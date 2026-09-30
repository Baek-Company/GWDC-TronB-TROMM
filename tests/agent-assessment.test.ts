import { describe, expect, it, vi } from 'vitest';
import { createAssessor } from '../server/agent/assessment';
import type { NileFeeScenario } from '../server/nile-plan-fees';
import type { PortfolioSnapshot } from '../server/agent/portfolio';
import { MAINNET_JUSDT_ADDRESS } from '../server/data/quotes';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import { createJusdtSizingLegRequests } from '../shared/jusdt-allocation';
import { costEvidenceForAction } from '../shared/jusdt-cost-model';
import { supplyRateForDepositRaw } from '../shared/jusdt-rate';
import { toBaseUnits } from '../shared/markets';
import { jusdtReadOnlyEvidenceSchema, jusdtSizingInputsSchema, productQuoteSchema, userNeedsSchema,
  type ActionCostSampleSet, type JusdtQuoteContext, type JusdtRateModel,
  type Plan, type ProductQuote, type Source, type UserNeeds } from '../shared/schemas';

const NOW = new Date('2026-09-29T09:00:00.000Z');
const WALLET = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const USDT = { symbol: 'USDT', address: MAINNET_USDT_ADDRESS, decimals: 6 };
const TRX = { symbol: 'TRX', address: null, decimals: 6 };
const mainnetSource: Source = { sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract',
  chain: 'mainnet', fetchedAt: NOW.toISOString(), sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };

function needs(chain: 'mainnet' | 'nile' = 'mainnet'): UserNeeds {
  const asset = chain === 'mainnet' ? USDT : TRX;
  return userNeedsSchema.parse({
    chain, asset, amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29',
    expenses: [{ date: '2026-10-06', amount: '200', asset }], liquidReserve: '0',
    riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
    inputVersion: 1, confirmedVersion: 1,
  });
}

function quote(): ProductQuote {
  const cost = (kind: 'approval' | 'deposit' | 'withdraw') => ({
    kind, amount: '0', asset: USDT, conversionRateToInput: null,
    estimatedAt: NOW.toISOString(), source: mainnetSource,
  });
  return productQuoteSchema.parse({
    id: 'jUSDT', quoteVersion: 'q1', product: 'justlend_jusdt', chain: 'mainnet',
    marketAddress: MAINNET_JUSDT_ADDRESS, inputToken: USDT, depositToken: USDT,
    receiptToken: { symbol: 'jUSDT', address: MAINNET_JUSDT_ADDRESS, decimals: 8 },
    baseRate: { kind: 'apy', rate: '0.05' }, reward: null,
    liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 },
    conversion: null, costs: [cost('approval'), cost('deposit'), cost('withdraw')],
    status: 'active', risks: [], source: mainnetSource,
  });
}

function snapshot(chain: 'mainnet' | 'nile', amount: string): PortfolioSnapshot {
  const token = chain === 'mainnet' ? USDT : TRX;
  const source: Source = { ...mainnetSource, chain };
  return {
    chain, walletAddress: WALLET, observedAt: NOW.toISOString(),
    declaredHoldings: { asset: token.symbol, amount: '1000' },
    walletBalance: { status: 'ready', token, amountBaseUnits: amount + '000000', amount,
      source, blockNumber: null, reason: null },
    feeBalance: { status: 'unknown', token: TRX, amountBaseUnits: null, amount: null,
      source: null, blockNumber: null, reason: 'not needed for this assessment test' },
    position: { status: 'unknown', receiptToken: token, receiptBalanceBaseUnits: null,
      receiptBalance: null, underlyingToken: token, underlyingValueBaseUnits: null,
      underlyingValue: null, exchangeRateRaw: null, valuationMethod: null,
      marketVerified: false, source: null, blockNumber: null, reason: 'not observed' },
    observedMinusDeclared: null, block: { number: null, status: 'unknown', reason: 'block number unavailable' },
    consistency: 'independent_latest_reads', executionEligible: false,
  };
}

