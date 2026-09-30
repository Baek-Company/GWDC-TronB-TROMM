import { createHash } from 'node:crypto';
import DecimalBase from 'decimal.js';
import { TronWeb } from 'tronweb';
import { calculateLiquidity, createMainnetPlans, createNilePlans, type PlanSet } from '../../shared/planning';
import { createJusdtSizingLegRequests } from '../../shared/jusdt-allocation';
import { approvalBranch } from '../../shared/jusdt-cost-model';
import { decideDatedAllocation, decidePlanSet, type AgentDecision, type DatedDecision } from '../../shared/agent-decision';
import { sameToken } from '../../shared/eligibility';
import { isCurrentLiveSource } from '../../shared/provenance';
import { dateSchema, jusdtReadOnlyEvidenceSchema, jusdtSizingInputsSchema, userNeedsSchema,
  type DatedAllocation, type JusdtReadOnlyEvidence, type JusdtSizingInputs,
  type ProductQuote, type Source, type UserNeeds } from '../../shared/schemas';
import { readMainnetQuotes, readNileQuote } from '../data/quotes';
import { readJusdtSizing } from '../data/jusdt-costs';
import { readNileRedeemReference } from '../data/nile-costs';
import { MAINNET_RPC, withMainnetRpcBudget } from '../data/tron-rpc';
import { readNilePlanFeeScenarios, type NileFeeScenario } from '../nile-plan-fees';
import { readNileDepositState } from '../transactions';
import { observePortfolio, type PortfolioSnapshot } from './portfolio';

const Money = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
const BALANCE_MAX_AGE_MS = 60_000;

