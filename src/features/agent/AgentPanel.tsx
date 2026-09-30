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
import { useI18n, type Translate } from '../../lib/i18n';
import './agent-panel.css';

function useAgentCopy() {
  const { t, language, locale } = useI18n();
  return { t, language, fieldLabels: getFieldLabels(t), planLabels: getPlanLabels(t),
    allocationReasonLabels: getAllocationReasonLabels(t), costActionLabels: getCostActionLabels(t),
    costBasisLabels: getCostBasisLabels(t), fieldExample: (field: string) => getFieldExample(field, t),
    sourceTime: (value: string | null) => formatSourceTime(value, locale, t),
    trxFromSun: (value: string | null) => formatTrxFromSun(value, t),
    questionText: (question: AgentIntakeQuestion) => agentQuestionText(question, language),
    serverText: (value: string) => translateAgentServerText(value, t) };
}

function agentQuestionText(question: AgentIntakeQuestion, language: 'ko' | 'en'): string {
  if (language === 'ko') return question.text;
  const prompts: Record<string, string> = {
    chain: 'Supported pairs are Mainnet USDT or Nile TRX. Enter Mainnet or Nile to match your asset.',
    asset: 'Supported pairs are Mainnet USDT or Nile TRX. Enter the asset you want to use.',
    statedHoldings: 'Enter your holdings as a number. Example: 1000',
    startDate: 'When will you start? Enter today or a date in YYYY-MM-DD format.',
    horizonDays: 'How many days will you invest? Enter a whole number from 1 to 3650.',
    expenseDeclaration: 'Are any expenses scheduled? Enter none or scheduled.',
    reserve: 'How much will you keep as an emergency reserve, excluding expenses? Enter 0 for none.',
    risk: 'Enter your risk preference: conservative, balanced or growth.',
    acceptsUsddRisk: 'Include USDD conversion and depegging risk in the comparison? Enter true or false.',
    acceptsDatedExpenseLiquidityRisk: 'Expense deposits may not be withdrawn before payment is due. Do you accept this risk? Enter true or false.',
    fundingCoverage: 'Scheduled expenses and the emergency reserve exceed your holdings. Correct your holdings, expenses or reserve before continuing.',
  };
  if (question.field.endsWith('.due')) return 'Enter this expense date in YYYY-MM-DD format.';
  if (question.field.endsWith('.amount')) return 'Enter this expense amount as a number. Example: 200';
  if (question.field.endsWith('.asset')) return 'Enter this expense asset. Example: USDT';
  if (/^expenses\[\d+\]$/.test(question.field)) return 'Enter the expense date, amount and asset. Example: 2026-10-07 200 USDT';
  return prompts[question.field] ?? 'Please check this value in the direct input field.';
}

function translateAgentServerText(value: string, t: Translate): string {
  const messages: Record<string, string> = {
    '보유액은 0보다 큰 십진수로 입력해 주세요.': 'Enter holdings as a decimal greater than zero.',
    '예비액은 0 이상의 십진수로 입력해 주세요.': 'Enter the reserve as a nonnegative decimal.',
    '시작일은 YYYY-MM-DD, 오늘 또는 7일 뒤 형식으로 입력해 주세요.': 'Enter the start date as YYYY-MM-DD or today.',
    '기간은 1~3650일 사이 정수로 입력해 주세요.': 'Enter a whole number of days from 1 to 3650.',
    '지출 없음 또는 지출 있음을 선택해 주세요.': 'Enter none or scheduled for expenses.',
    '위험 성향은 보수형, 균형형, 성장형 중에서 입력해 주세요.': 'Enter conservative, balanced or growth.',
    'USDD 동의 여부는 예 또는 아니요로 입력해 주세요.': 'Enter true or false for USDD risk consent.',
    '체인은 mainnet 또는 nile로 입력해 주세요.': 'Enter Mainnet or Nile as the chain.',
    '자산은 USDT, USDD, TRX 중에서 입력해 주세요.': 'Enter USDT, USDD or TRX as the asset.',
    '지출액 운용 위험 동의 여부는 예 또는 아니요로 입력해 주세요.': 'Enter true or false for expense investment risk consent.',
    '지출 항목 번호를 확인해 주세요.': 'Check the expense item number.',
    '지출은 날짜, 금액, 자산을 함께 입력해 주세요. 예: 7일 뒤 200 USDT': 'Enter the expense date, amount and asset together. Example: 2026-10-07 200 USDT',
    '날짜는 YYYY-MM-DD 또는 7일 뒤 형식으로 입력해 주세요.': 'Enter the date in YYYY-MM-DD format.',
    '지출액은 0보다 큰 자산 단위의 십진수로 입력해 주세요.': 'Enter the expense amount as a decimal greater than zero.',
    '유효한 TRON 지갑 주소가 필요합니다.': 'A valid TRON wallet address is required.',
    'TronLink 지갑을 연결하지 않았습니다.': 'No TronLink wallet is connected.',
    '지갑 실잔액 조회에 실패했습니다.': 'The wallet balance query failed.',
    '같은 체인·주소·자산의 최신 지갑 잔액을 확인하지 못했습니다.': 'The latest wallet balance for the same chain, address and asset is unverified.',
    '관측 잔액이 지출·예비액 보호 필요액에 미치지 못했습니다.': 'The observed balance does not cover protected expenses and reserves.',
    '평가 시간 제한으로 최신 지갑 잔액을 확정하지 못했습니다.': 'The assessment timed out before the latest wallet balance was verified.',
    '금액별 읽기에서는 수수료용 TRX를 별도로 표시하지 않습니다.': 'Amount-specific observations do not show fee TRX separately.',
    '금액별 읽기에서는 기존 jUSDT 포지션을 별도로 표시하지 않습니다.': 'Amount-specific observations do not show existing jUSDT positions separately.',
    '금액별 잔액은 Mainnet 최신 상수 조회이며 확정 블록에 결속되지 않았습니다.': 'Amount-specific balances use current Mainnet constant calls and are not tied to a confirmed block.',
    '계정·상수 호출 응답에 적용 블록 번호가 없어 관측값을 하나의 블록 또는 solidified 상태에 결속할 수 없습니다.': 'Account and constant-call responses provide no block number; observations cannot be tied to one block or solidified state.',
  };
  return t(value, messages[value] ?? value);
}

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

