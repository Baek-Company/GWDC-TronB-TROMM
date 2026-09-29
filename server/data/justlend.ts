import Decimal from "decimal.js";
import { readUint, readWords } from "./tron-rpc";
import { fromBaseUnits } from "../../shared/units";
import type { ProductQuote } from "../../shared/schemas";

// JustLend 시장 데이터.
// Mainnet: 공식 OpenAPI(GET /lend/jtoken) + Comptroller 온체인 읽기로 활성 여부 확인.
// Nile: 공식 API가 Nile을 색인하지 않으므로 jTRX 계약을 직접 읽는다.

export const JUSTLEND = {
  apiUrl: "https://openapi.just.network/lend/jtoken",
  docsUrl: "https://docs.justlend.org/developers/deployed_contracts/",
  mainnet: {
    comptroller: "TGjYzgCyPobsNS9n6WcbdLVR9dH7mWqFx7",
    jUSDT: "TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd",
    jUSDD: "TKFRELGGoRgiayhwJTNNLqCNjFoLBh3Mnf",
    USDT: "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t",
    USDD: "TXDk8mbtRbXeYuMNS83CfKPaYYT8XWv9Hz",
  },
  nile: {
    comptroller: "TJUCStq3WqfKqZLuZje5v7z6Ua6iBry1P6",
    // 출처: 공식 JustLend MCP 서버 src/core/chains.ts (Nile 섹션). 온체인 getcontract로 코드 존재를 확인한다.
    jTRX: "TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq",
  },
  /** JustLend 계약의 연간 블록 수 (3초 블록) */
  blocksPerYear: 10_512_000,
} as const;

interface ApiToken {
  address: string;
  symbol: string;
  underlyingSymbol: string;
  underlyingAddress: string;
  underlyingPriceInTrx: string;
  underlyingDecimal: number;
  supplyRate: string;
  cash: string;
  exchangeRate: string;
}

async function mintPaused(chain: "mainnet" | "nile", comptroller: string, jToken: string): Promise<boolean | undefined> {
  try {
    return (await readUint(chain, comptroller, "mintGuardianPaused(address)", [{ type: "address", value: jToken }])) !== 0n;
  } catch {
    return undefined;
  }
}

