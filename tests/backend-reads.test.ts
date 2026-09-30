import { afterEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { createReadGate, ReadLimitError } from '../server/read-gate';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

describe('bounded provider reads', () => {
  it('shares in-flight and cached values without replacing their provenance time', async () => {
    let time = 0;
    let release!: (value: { fetchedAt: string }) => void;
    const loader = vi.fn(() => new Promise<{ fetchedAt: string }>(resolve => { release = resolve; }));
    const gate = createReadGate({ maxConcurrent: 1, maxStartsPerMinute: 2, now: () => time });
    const first = gate('sources', 10_000, loader);
    const second = gate('sources', 10_000, loader);
    expect(first).toBe(second);
    expect(() => gate('other', 10_000, async () => 'other')).toThrow(ReadLimitError);
    await Promise.resolve();
    expect(loader).toHaveBeenCalledTimes(1);
    release({ fetchedAt: '2026-09-29T00:00:00.000Z' });
    const original = await first;
    expect(await second).toBe(original);
    time = 9_000;
    expect(await gate('sources', 10_000, loader)).toBe(original);
    expect(loader).toHaveBeenCalledTimes(1);
    time = 11_000;
    const refreshed = gate('sources', 10_000, async () => ({ fetchedAt: '2026-09-29T00:00:11.000Z' }));
    expect((await refreshed).fetchedAt).toBe('2026-09-29T00:00:11.000Z');
    expect(() => gate('third', 10_000, async () => 'third')).toThrow(ReadLimitError);
  });

  it('does not cache a failed upstream response', async () => {
    const gate = createReadGate({ maxStartsPerMinute: 2 });
    const loader = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce('recovered');
    await expect(gate('nile', 5_000, loader)).rejects.toThrow('offline');
    await expect(gate('nile', 5_000, loader)).resolves.toBe('recovered');
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe('TronGrid RPC read limiter', () => {
  it('keeps missing or mismatched account state unknown while accepting a verified zero balance', async () => {
    vi.resetModules();
    const { readTrxBalance } = await import('../server/data/tron-rpc');
    const { connectionReason } = await import('../server/data/provenance');
    const address = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
    const other = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response('{}', { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address: other, balance: 100 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address, balance: 1.5 }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ address: TronWeb.address.toHex(address), balance: 12 }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const reasons: string[] = [];
    for (let i = 0; i < 3; i++) {
      try { await readTrxBalance('mainnet', address); }
      catch (error) { reasons.push(connectionReason(error, 'Mainnet 수수료용 TRX 잔액')); }
    }
    expect(reasons).toEqual([
      'Mainnet 수수료용 TRX 잔액 계정 상태가 반환되지 않아 잔액을 확인하지 못했습니다.',
      'Mainnet 수수료용 TRX 잔액 응답 계정 주소가 요청 주소와 다릅니다.',
      'Mainnet 수수료용 TRX 잔액 응답 잔액이 안전한 정수 형식이 아닙니다.',
    ]);
    await expect(readTrxBalance('mainnet', address)).resolves.toBe('0');
    await expect(readTrxBalance('mainnet', address)).resolves.toBe('12');
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });
  it('shares one Mainnet read budget across concurrent helpers and nested calls', async () => {
    vi.resetModules();
    const { postTronRpc, readContract, readNowBlock, withMainnetRpcBudget, MainnetRpcBudgetError } =
      await import('../server/data/tron-rpc');
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/wallet/getnowblock')) return new Response(JSON.stringify({
        block_header: { raw_data: { number: 100, timestamp: 1_760_000_000_000 } },
      }), { status: 200 });
      if (url.endsWith('/wallet/getcontract')) return new Response(JSON.stringify({ bytecode: '6001' }), { status: 200 });
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await withMainnetRpcBudget(3, async () => {
      await Promise.all([
        postTronRpc('mainnet', '/wallet/getaccount', { address: 'first' }),
        readNowBlock('mainnet'),
        readContract('mainnet', 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd'),
      ]);
      await expect(withMainnetRpcBudget(100, () => postTronRpc('mainnet', '/wallet/getaccount',
        { address: 'fourth' }))).rejects.toBeInstanceOf(MainnetRpcBudgetError);
    });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('keeps separate request budgets and counts even a cached Mainnet helper read', async () => {
    vi.resetModules();
    const { postTronRpc, withMainnetRpcBudget, MainnetRpcBudgetError } = await import('../server/data/tron-rpc');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bytecode: '6001' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { value: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', visible: true };
    await Promise.all([
      withMainnetRpcBudget(1, async () => {
        await postTronRpc('mainnet', '/wallet/getcontract', body);
        await expect(postTronRpc('mainnet', '/wallet/getcontract', body)).rejects.toBeInstanceOf(MainnetRpcBudgetError);
      }),
      withMainnetRpcBudget(1, async () => {
        await postTronRpc('nile', '/wallet/getcontract', body); // Nile is outside this Mainnet budget.
        await postTronRpc('mainnet', '/wallet/getaccount', { address: 'other' });
        await expect(postTronRpc('mainnet', '/wallet/getaccount', { address: 'more' }))
          .rejects.toBeInstanceOf(MainnetRpcBudgetError);
      }),
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('cancels active and queued Mainnet reads when the shared assessment deadline expires', async () => {
    vi.resetModules();
    const { postTronRpc, withMainnetRpcBudget } = await import('../server/data/tron-rpc');
    const fetchMock = vi.fn((_url: string, init: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init.signal!.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(withMainnetRpcBudget(3, () => Promise.all(['one', 'two', 'three'].map(address =>
      postTronRpc('mainnet', '/wallet/getaccount', { address }))), { timeoutMs: 60 }))
      .rejects.toMatchObject({ name: 'AbortError' });
    await new Promise(resolve => setTimeout(resolve, 300));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('accepts TronGrid empty success ret on constant reads but rejects an explicit TVM failure', async () => {
    vi.resetModules();
    const { callConstant, decodeUint } = await import('../server/data/tron-rpc');
    const word = '0'.repeat(63) + '7';
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { result: true },
        transaction: { ret: [{}] }, constant_result: [word] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: { result: true },
        transaction: { ret: [{ ret: 'REVERT' }] }, constant_result: [word] }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect(decodeUint(await callConstant('mainnet', 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', 'getCash()'))).toBe('7');
    await expect(callConstant('mainnet', 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', 'getCash()'))
      .rejects.toThrow('TVM failed');
  });

  it('validates the current block header without trusting a missing timestamp', async () => {
    vi.resetModules();
    const { readNowBlock } = await import('../server/data/tron-rpc');
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ block_header: { raw_data: { number: 100, timestamp: 1_760_000_000_000 } } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ block_header: { raw_data: { number: 101 } } }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    expect((await readNowBlock('mainnet')).blockNumber).toBe('100');
    await expect(readNowBlock('mainnet')).rejects.toThrow('Invalid on-chain integer');
  });

  it('coalesces identical reads and reuses a short contract response cache', async () => {
    vi.resetModules();
    const { postTronRpc } = await import('../server/data/tron-rpc');
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ bytecode: '6001' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const body = { value: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', visible: true };
    const [a, b] = await Promise.all([
      postTronRpc('mainnet', '/wallet/getcontract', body),
      postTronRpc('mainnet', '/wallet/getcontract', body),
    ]);
    expect(a).toBe(b);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await postTronRpc('mainnet', '/wallet/getcontract', body)).toBe(a);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('cools down after HTTP 429 without sending another provider request', async () => {
    vi.resetModules();
    const { postTronRpc } = await import('../server/data/tron-rpc');
    const fetchMock = vi.fn(async () => new Response(null, { status: 429 }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(postTronRpc('nile', '/wallet/getaccount', { address: 'first' })).rejects.toThrow('HTTP 429');
    await expect(postTronRpc('nile', '/wallet/getaccount', { address: 'second' })).rejects.toThrow('HTTP 429');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('caps simultaneous Mainnet RPC requests while allowing queued reads to complete', async () => {
    vi.resetModules();
    const { postTronRpc } = await import('../server/data/tron-rpc');
    let active = 0;
    let maximum = 0;
    const fetchMock = vi.fn(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await new Promise(resolve => setTimeout(resolve, 350));
      active--;
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', fetchMock);
    await Promise.all(['first', 'second', 'third'].map(address =>
      postTronRpc('mainnet', '/wallet/getaccount', { address })));
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(maximum).toBeLessThanOrEqual(2);
  });

  it('removes an aborted queued read before sending it to TronGrid', async () => {
    vi.resetModules();
    const { postTronRpc } = await import('../server/data/tron-rpc');
    const releases: Array<() => void> = [];
    const fetchMock = vi.fn(() => new Promise<Response>(resolve => {
      releases.push(() => resolve(new Response('{}', { status: 200 })));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const first = postTronRpc('mainnet', '/wallet/getaccount', { address: 'one' });
    const second = postTronRpc('mainnet', '/wallet/getaccount', { address: 'two' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const controller = new AbortController();
    const third = postTronRpc('mainnet', '/wallet/getaccount', { address: 'three' }, { signal: controller.signal });
    const rejection = expect(third).rejects.toMatchObject({ name: 'AbortError' });
    controller.abort();
    await rejection;
    releases.forEach(release => release());
    await Promise.all([first, second]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
