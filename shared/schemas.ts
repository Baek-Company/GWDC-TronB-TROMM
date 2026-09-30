import Decimal from 'decimal.js';
import { z } from 'zod';
import { normalizeTronAddress } from './tron-address';

const Precise = Decimal.clone({ precision: 128 });

const decimalPattern = /^\d+(?:\.\d+)?$/;
export const decimalStringSchema = z.string().regex(decimalPattern, '0 이상의 십진수 문자열을 입력해 주세요.');
export const positiveDecimalStringSchema = decimalStringSchema.refine(value => new Decimal(value).gt(0), '0보다 커야 합니다.');
export const chainSchema = z.enum(['mainnet', 'nile']);
export const dataModeSchema = z.enum(['live', 'snapshot', 'synthetic']);
export const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}, '유효한 YYYY-MM-DD 날짜를 입력해 주세요.');
export const instantSchema = z.string().refine(value => {
  const match = /^(\d{4}-\d{2}-\d{2})T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:(?:0\d|1[0-3]):[0-5]\d|14:00))$/.exec(value);
  return match !== null && dateSchema.safeParse(match[1]).success && Number.isFinite(Date.parse(value));
}, '시간대(Z 또는 ±HH:mm)가 포함된 ISO 시각을 입력해 주세요.');

// Native TRX has no TRC20 address. An unknown token address also stays null and fails execution checks.
export const tokenSchema = z.object({
  symbol: z.string().min(1),
  address: z.string().min(1).nullable(),
  decimals: z.number().int().min(0).max(36),
});
export type Token = z.infer<typeof tokenSchema>;

export const sourceSchema = z.object({
  sourceUrl: z.string().min(1),
  chain: chainSchema,
  fetchedAt: instantSchema,
  sourceUpdatedAt: instantSchema.nullable(),
  mode: dataModeSchema,
  accessMethod: z.enum(['rest', 'mcp', 'rpc', 'manual']).optional(),
  serverId: z.string().optional(),
  toolName: z.string().optional(),
  serverVersion: z.string().optional(),
});
export type Source = z.infer<typeof sourceSchema>;

export const expenseSchema = z.object({
  date: dateSchema,
  amount: positiveDecimalStringSchema,
  asset: tokenSchema,
});

export const userNeedsSchema = z.object({
  chain: chainSchema,
  asset: tokenSchema,
  amount: positiveDecimalStringSchema,
  startDate: dateSchema,
  endDate: dateSchema,
  expenses: z.array(expenseSchema),
  liquidReserve: decimalStringSchema,
  riskPreference: z.enum(['conservative', 'balanced', 'growth']),
  acceptsUsddRisk: z.boolean(),
  // Legacy inputs parse to false; only explicit true opts in.
  acceptsDatedExpenseLiquidityRisk: z.boolean().default(false),
  timezone: z.literal('Asia/Seoul'),
  inputVersion: z.number().int().positive(),
  confirmedVersion: z.number().int().positive().nullable(),
}).superRefine((value, ctx) => {
  if (value.endDate <= value.startDate) ctx.addIssue({ code: 'custom', path: ['endDate'], message: '종료일은 시작일보다 늦어야 합니다.' });
  if (value.confirmedVersion !== null && value.confirmedVersion > value.inputVersion) {
    ctx.addIssue({ code: 'custom', path: ['confirmedVersion'], message: '확인 버전이 입력 버전보다 큽니다.' });
  }
  value.expenses.forEach((expense, index) => {
    if (expense.date < value.startDate) ctx.addIssue({ code: 'custom', path: ['expenses', index, 'date'], message: '지난 지출일은 계획에 포함할 수 없습니다.' });
  });
});
// Callers may still hold pre-migration needs without the opt-in field. Parsing normalizes it.
export type UserNeeds = z.input<typeof userNeedsSchema>;

export const rateSchema = z.object({
  kind: z.enum(['apy', 'apr']),
  rate: decimalStringSchema, // fractional annual rate: 0.05 = 5%
});
export const rewardSchema = rateSchema.extend({
  token: tokenSchema,
  verified: z.boolean(),
  conversionRateToInput: decimalStringSchema.nullable(),
  expiresAt: instantSchema.nullable(),
});

export const costKindSchema = z.enum(['approval', 'conversion_in', 'deposit', 'withdraw', 'conversion_out', 'claim', 'network']);
export const costEstimateSchema = z.object({
  kind: costKindSchema,
  amount: decimalStringSchema.nullable(), // null means unknown, never zero
  asset: tokenSchema,
  conversionRateToInput: decimalStringSchema.nullable(),
  estimatedAt: instantSchema.nullable(),
  source: sourceSchema.nullable(),
});
export type CostEstimate = z.infer<typeof costEstimateSchema>;

