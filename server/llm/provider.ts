import { Decimal } from "../../shared/units";
import type { ChatMessage, NeedsPatch, PlanningResult, UserNeeds } from "../../shared/schemas";

// 공급자 공통 계약. 앱은 이 두 기능만 쓴다. 거래 생성·서명 기능은 모델에 주지 않는다.

export interface ExtractResult {
  patch: NeedsPatch;
  latencyMs: number;
}

export interface LlmProvider {
  name: string;
  model?: string;
  extractNeeds(messages: ChatMessage[], current: UserNeeds, today: string): Promise<ExtractResult>;
  explainPlans(result: Omit<PlanningResult, "explanation">): Promise<{ text: string; latencyMs: number }>;
}

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: "auth" | "timeout" | "format" | "rate_limit" | "server" | "network" | "config",
  ) {
    super(message);
  }
}

export const EXTRACT_SYSTEM_PROMPT = (today: string, current: UserNeeds) => `너는 TRON 자산 계획 앱의 입력 추출기다. 사용자의 한국어 문장에서 **명시된 정보만** JSON으로 추출한다.
오늘 날짜(Asia/Seoul): ${today}. 운용 시작일은 오늘이다.
현재까지 확인된 입력: ${JSON.stringify({
  amount: current.amount,
  asset: current.asset,
  endDate: current.endDate,
  expenses: current.expenses.map((e) => ({ date: e.date, amount: e.amount, asset: e.asset })),
  bufferAmount: current.bufferAmount,
  riskProfile: current.riskProfile,
  acceptUsddRisk: current.acceptUsddRisk,
})}

규칙:
- 금액·날짜·금리를 추측하거나 계산하지 않는다. 사용자가 말하지 않은 필드는 null.
- 금액은 쉼표 없는 숫자 문자열 ("1,000 USDT" → "1000").
- 사용자가 보유하거나 운용한다고 말한 자산의 단위는 asset에 넣는다. 지출에 필요한 자산 단위와 혼동하지 않는다. 예: "10000 TRX를 운용하고 100일 뒤 1000 USDT가 필요" → asset="TRX", amount="10000", expenses[0].asset="USDT".
- 운용 기간이 "30일", "한 달"처럼 상대값이면 durationDays(정수, 한 달=30). 날짜로 말하면 endDate(YYYY-MM-DD).
- 지출은 "7일 뒤"면 inDays=7, 날짜면 date. 사용자가 지출을 새로 말하거나 바꾸면 **변경 후 전체 지출 목록**을 expenses에 넣는다 (기존 지출 중 유지되는 것도 포함).
- "지출 없음"이면 noExpenses=true.
- 여유액/비상금을 말하면 bufferAmount. "없음"/"0"이면 "0".
- 위험 성향: 보수적/안정 → "conservative", 균형/중립 → "balanced", 공격적 → "aggressive".
- USDD 위험 질문에 "예/감수/괜찮다"면 acceptUsddRisk=true, "아니오/싫다"면 false.
- 다른 설명 없이 아래 형식의 JSON 객체 하나만 출력한다.

{"asset":"USDT"|"TRX"|null,"amount":string|null,"durationDays":number|null,"endDate":string|null,"expenses":[{"inDays":number|null,"date":string|null,"amount":string,"asset":string|null,"label":string|null}]|null,"noExpenses":boolean|null,"bufferAmount":string|null,"riskProfile":"conservative"|"balanced"|"aggressive"|null,"acceptUsddRisk":boolean|null}`;

export const EXPLAIN_SYSTEM_PROMPT = `너는 TRON 자산 계획 앱의 설명 담당이다. 코드가 계산해 검증한 결과(JSON)만 근거로 한국어로 설명한다.
규칙:
- JSON에 없는 숫자·금리·비용·계약 주소를 만들지 않는다. 숫자는 JSON에 적힌 값을 **글자 그대로** 인용한다 (새로 계산하거나 단위를 바꾸지 않는다). 숫자가 검증에서 어긋나면 설명이 폐기된다.
- 추천 계획과 그 이유, 지출 재원을 먼저 확보한 이유, 왕복 거래비용이 결과를 바꾸는지를 설명한다. eligibility가 "ineligible"인 계획만 "제외"라고 말하고, 그 사유(reasons)를 설명한다.
- 날짜별 계획이 있으면 지출일마다 보유/예치 경로가 달라지는 이유와 인출 준비일을 설명한다. 지출 예정액이 예치된 경우 "처음부터 전액 확보했다"고 표현하지 않는다.
- 수익을 보장하는 표현을 쓰지 않는다. "조건부 분석"임을 밝힌다.
- 4~6문장, 마크다운 없이 평문.`;

