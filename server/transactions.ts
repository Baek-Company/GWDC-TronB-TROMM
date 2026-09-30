import { createHash, randomUUID } from 'node:crypto';
import { TronWeb } from 'tronweb';
import type { ActionPreview, Observation, Source } from '../shared/schemas';
import { NILE_RPC } from './data';

export const NILE_CHAIN_ID = '0xcd8690dc';
// Official JustLend MCP lists this as a Nile candidate. It is never trusted without the checks below.
export const NILE_JTRX_CANDIDATE = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
// Two explicit TronLink prompts (wallet proof and transaction signature) must fit before revalidation.
const PREVIEW_LIFETIME_MS = 180_000;
const TRX = { symbol: 'TRX', address: null, decimals: 6 } as const;
const UINT_RE = /^\d+$/;
const TX_ID_RE = /^[0-9a-fA-F]{64}$/;
const HEX_RE = /^(?:[0-9a-fA-F]{2})+$/;
// A single signed contract call: protobuf framing (3), one signature (67), result (64).
// https://developers.tron.network/docs/faq#how-do-i-calculate-bandwidth-and-energy-for-a-contract-call-or-deployment
const SIGNED_CONTRACT_OVERHEAD_BYTES = 134n;

type RpcResult = Record<string, unknown>;
export type NileRpc = (path: string, body: Record<string, unknown>, precise?: boolean) => Promise<RpcResult>;

export type NileDepositState = {
  chain: 'nile'; chainId: typeof NILE_CHAIN_ID;
  walletAddress: string; contractAddress: string; comptrollerAddress: string;
  jtrxDecimals: 8;
  contractCodeHash: string; walletBalanceSun: string; jtrxBalanceRaw: string;
  marketCashSun: string; exchangeRateRaw: string; supplyRatePerBlockRaw: string;
  availableEnergy: string; availableBandwidth: string;
  estimatedEnergy: string; energyPriceSun: string; bandwidthPriceSun: string;
  estimatedFeeSun: string; feeLimitSun: string; bandwidthFeeUpperBoundSun: string;
  maxFeeSun: string; amountSun: string; source: Source;
};

export type NileDepositPreview = ActionPreview & {
  chain: 'nile'; method: 'mint()'; feeLimitSun: string;
  state: NileDepositState;
};

export type NileWithdrawalState = {
  chain: 'nile'; chainId: typeof NILE_CHAIN_ID;
  walletAddress: string; contractAddress: string; comptrollerAddress: string;
  contractCodeHash: string; jtrxDecimals: 8;
  walletBalanceSun: string; jtrxBalanceRaw: string; jtrxAmountRaw: string;
  marketCashSun: string; exchangeRateStoredRaw: string; exchangeRateCurrentRaw: string;
  expectedUnderlyingSun: string; supplyRatePerBlockRaw: string;
  availableEnergy: string; availableBandwidth: string;
  estimatedEnergy: string; energyPriceSun: string; bandwidthPriceSun: string;
  estimatedFeeSun: string; feeLimitSun: string; bandwidthFeeUpperBoundSun: string;
  /** Zero-resource full burn; estimatedFeeSun subtracts currently available wallet resources. */
  fullBurnFeeSun?: string; estimatedBandwidthBytes?: string;
  simulatedEnergy?: string; estimateEnergyRequired?: string | null;
  dynamicEnergyMaxFactorRaw?: string | null;
  feeLimitBasis?: 'dynamic_max_factor' | 'current_energy_2x';
  maxFeeSun: string; source: Source;
};

export type NileWithdrawalPreview = ActionPreview & {
  chain: 'nile'; method: 'redeem(uint256)'; feeLimitSun: string;
  expectedUnderlyingSun: string; state: NileWithdrawalState;
};

export type NileWithdrawalProbe =
  | { status: 'ready'; state: NileWithdrawalState }
  | { status: 'deferred'; reason: string; source: Source };

export type NileTransactionResult = {
  txId: string; status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  receipt: RpcResult | null; actualFeeSun: string | null;
  reason: string | null; source: Source;
};

export type NileRedeemCostBound = {
  chain: 'nile'; contractAddress: string; estimatedFeeSun: null;
  maxFeeSun: string; energyFeeLimitSun: string; bandwidthFeeUpperBoundSun: string;
  reason: string; source: Source;
};

function address(value: string, field: string): string {
  if (!TronWeb.isAddress(value)) throw new Error(`${field}: 유효한 TRON 주소가 아닙니다.`);
  return TronWeb.address.fromHex(TronWeb.address.toHex(value));
}

function accountBalance(account: RpcResult, walletAddress: string): bigint {
  // A newly activated Nile account can be returned as {}. An address that is present
  // must still be bound to the account requested from the RPC.
  if (account.address !== undefined &&
      (typeof account.address !== 'string' || address(account.address, 'RPC 계정 주소') !== walletAddress)) {
    throw new Error('Nile RPC 계정 주소가 요청한 지갑과 다릅니다.');
  }
  return unsigned(account.balance ?? '0', 'TRX 잔고');
}