export const productQuoteSchema = z.object({
  id: z.string().min(1),
  quoteVersion: z.string().min(1),
  product: z.enum(['justlend_jusdt', 'psm_jusdd', 'justlend_jtrx', 'staking', 'sun_pool']),
  chain: chainSchema,
  marketAddress: z.string().min(1).nullable(),
  inputToken: tokenSchema,
  depositToken: tokenSchema,
  receiptToken: tokenSchema.nullable(),
  baseRate: rateSchema.nullable(),
  reward: rewardSchema.nullable(),
  liquidity: z.object({
    exitAvailable: decimalStringSchema.nullable(), // denominated in depositToken
    withdrawalDelayDays: z.number().int().min(0).nullable(),
  }),
  conversion: z.object({
    entryCapacity: decimalStringSchema.nullable(), // inputToken
    exitCapacity: decimalStringSchema.nullable(), // depositToken
    entryRate: positiveDecimalStringSchema.nullable(), // depositToken per inputToken
    exitRate: positiveDecimalStringSchema.nullable(), // inputToken per depositToken
    outputTokenAddress: z.string().min(1).nullable(),
    verified: z.boolean(),
  }).nullable(),
  costs: z.array(costEstimateSchema),
  status: z.enum(['active', 'inactive', 'unknown']),
  risks: z.array(z.string()),
  source: sourceSchema,
});
export type ProductQuote = z.infer<typeof productQuoteSchema>;

// Wallet- and amount-specific Mainnet evidence is separate from a market-wide ProductQuote.
// Raw token values (USDT has six decimals) and TRX sun must remain decimal integer strings.
export const uint256StringSchema = z.string().regex(/^\d+$/).refine(value => {
  const amount = BigInt(value);
  return amount <= 2n ** 256n - 1n;
}, 'uint256 범위의 원시 정수를 입력해 주세요.');
export const positiveUint256StringSchema = uint256StringSchema.refine(value => BigInt(value) > 0n);
const tronAddressSchema = z.string().refine(value => normalizeTronAddress(value) !== null, '유효한 TRON 주소를 입력해 주세요.');
const quoteWindowSchema = z.object({
  firstBlock: uint256StringSchema, lastBlock: uint256StringSchema,
  startedAt: instantSchema, endedAt: instantSchema,
}).strict().superRefine((window, ctx) => {
  if (BigInt(window.firstBlock) > BigInt(window.lastBlock) || Date.parse(window.startedAt) > Date.parse(window.endedAt)) {
    ctx.addIssue({ code: 'custom', message: '관측 블록과 시각의 순서가 올바르지 않습니다.' });
  }
});

export const jusdtQuoteContextSchema = z.object({
  version: z.string().min(1), chain: z.literal('mainnet'),
  walletAddress: tronAddressSchema, usdtAddress: tronAddressSchema, jusdtAddress: tronAddressSchema,
  marketQuoteVersion: z.string().min(1), needsVersion: z.number().int().positive(),
  energyPriceSun: positiveUint256StringSchema, bandwidthPriceSun: positiveUint256StringSchema,
  maxFeeLimitSun: positiveUint256StringSchema,
  trxUsd: positiveDecimalStringSchema.nullable(), usdtUsd: positiveDecimalStringSchema.nullable(),
  availableEnergy: uint256StringSchema.nullable(), availableBandwidth: uint256StringSchema.nullable(),
  availableTrxSun: uint256StringSchema.nullable(), observedUsdtRaw: uint256StringSchema.nullable(),
  allowanceUsdtRaw: uint256StringSchema.nullable(),
  sources: z.array(sourceSchema), observationWindow: quoteWindowSchema, validUntil: instantSchema,
}).strict().superRefine((value, ctx) => {
  if (value.sources.some(source => source.chain !== 'mainnet')) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Mainnet 근거만 사용할 수 있습니다.' });
  }
  if (Date.parse(value.validUntil) <= Date.parse(value.observationWindow.endedAt)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: '견적은 관측 종료 이후에 만료되어야 합니다.' });
  }
});
export type JusdtQuoteContext = z.infer<typeof jusdtQuoteContextSchema>;

export const costActionSchema = z.enum(['approve_zero', 'approve', 'mint', 'redeem_underlying']);
const abiSelectorSchema = z.string().regex(/^[A-Za-z_][A-Za-z_0-9]*\([A-Za-z0-9_,]*\)$/);
const actionSelector: Record<z.infer<typeof costActionSchema>, string> = {
  approve_zero: 'approve(address,uint256)', approve: 'approve(address,uint256)',
  mint: 'mint(uint256)', redeem_underlying: 'redeemUnderlying(uint256)',
};
export const costEvidenceSchema = z.object({
  action: costActionSchema,
  basis: z.enum(['account_simulation', 'reference_model', 'unknown']),
  contextVersion: z.string().min(1), contractAddress: tronAddressSchema,
  selector: abiSelectorSchema,
  amountRaw: uint256StringSchema,
  energyUnits: uint256StringSchema.nullable(), bandwidthBytes: uint256StringSchema.nullable(),
  estimatedFeeSun: uint256StringSchema.nullable(), feeLimitSun: uint256StringSchema.nullable(),
  bandwidthBudgetSun: uint256StringSchema.nullable(),
  sources: z.array(sourceSchema), referenceTxIds: z.array(z.string().min(1)),
}).strict().superRefine((value, ctx) => {
  if (value.selector !== actionSelector[value.action]
    || (value.action === 'approve_zero' && BigInt(value.amountRaw) !== 0n)
    || (value.action !== 'approve_zero' && BigInt(value.amountRaw) === 0n)) {
    ctx.addIssue({ code: 'custom', message: '행동의 ABI 함수 또는 원시 금액이 일치하지 않습니다.' });
  }
  if (value.basis === 'unknown' && (value.energyUnits !== null || value.bandwidthBytes !== null
    || value.estimatedFeeSun !== null || value.feeLimitSun !== null || value.bandwidthBudgetSun !== null)) {
    ctx.addIssue({ code: 'custom', message: '미확인 행동의 비용을 수치로 표시할 수 없습니다.' });
  }
  if (value.basis === 'reference_model' && value.referenceTxIds.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['referenceTxIds'], message: '기준 모델에는 확정 거래 ID가 필요합니다.' });
  }
  if (value.basis === 'account_simulation' && value.referenceTxIds.length !== 0) {
    ctx.addIssue({ code: 'custom', path: ['referenceTxIds'], message: '계정 모의 실행은 과거 거래 ID를 사용하지 않습니다.' });
  }
  if (value.sources.some(source => source.chain !== 'mainnet')) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Mainnet 근거만 사용할 수 있습니다.' });
  }
});
export type CostEvidence = z.infer<typeof costEvidenceSchema>;

