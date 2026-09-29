import { describe, expect, it } from "vitest";
import { parsePatch } from "../server/llm/nim";
import { preserveExplicitHolding, templateExtract } from "../server/llm/template";
import { applyPatch, demoNeeds, emptyNeeds, inputProblems } from "../shared/needs";
import { checkToolCall, filterDiscovered } from "../server/mcp/registry";

describe("LLM 응답 검증", () => {
  it("코드 블록·숫자 금액을 정규화해 스키마로 검증한다", () => {
    const r = parsePatch('```json\n{"amount":1000,"durationDays":30,"expenses":[{"inDays":7,"amount":"200","asset":"USDT"}]}\n```');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.patch.amount).toBe("1000");
  });
  it("보유 자산 단위를 검증한다", () => {
    const result = parsePatch('{"asset":"TRX","amount":10000,"expenses":[{"inDays":100,"amount":1000,"asset":"USDT"}]}');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.patch).toMatchObject({ asset: "TRX", amount: "10000", expenses: [{ asset: "USDT", amount: "1000" }] });
  });
  it("형식 오류와 잘못된 값은 거부한다", () => {
    expect(parsePatch("죄송합니다").ok).toBe(false);
    expect(parsePatch('{"amount":"천"}').ok).toBe(false);
    expect(parsePatch('{"riskProfile":"yolo"}').ok).toBe(false);
  });
});

describe("템플릿 추출 (LLM 장애 시)", () => {
  it("고정 사례 문장을 추출한다", () => {
    const p = templateExtract("1,000 USDT를 30일 운용하고, 7일 뒤에 200 USDT를 써야 해요. 여유액은 없어요.", undefined, "2026-09-29");
    expect(p.amount).toBe("1000");
    expect(p.durationDays).toBe(30);
    expect(p.expenses).toEqual([{ inDays: 7, amount: "200", asset: "USDT" }]);
    expect(p.bufferAmount).toBe("0");
  });
  it("직전 질문에 대한 짧은 답을 해석한다", () => {
    expect(templateExtract("네", "acceptUsddRisk").acceptUsddRisk).toBe(true);
    expect(templateExtract("아니요", "acceptUsddRisk").acceptUsddRisk).toBe(false);
    expect(templateExtract("균형형이요").riskProfile).toBe("balanced");
    expect(templateExtract("0", "bufferAmount").bufferAmount).toBe("0");
  });
  it("지출일 변경 문장", () => {
    expect(templateExtract("지출일을 45일 뒤로 바꿔 주세요", undefined, "2026-09-29", demoNeeds("2026-09-29")).expenses?.[0]).toMatchObject({ inDays: 45, amount: "200" });
    expect(templateExtract("45일 뒤에 200 USDT 지출").expenses?.[0].inDays).toBe(45);
  });
  it("TRX 보유액과 USDT 지출을 서로 다른 자산으로 보존한다", () => {
    const text = "10000trx를 1500일간 운용하고 100일 후 1000usdt가 필요하고 공격적으로 투자할 것이며 usdd의 위험은 감수할거야";
    const extracted = templateExtract(text, undefined, "2026-09-30");
    expect(extracted).toMatchObject({ asset: "TRX", amount: "10000", durationDays: 1500, expenses: [{ inDays: 100, amount: "1000", asset: "USDT" }], riskProfile: "aggressive", acceptUsddRisk: true });
    const corrected = preserveExplicitHolding({ amount: "10000", asset: "USDT" }, text, undefined, "2026-09-30");
    expect(corrected.asset).toBe("TRX");
    const { needs } = applyPatch(emptyNeeds("mainnet", "2026-09-30"), extracted);
    expect(needs.asset).toBe("TRX");
    expect(needs.expenses[0].asset).toBe("USDT");
    expect(inputProblems(needs)).toEqual([]);
  });
  it("금액이 날짜보다 앞에 오는 TRX 지출을 구분한다", () => {
    const patch = templateExtract("10000 TRX를 1500일간 운용하고 1000 TRX가 150일 후 필요해", undefined, "2026-09-30");
    expect(patch).toMatchObject({ amount: "10000", asset: "TRX", durationDays: 1500, expenses: [{ amount: "1000", asset: "TRX", inDays: 150 }] });
  });
  it("요청 문장의 TRX 보유와 150일 뒤 USDT 지출을 분리한다", () => {
    const patch = templateExtract("10000trx를 1500일간 운용하는데 1000usdt가 150일 후 필요하고 공격적으로 투자하며 usdd 위험을 감수할거야", undefined, "2026-09-30");
    expect(patch).toMatchObject({ amount: "10000", asset: "TRX", durationDays: 1500, expenses: [{ amount: "1000", asset: "USDT", inDays: 150 }], riskProfile: "aggressive", acceptUsddRisk: true });
  });
});

describe("MCP 허용 목록", () => {
  it("쓰기·지갑 도구와 목록 밖 도구, 잘못된 인자를 거부한다", () => {
    expect(checkToolCall("justlend", "supply", {}).ok).toBe(false);
    expect(checkToolCall("usdd", "psm_sell_gem", {}).ok).toBe(false);
    expect(checkToolCall("trongrid", "broadcastTransaction", {}).ok).toBe(false);
    expect(checkToolCall("trongrid", "getAccount", {}).ok).toBe(false);
    expect(checkToolCall("usdd", "get_psm_status", { market: "PSM-USDC", network: "tron" }).ok).toBe(false);
    expect(checkToolCall("usdd", "get_psm_status", { market: "PSM-USDT", network: "tron" }).ok).toBe(true);
    expect(checkToolCall("trongrid", "getChainParameters", {}).ok).toBe(true);
  });
  it("발견된 도구 중 허용된 읽기 도구만 노출한다", () => {
    const f = filterDiscovered("trongrid", ["getChainParameters", "broadcastHex", "createTransaction"]);
    expect(f.allowed).toEqual(["getChainParameters"]);
    expect(f.blocked).toEqual(["broadcastHex", "createTransaction"]);
  });
});

describe("AI 설명 숫자 검증", () => {
  it("계산 결과에 없는 숫자를 찾아낸다", async () => {
    const { unknownNumbers } = await import("../server/llm/provider");
    const data = { investable: "800", plans: [{ netReturn: "-6.1", breakEvenDays: "146320", baseRatePercent: "2.0022" }] };
    expect(unknownNumbers("800 USDT를 예치하면 순수익 -6.10 USDT, 손익분기 146,320일, 금리 2.0022%", data)).toEqual([]);
    expect(unknownNumbers("손익분기는 1,463,199일입니다", data)).toEqual(["1,463,199"]);
    expect(unknownNumbers("계획 A와 B 중 2개", data)).toEqual([]);
  });
});