export async function fetchMainnetMarkets(): Promise<{ jusdt: ProductQuote; jusdd: ProductQuote; trxPerUsdt?: string; fetchedAt: string }> {
  const fetchedAt = new Date().toISOString();
  const r = await fetch(JUSTLEND.apiUrl, { signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error(`JustLend API HTTP ${r.status}`);
  const body = (await r.json()) as { code: number; data?: { tokenList?: ApiToken[] } };
  if (body.code !== 0 || !Array.isArray(body.data?.tokenList)) throw new Error("JustLend API 응답 스키마가 예상과 다릅니다.");
  const list = body.data!.tokenList!;

  const [pausedUsdt, pausedUsdd] = await Promise.all([
    mintPaused("mainnet", JUSTLEND.mainnet.comptroller, JUSTLEND.mainnet.jUSDT),
    mintPaused("mainnet", JUSTLEND.mainnet.comptroller, JUSTLEND.mainnet.jUSDD),
  ]);

  const build = (symbol: "jUSDT" | "jUSDD", paused: boolean | undefined): ProductQuote => {
    const expected = JUSTLEND.mainnet[symbol];
    const t = list.find((x) => x.symbol === symbol);
    const source = {
      sourceUrl: JUSTLEND.apiUrl,
      chain: "mainnet" as const,
      fetchedAt,
      mode: "live" as const,
      accessMethod: "direct" as const,
      note: "JustLend 공식 OpenAPI + Comptroller.mintGuardianPaused 온체인 읽기",
    };
    if (!t) return { id: `mainnet:${symbol}`, kind: "lending", market: symbol, token: symbol.slice(1), address: expected, chain: "mainnet", active: false, inactiveReason: "API 목록에 시장이 없습니다", rewards: { status: "unverified", note: "-" }, source };
    const addressOk = t.address === expected;
    const inactiveReason = !addressOk
      ? `API 주소(${t.address})가 공식 배포 주소(${expected})와 다릅니다`
      : paused === true
        ? "예치(mint)가 일시 중지 상태입니다"
        : paused === undefined
          ? "Comptroller에서 예치 중지 여부를 확인하지 못했습니다"
          : undefined;
    return {
      id: `mainnet:${symbol}`,
      kind: "lending",
      market: symbol,
      token: t.underlyingSymbol,
      address: t.address,
      chain: "mainnet",
      baseRate: new Decimal(t.supplyRate).toFixed(),
      rateType: "APY",
      underlyingDecimals: t.underlyingDecimal,
      liquidity: new Decimal(t.cash).toFixed(),
      active: !inactiveReason,
      inactiveReason,
      rewards: { status: "unverified", note: "JustLend 채굴 보상은 자격·지급 자산·청구 조건을 확인하지 않아 미확인으로 두고 기본 수익에서 제외합니다." },
      source,
    };
  };

  const usdt = list.find((x) => x.symbol === "jUSDT");
  // underlyingPriceInTrx(USDT) = 1 USDT가 몇 TRX인지. TRX 수수료를 USDT로 환산하는 근거로 쓴다.
  const trxPerUsdt = usdt?.underlyingPriceInTrx ? new Decimal(usdt.underlyingPriceInTrx).toFixed() : undefined;
  return { jusdt: build("jUSDT", pausedUsdt), jusdd: build("jUSDD", pausedUsdd), trxPerUsdt, fetchedAt };
}

export async function fetchNileJtrx(): Promise<ProductQuote> {
  const fetchedAt = new Date().toISOString();
  const a = JUSTLEND.nile.jTRX;
  const [ratePerBlock, cashSun, paused] = await Promise.all([
    readUint("nile", a, "supplyRatePerBlock()"),
    readUint("nile", a, "getCash()"),
    mintPaused("nile", JUSTLEND.nile.comptroller, a),
  ]);
  const apr = new Decimal(ratePerBlock.toString()).mul(JUSTLEND.blocksPerYear).div("1e18");
  return {
    id: "nile:jTRX",
    kind: "lending",
    market: "jTRX",
    token: "TRX",
    address: a,
    chain: "nile",
    baseRate: apr.toFixed(),
    rateType: "APR",
    underlyingDecimals: 6,
    liquidity: fromBaseUnits(cashSun, 6),
    active: paused === false,
    inactiveReason: paused === true ? "예치(mint)가 일시 중지 상태입니다" : paused === undefined ? "예치 중지 여부를 확인하지 못했습니다" : undefined,
    rewards: { status: "none", note: "Nile 보상은 계산하지 않습니다." },
    source: {
      sourceUrl: `https://nile.tronscan.org/#/contract/${a}`,
      chain: "nile",
      fetchedAt,
      mode: "live",
      accessMethod: "direct",
      note: "jTRX.supplyRatePerBlock/getCash + Comptroller.mintGuardianPaused 온체인 읽기",
    },
  };
}

/** 지갑의 jTRX 포지션: jToken 잔고 × exchangeRateStored → 기초자산 TRX */
export async function nileJtrxPosition(wallet: string) {
  const a = JUSTLEND.nile.jTRX;
  const [bal, rate] = await Promise.all([
    readUint("nile", a, "balanceOf(address)", [{ type: "address", value: wallet }]),
    readUint("nile", a, "exchangeRateStored()"),
  ]);
  // underlying(sun) = jToken(1e8 단위) × rate / 1e18
  const underlyingSun = (bal * rate) / 10n ** 18n;
  return { jTokenRaw: bal, jToken: fromBaseUnits(bal, 8), exchangeRateRaw: rate, underlyingSun, underlyingTrx: fromBaseUnits(underlyingSun, 6) };
}

export { readWords };
