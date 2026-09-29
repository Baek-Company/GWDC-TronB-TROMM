import type { Update } from "../../App";
import type { PersistedState } from "../../lib/storage";
import type { Plan, PlanningResult } from "../../../shared/schemas";
import { ChainBadge, EligibilityBadge, Money, SourceLine, timeKo } from "../common";
import { riskLabel } from "../../../shared/needs";
import { Decimal } from "../../../shared/units";

export default function PlanComparison({ state, update, result, goNeeds, goMonitor }: {
  state: PersistedState;
  update: Update;
  result?: PlanningResult;
  goNeeds: () => void;
  goMonitor: () => void;
}) {
  if (!result) return <EmptyState goNeeds={goNeeds} />;

  const stale = result.needs.version !== state.needs.version || !["confirmed", "comparing"].includes(state.convState);
  const recommendation = result.plans.find((plan) => plan.id === result.recommendation.planId)!;
  const asset = recommendation.asset;
  const ladder = result.plans.find((plan) => plan.key === "L");
  const baselines = result.plans.filter((plan) => plan.key !== "L");
  const startMonitoring = () => {
    const selected = recommendation;
    update((current) => ({ ...current, selectedPlanId: selected.id, monitoredGoal: { baselineResultId: result.id, planKey: selected.key as "A" | "B" | "C" | "L" | "HOLD", savedAt: new Date().toISOString(), history: [] } }));
    goMonitor();
  };

  return <div className="stack">
    <header className="row">
      <div>
        <div className="eyebrow">Step 2 · Compare</div>
        <h1 className="hero-title" style={{ fontSize: 34 }}>날짜를 지키면서, <em>남는 돈을 운용</em>합니다</h1>
        <div className="row" style={{ gap: 8 }}>
          <ChainBadge chain={result.chain} />
          <span className="badge amber">조건부 분석</span>
          <span className="tiny muted">조회 {timeKo(result.createdAt)}</span>
        </div>
      </div>
      <div className="spacer" />
      <button className="btn" onClick={goNeeds}>조건 바꾸기</button>
    </header>

    {stale && <div className="callout amber small">입력 조건이 바뀌었습니다. 요구 분석에서 다시 확인한 뒤 새 계획을 계산해 주세요.</div>}
    {result.warnings.length > 0 && <div className="callout amber small">{result.warnings.map((warning) => <div key={warning}>⚠ {warning}</div>)}</div>}

    {result.funding && <div className="callout amber small">
      <strong>자산 전환을 반영한 계획</strong><div>입력: {result.funding.inputAmount} {result.funding.inputAsset} · 최초 전환 후 USDT 운용 재원: {result.plans[0]?.principal} USDT · 별도 보유 TRX: {result.funding.reservedTrx} TRX (예상 네트워크 비용 준비금 {result.funding.gasReserveTrx} TRX 포함)</div>
      <div>전환 가격 차이·슬리피지: {result.funding.conversionLossUsdt} USDT · 최초 전환 네트워크 비용: {result.funding.networkFeeTrx} TRX. 아래 수익은 USDT 기준이며 이 비용을 포함합니다.{result.funding.inputAsset === "TRX" && ` 고정 환율(1 USDT = ${result.funding.trxPerUsdt} TRX)로 환산한 추천 손익은 ${new Decimal(recommendation.netReturn ?? 0).mul(result.funding.trxPerUsdt).toDecimalPlaces(4).toFixed()} TRX입니다.`}</div>
      <div>{result.funding.note}</div>
      {result.needs.expenses.filter((expense) => expense.asset === "TRX" && expense.date >= result.needs.startDate && (!result.needs.endDate || expense.date <= result.needs.endDate)).map((expense) => <div key={expense.id}>TRX 지출 확보: {expense.date} · {expense.amount} TRX</div>)}
    </div>}
    <div className="formula" style={{ marginTop: 0 }}>
      <div className="small muted">{result.needs.startDate} ~ {result.needs.endDate} · 위험 성향 {riskLabel(result.needs.riskProfile)} · USDD 위험 {result.needs.acceptUsddRisk ? "수용" : "미수용"}</div>
      <Metric label={result.funding ? "전환 후 운용 재원" : "보유 자산"} value={result.funding ? result.plans[0]?.principal : result.needs.amount} asset={asset} tone="teal" />
      <div className="op">−</div>
      <Metric label="기간 내 지출 + 여유액" value={result.reserved.total} asset={asset} tone="coral" />
      <div className="op">=</div>
      <Metric label="지출 제외 장기 운용액" value={result.investable} asset={asset} tone="result" />
    </div>

    <div className={`callout ${recommendation.key === "HOLD" ? "coral" : "teal"}`}>
      <strong>추천: {recommendation.title}</strong>
      <div className="small" style={{ marginTop: 4 }}>{result.recommendation.reason}</div>
    </div>

    {ladder && <LadderPlan plan={ladder} asset={asset} />}

    <BaselineTable plans={baselines} asset={asset} />

    <div className="card">
      <div className="row">
        <div><h3 style={{ margin: 0 }}>이 계획 감시하기</h3><p className="small muted">조건이 바뀌면 다시 계산해 유지, 재검토, 보류를 제안합니다.</p></div>
        <div className="spacer" />
        <button className="btn primary" disabled={stale || recommendation.eligibility === "ineligible"} onClick={startMonitoring}>추천 계획 감시 시작</button>
      </div>
      <p className="tiny muted">추천 계획의 금리·수수료·인출 조건이 바뀌면 다시 계산해 알려드립니다.</p>
    </div>

    <div className="card">
      <div className="row"><h3>AI 설명</h3><div className="spacer" /><span className={`badge ${result.explanation.source === "llm" ? "teal" : "gray"}`}>{result.explanation.source === "llm" ? "AI 요약" : "템플릿 요약"}</span></div>
      <p style={{ whiteSpace: "pre-wrap", margin: 0 }}>{result.explanation.text}</p>
      <p className="tiny muted">설명은 계산 결과만 사용합니다. 금액과 추천은 코드가 결정합니다.</p>
    </div>

    <Sources result={result} />
  </div>;
}

