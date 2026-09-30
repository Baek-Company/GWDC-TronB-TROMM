import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readMarkets } from '../server/data';
import { provenance } from '../server/data/provenance';
import { MAINNET_JUSDT_ADDRESS, diagnoseJustLendMcpRead, readMainnetQuotes } from '../server/data/quotes';
import { readMainnetJusdtMarket } from '../server/data/jusdt-market';
import { MAINNET_USDT_ADDRESS, readMainnetPsmEvidence } from '../server/data/usdd';
import { readJustLendMcpMarket } from '../server/mcp/registry';
import { productQuoteSchema } from '../shared/schemas';

vi.mock('../server/data', async importOriginal => ({ ...(await importOriginal<typeof import('../server/data')>()), readMarkets: vi.fn() }));
vi.mock('../server/mcp/registry', async importOriginal => ({ ...(await importOriginal<typeof import('../server/mcp/registry')>()), readJustLendMcpMarket: vi.fn() }));
vi.mock('../server/data/jusdt-market', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/jusdt-market')>()), readMainnetJusdtMarket: vi.fn(),
}));
vi.mock('../server/data/usdd', async importOriginal => ({ ...(await importOriginal<typeof import('../server/data/usdd')>()), readMainnetPsmEvidence: vi.fn() }));

const mcpSource = provenance('https://docs.justlend.org/ai_support/mcp_server/', 'mainnet', 'mcp', {
  serverId: '@justlend/mcp-server-justlend', toolName: 'get_market_data', serverVersion: '1.1.3',
});
const rpcSource = provenance('https://api.trongrid.io', 'mainnet', 'rpc');
const quote = productQuoteSchema.parse({
  id: 'mainnet-justlend-jusdt', quoteVersion: 'rpc-v1', product: 'justlend_jusdt', chain: 'mainnet',
  marketAddress: MAINNET_JUSDT_ADDRESS,
  inputToken: { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 },
  depositToken: { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 },
  receiptToken: { symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, decimals: 8 },
  baseRate: { kind: 'apr', rate: '0.05' }, reward: null,
  liquidity: { exitAvailable: '100000', withdrawalDelayDays: 0 }, conversion: null, costs: [],
  status: 'active', risks: [], source: rpcSource,
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(readMainnetJusdtMarket).mockResolvedValue({ quote, evidence: null,
    diagnostics: [{ checkId: 'justlend_jusdt', status: 'ready', reason: 'RPC verified', source: rpcSource }] });
  vi.mocked(readMainnetPsmEvidence).mockResolvedValue({ status: 'unavailable', reason: 'not configured', source: rpcSource });
  vi.mocked(readJustLendMcpMarket).mockResolvedValue({ status: 'unavailable', reason: 'not configured', source: mcpSource });
});

