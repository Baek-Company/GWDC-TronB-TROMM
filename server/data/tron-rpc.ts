import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { TronWeb } from 'tronweb';
import { AccountReadError, connectionReason, provenance, type Chain, type DataResult } from './provenance';

export const MAINNET_RPC = 'https://api.trongrid.io';
export const NILE_RPC = 'https://nile.trongrid.io';
export const NILE_JTRX_CANDIDATE = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
export const NILE_JTRX_SOURCE = 'https://github.com/justlend/mcp-server-justlend/blob/main/src/core/chains.ts';
const READ_OWNER = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';

export type ContractInfo = {
  address: string;
  hasCode: boolean;
  abiFunctions: string[];
  codeHash?: string | null;
};

export type NileJtrxProbe = {
  candidateAddress: string;
  contract: ContractInfo;
  comptrollerAddress: string | null;
  marketListed: boolean | null;
  exchangeRateMantissa: string | null;
  supplyRatePerBlockMantissa: string | null;
  cashSun: string | null;
  walletAddress: string | null;
  walletBalanceSun: string | null;
  feeEstimateSun: string | null;
  executionReady: false;
  missing: string[];
};

function rpcUrl(chain: Chain): string { return chain === 'nile' ? NILE_RPC : MAINNET_RPC; }

const readEndpoints = new Set([
    '/wallet/getcontract', '/wallet/getcontractinfo', '/wallet/triggerconstantcontract',
    '/wallet/getaccount', '/wallet/getchainparameters', '/wallet/getaccountresource',
    '/wallet/getnowblock', '/wallet/getblockbynum', '/wallet/triggersmartcontract', '/wallet/estimateenergy',
    '/wallet/gettransactionbyid', '/walletsolidity/gettransactionbyid',
    '/walletsolidity/getnowblock', '/walletsolidity/gettransactioninfobyid',
    '/wallet/listwitnesses', '/wallet/getReward', '/walletsolidity/getaccount',
]);
type QueuedRead = { run: () => Promise<unknown>; resolve: (value: unknown) => void; reject: (error: unknown) => void };
type RpcState = { active: number; lastStarted: number; cooldownUntil: number; timer: ReturnType<typeof setTimeout> | null; queue: QueuedRead[] };
const states: Record<Chain, RpcState> = {
  mainnet: { active: 0, lastStarted: 0, cooldownUntil: 0, timer: null, queue: [] },
  nile: { active: 0, lastStarted: 0, cooldownUntil: 0, timer: null, queue: [] },
};
const pendingRpc = new Map<string, Promise<unknown>>();
const cachedRpc = new Map<string, { until: number; value: unknown }>();
const MAX_RPC_CONCURRENT = 2;
const MAX_RPC_QUEUE = 80;
const RPC_START_GAP_MS = 250;
const RPC_429_COOLDOWN_MS = 30_000;
type MainnetRpcCounter = { limit: number; reads: number };
type MainnetRpcScope = { counter: MainnetRpcCounter; signal?: AbortSignal };
const mainnetRpcBudget = new AsyncLocalStorage<MainnetRpcScope>();

export class MainnetRpcBudgetError extends Error {
  constructor() { super('Mainnet RPC read budget exceeded'); this.name = 'MainnetRpcBudgetError'; }
}

function combinedSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const available = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  return available.length === 0 ? undefined : available.length === 1 ? available[0] : AbortSignal.any(available);
}

function abortedRead(): DOMException { return new DOMException('RPC read cancelled', 'AbortError'); }

/** One budget and deadline cover every postTronRpc call in an asynchronous assessment. */
export function withMainnetRpcBudget<T>(limit: number, run: () => Promise<T>,
  options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
  if (!Number.isSafeInteger(limit) || limit <= 0) throw new Error('Invalid Mainnet RPC read budget');
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
    throw new Error('Invalid Mainnet RPC read deadline');
  }
  const existing = mainnetRpcBudget.getStore();
  // Nested scopes share the counter and may only tighten its cap or deadline.
  const counter = existing?.counter ?? { limit, reads: 0 };
  counter.limit = Math.min(counter.limit, limit);
  const signal = combinedSignal(existing?.signal, options.signal,
    options.timeoutMs === undefined ? undefined : AbortSignal.timeout(options.timeoutMs));
  const scope: MainnetRpcScope = { counter, signal };
  return mainnetRpcBudget.run(scope, () => {
    if (!signal) return run();
    if (signal.aborted) return Promise.reject(abortedRead());
    let onAbort: (() => void) | undefined;
    const cancelled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(abortedRead());
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return Promise.race([Promise.resolve().then(run), cancelled]).finally(() => {
      if (onAbort) signal.removeEventListener('abort', onAbort);
    });
  });
}