function EmptyState({ goNeeds }: { goNeeds: () => void }) {
  return <div className="card" style={{ textAlign: "center", padding: 48 }}><h2>아직 비교할 계획이 없어요</h2><p className="muted">보유액, 운용 기간, 지출 날짜를 확인하면 계획을 계산합니다.</p><button className="btn primary" onClick={goNeeds}>조건 입력하기</button></div>;
}

function Metric({ label, value, asset, tone }: { label: string; value?: string; asset: string; tone: "teal" | "coral" | "result" }) {
  return <div className={`fcard ${tone}`}><div><div className="ttl">{label}</div><div className="val"><Money v={value} dp={0} /> <small>{asset}</small></div></div></div>;
}

function LadderPlan({ plan, asset }: { plan: Plan; asset: string }) {
  const amounts = { JUSDT: new Decimal(0), JUSDD: new Decimal(0), STAKE: new Decimal(0) };
  for (const bucket of plan.ladder ?? []) for (const allocation of bucket.allocations) {
    if (allocation.product !== "HOLD") amounts[allocation.product] = amounts[allocation.product].plus(allocation.amount);
  }
  const denominator = new Decimal(plan.principal);
  const percent = (value: Decimal) => denominator.gt(0) ? `${value.div(denominator).mul(100).toDecimalPlaces(1).toFixed()}%` : "0%";
  const held = Decimal.max(denominator.minus(amounts.JUSDT).minus(amounts.JUSDD).minus(amounts.STAKE), 0);
  return <section className="card">
    <div className="row"><div><h3 style={{ margin: 0 }}>날짜별 유동성 배분</h3><p className="small muted">각 돈의 사용 시점을 기준으로 보유, JustLend, USDD 경로, Stake 2.0을 함께 비교합니다.</p></div><div className="spacer" /><EligibilityBadge e={plan.eligibility} />{plan.recommended && <span className="badge teal">추천</span>}</div>
    <div className="kv" style={{ margin: "14px 0" }}><div>예상 순수익</div><div><strong><Money v={plan.netReturn} asset={asset} dp={4} signed /></strong></div><div>운용 / 보유</div><div>{plan.allocation.invested} / {plan.allocation.held} {asset}</div><div>예상 네트워크 비용</div><div>{plan.costs.trx} TRX{plan.costs.inAsset && ` · ≈ ${plan.costs.inAsset} ${asset}`}</div></div>
    <div className="small muted">계획 자금 전체 기준 배분 · jUSDT {percent(amounts.JUSDT)} · jUSDD {percent(amounts.JUSDD)} · 스테이킹 {percent(amounts.STAKE)}{held.gt(0) && ` · 보유 ${percent(held)}`}</div>
    <div style={{ overflowX: "auto" }}><table className="table-simple"><thead><tr><th>필요한 날짜</th><th>자금</th><th>배분</th><th>준비 일정</th><th>이유</th></tr></thead><tbody>{plan.ladder?.map((bucket) => <tr key={bucket.id}><td>{bucket.needDate}</td><td>{bucket.label}<div className="tiny muted">{bucket.amount} {asset}</div></td><td>{bucket.allocations.map((allocation) => <div key={allocation.product}><strong>{allocation.productLabel}</strong> {allocation.amount} {asset}<div className="tiny muted">예상 수익 {allocation.expectedYield} {asset}</div></div>)}</td><td>{bucket.product === "HOLD" ? "필요 없음" : <>{bucket.unstakeDate && <div>해제 요청 {bucket.unstakeDate}</div>}<div>현금화 준비 {bucket.exitStartDate}</div></>}</td><td className="small">{bucket.reason}</td></tr>)}</tbody></table></div>
    <details><summary>실행 준비 목록 ({plan.steps.length})</summary><p className="tiny muted">Mainnet 거래를 만들거나 서명하지 않습니다. 실행 전 지갑 잔고, 승인 범위, 수수료, 인출 가능 물량을 다시 확인해야 합니다.</p>{plan.steps.map((item, index) => <div className="step" key={`${item.label}-${index}`}><span className="n">{index + 1}</span><div>{item.day ? `D+${item.day} · ` : ""}{item.label} · {item.amount} {item.asset}</div></div>)}</details>
  </section>;
}