export const actionCostSampleSetSchema = z.object({
  action: costActionSchema, contractAddress: tronAddressSchema,
  selector: abiSelectorSchema,
  samples: z.array(z.object({
    basis: z.enum(['account_simulation', 'reference_model']),
    amountRaw: uint256StringSchema, energyUnits: uint256StringSchema,
    signedBytes: uint256StringSchema, txId: z.string().min(1).nullable(), source: sourceSchema,
  }).strict()).max(20),
  codeIdentity: z.string().min(1), modelVersion: z.string().min(1), validUntil: instantSchema,
}).strict().superRefine((value, ctx) => {
  if (value.selector !== actionSelector[value.action]) {
    ctx.addIssue({ code: 'custom', path: ['selector'], message: '행동과 ABI 함수가 일치하지 않습니다.' });
  }
  if (value.samples.some(sample => sample.source.chain !== 'mainnet'
    || (sample.basis === 'reference_model' && sample.txId === null)
    || (sample.basis === 'account_simulation' && sample.txId !== null))) {
    ctx.addIssue({ code: 'custom', path: ['samples'], message: '표본의 체인·확정 거래 근거가 일치하지 않습니다.' });
  }
});
export type ActionCostSampleSet = z.infer<typeof actionCostSampleSetSchema>;

// All values ending in Raw use the chain's integer scaling (rates and reserve factor: 1e18).
export const jusdtRateModelSchema = z.object({
  kind: z.enum(['whitepaper', 'jump']), modelAddress: tronAddressSchema,
  codeIdentity: z.string().min(1), baseRatePerBlockRaw: uint256StringSchema,
  multiplierPerBlockRaw: uint256StringSchema, jumpMultiplierPerBlockRaw: uint256StringSchema.nullable(),
  kinkRaw: uint256StringSchema.nullable(), reserveFactorRaw: uint256StringSchema,
  cashRaw: uint256StringSchema, borrowsRaw: uint256StringSchema, reservesRaw: uint256StringSchema,
  currentSupplyRatePerBlockRaw: uint256StringSchema,
  source: sourceSchema, validUntil: instantSchema,
}).strict().superRefine((value, ctx) => {
  if (value.source.chain !== 'mainnet' || value.source.mode !== 'live') {
    ctx.addIssue({ code: 'custom', path: ['source'], message: 'Mainnet 실조회 금리 모델만 사용할 수 있습니다.' });
  }
  if (BigInt(value.reserveFactorRaw) > 10n ** 18n
    || (value.kinkRaw !== null && BigInt(value.kinkRaw) > 10n ** 18n)) {
    ctx.addIssue({ code: 'custom', message: '금리 모델 비율은 1e18을 넘을 수 없습니다.' });
  }
  if (value.kind === 'jump' && (value.kinkRaw === null || value.jumpMultiplierPerBlockRaw === null)) {
    ctx.addIssue({ code: 'custom', message: 'Jump 모델에는 kink와 jumpMultiplier가 필요합니다.' });
  }
});
export type JusdtRateModel = z.infer<typeof jusdtRateModelSchema>;