const r2 = (v?: string) => (v === undefined ? undefined : new Decimal(v).toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());

/**
 * 설명 문장 속 숫자가 모두 계산 결과에 있는 값인지 검사한다.
 * 모델이 만든 수치가 섞이면 설명을 쓰지 않고 템플릿으로 대체한다.
 */
export function unknownNumbers(text: string, data: unknown): string[] {
  const allowed = new Set<string>();
  const add = (n: Decimal) => {
    for (let dp = 0; dp <= 4; dp++) {
      allowed.add(n.toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed());
      allowed.add(n.toDecimalPlaces(dp, Decimal.ROUND_DOWN).toFixed());
    }
    allowed.add(n.abs().toDecimalPlaces(2, Decimal.ROUND_HALF_UP).toFixed());
    if (n.abs().lt(1)) for (let dp = 0; dp <= 4; dp++) allowed.add(n.mul(100).toDecimalPlaces(dp, Decimal.ROUND_HALF_UP).toFixed()); // 금리 %
  };
  const walk = (v: unknown) => {
    if (typeof v === "number") add(new Decimal(v));
    else if (typeof v === "string") for (const m of v.match(/-?\d+(?:\.\d+)?/g) ?? []) add(new Decimal(m));
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") Object.values(v).forEach(walk);
  };
  walk(data);
  const bad: string[] = [];
  for (const raw of text.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? []) {
    const n = raw.replace(/,/g, "");
    if (!/^-?\d+(\.\d+)?$/.test(n)) continue;
    const d = new Decimal(n);
    if (d.abs().lte(3) && d.isInteger()) continue; // "계획 A/B", 순서 등 작은 정수
    if (!allowed.has(d.toFixed()) && !allowed.has(d.abs().toFixed())) bad.push(raw);
  }
  return bad;
}

/** 설명용으로 계산 결과를 압축한다 (원본 quote 전체를 보내지 않음). 숫자는 인용하기 쉽게 반올림한다. */
export function compactForExplain(r: Omit<PlanningResult, "explanation">) {
  return {
    chain: r.chain,
    asset: r.plans[0]?.asset ?? r.needs.asset,
    funding: r.funding,
    principal: r.needs.amount,
    horizonDays: r.plans[0]?.horizonDays,
    reserved: r.reserved,
    investable: r.investable,
    recommendation: { plan: r.plans.find((p) => p.id === r.recommendation.planId)?.title, reason: r.recommendation.reason },
    naiveComparison: r.naiveComparison ? { ...r.naiveComparison, netReturn: r2(r.naiveComparison.netReturn) } : undefined,
    plans: r.plans.map((p) => ({
      title: p.title,
      eligibility: p.eligibility,
      reasons: p.reasons,
      invested: p.allocation.invested,
      baseRatePercent: p.baseRate ? new Decimal(p.baseRate).mul(100).toDecimalPlaces(4, Decimal.ROUND_HALF_UP).toFixed() : undefined,
      rateType: p.rateType,
      baseYield: r2(p.baseYield),
      rewards: p.rewards.status,
      costsInAsset: r2(p.costs.inAsset),
      costsTrx: r2(p.costs.trx),
      conversionFees: r2(p.costs.conversionFees),
      netReturn: r2(p.netReturn) ?? "산정 불가",
      breakEvenDays: p.breakEvenDays ? new Decimal(p.breakEvenDays).ceil().toFixed() : "산정 불가",
      recommended: p.recommended,
      dataModes: p.dataModes,
      ladder: p.ladder?.map((b) => ({ needDate: b.needDate, exitStartDate: b.exitStartDate, amount: b.amount, product: b.product, expectedYield: r2(b.expectedYield) })),
    })),
    warnings: r.warnings,
  };
}