function BaselineTable({ plans, asset }: { plans: Plan[]; asset: string }) {
  return <details className="card" style={{ overflowX: "auto" }}><summary>다른 기준선과 비교하기</summary><p className="small muted">jUSDT만, jUSDD만, 스테이킹만, 전액 보유했을 때를 같은 자금으로 비교합니다.</p><table className="plan-table"><thead><tr><th>계획</th><th>적격성</th><th>운용 / 보유</th><th>예상 순수익</th></tr></thead><tbody>{plans.map((plan) => <tr key={plan.id}><td><strong>{plan.title}</strong><div className="tiny muted">{plan.reasons[0]}</div></td><td><EligibilityBadge e={plan.eligibility} /></td><td>{plan.allocation.invested} / {plan.allocation.held} {asset}</td><td><strong><Money v={plan.netReturn} asset={asset} dp={4} signed /></strong></td></tr>)}</tbody></table></details>;
}

function Sources({ result }: { result: PlanningResult }) {
  return <details className="card"><summary>계산 근거와 데이터 출처</summary><div className="stack" style={{ gap: 10, marginTop: 14 }}>{result.quotes.map((quote) => <div key={quote.id}><div className="small bold">{quote.market} <code>{quote.address}</code></div><SourceLine s={quote.source} /></div>)}{result.swapQuote && <div><div className="small bold">SunSwap USDT↔TRX 전환 풀 <code>{result.swapQuote.pair}</code></div><SourceLine s={result.swapQuote.source} /></div>}{result.costBasis && <div><div className="small bold">거래비용 근거: Energy {result.costBasis.energyFeeSun} sun · Bandwidth {result.costBasis.bandwidthFeeSun} sun</div><SourceLine s={result.costBasis.source} /></div>}</div></details>;
}
