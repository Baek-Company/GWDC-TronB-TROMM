import { describe, expect, it } from 'vitest';
import { calculateLiquidity, calculatePlan, createDatedAllocation, createMainnetPlans, createNilePlans } from '../shared/planning';
import { datedAllocationSchema, executionRecordSchema, instantSchema, productQuoteSchema, userNeedsSchema,
  type CostEstimate, type ProductQuote, type Token, type UserNeeds } from '../shared/schemas';

const now = new Date('2026-09-29T03:00:00.000Z');
const usdt = { symbol: 'USDT', address: 'TUSDT', decimals: 6 };
const usdd = { symbol: 'USDD', address: 'TUSDD', decimals: 18 };
const trx = { symbol: 'TRX', address: null, decimals: 6 };
const source = { sourceUrl: 'https://example.org/verified', chain: 'mainnet' as const,
  fetchedAt: now.toISOString(), sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const };

function mainnetNeeds(overrides: Partial<UserNeeds> = {}): UserNeeds {
  return userNeedsSchema.parse({
    chain: 'mainnet', asset: usdt, amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29',
    expenses: [{ date: '2026-10-06', amount: '200', asset: usdt }], liquidReserve: '0',
    riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
    inputVersion: 1, confirmedVersion: 1, ...overrides,
  });
}

function cost(kind: CostEstimate['kind'], amount: string | null, asset: Token = usdt): CostEstimate {
  return { kind, amount, asset, conversionRateToInput: null, estimatedAt: now.toISOString(), source };
}

function jUsdtQuote(overrides: Partial<ProductQuote> = {}): ProductQuote {
  return productQuoteSchema.parse({
    id: 'jUSDT', quoteVersion: '1', product: 'justlend_jusdt', chain: 'mainnet',
    marketAddress: 'TJUSDT', inputToken: usdt, depositToken: usdt,
    receiptToken: { symbol: 'jUSDT', address: 'TJUSDT', decimals: 8 },
    baseRate: { kind: 'apy', rate: '0.05' }, reward: null,
    liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 }, conversion: null,
    costs: [cost('approval', '0.2'), cost('deposit', '0.2'), cost('withdraw', '0.2')],
    status: 'active', risks: [], source, ...overrides,
  });
}

describe('confirmed cash flow and shared schemas', () => {
  it('reserves multiple due expenses once plus the additional reserve', () => {
    const needs = mainnetNeeds({
      expenses: [
        { date: '2026-10-06', amount: '200', asset: usdt },
        { date: '2026-10-20', amount: '150.25', asset: usdt },
        { date: '2026-11-12', amount: '50', asset: usdt },
      ], liquidReserve: '100.05',
    });
    expect(calculateLiquidity(needs)).toEqual({
      protectedAmount: '500.3', investableAmount: '499.7',
      dueExpenses: [{ date: '2026-10-06', amount: '200' }, { date: '2026-10-20', amount: '150.25' }],
    });
    expect(calculateLiquidity(mainnetNeeds({ expenses: [{ date: '2026-11-12', amount: '200', asset: usdt }] })).investableAmount).toBe('800');
    const future = createDatedAllocation(mainnetNeeds({ expenses: [
      { date: '2026-10-06', amount: '200', asset: usdt },
      { date: '2026-11-12', amount: '300', asset: usdt },
    ] }), [jUsdtQuote()], { now });
    expect(future.legs.find(leg => leg.dueDate === '2026-11-12')).toMatchObject({
      amount: '300', decision: 'hold',
    });
    expect(future.legs.find(leg => leg.dueDate === '2026-11-12')?.reasons)
      .toContain('outside_planning_horizon');
    expect(future.legs.find(leg => leg.purpose === 'horizon')?.amount).toBe('500');
    expect(() => calculateLiquidity(mainnetNeeds({ expenses: [
      { date: '2026-10-06', amount: '200', asset: usdt },
      { date: '2026-11-12', amount: '900', asset: usdt },
    ] }))).toThrow(/예정 지출액/);
  });

  it('requires reconfirmation after an input version change and rejects cross-asset spending', () => {
    const changed = mainnetNeeds({ inputVersion: 2, confirmedVersion: 1 });
    expect(calculatePlan(changed, jUsdtQuote(), { now }).eligibility.reasons).toContain('needs_unconfirmed');
    expect(() => calculateLiquidity(mainnetNeeds({ expenses: [{ date: '2026-10-06', amount: '20', asset: usdd }] }))).toThrow(/전환 경로/);
    expect(userNeedsSchema.safeParse({ ...mainnetNeeds(), endDate: '2026-09-29' }).success).toBe(false);
  });
});

