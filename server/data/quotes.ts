import fs from "node:fs";
import path from "node:path";
import { env } from "../env";
import { chainFees } from "./tron-rpc";
import { fetchMainnetMarkets, fetchNileJtrx, JUSTLEND } from "./justlend";
import { fetchPsm, psmEnergyFromRecentTxs, USDD } from "./usdd";
import { fetchStakingQuote } from "./staking";
import { fetchUsdtTrxSwapQuote } from "./swap";
import { callReadTool, isConnected } from "../mcp/clients";
import type { CostBasis, ProductQuote, SourceMeta } from "../../shared/schemas";
import type { MainnetInputs, NileInputs } from "../../shared/planning";

// ② 데이터 조회 → 정규화 quote. 실패하면 unavailable과 사유를 돌려준다 (과거 값을 현재처럼 쓰지 않음).

export interface Fetched<T> {
  inputs: T;
  failures: string[];
  mode: "live" | "synthetic";
}

const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), "fixtures/synthetic-quotes.json"), "utf8"));

function syntheticSource(chain: "mainnet" | "nile", now: string): SourceMeta {
  return { sourceUrl: "fixtures/synthetic-quotes.json", chain, fetchedAt: now, mode: "synthetic", accessMethod: "fixture", note: "가상 값 (실제 금리 아님)" };
}

function syntheticMainnet(): MainnetInputs {
  const now = new Date().toISOString();
  const src = syntheticSource("mainnet", now);
  const lending = (market: string, token: string, address: string, f: any): ProductQuote => ({
    id: `synthetic:${market}`, kind: "lending", market, token, address, chain: "mainnet",
    baseRate: f.baseRate, rateType: "APY", liquidity: f.liquidity, active: f.active,
    rewards: { status: "unverified", note: "가상 데이터: 보상 미확인" }, source: src,
  });
  return {
    jusdt: lending("jUSDT", "USDT", JUSTLEND.mainnet.jUSDT, fixture.jusdt),
    jusdd: lending("jUSDD", "USDD", JUSTLEND.mainnet.jUSDD, fixture.jusdd),
    psm: {
      id: "synthetic:PSM-USDT", kind: "psm", market: "USDD PSM (USDT)", token: "USDD", address: USDD.psm, chain: "mainnet",
      active: true, rewards: { status: "none", note: "PSM은 수익원이 아닙니다." }, psm: fixture.psm, source: src,
    },
    staking: {
      id: "synthetic:TRX-STAKE-VOTE", kind: "staking", market: "TRX 스테이킹 + SR 투표", token: "TRX", address: fixture.staking.srAddress, chain: "mainnet",
      baseRate: fixture.staking.baseRate, rateType: "APR", active: true,
      rewards: { status: "none", note: "가상 데이터: 투표 보상" },
      staking: { srAddress: fixture.staking.srAddress, srName: "가상 SR", brokerage: "0", unfreezeDelayDays: fixture.staking.unfreezeDelayDays, voteDelayDays: fixture.staking.voteDelayDays },
      source: src,
    },
    swap: {
      ...fixture.swap,
      costs: { toTrx: fixture.swap.costs.toTrx, toUsdt: fixture.swap.costs.toUsdt },
      source: src,
    },
    costBasis: { ...fixture.costBasis, source: src, priceSource: src },
  };
}

/** Mainnet 수수료 파라미터: TronGrid MCP 우선, 실패하면 직접 RPC로 보완하고 그 사실을 기록한다 */
async function mainnetFees(): Promise<{ fees: { energyFeeSun: number; bandwidthFeeSun: number }; meta: Pick<SourceMeta, "accessMethod" | "serverId" | "toolName" | "note"> }> {
  if (isConnected("trongrid")) {
    try {
      const { data, version } = await callReadTool("trongrid", "getChainParameters", {});
      const list = (data as any)?.chainParameter;
      const find = (k: string) => (Array.isArray(list) ? list.find((p: any) => p?.key === k)?.value : undefined);
      const energyFeeSun = Number(find("getEnergyFee"));
      const bandwidthFeeSun = Number(find("getTransactionFee"));
      if (energyFeeSun > 0 && bandwidthFeeSun > 0)
        return { fees: { energyFeeSun, bandwidthFeeSun }, meta: { accessMethod: "mcp", serverId: `trongrid@${version ?? "?"}`, toolName: "getChainParameters" } };
    } catch (e) {
      return { fees: await chainFees("mainnet"), meta: { accessMethod: "direct", note: `TronGrid MCP 실패 → 직접 RPC 대체: ${(e as Error).message}` } };
    }
  }
  return { fees: await chainFees("mainnet"), meta: { accessMethod: "direct" } };
}

