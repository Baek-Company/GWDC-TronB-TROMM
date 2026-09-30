import DecimalBase from 'decimal.js';
import { z } from 'zod';
import { createMainnetPlans, createNilePlans } from './planning';
import { sameToken } from './eligibility';
import { instantSchema, productQuoteSchema, sourceSchema, userNeedsSchema,
  type Plan, type ProductQuote, type Source, type UserNeeds } from './schemas';

const Decimal = DecimalBase.clone({ precision: 128 });
type DecimalInstance = InstanceType<typeof Decimal>;
type ReplayMode = 'snapshot' | 'synthetic';

interface FrameBase {
  id: string;
  at: string;
  needs: UserNeeds;
  needsMode: ReplayMode;
  source: Source; // provenance of the recorded or invented needs
}
export type ReplayFrameInput = FrameBase & (
  { path: 'mainnet'; quotes: { jUsdt: ProductQuote | null; jUsdd: ProductQuote | null } } |
  { path: 'nile'; quote: ProductQuote | null; walletBalance?: string | null; feeReserve?: string | null }
);
export interface ReplayScenarioInput { id: string; frames: ReplayFrameInput[] }

export interface ReplayFrameResult {
  id: string;
  at: string;
  path: 'mainnet' | 'nile';
  needsMode: ReplayMode;
  quoteModes: ReplayMode[];
  displayMode: ReplayMode | 'mixed';
  source: Source;
  plans: Plan[];
  projectedLeaderId: string | null;
  executionAllowed: false;
  actualReturn: null;
  assumption: 'fixed_rate_projection';
}
export interface ReplayScenarioResult { id: string; frames: ReplayFrameResult[]; executionAllowed: false; actualReturn: null }

function validateSource(source: Source, chain: UserNeeds['chain'], asOf: string, needsMode?: ReplayMode): void {
  sourceSchema.parse(source);
  if (source.chain !== chain || source.mode === 'live' || (needsMode !== undefined && source.mode !== needsMode) ||
      Date.parse(source.fetchedAt) > Date.parse(asOf) ||
      (source.sourceUpdatedAt !== null && Date.parse(source.sourceUpdatedAt) > Date.parse(asOf))) {
    throw new Error('재생 자료의 체인·모드·시각이 시나리오와 일치하지 않습니다.');
  }
}

function validateQuote(quote: ProductQuote | null, chain: UserNeeds['chain'], asOf: string): ProductQuote | null {
  if (quote === null) return null;
  const parsed = productQuoteSchema.parse(quote);
  if (parsed.chain !== chain) throw new Error('재생 견적의 체인이 입력과 다릅니다.');
  validateSource(parsed.source, chain, asOf);
  for (const cost of parsed.costs) {
    if (cost.source !== null) validateSource(cost.source, chain, asOf);
    if (cost.estimatedAt !== null && Date.parse(cost.estimatedAt) > Date.parse(asOf)) {
      throw new Error('시나리오 시점 이후의 비용 견적을 사용할 수 없습니다.');
    }
  }
  return parsed;
}

function projectedLeader(plans: Plan[]): string | null {
  // Replay assumptions may rank a hypothetical quote, but never fill the Plan's
  // verified netYield when the source is historical or synthetic.
  const estimatedNet = (plan: Plan): DecimalInstance | null => {
    if (plan.kind === 'hold') return new Decimal(0);
    if (plan.baseYield === null || plan.conversionImpact === null || plan.quote === null) return null;
    if (!plan.eligibility.reasons.every(reason =>
      reason === 'non_live_data' || reason === 'quote_stale' || reason === 'cost_unverified')) return null;
    const required = plan.steps.flatMap(step => ({
      approve: ['approval'], psm_in: ['conversion_in'], deposit: ['deposit'], withdraw: ['withdraw'],
      psm_out: ['conversion_out'], claim: ['claim'], hold: [],
    })[step]);
    let costs = new Decimal(0);
    for (const kind of required) {
      const cost = plan.quote.costs.find(item => item.kind === kind);
      if (cost?.amount === null || cost === undefined) return null;
      const conversion = sameToken(cost.asset, plan.quote.inputToken) ? '1' : cost.conversionRateToInput;
      if (conversion === null) return null;
      costs = costs.plus(new Decimal(cost.amount).times(conversion));
    }
    return new Decimal(plan.baseYield).plus(plan.verifiedReward ?? '0').plus(plan.conversionImpact).minus(costs);
  };
  const candidates = plans.map(plan => ({ plan, net: estimatedNet(plan) })).filter(
    (entry): entry is { plan: Plan; net: DecimalInstance } => entry.net !== null,
  );
  candidates.sort((a, b) => b.net.comparedTo(a.net));
  return candidates[0]?.plan.id ?? null;
}

export function replayScenario(input: ReplayScenarioInput): ReplayScenarioResult {
  if (!input.id || input.frames.length < 1 || input.frames.length > 100) {
    throw new Error('시나리오 ID와 1~100개의 재생 프레임이 필요합니다.');
  }
  const seen = new Set<string>();
  let previousTime = -Infinity;
  const frames = input.frames.map(frame => {
    z.string().min(1).parse(frame.id);
    instantSchema.parse(frame.at);
    if (seen.has(frame.id)) throw new Error('재생 프레임 ID가 중복됩니다.');
    seen.add(frame.id);
    const time = Date.parse(frame.at);
    if (time <= previousTime) throw new Error('재생 프레임은 시각 순서로 정렬해야 합니다.');
    previousTime = time;
    const needs = userNeedsSchema.parse(frame.needs);
    if (frame.needsMode !== 'snapshot' && frame.needsMode !== 'synthetic') {
      throw new Error('실데이터 입력을 과거·가상 재생으로 표시할 수 없습니다.');
    }
    validateSource(frame.source, needs.chain, frame.at, frame.needsMode);
    let plans: Plan[];
    let quotes: (ProductQuote | null)[];
    if (frame.path === 'mainnet') {
      if (needs.chain !== 'mainnet') throw new Error('Mainnet 재생에는 Mainnet 입력이 필요합니다.');
      const jUsdt = validateQuote(frame.quotes.jUsdt, needs.chain, frame.at);
      const jUsdd = validateQuote(frame.quotes.jUsdd, needs.chain, frame.at);
      quotes = [jUsdt, jUsdd];
      plans = createMainnetPlans(needs, { jUsdt, jUsdd }, { now: new Date(frame.at) }).plans;
    } else {
      if (needs.chain !== 'nile') throw new Error('Nile 재생에는 Nile 입력이 필요합니다.');
      const jTrx = validateQuote(frame.quote, needs.chain, frame.at);
      quotes = [jTrx];
      plans = createNilePlans(needs, jTrx, { now: new Date(frame.at),
        walletBalance: frame.walletBalance, feeReserve: frame.feeReserve }).plans;
    }
    const quoteModes = quotes.flatMap(quote => quote === null ? [] : [quote.source.mode as ReplayMode]);
    const displayMode: ReplayMode | 'mixed' = quoteModes.length === 0 || quoteModes.every(mode => mode === frame.needsMode)
      ? frame.needsMode : 'mixed';
    return {
      id: frame.id, at: frame.at, path: frame.path, needsMode: frame.needsMode,
      quoteModes, displayMode, source: frame.source, plans,
      projectedLeaderId: projectedLeader(plans), executionAllowed: false as const,
      actualReturn: null, assumption: 'fixed_rate_projection' as const,
    };
  });
  return { id: input.id, frames, executionAllowed: false, actualReturn: null };
}
