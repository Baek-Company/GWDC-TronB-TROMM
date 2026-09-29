import { Decimal } from "./units";
import { addDays, daysBetween, reservedWithinHorizon } from "./needs";
import { baseYield, stepCosts, TYPICAL_RESOURCES, type MainnetInputs } from "./planning";
import { dataIssues, QUOTE_MAX_AGE_MS } from "./eligibility";
import type { LadderAllocation, LadderBucket, Plan, PlanCosts, PlanStep, ProductQuote, UserNeeds } from "./schemas";

const ZERO = new Decimal(0);
const EXIT_LEAD_DAYS = 2;
const STAKE_ACTION_BUFFER_DAYS = 1;

type Route = "JUSDT" | "JUSDD" | "STAKE";

interface BucketInput {
  id: string;
  label: string;
  amount: Decimal;
  needDate: string;
  exitStartDate: string;
  exitDay: number;
}

interface Allocation {
  jusdt: Decimal;
  jusdd: Decimal;
  stake: Decimal;
}

interface RouteResult {
  steps: PlanStep[];
  gross: Decimal;
  conversionFees: Decimal;
  costs: PlanCosts;
  net: Decimal;
}

const step = (action: PlanStep["action"], label: string, asset: string, amount: Decimal, energy: number, bandwidth: number, contract?: string, day = 0): PlanStep => ({
  action,
  label,
  asset,
  amount: amount.toFixed(),
  energy,
  bandwidth,
  contract,
  day,
  energySource: "Estimated network resources",
});

const productLabel = (product: Route | "HOLD" | "MIXED") => product === "HOLD" ? "지갑 보유" : product === "JUSDT" ? "JustLend jUSDT" : product === "JUSDD" ? "PSM → JustLend jUSDD" : product === "STAKE" ? "TRX 스테이킹 + SR 투표" : "복합 배분";

function quoteModes(...quotes: (ProductQuote | undefined)[]) {
  return [...new Set(quotes.filter(Boolean).map((quote) => quote!.source.mode))];
}

function bucketInputs(needs: UserNeeds): BucketInput[] {
  const endDate = needs.endDate ?? needs.startDate;
  const reserved = reservedWithinHorizon(needs);
  const buckets: BucketInput[] = [];
  if (reserved.buffer.gt(0)) buckets.push({ id: "buffer", label: "비상 여유액", amount: reserved.buffer, needDate: needs.startDate, exitStartDate: needs.startDate, exitDay: 0 });
  for (const expense of reserved.inside) {
    const needDay = daysBetween(needs.startDate, expense.date);
    const exitDay = Math.max(0, needDay - EXIT_LEAD_DAYS);
    buckets.push({ id: expense.id, label: expense.label ?? "예정 지출", amount: new Decimal(expense.amount), needDate: expense.date, exitStartDate: addDays(needs.startDate, exitDay), exitDay });
  }
  const remainder = Decimal.max(new Decimal(needs.amount ?? 0).minus(reserved.total), ZERO);
  if (remainder.gt(0)) buckets.push({ id: "remainder", label: "운용 종료 잔액", amount: remainder, needDate: endDate, exitStartDate: endDate, exitDay: daysBetween(needs.startDate, endDate) });
  return buckets.sort((a, b) => a.exitDay - b.exitDay);
}

function canUseUsdd(needs: UserNeeds, inputs: MainnetInputs, plan?: Plan) {
  const excludedForCapacityOnly = plan?.eligibility === "ineligible" && plan.reasons.every((reason) => /물량|유동성/.test(reason));
  return needs.acceptUsddRisk === true && needs.riskProfile !== "conservative" && (plan?.eligibility !== "ineligible" || excludedForCapacityOnly)
    && Boolean(inputs.jusdd?.active && inputs.jusdd.baseRate && inputs.psm?.psm?.sellEnabled && inputs.psm.psm.buyEnabled && inputs.costBasis?.psmEnergy);
}

function canUseStake(inputs: MainnetInputs) {
  const stake = inputs.staking;
  const swap = inputs.swap;
  return Boolean(stake?.active && stake.baseRate && stake.staking && swap && inputs.costBasis?.trxPerUsdt);
}