export const jusdtLegQuoteSchema = z.object({
  chain: z.literal('mainnet'), walletAddress: tronAddressSchema,
  needsVersion: z.number().int().positive(), bucketKey: z.string().min(1),
  amountUsdtRaw: positiveUint256StringSchema, dueDate: dateSchema, plannedExitDate: dateSchema,
  earningDays: z.number().int().min(0), contextVersion: z.string().min(1),
  marketQuoteVersion: z.string().min(1), mintCost: costEvidenceSchema,
  redeemModelVersion: z.string().min(1).nullable(),
  status: z.enum(['scenario_only', 'partial', 'unavailable']),
  validUntil: instantSchema, quoteVersion: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if (value.plannedExitDate > value.dueDate || value.mintCost.action !== 'mint'
    || value.mintCost.contextVersion !== value.contextVersion
    || value.mintCost.amountRaw !== value.amountUsdtRaw) {
    ctx.addIssue({ code: 'custom', message: '구간 날짜·예치 행동·맥락 버전이 일치하지 않습니다.' });
  }
  if (value.status === 'scenario_only' && (value.mintCost.basis === 'unknown' || value.redeemModelVersion === null)) {
    ctx.addIssue({ code: 'custom', path: ['status'], message: '미확인 예치 행동은 조건부 견적이 될 수 없습니다.' });
  }
});
export type JusdtLegQuote = z.infer<typeof jusdtLegQuoteSchema>;

export const jusdtBundleQuoteSchema = z.object({
  chain: z.literal('mainnet'), walletAddress: tronAddressSchema,
  needsVersion: z.number().int().positive(), contextVersion: z.string().min(1),
  inputTokenAddress: tronAddressSchema, marketAddress: tronAddressSchema,
  selectedLegVersions: z.array(z.string().min(1)).max(8),
  approvalActions: z.enum(['none', 'approve', 'reset_then_approve', 'unknown']),
  actions: z.array(z.object({ bucketKey: z.string().min(1).nullable(), cost: costEvidenceSchema }).strict()),
  allowanceUsdtRaw: uint256StringSchema.nullable(), totalDepositUsdtRaw: uint256StringSchema,
  scenarioRateApr: decimalStringSchema.nullable(), expectedCostUsdt: decimalStringSchema.nullable(),
  stressCostUsdt: decimalStringSchema.nullable(),
  requiredFeeTrxSun: uint256StringSchema.nullable(), availableFeeTrxSun: uint256StringSchema.nullable(),
  scenarioNetYieldUsdt: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  stressNetYieldUsdt: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  observationWindow: quoteWindowSchema,
  status: z.enum(['scenario_only', 'partial', 'unavailable']), validUntil: instantSchema,
  quoteVersion: z.string().min(1),
}).strict().superRefine((value, ctx) => {
  if ((value.status !== 'scenario_only') && (value.expectedCostUsdt !== null
    || value.stressCostUsdt !== null || value.scenarioNetYieldUsdt !== null || value.stressNetYieldUsdt !== null)) {
    ctx.addIssue({ code: 'custom', message: '불완전한 묶음은 비용·순익을 확정할 수 없습니다.' });
  }
  if (value.status === 'scenario_only' && (value.approvalActions === 'unknown'
    || value.actions.some(action => action.cost.basis === 'unknown')
    || value.selectedLegVersions.length === 0 || BigInt(value.totalDepositUsdtRaw) === 0n
    || value.scenarioRateApr === null
    || value.expectedCostUsdt === null || value.stressCostUsdt === null
    || value.requiredFeeTrxSun === null || value.availableFeeTrxSun === null
    || value.scenarioNetYieldUsdt === null || value.stressNetYieldUsdt === null)) {
    ctx.addIssue({ code: 'custom', message: '조건부 묶음에는 모든 비용·순익·TRX 재원 근거가 필요합니다.' });
  }
  if (value.actions.some(action => action.cost.contextVersion !== value.contextVersion)
    || new Set(value.selectedLegVersions).size !== value.selectedLegVersions.length) {
    ctx.addIssue({ code: 'custom', message: '묶음 행동의 맥락 또는 선택 구간의 정렬이 잘못되었습니다.' });
  }
  const approvalActions = value.actions.filter(action => action.cost.action === 'approve' || action.cost.action === 'approve_zero');
  const approveCount = approvalActions.filter(action => action.cost.action === 'approve').length;
  const resetCount = approvalActions.filter(action => action.cost.action === 'approve_zero').length;
  const expectedCounts = value.approvalActions === 'none' ? [0, 0]
    : value.approvalActions === 'approve' ? [1, 0]
      : value.approvalActions === 'reset_then_approve' ? [1, 1] : null;
  if (approvalActions.some(action => action.bucketKey !== null)
    || value.actions.some(action => action.cost.action !== 'approve' && action.cost.action !== 'approve_zero'
      && action.bucketKey === null)
    || (expectedCounts !== null && (approveCount !== expectedCounts[0] || resetCount !== expectedCounts[1]))) {
    ctx.addIssue({ code: 'custom', path: ['actions'], message: '묶음 승인 행동의 횟수 또는 대상 구간이 일치하지 않습니다.' });
  }
  if (value.status === 'scenario_only') {
    const allowance = value.allowanceUsdtRaw === null ? null : BigInt(value.allowanceUsdtRaw);
    const total = BigInt(value.totalDepositUsdtRaw);
    const expectedApproval = allowance === null ? 'unknown'
      : allowance >= total ? 'none' : allowance === 0n ? 'approve' : 'reset_then_approve';
    const bucketKeys = new Set(value.actions.filter(action => action.bucketKey !== null)
      .map(action => action.bucketKey));
    const completeLegActions = [...bucketKeys].every(key => value.actions.filter(action => action.bucketKey === key
      && action.cost.action === 'mint').length === 1
      && value.actions.filter(action => action.bucketKey === key
        && action.cost.action === 'redeem_underlying').length === 1);
    if (value.approvalActions !== expectedApproval || bucketKeys.size !== value.selectedLegVersions.length
      || !completeLegActions
      || value.actions.some(action => action.cost.action === 'approve'
        && action.cost.amountRaw !== value.totalDepositUsdtRaw)) {
      ctx.addIssue({ code: 'custom', path: ['actions'], message: '조건부 묶음의 allowance 분기 또는 구간별 진입·회수 행동이 불완전합니다.' });
    }
  }
});
export type JusdtBundleQuote = z.infer<typeof jusdtBundleQuoteSchema>;