describe('Mainnet comparison', () => {
  it('identifies the full confirmed economic input and reuses an ID only for the same plan', () => {
    const base = mainnetNeeds();
    const id = (needs: UserNeeds) => createMainnetPlans(needs, { jUsdt: null, jUsdd: null }, { now }).plans[0].id;
    expect(id(base)).toMatch(/^mainnet:hold:hold:v2:[a-f0-9]{64}$/);
    expect(id(base)).toBe(id(mainnetNeeds()));
    const changed = [
      mainnetNeeds({ expenses: [{ date: '2026-10-07', amount: '200', asset: usdt }] }),
      mainnetNeeds({ endDate: '2026-10-30' }),
      mainnetNeeds({ liquidReserve: '1' }),
      mainnetNeeds({ riskPreference: 'growth' }),
      mainnetNeeds({ acceptsUsddRisk: true }),
      mainnetNeeds({ confirmedVersion: null }),
    ];
    expect(new Set([id(base), ...changed.map(id)]).size).toBe(changed.length + 1);
    expect(id(base)).not.toBe('mainnet:hold:hold:v1:qnone:a0');
  });

  it('requires current live provenance even when every required cost is zero', () => {
    const zero = () => [cost('approval', '0'), cost('deposit', '0'), cost('withdraw', '0')];
    const valid = calculatePlan(mainnetNeeds(), jUsdtQuote({ costs: zero() }), { now });
    expect(valid.roundTripCost).toBe('0');
    expect(valid.eligibility.status).toBe('eligible');
    const invalid = [
      { ...zero()[0], estimatedAt: null },
      { ...zero()[0], estimatedAt: '2026-09-28T03:00:00.000Z' },
      { ...zero()[0], source: { ...source, mode: 'synthetic' as const } },
      { ...zero()[0], source: { ...source, chain: 'nile' as const } },
      { ...zero()[0], source: null },
      { ...zero()[0], source: { ...source, sourceUpdatedAt: '2026-09-28T03:00:00.000Z' } },
    ];
    for (const approval of invalid) {
      const plan = calculatePlan(mainnetNeeds(), jUsdtQuote({ costs: [approval, ...zero().slice(1)] }), { now });
      expect(plan.roundTripCost).toBeNull();
      expect(plan.netYield).toBeNull();
      expect(plan.eligibility.reasons).toContain('cost_unverified');
    }
    const staleUnderlying = calculatePlan(mainnetNeeds(), jUsdtQuote({
      source: { ...source, sourceUpdatedAt: '2026-09-28T03:00:00.000Z' },
    }), { now });
    expect(staleUnderlying.eligibility.reasons).toContain('quote_stale');
  });

  it('keeps base yield, verified reward, costs and negative net separate', () => {
    const quote = jUsdtQuote({ baseRate: { kind: 'apr', rate: '0.05' },
      reward: { kind: 'apr', rate: '0.02', token: usdt, verified: true, conversionRateToInput: '1', expiresAt: null },
      costs: [cost('approval', '5'), cost('deposit', '5'), cost('withdraw', '5'), cost('claim', '5')],
    });
    const plan = calculatePlan(mainnetNeeds(), quote, { now });
    expect(plan.allocation).toEqual({ invested: '800', held: '200', protected: '200' });
    expect(Number(plan.baseYield)).toBeCloseTo(800 * 0.05 * 30 / 365, 10);
    expect(Number(plan.verifiedReward)).toBeCloseTo(800 * 0.02 * 30 / 365, 10);
    expect(plan.roundTripCost).toBe('20');
    expect(plan.breakEvenDays).toBe(131);
    expect(Number(plan.netYield)).toBeLessThan(0);
    expect(plan.eligibility.status).toBe('eligible');
    expect(createMainnetPlans(mainnetNeeds(), { jUsdt: quote, jUsdd: null }, { now }).recommendedPlanId).toContain(':hold:');
  });

  it('never substitutes zero for a missing cost or reward, and excludes stale quotes', () => {
    const missing = calculatePlan(mainnetNeeds(), jUsdtQuote({
      costs: [cost('approval', '0'), cost('deposit', '0'), cost('withdraw', null)],
    }), { now });
    expect(missing.roundTripCost).toBeNull();
    expect(missing.netYield).toBeNull();
    expect(missing.verifiedReward).toBeNull();
    expect(missing.eligibility.reasons).toContain('cost_unverified');
    const stale = calculatePlan(mainnetNeeds(), jUsdtQuote({ source: { ...source, fetchedAt: '2026-09-28T03:00:00.000Z' } }), { now });
    expect(stale.eligibility.reasons).toContain('quote_stale');
  });

  it('requires a priced, current TRX conversion and enough exit liquidity', () => {
    const noPrice = calculatePlan(mainnetNeeds(), jUsdtQuote({
      costs: [cost('approval', '1', trx), cost('deposit', '0'), cost('withdraw', '0')],
    }), { now });
    expect(noPrice.netYield).toBeNull();
    expect(noPrice.eligibility.reasons).toContain('cost_unverified');
    const priced = calculatePlan(mainnetNeeds(), jUsdtQuote({
      costs: [{ ...cost('approval', '1', trx), conversionRateToInput: '0.1' }, cost('deposit', '0'), cost('withdraw', '0')],
    }), { now });
    expect(priced.roundTripCost).toBe('0.1');
    const stalePrice = calculatePlan(mainnetNeeds(), jUsdtQuote({
      costs: [{ ...cost('approval', '1', trx), conversionRateToInput: '0.1', estimatedAt: '2026-09-28T03:00:00.000Z' },
        cost('deposit', '0'), cost('withdraw', '0')],
    }), { now });
    expect(stalePrice.roundTripCost).toBeNull();
    const thinExit = calculatePlan(mainnetNeeds(), jUsdtQuote({ liquidity: { exitAvailable: '801', withdrawalDelayDays: 0 } }), { now });
    expect(thinExit.eligibility.reasons).toContain('liquidity_insufficient');
  });

  it('compares A, B and hold, and excludes unverified or declined PSM conversion', () => {
    const jUsdd = productQuoteSchema.parse({ ...jUsdtQuote(), id: 'jUSDD', quoteVersion: '2',
      product: 'psm_jusdd', marketAddress: 'TJUSDD', depositToken: usdd,
      receiptToken: { symbol: 'jUSDD', address: 'TJUSDD', decimals: 8 },
      conversion: { entryCapacity: '10000', exitCapacity: '10000', entryRate: '1', exitRate: '1', outputTokenAddress: usdd.address, verified: true },
      costs: [cost('approval', '0'), cost('conversion_in', '0'), cost('deposit', '0'), cost('withdraw', '0'), cost('conversion_out', '0')],
    });
    const result = createMainnetPlans(mainnetNeeds(), { jUsdt: jUsdtQuote(), jUsdd }, { now });
    expect(result.plans.map(plan => plan.kind)).toEqual(['hold', 'justlend_jusdt', 'psm_jusdd']);
    expect(result.plans[2].eligibility.reasons).toContain('usdd_risk_declined');
    const unverified = calculatePlan(mainnetNeeds({ acceptsUsddRisk: true }), { ...jUsdd,
      conversion: { ...jUsdd.conversion!, outputTokenAddress: 'TWRONG' } }, { now });
    expect(unverified.baseYield).toBeNull();
    expect(unverified.netYield).toBeNull();
    expect(unverified.eligibility.reasons).toContain('conversion_unverified');
    const lowExit = calculatePlan(mainnetNeeds({ acceptsUsddRisk: true }), { ...jUsdd,
      conversion: { ...jUsdd.conversion!, exitCapacity: '801' } }, { now });
    expect(lowExit.eligibility.reasons).toContain('exit_capacity_insufficient');
  });
});

