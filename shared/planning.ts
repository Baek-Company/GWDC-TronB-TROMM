import DecimalBase from 'decimal.js';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, utf8ToBytes } from '@noble/hashes/utils';
import { z } from 'zod';
import { evaluateEligibility, sameToken, type EligibilityOptions } from './eligibility';
import { isCurrentInstant, isCurrentLiveSource } from './provenance';
import { createSizedJusdtAllocation } from './jusdt-allocation';
import { datedAllocationSchema, planSchema, productQuoteSchema, userNeedsSchema,
  type CostEstimate, type DatedAllocation, type DatedAllocationLeg, type JusdtSizingInputs,
  type Plan, type ProductQuote, type UserNeeds } from './schemas';

// 78 integer digits for uint256, plus guard digits for rate arithmetic.
const Decimal = DecimalBase.clone({ precision: 128 });
const Money = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });

export const profileSchema = z.object({
  asset: z.enum(['USDT', 'USDD', 'TRX']),
  amount: z.string().regex(/^\d+(\.\d+)?$/).refine(v => new Decimal(v).gt(0)),
  horizonDays: z.number().int().min(1).max(3650),
  liquidReserve: z.string().regex(/^\d+(\.\d+)?$/),
  riskPreference: z.enum(['conservative', 'balanced', 'growth']),
}).refine(v => new Decimal(v.liquidReserve).lte(v.amount), '필요 유동성이 보유액보다 큽니다.');

// Read-only preview: every promised expense remains protected until a verified exit proves otherwise.
export function previewLiquidity(input: {
  holdings: string; horizonDays: number; expense: string; expenseDay: number; reserve: string;
}) {
  for (const value of [input.holdings, input.expense, input.reserve]) {
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('금액을 0 이상의 숫자로 입력해 주세요.');
  }
  if (!Number.isInteger(input.horizonDays) || input.horizonDays < 1 || input.horizonDays > 3650
    || !Number.isInteger(input.expenseDay) || input.expenseDay < 1 || input.expenseDay > 3650) {
    throw new Error('운용 기간과 지출일은 1~3650일로 입력해 주세요.');
  }
  const holdings = new Decimal(input.holdings);
  const expense = new Decimal(input.expense);
  const reserve = new Decimal(input.reserve);
  if (!holdings.gt(0)) throw new Error('보유 금액은 0보다 커야 합니다.');
  if (expense.gt(holdings)) throw new Error('예정 지출이 보유 금액보다 큽니다.');
  const dueWithinHorizon = input.expenseDay <= input.horizonDays;
  const protectedAmount = reserve.plus(expense);
  if (protectedAmount.gt(holdings)) throw new Error('지출액과 예비액의 합계가 보유 금액보다 큽니다.');
  return {
    dueWithinHorizon,
    protectedAmount: protectedAmount.toString(),
    investableAmount: holdings.minus(protectedAmount).toString(),
  };
}

// Mathematical utility for later planning. Inputs are assumptions, not a product recommendation.
// Base rate is effective APY; reward rate is a simple annual reward assumption.
export function estimateYield(input: {
  principal: string; days: number; baseApy: string; rewardApr: string; totalCost: string;
}) {
  if (!Number.isInteger(input.days) || input.days < 0 || input.days > 3650) throw new Error('Invalid horizon');
  for (const value of [input.principal, input.baseApy, input.rewardApr, input.totalCost]) {
    if (!/^\d+(\.\d+)?$/.test(value)) throw new Error('Invalid non-negative decimal');
  }
  const time = new Decimal(input.days).div(365);
  const principal = new Decimal(input.principal);
  const base = principal.times(new Decimal(1).plus(input.baseApy).pow(time).minus(1));
  const rewards = principal.times(input.rewardApr).times(time);
  return { baseYield: base.toFixed(8), rewardYield: rewards.toFixed(8),
    totalCost: new Decimal(input.totalCost).toFixed(8),
    netYield: base.plus(rewards).minus(input.totalCost).toFixed(8) };
}

export interface LiquidityResult {
  protectedAmount: string;
  investableAmount: string;
  dueExpenses: { date: string; amount: string }[];
}

// Business dates are YYYY-MM-DD in Asia/Seoul; calendar-day differences are independent of the host timezone.
export function planDays(needs: UserNeeds): number {
  const days = (Date.parse(`${needs.endDate}T00:00:00.000Z`) - Date.parse(`${needs.startDate}T00:00:00.000Z`)) / 86_400_000;
  if (!Number.isInteger(days) || days < 1 || days > 3650) throw new Error('운용 기간은 1~3650일이어야 합니다.');
  return days;
}

