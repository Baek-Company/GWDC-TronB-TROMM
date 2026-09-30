import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { TronWeb } from 'tronweb';
import { actionCostSampleSetSchema, dateSchema, jusdtLegQuoteSchema, jusdtQuoteContextSchema,
  jusdtRateModelSchema, jusdtSizingInputsSchema, type ActionCostSampleSet,
  type JusdtRateModel, type JusdtSizingInputs, type ProductQuote, type Source } from '../../shared/schemas';
import { approvalBranch, costEvidenceForAction } from '../../shared/jusdt-cost-model';
import { connectionReason, provenance, type DataProvenance, type DataResult } from './provenance';
import { MAINNET_RPC, encodeAddress, postTronRpc, readNowBlock,
  type BlockObservation } from './tron-rpc';
import { MAINNET_USDT_ADDRESS } from './usdd';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS,
  type MainnetJusdtMarketEvidence } from './jusdt-market';

const SUN_PRICE_URL = 'https://open.sun.io/apiv2/price';
// SUN's native TRX token representation; verified against a live /apiv2/price
// response as well as the official Universal Router token documentation.
const NATIVE_TRX_PRICE_ADDRESS = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
// Cold jUSDT market/model read uses up to 23 RPCs. One market-bound balance
// read plus this 15-read pass leaves one read under the request-wide 40 cap.
const MAX_RPC_READS = 15;
const MIN_ACTION_READS = 2; // constant simulation and unsigned size
const MAX_WINDOW_MS = 30_000;
const MAX_BLOCK_SPAN = 10n;
const SOURCE_MAX_AGE_MS = 60_000;
const PRICE_MAX_AGE_MS = 300_000;
type LegInput = { bucketKey: string; amountUsdtRaw: string; dueDate: string;
  plannedExitDate: string; earningDays: number };
