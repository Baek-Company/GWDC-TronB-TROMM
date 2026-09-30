import Decimal from 'decimal.js';
import type { DatedAllocation, Plan } from './schemas';
import type { PlanSet } from './planning';

export type AgentDecision = {
  action: 'recommend' | 'hold' | 'insufficient_data';
  planId: string | null;
  reasonCodes: string[];
  executionEligible: false;
};

export type DatedDecision = {
  action: 'conditional_allocate' | 'hold' | 'insufficient_data';
  allocationId: string;
  bundleQuoteVersion: string | null;
  basis: 'current_conditions_scenario' | 'unavailable';
  reasonCodes: string[];
  executionEligible: false;
};

/** The dated bundle is a separate read-only decision from an individual Plan. */
export function decideDatedAllocation(allocation: DatedAllocation): DatedDecision {
  const bundle = allocation.selectedBundleQuote;
  if (bundle?.status === 'scenario_only' && bundle.scenarioNetYieldUsdt !== null
    && bundle.stressNetYieldUsdt !== null
    && new Decimal(bundle.scenarioNetYieldUsdt).gt(0)
    && new Decimal(bundle.stressNetYieldUsdt).gt(0)
    && allocation.legs.some(leg => leg.decision === 'invest')) {
    return { action: 'conditional_allocate', allocationId: allocation.id,
      bundleQuoteVersion: bundle.quoteVersion, basis: 'current_conditions_scenario',
      reasonCodes: allocation.legs.some(leg => leg.eligibility === 'unverified')
        ? ['selected_buckets_only', 'other_buckets_unverified'] : ['selected_buckets_only'],
      executionEligible: false };
  }
  const reasons = [...new Set(allocation.legs.flatMap(leg => leg.reasons))];
  const incomplete = allocation.legs.some(leg => leg.eligibility === 'unverified');
  return { action: incomplete ? 'insufficient_data' : 'hold', allocationId: allocation.id,
    bundleQuoteVersion: null, basis: 'unavailable',
    reasonCodes: reasons.length ? reasons : ['no_positive_bundle'], executionEligible: false };
}

const informationReasons = new Set([
  'quote_unavailable', 'quote_stale', 'non_live_data', 'market_unknown', 'token_unverified',
  'rate_unavailable', 'cost_unverified', 'conversion_unverified', 'entry_capacity_insufficient',
  'exit_capacity_insufficient', 'liquidity_unverified', 'balance_unverified',
  'fee_reserve_unverified',
]);

/** A plan recommendation is read-only until a separate wallet and execution gate runs. */
export function decidePlanSet(planSet: PlanSet): AgentDecision {
  const hold = planSet.plans.find(plan => plan.kind === 'hold');
  const candidates = planSet.plans.filter(plan => plan.kind !== 'hold');
  const recommended = planSet.plans.find(plan => plan.id === planSet.recommendedPlanId);
  if (recommended && recommended.kind !== 'hold' && recommended.eligibility.status === 'eligible'
    && recommended.netYield !== null && new Decimal(recommended.netYield).gt(0)) {
    if (recommended.source?.mode !== 'live') {
      return { action: 'insufficient_data', planId: hold?.id ?? null,
        reasonCodes: ['non_live_data'], executionEligible: false };
    }
    if (recommended.roundTripCost === null || recommended.netYieldBasis === 'unavailable') {
      return { action: 'insufficient_data', planId: hold?.id ?? null,
        reasonCodes: ['cost_unverified'], executionEligible: false };
    }
    return { action: 'recommend', planId: recommended.id, reasonCodes: ['positive_verified_net_yield'], executionEligible: false };
  }
  const zeroInvestable = candidates.length > 0 && candidates.every(plan =>
    plan.eligibility.reasons.includes('zero_investable'));
  if (zeroInvestable) {
    return { action: 'hold', planId: hold?.id ?? null, reasonCodes: ['zero_investable'], executionEligible: false };
  }
  const reasons = [...new Set(candidates.flatMap(plan => plan.eligibility.reasons))];
  const incomplete = candidates.some(plan => plan.eligibility.status === 'conditional'
    || plan.netYield === null || plan.netYieldBasis === 'unavailable');
  if (incomplete && reasons.some(reason => informationReasons.has(reason))) {
    return { action: 'insufficient_data', planId: hold?.id ?? null,
      reasonCodes: reasons.filter(reason => informationReasons.has(reason)), executionEligible: false };
  }
  const losing = candidates.filter((plan: Plan) => plan.eligibility.status === 'eligible'
    && plan.netYield !== null && new Decimal(plan.netYield).lte(0));
  return { action: 'hold', planId: hold?.id ?? null,
    reasonCodes: losing.length ? ['non_positive_net_yield'] : reasons.length ? reasons : ['no_eligible_plan'],
    executionEligible: false };
}
