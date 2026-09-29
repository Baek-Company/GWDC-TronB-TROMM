import { TronWeb } from "tronweb";
import { readWords } from "./tron-rpc";
import type { SwapQuote } from "../../shared/schemas";
import { Decimal } from "../../shared/units";

const ROUTER = "TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax";
const USDT = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const TYPICAL_SWAP = { energy: 120_000, bandwidth: 320 };
const CACHE_MS = 60_000;

let cached: { at: number; value: SwapQuote } | undefined;

function address(word: string) {
  return TronWeb.address.fromHex("41" + word.slice(-40));
}

function integer(word: string) {
  return BigInt("0x" + word);
}

/** Read the live USDT/WTRX reserves used to estimate a round-trip stake conversion. */
export async function fetchUsdtTrxSwapQuote(): Promise<SwapQuote> {
  if (cached && Date.now() - cached.at < CACHE_MS) return cached.value;
  const [wtrxWord, factoryWord] = await Promise.all([
    readWords("mainnet", ROUTER, "WETH()"),
    readWords("mainnet", ROUTER, "factory()"),
  ]);
  const wtrx = address(wtrxWord[0]);
  const factory = address(factoryWord[0]);
  const pairWord = await readWords("mainnet", factory, "getPair(address,address)", [
    { type: "address", value: USDT },
    { type: "address", value: wtrx },
  ]);
  const pair = address(pairWord[0]);
  if (pair === "T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb") throw new Error("SunSwap USDT/WTRX 풀이 없습니다.");
  const [token0Word, reserves] = await Promise.all([
    readWords("mainnet", pair, "token0()"),
    readWords("mainnet", pair, "getReserves()"),
  ]);
  const token0 = address(token0Word[0]);
  const reserve0 = integer(reserves[0]);
  const reserve1 = integer(reserves[1]);
  const [usdtRaw, trxRaw] = token0 === USDT ? [reserve0, reserve1] : [reserve1, reserve0];
  const value: SwapQuote = {
    router: ROUTER,
    pair,
    reserveUsdt: new Decimal(usdtRaw.toString()).div(1_000_000).toFixed(),
    reserveTrx: new Decimal(trxRaw.toString()).div(1_000_000).toFixed(),
    feeNumerator: 997,
    costs: { toTrx: TYPICAL_SWAP, toUsdt: TYPICAL_SWAP },
    source: {
      sourceUrl: `https://tronscan.org/#/contract/${pair}`,
      chain: "mainnet",
      fetchedAt: new Date().toISOString(),
      mode: "live",
      accessMethod: "direct",
      note: "SunSwap V2 USDT/WTRX getReserves 기반 추정. 교환 Energy는 보수적 일반값입니다.",
    },
  };
  cached = { at: Date.now(), value };
  return value;
}
