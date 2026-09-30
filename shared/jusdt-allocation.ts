import DecimalBase from 'decimal.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { sameToken } from './eligibility';
import { verifiedScenarioApr } from './jusdt-rate';
import { approvalBranch, costEvidenceForAction } from './jusdt-cost-model';
import { datedAllocationSchema, jusdtSizingInputsSchema, productQuoteSchema, userNeedsSchema,
  type CostEvidence, type DatedAllocation, type DatedAllocationLeg, type JusdtBundleQuote,
  type JusdtSizingInputs, type ProductQuote, type UserNeeds } from './schemas';

const Money = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
const SCALE = 1_000_000n;
const DAY = 86_400_000;
const MAX_BUCKETS = 8;

type Bucket = { key: string; purpose: 'expense' | 'horizon'; dueDate: string; amountRaw: bigint;
  plannedExitDate: string; earningDays: number; daysUntilDue: number; blocked: string[] };

export type JusdtSizingLegRequest = { bucketKey: string; amountUsdtRaw: string; dueDate: string;
  plannedExitDate: string; earningDays: number };

function keyHash(value: unknown): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify(value))));
}

function dayShift(date: string, offset: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + offset * DAY).toISOString().slice(0, 10);
}

function daysBetween(start: string, end: string): number {
  return (Date.parse(`${end}T00:00:00.000Z`) - Date.parse(`${start}T00:00:00.000Z`)) / DAY;
}

function toRaw(amount: string): bigint | null {
  const decimal = new Money(amount);
  if (decimal.decimalPlaces() > 6) return null;
  return BigInt(decimal.times(SCALE.toString()).toFixed(0));
}

function fromRaw(raw: bigint): string {
  return new Money(raw.toString()).div(SCALE.toString()).toString();
}

function newestValidUntil(values: string[]): string {
  return values.reduce((minimum, value) => value < minimum ? value : minimum);
}

function bucketsFor(needs: UserNeeds, now: Date): Bucket[] {
  const expenses = new Map<string, bigint>();
  for (const expense of needs.expenses) {
    if (!sameToken(expense.asset, needs.asset)) throw new Error('다른 자산의 지출은 jUSDT 금액 견적에 포함할 수 없습니다.');
    const raw = toRaw(expense.amount);
    if (raw === null) throw new Error('USDT 지출 금액은 소수점 6자리까지 입력해 주세요.');
    expenses.set(expense.date, (expenses.get(expense.date) ?? 0n) + raw);
  }
  const reserveRaw = toRaw(needs.liquidReserve);
  const amountRaw = toRaw(needs.amount);
  if (reserveRaw === null || amountRaw === null) throw new Error('USDT 금액은 소수점 6자리까지 입력해 주세요.');
  const expenseTotal = [...expenses.values()].reduce((sum, raw) => sum + raw, 0n);
  if (expenseTotal + reserveRaw > amountRaw) throw new Error('예비액과 지출액이 보유액보다 큽니다.');
  const horizonRaw = amountRaw - expenseTotal - reserveRaw;
  const today = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const global: string[] = [];
  if (needs.startDate !== today) global.push('start_date_not_today');
  if (needs.confirmedVersion !== needs.inputVersion) global.push('needs_unconfirmed');
  const buckets: Bucket[] = [...expenses.entries()].map(([date, raw]) => {
    const days = daysBetween(needs.startDate, date);
    return { key: `expense:${date}`, purpose: 'expense', dueDate: date, amountRaw: raw,
      plannedExitDate: dayShift(date, -1), earningDays: Math.max(0, days - 1), daysUntilDue: days,
      blocked: [...global, ...(!needs.acceptsDatedExpenseLiquidityRisk ? ['dated_expense_liquidity_risk_declined'] : []),
        ...(date > needs.endDate ? ['outside_planning_horizon'] : []),
        ...(days <= 1 ? ['withdrawal_buffer_insufficient'] : [])] };
  });
  if (horizonRaw > 0n) {
    const days = daysBetween(needs.startDate, needs.endDate);
    buckets.push({ key: `horizon:${needs.endDate}`, purpose: 'horizon', dueDate: needs.endDate,
      amountRaw: horizonRaw, plannedExitDate: needs.endDate,
      earningDays: days, daysUntilDue: days,
      blocked: [...global] });
  }
  buckets.sort((a, b) => a.purpose === b.purpose
    ? a.dueDate.localeCompare(b.dueDate) || a.key.localeCompare(b.key)
    : a.purpose === 'expense' ? -1 : 1);
  let quoted = 0;
  for (const bucket of buckets) {
    if (bucket.blocked.length || bucket.amountRaw === 0n) continue;
    if (quoted++ >= MAX_BUCKETS) bucket.blocked.push('quote_budget_exceeded');
  }
  return buckets;
}