function swapOut(amount: Decimal, reserveIn: Decimal, reserveOut: Decimal, feeNumerator: number): Decimal {
  if (amount.lte(0) || reserveIn.lte(0) || reserveOut.lte(0)) return ZERO;
  return amount.mul(feeNumerator).mul(reserveOut).div(reserveIn.mul(1000).plus(amount.mul(feeNumerator)));
}

function stakeExitDay(bucket: BucketInput, unfreezeDelayDays: number) {
  return bucket.exitDay - unfreezeDelayDays - STAKE_ACTION_BUFFER_DAYS;
}

function routeResult(route: Route, buckets: BucketInput[], needs: UserNeeds, inputs: MainnetInputs, singles: { A: Plan; B: Plan }): RouteResult | undefined {
  if (!buckets.length) return undefined;
  if (route === "JUSDT") {
    const quote = inputs.jusdt;
    const capacityOnly = singles.A.eligibility === "ineligible" && singles.A.reasons.every((reason) => /유동성/.test(reason));
    if (!quote?.baseRate || !quote.active || (singles.A.eligibility === "ineligible" && !capacityOnly)) return undefined;
    const total = buckets.reduce((sum, bucket) => sum.plus(bucket.amount), ZERO);
    if (quote.liquidity && total.gt(quote.liquidity)) return undefined;
    const gross = buckets.reduce((sum, bucket) => sum.plus(baseYield(bucket.amount, new Decimal(quote.baseRate!), quote.rateType ?? "APY", bucket.exitDay)), ZERO);
    const steps = [
      step("approve", "Approve USDT for JustLend", "USDT", total, TYPICAL_RESOURCES.approve.energy, TYPICAL_RESOURCES.approve.bandwidth, quote.address),
      step("supply", "Supply USDT to JustLend", "USDT", total, TYPICAL_RESOURCES.supply_trc20.energy, TYPICAL_RESOURCES.supply_trc20.bandwidth, quote.address),
      ...buckets.map((bucket) => step("withdraw", `Withdraw jUSDT for ${bucket.label}`, "USDT", bucket.amount, TYPICAL_RESOURCES.withdraw.energy, TYPICAL_RESOURCES.withdraw.bandwidth, quote.address, bucket.exitDay)),
    ];
    const costs = stepCosts(steps, inputs.costBasis, "USDT");
    return costs.inAsset === undefined ? undefined : { steps, gross, conversionFees: ZERO, costs, net: gross.minus(costs.inAsset) };
  }

  if (route === "STAKE") {
    const quote = inputs.staking;
    const stake = quote?.staking;
    const swap = inputs.swap;
    if (!quote?.baseRate || !stake || !swap || !inputs.costBasis?.trxPerUsdt) return undefined;
    if (buckets.some((bucket) => stakeExitDay(bucket, stake.unfreezeDelayDays) <= new Decimal(stake.voteDelayDays ?? "0.25").toNumber())) return undefined;
    const total = buckets.reduce((sum, bucket) => sum.plus(bucket.amount), ZERO);
    const reserveUsdt = new Decimal(swap.reserveUsdt);
    const reserveTrx = new Decimal(swap.reserveTrx);
    const trxIn = swapOut(total, reserveUsdt, reserveTrx, swap.feeNumerator);
    if (trxIn.lte(0)) return undefined;
    const rate = new Decimal(quote.baseRate);
    const exits = buckets.map((bucket) => {
      const principalTrx = trxIn.mul(bucket.amount).div(total);
      const rewardDays = stakeExitDay(bucket, stake.unfreezeDelayDays) - new Decimal(stake.voteDelayDays ?? "0.25").toNumber();
      const rewardTrx = principalTrx.mul(rate).mul(rewardDays).div(365);
      const baseBack = swapOut(principalTrx, reserveTrx, reserveUsdt, swap.feeNumerator);
      const usdtBack = swapOut(principalTrx.plus(rewardTrx), reserveTrx, reserveUsdt, swap.feeNumerator);
      return { bucket, principalTrx, rewardTrx, baseBack, usdtBack, rewardDays };
    });
    const gross = exits.reduce((sum, exit) => sum.plus(exit.usdtBack.minus(exit.baseBack)), ZERO);
    const conversionFees = total.minus(exits.reduce((sum, exit) => sum.plus(exit.baseBack), ZERO));
    const steps = [
      step("approve", "Approve USDT for SunSwap", "USDT", total, TYPICAL_RESOURCES.approve.energy, TYPICAL_RESOURCES.approve.bandwidth, swap.router),
      step("swap", "Swap USDT to TRX through SunSwap", "USDT", total, swap.costs.toTrx.energy, swap.costs.toTrx.bandwidth, swap.router),
      step("stake", "Stake TRX (Stake 2.0)", "TRX", trxIn, 0, 300),
      step("vote", `Vote for ${stake.srName}`, "TRX", trxIn, 0, 300, stake.srAddress),
      ...exits.flatMap((exit) => [
        step("unstake", `Request unstake for ${exit.bucket.label}`, "TRX", exit.principalTrx, 0, 300, undefined, stakeExitDay(exit.bucket, stake.unfreezeDelayDays)),
        step("withdraw", `Withdraw unstaked TRX for ${exit.bucket.label}`, "TRX", exit.principalTrx, 0, 300, undefined, exit.bucket.exitDay),
        step("claim", `Claim SR rewards for ${exit.bucket.label}`, "TRX", exit.rewardTrx, 0, 300, undefined, exit.bucket.exitDay),
        step("swap", `Swap TRX to USDT for ${exit.bucket.label}`, "TRX", exit.principalTrx.plus(exit.rewardTrx), swap.costs.toUsdt.energy, swap.costs.toUsdt.bandwidth, swap.router, exit.bucket.exitDay),
      ]),
    ];
    const costs = stepCosts(steps, inputs.costBasis, "USDT", conversionFees);
    return costs.inAsset === undefined ? undefined : { steps, gross, conversionFees, costs, net: gross.minus(conversionFees).minus(costs.inAsset) };
  }

  const jusdd = inputs.jusdd;
  const psm = inputs.psm;
  const psmEnergy = inputs.costBasis?.psmEnergy;
  if (!jusdd?.baseRate || !psm?.psm || !psmEnergy || !canUseUsdd(needs, inputs, singles.B)) return undefined;
  const total = buckets.reduce((sum, bucket) => sum.plus(bucket.amount), ZERO);
  const feeIn = new Decimal(psm.psm.feeIn);
  const feeOut = new Decimal(psm.psm.feeOut);
  const usddTotal = total.mul(new Decimal(1).minus(feeIn));
  const gross = buckets.reduce((sum, bucket) => sum.plus(baseYield(bucket.amount.mul(new Decimal(1).minus(feeIn)), new Decimal(jusdd.baseRate!), jusdd.rateType ?? "APY", bucket.exitDay)), ZERO);
  const usddOut = usddTotal.plus(gross);
  if ((jusdd.liquidity && usddTotal.gt(jusdd.liquidity)) || (psm.psm.entryCapacity && usddTotal.gt(psm.psm.entryCapacity)) || (psm.psm.exitLiquidity && usddOut.gt(psm.psm.exitLiquidity))) return undefined;
  const conversionFees = buckets.reduce((sum, bucket) => {
    const entry = bucket.amount.mul(new Decimal(1).minus(feeIn));
    const exit = entry.plus(baseYield(entry, new Decimal(jusdd.baseRate!), jusdd.rateType ?? "APY", bucket.exitDay));
    return sum.plus(bucket.amount.minus(entry)).plus(exit.mul(feeOut));
  }, ZERO);
  const steps = [
    step("approve", "Approve USDT for PSM", "USDT", total, TYPICAL_RESOURCES.approve.energy, TYPICAL_RESOURCES.approve.bandwidth, psm.address),
    step("psm_sell", "Swap USDT to USDD through PSM", "USDT", total, psmEnergy.sell, TYPICAL_RESOURCES.psm.bandwidth, psm.address),
    step("approve", "Approve USDD for JustLend", "USDD", usddTotal, TYPICAL_RESOURCES.approve.energy, TYPICAL_RESOURCES.approve.bandwidth, jusdd.address),
    step("supply", "Supply USDD to JustLend", "USDD", usddTotal, TYPICAL_RESOURCES.supply_trc20.energy, TYPICAL_RESOURCES.supply_trc20.bandwidth, jusdd.address),
    ...buckets.flatMap((bucket) => {
      const entry = bucket.amount.mul(new Decimal(1).minus(feeIn));
      const exit = entry.plus(baseYield(entry, new Decimal(jusdd.baseRate!), jusdd.rateType ?? "APY", bucket.exitDay));
      return [
        step("withdraw", `Withdraw jUSDD for ${bucket.label}`, "USDD", exit, TYPICAL_RESOURCES.withdraw.energy, TYPICAL_RESOURCES.withdraw.bandwidth, jusdd.address, bucket.exitDay),
        step("psm_buy", "Swap USDD to USDT through PSM", "USDD", exit, psmEnergy.buy, TYPICAL_RESOURCES.psm.bandwidth, psm.address, bucket.exitDay),
      ];
    }),
  ];
  const costs = stepCosts(steps, inputs.costBasis, "USDT", conversionFees);
  return costs.inAsset === undefined ? undefined : { steps, gross, conversionFees, costs, net: gross.minus(conversionFees).minus(costs.inAsset) };
}