function assessor(portfolio = vi.fn().mockResolvedValue(snapshot('mainnet', '700'))) {
  const mainnetQuotes = vi.fn().mockResolvedValue({
    jUsdt: quote(), jUsdd: null, diagnostics: [], psmEvidence: null,
  });
  return { run: createAssessor({ mainnetQuotes, portfolio, now: () => NOW }),
    portfolio, mainnetQuotes };
}

function sizedHorizon(needsInput: UserNeeds) {
  const validUntil = '2026-09-29T09:01:00.000Z';
  const context: JusdtQuoteContext = {
    version: 'context-1', chain: 'mainnet', walletAddress: WALLET,
    usdtAddress: MAINNET_USDT_ADDRESS, jusdtAddress: MAINNET_JUSDT_ADDRESS,
    marketQuoteVersion: 'q1', needsVersion: needsInput.inputVersion,
    energyPriceSun: '100', bandwidthPriceSun: '100', maxFeeLimitSun: '15000000000',
    trxUsd: '0.1', usdtUsd: '1', availableEnergy: '0', availableBandwidth: '0',
    availableTrxSun: '100000000', observedUsdtRaw: '1000000000', allowanceUsdtRaw: '0',
    sources: [mainnetSource], observationWindow: { firstBlock: '1', lastBlock: '2',
      startedAt: NOW.toISOString(), endedAt: NOW.toISOString() }, validUntil,
  };
  const model: JusdtRateModel = {
    kind: 'whitepaper', modelAddress: MAINNET_JUSDT_ADDRESS, codeIdentity: 'code-1',
    baseRatePerBlockRaw: '0', multiplierPerBlockRaw: '10000000000',
    jumpMultiplierPerBlockRaw: null, kinkRaw: null, reserveFactorRaw: '0',
    cashRaw: '1000000000000', borrowsRaw: '1000000000000', reservesRaw: '0',
    currentSupplyRatePerBlockRaw: '0', source: mainnetSource, validUntil,
  };
  model.currentSupplyRatePerBlockRaw = supplyRateForDepositRaw(model, '0');
  const sampleSet = (action: ActionCostSampleSet['action'], amountRaw: string): ActionCostSampleSet => ({
    action, contractAddress: action === 'approve' ? MAINNET_USDT_ADDRESS : MAINNET_JUSDT_ADDRESS,
    selector: action === 'approve' ? 'approve(address,uint256)'
      : action === 'mint' ? 'mint(uint256)' : 'redeemUnderlying(uint256)',
    samples: Array.from({ length: 5 }, (_, index) => ({
      basis: 'reference_model' as const, amountRaw, energyUnits: '10', signedBytes: '10',
      txId: `${index + 1}`.padStart(64, 'a'),
      source: { ...mainnetSource, sourceUpdatedAt: NOW.toISOString() },
    })),
    codeIdentity: 'code-1', modelVersion: `${action}-${amountRaw}`, validUntil,
  });
  const requests = createJusdtSizingLegRequests(needsInput, NOW);
  return jusdtSizingInputsSchema.parse({ context,
    approvalModels: [sampleSet('approve', '800000000')],
    redeemModels: [sampleSet('redeem_underlying', '800000000')],
    rateModel: model,
    legs: requests.map(request => ({ chain: 'mainnet', walletAddress: WALLET,
      needsVersion: needsInput.inputVersion, bucketKey: request.bucketKey,
      amountUsdtRaw: request.amountUsdtRaw, dueDate: request.dueDate,
      plannedExitDate: request.plannedExitDate, earningDays: request.earningDays,
      contextVersion: context.version, marketQuoteVersion: context.marketQuoteVersion,
      mintCost: costEvidenceForAction(context, 'mint', request.amountUsdtRaw,
        [sampleSet('mint', request.amountUsdtRaw)]),
      redeemModelVersion: 'reference-v1', status: 'scenario_only',
      validUntil, quoteVersion: `leg-${request.bucketKey}` })) });
}