function pump(chain: Chain): void {
  const state = states[chain];
  if (state.timer) { clearTimeout(state.timer); state.timer = null; }
  if (Date.now() < state.cooldownUntil) {
    while (state.queue.length) state.queue.shift()!.reject(new Error('HTTP 429'));
    return;
  }
  if (state.active >= MAX_RPC_CONCURRENT || !state.queue.length) return;
  const wait = Math.max(0, state.lastStarted + RPC_START_GAP_MS - Date.now());
  if (wait) { state.timer = setTimeout(() => pump(chain), wait); return; }
  const item = state.queue.shift()!;
  state.active++;
  state.lastStarted = Date.now();
  void item.run().then(item.resolve, item.reject).finally(() => { state.active--; pump(chain); });
  if (state.queue.length) state.timer = setTimeout(() => pump(chain), RPC_START_GAP_MS);
}

export async function postTronRpc(chain: Chain, endpoint: string, body: Record<string, unknown>,
  options: { signal?: AbortSignal } = {}): Promise<unknown> {
  if (!readEndpoints.has(endpoint)) throw new Error('RPC endpoint is not read-allowlisted');
  const scope = chain === 'mainnet' ? mainnetRpcBudget.getStore() : undefined;
  const signal = combinedSignal(options.signal, scope?.signal);
  if (signal?.aborted) throw abortedRead();
  if (chain === 'mainnet') {
    const counter = scope?.counter;
    if (counter) {
      if (counter.reads >= counter.limit) throw new MainnetRpcBudgetError();
      counter.reads++;
    }
  }
  const key = `${chain}:${endpoint}:${JSON.stringify(body)}`;
  const cached = cachedRpc.get(key);
  if (cached && cached.until > Date.now()) return cached.value;
  const pending = signal ? null : pendingRpc.get(key);
  if (pending) return pending;
  const state = states[chain];
  if (Date.now() < state.cooldownUntil) throw new Error('HTTP 429');
  if (state.queue.length >= MAX_RPC_QUEUE) throw new Error('RPC read queue full');
  let queued: QueuedRead | null = null;
  let abortQueued: (() => void) | null = null;
  const request = new Promise<unknown>((resolve, reject) => {
    queued = { resolve, reject, run: async () => {
      const result = await fetchTronRpc(chain, endpoint, body, signal);
      const ttl = endpoint === '/wallet/getcontract' || endpoint === '/wallet/getcontractinfo' ? 30_000
        : endpoint === '/wallet/getchainparameters' ? 10_000 : 0;
      if (ttl) {
        if (cachedRpc.size >= 128) cachedRpc.delete(cachedRpc.keys().next().value!);
        cachedRpc.set(key, { until: Date.now() + ttl, value: result });
      }
      return result;
    } };
    state.queue.push(queued);
    if (signal) {
      abortQueued = () => {
        const index = state.queue.indexOf(queued!);
        if (index !== -1) {
          state.queue.splice(index, 1);
          reject(abortedRead());
        }
      };
      signal.addEventListener('abort', abortQueued, { once: true });
    }
  });
  if (!signal) pendingRpc.set(key, request);
  pump(chain);
  try { return await request; }
  finally {
    if (pendingRpc.get(key) === request) pendingRpc.delete(key);
    if (signal && abortQueued) signal.removeEventListener('abort', abortQueued);
  }
}