function splitBuckets(buckets: BucketInput[], allocations: Allocation[], route: Route) {
  return buckets.flatMap((bucket, index) => {
    const amount = route === "JUSDT" ? allocations[index].jusdt : route === "JUSDD" ? allocations[index].jusdd : allocations[index].stake;
    return amount.gt(0) ? [{ ...bucket, amount }] : [];
  });
}

function assignmentNet(allocations: Allocation[], buckets: BucketInput[], needs: UserNeeds, inputs: MainnetInputs, singles: { A: Plan; B: Plan }) {
  let net = ZERO;
  for (const route of ["JUSDT", "JUSDD", "STAKE"] as const) {
    const result = routeResult(route, splitBuckets(buckets, allocations, route), needs, inputs, singles);
    if (splitBuckets(buckets, allocations, route).length && !result) return undefined;
    if (result) net = net.plus(result.net);
  }
  return net;
}

export function buildStakingBaseline(
  needs: UserNeeds,
  inputs: MainnetInputs,
  singles: { A: Plan; B: Plan },
  base: Pick<Plan, "chain" | "asset" | "inputVersion" | "horizonDays" | "principal" | "label">,
  idPrefix: string,
  now: Date,
): Plan {
  const reserved = reservedWithinHorizon(needs);
  const amount = new Decimal(needs.amount ?? 0);
  const investable = Decimal.max(amount.minus(reserved.total), ZERO);
  const endDate = needs.endDate ?? needs.startDate;
  const bucket: BucketInput = { id: "remainder", label: "운용 종료 잔액", amount: investable, needDate: endDate, exitStartDate: endDate, exitDay: daysBetween(needs.startDate, endDate) };
  const route = investable.gt(0) ? routeResult("STAKE", [bucket], needs, inputs, singles) : undefined;
  const quoteIssues = dataIssues(inputs.staking, "mainnet", now);
  const blocking = [...quoteIssues.blocking];
  const conditional = [...quoteIssues.conditional];
  if (!inputs.staking?.active) blocking.push("Stake 2.0 투표 후보가 비활성입니다.");
  if (!inputs.swap) blocking.push("USDT↔TRX 교환 견적을 확인하지 못했습니다.");
  else {
    if (inputs.swap.source.mode === "synthetic") conditional.push("SunSwap 교환 견적은 가상 데이터입니다.");
    if (inputs.swap.source.mode === "snapshot") conditional.push("SunSwap 교환 견적은 과거 데이터입니다.");
    if (inputs.swap.source.mode === "live" && now.getTime() - Date.parse(inputs.swap.source.fetchedAt) > QUOTE_MAX_AGE_MS) blocking.push("SunSwap 교환 견적이 오래됐습니다.");
  }
  if (!inputs.costBasis?.trxPerUsdt) blocking.push("네트워크 비용을 USDT로 환산할 근거가 없습니다.");
  if (investable.lte(0)) blocking.push("지출을 제외하면 운용할 금액이 없습니다.");
  if (inputs.staking?.staking && stakeExitDay(bucket, inputs.staking.staking.unfreezeDelayDays) <= new Decimal(inputs.staking.staking.voteDelayDays ?? "0.25").toNumber())
    blocking.push(`운용 종료일 전에 Stake 2.0 해제 대기 ${inputs.staking.staking.unfreezeDelayDays}일과 실행 여유를 확보할 수 없습니다.`);
  if (!route && !blocking.length) blocking.push("스테이킹 경로의 전환·해제 비용을 계산할 수 없습니다.");
  const costs = route?.costs ?? { energy: 0, bandwidth: 0, trx: "0", inAsset: undefined, conversionFees: "0" };
  return {
    ...base, id: `${idPrefix}-C`, key: "C", title: "C. 전액 TRX 스테이킹 + SR 투표",
    allocation: { invested: investable.toFixed(), held: reserved.total.toFixed() },
    steps: route?.steps ?? [], baseRate: inputs.staking?.baseRate, rateType: "APR",
    baseYield: route?.gross.toFixed() ?? "0", rewards: inputs.staking?.rewards ?? { status: "none", note: "투표 보상을 확인하지 못했습니다." },
    costs, netReturn: route?.net.toFixed(),
    eligibility: blocking.length ? "ineligible" : conditional.length ? "conditional" : "eligible",
    reasons: [...blocking, ...conditional],
    risks: ["TRX 가격 변동", "스테이킹 해제 대기", "SR 보상 변동", "SunSwap 전환 비용과 유동성"],
    assumptions: ["지출 재원은 USDT로 보유하고 나머지를 스테이킹합니다.", "현재 SunSwap 풀 가격이 출구에도 같다고 가정합니다.", "스테이킹 보상은 해제 요청 전까지만 계산합니다."],
    recommended: false, quoteIds: inputs.staking ? [inputs.staking.id] : [],
    dataModes: quoteModes(inputs.staking), label: "조건부 분석",
  };
}

