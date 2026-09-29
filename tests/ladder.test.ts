import { describe, expect, it } from "vitest";
import { addDays } from "../shared/needs";
import { buildMainnetPlans } from "../shared/planning";
import { Decimal } from "../shared/units";
import { FundingError } from "../shared/funding";
import type { CostBasis, ProductQuote, UserNeeds } from "../shared/schemas";

const TODAY = "2026-09-29";
const NOW = new Date("2026-09-29T03:00:00Z");
const source = { sourceUrl: "test", chain: "mainnet" as const, fetchedAt: NOW.toISOString(), mode: "live" as const, accessMethod: "direct" as const };

function lending(id: string, token: string, rate: string): ProductQuote {
  return { id, kind: "lending", market: id, token, address: `T${id}`, chain: "mainnet", baseRate: rate, rateType: "APY", liquidity: "1000000", active: true, rewards: { status: "none", note: "" }, source };
}

const psm: ProductQuote = { id: "psm", kind: "psm", market: "PSM", token: "USDD", address: "Tpsm", chain: "mainnet", active: true, rewards: { status: "none", note: "" }, psm: { feeIn: "0", feeOut: "0", sellEnabled: true, buyEnabled: true, entryCapacity: "1000000", exitLiquidity: "1000000" }, source };
const costs: CostBasis = { energyFeeSun: 1, bandwidthFeeSun: 1, trxPerUsdt: "3", psmEnergy: { sell: 10, buy: 10, sampleSize: 1 }, source };
const staking: ProductQuote = {
  id: "stake", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: "TSR", chain: "mainnet", baseRate: "0.5", rateType: "APR", active: true,
  rewards: { status: "none", note: "" }, staking: { srAddress: "TSR", srName: "Test SR", brokerage: "0", unfreezeDelayDays: 14, voteDelayDays: "0.25" }, source,
};
const swap = { router: "TSwap", pair: "TPair", reserveUsdt: "100000000", reserveTrx: "300000000", feeNumerator: 997, costs: { toTrx: { energy: 1, bandwidth: 1 }, toUsdt: { energy: 1, bandwidth: 1 } }, source };

function needs(overrides: Partial<UserNeeds> = {}): UserNeeds {
  return {
    chain: "mainnet", asset: "USDT", amount: "50000", startDate: TODAY, endDate: addDays(TODAY, 180),
    expenses: [
      { id: "soon", date: addDays(TODAY, 7), amount: "500", asset: "USDT", label: "단기 지출" },
      { id: "later", date: addDays(TODAY, 30), amount: "5000", asset: "USDT", label: "중기 지출" },
    ],
    expensesStated: true, bufferAmount: "500", riskProfile: "balanced", acceptUsddRisk: false, timezone: "Asia/Seoul", version: 1,
    ...overrides,
  };
}