describe('dated allocation', () => {
  function psmQuote(overrides: Partial<ProductQuote> = {}): ProductQuote {
    return productQuoteSchema.parse({ ...jUsdtQuote(), id: 'jUSDD', quoteVersion: 'psm-1',
      product: 'psm_jusdd', marketAddress: 'TJUSDD', depositToken: usdd,
      receiptToken: { symbol: 'jUSDD', address: 'TJUSDD', decimals: 8 },
      baseRate: { kind: 'apr', rate: '0.2' },
      liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 5 },
      conversion: { entryCapacity: '1000000', exitCapacity: '1000000', entryRate: '1', exitRate: '1',
        outputTokenAddress: usdd.address, verified: true },
      costs: [cost('approval', '0.16'), cost('conversion_in', '0.16'), cost('deposit', '0.16'),
        cost('withdraw', '0.16'), cost('conversion_out', '0.16')],
      ...overrides,
    });
  }

  it('places separately due funds on different verified paths and requests withdrawal before each due date', () => {
    const needs = mainnetNeeds({ acceptsUsddRisk: true, acceptsDatedExpenseLiquidityRisk: true,
      expenses: [{ date: '2026-10-06', amount: '200', asset: usdt },
        { date: '2026-10-19', amount: '300', asset: usdt }] });
    const quote = jUsdtQuote({ baseRate: { kind: 'apr', rate: '0.05' },
      costs: [cost('approval', '0.01'), cost('deposit', '0.01'), cost('withdraw', '0.01')] });
    const allocation = createDatedAllocation(needs, [quote, psmQuote()], { now });
    expect(datedAllocationSchema.safeParse(allocation).success).toBe(true);
    expect(allocation.legs.map(leg => [leg.purpose, leg.dueDate, leg.amount, leg.product])).toEqual([
      ['expense', '2026-10-06', '200', 'justlend_jusdt'],
      ['expense', '2026-10-19', '300', 'psm_jusdd'],
      ['horizon', '2026-10-29', '500', 'psm_jusdd'],
    ]);
    expect(allocation.legs[1]).toMatchObject({ daysUntilDue: 20, earningDays: 15,
      withdrawalRequestDate: '2026-10-14', roundTripCost: '0.8', eligibility: 'eligible' });
    expect(Number(allocation.legs[1].expectedNetYield)).toBeCloseTo(300 * 0.2 * 15 / 365 - 0.8, 10);
    expect(allocation).toMatchObject({ totalInvested: '1000', totalHeld: '0', recommendation: 'allocate',
      executionEligible: false });
    expect(Number(allocation.expectedNetYield)).toBeGreaterThan(0);
    expect(createDatedAllocation(needs, [quote, psmQuote()], { now }).id).toBe(allocation.id);
    expect(createMainnetPlans(needs, { jUsdt: quote, jUsdd: psmQuote() }, { now }).datedAllocation?.id)
      .toBe(allocation.id);
  });

  it('holds a due bucket when exit delay consumes its earning period and never invents an unavailable quote', () => {
    const needs = mainnetNeeds({ acceptsDatedExpenseLiquidityRisk: true,
      expenses: [{ date: '2026-10-06', amount: '200', asset: usdt }] });
    const delayed = jUsdtQuote({ liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 7 } });
    const allocation = createDatedAllocation(needs, [delayed, null], { now });
    expect(allocation.legs[0]).toMatchObject({ decision: 'hold', eligibility: 'unverified',
      invested: '0', held: '200', expectedNetYield: null });
    expect(allocation.legs[0].reasons).toContain('withdrawal_delay');
    expect(allocation.legs[0].reasons).toContain('quote_unavailable');
    expect(allocation.expectedNetYield).toBeNull();
    expect(allocation.recommendation).toBe('insufficient_data');
  });

  it('checks shared market cash across dates instead of approving each leg against the same capacity', () => {
    const needs = mainnetNeeds({ acceptsDatedExpenseLiquidityRisk: true, expenses: [
      { date: '2026-10-06', amount: '200', asset: usdt },
      { date: '2026-10-19', amount: '300', asset: usdt },
    ] });
    const constrained = jUsdtQuote({ liquidity: { exitAvailable: '600', withdrawalDelayDays: 0 },
      costs: [cost('approval', '0'), cost('deposit', '0'), cost('withdraw', '0')] });
    const allocation = createDatedAllocation(needs, [constrained], { now });
    expect(allocation.totalInvested).toBe('500');
    expect(allocation.totalHeld).toBe('500');
    expect(allocation.legs.map(leg => leg.decision)).toEqual(['hold', 'hold', 'invest']);
    expect(allocation.legs[0].reasons).toContain('aggregate_exit_or_conversion_capacity_insufficient');
  });

  it('never promotes an expired start date or missing wallet and fee evidence to a dated recommendation', () => {
    const expired = createDatedAllocation(mainnetNeeds({ startDate: '2026-09-28' }), [jUsdtQuote()], { now });
    expect(expired.recommendation).toBe('insufficient_data');
    expect(expired.totalInvested).toBe('0');
    expect(expired.legs[0].reasons).toContain('start_date_not_today');
    const nileNeeds = userNeedsSchema.parse({ ...mainnetNeeds(), chain: 'nile', asset: trx,
      expenses: [{ date: '2026-10-06', amount: '200', asset: trx }] });
    const blocked = createDatedAllocation(nileNeeds, [], { now,
      requireWalletBalance: true, requireFeeReserve: true });
    expect(blocked.totalInvested).toBe('0');
    expect(blocked.legs[0].reasons).toEqual(expect.arrayContaining(['balance_unverified', 'fee_reserve_unverified']));
  });

  it('groups same-day cash needs and rejects a corrupted persisted allocation total', () => {
    const needs = mainnetNeeds({ expenses: [
      { date: '2026-09-29', amount: '50', asset: usdt },
      { date: '2026-09-29', amount: '75', asset: usdt },
      { date: '2026-10-19', amount: '300', asset: usdt },
    ], liquidReserve: '25' });
    const allocation = createDatedAllocation(needs, [jUsdtQuote()], { now });
    expect(allocation.legs[0]).toMatchObject({ dueDate: '2026-09-29', amount: '125',
      decision: 'hold', held: '125', withdrawalRequestDate: null });
    expect(allocation.legs).toHaveLength(3);
    expect(datedAllocationSchema.safeParse({ ...allocation, totalHeld: '0' }).success).toBe(false);
  });
});