/** The server sizes only this bounded, risk-approved list; all other expense rows remain visible as held. */
export function createJusdtSizingLegRequests(rawNeeds: UserNeeds, now = new Date()): JusdtSizingLegRequest[] {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT' || needs.asset.decimals !== 6) return [];
  return bucketsFor(needs, now).filter(bucket => bucket.blocked.length === 0 && bucket.amountRaw > 0n)
    .map(bucket => ({ bucketKey: bucket.key, amountUsdtRaw: bucket.amountRaw.toString(),
      dueDate: bucket.dueDate, plannedExitDate: bucket.plannedExitDate,
      earningDays: bucket.earningDays }));
}

type ComputedBundle = { quote: JusdtBundleQuote; contributions: Map<string, { netRaw: bigint;
  costRaw: bigint; redeemRaw: bigint; costBasis: DatedAllocationLeg['costBasis'] }>;
  reason: string | null };

function expectedCostSun(cost: CostEvidence, energyPrice: bigint, bandwidthPrice: bigint,
  freeEnergy: bigint, freeBandwidth: bigint): bigint {
  const energy = BigInt(cost.energyUnits!);
  const bandwidth = BigInt(cost.bandwidthBytes!);
  return (energy > freeEnergy ? energy - freeEnergy : 0n) * energyPrice
    + (bandwidth > freeBandwidth ? bandwidth - freeBandwidth : 0n) * bandwidthPrice;
}

function convertSunToUsdtRaw(sun: bigint, context: JusdtSizingInputs['context']): bigint {
  return BigInt(new Money(sun.toString()).times(context.trxUsd!).div(context.usdtUsd!)
    .toDecimalPlaces(0, Money.ROUND_CEIL).toString());
}

function modelCost(input: JusdtSizingInputs, action: CostEvidence['action'], amountRaw: string): CostEvidence {
  return costEvidenceForAction(input.context, action, amountRaw,
    action === 'redeem_underlying' ? input.redeemModels : input.approvalModels);
}