export function calculateLiquidity(rawNeeds: UserNeeds): LiquidityResult {
  const needs = userNeedsSchema.parse(rawNeeds);
  planDays(needs);
  const dueExpenses = needs.expenses.filter(expense => expense.date <= needs.endDate);
  if (needs.expenses.some(expense => !sameToken(expense.asset, needs.asset))) {
    throw new Error('다른 자산으로 지급할 지출에는 검증된 자산 전환 경로가 필요합니다.');
  }
  // Funds promised after this plan's end are still unavailable to invest today.
  const protectedAmount = needs.expenses.reduce((sum, expense) => sum.plus(expense.amount), new Money(needs.liquidReserve));
  if (protectedAmount.gt(needs.amount)) throw new Error('예정 지출액과 여유액의 합계가 보유 금액보다 큽니다.');
  return {
    protectedAmount: protectedAmount.toString(),
    investableAmount: new Money(needs.amount).minus(protectedAmount).toString(),
    dueExpenses: dueExpenses.map(expense => ({ date: expense.date, amount: expense.amount })),
  };
}

export interface PlanOptions extends EligibilityOptions {
  allocation?: string;
  scenario?: 'max' | '80_20' | '50_50';
  earningDays?: number;
}

function annualReturn(rate: { kind: 'apy' | 'apr'; rate: string }, days: number): MoneyInstance {
  const time = new Money(days).div(365);
  const value = new Money(rate.rate);
  return rate.kind === 'apy' ? new Money(1).plus(value).pow(time).minus(1) : value.times(time);
}
type MoneyInstance = InstanceType<typeof Money>;

function sameCostAsset(cost: CostEstimate, quote: ProductQuote): boolean {
  return sameToken(cost.asset, quote.inputToken);
}

function requiredCostKinds(quote: ProductQuote, rewardApplicable: boolean): CostEstimate['kind'][] {
  const main = quote.product === 'psm_jusdd'
    ? ['conversion_in', 'approval', 'deposit', 'withdraw', 'conversion_out'] as const
    : quote.product === 'justlend_jtrx'
      ? ['deposit', 'withdraw'] as const
      : ['approval', 'deposit', 'withdraw'] as const;
  return [...main, ...(rewardApplicable ? ['claim' as const] : [])];
}

function calculateCosts(quote: ProductQuote, now: Date, maxAgeMs: number, rewardApplicable: boolean): { total: MoneyInstance | null; missing: string[] } {
  const required = new Set<CostEstimate['kind']>(requiredCostKinds(quote, rewardApplicable));
  // A source may also report a separate network cost. Count it when present; unknown means unknown.
  quote.costs.forEach(cost => { if (cost.kind !== 'claim' || rewardApplicable) required.add(cost.kind); });
  let total = new Money(0);
  const missing: string[] = [];
  for (const kind of required) {
    const cost = quote.costs.find(item => item.kind === kind);
    if (!cost || cost.amount === null) { missing.push(kind); continue; }
    if (!isCurrentInstant(cost.estimatedAt, now, maxAgeMs)
      || !isCurrentLiveSource(cost.source, quote.chain, now, maxAgeMs)) {
      missing.push(`${kind}:stale`); continue;
    }
    const amount = new Money(cost.amount);
    const conversion = sameCostAsset(cost, quote) ? new Money(1)
      : cost.conversionRateToInput === null ? null : new Money(cost.conversionRateToInput);
    if (conversion === null) { missing.push(`${kind}:conversion`); continue; }
    total = total.plus(amount.times(conversion));
  }
  return { total: missing.length ? null : total, missing };
}

function breakEvenDays(
  depositPrincipal: MoneyInstance, baseToInput: MoneyInstance,
  rate: ProductQuote['baseRate'], rewardRate: ProductQuote['reward'],
  conversionImpact: MoneyInstance, cost: MoneyInstance | null,
): number | null {
  if (cost === null || rate === null || depositPrincipal.isZero()) return null;
  const netAt = (days: number) => {
    const base = depositPrincipal.times(annualReturn(rate, days)).times(baseToInput);
    const reward = rewardRate?.verified && rewardRate.conversionRateToInput !== null
      ? depositPrincipal.times(annualReturn(rewardRate, days)).times(rewardRate.conversionRateToInput)
      : new Money(0);
    return base.plus(reward).plus(conversionImpact).minus(cost);
  };
  if (netAt(0).gte(0)) return 0;
  if (netAt(3650).lt(0)) return null;
  let low = 0;
  let high = 3650;
  while (low + 1 < high) {
    const mid = Math.floor((low + high) / 2);
    if (netAt(mid).gte(0)) high = mid;
    else low = mid;
  }
  return high;
}