export const jusdtSizingInputsSchema = z.object({
  context: jusdtQuoteContextSchema,
  legs: z.array(jusdtLegQuoteSchema).max(8),
  approvalModels: z.array(actionCostSampleSetSchema),
  redeemModels: z.array(actionCostSampleSetSchema),
  rateModel: jusdtRateModelSchema.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.legs.some(leg => leg.contextVersion !== value.context.version
    || leg.marketQuoteVersion !== value.context.marketQuoteVersion
    || leg.needsVersion !== value.context.needsVersion
    || leg.walletAddress !== value.context.walletAddress
    || leg.mintCost.contractAddress !== value.context.jusdtAddress)) {
    ctx.addIssue({ code: 'custom', path: ['legs'], message: '구간 견적의 지갑·요구·시장 버전이 다릅니다.' });
  }
  if (value.approvalModels.some(model => model.contractAddress !== value.context.usdtAddress
    || (model.action !== 'approve' && model.action !== 'approve_zero'))
    || value.redeemModels.some(model => model.contractAddress !== value.context.jusdtAddress
      || model.action !== 'redeem_underlying')) {
    ctx.addIssue({ code: 'custom', path: ['approvalModels'], message: '행동 비용 모델의 계약·함수가 선택 경로와 다릅니다.' });
  }
  if (new Set(value.legs.map(leg => leg.bucketKey)).size !== value.legs.length) {
    ctx.addIssue({ code: 'custom', path: ['legs'], message: '날짜별 버킷 키가 중복되었습니다.' });
  }
  if (value.rateModel && Date.parse(value.rateModel.validUntil) < Date.parse(value.context.validUntil)) {
    ctx.addIssue({ code: 'custom', path: ['rateModel'], message: '금리 모델이 견적보다 먼저 만료됩니다.' });
  }
});
export type JusdtSizingInputs = z.infer<typeof jusdtSizingInputsSchema>;

// A bounded diagnostic projection of wallet-specific sizing. This is never an
// allocation, a round-trip profit quote, or transaction authority. In
// particular, raw RPC/account responses are not copied here.
export const jusdtReadOnlyMintCostSchema = z.object({
  action: z.literal('mint'),
  basis: costEvidenceSchema.shape.basis,
  contextVersion: z.string().min(1),
  amountRaw: positiveUint256StringSchema,
  energyUnits: uint256StringSchema.nullable(),
  bandwidthBytes: uint256StringSchema.nullable(),
  estimatedFeeSun: uint256StringSchema.nullable(),
  feeLimitSun: uint256StringSchema.nullable(),
  sources: z.array(sourceSchema).max(20),
}).strict().superRefine((value, ctx) => {
  if (value.basis === 'unknown' && (value.energyUnits !== null || value.bandwidthBytes !== null
    || value.estimatedFeeSun !== null || value.feeLimitSun !== null)) {
    ctx.addIssue({ code: 'custom', message: '미확인 예치 행동의 비용을 수치로 표시할 수 없습니다.' });
  }
  if (value.sources.some(source => source.chain !== 'mainnet' || source.mode !== 'live')) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: 'Mainnet 실조회 근거만 표시할 수 있습니다.' });
  }
  if (value.basis !== 'unknown' && value.sources.length === 0) {
    ctx.addIssue({ code: 'custom', path: ['sources'], message: '확인된 예치 비용에는 조회 출처가 필요합니다.' });
  }
});