describe('read-only wallet-bounded agent assessment', () => {
  it('caps a Mainnet recommendation at the current observed USDT balance after protected funds', async () => {
    const { run, portfolio } = assessor();
    const result = await run(needs(), WALLET);
    expect(portfolio).toHaveBeenCalledWith({ chain: 'mainnet', address: WALLET,
      declaredHoldings: { asset: 'USDT', amount: '1000' } });
    expect(result).toMatchObject({
      declaredAmount: '1000', declaredInvestableAmount: '800', observedWalletBalance: '700',
      protectedAmount: '200', investableAmount: '500', balanceStatus: 'ready',
      planBasis: 'observed_capped', decision: { action: 'recommend', executionEligible: false },
    });
    expect(result.plans.find(plan => plan.kind === 'justlend_jusdt')?.allocation.invested).toBe('500');
    expect(result.datedAllocation?.amount).toBe('700');
    expect(result.datedAllocation?.legs.map(leg => [leg.dueDate, leg.amount])).toEqual([
      ['2026-10-06', '200'], ['2026-10-29', '500'],
    ]);
    // The mocked market read has no wallet-sized context or action-cost evidence.
    expect(result.datedAllocation?.recommendation).toBe('insufficient_data');
    expect(result.jusdtReadOnlyEvidence).toBeNull();
    expect(result.datedDecision?.action).toBe('insufficient_data');
    expect(result.summary).toContain('700 USDT를 관측');
    expect(result.walletBalanceSource?.chain).toBe('mainnet');
  });

  it('keeps the wallet cap and holds every dated leg when wallet-specific sizing is unknown', async () => {
    const riskAccepted = userNeedsSchema.parse({ ...needs(), acceptsDatedExpenseLiquidityRisk: true });
    const jusdtSizing = vi.fn().mockResolvedValue({ status: 'unknown', reason: 'redeem simulation unavailable',
      source: mainnetSource });
    const run = createAssessor({
      mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: quote(), jUsdd: null,
        diagnostics: [], psmEvidence: null }),
      portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '700')),
      jusdtSizing, now: () => NOW,
    });
    const result = await run(riskAccepted, WALLET);
    expect(jusdtSizing).toHaveBeenCalledWith(expect.objectContaining({
      walletAddress: WALLET, observedUsdtRaw: '700000000', needsVersion: 1,
      legs: [expect.objectContaining({ bucketKey: 'expense:2026-10-06', amountUsdtRaw: '200000000' }),
        expect.objectContaining({ bucketKey: 'horizon:2026-10-29', amountUsdtRaw: '500000000' })],
    }));
    expect(result).toMatchObject({ investableAmount: '500', planBasis: 'observed_capped',
      selectedRouteDataMode: 'mixed_or_unavailable',
      datedDecision: { action: 'insufficient_data', executionEligible: false } });
    expect(result.datedAllocation?.totalInvested).toBe('0');
    expect(result.datedAllocation?.selectedBundleQuote).toBeNull();
    expect(result.jusdtReadOnlyEvidence).toBeNull();
    expect(result.datedAllocation?.legs.every(leg => leg.decision === 'hold')).toBe(true);
    expect(result.diagnostics).toContainEqual({ name: 'jusdt_sizing', status: 'unknown',
      reason: 'redeem simulation unavailable' });
  });

  it('exposes two amount-specific entry readings while redemption and net return stay unknown', async () => {
    const input = userNeedsSchema.parse({ ...needs(), acceptsDatedExpenseLiquidityRisk: true });
    const sizing = sizedHorizon(input);
    sizing.redeemModels = [];
    sizing.legs = sizing.legs.map(leg => ({ ...leg, status: 'partial' as const,
      redeemModelVersion: null }));
    sizing.legs[0].mintCost.sources[0].sourceUrl =
      'https://api.trongrid.io/wallet/triggerconstantcontract?api_key=never-expose';
    const run = createAssessor({
      mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: productQuoteSchema.parse({ ...quote(),
        baseRate: { kind: 'apr', rate: '0.05' } }), jUsdd: null, diagnostics: [], psmEvidence: null }),
      portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
      jusdtSizing: vi.fn().mockResolvedValue({ status: 'ready', value: sizing, source: mainnetSource }),
      now: () => NOW,
    });
    const result = await run(input, WALLET);
    const evidence = result.jusdtReadOnlyEvidence;
    expect(evidence).not.toBeNull();
    expect(evidence).toMatchObject({ chain: 'mainnet', walletAddress: WALLET,
      needsVersion: 1, marketQuoteVersion: 'q1', contextVersion: 'context-1',
      totalCandidateUsdtRaw: '1000000000', approvalActions: 'approve',
      validUntil: '2026-09-29T09:01:00.000Z', executionEligible: false,
      legs: [
        { bucketKey: 'expense:2026-10-06', amountUsdtRaw: '200000000',
          dueDate: '2026-10-06', plannedExitDate: '2026-10-05', redeemModelVersion: null },
        { bucketKey: 'horizon:2026-10-29', amountUsdtRaw: '800000000',
          dueDate: '2026-10-29', plannedExitDate: '2026-10-29', redeemModelVersion: null },
      ],
    });
    expect(jusdtReadOnlyEvidenceSchema.safeParse(evidence).success).toBe(true);
    expect(evidence?.legs.every(leg => leg.mintCost.basis !== 'unknown')).toBe(true);
    expect(evidence?.legs.every(leg => leg.holdReasons.includes('cost_unverified'))).toBe(true);
    expect(evidence?.legs[0].mintCost.sources[0].sourceUrl)
      .toBe('https://api.trongrid.io/wallet/triggerconstantcontract');
    expect(JSON.stringify(evidence)).not.toContain('never-expose');
    expect(result.datedAllocation?.totalInvested).toBe('0');
    expect(result.datedAllocation?.selectedBundleQuote).toBeNull();
    expect(result.datedAllocation?.selectedBundleNetYield).toBeNull();
    expect(result.datedDecision?.action).toBe('insufficient_data');
    expect(jusdtReadOnlyEvidenceSchema.safeParse({ ...evidence, approvalActions: 'none' }).success).toBe(false);
    expect(jusdtReadOnlyEvidenceSchema.safeParse({ ...evidence, executionEligible: true }).success).toBe(false);
    expect(jusdtReadOnlyEvidenceSchema.safeParse({ ...evidence, netYieldUsdt: '1' }).success).toBe(false);
  });

  it('uses the full two-leg candidate amount for zero, sufficient, and partial allowance branches', async () => {
    const input = userNeedsSchema.parse({ ...needs(), acceptsDatedExpenseLiquidityRisk: true });
    for (const [allowanceUsdtRaw, approvalActions] of [
      ['0', 'approve'], ['1000000000', 'none'], ['100000000', 'reset_then_approve'],
    ] as const) {
      const sizing = sizedHorizon(input);
      sizing.context.allowanceUsdtRaw = allowanceUsdtRaw;
      sizing.redeemModels = [];
      sizing.legs = sizing.legs.map(leg => ({ ...leg, status: 'partial' as const,
        redeemModelVersion: null }));
      const run = createAssessor({
        mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: productQuoteSchema.parse({ ...quote(),
          baseRate: { kind: 'apr', rate: '0.05' } }), jUsdd: null, diagnostics: [], psmEvidence: null }),
        portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
        jusdtSizing: vi.fn().mockResolvedValue({ status: 'ready', value: sizing, source: mainnetSource }),
        now: () => NOW,
      });
      const result = await run(input, WALLET);
      expect(result.jusdtReadOnlyEvidence).toMatchObject({
        totalCandidateUsdtRaw: '1000000000', allowanceUsdtRaw, approvalActions,
        executionEligible: false,
      });
      expect(result.datedAllocation?.selectedBundleQuote).toBeNull();
      expect(result.datedAllocation?.selectedBundleNetYield).toBeNull();
    }
  });

  it('fails closed after the 25-second assessment deadline expires', async () => {
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => AbortSignal.abort());
    try {
      const { run, portfolio, mainnetQuotes } = assessor();
      const result = await run(needs(), WALLET);
      expect(timeout).toHaveBeenCalledWith(25_000);
      expect(mainnetQuotes).not.toHaveBeenCalled();
      expect(portfolio).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        balanceStatus: 'unavailable', observedWalletBalance: null, jusdtReadOnlyEvidence: null,
        selectedRouteDataMode: 'mixed_or_unavailable',
        decision: { action: 'insufficient_data', reasonCodes: ['assessment_deadline_exceeded'],
          executionEligible: false },
      });
      expect(result.datedAllocation?.selectedBundleQuote).toBeNull();
    } finally { timeout.mockRestore(); }
  });

  it('does not reuse an earlier wallet quote after a fresh selected-market HTTP 429', async () => {
    const input = needs();
    const selectedQuote = productQuoteSchema.parse({ ...quote(),
      baseRate: { kind: 'apr', rate: '0.05' } });
    const jusdtSizing = vi.fn().mockResolvedValue({ status: 'ready',
      value: sizedHorizon(input), source: mainnetSource });
    const mainnetQuotes = vi.fn()
      .mockResolvedValueOnce({ jUsdt: selectedQuote, jUsdd: null,
        diagnostics: [], psmEvidence: null })
      .mockResolvedValueOnce({ jUsdt: null, jUsdd: null,
        diagnostics: [{ checkId: 'justlend_jusdt_rpc', status: 'unavailable', reason: 'HTTP 429' }],
        psmEvidence: null });
    const run = createAssessor({ mainnetQuotes,
      portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
      jusdtSizing, now: () => NOW });
    const first = await run(input, WALLET);
    expect(first.jusdtReadOnlyEvidence).not.toBeNull();
    const second = await run(input, WALLET);
    expect(mainnetQuotes).toHaveBeenCalledTimes(2);
    expect(jusdtSizing).toHaveBeenCalledTimes(1);
    expect(second.assessmentId).not.toBe(first.assessmentId);
    expect(second.jusdtReadOnlyEvidence).toBeNull();
    expect(second.datedAllocation?.selectedBundleQuote).toBeNull();
    expect(second.datedDecision?.action).not.toBe('conditional_allocate');
    expect(second.diagnostics).toContainEqual({ name: 'justlend_jusdt_rpc',
      status: 'unavailable', reason: 'HTTP 429' });
  });

  it('drops wallet-specific sizing when its wallet, balance, needs, market, or expiry changes', async () => {
    const input = needs();
    for (const mismatch of ['wallet', 'balance', 'needs', 'market', 'expired'] as const) {
      const sizing = sizedHorizon(input);
      if (mismatch === 'wallet') {
        sizing.context.walletAddress = MAINNET_JUSDT_ADDRESS;
        sizing.legs.forEach(leg => { leg.walletAddress = MAINNET_JUSDT_ADDRESS; });
      }
      if (mismatch === 'balance') sizing.context.observedUsdtRaw = '999000000';
      if (mismatch === 'needs') {
        sizing.context.needsVersion = 2;
        sizing.legs.forEach(leg => { leg.needsVersion = 2; });
      }
      if (mismatch === 'market') {
        sizing.context.marketQuoteVersion = 'new-market';
        sizing.legs.forEach(leg => { leg.marketQuoteVersion = 'new-market'; });
      }
      if (mismatch === 'expired') {
        sizing.context.validUntil = NOW.toISOString();
        sizing.legs.forEach(leg => { leg.validUntil = NOW.toISOString(); });
      }
      const run = createAssessor({
        mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: productQuoteSchema.parse({ ...quote(),
          baseRate: { kind: 'apr', rate: '0.05' } }), jUsdd: null, diagnostics: [], psmEvidence: null }),
        portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
        jusdtSizing: vi.fn().mockResolvedValue({ status: 'ready', value: sizing, source: mainnetSource }),
        now: () => NOW,
      });
      const result = await run(input, WALLET);
      expect(result.jusdtReadOnlyEvidence, mismatch).toBeNull();
      expect(result.datedAllocation?.selectedBundleQuote, mismatch).toBeNull();
      expect(result.datedDecision?.action, mismatch).not.toBe('conditional_allocate');
      expect(result.diagnostics).toContainEqual({ name: 'jusdt_sizing', status: 'unknown',
        reason: '금액별 근거의 지갑·잔액·체인·입력·시장 버전 또는 만료시각이 현재 평가와 일치하지 않습니다.' });
    }
  });

  it('preserves a selected jUSDT scenario despite a separate PSM read failure', async () => {
    const confirmed = needs();
    const selectedQuote = productQuoteSchema.parse({ ...quote(),
      baseRate: { kind: 'apr', rate: '0.05' } });
    const jusdtSizing = vi.fn().mockResolvedValue({ status: 'ready', value: sizedHorizon(confirmed),
      source: mainnetSource });
    const run = createAssessor({
      mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: selectedQuote, jUsdd: null,
        diagnostics: [{ checkId: 'psm', status: 'unknown', reason: 'PSM read unavailable' }],
        psmEvidence: null }),
      portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
      jusdtSizing, now: () => NOW,
    });
    const result = await run(confirmed, WALLET);
    expect(jusdtSizing).toHaveBeenCalledOnce();
    expect(result.datedDecision).toMatchObject({ action: 'conditional_allocate',
      basis: 'current_conditions_scenario', executionEligible: false });
    expect(result.datedAllocation).toMatchObject({ totalInvested: '800', totalHeld: '200',
      recommendation: 'conditional_allocate', selectedBundleStatus: 'scenario_only',
      selectedBundleQuote: { validUntil: '2026-09-29T09:01:00.000Z',
        totalDepositUsdtRaw: '800000000' } });
    expect(result.datedAllocation?.legs.find(leg => leg.purpose === 'expense')?.decision).toBe('hold');
    expect(result.diagnostics).toContainEqual({ name: 'psm', status: 'unknown',
      reason: 'PSM read unavailable' });
    expect(result.dataMode).toBe('mixed_or_unavailable');
    expect(result.summary).toContain('읽기 전용 조건부 시나리오');
  });

  it('uses the finished read time when checking freshly fetched sizing sources', async () => {
    const finished = new Date(NOW.getTime() + 10_000);
    const input = needs();
    const sizing = sizedHorizon(input);
    sizing.context.sources = [{ ...mainnetSource, fetchedAt: finished.toISOString() }];
    let clockReads = 0;
    const run = createAssessor({
      now: () => ++clockReads <= 2 ? NOW : finished,
      mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: productQuoteSchema.parse({ ...quote(),
        baseRate: { kind: 'apr', rate: '0.05' } }), jUsdd: null, diagnostics: [], psmEvidence: null }),
      portfolio: vi.fn().mockResolvedValue(snapshot('mainnet', '1000')),
      jusdtSizing: vi.fn().mockResolvedValue({ status: 'ready', value: sizing, source: mainnetSource }),
    });
    const result = await run(input, WALLET);
    expect(result.datedDecision?.action).toBe('conditional_allocate');
    expect(result.assessedAt).toBe(finished.toISOString());
  });

  it('holds an unconnected declared amount as a hypothetical comparison', async () => {
    const { run, portfolio } = assessor();
    const result = await run(needs());
    expect(portfolio).not.toHaveBeenCalled();
    expect(result).toMatchObject({ observedWalletBalance: null, walletAddress: null,
      balanceStatus: 'not_connected', planBasis: 'declared_hypothetical',
      declaredInvestableAmount: '800', investableAmount: '0',
      decision: { action: 'insufficient_data', reasonCodes: ['balance_unverified'], executionEligible: false } });
    expect(result.plans.find(plan => plan.kind === 'justlend_jusdt')?.eligibility)
      .toMatchObject({ status: 'conditional', reasons: ['balance_unverified'] });
    expect(result.datedAllocation?.recommendation).toBe('insufficient_data');
    expect(result.jusdtReadOnlyEvidence).toBeNull();
    expect(result.summary).toContain('가정 비교');
  });

  it('holds when observed funds cannot cover scheduled expense protection', async () => {
    const { run } = assessor(vi.fn().mockResolvedValue(snapshot('mainnet', '100')));
    const result = await run(needs(), WALLET);
    expect(result).toMatchObject({ observedWalletBalance: '100', investableAmount: '0',
      planBasis: 'declared_hypothetical',
      decision: { action: 'hold', reasonCodes: ['balance_insufficient'], executionEligible: false } });
    expect(result.plans.find(plan => plan.kind === 'justlend_jusdt')?.eligibility)
      .toMatchObject({ status: 'excluded', reasons: ['balance_insufficient'] });
  });

  it('rejects stale, wrong-chain or internally inconsistent observations as recommendation evidence', async () => {
    const stale = snapshot('mainnet', '700');
    stale.walletBalance.source = { ...mainnetSource, fetchedAt: '2026-09-29T08:55:00.000Z' };
    const wrongChain = snapshot('nile', '700');
    const wrongUnits = snapshot('mainnet', '700');
    wrongUnits.walletBalance.amountBaseUnits = '1';
    for (const observed of [stale, wrongChain, wrongUnits]) {
      const { run } = assessor(vi.fn().mockResolvedValue(observed));
      const result = await run(needs(), WALLET);
      expect(result.observedWalletBalance).toBeNull();
      expect(result.investableAmount).toBe('0');
      expect(result.decision.reasonCodes).toContain('balance_unverified');
    }
  });

  it('applies the same protected-fund cap to Nile scenarios', async () => {
    const portfolio = vi.fn().mockResolvedValue(snapshot('nile', '500'));
    const nileQuote = vi.fn().mockResolvedValue({ jTrx: null, diagnostics: [] });
    const run = createAssessor({ nileQuote, portfolio, now: () => NOW });
    const result = await run(needs('nile'), WALLET);
    expect(result).toMatchObject({ observedWalletBalance: '500', investableAmount: '300',
      planBasis: 'observed_capped', decision: { executionEligible: false } });
    expect(result.jusdtReadOnlyEvidence).toBeNull();
    expect(result.plans.filter(plan => plan.kind === 'justlend_jtrx').map(plan => plan.allocation.invested))
      .toEqual(['300', '250']);
    expect(nileQuote).toHaveBeenCalledWith(WALLET);
  });

  it('attaches Nile future-fee references without changing verified plan economics or execution decisions', async () => {
    const nileSource: Source = { ...mainnetSource, chain: 'nile',
      sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract' };
    const market = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
    const nileProduct = productQuoteSchema.parse({ id: 'nile-jtrx', quoteVersion: 'nile-q1',
      product: 'justlend_jtrx', chain: 'nile', marketAddress: market,
      inputToken: TRX, depositToken: TRX,
      receiptToken: { symbol: 'jTRX', address: market, decimals: 8 },
      baseRate: null, reward: null,
      liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 },
      conversion: null, costs: [], status: 'active', risks: [], source: nileSource });
    const nileFees = vi.fn(async (_needs: UserNeeds, plans: Plan[]) =>
      plans.filter(plan => plan.kind === 'justlend_jtrx').map((plan): NileFeeScenario => ({
        planId: plan.id, status: 'reference_scenario', basis: 'representative_simulation',
        amountSun: toBaseUnits(plan.allocation.invested, 6), jTokenAmountRaw: '30000000000',
        depositFeeSun: '1000000', estimatedRedeemFeeSun: '2000000',
        stressRedeemFeeSun: '4000000', estimatedRoundTripFeeSun: '3000000',
        stressRoundTripFeeSun: '5000000', feeReserveSun: '6000000',
        postReserveInvestableSun: '294000000',
        reserveStatus: BigInt(toBaseUnits(plan.allocation.invested, 6)) > 294000000n ? 'insufficient' : 'ready',
        economicDepositSun: BigInt(toBaseUnits(plan.allocation.invested, 6)) > 294000000n
          ? '294000000' : toBaseUnits(plan.allocation.invested, 6),
        economicFeeReserveSun: '6000000',
        economicSizingStatus: 'ready',
        referenceAccountAddress: WALLET, referenceTxIds: [],
        sourceUrl: nileSource.sourceUrl, fetchedAt: NOW.toISOString(),
        validUntil: new Date(NOW.getTime() + 60_000).toISOString(),
        reason: null, assumptions: ['미래 무료 자원 0'] })));
    const run = createAssessor({
      nileQuote: vi.fn().mockResolvedValue({ jTrx: nileProduct, diagnostics: [],
        exchangeRateRaw: '1000000000000000000' }),
      portfolio: vi.fn().mockResolvedValue(snapshot('nile', '500')),
      nileFees, now: () => NOW,
    });
    const result = await run(needs('nile'), WALLET);
    expect(nileFees).toHaveBeenCalledWith(expect.objectContaining({ amount: '500' }),
      result.plans, WALLET, '1000000000000000000');
    expect(result.nileFeeScenarios).toHaveLength(2);
    expect(result.nileFeeScenarios.every(item => item.status === 'reference_scenario')).toBe(true);
    expect(result.plans.filter(plan => plan.kind === 'justlend_jtrx').every(plan =>
      plan.netYield === null && plan.roundTripCost === null)).toBe(true);
    expect(result.decision.executionEligible).toBe(false);
    expect(result.dataMode).toBe('mixed_or_unavailable');
    const failure = await createAssessor({
      nileQuote: vi.fn().mockResolvedValue({ jTrx: nileProduct, diagnostics: [] }),
      portfolio: vi.fn().mockResolvedValue(snapshot('nile', '500')),
      nileFees: vi.fn().mockRejectedValue(new Error('HTTP 429')), now: () => NOW,
    })(needs('nile'), WALLET);
    expect(failure.nileFeeScenarios).toEqual([]);
    expect(failure.decision).toEqual(result.decision);
    expect(failure.diagnostics).toContainEqual(expect.objectContaining({
      name: 'nile_future_redeem_fee', status: 'unknown' }));
  });

  it('rejects an invalid address before reading quotes or a wallet', async () => {
    const { run, portfolio, mainnetQuotes } = assessor();
    await expect(run(needs(), 'not-a-wallet')).rejects.toThrow('TRON 지갑 주소');
    expect(portfolio).not.toHaveBeenCalled();
    expect(mainnetQuotes).not.toHaveBeenCalled();
  });

  it('recalculates the remaining horizon only for today without assuming a due expense was paid', async () => {
    const reassessmentTime = new Date('2026-10-01T03:00:00.000Z');
    const run = createAssessor({
      now: () => reassessmentTime,
      mainnetQuotes: vi.fn().mockResolvedValue({ jUsdt: quote(), jUsdd: null, diagnostics: [], psmEvidence: null }),
    });
    const remaining = await run(needs(), undefined, '2026-10-01');
    expect(remaining.plans[0].startDate).toBe('2026-10-01');
    expect(remaining.plans[0].days).toBe(28);
    expect(remaining.datedAllocation?.startDate).toBe('2026-10-01');
    await expect(run(needs(), undefined, '2026-09-30')).rejects.toThrow(/오늘 날짜/);
    const dueDay = createAssessor({ now: () => new Date('2026-10-06T03:00:00.000Z') });
    await expect(dueDay(needs(), undefined, '2026-10-06')).rejects.toThrow(/이미 도래한 지출/);
  });
});
