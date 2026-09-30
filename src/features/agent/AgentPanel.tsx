import { useEffect, useRef, useState, type FormEvent } from 'react';
import Decimal from 'decimal.js';
import { agentRequestStateSchema, emptyAgentRequest, validateAgentRequest,
  type AgentIntakeQuestion, type AgentIntakeResult, type AgentRequestState,
  type RequestValidation } from '../../../shared/agent-request';
import { datedAllocationSchema, jusdtReadOnlyEvidenceSchema, planSchema,
  type DatedAllocation, type Plan, type Source } from '../../../shared/schemas';
import { isCurrentLiveSource } from '../../../shared/provenance';
import type { Assessment } from '../../../server/agent/assessment';
import type { MarketResearchReport } from '../../../server/agent/research';
import type { PortfolioSnapshot } from '../../../server/agent/portfolio';
import type { getWalletState } from '../../wallet';
import './agent-panel.css';

const storageKey = 'gwdc:agent-request:v1';
type Loaded = { request: AgentRequestState; invalid: string | null };
function loadRequest(): Loaded {
  let raw: string | null = null;
  try {
    raw = localStorage.getItem(storageKey);
    return raw ? { request: agentRequestStateSchema.parse(JSON.parse(raw)), invalid: null }
      : { request: emptyAgentRequest(), invalid: null };
  } catch {
    return { request: emptyAgentRequest(), invalid: raw };
  }
}

function saveJson(name: string, value: unknown) {
  const object = new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(object);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}
function saveOriginal(name: string, value: string) {
  const object = new Blob([value], { type: 'application/json' });
  const url = URL.createObjectURL(object);
  const link = document.createElement('a');
  link.href = url; link.download = name; link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

const fieldLabels: Record<string, string> = {
  chain: 'Mainnet 또는 Nile', asset: '보유 자산', statedHoldings: '보유 금액',
  startDate: '운용 시작일', horizonDays: '운용 기간', reserve: '비상 예비액', risk: '위험 성향',
  expenseDeclaration: '예정 지출 유무', 'expenses[0]': '예정 지출',
  fundingCoverage: '보유액·예정 지출·예비액 합계',
};
const planLabels: Record<string, string> = {
  hold: '보유', justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};
const allocationReasonLabels: Record<string, string> = {
  positive_verified_net_yield: '확인된 비용 차감 후 예상 수익이 양수입니다',
  non_positive_net_yield: '예상 수익이 비용을 넘지 못합니다',
  needs_unconfirmed: '입력 확인이 필요합니다',
  balance_unverified: '지갑 잔액을 확인하지 못했습니다',
  balance_insufficient: '지갑 잔액이 부족합니다',
  fee_reserve_unverified: '수수료 예비액을 확인하지 못했습니다',
  due_today: '오늘 필요한 자금입니다',
  quote_unavailable: '상품 견적을 조회하지 못했습니다',
  quote_stale: '견적 조회 시각이 오래되었습니다',
  non_live_data: '현재 실데이터가 아닙니다',
  rate_unavailable: '수익률을 확인하지 못했습니다',
  cost_unverified: '왕복 비용을 확인하지 못했습니다',
  conversion_unverified: '왕복 전환을 확인하지 못했습니다',
  liquidity_unverified: '출금 유동성을 확인하지 못했습니다',
  withdrawal_delay: '출금 지연으로 필요일을 맞출 수 없습니다',
  entry_capacity_insufficient: '진입 가용량이 부족하거나 미확인입니다',
  exit_capacity_insufficient: '출구 가용량이 부족하거나 미확인입니다',
  aggregate_exit_or_conversion_capacity_insufficient: '여러 날짜의 합산 출구·전환 가용량이 부족합니다',
  amount_precision_unverified: '금액 정밀도를 확인하지 못했습니다',
  start_date_not_today: '운용 시작일이 오늘이 아니어서 출금 일정 재평가가 필요합니다',
  fee_reserve_insufficient: '수수료 예비액이 부족합니다',
  market_unknown: '시장 활성 상태를 확인하지 못했습니다',
  market_inactive: '시장이 비활성 상태입니다',
  token_unverified: '계약과 토큰을 확인하지 못했습니다',
  usdd_risk_declined: 'USDD 위험에 동의하지 않았습니다',
  risk_preference: '위험 성향에 맞지 않습니다',
  liquidity_insufficient: '인출 가능한 시장 유동성이 부족합니다',
  chain_mismatch: '체인이 일치하지 않습니다',
  asset_mismatch: '자산이 일치하지 않습니다',
  zero_investable: '운용 가능한 금액이 없습니다',
  market_unverified: 'jUSDT 시장의 현재 상태를 확인하지 못했습니다',
  wallet_unverified: '같은 지갑의 잔액·포지션 관측이 부족합니다',
  price_unverified: 'TRX와 USDT의 최신 가격 근거가 부족합니다',
  action_cost_unknown: '승인·예치 행동의 비용 근거가 부족합니다',
  future_exit_unknown: '회수 행동의 비용 또는 가능성을 확인하지 못했습니다',
  fee_trx_insufficient: '수수료 예비용 TRX가 부족합니다',
  liquidity_risk_not_accepted: '지출액 운용의 회수 지연 위험에 동의하지 않았으므로 보유합니다',
  exit_buffer_insufficient: '지급일 전 회수 완충 기간이 부족합니다',
  aggregate_cash_insufficient: '현재 시장 현금이 선택한 구간의 합산 회수 목표에 부족합니다',
  non_positive_stress_net: '스트레스 비용을 적용한 예상 순익이 양수가 아닙니다',
  quote_budget_exceeded: '이번 평가의 금액별 조회 한도에 도달해 보유합니다',
  quote_expired: '금액별 견적이 만료되어 다시 평가해야 합니다',
  selected_buckets_only: '검증된 선택 구간만 조건부 후보입니다',
  other_buckets_unverified: '다른 날짜의 금액은 근거 부족으로 보유합니다',
  no_positive_bundle: '양의 스트레스 순익을 가진 묶음이 없습니다',
};
function fieldExample(field: string): string {
  if (/^expenses\[\d+\]$/.test(field)) return '7일 뒤 200 USDT';
  if (field.endsWith('.due')) return '7일 뒤 또는 2026-10-07';
  if (field.endsWith('.amount')) return '200';
  if (field.endsWith('.asset')) return 'USDT';
  return ({ chain: '메인넷 또는 Nile', asset: 'USDT 또는 TRX', statedHoldings: '1000',
    startDate: '오늘 또는 2026-10-01', horizonDays: '30',
    expenseDeclaration: '지출 없음 또는 지출 있음', reserve: '0', risk: '보수형',
    acceptsUsddRisk: '예 또는 아니요', acceptsDatedExpenseLiquidityRisk: '예 또는 아니요' } as Record<string, string>)[field] ?? '값을 입력해 주세요';
}
function sourceTime(value: string | null): string {
  return value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미제공';
}
function trxFromSun(value: string | null): string {
  return value === null ? '미확인' : `${new Decimal(value).div(1_000_000).toString()} TRX`;
}
function usdtFromRaw(value: string): string {
  return new Decimal(value).div(1_000_000).toString();
}
function sourceLink(value: string): string | null {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash
      ? url.href : null;
  } catch { return null; }
}
function validSun(value: string | null): value is string {
  return typeof value === 'string' && /^\d+$/.test(value);
}
export function visibleNileFeeScenario(request: AgentRequestState, assessment: Assessment | null,
  plan: Plan, wallet: ReturnType<typeof getWalletState>): Assessment['nileFeeScenarios'][number] | null {
  if (!assessment || assessment.chain !== 'nile' || assessment.planBasis !== 'observed_capped'
    || request.explicitFacts.chain !== 'nile' || request.explicitFacts.asset !== 'TRX'
    || request.confirmedVersion !== request.version || assessment.inputVersion !== request.version
    || assessment.confirmedVersion !== request.version || wallet.networkKey !== 'nile'
    || !wallet.address || assessment.walletAddress !== wallet.address
    || plan.chain !== 'nile' || plan.kind !== 'justlend_jtrx'
    || !assessment.plans.includes(plan)) return null;
  const scenario = assessment.nileFeeScenarios?.find(item => item.planId === plan.id);
  if (!scenario || !validSun(scenario.amountSun)
    || new Decimal(scenario.amountSun).div(1_000_000).toString() !== plan.allocation.invested) return null;
  return scenario;
}

