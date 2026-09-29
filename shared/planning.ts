import { Decimal } from "./units";
import { daysBetween, reservedWithinHorizon } from "./needs";
import { dataIssues, lendingIssues, psmIssues } from "./eligibility";
import { buildLadderPlan, buildStakingBaseline } from "./ladder";
import { prepareMainnetFunding, trxHoldCost } from "./funding";
import type { CostBasis, DataMode, Plan, PlanCosts, PlanStep, PlanningResult, ProductQuote, SwapQuote, UserNeeds } from "./schemas";

export const ENGINE_VERSION = "planning-2.2.0";

/**
 * 거래 유형별 일반 Energy/Bandwidth 사용량.
 * 출처: JustLend 공식 MCP 서버 src/core/services/lending.ts (TYPICAL_RESOURCES).
 * PSM 전환은 최근 성공 거래 실측값(CostBasis.psmEnergy)을 쓴다.
 */
export const TYPICAL_RESOURCES = {
  approve: { energy: 23000, bandwidth: 265 },
  supply_trx: { energy: 80000, bandwidth: 280 },
  supply_trc20: { energy: 100000, bandwidth: 310 },
  withdraw: { energy: 90000, bandwidth: 300 },
  psm: { bandwidth: 345 },
} as const;
const JUSTLEND_RES_SRC = "JustLend MCP TYPICAL_RESOURCES (일반값)";

const ZERO = new Decimal(0);

/** 기본 수익: APY면 복리, APR이면 단리 */
export function baseYield(principal: Decimal, rate: Decimal, rateType: "APY" | "APR", days: number): Decimal {
  if (principal.lte(0) || days <= 0) return ZERO;
  if (rateType === "APY") return principal.mul(rate.plus(1).pow(new Decimal(days).div(365)).minus(1));
  return principal.mul(rate).mul(days).div(365);
}

/** 고정 금리·비용 가정에서 기본 수익이 비용을 넘는 데 필요한 일수 */
export function breakEvenDays(principal: Decimal, rate: Decimal, rateType: "APY" | "APR", cost: Decimal): Decimal | undefined {
  if (principal.lte(0) || rate.lte(0)) return undefined;
  if (cost.lte(0)) return ZERO;
  if (rateType === "APY") return new Decimal(365).mul(cost.div(principal).plus(1).ln()).div(rate.plus(1).ln());
  return cost.mul(365).div(principal.mul(rate));
}

export function stepCosts(steps: PlanStep[], basis: CostBasis | undefined, evalAsset: "USDT" | "TRX", conversionFees = ZERO): PlanCosts {
  const energy = steps.reduce((s, x) => s + x.energy, 0);
  const bandwidth = steps.reduce((s, x) => s + x.bandwidth, 0);
  if (!basis) return { energy, bandwidth, trx: "0", inAsset: undefined, conversionFees: conversionFees.toFixed() };
  const trx = new Decimal(energy * basis.energyFeeSun + bandwidth * basis.bandwidthFeeSun).div(1_000_000);
  let inAsset: Decimal | undefined;
  if (evalAsset === "TRX") inAsset = trx;
  else if (basis.trxPerUsdt && new Decimal(basis.trxPerUsdt).gt(0)) inAsset = trx.div(basis.trxPerUsdt);
  return { energy, bandwidth, trx: trx.toFixed(), inAsset: inAsset?.toFixed(), conversionFees: conversionFees.toFixed() };
}

const step = (
  action: PlanStep["action"],
  label: string,
  asset: string,
  amount: Decimal,
  res: { energy: number; bandwidth: number },
  energySource: string,
  contract?: string,
): PlanStep => ({ action, label, asset, amount: amount.toFixed(), contract, energy: res.energy, bandwidth: res.bandwidth, energySource });

function modesOf(...qs: (ProductQuote | undefined)[]): DataMode[] {
  return [...new Set(qs.filter(Boolean).map((q) => q!.source.mode))];
}

export interface MainnetInputs {
  jusdt?: ProductQuote;
  jusdd?: ProductQuote;
  psm?: ProductQuote;
  staking?: ProductQuote;
  swap?: SwapQuote;
  costBasis?: CostBasis;
}