function buildId(needs: UserNeeds, kind: Plan['kind'], scenario: Plan['scenario'], quote: ProductQuote | null,
  allocation: string, earningDays?: number): string {
  const token = (value: UserNeeds['asset']) => [value.symbol, value.address, value.decimals];
  const canonical = {
    chain: needs.chain,
    asset: token(needs.asset),
    amount: new Money(needs.amount).toString(),
    startDate: needs.startDate,
    endDate: needs.endDate,
    expenses: needs.expenses.map(expense => [expense.date, new Money(expense.amount).toString(), ...token(expense.asset)]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b))),
    liquidReserve: new Money(needs.liquidReserve).toString(),
    riskPreference: needs.riskPreference,
    acceptsUsddRisk: needs.acceptsUsddRisk,
    timezone: needs.timezone,
    inputVersion: needs.inputVersion,
    confirmedVersion: needs.confirmedVersion,
    kind,
    scenario,
    allocation: new Money(allocation).toString(),
    earningDays: earningDays ?? planDays(needs),
    quote: quote === null ? null : [quote.id, quote.quoteVersion, quote.product, quote.chain, quote.marketAddress,
      ...token(quote.inputToken), ...token(quote.depositToken)],
  };
  const digest = bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))));
  return `${needs.chain}:${kind}:${scenario}:v2:${digest}`;
}

function holdPlan(needs: UserNeeds, protectedAmount: string, now: Date): Plan {
  const days = planDays(needs);
  return planSchema.parse({
    id: buildId(needs, 'hold', 'hold', null, '0'), kind: 'hold', scenario: 'hold', chain: needs.chain,
    needsVersion: needs.inputVersion, quoteVersion: null, quoteId: null,
    quote: null,
    startDate: needs.startDate, endDate: needs.endDate, days,
    inputToken: needs.asset, depositToken: needs.asset,
    allocation: { invested: '0', held: needs.amount, protected: protectedAmount },
    steps: ['hold'], baseYield: '0', verifiedReward: '0', conversionImpact: '0',
    roundTripCost: '0', netYield: '0', netYieldBasis: 'all_verified', breakEvenDays: 0,
    eligibility: needs.confirmedVersion === needs.inputVersion
      ? { status: 'eligible', reasons: [] } : { status: 'excluded', reasons: ['needs_unconfirmed'] },
    risks: [], source: null, calculatedAt: now.toISOString(),
  });
}

function unavailablePlan(needs: UserNeeds, kind: 'justlend_jusdt' | 'psm_jusdd' | 'justlend_jtrx',
  protectedAmount: string, now: Date, scenario: Plan['scenario'] = 'max', allocation?: string): Plan {
  const invested = allocation ?? new Money(needs.amount).minus(protectedAmount).toString();
  const held = new Money(needs.amount).minus(invested).toString();
  return planSchema.parse({
    id: buildId(needs, kind, scenario, null, invested), kind, scenario, chain: needs.chain,
    needsVersion: needs.inputVersion, quoteVersion: null, quoteId: null,
    quote: null,
    startDate: needs.startDate, endDate: needs.endDate, days: planDays(needs),
    inputToken: needs.asset, depositToken: needs.asset,
    allocation: { invested, held, protected: protectedAmount },
    steps: kind === 'psm_jusdd' ? ['psm_in', 'approve', 'deposit', 'withdraw', 'psm_out']
      : kind === 'justlend_jtrx' ? ['deposit', 'withdraw'] : ['approve', 'deposit', 'withdraw'],
    baseYield: null, verifiedReward: null, conversionImpact: null, roundTripCost: null, netYield: null,
    netYieldBasis: 'unavailable', breakEvenDays: null,
    eligibility: { status: 'excluded', reasons: ['quote_unavailable'] },
    risks: [], source: null, calculatedAt: now.toISOString(),
  });
}

