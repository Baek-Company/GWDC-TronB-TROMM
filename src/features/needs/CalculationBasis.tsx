import { useI18n } from '../../lib/i18n';
import DecimalBase from 'decimal.js';
import { planDays, type LiquidityResult } from '../../../shared/planning';
import { userNeedsSchema, type UserNeeds } from '../../../shared/schemas';
import './calculation-basis.css';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });

function amount(value: string): string {
  const [whole, fraction] = new Decimal(value).toFixed().split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

function daysBetween(startDate: string, endDate: string): number {
  // Business dates are Seoul calendar dates. UTC midnight gives calendar-day differences
  // without a daylight-saving or host-timezone offset.
  return (Date.parse(`${endDate}T00:00:00.000Z`) - Date.parse(`${startDate}T00:00:00.000Z`)) / 86_400_000;
}

export function CalculationBasis({ needs: rawNeeds, liquidity }: {
  needs: UserNeeds;
  liquidity: LiquidityResult;
}) {
  const { t } = useI18n();
  const needs = userNeedsSchema.parse(rawNeeds);
  const horizonDays = planDays(needs);
  const expenseTotal = needs.expenses.reduce((sum, expense) => sum.plus(expense.amount), new Decimal(0));
  const asset = needs.asset.symbol;
  const expenses = [...needs.expenses].sort((a, b) => a.date.localeCompare(b.date));
  const datedRiskAllowed = needs.acceptsDatedExpenseLiquidityRisk;

  return <section className="calculation-basis" aria-labelledby="calculation-basis-title" data-mode="synthetic">
    <div className="calculation-basis-heading">
      <h4 id="calculation-basis-title">{t("이번 계산의 근거", "Basis for this calculation")}</h4>
      <span>{t("직접 입력한 가상 조건", "Manually entered hypothetical inputs")}</span>
    </div>
    <p className="calculation-basis-lead">{t("사용자님이 입력한 금액·기간·지출일을 한국시간의 오늘 날짜에 적용해 ", "Using your amount, period, and expense dates with today's date in Korea, we calculated the ")}<strong>{t("전 기간 운용 상한", "full-period investment cap")}</strong>{t("을 구했습니다. 지갑 잔액이나 실제 시장 시세를 읽어 산출한 금액은 아닙니다.", ". This amount is not based on a wallet balance or live market prices.")}</p>

    <dl className="calculation-basis-facts">
      <div><dt>{t("운용 기간", "Investment period")}</dt><dd><time dateTime={needs.startDate}>{needs.startDate}</time> ~ <time dateTime={needs.endDate}>{needs.endDate}</time> ({horizonDays}{t("일)", " days)")}</dd></div>
      <div><dt>{t("입력한 보유액", "Declared holdings")}</dt><dd>{amount(needs.amount)} {asset}</dd></div>
      <div><dt>{t("비상 예비액", "Emergency reserve")}</dt><dd>{amount(needs.liquidReserve)} {asset}</dd></div>
      <div><dt>{t("예정 지출 합계", "Total scheduled expenses")}</dt><dd>{amount(expenseTotal.toString())} {asset} · {expenses.length}{t("건", " expenses")}</dd></div>
    </dl>

    <div className="calculation-basis-group">
      <h5>{t("지출액을 보호한 기준", "How expense funds are protected")}</h5>
      {expenses.length ? <ol className="calculation-basis-expenses">
        {expenses.map((expense, index) => {
          const days = daysBetween(needs.startDate, expense.date);
          const withinHorizon = expense.date <= needs.endDate;
          return <li key={`${expense.date}-${index}`}>
            <div><strong>{amount(expense.amount)} {asset}</strong><span>{withinHorizon ? t("기간 내 지출", "Expense within period") : t("기간 후 지출", "Expense after period")}</span></div>
            <p><time dateTime={expense.date}>{expense.date}</time>{t(" · 시작일부터 ", " · After the start date: ")}{days}{t("일 뒤", " days")}
              {withinHorizon ? t(" 지급 예정", " payment scheduled") : t(" 지급 예정이며, 종료일 이후라도 전액 보호", " payment scheduled and fully protected even after the end date")}</p>
          </li>;
        })}
      </ol> : <p className="calculation-basis-muted">{t("등록된 예정 지출이 없습니다. 예비액만 보호액에 들어갑니다.", "No scheduled expenses were entered. Only the reserve is included in the protected amount.")}</p>}
      <p className="calculation-basis-muted">{t("종료일 뒤에 지급할 금액도 이미 약속된 지출로 보고 운용 상한에서 제외합니다.", "Payments due after the end date are also treated as committed expenses and excluded from the investment cap.")}</p>
    </div>

    <div className="calculation-basis-equation" aria-label={t("전 기간 운용 상한 산식", "Full-period investment cap formula")}>
      <span>{t("보유액 − (비상 예비액 + 모든 예정 지출) = 전 기간 운용 상한", "Holdings − (emergency reserve + all scheduled expenses) = full-period investment cap")}</span>
      <strong>{amount(needs.amount)} − ({amount(needs.liquidReserve)} + {amount(expenseTotal.toString())}) = {amount(liquidity.investableAmount)} {asset}</strong>
      <small>{t("보호액 ", "Protected amount ")}{amount(liquidity.protectedAmount)} {asset}{t(" = 예비액 ", " = Reserve ")}{amount(needs.liquidReserve)}{t(" + 지출 합계 ", " + Total expenses ")}{amount(expenseTotal.toString())}</small>
    </div>

    <div className="calculation-basis-group">
      <h5>{t("선택 조건이 결과에 미치는 영향", "How your selections affect the result")}</h5>
      <ul className="calculation-basis-notes">
        <li><strong>{t("지출액 날짜별 운용:", "Investing expense funds by date:")}</strong> {datedRiskAllowed
          ? t("위험 수용 의향이 기록됐습니다. 현재 가정 계산은 예정 지출을 전액 보호하며, 이 선택으로 상한이 늘어나지 않습니다. 지급일 전 회수 경로는 이 화면에서 계산하지 않습니다.", "Your willingness to accept the risk is recorded. This hypothetical calculation fully protects scheduled expenses, so this selection does not increase the cap. Redemption routes before the due date are not calculated here.")
          : t("위험 수용 의향이 기록되지 않았습니다. 현재 가정 계산은 예정 지출을 전액 보호하며, 이 선택과 관계없이 상한은 같습니다. 지급일 전 회수 경로는 이 화면에서 계산하지 않습니다.", "Willingness to accept the risk is not recorded. This hypothetical calculation fully protects scheduled expenses, so the cap is unchanged by this selection. Redemption routes before the due date are not calculated here.")}</li>
        <li><strong>{t("위험 성향:", "Risk preference:")}</strong> {({ conservative: t("보수형", "Conservative"), balanced: t("균형형", "Balanced"), growth: t("성장형", "Growth") } as const)[needs.riskPreference]}{t("으로 기록했습니다. 이 단순 유동성 산식에는 적용하지 않았습니다.", " is recorded. It is not applied to this simple liquidity formula.")}</li>
        <li><strong>{t("USDD 경로 검토:", "Considering the USDD route:")}</strong> {needs.acceptsUsddRisk ? t("검토 의향이 기록됐습니다.", "Your interest in considering this route is recorded.") : t("검토 의향이 기록되지 않았습니다.", "Interest in considering this route is not recorded.")}{t(" 현재 가정 계산은 USDD 전환 경로를 비교하지 않으며, 이 선택은 위 금액 계산에 영향을 주지 않습니다.", " This hypothetical calculation does not compare USDD conversion routes; this selection does not affect the amounts above.")}</li>
      </ul>
    </div>

    <p className="calculation-basis-limit"><strong>{t("아직 확인하지 않은 것:", "Not yet verified:")}</strong>{t(" 실제 지갑 잔액, 상품 이율·시세, 입출금 경로, 왕복 거래비용, 지급일 회수 가능성, 비용 차감 후 순익입니다. 따라서 이 숫자는 예치 권고나 실행 가능한 거래 금액이 아닙니다.", " Live wallet balance, product rates and prices, deposit and withdrawal routes, round-trip costs, redemption by the due date, and net yield after costs. This number is therefore not a deposit recommendation or an executable transaction amount.")}</p>
  </section>;
}