function seoulDate(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(value);
  const part = (type: string) => parts.find(item => item.type === type)?.value;
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export type Assessment = {
  assessmentId: string;
  inputVersion: number;
  confirmedVersion: number;
  assessedAt: string;
  chain: UserNeeds['chain'];
  declaredAmount: string;
  declaredInvestableAmount: string;
  observedWalletBalance: string | null;
  walletAddress: string | null;
  walletBalanceSource: Source | null;
  observedPosition: PortfolioSnapshot['position'] | null;
  observedFeeBalance: PortfolioSnapshot['feeBalance'] | null;
  balanceStatus: 'ready' | 'unavailable' | 'not_connected';
  balanceReason: string | null;
  planBasis: 'observed_capped' | 'declared_hypothetical';
  protectedAmount: string;
  /** Maximum recommendation amount backed by a current same-chain wallet reading. */
  investableAmount: string;
  plans: PlanSet['plans'];
  datedAllocation: DatedAllocation | null;
  /** Partial Mainnet sizing evidence only; never a selected allocation or trading approval. */
  jusdtReadOnlyEvidence: JusdtReadOnlyEvidence | null;
  /** Future Nile fee references are separate from verified net yield and execution eligibility. */
  nileFeeScenarios: NileFeeScenario[];
  decision: AgentDecision;
  datedDecision: DatedDecision | null;
  diagnostics: { name: string; status: string; reason: string }[];
  summary: string;
  dataMode: 'live' | 'mixed_or_unavailable';
  selectedRouteDataMode: 'live' | 'mixed_or_unavailable';
};

type Dependencies = {
  mainnetQuotes: typeof readMainnetQuotes;
  jusdtSizing: typeof readJusdtSizing;
  nileQuote: typeof readNileQuote;
  nileFees: (needs: UserNeeds, plans: PlanSet['plans'], walletAddress: string,
    exchangeRateRaw: string | null) => Promise<NileFeeScenario[]>;
  portfolio: typeof observePortfolio;
  now: () => Date;
};

function stableId(fields: unknown): string {
  return createHash('sha256').update(JSON.stringify(fields)).digest('hex');
}

function sameAddress(a: string, b: string): boolean {
  return TronWeb.isAddress(a) && TronWeb.isAddress(b)
    && TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();
}

function verifiedBalance(snapshot: PortfolioSnapshot | null, needs: UserNeeds, address: string | undefined,
  now: Date): { amount: string | null; reason: string | null; source: Source | null } {
  if (!address) return { amount: null, reason: 'TronLink 지갑을 연결하지 않았습니다.', source: null };
  if (!snapshot) return { amount: null, reason: '지갑 실잔액 조회에 실패했습니다.', source: null };
  const balance = snapshot.walletBalance;
  if (snapshot.chain !== needs.chain || !sameAddress(snapshot.walletAddress, address)
    || balance.status !== 'ready' || !sameToken(balance.token, needs.asset)
    || balance.amount === null || !/^\d+(?:\.\d+)?$/.test(balance.amount)
    || balance.amountBaseUnits === null || !/^\d+$/.test(balance.amountBaseUnits)
    || new Money(balance.amount).times(new Money(10).pow(needs.asset.decimals)).toString() !== balance.amountBaseUnits
    || !isCurrentLiveSource(balance.source, needs.chain, now, BALANCE_MAX_AGE_MS)) {
    return { amount: null, reason: balance.reason ?? '같은 체인·주소·자산의 최신 지갑 잔액을 확인하지 못했습니다.', source: null };
  }
  return { amount: new Money(balance.amount).toString(), reason: null, source: balance.source };
}

function withBalanceBlock(planSet: PlanSet, reason: 'balance_unverified' | 'balance_insufficient'): PlanSet {
  const hold = planSet.plans.find(plan => plan.kind === 'hold');
  return {
    recommendedPlanId: hold?.id ?? null,
    datedAllocation: planSet.datedAllocation ? { ...planSet.datedAllocation,
      recommendation: 'insufficient_data' } : undefined,
    plans: planSet.plans.map(plan => plan.kind === 'hold' ? plan : {
      ...plan,
      eligibility: {
        status: reason === 'balance_insufficient' || plan.eligibility.status === 'excluded'
          ? 'excluded' as const : 'conditional' as const,
        reasons: [...new Set([...plan.eligibility.reasons, reason])],
      },
    }),
  };
}

const PUBLIC_MINT_SOURCE_PATHS = new Set([
  '/wallet/triggerconstantcontract', '/wallet/estimateenergy',
  '/walletsolidity/gettransactioninfobyid',
]);

function publicMintSources(sources: Source[]): Source[] {
  return sources.slice(0, 20).flatMap(source => {
    try {
      const url = new URL(source.sourceUrl);
      if (url.origin !== MAINNET_RPC || source.chain !== 'mainnet' || source.mode !== 'live') return [];
      const path = PUBLIC_MINT_SOURCE_PATHS.has(url.pathname) ? url.pathname : '';
      return [{ ...source, sourceUrl: `${MAINNET_RPC}${path}` }];
    } catch { return []; }
  });
}

function boundJusdtSizing(rawSizing: JusdtSizingInputs | null,
  needs: UserNeeds, walletAddress: string | undefined, quote: ProductQuote | null,
  observedUsdtRaw: string | null, now: Date): JusdtSizingInputs | null {
  if (!rawSizing || !walletAddress || !quote || observedUsdtRaw === null
    || needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT'
    || needs.asset.address === null || needs.confirmedVersion !== needs.inputVersion
    || quote.chain !== 'mainnet' || quote.product !== 'justlend_jusdt'
    || quote.source.mode !== 'live' || quote.marketAddress === null) return null;
  const parsed = jusdtSizingInputsSchema.safeParse(rawSizing);
  if (!parsed.success) return null;
  const sizing = parsed.data;
  const context = sizing.context;
  if (!sameAddress(context.walletAddress, walletAddress)
    || !sameAddress(context.usdtAddress, needs.asset.address)
    || !sameAddress(context.jusdtAddress, quote.marketAddress)
    || context.needsVersion !== needs.inputVersion
    || context.marketQuoteVersion !== quote.quoteVersion
    || context.observedUsdtRaw !== observedUsdtRaw
    || Date.parse(context.validUntil) <= now.getTime()) return null;
  const requested = createJusdtSizingLegRequests(needs, now);
  if (requested.length === 0 || requested.length !== sizing.legs.length) return null;
  const requestedByKey = new Map(requested.map(leg => [leg.bucketKey, leg]));
  if (sizing.legs.some(leg => {
    const expected = requestedByKey.get(leg.bucketKey);
    return !expected || leg.chain !== 'mainnet' || !sameAddress(leg.walletAddress, walletAddress)
      || leg.needsVersion !== needs.inputVersion
      || leg.contextVersion !== context.version
      || leg.marketQuoteVersion !== context.marketQuoteVersion
      || leg.amountUsdtRaw !== expected.amountUsdtRaw
      || leg.dueDate !== expected.dueDate || leg.plannedExitDate !== expected.plannedExitDate
      || leg.earningDays !== expected.earningDays
      || Date.parse(leg.validUntil) <= now.getTime();
  })) return null;
  return sizing;
}

function projectJusdtReadOnlyEvidence(rawSizing: JusdtSizingInputs | null,
  needs: UserNeeds, walletAddress: string | undefined, quote: ProductQuote | null,
  observedUsdtRaw: string | null, planSet: PlanSet, now: Date): JusdtReadOnlyEvidence | null {
  const sizing = boundJusdtSizing(rawSizing, needs, walletAddress, quote, observedUsdtRaw, now);
  if (!sizing || !walletAddress) return null;
  const context = sizing.context;
  const totalRaw = sizing.legs.reduce((sum, leg) => sum + BigInt(leg.amountUsdtRaw), 0n).toString();
  const validUntil = [context.validUntil, ...sizing.legs.map(leg => leg.validUntil)]
    .reduce((earliest, value) => value < earliest ? value : earliest);
  const reasonsByKey = new Map(planSet.datedAllocation?.legs.map(leg => [
    `${leg.purpose}:${leg.dueDate}`, leg.reasons,
  ]) ?? []);
  const projected = jusdtReadOnlyEvidenceSchema.safeParse({
    chain: 'mainnet', walletAddress, needsVersion: needs.inputVersion,
    contextVersion: context.version, marketQuoteVersion: context.marketQuoteVersion,
    allowanceUsdtRaw: context.allowanceUsdtRaw, totalCandidateUsdtRaw: totalRaw,
    observationWindow: context.observationWindow, validUntil,
    approvalActions: approvalBranch(context.allowanceUsdtRaw, totalRaw),
    legs: sizing.legs.map(leg => ({
      bucketKey: leg.bucketKey, amountUsdtRaw: leg.amountUsdtRaw,
      dueDate: leg.dueDate, plannedExitDate: leg.plannedExitDate,
      quoteVersion: leg.quoteVersion,
      mintCost: {
        action: 'mint', basis: leg.mintCost.basis,
        contextVersion: leg.mintCost.contextVersion, amountRaw: leg.mintCost.amountRaw,
        energyUnits: leg.mintCost.energyUnits, bandwidthBytes: leg.mintCost.bandwidthBytes,
        estimatedFeeSun: leg.mintCost.estimatedFeeSun, feeLimitSun: leg.mintCost.feeLimitSun,
        sources: publicMintSources(leg.mintCost.sources),
      },
      redeemModelVersion: leg.redeemModelVersion,
      holdReasons: reasonsByKey.get(leg.bucketKey) ?? [],
    })),
    executionEligible: false,
  });
  return projected.success ? projected.data : null;
}

function summarize(decision: AgentDecision, datedDecision: DatedDecision | null, assessment: Pick<Assessment,
  'declaredAmount' | 'declaredInvestableAmount' | 'observedWalletBalance' | 'protectedAmount'
  | 'investableAmount' | 'balanceReason' | 'planBasis'>, asset: string, planSet: PlanSet): string {
  if (assessment.planBasis === 'declared_hypothetical') {
    return '입력하신 ' + assessment.declaredAmount + ' ' + asset + '를 기준으로 시세와 계획을 가정 비교했습니다. '
      + '지출·예비액 ' + assessment.protectedAmount + ' ' + asset + '를 보호해야 하며 입력 기준 여유액은 '
      + assessment.declaredInvestableAmount + ' ' + asset + '입니다. '
      + (assessment.balanceReason ?? '지갑 잔액을 확인하지 못했습니다.') + ' 실잔액으로 뒷받침된 운용 권고액은 0이며 거래를 보류합니다.';
  }
  const prefix = '입력하신 ' + assessment.declaredAmount + ' ' + asset + ' 중 지갑에서 '
    + assessment.observedWalletBalance + ' ' + asset + '를 관측했습니다. 지출·예비액 '
    + assessment.protectedAmount + ' ' + asset + '를 보호한 운용 가능 상한은 '
    + assessment.investableAmount + ' ' + asset + '입니다.';
  if (datedDecision?.action === 'conditional_allocate' && planSet.datedAllocation?.selectedBundleQuote) {
    const dated = planSet.datedAllocation;
    return prefix + ' 선택된 지급일 구간의 ' + dated.totalInvested + ' ' + asset
      + '는 현재 금리·비용·TRX 예비액을 반영한 읽기 전용 조건부 시나리오입니다. 예상 순익은 '
      + dated.selectedBundleNetYield + ' ' + asset + '이며, 지급일의 출금과 실제 거래 성공은 보장되지 않습니다.'
      + (dated.recommendation === 'insufficient_data' ? ' 다른 구간의 근거가 부족해 전체 배분은 보류 중입니다.' : '')
      + ' 거래 전 새 견적과 지갑 승인이 필요합니다.';
  }
  if (planSet.datedAllocation?.recommendation === 'allocate') {
    const dated = planSet.datedAllocation;
    return prefix + ' 지출 날짜별 가정 비교에서는 ' + dated.totalInvested + ' ' + asset
      + '를 날짜에 맞춰 나누어 운용하고 ' + dated.totalHeld + ' ' + asset
      + '를 보유하는 안의 예상 순수익이 ' + dated.expectedNetYield + ' ' + asset
      + '입니다. 출금 가능량과 비용은 거래 전에 다시 확인해야 하며 자동 거래는 하지 않습니다.';
  }
  if (planSet.datedAllocation?.recommendation === 'insufficient_data') {
    return prefix + ' 지출 날짜별 운용에 필요한 잔액·시세·비용 또는 출금 근거가 충분하지 않아 신규 예치를 보류합니다.';
  }
  if (planSet.datedAllocation?.recommendation === 'hold') {
    return prefix + ' 지출 날짜별 순수익과 출금 시점을 비교하면 현재는 보유가 적합합니다.';
  }
  if (decision.action === 'recommend') {
    const plan = planSet.plans.find(value => value.id === decision.planId)!;
    return prefix + ' 현재 확인된 근거에서는 ' + plan.kind + ' 계획의 예상 순수익이 '
      + plan.netYield + ' ' + asset + '로 가장 높습니다. 실제 거래에는 비용·미리보기·별도 지갑 승인이 필요합니다.';
  }
  if (decision.action === 'insufficient_data') {
    return prefix + ' 금리·비용·출구 또는 자료 시각이 충분히 확인되지 않아 거래 권고를 보류합니다.';
  }
  return prefix + ' 현재 조건에서는 운용보다 보유가 적합하여 거래를 보류합니다.';
}

/** Read-only assessment. A connected address is an observation target, never transaction authority. */
export function createAssessor(overrides: Partial<Dependencies> = {}) {
  const dependencies: Dependencies = {
    mainnetQuotes: readMainnetQuotes, jusdtSizing: readJusdtSizing, nileQuote: readNileQuote,
    nileFees: (needs, plans, walletAddress, exchangeRateRaw) => readNilePlanFeeScenarios(
      needs, plans, walletAddress, exchangeRateRaw,
      { readDepositState: readNileDepositState, readRedeemReference: readNileRedeemReference }),
    portfolio: observePortfolio, now: () => new Date(), ...overrides,
  };
  return async function assessConfirmedNeeds(rawNeeds: UserNeeds, address?: string,
    asOfDate?: string): Promise<Assessment> {
    try {
    return await withMainnetRpcBudget(40, async () => {
    const originalNeeds = userNeedsSchema.parse(rawNeeds);
    const now = dependencies.now();
    const today = seoulDate(now);
    if (asOfDate !== undefined && (dateSchema.parse(asOfDate) !== today || asOfDate >= originalNeeds.endDate)) {
      throw new Error('남은 기간 재평가는 오늘 날짜이며 원 계획 종료일 전이어야 합니다.');
    }
    if (asOfDate !== undefined && asOfDate > originalNeeds.startDate
      && originalNeeds.expenses.some(expense => expense.date <= asOfDate)) {
      throw new Error('이미 도래한 지출의 실제 지급 여부를 먼저 확인해야 합니다.');
    }
    const needs = asOfDate !== undefined && asOfDate > originalNeeds.startDate
      ? userNeedsSchema.parse({ ...originalNeeds, startDate: asOfDate }) : originalNeeds;
    if (needs.confirmedVersion !== needs.inputVersion) throw new Error('확인된 계획 입력 버전이 필요합니다.');
    if (address && !TronWeb.isAddress(address)) throw new Error('유효한 TRON 지갑 주소가 필요합니다.');
    if ((needs.chain === 'mainnet' && needs.asset.symbol !== 'USDT')
      || (needs.chain === 'nile' && needs.asset.symbol !== 'TRX')) {
      throw new Error('Mainnet USDT 또는 Nile TRX 계획만 평가할 수 있습니다.');
    }
    const declaredLiquidity = calculateLiquidity(needs);
    const selectedQuote = needs.chain === 'mainnet' && address
      ? await dependencies.mainnetQuotes({ selectedRoute: 'jusdt' }) : null;
    let snapshot: PortfolioSnapshot | null = null;
    if (address) {
      try {
        snapshot = await dependencies.portfolio({ chain: needs.chain, address,
          declaredHoldings: { asset: needs.asset.symbol, amount: needs.amount },
          ...(selectedQuote?.jUsdt && selectedQuote.jUsdtEvidence
            ? { marketEvidence: selectedQuote.jUsdtEvidence,
              marketQuoteVersion: selectedQuote.jUsdt.quoteVersion } : {}) });
      } catch { /* A failed observation must not become a guessed balance. */ }
    }
    const balance = verifiedBalance(snapshot, needs, address, dependencies.now());
    const observedWalletBalance = balance.amount;
    const fundable = observedWalletBalance === null ? null
      : Money.min(needs.amount, observedWalletBalance);
    const protectedAmount = new Money(declaredLiquidity.protectedAmount);
    const canSize = fundable !== null && fundable.gt(0) && fundable.gte(protectedAmount);
    const investableAmount = canSize ? fundable.minus(protectedAmount).toString() : '0';
    const effectiveNeeds = canSize ? { ...needs, amount: fundable.toString() } : needs;
    const balanceReason = observedWalletBalance === null ? balance.reason
      : !canSize ? '관측 잔액이 지출·예비액 보호 필요액에 미치지 못했습니다.' : null;

    let planSet: PlanSet;
    let diagnostics: Assessment['diagnostics'];
    let sizingReady = false;
    let readySizing: JusdtSizingInputs | null = null;
    let selectedJusdtQuote: ProductQuote | null = null;
    let nileFeeScenarios: NileFeeScenario[] = [];
    if (needs.chain === 'mainnet') {
      const quote = selectedQuote ?? await dependencies.mainnetQuotes();
      selectedJusdtQuote = quote.jUsdt;
      diagnostics = quote.diagnostics.map(item => ({ name: item.checkId, status: item.status, reason: item.reason }));
      if (address && canSize) {
        const legs = createJusdtSizingLegRequests(effectiveNeeds, now);
        let sizing: Awaited<ReturnType<typeof readJusdtSizing>> | null = null;
        if (quote.jUsdt && legs.length > 0) {
          const fee = snapshot?.feeBalance;
          const verifiedTrxSun = fee?.status === 'ready' && fee.amountBaseUnits !== null
            && fee.token.symbol === 'TRX' && fee.token.address === null && fee.token.decimals === 6
            && isCurrentLiveSource(fee.source, 'mainnet', now, BALANCE_MAX_AGE_MS)
            ? fee.amountBaseUnits : null;
          try {
            sizing = await dependencies.jusdtSizing({ walletAddress: address,
              observedUsdtRaw: snapshot?.walletBalance.amountBaseUnits ?? null,
              observedTrxSun: verifiedTrxSun, needsVersion: needs.inputVersion,
              legs, marketQuote: quote.jUsdt, marketEvidence: quote.jUsdtEvidence ?? null });
          } catch { /* Failed quote stays unavailable; no synthetic fee is substituted. */ }
          if (sizing?.status === 'ready') {
            readySizing = boundJusdtSizing(sizing.value, effectiveNeeds, address,
              quote.jUsdt, snapshot?.walletBalance.amountBaseUnits ?? null, dependencies.now());
            sizingReady = readySizing !== null;
            if (!sizingReady) diagnostics.push({ name: 'jusdt_sizing', status: 'unknown',
              reason: '금액별 근거의 지갑·잔액·체인·입력·시장 버전 또는 만료시각이 현재 평가와 일치하지 않습니다.' });
          } else diagnostics.push({ name: 'jusdt_sizing', status: sizing?.status ?? 'unknown',
            reason: sizing?.reason ?? '금액별 jUSDT 행동·비용 근거를 읽지 못했습니다.' });
        }
        const calculationNow = dependencies.now();
        if (seoulDate(calculationNow) !== today) throw new DOMException('평가 중 날짜가 바뀌었습니다.', 'AbortError');
        planSet = createMainnetPlans(effectiveNeeds, quote, { now: calculationNow,
          jusdtSizing: readySizing });
      } else {
        const calculationNow = dependencies.now();
        if (seoulDate(calculationNow) !== today) throw new DOMException('평가 중 날짜가 바뀌었습니다.', 'AbortError');
        planSet = createMainnetPlans(effectiveNeeds, quote, { now: calculationNow });
      }
    } else {
      const quote = await dependencies.nileQuote(address);
      const calculationNow = dependencies.now();
      if (seoulDate(calculationNow) !== today) throw new DOMException('평가 중 날짜가 바뀌었습니다.', 'AbortError');
      planSet = createNilePlans(effectiveNeeds, quote.jTrx, { now: calculationNow,
        walletBalance: observedWalletBalance });
      diagnostics = quote.diagnostics.map(item => ({ name: item.checkId, status: item.status, reason: item.reason }));
      if (quote.jTrx && address && canSize) {
        try {
          nileFeeScenarios = await dependencies.nileFees(effectiveNeeds, planSet.plans,
            address, quote.exchangeRateRaw ?? null);
          const complete = nileFeeScenarios.filter(item => item.status === 'reference_scenario').length;
          const candidateCount = planSet.plans.filter(item => item.kind === 'justlend_jtrx').length;
          diagnostics.push({ name: 'nile_future_redeem_fee',
            status: candidateCount > 0 && complete === candidateCount ? 'reference_scenario' : 'unknown',
            reason: candidateCount > 0 && complete === candidateCount
              ? `${complete}개 금액별 미래 환매 비용은 현재 조건의 참고 시나리오입니다. 확정 비용이나 추천 근거가 아닙니다.`
              : '일부 또는 전체 금액의 미래 환매 비용 참고 근거를 확보하지 못했습니다.' });
        } catch {
          diagnostics.push({ name: 'nile_future_redeem_fee', status: 'unknown',
            reason: 'Nile 환매 비용 참고 조회에 실패했습니다. 기존 계획의 비용과 순익은 미확인으로 유지합니다.' });
        }
      }
    }
    if (!canSize) planSet = withBalanceBlock(planSet, observedWalletBalance === null
      ? 'balance_unverified' : 'balance_insufficient');
    const decision: AgentDecision = !canSize ? {
      action: observedWalletBalance === null ? 'insufficient_data' : 'hold',
      planId: planSet.plans.find(plan => plan.kind === 'hold')?.id ?? null,
      reasonCodes: [observedWalletBalance === null ? 'balance_unverified' : 'balance_insufficient'],
      executionEligible: false,
    } : decidePlanSet(planSet);
    const datedDecision = canSize && planSet.datedAllocation
      ? decideDatedAllocation(planSet.datedAllocation) : null;
    const planBasis: Assessment['planBasis'] = canSize ? 'observed_capped' : 'declared_hypothetical';
    const summaryInputs = { declaredAmount: needs.amount,
      declaredInvestableAmount: declaredLiquidity.investableAmount,
      observedWalletBalance, protectedAmount: declaredLiquidity.protectedAmount,
      investableAmount, balanceReason, planBasis };
    const quoteVersions = planSet.plans.map(plan => [plan.id, plan.quoteVersion, plan.source?.fetchedAt]);
    const assessedAt = dependencies.now().toISOString();
    const jusdtReadOnlyEvidence = canSize
      ? projectJusdtReadOnlyEvidence(readySizing, effectiveNeeds, address,
        selectedJusdtQuote, snapshot?.walletBalance.amountBaseUnits ?? null,
        planSet, new Date(assessedAt)) : null;
    return {
      assessmentId: stableId([needs, address, observedWalletBalance, assessedAt, quoteVersions,
        planSet.datedAllocation?.selectedBundleQuoteVersion ?? null,
        jusdtReadOnlyEvidence?.contextVersion ?? null, nileFeeScenarios, decision, datedDecision]),
      inputVersion: needs.inputVersion, confirmedVersion: needs.confirmedVersion!, assessedAt,
      chain: needs.chain, declaredAmount: needs.amount, declaredInvestableAmount: declaredLiquidity.investableAmount,
      observedWalletBalance, walletAddress: address ?? null, walletBalanceSource: balance.source,
      observedPosition: snapshot?.position ?? null,
      observedFeeBalance: snapshot?.feeBalance ?? null,
      balanceStatus: observedWalletBalance !== null ? 'ready' : address ? 'unavailable' : 'not_connected',
      balanceReason, planBasis,
      protectedAmount: declaredLiquidity.protectedAmount, investableAmount,
      plans: planSet.plans, datedAllocation: planSet.datedAllocation ?? null,
      jusdtReadOnlyEvidence, nileFeeScenarios,
      decision, datedDecision, diagnostics,
      summary: summarize(decision, datedDecision, summaryInputs, needs.asset.symbol, planSet),
      dataMode: needs.chain !== 'nile' && canSize && planSet.plans.filter(plan => plan.kind !== 'hold').length > 0
        && planSet.plans.filter(plan => plan.kind !== 'hold').every(plan => plan.source?.mode === 'live')
        && diagnostics.every(item => item.status === 'ready')
        ? 'live' : 'mixed_or_unavailable',
      selectedRouteDataMode: sizingReady && planSet.datedAllocation?.selectedBundleStatus === 'scenario_only'
        && planSet.datedAllocation.selectedBundleQuote?.actions.every(action =>
          action.cost.basis === 'account_simulation')
        ? 'live' : 'mixed_or_unavailable',
    };
    }, { timeoutMs: 25_000 });
    } catch (error) {
      if (!(error instanceof DOMException && error.name === 'AbortError')) throw error;
      const original = userNeedsSchema.parse(rawNeeds);
      if (original.chain !== 'mainnet' || original.confirmedVersion !== original.inputVersion) throw error;
      const now = dependencies.now();
      const needs = asOfDate && asOfDate > original.startDate
        ? userNeedsSchema.parse({ ...original, startDate: asOfDate }) : original;
      const liquidity = calculateLiquidity(needs);
      const planSet = withBalanceBlock(createMainnetPlans(needs,
        { jUsdt: null, jUsdd: null }, { now, jusdtSizing: null }), 'balance_unverified');
      const decision: AgentDecision = { action: 'insufficient_data',
        planId: planSet.plans.find(plan => plan.kind === 'hold')?.id ?? null,
        reasonCodes: ['assessment_deadline_exceeded'], executionEligible: false };
      return { assessmentId: stableId([needs, address, now.toISOString(), 'assessment_deadline_exceeded']),
        inputVersion: needs.inputVersion, confirmedVersion: needs.confirmedVersion!,
        assessedAt: now.toISOString(), chain: needs.chain, declaredAmount: needs.amount,
        declaredInvestableAmount: liquidity.investableAmount, observedWalletBalance: null,
        walletAddress: address ?? null, walletBalanceSource: null,
        observedPosition: null, observedFeeBalance: null,
        balanceStatus: address ? 'unavailable' : 'not_connected',
        balanceReason: '평가 시간 제한으로 최신 지갑 잔액을 확정하지 못했습니다.',
        planBasis: 'declared_hypothetical', protectedAmount: liquidity.protectedAmount,
        investableAmount: '0', plans: planSet.plans,
        datedAllocation: planSet.datedAllocation ?? null, jusdtReadOnlyEvidence: null,
        nileFeeScenarios: [], decision,
        datedDecision: planSet.datedAllocation ? decideDatedAllocation(planSet.datedAllocation) : null,
        diagnostics: [{ name: 'assessment_deadline', status: 'unknown',
          reason: '25초 안에 시장·지갑·비용 조회를 마치지 못해 신규 예치를 보류합니다.' }],
        summary: '평가 시간 제한으로 현재 지갑·시장·거래비용을 함께 확인하지 못했습니다. 신규 예치를 보류하고 다시 조회해 주세요.',
        dataMode: 'mixed_or_unavailable', selectedRouteDataMode: 'mixed_or_unavailable' };
    }
  };
}

export const assessConfirmedNeeds = createAssessor();