describe("dated liquidity ladder", () => {
  it("keeps emergency funds liquid and prepares withdrawal two days before an expense", () => {
    const result = buildMainnetPlans(needs(), { jusdt: lending("jUSDT", "USDT", "0.08"), jusdd: lending("jUSDD", "USDD", "0.01"), psm, costBasis: costs }, NOW);
    const plan = result.plans.find((item) => item.key === "L")!;
    expect(plan.ladder?.find((bucket) => bucket.id === "buffer")?.product).toBe("HOLD");
    expect(plan.ladder?.find((bucket) => bucket.id === "soon")?.exitStartDate).toBe(addDays(TODAY, 5));
    expect(plan.ladder?.find((bucket) => bucket.id === "later")?.exitStartDate).toBe(addDays(TODAY, 28));
    expect(plan.ladder?.some((bucket) => bucket.product === "JUSDT")).toBe(true);
  });

  it("does not use the USDD route when the user declines its risk", () => {
    const result = buildMainnetPlans(needs({ acceptUsddRisk: false }), { jusdt: lending("jUSDT", "USDT", "0.03"), jusdd: lending("jUSDD", "USDD", "0.5"), psm, costBasis: costs }, NOW);
    const plan = result.plans.find((item) => item.key === "L")!;
    expect(plan.ladder?.some((bucket) => bucket.product === "JUSDD")).toBe(false);
  });

  it("splits an eligible long-term bucket between jUSDT and jUSDD instead of putting all funds in USDD", () => {
    const result = buildMainnetPlans(needs({ acceptUsddRisk: true }), { jusdt: lending("jUSDT", "USDT", "0.03"), jusdd: lending("jUSDD", "USDD", "0.5"), psm, costBasis: costs }, NOW);
    const remainder = result.plans.find((item) => item.key === "L")!.ladder?.find((bucket) => bucket.id === "remainder");
    expect(remainder?.product).toBe("MIXED");
    expect(remainder?.allocations.map((allocation) => allocation.product)).toEqual(["JUSDT", "JUSDD"]);
  });

  it("uses the calculated risk-cap boundary instead of a fixed percentage grid", () => {
    const result = buildMainnetPlans(needs({ amount: "1001", expenses: [], bufferAmount: "0", acceptUsddRisk: true }), { jusdt: lending("jUSDT", "USDT", "0.03"), jusdd: lending("jUSDD", "USDD", "0.5"), psm, costBasis: costs }, NOW);
    const remainder = result.plans.find((item) => item.key === "L")!.ladder?.find((bucket) => bucket.id === "remainder");
    expect(remainder?.allocations.find((allocation) => allocation.product === "JUSDD")?.amount).toBe("500.5");
  });

  it("uses Stake 2.0 only for a bucket that can finish its unfreeze wait before withdrawal preparation", () => {
    const result = buildMainnetPlans(needs({ acceptUsddRisk: false, endDate: addDays(TODAY, 60) }), { jusdt: lending("jUSDT", "USDT", "0.001"), jusdd: lending("jUSDD", "USDD", "0.001"), psm, staking, swap, costBasis: costs }, NOW);
    const plan = result.plans.find((item) => item.key === "L")!;
    const soon = plan.ladder?.find((bucket) => bucket.id === "soon");
    const remainder = plan.ladder?.find((bucket) => bucket.id === "remainder");
    expect(soon?.product).not.toBe("STAKE");
    expect(remainder?.product).toBe("STAKE");
    expect(remainder?.unstakeDate).toBe(addDays(TODAY, 45));
  });

  it("does not stake when the unfreeze wait would leave no action buffer", () => {
    const result = buildMainnetPlans(needs({ expenses: [], bufferAmount: "0", endDate: addDays(TODAY, 15), acceptUsddRisk: false }), { jusdt: lending("jUSDT", "USDT", "0.001"), jusdd: lending("jUSDD", "USDD", "0.001"), psm, staking, swap, costBasis: costs }, NOW);
    const remainder = result.plans.find((item) => item.key === "L")!.ladder?.find((bucket) => bucket.id === "remainder");
    expect(remainder?.product).not.toBe("STAKE");
  });

  it("optimizes one long bucket across USDT, USDD, and staking and compares the staking baseline", () => {
    const longNeeds = needs({ amount: "1000", expenses: [], bufferAmount: "0", endDate: addDays(TODAY, 365), acceptUsddRisk: true });
    const shallowSwap = { ...swap, reserveUsdt: "10000", reserveTrx: "30000" };
    const higherStake = { ...staking, baseRate: "0.25" };
    const result = buildMainnetPlans(longNeeds, { jusdt: lending("jUSDT", "USDT", "0.12"), jusdd: lending("jUSDD", "USDD", "0.3"), psm, staking: higherStake, swap: shallowSwap, costBasis: costs }, NOW);
    const ladder = result.plans.find((plan) => plan.key === "L")!;
    const stakeOnly = result.plans.find((plan) => plan.key === "C")!;
    const remainder = ladder.ladder?.find((bucket) => bucket.id === "remainder")!;
    expect(remainder.product).toBe("MIXED");
    expect(remainder.allocations.map((allocation) => allocation.product)).toEqual(["JUSDT", "JUSDD", "STAKE"]);
    expect(new Decimal(remainder.allocations.find((allocation) => allocation.product === "STAKE")!.amount).gt(100)).toBe(true);
    expect(new Decimal(remainder.allocations.find((allocation) => allocation.product === "STAKE")!.amount).lt(300)).toBe(true);
    expect(remainder.allocations.reduce((sum, allocation) => sum.plus(allocation.amount), new Decimal(0)).toFixed()).toBe("1000");
    expect(remainder.unstakeDate).toBe(addDays(TODAY, 350));
    expect(stakeOnly.eligibility).toBe("eligible");
    expect(new Decimal(ladder.netReturn!).gt(stakeOnly.netReturn!)).toBe(true);
  });

  it("values TRX holdings using a quoted swap, keeps the USDT expense liquid, and charges entry costs", () => {
    const trxNeeds = needs({ asset: "TRX", amount: "10000", expenses: [{ id: "future", date: addDays(TODAY, 150), amount: "1000", asset: "USDT" }], bufferAmount: "0", endDate: addDays(TODAY, 1500), riskProfile: "aggressive", acceptUsddRisk: true });
    const result = buildMainnetPlans(trxNeeds, { jusdt: lending("jUSDT", "USDT", "0.12"), jusdd: lending("jUSDD", "USDD", "0.2"), psm, staking, swap, costBasis: costs }, NOW);
    expect(result.needs.asset).toBe("TRX");
    expect(result.funding?.inputAmount).toBe("10000");
    expect(result.plans.every((plan) => plan.asset === "USDT")).toBe(true);
    expect(new Decimal(result.plans[0].principal).lt(new Decimal(10000).div(3))).toBe(true);
    expect(result.reserved.total).toBe("1000");
    expect(result.plans[0].steps[0].action).toBe("swap");
    expect(new Decimal(result.plans[0].costs.conversionFees).gt(0)).toBe(true);
    expect(result.plans.find((plan) => plan.key === "L")?.ladder?.some((bucket) => bucket.needDate === addDays(TODAY, 150))).toBe(true);
    const hold = result.plans.find((plan) => plan.key === "HOLD")!;
    expect(hold.title).toContain("필요한 USDT만 전환");
    expect(hold.steps.some((item) => item.action === "swap")).toBe(true);
    expect(new Decimal(hold.netReturn!).lt(0)).toBe(true);
  });

  it("keeps an actual no-swap TRX holding baseline when no USDT expense exists", () => {
    const trxNeeds = needs({ asset: "TRX", amount: "1000", expenses: [{ id: "future", date: addDays(TODAY, 30), amount: "100", asset: "TRX" }], bufferAmount: "0" });
    const result = buildMainnetPlans(trxNeeds, { jusdt: lending("jUSDT", "USDT", "0.1"), jusdd: lending("jUSDD", "USDD", "0.1"), psm, staking, swap, costBasis: costs }, NOW);
    const hold = result.plans.find((plan) => plan.key === "HOLD")!;
    expect(hold.netReturn).toBe("0");
    expect(hold.steps.some((item) => item.action === "swap")).toBe(false);
  });

  it("reserves TRX expenses in TRX and rejects a mixed plan that cannot fund its USDT expense", () => {
    const trxExpense = needs({ amount: "1000", expenses: [{ id: "future", date: addDays(TODAY, 30), amount: "100", asset: "TRX" }], bufferAmount: "0" });
    const result = buildMainnetPlans(trxExpense, { jusdt: lending("jUSDT", "USDT", "0.1"), jusdd: lending("jUSDD", "USDD", "0.1"), psm, staking, swap, costBasis: costs }, NOW);
    expect(result.funding?.reservedTrx).toBe("100");
    expect(new Decimal(result.plans[0].principal).lt(1000)).toBe(true);
    const impossible = needs({ asset: "TRX", amount: "1000", expenses: [{ id: "future", date: addDays(TODAY, 30), amount: "1000", asset: "USDT" }], bufferAmount: "0" });
    expect(() => buildMainnetPlans(impossible, { jusdt: lending("jUSDT", "USDT", "0.1"), jusdd: lending("jUSDD", "USDD", "0.1"), psm, staking, swap, costBasis: costs }, NOW)).toThrow(FundingError);
  });
});