export function calculatePlan(rawNeeds: UserNeeds, rawQuote: ProductQuote | null, options: PlanOptions = {}): Plan {
  const needs = userNeedsSchema.parse(rawNeeds);
  const quote = rawQuote === null ? null : productQuoteSchema.parse(rawQuote);
  const liquidity = calculateLiquidity(needs);
  const now = options.now ?? new Date();
  if (quote === null) throw new Error('상품 견적이 없어 상품별 Plan을 생성할 수 없습니다.');
  if (!['justlend_jusdt', 'psm_jusdd', 'justlend_jtrx'].includes(quote.product)) {
    throw new Error('지원하지 않는 계획 상품입니다.');
  }
  const days = planDays(needs);
  const earningDays = options.earningDays ?? days;
  if (!Number.isInteger(earningDays) || earningDays < 0 || earningDays > days) {
    throw new Error('실제 운용일은 계획 기간 이내여야 합니다.');
  }
  const allocationText = options.allocation ?? liquidity.investableAmount;
  if (!/^\d+(?:\.\d+)?$/.test(allocationText)) throw new Error('투자 금액은 십진수 문자열이어야 합니다.');
  const investedInput = new Money(allocationText);
  if (investedInput.gt(liquidity.investableAmount)) throw new Error('투자 금액이 지출과 여유액을 제외한 상한을 넘습니다.');
  const held = new Money(needs.amount).minus(investedInput);
  let investedDeposit: MoneyInstance | null = investedInput;
  let conversionImpact: MoneyInstance | null = new Money(0);
  if (quote.product === 'psm_jusdd') {
    const conversion = quote.conversion;
    if (conversion?.entryRate && conversion.exitRate && conversion.verified && quote.depositToken.address !== null
      && conversion.outputTokenAddress === quote.depositToken.address) {
      investedDeposit = investedInput.times(conversion.entryRate);
      conversionImpact = investedDeposit.times(conversion.exitRate).minus(investedInput);
    } else {
      investedDeposit = null;
      conversionImpact = null;
    }
  }
  let baseYield: MoneyInstance | null = null;
  let expectedExitDeposit: string | undefined;
  if (investedDeposit !== null && quote.baseRate !== null) {
    baseYield = investedDeposit.times(annualReturn(quote.baseRate, earningDays));
    expectedExitDeposit = investedDeposit.plus(baseYield).toString();
    if (quote.product === 'psm_jusdd' && quote.conversion?.exitRate) baseYield = baseYield.times(quote.conversion.exitRate);
  }
  let rewardYield: MoneyInstance | null = null;
  const rewardApplicable = quote.reward?.verified === true && quote.reward.conversionRateToInput !== null
    && (quote.reward.expiresAt === null || Date.parse(quote.reward.expiresAt) >= Date.parse(`${needs.endDate}T00:00:00+09:00`));
  if (rewardApplicable && quote.reward !== null && quote.reward.conversionRateToInput !== null && investedDeposit !== null) {
    rewardYield = investedDeposit.times(annualReturn(quote.reward, earningDays)).times(quote.reward.conversionRateToInput);
  }
  const costs = calculateCosts(quote, now, options.maxQuoteAgeMs ?? 15 * 60 * 1000, rewardApplicable);
  const netYield = baseYield !== null && conversionImpact !== null && costs.total !== null
    ? baseYield.plus(rewardYield ?? 0).plus(conversionImpact).minus(costs.total) : null;
  const eligibility = evaluateEligibility(needs, quote, investedInput.toString(), {
    ...options, now, expectedExitDeposit, costsVerified: costs.total !== null,
  });
  const breakEven = baseYield !== null && conversionImpact !== null && investedDeposit !== null
    ? breakEvenDays(investedDeposit, new Money(quote.product === 'psm_jusdd' ? quote.conversion!.exitRate! : '1'),
      quote.baseRate, rewardApplicable ? quote.reward : null, conversionImpact, costs.total) : null;
  const kind = quote.product as Plan['kind'];
  const steps: Plan['steps'] = kind === 'psm_jusdd'
    ? ['psm_in', 'approve', 'deposit', 'withdraw', 'psm_out']
    : kind === 'justlend_jtrx' ? ['deposit', 'withdraw'] : ['approve', 'deposit', 'withdraw'];
  if (rewardApplicable) steps.push('claim');
  return planSchema.parse({
    id: buildId(needs, kind, options.scenario ?? 'max', quote, investedInput.toString(), earningDays), kind,
    scenario: options.scenario ?? 'max',
    chain: needs.chain, needsVersion: needs.inputVersion, quoteVersion: quote.quoteVersion, quoteId: quote.id,
    quote,
    startDate: needs.startDate, endDate: needs.endDate, days, earningDays,
    inputToken: quote.inputToken, depositToken: quote.depositToken,
    allocation: { invested: investedInput.toString(), held: held.toString(), protected: liquidity.protectedAmount },
    steps, baseYield: baseYield?.toString() ?? null, verifiedReward: rewardYield?.toString() ?? null,
    conversionImpact: conversionImpact?.toString() ?? null,
    roundTripCost: costs.total?.toString() ?? null, netYield: netYield?.toString() ?? null,
    netYieldBasis: netYield === null ? 'unavailable' : rewardYield === null ? 'base_only' : 'all_verified',
    breakEvenDays: breakEven, eligibility,
    risks: quote.reward?.verified && !rewardApplicable
      ? [...quote.risks, '보상 기간이 계획 종료 전에 만료되어 보상을 계산에서 제외했습니다.'] : quote.risks,
    source: quote.source, calculatedAt: now.toISOString(),
  });
}