describe('execution evidence contract', () => {
  it('cannot mark a transaction confirmed without original tx ID and receipt', () => {
    const base = { id: 'record-1', planId: 'plan-1', previewId: 'preview-1', walletAddress: 'TNILE',
      chain: 'nile', txId: null, status: 'confirmed', receipt: null, actualFeeBaseUnits: null,
      createdAt: now.toISOString(), submittedAt: now.toISOString(), confirmedAt: null, error: null };
    expect(executionRecordSchema.safeParse(base).success).toBe(false);
    expect(executionRecordSchema.safeParse({ ...base, txId: 'abcd', receipt: { result: 'SUCCESS' }, confirmedAt: now.toISOString() }).success).toBe(true);
  });
});

describe('unambiguous instants', () => {
  it('requires a timezone on timestamps while keeping calendar dates separate', () => {
    expect(instantSchema.safeParse('2026-09-29T12:00:00').success).toBe(false);
    expect(instantSchema.safeParse('2026-09-29T12:00:00Z').success).toBe(true);
    expect(instantSchema.safeParse('2026-09-29T21:00:00+09:00').success).toBe(true);
    expect(instantSchema.safeParse('2026-09-29T21:00:00+25:00').success).toBe(false);
    expect(Date.parse('2026-09-29T12:00:00Z')).toBe(Date.parse('2026-09-29T21:00:00+09:00'));
  });
});

