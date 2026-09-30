import { describe, expect, it } from 'vitest';
import { replayScenario } from '../shared/replay';
import { findMinimumBreakEvenAllocation, type FixedCostEvidence } from '../shared/sizing';
import type { ProductQuote, Source, UserNeeds } from '../shared/schemas';

const at = '2026-09-29T03:00:00.000Z';
const token = { symbol: 'USDT', address: 'TUSDT', decimals: 6 };
const source = (mode: Source['mode'], fetchedAt = at): Source => ({
  sourceUrl: 'https://example.org/market/justlend', chain: 'mainnet', fetchedAt,
  sourceUpdatedAt: mode === 'live' ? fetchedAt : null, mode, accessMethod: 'rest',
});
const needs = (overrides: Partial<UserNeeds> = {}): UserNeeds => ({
  chain: 'mainnet', asset: token, amount: '1000', startDate: '2026-09-29', endDate: '2027-09-29',
  expenses: [], liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
  timezone: 'Asia/Seoul', inputVersion: 1, confirmedVersion: 1, ...overrides,
});
const quote = (mode: Source['mode'] = 'live', cost = '1'): ProductQuote => ({
  id: 'jUSDT', quoteVersion: 'q1', product: 'justlend_jusdt', chain: 'mainnet',
  marketAddress: 'TJUSDT', inputToken: token, depositToken: token,
  receiptToken: { symbol: 'jUSDT', address: 'TJUSDT', decimals: 8 },
  baseRate: { kind: 'apr', rate: '0.1' }, reward: null,
  liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 }, conversion: null,
  costs: (['approval', 'deposit', 'withdraw'] as const).map(kind => ({
    kind, amount: cost, asset: token, conversionRateToInput: null,
    estimatedAt: at, source: mode === 'live' ? source('live') : null,
  })), status: 'active', risks: [], source: source(mode),
});
const evidence = (overrides: Partial<FixedCostEvidence> = {}): FixedCostEvidence => ({
  quoteId: 'jUSDT', quoteVersion: 'q1', minAllocation: '0', maxAllocation: '1000',
  costBehavior: 'fixed_within_range', source: source('live'), ...overrides,
});

describe('minimum verified allocation', () => {
  it('finds the first token unit that breaks even, without counting unknown rewards', () => {
    const result = findMinimumBreakEvenAllocation({ needs: needs(), quote: quote(), fixedCostEvidence: evidence(),
      now: new Date(at) });
    expect(result.status).toBe('found');
    expect(result.minimumAmount).toBe('30'); // 30 × 10% APR − 3 verified fixed costs = 0
    expect(result.netYieldAtMinimum).toBe('0');
    expect(result.netYieldBasis).toBe('base_only');
    expect(result.plan?.allocation.invested).toBe('30');
    expect(result.sourceMode).toBe('live');
  });

  it('withholds the minimum when the cost model, a cost, or freshness is unverified', () => {
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: quote(), now: new Date(at) }).reason)
      .toBe('fixed_cost_range_unverified');
    const missingCost = quote();
    missingCost.costs[2].amount = null;
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: missingCost,
      fixedCostEvidence: evidence(), now: new Date(at) }).reason).toBe('cost_or_conversion_unverified');
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: quote('snapshot'),
      fixedCostEvidence: evidence(), now: new Date(at) }).reason).toBe('data_not_current_live');
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: quote(),
      fixedCostEvidence: evidence(), now: new Date('2026-09-30T03:00:00.000Z') }).reason)
      .toBe('data_not_current_live');
    const oldCostSource = quote();
    oldCostSource.costs[0].source = { ...source('live'), sourceUpdatedAt: '2026-09-28T03:00:00.000Z' };
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: oldCostSource,
      fixedCostEvidence: evidence(), now: new Date(at) }).reason).toBe('cost_source_not_current_live');
    const noOriginalTime = quote();
    noOriginalTime.source.sourceUpdatedAt = null;
    expect(findMinimumBreakEvenAllocation({ needs: needs(), quote: noOriginalTime,
      fixedCostEvidence: evidence(), now: new Date(at) }).reason).toBe('data_not_current_live');
  });

  it('reports no break-even inside a verified amount range instead of extrapolating', () => {
    const result = findMinimumBreakEvenAllocation({ needs: needs(), quote: quote(),
      fixedCostEvidence: evidence({ maxAllocation: '25' }), now: new Date(at) });
    expect(result.status).toBe('no_break_even');
    expect(result.minimumAmount).toBeNull();
    expect(result.maximumEligibleAmount).toBe('25');
  });
});