export const jusdtReadOnlyEvidenceSchema = z.object({
  chain: z.literal('mainnet'), walletAddress: tronAddressSchema,
  needsVersion: z.number().int().positive(),
  contextVersion: z.string().min(1), marketQuoteVersion: z.string().min(1),
  allowanceUsdtRaw: uint256StringSchema.nullable(),
  totalCandidateUsdtRaw: positiveUint256StringSchema,
  observationWindow: quoteWindowSchema, validUntil: instantSchema,
  approvalActions: z.enum(['none', 'approve', 'reset_then_approve', 'unknown']),
  legs: z.array(z.object({
    bucketKey: z.string().min(1), amountUsdtRaw: positiveUint256StringSchema,
    dueDate: dateSchema, plannedExitDate: dateSchema,
    quoteVersion: z.string().min(1), mintCost: jusdtReadOnlyMintCostSchema,
    redeemModelVersion: z.string().min(1).nullable(),
    holdReasons: z.array(z.string().min(1)).max(32),
  }).strict()).min(1).max(8),
  executionEligible: z.literal(false),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.validUntil) <= Date.parse(value.observationWindow.endedAt)) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: '부분 근거는 관측 종료 이후에 만료되어야 합니다.' });
  }
  const total = value.legs.reduce((sum, leg) => sum + BigInt(leg.amountUsdtRaw), 0n);
  if (total.toString() !== value.totalCandidateUsdtRaw) {
    ctx.addIssue({ code: 'custom', path: ['totalCandidateUsdtRaw'], message: '후보 구간 합계가 일치하지 않습니다.' });
  }
  const allowance = value.allowanceUsdtRaw === null ? null : BigInt(value.allowanceUsdtRaw);
  const expectedApproval = allowance === null ? 'unknown'
    : allowance >= total ? 'none' : allowance === 0n ? 'approve' : 'reset_then_approve';
  if (value.approvalActions !== expectedApproval) {
    ctx.addIssue({ code: 'custom', path: ['approvalActions'], message: '후보 합계의 공동 승인 분기가 일치하지 않습니다.' });
  }
  if (new Set(value.legs.map(leg => leg.bucketKey)).size !== value.legs.length
    || new Set(value.legs.map(leg => leg.quoteVersion)).size !== value.legs.length) {
    ctx.addIssue({ code: 'custom', path: ['legs'], message: '구간 키 또는 견적 버전이 중복되었습니다.' });
  }
  value.legs.forEach((leg, index) => {
    if (leg.plannedExitDate > leg.dueDate
      || leg.mintCost.contextVersion !== value.contextVersion
      || leg.mintCost.amountRaw !== leg.amountUsdtRaw) {
      ctx.addIssue({ code: 'custom', path: ['legs', index], message: '구간 날짜·진입 비용·맥락 버전이 일치하지 않습니다.' });
    }
  });
});
export type JusdtReadOnlyEvidence = z.infer<typeof jusdtReadOnlyEvidenceSchema>;

export const eligibilityReasonSchema = z.enum([
  'needs_unconfirmed', 'chain_mismatch', 'asset_mismatch', 'expense_asset_mismatch',
  'quote_unavailable', 'quote_stale', 'non_live_data', 'market_inactive', 'market_unknown',
  'token_unverified', 'rate_unavailable', 'cost_unverified', 'conversion_unverified',
  'entry_capacity_insufficient', 'exit_capacity_insufficient', 'liquidity_insufficient',
  'withdrawal_delay', 'usdd_risk_declined', 'risk_preference', 'balance_unverified',
  'balance_insufficient', 'fee_reserve_unverified', 'fee_reserve_insufficient',
  'zero_investable', 'liquidity_unverified',
]);
export type EligibilityReason = z.infer<typeof eligibilityReasonSchema>;
export const eligibilitySchema = z.object({
  status: z.enum(['eligible', 'conditional', 'excluded']),
  reasons: z.array(eligibilityReasonSchema),
});
export type Eligibility = z.infer<typeof eligibilitySchema>;

export const planSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(['hold', 'justlend_jusdt', 'psm_jusdd', 'justlend_jtrx']),
  scenario: z.enum(['hold', 'max', '80_20', '50_50']),
  chain: chainSchema,
  needsVersion: z.number().int().positive(),
  quoteVersion: z.string().nullable(),
  quoteId: z.string().nullable(),
  quote: productQuoteSchema.nullable(),
  startDate: dateSchema,
  endDate: dateSchema,
  days: z.number().int().positive(),
  // When a withdrawal needs lead time, earning days can be shorter than calendar days.
  earningDays: z.number().int().min(0).optional(),
  inputToken: tokenSchema,
  depositToken: tokenSchema,
  allocation: z.object({ invested: decimalStringSchema, held: decimalStringSchema, protected: decimalStringSchema }),
  steps: z.array(z.enum(['hold', 'psm_in', 'approve', 'deposit', 'withdraw', 'psm_out', 'claim'])),
  baseYield: decimalStringSchema.nullable(),
  verifiedReward: decimalStringSchema.nullable(),
  conversionImpact: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  roundTripCost: decimalStringSchema.nullable(),
  netYield: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  netYieldBasis: z.enum(['all_verified', 'base_only', 'current_conditions_scenario', 'unavailable']),
  breakEvenDays: z.number().int().min(0).nullable(),
  eligibility: eligibilitySchema,
  risks: z.array(z.string()),
  source: sourceSchema.nullable(),
  calculatedAt: instantSchema,
});
export type Plan = z.infer<typeof planSchema>;