describe('JustLend MCP quote diagnostics', () => {
  it('records a successful read without treating an unverified payload as a REST match', () => {
    const diagnostics = diagnoseJustLendMcpRead('jUSDT', {
      status: 'ready', source: mcpSource,
      value: { serverId: 'justlend', serverVersion: '1.1.3', toolName: 'get_market_data',
        result: { schemaVersion: '1.0.0', tool: 'get_market_data', result: { supplyAPY: '0.04' } } },
    });
    expect(diagnostics.map(item => item.status)).toEqual(['ready', 'unknown']);
    expect(diagnostics[0].source?.accessMethod).toBe('mcp');
    expect(diagnostics[1].checkId).toBe('justlend_mcp_jusdt_rest_match');
  });

  it('keeps the independent on-chain jUSDT quote when REST is unavailable', async () => {
    vi.mocked(readMarkets).mockRejectedValue(new Error('REST offline'));
    vi.mocked(readJustLendMcpMarket).mockImplementation(async market => ({
      status: 'ready', source: mcpSource,
      value: { serverId: 'justlend', serverVersion: '1.1.3', toolName: 'get_market_data',
        result: { schemaVersion: '1.0.0', tool: 'get_market_data', result: { market } } },
    }));
    const result = await readMainnetQuotes();
    expect(result.jUsdt).toEqual(quote);
    expect(result.jUsdt?.source.accessMethod).toBe('rpc');
    expect(readJustLendMcpMarket).toHaveBeenCalledTimes(2);
    expect(result.diagnostics.some(item => item.checkId === 'justlend_rest' && item.status === 'unavailable')).toBe(true);
    expect(result.diagnostics.some(item => item.checkId === 'justlend_mcp_jusdt' && item.status === 'ready')).toBe(true);
  });

  it('keeps the on-chain jUSDT quote when PSM and MCP unexpectedly reject', async () => {
    vi.mocked(readMarkets).mockRejectedValue(new Error('REST offline'));
    vi.mocked(readMainnetPsmEvidence).mockRejectedValue(new Error('PSM offline'));
    vi.mocked(readJustLendMcpMarket).mockRejectedValue(new Error('MCP offline'));
    const result = await readMainnetQuotes();
    expect(result.jUsdt).toEqual(quote);
    expect(result.diagnostics.some(item => item.checkId === 'usdd_psm' && item.status === 'unavailable')).toBe(true);
    expect(result.diagnostics.some(item => item.checkId === 'justlend_mcp' && item.status === 'unavailable')).toBe(true);
  });

  it('does not accept an unsupported MCP envelope as a verified quote', () => {
    const diagnostics = diagnoseJustLendMcpRead('jUSDD', {
      status: 'ready', source: mcpSource,
      value: { serverId: 'justlend', serverVersion: null, toolName: 'get_market_data', result: { supplyAPY: '0.04' } },
    });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0].status).toBe('unknown');
  });
});

describe('Mainnet market composition', () => {
  it('keeps the wallet-sized jUSDT route independent of PSM, REST and MCP reads', async () => {
    const result = await readMainnetQuotes({ selectedRoute: 'jusdt' });
    expect(result.jUsdt).toEqual(quote);
    expect(result.jUsdd).toBeNull();
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      checkId: 'usdd_psm', status: 'unknown',
    }));
    expect(readMarkets).not.toHaveBeenCalled();
    expect(readMainnetPsmEvidence).not.toHaveBeenCalled();
    expect(readJustLendMcpMarket).not.toHaveBeenCalled();
  });

  it('does not let a mismatched REST market replace the on-chain jUSDT quote', async () => {
    vi.mocked(readMarkets).mockResolvedValue({ source: 'https://openapi.just.network/lend/jtoken', network: 'mainnet',
      fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live', markets: [{
        symbol: 'jUSDT', address: MAINNET_USDT_ADDRESS, underlyingSymbol: 'USDT',
        underlyingAddress: MAINNET_USDT_ADDRESS, underlyingDecimal: 6, supplyRate: '0.09',
        borrowRate: '0.06', cash: '999999', totalBorrows: '1000', exchangeRate: '1',
      }] });
    const result = await readMainnetQuotes();
    expect(result.jUsdt).toEqual(quote);
    expect(result.jUsdt?.baseRate?.kind).toBe('apr');
    expect(result.diagnostics.find(item => item.checkId === 'justlend_jusdt_rest_crosscheck')?.status).toBe('unknown');
  });

  it('does not promote an unavailable on-chain market from REST data', async () => {
    vi.mocked(readMainnetJusdtMarket).mockResolvedValue({ quote: null, evidence: null,
      diagnostics: [{ checkId: 'justlend_jusdt', status: 'unavailable', reason: 'unlisted' }] });
    vi.mocked(readMarkets).mockResolvedValue({ source: 'https://openapi.just.network/lend/jtoken', network: 'mainnet',
      fetchedAt: new Date().toISOString(), sourceUpdatedAt: null, mode: 'live', markets: [{
        symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, underlyingSymbol: 'USDT',
        underlyingAddress: MAINNET_USDT_ADDRESS, underlyingDecimal: 6, supplyRate: '0.09',
        borrowRate: '0.06', cash: '999999', totalBorrows: '1000', exchangeRate: '1',
      }] });
    const result = await readMainnetQuotes();
    expect(result.jUsdt).toBeNull();
    expect(result.diagnostics.find(item => item.checkId === 'justlend_jusdt')?.status).toBe('unavailable');
  });
});
