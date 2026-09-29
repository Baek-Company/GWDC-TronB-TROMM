import Decimal from "decimal.js";
import { getJson, readUint, readWords } from "./tron-rpc";
import { fromBaseUnits } from "../../shared/units";
import type { ProductQuote } from "../../shared/schemas";

// USDD PSM(USDT) 독립 조회. JustLend와 별개의 계약 경로다.
// 주소 출처: https://docs.usdd.io/developers/deployment-addresses , 공식 USDD MCP src/core/chains.ts

export const USDD = {
  docsUrl: "https://docs.usdd.io/developers/deployment-addresses",
  psm: "TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz", // MCD_PSM_USDT_A
  gemJoin: "TSUYvQ5tdd3DijCD1uGunGLpftHuSZ12sQ", // JOIN_PSM_USDT_A
  vat: "TH5dhX7o39afSbfDT2e3c9k4itWjNKD4D9",
  usdt: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
  usdd: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
  sellGemSelector: "95991276",
  buyGemSelector: "8d7ef9bb",
};

const WAD = new Decimal("1e18");
const RAD = new Decimal("1e45");

export async function fetchPsm(): Promise<ProductQuote> {
  const fetchedAt = new Date().toISOString();
  const [tin, tout, sell, buy, ilkWords, exitRaw] = await Promise.all([
    readUint("mainnet", USDD.psm, "tin()"),
    readUint("mainnet", USDD.psm, "tout()"),
    readUint("mainnet", USDD.psm, "sellEnabled()"),
    readUint("mainnet", USDD.psm, "buyEnabled()"),
    readWords("mainnet", USDD.psm, "ilk()"),
    readUint("mainnet", USDD.usdt, "balanceOf(address)", [{ type: "address", value: USDD.gemJoin }]),
  ]);
  // Vat.ilks(ilk) → (Art wad, rate ray, spot ray, line rad, dust rad). 진입 여유 = line − Art×rate
  let entryCapacity: string | undefined;
  try {
    const w = await readWords("mainnet", USDD.vat, "ilks(bytes32)", [{ type: "bytes32", value: "0x" + ilkWords[0] }]);
    const Art = BigInt("0x" + w[0]);
    const rate = BigInt("0x" + w[1]);
    const line = BigInt("0x" + w[3]);
    const room = line - Art * rate;
    entryCapacity = Decimal.max(new Decimal(room.toString()).div(RAD), 0).toFixed();
  } catch {
    entryCapacity = undefined;
  }
  return {
    id: "mainnet:PSM-USDT",
    kind: "psm",
    market: "USDD PSM (USDT)",
    token: "USDD",
    address: USDD.psm,
    chain: "mainnet",
    active: sell === 1n && buy === 1n,
    inactiveReason: sell !== 1n || buy !== 1n ? "PSM 전환 방향 중 하나 이상이 비활성입니다" : undefined,
    rewards: { status: "none", note: "PSM은 전환 경로이며 수익원이 아닙니다." },
    psm: {
      feeIn: new Decimal(tin.toString()).div(WAD).toFixed(),
      feeOut: new Decimal(tout.toString()).div(WAD).toFixed(),
      sellEnabled: sell === 1n,
      buyEnabled: buy === 1n,
      entryCapacity,
      exitLiquidity: fromBaseUnits(exitRaw, 6),
    },
    source: {
      sourceUrl: `https://tronscan.org/#/contract/${USDD.psm}`,
      chain: "mainnet",
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: "PSM.tin/tout/sellEnabled/buyEnabled, Vat.ilks(PSM-USDT-A), USDT.balanceOf(GemJoin) 온체인 읽기",
    },
  };
}

/** 최근 성공한 PSM 전환 거래의 실제 Energy 사용량(최대값)을 비용 근거로 쓴다 */
export async function psmEnergyFromRecentTxs(): Promise<{ sell: number; buy: number; sampleSize: number } | undefined> {
  const j = await getJson<{ data?: any[] }>("mainnet", `/v1/accounts/${USDD.psm}/transactions?only_to=true&only_confirmed=true&limit=50`);
  let sell = 0;
  let buy = 0;
  let n = 0;
  for (const t of j.data ?? []) {
    if (t?.ret?.[0]?.contractRet !== "SUCCESS") continue;
    const data: string = t?.raw_data?.contract?.[0]?.parameter?.value?.data ?? "";
    const e = Number(t.energy_usage_total ?? 0);
    if (data.startsWith(USDD.sellGemSelector)) (sell = Math.max(sell, e)), n++;
    else if (data.startsWith(USDD.buyGemSelector)) (buy = Math.max(buy, e)), n++;
  }
  if (!sell || !buy) return undefined;
  return { sell, buy, sampleSize: n };
}
