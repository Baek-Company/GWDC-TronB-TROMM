import { describe, expect, it } from "vitest";
import { assessGoal } from "../shared/monitor";
import type { PlanningResult } from "../shared/schemas";

const base = (): PlanningResult => ({
  id: "baseline", chain: "mainnet", createdAt: "2026-09-29T00:00:00Z", engineVersion: "test",
  needs: { chain: "mainnet", asset: "USDT", amount: "1000", startDate: "2026-09-29", endDate: "2026-10-29", expenses: [{ id: "e", date: "2026-10-06", amount: "200", asset: "USDT" }], expensesStated: true, bufferAmount: "0", riskProfile: "balanced", acceptUsddRisk: false, timezone: "Asia/Seoul", version: 1 },
  reserved: { total: "200", expensesInHorizon: "200", buffer: "0", outsideHorizon: [] }, investable: "800",
  plans: [{ id: "a", key: "A", title: "USDT 예치", chain: "mainnet", asset: "USDT", inputVersion: 1, horizonDays: 30, principal: "1000", allocation: { invested: "800", held: "200" }, steps: [], baseYield: "10", rewards: { status: "none", note: "" }, costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "2", conversionFees: "0" }, netReturn: "8", eligibility: "eligible", reasons: [], risks: [], assumptions: [], recommended: true, quoteIds: ["q"], dataModes: ["live"], label: "조건부 분석" },
    { id: "h", key: "HOLD", title: "보유", chain: "mainnet", asset: "USDT", inputVersion: 1, horizonDays: 30, principal: "1000", allocation: { invested: "0", held: "1000" }, steps: [], baseYield: "0", rewards: { status: "none", note: "" }, costs: { energy: 0, bandwidth: 0, trx: "0", inAsset: "0", conversionFees: "0" }, netReturn: "0", eligibility: "eligible", reasons: [], risks: [], assumptions: [], recommended: false, quoteIds: [], dataModes: [], label: "조건부 분석" }],
  recommendation: { planId: "a", reason: "test" }, quotes: [{ id: "q", kind: "lending", market: "jUSDT", token: "USDT", address: "T...", chain: "mainnet", active: true, rewards: { status: "none", note: "" }, source: { sourceUrl: "https://example.org", chain: "mainnet", fetchedAt: "2026-09-29T00:00:00Z", mode: "live", accessMethod: "direct" } }], warnings: [], explanation: { text: "", source: "template" }
});

describe("goal monitor", () => {
  it("keeps a valid unchanged plan", () => {
    const b = base();
    expect(assessGoal(b, { ...b, id: "current" }, "A").action).toBe("keep");
  });
  it("pauses a route when net return turns negative", () => {
    const b = base();
    const current = structuredClone(b);
    current.plans[0].netReturn = "-1";
    current.recommendation.planId = "h";
    expect(assessGoal(b, current, "A").action).toBe("pause");
  });
  it("requests review when spending reserve changes", () => {
    const b = base();
    const current = structuredClone(b);
    current.needs.version = 2;
    current.reserved.total = "300";
    current.plans[0].allocation.invested = "700";
    expect(assessGoal(b, current, "A").action).toBe("review");
  });
});
