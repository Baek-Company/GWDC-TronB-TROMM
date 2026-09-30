import { describe, expect, it, vi } from 'vitest';
import { researchMarketQuestion, researchMarketQuestions } from '../server/agent/research';
import { MAINNET_JUSDD_ADDRESS, MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import type { MarketSnapshot } from '../shared/markets';
import type { PsmEvidence } from '../server/data/usdd';
import { provenance } from '../server/data/provenance';

const now = Date.parse('2026-09-29T04:00:00.000Z');
const marketSnapshot: MarketSnapshot = {
  source: 'https://openapi.just.network/lend/jtoken', network: 'mainnet',
  fetchedAt: '2026-09-29T04:00:00.000Z', sourceUpdatedAt: null, mode: 'live',
  markets: [{ symbol: 'jUSDT', address: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd',
    underlyingSymbol: 'USDT', underlyingAddress: MAINNET_USDT_ADDRESS, underlyingDecimal: 6,
    supplyRate: '0.05', borrowRate: '0.07', cash: '100000', totalBorrows: '100', exchangeRate: '1' }],
};

function psmEvidence(): PsmEvidence {
  return {
    chain: 'mainnet', market: 'PSM-USDT', psmAddress: 'TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz',
    inputToken: { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 },
    outputToken: { symbol: 'USDD', address: MAINNET_USDD_ADDRESS, decimals: 18 },
    jUsddAddress: MAINNET_JUSDD_ADDRESS, jUsddUnderlyingAddress: MAINNET_USDD_ADDRESS,
    psmOutputTokenAddress: MAINNET_USDD_ADDRESS, psmInputTokenAddress: MAINNET_USDT_ADDRESS,
    tokenCompatible: true, inputTokenCompatible: true,
    entryEnabled: true, exitEnabled: true, entryFeeRaw: '0', exitFeeRaw: '0',
    entryFeeRate: '0', exitFeeRate: '0', entryCapacity: null, exitCapacity: null,
    jUsddListed: true, planReady: false, missing: ['PSM 양방향 수량 한도 미확인'],
  };
}

describe('read-only market research', () => {
  it('shows JustLend rates as display-only when the upstream update time is missing', async () => {
    const result = await researchMarketQuestion('지금 JustLend USDT 금리는?',
      { markets: vi.fn().mockResolvedValue(marketSnapshot), now: () => now });
    expect(result.topic).toBe('lending_rate');
    expect(result.status).toBe('partial');
    expect(result.claims).toMatchObject([{ value: '5', unit: '% APY',
      availability: 'unknown', useScope: 'display', source: { sourceUpdatedAt: null, mode: 'live' } }]);
    expect(result.planningImpact).toContain('실행 견적');
  });

  it('reports provider rate limits as unavailable without substituting old or synthetic values', async () => {
    const result = await researchMarketQuestion('JustLend USDT 금리',
      { markets: vi.fn().mockRejectedValue(new Error('JustLend HTTP 429')), now: () => now });
    expect(result.status).toBe('unavailable');
    expect(result.claims[0]).toMatchObject({ value: null, availability: 'unavailable',
      source: { sourceUrl: 'https://openapi.just.network/lend/jtoken', mode: 'unavailable',
        fetchedAt: null, attemptedAt: '2026-09-29T04:00:00.000Z' } });
    expect(result.unavailable[0]).toContain('429');
  });

  it('never treats an enabled PSM exit switch as a usable exit capacity', async () => {
    const result = await researchMarketQuestion('USDD PSM 출구 가능한가요?', {
      psm: vi.fn().mockResolvedValue({ status: 'ready', value: psmEvidence(),
        source: provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc') }),
    });
    expect(result.status).toBe('partial');
    expect(result.claims.find(item => item.label.includes('출구 용량'))).toMatchObject({
      value: null, availability: 'unknown', useScope: 'display',
    });
    expect(result.planningImpact).toContain('추천하지 않습니다');
  });

  it('separates Mainnet and Nile as documentation claims, without invented live rates', async () => {
    const report = await researchMarketQuestions(['Nile과 Mainnet의 차이']);
    expect(report.status).toBe('ready');
    expect(report.results[0].claims.every(item => item.source?.mode === 'documentation'
      && item.source.fetchedAt === null && item.useScope === 'display')).toBe(true);
    expect(report.results[0].planningImpact).toContain('Mainnet');
  });

  it('accepts a fresh SUN address-keyed USD price only as a spot reference', async () => {
    const fetchPrice = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0,
      data: { [MAINNET_USDD_ADDRESS]: { quote: { USD: { price: '0.9987', last_updated: now - 60_000 } } } },
    }) });
    const result = await researchMarketQuestion('USDD 시세는 얼마인가요?', { fetchPrice, now: () => now });
    expect(result.status).toBe('ready');
    expect(result.claims[0]).toMatchObject({ value: '0.9987', unit: 'USD', availability: 'ready',
      useScope: 'display', source: { sourceUpdatedAt: '2026-09-29T03:59:00.000Z' } });
    expect(result.planningImpact).toContain('실행 적격성');
  });

  it('hides stale SUN prices instead of calling them current prices', async () => {
    const fetchPrice = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0,
      data: { [MAINNET_USDD_ADDRESS]: { quote: { USD: { price: '0.997', last_updated: now - 3_600_000 } } } },
    }) });
    const result = await researchMarketQuestion('USDD 가격', { fetchPrice, now: () => now });
    expect(result.status).toBe('partial');
    expect(result.claims[0]).toMatchObject({ value: null, availability: 'unknown' });
  });

  it('asks for a token only when a spot-price question lacks one', async () => {
    const result = await researchMarketQuestion('지금 달러 가격은?', { now: () => now });
    expect(result.status).toBe('needs_clarification');
    expect(result.followUpQuestion).toContain('USDT');
    expect(result.claims).toEqual([]);
  });

  it('returns both USDT and USDD spot claims without dropping the first token-only clause', async () => {
    const prices: Record<string, string> = {
      [MAINNET_USDT_ADDRESS]: '1.001', [MAINNET_USDD_ADDRESS]: '0.9987',
    };
    const fetchPrice = vi.fn(async (input: URL | RequestInfo) => {
      const address = new URL(String(input)).searchParams.get('tokenAddress')!;
      return { ok: true, json: async () => ({ code: 0,
        data: { [address]: { quote: { USD: { price: prices[address], last_updated: now - 60_000 } } } },
      }) } as Response;
    });
    const report = await researchMarketQuestions(['USDT와 USDD 시세를 알려주세요?'],
      { fetchPrice, now: () => now });
    expect(report.status).toBe('ready');
    expect(report.results).toHaveLength(1);
    expect(report.results[0].claims.map(item => [item.label, item.value])).toEqual([
      ['USDT USD 현물 가격', '1.001'], ['USDD USD 현물 가격', '0.9987'],
    ]);
    expect(fetchPrice).toHaveBeenCalledTimes(2);
  });

  it('does not mix a USDT rate clause into a USDD spot price lookup', async () => {
    const fetchPrice = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ code: 0,
      data: { [MAINNET_USDD_ADDRESS]: { quote: { USD: { price: '0.99', last_updated: now } } } },
    }) });
    const report = await researchMarketQuestions(['USDT 금리와 USDD 시세'], {
      markets: vi.fn().mockResolvedValue(marketSnapshot), fetchPrice, now: () => now,
    });
    const spot = report.results.find(result => result.topic === 'spot_price')!;
    expect(spot.claims.map(item => item.label)).toEqual(['USDD USD 현물 가격']);
    expect(fetchPrice).toHaveBeenCalledTimes(1);
  });

  it('keeps failed SUN and PSM attempts distinct from successful live source times', async () => {
    const price = await researchMarketQuestion('USDD 시세', {
      fetchPrice: vi.fn().mockResolvedValue({ ok: false, status: 429 }), now: () => now,
    });
    expect(price.status).toBe('unavailable');
    expect(price.claims[0].source).toMatchObject({ mode: 'unavailable', fetchedAt: null,
      attemptedAt: '2026-09-29T04:00:00.000Z' });
    expect(price.claims[0].source?.sourceUrl).toContain(`tokenAddress=${MAINNET_USDD_ADDRESS}`);
    const psm = await researchMarketQuestion('USDD PSM 출구 상태', {
      psm: vi.fn().mockResolvedValue({ status: 'unavailable', reason: 'HTTP 429',
        source: provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc') }),
      now: () => now,
    });
    expect(psm.claims[0].source).toMatchObject({ mode: 'unavailable', fetchedAt: null,
      sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract' });
    const nile = await researchMarketQuestion('Nile jTRX 유동성', {
      nileQuote: vi.fn().mockResolvedValue({ jTrx: null,
        diagnostics: [{ checkId: 'nile_jtrx', status: 'unavailable', reason: 'HTTP 429' }] }),
      now: () => now,
    });
    expect(nile.claims[0].source).toMatchObject({ mode: 'unavailable', fetchedAt: null,
      sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract' });
  });

  it('counts both token price reads against the five-call per-request budget', async () => {
    const fetchPrice = vi.fn(async (input: URL | RequestInfo) => {
      const address = new URL(String(input)).searchParams.get('tokenAddress')!;
      return { ok: true, json: async () => ({ code: 0,
        data: { [address]: { quote: { USD: { price: '1', last_updated: now } } } },
      }) } as Response;
    });
    const report = await researchMarketQuestions(Array(3).fill('USDT와 USDD 시세'),
      { fetchPrice, now: () => now });
    expect(fetchPrice).toHaveBeenCalledTimes(5);
    expect(report.results).toHaveLength(3);
    expect(report.results[2].claims.map(item => item.availability)).toEqual(['ready', 'unavailable']);
  });

  it('answers both parts of a JustLend rate and USDD exit question', async () => {
    const markets = vi.fn().mockResolvedValue(marketSnapshot);
    const psm = vi.fn().mockResolvedValue({ status: 'ready', value: psmEvidence(),
      source: provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc') });
    const report = await researchMarketQuestions(['지금 JustLend 금리와 USDD 출구를 알려주세요?'],
      { markets, psm, now: () => now });
    expect(report.results.map(item => item.topic)).toEqual(['lending_rate', 'psm_exit']);
    expect(report.results[0].claims.some(item => item.label === 'jUSDT 표시 공급 금리')).toBe(true);
    expect(report.results[1].claims.some(item => item.label.includes('출구 스위치'))).toBe(true);
    expect(markets).toHaveBeenCalledTimes(1);
    expect(psm).toHaveBeenCalledTimes(1);
  });

  it('keeps the external read budget when multiple questions contain two topics', async () => {
    const markets = vi.fn().mockResolvedValue(marketSnapshot);
    const psm = vi.fn().mockResolvedValue({ status: 'ready', value: psmEvidence(),
      source: provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc') });
    const report = await researchMarketQuestions(Array(3).fill('JustLend 금리와 USDD 출구'),
      { markets, psm, now: () => now });
    expect(report.results).toHaveLength(6);
    expect(markets.mock.calls.length + psm.mock.calls.length).toBe(5);
    expect(report.results[5]).toMatchObject({ topic: 'psm_exit', status: 'unavailable' });
    expect(report.results[5].unavailable[0]).toContain('상한');
  });
});
