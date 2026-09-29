import { Decimal } from "./units";
import { todaySeoul } from "./needs";
import type { Plan, PlanningResult } from "./schemas";

export type GoalAction = "keep" | "pause" | "review";
export interface GoalAssessment {
  action: GoalAction;
  headline: string;
  reasons: string[];
  previousNet?: string;
  currentNet?: string;
  netChange?: string;
  selectedPlanTitle: string;
  checkedAt: string;
  sourceMode: "live" | "synthetic" | "snapshot" | "unavailable";
  sources: { market: string; url: string; fetchedAt: string; mode: string }[];
}

const selected = (result: PlanningResult, key: Plan["key"]) => result.plans.find((p) => p.key === key);

/** 저장한 목표와 최신 계획을 비교한다. 모델이 아닌 결정적 코드가 행동을 판정한다. */
export function assessGoal(baseline: PlanningResult, current: PlanningResult, key: Plan["key"]): GoalAssessment {
  const before = selected(baseline, key);
  const after = selected(current, key);
  if (!before || !after || baseline.chain !== current.chain) throw new Error("같은 체인·계획의 결과만 비교할 수 있습니다.");
  const reasons: string[] = [];
  let action: GoalAction = "keep";
  const mark = (next: GoalAction, reason: string) => {
    if (next === "pause" || action === "keep") action = next;
    reasons.push(reason);
  };
  if (baseline.needs.version !== current.needs.version) mark("review", "지출 일정 또는 사용자 조건이 바뀌어 기존 계획을 다시 확인해야 합니다.");
  if (baseline.reserved.total !== current.reserved.total) mark("review", `USDT 지출·예비금 확보액이 ${baseline.reserved.total} → ${current.reserved.total} ${after.asset}로 바뀌었습니다.`);
  if (baseline.funding?.reservedTrx !== current.funding?.reservedTrx) mark("review", `별도 확보할 TRX가 ${baseline.funding?.reservedTrx ?? "0"} → ${current.funding?.reservedTrx ?? "0"} TRX로 바뀌었습니다.`);
  if (before.allocation.invested !== after.allocation.invested) mark("review", `운용 대상 금액이 ${before.allocation.invested} → ${after.allocation.invested} ${after.asset}로 바뀌었습니다.`);
  if (before.ladder && after.ladder) {
    const signature = (p: Plan) => JSON.stringify(p.ladder?.map((b) => [b.id, b.needDate, b.exitStartDate, b.unstakeDate, b.amount, b.product, b.allocations.map((allocation) => [allocation.product, allocation.amount])]));
    if (signature(before) !== signature(after)) mark("review", "지출 날짜별 배분 또는 인출 준비 일정이 달라졌습니다.");
    const today = todaySeoul(new Date(current.createdAt));
    for (const bucket of before.ladder.filter((b) => b.id !== "buffer" && b.product !== "HOLD")) {
      if (bucket.needDate < today) mark("pause", `${bucket.needDate} 지출일이 지났습니다. 실제 인출과 지출 여부를 확인해야 합니다.`);
      else if (bucket.allocations.some((allocation) => allocation.product === "STAKE") && bucket.unstakeDate && bucket.unstakeDate <= today) mark("review", `${bucket.label}의 Stake 2.0 배분액은 해제 요청일(${bucket.unstakeDate})이 됐습니다. 해제를 실행하고 대기를 시작해야 합니다.`);
      else if (bucket.exitStartDate <= today) mark("review", `${bucket.label} ${bucket.amount} ${after.asset}의 인출 준비일(${bucket.exitStartDate})이 됐습니다. 실제 포지션·출구 물량을 확인하세요.`);
    }
  }
  if (before.netReturn !== undefined && after.netReturn !== undefined && new Decimal(after.netReturn).lt(before.netReturn)) {
    mark("review", `선택한 경로의 예상 순수익이 ${new Decimal(before.netReturn).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed()} → ${new Decimal(after.netReturn).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed()} ${after.asset}로 감소했습니다.`);
  }
  if (after.eligibility === "ineligible") mark("pause", `선택한 경로의 실행 조건이 충족되지 않습니다: ${after.reasons.join(" ")}`);
  if (after.netReturn === undefined) mark("pause", "최신 비용 또는 환산 근거가 없어 예상 순수익을 계산할 수 없습니다.");
  else if (key !== "HOLD" && new Decimal(after.netReturn).lte(0)) mark("pause", `최신 예상 순수익이 ${after.netReturn} ${after.asset}로 0 이하입니다.`);
  if (key !== "HOLD" && current.plans.find((p) => p.id === current.recommendation.planId)?.key === "HOLD") mark("pause", "최신 계산은 신규 예치보다 보유를 권합니다.");
  if (key === "HOLD" && current.plans.find((p) => p.id === current.recommendation.planId)?.key !== "HOLD") mark("review", "새로운 계획이 보유보다 유리할 수 있어 다시 비교할 가치가 있습니다.");
  if (!reasons.length) reasons.push("지출 확보액과 선택 경로의 실행 조건에 중요한 변화가 없습니다.");
  const modes = [...current.quotes.map((q) => q.source.mode), ...(current.swapQuote ? [current.swapQuote.source.mode] : [])];
  const sourceMode = modes.includes("synthetic") ? "synthetic" : modes.includes("snapshot") ? "snapshot" : modes.includes("live") ? "live" : "unavailable";
  if (sourceMode !== "live") reasons.push("현재 값은 실시간 검증 자료가 아니므로 실제 거래 판단에 사용하지 않습니다.");
  const headlines: Record<GoalAction, string> = { pause: "신규 예치 보류·기존 포지션 별도 확인", review: "계획 재검토 필요", keep: "현재 계획 유지" };
  const headline = headlines[action];
  return {
    action, headline, reasons, previousNet: before.netReturn, currentNet: after.netReturn,
    netChange: before.netReturn !== undefined && after.netReturn !== undefined ? new Decimal(after.netReturn).minus(before.netReturn).toFixed() : undefined,
    selectedPlanTitle: after.title, checkedAt: current.createdAt, sourceMode,
    sources: [...current.quotes.filter((q) => after.quoteIds.includes(q.id)).map((q) => ({ market: q.market, url: q.source.sourceUrl, fetchedAt: q.source.fetchedAt, mode: q.source.mode })), ...(current.funding && current.swapQuote ? [{ market: "SunSwap TRX/USDT", url: current.swapQuote.source.sourceUrl, fetchedAt: current.swapQuote.source.fetchedAt, mode: current.swapQuote.source.mode }] : [])],
  };
}