function usddCap(needs: UserNeeds) {
  if (needs.riskProfile === "aggressive") return new Decimal("0.75");
  if (needs.riskProfile === "balanced") return new Decimal("0.5");
  return ZERO;
}

type Destination = Route | "HOLD";
const DESTINATIONS: Destination[] = ["HOLD", "JUSDT", "JUSDD", "STAKE"];
const emptyAllocation = (): Allocation => ({ jusdt: ZERO, jusdd: ZERO, stake: ZERO });

function amountAt(allocation: Allocation, bucket: BucketInput, destination: Destination): Decimal {
  if (destination === "HOLD") return bucket.amount.minus(allocation.jusdt).minus(allocation.jusdd).minus(allocation.stake);
  return allocation[destination.toLowerCase() as keyof Allocation];
}

function transfer(allocations: Allocation[], index: number, from: Destination, to: Destination, amount: Decimal): Allocation[] {
  const next = allocations.map((allocation) => ({ ...allocation }));
  if (from !== "HOLD") next[index][from.toLowerCase() as keyof Allocation] = next[index][from.toLowerCase() as keyof Allocation].minus(amount);
  if (to !== "HOLD") next[index][to.toLowerCase() as keyof Allocation] = next[index][to.toLowerCase() as keyof Allocation].plus(amount);
  return next;
}