function unsigned(value: unknown, field: string): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${field}: 정밀하지 않은 숫자입니다.`);
    return BigInt(value);
  }
  if (typeof value !== 'string' || !UINT_RE.test(value)) throw new Error(`${field}: 정수 문자열이 필요합니다.`);
  return BigInt(value);
}

function positive(value: unknown, field: string): bigint {
  const number = unsigned(value, field);
  if (number === 0n) throw new Error(`${field}: 0보다 커야 합니다.`);
  return number;
}

function safeNumber(value: bigint, field: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${field}: TronWeb의 안전한 정수 범위를 초과했습니다.`);
  return Number(value);
}

function object(value: unknown, field: string): RpcResult {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field}: 예상하지 못한 응답입니다.`);
  return value as RpcResult;
}

function hexResult(value: RpcResult, field: string): string {
  const result = object(value.result, `${field}.result`);
  if (result.result !== true) throw new Error(`${field}: 계약 호출이 실패했습니다.`);
  const first = Array.isArray(value.constant_result) ? value.constant_result[0] : undefined;
  if (typeof first !== 'string' || !HEX_RE.test(first) || first.length < 64) throw new Error(`${field}: 반환값을 확인할 수 없습니다.`);
  return first;
}

function abiMethod(contract: RpcResult, name: string, mutability?: string, inputTypes?: string[]): boolean {
  const abi = object(contract.abi, '계약 ABI');
  const entries = Array.isArray(abi.entrys) ? abi.entrys : [];
  return entries.some(entry => {
    if (!entry || typeof entry !== 'object') return false;
    const item = entry as RpcResult;
    const inputs = Array.isArray(item.inputs) ? item.inputs : [];
    return item.name === name && item.type === 'Function' &&
      (inputTypes === undefined || (inputs.length === inputTypes.length &&
        inputs.every((input, index) => input && typeof input === 'object' &&
          (input as RpcResult).type === inputTypes[index]))) &&
      (mutability === undefined || item.stateMutability === mutability || (mutability === 'Payable' && item.payable === true));
  });
}

async function defaultRpc(path: string, body: Record<string, unknown>, precise = false): Promise<RpcResult> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const url = new URL(path, `${NILE_RPC}/`);
  if (precise) {
    for (const [key, value] of Object.entries({ ...body, int64_as_string: true })) url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, {
    method: precise ? 'GET' : 'POST', headers,
    body: precise ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Nile RPC HTTP ${response.status}`);
  const data = object(await response.json(), path);
  if (data.Error || data.error) {
    const detail = data.Error ?? data.error;
    if (path === 'wallet/estimateenergy' && typeof detail === 'string' &&
        /this node does not support estimate energy/i.test(detail)) {
      throw new Error('this node does not support estimate energy');
    }
    throw new Error(`${path}: Nile RPC 오류`);
  }
  return data;
}

function estimateEnergyUnsupported(error: unknown): boolean {
  return error instanceof Error && /this node does not support estimate energy/i.test(error.message);
}

function source(now: () => number): Source {
  return { sourceUrl: NILE_RPC, chain: 'nile', fetchedAt: new Date(now()).toISOString(),
    sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };
}

function chainParameter(result: RpcResult, name: string): bigint {
  const params = Array.isArray(result.chainParameter) ? result.chainParameter : [];
  const match = params.find(item => item && typeof item === 'object' && (item as RpcResult).key === name);
  return positive(match && (match as RpcResult).value, name);
}

function optionalChainParameter(result: RpcResult, name: string): bigint | null {
  const params = Array.isArray(result.chainParameter) ? result.chainParameter : [];
  const match = params.find(item => item && typeof item === 'object' && (item as RpcResult).key === name);
  return match === undefined ? null : unsigned((match as RpcResult).value, name);
}

function isSuccessfulSimulation(result: RpcResult): boolean {
  if (result.ret === undefined) return true;
  if (!Array.isArray(result.ret)) return false;
  return result.ret.every(item => item && typeof item === 'object' &&
    (item as RpcResult).contractRet !== undefined &&
    ['SUCCESS', 'SUCESS'].includes(String((item as RpcResult).contractRet)));
}

function excess(needed: bigint, available: bigint): bigint {
  return needed > available ? needed - available : 0n;
}

function resourceRemaining(resource: RpcResult, limit: string, used: string): bigint {
  const total = unsigned(resource[limit] ?? '0', limit);
  const spent = unsigned(resource[used] ?? '0', used);
  return total > spent ? total - spent : 0n;
}

