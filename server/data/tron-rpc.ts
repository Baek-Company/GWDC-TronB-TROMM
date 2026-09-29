import { TronWeb } from "tronweb";
import { env } from "../env";
import type { Chain } from "../../shared/schemas";

// TronGrid 직접 RPC. MCP로 대체하지 않은 체인 조회(계약 읽기, 잔고, 영수증, 수수료 파라미터)를 맡는다.

export const HOSTS: Record<Chain, string> = {
  mainnet: "https://api.trongrid.io",
  nile: "https://nile.trongrid.io",
};
export const EXPLORER: Record<Chain, string> = {
  mainnet: "https://tronscan.org/#/transaction/",
  nile: "https://nile.tronscan.org/#/transaction/",
};

/** 읽기 전용 호출에 쓰는 임의 owner 주소 (서명·전송 없음) */
const READ_OWNER = "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb";
const TIMEOUT_MS = 15000;

const clients: Partial<Record<Chain, TronWeb>> = {};
function tw(chain: Chain): TronWeb {
  if (!clients[chain]) {
    const headers: Record<string, string> = env.trongridApiKey ? { "TRON-PRO-API-KEY": env.trongridApiKey } : {};
    clients[chain] = new TronWeb({ fullHost: HOSTS[chain], headers });
  }
  return clients[chain]!;
}

function withTimeout<T>(p: Promise<T>, what: string): Promise<T> {
  return Promise.race([p, new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`${what} 시간 초과`)), TIMEOUT_MS))]);
}

export async function post<T = any>(chain: Chain, pathname: string, body: unknown): Promise<T> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (env.trongridApiKey) headers["TRON-PRO-API-KEY"] = env.trongridApiKey;
  const r = await fetch(HOSTS[chain] + pathname, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`TronGrid ${pathname} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

export async function getJson<T = any>(chain: Chain, pathname: string): Promise<T> {
  const headers: Record<string, string> = {};
  if (env.trongridApiKey) headers["TRON-PRO-API-KEY"] = env.trongridApiKey;
  const r = await fetch(HOSTS[chain] + pathname, { headers, signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!r.ok) throw new Error(`TronGrid ${pathname} HTTP ${r.status}`);
  return r.json() as Promise<T>;
}

/** view 함수 호출 → 32바이트 워드 배열(hex) */
export async function readWords(chain: Chain, contract: string, signature: string, params: { type: string; value: unknown }[] = []): Promise<string[]> {
  const r: any = await withTimeout(tw(chain).transactionBuilder.triggerConstantContract(contract, signature, {}, params as any, READ_OWNER), signature);
  const hex: string | undefined = r?.constant_result?.[0];
  if (!r?.result?.result || hex === undefined) throw new Error(`${signature} 호출 실패: ${r?.result?.message ?? "응답 없음"}`);
  return hex.match(/.{1,64}/g) ?? [];
}

export async function readUint(chain: Chain, contract: string, signature: string, params: { type: string; value: unknown }[] = []): Promise<bigint> {
  const words = await readWords(chain, contract, signature, params);
  if (!words[0]) throw new Error(`${signature} 빈 응답`);
  return BigInt("0x" + words[0]);
}

export async function chainFees(chain: Chain): Promise<{ energyFeeSun: number; bandwidthFeeSun: number }> {
  const r = await post<{ chainParameter: { key: string; value?: number }[] }>(chain, "/wallet/getchainparameters", {});
  const find = (k: string) => r.chainParameter.find((p) => p.key === k)?.value;
  const energyFeeSun = find("getEnergyFee");
  const bandwidthFeeSun = find("getTransactionFee");
  if (!energyFeeSun || !bandwidthFeeSun) throw new Error("수수료 파라미터 없음");
  return { energyFeeSun, bandwidthFeeSun };
}

export async function trxBalanceSun(chain: Chain, address: string): Promise<bigint> {
  const r = await post<{ balance?: number }>(chain, "/wallet/getaccount", { address, visible: true });
  return BigInt(r.balance ?? 0);
}

export async function contractExists(chain: Chain, address: string): Promise<{ exists: boolean; name?: string }> {
  const r = await post<{ contract_address?: string; name?: string }>(chain, "/wallet/getcontract", { value: address, visible: true });
  return { exists: Boolean(r.contract_address), name: r.name };
}

export async function nowBlock(chain: Chain): Promise<number> {
  const r = await post<any>(chain, "/wallet/getnowblock", {});
  return r?.block_header?.raw_data?.number;
}

/** 확정(solidity) 노드의 영수증과 최신 노드의 영수증을 함께 본다 */
export async function txInfo(chain: Chain, txId: string) {
  const [solid, latest] = await Promise.all([
    post<any>(chain, "/walletsolidity/gettransactioninfobyid", { value: txId }).catch(() => ({})),
    post<any>(chain, "/wallet/gettransactioninfobyid", { value: txId }).catch(() => ({})),
  ]);
  return { solid, latest };
}

export function isBase58Address(a: string): boolean {
  return /^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(a) && TronWeb.isAddress(a);
}