/** Search continuous allocations, including combinations that use all three routes in one bucket. */
function bestAllocations(buckets: BucketInput[], needs: UserNeeds, inputs: MainnetInputs, singles: { A: Plan; B: Plan; C: Plan }) {
  const cap = new Decimal(needs.amount ?? 0).mul(usddCap(needs));
  const usddAllowed = canUseUsdd(needs, inputs, singles.B);
  const stakeAllowed = canUseStake(inputs) && singles.C.eligibility !== "ineligible";
  const usable = (bucket: BucketInput, destination: Destination) => destination === "HOLD" || (bucket.exitDay > 0 && (
    destination === "JUSDT" ? singles.A.eligibility !== "ineligible" || singles.A.reasons.every((reason) => /유동성/.test(reason))
      : destination === "JUSDD" ? usddAllowed
        : stakeAllowed && Boolean(inputs.staking?.staking && stakeExitDay(bucket, inputs.staking.staking.unfreezeDelayDays) > new Decimal(inputs.staking.staking.voteDelayDays ?? "0.25").toNumber())
  ));
  const totalUsdd = (items: Allocation[]) => items.reduce((sum, item) => sum.plus(item.jusdd), ZERO);
  const evaluate = (items: Allocation[]) => assignmentNet(items, buckets, needs, inputs, singles);
  const empty = buckets.map(emptyAllocation);
  const seeds: Allocation[][] = [empty];
  for (const route of ["JUSDT", "STAKE"] as const) {
    const seed = buckets.map((bucket) => usable(bucket, route) ? { ...emptyAllocation(), [route.toLowerCase()]: bucket.amount } : emptyAllocation());
    seeds.push(seed);
    seeds.push(buckets.map((bucket) => bucket.id === "remainder" && usable(bucket, route)
      ? { ...emptyAllocation(), [route.toLowerCase()]: bucket.amount }
      : emptyAllocation()));
  }
  if (usddAllowed) {
    const seed = buckets.map((bucket) => usable(bucket, "JUSDT") ? { ...emptyAllocation(), jusdt: bucket.amount } : emptyAllocation());
    let remaining = cap;
    for (const index of buckets.map((_, index) => index).sort((left, right) => buckets[right].exitDay - buckets[left].exitDay)) {
      if (!usable(buckets[index], "JUSDD") || remaining.lte(0)) continue;
      const usdd = Decimal.min(buckets[index].amount, remaining);
      seed[index] = { jusdt: seed[index].jusdt.minus(usdd), jusdd: usdd, stake: ZERO };
      remaining = remaining.minus(usdd);
    }
    seeds.push(seed);
  }

  let best = { allocations: empty, net: ZERO };
  for (const seed of seeds) {
    const seedNet = evaluate(seed);
    if (seedNet === undefined) continue;
    let current = seed;
    let currentNet = seedNet;
    for (let sweep = 0; sweep < 3; sweep++) {
      let improved = false;
      for (let index = 0; index < buckets.length; index++) {
        const bucket = buckets[index];
        for (const from of DESTINATIONS) for (const to of DESTINATIONS) {
          if (from === to || !usable(bucket, to)) continue;
          let maximum = amountAt(current[index], bucket, from);
          if (to === "JUSDD") maximum = Decimal.min(maximum, cap.minus(totalUsdd(current)));
          if (maximum.lte(0)) continue;
          const at = (fraction: Decimal) => {
            const candidate = transfer(current, index, from, to, maximum.mul(fraction));
            return { candidate, net: evaluate(candidate) };
          };
          const probes = [ZERO, new Decimal("0.25"), new Decimal("0.5"), new Decimal("0.75"), new Decimal(1)];
          let winner = { fraction: ZERO, candidate: current, net: currentNet };
          for (const fraction of probes.slice(1)) {
            const result = at(fraction);
            if (result.net && result.net.gt(winner.net)) winner = { fraction, candidate: result.candidate, net: result.net };
          }
          const left = Decimal.max(winner.fraction.minus("0.25"), ZERO);
          const right = Decimal.min(winner.fraction.plus("0.25"), 1);
          let low = left;
          let high = right;
          for (let iteration = 0; iteration < 12 && high.minus(low).gt("0.000001"); iteration++) {
            const oneThird = high.minus(low).div(3);
            const x = low.plus(oneThird);
            const y = high.minus(oneThird);
            const ax = at(x);
            const ay = at(y);
            if (ax.net && ax.net.gt(winner.net)) winner = { fraction: x, candidate: ax.candidate, net: ax.net };
            if (ay.net && ay.net.gt(winner.net)) winner = { fraction: y, candidate: ay.candidate, net: ay.net };
            if ((ax.net ?? new Decimal("-1e100")).gt(ay.net ?? new Decimal("-1e100"))) high = y;
            else low = x;
          }
          if (winner.net.minus(currentNet).gt("0.00000001")) {
            current = winner.candidate;
            currentNet = winner.net;
            improved = true;
          }
        }
      }
      if (!improved) break;
    }
    if (currentNet.gt(best.net)) best = { allocations: current, net: currentNet };
  }
  return best.allocations.map((allocation, index) => {
    const jusdd = allocation.jusdd.toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const stake = allocation.stake.toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const held = Decimal.max(amountAt(allocation, buckets[index], "HOLD"), ZERO).toDecimalPlaces(6, Decimal.ROUND_DOWN);
    const jusdt = allocation.jusdt.gt(0)
      ? buckets[index].amount.minus(held).minus(jusdd).minus(stake)
      : ZERO;
    return { jusdt, jusdd, stake };
  });
}

