import { useEffect, useState } from 'react';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { datedAllocationSchema, instantSchema, planSchema, type DatedAllocation, type ExecutionRecord, type Plan,
  type PositionFlow, type UserNeeds } from '../../../shared/schemas';
import { canPreviewNileDeposit } from '../../../shared/execution-policy';
import { canStoreManualDatedAllocation } from '../../lib/manual-allocation';
import { findNileRoundTripReference, nileRateScenario } from '../../lib/nile-reference';
import './plan-dated.css';

const sunSchema = z.string().regex(/^\d+$/);
const nileFeeScenarioSchema = z.object({
  planId: z.string().min(1),
  status: z.enum(['reference_scenario', 'partial', 'unknown']),
  basis: z.enum(['representative_simulation', 'historical_reference', 'unknown']),
  amountSun: sunSchema.nullable(), jTokenAmountRaw: sunSchema.nullable(),
  depositFeeSun: sunSchema.nullable(), estimatedRedeemFeeSun: sunSchema.nullable(),
  stressRedeemFeeSun: sunSchema.nullable(), estimatedRoundTripFeeSun: sunSchema.nullable(),
  stressRoundTripFeeSun: sunSchema.nullable(), feeReserveSun: sunSchema.nullable(),
  postReserveInvestableSun: sunSchema.nullable(), reserveStatus: z.enum(['ready', 'insufficient', 'unknown']),
  economicDepositSun: sunSchema.nullable().optional(),
  economicFeeReserveSun: sunSchema.nullable().optional(),
  economicSizingStatus: z.enum(['ready', 'insufficient', 'unknown']).optional(),
  referenceAccountAddress: z.string().min(1).nullable(),
  referenceTxIds: z.array(z.string().regex(/^[0-9a-fA-F]{64}$/)),
  reason: z.string().nullable(), sourceUrl: z.string().nullable(),
  fetchedAt: instantSchema.nullable(), validUntil: instantSchema.nullable(),
  assumptions: z.array(z.string()),
});
type NileFeeScenario = z.infer<typeof nileFeeScenarioSchema>;
const responseSchema = z.object({
  plans: z.array(planSchema), recommendedPlanId: z.string().nullable(),
  datedAllocation: datedAllocationSchema.optional(),
  nileRatePerBlockRaw: z.string().regex(/^\d+$/).nullable().optional(),
  nileFeeScenarios: z.array(nileFeeScenarioSchema).optional(),
  diagnostics: z.array(z.object({ name: z.string(), status: z.string(), reason: z.string().nullable() })),
});
const reasonText: Record<string, string> = {
  needs_unconfirmed: '입력 확인 필요', chain_mismatch: '체인 불일치', asset_mismatch: '자산 불일치',
  expense_asset_mismatch: '지출 자산 불일치', quote_unavailable: '상품 근거 조회 불가', quote_stale: '견적 시각 경과',
  non_live_data: '현재 실데이터 아님', market_inactive: '시장 비활성', market_unknown: '시장 활성 미확인',
  token_unverified: '계약·토큰 미검증', rate_unavailable: '수익률 미확인', cost_unverified: '왕복 비용 미확인',
  conversion_unverified: 'PSM 왕복 전환 미검증', entry_capacity_insufficient: '진입 가용량 부족 또는 미확인',
  exit_capacity_insufficient: '출구 가용량 부족 또는 미확인', liquidity_insufficient: '시장 인출 유동성 부족',
  withdrawal_delay: '출금 지연', usdd_risk_declined: 'USDD 위험 미동의', risk_preference: '위험 성향과 불일치',
  balance_unverified: '지갑 잔고 미확인', balance_insufficient: '지갑 잔고 부족',
  fee_reserve_unverified: '수수료 재원 미확인', fee_reserve_insufficient: '수수료 재원 부족',
  zero_investable: '운용 가능 금액 없음', liquidity_unverified: '출금 가능량 미확인',
  start_date_not_today: '운용 시작일 재확인 필요', due_today: '오늘 필요한 자금',
  non_positive_net_yield: '비용 차감 후 수익 없음', positive_verified_net_yield: '비용 차감 후 예상 수익 양수',
  aggregate_exit_or_conversion_capacity_insufficient: '합산 출구·전환 가용량 부족',
  amount_precision_unverified: '금액 정밀도 미확인',
  dated_expense_liquidity_risk_declined: '지출액 기한 전 운용 위험 미동의',
};
const title: Record<Plan['kind'], string> = {
  hold: '보유 기준선', justlend_jusdt: 'A · USDT 예치', psm_jusdd: 'B · USDD 전환 후 예치',
  justlend_jtrx: 'Nile · TRX 예치',
};
const productLabel: Record<NonNullable<DatedAllocation['legs'][number]['product']>, string> = {
  justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};
