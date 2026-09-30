import Decimal from 'decimal.js';
import type { UserNeeds } from '../../../shared/schemas';
import { estimateUsdtDemo } from '../../../shared/demo-estimate';
import './usdt-expected-result.css';

function usdt(value: string) {
  const fixed = new Decimal(value).toFixed(6);
  const [whole, fractional] = fixed.split('.');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${grouped}.${fractional}`;
}

export function UsdtExpectedResult({ needs, error }: { needs: UserNeeds | null; error?: string }) {
  let estimate;
  try {
    estimate = needs ? estimateUsdtDemo(needs) : null;
  } catch (cause) {
    return <section className="usdt-expected-result" data-mode="synthetic" aria-label="USDT 가정 계산">
      <div className="usdt-expected-head"><span>MAINNET USDT · 가정 계산</span><h2>조건을 확인해 주세요</h2></div>
      <p role="alert">{cause instanceof Error ? cause.message : '입력값을 확인해 주세요.'}</p>
    </section>;
  }

  if (!estimate || !needs) {
    return <section className="usdt-expected-result" data-mode="synthetic" aria-label="USDT 가정 계산">
      <div className="usdt-expected-head"><span>MAINNET USDT · 가정 계산</span><h2>조건을 확인해 주세요</h2></div>
      <p role="alert">{error || '보유액, 운용 기간, 예정 지출을 입력해 주세요.'}</p>
    </section>;
  }

  return <section className="usdt-expected-result" data-mode="synthetic" aria-label="USDT 가정 계산">
    <div className="usdt-expected-head">
      <div><span>MAINNET USDT · SYNTHETIC</span><h2>입력 조건에 따른 예상 결과</h2>
        <p>지갑 잔액과 시장 시세를 조회하지 않은 설명용 계산입니다. JustLend 상품 견적이나 예치 권고가 아닙니다.</p></div>
      <strong>가정 기반 · 거래 불가</strong>
    </div>
    <div className="usdt-expected-metrics">
      <div><span>가상 보유액</span><strong>{usdt(estimate.declaredAmountUsdt)} <small>USDT</small></strong></div>
      <div><span>지출·예비액 보호</span><strong>{usdt(estimate.protectedAmountUsdt)} <small>USDT</small></strong></div>
      <div><span>전 기간 운용 가정액</span><strong>{usdt(estimate.hypotheticalInvestableUsdt)} <small>USDT</small></strong></div>
    </div>
    <div className="usdt-expected-projection">
      <div><span>고정 예시 이율 · 연 5% APY</span><strong>{usdt(estimate.projectedGrossInterestUsdt)} <small>USDT</small></strong>
        <p>{estimate.startDate}~{estimate.endDate} ({estimate.horizonDays}일) 동안 운용 가정액 전체에 같은 예시 이율을 적용한 <b>비용 전 이자</b>입니다.</p></div>
      <dl><div><dt>왕복 거래비용</dt><dd>미확인</dd></div><div><dt>비용 차감 후 순익</dt><dd>계산 불가</dd></div><div><dt>상품 추천·거래</dt><dd>제공하지 않음</dd></div></dl>
    </div>
    <div className="usdt-expected-schedule"><h3>입력한 지출 보호 내역</h3>
      {needs.expenses.length > 0 ? <ul>{needs.expenses.map((expense, index) => <li key={`${expense.date}-${index}`}><span>{expense.date} 예정 지출</span><strong>{usdt(expense.amount)} USDT</strong></li>)}</ul>
        : <p>입력한 예정 지출이 없습니다.</p>}
      <p>비상 예비액 {usdt(needs.liquidReserve)} USDT도 보호 금액에 포함했습니다. 종료일 이후 지출도 현재 보유액에서 별도로 확보합니다.</p>
    </div>
    <p className="usdt-expected-foot">이율 5%는 고정 예시이며 관측 시각이 없는 값입니다. 실제 APY, 비용, 출금 가능성, 순익과는 다를 수 있습니다. 위험 성향·USDD 전환·지출액의 기한 전 예치는 이 계산에 반영하지 않았습니다. Nile TRX 시험 거래 결과와 합산하지 않습니다.</p>
  </section>;
}
