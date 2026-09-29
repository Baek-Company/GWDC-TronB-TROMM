import { z } from "zod";

// 팀 공통 계약. 금액은 모두 문자열(Decimal 문자열)로 주고받는다.

export const DecimalString = z.string().regex(/^\d+(\.\d+)?$/, "숫자 문자열이어야 합니다");
export const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "YYYY-MM-DD 형식이어야 합니다");

export const Chain = z.enum(["mainnet", "nile"]);
export type Chain = z.infer<typeof Chain>;

export const DataMode = z.enum(["live", "snapshot", "synthetic"]);
export type DataMode = z.infer<typeof DataMode>;

export const RiskProfile = z.enum(["conservative", "balanced", "aggressive"]);
export type RiskProfile = z.infer<typeof RiskProfile>;

/** 모든 외부 값에 붙는 출처 메타데이터 */
export const SourceMeta = z.object({
  sourceUrl: z.string(),
  chain: Chain,
  fetchedAt: z.string(),
  sourceUpdatedAt: z.string().optional(),
  mode: DataMode,
  accessMethod: z.enum(["mcp", "direct", "fixture"]),
  serverId: z.string().optional(),
  toolName: z.string().optional(),
  note: z.string().optional(),
});
export type SourceMeta = z.infer<typeof SourceMeta>;

// ---------------------------------------------------------------- UserNeeds

export const Expense = z.object({
  id: z.string(),
  date: IsoDate,
  amount: DecimalString,
  asset: z.string(),
  label: z.string().optional(),
});
export type Expense = z.infer<typeof Expense>;

export const UserNeeds = z.object({
  chain: Chain,
  asset: z.enum(["USDT", "TRX"]),
  amount: DecimalString.optional(),
  startDate: IsoDate,
  endDate: IsoDate.optional(),
  expenses: z.array(Expense),
  /** 사용자가 "지출 없음"을 명시했거나 지출 목록을 확인했는지 */
  expensesStated: z.boolean(),
  bufferAmount: DecimalString.optional(),
  riskProfile: RiskProfile.optional(),
  acceptUsddRisk: z.boolean().optional(),
  timezone: z.literal("Asia/Seoul"),
  version: z.number().int().nonnegative(),
});
export type UserNeeds = z.infer<typeof UserNeeds>;

/** LLM(또는 템플릿 파서)이 돌려주는 추출 결과. 명시된 정보만 채운다. */
export const NeedsPatch = z.object({
  asset: z.enum(["USDT", "TRX"]).nullish(),
  amount: DecimalString.nullish(),
  durationDays: z.number().int().positive().max(3650).nullish(),
  endDate: IsoDate.nullish(),
  expenses: z
    .array(
      z.object({
        date: IsoDate.nullish(),
        inDays: z.number().int().nonnegative().max(3650).nullish(),
        amount: DecimalString,
        asset: z.string().nullish(),
        label: z.string().nullish(),
      }),
    )
    .nullish(),
  noExpenses: z.boolean().nullish(),
  bufferAmount: DecimalString.nullish(),
  riskProfile: RiskProfile.nullish(),
  acceptUsddRisk: z.boolean().nullish(),
});
export type NeedsPatch = z.infer<typeof NeedsPatch>;

export const ChatMessage = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().max(2000),
});
export type ChatMessage = z.infer<typeof ChatMessage>;

export type MissingField = "amount" | "endDate" | "expenses" | "bufferAmount" | "riskProfile" | "acceptUsddRisk";

export interface ChatResponse {
  needs: UserNeeds;
  missing: MissingField[];
  problems: string[];
  reply: string;
  state: "collecting" | "awaiting_confirmation";
  llm: { provider: string; model?: string; used: boolean; fallbackReason?: string; latencyMs?: number };
}

// ---------------------------------------------------------------- ProductQuote

