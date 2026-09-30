import DecimalBase from 'decimal.js';
import { z } from 'zod';
import { sameToken } from './eligibility';
import { calculatePlan, createMainnetPlans, createNilePlans } from './planning';
import { isCurrentLiveSource } from './provenance';
import {
  dateSchema, decimalStringSchema, executionRecordSchema, flowCoverageSchema, observationSchema,
  planSchema, positionFlowSchema, positiveDecimalStringSchema, productQuoteSchema, sourceSchema, tokenSchema,
  userNeedsSchema, type ExecutionRecord, type FlowCoverage, type Observation, type Plan,
  type PositionFlow, type ProductQuote, type UserNeeds,
} from './schemas';
export { positionFlowSchema, flowCoverageSchema } from './schemas';
export type { PositionFlow, FlowCoverage } from './schemas';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
type DecimalValue = InstanceType<typeof Decimal>;

export const externalExpenseSchema = z.object({
  id: z.string().min(1), date: dateSchema, amount: positiveDecimalStringSchema, asset: tokenSchema,
});
export type ExternalExpense = z.infer<typeof externalExpenseSchema>;

export interface PositionReviewInput {
  plan: Plan;
  record: ExecutionRecord;
  observation?: Observation | null;
  openingObservation?: Observation | null;
  positionFlows?: PositionFlow[];
  flowCoverage?: FlowCoverage | null;
  externalExpenses?: ExternalExpense[];
}

export interface PositionReview {
  status: 'not_executed' | 'unconfirmed' | 'awaiting_observation' | 'non_live_observation' | 'observed' | 'comparable';
  planId: string;
  chain: Plan['chain'];
  walletAddress: string;
  positionId: string | null;
  expectedEndNetYield: string | null; // plan.inputToken; unchanged original plan
  expectedAsset: Plan['inputToken'];
  expectedEndDate: string;
  observedValue: string | null; // plan.depositToken, current position value, not profit
  observedAsset: Plan['depositToken'];
  observedAt: string | null;
  observedMode: Observation['source']['mode'] | null;
  observedSource: Observation['source'] | null;
  actualFee: string | null; // known original fee, or complete flow fee total when coverage is available
  positionChange: string | null; // depositToken; closing minus opening, before flows
  actualNetChange: string | null; // plan.inputToken; null until complete confirmed flows
  resultKind: 'unrealized' | 'realized' | null;
  varianceFromExpected: string | null; // only realized after the planned horizon, same asset
  externalExpenses: ExternalExpense[]; // informational; never part of investment P&L
  reasons: string[];
}

function units(raw: string, decimals: number): DecimalValue {
  return new Decimal(raw).div(new Decimal(10).pow(decimals));
}