function computeBundle(selected: Bucket[], quote: ProductQuote, sizing: JusdtSizingInputs,
  now: Date): ComputedBundle {
  const ctx = sizing.context;
  const totalRaw = selected.reduce((sum, bucket) => sum + bucket.amountRaw, 0n);
  const versions = selected.map(bucket => sizing.legs.find(leg => leg.bucketKey === bucket.key)!.quoteVersion).sort();
  const approval = approvalBranch(ctx.allowanceUsdtRaw, totalRaw.toString());
  const actions: JusdtBundleQuote['actions'] = [];
  if (approval === 'reset_then_approve') actions.push({ bucketKey: null, cost: modelCost(sizing, 'approve_zero', '0') });
  if (approval === 'approve' || approval === 'reset_then_approve') {
    actions.push({ bucketKey: null, cost: modelCost(sizing, 'approve', totalRaw.toString()) });
  }
  for (const bucket of selected) actions.push({ bucketKey: bucket.key,
    cost: sizing.legs.find(leg => leg.bucketKey === bucket.key)!.mintCost });
  let rate: string | null = null;
  try { if (sizing.rateModel) rate = verifiedScenarioApr(sizing.rateModel, totalRaw.toString()); }
  catch { rate = null; }
  const gross = new Map<string, bigint>();
  const redeem = new Map<string, bigint>();
  for (const bucket of selected) {
    const earned = rate === null ? 0n : BigInt(new Money(bucket.amountRaw.toString())
      .times(rate).times(bucket.earningDays).div(365).toDecimalPlaces(0, Money.ROUND_DOWN).toString());
    gross.set(bucket.key, earned);
    const amount = bucket.amountRaw + earned;
    redeem.set(bucket.key, amount);
    actions.push({ bucketKey: bucket.key, cost: modelCost(sizing, 'redeem_underlying', amount.toString()) });
  }
  const validUntil = newestValidUntil([ctx.validUntil, ...selected.map(bucket =>
    sizing.legs.find(leg => leg.bucketKey === bucket.key)!.validUntil),
  ...(sizing.rateModel ? [sizing.rateModel.validUntil] : [])]);
  const reasons: string[] = [];
  if (rate === null) reasons.push('rate_model_unverified');
  if (approval === 'unknown') reasons.push('allowance_unverified');
  if (ctx.trxUsd === null || ctx.usdtUsd === null) reasons.push('price_unverified');
  if (ctx.availableEnergy === null || ctx.availableBandwidth === null || ctx.availableTrxSun === null
    || ctx.observedUsdtRaw === null) reasons.push('wallet_resources_unverified');
  if (Date.parse(validUntil) <= now.getTime()) reasons.push('quote_stale');
  if (ctx.sources.length === 0 || ctx.sources.some(source => {
    const fetchedAge = now.getTime() - Date.parse(source.fetchedAt);
    const updatedAge = source.sourceUpdatedAt === null ? null
      : now.getTime() - Date.parse(source.sourceUpdatedAt);
    return source.chain !== 'mainnet' || source.mode !== 'live'
      || fetchedAge < -5_000 || fetchedAge > 60_000
      || (updatedAge !== null && (updatedAge < -60_000 || updatedAge > 300_000));
  })) reasons.push('source_stale_or_unverified');
  if (Date.parse(ctx.observationWindow.endedAt) - Date.parse(ctx.observationWindow.startedAt) > 30_000
    || BigInt(ctx.observationWindow.lastBlock) - BigInt(ctx.observationWindow.firstBlock) > 10n) {
    reasons.push('observation_window_exceeded');
  }
  if (actions.some(action => action.cost.basis === 'unknown' || action.cost.energyUnits === null
    || action.cost.bandwidthBytes === null || action.cost.feeLimitSun === null
    || action.cost.bandwidthBudgetSun === null)) reasons.push('cost_unverified');
  if (quote.liquidity.exitAvailable === null || toRaw(quote.liquidity.exitAvailable) === null) {
    reasons.push('liquidity_unverified');
  } else if ([...redeem.values()].reduce((sum, raw) => sum + raw, 0n) > toRaw(quote.liquidity.exitAvailable)!) {
    reasons.push('aggregate_exit_capacity_insufficient');
  }
  if (ctx.observedUsdtRaw !== null) {
    const needsProtected = BigInt(ctx.observedUsdtRaw) - totalRaw;
    if (needsProtected < 0n) reasons.push('balance_insufficient');
  }
  const complete = reasons.length === 0;
  let expectedSun = 0n;
  let stressSun = 0n;
  let requiredSun = 0n;
  let remainingEnergy = complete ? BigInt(ctx.availableEnergy!) : 0n;
  let remainingBandwidth = complete ? BigInt(ctx.availableBandwidth!) : 0n;
  const completedActions: JusdtBundleQuote['actions'] = [];
  const directCosts = new Map<string, bigint>();
  let approvalCostRaw = 0n;
  if (complete) {
    for (const action of actions) {
      const cost = action.cost;
      const energy = BigInt(cost.energyUnits!);
      const bandwidth = BigInt(cost.bandwidthBytes!);
      const maxFee = BigInt(ctx.maxFeeLimitSun);
      const feeLimit = BigInt(cost.feeLimitSun!);
      const bandwidthBudget = BigInt(cost.bandwidthBudgetSun!);
      if (feeLimit > maxFee || feeLimit < energy * BigInt(ctx.energyPriceSun)
        || bandwidthBudget < bandwidth * BigInt(ctx.bandwidthPriceSun)) {
        reasons.push('fee_limit_unverified'); break;
      }
      const exit = cost.action === 'redeem_underlying';
      const fee = expectedCostSun(cost, BigInt(ctx.energyPriceSun), BigInt(ctx.bandwidthPriceSun),
        exit ? 0n : remainingEnergy, exit ? 0n : remainingBandwidth);
      expectedSun += fee;
      stressSun += feeLimit + bandwidthBudget;
      requiredSun += feeLimit + bandwidthBudget;
      if (!exit) {
        remainingEnergy = remainingEnergy > energy ? remainingEnergy - energy : 0n;
        remainingBandwidth = remainingBandwidth > bandwidth ? remainingBandwidth - bandwidth : 0n;
      }
      const amount = convertSunToUsdtRaw(fee, ctx);
      if (action.bucketKey === null) approvalCostRaw += amount;
      else directCosts.set(action.bucketKey, (directCosts.get(action.bucketKey) ?? 0n) + amount);
      completedActions.push({ ...action, cost: { ...cost, estimatedFeeSun: fee.toString(),
        sources: [...new Map([...cost.sources, ...ctx.sources].map(source =>
          [`${source.sourceUrl}:${source.fetchedAt}`, source])).values()] } });
    }
  }
  const costsKnown = complete && completedActions.length === actions.length && reasons.length === 0;
  const currentAmount = costsKnown ? convertSunToUsdtRaw(expectedSun, ctx) : null;
  const stressAmount = costsKnown ? convertSunToUsdtRaw(stressSun, ctx) : null;
  if (costsKnown && BigInt(ctx.availableTrxSun!) < requiredSun) {
    reasons.push('fee_reserve_insufficient');
  }
  const grossTotal = [...gross.values()].reduce((sum, raw) => sum + raw, 0n);
  const expectedNet = currentAmount === null ? null : grossTotal - currentAmount;
  const stressNet = stressAmount === null ? null : grossTotal - stressAmount;
  if (expectedNet !== null && expectedNet <= 0n) reasons.push('non_positive_net_yield');
  if (stressNet !== null && stressNet <= 0n) reasons.push('non_positive_stress_yield');
  const status: JusdtBundleQuote['status'] = costsKnown
    ? 'scenario_only' : actions.length ? 'partial' : 'unavailable';
  const bundle: JusdtBundleQuote = {
    chain: 'mainnet', walletAddress: ctx.walletAddress, needsVersion: ctx.needsVersion,
    contextVersion: ctx.version, inputTokenAddress: ctx.usdtAddress, marketAddress: ctx.jusdtAddress,
    selectedLegVersions: versions, approvalActions: approval,
    actions: status === 'scenario_only' ? completedActions : actions,
    allowanceUsdtRaw: ctx.allowanceUsdtRaw, totalDepositUsdtRaw: totalRaw.toString(),
    scenarioRateApr: rate,
    expectedCostUsdt: status === 'scenario_only' ? fromRaw(currentAmount!) : null,
    stressCostUsdt: status === 'scenario_only' ? fromRaw(stressAmount!) : null,
    requiredFeeTrxSun: status === 'scenario_only' ? requiredSun.toString() : null,
    availableFeeTrxSun: ctx.availableTrxSun,
    scenarioNetYieldUsdt: status === 'scenario_only' ? fromRaw(expectedNet!) : null,
    stressNetYieldUsdt: status === 'scenario_only' ? fromRaw(stressNet!) : null,
    observationWindow: ctx.observationWindow, status, validUntil,
    quoteVersion: `jusdt:bundle:v1:${keyHash([ctx.version, versions, totalRaw.toString(),
      approval, status === 'scenario_only' ? completedActions : actions,
      sizing.rateModel?.codeIdentity ?? null,
      sizing.approvalModels.map(model => model.modelVersion),
      sizing.redeemModels.map(model => model.modelVersion), rate, validUntil])}`,
  };
  const contributions = new Map<string, { netRaw: bigint; costRaw: bigint;
    redeemRaw: bigint; costBasis: DatedAllocationLeg['costBasis'] }>();
  if (status === 'scenario_only') {
    let approvalRemaining = approvalCostRaw;
    selected.forEach((bucket, index) => {
      const share = index === selected.length - 1 ? approvalRemaining
        : approvalCostRaw * bucket.amountRaw / totalRaw;
      approvalRemaining -= share;
      const own = (directCosts.get(bucket.key) ?? 0n) + share;
      const bases = completedActions.filter(item => item.bucketKey === bucket.key || item.bucketKey === null)
        .map(item => item.cost.basis);
      contributions.set(bucket.key, { netRaw: gross.get(bucket.key)! - own,
        costRaw: own, redeemRaw: redeem.get(bucket.key)!,
        costBasis: bases.every(basis => basis === 'account_simulation')
          ? 'account_simulation' : bases.every(basis => basis === 'reference_model')
            ? 'reference_model' : 'mixed' });
    });
    const contributionSum = [...contributions.values()].reduce((sum, item) => sum + item.netRaw, 0n);
    // Per-action upward conversion rounding can exceed one conversion of the sum.
    // Allocate that conservative difference to the last leg so totals reconcile exactly.
    const rounding = contributionSum - expectedNet!;
    if (rounding !== 0n && selected.length) {
      const last = contributions.get(selected[selected.length - 1].key)!;
      last.costRaw += rounding;
      last.netRaw -= rounding;
    }
  }
  return { quote: bundle, contributions, reason: reasons[0] ?? null };
}