export const ProductQuote = z.object({
  id: z.string(),
  kind: z.enum(["lending", "psm", "staking"]),
  market: z.string(),
  token: z.string(),
  address: z.string(),
  chain: Chain,
  /** 기본 공급 금리 (소수, 예: 0.02 = 2%) */
  baseRate: DecimalString.optional(),
  rateType: z.enum(["APY", "APR"]).optional(),
  underlyingDecimals: z.number().int().optional(),
  /** 시장에서 즉시 인출 가능한 기초자산 수량 */
  liquidity: DecimalString.optional(),
  active: z.boolean(),
  inactiveReason: z.string().optional(),
  rewards: z.object({ status: z.enum(["verified", "unverified", "none"]), apr: DecimalString.optional(), note: z.string() }),
  psm: z
    .object({
      feeIn: DecimalString,
      feeOut: DecimalString,
      sellEnabled: z.boolean(),
      buyEnabled: z.boolean(),
      /** USDT → USDD 전환 가능 여유 (부채 한도 기준) */
      entryCapacity: DecimalString.optional(),
      /** USDD → USDT 전환 가능 물량 (PSM 보유 USDT) */
      exitLiquidity: DecimalString.optional(),
    })
    .optional(),
  /** Stake 2.0 and a single SR vote route. */
  staking: z
    .object({
      srAddress: z.string(),
      srName: z.string(),
      brokerage: DecimalString,
      unfreezeDelayDays: z.number().int().positive(),
      voteDelayDays: DecimalString.optional(),
    })
    .optional(),
  source: SourceMeta,
});
export type ProductQuote = z.infer<typeof ProductQuote>;

export const CostBasis = z.object({
  energyFeeSun: z.number(),
  bandwidthFeeSun: z.number(),
  /** 1 USDT가 몇 TRX인지 (TRX 비용을 USDT로 환산할 근거). 없으면 순수익 산정 불가 */
  trxPerUsdt: DecimalString.optional(),
  /** PSM 전환 Energy: 최근 성공 거래의 실측 최대값 */
  psmEnergy: z.object({ sell: z.number(), buy: z.number(), sampleSize: z.number() }).optional(),
  source: SourceMeta,
  priceSource: SourceMeta.optional(),
});
export type CostBasis = z.infer<typeof CostBasis>;

// ---------------------------------------------------------------- Plan

export interface PlanStep {
  action: "hold" | "approve" | "psm_sell" | "supply" | "withdraw" | "psm_buy" | "swap" | "stake" | "vote" | "claim" | "unstake";
  label: string;
  asset: string;
  amount: string;
  contract?: string;
  energy: number;
  bandwidth: number;
  energySource: string;
  /** Days after the analysis start date when this action should be prepared. */
  day?: number;
}

export interface PlanCosts {
  energy: number;
  bandwidth: number;
  trx: string;
  /** 평가 자산(USDT/TRX) 기준. 환산 근거가 없으면 undefined */
  inAsset?: string;
  conversionFees: string;
}

export type LadderProduct = "HOLD" | "JUSDT" | "JUSDD" | "STAKE" | "MIXED";

export interface LadderAllocation {
  product: Exclude<LadderProduct, "MIXED">;
  productLabel: string;
  amount: string;
  expectedYield: string;
}

export interface LadderBucket {
  id: string;
  label: string;
  amount: string;
  needDate: string;
  /** The asset must be available by this date, before the scheduled expense. */
  exitStartDate: string;
  /** Applies only to Stake 2.0 allocations. */
  unstakeDate?: string;
  product: LadderProduct;
  productLabel: string;
  expectedYield: string;
  allocations: LadderAllocation[];
  reason: string;
}

/** Current SunSwap V2 pool state used for a USDT → TRX → USDT estimate. */
export interface SwapQuote {
  router: string;
  pair: string;
  reserveUsdt: string;
  reserveTrx: string;
  feeNumerator: number;
  costs: { toTrx: { energy: number; bandwidth: number }; toUsdt: { energy: number; bandwidth: number } };
  source: SourceMeta;
}

export type Eligibility = "eligible" | "conditional" | "ineligible";