function kstDate(instant: string): string {
  return new Date(Date.parse(instant) + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function checkObservation(plan: Plan, record: ExecutionRecord, observation: Observation): void {
  if (observation.planId !== plan.id || observation.chain !== plan.chain ||
      observation.source.chain !== plan.chain || observation.walletAddress !== record.walletAddress) {
    throw new Error('관측의 계획·체인·지갑이 원 거래와 일치하지 않습니다.');
  }
  if (plan.quote?.receiptToken === null || !plan.quote ||
      !sameToken(observation.receiptToken, plan.quote.receiptToken) ||
      !sameToken(observation.underlyingToken, plan.depositToken)) {
    throw new Error('관측의 영수증/기초 자산이 원 계획과 일치하지 않습니다.');
  }
  if (plan.kind === 'justlend_jtrx' && plan.quote.receiptToken.address !== plan.quote.marketAddress) {
    throw new Error('원 Nile 견적의 jTRX 주소가 시장 주소와 다릅니다.');
  }
  if (plan.kind === 'justlend_jtrx' &&
      observation.positionId !== `nile:${record.walletAddress}:${plan.quote.marketAddress}`) {
    throw new Error('관측의 Nile jTRX 포지션이 원 계획과 일치하지 않습니다.');
  }
  if (plan.kind === 'justlend_jtrx' &&
      BigInt(observation.underlyingValueBaseUnits) !== BigInt(observation.receiptBalanceBaseUnits)
        * BigInt(observation.exchangeRateRaw) / 10n ** 18n) {
    throw new Error('Nile jTRX 잔고·환율·기초자산 가치가 일치하지 않습니다.');
  }
}

export function reviewPlanPosition(raw: PositionReviewInput): PositionReview {
  const plan = planSchema.parse(raw.plan);
  const record = executionRecordSchema.parse(raw.record);
  if (plan.kind === 'hold' || plan.quote === null) throw new Error('거래 상품의 원 계획과 견적이 필요합니다.');
  if (record.planId !== plan.id || record.chain !== plan.chain || plan.quote.chain !== plan.chain ||
      plan.quote.source.chain !== plan.chain || (plan.source !== null && plan.source.chain !== plan.chain)) {
    throw new Error('원 계획과 거래의 ID 또는 체인이 일치하지 않습니다.');
  }
  const externalExpenses = (raw.externalExpenses ?? []).map(value => externalExpenseSchema.parse(value));
  const result: PositionReview = {
    status: 'not_executed', planId: plan.id, chain: plan.chain, walletAddress: record.walletAddress,
    positionId: null, expectedEndNetYield: plan.netYield, expectedAsset: plan.inputToken,
    expectedEndDate: plan.endDate, observedValue: null, observedAsset: plan.depositToken,
    observedAt: null, observedMode: null, observedSource: null, actualFee: null,
    positionChange: null, actualNetChange: null, resultKind: null, varianceFromExpected: null,
    externalExpenses, reasons: [],
  };
  const observation = raw.observation === undefined || raw.observation === null
    ? null : observationSchema.parse(raw.observation);
  if (observation !== null) checkObservation(plan, record, observation);
  if (plan.chain === 'nile' && sameToken(plan.inputToken, { symbol: 'TRX', address: null, decimals: 6 })
      && record.actualFeeBaseUnits !== null) {
    result.actualFee = units(record.actualFeeBaseUnits, 6).toString();
  }
  if (['preview', 'awaiting_signature', 'rejected', 'failed'].includes(record.status)) {
    result.reasons.push('transaction_not_confirmed');
    return result;
  }
  if (['submitted', 'pending', 'unknown'].includes(record.status)) {
    result.status = 'unconfirmed';
    result.reasons.push('transaction_pending_or_unknown');
    return result;
  }
  if (record.status !== 'confirmed' || record.txId === null || record.confirmedAt === null) {
    throw new Error('확정 거래 근거가 부족합니다.');
  }
  if (observation === null) {
    result.status = 'awaiting_observation';
    result.reasons.push('position_not_observed');
    return result;
  }
  if (Date.parse(observation.source.fetchedAt) < Date.parse(record.confirmedAt)) {
    throw new Error('원 거래 확정보다 앞선 관측은 결과로 사용할 수 없습니다.');
  }
  result.positionId = observation.positionId;
  result.observedValue = units(observation.underlyingValueBaseUnits, observation.underlyingToken.decimals).toString();
  result.observedAt = observation.source.fetchedAt;
  result.observedMode = observation.source.mode;
  result.observedSource = observation.source;
  if (observation.source.mode !== 'live') {
    result.status = 'non_live_observation';
    result.reasons.push('observation_not_live');
    return result;
  }
  result.status = 'observed';

  if (!raw.openingObservation || !raw.flowCoverage) {
    result.reasons.push('opening_or_flow_coverage_missing');
    return result;
  }
  const opening = observationSchema.parse(raw.openingObservation);
  checkObservation(plan, record, opening);
  if (opening.positionId !== observation.positionId || opening.source.mode !== 'live' ||
      Date.parse(opening.source.fetchedAt) > Date.parse(record.submittedAt ?? record.confirmedAt)) {
    throw new Error('거래 전 동일 포지션의 실제 관측이 필요합니다.');
  }
  const coverage = flowCoverageSchema.parse(raw.flowCoverage);
  if (coverage.source.mode !== 'live' || coverage.source.chain !== plan.chain ||
      Date.parse(coverage.fromAt) > Date.parse(opening.source.fetchedAt) ||
      Date.parse(coverage.throughAt) < Date.parse(observation.source.fetchedAt) ||
      Date.parse(coverage.source.fetchedAt) < Date.parse(coverage.throughAt)) {
    result.reasons.push('flow_coverage_incomplete');
    return result;
  }
  const flows = (raw.positionFlows ?? []).map(value => positionFlowSchema.parse(value));
  if (new Set(flows.map(flow => flow.id)).size !== flows.length) throw new Error('중복된 포지션 현금흐름 ID가 있습니다.');
  for (const flow of flows) {
    if (flow.planId !== plan.id || flow.chain !== plan.chain || flow.source.chain !== plan.chain ||
        flow.walletAddress !== record.walletAddress || flow.positionId !== observation.positionId ||
        !sameToken(flow.asset, plan.depositToken) || flow.source.mode !== 'live' ||
        Date.parse(flow.occurredAt) < Date.parse(opening.source.fetchedAt) ||
        Date.parse(flow.occurredAt) > Date.parse(observation.source.fetchedAt) ||
        Date.parse(flow.solidifiedAt) < Date.parse(flow.occurredAt) ||
        Date.parse(flow.source.fetchedAt) < Date.parse(flow.solidifiedAt)) {
      throw new Error('포지션 현금흐름의 계획·체인·계정·자산·기간이 일치하지 않습니다.');
    }
  }
  if (!flows.some(flow => flow.kind === 'deposit' && flow.txId === record.txId)) {
    result.reasons.push('deposit_flow_missing');
    return result;
  }
  const openingValue = units(opening.underlyingValueBaseUnits, opening.underlyingToken.decimals);
  const observedValue = new Decimal(result.observedValue);
  result.positionChange = observedValue.minus(openingValue).toString();
  const deposit = flows.filter(flow => flow.kind === 'deposit').reduce((sum, flow) => sum.plus(flow.amount), new Decimal(0));
  const withdrawn = flows.filter(flow => flow.kind === 'withdraw').reduce((sum, flow) => sum.plus(flow.amount), new Decimal(0));
  const rewards = flows.filter(flow => flow.kind === 'reward').reduce((sum, flow) => sum.plus(flow.amount), new Decimal(0));
  // A USDD or other denominated position needs a verified conversion to the plan's starting asset.
  if (!sameToken(plan.inputToken, plan.depositToken) || result.actualFee === null) {
    result.reasons.push('valuation_or_actual_fee_unavailable');
    return result;
  }
  const feesByTx = new Map<string, DecimalValue>();
  for (const flow of flows) {
    if (flow.txId === record.txId) {
      if (flow.actualFeeInInputAsset !== null && !new Decimal(flow.actualFeeInInputAsset).eq(result.actualFee)) {
        throw new Error('원 거래 수수료가 확정 영수증과 현금흐름 기록에서 다릅니다.');
      }
      continue;
    }
    if (flow.actualFeeInInputAsset === null) {
      result.reasons.push('additional_fee_unavailable');
      return result;
    }
    const fee = new Decimal(flow.actualFeeInInputAsset);
    const previous = feesByTx.get(flow.txId);
    if (previous && !previous.eq(fee)) throw new Error('같은 거래 ID의 수수료 값이 다릅니다.');
    feesByTx.set(flow.txId, fee);
  }
  const totalFees = [...feesByTx.values()].reduce((sum, fee) => sum.plus(fee), new Decimal(result.actualFee));
  result.actualFee = totalFees.toString();
  const actualNet = observedValue.minus(openingValue).minus(deposit).plus(withdrawn).plus(rewards).minus(totalFees);
  result.actualNetChange = actualNet.toString();
  const closed = BigInt(observation.receiptBalanceBaseUnits) === 0n;
  result.resultKind = closed ? 'realized' : 'unrealized';
  if (!closed) {
    result.reasons.push('position_open');
    return result;
  }
  if (kstDate(observation.source.fetchedAt) < plan.endDate) {
    result.reasons.push('planned_horizon_not_reached');
    return result;
  }
  if (plan.netYield === null) {
    result.reasons.push('expected_net_unavailable');
    return result;
  }
  result.status = 'comparable';
  result.varianceFromExpected = actualNet.minus(plan.netYield).toString();
  return result;
}

export const adjustmentCostSchema = z.object({
  amount: decimalStringSchema.nullable(), asset: tokenSchema, source: sourceSchema,
});
export type AdjustmentCost = z.infer<typeof adjustmentCostSchema>;

export interface AdjustmentProposalInput {
  originalPlan: Plan;
  changedNeeds: UserNeeds;
  newQuote: ProductQuote | null;
  estimatedAdjustmentCost?: AdjustmentCost | null;
  walletBalance?: string | null;
  feeReserve?: string | null;
  now?: Date;
}

export interface AdjustmentProposal {
  originalPlanId: string;
  proposedPlan: Plan;
  direction: 'deposit' | 'withdraw' | 'none';
  amountFromOriginalAllocation: string;
  estimatedAdditionalCost: string | null;
  requiresPositionRecheck: boolean;
  requiresConfirmation: true;
  canExecute: false;
  reasons: string[];
}

export function proposeAdjustment(input: AdjustmentProposalInput): AdjustmentProposal {
  const original = planSchema.parse(input.originalPlan);
  const needs = userNeedsSchema.parse(input.changedNeeds);
  const quote = input.newQuote === null ? null : productQuoteSchema.parse(input.newQuote);
  if (needs.chain !== original.chain || !sameToken(needs.asset, original.inputToken)) {
    throw new Error('다른 체인이나 시작 자산으로 원 계획을 조정할 수 없습니다.');
  }
  if (quote !== null && (quote.product !== original.kind || quote.chain !== original.chain)) {
    throw new Error('새 견적의 상품과 체인이 원 계획과 다릅니다.');
  }
  if (needs.inputVersion < original.needsVersion ||
      (needs.inputVersion === original.needsVersion && (quote?.quoteVersion ?? null) === original.quoteVersion)) {
    throw new Error('입력 또는 견적 버전이 원 계획보다 새롭지 않습니다.');
  }
  // A proposal is always unconfirmed. Never carry an old confirmation into a changed trade.
  const proposedNeeds = { ...needs, confirmedVersion: null };
  const now = input.now ?? new Date();
  let proposed: Plan;
  if (original.kind === 'hold') {
    proposed = (needs.chain === 'mainnet'
      ? createMainnetPlans(proposedNeeds, { jUsdt: null, jUsdd: null }, { now })
      : createNilePlans(proposedNeeds, null, { now })).plans[0];
  } else if (original.kind === 'justlend_jtrx') {
    const nilePlans = createNilePlans(proposedNeeds, quote, { now,
      walletBalance: input.walletBalance, feeReserve: input.feeReserve,
    }).plans;
    const sameScenario = nilePlans.find(plan => plan.scenario === original.scenario);
    if (sameScenario) proposed = sameScenario;
    else if (quote !== null) proposed = calculatePlan(proposedNeeds, quote, { now });
    else throw new Error('원 Nile 시나리오의 새 견적이 필요합니다.');
  } else if (quote !== null) {
    proposed = calculatePlan(proposedNeeds, quote, { now });
  } else {
    const plans = createMainnetPlans(proposedNeeds, { jUsdt: null, jUsdd: null }, { now }).plans;
    proposed = plans.find(plan => plan.kind === original.kind)!;
  }
  const delta = new Decimal(proposed.allocation.invested).minus(original.allocation.invested);
  const cost = input.estimatedAdjustmentCost === undefined || input.estimatedAdjustmentCost === null
    ? null : adjustmentCostSchema.parse(input.estimatedAdjustmentCost);
  const estimatedAdditionalCost = cost !== null && cost.amount !== null
    && isCurrentLiveSource(cost.source, original.chain, now, 15 * 60 * 1000)
    && sameToken(cost.asset, original.inputToken)
    ? cost.amount : null;
  const reasons = ['confirmation_required'];
  if (quote === null && original.kind !== 'hold') reasons.push('quote_unavailable');
  if (estimatedAdditionalCost === null && !delta.isZero()) reasons.push('adjustment_cost_unverified');
  if (original.kind !== 'hold') reasons.push('position_recheck_required');
  return {
    originalPlanId: original.id, proposedPlan: proposed,
    direction: delta.gt(0) ? 'deposit' : delta.lt(0) ? 'withdraw' : 'none',
    amountFromOriginalAllocation: delta.abs().toString(), estimatedAdditionalCost,
    requiresPositionRecheck: original.kind !== 'hold', requiresConfirmation: true,
    canExecute: false, reasons,
  };
}