async function fetchTronRpc(chain: Chain, endpoint: string, body: Record<string, unknown>, signal?: AbortSignal): Promise<unknown> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const response = await fetch(`${rpcUrl(chain)}${endpoint}`, {
    method: 'POST', headers, body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12_000)]) : AbortSignal.timeout(12_000),
  });
  if (response.status === 429) states[chain].cooldownUntil = Date.now() + RPC_429_COOLDOWN_MS;
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const json: unknown = await response.json();
  if (!json || typeof json !== 'object' || Array.isArray(json)) throw new Error('Invalid RPC object');
  if ('Error' in json || 'error' in json) throw new Error('RPC error');
  return json;
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid RPC object');
  return value as Record<string, unknown>;
}

function uint(value: unknown): string {
  if (typeof value === 'string' && /^\d+$/.test(value)) return BigInt(value).toString();
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return BigInt(value).toString();
  throw new Error('Invalid on-chain integer');
}

export type BlockObservation = { blockNumber: string; blockTime: string; fetchedAt: string };

export async function readNowBlock(chain: Chain, signal?: AbortSignal): Promise<BlockObservation> {
  const data = record(await postTronRpc(chain, '/wallet/getnowblock', {}, { signal }));
  const header = record(data.block_header);
  const raw = record(header.raw_data);
  const number = uint(raw.number);
  const timestamp = Number(uint(raw.timestamp));
  if (!Number.isSafeInteger(timestamp)) throw new Error('Invalid block timestamp');
  return { blockNumber: number, blockTime: new Date(timestamp).toISOString(), fetchedAt: new Date().toISOString() };
}

export async function readContract(chain: Chain, address: string, signal?: AbortSignal): Promise<ContractInfo> {
  if (!TronWeb.isAddress(address)) throw new Error('Invalid TRON address');
  const data = record(await postTronRpc(chain, '/wallet/getcontract', { value: address, visible: true }, { signal }));
  const abi = record(data.abi ?? {});
  const functions = Array.isArray(abi.entrys)
    ? abi.entrys.flatMap((entry: unknown) => {
        const item = record(entry);
        return typeof item.name === 'string' && item.type === 'Function' ? [item.name] : [];
      })
    : [];
  let code = typeof data.bytecode === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(data.bytecode) ? data.bytecode : null;
  if (code === null && data.contract_address !== undefined) {
    // Some deployed TRON contracts expose ABI and code_hash but omit deployment
    // bytecode. GetContractInfo supplies their runtime bytecode.
    const info = record(await postTronRpc(chain, '/wallet/getcontractinfo', { value: address, visible: true }, { signal }));
    const contract = record(info.smart_contract ?? {});
    const reported = contract.contract_address;
    const runtime = info.runtimecode;
    if (typeof reported === 'string' && TronWeb.isAddress(reported)
      && TronWeb.address.toHex(reported).toLowerCase() === TronWeb.address.toHex(address).toLowerCase()
      && typeof runtime === 'string' && /^(?:[0-9a-fA-F]{2})+$/.test(runtime)) {
      code = runtime;
    }
  }
  return { address, hasCode: code !== null, abiFunctions: functions,
    codeHash: code ? createHash('sha256').update(Buffer.from(code, 'hex')).digest('hex') : null };
}

export async function callConstant(chain: Chain, contractAddress: string, selector: string, parameter?: string,
  signal?: AbortSignal): Promise<string> {
  if (!TronWeb.isAddress(contractAddress) || !/^[A-Za-z_][A-Za-z_0-9]*\([A-Za-z0-9_,]*\)$/.test(selector)) throw new Error('Invalid contract call');
  if (parameter && !/^[0-9a-fA-F]*$/.test(parameter)) throw new Error('Invalid ABI parameter');
  const result = record(await postTronRpc(chain, '/wallet/triggerconstantcontract', {
    owner_address: READ_OWNER, contract_address: contractAddress, function_selector: selector,
    ...(parameter ? { parameter } : {}), visible: true,
  }, { signal }));
  const status = record(result.result ?? {});
  if (Array.isArray(result.transaction)) throw new Error('Invalid TVM transaction');
  if (result.transaction && typeof result.transaction === 'object') {
    const transaction = record(result.transaction);
    if (Array.isArray(transaction.ret) && transaction.ret.some(item => {
      const ret = record(item).ret;
      return ret !== undefined && ret !== 'SUCCESS';
    })) {
      throw new Error('Constant call TVM failed');
    }
  }
  if (status.result !== true || !Array.isArray(result.constant_result) || typeof result.constant_result[0] !== 'string'
    || !/^[0-9a-fA-F]+$/.test(result.constant_result[0])) throw new Error('Constant call failed');
  return result.constant_result[0];
}