// A dated allocation is a read-only portfolio comparison. Its legs are not
// transaction plans and must never be passed to the single-plan executor.
export const datedAllocationLegSchema = z.object({
  purpose: z.enum(['expense', 'horizon']),
  dueDate: dateSchema,
  amount: positiveDecimalStringSchema,
  daysUntilDue: z.number().int().min(0),
  decision: z.enum(['hold', 'invest']),
  eligibility: z.enum(['eligible', 'held', 'unverified']),
  product: z.enum(['justlend_jusdt', 'psm_jusdd', 'justlend_jtrx']).nullable(),
  quoteId: z.string().nullable(),
  quoteVersion: z.string().nullable(),
  // Stable contract/token route. Older saved comparisons lack this and require review.
  routeIdentity: z.string().min(1).nullable().optional(),
  sizedQuoteVersion: z.string().min(1).nullable().optional(),
  bundleQuoteVersion: z.string().min(1).nullable().optional(),
  plannedRedeemUsdtRaw: z.string().regex(/^\d+$/).nullable().optional(),
  costBasis: z.enum(['account_simulation', 'reference_model', 'mixed', 'unknown']).nullable().optional(),
  validUntil: instantSchema.nullable().optional(),
  invested: decimalStringSchema,
  held: decimalStringSchema,
  earningDays: z.number().int().min(0),
  withdrawalRequestDate: dateSchema.nullable(),
  expectedNetYield: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  roundTripCost: decimalStringSchema.nullable(),
  source: sourceSchema.nullable(),
  reasons: z.array(z.string()),
});
export type DatedAllocationLeg = z.infer<typeof datedAllocationLegSchema>;

export const datedAllocationSchema = z.object({
  id: z.string().min(1),
  chain: chainSchema,
  asset: tokenSchema,
  inputToken: tokenSchema,
  inputVersion: z.number().int().positive(),
  startDate: dateSchema,
  endDate: dateSchema,
  amount: positiveDecimalStringSchema,
  liquidReserve: decimalStringSchema,
  feeReserve: decimalStringSchema.nullable(),
  evaluatedQuotes: z.array(z.object({
    product: productQuoteSchema.shape.product,
    quoteId: z.string(),
    quoteVersion: z.string(),
    source: sourceSchema,
  })),
  legs: z.array(datedAllocationLegSchema),
  totalInvested: decimalStringSchema,
  totalHeld: decimalStringSchema,
  expectedNetYield: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable(),
  selectedBundleNetYield: z.string().regex(/^-?\d+(?:\.\d+)?$/).nullable().optional(),
  selectedBundleStatus: z.enum(['scenario_only', 'partial', 'unavailable']).nullable().optional(),
  selectedBundleQuoteVersion: z.string().min(1).nullable().optional(),
  selectedBundleQuote: jusdtBundleQuoteSchema.nullable().optional(),
  recommendation: z.enum(['allocate', 'conditional_allocate', 'hold', 'insufficient_data']),
  executionEligible: z.literal(false),
  calculatedAt: instantSchema,
}).superRefine((value, ctx) => {
  const sameAsset = value.asset.symbol === value.inputToken.symbol
    && value.asset.address === value.inputToken.address
    && value.asset.decimals === value.inputToken.decimals;
  if (!sameAsset) ctx.addIssue({ code: 'custom', path: ['inputToken'], message: '입력 자산이 일치하지 않습니다.' });
  const invested = value.legs.reduce((sum, leg) => sum.plus(leg.invested), new Precise(0));
  if (!invested.eq(value.totalInvested) || !new Precise(value.totalInvested).plus(value.totalHeld).eq(value.amount)) {
    ctx.addIssue({ code: 'custom', path: ['totalInvested'], message: '날짜별 배분 합계가 보유액과 다릅니다.' });
  }
  if (value.selectedBundleQuote) {
    const bundle = value.selectedBundleQuote;
    if (value.chain !== 'mainnet' || value.asset.symbol !== 'USDT'
      || value.selectedBundleStatus !== bundle.status
      || value.selectedBundleNetYield !== bundle.scenarioNetYieldUsdt
      || value.selectedBundleQuoteVersion !== bundle.quoteVersion
      || value.inputVersion !== bundle.needsVersion) {
      ctx.addIssue({ code: 'custom', path: ['selectedBundleQuote'], message: '선택 묶음의 자산·상태·순익·버전이 일치하지 않습니다.' });
    }
    if (value.recommendation === 'conditional_allocate'
      && (bundle.status !== 'scenario_only' || bundle.stressNetYieldUsdt === null
        || !new Precise(bundle.stressNetYieldUsdt).gt(0))) {
      ctx.addIssue({ code: 'custom', path: ['recommendation'], message: '양의 스트레스 순익이 없는 묶음은 조건부 추천할 수 없습니다.' });
    }
  }
  if (value.recommendation === 'conditional_allocate' && !value.selectedBundleQuote) {
    ctx.addIssue({ code: 'custom', path: ['recommendation'], message: '조건부 추천에는 금액별 선택 묶음 견적이 필요합니다.' });
  }
  value.legs.forEach((leg, index) => {
    if (!new Precise(leg.invested).plus(leg.held).eq(leg.amount)) {
      ctx.addIssue({ code: 'custom', path: ['legs', index], message: '구간별 배분 합계가 필요액과 다릅니다.' });
    }
    if (leg.source !== null && leg.source.chain !== value.chain) {
      ctx.addIssue({ code: 'custom', path: ['legs', index, 'source'], message: '출처 체인이 다릅니다.' });
    }
    const selectedBundleLeg = value.selectedBundleQuote && leg.product === 'justlend_jusdt';
    if (leg.decision === 'invest' && (leg.eligibility !== 'eligible' || leg.product === null
      || leg.quoteId === null || leg.quoteVersion === null || leg.source === null
      || leg.withdrawalRequestDate === null || leg.earningDays === 0
      || leg.expectedNetYield === null
      || (!selectedBundleLeg && !new Precise(leg.expectedNetYield).gt(0))
      || (selectedBundleLeg && (leg.sizedQuoteVersion == null
        || leg.bundleQuoteVersion !== value.selectedBundleQuote?.quoteVersion
        || leg.validUntil == null)))) {
      ctx.addIssue({ code: 'custom', path: ['legs', index], message: '검증되지 않은 구간은 투자 결정이 될 수 없습니다.' });
    }
    if (leg.decision === 'hold' && (leg.product !== null || !new Precise(leg.invested).isZero())) {
      ctx.addIssue({ code: 'custom', path: ['legs', index], message: '보유 구간에는 투자 상품이 없어야 합니다.' });
    }
  });
});
export type DatedAllocation = z.infer<typeof datedAllocationSchema>;

