import DecimalBase from 'decimal.js';
import { z } from 'zod';
import { calculateLiquidity, calculatePlan } from './planning';
import { isCurrentLiveSource } from './provenance';
import { decimalStringSchema, productQuoteSchema, sourceSchema, userNeedsSchema,
  type Plan, type ProductQuote, type UserNeeds } from './schemas';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });

// A quote's single cost estimate cannot be extrapolated to other sizes without this evidence.
export const fixedCostEvidenceSchema = z.object({
  quoteId: z.string().min(1),
  quoteVersion: z.string().min(1),
  minAllocation: decimalStringSchema,
  maxAllocation: decimalStringSchema,
  costBehavior: z.literal('fixed_within_range'),
  source: sourceSchema,
}).refine(value => new Decimal(value.minAllocation).lte(value.maxAllocation), '고정 비용 적용 범위가 뒤집혔습니다.');
export type FixedCostEvidence = z.infer<typeof fixedCostEvidenceSchema>;

export interface MinimumAllocationInput {
  needs: UserNeeds;
  quote: ProductQuote | null;
  fixedCostEvidence?: FixedCostEvidence | null;
  walletBalance?: string | null; // same display units as needs.asset, not base units
  feeReserve?: string | null; // same display units as needs.asset
  now?: Date;
  maxAgeMs?: number;
}

export interface MinimumAllocationResult {
  status: 'found' | 'unavailable' | 'no_break_even';
  reason: string | null;
  minimumAmount: string | null;
  maximumEligibleAmount: string | null;
  netYieldAtMinimum: string | null;
  netYieldBasis: Plan['netYieldBasis'] | null;
  plan: Plan | null;
  quoteVersion: string | null;
  sourceMode: ProductQuote['source']['mode'] | null;
}

export function findMinimumBreakEvenAllocation(raw: MinimumAllocationInput): MinimumAllocationResult {
  const needs = userNeedsSchema.parse(raw.needs);
  const quote = raw.quote === null ? null : productQuoteSchema.parse(raw.quote);
  const empty = (status: MinimumAllocationResult['status'], reason: string,
    maximumEligibleAmount: string | null = null): MinimumAllocationResult => ({
    status, reason, minimumAmount: null, maximumEligibleAmount, netYieldAtMinimum: null,
    netYieldBasis: null, plan: null, quoteVersion: quote?.quoteVersion ?? null,
    sourceMode: quote?.source.mode ?? null,
  });
  if (quote === null) return empty('unavailable', 'quote_unavailable');
  if (!['justlend_jusdt', 'psm_jusdd', 'justlend_jtrx'].includes(quote.product)) return empty('unavailable', 'unsupported_product');
  if (needs.confirmedVersion !== needs.inputVersion) return empty('unavailable', 'needs_unconfirmed');
  if (quote.baseRate === null) return empty('unavailable', 'rate_unavailable');
  const evidence = raw.fixedCostEvidence === undefined || raw.fixedCostEvidence === null
    ? null : fixedCostEvidenceSchema.parse(raw.fixedCostEvidence);
  if (evidence === null || evidence.quoteId !== quote.id || evidence.quoteVersion !== quote.quoteVersion ||
      evidence.source.chain !== quote.chain) return empty('unavailable', 'fixed_cost_range_unverified');
  const now = raw.now ?? new Date();
  const maxAgeMs = raw.maxAgeMs ?? 15 * 60 * 1000;
  const current = (source: ProductQuote['source'] | null) => isCurrentLiveSource(source, quote.chain, now, maxAgeMs);
  if (!current(quote.source) || !current(evidence.source)) return empty('unavailable', 'data_not_current_live');
  if (quote.costs.some(cost => cost.amount !== null && !current(cost.source))) {
    return empty('unavailable', 'cost_source_not_current_live');
  }
  const liquidity = calculateLiquidity(needs);
  const lowerAmount = Decimal.max(0, evidence.minAllocation);
  const upperAmount = Decimal.min(liquidity.investableAmount, evidence.maxAllocation);
  if (upperAmount.lt(lowerAmount) || upperAmount.lte(0)) return empty('unavailable', 'allocation_range_empty');

  const scale = new Decimal(10).pow(needs.asset.decimals);
  const minUnits = BigInt(Decimal.max(1, lowerAmount.times(scale).ceil()).toFixed(0));
  const requestedMax = BigInt(upperAmount.times(scale).floor().toFixed(0));
  const uint256Max = 2n ** 256n - 1n;
  const maxUnits = requestedMax > uint256Max ? uint256Max : requestedMax;
  if (maxUnits < minUnits) return empty('unavailable', 'allocation_range_empty');
  const amount = (units: bigint) => new Decimal(units.toString()).div(scale).toString();
  const options = { now, maxQuoteAgeMs: maxAgeMs, walletBalance: raw.walletBalance, feeReserve: raw.feeReserve,
    requireWalletBalance: quote.chain === 'nile', requireFeeReserve: quote.chain === 'nile' };
  const planAt = (units: bigint) => calculatePlan(needs, quote, { ...options, allocation: amount(units) });
  const first = planAt(minUnits);
  if (first.netYield === null) return empty('unavailable', 'cost_or_conversion_unverified');
  if (first.eligibility.status !== 'eligible') return empty('unavailable', first.eligibility.reasons.join(',') || 'not_eligible');

  // Entry and exit capacity give a monotone maximum feasible amount for fixed-rate, fixed-cost quotes.
  let largestEligible = maxUnits;
  if (planAt(maxUnits).eligibility.status !== 'eligible') {
    let low = minUnits;
    let high = maxUnits;
    while (low + 1n < high) {
      const mid = (low + high) / 2n;
      if (planAt(mid).eligibility.status === 'eligible') low = mid;
      else high = mid;
    }
    largestEligible = low;
  }
  const largestPlan = planAt(largestEligible);
  const largestAmount = amount(largestEligible);
  if (largestPlan.netYield === null) return empty('unavailable', 'cost_or_conversion_unverified', largestAmount);
  if (new Decimal(largestPlan.netYield).lt(0)) return empty('no_break_even', 'net_negative_within_verified_range', largestAmount);

  let low = minUnits;
  let high = largestEligible;
  while (low < high) {
    const mid = (low + high) / 2n;
    const candidate = planAt(mid);
    if (candidate.eligibility.status !== 'eligible' || candidate.netYield === null) {
      return empty('unavailable', 'non_monotone_or_unverified_quote', largestAmount);
    }
    if (new Decimal(candidate.netYield).gte(0)) high = mid;
    else low = mid + 1n;
  }
  const minimumPlan = planAt(low);
  return {
    status: 'found', reason: null, minimumAmount: amount(low), maximumEligibleAmount: largestAmount,
    netYieldAtMinimum: minimumPlan.netYield, netYieldBasis: minimumPlan.netYieldBasis,
    plan: minimumPlan, quoteVersion: quote.quoteVersion, sourceMode: quote.source.mode,
  };
}