describe('separate Nile plan set', () => {
  it('creates stable 80/20 and 50/50 identities, leaving TRX for expense and fees', () => {
    const needs = userNeedsSchema.parse({ ...mainnetNeeds(), chain: 'nile', asset: trx, amount: '100',
      expenses: [], liquidReserve: '20' });
    const nileSource = { ...source, chain: 'nile' as const };
    const nileQuote = productQuoteSchema.parse({ ...jUsdtQuote(), id: 'nile-jTRX', quoteVersion: 'nile-1',
      product: 'justlend_jtrx', chain: 'nile', marketAddress: 'TNILEJTRX', inputToken: trx,
      depositToken: trx, receiptToken: { symbol: 'jTRX', address: 'TNILEJTRX', decimals: 8 },
      costs: [{ ...cost('deposit', '1', trx), source: nileSource }, { ...cost('withdraw', '1', trx), source: nileSource }],
      source: nileSource,
    });
    const { plans, recommendedPlanId } = createNilePlans(needs, nileQuote, { now, walletBalance: '100', feeReserve: '1' });
    expect(plans.map(plan => plan.scenario)).toEqual(['hold', '80_20', '50_50']);
    expect(plans[1].allocation).toEqual({ invested: '79', held: '21', protected: '20' });
    expect(plans[2].allocation).toEqual({ invested: '50', held: '50', protected: '20' });
    expect(plans[1].id).not.toBe(plans[2].id);
    expect(plans[1].eligibility.status).toBe('eligible');
    expect(recommendedPlanId).toBe(plans[0].id); // round-trip costs exceed 30-day interest
    expect(() => createNilePlans(mainnetNeeds(), nileQuote, { now })).toThrow(/Nile TRX/);
    const unavailable = createNilePlans(needs, null, { now });
    expect(unavailable.plans[1].eligibility.reasons).toContain('quote_unavailable');
    expect(unavailable.plans[2].id).not.toBe(unavailable.plans[1].id);
  });
});