export function NileAgentFeeEvidence({ scenario, now = Date.now() }: {
  scenario: Assessment['nileFeeScenarios'][number] | null; now?: number;
}) {
  const fetched = Date.parse(scenario?.fetchedAt ?? '');
  const validUntil = Date.parse(scenario?.validUntil ?? '');
  const link = scenario?.sourceUrl ? sourceLink(scenario.sourceUrl) : null;
  const fresh = !!link && Number.isFinite(fetched) && Number.isFinite(validUntil)
    && fetched <= now && fetched < validUntil && validUntil > now;
  const referenceProvenance = scenario?.basis === 'representative_simulation'
    ? !!scenario.referenceAccountAddress : scenario?.basis === 'historical_reference'
      ? scenario.referenceTxIds.length >= 6 && scenario.referenceTxIds.every(id => /^[a-fA-F0-9]{64}$/.test(id))
      : false;
  const entry = fresh && validSun(scenario?.depositFeeSun ?? null);
  const exit = fresh && referenceProvenance && validSun(scenario?.estimatedRedeemFeeSun ?? null);
  const complete = entry && exit && scenario?.status === 'reference_scenario'
    && validSun(scenario.stressRedeemFeeSun) && validSun(scenario.estimatedRoundTripFeeSun)
    && validSun(scenario.stressRoundTripFeeSun) && validSun(scenario.feeReserveSun);
  const basis = scenario?.basis === 'representative_simulation' ? '기준 계정의 현재 모의 실행'
    : scenario?.basis === 'historical_reference' ? '과거 확정 거래 표본' : '환매 근거 미확인';
  const status = complete ? '금액별 참고 시나리오' : entry || exit ? '일부 비용만 확인' : '미산정';
  return <div className="agent-readonly-evidence" role="note" aria-label="Nile 미래 환매 수수료 참고">
    <strong>Nile 미래 환매 수수료 · {status}</strong>
    <p>{basis}{scenario && validSun(scenario.amountSun) && ` · 후보액 ${trxFromSun(scenario.amountSun)}`}</p>
    {entry && <p>현재 예치 비용 참고: {trxFromSun(scenario!.depositFeeSun)}</p>}
    {exit && <p>미래 환매 비용 참고: {trxFromSun(scenario!.estimatedRedeemFeeSun)}
      {validSun(scenario!.stressRedeemFeeSun) && <> · 스트레스 가정 {trxFromSun(scenario!.stressRedeemFeeSun)}</>}</p>}
    {complete && <p>왕복 비용 참고: {trxFromSun(scenario!.estimatedRoundTripFeeSun)}
      {' · '}스트레스 왕복 비용 {trxFromSun(scenario!.stressRoundTripFeeSun)}
      {' · '}비용 예비액 참고 {trxFromSun(scenario!.feeReserveSun)}</p>}
    {complete && scenario!.economicSizingStatus === 'ready' && validSun(scenario!.economicDepositSun)
      && validSun(scenario!.economicFeeReserveSun)
      && <p>비용 예비액 반영 후 재계산한 운용 가능액 참고: {trxFromSun(scenario!.economicDepositSun)}
        {' · '}해당 금액의 비용 예비액 참고 {trxFromSun(scenario!.economicFeeReserveSun)}</p>}
    {complete && scenario!.reserveStatus === 'insufficient'
      && scenario!.economicSizingStatus !== 'ready'
      && <p className="agent-limited">비용 예비액을 남기면 이 후보 운용액을 감당하지 못합니다. 경제성 기준 신규 예치는 보류합니다.</p>}
    {complete && scenario!.reserveStatus === 'insufficient'
      && scenario!.economicSizingStatus === 'ready'
      && <p className="agent-limited">원래 후보 운용액은 비용 예비액을 남길 수 없어 축소 금액만 참고로 계산했습니다. 승인 적격성은 여전히 미확인입니다.</p>}
    {!complete && <p className="agent-limited">미산정 이유: {!fresh && scenario?.status !== 'unknown'
      ? '출처·조회 시각을 확인할 수 없거나 참고 근거가 만료됐습니다.'
      : scenario?.reason || '현재 금액의 예치 또는 환매 근거를 확보하지 못했습니다.'}</p>}
    {scenario && (scenario.assumptions.length > 0 || scenario.referenceAccountAddress || scenario.referenceTxIds.length > 0)
      && <details><summary>근거와 가정</summary>
        {scenario.referenceAccountAddress && <p>기준 계정: {scenario.referenceAccountAddress}</p>}
        {scenario.referenceTxIds.length > 0 && <p>확정 거래 표본 {scenario.referenceTxIds.length}건</p>}
        <ul>{scenario.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
      </details>}
    {scenario?.fetchedAt && <small>조회 {sourceTime(scenario.fetchedAt)} · 유효 {sourceTime(scenario.validUntil)} (한국 시간)
      {link && <> · <a href={link} target="_blank" rel="noreferrer">조회 출처 ↗</a></>}</small>}
    <small>참고 비용은 미래 확정 수수료나 상한이 아니며, 기존 계획의 검증된 순익·추천·승인 적격성에 반영되지 않습니다.</small>
  </div>;
}
const costActionLabels = {
  approve_zero: '승인 초기화', approve: 'USDT 승인', mint: 'jUSDT 예치', redeem_underlying: 'jUSDT 회수',
};
const costBasisLabels = { account_simulation: '현재 계정 성공 모의', reference_model: '과거 확정 거래 기준 시나리오', unknown: '근거 미확인' };
function resumeQuestion(request: AgentRequestState): AgentIntakeQuestion | null {
  const field = request.questionState.field;
  if (!field || request.confirmedVersion === request.version) return null;
  return { id: request.questionState.id ?? `q:${request.version}:${field}`, field,
    text: `${fieldLabels[field] ?? field} 값을 직접 입력하거나 문장으로 알려주세요.`, mode: 'form', ask: false };
}

export function canStoreAssessedPlan(request: AgentRequestState, assessment: Assessment | null,
  plan: Plan, wallet: ReturnType<typeof getWalletState>): boolean {
  if (!assessment || validateAgentRequest(request).status !== 'confirmed'
    || request.version !== assessment.inputVersion || request.version !== assessment.confirmedVersion
    || plan.needsVersion !== request.version || assessment.chain !== request.explicitFacts.chain
    || plan.chain !== assessment.chain || !assessment.plans.includes(plan)
    || (plan.kind !== 'hold' && plan.eligibility.status === 'excluded')
    || !planSchema.safeParse(plan).success) return false;
  return assessment.walletAddress === null || (wallet.address === assessment.walletAddress
    && wallet.networkKey === assessment.chain);
}

export function canStoreDatedAllocation(request: AgentRequestState, assessment: Assessment | null,
  allocation: DatedAllocation, wallet: ReturnType<typeof getWalletState>): boolean {
  if (!assessment || validateAgentRequest(request).status !== 'confirmed'
    || request.version !== assessment.inputVersion || request.version !== assessment.confirmedVersion
    || allocation.inputVersion !== request.version || allocation.chain !== assessment.chain
    || allocation.chain !== request.explicitFacts.chain || allocation.asset.symbol !== request.explicitFacts.asset
    || (assessment as Assessment & { datedAllocation?: DatedAllocation }).datedAllocation !== allocation
    || (allocation.selectedBundleQuote !== null && allocation.selectedBundleQuote !== undefined
      && Date.parse(allocation.selectedBundleQuote.validUntil) <= Date.now())
    || !datedAllocationSchema.safeParse(allocation).success) return false;
  return assessment.walletAddress === null || (wallet.address === assessment.walletAddress
    && wallet.networkKey === assessment.chain);
}

export function visibleJusdtReadOnlyEvidence(request: AgentRequestState, assessment: Assessment | null,
  wallet: ReturnType<typeof getWalletState>, now = Date.now()): NonNullable<Assessment['jusdtReadOnlyEvidence']> | null {
  const parsed = jusdtReadOnlyEvidenceSchema.safeParse(assessment?.jusdtReadOnlyEvidence);
  if (!parsed.success) return null;
  const evidence = parsed.data;
  const route = assessment?.plans.find(plan => plan.kind === 'justlend_jusdt');
  if (!assessment || evidence.executionEligible !== false
    || assessment.chain !== 'mainnet' || evidence.chain !== 'mainnet'
    || request.explicitFacts.chain !== 'mainnet' || request.explicitFacts.asset !== 'USDT'
    || wallet.networkKey !== 'mainnet' || !wallet.address
    || assessment.walletAddress !== wallet.address || evidence.walletAddress !== wallet.address
    || request.confirmedVersion !== request.version
    || assessment.inputVersion !== request.version || assessment.confirmedVersion !== request.version
    || evidence.needsVersion !== request.version
    || !route?.quoteVersion || route.quoteVersion !== evidence.marketQuoteVersion
    || !isCurrentLiveSource(route.source, 'mainnet', new Date(now), 60_000)
    || !evidence.contextVersion || !evidence.legs.length) return null;
  const startedAt = Date.parse(evidence.observationWindow.startedAt);
  const endedAt = Date.parse(evidence.observationWindow.endedAt);
  const validUntil = Date.parse(evidence.validUntil);
  if (!Number.isFinite(startedAt) || !Number.isFinite(endedAt) || !Number.isFinite(validUntil)
    || startedAt > endedAt || endedAt > now + 5_000 || validUntil <= now
    || evidence.legs.some(leg => !/^\d+$/.test(leg.amountUsdtRaw)
      || BigInt(leg.amountUsdtRaw) === 0n || !leg.quoteVersion
      || leg.mintCost.action !== 'mint' || leg.mintCost.contextVersion !== evidence.contextVersion
      || leg.mintCost.amountRaw !== leg.amountUsdtRaw)) return null;
  return evidence;
}

export function JusdtReadOnlyEvidencePanel({ evidence, marketSource }: {
  evidence: NonNullable<Assessment['jusdtReadOnlyEvidence']>;
  marketSource: Source | null;
}) {
  const link = marketSource && sourceLink(marketSource.sourceUrl);
  const approval = evidence.approvalActions === 'none' ? '추가 승인 없음'
    : evidence.approvalActions === 'approve' ? '승인 1회가 필요한 분기'
      : evidence.approvalActions === 'reset_then_approve' ? '승인 초기화 후 재승인이 필요한 분기'
        : '승인 분기 미확인';
  return <div className="agent-readonly-evidence" aria-label="jUSDT 금액별 부분 조회 결과">
    <h5>jUSDT 금액별 부분 조회 결과 · 읽기 전용</h5>
    <p className="agent-limited">아래 금액은 검토 대상 구간입니다. 미래 환매와 왕복 비용이 확인되기 전에는 모두 보유·자료 부족 상태이며, 투자 추천이나 거래 권한이 아닙니다.</p>
    <p>후보 전체의 공동 승인 분기: {approval}. 실제 승인 요청은 하지 않았습니다.</p>
    <p>시장 근거: Mainnet 현재 조회 · {marketSource ? sourceTime(marketSource.fetchedAt) : '시각 미확인'} (한국 시간)
      {link && <> · <a href={link} target="_blank" rel="noreferrer">시장 조회 출처 ↗</a></>}</p>
    <p>계정·시장 관측 구간: {sourceTime(evidence.observationWindow.startedAt)}–{sourceTime(evidence.observationWindow.endedAt)} (한국 시간)
      {' · '}블록 {evidence.observationWindow.firstBlock}–{evidence.observationWindow.lastBlock}
      {' · '}근거 만료 {sourceTime(evidence.validUntil)} (한국 시간)</p>
    <p className="agent-evidence-version">시장 버전 {evidence.marketQuoteVersion.slice(0, 12)} · 계정 맥락 {evidence.contextVersion.slice(0, 12)} · 입력 확인 버전 {evidence.needsVersion}</p>
    <div className="agent-readonly-legs">{evidence.legs.map(leg => <article key={leg.bucketKey}>
      <strong>{leg.bucketKey.startsWith('expense:') ? '예정 지출' : '운용 종료'} · {usdtFromRaw(leg.amountUsdtRaw)} USDT</strong>
      <small>필요일 {leg.dueDate} · 회수 목표일 {leg.plannedExitDate} · 구간 견적 {leg.quoteVersion.slice(0, 12)}</small>
      <p>예치 행동 근거: {costBasisLabels[leg.mintCost.basis]}
        {' · '}Energy {leg.mintCost.energyUnits ?? '미확인'} · Bandwidth {leg.mintCost.bandwidthBytes ?? '미확인'} bytes</p>
      {leg.mintCost.sources.length === 0 ? <small>예치 행동의 원천 조회 정보: 미확인</small>
        : leg.mintCost.sources.slice(0, 3).map((source, index) => <small key={`${source.sourceUrl}-${source.fetchedAt}-${index}`}>
          예치 근거 {index + 1}: {source.accessMethod?.toUpperCase() ?? '접근 방식 미확인'} · 조회 {sourceTime(source.fetchedAt)} (한국 시간)
          {source.sourceUpdatedAt && <> · 원천 갱신 {sourceTime(source.sourceUpdatedAt)}</>}
          {sourceLink(source.sourceUrl) && <> · <a href={sourceLink(source.sourceUrl)!} target="_blank" rel="noreferrer">공개 출처 ↗</a></>}
        </small>)}
      {leg.mintCost.sources.length > 3 && <small>추가 예치 근거 {leg.mintCost.sources.length - 3}건</small>}
      <p>미래 환매 모델: {leg.redeemModelVersion === null ? '미확인 · 왕복 비용 계산 불가'
        : `과거 거래 기준 시나리오 ${leg.redeemModelVersion.slice(0, 12)} · 미래 비용·회수 보장 아님`}</p>
      {leg.holdReasons.length > 0 && <small>보유·자료 부족 사유: {leg.holdReasons.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ')}</small>}
    </article>)}</div>
    <small>현재 계정 모의와 시장 조회는 서명·방송·체결 결과가 아닙니다. 실제 거래는 실행하지 않았습니다.</small>
  </div>;
}

export function AgentPanel({ wallet, onSelectPlan, onSelectDatedAllocation, onRequestChange }: {
  wallet: ReturnType<typeof getWalletState>;
  onSelectPlan?: (plan: Plan, request: AgentRequestState, assessment: Assessment) => void;
  onSelectDatedAllocation?: (allocation: DatedAllocation, request: AgentRequestState, assessment: Assessment) => void;
  onRequestChange?: (request: AgentRequestState) => void;
}) {
  const [loaded] = useState(loadRequest);
  const [request, setRequest] = useState(loaded.request);
  const [invalid, setInvalid] = useState(loaded.invalid);
  const [validation, setValidation] = useState<RequestValidation>(() => validateAgentRequest(loaded.request));
  const [nextQuestion, setNextQuestion] = useState<AgentIntakeQuestion | null>(() => resumeQuestion(loaded.request));
  const [message, setMessage] = useState('');
  const [fieldValue, setFieldValue] = useState('');
  const [fieldError, setFieldError] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [research, setResearch] = useState<MarketResearchReport | null>(null);
  const [assessment, setAssessment] = useState<Assessment | null>(null);
  const [storedPlanId, setStoredPlanId] = useState<string | null>(null);
  const [storedAllocationId, setStoredAllocationId] = useState<string | null>(null);
  const [portfolio, setPortfolio] = useState<PortfolioSnapshot | null>(null);
  const [portfolioError, setPortfolioError] = useState('');
  const [extraction, setExtraction] = useState<{ provider: 'nim' | 'template'; reason: string | null } | null>(null);
  const [transcript, setTranscript] = useState<{ role: 'user' | 'assistant'; text: string }[]>([]);
  const [evidenceClock, setEvidenceClock] = useState(() => Date.now());
  const sessionReady = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const walletKey = wallet.networkKey + ':' + wallet.address;
  const walletKeyRef = useRef(walletKey);
  walletKeyRef.current = walletKey;

  useEffect(() => {
    if (invalid !== null) return;
    try { localStorage.setItem(storageKey, JSON.stringify(request)); }
    catch { setError('요청 JSON을 브라우저에 저장하지 못했습니다. JSON을 내보내 보관해 주세요.'); }
  }, [request, invalid]);
  useEffect(() => {
    if (invalid === null) onRequestChange?.(request);
  }, [request, invalid, onRequestChange]);
  useEffect(() => () => controller.current?.abort(), []);
  useEffect(() => { setPortfolio(null); setPortfolioError(''); }, [wallet.address, wallet.networkKey]);
  useEffect(() => { setAssessment(null); setStoredPlanId(null); setStoredAllocationId(null); }, [wallet.address, wallet.networkKey]);
  useEffect(() => {
    const market = assessment?.plans.find(plan => plan.kind === 'justlend_jusdt')?.source;
    const deadlines = [Date.parse(assessment?.jusdtReadOnlyEvidence?.validUntil ?? ''),
      ...(assessment?.nileFeeScenarios?.map(item => Date.parse(item.validUntil ?? '')) ?? []),
      market ? Date.parse(market.fetchedAt) + 60_000 : NaN,
      market?.sourceUpdatedAt ? Date.parse(market.sourceUpdatedAt) + 60_000 : NaN];
    const delay = Math.min(...deadlines.filter(value => Number.isFinite(value))) - Date.now();
    if (!Number.isFinite(delay) || delay <= 0) return;
    const timer = window.setTimeout(() => setEvidenceClock(Date.now()), delay + 1);
    return () => window.clearTimeout(timer);
  }, [assessment]);

  const assessmentAddress = (current: AgentRequestState): string | undefined =>
    current.explicitFacts.chain === wallet.networkKey && wallet.address
      && (wallet.networkKey === 'mainnet' || wallet.networkKey === 'nile')
      ? wallet.address : undefined;

  const begin = () => {
    controller.current?.abort();
    controller.current = new AbortController();
    setBusy(true); setError('');
    return controller.current.signal;
  };
  const session = async (signal: AbortSignal) => {
    if (sessionReady.current) return;
    const response = await fetch('/api/agent/session', { signal, credentials: 'same-origin' });
    if (!response.ok) throw new Error('에이전트 세션을 시작하지 못했습니다.');
    sessionReady.current = true;
  };
  const post = async <T,>(path: string, body: unknown, signal: AbortSignal): Promise<T> => {
    await session(signal);
    const call = () => fetch(path, { method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
    let response = await call();
    if (response.status === 401) {
      sessionReady.current = false;
      await session(signal);
      response = await call();
    }
    const raw = await response.json() as { error?: string };
    if (!response.ok) throw new Error(raw.error ?? `요청에 실패했습니다. (${response.status})`);
    return raw as T;
  };
  const researchQuestions = async (questions: string[], signal: AbortSignal) => {
    if (questions.length === 0) return;
    try {
      const report = await post<MarketResearchReport>('/api/agent/research',
        { questions: questions.slice(0, 5) }, signal);
      setResearch(current => {
        const results = [...(current?.results ?? []), ...report.results];
        const status = results.every(item => item.status === 'ready') ? 'ready'
          : results.some(item => item.status === 'ready' || item.status === 'partial') ? 'partial' : 'unavailable';
        return { status, results };
      });
    }
    catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : '시장 조사에 실패했습니다.');
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const value = message.trim();
    if (!value || busy || invalid !== null) return;
    const signal = begin();
    try {
      const result = await post<AgentIntakeResult & { extraction?: { provider: 'nim' | 'template'; reason: string | null } }>('/api/agent/intake', {
        message: value, current: request,
      }, signal);
      if (signal.aborted) return;
      const parsed = agentRequestStateSchema.parse(result.request);
      setRequest(parsed); setValidation(result.validation); setNextQuestion(result.nextQuestion);
      setFieldValue(''); setFieldError('');
      setExtraction(result.extraction ?? null);
      setAssessment(null); setStoredPlanId(null); setStoredAllocationId(null); setMessage('');
      setTranscript(current => [...current, { role: 'user', text: value },
        { role: 'assistant', text: result.nextQuestion?.text ?? (result.validation.status === 'research_only'
          ? '질문에 맞는 공식 자료를 조회하겠습니다.' : result.validation.status === 'ready_for_confirmation'
            ? '명시한 정보를 확인해 주세요.' : result.progress === 'unrecognized'
              ? '답변을 해석하지 못했습니다. 아래 입력 예시를 확인해 주세요.' : '입력 내용을 갱신했습니다.') }]);
      if (parsed.marketQuestions.length > request.marketQuestions.length) {
        await researchQuestions(parsed.marketQuestions.slice(request.marketQuestions.length), signal);
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : '문장 분석에 실패했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };

  const submitField = async (event: FormEvent) => {
    event.preventDefault();
    const field = nextQuestion?.field;
    const value = fieldValue.trim();
    if (!field || !value || busy || invalid !== null) return;
    const signal = begin();
    try {
      const result = await post<AgentIntakeResult & { fieldError: string | null }>('/api/agent/field', {
        current: request, field, value,
      }, signal);
      if (signal.aborted) return;
      if (result.fieldError) { setFieldError(result.fieldError); return; }
      const parsed = agentRequestStateSchema.parse(result.request);
      setRequest(parsed); setValidation(result.validation); setNextQuestion(result.nextQuestion);
      setAssessment(null); setStoredPlanId(null); setStoredAllocationId(null); setFieldValue(''); setFieldError('');
      setTranscript(current => [...current, { role: 'user', text: `${fieldLabels[field] ?? field}: ${value}` },
        { role: 'assistant', text: result.nextQuestion?.text ?? '입력 값을 확인했습니다. JSON을 검토해 주세요.' }]);
    } catch (cause) {
      if (!signal.aborted) setFieldError(cause instanceof Error ? cause.message : '직접 입력을 확인하지 못했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };

  const setDatedExpenseRisk = async (accepted: boolean) => {
    if (busy || invalid !== null || request.explicitFacts.acceptsDatedExpenseLiquidityRisk === accepted) return;
    const signal = begin();
    try {
      const result = await post<AgentIntakeResult & { fieldError: string | null }>('/api/agent/field', {
        current: request, field: 'acceptsDatedExpenseLiquidityRisk', value: accepted,
      }, signal);
      if (signal.aborted) return;
      if (result.fieldError) { setFieldError(result.fieldError); return; }
      const parsed = agentRequestStateSchema.parse(result.request);
      setRequest(parsed); setValidation(result.validation); setNextQuestion(result.nextQuestion);
      setAssessment(null); setStoredPlanId(null); setStoredAllocationId(null);
      setTranscript(current => [...current, { role: 'user', text: accepted
        ? '지출액 운용 시 회수 지연 위험을 이해하고 동의합니다.' : '지출 예정액은 보유하겠습니다.' },
      { role: 'assistant', text: '위험 선택을 기록했습니다. 계획 조건 요약을 다시 확인해 주세요.' }]);
      setFieldError('');
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : '위험 선택을 저장하지 못했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };

  const confirm = async () => {
    if (busy || validation.status !== 'ready_for_confirmation') return;
    const requestedWalletKey = walletKey;
    const signal = begin();
    try {
      const result = await post<{ request: AgentRequestState }>('/api/agent/confirm', { request }, signal);
      if (signal.aborted) return;
      const confirmed = agentRequestStateSchema.parse(result.request);
      setRequest(confirmed); setValidation(validateAgentRequest(confirmed)); setNextQuestion(null);
      if (walletKeyRef.current !== requestedWalletKey) return;
      const evaluated = await post<Assessment>('/api/agent/assessment', {
        request: confirmed, address: assessmentAddress(confirmed),
      }, signal);
      if (!signal.aborted && walletKeyRef.current === requestedWalletKey) {
        setAssessment(evaluated); setStoredPlanId(null); setStoredAllocationId(null);
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : '계획 평가에 실패했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };
  const refreshAssessment = async () => {
    if (busy || validation.status !== 'confirmed') return;
    const requestedWalletKey = walletKey;
    const signal = begin();
    setAssessment(null); setStoredPlanId(null); setStoredAllocationId(null);
    try {
      const evaluated = await post<Assessment>('/api/agent/assessment', {
        request, address: assessmentAddress(request),
      }, signal);
      if (!signal.aborted && walletKeyRef.current === requestedWalletKey) setAssessment(evaluated);
    }
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : '계획 평가에 실패했습니다.'); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const refreshResearch = async () => {
    if (busy || request.marketQuestions.length === 0) return;
    const signal = begin();
    try {
      setResearch(await post<MarketResearchReport>('/api/agent/research',
        { questions: request.marketQuestions.slice(-5) }, signal));
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : '시장 조사에 실패했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };
  const refreshPortfolio = async () => {
    if (busy || !wallet.address || (wallet.networkKey !== 'mainnet' && wallet.networkKey !== 'nile')) return;
    const requestedWalletKey = walletKey;
    const signal = begin();
    setPortfolioError('');
    try {
      const asset = request.explicitFacts.asset;
      const amount = request.explicitFacts.statedHoldings;
      const declaredHoldings = request.explicitFacts.chain === wallet.networkKey && asset && amount
        ? { asset, amount } : null;
      const result = await post<PortfolioSnapshot>('/api/agent/portfolio', {
        chain: wallet.networkKey, address: wallet.address, declaredHoldings,
      }, signal);
      if (!signal.aborted && walletKeyRef.current === requestedWalletKey) setPortfolio(result);
    } catch (cause) {
      if (!signal.aborted) setPortfolioError(cause instanceof Error ? cause.message : '지갑 잔액 조회에 실패했습니다.');
    } finally { if (!signal.aborted) setBusy(false); }
  };
  const reset = () => {
    controller.current?.abort(); setBusy(false);
    if (invalid !== null) {
      try { localStorage.setItem(`${storageKey}:unreadable:${Date.now()}`, invalid); }
      catch { setError('읽을 수 없는 원본을 백업하지 못했습니다. 먼저 JSON으로 내보내 주세요.'); return; }
    }
    setInvalid(null); setRequest(emptyAgentRequest()); setValidation(validateAgentRequest(emptyAgentRequest()));
    setNextQuestion(null); setTranscript([]); setResearch(null); setAssessment(null);
    setStoredPlanId(null); setStoredAllocationId(null);
    setPortfolio(null); setPortfolioError('');
    setMessage(''); setFieldValue(''); setFieldError(''); setError(''); setExtraction(null);
  };
  const storePlan = (plan: Plan) => {
    if (!onSelectPlan || !assessment || !canStoreAssessedPlan(request, assessment, plan, wallet)) {
      setError('입력 버전, 지갑, 계획 상태가 달라졌습니다. 시세와 계획을 다시 평가해 주세요.');
      return;
    }
    try {
      onSelectPlan(plan, request, assessment);
      setStoredPlanId(plan.id); setStoredAllocationId(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '계획을 보관하지 못했습니다.');
    }
  };
  const storeAllocation = (allocation: DatedAllocation) => {
    if (!onSelectDatedAllocation || !assessment || !canStoreDatedAllocation(request, assessment, allocation, wallet)) {
      setError('입력 버전, 지갑, 날짜별 배분안이 달라졌습니다. 시세와 계획을 다시 평가해 주세요.');
      return;
    }
    try {
      onSelectDatedAllocation(allocation, request, assessment);
      setStoredAllocationId(allocation.id); setStoredPlanId(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '날짜별 배분안을 보관하지 못했습니다.');
    }
  };
  const datedAllocation = (assessment as Assessment & { datedAllocation?: DatedAllocation } | null)?.datedAllocation;
  const readOnlyEvidence = visibleJusdtReadOnlyEvidence(request, assessment, wallet,
    Math.max(evidenceClock, Date.now()));
  const jusdtMarketSource = assessment?.plans.find(plan => plan.kind === 'justlend_jusdt')?.source ?? null;

  return <section className="surface agent-panel" aria-label="명시 정보 기반 자산 계획 에이전트">
    <div className="panel-head"><div><span className="panel-step">AI</span><h3>명시 정보로 계획·시장 조사</h3></div>
      <button className="text-button" type="button" onClick={reset}>새 요청 ↺</button></div>
    <p className="conversation-disclosure">말씀하신 사실만 JSON에 저장합니다. 시장 조사와 계획 평가는 읽기 전용이며 거래를 실행하지 않습니다. 아래 가상 시연 입력과는 별개입니다.</p>
    {extraction && <p className="agent-extraction-mode">문장 해석: {extraction.provider === 'nim'
      ? 'NVIDIA NIM 보조 · 규칙 검증 완료' : extraction.reason === 'not_configured'
        ? '규칙 기반 · NIM 미설정' : '규칙 기반 · NIM 연결 실패'}</p>}
    {invalid !== null && <div className="input-error" role="alert"><strong>저장된 요청 JSON을 읽지 못했습니다.</strong>
      <p>원본을 보존했습니다. 먼저 내보내거나 새 요청을 시작해 주세요.</p>
      <button type="button" onClick={() => saveOriginal('gwdc-unreadable-agent-request.json', invalid)}>원본 JSON 내보내기</button></div>}
    <div className="agent-transcript" aria-live="polite">
      {transcript.length ? transcript.map((turn, index) => <p key={index} className={`conversation-turn ${turn.role}`}>
        <small>{turn.role === 'user' ? '사용자님' : '조건 확인'}</small>{turn.text}</p>)
        : <p className="conversation-empty">“1,000 USDT를 30일 운용해요. 7일 뒤 200 USDT를 지출해요.” 또는 “JustLend 금리는?”처럼 말씀해 주세요.</p>}
    </div>
    <form className="conversation-form" onSubmit={event => void submit(event)}>
      <label htmlFor="agent-message">계획 조건이나 시장 질문</label>
      <div><input id="agent-message" value={message} onChange={event => setMessage(event.target.value)}
        maxLength={2000} placeholder="조건 또는 질문을 입력해 주세요" disabled={busy || invalid !== null} />
        <button type="submit" disabled={busy || invalid !== null || !message.trim()}>{busy ? '확인 중…' : '입력 분석'}</button></div>
    </form>
    {nextQuestion && <div className="agent-next-question" role="status"><strong>다음 확인</strong><p>{nextQuestion.text}</p>
      {nextQuestion.field !== 'fundingCoverage' && <form className="agent-field-form" onSubmit={event => void submitField(event)}>
        <label htmlFor="agent-field-value">{fieldLabels[nextQuestion.field] ?? nextQuestion.field} 직접 입력</label>
        <div><input id="agent-field-value" value={fieldValue} onChange={event => setFieldValue(event.target.value)}
          maxLength={120} placeholder={fieldExample(nextQuestion.field)} disabled={busy || invalid !== null} />
          <button type="submit" disabled={busy || invalid !== null || !fieldValue.trim()}>값 확인</button></div>
      </form>}
      {fieldError && <p className="input-error" role="alert">{fieldError}</p>}</div>}
    {error && <p className="input-error" role="alert">{error}</p>}
    {request.intent !== 'unknown' && <div className="agent-request-output">
      <div className="agent-output-heading"><strong>사용자님이 명시한 정보 · 버전 {request.version}</strong>
        <button type="button" onClick={() => saveJson('gwdc-declared-request.json', request)}>JSON 내보내기</button></div>
      <pre aria-label="명시 정보 JSON">{JSON.stringify({ schemaVersion: request.schemaVersion, intent: request.intent,
        explicitFacts: request.explicitFacts, marketQuestions: request.marketQuestions,
        missingFields: validation.missingFields, invalidFields: validation.invalidFields,
        conflicts: validation.conflicts }, null, 2)}</pre>
      {validation.missingFields.length > 0 && <p>추가 확인: {validation.missingFields.map(field => fieldLabels[field] ?? field).join(', ')}</p>}
      {validation.invalidFields.length > 0 && <p>형식·의미 확인: {validation.invalidFields.map(field => fieldLabels[field] ?? field).join(', ')}</p>}
      {request.explicitFacts.expenseDeclaration === 'scheduled' && request.explicitFacts.expenses.length > 0
        && request.explicitFacts.chain === 'mainnet' && <div className="agent-dated-risk">
          <strong>예정 지출액의 운용 위험</strong>
          <p>지출 예정액을 jUSDT에 예치하면 지갑의 유동 USDT가 아닙니다. 지급일 전에 환매가 지연되거나 비용이 늘 수 있습니다. 동의하지 않거나 답하지 않으면 지출액은 보유하고 나머지 금액만 평가합니다.</p>
          <p>현재 선택: {request.explicitFacts.acceptsDatedExpenseLiquidityRisk === true ? '위험을 이해하고 후보에 포함'
            : request.explicitFacts.acceptsDatedExpenseLiquidityRisk === false ? '지출액 보유' : '미선택 · 지출액 보유'}</p>
          <button type="button" disabled={busy || invalid !== null} onClick={() => void setDatedExpenseRisk(true)}>위험을 이해하고 지출액 운용 후보에 포함</button>{' '}
          <button type="button" disabled={busy || invalid !== null} onClick={() => void setDatedExpenseRisk(false)}>지출액 보유</button>
        </div>}
      {validation.status === 'ready_for_confirmation' && <button className="agent-primary" type="button" onClick={() => void confirm()} disabled={busy}>JSON 확인하고 평가</button>}
      {validation.status === 'confirmed' && <button className="agent-primary" type="button" onClick={() => void refreshAssessment()} disabled={busy}>시세·계획 다시 평가</button>}
      {request.marketQuestions.length > 0 && <button className="agent-secondary" type="button" onClick={() => void refreshResearch()} disabled={busy}>최근 시장 질문 다시 조회</button>}
    </div>}
    {research && <div className="agent-research-output"><h4>질문별 시장 조사</h4>
      {research.results.map((result, index) => <article key={`${result.question}-${index}`}>
        <strong>{result.question} · {result.topic}</strong><p>{result.conclusion}</p>
        <ul>{result.claims.map((claim, claimIndex) => <li key={claimIndex}>{claim.label}: {claim.value ?? '확인 불가'} {claim.unit ?? ''}
          {claim.source?.sourceUrl && <a href={claim.source.sourceUrl} target="_blank" rel="noreferrer">출처 ↗</a>}
          <small>표시 전용 · {claim.availability} · {claim.source?.chain ?? '체인 미확인'} · {claim.source?.mode ?? '자료 모드 미확인'}</small>
          {claim.source && <small>{claim.source.fetchedAt
            ? '조회: ' + sourceTime(claim.source.fetchedAt)
            : '성공한 조회 없음'}
            {claim.source.attemptedAt && ' · 시도: ' + sourceTime(claim.source.attemptedAt)}
            {' · 원천 갱신: ' + sourceTime(claim.source.sourceUpdatedAt) + ' (한국 시간)'}</small>}
          {claim.note && <small>{claim.note}</small>}</li>)}</ul>
        {result.unavailable.length > 0 && <p className="agent-limited">현재 확인 불가: {result.unavailable.join('; ')}</p>}
        <small>{result.planningImpact}</small>
      </article>)}
    </div>}
    <div className="agent-portfolio-output">
      <div className="agent-output-heading"><strong>TronLink 실잔액·JustLend 포지션 관측</strong>
        {wallet.address && (wallet.networkKey === 'mainnet' || wallet.networkKey === 'nile') &&
          <button type="button" onClick={() => void refreshPortfolio()} disabled={busy}>{busy ? '조회 중…' : '읽기 전용 조회'}</button>}</div>
      {wallet.address && (wallet.networkKey === 'mainnet' || wallet.networkKey === 'nile')
        ? <p>{wallet.network} · {wallet.address}</p>
        : <p>확인된 TronLink 주소와 Mainnet 또는 Nile 네트워크가 필요합니다. <a href="/connections">연결 상태에서 주소 연결 ↗</a></p>}
      {portfolioError && <p className="input-error" role="alert">{portfolioError}</p>}
      {portfolio && <div className="agent-portfolio-values">
        <p>관측 시각 {sourceTime(portfolio.observedAt)} (한국 시간) · {portfolio.chain} · 거래 권한 없음</p>
        <p>지갑 보유액: {portfolio.walletBalance.amount ?? '확인 불가'} {portfolio.walletBalance.token.symbol}
          {portfolio.walletBalance.reason && <small>{portfolio.walletBalance.reason}</small>}</p>
        <p>수수료용 잔액: {portfolio.feeBalance.amount ?? '확인 불가'} TRX
          {portfolio.feeBalance.reason && <small>{portfolio.feeBalance.reason}</small>}</p>
        <p>JustLend 포지션: {portfolio.position.receiptBalance ?? '확인 불가'} {portfolio.position.receiptToken.symbol}
          {' · '}기초 자산 추정 {portfolio.position.underlyingValue ?? '확인 불가'} {portfolio.position.underlyingToken.symbol}
          {portfolio.position.reason && <small>{portfolio.position.reason}</small>}</p>
        {portfolio.declaredHoldings && <p>사용자님 진술: {portfolio.declaredHoldings.amount} {portfolio.declaredHoldings.asset}
          {' · '}관측 잔액과 차이: {portfolio.observedMinusDeclared ?? '비교 불가'}</p>}
        <p className="agent-limited">{portfolio.block.reason} 조회 항목마다 적용 블록이 다를 수 있습니다.</p>
      </div>}
    </div>
    {assessment && <div className="agent-assessment-output"><h4>계획 평가 · 읽기 전용</h4>
      <p>{assessment.summary}</p>
      <p>입력 확인 버전 {assessment.confirmedVersion} · 평가 시각 {sourceTime(assessment.assessedAt)} (한국 시간) · 자료 {assessment.dataMode}</p>
      <p>선택한 날짜별 jUSDT 경로 자료: {assessment.selectedRouteDataMode === 'live' ? '현재 읽기 자료' : '혼합 또는 미확인'}
        {' · '}판정 {assessment.datedDecision?.action === 'conditional_allocate' ? '일부 또는 전체 구간의 조건부 후보'
          : assessment.datedDecision?.action === 'hold' ? '보유' : '필수 근거 부족으로 보류'}</p>
      <p>사용자님 진술 보유액: {assessment.declaredAmount} {assessment.plans[0]?.inputToken.symbol ?? ''}
        {' · '}진술 기준 지출·예비액 제외: {assessment.declaredInvestableAmount}</p>
      <p>지갑 관측 잔액: {assessment.observedWalletBalance ?? '확인 불가'}
        {' · '}보호액: {assessment.protectedAmount}
        {' · '}실잔액 기준 운용 권고 상한: {assessment.investableAmount}</p>
      {assessment.balanceReason && <p className="agent-limited">{assessment.balanceReason}</p>}
      {assessment.walletBalanceSource && <small>잔액 근거: {assessment.walletBalanceSource.chain} · {assessment.walletBalanceSource.mode}
        {' · '}조회 {sourceTime(assessment.walletBalanceSource.fetchedAt)} (한국 시간)
        {' · '}블록 번호 미제공 · 항목 간 동일 블록 스냅샷 아님</small>}
      {assessment.planBasis === 'declared_hypothetical' && <p className="agent-limited">아래 계획별 운용액은 사용자님 진술을 바탕으로 계산한 가정값입니다. 실제 운용 권고액은 0이며 거래에 사용할 수 없습니다.</p>}
      <p className="agent-limited">기존 단일 경로 판정: {assessment.decision.action} · 거래 권한 없음 · 평가 {assessment.assessmentId.slice(0, 12)}</p>
      {onSelectPlan && <p className="agent-limited">계획을 선택하면 감시·검토 기준으로 보관합니다. 이 선택으로 거래가 실행되거나 승인되지는 않습니다.
        {assessment.planBasis === 'declared_hypothetical' && ' 지갑 실잔액이 확인되지 않은 계획은 진술액 기반 가정 비교입니다.'}</p>}
      {assessment.decision.reasonCodes.length > 0 && <p>판정 근거: {assessment.decision.reasonCodes.join(', ')}</p>}
      {readOnlyEvidence && <JusdtReadOnlyEvidencePanel evidence={readOnlyEvidence} marketSource={jusdtMarketSource} />}
      {assessment.jusdtReadOnlyEvidence && !readOnlyEvidence && <p className="agent-limited" role="status">
        이전 금액별 조회 근거가 만료되었거나 현재 지갑·네트워크·입력과 일치하지 않습니다. 시세·계획을 다시 평가해 주세요.
      </p>}
      {datedAllocation && <div className="agent-dated-allocation">
        <h5>지출 날짜별 배분 비교 · {assessment.planBasis === 'declared_hypothetical' ? '진술액 기반 가정' : '관측 잔액 상한 기준'}</h5>
        <p>판정: {assessment.planBasis === 'declared_hypothetical' ? '실잔액 권고 보류 · 가정 비교'
          : assessment.datedDecision?.action === 'conditional_allocate' ? '선택 구간만 조건부 운용 후보 · 나머지 보유'
            : datedAllocation.recommendation === 'allocate' ? '날짜별 운용 후보' : datedAllocation.recommendation === 'hold' ? '보유 유지' : '자료 부족으로 보류'}
          {' · '}{assessment.planBasis === 'declared_hypothetical' ? '가정 운용액' : '운용 후보액'} {datedAllocation.totalInvested} {datedAllocation.asset.symbol}
          {' · '}보유 {datedAllocation.totalHeld} {datedAllocation.asset.symbol}
          {' · '}예상 순익 {datedAllocation.expectedNetYield ?? '미확인'} {datedAllocation.asset.symbol}</p>
        <p className="agent-limited">각 지출일까지 필요한 자금을 별도 항목으로 비교합니다. 금리와 출금 가능량은 바뀔 수 있으며 이 배분안은 거래 지시가 아닙니다. 지출액 운용 동의: {request.explicitFacts.acceptsDatedExpenseLiquidityRisk === true ? '확인됨' : '없음 · 지출액 보유'}</p>
        {assessment.datedDecision && <p>날짜별 판정 근거: {assessment.datedDecision.reasonCodes.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ')} · {assessment.datedDecision.basis === 'current_conditions_scenario' ? '현재 조건의 비용 시나리오' : '견적 미완료'}</p>}
        {datedAllocation.selectedBundleQuote && <div className="agent-bundle-evidence">
          <h6>선택 구간 공동 견적 · {datedAllocation.selectedBundleQuote.status === 'scenario_only' ? '조건부 시나리오' : '불완전'}</h6>
          <p>묶음 버전 {datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)} · 관측 {sourceTime(datedAllocation.selectedBundleQuote.observationWindow.endedAt)} · 만료 {sourceTime(datedAllocation.selectedBundleQuote.validUntil)} KST</p>
          <p>시나리오 APR {datedAllocation.selectedBundleQuote.scenarioRateApr === null ? '미확인' : `${new Decimal(datedAllocation.selectedBundleQuote.scenarioRateApr).times(100).toString()}%`}
            {' · '}예상 비용 {datedAllocation.selectedBundleQuote.expectedCostUsdt ?? '미확인'} USDT
            {' · '}스트레스 비용 {datedAllocation.selectedBundleQuote.stressCostUsdt ?? '미확인'} USDT</p>
          <p>예상 순익 {datedAllocation.selectedBundleQuote.scenarioNetYieldUsdt ?? '미확인'} USDT · 스트레스 순익 {datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? '미확인'} USDT</p>
          <p>수수료용 TRX: 현재 {trxFromSun(datedAllocation.selectedBundleQuote.availableFeeTrxSun)} · 정책상 필요 {trxFromSun(datedAllocation.selectedBundleQuote.requiredFeeTrxSun)}. 이는 USDT 예비액과 별도이며 미래 수수료 상한이 아닙니다.</p>
          <p>공동 승인 경로: {datedAllocation.selectedBundleQuote.approvalActions === 'none' ? '추가 승인 없음'
            : datedAllocation.selectedBundleQuote.approvalActions === 'approve' ? '승인 1회'
              : datedAllocation.selectedBundleQuote.approvalActions === 'reset_then_approve' ? '초기화 후 승인 2회' : '미확인'}</p>
          <ul>{datedAllocation.selectedBundleQuote.actions.map((action, index) => <li key={`${action.bucketKey ?? 'shared'}-${action.cost.action}-${index}`}>
            {costActionLabels[action.cost.action]} · {action.bucketKey ?? '공동 승인'} · {costBasisLabels[action.cost.basis]}
            {' · '}Energy {action.cost.energyUnits ?? '미확인'} · Bandwidth {action.cost.bandwidthBytes ?? '미확인'} bytes
            {' · '}현재 비용 {trxFromSun(action.cost.estimatedFeeSun)}
            {action.cost.sources[0] && <> · <a href={action.cost.sources[0].sourceUrl} target="_blank" rel="noreferrer">비용 근거 ↗</a></>}
          </li>)}</ul>
          <small>과거 거래 모델과 현재 계정 모의 결과는 미래 거래 성공이나 회수 보증이 아닙니다.</small>
        </div>}
        <div className="agent-allocation-scroll"><table className="agent-allocation-table">
          <thead><tr><th>목적·필요일</th><th>금액</th><th>운용 경로</th><th>회수 요청</th><th>비용·예상 순익</th><th>확인 사항</th></tr></thead>
          <tbody>{datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
            <td>{leg.purpose === 'expense' ? '예정 지출' : '운용 종료'}<small>{leg.dueDate} · {leg.daysUntilDue}일 뒤</small></td>
            <td>{leg.amount} {datedAllocation.asset.symbol}</td>
            <td>{leg.decision === 'invest' && leg.product ? planLabels[leg.product] : '보유'}
              <small>운용 {leg.invested} · 보유 {leg.held} {datedAllocation.asset.symbol}</small>
              {leg.decision === 'invest' && <small>이자 계산 기간 {leg.earningDays}일 · {leg.eligibility === 'eligible' ? '조건 충족' : '추가 확인 필요'}</small>}</td>
            <td>{leg.withdrawalRequestDate ?? '해당 없음'}</td>
            <td>구간 비용 {leg.roundTripCost ?? '묶음 공동 비용에 포함 또는 미확인'}<small>예상 기여 순익 {leg.expectedNetYield ?? '미확인'} {datedAllocation.asset.symbol}</small>
              {leg.sizedQuoteVersion && <small>금액별 견적 {leg.sizedQuoteVersion.slice(0, 12)} · 만료 {sourceTime(leg.validUntil ?? null)}</small>}</td>
            <td>{leg.reasons.length > 0 ? leg.reasons.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ') : '추가 사유 없음'}
              {leg.source && <small>{leg.source.mode} · 조회 {sourceTime(leg.source.fetchedAt)} (한국 시간)</small>}</td>
          </tr>)}</tbody>
        </table></div>
        {onSelectDatedAllocation && <button className="agent-store-plan" type="button"
          disabled={busy || !canStoreDatedAllocation(request, assessment, datedAllocation, wallet)}
          onClick={() => storeAllocation(datedAllocation)}>{storedAllocationId === datedAllocation.id
            ? '날짜별 배분안 보관됨' : '날짜별 배분안 감시·검토용으로 보관'}</button>}
        {storedAllocationId === datedAllocation.id && <p className="agent-limited"><a href="/review">계획 검토 화면</a>에서 보관한 기준을 확인하세요. 자동 거래는 실행되지 않습니다.</p>}
      </div>}
      <ul>{assessment.plans.map(plan => <li key={plan.id}><strong>{planLabels[plan.kind] ?? plan.kind}</strong>
        {' · '}{plan.eligibility.status} · 운용 {plan.allocation.invested} {plan.inputToken.symbol}
        {' · '}예상 순수익 {plan.netYield ?? '미확인'} {plan.inputToken.symbol}
        {' · '}왕복 비용 {plan.roundTripCost ?? '미확인'} {plan.inputToken.symbol}
        {plan.eligibility.reasons.length > 0 && <small>제외·보류 근거: {plan.eligibility.reasons.join(', ')}</small>}
        {plan.source && <small>자료: {plan.source.mode} · 조회 {sourceTime(plan.source.fetchedAt)} (한국 시간) · 원천 갱신 {sourceTime(plan.source.sourceUpdatedAt)}</small>}
        {plan.risks.length > 0 && <small>위험: {plan.risks.join('; ')}</small>}
        {assessment.chain === 'nile' && plan.kind === 'justlend_jtrx'
          && <NileAgentFeeEvidence now={Math.max(evidenceClock, Date.now())}
            scenario={visibleNileFeeScenario(request, assessment, plan, wallet)} />}
        {onSelectPlan && <button className="agent-store-plan" type="button"
          disabled={busy || !canStoreAssessedPlan(request, assessment, plan, wallet)}
          onClick={() => storePlan(plan)}>{storedPlanId === plan.id ? '검토 계획으로 보관됨' : '감시·검토 계획으로 보관'}</button>}</li>)}</ul>
      {storedPlanId && <p className="agent-limited">선택한 계획을 <a href="/review">계획 검토 화면</a>에서 확인할 수 있습니다. 최신 자료 재평가 전에는 실행 판단에 사용하지 마세요.</p>}
      {assessment.diagnostics.length > 0 && <details><summary>미확인 데이터와 연결 상태</summary><ul>{assessment.diagnostics.map(item =>
        <li key={item.name}>{item.name}: {item.status} · {item.reason}</li>)}</ul></details>}
    </div>}
  </section>;
}