function allocationDetails(bucket: BucketInput, allocation: Allocation, inputs: MainnetInputs): LadderAllocation[] {
  const items: LadderAllocation[] = [];
  if (allocation.jusdt.gt(0)) {
    const yieldAmount = baseYield(allocation.jusdt, new Decimal(inputs.jusdt?.baseRate ?? 0), inputs.jusdt?.rateType ?? "APY", bucket.exitDay);
    items.push({ product: "JUSDT", productLabel: productLabel("JUSDT"), amount: allocation.jusdt.toFixed(), expectedYield: yieldAmount.toFixed() });
  }
  if (allocation.jusdd.gt(0)) {
    const principal = allocation.jusdd.mul(new Decimal(1).minus(inputs.psm?.psm?.feeIn ?? 0));
    const yieldAmount = baseYield(principal, new Decimal(inputs.jusdd?.baseRate ?? 0), inputs.jusdd?.rateType ?? "APY", bucket.exitDay);
    items.push({ product: "JUSDD", productLabel: productLabel("JUSDD"), amount: allocation.jusdd.toFixed(), expectedYield: yieldAmount.toFixed() });
  }
  if (allocation.stake.gt(0)) {
    const stake = inputs.staking?.staking;
    const swap = inputs.swap;
    const rewardDays = stake ? Math.max(0, stakeExitDay(bucket, stake.unfreezeDelayDays) - new Decimal(stake.voteDelayDays ?? "0.25").toNumber()) : 0;
    const rate = new Decimal(inputs.staking?.baseRate ?? 0);
    const approxYield = swap
      ? allocation.stake.mul(rate).mul(rewardDays).div(365).mul(swap.feeNumerator).div(1000)
      : ZERO;
    items.push({ product: "STAKE", productLabel: productLabel("STAKE"), amount: allocation.stake.toFixed(), expectedYield: approxYield.toFixed() });
  }
  const held = Decimal.max(bucket.amount.minus(allocation.jusdt).minus(allocation.jusdd).minus(allocation.stake), ZERO);
  if (held.gt(0)) items.push({ product: "HOLD", productLabel: productLabel("HOLD"), amount: held.toFixed(), expectedYield: "0" });
  return items;
}

