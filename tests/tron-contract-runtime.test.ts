import { afterEach, describe, expect, it, vi } from 'vitest';

afterEach(() => vi.unstubAllGlobals());

describe('TRON contract runtime fallback', () => {
  it('accepts runtime bytecode only when GetContractInfo confirms the requested address', async () => {
    vi.resetModules();
    const { readContract } = await import('../server/data/tron-rpc');
    const address = 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz';
    const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/wallet/getcontractinfo')
        ? { smart_contract: { contract_address: address }, runtimecode: '60806040' }
        : { contract_address: address, abi: { entrys: [] }, code_hash: 'a'.repeat(64) }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);
    const result = await readContract('mainnet', address);
    expect(result.hasCode).toBe(true);
    expect(result.codeHash).toMatch(/^[0-9a-f]{64}$/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not trust runtime code from a different contract address', async () => {
    vi.resetModules();
    const { readContract } = await import('../server/data/tron-rpc');
    const address = 'TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz';
    vi.stubGlobal('fetch', vi.fn(async (url: string) => new Response(JSON.stringify(
      url.endsWith('/wallet/getcontractinfo')
        ? { smart_contract: { contract_address: 'TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz' }, runtimecode: '60806040' }
        : { contract_address: address, code_hash: 'a'.repeat(64) }), { status: 200 })));
    expect((await readContract('mainnet', address)).hasCode).toBe(false);
  });
});
