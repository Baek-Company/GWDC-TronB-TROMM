import { describe, expect, it } from 'vitest';
import Decimal from 'decimal.js';
import { MAINNET_JUSDT_ADDRESS } from '../server/data/quotes';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import { createJusdtSizingLegRequests, createSizedJusdtAllocation } from '../shared/jusdt-allocation';
import { costEvidenceForAction } from '../shared/jusdt-cost-model';
import { supplyRateForDepositRaw, verifiedScenarioApr } from '../shared/jusdt-rate';
import { jusdtSizingInputsSchema, productQuoteSchema, userNeedsSchema,
  type ActionCostSampleSet, type JusdtQuoteContext, type JusdtRateModel,
  type Source } from '../shared/schemas';

const now = new Date('2026-09-29T03:00:00.000Z');
const wallet = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const usdt = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
const source: Source = { sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract',
  chain: 'mainnet', fetchedAt: now.toISOString(), sourceUpdatedAt: null,
  mode: 'live', accessMethod: 'rpc' };

function needs(risk: boolean) {
  return userNeedsSchema.parse({ chain: 'mainnet', asset: usdt, amount: '1000',
    startDate: '2026-09-29', endDate: '2026-10-29',
    expenses: [{ date: '2026-10-06', amount: '200', asset: usdt }],
    liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
    acceptsDatedExpenseLiquidityRisk: risk, timezone: 'Asia/Seoul',
    inputVersion: 2, confirmedVersion: 2 });
}

function market() {
  return productQuoteSchema.parse({ id: 'jUSDT', quoteVersion: 'market-1',
    product: 'justlend_jusdt', chain: 'mainnet', marketAddress: MAINNET_JUSDT_ADDRESS,
    inputToken: usdt, depositToken: usdt,
    receiptToken: { symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, decimals: 8 },
    baseRate: { kind: 'apr', rate: '0.05' }, reward: null,
    liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 },
    conversion: null, costs: [], status: 'active', risks: [], source });
}

function context(): JusdtQuoteContext {
  return { version: 'context-1', chain: 'mainnet', walletAddress: wallet,
    usdtAddress: MAINNET_USDT_ADDRESS, jusdtAddress: MAINNET_JUSDT_ADDRESS,
    marketQuoteVersion: 'market-1', needsVersion: 2,
    energyPriceSun: '100', bandwidthPriceSun: '100', maxFeeLimitSun: '15000000000',
    trxUsd: '0.1', usdtUsd: '1', availableEnergy: '0', availableBandwidth: '0',
    availableTrxSun: '100000000', observedUsdtRaw: '1000000000', allowanceUsdtRaw: '0',
    sources: [source], observationWindow: { firstBlock: '1', lastBlock: '2',
      startedAt: now.toISOString(), endedAt: now.toISOString() },
    validUntil: '2026-09-29T03:01:00.000Z' };
}

function rateModel(multiplier = '10000000000'): JusdtRateModel {
  const initial: JusdtRateModel = { kind: 'whitepaper', modelAddress: MAINNET_JUSDT_ADDRESS,
    codeIdentity: 'code-1', baseRatePerBlockRaw: '0', multiplierPerBlockRaw: multiplier,
    jumpMultiplierPerBlockRaw: null, kinkRaw: null, reserveFactorRaw: '0',
    cashRaw: '1000000000000', borrowsRaw: '1000000000000', reservesRaw: '0',
    currentSupplyRatePerBlockRaw: '0', source, validUntil: '2026-09-29T03:01:00.000Z' };
  return { ...initial, currentSupplyRatePerBlockRaw: supplyRateForDepositRaw(initial, '0') };
}

function sampleSet(ctx: JusdtQuoteContext, action: ActionCostSampleSet['action'], amount: string,
  energy = '10', count = 5): ActionCostSampleSet {
  const contractAddress = action === 'approve' || action === 'approve_zero'
    ? ctx.usdtAddress : ctx.jusdtAddress;
  const selector = action === 'approve' || action === 'approve_zero'
    ? 'approve(address,uint256)' : action === 'mint' ? 'mint(uint256)' : 'redeemUnderlying(uint256)';
  return { action, contractAddress, selector, samples: Array.from({ length: count }, (_, index) => ({
    basis: 'reference_model' as const, amountRaw: amount,
    energyUnits: energy, signedBytes: '10', txId: `${index + 1}`.padStart(64, 'a'),
    source: { ...source, sourceUpdatedAt: now.toISOString() },
  })), codeIdentity: 'code-1', modelVersion: `${action}-${amount}`,
  validUntil: ctx.validUntil };
}

function sizing(risk: boolean, energy = '10', approvalEnergy = energy) {
  const ctx = context();
  const requests = createJusdtSizingLegRequests(needs(risk), now);
  const mintModels = requests.map(request => sampleSet(ctx, 'mint', request.amountUsdtRaw, energy));
  const redeemModels = [
    sampleSet(ctx, 'redeem_underlying', '200000000', energy),
    sampleSet(ctx, 'redeem_underlying', '800000000', energy),
  ];
  const approvalModels = [sampleSet(ctx, 'approve', '1000000000', approvalEnergy),
    sampleSet(ctx, 'approve', '800000000', approvalEnergy)];
  return jusdtSizingInputsSchema.parse({ context: ctx, approvalModels, redeemModels,
    rateModel: rateModel(),
    legs: requests.map(request => ({ chain: 'mainnet', walletAddress: wallet,
      needsVersion: 2, bucketKey: request.bucketKey, amountUsdtRaw: request.amountUsdtRaw,
      dueDate: request.dueDate, plannedExitDate: request.plannedExitDate,
      earningDays: request.earningDays, contextVersion: ctx.version,
      marketQuoteVersion: ctx.marketQuoteVersion,
      mintCost: costEvidenceForAction(ctx, 'mint', request.amountUsdtRaw, mintModels),
      redeemModelVersion: 'reference-v1', status: 'scenario_only',
      validUntil: ctx.validUntil, quoteVersion: `leg-${request.bucketKey}` })) });
}