let cache: { at: number; value: Fetched<MainnetInputs> } | undefined;
const CACHE_MS = 60_000;

export async function getMainnetInputs(force = false): Promise<Fetched<MainnetInputs>> {
  if (env.dataMode === "synthetic") return { inputs: syntheticMainnet(), failures: [], mode: "synthetic" };
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.value;

  const failures: string[] = [];
  const [markets, psm, feeResult, psmEnergy, staking, swap] = await Promise.all([
    fetchMainnetMarkets().catch((e) => (failures.push(`JustLend 시장 조회 실패: ${e.message}`), undefined)),
    fetchPsm().catch((e) => (failures.push(`USDD PSM 조회 실패: ${e.message}`), undefined)),
    mainnetFees().catch((e) => (failures.push(`Mainnet 수수료 파라미터 조회 실패: ${e.message}`), undefined)),
    psmEnergyFromRecentTxs().catch((e) => (failures.push(`PSM 거래비용 실측 조회 실패: ${e.message}`), undefined)),
    fetchStakingQuote().catch((e) => (failures.push(`TRX 스테이킹 조회 실패: ${e.message}`), undefined)),
    fetchUsdtTrxSwapQuote().catch((e) => (failures.push(`SunSwap USDT↔TRX 조회 실패: ${e.message}`), undefined)),
  ]);
  const now = new Date().toISOString();
  let costBasis: CostBasis | undefined;
  if (feeResult) {
    const { fees, meta } = feeResult;
    costBasis = {
      ...fees,
      trxPerUsdt: markets?.trxPerUsdt,
      psmEnergy,
      source: { sourceUrl: "https://api.trongrid.io/wallet/getchainparameters", chain: "mainnet", fetchedAt: now, mode: "live", note: "getEnergyFee / getTransactionFee", ...meta },
      priceSource: markets
        ? { sourceUrl: JUSTLEND.apiUrl, chain: "mainnet", fetchedAt: markets.fetchedAt, mode: "live", accessMethod: "direct", note: "jUSDT.underlyingPriceInTrx (JustLend 오라클 가격)" }
        : undefined,
    };
  }
  const value: Fetched<MainnetInputs> = { inputs: { jusdt: markets?.jusdt, jusdd: markets?.jusdd, psm, staking, swap, costBasis }, failures, mode: "live" };
  if (!failures.length) cache = { at: Date.now(), value };
  return value;
}

export async function getNileInputs(): Promise<Fetched<Omit<NileInputs, "walletBalanceTrx">>> {
  // 실거래가 켜져 있으면 Nile은 항상 실제 계약 값을 읽는다 (가상 값으로 거래 판단 금지).
  if (env.dataMode === "synthetic" && !env.enableNileExecution) {
    const now = new Date().toISOString();
    const src = syntheticSource("nile", now);
    return {
      inputs: {
        jtrx: {
          id: "synthetic:jTRX", kind: "lending", market: "jTRX", token: "TRX", address: JUSTLEND.nile.jTRX, chain: "nile",
          baseRate: fixture.jtrx.baseRate, rateType: "APR", liquidity: fixture.jtrx.liquidity, active: true,
          rewards: { status: "none", note: "-" }, source: src,
        },
        costBasis: { energyFeeSun: fixture.costBasis.energyFeeSun, bandwidthFeeSun: fixture.costBasis.bandwidthFeeSun, source: src },
      },
      failures: [],
      mode: "synthetic",
    };
  }
  const failures: string[] = [];
  const [jtrx, fees] = await Promise.all([
    fetchNileJtrx().catch((e) => (failures.push(`Nile jTRX 조회 실패: ${e.message}`), undefined)),
    chainFees("nile").catch((e) => (failures.push(`Nile 수수료 파라미터 조회 실패: ${e.message}`), undefined)),
  ]);
  const costBasis: CostBasis | undefined = fees
    ? { ...fees, source: { sourceUrl: "https://nile.trongrid.io/wallet/getchainparameters", chain: "nile", fetchedAt: new Date().toISOString(), mode: "live", accessMethod: "direct" } }
    : undefined;
  return { inputs: { jtrx, costBasis }, failures, mode: "live" };
}
