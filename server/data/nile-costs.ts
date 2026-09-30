import { createHash } from 'node:crypto';
import { TronWeb } from 'tronweb';
import { normalizeTronAddress } from '../../shared/tron-address';
import { quoteNileRedeemScenario, unknownNileRedeemReference,
  type NileRedeemReference } from '../../shared/nile-cost-model';
import type { Source } from '../../shared/schemas';
import { NILE_JTRX_CANDIDATE, NILE_RPC, postTronRpc } from './tron-rpc';

const UINT256_MAX = 2n ** 256n - 1n;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const REFERENCE_LIFETIME_MS = 60_000;
const MAX_CANDIDATES = 5;
const DEFAULT_RPC_BUDGET = 18;
const DEFAULT_DEADLINE_MS = 8_000;
const holderCache = new Map<string, { until: number; pending: Promise<string[]> }>();

export type NileCostRpc = (endpoint: string, body: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>;
export type NileRedeemReferenceInput = {
  jtrxAmountRaw: string;
  contractAddress?: string;
  excludeWalletAddress?: string;
  /** Optional public read-only account, not a signing key. Automatic discovery is attempted first. */
  representativeAddress?: string;
};
export type NileCostDependencies = {
  rpc?: NileCostRpc; fetchHolders?: typeof fetch; now?: () => Date;
  signal?: AbortSignal; maxRpcReads?: number; timeoutMs?: number;
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_rpc_object');
  return value as Record<string, unknown>;
}

function uint(value: unknown): bigint {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value);
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  throw new Error('invalid_rpc_integer');
}

function uintWord(value: unknown): bigint {
  const response = object(value);
  if (object(response.result).result !== true || tvmFailed(response)) throw new Error('constant_failed');
  const word = Array.isArray(response.constant_result) ? response.constant_result[0] : null;
  if (typeof word !== 'string' || !HEX.test(word) || word.length < 64) throw new Error('invalid_abi_word');
  return BigInt(`0x${word.slice(0, 64)}`);
}

function tvmFailed(response: Record<string, unknown>): boolean {
  if (!response.transaction) return false;
  const ret = object(response.transaction).ret;
  return Array.isArray(ret) && ret.some(item => {
    const status = object(item).ret;
    return status !== undefined && status !== 'SUCCESS';
  });
}

function parameter(response: unknown, key: string): bigint {
  const list = object(response).chainParameter;
  if (!Array.isArray(list)) throw new Error('missing_chain_parameters');
  const found = list.find(item => object(item).key === key);
  const value = uint(found ? object(found).value : null);
  if (value === 0n) throw new Error('zero_chain_parameter');
  return value;
}

function source(at: Date): Source {
  return { sourceUrl: `${NILE_RPC}/wallet/triggerconstantcontract`, chain: 'nile',
    fetchedAt: at.toISOString(), sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };
}

function abiMethod(contract: Record<string, unknown>, name: string, inputs: string[]): boolean {
  const entries = object(contract.abi).entrys;
  if (!Array.isArray(entries)) return false;
  return entries.some(raw => {
    const entry = object(raw);
    const declaredInputs = entry.inputs ?? [];
    return entry.type === 'Function' && entry.name === name
      && Array.isArray(declaredInputs) && declaredInputs.length === inputs.length
      && declaredInputs.every((input, index) => object(input).type === inputs[index]);
  });
}

function readContractIdentity(response: unknown, address: string): string {
  const info = object(response);
  const smart = object(info.smart_contract);
  const actualAddress = normalizeTronAddress(String(smart.contract_address));
  const runtime = info.runtimecode;
  if (actualAddress !== address || typeof runtime !== 'string' || !HEX.test(runtime)
    || runtime.length < 4 || !abiMethod(smart, 'redeem', ['uint256'])
    || !abiMethod(smart, 'balanceOf', ['address'])
    || !abiMethod(smart, 'getCash', [])
    || !abiMethod(smart, 'exchangeRateCurrent', [])
    || !abiMethod(smart, 'comptroller', [])) throw new Error('unverified_jtrx_contract');
  // Match the identity convention of the existing Nile execution gateway.
  return createHash('sha256').update(runtime).digest('hex');
}