/** Mainnet baselines and dated allocation. Results are conditional projections. */
export function buildMainnetPlans(needs: UserNeeds, inputs: MainnetInputs, now = new Date(), idPrefix = "m"): Omit<PlanningResult, "explanation"> {
  let gasReserve = ZERO;
  let funding = prepareMainnetFunding(needs, inputs.swap, inputs.costBasis, now, gasReserve);
  if (funding) {
    let result = buildMainnetPlans(funding.needs, inputs, now, idPrefix);
    if (needs.asset === "TRX") {
      for (let attempt = 0; attempt < 3; attempt++) {
        const ladder = result.plans.find((plan) => plan.key === "L");
        const required = new Decimal(ladder?.costs.trx ?? 0);
        if (required.lte(gasReserve)) break;
        gasReserve = required;
        funding = prepareMainnetFunding(needs, inputs.swap, inputs.costBasis, now, gasReserve)!;
        result = buildMainnetPlans(funding.needs, inputs, now, idPrefix);
      }
      if (new Decimal(result.plans.find((plan) => plan.key === "L")?.costs.trx ?? 0).gt(gasReserve))
        throw new Error("예상 네트워크 비용 준비금이 계산 중 변했습니다. 다시 계산해 주세요.");
    }
    const conversionLoss = new Decimal(funding.conversionLossUsdt);
    const networkFee = new Decimal(funding.networkFeeUsdt);
    for (const plan of result.plans) {
      if (plan.key === "HOLD") plan.title = "기준선: 필수 전환 후 보유";
      plan.steps = [...funding.steps, ...plan.steps].sort((left, right) => (left.day ?? 0) - (right.day ?? 0));
      plan.costs = {
        ...plan.costs,
        trx: new Decimal(plan.costs.trx).plus(funding.networkFeeTrx).toFixed(),
        inAsset: plan.costs.inAsset === undefined ? undefined : new Decimal(plan.costs.inAsset).plus(networkFee).toFixed(),
        conversionFees: new Decimal(plan.costs.conversionFees).plus(conversionLoss).toFixed(),
      };
      if (plan.netReturn !== undefined) plan.netReturn = new Decimal(plan.netReturn).minus(conversionLoss).minus(networkFee).toFixed();
      plan.assumptions = [funding.note, ...plan.assumptions];
      if (inputs.swap?.source.mode !== "live" && plan.eligibility === "eligible") plan.eligibility = "conditional";
    }
    if (needs.asset === "TRX" && inputs.swap && inputs.costBasis) {
      const hold = result.plans.find((plan) => plan.key === "HOLD")!;
      const cost = trxHoldCost(needs, inputs.swap, inputs.costBasis);
      hold.title = "기준선: 필요한 USDT만 전환하고 TRX 보유";
      hold.principal = funding.valuedInputUsdt;
      hold.allocation = { invested: "0", held: funding.valuedInputUsdt };
      hold.steps = cost.steps;
      hold.costs = {
        energy: cost.steps.reduce((sum, item) => sum + item.energy, 0),
        bandwidth: cost.steps.reduce((sum, item) => sum + item.bandwidth, 0),
        trx: cost.feeTrx.toFixed(), inAsset: cost.feeUsdt.toFixed(), conversionFees: cost.loss.toFixed(),
      };
      hold.netReturn = cost.loss.neg().minus(cost.feeUsdt).toFixed();
      hold.eligibility = cost.steps.length && inputs.swap.source.mode !== "live" ? "conditional" : "eligible";
      hold.assumptions = ["USDT 지출분만 지금 TRX에서 전환하고 나머지 TRX는 보유합니다.", "미래 TRX 가격이 현재와 같다고 가정합니다."];
    }
    result.needs = needs;
    result.funding = {
      inputAsset: funding.inputAsset, inputAmount: funding.inputAmount, valuedInputUsdt: funding.valuedInputUsdt,
      reservedTrx: funding.reservedTrx, gasReserveTrx: funding.gasReserveTrx, entrySwapUsdt: funding.entrySwapUsdt,
      conversionLossUsdt: funding.conversionLossUsdt, networkFeeTrx: funding.networkFeeTrx,
      networkFeeUsdt: funding.networkFeeUsdt, trxPerUsdt: funding.trxPerUsdt, note: funding.note,
    };
    result.naiveComparison = undefined;
    result.warnings.push("TRX 지출은 현재 확보해 보유하고, 향후 TRX/USDT 가격은 변하지 않는다고 가정합니다. 전환 수수료와 풀 슬리피지는 포함했습니다.");
    if (needs.asset === "USDT" && new Decimal(funding.reservedTrx).gt(0)) result.warnings.push("TRX 지출 확보를 위한 최초 전환 수수료는 계산했지만, 이를 지불할 TRX 잔고는 별도로 필요합니다.");
    if (needs.asset === "TRX") result.warnings.push("TRX 시작 자산은 지출·네트워크 비용 준비금을 제외한 금액을 먼저 USDT로 바꿔 세 경로에 배분합니다. 보유 TRX를 바로 스테이킹하는 경로는 아직 비교하지 않습니다.");
    const selected = recommend(result.plans.filter((plan) => plan.key === "L" || plan.key === "HOLD"));
    for (const plan of result.plans) plan.recommended = plan.id === selected.plan.id;
    result.recommendation = { planId: selected.plan.id, reason: selected.reason };
    return result;
  }
  const { jusdt, jusdd, psm, staking, costBasis } = inputs;
  const amount = new Decimal(needs.amount ?? 0);
  const days = needs.endDate ? daysBetween(needs.startDate, needs.endDate) : 0;
  const reserved = reservedWithinHorizon(needs);
  const investable = Decimal.max(amount.minus(reserved.total), 0);
  const warnings: string[] = [];
  if (!costBasis) warnings.push("체인 수수료 파라미터를 조회하지 못해 거래비용과 순수익을 산정할 수 없습니다.");
  else if (!costBasis.trxPerUsdt) warnings.push("TRX→USDT 환산 근거가 없어 순수익을 산정할 수 없습니다.");
  if (reserved.outside.length)
    warnings.push(`운용 기간 밖 지출 ${reserved.outside.map((e) => `${e.date} ${e.amount} ${e.asset}`).join(", ")}은 이번 기간에 확보하지 않습니다.`);

  const base = {
    chain: "mainnet" as const,
    asset: needs.asset,
    inputVersion: needs.version,
    horizonDays: days,
    principal: amount.toFixed(),
    label: "조건부 분석" as const,
    recommended: false,
  };
  const commonAssumptions = [
    `지출 재원 ${reserved.total.toFixed()} ${needs.asset}은 처음부터 예치하지 않고 보유합니다.`,
    "조회 시점의 금리가 운용 기간 내내 유지된다고 가정합니다 (보장 아님).",
    "Energy를 스테이킹하지 않고 TRX 소각으로 지불한다고 가정합니다. 대역폭 무료 한도는 반영하지 않았습니다.",
  ];

  // ---------------- Plan A: USDT → jUSDT
  const planA = ((): Plan => {
    const q = jusdt;
    const steps = [
      step("hold", "지출 재원 보유", "USDT", reserved.total, { energy: 0, bandwidth: 0 }, "-"),
      step("approve", "USDT 사용 승인 (jUSDT)", "USDT", investable, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, q?.address),
      step("supply", "JustLend jUSDT 예치", "USDT", investable, TYPICAL_RESOURCES.supply_trc20, JUSTLEND_RES_SRC, q?.address),
      step("withdraw", "만기 인출 jUSDT → USDT", "USDT", investable, TYPICAL_RESOURCES.withdraw, JUSTLEND_RES_SRC, q?.address),
    ];
    const rate = q?.baseRate ? new Decimal(q.baseRate) : undefined;
    const rt = q?.rateType ?? "APY";
    const yieldA = rate ? baseYield(investable, rate, rt, days) : ZERO;
    const costs = stepCosts(steps, costBasis, "USDT");
    const net = costs.inAsset !== undefined && rate ? yieldA.minus(costs.inAsset) : undefined;
    const di = dataIssues(q, "mainnet", now);
    const blocking = [...di.blocking, ...lendingIssues(q, investable)];
    if (investable.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    const conditional = [...di.conditional];
    if (net === undefined) conditional.push("비용 또는 TRX 환산 근거가 없어 순수익 산정 불가입니다.");
    return {
      ...base,
      id: `${idPrefix}-A`,
      key: "A",
      title: "A. USDT 예치 (JustLend jUSDT)",
      allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
      steps,
      baseRate: q?.baseRate,
      rateType: rt,
      baseYield: yieldA.toFixed(),
      rewards: q?.rewards ?? { status: "unverified", note: "보상 데이터를 확인하지 못했습니다." },
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(investable, rate, rt, new Decimal(costs.inAsset))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      risks: ["JustLend 시장 인출 유동성 부족 시 지연", "금리 변동", "스마트 계약 위험"],
      assumptions: commonAssumptions,
      quoteIds: q ? [q.id] : [],
      dataModes: modesOf(q),
    };
  })();

  // ---------------- Plan B: USDT → PSM → USDD → jUSDD (출구 역순)
  const planB = ((): Plan => {
    const feeIn = psm?.psm ? new Decimal(psm.psm.feeIn) : ZERO;
    const feeOut = psm?.psm ? new Decimal(psm.psm.feeOut) : ZERO;
    const usddIn = investable.mul(new Decimal(1).minus(feeIn));
    const rate = jusdd?.baseRate ? new Decimal(jusdd.baseRate) : undefined;
    const rt = jusdd?.rateType ?? "APY";
    const yieldUsdd = rate ? baseYield(usddIn, rate, rt, days) : ZERO;
    const usddOut = usddIn.plus(yieldUsdd);
    const usdtBack = usddOut.mul(new Decimal(1).minus(feeOut));
    // PSM 자체는 수익원이 아니다. 전환 수수료는 비용으로 분리해 보인다.
    const conversionFees = investable.minus(usddIn).plus(usddOut.minus(usdtBack));
    const pe = costBasis?.psmEnergy;
    const psmSrc = pe ? `PSM 최근 성공 거래 ${pe.sampleSize}건 실측 최대값` : "미확인";
    const steps = [
      step("hold", "지출 재원 보유", "USDT", reserved.total, { energy: 0, bandwidth: 0 }, "-"),
      step("approve", "USDT 사용 승인 (PSM)", "USDT", investable, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_sell", "PSM 전환 USDT → USDD", "USDT", investable, { energy: pe?.sell ?? 0, bandwidth: TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
      step("approve", "USDD 사용 승인 (jUSDD)", "USDD", usddIn, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, jusdd?.address),
      step("supply", "JustLend jUSDD 예치", "USDD", usddIn, TYPICAL_RESOURCES.supply_trc20, JUSTLEND_RES_SRC, jusdd?.address),
      step("withdraw", "만기 인출 jUSDD → USDD", "USDD", usddOut, TYPICAL_RESOURCES.withdraw, JUSTLEND_RES_SRC, jusdd?.address),
      step("approve", "USDD 사용 승인 (PSM 출구)", "USDD", usddOut, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC, psm?.address),
      step("psm_buy", "PSM 전환 USDD → USDT", "USDD", usddOut, { energy: pe?.buy ?? 0, bandwidth: TYPICAL_RESOURCES.psm.bandwidth }, psmSrc, psm?.address),
    ];
    const costs = stepCosts(steps, costBasis, "USDT", conversionFees);
    const net = costs.inAsset !== undefined && rate && pe ? yieldUsdd.minus(conversionFees).minus(costs.inAsset) : undefined;
    const blocking: string[] = [];
    if (needs.acceptUsddRisk !== true) blocking.push("사용자가 USDD 가격 변동 위험을 받아들이지 않아 추천 후보에서 제외합니다.");
    if (needs.riskProfile === "conservative") blocking.push("보수적 성향에서는 USDD 전환 경로를 비교하지 않습니다.");
    const d1 = dataIssues(jusdd, "mainnet", now);
    const d2 = dataIssues(psm, "mainnet", now);
    blocking.push(...d1.blocking, ...d2.blocking, ...lendingIssues(jusdd, usddIn), ...psmIssues(psm, investable));
    if (!pe) blocking.push("PSM 전환 거래비용(Energy)을 확인하지 못했습니다.");
    if (investable.lte(0)) blocking.push("지출 재원을 빼면 운용 가능한 금액이 없습니다.");
    const conditional = [...new Set([...d1.conditional, ...d2.conditional])];
    if (net === undefined) conditional.push("비용·환산 근거가 부족해 순수익 산정 불가입니다.");
    const stress =
      net !== undefined
        ? [
            { label: "출구 시 USDD 0.5% 디페깅 (PSM 출구 불가, 시장 매도)", netReturn: net.minus(usddOut.mul("0.005")).toFixed() },
            { label: "출구 시 USDD 2% 디페깅", netReturn: net.minus(usddOut.mul("0.02")).toFixed() },
          ]
        : undefined;
    return {
      ...base,
      id: `${idPrefix}-B`,
      key: "B",
      title: "B. USDD 경로 (PSM 전환 → JustLend jUSDD)",
      allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
      steps,
      baseRate: jusdd?.baseRate,
      rateType: rt,
      baseYield: yieldUsdd.toFixed(),
      rewards: jusdd?.rewards ?? { status: "unverified", note: "보상 데이터를 확인하지 못했습니다." },
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays:
        rate && costs.inAsset ? breakEvenDays(usddIn, rate, rt, new Decimal(costs.inAsset).plus(conversionFees))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
      reasons: [...blocking, ...conditional],
      risks: ["USDD 디페깅(가격 이탈)", "PSM 출구 물량 부족", "전환 단계가 많아 거래비용 증가", "스마트 계약 위험 (PSM + JustLend)"],
      assumptions: [
        ...commonAssumptions,
        "PSM은 전환 경로일 뿐 수익원이 아닙니다. 이자는 jUSDD 예치에서만 발생합니다.",
        "USDD→USDT 출구 시 PSM이 정상 1:1(수수료 제외) 전환된다고 가정합니다. 디페깅은 스트레스 결과로 따로 봅니다.",
      ],
      stress,
      quoteIds: [jusdd, psm].filter(Boolean).map((q) => q!.id),
      dataModes: modesOf(jusdd, psm),
    };
  })();

  const hold: Plan = {
    ...base,
    id: `${idPrefix}-HOLD`,
    key: "HOLD",
    title: "기준선: 전액 보유",
    allocation: { invested: "0", held: amount.toFixed() },
    steps: [step("hold", "전액 보유", needs.asset, amount, { energy: 0, bandwidth: 0 }, "-")],
    baseYield: "0",
    rewards: { status: "none", note: "예치하지 않으므로 보상이 없습니다." },
    costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "0", conversionFees: "0" },
    netReturn: "0",
    eligibility: "eligible",
    reasons: [],
    risks: ["수익 없음"],
    assumptions: ["거래하지 않으므로 비용이 없습니다."],
    quoteIds: [],
    dataModes: [],
  };

  const planC = buildStakingBaseline(needs, inputs, { A: planA, B: planB }, base, idPrefix, now);
  const planL = buildLadderPlan(needs, inputs, { A: planA, B: planB, C: planC }, base, idPrefix);
  const plans = [planL, planA, planB, planC, hold];
  const rec = recommend([planL, hold]);
  rec.plan.recommended = true;

  // 차별점 비교: 지출 일정·비용을 무시하고 최고 APY에 전액 예치했다면
  const naive = naiveComparison(needs, amount, days, [jusdt, jusdd], costBasis, reserved.inside.length);

  return {
    id: `${idPrefix}-${now.getTime()}`,
    chain: "mainnet",
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    needs,
    reserved: {
      total: reserved.total.toFixed(),
      expensesInHorizon: reserved.expenses.toFixed(),
      buffer: reserved.buffer.toFixed(),
      outsideHorizon: reserved.outside,
    },
    investable: investable.toFixed(),
    plans,
    recommendation: { planId: rec.plan.id, reason: rec.reason },
    naiveComparison: naive,
    quotes: [jusdt, jusdd, psm, staking].filter(Boolean) as ProductQuote[],
    swapQuote: inputs.swap,
    costBasis,
    warnings,
  };
}

function recommend(plans: Plan[]): { plan: Plan; reason: string } {
  const hold = plans.find((p) => p.key === "HOLD" || p.key.startsWith("HOLD"))!;
  const candidates = plans.filter((p) => p !== hold && p.eligibility !== "ineligible" && p.netReturn !== undefined);
  const best = candidates.sort((a, b) => new Decimal(b.netReturn!).cmp(a.netReturn!))[0];
  if (best && new Decimal(best.netReturn!).gt(hold.netReturn ?? "0")) {
    return { plan: best, reason: `${best.title}의 예상 순수익이 비용을 빼고도 가장 큽니다 (조건부 분석).` };
  }
  const unknown = plans.some((p) => p !== hold && p.eligibility !== "ineligible" && p.netReturn === undefined);
  if (unknown) return { plan: hold, reason: "비용 또는 환산 근거를 확인하지 못해 순수익 순위를 매길 수 없습니다. 실행 권고를 보류하고 보유를 기준으로 둡니다." };
  if (best) return { plan: hold, reason: "운용 경로의 예상 손익이 필수 지출만 전환해 보유하는 기준선보다 크지 않습니다. 추가 거래를 보류합니다." };
  return { plan: hold, reason: "실행 조건을 통과한 예치 경로가 없습니다. 보유를 권고합니다." };
}

function naiveComparison(
  needs: UserNeeds,
  amount: Decimal,
  days: number,
  quotes: (ProductQuote | undefined)[],
  basis: CostBasis | undefined,
  expenseCount: number,
) {
  const best = quotes.filter((q) => q?.baseRate).sort((a, b) => new Decimal(b!.baseRate!).cmp(a!.baseRate!))[0];
  if (!best || amount.lte(0)) return undefined;
  const y = baseYield(amount, new Decimal(best.baseRate!), best.rateType ?? "APY", days);
  // 지출마다 중도 인출 거래가 추가된다.
  const steps: PlanStep[] = [
    step("approve", "", "", amount, TYPICAL_RESOURCES.approve, JUSTLEND_RES_SRC),
    step("supply", "", "", amount, TYPICAL_RESOURCES.supply_trc20, JUSTLEND_RES_SRC),
    ...Array.from({ length: expenseCount + 1 }, () => step("withdraw", "", "", amount, TYPICAL_RESOURCES.withdraw, JUSTLEND_RES_SRC)),
  ];
  const c = stepCosts(steps, basis, "USDT");
  return {
    title: `최고 APY(${best.market})에 ${amount.toFixed()} ${needs.asset} 전액 예치`,
    description:
      expenseCount > 0
        ? `지출일마다 중도 인출이 필요하고(인출 ${expenseCount + 1}회), 그날 시장 유동성이 부족하면 지출 재원을 제때 꺼내지 못할 수 있습니다.`
        : "지출은 없지만 거래비용을 고려하지 않고 APY만 보고 고른 결과입니다.",
    netReturn: c.inAsset !== undefined ? y.minus(c.inAsset).toFixed() : undefined,
  };
}

// ======================================================================= Nile

export interface NileInputs {
  jtrx?: ProductQuote;
  costBasis?: CostBasis;
  /** 지갑에서 읽은 실제 TRX 잔고. 없으면 입력 금액(가정)을 쓴다 */
  walletBalanceTrx?: string;
}

/** Nile jTRX 두 배분안. 실제 잔고·수수료 재원에 맞춰 예치액을 줄인다. */
export function buildNilePlans(needs: UserNeeds, inputs: NileInputs, now = new Date(), idPrefix = "n"): Omit<PlanningResult, "explanation"> {
  const { jtrx, costBasis } = inputs;
  const days = needs.endDate ? daysBetween(needs.startDate, needs.endDate) : 30;
  const total = new Decimal(inputs.walletBalanceTrx ?? needs.amount ?? 0);
  const reserved = reservedWithinHorizon(needs);
  const warnings: string[] = [];
  if (!inputs.walletBalanceTrx) warnings.push("지갑이 연결되지 않아 입력한 보유액을 가정으로 사용했습니다. 실행 전에 실제 잔고로 다시 계산합니다.");

  const depositRes = TYPICAL_RESOURCES.supply_trx;
  const withdrawRes = TYPICAL_RESOURCES.withdraw;
  const feeBudget = costBasis
    ? new Decimal((depositRes.energy + withdrawRes.energy) * costBasis.energyFeeSun + (depositRes.bandwidth + withdrawRes.bandwidth) * costBasis.bandwidthFeeSun).div(1_000_000)
    : new Decimal(0);
  const maxDeposit = Decimal.max(total.minus(reserved.total).minus(feeBudget), 0);

  const variants: { key: Plan["key"]; share: Decimal; title: string }[] = [
    { key: "NILE_80", share: total.minus(reserved.total), title: "최대 예치안 (지출 재원만 보유)" },
    { key: "NILE_50", share: total.mul("0.5"), title: "절반 예치안 (50% 보유)" },
  ];

  const plans: Plan[] = variants.map(({ key, share, title }) => {
    const intended = Decimal.max(share, 0);
    const deposit = Decimal.min(intended, maxDeposit).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const steps = [
      step("hold", "지출 재원·수수료 재원 보유", "TRX", total.minus(deposit), { energy: 0, bandwidth: 0 }, "-"),
      step("supply", "JustLend jTRX 예치 (mint)", "TRX", deposit, depositRes, JUSTLEND_RES_SRC, jtrx?.address),
      step("withdraw", "인출 (redeem)", "TRX", deposit, withdrawRes, JUSTLEND_RES_SRC, jtrx?.address),
    ];
    const rate = jtrx?.baseRate ? new Decimal(jtrx.baseRate) : undefined;
    const rt = jtrx?.rateType ?? "APR";
    const y = rate ? baseYield(deposit, rate, rt, days) : ZERO;
    const costs = stepCosts(steps, costBasis, "TRX");
    const net = costs.inAsset !== undefined && rate ? y.minus(costs.inAsset) : undefined;
    const di = dataIssues(jtrx, "nile", now);
    const blocking = [...di.blocking, ...lendingIssues(jtrx, deposit)];
    if (deposit.lte(0)) blocking.push("지출 재원과 수수료 재원을 빼면 예치할 TRX가 없습니다.");
    const reasons = [...blocking, ...di.conditional];
    if (deposit.lt(intended)) reasons.push(`수수료 재원 ${feeBudget.toFixed(2)} TRX를 남기기 위해 예치액을 ${intended.toFixed(2)} → ${deposit.toFixed(2)} TRX로 줄였습니다.`);
    const negative = net !== undefined && net.lte(0);
    return {
      id: `${idPrefix}-${key}`,
      key,
      title,
      chain: "nile",
      asset: "TRX",
      inputVersion: needs.version,
      horizonDays: days,
      principal: total.toFixed(),
      allocation: { invested: deposit.toFixed(), held: total.minus(deposit).toFixed() },
      steps,
      baseRate: jtrx?.baseRate,
      rateType: rt,
      baseYield: y.toFixed(),
      rewards: { status: "none", note: "Nile 테스트넷 보상은 계산하지 않습니다." },
      costs,
      netReturn: net?.toFixed(),
      breakEvenDays: rate && costs.inAsset ? breakEvenDays(deposit, rate, rt, new Decimal(costs.inAsset))?.toFixed() : undefined,
      eligibility: blocking.length ? "ineligible" : di.conditional.length ? "conditional" : "eligible",
      reasons,
      risks: ["테스트 토큰이며 실제 가치가 없습니다", "Nile 네트워크 상태에 따라 확정이 지연될 수 있습니다", "스마트 계약 위험"],
      assumptions: [
        "Nile jTRX 계약에서 읽은 supplyRatePerBlock × 연간 블록 수(10,512,000)로 APR을 계산했습니다.",
        "테스트 TRX 수익은 실제 USDT 수익으로 환산하지 않습니다. Mainnet 계획의 실행 증거가 아닙니다.",
      ],
      recommended: false,
      quoteIds: jtrx ? [jtrx.id] : [],
      dataModes: modesOf(jtrx),
      label: negative ? "개발자 테스트 실행" : "Nile 실행 계획",
    };
  });

  const hold: Plan = {
    id: `${idPrefix}-HOLD`,
    key: "HOLD",
    title: "기준선: 전액 보유",
    chain: "nile",
    asset: "TRX",
    inputVersion: needs.version,
    horizonDays: days,
    principal: total.toFixed(),
    allocation: { invested: "0", held: total.toFixed() },
    steps: [step("hold", "전액 보유", "TRX", total, { energy: 0, bandwidth: 0 }, "-")],
    baseYield: "0",
    rewards: { status: "none", note: "-" },
    costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "0", conversionFees: "0" },
    netReturn: "0",
    eligibility: "eligible",
    reasons: [],
    risks: ["수익 없음"],
    assumptions: [],
    recommended: false,
    quoteIds: [],
    dataModes: [],
    label: "Nile 실행 계획",
  };
  const all = [...plans, hold];
  const rec = recommend(all);
  rec.plan.recommended = true;
  if (rec.plan === hold) warnings.push("순수익이 0 이하라 경제적으로는 보유가 유리합니다. 예치는 '개발자 테스트 실행'으로만 진행합니다.");

  return {
    id: `${idPrefix}-${now.getTime()}`,
    chain: "nile",
    createdAt: now.toISOString(),
    engineVersion: ENGINE_VERSION,
    needs,
    reserved: {
      total: reserved.total.toFixed(),
      expensesInHorizon: reserved.expenses.toFixed(),
      buffer: reserved.buffer.toFixed(),
      outsideHorizon: reserved.outside,
    },
    investable: maxDeposit.toFixed(),
    plans: all,
    recommendation: { planId: rec.plan.id, reason: rec.reason },
    quotes: jtrx ? [jtrx] : [],
    costBasis,
    warnings,
  };
}