export function decodeUint(word: string): string {
  if (!/^[0-9a-fA-F]{64,}$/.test(word)) throw new Error('Invalid ABI uint');
  return BigInt(`0x${word.slice(0, 64)}`).toString();
}

export function decodeAddress(word: string): string {
  if (!/^[0-9a-fA-F]{64,}$/.test(word)) throw new Error('Invalid ABI address');
  return TronWeb.address.fromHex(`41${word.slice(24, 64)}`);
}

export function encodeAddress(address: string): string {
  if (!TronWeb.isAddress(address)) throw new Error('Invalid TRON address');
  return TronWeb.address.toHex(address).slice(2).padStart(64, '0');
}

export async function readTrxBalance(chain: Chain, address: string): Promise<string> {
  if (!TronWeb.isAddress(address)) throw new Error('Invalid TRON address');
  const data = record(await postTronRpc(chain, '/wallet/getaccount', { address, visible: true }));
  if (data.address === undefined) throw new AccountReadError('state_missing');
  if (typeof data.address !== 'string' || !TronWeb.isAddress(data.address)
    || TronWeb.address.toHex(data.address).toLowerCase() !== TronWeb.address.toHex(address).toLowerCase()) {
    throw new AccountReadError('address_mismatch');
  }
  try { return uint(data.balance ?? 0); }
  catch { throw new AccountReadError('balance_invalid'); }
}

export async function readNileJtrxProbe(walletAddress?: string): Promise<DataResult<NileJtrxProbe>> {
  const source = provenance(NILE_RPC, 'nile', 'rpc');
  try {
    const contract = await readContract('nile', NILE_JTRX_CANDIDATE);
    if (!contract.hasCode) return { status: 'unavailable', reason: 'Nile jTRX 후보 주소에 계약 코드가 확인되지 않았습니다.', source };
    const missing: string[] = [];
    const read = async (selector: string) => {
      try { return decodeUint(await callConstant('nile', NILE_JTRX_CANDIDATE, selector)); }
      catch { missing.push(`${selector} 읽기 실패`); return null; }
    };
    let comptrollerAddress: string | null = null;
    let marketListed: boolean | null = null;
    try {
      comptrollerAddress = decodeAddress(await callConstant('nile', NILE_JTRX_CANDIDATE, 'comptroller()'));
      const comptroller = await readContract('nile', comptrollerAddress);
      if (!comptroller.hasCode) missing.push('Comptroller 계약 코드 미확인');
      else marketListed = decodeUint(await callConstant('nile', comptrollerAddress, 'markets(address)', encodeAddress(NILE_JTRX_CANDIDATE))) === '1';
    } catch { missing.push('Comptroller 시장 활성 조회 실패'); }
    if (marketListed === false) missing.push('jTRX 시장 비활성');
    const [exchangeRateMantissa, supplyRatePerBlockMantissa, cashSun] = await Promise.all([
      read('exchangeRateStored()'), read('supplyRatePerBlock()'), read('getCash()'),
    ]);
    let walletBalanceSun: string | null = null;
    if (walletAddress) {
      try { walletBalanceSun = await readTrxBalance('nile', walletAddress); }
      catch { missing.push('Nile 지갑 잔고 조회 실패'); }
    } else missing.push('Nile 지갑 주소 미설정');
    missing.push('서명 대상 금액의 Energy/Bandwidth 비용 미산정');
    return { status: 'ready', value: {
      candidateAddress: NILE_JTRX_CANDIDATE, contract, comptrollerAddress, marketListed,
      exchangeRateMantissa, supplyRatePerBlockMantissa, cashSun,
      walletAddress: walletAddress ?? null, walletBalanceSun, feeEstimateSun: null,
      executionReady: false, missing,
    }, source };
  } catch (error) {
    return { status: 'unavailable', reason: connectionReason(error, 'Nile jTRX RPC'), source };
  }
}