/** Pure, bounded comparison of all combinations of up to eight amount/date buckets. */
export function createSizedJusdtAllocation(rawNeeds: UserNeeds, rawQuote: ProductQuote | null,
  rawSizing: JusdtSizingInputs | null, now = new Date()): DatedAllocation {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT' || needs.asset.decimals !== 6) {
    throw new Error('Mainnet USDT 요구사항만 jUSDT 금액별 견적을 계산할 수 있습니다.');
  }
  const quote = rawQuote ? productQuoteSchema.parse(rawQuote) : null;
  const sizing = rawSizing ? jusdtSizingInputsSchema.parse(rawSizing) : null;
  const buckets = bucketsFor(needs, now);
  const prerequisites: string[] = [];
  if (!quote || quote.product !== 'justlend_jusdt' || quote.chain !== 'mainnet') prerequisites.push('quote_unavailable');
  else if (quote.status !== 'active' || quote.source.mode !== 'live'
    || quote.source.accessMethod !== 'rpc'
    || !sameToken(quote.inputToken, needs.asset) || !sameToken(quote.depositToken, needs.asset)
    || quote.baseRate?.kind !== 'apr'
    || Date.parse(quote.source.fetchedAt) < now.getTime() - 60_000) prerequisites.push('market_unverified');
  if (!sizing) prerequisites.push('sizing_unavailable');
  else if (sizing.context.needsVersion !== needs.inputVersion || !quote
    || sizing.context.marketQuoteVersion !== quote.quoteVersion
    || sizing.context.usdtAddress !== needs.asset.address
    || sizing.context.jusdtAddress !== quote.marketAddress) prerequisites.push('context_mismatch');
  if (sizing?.context.observedUsdtRaw !== null && sizing?.context.observedUsdtRaw !== undefined) {
    const needRaw = toRaw(needs.amount);
    if (needRaw !== null && BigInt(sizing.context.observedUsdtRaw) < needRaw) prerequisites.push('balance_insufficient');
  }
  const candidates = buckets.filter(bucket => bucket.blocked.length === 0);
  const legMap = new Map(sizing?.legs.map(leg => [leg.bucketKey, leg]) ?? []);
  for (const bucket of candidates) {
    const leg = legMap.get(bucket.key);
    if (sizing && (!leg || leg.amountUsdtRaw !== bucket.amountRaw.toString()
      || leg.dueDate !== bucket.dueDate || leg.plannedExitDate !== bucket.plannedExitDate
      || leg.earningDays !== bucket.earningDays)) bucket.blocked.push('sized_quote_unavailable');
  }
  const usable = candidates.filter(bucket => bucket.blocked.length === 0);
  let winner: { selected: Bucket[]; computed: ComputedBundle } | null = null;
  if (prerequisites.length === 0 && quote && sizing) {
    for (let mask = 1; mask < 2 ** usable.length; mask++) {
      const selected = usable.filter((_, index) => (mask & (1 << index)) !== 0);
      const computed = computeBundle(selected, quote, sizing, now);
      const bundle = computed.quote;
      if (bundle.status !== 'scenario_only' || bundle.scenarioNetYieldUsdt === null
        || bundle.stressNetYieldUsdt === null || new Money(bundle.scenarioNetYieldUsdt).lte(0)
        || new Money(bundle.stressNetYieldUsdt).lte(0) || computed.reason !== null) continue;
      if (!winner) { winner = { selected, computed }; continue; }
      const current = winner.computed.quote;
      const stress = new Money(bundle.stressNetYieldUsdt).comparedTo(current.stressNetYieldUsdt!);
      const expected = new Money(bundle.scenarioNetYieldUsdt).comparedTo(current.scenarioNetYieldUsdt!);
      const invested = BigInt(bundle.totalDepositUsdtRaw) - BigInt(current.totalDepositUsdtRaw);
      const lex = selected.map(bucket => bucket.key).sort().join('|')
        .localeCompare(winner.selected.map(bucket => bucket.key).sort().join('|'));
      if (stress > 0 || (stress === 0 && (expected > 0 || (expected === 0
        && (invested < 0n || (invested === 0n && lex < 0)))))) winner = { selected, computed };
    }
  }
  const selectedKeys = new Set(winner?.selected.map(bucket => bucket.key) ?? []);
  const legs: DatedAllocationLeg[] = buckets.map(bucket => {
    const chosen = selectedKeys.has(bucket.key);
    const contribution = winner?.computed.contributions.get(bucket.key);
    const sized = legMap.get(bucket.key);
    if (chosen && contribution && quote && sized && winner) {
      return {
        purpose: bucket.purpose, dueDate: bucket.dueDate, amount: fromRaw(bucket.amountRaw),
        daysUntilDue: bucket.daysUntilDue, decision: 'invest', eligibility: 'eligible',
        product: 'justlend_jusdt', quoteId: quote.id, quoteVersion: quote.quoteVersion,
        routeIdentity: keyHash([quote.chain, quote.product, quote.marketAddress,
          quote.inputToken, quote.depositToken]),
        sizedQuoteVersion: sized.quoteVersion,
        bundleQuoteVersion: winner.computed.quote.quoteVersion,
        plannedRedeemUsdtRaw: contribution.redeemRaw.toString(),
        costBasis: contribution.costBasis, validUntil: winner.computed.quote.validUntil,
        invested: fromRaw(bucket.amountRaw), held: '0', earningDays: bucket.earningDays,
        withdrawalRequestDate: bucket.plannedExitDate,
        expectedNetYield: fromRaw(contribution.netRaw), roundTripCost: fromRaw(contribution.costRaw),
        source: quote.source, reasons: ['current_conditions_scenario'],
      };
    }
    const reasons = [...new Set([...bucket.blocked,
      ...(bucket.blocked.length === 0 ? prerequisites : [])])];
    if (reasons.length === 0 && quote && sizing) {
      reasons.push(computeBundle([bucket], quote, sizing, now).reason ?? 'bundle_not_selected');
    }
    const unverified = reasons.some(reason => ['quote_unavailable', 'market_unverified',
      'sizing_unavailable', 'context_mismatch', 'sized_quote_unavailable', 'cost_unverified',
      'rate_model_unverified', 'allowance_unverified', 'price_unverified',
      'wallet_resources_unverified', 'liquidity_unverified', 'quote_stale',
      'source_stale_or_unverified',
      'observation_window_exceeded', 'fee_limit_unverified', 'quote_budget_exceeded',
      'amount_precision_unverified'].includes(reason));
    return { purpose: bucket.purpose, dueDate: bucket.dueDate, amount: fromRaw(bucket.amountRaw),
      daysUntilDue: bucket.daysUntilDue, decision: 'hold',
      eligibility: unverified ? 'unverified' : 'held', product: null,
      quoteId: null, quoteVersion: null, routeIdentity: null,
      invested: '0', held: fromRaw(bucket.amountRaw), earningDays: 0,
      withdrawalRequestDate: null, expectedNetYield: unverified ? null : '0',
      roundTripCost: null, source: null, reasons };
  });
  const selectedRaw = winner?.selected.reduce((sum, bucket) => sum + bucket.amountRaw, 0n) ?? 0n;
  const incomplete = legs.some(leg => leg.eligibility === 'unverified');
  const selectedQuote = winner?.computed.quote ?? null;
  return datedAllocationSchema.parse({
    id: `mainnet:dated:jusdt:v1:${keyHash([needs, quote?.quoteVersion ?? null,
      sizing?.context.version ?? null, selectedQuote?.quoteVersion ?? null,
      legs.map(leg => [leg.purpose, leg.dueDate, leg.decision, leg.reasons])])}`,
    chain: 'mainnet', asset: needs.asset, inputToken: needs.asset, inputVersion: needs.inputVersion,
    startDate: needs.startDate, endDate: needs.endDate, amount: needs.amount,
    liquidReserve: needs.liquidReserve, feeReserve: null,
    evaluatedQuotes: quote ? [{ product: quote.product, quoteId: quote.id,
      quoteVersion: quote.quoteVersion, source: quote.source }] : [],
    legs, totalInvested: fromRaw(selectedRaw),
    totalHeld: new Money(needs.amount).minus(fromRaw(selectedRaw)).toString(),
    expectedNetYield: incomplete ? null : selectedQuote?.scenarioNetYieldUsdt ?? '0',
    selectedBundleNetYield: selectedQuote?.scenarioNetYieldUsdt ?? null,
    selectedBundleStatus: selectedQuote?.status ?? null,
    selectedBundleQuoteVersion: selectedQuote?.quoteVersion ?? null,
    selectedBundleQuote: selectedQuote,
    recommendation: incomplete ? 'insufficient_data' : selectedQuote ? 'conditional_allocate' : 'hold',
    executionEligible: false, calculatedAt: now.toISOString(),
  });
}
