import { afterEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';

vi.mock('../server/data/tron-rpc', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/tron-rpc')>()),
  readNowBlock: vi.fn(), readContract: vi.fn(), callConstant: vi.fn(),
}));

const JUSDT = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
const USDT = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const UNITROLLER = 'TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7';
const MODEL = 'TTetZxp98wcPaciyBMHYvQkS735RZ3tyXY';
const RATE = 25_000_000_000n;
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (value: string) => TronWeb.address.toHex(value).slice(2).padStart(64, '0');

function directory(status: 'active' | 'legacy' = 'active') {
  const address = (base58: string) => ({ address: { base58 } });
  return { _meta: { schema_version: '1.2.0' }, networks: { mainnet: {
    comptroller: { unitroller_proxy: address(UNITROLLER) },
    jtokens: { jUSDT: { symbol: 'jUSDT', status, underlying_symbol: 'USDT', decimals: 8,
      underlying_decimals: 6, delegator: address(JUSDT), underlying: address(USDT) } },
    interest_rate_models: { jumpRateUSDT: { ...address(MODEL), role: 'JumpRateModelV2' } },
  } } };
}

async function setup(options: { status?: 'active' | 'legacy'; paused?: boolean; modelRate?: bigint;
  lastBlock?: string; underlying?: string } = {}) {
  vi.resetModules();
  const rpc = await import('../server/data/tron-rpc');
  vi.resetAllMocks();
  const now = new Date().toISOString();
  vi.mocked(rpc.readNowBlock).mockResolvedValueOnce({ blockNumber: '100', blockTime: now, fetchedAt: now })
    .mockResolvedValueOnce({ blockNumber: options.lastBlock ?? '101', blockTime: now, fetchedAt: now });
  vi.mocked(rpc.readContract).mockImplementation(async (_chain, address) =>
    ({ address, hasCode: true, abiFunctions: [], codeHash: 'verified-code-hash' }));
  vi.mocked(rpc.callConstant).mockImplementation(async (_chain, address, selector) => {
    if (selector === 'underlying()') return addressWord(options.underlying ?? USDT);
    if (selector === 'comptroller()') return addressWord(UNITROLLER);
    if (selector === 'interestRateModel()') return addressWord(MODEL);
    if (selector === 'decimals()') return word(address === USDT ? 6n : 8n);
    if (selector === 'markets(address)') return word(1n);
    if (selector === 'mintGuardianPaused(address)') return word(options.paused ? 1n : 0n);
    if (selector === 'supplyRatePerBlock()') return word(RATE);
    if (selector === 'getCash()') return word(1_000_000_000n);
    if (selector === 'totalBorrows()') return word(1_000_000_000n);
    if (selector === 'totalReserves()' || selector === 'reserveFactorMantissa()' || selector === 'baseRatePerBlock()') return word(0n);
    if (selector === 'multiplierPerBlock()') return word(100_000_000_000n);
    if (selector === 'jumpMultiplierPerBlock()') return word(200_000_000_000n);
    if (selector === 'kink()') return word(800_000_000_000_000_000n);
    if (selector.startsWith('getSupplyRate(')) return word(options.modelRate ?? RATE);
    throw new Error(`Unexpected read: ${selector}`);
  });
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(directory(options.status)), { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
  const market = await import('../server/data/jusdt-market');
  return { market, rpc, fetchMock };
}

afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });

describe('independent Mainnet jUSDT market read', () => {
  it('uses verified on-chain APR, 6-decimal cash, active listing and a checked rate model', async () => {
    const { market, rpc, fetchMock } = await setup();
    const result = await market.readMainnetJusdtMarket();
    expect(result.quote?.baseRate).toEqual({ kind: 'apr', rate: '0.2628' });
    expect(result.quote?.liquidity.exitAvailable).toBe('1000');
    expect(result.quote?.source.accessMethod).toBe('rpc');
    expect(result.evidence?.rateModel?.kind).toBe('jump');
    expect(result.evidence?.rateModel?.codeIdentity).toBe('verified-code-hash');
    expect(result.evidence?.marketCodeIdentity).toBe('verified-code-hash');
    expect(result.evidence?.underlyingCodeIdentity).toBe('verified-code-hash');
    expect(result.evidence?.observationWindow).toMatchObject({ firstBlock: '100', lastBlock: '101' });
    expect(result.diagnostics.find(item => item.checkId === 'justlend_jusdt')?.status).toBe('ready');
    expect(fetchMock).toHaveBeenCalledWith('https://docs.justlend.org/developers/contracts.json', expect.any(Object));
    expect(rpc.callConstant).toHaveBeenCalledWith('mainnet', MODEL,
      'getSupplyRate(uint256,uint256,uint256,uint256)', expect.any(String), expect.any(AbortSignal));
    expect(vi.mocked(rpc.readNowBlock).mock.calls.length + vi.mocked(rpc.readContract).mock.calls.length
      + vi.mocked(rpc.callConstant).mock.calls.length).toBe(23);
  });

  it('holds a legacy market even if the on-chain market is listed', async () => {
    const { market, rpc } = await setup({ status: 'legacy' });
    const result = await market.readMainnetJusdtMarket();
    expect(result.quote).toBeNull();
    expect(result.diagnostics[0].status).toBe('unavailable');
    expect(rpc.callConstant).not.toHaveBeenCalled();
  });

  it.each([{ paused: true }, { underlying: UNITROLLER }, { lastBlock: '112' }])
    ('fails closed on active-market or block-window mismatch %j', async options => {
      const { market } = await setup(options);
      const result = await market.readMainnetJusdtMarket();
      expect(result.quote).toBeNull();
      expect(result.diagnostics[0].status).not.toBe('ready');
    });

  it('keeps market APR but withholds amount-adjusted rate when model output diverges', async () => {
    const { market } = await setup({ modelRate: RATE + 1n });
    const result = await market.readMainnetJusdtMarket();
    expect(result.quote).not.toBeNull();
    expect(result.evidence?.rateModel).toBeNull();
    expect(result.diagnostics.find(item => item.checkId === 'justlend_jusdt_rate_model')?.status).toBe('unknown');
  });
});