export type ReadJusdtSizingInput = {
  walletAddress: string;
  observedUsdtRaw: string | null;
  observedTrxSun: string | null;
  needsVersion: number;
  legs: LegInput[];
  marketQuote: ProductQuote;
  marketEvidence: MainnetJusdtMarketEvidence | null;
  /** Optional override for test fixtures; null disables TRX pricing. */
  trxPriceTokenAddress?: string | null;
};
export type JusdtCostDependencies = {
  rpc?: typeof postTronRpc;
  block?: typeof readNowBlock;
  fetchPrice?: typeof fetch;
  now?: () => Date;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC object');
  return value as Record<string, unknown>;
}
function unsigned(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error('Invalid on-chain integer');
}
function sameAddress(left: string, right: string): boolean {
  return TronWeb.isAddress(left) && TronWeb.isAddress(right)
    && TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
function rpcSource(path: string, at: Date): DataProvenance {
  return { ...provenance(`${MAINNET_RPC}${path}`, 'mainnet', 'rpc'), fetchedAt: at.toISOString() };
}
function chainParameter(response: unknown, key: string): bigint {
  const parameters = object(response).chainParameter;
  if (!Array.isArray(parameters)) throw new Error('Chain parameter list missing');
  const match = parameters.find(item => object(item).key === key);
  if (!match) throw new Error(`Chain parameter ${key} missing`);
  const value = unsigned(object(match).value);
  if (value === 0n) throw new Error(`Chain parameter ${key} is zero`);
  return value;
}
function remaining(response: unknown, limit: string, used: string): bigint | null {
  const value = object(response);
  if (value[limit] === undefined || value[used] === undefined) return null;
  const free = unsigned(value[limit]) - unsigned(value[used]);
  return free > 0n ? free : 0n;
}
function decodeWord(response: unknown, expected: 'uint' | 'bool'): bigint {
  const result = object(response);
  if (object(result.result).result !== true) throw new Error('Constant call API failed');
  const transaction = result.transaction;
  if (transaction && typeof transaction === 'object') {
    const ret = object(transaction).ret;
    // TronGrid can return ret:[{}] for a successful constant call. Explicit
    // TVM failures still override the API-level success and ABI return word.
    if (Array.isArray(ret) && ret.some(item => {
      const status = object(item).ret;
      return status !== undefined && status !== 'SUCCESS';
    })) {
      throw new Error('Constant call TVM failed');
    }
  }
  if (!Array.isArray(result.constant_result) || typeof result.constant_result[0] !== 'string'
    || !/^[0-9a-fA-F]{64,}$/.test(result.constant_result[0])) throw new Error('Constant return missing');
  const word = BigInt(`0x${result.constant_result[0].slice(0, 64)}`);
  if (expected === 'bool' && word !== 0n && word !== 1n) throw new Error('Invalid ABI boolean');
  return word;
}
function sourceFresh(source: Source, end: Date, ageMs = SOURCE_MAX_AGE_MS): boolean {
  const age = end.getTime() - Date.parse(source.fetchedAt);
  return source.chain === 'mainnet' && source.mode === 'live' && age >= -5_000 && age <= ageMs;
}

async function readSunPrice(tokenAddress: string | null | undefined, at: Date,
  fetchPrice: typeof fetch, signal: AbortSignal): Promise<{ value: string; source: Source } | null> {
  if (!tokenAddress || !TronWeb.isAddress(tokenAddress)) return null;
  const url = new URL(SUN_PRICE_URL);
  url.searchParams.set('tokenAddress', tokenAddress);
  try {
    const headers: Record<string, string> = {};
    if (process.env.SUN_API_KEY) headers['X-API-KEY'] = process.env.SUN_API_KEY;
    const response = await fetchPrice(url, { headers, signal });
    if (!response.ok) return null;
    const envelope = object(await response.json());
    if (envelope.code !== 0) return null;
    const data = object(envelope.data);
    const key = Object.keys(data).find(candidate => sameAddress(candidate, tokenAddress));
    if (!key) return null;
    const usd = object(object(object(data[key]).quote).USD);
    if (typeof usd.price !== 'string' || !/^\d+(?:\.\d+)?$/.test(usd.price)
      || !new Decimal(usd.price).gt(0)) return null;
    const updated = unsigned(usd.last_updated);
    if (updated > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    const age = at.getTime() - Number(updated);
    if (age < -60_000 || age > PRICE_MAX_AGE_MS) return null;
    return { value: usd.price, source: { sourceUrl: url.toString(), chain: 'mainnet',
      fetchedAt: at.toISOString(), sourceUpdatedAt: new Date(Number(updated)).toISOString(),
      mode: 'live', accessMethod: 'rest' } };
  } catch { return null; }
}

function oneOwnerSignature(account: unknown, wallet: string): boolean {
  try {
    const permission = object(object(account).owner_permission);
    const keys = permission.keys;
    if (!Array.isArray(keys) || keys.length !== 1) return false;
    const key = object(keys[0]);
    return typeof key.address === 'string' && sameAddress(key.address, wallet)
      && unsigned(key.weight) >= unsigned(permission.threshold);
  } catch { return false; }
}

function actionRequest(wallet: string, action: 'approve_zero' | 'approve' | 'mint',
  amountRaw: string): Record<string, unknown> {
  const amount = BigInt(amountRaw);
  if (amount < 0n || amount > 2n ** 256n - 1n) throw new Error('Invalid action amount');
  const parameter = action === 'mint' ? amount.toString(16).padStart(64, '0')
    : encodeAddress(MAINNET_JUSDT_ADDRESS) + amount.toString(16).padStart(64, '0');
  return { owner_address: wallet,
    contract_address: action === 'mint' ? MAINNET_JUSDT_ADDRESS : MAINNET_USDT_ADDRESS,
    function_selector: action === 'mint' ? 'mint(uint256)' : 'approve(address,uint256)',
    parameter, visible: true };
}

async function simulateAction(wallet: string, action: 'approve_zero' | 'approve' | 'mint',
  amountRaw: string, maxFeeLimitSun: bigint, canUseSingleSignature: boolean,
  rpc: (endpoint: string, body: Record<string, unknown>) => Promise<unknown>,
  at: () => Date, codeIdentity: string | null,
  allowEstimateEnergy: boolean): Promise<ActionCostSampleSet | null> {
  if (!canUseSingleSignature || !codeIdentity || maxFeeLimitSun > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  const request = actionRequest(wallet, action, amountRaw);
  try {
    const simulated = object(await rpc('/wallet/triggerconstantcontract', request));
    const result = decodeWord(simulated, 'uint');
    if (result !== (action === 'mint' ? 0n : 1n)) return null;
    let energy = unsigned(simulated.energy_used);
    if (energy === 0n) return null;
    let energySource = '/wallet/triggerconstantcontract';
    try {
      if (!allowEstimateEnergy) throw new Error('Estimate skipped by RPC budget');
      // Some TRON nodes disable this read-only endpoint. When available,
      // conservatively take the larger of the two successful estimates.
      const estimate = object(await rpc('/wallet/estimateenergy', request));
      if (object(estimate.result).result === true) {
        const required = unsigned(estimate.energy_required);
        if (required === 0n) return null;
        if (required > energy) { energy = required; energySource = '/wallet/estimateenergy'; }
      }
    } catch { /* An unsupported estimate never upgrades a failed constant simulation. */ }
    // The unsigned builder is used only for transaction size. It never signs or broadcasts.
    const draft = object(await rpc('/wallet/triggersmartcontract', {
      ...request, fee_limit: Number(maxFeeLimitSun),
    }));
    if (object(draft.result).result !== true) return null;
    const raw = object(draft.transaction).raw_data_hex;
    if (typeof raw !== 'string' || !/^[0-9a-fA-F]+$/.test(raw) || raw.length % 2 !== 0) return null;
    const signedBytesScenario = BigInt(raw.length / 2 + 80);
    const source = rpcSource(energySource, at());
    return actionCostSampleSetSchema.parse({ action,
      contractAddress: action === 'mint' ? MAINNET_JUSDT_ADDRESS : MAINNET_USDT_ADDRESS,
      selector: action === 'mint' ? 'mint(uint256)' : 'approve(address,uint256)',
      samples: [{ basis: 'account_simulation', amountRaw,
        energyUnits: energy.toString(), signedBytes: signedBytesScenario.toString(),
        txId: null, source }], codeIdentity,
      modelVersion: hash([action, amountRaw, energy.toString(), signedBytesScenario.toString(), codeIdentity]),
      validUntil: new Date(at().getTime() + SOURCE_MAX_AGE_MS).toISOString(),
    });
  } catch { return null; }
}

export async function readJusdtSizing(input: ReadJusdtSizingInput,
  dependencies: JusdtCostDependencies = {}): Promise<DataResult<JusdtSizingInputs>> {
  const now = dependencies.now ?? (() => new Date());
  const source = rpcSource('/wallet/getnowblock', now());
  const unknown = (reason: string): DataResult<JusdtSizingInputs> => ({ status: 'unknown', reason, source });
  if (!TronWeb.isAddress(input.walletAddress) || input.needsVersion < 1 || !Number.isInteger(input.needsVersion)
    || input.legs.length > 8 || !input.marketEvidence || input.marketQuote.chain !== 'mainnet'
    || input.marketQuote.product !== 'justlend_jusdt'
    || !sameAddress(input.marketQuote.marketAddress ?? '', MAINNET_JUSDT_ADDRESS)
    || !sameAddress(input.marketQuote.inputToken.address ?? '', MAINNET_USDT_ADDRESS)
    || input.marketEvidence.quoteVersion !== input.marketQuote.quoteVersion
    || !sameAddress(input.marketEvidence.marketAddress, MAINNET_JUSDT_ADDRESS)
    || !sameAddress(input.marketEvidence.underlyingAddress, MAINNET_USDT_ADDRESS)
    || !sameAddress(input.marketEvidence.controllerAddress, MAINNET_UNITROLLER_ADDRESS)
    || !/^[0-9a-fA-F]{64}$/.test(input.marketEvidence.marketCodeIdentity)
    || !/^[0-9a-fA-F]{64}$/.test(input.marketEvidence.underlyingCodeIdentity)
    || !input.observedUsdtRaw || !/^\d+$/.test(input.observedUsdtRaw)
    || input.legs.some(leg => !leg.bucketKey || !/^\d+$/.test(leg.amountUsdtRaw)
      || BigInt(leg.amountUsdtRaw) === 0n || BigInt(leg.amountUsdtRaw) > 2n ** 256n - 1n
      || !dateSchema.safeParse(leg.dueDate).success || !dateSchema.safeParse(leg.plannedExitDate).success
      || leg.plannedExitDate > leg.dueDate || !Number.isInteger(leg.earningDays) || leg.earningDays < 0)
    || new Set(input.legs.map(leg => leg.bucketKey)).size !== input.legs.length) {
    return unknown('지갑·잔액·시장 계약의 금액별 견적 선행 근거가 부족합니다.');
  }
  const marketEvidence = input.marketEvidence;
  const marketStarted = Date.parse(marketEvidence.observationWindow.startedAt);
  const marketEnded = Date.parse(marketEvidence.observationWindow.endedAt);
  const firstBlock = marketEvidence.observationWindow.firstBlock;
  const lastBlock = marketEvidence.observationWindow.lastBlock;
  const blockSpan = /^\d+$/.test(firstBlock) && /^\d+$/.test(lastBlock)
    ? BigInt(lastBlock) - BigInt(firstBlock) : -1n;
  if (!Number.isFinite(marketStarted) || !Number.isFinite(marketEnded)
    || marketEnded < marketStarted || marketEnded - marketStarted > MAX_WINDOW_MS
    || blockSpan < 0n || blockSpan > MAX_BLOCK_SPAN
    || !sourceFresh(marketEvidence.source, now())
    || !sourceFresh(marketEvidence.directorySource, now())
    || Date.parse(marketEvidence.validUntil) <= now().getTime()) {
    return unknown('시장 계약 코드와 시세의 현재 관측 범위를 검증하지 못했습니다.');
  }
  const abort = AbortSignal.timeout(25_000);
  let calls = 0;
  const rpc = async (endpoint: string, body: Record<string, unknown>) => {
    if (++calls > MAX_RPC_READS) throw new Error('RPC read budget exceeded');
    return (dependencies.rpc ?? postTronRpc)('mainnet', endpoint, body, { signal: abort });
  };
  const block = async (): Promise<BlockObservation> => {
    if (++calls > MAX_RPC_READS) throw new Error('RPC read budget exceeded');
    return (dependencies.block ?? readNowBlock)('mainnet', abort);
  };
  try {
    const first = await block();
    const startedAt = new Date(Math.min(Date.parse(first.fetchedAt), now().getTime()));
    if (!Number.isFinite(startedAt.getTime())) return unknown('첫 블록의 관측 시각을 검증하지 못했습니다.');
    const [parameters, account, resources] = await Promise.all([
      rpc('/wallet/getchainparameters', {}),
      rpc('/wallet/getaccount', { address: input.walletAddress, visible: true }),
      rpc('/wallet/getaccountresource', { address: input.walletAddress, visible: true }),
    ]);
    const energyPrice = chainParameter(parameters, 'getEnergyFee');
    const bandwidthPrice = chainParameter(parameters, 'getTransactionFee');
    const maxFeeLimit = chainParameter(parameters, 'getMaxFeeLimit');
    if (!sameAddress(String(object(account).address), input.walletAddress)) {
      return unknown('지갑 주소를 검증하지 못했습니다.');
    }
    const trxSun = unsigned(object(account).balance ?? 0);
    if (input.observedTrxSun !== null && (!/^\d+$/.test(input.observedTrxSun)
      || trxSun !== BigInt(input.observedTrxSun))) return unknown('수수료용 TRX 관측값이 새 계정 조회와 다릅니다.');
    const availableEnergy = remaining(resources, 'EnergyLimit', 'EnergyUsed');
    const freeNet = remaining(resources, 'freeNetLimit', 'freeNetUsed');
    const paidNet = remaining(resources, 'NetLimit', 'NetUsed');
    const availableBandwidth = freeNet === null || paidNet === null ? null : freeNet + paidNet;
    const balanceRead = await rpc('/wallet/triggerconstantcontract', {
      owner_address: input.walletAddress, contract_address: MAINNET_USDT_ADDRESS,
      function_selector: 'balanceOf(address)', parameter: encodeAddress(input.walletAddress), visible: true,
    });
    const balanceRaw = decodeWord(balanceRead, 'uint');
    if (balanceRaw !== BigInt(input.observedUsdtRaw)) return unknown('USDT 실잔액 관측값이 금액별 견적의 새 조회와 다릅니다.');
    // This sizing path models a fresh deposit. Existing jUSDT may be collateral
    // or have a different withdrawal dependency, so keep it outside this model.
    const positionRaw = decodeWord(await rpc('/wallet/triggerconstantcontract', {
      owner_address: input.walletAddress, contract_address: MAINNET_JUSDT_ADDRESS,
      function_selector: 'balanceOf(address)', parameter: encodeAddress(input.walletAddress), visible: true,
    }), 'uint');
    if (positionRaw !== 0n) return unknown('기존 jUSDT 보유가 있어 독립적인 환매 가능 금액을 검증하지 못했습니다.');
    let allowanceRaw: string | null = null;
    try {
      allowanceRaw = decodeWord(await rpc('/wallet/triggerconstantcontract', {
        owner_address: input.walletAddress, contract_address: MAINNET_USDT_ADDRESS,
        function_selector: 'allowance(address,address)',
        parameter: encodeAddress(input.walletAddress) + encodeAddress(MAINNET_JUSDT_ADDRESS), visible: true,
      }), 'uint').toString();
    } catch { /* Unknown allowance never becomes approval-free. */ }
    const priceAt = now();
    const [trxPrice, usdtPrice] = await Promise.all([
      readSunPrice(input.trxPriceTokenAddress === undefined
        ? NATIVE_TRX_PRICE_ADDRESS : input.trxPriceTokenAddress,
      priceAt, dependencies.fetchPrice ?? fetch, abort),
      readSunPrice(MAINNET_USDT_ADDRESS, priceAt, dependencies.fetchPrice ?? fetch, abort),
    ]);
    const canSingleSign = oneOwnerSignature(account, input.walletAddress);
    const totalInput = input.legs.reduce((sum, leg) => sum + BigInt(leg.amountUsdtRaw), 0n).toString();
    type ActionTarget = { action: 'approve_zero' | 'approve' | 'mint'; amount: string };
    const approvalTargets: ActionTarget[] = [];
    const seen = new Set<string>();
    const add = (action: ActionTarget['action'], amount: string) => {
      const key = `${action}:${amount}`;
      if (!seen.has(key)) { seen.add(key); approvalTargets.push({ action, amount }); }
    };
    // Exact allowance costs for singleton candidates are reusable by subset
    // plans; the all-candidate amount is kept separately for that bundle.
    const singletonAmounts = [...new Set(input.legs.map(leg => leg.amountUsdtRaw))];
    const approvalAmounts = [...new Set([totalInput, ...singletonAmounts])];
    for (const amount of approvalAmounts) {
      const branch = approvalBranch(allowanceRaw, amount);
      if (branch === 'reset_then_approve') add('approve_zero', '0');
      if (branch === 'approve' || branch === 'reset_then_approve') add('approve', amount);
    }
    const approvalModels: ActionCostSampleSet[] = [];
    const mintAmounts = [...new Set(input.legs.map(leg => leg.amountUsdtRaw))];
    const primaryApprovals = approvalTargets.filter(target => target.action === 'approve_zero'
      || target.amount === totalInput);
    const additionalApprovals = approvalTargets.filter(target => !primaryApprovals.includes(target));
    const requestedActions: ActionTarget[] = [
      ...primaryApprovals,
      ...mintAmounts.map(amount => ({ action: 'mint' as const, amount })),
      ...additionalApprovals,
    ];
    const actionCapacity = Math.max(0, Math.floor((MAX_RPC_READS - calls - 1) / MIN_ACTION_READS));
    const selectedActions = requestedActions.slice(0, actionCapacity);
    const mintModels = new Map<string, ActionCostSampleSet>();
    for (const [index, target] of selectedActions.entries()) {
      const remainingBaseline = (selectedActions.length - index - 1) * MIN_ACTION_READS;
      const allowEstimate = calls + MIN_ACTION_READS + 1 + remainingBaseline + 1 <= MAX_RPC_READS;
      const model = await simulateAction(input.walletAddress, target.action, target.amount,
        maxFeeLimit, canSingleSign, rpc, now,
        target.action === 'mint' ? marketEvidence.marketCodeIdentity
          : marketEvidence.underlyingCodeIdentity,
        allowEstimate);
      if (!model) continue;
      if (target.action === 'mint') {
        for (const leg of input.legs) if (leg.amountUsdtRaw === target.amount) mintModels.set(leg.bucketKey, model);
      } else approvalModels.push(model);
    }
    const last = await block();
    const endedAt = now();
    const firstBlock = BigInt(first.blockNumber) < BigInt(marketEvidence.observationWindow.firstBlock)
      ? first.blockNumber : marketEvidence.observationWindow.firstBlock;
    const lastBlock = BigInt(last.blockNumber) > BigInt(marketEvidence.observationWindow.lastBlock)
      ? last.blockNumber : marketEvidence.observationWindow.lastBlock;
    const windowStart = new Date(Math.min(Date.parse(marketEvidence.observationWindow.startedAt), startedAt.getTime()));
    if (endedAt.getTime() - windowStart.getTime() > MAX_WINDOW_MS
      || BigInt(lastBlock) - BigInt(firstBlock) > MAX_BLOCK_SPAN
      || !sourceFresh(marketEvidence.source, endedAt)
      || Date.parse(marketEvidence.validUntil) <= endedAt.getTime()) {
      return unknown('시장과 계정의 관측 범위·시각이 금액별 견적 한계를 초과했습니다.');
    }
    const parsedRate = marketEvidence.rateModel === null ? null
      : jusdtRateModelSchema.safeParse(marketEvidence.rateModel).data ?? null;
    const marketRate = parsedRate && sourceFresh(parsedRate.source, endedAt) ? parsedRate : null;
    const sources: Source[] = [marketEvidence.source, marketEvidence.directorySource,
      rpcSource('/wallet/getnowblock', startedAt), rpcSource('/wallet/getnowblock', endedAt),
      rpcSource('/wallet/getchainparameters', startedAt), rpcSource('/wallet/getaccount', startedAt),
      rpcSource('/wallet/getaccountresource', startedAt),
      rpcSource('/wallet/triggerconstantcontract', startedAt),
      ...(trxPrice ? [trxPrice.source] : []), ...(usdtPrice ? [usdtPrice.source] : []),
      ...approvalModels.flatMap(model => model.samples.map(sample => sample.source)),
      ...[...mintModels.values()].flatMap(model => model.samples.map(sample => sample.source))];
    const sourceExpiries = sources.filter(item => item.accessMethod === 'rpc')
      .map(item => Date.parse(item.fetchedAt) + SOURCE_MAX_AGE_MS);
    const priceExpiries = [trxPrice, usdtPrice].filter(item => item !== null)
      .map(item => Date.parse(item.source.sourceUpdatedAt!) + PRICE_MAX_AGE_MS);
    const validUntilMs = Math.min(Date.parse(marketEvidence.validUntil),
      marketRate ? Date.parse(marketRate.validUntil) : Infinity,
      endedAt.getTime() + 120_000, ...sourceExpiries, ...priceExpiries,
      ...approvalModels.map(model => Date.parse(model.validUntil)),
      ...[...mintModels.values()].map(model => Date.parse(model.validUntil)));
    if (validUntilMs <= endedAt.getTime()) return unknown('금액별 견적의 자료가 응답 전에 만료되었습니다.');
    const observationWindow = { firstBlock, lastBlock,
      startedAt: windowStart.toISOString(), endedAt: endedAt.toISOString() };
    const context = jusdtQuoteContextSchema.parse({
      version: hash([input.walletAddress, input.needsVersion, input.marketQuote.quoteVersion,
        observationWindow, balanceRaw.toString(), allowanceRaw, trxSun.toString(),
        energyPrice.toString(), bandwidthPrice.toString(), maxFeeLimit.toString(),
        trxPrice?.value ?? null, usdtPrice?.value ?? null,
        marketEvidence.underlyingCodeIdentity, marketEvidence.marketCodeIdentity,
        approvalModels.map(model => model.modelVersion),
        [...mintModels.entries()].map(([key, model]) => [key, model.modelVersion])]),
      chain: 'mainnet', walletAddress: input.walletAddress,
      usdtAddress: MAINNET_USDT_ADDRESS, jusdtAddress: MAINNET_JUSDT_ADDRESS,
      marketQuoteVersion: input.marketQuote.quoteVersion, needsVersion: input.needsVersion,
      energyPriceSun: energyPrice.toString(), bandwidthPriceSun: bandwidthPrice.toString(),
      maxFeeLimitSun: maxFeeLimit.toString(), trxUsd: trxPrice?.value ?? null, usdtUsd: usdtPrice?.value ?? null,
      availableEnergy: availableEnergy?.toString() ?? null,
      availableBandwidth: availableBandwidth?.toString() ?? null,
      availableTrxSun: trxSun.toString(), observedUsdtRaw: balanceRaw.toString(),
      allowanceUsdtRaw: allowanceRaw, sources, observationWindow,
      validUntil: new Date(validUntilMs).toISOString(),
    });
    const legs = [];
    for (const leg of input.legs) {
      const mintModel = mintModels.get(leg.bucketKey);
      const mintCost = costEvidenceForAction(context, 'mint', leg.amountUsdtRaw,
        mintModel ? [mintModel] : []);
      legs.push(jusdtLegQuoteSchema.parse({ chain: 'mainnet', walletAddress: input.walletAddress,
        needsVersion: input.needsVersion, bucketKey: leg.bucketKey,
        amountUsdtRaw: leg.amountUsdtRaw, dueDate: leg.dueDate,
        plannedExitDate: leg.plannedExitDate, earningDays: leg.earningDays,
        contextVersion: context.version, marketQuoteVersion: context.marketQuoteVersion,
        mintCost, redeemModelVersion: null, status: 'partial',
        validUntil: context.validUntil,
        quoteVersion: hash([context.version, leg, mintCost.basis, mintCost.energyUnits]),
      }));
    }
    const sizing = jusdtSizingInputsSchema.parse({ context, legs, approvalModels,
      redeemModels: [], rateModel: marketRate });
    return { status: 'ready', value: sizing, source: provenance(`${MAINNET_RPC}/wallet/getnowblock`, 'mainnet', 'rpc') };
  } catch (error) {
    return unknown(connectionReason(error, 'Mainnet jUSDT 금액별 읽기'));
  }
}