async function holderAddresses(contractAddress: string, fetchHolders: typeof fetch,
  now: () => Date): Promise<string[]> {
  const url = new URL(`/v1/contracts/${contractAddress}/tokens`, NILE_RPC);
  url.searchParams.set('limit', String(MAX_CANDIDATES));
  url.searchParams.set('order_by', 'balance,desc');
  const headers: Record<string, string> = { accept: 'application/json' };
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const response = await fetchHolders(url, { headers, signal: AbortSignal.timeout(5_000) });
  if (!response.ok) throw new Error('holder_index_http');
  const payload = object(await response.json());
  if (payload.success !== true || !Array.isArray(payload.data) || payload.data.length > MAX_CANDIDATES) {
    throw new Error('holder_index_shape');
  }
  const at = uint(object(payload.meta).at);
  const age = BigInt(now().getTime()) - at;
  if (age < -10_000n || age > 60_000n) throw new Error('holder_index_stale');
  const result: string[] = [];
  for (const row of payload.data) {
    const fields = Object.entries(object(row));
    if (fields.length !== 1) throw new Error('holder_index_shape');
    const [rawAddress, rawBalance] = fields[0];
    const address = normalizeTronAddress(rawAddress);
    if (!address || typeof rawBalance !== 'string' || !/^\d+(?:\.\d+)?$/.test(rawBalance)) {
      throw new Error('holder_index_shape');
    }
    if (!result.includes(address)) result.push(address);
  }
  return result;
}

/** Shares only the bounded index lookup; every balance and simulation is re-read from Nile RPC. */
export function listNileRepresentativeCandidates(contractAddress: string,
  options: { fetchHolders?: typeof fetch; now?: () => Date } = {}): Promise<string[]> {
  const address = normalizeTronAddress(contractAddress);
  if (!address || address !== NILE_JTRX_CANDIDATE) return Promise.reject(new Error('invalid_nile_market'));
  const now = options.now ?? (() => new Date());
  // Test/custom providers must not inherit a different provider's cached index.
  if (options.fetchHolders) return holderAddresses(address, options.fetchHolders, now);
  const existing = holderCache.get(address);
  if (existing && existing.until > now().getTime()) return existing.pending;
  const pending = holderAddresses(address, options.fetchHolders ?? fetch, now).catch(error => {
    if (holderCache.get(address)?.pending === pending) holderCache.delete(address);
    throw error;
  });
  holderCache.set(address, { until: now().getTime() + 15_000, pending });
  return pending;
}

/**
 * Read-only, amount-specific reference from a different Nile jTRX holder.
 * No result from this function authorizes a trade or describes the user's wallet.
 */