function amount(value: string | null, unit = 'USDT') {
  return value === null ? '미확인' : `${new Decimal(value).toDecimalPlaces(6).toString()} ${unit}`;
}
function statusLabel(plan: Plan) {
  return plan.eligibility.status === 'eligible' ? '검증 조건 충족'
    : plan.eligibility.status === 'conditional' ? '추가 검증 필요' : '실행 제외';
}
function sunAmount(value: string | null) {
  return value === null ? '미산정' : `${new Decimal(value).div(1_000_000).toDecimalPlaces(6).toString()} TRX`;
}
function sourceLink(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
function koreanTime(value: string) {
  return `${new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST`;
}

export function NileFeeEvidence({ scenario }: { scenario: NileFeeScenario | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!scenario?.validUntil) return;
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, [scenario?.validUntil]);
  const link = sourceLink(scenario?.sourceUrl ?? null);
  const fetched = scenario?.fetchedAt ? Date.parse(scenario.fetchedAt) : NaN;
  const expires = scenario?.validUntil ? Date.parse(scenario.validUntil) : NaN;
  const referenceProvenanceValid = scenario?.basis === 'representative_simulation'
    ? !!scenario.referenceAccountAddress : scenario?.basis === 'historical_reference'
      ? scenario.referenceTxIds.length >= 6 : true;
  const current = !!scenario && !!link && Number.isFinite(fetched) && Number.isFinite(expires)
    && fetched <= now && fetched < expires && now < expires && referenceProvenanceValid;
  const hasEntry = current && scenario?.depositFeeSun !== null;
  const hasExit = current && scenario?.basis !== 'unknown' && scenario?.estimatedRedeemFeeSun !== null;
  const complete = current && scenario?.status === 'reference_scenario' && scenario.basis !== 'unknown'
    && scenario.depositFeeSun !== null
    && scenario.estimatedRedeemFeeSun !== null && scenario.estimatedRoundTripFeeSun !== null
    && scenario.stressRedeemFeeSun !== null && scenario.stressRoundTripFeeSun !== null;
  const basis = scenario?.basis === 'representative_simulation' ? '기준 계정 모의 실행'
    : scenario?.basis === 'historical_reference' ? '검증된 과거 유사 거래 모델' : '환매 근거 미확인';
  const status = !scenario ? '근거 없음' : !current && scenario.status !== 'unknown' ? '근거 미완전·만료'
    : complete ? '참고 시나리오' : hasEntry && hasExit ? '일부 비용만 확인'
      : hasEntry ? '진입 비용만 확인' : hasExit ? '환매 참고치만 확인' : '미산정';
  return <div className="nile-fee-evidence" role="note" data-status={status}>
    <div className="nile-fee-head"><strong>미래 환매 수수료 · 금액별 참고</strong><span>{status}</span></div>
    <p>{basis}{scenario?.amountSun ? ` · 후보 운용액 ${sunAmount(scenario.amountSun)}` : ''}</p>
    {current && (hasEntry || hasExit) && <div className="nile-fee-figures">
      {hasEntry && <span>예치 비용 참고 <strong>{sunAmount(scenario!.depositFeeSun)}</strong></span>}
      {hasExit && <span>미래 환매 비용 참고 <strong>{sunAmount(scenario!.estimatedRedeemFeeSun)}</strong></span>}
      {hasExit && scenario!.stressRedeemFeeSun !== null && <span>미래 환매 스트레스 비용 참고 <strong>{sunAmount(scenario!.stressRedeemFeeSun)}</strong></span>}
      {complete && <>
        <span>왕복 비용 참고 <strong>{sunAmount(scenario!.estimatedRoundTripFeeSun)}</strong></span>
        <span>환매 단가 2배 가정 왕복 비용 <strong>{sunAmount(scenario!.stressRoundTripFeeSun)}</strong></span>
        {scenario!.feeReserveSun !== null && <span>남겨 둘 비용 예비액 참고 <strong>{sunAmount(scenario!.feeReserveSun)}</strong></span>}
        {scenario!.reserveStatus !== 'unknown' && scenario!.postReserveInvestableSun !== null
          && <span>비용 예비액 제외 후 운용 가능액 참고 <strong>{sunAmount(scenario!.postReserveInvestableSun)}</strong></span>}
      </>}
    </div>}
    {complete && scenario!.reserveStatus === 'insufficient' && <p className="nile-fee-reserve-alert">이 카드의 원래 금액은 수수료 예비액이 부족합니다. 경제성 기준의 신규 예치는 보류합니다.</p>}
    {complete && scenario!.economicSizingStatus === 'ready' && scenario!.economicDepositSun !== null
      && scenario!.economicDepositSun !== undefined && scenario!.economicDepositSun !== scenario!.amountSun
      && <p className="nile-fee-reserve-alert">금액별 비용을 다시 조회하면 비용 예비액 {sunAmount(scenario!.economicFeeReserveSun ?? null)}을 남길 때 예치 가능 상한은 {sunAmount(scenario!.economicDepositSun)}입니다. 비용 재원만 고려한 참고치이며 수익성이나 거래 승인은 검증되지 않았습니다.</p>}
    {complete && scenario!.economicSizingStatus === 'insufficient' && <p className="nile-fee-reserve-alert">스트레스 비용 예비액을 남기면 운용 가능액이 없어 신규 예치를 보류합니다.</p>}
    {complete && scenario!.reserveStatus === 'unknown' && <p className="nile-fee-reason">수수료 예비액 충족 여부를 확인하지 못해 신규 예치를 추천할 수 없습니다.</p>}
    {!complete && <p className="nile-fee-reason">미산정: {!current && scenario && scenario.status !== 'unknown' ? '참고 비용의 기준 계정·거래 표본·출처·조회 시각·유효 시각을 확인할 수 없거나 견적이 만료됐습니다. 다시 조회해 주세요.'
      : scenario?.reason || (hasEntry || hasExit ? '한쪽 거래 비용이 확인되지 않아 왕복 비용과 예비액을 산정하지 못했습니다.'
        : '현재 금액에 적용할 기준 계정 모의 실행이나 충분한 확정 거래 근거가 없습니다.')}</p>}
    {scenario && (scenario.assumptions.length > 0 || scenario.referenceAccountAddress || scenario.referenceTxIds.length > 0 || scenario.jTokenAmountRaw)
      && <details><summary>계산 근거와 가정</summary>
        {scenario.referenceAccountAddress && <p>기준 계정: <code>{scenario.referenceAccountAddress}</code></p>}
        {scenario.jTokenAmountRaw && <p>모의 환매 jTRX 원시 수량: <code>{scenario.jTokenAmountRaw}</code></p>}
        {scenario.referenceTxIds.length > 0 && <p>확정 거래 표본 {scenario.referenceTxIds.length}건: {scenario.referenceTxIds.map(txId => <code key={txId}>{txId} </code>)}</p>}
        {scenario.assumptions.length > 0 && <ul>{scenario.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>}
      </details>}
    {(scenario?.fetchedAt || scenario?.validUntil || link) && <p className="nile-fee-source">
      {scenario?.fetchedAt && <>조회 {koreanTime(scenario.fetchedAt)}</>}
      {scenario?.validUntil && <> · 유효 {koreanTime(scenario.validUntil)}까지</>}
      {link && <> · <a href={link} target="_blank" rel="noreferrer">조회 출처 ↗</a></>}
    </p>}
    <small>참고 비용은 사용자님 지갑의 미래 확정 수수료가 아닙니다. 카드의 검증된 왕복 비용·순익·추천 적격성에 포함하지 않으며, 거래 직전에는 본인 지갑으로 새 미리보기가 필요합니다.</small>
  </div>;
}

export function PlanExplorer({ needs, onSelect, onSelectDatedAllocation, selectedDatedAllocationId = null,
  endpoint = '/api/plans', walletAddress, nilePositionFlows = [], nileRecords = [] }: {
  needs: UserNeeds | null; onSelect?: (plan: Plan) => void;
  onSelectDatedAllocation?: (allocation: DatedAllocation) => void;
  selectedDatedAllocationId?: string | null;
  endpoint?: '/api/plans' | '/api/nile/plans'; walletAddress?: string;
  nilePositionFlows?: PositionFlow[]; nileRecords?: ExecutionRecord[];
}) {
  const [plans, setPlans] = useState<Plan[]>([]);
  const [recommended, setRecommended] = useState<string | null>(null);
  const [datedAllocation, setDatedAllocation] = useState<DatedAllocation | null>(null);
  const [diagnostics, setDiagnostics] = useState<{ name: string; status: string; reason: string | null }[]>([]);
  const [nileRatePerBlockRaw, setNileRatePerBlockRaw] = useState<string | null>(null);
  const [nileFeeScenarios, setNileFeeScenarios] = useState<NileFeeScenario[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const needsKey = needs ? JSON.stringify(needs) : '';

  useEffect(() => {
    if (!needs || needs.confirmedVersion !== needs.inputVersion) {
      setPlans([]);
      setRecommended(null);
      setDatedAllocation(null);
      setDiagnostics([]);
      setNileRatePerBlockRaw(null);
      setNileFeeScenarios([]);
      setBusy(false);
      setError('');
      return;
    }
    const controller = new AbortController();
    setPlans([]);
    setRecommended(null);
    setDatedAllocation(null);
    setDiagnostics([]);
    setNileRatePerBlockRaw(null);
    setNileFeeScenarios([]);
    setBusy(true);
    setError('');
    fetch(endpoint, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ needs, ...(walletAddress ? { address: walletAddress } : {}) }), signal: controller.signal,
    }).then(async response => {
      const data: unknown = await response.json();
      if (!response.ok) throw new Error(z.object({ error: z.string() }).safeParse(data).data?.error || `HTTP ${response.status}`);
      return responseSchema.parse(data);
    }).then(data => {
      setPlans(data.plans); setRecommended(data.recommendedPlanId);
      setDatedAllocation(data.datedAllocation ?? null); setDiagnostics(data.diagnostics);
      setNileRatePerBlockRaw(data.nileRatePerBlockRaw ?? null);
      setNileFeeScenarios(data.nileFeeScenarios ?? []);
    }).catch(cause => {
      if (controller.signal.aborted) return;
      setPlans([]); setNileFeeScenarios([]); setError(cause instanceof Error ? cause.message : '계획 계산에 실패했습니다.');
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [needsKey, endpoint, walletAddress]);

  if (!needs || needs.confirmedVersion !== needs.inputVersion) {
    return <div className="plan-gate" role="status"><strong>조건 확인을 기다리고 있습니다.</strong><p>요구 분석에서 금액·지출일·위험 성향을 검토하고 확인해 주세요. 변경하면 계획을 다시 계산합니다.</p></div>;
  }
  const previousRoundTrip = needs.chain === 'nile' && walletAddress
    ? findNileRoundTripReference(nilePositionFlows, nileRecords, walletAddress) : null;
  const nileCandidates = plans.filter(plan => plan.kind === 'justlend_jtrx');
  return <>
    {needs.chain === 'mainnet' && <div className="market-state" role="note">가상 조건 비교입니다. 이 화면은 지갑의 금액별 승인·예치·회수 비용을 확인한 실견적이 아니며 신규 예치 권고로 사용할 수 없습니다. 지갑 기반 평가는 ‘요구 분석’의 에이전트 결과에서 확인해 주세요.</div>}
    {busy && <div className="market-state" role="status">상품 근거와 계획을 다시 계산하고 있습니다…</div>}
    {error && <div className="market-state error" role="alert"><strong>계획 조회 실패</strong><span>{error}</span></div>}
    {datedAllocation && <section className="plan-dated-allocation" aria-label="지출 날짜별 배분 비교">
      <div className="plan-dated-head"><div><h3>지출 날짜별 배분 비교</h3>
        <p>각 지출일 전까지의 예상 순익과 출금 시점을 따로 계산한 읽기 전용 가상 비교입니다.</p></div>
        <strong>{datedAllocation.recommendation === 'allocate' ? '가상 날짜별 비교'
          : datedAllocation.recommendation === 'conditional_allocate' ? '조건부 시나리오'
            : datedAllocation.recommendation === 'hold' ? '보유' : '검증 자료 부족'}</strong></div>
      <div className="table-scroll"><table><thead><tr><th>필요 날짜</th><th>필요 금액</th><th>예상 경로</th><th>출금 요청</th><th>예상 순익</th><th>판정 근거</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
          <td>{leg.dueDate}{leg.purpose === 'horizon' ? ' · 종료일' : ' · 지출'}</td>
          <td>{amount(leg.amount, datedAllocation.asset.symbol)}</td>
          <td>{leg.product ? productLabel[leg.product] : '보유'}<small>운용 {leg.invested} · 보유 {leg.held} {datedAllocation.asset.symbol}</small></td>
          <td>{leg.withdrawalRequestDate ?? '해당 없음'}<small>예상 운용 {leg.earningDays}일</small></td>
          <td>{amount(leg.expectedNetYield, datedAllocation.asset.symbol)}<small>왕복 비용 {amount(leg.roundTripCost, datedAllocation.asset.symbol)}</small></td>
          <td>{[...new Set(leg.reasons)].map(reason => reasonText[reason] ?? reason).join(' · ')}</td>
        </tr>)}</tbody></table></div>
      <p>합계: 운용 후보 {amount(datedAllocation.totalInvested, datedAllocation.asset.symbol)} · 보유 {amount(datedAllocation.totalHeld, datedAllocation.asset.symbol)} · 예상 순익 {amount(datedAllocation.expectedNetYield, datedAllocation.asset.symbol)}</p>
      <p>미확인 항목은 운용에서 제외합니다. 이 가상 비교의 지출액 운용 동의는 실거래 승인이나 출금 보증이 아닙니다. 이 배분안으로 거래할 수 없습니다.</p>
      {onSelectDatedAllocation && <div className="plan-dated-actions"><button className="plan-select" type="button"
        disabled={!canStoreManualDatedAllocation(needs, datedAllocation)}
        onClick={() => onSelectDatedAllocation(datedAllocation)}>{selectedDatedAllocationId === datedAllocation.id
          ? '감시 기준으로 보관됨' : '날짜별 배분안 감시 기준으로 보관'}</button>
        {selectedDatedAllocationId === datedAllocation.id && <a href="/review">목표 감시에서 확인 ↗</a>}
      </div>}
    </section>}
    {plans.length > 0 && <>
      {needs.chain === 'nile' && nileCandidates.length === 2
        && nileCandidates[0].allocation.invested === nileCandidates[1].allocation.invested && <p className="market-state" role="note">
          80/20과 50/50 모두 예정 지출·예비액을 먼저 확보한 결과, 현재 운용 가능 상한이 {amount(nileCandidates[0].allocation.invested, 'TRX')}라 두 후보의 실제 운용액이 같습니다.
        </p>}
      <div className="plan-grid">
        {plans.map(plan => {
          const nileScenario = plan.kind === 'justlend_jtrx' && plan.quote?.status === 'active'
            && plan.source?.chain === 'nile' && plan.source.mode === 'live'
            ? nileRateScenario(nileRatePerBlockRaw, plan.allocation.invested, plan.earningDays ?? plan.days) : null;
          return <article className={`plan-card ${plan.kind === 'justlend_jusdt' ? 'primary-plan' : ''}`} key={plan.id}>
          <div className="plan-card-top"><span className="plan-letter">{plan.kind === 'hold' ? '—' : plan.kind === 'psm_jusdd' ? 'B' : 'A'}</span><span className={`status-pill ${plan.eligibility.status === 'eligible' ? 'neutral' : 'caution'}`}>{statusLabel(plan)}</span></div>
          <p className="plan-route">{plan.chain.toUpperCase()} · {plan.scenario}</p><h3>{title[plan.kind]}</h3>
          <p className="plan-copy">{plan.kind === 'hold' ? '지출과 예비액을 포함해 자산을 보유하는 비교 기준입니다.'
            : plan.kind === 'psm_jusdd'
              ? 'USDT·GemJoin 승인 → PSM 진입 → USDD·jUSDD 승인 → 예치 → 인출 → USDD·PSM 승인 → PSM 출구 · USDT 기준'
              : `${plan.steps.join(' → ')} · ${plan.inputToken.symbol} 기준`}</p>
          <div className="plan-divider" />
          <div className="plan-metric"><small>운용액</small><strong>{amount(plan.allocation.invested, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>먼저 확보</small><strong>{amount(plan.allocation.protected, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{plan.kind === 'justlend_jtrx' ? '기본 수익률 (가정)' : '기본 수익률'}</small><strong>{plan.kind === 'hold' ? '적용 없음'
            : plan.kind === 'justlend_jtrx' ? nileScenario ? `${new Decimal(nileScenario.aprPercent).toDecimalPlaces(6).toString()}% APR` : '블록당 금리 조회 불가'
              : plan.quote?.baseRate ? `${new Decimal(plan.quote.baseRate.rate).times(100).toDecimalPlaces(4).toString()}% ${plan.quote.baseRate.kind.toUpperCase()}` : '미확인'}</strong></div>
          <div className="plan-metric"><small>추가 보상</small><strong>{plan.kind === 'hold' ? '적용 없음'
            : plan.kind === 'justlend_jtrx' && !plan.quote?.reward?.verified ? '검증 자료 없음'
              : plan.quote?.reward?.verified ? `${new Decimal(plan.quote.reward.rate).times(100).toDecimalPlaces(4).toString()}% ${plan.quote.reward.kind.toUpperCase()}` : '미확인'}</strong></div>
          <div className="plan-metric"><small>{plan.kind === 'justlend_jtrx' ? '기간 이자 (비용 전 가정)' : '기간 기본 이자'}</small><strong>{plan.kind === 'justlend_jtrx' && nileScenario
            ? `${new Decimal(nileScenario.grossInterest).gt(0) && new Decimal(nileScenario.grossInterest).lt('0.000001')
              ? '<0.000001 TRX' : amount(nileScenario.grossInterest, 'TRX')}` : amount(plan.baseYield, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>검증된 보상</small><strong>{plan.kind === 'justlend_jtrx' && plan.verifiedReward === null ? '계산 제외' : amount(plan.verifiedReward, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>왕복 비용</small><strong>{plan.kind === 'justlend_jtrx' && plan.roundTripCost === null ? '미래 환매 비용 미산정' : amount(plan.roundTripCost, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>예상 순익</small><strong>{plan.kind === 'justlend_jtrx' && plan.netYield === null ? '수수료 미확인 · 계산 보류' : amount(plan.netYield, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>손익분기</small><strong>{plan.kind === 'justlend_jtrx' && plan.breakEvenDays === null ? '계산 보류' : plan.breakEvenDays === null ? '미확인' : `${plan.breakEvenDays}일`}</strong></div>
          {plan.kind === 'justlend_jtrx' && <div className="nile-scenario-note" role="note">
            <strong>금리 참고 계산</strong>
            <p>{nileScenario ? `온체인 블록당 공급 금리 원시값 ${nileScenario.rawRate} ÷ 10¹⁸ × 연 10,512,000블록(3초 간격 가정)으로 APR을 계산했습니다. 기간 이자는 이 금리가 ${plan.earningDays ?? plan.days}일 동안 유지된다는 단리 가정입니다.`
              : '현재 블록당 공급 금리를 읽지 못해 기간 이자 시나리오도 계산하지 않았습니다.'}</p>
            <p>실제 블록 누락·금리 변동·추가 보상·예치와 미래 환매 수수료는 반영하지 않았습니다. 위 숫자는 수익 권고나 거래 견적이 아닙니다.</p>
            <p><a href="https://docs.justlend.org/developers/supply_and_borrow_market/sbm/" target="_blank" rel="noreferrer">JustLend 금리 단위 ↗</a> · <a href="https://developers.tron.network/docs/block" target="_blank" rel="noreferrer">TRON 3초 블록 설명 ↗</a></p>
          </div>}
          {plan.kind === 'justlend_jtrx' && <NileFeeEvidence scenario={nileFeeScenarios.find(item => item.planId === plan.id) ?? null} />}
          {plan.eligibility.reasons.length > 0 && <div className="plan-warning">{plan.eligibility.reasons.map(reason =>
            plan.kind === 'justlend_jtrx' && reason === 'rate_unavailable'
              ? '운용 수익률 미검증 (상단 APR은 가정)' : reasonText[reason] || reason).join(' · ')}</div>}
          {recommended === plan.id && plan.kind !== 'hold' && <p className="plan-recommended">단일 경로 비교 상위 후보</p>}
          {plan.source && <p className="plan-provenance">{plan.source.mode === 'live'
            ? plan.source.accessMethod === 'rest' && !plan.source.sourceUpdatedAt ? 'REST 조회 · 원천 갱신 미확인' : '실시간'
            : plan.source.mode} · 조회 {new Date(plan.source.fetchedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' })} KST<br />원천 갱신 {plan.source.sourceUpdatedAt ? new Date(plan.source.sourceUpdatedAt).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '제공되지 않음'}<br /><a href={plan.source.sourceUrl} target="_blank" rel="noreferrer">출처 확인 ↗</a></p>}
          {plan.kind !== 'hold' && onSelect && <button className="plan-select" type="button" disabled={needs.chain === 'nile' && plan.eligibility.status !== 'eligible' && !canPreviewNileDeposit(plan)} onClick={() => onSelect(plan)}>{needs.chain === 'mainnet' ? '검토 기록에 보관' : canPreviewNileDeposit(plan) && plan.eligibility.status !== 'eligible' ? 'Nile 기술 시험 미리보기' : '계획 선택'}</button>}
        </article>; })}
      </div>
      {needs.chain === 'nile' && previousRoundTrip && <section className="nile-round-trip-reference" aria-label="이전 Nile 왕복 실증">
        <h3>이 브라우저의 이전 Nile 왕복 실증</h3>
        <p>예치 {amount(previousRoundTrip.deposit.amount, 'TRX')} → 환매 실수령 {amount(previousRoundTrip.withdraw.amount, 'TRX')}</p>
        <p>실제 예치 수수료 {amount(previousRoundTrip.deposit.actualFeeInInputAsset, 'TRX')} + 환매 수수료 {amount(previousRoundTrip.withdraw.actualFeeInInputAsset, 'TRX')} = 왕복 {amount(previousRoundTrip.totalFees, 'TRX')}</p>
        <p><strong>당시 순현금흐름 {amount(previousRoundTrip.netCashFlow, 'TRX')}</strong></p>
        <details><summary>확정 거래 ID와 시각</summary><p>예치 {previousRoundTrip.deposit.solidifiedAt} · <code>{previousRoundTrip.deposit.txId}</code></p><p>환매 {previousRoundTrip.withdraw.solidifiedAt} · <code>{previousRoundTrip.withdraw.txId}</code></p></details>
        <small>이 브라우저에 저장된 확정 거래·포지션 기록의 과거 시험 결과입니다. 현재 80/20·50/50 후보의 미래 수수료나 예상 수익으로 재사용하지 않습니다.</small>
      </section>}
      <p className="plan-footnote">금리는 조회 시점 값이 운용 기간 동안 유지된다는 가정입니다. 비용·출금 가능량이 확인되지 않으면 순익과 실행 가능 여부를 확정하지 않습니다. {needs.chain === 'mainnet' ? '선택한 Mainnet 계획은 이 앱에서 거래하지 않습니다.' : 'Nile 거래에는 별도의 최신 미리보기와 TronLink 확인이 필요합니다.'}</p>
    </>}
    {diagnostics.length > 0 && <div className="source-diagnostics"><h3>상품 데이터 확인</h3>{diagnostics.map(item => <p key={item.name}><strong>{item.name}</strong> · {item.status}{item.reason ? ` · ${item.reason}` : ''}</p>)}</div>}
  </>;
}