describe('explicit historical and synthetic replay', () => {
  const scenarioNeeds = needs({ endDate: '2026-10-29',
    expenses: [{ date: '2026-10-06', amount: '200', asset: token }] });
  const syntheticQuote = quote('synthetic', '0');
  it('keeps a future expense protected beyond the chosen horizon without presenting projected interest as actual performance', () => {
    const secondAt = '2026-09-30T03:00:00.000Z';
    const result = replayScenario({ id: 'expense-shift', frames: [
      { id: 'before', at, path: 'mainnet', needs: scenarioNeeds, needsMode: 'synthetic',
        source: source('synthetic'), quotes: { jUsdt: syntheticQuote, jUsdd: null } },
      { id: 'after', at: secondAt, path: 'mainnet',
        needs: needs({ inputVersion: 2, confirmedVersion: 2, endDate: '2026-10-29',
          expenses: [{ date: '2026-11-13', amount: '200', asset: token }] }),
        needsMode: 'synthetic', source: source('synthetic', secondAt),
        quotes: { jUsdt: syntheticQuote, jUsdd: null } },
    ] });
    expect(result.frames[0].plans[1].allocation.invested).toBe('800');
    expect(result.frames[1].plans[1].allocation.invested).toBe('800');
    expect(result.frames[0].projectedLeaderId).toBe(result.frames[0].plans[1].id);
    expect(result.frames[0].plans[1].netYield).toBeNull();
    expect(result.frames[0].displayMode).toBe('synthetic');
    expect(result.frames[0].actualReturn).toBeNull();
    expect(result.executionAllowed).toBe(false);
  });

  it('keeps historical quote provenance and mixed input origins visible', () => {
    const historical = quote('snapshot', '0');
    const result = replayScenario({ id: 'historical', frames: [{ id: 'frame1', at,
      path: 'mainnet', needs: scenarioNeeds, needsMode: 'synthetic', source: source('synthetic'),
      quotes: { jUsdt: historical, jUsdd: null } }] });
    expect(result.frames[0].quoteModes).toEqual(['snapshot']);
    expect(result.frames[0].displayMode).toBe('mixed');
    expect(result.frames[0].plans[1].source?.mode).toBe('snapshot');
    expect(result.frames[0].plans[1].eligibility.reasons).toContain('non_live_data');
  });

  it('rejects live or future data in a replay frame', () => {
    const frame = { id: 'f', at, path: 'mainnet' as const, needs: scenarioNeeds,
      needsMode: 'synthetic' as const, source: source('synthetic'),
      quotes: { jUsdt: quote('live', '0'), jUsdd: null } };
    expect(() => replayScenario({ id: 'bad', frames: [frame] })).toThrow(/모드/);
    expect(() => replayScenario({ id: 'bad', frames: [{ ...frame,
      quotes: { jUsdt: { ...syntheticQuote, source: source('synthetic', '2026-10-01T03:00:00.000Z') }, jUsdd: null } }] })).toThrow(/시각/);
    const futureCost = quote('synthetic', '0');
    futureCost.costs[0].estimatedAt = '2026-10-01T03:00:00.000Z';
    expect(() => replayScenario({ id: 'bad', frames: [{ ...frame,
      quotes: { jUsdt: futureCost, jUsdd: null } }] })).toThrow(/비용 견적/);
  });
});
