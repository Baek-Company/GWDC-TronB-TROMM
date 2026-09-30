import { localizeKnownText, useI18n } from '../../lib/i18n';
import Decimal from 'decimal.js';
import type { UserNeeds } from '../../../shared/schemas';
import { estimateUsdtDemo } from '../../../shared/demo-estimate';
import './usdt-expected-result.css';

const demoMessages: readonly (readonly [string, string])[] = [
  ['Mainnet USDT 가상 조건만 계산할 수 있습니다.', 'Only hypothetical Mainnet USDT inputs can be calculated.'],
  ['USDT 금액은 소수점 여섯 자리 이내여야 합니다.', 'USDT amounts must have at most six decimal places.'],
];

function usdt(value: string) {
  const fixed = new Decimal(value).toFixed(6);
  const [whole, fractional] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${fractional}`;
}

export function UsdtExpectedResult({ needs, error }: { needs: UserNeeds | null; error?: string }) {
  const { t } = useI18n();
  let estimate;
  try {
    estimate = needs ? estimateUsdtDemo(needs) : null;
  } catch (cause) {
    return <section className="usdt-expected-result" data-mode="synthetic" aria-label={t("USDT 가정 계산", "Hypothetical USDT calculation")}>
      <div className="usdt-expected-head"><span>{t("MAINNET USDT · 가정 계산", "MAINNET USDT · Hypothetical calculation")}</span><h2>{t("조건을 확인해 주세요", "Please check your inputs")}</h2></div>
      <p role="alert">{cause instanceof Error ? localizeKnownText(cause.message, t, demoMessages) : t("입력값을 확인해 주세요.", "Please check your inputs.")}</p>
    </section>;
  }

  if (!estimate || !needs) {
    return <section className="usdt-expected-result" data-mode="synthetic" aria-label={t("USDT 가정 계산", "Hypothetical USDT calculation")}>
      <div className="usdt-expected-head"><span>{t("MAINNET USDT · 가정 계산", "MAINNET USDT · Hypothetical calculation")}</span><h2>{t("조건을 확인해 주세요", "Please check your inputs")}</h2></div>
      <p role="alert">{(error ? localizeKnownText(error, t, demoMessages) : '') || t("보유액, 운용 기간, 예정 지출을 입력해 주세요.", "Enter your holdings, investment period, and scheduled expenses.")}</p>
    </section>;
  }

  return <section className="usdt-expected-result" data-mode="synthetic" aria-label={t("USDT 가정 계산", "Hypothetical USDT calculation")}>
    <div className="usdt-expected-head">
      <div><span>MAINNET USDT · SYNTHETIC</span><h2>{t("입력 조건에 따른 예상 결과", "Projected results from your inputs")}</h2>
        <p>{t("지갑 잔액과 시장 시세를 조회하지 않은 설명용 계산입니다. JustLend 상품 견적이나 예치 권고가 아닙니다.", "An illustrative calculation without retrieving a wallet balance or market prices. This is not a JustLend product quote or deposit recommendation.")}</p></div>
      <strong>{t("가정 기반 · 거래 불가", "Hypothetical · No trading")}</strong>
    </div>
    <div className="usdt-expected-metrics">
      <div><span>{t("가상 보유액", "Hypothetical holdings")}</span><strong>{usdt(estimate.declaredAmountUsdt)} <small>USDT</small></strong></div>
      <div><span>{t("지출·예비액 보호", "Protected expenses and reserve")}</span><strong>{usdt(estimate.protectedAmountUsdt)} <small>USDT</small></strong></div>
      <div><span>{t("전 기간 운용 가정액", "Hypothetical full-period investment")}</span><strong>{usdt(estimate.hypotheticalInvestableUsdt)} <small>USDT</small></strong></div>
    </div>
    <div className="usdt-expected-projection">
      <div><span>{t("고정 예시 이율 · 연 5% APY", "Fixed example rate · 5% APY")}</span><strong>{usdt(estimate.projectedGrossInterestUsdt)} <small>USDT</small></strong>
        <p>{estimate.startDate}~{estimate.endDate} ({estimate.horizonDays}{t("일) 동안 운용 가정액 전체에 같은 예시 이율을 적용한 ", " days), applying the same example rate to the entire hypothetical investment yields ")}<b>{t("비용 전 이자", "interest before costs")}</b>{t("입니다.", ".")}</p></div>
      <dl><div><dt>{t("왕복 거래비용", "Round-trip transaction costs")}</dt><dd>{t("미확인", "Unverified")}</dd></div><div><dt>{t("비용 차감 후 순익", "Net yield after costs")}</dt><dd>{t("계산 불가", "Cannot be calculated")}</dd></div><div><dt>{t("상품 추천·거래", "Product recommendations / Trading")}</dt><dd>{t("제공하지 않음", "Not provided")}</dd></div></dl>
    </div>
    <div className="usdt-expected-schedule"><h3>{t("입력한 지출 보호 내역", "Protection for entered expenses")}</h3>
      {needs.expenses.length > 0 ? <ul>{needs.expenses.map((expense, index) => <li key={`${expense.date}-${index}`}><span>{expense.date}{t(" 예정 지출", " Scheduled expense")}</span><strong>{usdt(expense.amount)} USDT</strong></li>)}</ul>
        : <p>{t("입력한 예정 지출이 없습니다.", "No scheduled expenses were entered.")}</p>}
      <p>{t("비상 예비액 ", "Emergency reserve ")}{usdt(needs.liquidReserve)}{t(" USDT도 보호 금액에 포함했습니다. 종료일 이후 지출도 현재 보유액에서 별도로 확보합니다.", " USDT is also included in the protected amount. Expenses after the end date are also set aside from current holdings.")}</p>
    </div>
    <p className="usdt-expected-foot">{t("이율 5%는 고정 예시이며 관측 시각이 없는 값입니다. 실제 APY, 비용, 출금 가능성, 순익과는 다를 수 있습니다. 위험 성향·USDD 전환·지출액의 기한 전 예치는 이 계산에 반영하지 않았습니다. Nile TRX 시험 거래 결과와 합산하지 않습니다.", "The 5% rate is a fixed example with no observation timestamp. Actual APY, costs, withdrawal availability, and net yield may differ. Risk preference, USDD conversion, and investing expense funds before their due dates are excluded. These results are not combined with Nile TRX test transactions.")}</p>
  </section>;
}