describe('Mainnet jUSDT amount/date scenario', () => {
  it('keeps dated expenses liquid until risk is explicitly accepted', () => {
    const requests = createJusdtSizingLegRequests(needs(false), now);
    expect(requests.map(request => request.bucketKey)).toEqual(['horizon:2026-10-29']);
    const result = createSizedJusdtAllocation(needs(false), market(), sizing(false), now);
    expect(result.legs[0]).toMatchObject({ decision: 'hold', invested: '0',
      reasons: ['dated_expense_liquidity_risk_declined'] });
  });

  it('calculates every subset, counts one shared approval, and reconciles contribution yield', () => {
    const result = createSizedJusdtAllocation(needs(true), market(), sizing(true), now);
    expect(result.recommendation).toBe('conditional_allocate');
    expect(result.totalInvested).toBe('1000');
    expect(result.selectedBundleQuote?.approvalActions).toBe('approve');
    expect(result.selectedBundleQuote?.actions.filter(action => action.cost.action === 'approve')).toHaveLength(1);
    expect(result.selectedBundleQuote?.actions.filter(action => action.cost.action === 'mint')).toHaveLength(2);
    expect(result.selectedBundleQuote?.actions.filter(action => action.cost.action === 'redeem_underlying')).toHaveLength(2);
    expect(result.legs.filter(leg => leg.decision === 'invest').map(leg => leg.plannedRedeemUsdtRaw))
      .toHaveLength(2);
    const raw = (value: string) => BigInt(new Decimal(value).times('1000000').toFixed(0));
    const netSum = result.legs.reduce((sum, leg) => sum + raw(leg.expectedNetYield ?? '0'), 0n);
    expect(netSum).toBe(raw(result.selectedBundleNetYield!));
    expect(result.executionEligible).toBe(false);
  });

  it('holds when the observed rate model does not reproduce the current market rate', () => {
    const data = sizing(true);
    data.rateModel!.currentSupplyRatePerBlockRaw = '1';
    expect(verifiedScenarioApr(data.rateModel!, '1000000000')).toBeNull();
    const result = createSizedJusdtAllocation(needs(true), market(), data, now);
    expect(result.totalInvested).toBe('0');
    expect(result.legs.every(leg => leg.decision === 'hold')).toBe(true);
    expect(result.legs.some(leg => leg.reasons.includes('rate_model_unverified'))).toBe(true);
  });

  it('holds when the fee reserve is less than the entry and future exit budget', () => {
    const data = sizing(true);
    data.context.availableTrxSun = '1';
    const result = createSizedJusdtAllocation(needs(true), market(), data, now);
    expect(result.totalInvested).toBe('0');
    expect(result.legs.some(leg => leg.reasons.includes('fee_reserve_insufficient'))).toBe(true);
  });

  it('can select a profitable bundle even when shared approval makes one contribution negative', () => {
    const result = createSizedJusdtAllocation(needs(true), market(), sizing(true, '10', '50000'), now);
    expect(result.recommendation).toBe('conditional_allocate');
    expect(result.totalInvested).toBe('1000');
    expect(new Decimal(result.legs[0].expectedNetYield! ).lt(0)).toBe(true);
    expect(new Decimal(result.selectedBundleNetYield!).gt(0)).toBe(true);
  });

  it('rejects positive expected yield when the stress cost makes it nonpositive', () => {
    const result = createSizedJusdtAllocation(needs(true), market(), sizing(true, '30000'), now);
    expect(result.totalInvested).toBe('0');
    expect(result.legs.some(leg => leg.reasons.includes('non_positive_stress_yield'))).toBe(true);
  });

  it('limits the sized quote to the eight earliest eligible buckets and keeps later dates visible', () => {
    const extra = userNeedsSchema.parse({ ...needs(true),
      expenses: Array.from({ length: 9 }, (_, index) => ({
        date: new Date(Date.parse('2026-10-01T00:00:00.000Z') + index * 86_400_000)
          .toISOString().slice(0, 10), amount: '1', asset: usdt,
      })) });
    const requests = createJusdtSizingLegRequests(extra, now);
    expect(requests).toHaveLength(8);
    expect(requests[0].bucketKey).toBe('expense:2026-10-01');
    const allocation = createSizedJusdtAllocation(extra, market(), null, now);
    expect(allocation.legs).toHaveLength(10);
    expect(allocation.legs[8].reasons).toContain('quote_budget_exceeded');
  });

  it('holds expenses beyond the selected horizon instead of adding them to investable surplus', () => {
    const future = userNeedsSchema.parse({ ...needs(true),
      expenses: [...needs(true).expenses, { date: '2026-11-02', amount: '300', asset: usdt }] });
    expect(createJusdtSizingLegRequests(future, now).map(leg => leg.amountUsdtRaw))
      .toEqual(['200000000', '500000000']);
    const result = createSizedJusdtAllocation(future, market(), null, now);
    expect(result.legs.find(leg => leg.dueDate === '2026-11-02')).toMatchObject({
      decision: 'hold', amount: '300', reasons: ['outside_planning_horizon'],
    });
  });
});
