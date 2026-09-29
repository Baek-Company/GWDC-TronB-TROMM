import { env, publicConfig, redact } from "./env";
import { createNim } from "./llm/nim";
import { contractExists, nowBlock } from "./data/tron-rpc";
import { fetchMainnetMarkets, fetchNileJtrx, JUSTLEND } from "./data/justlend";
import { fetchPsm, psmEnergyFromRecentTxs } from "./data/usdd";
import { closeAll, connectAll } from "./mcp/clients";
import { checkToolCall } from "./mcp/registry";
import { emptyNeeds, todaySeoul } from "../shared/needs";

// 외부 연결 진단. 결과를 성공 / 실패 / 미확인으로 기록한다. 키 값은 출력하지 않는다.

type Result = { name: string; status: "성공" | "실패" | "미확인"; detail: string };
const results: Result[] = [];

async function check(name: string, fn: () => Promise<string>, skip?: string) {
  if (skip) return results.push({ name, status: "미확인", detail: skip });
  const t0 = Date.now();
  try {
    const detail = await fn();
    results.push({ name, status: "성공", detail: `${detail} (${Date.now() - t0}ms)` });
  } catch (e) {
    results.push({ name, status: "실패", detail: redact(String((e as Error).message ?? e)) });
  }
}

console.log("설정:", JSON.stringify(publicConfig()));

await check("TronGrid Mainnet", async () => `블록 ${await nowBlock("mainnet")}`, env.trongridApiKey ? undefined : "TRONGRID_API_KEY 없음");
await check("TronGrid Nile", async () => `블록 ${await nowBlock("nile")}`);
await check("JustLend OpenAPI (jUSDT/jUSDD)", async () => {
  const m = await fetchMainnetMarkets();
  return `jUSDT APY ${m.jusdt.baseRate} active=${m.jusdt.active}, jUSDD APY ${m.jusdd.baseRate} active=${m.jusdd.active}, 1 USDT=${m.trxPerUsdt} TRX`;
});
await check("USDD PSM 온체인", async () => {
  const p = await fetchPsm();
  return `tin=${p.psm!.feeIn} tout=${p.psm!.feeOut} sell=${p.psm!.sellEnabled} buy=${p.psm!.buyEnabled} 진입여유=${p.psm!.entryCapacity} 출구USDT=${p.psm!.exitLiquidity}`;
});
await check("PSM 거래비용 실측", async () => {
  const e = await psmEnergyFromRecentTxs();
  if (!e) throw new Error("최근 성공 거래에서 sell/buy를 모두 찾지 못함");
  return `sell≤${e.sell} buy≤${e.buy} energy (표본 ${e.sampleSize})`;
});
await check("Nile jTRX 계약", async () => {
  const c = await contractExists("nile", JUSTLEND.nile.jTRX);
  if (!c.exists) throw new Error("계약 없음");
  const q = await fetchNileJtrx();
  return `${c.name}, APR ${q.baseRate}, 현금 ${q.liquidity} TRX, active=${q.active}`;
});
await check(
  "LLM (NIM) 추출",
  async () => {
    const r = await createNim().extractNeeds([{ role: "user", content: "1,000 USDT를 30일 운용하고 7일 뒤 200 USDT를 써요" }], emptyNeeds("mainnet"), todaySeoul());
    return `${env.nimModel}: ${JSON.stringify(r.patch)}`;
  },
  env.nimApiKey ? undefined : "NIM_API_KEY 없음",
);
await check("MCP 허용 목록 거부 테스트", async () => {
  const bad = checkToolCall("justlend", "supply", {});
  const unknown = checkToolCall("usdd", "psm_sell_gem", {});
  const okCall = checkToolCall("usdd", "get_psm_status", { market: "PSM-USDT", network: "tron" });
  if (bad.ok || unknown.ok || !okCall.ok) throw new Error("허용 목록 판정 오류");
  return "쓰기 도구 거부, 읽기 도구 허용 확인";
});
await check("MCP 연결", async () => {
  const s = await connectAll();
  await closeAll();
  return s.map((x) => `${x.server}=${x.state}${x.tools ? ` (허용 ${x.tools.allowed.length}, 누락 ${x.tools.missing.length})` : ""}${x.error ? ` [${x.error}]` : ""}`).join(", ");
});

console.log("\n=== doctor 결과 ===");
for (const r of results) console.log(`[${r.status}] ${r.name} — ${r.detail}`);
process.exit(results.some((r) => r.status === "실패") ? 1 : 0);