export async function readNileRedeemReference(input: NileRedeemReferenceInput,
  dependencies: NileCostDependencies = {}): Promise<NileRedeemReference> {
  const now = dependencies.now ?? (() => new Date());
  const contractAddress = normalizeTronAddress(input.contractAddress ?? NILE_JTRX_CANDIDATE);
  const rawAmount = /^\d+$/.test(input.jtrxAmountRaw) ? BigInt(input.jtrxAmountRaw) : null;
  const unknown = (reason: string): NileRedeemReference => unknownNileRedeemReference({
    contractAddress, jtrxAmountRaw: rawAmount?.toString() ?? null, source: source(now()), reason,
  });
  if (contractAddress !== NILE_JTRX_CANDIDATE || !rawAmount || rawAmount <= 0n || rawAmount > UINT256_MAX) {
    return unknown('Nile jTRX 계약 주소 또는 환매 수량이 유효하지 않습니다.');
  }
  const excluded = input.excludeWalletAddress ? normalizeTronAddress(input.excludeWalletAddress) : null;
  if (input.excludeWalletAddress && !excluded) return unknown('제외할 지갑 주소가 유효하지 않습니다.');
  const explicit = input.representativeAddress ? normalizeTronAddress(input.representativeAddress) : null;
  if (input.representativeAddress && !explicit) return unknown('기준 계정 주소가 유효하지 않습니다.');
  const limit = dependencies.maxRpcReads ?? DEFAULT_RPC_BUDGET;
  const timeout = dependencies.timeoutMs ?? DEFAULT_DEADLINE_MS;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 30
    || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 30_000) {
    return unknown('Nile 읽기 예산 또는 제한 시간이 유효하지 않습니다.');
  }
  const signal = dependencies.signal
    ? AbortSignal.any([dependencies.signal, AbortSignal.timeout(timeout)])
    : AbortSignal.timeout(timeout);
  const actualRpc = dependencies.rpc ?? ((endpoint: string, body: Record<string, unknown>, requestSignal: AbortSignal) =>
    postTronRpc('nile', endpoint, body, { signal: requestSignal }));
  let reads = 0;
  const rpc = (endpoint: string, body: Record<string, unknown>) => {
    if (signal.aborted) throw new Error('read_deadline');
    if (++reads > limit) throw new Error('read_budget');
    return actualRpc(endpoint, body, signal);
  };
  const constant = (owner: string, contract: string, selector: string, parameterHex?: string) =>
    rpc('/wallet/triggerconstantcontract', { owner_address: owner, contract_address: contract,
      function_selector: selector, ...(parameterHex ? { parameter: parameterHex } : {}), visible: true });
  const run = async (): Promise<NileRedeemReference> => {
    const candidates = explicit ? [explicit] : await listNileRepresentativeCandidates(contractAddress, {
      fetchHolders: dependencies.fetchHolders, now,
    });
    const possible = candidates.filter(candidate => candidate !== excluded && candidate !== contractAddress);
    if (possible.length === 0) return unknown('충분한 jTRX를 가진 별도 기준 계정을 찾지 못했습니다.');
    const [contract, params, exchange, cash, controller] = await Promise.all([
      rpc('/wallet/getcontractinfo', { value: contractAddress, visible: true }),
      rpc('/wallet/getchainparameters', {}),
      constant(contractAddress, contractAddress, 'exchangeRateCurrent()'),
      constant(contractAddress, contractAddress, 'getCash()'),
      constant(contractAddress, contractAddress, 'comptroller()'),
    ]);
    const codeHash = readContractIdentity(contract, contractAddress);
    const rate = uintWord(exchange);
    const marketCash = uintWord(cash);
    if (rate <= 0n) return unknown('Nile jTRX 현재 환율을 확인하지 못했습니다.');
    const expectedUnderlying = rawAmount * rate / 10n ** 18n;
    if (expectedUnderlying <= 0n || marketCash < expectedUnderlying) {
      return unknown('환매 수량의 예상 수령액 또는 현재 시장 유동성이 부족합니다.');
    }
    const energyPrice = parameter(params, 'getEnergyFee');
    const bandwidthPrice = parameter(params, 'getTransactionFee');
    const maxFeeLimit = parameter(params, 'getMaxFeeLimit');
    const controllerWord = uintWord(controller);
    const controllerAddress = normalizeTronAddress(`41${controllerWord.toString(16).padStart(40, '0')}`);
    if (!controllerAddress) return unknown('Nile Comptroller 주소를 검증하지 못했습니다.');
    const marketParam = TronWeb.address.toHex(contractAddress).slice(2).padStart(64, '0');
    const [controllerInfo, listing] = await Promise.all([
      rpc('/wallet/getcontractinfo', { value: controllerAddress, visible: true }),
      constant(controllerAddress, controllerAddress, 'markets(address)', marketParam),
    ]);
    const smartController = object(object(controllerInfo).smart_contract);
    if (normalizeTronAddress(String(smartController.contract_address)) !== controllerAddress
      || typeof object(controllerInfo).runtimecode !== 'string'
      || !HEX.test(String(object(controllerInfo).runtimecode)) || uintWord(listing) !== 1n) {
      return unknown('Nile jTRX 시장 활성 상태를 검증하지 못했습니다.');
    }
    const amountHex = rawAmount.toString(16).padStart(64, '0');
    for (const representative of possible) {
      const holderParam = TronWeb.address.toHex(representative).slice(2).padStart(64, '0');
      const balance = uintWord(await constant(contractAddress, contractAddress, 'balanceOf(address)', holderParam));
      if (balance < rawAmount) continue;
      const request = { owner_address: representative, contract_address: contractAddress,
        function_selector: 'redeem(uint256)', parameter: amountHex, visible: true };
      const simulated = object(await rpc('/wallet/triggerconstantcontract', request));
      let redeemCode: bigint;
      try { redeemCode = uintWord(simulated); }
      catch { continue; } // This holder may be collateralized; try a different holder.
      if (redeemCode !== 0n) continue;
      const simulatedEnergy = uint(simulated.energy_used);
      if (simulatedEnergy === 0n) continue;
      let energy = simulatedEnergy;
      try {
        const estimate = object(await rpc('/wallet/estimateenergy', request));
        if (object(estimate.result).result !== true) return unknown('Nile 환매 Energy 추정이 실패했습니다.');
        const required = uint(estimate.energy_required);
        if (required <= 0n) return unknown('Nile 환매 Energy 추정값이 유효하지 않습니다.');
        if (required > energy) energy = required;
      } catch (error) {
        // Only an explicit node capability error permits the successful constant
        // simulation to supply Energy. Timeouts and 429s remain unknown.
        if (!(error instanceof Error && /this node does not support estimate energy/i.test(error.message))) {
          return unknown('Nile 환매 Energy 추가 추정을 완료하지 못했습니다.');
        }
      }
      const feeLimit = energy * energyPrice * 2n;
      if (feeLimit > maxFeeLimit || maxFeeLimit > BigInt(Number.MAX_SAFE_INTEGER)) {
        return unknown('Energy 예산이 Nile 체인 허용 범위를 초과합니다.');
      }
      const draft = object(await rpc('/wallet/triggersmartcontract', {
        ...request, fee_limit: Number(maxFeeLimit),
      }));
      if (object(draft.result).result !== true) return unknown('Nile 환매 미서명 거래 크기를 확인하지 못했습니다.');
      const raw = object(draft.transaction).raw_data_hex;
      if (typeof raw !== 'string' || !HEX.test(raw)) return unknown('Nile 환매 미서명 거래가 유효하지 않습니다.');
      // A 65-byte signature plus conservative protobuf framing allowance.
      const signedBytes = BigInt(raw.length / 2 + 134);
      const finishedAt = now();
      return quoteNileRedeemScenario({ basis: 'representative_simulation', contractAddress,
        contractCodeHash: codeHash, jtrxAmountRaw: rawAmount.toString(),
        representativeAddress: representative, representativeBalanceRaw: balance.toString(),
        expectedUnderlyingSun: expectedUnderlying.toString(), energyUnits: energy.toString(),
        bandwidthBytes: signedBytes.toString(), energyPriceSun: energyPrice.toString(),
        bandwidthPriceSun: bandwidthPrice.toString(), referenceTxIds: [], source: source(finishedAt),
        validUntil: new Date(finishedAt.getTime() + REFERENCE_LIFETIME_MS).toISOString(),
        assumptions: ['Nile의 별도 jTRX 보유 계정에서 현재 환매 수량을 읽기 전용 모의 실행',
          '미래 무료 Energy·Bandwidth 0, 미서명 거래 크기 + 134바이트',
          '스트레스 비용은 현재 자원 단가 2배 가정이며 미래 최대 수수료가 아님',
          '사용자 지갑의 담보·차입·자원 상태 및 미래 시장 변경을 반영하지 않음'],
      });
    }
    return unknown('후보 계정의 jTRX 잔고가 부족하거나 해당 수량의 환매 모의 실행이 실패했습니다.');
  };
  try {
    if (signal.aborted) return unknown('Nile 비용 근거 조회 시간이 만료되었습니다.');
    let removeAbort: (() => void) | null = null;
    const cancelled = new Promise<never>((_resolve, reject) => {
      const onAbort = () => reject(new Error('read_deadline'));
      removeAbort = () => signal.removeEventListener('abort', onAbort);
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([run(), cancelled]).finally(() => removeAbort?.());
  } catch (error) {
    if (signal.aborted) return unknown('Nile 비용 근거 조회 시간이 만료되었습니다.');
    if (error instanceof Error && error.message === 'read_budget') return unknown('Nile 비용 근거 RPC 읽기 예산을 초과했습니다.');
    return unknown('Nile 기준 계정·시장·환매 모의 실행을 검증할 수 없습니다.');
  }
}