export function createNileExecutionGateway(options: {
  rpc?: NileRpc; now?: () => number; candidateAddress?: string;
} = {}) {
  const rpc = options.rpc ?? defaultRpc;
  const now = options.now ?? Date.now;
  const candidate = address(options.candidateAddress ?? NILE_JTRX_CANDIDATE, 'jTRX 후보');

  async function readNileWalletBalance(wallet: string) {
    const walletAddress = address(wallet, '지갑 주소');
    const account = await rpc('wallet/getaccount', { address: walletAddress, visible: true }, true);
    return { walletAddress, chain: 'nile' as const,
      balanceSun: accountBalance(account, walletAddress).toString(), source: source(now) };
  }

  async function readNileRedeemCostBound(contractInput?: string): Promise<NileRedeemCostBound> {
    const contractAddress = address(contractInput ?? candidate, 'jTRX 주소');
    if (contractAddress !== candidate) throw new Error('검증된 Nile jTRX 후보 주소와 다릅니다.');
    const info = await rpc('wallet/getcontractinfo', { value: contractAddress, visible: true });
    const contract = object(info.smart_contract, 'jTRX 계약');
    if (typeof info.runtimecode !== 'string' || !HEX_RE.test(info.runtimecode) || info.runtimecode.length < 4 ||
        address(String(contract.contract_address), '계약 응답 주소') !== contractAddress ||
        !abiMethod(contract, 'redeem', undefined, ['uint256'])) {
      throw new Error('Nile jTRX 코드와 redeem(uint256) ABI를 확인할 수 없습니다.');
    }
    const parameters = await rpc('wallet/getchainparameters', {});
    const maximumFeeLimit = chainParameter(parameters, 'getMaxFeeLimit');
    const bandwidthPrice = chainParameter(parameters, 'getTransactionFee');
    // This is only an unsigned size probe. redeem(1) cannot estimate a real withdrawal without jTRX holdings.
    const draft = await rpc('wallet/triggersmartcontract', {
      owner_address: contractAddress, contract_address: contractAddress,
      function_selector: 'redeem(uint256)', parameter: '1'.padStart(64, '0'),
      fee_limit: safeNumber(maximumFeeLimit, 'Nile 최대 Energy 상한'), visible: true,
    });
    const result = object(draft.result, '환매 미서명 거래 결과');
    const transaction = object(draft.transaction, '환매 미서명 거래');
    if (result.result !== true || typeof transaction.raw_data_hex !== 'string' || !HEX_RE.test(transaction.raw_data_hex)) {
      throw new Error('Nile 환매 거래 크기를 확인할 수 없습니다.');
    }
    const bandwidthFeeUpperBound = (BigInt(transaction.raw_data_hex.length / 2) + SIGNED_CONTRACT_OVERHEAD_BYTES) * bandwidthPrice;
    return {
      chain: 'nile', contractAddress, estimatedFeeSun: null,
      maxFeeSun: (maximumFeeLimit + bandwidthFeeUpperBound).toString(),
      energyFeeLimitSun: maximumFeeLimit.toString(),
      bandwidthFeeUpperBoundSun: bandwidthFeeUpperBound.toString(),
      reason: '예치 전 양수 환매 Energy는 jTRX 잔고가 없어 시뮬레이션할 수 없습니다. 체인 최대 상한만 확인했습니다.',
      source: source(now),
    };
  }

  async function constant(contractAddress: string, selector: string, parameters?: string): Promise<string> {
    const response = await rpc('wallet/triggerconstantcontract', {
      owner_address: contractAddress, contract_address: contractAddress,
      function_selector: selector, ...(parameters ? { parameter: parameters } : {}), visible: true,
    });
    return hexResult(response, selector);
  }

  async function verifyJtrxMarket(contractAddress: string) {
    const info = await rpc('wallet/getcontractinfo', { value: contractAddress, visible: true });
    const smartContract = object(info.smart_contract, 'jTRX 계약');
    const runtimeCode = info.runtimecode;
    if (typeof runtimeCode !== 'string' || !HEX_RE.test(runtimeCode) || runtimeCode.length < 4) {
      throw new Error('Nile jTRX 런타임 코드가 확인되지 않았습니다.');
    }
    if (address(String(smartContract.contract_address), '계약 응답 주소') !== contractAddress) {
      throw new Error('Nile jTRX 계약 주소가 응답과 다릅니다.');
    }
    for (const method of ['symbol', 'decimals', 'balanceOf', 'exchangeRateStored', 'exchangeRateCurrent',
      'getCash', 'comptroller', 'supplyRatePerBlock']) {
      if (!abiMethod(smartContract, method)) throw new Error(`Nile jTRX ABI의 ${method} 메서드가 확인되지 않았습니다.`);
    }
    if (!abiMethod(smartContract, 'mint', 'Payable', [])) throw new Error('Nile jTRX의 payable mint()가 확인되지 않았습니다.');
    if (!abiMethod(smartContract, 'redeem', undefined, ['uint256'])) throw new Error('Nile jTRX의 redeem(uint256)이 확인되지 않았습니다.');

    const [decimalsHex, symbolHex] = await Promise.all([
      constant(contractAddress, 'decimals()'), constant(contractAddress, 'symbol()'),
    ]);
    if (BigInt(`0x${decimalsHex}`) !== 8n) throw new Error('Nile jTRX의 온체인 소수 자릿수가 8이 아닙니다.');
    const stringOffset = Number(BigInt(`0x${symbolHex.slice(0, 64)}`)) * 2;
    if (!Number.isSafeInteger(stringOffset) || stringOffset + 64 > symbolHex.length) throw new Error('Nile jTRX 심볼을 확인할 수 없습니다.');
    const stringLength = Number(BigInt(`0x${symbolHex.slice(stringOffset, stringOffset + 64)}`));
    if (!Number.isSafeInteger(stringLength) || stringLength < 1 || stringLength > 32 ||
        stringOffset + 64 + stringLength * 2 > symbolHex.length ||
        Buffer.from(symbolHex.slice(stringOffset + 64, stringOffset + 64 + stringLength * 2), 'hex').toString('utf8') !== 'jTRX') {
      throw new Error('Nile jTRX 계약 심볼이 일치하지 않습니다.');
    }

    const comptrollerHex = await constant(contractAddress, 'comptroller()');
    const comptrollerAddress = address(`41${comptrollerHex.slice(-40)}`, 'Comptroller 주소');
    const comptrollerInfo = await rpc('wallet/getcontractinfo', { value: comptrollerAddress, visible: true });
    if (typeof comptrollerInfo.runtimecode !== 'string' || !HEX_RE.test(comptrollerInfo.runtimecode) || comptrollerInfo.runtimecode.length < 4) {
      throw new Error('Nile Comptroller 계약 코드가 확인되지 않았습니다.');
    }
    const encodedMarket = TronWeb.address.toHex(contractAddress).slice(2).padStart(64, '0');
    const marketWords = await constant(comptrollerAddress, 'markets(address)', encodedMarket);
    if (BigInt(`0x${marketWords.slice(0, 64)}`) !== 1n) throw new Error('Nile jTRX 시장이 활성 목록에 없습니다.');
    return { comptrollerAddress, contractCodeHash: createHash('sha256').update(runtimeCode).digest('hex') };
  }

  async function readNileDepositState(input: {
    address: string; amountSun: string; contractAddress?: string;
  }): Promise<NileDepositState> {
    const walletAddress = address(input.address, '지갑 주소');
    const contractAddress = address(input.contractAddress ?? candidate, 'jTRX 주소');
    if (contractAddress !== candidate) throw new Error('검증된 Nile jTRX 후보 주소와 다릅니다.');
    const amount = positive(input.amountSun, '예치 SUN');
    const amountNumber = safeNumber(amount, '예치 SUN');

    const verified = await verifyJtrxMarket(contractAddress);

    const encodedWallet = TronWeb.address.toHex(walletAddress).slice(2).padStart(64, '0');
    const [balanceHex, exchangeHex, cashHex, rateHex, account, resources, parameters] = await Promise.all([
      constant(contractAddress, 'balanceOf(address)', encodedWallet),
      constant(contractAddress, 'exchangeRateStored()'),
      constant(contractAddress, 'getCash()'),
      constant(contractAddress, 'supplyRatePerBlock()'),
      rpc('wallet/getaccount', { address: walletAddress, visible: true }, true),
      rpc('wallet/getaccountresource', { address: walletAddress, visible: true }, true),
      rpc('wallet/getchainparameters', {}),
    ]);
    const walletBalance = accountBalance(account, walletAddress);
    const jtrxBalance = BigInt(`0x${balanceHex}`);
    const exchangeRate = positive(BigInt(`0x${exchangeHex}`).toString(), '환율');
    const cash = BigInt(`0x${cashHex}`);
    const rate = BigInt(`0x${rateHex}`);
    // Conservative demonstration policy: require immediate full exit liquidity.
    // getCash() is not a protocol requirement for mint() itself.
    if (cash < amount) throw new Error('시연 정책상 예치 직후 전액 환매가 가능한 시장 현금이 필요합니다. 현재 출구 유동성이 부족합니다.');
    const energyPrice = chainParameter(parameters, 'getEnergyFee');
    const bandwidthPrice = chainParameter(parameters, 'getTransactionFee');
    const maximumFeeLimit = chainParameter(parameters, 'getMaxFeeLimit');

    const energyRequest = {
      owner_address: walletAddress, contract_address: contractAddress,
      function_selector: 'mint()', call_value: amountNumber, visible: true,
    };
    let energy: bigint;
    try {
      const estimate = await rpc('wallet/estimateenergy', energyRequest);
      const result = object(estimate.result, 'Energy 추정 결과');
      if (result.result !== true) throw new Error('mint() 사전 실행에 실패했습니다.');
      energy = positive(estimate.energy_required, '예상 Energy');
    } catch (error) {
      if (!estimateEnergyUnsupported(error)) throw error;
      const simulated = await rpc('wallet/triggerconstantcontract', energyRequest);
      const simulationResult = object(simulated.result, 'mint() 사전 실행');
      if (simulationResult.result !== true) throw new Error('mint() 사전 실행이 실패했습니다.');
      energy = positive(simulated.energy_used, '예상 Energy');
    }
    const estimatedEnergyFee = energy * energyPrice;
    const feeLimit = estimatedEnergyFee * 2n;
    if (feeLimit > maximumFeeLimit) throw new Error('Energy 상한이 Nile 체인 허용 범위를 초과합니다.');
    const draft = await rpc('wallet/triggersmartcontract', {
      ...energyRequest, fee_limit: safeNumber(feeLimit, 'Energy 상한'),
    });
    const draftResult = object(draft.result, '미서명 거래 결과');
    const transaction = object(draft.transaction, '미서명 거래');
    if (draftResult.result !== true || typeof transaction.raw_data_hex !== 'string' || !HEX_RE.test(transaction.raw_data_hex)) {
      throw new Error('Nile jTRX 미서명 거래를 구성할 수 없습니다.');
    }
    const bandwidthBytes = BigInt(transaction.raw_data_hex.length / 2) + SIGNED_CONTRACT_OVERHEAD_BYTES;
    const bandwidthFeeUpperBound = bandwidthBytes * bandwidthPrice;
    const estimatedFee = estimatedEnergyFee + bandwidthFeeUpperBound;
    const maxFee = feeLimit + bandwidthFeeUpperBound;
    if (walletBalance < amount + maxFee) throw new Error('Nile TRX 잔고가 예치 금액과 최대 수수료 재원을 충당하지 못합니다.');
    const availableEnergy = resourceRemaining(resources, 'EnergyLimit', 'EnergyUsed');
    const availableBandwidth = resourceRemaining(resources, 'freeNetLimit', 'freeNetUsed') +
      resourceRemaining(resources, 'NetLimit', 'NetUsed');

    return {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress, contractAddress, jtrxDecimals: 8,
      comptrollerAddress: verified.comptrollerAddress, contractCodeHash: verified.contractCodeHash,
      walletBalanceSun: walletBalance.toString(), jtrxBalanceRaw: jtrxBalance.toString(),
      marketCashSun: cash.toString(), exchangeRateRaw: exchangeRate.toString(),
      supplyRatePerBlockRaw: rate.toString(), availableEnergy: availableEnergy.toString(),
      availableBandwidth: availableBandwidth.toString(), estimatedEnergy: energy.toString(),
      energyPriceSun: energyPrice.toString(), bandwidthPriceSun: bandwidthPrice.toString(),
      estimatedFeeSun: estimatedFee.toString(), feeLimitSun: feeLimit.toString(),
      bandwidthFeeUpperBoundSun: bandwidthFeeUpperBound.toString(), maxFeeSun: maxFee.toString(),
      amountSun: amount.toString(), source: source(now),
    };
  }

  async function readNileWithdrawalState(input: {
    address: string; jtrxAmountRaw: string; contractAddress?: string;
  }): Promise<NileWithdrawalState> {
    const walletAddress = address(input.address, '지갑 주소');
    const contractAddress = address(input.contractAddress ?? candidate, 'jTRX 주소');
    if (contractAddress !== candidate) throw new Error('검증된 Nile jTRX 후보 주소와 다릅니다.');
    const amount = positive(input.jtrxAmountRaw, '환매 jTRX 최소 단위');
    if (amount > 2n ** 256n - 1n) throw new Error('jTRX 환매 수량이 uint256 범위를 초과합니다.');
    const verified = await verifyJtrxMarket(contractAddress);
    const encodedWallet = TronWeb.address.toHex(walletAddress).slice(2).padStart(64, '0');
    const [balanceHex, storedHex, currentHex, cashHex, rateHex, account, resources, parameters] = await Promise.all([
      constant(contractAddress, 'balanceOf(address)', encodedWallet),
      constant(contractAddress, 'exchangeRateStored()'),
      constant(contractAddress, 'exchangeRateCurrent()'),
      constant(contractAddress, 'getCash()'),
      constant(contractAddress, 'supplyRatePerBlock()'),
      rpc('wallet/getaccount', { address: walletAddress, visible: true }, true),
      rpc('wallet/getaccountresource', { address: walletAddress, visible: true }, true),
      rpc('wallet/getchainparameters', {}),
    ]);
    const receiptBalance = BigInt(`0x${balanceHex}`);
    const storedRate = positive(BigInt(`0x${storedHex}`).toString(), '저장 환율');
    const currentRate = positive(BigInt(`0x${currentHex}`).toString(), '현재 환율');
    const marketCash = BigInt(`0x${cashHex}`);
    const walletBalance = accountBalance(account, walletAddress);
    if (receiptBalance < amount) throw new Error('실제 Nile jTRX 잔고가 환매 수량보다 적습니다.');
    const expectedUnderlying = amount * currentRate / 10n ** 18n;
    if (expectedUnderlying === 0n) throw new Error('예상 환매 TRX가 최소 단위보다 작습니다.');
    if (marketCash < expectedUnderlying) throw new Error('Nile jTRX 시장의 현재 환매 유동성이 부족합니다.');
    const energyPrice = chainParameter(parameters, 'getEnergyFee');
    const bandwidthPrice = chainParameter(parameters, 'getTransactionFee');
    const maximumFeeLimit = chainParameter(parameters, 'getMaxFeeLimit');
    const parameter = amount.toString(16).padStart(64, '0');
    const request = {
      owner_address: walletAddress, contract_address: contractAddress,
      function_selector: 'redeem(uint256)', parameter, visible: true,
    };
    const simulated = await rpc('wallet/triggerconstantcontract', request);
    const simulationReturn = hexResult(simulated, 'redeem(uint256) 사전 실행');
    if (!isSuccessfulSimulation(simulated)) throw new Error('redeem(uint256) 사전 실행의 TVM 결과가 성공이 아닙니다.');
    if (BigInt(`0x${simulationReturn.slice(0, 64)}`) !== 0n) {
      throw new Error('jTRX 환매 계약이 오류 코드를 반환했습니다. 담보·차입·시장 상태를 확인해 주세요.');
    }
    const simulatedEnergy = positive(simulated.energy_used, '환매 사전 실행 Energy');
    const energyPenalty = simulated.energy_penalty === undefined ? null :
      unsigned(simulated.energy_penalty, '환매 동적 Energy');
    if (energyPenalty !== null && energyPenalty > simulatedEnergy) {
      throw new Error('환매 동적 Energy가 전체 사용량보다 큽니다.');
    }
    let estimateEnergyRequired: bigint | null = null;
    try {
      const estimate = await rpc('wallet/estimateenergy', request);
      if (object(estimate.result, '환매 Energy 추정').result !== true) throw new Error('환매 Energy 추정 실패');
      estimateEnergyRequired = positive(estimate.energy_required, '환매 예상 Energy');
    } catch (error) {
      if (!estimateEnergyUnsupported(error)) throw error;
    }
    // Both endpoints are read-only estimates. Use the larger successful reading rather than
    // silently replacing a higher constant-call result with a lower estimateenergy result.
    const energy = estimateEnergyRequired !== null && estimateEnergyRequired > simulatedEnergy ?
      estimateEnergyRequired : simulatedEnergy;
    const dynamicEnabled = optionalChainParameter(parameters, 'getAllowDynamicEnergy');
    const dynamicFactor = dynamicEnabled === 0n ? 0n :
      optionalChainParameter(parameters, 'getDynamicEnergyMaxFactor');
    const baseForDynamic = estimateEnergyRequired !== null && estimateEnergyRequired > simulatedEnergy ?
      estimateEnergyRequired : simulatedEnergy - (energyPenalty ?? 0n);
    const dynamicEnergyBudget = dynamicFactor === null ? null :
      (baseForDynamic * (10_000n + dynamicFactor) + 9_999n) / 10_000n;
    const feeLimitEnergy = dynamicEnergyBudget !== null && dynamicEnergyBudget > energy * 2n ?
      dynamicEnergyBudget : energy * 2n;
    const feeLimit = feeLimitEnergy * energyPrice;
    if (feeLimit > maximumFeeLimit) throw new Error('환매 Energy 상한이 Nile 체인 허용 범위를 초과합니다.');
    const draft = await rpc('wallet/triggersmartcontract', {
      ...request, fee_limit: safeNumber(feeLimit, '환매 Energy 상한'),
    });
    const draftResult = object(draft.result, '환매 미서명 거래 결과');
    const transaction = object(draft.transaction, '환매 미서명 거래');
    if (draftResult.result !== true || typeof transaction.raw_data_hex !== 'string' || !HEX_RE.test(transaction.raw_data_hex)) {
      throw new Error('Nile jTRX 환매 거래 크기를 확인할 수 없습니다.');
    }
    const bandwidthBytes = BigInt(transaction.raw_data_hex.length / 2) + SIGNED_CONTRACT_OVERHEAD_BYTES;
    const bandwidthFeeUpperBound = bandwidthBytes * bandwidthPrice;
    const fullBurnFee = energy * energyPrice + bandwidthFeeUpperBound;
    const maxFee = feeLimit + bandwidthFeeUpperBound;
    const availableEnergy = resourceRemaining(resources, 'EnergyLimit', 'EnergyUsed');
    const availableBandwidth = resourceRemaining(resources, 'freeNetLimit', 'freeNetUsed') +
      resourceRemaining(resources, 'NetLimit', 'NetUsed');
    // Treat all Energy as caller-paid: an unverified deployer subsidy must not
    // make the wallet's burn estimate look artificially low.
    const estimatedFee = excess(energy, availableEnergy) * energyPrice +
      excess(bandwidthBytes, availableBandwidth) * bandwidthPrice;
    // The cap remains a conservative wallet funding policy even when free resources
    // appear available now; those resources may be spent before the transaction lands.
    if (walletBalance < maxFee) throw new Error('환매 거래의 최대 수수료를 지불할 Nile TRX 잔고가 부족합니다.');
    return {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress, contractAddress,
      comptrollerAddress: verified.comptrollerAddress, contractCodeHash: verified.contractCodeHash, jtrxDecimals: 8,
      walletBalanceSun: walletBalance.toString(), jtrxBalanceRaw: receiptBalance.toString(),
      jtrxAmountRaw: amount.toString(), marketCashSun: marketCash.toString(),
      exchangeRateStoredRaw: storedRate.toString(), exchangeRateCurrentRaw: currentRate.toString(),
      expectedUnderlyingSun: expectedUnderlying.toString(), supplyRatePerBlockRaw: BigInt(`0x${rateHex}`).toString(),
      availableEnergy: availableEnergy.toString(), availableBandwidth: availableBandwidth.toString(),
      estimatedEnergy: energy.toString(), energyPriceSun: energyPrice.toString(),
      bandwidthPriceSun: bandwidthPrice.toString(), estimatedFeeSun: estimatedFee.toString(),
      fullBurnFeeSun: fullBurnFee.toString(), estimatedBandwidthBytes: bandwidthBytes.toString(),
      simulatedEnergy: simulatedEnergy.toString(), estimateEnergyRequired: estimateEnergyRequired?.toString() ?? null,
      dynamicEnergyMaxFactorRaw: dynamicFactor?.toString() ?? null,
      feeLimitBasis: dynamicEnergyBudget !== null && dynamicEnergyBudget > energy * 2n ?
        'dynamic_max_factor' : 'current_energy_2x',
      feeLimitSun: feeLimit.toString(), bandwidthFeeUpperBoundSun: bandwidthFeeUpperBound.toString(),
      maxFeeSun: maxFee.toString(), source: source(now),
    };
  }

  async function probeNileWithdrawal(input: {
    address: string; jtrxAmountRaw: string; contractAddress?: string;
  }): Promise<NileWithdrawalProbe> {
    try { return { status: 'ready', state: await readNileWithdrawalState(input) }; }
    catch (error) {
      return { status: 'deferred', reason: error instanceof Error ? error.message : 'Nile 환매 사전 검증에 실패했습니다.', source: source(now) };
    }
  }

  async function createNileWithdrawalPreview(input: {
    planId: string; needsVersion: number; quoteVersion: string;
    address: string; jtrxAmountRaw: string; contractAddress?: string;
  }): Promise<NileWithdrawalPreview> {
    if (!input.planId || !Number.isSafeInteger(input.needsVersion) || input.needsVersion < 1 || !input.quoteVersion) {
      throw new Error('원 Nile 계획 ID와 입력·견적 버전이 필요합니다.');
    }
    const state = await readNileWithdrawalState(input);
    const fingerprintInput = {
      planId: input.planId, needsVersion: input.needsVersion, quoteVersion: input.quoteVersion,
      chainId: state.chainId, walletAddress: state.walletAddress, contractAddress: state.contractAddress,
      contractCodeHash: state.contractCodeHash, comptrollerAddress: state.comptrollerAddress,
      jtrxDecimals: state.jtrxDecimals, jtrxBalanceRaw: state.jtrxBalanceRaw,
      jtrxAmountRaw: state.jtrxAmountRaw, walletBalanceSun: state.walletBalanceSun,
      marketCashSun: state.marketCashSun, exchangeRateStoredRaw: state.exchangeRateStoredRaw,
      exchangeRateCurrentRaw: state.exchangeRateCurrentRaw, expectedUnderlyingSun: state.expectedUnderlyingSun,
      supplyRatePerBlockRaw: state.supplyRatePerBlockRaw,
      estimatedEnergy: state.estimatedEnergy, energyPriceSun: state.energyPriceSun,
      bandwidthPriceSun: state.bandwidthPriceSun, availableEnergy: state.availableEnergy,
      availableBandwidth: state.availableBandwidth, fullBurnFeeSun: state.fullBurnFeeSun,
      estimatedBandwidthBytes: state.estimatedBandwidthBytes, simulatedEnergy: state.simulatedEnergy,
      estimateEnergyRequired: state.estimateEnergyRequired,
      dynamicEnergyMaxFactorRaw: state.dynamicEnergyMaxFactorRaw, feeLimitBasis: state.feeLimitBasis,
      feeLimitSun: state.feeLimitSun,
      estimatedFeeSun: state.estimatedFeeSun, maxFeeSun: state.maxFeeSun,
    };
    return {
      id: randomUUID(), planId: input.planId, needsVersion: input.needsVersion,
      quoteVersion: input.quoteVersion, walletAddress: state.walletAddress, chain: 'nile',
      asset: { symbol: 'jTRX', address: state.contractAddress, decimals: 8 },
      amountBaseUnits: state.jtrxAmountRaw, contractAddress: state.contractAddress,
      method: 'redeem(uint256)', approvalScope: null,
      estimatedFeeBaseUnits: state.estimatedFeeSun, maxFeeBaseUnits: state.maxFeeSun,
      feeLimitSun: state.feeLimitSun, expectedUnderlyingSun: state.expectedUnderlyingSun,
      expiresAt: new Date(now() + PREVIEW_LIFETIME_MS).toISOString(),
      fingerprint: createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex'),
      risks: ['redeem(uint256)에는 최소 TRX 수령량 인자가 없어 실제 수령액은 환율에 따라 달라질 수 있습니다.',
        '담보로 사용 중인 jTRX는 환매가 실패할 수 있습니다.',
        '예상 수수료는 현재 무료 Energy·Bandwidth를 차감한 TRX 소각 추정치입니다. 자원은 서명 전에 변할 수 있습니다.',
        '최대 수수료는 Energy fee_limit과 Bandwidth 예산의 합이며 실제 납부액이나 거래 성공 보증이 아닙니다.',
        ...(state.dynamicEnergyMaxFactorRaw === null ?
          ['Nile 동적 Energy 최대 계수가 확인되지 않아 현재 Energy의 2배를 상한 정책으로 사용합니다.'] : [])],
      source: state.source, state,
    };
  }

  async function createNileDepositPreview(input: {
    planId: string; needsVersion: number; quoteVersion: string;
    address: string; amountSun: string; contractAddress?: string;
  }): Promise<NileDepositPreview> {
    if (!input.planId || !Number.isSafeInteger(input.needsVersion) || input.needsVersion < 1 || !input.quoteVersion) {
      throw new Error('확인된 Nile 계획 ID와 입력·견적 버전이 필요합니다.');
    }
    const state = await readNileDepositState(input);
    const fingerprintInput = {
      planId: input.planId, needsVersion: input.needsVersion, quoteVersion: input.quoteVersion,
      chainId: state.chainId, walletAddress: state.walletAddress,
      asset: TRX, amountSun: state.amountSun, contractAddress: state.contractAddress,
      contractCodeHash: state.contractCodeHash, comptrollerAddress: state.comptrollerAddress,
      jtrxDecimals: state.jtrxDecimals,
      marketListed: true, marketCashSun: state.marketCashSun, walletBalanceSun: state.walletBalanceSun,
      jtrxBalanceRaw: state.jtrxBalanceRaw,
      exchangeRateRaw: state.exchangeRateRaw, supplyRatePerBlockRaw: state.supplyRatePerBlockRaw,
      estimatedEnergy: state.estimatedEnergy, energyPriceSun: state.energyPriceSun,
      bandwidthPriceSun: state.bandwidthPriceSun, feeLimitSun: state.feeLimitSun,
      estimatedFeeSun: state.estimatedFeeSun, maxFeeSun: state.maxFeeSun,
    };
    const fingerprint = createHash('sha256').update(JSON.stringify(fingerprintInput)).digest('hex');
    return {
      id: randomUUID(), planId: input.planId, needsVersion: input.needsVersion,
      quoteVersion: input.quoteVersion, walletAddress: state.walletAddress, chain: 'nile',
      asset: TRX, amountBaseUnits: state.amountSun, contractAddress: state.contractAddress,
      method: 'mint()', approvalScope: null, estimatedFeeBaseUnits: state.estimatedFeeSun,
      maxFeeBaseUnits: state.maxFeeSun, feeLimitSun: state.feeLimitSun,
      expiresAt: new Date(now() + PREVIEW_LIFETIME_MS).toISOString(), fingerprint,
      risks: ['금리·환율과 계약 유동성은 변할 수 있습니다.', 'Energy와 Bandwidth 사용량은 추정치이며 최대 수수료 범위에서 변동될 수 있습니다.'],
      source: state.source, state,
    };
  }

  async function readSolidifiedNileTransaction(txId: string): Promise<NileTransactionResult> {
    if (!TX_ID_RE.test(txId)) throw new Error('원 거래 ID 형식이 올바르지 않습니다.');
    const fetched = source(now);
    try {
      const body = await rpc('walletsolidity/gettransactionbyid', { value: txId });
      if (body.txID !== undefined && String(body.txID).toLowerCase() !== txId.toLowerCase()) {
        throw new Error('solidified 거래 ID가 요청과 다릅니다.');
      }
      const receipt = await rpc('walletsolidity/gettransactioninfobyid', { value: txId });
      if (!body.txID || !receipt.id) {
        return { txId, status: 'pending', receipt: null, actualFeeSun: null, reason: null, source: fetched };
      }
      if (String(receipt.id).toLowerCase() !== txId.toLowerCase()) throw new Error('solidified 영수증 ID가 요청과 다릅니다.');
      const result = object(receipt.receipt, '실행 영수증');
      const actualFeeSun = unsigned(receipt.fee ?? '0', '실제 수수료').toString();
      if (receipt.result === 'FAILED' || result.result !== 'SUCCESS') {
        return { txId, status: 'failed', receipt, actualFeeSun,
          reason: String(result.result ?? receipt.result ?? '실행 실패'), source: fetched };
      }
      return { txId, status: 'confirmed', receipt, actualFeeSun, reason: null, source: fetched };
    } catch {
      return { txId, status: 'unknown', receipt: null, actualFeeSun: null,
        reason: 'Nile solidified 거래 조회가 불확실합니다. 원 txID만 다시 조회해 주세요.', source: fetched };
    }
  }

  async function observeNileJtrxPosition(input: {
    planId: string; address: string; contractAddress?: string;
  }): Promise<Observation> {
    if (!input.planId) throw new Error('원 Nile 계획 ID가 필요합니다.');
    const walletAddress = address(input.address, '지갑 주소');
    const contractAddress = address(input.contractAddress ?? candidate, 'jTRX 주소');
    if (contractAddress !== candidate) throw new Error('검증된 Nile jTRX 후보 주소와 다릅니다.');
    const encodedWallet = TronWeb.address.toHex(walletAddress).slice(2).padStart(64, '0');
    const [balance, exchange] = await Promise.all([
      constant(contractAddress, 'balanceOf(address)', encodedWallet),
      // Constant execution calculates the current accrued rate without broadcasting a transaction.
      constant(contractAddress, 'exchangeRateCurrent()'),
    ]);
    const receiptBalance = BigInt(`0x${balance}`);
    const exchangeRate = positive(BigInt(`0x${exchange}`).toString(), '현재 환율');
    return {
      id: randomUUID(), planId: input.planId, positionId: `nile:${walletAddress}:${contractAddress}`,
      walletAddress, chain: 'nile', receiptToken: { symbol: 'jTRX', address: contractAddress, decimals: 8 },
      receiptBalanceBaseUnits: receiptBalance.toString(), exchangeRateRaw: exchangeRate.toString(),
      underlyingToken: TRX, underlyingValueBaseUnits: (receiptBalance * exchangeRate / 10n ** 18n).toString(),
      source: source(now),
    };
  }

  return { readNileWalletBalance, readNileRedeemCostBound, readNileDepositState, createNileDepositPreview,
    readNileWithdrawalState, probeNileWithdrawal, createNileWithdrawalPreview,
    readSolidifiedNileTransaction, observeNileJtrxPosition };
}

const gateway = createNileExecutionGateway();
export const readNileWalletBalance = gateway.readNileWalletBalance;
export const readNileRedeemCostBound = gateway.readNileRedeemCostBound;
export const readNileDepositState = gateway.readNileDepositState;
export const createNileDepositPreview = gateway.createNileDepositPreview;
export const readNileWithdrawalState = gateway.readNileWithdrawalState;
export const probeNileWithdrawal = gateway.probeNileWithdrawal;
export const createNileWithdrawalPreview = gateway.createNileWithdrawalPreview;
export const readSolidifiedNileTransaction = gateway.readSolidifiedNileTransaction;
export const observeNileJtrxPosition = gateway.observeNileJtrxPosition;
