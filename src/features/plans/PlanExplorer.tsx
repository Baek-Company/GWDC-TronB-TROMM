import { localizeKnownText, useI18n } from '../../lib/i18n';
import { useEffect, useState } from 'react';
import Decimal from 'decimal.js';
import { z } from 'zod';
import { datedAllocationSchema, instantSchema, planSchema, type DatedAllocation, type ExecutionRecord, type Plan,
  type PositionFlow, type UserNeeds } from '../../../shared/schemas';
import { canPreviewNileDeposit } from '../../../shared/execution-policy';
import { canStoreManualDatedAllocation } from '../../lib/manual-allocation';
import { findNileRoundTripReference, nileRateScenario } from '../../lib/nile-reference';
import './plan-dated.css';

const planMessages: readonly (readonly [string, string])[] = [
  ["같은 Nile jTRX의 최신 상품 근거가 없습니다.", "There is no current product evidence for the same Nile jTRX market."],
  ["운용액이 0 TRX라 환매 금액을 계산하지 않았습니다.", "The investment is 0 TRX, so no redemption amount was calculated."],
  ["현재 예치 비용: {0}", "Current deposit cost: {0}"],
  ["환매 참고 비용: {0}", "Redemption reference cost: {0}"],
  ["예치 비용·환율의 계정, 수량 또는 조회 시각이 일치하지 않습니다.", "The account, amount, or retrieval time for deposit costs and exchange rates does not match."],
  ["기준 환매 비용의 계약 또는 수량이 현재 후보와 다릅니다.", "The reference redemption cost's contract or amount differs from the current candidate."],
  ["같은 금액의 기준 계정 또는 과거 거래 근거가 검증되지 않았습니다.", "Reference-account or historical transaction evidence for the same amount is unverified."],
  ["현재 환율로 양수 jTRX 예상 수량을 계산할 수 없습니다.", "A positive estimated jTRX amount cannot be calculated at the current exchange rate."],
  ["환매 jTRX 수량은 현재 계정의 예치 모의 실행 환율로 환산했으며 실제 발행량과 다를 수 있습니다.", "The redemption jTRX amount uses the current account's simulated deposit exchange rate and may differ from the actual minted amount."],
  ["환매 jTRX 수량은 상품 조회 당시 환율로 환산했으며 실제 발행량과 다를 수 있습니다.", "The redemption jTRX amount uses the exchange rate when the product was retrieved and may differ from the actual minted amount."],
  ["환매 참고치는 미래 무료 자원을 0으로 두고 현재 Nile 단가를 적용합니다.", "Redemption references assume no future free resources and use current Nile unit prices."],
  ["수수료 예비액은 현재 예치 비용 예산과 환매 스트레스 시나리오의 합계이며 미래 상한이 아닙니다.", "The fee reserve combines the current deposit budget and the redemption stress scenario. It is not a future upper bound."],
  ["수수료 예비액을 반영한 금액이 제한된 재계산 횟수 안에 안정되지 않았습니다.", "The amount after the fee reserve did not stabilize within the recalculation limit."],
  ["Nile jTRX 계약 주소 또는 환매 수량이 유효하지 않습니다.", "The Nile jTRX contract address or redemption amount is invalid."],
  ["제외할 지갑 주소가 유효하지 않습니다.", "The wallet address to exclude is invalid."],
  ["기준 계정 주소가 유효하지 않습니다.", "The reference-account address is invalid."],
  ["Nile 읽기 예산 또는 제한 시간이 유효하지 않습니다.", "The Nile read budget or timeout is invalid."],
  ["충분한 jTRX를 가진 별도 기준 계정을 찾지 못했습니다.", "No separate reference account with sufficient jTRX was found."],
  ["Nile jTRX 현재 환율을 확인하지 못했습니다.", "The current Nile jTRX exchange rate could not be verified."],
  ["환매 수량의 예상 수령액 또는 현재 시장 유동성이 부족합니다.", "The expected redemption proceeds or current market liquidity are insufficient."],
  ["Nile Comptroller 주소를 검증하지 못했습니다.", "The Nile Comptroller address could not be verified."],
  ["Nile jTRX 시장 활성 상태를 검증하지 못했습니다.", "Nile jTRX market activity could not be verified."],
  ["Nile 환매 Energy 추정이 실패했습니다.", "Nile redemption Energy estimation failed."],
  ["Nile 환매 Energy 추정값이 유효하지 않습니다.", "The Nile redemption Energy estimate is invalid."],
  ["Nile 환매 Energy 추가 추정을 완료하지 못했습니다.", "Additional Nile redemption Energy estimation could not be completed."],
  ["Energy 예산이 Nile 체인 허용 범위를 초과합니다.", "The Energy budget exceeds the Nile chain's permitted range."],
  ["Nile 환매 미서명 거래 크기를 확인하지 못했습니다.", "The unsigned Nile redemption transaction size could not be verified."],
  ["Nile 환매 미서명 거래가 유효하지 않습니다.", "The unsigned Nile redemption transaction is invalid."],
  ["Nile의 별도 jTRX 보유 계정에서 현재 환매 수량을 읽기 전용 모의 실행", "Read-only simulation of the current redemption amount using a separate Nile account holding jTRX"],
  ["미래 무료 Energy·Bandwidth 0, 미서명 거래 크기 + 134바이트", "No future free Energy/Bandwidth; unsigned transaction size + 134 bytes"],
  ["스트레스 비용은 현재 자원 단가 2배 가정이며 미래 최대 수수료가 아님", "Stress costs assume twice the current resource unit prices and are not maximum future fees"],
  ["사용자 지갑의 담보·차입·자원 상태 및 미래 시장 변경을 반영하지 않음", "Excludes the user's collateral, borrowing, resource state, and future market changes"],
  ["후보 계정의 jTRX 잔고가 부족하거나 해당 수량의 환매 모의 실행이 실패했습니다.", "The candidate account has insufficient jTRX, or redemption simulation failed for this amount."],
  ["Nile 비용 근거 조회 시간이 만료되었습니다.", "Retrieval of Nile cost evidence timed out."],
  ["Nile 비용 근거 RPC 읽기 예산을 초과했습니다.", "The RPC read budget for Nile cost evidence was exceeded."],
  ["Nile 기준 계정·시장·환매 모의 실행을 검증할 수 없습니다.", "The Nile reference account, market, or redemption simulation could not be verified."],
  ["Nile 비용 모델 입력·현재 단가 또는 유효기간을 검증할 수 없습니다.", "The Nile cost model inputs, current unit prices, or validity period could not be verified."],
  ["같은 Nile 실행 코드·수량 구간의 독립된 확정 환매 표본 5건과 보류 검증 1건이 없습니다.", "There are not five independent confirmed redemption samples and one held-out validation sample for the same Nile execution code and amount range."],
  ["보류 검증 거래가 보정 표본의 Energy 또는 Bandwidth 범위를 초과했습니다.", "The held-out validation transaction exceeded the calibration sample's Energy or Bandwidth range."],
  ["30일 이내 동일 실행 코드·수량 구간의 확정 환매 5건과 보류 검증 1건", "Five confirmed redemptions and one held-out validation sample within 30 days for the same execution code and amount range"],
  ["미래 무료 자원 0, 현재 자원 단가 및 단가 2배 스트레스 시나리오", "No future free resources; current unit prices and a stress scenario with twice those prices"],
  ["미래 Energy 사용량·정책 변동은 상한으로 보증하지 않음", "No upper-bound guarantee for future Energy usage or policy changes"],
  ["Nile 과거 환매 표본과 현재 단가를 검증할 수 없습니다.", "Historical Nile redemption samples and current unit prices could not be verified."],
  ["미래 무료 Energy와 Bandwidth는 0으로 가정합니다.", "Future free Energy and Bandwidth are assumed to be zero."],
  ["미래 단가 2배는 스트레스 가정입니다.", "Doubling future unit prices is a stress assumption."],
  ["기준 계정에서 해당 수량의 환매 모의 실행이 실패했습니다.", "Redemption simulation for this amount failed in the reference account."],
  ["진입 비용 조회가 실패했습니다.", "Entry cost retrieval failed."],
  ["계획 계산에 실패했습니다.", "Failed to calculate plans."],
];

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
const productLabel: Record<NonNullable<DatedAllocation['legs'][number]['product']>, string> = {
  justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
};
function sourceLink(url: string | null) {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' ? parsed.href : null;
  } catch {
    return null;
  }
}
export function NileFeeEvidence({ scenario }: { scenario: NileFeeScenario | null }) {
  const { t, locale } = useI18n();
  function sunAmount(value: string | null) {
    return value === null ? t("미산정", "Not estimated") : `${new Decimal(value).div(1_000_000).toDecimalPlaces(6).toString()} TRX`;
  }
  function formatTime(value: string) {
    return `${new Date(value).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST`;
  }

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
  const basis = scenario?.basis === 'representative_simulation' ? t("기준 계정 모의 실행", "Reference-account simulation")
    : scenario?.basis === 'historical_reference' ? t("검증된 과거 유사 거래 모델", "Verified historical transaction model") : t("환매 근거 미확인", "Redemption evidence unverified");
  const status = !scenario ? t("근거 없음", "No evidence") : !current && scenario.status !== 'unknown' ? t("근거 미완전·만료", "Incomplete or expired evidence")
    : complete ? t("참고 시나리오", "Reference scenario") : hasEntry && hasExit ? t("일부 비용만 확인", "Partial costs verified")
      : hasEntry ? t("진입 비용만 확인", "Entry cost only") : hasExit ? t("환매 참고치만 확인", "Redemption reference only") : t("미산정", "Not estimated");
  return <div className="nile-fee-evidence" role="note" data-status={status}>
    <div className="nile-fee-head"><strong>{t("미래 환매 수수료 · 금액별 참고", "Future redemption fees · Amount-specific reference")}</strong><span>{status}</span></div>
    <p>{basis}{scenario?.amountSun ? t(` · 후보 운용액 ${sunAmount(scenario.amountSun)}`, ` · Candidate investment ${sunAmount(scenario.amountSun)}`) : ''}</p>
    {current && (hasEntry || hasExit) && <div className="nile-fee-figures">
      {hasEntry && <span>{t("예치 비용 참고 ", "Deposit cost reference ")}<strong>{sunAmount(scenario!.depositFeeSun)}</strong></span>}
      {hasExit && <span>{t("미래 환매 비용 참고 ", "Future redemption cost reference ")}<strong>{sunAmount(scenario!.estimatedRedeemFeeSun)}</strong></span>}
      {hasExit && scenario!.stressRedeemFeeSun !== null && <span>{t("미래 환매 스트레스 비용 참고 ", "Future redemption stress cost reference ")}<strong>{sunAmount(scenario!.stressRedeemFeeSun)}</strong></span>}
      {complete && <>
        <span>{t("왕복 비용 참고 ", "Round-trip cost reference ")}<strong>{sunAmount(scenario!.estimatedRoundTripFeeSun)}</strong></span>
        <span>{t("환매 단가 2배 가정 왕복 비용 ", "Round-trip cost with double redemption unit prices ")}<strong>{sunAmount(scenario!.stressRoundTripFeeSun)}</strong></span>
        {scenario!.feeReserveSun !== null && <span>{t("남겨 둘 비용 예비액 참고 ", "Fee reserve reference ")}<strong>{sunAmount(scenario!.feeReserveSun)}</strong></span>}
        {scenario!.reserveStatus !== 'unknown' && scenario!.postReserveInvestableSun !== null
          && <span>{t("비용 예비액 제외 후 운용 가능액 참고 ", "Investable funds after fee reserve ")}<strong>{sunAmount(scenario!.postReserveInvestableSun)}</strong></span>}
      </>}
    </div>}
    {complete && scenario!.reserveStatus === 'insufficient' && <p className="nile-fee-reserve-alert">{t("이 카드의 원래 금액은 수수료 예비액이 부족합니다. 경제성 기준의 신규 예치는 보류합니다.", "The original amount on this card leaves an insufficient fee reserve. New deposits are withheld on economic grounds.")}</p>}
    {complete && scenario!.economicSizingStatus === 'ready' && scenario!.economicDepositSun !== null
      && scenario!.economicDepositSun !== undefined && scenario!.economicDepositSun !== scenario!.amountSun
      && <p className="nile-fee-reserve-alert">{t("금액별 비용을 다시 조회하면 비용 예비액 ", "After rechecking amount-specific costs, with a fee reserve of ")}{sunAmount(scenario!.economicFeeReserveSun ?? null)}{t("을 남길 때 예치 가능 상한은 ", ", the maximum deposit is ")}{sunAmount(scenario!.economicDepositSun)}{t("입니다. 비용 재원만 고려한 참고치이며 수익성이나 거래 승인은 검증되지 않았습니다.", ". This reference considers fee funding only; profitability and transaction approval are unverified.")}</p>}
    {complete && scenario!.economicSizingStatus === 'insufficient' && <p className="nile-fee-reserve-alert">{t("스트레스 비용 예비액을 남기면 운용 가능액이 없어 신규 예치를 보류합니다.", "No investable funds remain after the stress fee reserve, so new deposits are withheld.")}</p>}
    {complete && scenario!.reserveStatus === 'unknown' && <p className="nile-fee-reason">{t("수수료 예비액 충족 여부를 확인하지 못해 신규 예치를 추천할 수 없습니다.", "The fee reserve could not be verified, so a new deposit cannot be recommended.")}</p>}
    {!complete && <p className="nile-fee-reason">{t("미산정: ", "Not estimated: ")}{!current && scenario && scenario.status !== 'unknown' ? t("참고 비용의 기준 계정·거래 표본·출처·조회 시각·유효 시각을 확인할 수 없거나 견적이 만료됐습니다. 다시 조회해 주세요.", "The reference account, transaction sample, source, retrieval time, or validity could not be verified, or the quote has expired. Please refresh.")
      : (scenario?.reason ? scenario.reason.split(' · ').map(part => part.split(': ').map(message => localizeKnownText(message, t, planMessages)).join(': ')).join(' · ') : '') || (hasEntry || hasExit ? t("한쪽 거래 비용이 확인되지 않아 왕복 비용과 예비액을 산정하지 못했습니다.", "One transaction leg has an unverified cost, so the round-trip cost and reserve could not be estimated.")
        : t("현재 금액에 적용할 기준 계정 모의 실행이나 충분한 확정 거래 근거가 없습니다.", "There is no reference-account simulation or sufficient confirmed transaction evidence for this amount."))}</p>}
    {scenario && (scenario.assumptions.length > 0 || scenario.referenceAccountAddress || scenario.referenceTxIds.length > 0 || scenario.jTokenAmountRaw)
      && <details><summary>{t("계산 근거와 가정", "Calculation basis and assumptions")}</summary>
        {scenario.referenceAccountAddress && <p>{t("기준 계정: ", "Reference account: ")}<code>{scenario.referenceAccountAddress}</code></p>}
        {scenario.jTokenAmountRaw && <p>{t("모의 환매 jTRX 원시 수량: ", "Simulated redemption raw jTRX amount: ")}<code>{scenario.jTokenAmountRaw}</code></p>}
        {scenario.referenceTxIds.length > 0 && <p>{t("확정 거래 표본 ", "Confirmed transaction sample ")}{scenario.referenceTxIds.length}{t("건: ", " transactions: ")}{scenario.referenceTxIds.map(txId => <code key={txId}>{txId} </code>)}</p>}
        {scenario.assumptions.length > 0 && <ul>{scenario.assumptions.map((item, index) => <li key={`${index}-${item}`}>{localizeKnownText(item, t, planMessages)}</li>)}</ul>}
      </details>}
    {(scenario?.fetchedAt || scenario?.validUntil || link) && <p className="nile-fee-source">
      {scenario?.fetchedAt && <>{t("조회 ", "Retrieved ")}{formatTime(scenario.fetchedAt)}</>}
      {scenario?.validUntil && <>{t(" · 유효 ", " · Valid until ")}{formatTime(scenario.validUntil)}{t("까지", "")}</>}
      {link && <> · <a href={link} target="_blank" rel="noreferrer">{t("조회 출처 ↗", "Retrieval source ↗")}</a></>}
    </p>}
    <small>{t("참고 비용은 사용자님 지갑의 미래 확정 수수료가 아닙니다. 카드의 검증된 왕복 비용·순익·추천 적격성에 포함하지 않으며, 거래 직전에는 본인 지갑으로 새 미리보기가 필요합니다.", "Reference costs are not confirmed future fees for your wallet. They are excluded from the card's verified round-trip cost, net yield, and recommendation eligibility. A fresh preview using your wallet is required immediately before a transaction.")}</small>
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
  const { t, locale } = useI18n();
  const reasonText: Record<string, string> = {
    needs_unconfirmed: t("입력 확인 필요", "Input confirmation required"), chain_mismatch: t("체인 불일치", "Chain mismatch"), asset_mismatch: t("자산 불일치", "Asset mismatch"),
    expense_asset_mismatch: t("지출 자산 불일치", "Expense asset mismatch"), quote_unavailable: t("상품 근거 조회 불가", "Product evidence unavailable"), quote_stale: t("견적 시각 경과", "Quote expired"),
    non_live_data: t("현재 실데이터 아님", "Not current live data"), market_inactive: t("시장 비활성", "Market inactive"), market_unknown: t("시장 활성 미확인", "Market activity unverified"),
    token_unverified: t("계약·토큰 미검증", "Contract and token unverified"), rate_unavailable: t("수익률 미확인", "Yield rate unverified"), cost_unverified: t("왕복 비용 미확인", "Round-trip cost unverified"),
    conversion_unverified: t("PSM 왕복 전환 미검증", "PSM round-trip conversion unverified"), entry_capacity_insufficient: t("진입 가용량 부족 또는 미확인", "Entry capacity insufficient or unverified"),
    exit_capacity_insufficient: t("출구 가용량 부족 또는 미확인", "Exit capacity insufficient or unverified"), liquidity_insufficient: t("시장 인출 유동성 부족", "Insufficient market withdrawal liquidity"),
    withdrawal_delay: t("출금 지연", "Withdrawal delay"), usdd_risk_declined: t("USDD 위험 미동의", "USDD risk not accepted"), risk_preference: t("위험 성향과 불일치", "Risk preference mismatch"),
    balance_unverified: t("지갑 잔고 미확인", "Wallet balance unverified"), balance_insufficient: t("지갑 잔고 부족", "Insufficient wallet balance"),
    fee_reserve_unverified: t("수수료 재원 미확인", "Fee funds unverified"), fee_reserve_insufficient: t("수수료 재원 부족", "Insufficient fee funds"),
    zero_investable: t("운용 가능 금액 없음", "No investable funds"), liquidity_unverified: t("출금 가능량 미확인", "Withdrawal capacity unverified"),
    start_date_not_today: t("운용 시작일 재확인 필요", "Reconfirm the start date"), due_today: t("오늘 필요한 자금", "Funds required today"),
    non_positive_net_yield: t("비용 차감 후 수익 없음", "No net yield after costs"), positive_verified_net_yield: t("비용 차감 후 예상 수익 양수", "Positive estimated net yield after costs"),
    aggregate_exit_or_conversion_capacity_insufficient: t("합산 출구·전환 가용량 부족", "Insufficient combined exit and conversion capacity"),
    amount_precision_unverified: t("금액 정밀도 미확인", "Amount precision unverified"),
    dated_expense_liquidity_risk_declined: t("지출액 기한 전 운용 위험 미동의", "Risk of investing expense funds before their due date not accepted"),
  };
  const title: Record<Plan['kind'], string> = {
    hold: t("보유 기준선", "Hold baseline"), justlend_jusdt: t("A · USDT 예치", "A · Deposit USDT"), psm_jusdd: t("B · USDD 전환 후 예치", "B · Convert to USDD and deposit"),
    justlend_jtrx: t("Nile · TRX 예치", "Nile · Deposit TRX"),
  };
  function amount(value: string | null, unit = 'USDT') {
    return value === null ? t("미확인", "Unverified") : `${new Decimal(value).toDecimalPlaces(6).toString()} ${unit}`;
  }
  function statusLabel(plan: Plan) {
    return plan.eligibility.status === 'eligible' ? t("검증 조건 충족", "Verification conditions met")
      : plan.eligibility.status === 'conditional' ? t("추가 검증 필요", "Further verification required") : t("실행 제외", "Excluded from execution");
  }
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
      setPlans([]); setNileFeeScenarios([]); setError(cause instanceof Error ? cause.message : t("계획 계산에 실패했습니다.", "Failed to calculate plans."));
    }).finally(() => { if (!controller.signal.aborted) setBusy(false); });
    return () => controller.abort();
  }, [needsKey, endpoint, walletAddress]);

  if (!needs || needs.confirmedVersion !== needs.inputVersion) {
    return <div className="plan-gate" role="status"><strong>{t("조건 확인을 기다리고 있습니다.", "Waiting for confirmation of your inputs.")}</strong><p>{t("요구 분석에서 금액·지출일·위험 성향을 검토하고 확인해 주세요. 변경하면 계획을 다시 계산합니다.", "Review and confirm the amount, expense dates, and risk preference in Needs analysis. Changes trigger a recalculation.")}</p></div>;
  }
  const previousRoundTrip = needs.chain === 'nile' && walletAddress
    ? findNileRoundTripReference(nilePositionFlows, nileRecords, walletAddress) : null;
  const nileCandidates = plans.filter(plan => plan.kind === 'justlend_jtrx');
  return <>
    {needs.chain === 'mainnet' && <div className="market-state" role="note">{t("가상 조건 비교입니다. 이 화면은 지갑의 금액별 승인·예치·회수 비용을 확인한 실견적이 아니며 신규 예치 권고로 사용할 수 없습니다. 지갑 기반 평가는 ‘요구 분석’의 에이전트 결과에서 확인해 주세요.", "This is a hypothetical comparison, not a wallet-specific quote with verified approval, deposit, and redemption costs. It cannot be used to recommend a new deposit. See the agent results in Needs analysis for a wallet-based assessment.")}</div>}
    {busy && <div className="market-state" role="status">{t("상품 근거와 계획을 다시 계산하고 있습니다…", "Refreshing product evidence and recalculating plans…")}</div>}
    {error && <div className="market-state error" role="alert"><strong>{t("계획 조회 실패", "Failed to retrieve plans")}</strong><span>{localizeKnownText(error, t, planMessages)}</span></div>}
    {datedAllocation && <section className="plan-dated-allocation" aria-label={t("지출 날짜별 배분 비교", "Allocation comparison by expense date")}>
      <div className="plan-dated-head"><div><h3>{t("지출 날짜별 배분 비교", "Allocation comparison by expense date")}</h3>
        <p>{t("각 지출일 전까지의 예상 순익과 출금 시점을 따로 계산한 읽기 전용 가상 비교입니다.", "A read-only hypothetical comparison that calculates estimated net yield and withdrawal timing separately for each expense date.")}</p></div>
        <strong>{datedAllocation.recommendation === 'allocate' ? t("가상 날짜별 비교", "Hypothetical comparison by date")
          : datedAllocation.recommendation === 'conditional_allocate' ? t("조건부 시나리오", "Conditional scenario")
            : datedAllocation.recommendation === 'hold' ? t("보유", "Hold") : t("검증 자료 부족", "Insufficient verified evidence")}</strong></div>
      <div className="table-scroll"><table><thead><tr><th>{t("필요 날짜", "Required date")}</th><th>{t("필요 금액", "Required amount")}</th><th>{t("예상 경로", "Expected route")}</th><th>{t("출금 요청", "Withdrawal request")}</th><th>{t("예상 순익", "Estimated net yield")}</th><th>{t("판정 근거", "Decision basis")}</th></tr></thead><tbody>
        {datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
          <td>{leg.dueDate}{leg.purpose === 'horizon' ? t(" · 종료일", " · End date") : t(" · 지출", " · Expense")}</td>
          <td>{amount(leg.amount, datedAllocation.asset.symbol)}</td>
          <td>{leg.product ? productLabel[leg.product] : t("보유", "Hold")}<small>{t("운용 ", "Invested ")}{leg.invested}{t(" · 보유 ", " · Held ")}{leg.held} {datedAllocation.asset.symbol}</small></td>
          <td>{leg.withdrawalRequestDate ?? t("해당 없음", "Not applicable")}<small>{t("예상 운용 ", "Estimated investment period ")}{leg.earningDays}{t("일", " days")}</small></td>
          <td>{amount(leg.expectedNetYield, datedAllocation.asset.symbol)}<small>{t("왕복 비용 ", "Round-trip cost ")}{amount(leg.roundTripCost, datedAllocation.asset.symbol)}</small></td>
          <td>{[...new Set(leg.reasons)].map(reason => reasonText[reason] ?? reason).join(' · ')}</td>
        </tr>)}</tbody></table></div>
      <p>{t("합계: 운용 후보 ", "Totals: investment candidate ")}{amount(datedAllocation.totalInvested, datedAllocation.asset.symbol)}{t(" · 보유 ", " · Held ")}{amount(datedAllocation.totalHeld, datedAllocation.asset.symbol)}{t(" · 예상 순익 ", " · Estimated net yield ")}{amount(datedAllocation.expectedNetYield, datedAllocation.asset.symbol)}</p>
      <p>{t("미확인 항목은 운용에서 제외합니다. 이 가상 비교의 지출액 운용 동의는 실거래 승인이나 출금 보증이 아닙니다. 이 배분안으로 거래할 수 없습니다.", "Unverified items are excluded from investment. Consent to invest expense funds in this hypothetical comparison is neither transaction approval nor a withdrawal guarantee. This allocation cannot execute trades.")}</p>
      {onSelectDatedAllocation && <div className="plan-dated-actions"><button className="plan-select" type="button"
        disabled={!canStoreManualDatedAllocation(needs, datedAllocation)}
        onClick={() => onSelectDatedAllocation(datedAllocation)}>{selectedDatedAllocationId === datedAllocation.id
          ? t("감시 기준으로 보관됨", "Saved as monitoring baseline") : t("날짜별 배분안 감시 기준으로 보관", "Save dated allocation as monitoring baseline")}</button>
        {selectedDatedAllocationId === datedAllocation.id && <a href="/review">{t("목표 감시에서 확인 ↗", "View in goal monitoring ↗")}</a>}
      </div>}
    </section>}
    {plans.length > 0 && <>
      {needs.chain === 'nile' && nileCandidates.length === 2
        && nileCandidates[0].allocation.invested === nileCandidates[1].allocation.invested && <p className="market-state" role="note">
          80/20과 50/50 모두 예정 지출·예비액을 먼저 확보한 결과, 현재 운용 가능 상한이 {amount(nileCandidates[0].allocation.invested, 'TRX')}{t("라 두 후보의 실제 운용액이 같습니다.", ", so both candidates invest the same amount.")}
        </p>}
      <div className="plan-grid">
        {plans.map(plan => {
          const nileScenario = plan.kind === 'justlend_jtrx' && plan.quote?.status === 'active'
            && plan.source?.chain === 'nile' && plan.source.mode === 'live'
            ? nileRateScenario(nileRatePerBlockRaw, plan.allocation.invested, plan.earningDays ?? plan.days) : null;
          return <article className={`plan-card ${plan.kind === 'justlend_jusdt' ? 'primary-plan' : ''}`} key={plan.id}>
          <div className="plan-card-top"><span className="plan-letter">{plan.kind === 'hold' ? '—' : plan.kind === 'psm_jusdd' ? 'B' : 'A'}</span><span className={`status-pill ${plan.eligibility.status === 'eligible' ? 'neutral' : 'caution'}`}>{statusLabel(plan)}</span></div>
          <p className="plan-route">{plan.chain.toUpperCase()} · {plan.scenario}</p><h3>{title[plan.kind]}</h3>
          <p className="plan-copy">{plan.kind === 'hold' ? t("지출과 예비액을 포함해 자산을 보유하는 비교 기준입니다.", "A comparison baseline that holds all assets, including expenses and reserves.")
            : plan.kind === 'psm_jusdd'
              ? t("USDT·GemJoin 승인 → PSM 진입 → USDD·jUSDD 승인 → 예치 → 인출 → USDD·PSM 승인 → PSM 출구 · USDT 기준", "Approve USDT/GemJoin → Enter PSM → Approve USDD/jUSDD → Deposit → Withdraw → Approve USDD/PSM → Exit PSM · In USDT")
              : t(`${plan.steps.join(' → ')} · ${plan.inputToken.symbol} 기준`, `${plan.steps.map(step => localizeKnownText(step, t, planMessages)).join(' → ')} · In ${plan.inputToken.symbol}`)}</p>
          <div className="plan-divider" />
          <div className="plan-metric"><small>{t("운용액", "Investment amount")}</small><strong>{amount(plan.allocation.invested, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{t("먼저 확보", "Protected first")}</small><strong>{amount(plan.allocation.protected, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{plan.kind === 'justlend_jtrx' ? t("기본 수익률 (가정)", "Base yield rate (assumed)") : t("기본 수익률", "Base yield rate")}</small><strong>{plan.kind === 'hold' ? t("적용 없음", "Not applicable")
            : plan.kind === 'justlend_jtrx' ? nileScenario ? `${new Decimal(nileScenario.aprPercent).toDecimalPlaces(6).toString()}% APR` : t("블록당 금리 조회 불가", "Per-block rate unavailable")
              : plan.quote?.baseRate ? `${new Decimal(plan.quote.baseRate.rate).times(100).toDecimalPlaces(4).toString()}% ${plan.quote.baseRate.kind.toUpperCase()}` : t("미확인", "Unverified")}</strong></div>
          <div className="plan-metric"><small>{t("추가 보상", "Additional rewards")}</small><strong>{plan.kind === 'hold' ? t("적용 없음", "Not applicable")
            : plan.kind === 'justlend_jtrx' && !plan.quote?.reward?.verified ? t("검증 자료 없음", "No verified evidence")
              : plan.quote?.reward?.verified ? `${new Decimal(plan.quote.reward.rate).times(100).toDecimalPlaces(4).toString()}% ${plan.quote.reward.kind.toUpperCase()}` : t("미확인", "Unverified")}</strong></div>
          <div className="plan-metric"><small>{plan.kind === 'justlend_jtrx' ? t("기간 이자 (비용 전 가정)", "Period interest (before costs, assumed)") : t("기간 기본 이자", "Period base interest")}</small><strong>{plan.kind === 'justlend_jtrx' && nileScenario
            ? `${new Decimal(nileScenario.grossInterest).gt(0) && new Decimal(nileScenario.grossInterest).lt('0.000001')
              ? '<0.000001 TRX' : amount(nileScenario.grossInterest, 'TRX')}` : amount(plan.baseYield, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{t("검증된 보상", "Verified rewards")}</small><strong>{plan.kind === 'justlend_jtrx' && plan.verifiedReward === null ? t("계산 제외", "Excluded from calculation") : amount(plan.verifiedReward, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{t("왕복 비용", "Round-trip cost")}</small><strong>{plan.kind === 'justlend_jtrx' && plan.roundTripCost === null ? t("미래 환매 비용 미산정", "Future redemption cost not estimated") : amount(plan.roundTripCost, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{t("예상 순익", "Estimated net yield")}</small><strong>{plan.kind === 'justlend_jtrx' && plan.netYield === null ? t("수수료 미확인 · 계산 보류", "Fees unverified · Calculation withheld") : amount(plan.netYield, plan.inputToken.symbol)}</strong></div>
          <div className="plan-metric"><small>{t("손익분기", "Break-even")}</small><strong>{plan.kind === 'justlend_jtrx' && plan.breakEvenDays === null ? t("계산 보류", "Calculation withheld") : plan.breakEvenDays === null ? t("미확인", "Unverified") : t(`${plan.breakEvenDays}일`, `${plan.breakEvenDays} days`)}</strong></div>
          {plan.kind === 'justlend_jtrx' && <div className="nile-scenario-note" role="note">
            <strong>{t("금리 참고 계산", "Reference rate calculation")}</strong>
            <p>{nileScenario ? t(`온체인 블록당 공급 금리 원시값 ${nileScenario.rawRate} ÷ 10¹⁸ × 연 10,512,000블록(3초 간격 가정)으로 APR을 계산했습니다. 기간 이자는 이 금리가 ${plan.earningDays ?? plan.days}일 동안 유지된다는 단리 가정입니다.`, `APR is calculated as the raw on-chain supply rate per block ${nileScenario.rawRate} ÷ 10¹⁸ × 10,512,000 blocks per year (assuming 3-second intervals). Period interest assumes this rate remains constant for ${plan.earningDays ?? plan.days} days, without compounding.`)
              : t("현재 블록당 공급 금리를 읽지 못해 기간 이자 시나리오도 계산하지 않았습니다.", "The current per-block supply rate could not be read, so period interest was not estimated.")}</p>
            <p>{t("실제 블록 누락·금리 변동·추가 보상·예치와 미래 환매 수수료는 반영하지 않았습니다. 위 숫자는 수익 권고나 거래 견적이 아닙니다.", "Missed blocks, rate changes, additional rewards, deposit fees, and future redemption fees are excluded. These figures are not an investment recommendation or transaction quote.")}</p>
            <p><a href="https://docs.justlend.org/developers/supply_and_borrow_market/sbm/" target="_blank" rel="noreferrer">{t("JustLend 금리 단위 ↗", "JustLend rate units ↗")}</a> · <a href="https://developers.tron.network/docs/block" target="_blank" rel="noreferrer">{t("TRON 3초 블록 설명 ↗", "TRON 3-second blocks ↗")}</a></p>
          </div>}
          {plan.kind === 'justlend_jtrx' && <NileFeeEvidence scenario={nileFeeScenarios.find(item => item.planId === plan.id) ?? null} />}
          {plan.eligibility.reasons.length > 0 && <div className="plan-warning">{plan.eligibility.reasons.map(reason =>
            plan.kind === 'justlend_jtrx' && reason === 'rate_unavailable'
              ? t("운용 수익률 미검증 (상단 APR은 가정)", "Investment yield unverified (APR above is assumed)") : reasonText[reason] || reason).join(' · ')}</div>}
          {recommended === plan.id && plan.kind !== 'hold' && <p className="plan-recommended">{t("단일 경로 비교 상위 후보", "Leading single-route candidate")}</p>}
          {plan.source && <p className="plan-provenance">{plan.source.mode === 'live'
            ? plan.source.accessMethod === 'rest' && !plan.source.sourceUpdatedAt ? t("REST 조회 · 원천 갱신 미확인", "REST retrieval · Source update unverified") : t("실시간", "Live")
            : plan.source.mode}{t(" · 조회 ", " · Retrieved ")}{new Date(plan.source.fetchedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' })} KST<br />{t("원천 갱신 ", "Source updated ")}{plan.source.sourceUpdatedAt ? new Date(plan.source.sourceUpdatedAt).toLocaleString(locale, { timeZone: 'Asia/Seoul' }) : t("제공되지 않음", "Not provided")}<br /><a href={plan.source.sourceUrl} target="_blank" rel="noreferrer">{t("출처 확인 ↗", "View source ↗")}</a></p>}
          {plan.kind !== 'hold' && onSelect && <button className="plan-select" type="button" disabled={needs.chain === 'nile' && plan.eligibility.status !== 'eligible' && !canPreviewNileDeposit(plan)} onClick={() => onSelect(plan)}>{needs.chain === 'mainnet' ? t("검토 기록에 보관", "Save to review records") : canPreviewNileDeposit(plan) && plan.eligibility.status !== 'eligible' ? t("Nile 기술 시험 미리보기", "Preview Nile technical test") : t("계획 선택", "Select plan")}</button>}
        </article>; })}
      </div>
      {needs.chain === 'nile' && previousRoundTrip && <section className="nile-round-trip-reference" aria-label={t("이전 Nile 왕복 실증", "Previous Nile round-trip test")}>
        <h3>{t("이 브라우저의 이전 Nile 왕복 실증", "Previous Nile round-trip test in this browser")}</h3>
        <p>{t("예치 ", "Deposit ")}{amount(previousRoundTrip.deposit.amount, 'TRX')}{t(" → 환매 실수령 ", " → Actual redemption received ")}{amount(previousRoundTrip.withdraw.amount, 'TRX')}</p>
        <p>{t("실제 예치 수수료 ", "Actual deposit fee ")}{amount(previousRoundTrip.deposit.actualFeeInInputAsset, 'TRX')}{t(" + 환매 수수료 ", " + Redemption fee ")}{amount(previousRoundTrip.withdraw.actualFeeInInputAsset, 'TRX')}{t(" = 왕복 ", " = Round trip ")}{amount(previousRoundTrip.totalFees, 'TRX')}</p>
        <p><strong>{t("당시 순현금흐름 ", "Net cash flow at that time ")}{amount(previousRoundTrip.netCashFlow, 'TRX')}</strong></p>
        <details><summary>{t("확정 거래 ID와 시각", "Confirmed transaction IDs and times")}</summary><p>{t("예치 ", "Deposit ")}{previousRoundTrip.deposit.solidifiedAt} · <code>{previousRoundTrip.deposit.txId}</code></p><p>{t("환매 ", "Redemption ")}{previousRoundTrip.withdraw.solidifiedAt} · <code>{previousRoundTrip.withdraw.txId}</code></p></details>
        <small>{t("이 브라우저에 저장된 확정 거래·포지션 기록의 과거 시험 결과입니다. 현재 80/20·50/50 후보의 미래 수수료나 예상 수익으로 재사용하지 않습니다.", "These are historical test results from confirmed transaction and position records stored in this browser. They are not reused as future fees or estimated yield for the current 80/20 or 50/50 candidates.")}</small>
      </section>}
      <p className="plan-footnote">{t("금리는 조회 시점 값이 운용 기간 동안 유지된다는 가정입니다. 비용·출금 가능량이 확인되지 않으면 순익과 실행 가능 여부를 확정하지 않습니다. ", "Rates are assumed to remain at their retrieved values throughout the investment period. Net yield and execution eligibility remain unconfirmed until costs and withdrawal capacity are verified. ")}{needs.chain === 'mainnet' ? t("선택한 Mainnet 계획은 이 앱에서 거래하지 않습니다.", "Selected Mainnet plans cannot be executed in this app.") : t("Nile 거래에는 별도의 최신 미리보기와 TronLink 확인이 필요합니다.", "Nile transactions require a separate fresh preview and TronLink confirmation.")}</p>
    </>}
    {diagnostics.length > 0 && <div className="source-diagnostics"><h3>{t("상품 데이터 확인", "Product data checks")}</h3>{diagnostics.map(item => <p key={item.name}><strong>{item.name}</strong> · {item.status}{item.reason ? ` · ${localizeKnownText(item.reason, t, planMessages)}` : ''}</p>)}</div>}
  </>;
}
