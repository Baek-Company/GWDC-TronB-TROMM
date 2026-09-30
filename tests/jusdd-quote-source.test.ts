import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { readMarkets } from '../server/data';
import { readMainnetQuotes } from '../server/data/quotes';
import { readMainnetJusdtMarket, MAINNET_UNITROLLER_ADDRESS } from '../server/data/jusdt-market';
import { MAINNET_JUSDD_ADDRESS, MAINNET_USDD_ADDRESS, readMainnetPsmEvidence } from '../server/data/usdd';
import { callConstant, readContract, readNowBlock } from '../server/data/tron-rpc';
import { readJustLendMcpMarket } from '../server/mcp/registry';
import { isCurrentLiveSource } from '../shared/provenance';

vi.mock('../server/data', async importOriginal => ({ ...(await importOriginal<typeof import('../server/data')>()), readMarkets: vi.fn() }));
vi.mock('../server/data/jusdt-market', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/jusdt-market')>()), readMainnetJusdtMarket: vi.fn(),
}));
vi.mock('../server/data/usdd', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/usdd')>()), readMainnetPsmEvidence: vi.fn(),
}));
vi.mock('../server/data/tron-rpc', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/tron-rpc')>()),
  callConstant: vi.fn(), readContract: vi.fn(), readNowBlock: vi.fn(),
}));
vi.mock('../server/mcp/registry', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/mcp/registry')>()), readJustLendMcpMarket: vi.fn(),
}));

const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (value: string) => TronWeb.address.toHex(value).slice(2).padStart(64, '0');

beforeEach(() => {
  vi.clearAllMocks();
  const source = { sourceUrl: 'https://api.trongrid.io', chain: 'mainnet' as const,
    fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const };
  vi.mocked(readMarkets).mockResolvedValue({ source: 'https://openapi.just.network/lend/jtoken',
    network: 'mainnet', fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live',
    markets: [{ symbol: 'jUSDD', address: MAINNET_JUSDD_ADDRESS, underlyingSymbol: 'USDD',
      underlyingAddress: MAINNET_USDD_ADDRESS, underlyingDecimal: 18, supplyRate: '0.9',
      borrowRate: '0', cash: '999999', totalBorrows: '0', exchangeRate: '1' }] } as Awaited<ReturnType<typeof readMarkets>>);
  vi.mocked(readMainnetJusdtMarket).mockResolvedValue({ quote: null, evidence: null, diagnostics: [] });
  vi.mocked(readMainnetPsmEvidence).mockResolvedValue({ status: 'unavailable', reason: 'PSM unavailable', source });
  vi.mocked(readJustLendMcpMarket).mockResolvedValue({ status: 'unavailable', reason: 'MCP unavailable', source });
  vi.mocked(readContract).mockImplementation(async (_chain, address) => ({ address, hasCode: true, abiFunctions: [], codeHash: null }));
  vi.mocked(readNowBlock).mockImplementation(async () => ({ blockNumber: '100',
    blockTime: new Date().toISOString(), fetchedAt: new Date().toISOString() }));
  vi.mocked(callConstant).mockImplementation(async (_chain, _address, selector) => {
    if (selector === 'underlying()') return addressWord(MAINNET_USDD_ADDRESS);
    if (selector === 'decimals()') return word(18n);
    if (selector === 'comptroller()') return addressWord(MAINNET_UNITROLLER_ADDRESS);
    if (selector === 'markets(address)') return word(1n);
    if (selector === 'supplyRatePerBlock()') return word(1_000_000_000n);
    if (selector === 'getCash()') return word(1_000n * 10n ** 18n);
    throw new Error(`Unexpected selector ${selector}`);
  });
});

describe('jUSDD Mainnet quote source', () => {
  it('uses current on-chain APR and cash instead of REST APY and cash without update time', async () => {
    const result = await readMainnetQuotes();
    expect(result.jUsdd?.baseRate).toEqual({ kind: 'apr', rate: '0.010512' });
    expect(result.jUsdd?.liquidity.exitAvailable).toBe('1000');
    expect(result.jUsdd?.source.accessMethod).toBe('rpc');
    expect(isCurrentLiveSource(result.jUsdd?.source ?? null, 'mainnet', new Date(), 60_000)).toBe(true);
  });

  it('does not promote REST values when the on-chain rate read fails', async () => {
    const original = vi.mocked(callConstant).getMockImplementation()!;
    vi.mocked(callConstant).mockImplementation(async (...args) => {
      if (args[2] === 'supplyRatePerBlock()') throw new Error('RPC unavailable');
      return original(...args);
    });
    const result = await readMainnetQuotes();
    expect(result.jUsdd).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({ checkId: 'justlend_jusdd', status: 'unknown' }));
  });
});