export interface Plan {
  id: string;
  key: "A" | "B" | "C" | "L" | "HOLD" | "NILE_80" | "NILE_50";
  title: string;
  chain: Chain;
  asset: string;
  inputVersion: number;
  horizonDays: number;
  principal: string;
  allocation: { invested: string; held: string };
  steps: PlanStep[];
  baseRate?: string;
  rateType?: "APY" | "APR";
  baseYield: string;
  rewards: { status: "verified" | "unverified" | "none"; amount?: string; note: string };
  costs: PlanCosts;
  /** 산정 불가면 undefined */
  netReturn?: string;
  breakEvenDays?: string;
  eligibility: Eligibility;
  reasons: string[];
  risks: string[];
  assumptions: string[];
  stress?: { label: string; netReturn: string }[];
  recommended: boolean;
  quoteIds: string[];
  dataModes: DataMode[];
  label: "조건부 분석" | "Nile 실행 계획" | "개발자 테스트 실행";
  ladder?: LadderBucket[];
}

export interface PlanningResult {
  id: string;
  chain: Chain;
  createdAt: string;
  engineVersion: string;
  needs: UserNeeds;
  reserved: { total: string; expensesInHorizon: string; buffer: string; outsideHorizon: Expense[] };
  investable: string;
  plans: Plan[];
  recommendation: { planId: string; reason: string };
  naiveComparison?: { title: string; description: string; netReturn?: string };
  quotes: ProductQuote[];
  swapQuote?: SwapQuote;
  funding?: {
    inputAsset: "TRX" | "USDT";
    inputAmount: string;
    valuedInputUsdt: string;
    reservedTrx: string;
    gasReserveTrx: string;
    entrySwapUsdt: string;
    conversionLossUsdt: string;
    networkFeeTrx: string;
    networkFeeUsdt: string;
    trxPerUsdt: string;
    note: string;
  };
  costBasis?: CostBasis;
  warnings: string[];
  explanation: { text: string; source: "llm" | "template"; provider?: string; model?: string; fallbackReason?: string };
}

// ---------------------------------------------------------------- Execution

export const ActionPreview = z.object({
  id: z.string(),
  planId: z.string(),
  kind: z.enum(["deposit", "withdraw"]),
  wallet: z.string(),
  chain: z.literal("nile"),
  asset: z.string(),
  amountSun: z.string(),
  amountDisplay: z.string(),
  contract: z.string(),
  method: z.string(),
  approval: z.string(),
  estimatedEnergy: z.number(),
  estimatedFeeTrx: z.string(),
  feeLimitSun: z.string(),
  risks: z.array(z.string()),
  createdAt: z.string(),
  validUntil: z.string(),
  snapshot: z.object({ balanceSun: z.string(), jTokenBalance: z.string(), energyFeeSun: z.number(), contractVerified: z.boolean() }),
});
export type ActionPreview = z.infer<typeof ActionPreview>;

export type TxStatus = "preview" | "awaiting_signature" | "submitted" | "pending" | "confirmed" | "failed" | "rejected" | "unknown";

export interface ExecutionRecord {
  id: string;
  planId: string;
  previewId: string;
  kind: "deposit" | "withdraw";
  chain: "nile";
  wallet: string;
  txId?: string;
  status: TxStatus;
  amountDisplay: string;
  submittedAt?: string;
  confirmedAt?: string;
  blockNumber?: number;
  feeTrx?: string;
  energyUsed?: number;
  error?: string;
}

export interface Observation {
  id: string;
  planId: string;
  positionId: string;
  chain: Chain;
  wallet: string;
  observedAt: string;
  balances: { asset: string; amount: string }[];
  underlyingValue: string;
  valuationBasis: string;
  source: SourceMeta;
}

export interface TxStatusResponse {
  txId: string;
  chain: "nile";
  status: "pending" | "confirmed" | "failed" | "not_found";
  blockNumber?: number;
  feeTrx?: string;
  energyUsed?: number;
  result?: string;
  source: SourceMeta;
}