const getFieldLabels = (t: Translate): Record<string, string> => ({
  chain: t("Mainnet 또는 Nile", "Mainnet or Nile"), asset: t("보유 자산", "Asset held"), statedHoldings: t("보유 금액", "Holdings"),
  startDate: t("운용 시작일", "Start date"), horizonDays: t("운용 기간", "Investment period"), reserve: t("비상 예비액", "Emergency reserve"), risk: t("위험 성향", "Risk preference"),
  expenseDeclaration: t("예정 지출 유무", "Scheduled expenses"), 'expenses[0]': t("예정 지출", "Scheduled expense"),
  fundingCoverage: t("보유액·예정 지출·예비액 합계", "Holdings, scheduled expenses and reserve total"),
});
const getPlanLabels = (t: Translate): Record<string, string> => ({
  hold: t("보유", "Hold"), justlend_jusdt: 'JustLend jUSDT', psm_jusdd: 'PSM → JustLend jUSDD',
  justlend_jtrx: 'Nile JustLend jTRX',
});
const getAllocationReasonLabels = (t: Translate): Record<string, string> => ({
  positive_verified_net_yield: t("확인된 비용 차감 후 예상 수익이 양수입니다", "Expected yield is positive after verified costs"),
  non_positive_net_yield: t("예상 수익이 비용을 넘지 못합니다", "Expected yield does not exceed costs"),
  needs_unconfirmed: t("입력 확인이 필요합니다", "Input confirmation is required"),
  balance_unverified: t("지갑 잔액을 확인하지 못했습니다", "Wallet balance is unverified"),
  balance_insufficient: t("지갑 잔액이 부족합니다", "Wallet balance is insufficient"),
  fee_reserve_unverified: t("수수료 예비액을 확인하지 못했습니다", "Fee reserve is unverified"),
  due_today: t("오늘 필요한 자금입니다", "These funds are needed today"),
  quote_unavailable: t("상품 견적을 조회하지 못했습니다", "Product quote is unavailable"),
  quote_stale: t("견적 조회 시각이 오래되었습니다", "The quote is stale"),
  non_live_data: t("현재 실데이터가 아닙니다", "This is not current live data"),
  rate_unavailable: t("수익률을 확인하지 못했습니다", "Yield rate is unverified"),
  cost_unverified: t("왕복 비용을 확인하지 못했습니다", "Round-trip costs are unverified"),
  conversion_unverified: t("왕복 전환을 확인하지 못했습니다", "Round-trip conversion is unverified"),
  liquidity_unverified: t("출금 유동성을 확인하지 못했습니다", "Withdrawal liquidity is unverified"),
  withdrawal_delay: t("출금 지연으로 필요일을 맞출 수 없습니다", "Withdrawal delays would miss the required date"),
  entry_capacity_insufficient: t("진입 가용량이 부족하거나 미확인입니다", "Entry capacity is insufficient or unverified"),
  exit_capacity_insufficient: t("출구 가용량이 부족하거나 미확인입니다", "Exit capacity is insufficient or unverified"),
  aggregate_exit_or_conversion_capacity_insufficient: t("여러 날짜의 합산 출구·전환 가용량이 부족합니다", "Combined exit or conversion capacity across dates is insufficient"),
  amount_precision_unverified: t("금액 정밀도를 확인하지 못했습니다", "Amount precision is unverified"),
  start_date_not_today: t("운용 시작일이 오늘이 아니어서 출금 일정 재평가가 필요합니다", "The start date is not today; the withdrawal schedule needs reassessment"),
  fee_reserve_insufficient: t("수수료 예비액이 부족합니다", "Fee reserve is insufficient"),
  market_unknown: t("시장 활성 상태를 확인하지 못했습니다", "Market activity is unverified"),
  market_inactive: t("시장이 비활성 상태입니다", "The market is inactive"),
  token_unverified: t("계약과 토큰을 확인하지 못했습니다", "Contracts and tokens are unverified"),
  usdd_risk_declined: t("USDD 위험에 동의하지 않았습니다", "USDD risk was not accepted"),
  risk_preference: t("위험 성향에 맞지 않습니다", "This does not match your risk preference"),
  liquidity_insufficient: t("인출 가능한 시장 유동성이 부족합니다", "Available market withdrawal liquidity is insufficient"),
  chain_mismatch: t("체인이 일치하지 않습니다", "Chain mismatch"),
  asset_mismatch: t("자산이 일치하지 않습니다", "Asset mismatch"),
  zero_investable: t("운용 가능한 금액이 없습니다", "No funds are available to invest"),
  market_unverified: t("jUSDT 시장의 현재 상태를 확인하지 못했습니다", "The current jUSDT market state is unverified"),
  wallet_unverified: t("같은 지갑의 잔액·포지션 관측이 부족합니다", "Balance and position observations for the same wallet are insufficient"),
  price_unverified: t("TRX와 USDT의 최신 가격 근거가 부족합니다", "Current TRX and USDT price evidence is insufficient"),
  action_cost_unknown: t("승인·예치 행동의 비용 근거가 부족합니다", "Approval and deposit cost evidence is insufficient"),
  future_exit_unknown: t("회수 행동의 비용 또는 가능성을 확인하지 못했습니다", "Withdrawal cost or feasibility is unverified"),
  fee_trx_insufficient: t("수수료 예비용 TRX가 부족합니다", "TRX for the fee reserve is insufficient"),
  liquidity_risk_not_accepted: t("지출액 운용의 회수 지연 위험에 동의하지 않았으므로 보유합니다", "Hold: the risk of delayed expense withdrawals was not accepted"),
  exit_buffer_insufficient: t("지급일 전 회수 완충 기간이 부족합니다", "The withdrawal buffer before payment is insufficient"),
  aggregate_cash_insufficient: t("현재 시장 현금이 선택한 구간의 합산 회수 목표에 부족합니다", "Current market cash cannot cover the combined withdrawal targets"),
  non_positive_stress_net: t("스트레스 비용을 적용한 예상 순익이 양수가 아닙니다", "Expected net yield is not positive under stress costs"),
  quote_budget_exceeded: t("이번 평가의 금액별 조회 한도에 도달해 보유합니다", "Hold: this assessment reached its amount-specific quote limit"),
  quote_expired: t("금액별 견적이 만료되어 다시 평가해야 합니다", "The amount-specific quote expired; reassess"),
  selected_buckets_only: t("검증된 선택 구간만 조건부 후보입니다", "Only verified selected periods are conditional candidates"),
  other_buckets_unverified: t("다른 날짜의 금액은 근거 부족으로 보유합니다", "Other dated amounts remain held due to insufficient evidence"),
  no_positive_bundle: t("양의 스트레스 순익을 가진 묶음이 없습니다", "No bundle has positive net yield under stress costs"),
});
function getFieldExample(field: string, t: Translate): string {
  if (/^expenses\[\d+\]$/.test(field)) return t("7일 뒤 200 USDT", "2026-10-07 200 USDT");
  if (field.endsWith('.due')) return t("7일 뒤 또는 2026-10-07", "2026-10-07");
  if (field.endsWith('.amount')) return '200';
  if (field.endsWith('.asset')) return 'USDT';
  return ({ chain: t("메인넷 또는 Nile", "Mainnet or Nile"), asset: t("USDT 또는 TRX", "USDT or TRX"), statedHoldings: '1000',
    startDate: t("오늘 또는 2026-10-01", "today or 2026-10-01"), horizonDays: '30',
    expenseDeclaration: t("지출 없음 또는 지출 있음", "none or scheduled"), reserve: '0', risk: t("보수형", "conservative"),
    acceptsUsddRisk: t("예 또는 아니요", "true or false"), acceptsDatedExpenseLiquidityRisk: t("예 또는 아니요", "true or false") } as Record<string, string>)[field] ?? t("값을 입력해 주세요", "Enter a value");
}
function formatSourceTime(value: string | null, locale: string, t: Translate): string {
  return value ? new Date(value).toLocaleString(locale, { timeZone: 'Asia/Seoul' }) : t("미제공", "Not provided");
}
function formatTrxFromSun(value: string | null, t: Translate): string {
  return value === null ? t("미확인", "Unverified") : `${new Decimal(value).div(1_000_000).toString()} TRX`;
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
  const { t, sourceTime, trxFromSun } = useAgentCopy();
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
  const basis = scenario?.basis === 'representative_simulation' ? t("기준 계정의 현재 모의 실행", "Current simulation using a reference account")
    : scenario?.basis === 'historical_reference' ? t("과거 확정 거래 표본", "Historical confirmed transaction samples") : t("환매 근거 미확인", "Redemption evidence unverified");
  const status = complete ? t("금액별 참고 시나리오", "Amount-specific reference scenario") : entry || exit ? t("일부 비용만 확인", "Only some costs verified") : t("미산정", "Not estimated");
  return <div className="agent-readonly-evidence" role="note" aria-label={t("Nile 미래 환매 수수료 참고", "Nile future redemption fee reference")}>
    <strong>{t("Nile 미래 환매 수수료 · ", "Nile future redemption fees · ")}{status}</strong>
    <p>{basis}{scenario && validSun(scenario.amountSun) && t(` · 후보액 ${trxFromSun(scenario.amountSun)}`, ` · Candidate ${trxFromSun(scenario.amountSun)}`)}</p>
    {entry && <p>{t("현재 예치 비용 참고: ", "Current deposit cost reference: ")}{trxFromSun(scenario!.depositFeeSun)}</p>}
    {exit && <p>{t("미래 환매 비용 참고: ", "Future redemption cost reference: ")}{trxFromSun(scenario!.estimatedRedeemFeeSun)}
      {validSun(scenario!.stressRedeemFeeSun) && <>{t(" · 스트레스 가정 ", " · Stress assumption ")}{trxFromSun(scenario!.stressRedeemFeeSun)}</>}</p>}
    {complete && <p>{t("왕복 비용 참고: ", "Round-trip cost reference: ")}{trxFromSun(scenario!.estimatedRoundTripFeeSun)}
      {' · '}{t("스트레스 왕복 비용 ", "Stress round-trip cost ")}{trxFromSun(scenario!.stressRoundTripFeeSun)}
      {' · '}{t("비용 예비액 참고 ", "Fee reserve reference ")}{trxFromSun(scenario!.feeReserveSun)}</p>}
    {complete && scenario!.economicSizingStatus === 'ready' && validSun(scenario!.economicDepositSun)
      && validSun(scenario!.economicFeeReserveSun)
      && <p>{t("비용 예비액 반영 후 재계산한 운용 가능액 참고: ", "Recalculated investable amount after the fee reserve: ")}{trxFromSun(scenario!.economicDepositSun)}
        {' · '}{t("해당 금액의 비용 예비액 참고 ", "Fee reserve for that amount ")}{trxFromSun(scenario!.economicFeeReserveSun)}</p>}
    {complete && scenario!.reserveStatus === 'insufficient'
      && scenario!.economicSizingStatus !== 'ready'
      && <p className="agent-limited">{t("비용 예비액을 남기면 이 후보 운용액을 감당하지 못합니다. 경제성 기준 신규 예치는 보류합니다.", "This candidate amount cannot be funded while retaining the fee reserve. New deposits are deferred on economic grounds.")}</p>}
    {complete && scenario!.reserveStatus === 'insufficient'
      && scenario!.economicSizingStatus === 'ready'
      && <p className="agent-limited">{t("원래 후보 운용액은 비용 예비액을 남길 수 없어 축소 금액만 참고로 계산했습니다. 승인 적격성은 여전히 미확인입니다.", "The original candidate cannot retain the fee reserve, so only a reduced amount was calculated for reference. Approval eligibility remains unverified.")}</p>}
    {!complete && <p className="agent-limited">{t("미산정 이유: ", "Reason not estimated: ")}{!fresh && scenario?.status !== 'unknown'
      ? t("출처·조회 시각을 확인할 수 없거나 참고 근거가 만료됐습니다.", "The source or fetch time is unverified, or the reference evidence has expired.")
      : scenario?.reason || t("현재 금액의 예치 또는 환매 근거를 확보하지 못했습니다.", "Deposit or redemption evidence for the current amount is unavailable.")}</p>}
    {scenario && (scenario.assumptions.length > 0 || scenario.referenceAccountAddress || scenario.referenceTxIds.length > 0)
      && <details><summary>{t("근거와 가정", "Evidence and assumptions")}</summary>
        {scenario.referenceAccountAddress && <p>{t("기준 계정: ", "Reference account: ")}{scenario.referenceAccountAddress}</p>}
        {scenario.referenceTxIds.length > 0 && <p>{t("확정 거래 표본 ", "Confirmed transaction samples: ")}{scenario.referenceTxIds.length}{t("건", " samples")}</p>}
        <ul>{scenario.assumptions.map((item, index) => <li key={`${index}-${item}`}>{item}</li>)}</ul>
      </details>}
    {scenario?.fetchedAt && <small>{t("조회 ", "Fetched ")}{sourceTime(scenario.fetchedAt)}{t(" · 유효 ", " · Valid until ")}{sourceTime(scenario.validUntil)}{t(" (한국 시간)", " (Korea time)")}{link && <> · <a href={link} target="_blank" rel="noreferrer">{t("조회 출처 ↗", "Query source ↗")}</a></>}</small>}
    <small>{t("참고 비용은 미래 확정 수수료나 상한이 아니며, 기존 계획의 검증된 순익·추천·승인 적격성에 반영되지 않습니다.", "Reference costs are not confirmed future fees or fee caps. They do not affect verified net yield, recommendations or approval eligibility in existing plans.")}</small>
  </div>;
}
const getCostActionLabels = (t: Translate) => ({
  approve_zero: t("승인 초기화", "Reset approval"), approve: t("USDT 승인", "Approve USDT"), mint: t("jUSDT 예치", "Deposit jUSDT"), redeem_underlying: t("jUSDT 회수", "Withdraw jUSDT"),
});
const getCostBasisLabels = (t: Translate) => ({ account_simulation: t("현재 계정 성공 모의", "Successful current-account simulation"), reference_model: t("과거 확정 거래 기준 시나리오", "Scenario based on historical confirmed transactions"), unknown: t("근거 미확인", "Evidence unverified") });
function resumeQuestion(request: AgentRequestState, t: Translate): AgentIntakeQuestion | null {
  const fieldLabels = getFieldLabels(t);
  const field = request.questionState.field;
  if (!field || request.confirmedVersion === request.version) return null;
  return { id: request.questionState.id ?? `q:${request.version}:${field}`, field,
    text: t(`${fieldLabels[field] ?? field} 값을 직접 입력하거나 문장으로 알려주세요.`, `Enter ${fieldLabels[field] ?? field} directly or describe it in a sentence.`), mode: 'form', ask: false };
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
  const { t, sourceTime, costBasisLabels, allocationReasonLabels } = useAgentCopy();
  const link = marketSource && sourceLink(marketSource.sourceUrl);
  const approval = evidence.approvalActions === 'none' ? t("추가 승인 없음", "No additional approval")
    : evidence.approvalActions === 'approve' ? t("승인 1회가 필요한 분기", "One approval required")
      : evidence.approvalActions === 'reset_then_approve' ? t("승인 초기화 후 재승인이 필요한 분기", "Approval reset followed by reapproval required")
        : t("승인 분기 미확인", "Approval path unverified");
  return <div className="agent-readonly-evidence" aria-label={t("jUSDT 금액별 부분 조회 결과", "Partial jUSDT observations by amount")}>
    <h5>{t("jUSDT 금액별 부분 조회 결과 · 읽기 전용", "Partial jUSDT observations by amount · Read only")}</h5>
    <p className="agent-limited">{t("아래 금액은 검토 대상 구간입니다. 미래 환매와 왕복 비용이 확인되기 전에는 모두 보유·자료 부족 상태이며, 투자 추천이나 거래 권한이 아닙니다.", "The amounts below are under review. All remain on hold with insufficient evidence until future redemption and round-trip costs are verified. They are not investment recommendations or transaction authorization.")}</p>
    <p>{t("후보 전체의 공동 승인 분기: ", "Shared approval path for all candidates: ")}{approval}{t(". 실제 승인 요청은 하지 않았습니다.", ". No approval request was submitted.")}</p>
    <p>{t("시장 근거: Mainnet 현재 조회 · ", "Market evidence: current Mainnet query · ")}{marketSource ? sourceTime(marketSource.fetchedAt) : t("시각 미확인", "Time unverified")}{t(" (한국 시간)", " (Korea time)")}{link && <> · <a href={link} target="_blank" rel="noreferrer">{t("시장 조회 출처 ↗", "Market source ↗")}</a></>}</p>
    <p>{t("계정·시장 관측 구간: ", "Account and market observation window: ")}{sourceTime(evidence.observationWindow.startedAt)}–{sourceTime(evidence.observationWindow.endedAt)}{t(" (한국 시간)", " (Korea time)")}{' · '}{t("블록 ", "Blocks ")}{evidence.observationWindow.firstBlock}–{evidence.observationWindow.lastBlock}
      {' · '}{t("근거 만료 ", "Evidence expires ")}{sourceTime(evidence.validUntil)}{t(" (한국 시간)", " (Korea time)")}</p>
    <p className="agent-evidence-version">{t("시장 버전 ", "Market version ")}{evidence.marketQuoteVersion.slice(0, 12)}{t(" · 계정 맥락 ", " · Account context ")}{evidence.contextVersion.slice(0, 12)}{t(" · 입력 확인 버전 ", " · Confirmed input version ")}{evidence.needsVersion}</p>
    <div className="agent-readonly-legs">{evidence.legs.map(leg => <article key={leg.bucketKey}>
      <strong>{leg.bucketKey.startsWith('expense:') ? t("예정 지출", "Scheduled expense") : t("운용 종료", "End of period")} · {usdtFromRaw(leg.amountUsdtRaw)} USDT</strong>
      <small>{t("필요일 ", "Required date ")}{leg.dueDate}{t(" · 회수 목표일 ", " · Target withdrawal date ")}{leg.plannedExitDate}{t(" · 구간 견적 ", " · Period quote ")}{leg.quoteVersion.slice(0, 12)}</small>
      <p>{t("예치 행동 근거: ", "Deposit action evidence: ")}{costBasisLabels[leg.mintCost.basis]}
        {' · '}Energy {leg.mintCost.energyUnits ?? t("미확인", "Unverified")} · Bandwidth {leg.mintCost.bandwidthBytes ?? t("미확인", "Unverified")} bytes</p>
      {leg.mintCost.sources.length === 0 ? <small>{t("예치 행동의 원천 조회 정보: 미확인", "Deposit source observation: unverified")}</small>
        : leg.mintCost.sources.slice(0, 3).map((source, index) => <small key={`${source.sourceUrl}-${source.fetchedAt}-${index}`}>{t("예치 근거 ", "Deposit evidence ")}{index + 1}: {source.accessMethod?.toUpperCase() ?? t("접근 방식 미확인", "Access method unverified")}{t(" · 조회 ", " · Fetched ")}{sourceTime(source.fetchedAt)}{t(" (한국 시간)", " (Korea time)")}{source.sourceUpdatedAt && <>{t(" · 원천 갱신 ", " · Source updated ")}{sourceTime(source.sourceUpdatedAt)}</>}
          {sourceLink(source.sourceUrl) && <> · <a href={sourceLink(source.sourceUrl)!} target="_blank" rel="noreferrer">{t("공개 출처 ↗", "Public source ↗")}</a></>}
        </small>)}
      {leg.mintCost.sources.length > 3 && <small>{t("추가 예치 근거 ", "Additional deposit evidence: ")}{leg.mintCost.sources.length - 3}{t("건", " samples")}</small>}
      <p>{t("미래 환매 모델: ", "Future redemption model: ")}{leg.redeemModelVersion === null ? t("미확인 · 왕복 비용 계산 불가", "Unverified · Round-trip costs unavailable")
        : t(`과거 거래 기준 시나리오 ${leg.redeemModelVersion.slice(0, 12)} · 미래 비용·회수 보장 아님`, `Historical transaction scenario ${leg.redeemModelVersion.slice(0, 12)} · Future costs and withdrawals are not guaranteed`)}</p>
      {leg.holdReasons.length > 0 && <small>{t("보유·자료 부족 사유: ", "Hold / insufficient evidence reasons: ")}{leg.holdReasons.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ')}</small>}
    </article>)}</div>
    <small>{t("현재 계정 모의와 시장 조회는 서명·방송·체결 결과가 아닙니다. 실제 거래는 실행하지 않았습니다.", "Current-account simulations and market observations are not signatures, broadcasts or execution results. No transaction was executed.")}</small>
  </div>;
}

export function AgentPanel({ wallet, onSelectPlan, onSelectDatedAllocation, onRequestChange }: {
  wallet: ReturnType<typeof getWalletState>;
  onSelectPlan?: (plan: Plan, request: AgentRequestState, assessment: Assessment) => void;
  onSelectDatedAllocation?: (allocation: DatedAllocation, request: AgentRequestState, assessment: Assessment) => void;
  onRequestChange?: (request: AgentRequestState) => void;
}) {
  const { t, language, sourceTime, trxFromSun, fieldExample, fieldLabels, planLabels, allocationReasonLabels, costActionLabels, costBasisLabels, questionText, serverText } = useAgentCopy();
  const [loaded] = useState(loadRequest);
  const [request, setRequest] = useState(loaded.request);
  const [invalid, setInvalid] = useState(loaded.invalid);
  const [validation, setValidation] = useState<RequestValidation>(() => validateAgentRequest(loaded.request));
  const [nextQuestion, setNextQuestion] = useState<AgentIntakeQuestion | null>(() => resumeQuestion(loaded.request, t));
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
    catch { setError(t("요청 JSON을 브라우저에 저장하지 못했습니다. JSON을 내보내 보관해 주세요.", "Could not save the request JSON in this browser. Export the JSON to keep a copy.")); }
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
    if (!response.ok) throw new Error(t("에이전트 세션을 시작하지 못했습니다.", "Could not start the agent session."));
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
    if (!response.ok) throw new Error(raw.error ?? t(`요청에 실패했습니다. (${response.status})`, `Request failed. (${response.status})`));
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
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("시장 조사에 실패했습니다.", "Market research failed."));
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
        { role: 'assistant', text: (result.nextQuestion ? questionText(result.nextQuestion) : null) ?? (result.validation.status === 'research_only'
          ? t("질문에 맞는 공식 자료를 조회하겠습니다.", "I will query official sources for your question.") : result.validation.status === 'ready_for_confirmation'
            ? t("명시한 정보를 확인해 주세요.", "Please confirm the information you provided.") : result.progress === 'unrecognized'
              ? t("답변을 해석하지 못했습니다. 아래 입력 예시를 확인해 주세요.", "Your answer could not be interpreted. Check the input examples below.") : t("입력 내용을 갱신했습니다.", "Your input has been updated.")) }]);
      if (parsed.marketQuestions.length > request.marketQuestions.length) {
        await researchQuestions(parsed.marketQuestions.slice(request.marketQuestions.length), signal);
      }
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("문장 분석에 실패했습니다.", "Message analysis failed."));
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
        { role: 'assistant', text: (result.nextQuestion ? questionText(result.nextQuestion) : null) ?? t("입력 값을 확인했습니다. JSON을 검토해 주세요.", "Your input has been checked. Please review the JSON.") }]);
    } catch (cause) {
      if (!signal.aborted) setFieldError(cause instanceof Error ? cause.message : t("직접 입력을 확인하지 못했습니다.", "Could not validate the direct input."));
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
        ? t("지출액 운용 시 회수 지연 위험을 이해하고 동의합니다.", "I understand and accept the risk of delayed withdrawals when investing expense funds.") : t("지출 예정액은 보유하겠습니다.", "I will hold the scheduled expense funds.") },
      { role: 'assistant', text: t("위험 선택을 기록했습니다. 계획 조건 요약을 다시 확인해 주세요.", "Your risk choice has been recorded. Review the plan conditions again.") }]);
      setFieldError('');
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("위험 선택을 저장하지 못했습니다.", "Could not save your risk choice."));
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
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("계획 평가에 실패했습니다.", "Plan assessment failed."));
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
    catch (cause) { if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("계획 평가에 실패했습니다.", "Plan assessment failed.")); }
    finally { if (!signal.aborted) setBusy(false); }
  };
  const refreshResearch = async () => {
    if (busy || request.marketQuestions.length === 0) return;
    const signal = begin();
    try {
      setResearch(await post<MarketResearchReport>('/api/agent/research',
        { questions: request.marketQuestions.slice(-5) }, signal));
    } catch (cause) {
      if (!signal.aborted) setError(cause instanceof Error ? cause.message : t("시장 조사에 실패했습니다.", "Market research failed."));
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
      if (!signal.aborted) setPortfolioError(cause instanceof Error ? cause.message : t("지갑 잔액 조회에 실패했습니다.", "Wallet balance query failed."));
    } finally { if (!signal.aborted) setBusy(false); }
  };
  const reset = () => {
    controller.current?.abort(); setBusy(false);
    if (invalid !== null) {
      try { localStorage.setItem(`${storageKey}:unreadable:${Date.now()}`, invalid); }
      catch { setError(t("읽을 수 없는 원본을 백업하지 못했습니다. 먼저 JSON으로 내보내 주세요.", "Could not back up the unreadable original. Export it as JSON first.")); return; }
    }
    setInvalid(null); setRequest(emptyAgentRequest()); setValidation(validateAgentRequest(emptyAgentRequest()));
    setNextQuestion(null); setTranscript([]); setResearch(null); setAssessment(null);
    setStoredPlanId(null); setStoredAllocationId(null);
    setPortfolio(null); setPortfolioError('');
    setMessage(''); setFieldValue(''); setFieldError(''); setError(''); setExtraction(null);
  };
  const storePlan = (plan: Plan) => {
    if (!onSelectPlan || !assessment || !canStoreAssessedPlan(request, assessment, plan, wallet)) {
      setError(t("입력 버전, 지갑, 계획 상태가 달라졌습니다. 시세와 계획을 다시 평가해 주세요.", "The input version, wallet or plan status changed. Reassess prices and plans."));
      return;
    }
    try {
      onSelectPlan(plan, request, assessment);
      setStoredPlanId(plan.id); setStoredAllocationId(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("계획을 보관하지 못했습니다.", "Could not save the plan."));
    }
  };
  const storeAllocation = (allocation: DatedAllocation) => {
    if (!onSelectDatedAllocation || !assessment || !canStoreDatedAllocation(request, assessment, allocation, wallet)) {
      setError(t("입력 버전, 지갑, 날짜별 배분안이 달라졌습니다. 시세와 계획을 다시 평가해 주세요.", "The input version, wallet or dated allocation changed. Reassess prices and plans."));
      return;
    }
    try {
      onSelectDatedAllocation(allocation, request, assessment);
      setStoredAllocationId(allocation.id); setStoredPlanId(null);
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t("날짜별 배분안을 보관하지 못했습니다.", "Could not save the dated allocation."));
    }
  };
  const datedAllocation = (assessment as Assessment & { datedAllocation?: DatedAllocation } | null)?.datedAllocation;
  const readOnlyEvidence = visibleJusdtReadOnlyEvidence(request, assessment, wallet,
    Math.max(evidenceClock, Date.now()));
  const jusdtMarketSource = assessment?.plans.find(plan => plan.kind === 'justlend_jusdt')?.source ?? null;

  return <section className="surface agent-panel" aria-label={t("명시 정보 기반 자산 계획 에이전트", "Asset planning agent based on explicit information")}>
    <div className="panel-head"><div><span className="panel-step">AI</span><h3>{t("명시 정보로 계획·시장 조사", "Plan and research from your stated facts")}</h3></div>
      <button className="text-button" type="button" onClick={reset}>{t("새 요청 ↺", "New request ↺")}</button></div>
    <p className="conversation-disclosure">{t("말씀하신 사실만 JSON에 저장합니다. 시장 조사와 계획 평가는 읽기 전용이며 거래를 실행하지 않습니다. 아래 가상 시연 입력과는 별개입니다.", "Only facts you state are saved in JSON. Market research and plan assessment are read only and do not execute trades. These are separate from the hypothetical demo inputs below.")}</p>
    {language === 'en' && <p className="conversation-disclosure">Some source-provided research responses and diagnostic details may remain in Korean. Your original input and JSON evidence are preserved.</p>}
    {extraction && <p className="agent-extraction-mode">{t("문장 해석: ", "Message analysis: ")}{extraction.provider === 'nim'
      ? t("NVIDIA NIM 보조 · 규칙 검증 완료", "NVIDIA NIM assisted · Rules validated") : extraction.reason === 'not_configured'
        ? t("규칙 기반 · NIM 미설정", "Rule based · NIM not configured") : t("규칙 기반 · NIM 연결 실패", "Rule based · NIM connection failed")}</p>}
    {invalid !== null && <div className="input-error" role="alert"><strong>{t("저장된 요청 JSON을 읽지 못했습니다.", "Could not read the saved request JSON.")}</strong>
      <p>{t("원본을 보존했습니다. 먼저 내보내거나 새 요청을 시작해 주세요.", "The original has been preserved. Export it or start a new request.")}</p>
      <button type="button" onClick={() => saveOriginal('gwdc-unreadable-agent-request.json', invalid)}>{t("원본 JSON 내보내기", "Export original JSON")}</button></div>}
    <div className="agent-transcript" aria-live="polite">
      {transcript.length ? transcript.map((turn, index) => <p key={index} className={`conversation-turn ${turn.role}`}>
        <small>{turn.role === 'user' ? t("사용자님", "You") : t("조건 확인", "Confirm conditions")}</small>{turn.text}</p>)
        : <p className="conversation-empty">{t("“1,000 USDT를 30일 운용해요. 7일 뒤 200 USDT를 지출해요.” 또는 “JustLend 금리는?”처럼 말씀해 주세요.", "Start with your amount and asset, such as “1,000 USDT”, or ask “JustLend APR?”. Free-text parsing currently supports Korean primarily; use the direct fields below to confirm your values.")}</p>}
    </div>
    <form className="conversation-form" onSubmit={event => void submit(event)}>
      <label htmlFor="agent-message">{t("계획 조건이나 시장 질문", "Plan conditions or market questions")}</label>
      <div><input id="agent-message" value={message} onChange={event => setMessage(event.target.value)}
        maxLength={2000} placeholder={t("조건 또는 질문을 입력해 주세요", "Enter conditions or a question")} disabled={busy || invalid !== null} />
        <button type="submit" disabled={busy || invalid !== null || !message.trim()}>{busy ? t("확인 중…", "Checking…") : t("입력 분석", "Analyze input")}</button></div>
    </form>
    {nextQuestion && <div className="agent-next-question" role="status"><strong>{t("다음 확인", "Next confirmation")}</strong><p>{questionText(nextQuestion)}</p>
      {nextQuestion.field !== 'fundingCoverage' && <form className="agent-field-form" onSubmit={event => void submitField(event)}>
        <label htmlFor="agent-field-value">{fieldLabels[nextQuestion.field] ?? nextQuestion.field}{t(" 직접 입력", " Direct input")}</label>
        <div><input id="agent-field-value" value={fieldValue} onChange={event => setFieldValue(event.target.value)}
          maxLength={120} placeholder={fieldExample(nextQuestion.field)} disabled={busy || invalid !== null} />
          <button type="submit" disabled={busy || invalid !== null || !fieldValue.trim()}>{t("값 확인", "Check value")}</button></div>
      </form>}
      {fieldError && <p className="input-error" role="alert">{serverText(fieldError)}</p>}</div>}
    {error && <p className="input-error" role="alert">{serverText(error)}</p>}
    {request.intent !== 'unknown' && <div className="agent-request-output">
      <div className="agent-output-heading"><strong>{t("사용자님이 명시한 정보 · 버전 ", "Facts you stated · Version ")}{request.version}</strong>
        <button type="button" onClick={() => saveJson('gwdc-declared-request.json', request)}>{t("JSON 내보내기", "Export JSON")}</button></div>
      <pre aria-label={t("명시 정보 JSON", "Explicit facts JSON")}>{JSON.stringify({ schemaVersion: request.schemaVersion, intent: request.intent,
        explicitFacts: request.explicitFacts, marketQuestions: request.marketQuestions,
        missingFields: validation.missingFields, invalidFields: validation.invalidFields,
        conflicts: validation.conflicts }, null, 2)}</pre>
      {validation.missingFields.length > 0 && <p>{t("추가 확인: ", "Additional information: ")}{validation.missingFields.map(field => fieldLabels[field] ?? field).join(', ')}</p>}
      {validation.invalidFields.length > 0 && <p>{t("형식·의미 확인: ", "Check format and meaning: ")}{validation.invalidFields.map(field => fieldLabels[field] ?? field).join(', ')}</p>}
      {request.explicitFacts.expenseDeclaration === 'scheduled' && request.explicitFacts.expenses.length > 0
        && request.explicitFacts.chain === 'mainnet' && <div className="agent-dated-risk">
          <strong>{t("예정 지출액의 운용 위험", "Risk of investing scheduled expense funds")}</strong>
          <p>{t("지출 예정액을 jUSDT에 예치하면 지갑의 유동 USDT가 아닙니다. 지급일 전에 환매가 지연되거나 비용이 늘 수 있습니다. 동의하지 않거나 답하지 않으면 지출액은 보유하고 나머지 금액만 평가합니다.", "Funds deposited into jUSDT are no longer liquid USDT in your wallet. Redemption may be delayed or costs may increase before payment is due. If you decline or leave this unanswered, expense funds remain held and only the rest is assessed.")}</p>
          <p>{t("현재 선택: ", "Current choice: ")}{request.explicitFacts.acceptsDatedExpenseLiquidityRisk === true ? t("위험을 이해하고 후보에 포함", "Accept risk and include as a candidate")
            : request.explicitFacts.acceptsDatedExpenseLiquidityRisk === false ? t("지출액 보유", "Hold expense funds") : t("미선택 · 지출액 보유", "No choice · Hold expense funds")}</p>
          <button type="button" disabled={busy || invalid !== null} onClick={() => void setDatedExpenseRisk(true)}>{t("위험을 이해하고 지출액 운용 후보에 포함", "Accept risk and consider investing expense funds")}</button>{' '}
          <button type="button" disabled={busy || invalid !== null} onClick={() => void setDatedExpenseRisk(false)}>{t("지출액 보유", "Hold expense funds")}</button>
        </div>}
      {validation.status === 'ready_for_confirmation' && <button className="agent-primary" type="button" onClick={() => void confirm()} disabled={busy}>{t("JSON 확인하고 평가", "Confirm JSON and assess")}</button>}
      {validation.status === 'confirmed' && <button className="agent-primary" type="button" onClick={() => void refreshAssessment()} disabled={busy}>{t("시세·계획 다시 평가", "Reassess prices and plans")}</button>}
      {request.marketQuestions.length > 0 && <button className="agent-secondary" type="button" onClick={() => void refreshResearch()} disabled={busy}>{t("최근 시장 질문 다시 조회", "Refresh recent market questions")}</button>}
    </div>}
    {research && <div className="agent-research-output"><h4>{t("질문별 시장 조사", "Market research by question")}</h4>
      {research.results.map((result, index) => <article key={`${result.question}-${index}`}>
        <strong>{result.question} · {result.topic}</strong><p>{result.conclusion}</p>
        <ul>{result.claims.map((claim, claimIndex) => <li key={claimIndex}>{claim.label}: {claim.value ?? t("확인 불가", "Unavailable")} {claim.unit ?? ''}
          {claim.source?.sourceUrl && <a href={claim.source.sourceUrl} target="_blank" rel="noreferrer">{t("출처 ↗", "Source ↗")}</a>}
          <small>{t("표시 전용 · ", "Display only · ")}{claim.availability} · {claim.source?.chain ?? t("체인 미확인", "Chain unverified")} · {claim.source?.mode ?? t("자료 모드 미확인", "Data mode unverified")}</small>
          {claim.source && <small>{claim.source.fetchedAt
            ? t("조회: ", "Fetched: ") + sourceTime(claim.source.fetchedAt)
            : t("성공한 조회 없음", "No successful query")}
            {claim.source.attemptedAt && t(" · 시도: ", " · Attempted: ") + sourceTime(claim.source.attemptedAt)}
            {t(" · 원천 갱신: ", " · Source updated: ") + sourceTime(claim.source.sourceUpdatedAt) + t(" (한국 시간)", " (Korea time)")}</small>}
          {claim.note && <small>{claim.note}</small>}</li>)}</ul>
        {result.unavailable.length > 0 && <p className="agent-limited">{t("현재 확인 불가: ", "Currently unavailable: ")}{result.unavailable.join('; ')}</p>}
        <small>{result.planningImpact}</small>
      </article>)}
    </div>}
    <div className="agent-portfolio-output">
      <div className="agent-output-heading"><strong>{t("TronLink 실잔액·JustLend 포지션 관측", "TronLink balances and JustLend position observations")}</strong>
        {wallet.address && (wallet.networkKey === 'mainnet' || wallet.networkKey === 'nile') &&
          <button type="button" onClick={() => void refreshPortfolio()} disabled={busy}>{busy ? t("조회 중…", "Querying…") : t("읽기 전용 조회", "Read-only query")}</button>}</div>
      {wallet.address && (wallet.networkKey === 'mainnet' || wallet.networkKey === 'nile')
        ? <p>{wallet.networkKey === 'nile' ? t('Nile 테스트넷', 'Nile testnet') : 'Mainnet'} · {wallet.address}</p>
        : <p>{t("확인된 TronLink 주소와 Mainnet 또는 Nile 네트워크가 필요합니다. ", "A verified TronLink address and Mainnet or Nile network are required. ")}<a href="/connections">{t("연결 상태에서 주소 연결 ↗", "Connect address in Connections ↗")}</a></p>}
      {portfolioError && <p className="input-error" role="alert">{serverText(portfolioError)}</p>}
      {portfolio && <div className="agent-portfolio-values">
        <p>{t("관측 시각 ", "Observed ")}{sourceTime(portfolio.observedAt)}{t(" (한국 시간) · ", " (Korea time) · ")}{portfolio.chain}{t(" · 거래 권한 없음", " · No transaction authorization")}</p>
        <p>{t("지갑 보유액: ", "Wallet holdings: ")}{portfolio.walletBalance.amount ?? t("확인 불가", "Unavailable")} {portfolio.walletBalance.token.symbol}
          {portfolio.walletBalance.reason && <small>{serverText(portfolio.walletBalance.reason)}</small>}</p>
        <p>{t("수수료용 잔액: ", "Fee balance: ")}{portfolio.feeBalance.amount ?? t("확인 불가", "Unavailable")} TRX
          {portfolio.feeBalance.reason && <small>{serverText(portfolio.feeBalance.reason)}</small>}</p>
        <p>{t("JustLend 포지션: ", "JustLend position: ")}{portfolio.position.receiptBalance ?? t("확인 불가", "Unavailable")} {portfolio.position.receiptToken.symbol}
          {' · '}{t("기초 자산 추정 ", "Estimated underlying assets ")}{portfolio.position.underlyingValue ?? t("확인 불가", "Unavailable")} {portfolio.position.underlyingToken.symbol}
          {portfolio.position.reason && <small>{serverText(portfolio.position.reason)}</small>}</p>
        {portfolio.declaredHoldings && <p>{t("사용자님 진술: ", "Your stated amount: ")}{portfolio.declaredHoldings.amount} {portfolio.declaredHoldings.asset}
          {' · '}{t("관측 잔액과 차이: ", "Difference from observed balance: ")}{portfolio.observedMinusDeclared ?? t("비교 불가", "Not comparable")}</p>}
        <p className="agent-limited">{serverText(portfolio.block.reason)}{t(" 조회 항목마다 적용 블록이 다를 수 있습니다.", " Each queried item may use a different block.")}</p>
      </div>}
    </div>
    {assessment && <div className="agent-assessment-output"><h4>{t("계획 평가 · 읽기 전용", "Plan assessment · Read only")}</h4>
      <p>{assessment.summary}</p>
      <p>{t("입력 확인 버전 ", "Confirmed input version ")}{assessment.confirmedVersion}{t(" · 평가 시각 ", " · Assessed ")}{sourceTime(assessment.assessedAt)}{t(" (한국 시간) · 자료 ", " (Korea time) · Data ")}{assessment.dataMode}</p>
      <p>{t("선택한 날짜별 jUSDT 경로 자료: ", "Selected dated jUSDT route data: ")}{assessment.selectedRouteDataMode === 'live' ? t("현재 읽기 자료", "Current read-only data") : t("혼합 또는 미확인", "Mixed or unverified")}
        {' · '}{t("판정 ", "Decision ")}{assessment.datedDecision?.action === 'conditional_allocate' ? t("일부 또는 전체 구간의 조건부 후보", "Conditional candidate for some or all periods")
          : assessment.datedDecision?.action === 'hold' ? t("보유", "Hold") : t("필수 근거 부족으로 보류", "Deferred: required evidence missing")}</p>
      <p>{t("사용자님 진술 보유액: ", "Your stated holdings: ")}{assessment.declaredAmount} {assessment.plans[0]?.inputToken.symbol ?? ''}
        {' · '}{t("진술 기준 지출·예비액 제외: ", "Stated amount after expenses and reserve: ")}{assessment.declaredInvestableAmount}</p>
      <p>{t("지갑 관측 잔액: ", "Observed wallet balance: ")}{assessment.observedWalletBalance ?? t("확인 불가", "Unavailable")}
        {' · '}{t("보호액: ", "Protected funds: ")}{assessment.protectedAmount}
        {' · '}{t("실잔액 기준 운용 권고 상한: ", "Investment recommendation cap based on observed balance: ")}{assessment.investableAmount}</p>
      {assessment.balanceReason && <p className="agent-limited">{serverText(assessment.balanceReason)}</p>}
      {assessment.walletBalanceSource && <small>{t("잔액 근거: ", "Balance evidence: ")}{assessment.walletBalanceSource.chain} · {assessment.walletBalanceSource.mode}
        {' · '}{t("조회 ", "Fetched ")}{sourceTime(assessment.walletBalanceSource.fetchedAt)}{t(" (한국 시간)", " (Korea time)")}{' · '}{t("블록 번호 미제공 · 항목 간 동일 블록 스냅샷 아님", "Block number not provided · Items are not a same-block snapshot")}</small>}
      {assessment.planBasis === 'declared_hypothetical' && <p className="agent-limited">{t("아래 계획별 운용액은 사용자님 진술을 바탕으로 계산한 가정값입니다. 실제 운용 권고액은 0이며 거래에 사용할 수 없습니다.", "The plan amounts below are hypothetical calculations based on your statement. The actual recommended investment is zero and cannot be used for trading.")}</p>}
      <p className="agent-limited">{t("기존 단일 경로 판정: ", "Existing single-route decision: ")}{assessment.decision.action}{t(" · 거래 권한 없음 · 평가 ", " · No transaction authorization · Assessment ")}{assessment.assessmentId.slice(0, 12)}</p>
      {onSelectPlan && <p className="agent-limited">{t("계획을 선택하면 감시·검토 기준으로 보관합니다. 이 선택으로 거래가 실행되거나 승인되지는 않습니다.", "Selecting a plan saves it for monitoring and review. This selection does not execute or authorize a trade.")}{assessment.planBasis === 'declared_hypothetical' && t(" 지갑 실잔액이 확인되지 않은 계획은 진술액 기반 가정 비교입니다.", " Plans without verified wallet balances are hypothetical comparisons based on stated amounts.")}</p>}
      {assessment.decision.reasonCodes.length > 0 && <p>{t("판정 근거: ", "Decision evidence: ")}{assessment.decision.reasonCodes.join(', ')}</p>}
      {readOnlyEvidence && <JusdtReadOnlyEvidencePanel evidence={readOnlyEvidence} marketSource={jusdtMarketSource} />}
      {assessment.jusdtReadOnlyEvidence && !readOnlyEvidence && <p className="agent-limited" role="status">{t("이전 금액별 조회 근거가 만료되었거나 현재 지갑·네트워크·입력과 일치하지 않습니다. 시세·계획을 다시 평가해 주세요.", "Previous amount-specific evidence expired or does not match the current wallet, network or inputs. Reassess prices and plans.")}</p>}
      {datedAllocation && <div className="agent-dated-allocation">
        <h5>{t("지출 날짜별 배분 비교 · ", "Allocation comparison by expense date · ")}{assessment.planBasis === 'declared_hypothetical' ? t("진술액 기반 가정", "Hypothetical stated amounts") : t("관측 잔액 상한 기준", "Observed balance cap")}</h5>
        <p>{t("판정: ", "Decision: ")}{assessment.planBasis === 'declared_hypothetical' ? t("실잔액 권고 보류 · 가정 비교", "Actual-balance recommendation deferred · Hypothetical comparison")
          : assessment.datedDecision?.action === 'conditional_allocate' ? t("선택 구간만 조건부 운용 후보 · 나머지 보유", "Conditional candidates for selected periods · Hold the rest")
            : datedAllocation.recommendation === 'allocate' ? t("날짜별 운용 후보", "Investment candidates by date") : datedAllocation.recommendation === 'hold' ? t("보유 유지", "Continue holding") : t("자료 부족으로 보류", "Deferred: insufficient evidence")}
          {' · '}{assessment.planBasis === 'declared_hypothetical' ? t("가정 운용액", "Hypothetical investment") : t("운용 후보액", "Candidate investment amount")} {datedAllocation.totalInvested} {datedAllocation.asset.symbol}
          {' · '}{t("보유 ", "Hold ")}{datedAllocation.totalHeld} {datedAllocation.asset.symbol}
          {' · '}{t("예상 순익 ", "Expected net yield ")}{datedAllocation.expectedNetYield ?? t("미확인", "Unverified")} {datedAllocation.asset.symbol}</p>
        <p className="agent-limited">{t("각 지출일까지 필요한 자금을 별도 항목으로 비교합니다. 금리와 출금 가능량은 바뀔 수 있으며 이 배분안은 거래 지시가 아닙니다. 지출액 운용 동의: ", "Funds needed for each expense date are compared separately. Rates and withdrawal capacity may change. This allocation is not a trading instruction. Consent to invest expense funds: ")}{request.explicitFacts.acceptsDatedExpenseLiquidityRisk === true ? t("확인됨", "Confirmed") : t("없음 · 지출액 보유", "Not given · Hold expense funds")}</p>
        {assessment.datedDecision && <p>{t("날짜별 판정 근거: ", "Dated decision evidence: ")}{assessment.datedDecision.reasonCodes.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ')} · {assessment.datedDecision.basis === 'current_conditions_scenario' ? t("현재 조건의 비용 시나리오", "Cost scenario under current conditions") : t("견적 미완료", "Quote incomplete")}</p>}
        {datedAllocation.selectedBundleQuote && <div className="agent-bundle-evidence">
          <h6>{t("선택 구간 공동 견적 · ", "Shared quote for selected periods · ")}{datedAllocation.selectedBundleQuote.status === 'scenario_only' ? t("조건부 시나리오", "Conditional scenario") : t("불완전", "Incomplete")}</h6>
          <p>{t("묶음 버전 ", "Bundle version ")}{datedAllocation.selectedBundleQuote.quoteVersion.slice(0, 12)}{t(" · 관측 ", " · Observed ")}{sourceTime(datedAllocation.selectedBundleQuote.observationWindow.endedAt)}{t(" · 만료 ", " · Expires ")}{sourceTime(datedAllocation.selectedBundleQuote.validUntil)} KST</p>
          <p>{t("시나리오 APR ", "Scenario APR ")}{datedAllocation.selectedBundleQuote.scenarioRateApr === null ? t("미확인", "Unverified") : `${new Decimal(datedAllocation.selectedBundleQuote.scenarioRateApr).times(100).toString()}%`}
            {' · '}{t("예상 비용 ", "Expected costs ")}{datedAllocation.selectedBundleQuote.expectedCostUsdt ?? t("미확인", "Unverified")} USDT
            {' · '}{t("스트레스 비용 ", "Stress costs ")}{datedAllocation.selectedBundleQuote.stressCostUsdt ?? t("미확인", "Unverified")} USDT</p>
          <p>{t("예상 순익 ", "Expected net yield ")}{datedAllocation.selectedBundleQuote.scenarioNetYieldUsdt ?? t("미확인", "Unverified")}{t(" USDT · 스트레스 순익 ", " USDT · Stress net yield ")}{datedAllocation.selectedBundleQuote.stressNetYieldUsdt ?? t("미확인", "Unverified")} USDT</p>
          <p>{t("수수료용 TRX: 현재 ", "TRX for fees: available ")}{trxFromSun(datedAllocation.selectedBundleQuote.availableFeeTrxSun)}{t(" · 정책상 필요 ", " · Required by policy ")}{trxFromSun(datedAllocation.selectedBundleQuote.requiredFeeTrxSun)}{t(". 이는 USDT 예비액과 별도이며 미래 수수료 상한이 아닙니다.", ". This is separate from the USDT reserve and is not a cap on future fees.")}</p>
          <p>{t("공동 승인 경로: ", "Shared approval path: ")}{datedAllocation.selectedBundleQuote.approvalActions === 'none' ? t("추가 승인 없음", "No additional approval")
            : datedAllocation.selectedBundleQuote.approvalActions === 'approve' ? t("승인 1회", "One approval")
              : datedAllocation.selectedBundleQuote.approvalActions === 'reset_then_approve' ? t("초기화 후 승인 2회", "Reset and approve: two approvals") : t("미확인", "Unverified")}</p>
          <ul>{datedAllocation.selectedBundleQuote.actions.map((action, index) => <li key={`${action.bucketKey ?? 'shared'}-${action.cost.action}-${index}`}>
            {costActionLabels[action.cost.action]} · {action.bucketKey ?? t("공동 승인", "Shared approval")} · {costBasisLabels[action.cost.basis]}
            {' · '}Energy {action.cost.energyUnits ?? t("미확인", "Unverified")} · Bandwidth {action.cost.bandwidthBytes ?? t("미확인", "Unverified")} bytes
            {' · '}{t("현재 비용 ", "Current cost ")}{trxFromSun(action.cost.estimatedFeeSun)}
            {action.cost.sources[0] && <> · <a href={action.cost.sources[0].sourceUrl} target="_blank" rel="noreferrer">{t("비용 근거 ↗", "Cost evidence ↗")}</a></>}
          </li>)}</ul>
          <small>{t("과거 거래 모델과 현재 계정 모의 결과는 미래 거래 성공이나 회수 보증이 아닙니다.", "Historical transaction models and current-account simulations do not guarantee future transaction success or withdrawals.")}</small>
        </div>}
        <div className="agent-allocation-scroll"><table className="agent-allocation-table">
          <thead><tr><th>{t("목적·필요일", "Purpose / required date")}</th><th>{t("금액", "Amount")}</th><th>{t("운용 경로", "Investment route")}</th><th>{t("회수 요청", "Withdrawal request")}</th><th>{t("비용·예상 순익", "Costs / expected net yield")}</th><th>{t("확인 사항", "Checks")}</th></tr></thead>
          <tbody>{datedAllocation.legs.map((leg, index) => <tr key={`${leg.purpose}-${leg.dueDate}-${index}`}>
            <td>{leg.purpose === 'expense' ? t("예정 지출", "Scheduled expense") : t("운용 종료", "End of period")}<small>{leg.dueDate} · {leg.daysUntilDue}{t("일 뒤", " days later")}</small></td>
            <td>{leg.amount} {datedAllocation.asset.symbol}</td>
            <td>{leg.decision === 'invest' && leg.product ? planLabels[leg.product] : t("보유", "Hold")}
              <small>{t("운용 ", "Invested ")}{leg.invested}{t(" · 보유 ", " · Held ")}{leg.held} {datedAllocation.asset.symbol}</small>
              {leg.decision === 'invest' && <small>{t("이자 계산 기간 ", "Interest period ")}{leg.earningDays}{t("일 · ", " days · ")}{leg.eligibility === 'eligible' ? t("조건 충족", "Conditions met") : t("추가 확인 필요", "Further checks needed")}</small>}</td>
            <td>{leg.withdrawalRequestDate ?? t("해당 없음", "Not applicable")}</td>
            <td>{t("구간 비용 ", "Period cost ")}{leg.roundTripCost ?? t("묶음 공동 비용에 포함 또는 미확인", "Included in shared bundle cost or unverified")}<small>{t("예상 기여 순익 ", "Expected net yield contribution ")}{leg.expectedNetYield ?? t("미확인", "Unverified")} {datedAllocation.asset.symbol}</small>
              {leg.sizedQuoteVersion && <small>{t("금액별 견적 ", "Amount-specific quote ")}{leg.sizedQuoteVersion.slice(0, 12)}{t(" · 만료 ", " · Expires ")}{sourceTime(leg.validUntil ?? null)}</small>}</td>
            <td>{leg.reasons.length > 0 ? leg.reasons.map(reason => allocationReasonLabels[reason] ?? reason).join(' · ') : t("추가 사유 없음", "No additional reasons")}
              {leg.source && <small>{leg.source.mode}{t(" · 조회 ", " · Fetched ")}{sourceTime(leg.source.fetchedAt)}{t(" (한국 시간)", " (Korea time)")}</small>}</td>
          </tr>)}</tbody>
        </table></div>
        {onSelectDatedAllocation && <button className="agent-store-plan" type="button"
          disabled={busy || !canStoreDatedAllocation(request, assessment, datedAllocation, wallet)}
          onClick={() => storeAllocation(datedAllocation)}>{storedAllocationId === datedAllocation.id
            ? t("날짜별 배분안 보관됨", "Dated allocation saved") : t("날짜별 배분안 감시·검토용으로 보관", "Save dated allocation for monitoring and review")}</button>}
        {storedAllocationId === datedAllocation.id && <p className="agent-limited"><a href="/review">{t("계획 검토 화면", "Plan review")}</a>{t("에서 보관한 기준을 확인하세요. 자동 거래는 실행되지 않습니다.", " shows the saved criteria. No automated trades are executed.")}</p>}
      </div>}
      <ul>{assessment.plans.map(plan => <li key={plan.id}><strong>{planLabels[plan.kind] ?? plan.kind}</strong>
        {' · '}{plan.eligibility.status}{t(" · 운용 ", " · Invested ")}{plan.allocation.invested} {plan.inputToken.symbol}
        {' · '}{t("예상 순수익 ", "Expected net yield ")}{plan.netYield ?? t("미확인", "Unverified")} {plan.inputToken.symbol}
        {' · '}{t("왕복 비용 ", "Round-trip cost ")}{plan.roundTripCost ?? t("미확인", "Unverified")} {plan.inputToken.symbol}
        {plan.eligibility.reasons.length > 0 && <small>{t("제외·보류 근거: ", "Exclusion / hold reasons: ")}{plan.eligibility.reasons.join(', ')}</small>}
        {plan.source && <small>{t("자료: ", "Data: ")}{plan.source.mode}{t(" · 조회 ", " · Fetched ")}{sourceTime(plan.source.fetchedAt)}{t(" (한국 시간) · 원천 갱신 ", " (Korea time) · Source updated ")}{sourceTime(plan.source.sourceUpdatedAt)}</small>}
        {plan.risks.length > 0 && <small>{t("위험: ", "Risks: ")}{plan.risks.join('; ')}</small>}
        {assessment.chain === 'nile' && plan.kind === 'justlend_jtrx'
          && <NileAgentFeeEvidence now={Math.max(evidenceClock, Date.now())}
            scenario={visibleNileFeeScenario(request, assessment, plan, wallet)} />}
        {onSelectPlan && <button className="agent-store-plan" type="button"
          disabled={busy || !canStoreAssessedPlan(request, assessment, plan, wallet)}
          onClick={() => storePlan(plan)}>{storedPlanId === plan.id ? t("검토 계획으로 보관됨", "Saved as a review plan") : t("감시·검토 계획으로 보관", "Save for monitoring and review")}</button>}</li>)}</ul>
      {storedPlanId && <p className="agent-limited">{t("선택한 계획을 ", "View the selected plan in ")}<a href="/review">{t("계획 검토 화면", "Plan review")}</a>{t("에서 확인할 수 있습니다. 최신 자료 재평가 전에는 실행 판단에 사용하지 마세요.", ". Reassess current data before using it for execution decisions.")}</p>}
      {assessment.diagnostics.length > 0 && <details><summary>{t("미확인 데이터와 연결 상태", "Unverified data and connection status")}</summary><ul>{assessment.diagnostics.map(item =>
        <li key={item.name}>{item.name}: {item.status} · {item.reason}</li>)}</ul></details>}
    </div>}
  </section>;
}