export function buildLadderPlan(needs: UserNeeds, inputs: MainnetInputs, singles: { A: Plan; B: Plan; C: Plan }, base: Pick<Plan, "chain" | "asset" | "inputVersion" | "horizonDays" | "principal" | "label">, idPrefix: string): Plan {
  const buckets = bucketInputs(needs);
  const allocations = bestAllocations(buckets, needs, inputs, singles);
  const jusdtBuckets = splitBuckets(buckets, allocations, "JUSDT");
  const jusddBuckets = splitBuckets(buckets, allocations, "JUSDD");
  const stakeBuckets = splitBuckets(buckets, allocations, "STAKE");
  const routes = ([routeResult("JUSDT", jusdtBuckets, needs, inputs, singles), routeResult("JUSDD", jusddBuckets, needs, inputs, singles), routeResult("STAKE", stakeBuckets, needs, inputs, singles)]).filter((route): route is RouteResult => Boolean(route));
  const gross = routes.reduce((sum, route) => sum.plus(route.gross), ZERO);
  const conversionFees = routes.reduce((sum, route) => sum.plus(route.conversionFees), ZERO);
  const steps = routes.flatMap((route) => route.steps).sort((a, b) => (a.day ?? 0) - (b.day ?? 0));
  const costs = stepCosts(steps, inputs.costBasis, "USDT", conversionFees);
  const net = routes.reduce((sum, route) => sum.plus(route.net), ZERO);
  const invested = allocations.reduce((sum, allocation) => sum.plus(allocation.jusdt).plus(allocation.jusdd).plus(allocation.stake), ZERO);
  const ladder: LadderBucket[] = buckets.map((bucket, index) => {
    const detail = allocationDetails(bucket, allocations[index], inputs);
    const product = detail.length === 1 ? detail[0].product : "MIXED";
    const expectedYield = detail.reduce((sum, item) => sum.plus(item.expectedYield), ZERO);
    const unstakeDate = detail.some((item) => item.product === "STAKE") && inputs.staking?.staking
      ? addDays(needs.startDate, stakeExitDay(bucket, inputs.staking.staking.unfreezeDelayDays))
      : undefined;
    const reason = product === "HOLD"
      ? bucket.exitDay === 0 ? "바로 사용할 수 있어야 하는 자금입니다." : "예상 수익이 거래비용과 인출 조건을 넘지 못했습니다."
      : product === "MIXED" ? "세 경로의 예상 순수익과 전환 비용을 함께 계산해 비율을 조정했습니다."
        : product === "STAKE" ? `해제 요청을 ${unstakeDate}에 보내고 ${bucket.exitStartDate}까지 TRX를 USDT로 되돌립니다.`
          : `${bucket.exitDay}일 동안 운용한 뒤 ${bucket.exitStartDate}부터 인출을 준비합니다.`;
    return { id: bucket.id, label: bucket.label, amount: bucket.amount.toFixed(), needDate: bucket.needDate, exitStartDate: bucket.exitStartDate, unstakeDate, product, productLabel: productLabel(product), expectedYield: expectedYield.toFixed(), allocations: detail, reason };
  });
  const quotes = [jusdtBuckets.length ? inputs.jusdt : undefined, jusddBuckets.length ? inputs.jusdd : undefined, jusddBuckets.length ? inputs.psm : undefined, stakeBuckets.length ? inputs.staking : undefined];
  return {
    ...base,
    id: `${idPrefix}-L`, key: "L", title: "L. 날짜별 유동성 배분",
    allocation: { invested: invested.toFixed(), held: new Decimal(needs.amount ?? 0).minus(invested).toFixed() },
    steps, baseYield: gross.toFixed(), rewards: { status: "none", note: "Unverified incentives are excluded from this plan." }, costs,
    netReturn: costs.inAsset === undefined ? undefined : net.toFixed(), eligibility: costs.inAsset === undefined || quotes.some((quote) => quote?.source.mode !== "live") || (stakeBuckets.length > 0 && inputs.swap?.source.mode !== "live") ? "conditional" : "eligible",
    reasons: invested.gt(0) ? ["각 날짜의 자금을 보유·jUSDT·jUSDD·Stake 2.0에 나누고 왕복 비용을 포함한 순수익을 비교했습니다."] : ["왕복 비용을 뺀 예상 수익이 양수인 경로가 없습니다."],
    risks: ["Interest rates and withdrawal liquidity can change", "Smart contract risk", ...(jusddBuckets.length ? ["USDD depeg and PSM exit liquidity risk"] : []), ...(stakeBuckets.length ? ["TRX price is assumed unchanged between swaps", "Unstake timing is required before the withdrawal preparation date", "SR voting rewards can change"] : [])],
    assumptions: [`지출일 ${EXIT_LEAD_DAYS}일 전부터 인출을 준비합니다.`, `USDD 비중은 보유 자산의 ${usddCap(needs).mul(100).toFixed()}%를 넘지 않습니다. 고정 배분 비율은 사용하지 않습니다.`, ...(stakeBuckets.length ? [`Stake 2.0은 체인에서 조회한 해제 대기와 ${STAKE_ACTION_BUFFER_DAYS}일 실행 여유가 인출 준비일 전에 확보될 때만 사용합니다.`, "SunSwap 현재 풀 가격이 예정 출구에도 같다고 가정합니다."] : []), "금리와 비용은 조회 시점 값이며 미래 수익을 보장하지 않습니다."],
    recommended: false, quoteIds: quotes.filter(Boolean).map((quote) => quote!.id), dataModes: quoteModes(...quotes), label: "조건부 분석", ladder,
  };
}