type DatedCandidate = {
  quote: ProductQuote;
  plan: Plan;
  earningDays: number;
  withdrawalRequestDate: string;
  entryInput: MoneyInstance;
  exitDeposit: MoneyInstance;
};

type DatedBucket = {
  purpose: DatedAllocationLeg['purpose'];
  dueDate: string;
  amount: MoneyInstance;
  daysUntilDue: number;
  candidates: DatedCandidate[];
  rejectedReasons: string[];
};

function dateAfter(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

function quoteKey(quote: ProductQuote): string {
  return `${quote.chain}:${quote.product}:${quote.id}:${quote.quoteVersion}`;
}

function quoteRouteIdentity(quote: ProductQuote): string {
  return bytesToHex(sha256(utf8ToBytes(JSON.stringify([
    quote.chain, quote.product, quote.id, quote.marketAddress,
    quote.inputToken, quote.depositToken, quote.receiptToken,
    quote.conversion?.outputTokenAddress ?? null,
  ]))));
}

/**
 * Compare each expense date independently. A leg is only an estimate: a later
 * rate, market cash balance, wallet balance, or exit quote may change.
 */
export function createDatedAllocation(
  rawNeeds: UserNeeds, rawQuotes: readonly (ProductQuote | null)[],
  options: Omit<PlanOptions, 'allocation' | 'scenario' | 'earningDays'> = {},
): DatedAllocation {
  const needs = userNeedsSchema.parse(rawNeeds);
  const liquidity = calculateLiquidity(needs);
  const now = options.now ?? new Date();
  const quotes = rawQuotes.filter((quote): quote is ProductQuote => quote !== null).map(quote => productQuoteSchema.parse(quote));
  const supportedQuotes = quotes.filter(quote =>
    ['justlend_jusdt', 'psm_jusdd', 'justlend_jtrx'].includes(quote.product));
  const missingQuoteCount = rawQuotes.length - quotes.length;
  const feeReserve = options.feeReserve === null || options.feeReserve === undefined ? null : new Money(options.feeReserve);
  if (feeReserve !== null && feeReserve.lt(0)) throw new Error('수수료 예비액은 0 이상이어야 합니다.');
  const extraFeeReserve = feeReserve === null ? new Money(0)
    : Money.min(feeReserve, new Money(liquidity.investableAmount));
  const horizonAmount = new Money(liquidity.investableAmount).minus(extraFeeReserve);
  const dueAmounts = new Map<string, MoneyInstance>();
  for (const expense of needs.expenses) {
    dueAmounts.set(expense.date, (dueAmounts.get(expense.date) ?? new Money(0)).plus(expense.amount));
  }
  const rawBuckets: { purpose: DatedBucket['purpose']; dueDate: string; amount: MoneyInstance }[] =
    [...dueAmounts.entries()].map(([dueDate, amount]) => ({ purpose: 'expense', dueDate, amount }));
  if (horizonAmount.gt(0)) rawBuckets.push({ purpose: 'horizon', dueDate: needs.endDate, amount: horizonAmount });

  const globalReasons: string[] = [];
  const todaySeoul = new Date(now.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  if (needs.startDate !== todaySeoul) globalReasons.push('start_date_not_today');
  if (needs.confirmedVersion !== needs.inputVersion) globalReasons.push('needs_unconfirmed');
  if (options.requireWalletBalance && (options.walletBalance === null || options.walletBalance === undefined)) {
    globalReasons.push('balance_unverified');
  } else if (options.requireWalletBalance && new Money(options.walletBalance!).lt(needs.amount)) {
    globalReasons.push('balance_insufficient');
  }
  if (options.requireFeeReserve && feeReserve === null) globalReasons.push('fee_reserve_unverified');
  if (options.requireFeeReserve && feeReserve !== null
    && feeReserve.gt(liquidity.investableAmount)) globalReasons.push('fee_reserve_insufficient');

  const buckets: DatedBucket[] = rawBuckets.map(({ purpose, dueDate, amount }) => {
    const daysUntilDue = (Date.parse(`${dueDate}T00:00:00.000Z`)
      - Date.parse(`${needs.startDate}T00:00:00.000Z`)) / 86_400_000;
    const candidates: DatedCandidate[] = [];
    const rejectedReasons = [...globalReasons];
    if (dueDate > needs.endDate) rejectedReasons.push('outside_planning_horizon');
    if (purpose === 'expense' && !needs.acceptsDatedExpenseLiquidityRisk) {
      rejectedReasons.push('dated_expense_liquidity_risk_declined');
    }
    if (daysUntilDue === 0) rejectedReasons.push('due_today');
    if (amount.decimalPlaces() > needs.asset.decimals) rejectedReasons.push('amount_precision_unverified');
    if (rejectedReasons.length === 0 && daysUntilDue > 0 && amount.decimalPlaces() <= needs.asset.decimals) {
      for (const quote of supportedQuotes) {
        const delay = quote.liquidity.withdrawalDelayDays;
        if (delay === null) { rejectedReasons.push('liquidity_unverified'); continue; }
        if (delay >= daysUntilDue) { rejectedReasons.push('withdrawal_delay'); continue; }
        const earningDays = daysUntilDue - delay;
        const legNeeds = { ...needs, amount: amount.toString(), endDate: dueDate,
          expenses: [], liquidReserve: '0' };
        const plan = calculatePlan(legNeeds, quote, {
          ...options, now, allocation: amount.toString(), earningDays,
          requireWalletBalance: false, requireFeeReserve: false,
        });
        if (plan.eligibility.status !== 'eligible' || plan.netYield === null) {
          rejectedReasons.push(...plan.eligibility.reasons);
          continue;
        }
        if (new Money(plan.netYield).lte(0)) { rejectedReasons.push('non_positive_net_yield'); continue; }
        const entryInput = amount;
        const entryDeposit = quote.product === 'psm_jusdd'
          ? amount.times(quote.conversion!.entryRate!) : amount;
        const exitDeposit = entryDeposit.times(new Money(1).plus(annualReturn(quote.baseRate!, earningDays)));
        candidates.push({ quote, plan, earningDays,
          withdrawalRequestDate: dateAfter(needs.startDate, earningDays),
          entryInput, exitDeposit });
      }
    }
    if (candidates.length === 0 && (missingQuoteCount > 0 || supportedQuotes.length === 0)
      && daysUntilDue > 0 && globalReasons.length === 0
      && !rejectedReasons.includes('dated_expense_liquidity_risk_declined')) {
      rejectedReasons.push('quote_unavailable');
    }
    candidates.sort((a, b) => {
      const comparison = new Money(b.plan.netYield!).comparedTo(a.plan.netYield!);
      return comparison || quoteKey(a.quote).localeCompare(quoteKey(b.quote));
    });
    return { purpose, dueDate, amount, daysUntilDue, candidates,
      rejectedReasons: [...new Set(rejectedReasons)] };
  });

  // Reserve scarce capacity for the legs with the largest verified absolute
  // benefit. Count all selected exits together, even when their dates differ.
  const byBenefit = [...buckets].sort((a, b) => {
    const comparison = new Money(b.candidates[0]?.plan.netYield ?? '0')
      .comparedTo(a.candidates[0]?.plan.netYield ?? '0');
    return comparison || a.dueDate.localeCompare(b.dueDate);
  });
  const used = new Map<string, { entry: MoneyInstance; exit: MoneyInstance }>();
  const chosen = new Map<DatedBucket, DatedCandidate>();
  let committedCosts = new Money(0);
  for (const bucket of byBenefit) {
    for (const candidate of bucket.candidates) {
      const quote = candidate.quote;
      const candidateCost = new Money(candidate.plan.roundTripCost!);
      if (options.requireFeeReserve && feeReserve !== null
        && committedCosts.plus(candidateCost).gt(feeReserve)) {
        bucket.rejectedReasons.push('fee_reserve_insufficient');
        continue;
      }
      const prior = used.get(quoteKey(quote)) ?? { entry: new Money(0), exit: new Money(0) };
      const combinedEntry = prior.entry.plus(candidate.entryInput);
      const combinedExit = prior.exit.plus(candidate.exitDeposit);
      if (quote.liquidity.exitAvailable === null
        || combinedExit.gt(quote.liquidity.exitAvailable)
        || (quote.product === 'psm_jusdd' && (quote.conversion?.entryCapacity === null
          || quote.conversion?.exitCapacity === null
          || combinedEntry.gt(quote.conversion!.entryCapacity!)
          || combinedExit.gt(quote.conversion!.exitCapacity!)))) {
        bucket.rejectedReasons.push('aggregate_exit_or_conversion_capacity_insufficient');
        continue;
      }
      used.set(quoteKey(quote), { entry: combinedEntry, exit: combinedExit });
      chosen.set(bucket, candidate);
      committedCosts = committedCosts.plus(candidateCost);
      break;
    }
  }

  const legs: DatedAllocationLeg[] = buckets.sort((a, b) => a.dueDate.localeCompare(b.dueDate)
    || a.purpose.localeCompare(b.purpose)).map(bucket => {
    const candidate = chosen.get(bucket);
    if (candidate) return {
      purpose: bucket.purpose, dueDate: bucket.dueDate, amount: bucket.amount.toString(),
      daysUntilDue: bucket.daysUntilDue, decision: 'invest', eligibility: 'eligible',
      product: candidate.quote.product as DatedAllocationLeg['product'],
      quoteId: candidate.quote.id, quoteVersion: candidate.quote.quoteVersion,
      routeIdentity: quoteRouteIdentity(candidate.quote),
      invested: bucket.amount.toString(), held: '0', earningDays: candidate.earningDays,
      withdrawalRequestDate: candidate.withdrawalRequestDate,
      expectedNetYield: candidate.plan.netYield!, roundTripCost: candidate.plan.roundTripCost,
      source: candidate.quote.source, reasons: ['positive_verified_net_yield'],
    };
    const reasons = [...new Set(bucket.rejectedReasons)];
    const uncertain = reasons.some(reason => [
      'quote_unavailable', 'quote_stale', 'non_live_data', 'market_unknown', 'token_unverified',
      'rate_unavailable', 'cost_unverified', 'conversion_unverified', 'liquidity_unverified',
      'entry_capacity_insufficient', 'exit_capacity_insufficient', 'balance_unverified',
      'fee_reserve_unverified', 'amount_precision_unverified', 'start_date_not_today',
      'needs_unconfirmed',
    ].includes(reason));
    return {
      purpose: bucket.purpose, dueDate: bucket.dueDate, amount: bucket.amount.toString(),
      daysUntilDue: bucket.daysUntilDue, decision: 'hold',
      eligibility: uncertain || reasons.includes('quote_unavailable') ? 'unverified' : 'held',
      product: null, quoteId: null, quoteVersion: null, routeIdentity: null,
      invested: '0', held: bucket.amount.toString(),
      earningDays: 0, withdrawalRequestDate: null,
      expectedNetYield: uncertain || reasons.includes('quote_unavailable') ? null : '0',
      roundTripCost: null, source: null,
      reasons: reasons.length ? reasons : ['non_positive_net_yield'],
    };
  });
  const totalInvested = legs.reduce((sum, leg) => sum.plus(leg.invested), new Money(0));
  const incomplete = legs.some(leg => leg.eligibility === 'unverified');
  const expectedNetYield = incomplete ? null
    : legs.reduce((sum, leg) => sum.plus(leg.expectedNetYield ?? '0'), new Money(0)).toString();
  const evaluatedQuotes = quotes.map(quote => ({ product: quote.product,
    quoteId: quote.id, quoteVersion: quote.quoteVersion, source: quote.source }))
    .sort((a, b) => `${a.product}:${a.quoteId}`.localeCompare(`${b.product}:${b.quoteId}`));
  const canonical = { needs: { ...needs, expenses: [...needs.expenses].sort((a, b) =>
    `${a.date}:${a.amount}`.localeCompare(`${b.date}:${b.amount}`)) },
  evaluatedQuotes, quoteSlots: rawQuotes.map(quote => quote === null ? null
    : [quote.product, quote.id, quote.quoteVersion, quote.source]),
  feeReserve: feeReserve?.toString() ?? null,
  walletBalance: options.walletBalance ?? null,
  requireWalletBalance: options.requireWalletBalance ?? false,
  requireFeeReserve: options.requireFeeReserve ?? false,
  legs: legs.map(leg => [leg.purpose, leg.dueDate, leg.amount, leg.product,
    leg.quoteId, leg.quoteVersion, leg.routeIdentity, leg.earningDays, leg.expectedNetYield,
    leg.eligibility, leg.reasons]) };
  return datedAllocationSchema.parse({
    id: `${needs.chain}:dated:v1:${bytesToHex(sha256(utf8ToBytes(JSON.stringify(canonical))))}`,
    chain: needs.chain, asset: needs.asset, inputToken: needs.asset,
    inputVersion: needs.inputVersion,
    startDate: needs.startDate, endDate: needs.endDate, amount: needs.amount,
    liquidReserve: needs.liquidReserve, feeReserve: feeReserve?.toString() ?? null,
    evaluatedQuotes, legs, totalInvested: totalInvested.toString(),
    totalHeld: new Money(needs.amount).minus(totalInvested).toString(), expectedNetYield,
    recommendation: incomplete ? 'insufficient_data' : totalInvested.gt(0) ? 'allocate' : 'hold',
    executionEligible: false, calculatedAt: now.toISOString(),
  });
}

export interface PlanSet { plans: Plan[]; recommendedPlanId: string | null; datedAllocation?: DatedAllocation }

function recommend(plans: Plan[]): string | null {
  const candidates = plans.filter(plan => plan.eligibility.status === 'eligible' && plan.netYield !== null);
  candidates.sort((a, b) => new Money(b.netYield!).comparedTo(a.netYield!));
  return candidates[0]?.id ?? null;
}

export function createMainnetPlans(
  rawNeeds: UserNeeds,
  quotes: { jUsdt: ProductQuote | null; jUsdd: ProductQuote | null },
  options: Omit<PlanOptions, 'allocation'> & { jusdtSizing?: JusdtSizingInputs | null } = {},
): PlanSet {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT') throw new Error('Mainnet USDT 요구사항이 필요합니다.');
  if (quotes.jUsdt !== null && quotes.jUsdt.product !== 'justlend_jusdt') throw new Error('jUSDT 견적 상품이 일치하지 않습니다.');
  if (quotes.jUsdd !== null && quotes.jUsdd.product !== 'psm_jusdd') throw new Error('PSM→jUSDD 견적 상품이 일치하지 않습니다.');
  const liquidity = calculateLiquidity(needs);
  const now = options.now ?? new Date();
  const plans = [holdPlan(needs, liquidity.protectedAmount, now)];
  plans.push(quotes.jUsdt ? calculatePlan(needs, quotes.jUsdt, { ...options, now })
    : unavailablePlan(needs, 'justlend_jusdt', liquidity.protectedAmount, now));
  plans.push(quotes.jUsdd ? calculatePlan(needs, quotes.jUsdd, { ...options, now })
    : unavailablePlan(needs, 'psm_jusdd', liquidity.protectedAmount, now));
  return { plans, recommendedPlanId: recommend(plans),
    datedAllocation: 'jusdtSizing' in options
      ? createSizedJusdtAllocation(needs, quotes.jUsdt, options.jusdtSizing ?? null, now)
      : createDatedAllocation(needs, [quotes.jUsdt, quotes.jUsdd], options) };
}

export function createNilePlans(
  rawNeeds: UserNeeds,
  jTrx: ProductQuote | null,
  options: Omit<PlanOptions, 'allocation'> = {},
): PlanSet {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'nile' || needs.asset.symbol !== 'TRX') throw new Error('Nile TRX 요구사항이 필요합니다.');
  if (jTrx !== null && jTrx.product !== 'justlend_jtrx') throw new Error('Nile jTRX 견적 상품이 일치하지 않습니다.');
  const liquidity = calculateLiquidity(needs);
  const now = options.now ?? new Date();
  const amount = new Money(needs.amount);
  const maxInvestable = new Money(liquidity.investableAmount);
  const feeReserve = options.feeReserve === undefined || options.feeReserve === null ? null : new Money(options.feeReserve);
  const withReserve = (share: string) => {
    const cap = feeReserve === null ? maxInvestable : Money.max(0, maxInvestable.minus(feeReserve));
    return Money.min(amount.times(share), cap).toDecimalPlaces(needs.asset.decimals, Money.ROUND_DOWN).toString();
  };
  const allocation80 = withReserve('0.8');
  const allocation50 = withReserve('0.5');
  const plans = [holdPlan(needs, liquidity.protectedAmount, now),
    jTrx ? calculatePlan(needs, jTrx, { ...options, now, allocation: allocation80, scenario: '80_20', requireWalletBalance: true, requireFeeReserve: true })
      : unavailablePlan(needs, 'justlend_jtrx', liquidity.protectedAmount, now, '80_20', allocation80),
    jTrx ? calculatePlan(needs, jTrx, { ...options, now, allocation: allocation50, scenario: '50_50', requireWalletBalance: true, requireFeeReserve: true })
      : unavailablePlan(needs, 'justlend_jtrx', liquidity.protectedAmount, now, '50_50', allocation50),
  ];
  return { plans, recommendedPlanId: recommend(plans),
    datedAllocation: createDatedAllocation(needs, [jTrx], { ...options,
      requireWalletBalance: true, requireFeeReserve: true }) };
}