export const actionPreviewSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  needsVersion: z.number().int().positive(),
  quoteVersion: z.string().min(1),
  walletAddress: z.string().min(1),
  chain: chainSchema,
  asset: tokenSchema,
  amountBaseUnits: z.string().regex(/^\d+$/),
  contractAddress: z.string().min(1),
  method: z.string().min(1),
  approvalScope: z.string().nullable(),
  estimatedFeeBaseUnits: z.string().regex(/^\d+$/).nullable(),
  maxFeeBaseUnits: z.string().regex(/^\d+$/).nullable(),
  expiresAt: instantSchema,
  fingerprint: z.string().min(1),
  risks: z.array(z.string()),
  source: sourceSchema,
});
export type ActionPreview = z.infer<typeof actionPreviewSchema>;

export const executionRecordSchema = z.object({
  id: z.string().min(1),
  action: z.enum(['deposit', 'withdraw']).optional(),
  planId: z.string().min(1),
  previewId: z.string().min(1),
  walletAddress: z.string().min(1),
  chain: chainSchema,
  amountBaseUnits: z.string().regex(/^\d+$/).optional(),
  contractAddress: z.string().min(1).optional(),
  confirmationSource: sourceSchema.optional(),
  approvalIntentId: z.string().regex(/^[0-9a-f]{64}$/i).optional(),
  txId: z.string().nullable(),
  status: z.enum(['preview', 'awaiting_signature', 'submitted', 'pending', 'confirmed', 'failed', 'rejected', 'unknown']),
  receipt: z.unknown().nullable(),
  actualFeeBaseUnits: z.string().regex(/^\d+$/).nullable(),
  createdAt: instantSchema,
  submittedAt: instantSchema.nullable(),
  confirmedAt: instantSchema.nullable(),
  error: z.string().nullable(),
}).superRefine((record, ctx) => {
  if (['submitted', 'pending', 'confirmed'].includes(record.status) && record.txId === null) {
    ctx.addIssue({ code: 'custom', path: ['txId'], message: '제출 이후에는 원 거래 ID가 필요합니다.' });
  }
  if (record.status === 'confirmed' && (record.receipt === null || record.confirmedAt === null)) {
    ctx.addIssue({ code: 'custom', path: ['receipt'], message: '확정에는 영수증과 확정 시각이 필요합니다.' });
  }
});
export type ExecutionRecord = z.infer<typeof executionRecordSchema>;

export const observationSchema = z.object({
  id: z.string().min(1),
  planId: z.string().min(1),
  positionId: z.string().min(1),
  walletAddress: z.string().min(1),
  chain: chainSchema,
  receiptToken: tokenSchema,
  receiptBalanceBaseUnits: z.string().regex(/^\d+$/),
  exchangeRateRaw: z.string().regex(/^\d+$/),
  underlyingToken: tokenSchema,
  underlyingValueBaseUnits: z.string().regex(/^\d+$/),
  source: sourceSchema,
});
export type Observation = z.infer<typeof observationSchema>;

// Confirmed position movements and a separately verified complete query interval.
export const positionFlowSchema = z.object({
  id: z.string().min(1), planId: z.string().min(1), positionId: z.string().min(1),
  walletAddress: z.string().min(1), chain: chainSchema,
  txId: z.string().min(1), kind: z.enum(['deposit', 'withdraw', 'reward']),
  amount: positiveDecimalStringSchema, asset: tokenSchema,
  actualFeeInInputAsset: decimalStringSchema.nullable(),
  occurredAt: instantSchema, solidifiedAt: instantSchema, source: sourceSchema,
});
export type PositionFlow = z.infer<typeof positionFlowSchema>;

export const flowCoverageSchema = z.object({
  fromAt: instantSchema, throughAt: instantSchema, source: sourceSchema,
}).refine(value => Date.parse(value.fromAt) <= Date.parse(value.throughAt), '현금흐름 조회 구간이 뒤집혔습니다.');
export type FlowCoverage = z.infer<typeof flowCoverageSchema>;
