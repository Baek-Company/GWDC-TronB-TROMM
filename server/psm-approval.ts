import { createHash, randomUUID } from 'node:crypto';
import { TronWeb, utils } from 'tronweb';
import { z } from 'zod';
import { actionPreviewSchema, type ActionPreview, type Source } from '../shared/schemas';
import { postTronRpc } from './data/tron-rpc';
import { NILE_PSM_CONTRACTS, quoteNilePsmBuy, quoteNilePsmSell, readNilePsmState,
  type NilePsmBalances, type NilePsmDirection, type NilePsmState } from './nile-psm';
import { NILE_CHAIN_ID, readSolidifiedNileTransaction, type NileTransactionResult } from './transactions';
import { createTriggerId, type ActionIntent, type createActionLedger } from './agent/ledger';

export type NilePsmStep = 'approve_usdd' | 'buy_gem' | 'approve_usdt' | 'sell_gem';
export type NilePsmMethod = 'approve(address,uint256)' | 'buyGem(address,uint256)' | 'sellGem(address,uint256)';
export type NilePsmPreview = ActionPreview & {
  chain: 'nile'; step: NilePsmStep; direction: 'buy' | 'sell';
  method: NilePsmMethod; argumentAddress: string; gemAmountRaw: string;
  feeLimitSun: string; estimatedFeeSun: string; maxFeeSun: string;
  state: NilePsmState;
};

export type NilePsmReconciliation = {
  intent: ActionIntent; observation: NileTransactionResult; balances: NilePsmBalances | null;
};

const nilePsmPreviewSchema = actionPreviewSchema.extend({
  chain: z.literal('nile'),
  step: z.enum(['approve_usdd', 'buy_gem', 'approve_usdt', 'sell_gem']),
  direction: z.enum(['buy', 'sell']),
  method: z.enum(['approve(address,uint256)', 'buyGem(address,uint256)', 'sellGem(address,uint256)']),
  argumentAddress: z.string().min(1), gemAmountRaw: z.string().regex(/^\d+$/),
  feeLimitSun: z.string().regex(/^\d+$/), estimatedFeeSun: z.string().regex(/^\d+$/),
  maxFeeSun: z.string().regex(/^\d+$/), state: z.record(z.string(), z.unknown()),
}).passthrough();

export function parseNilePsmPreview(value: unknown): NilePsmPreview {
  const preview = nilePsmPreviewSchema.parse(value) as unknown as NilePsmPreview;
  assertCurrentPreview(preview, Date.now());
  return preview;
}

type Ledger = ReturnType<typeof createActionLedger>;
type Rpc = (endpoint: string, body: Record<string, unknown>) => Promise<unknown>;
type PsmBefore = {
  step: NilePsmStep; gemAmountRaw: string; usddAmountRaw: string;
  usddBalanceRaw: string; usdtBalanceRaw: string;
  usddAllowanceRaw: string; usdtAllowanceRaw: string;
};
const UINT = /^\d+$/;
const HEX = /^(?:[0-9a-fA-F]{2})+$/;
const TX_ID = /^[0-9a-fA-F]{64}$/;
const PREVIEW_LIFETIME_MS = 180_000;
const SIGNED_CONTRACT_OVERHEAD_BYTES = 134n;

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${label}: 예상하지 못한 응답입니다.`);
  return value as Record<string, unknown>;
}

function uint(value: unknown, label: string, positive = false): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label}: 안전한 정수가 아닙니다.`);
    value = String(value);
  }
  if (typeof value !== 'string' || !UINT.test(value)) throw new Error(`${label}: 정수 문자열이 필요합니다.`);
  const parsed = BigInt(value);
  if (positive && parsed === 0n) throw new Error(`${label}: 0보다 커야 합니다.`);
  return parsed;
}

function sameAddress(left: string, right: string): boolean {
  return TronWeb.isAddress(left) && TronWeb.isAddress(right) &&
    TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

function canonicalAddress(value: string, label: string): string {
  if (!TronWeb.isAddress(value)) throw new Error(`${label}: 유효한 TRON 주소가 아닙니다.`);
  return TronWeb.address.fromHex(TronWeb.address.toHex(value));
}

function encodeAddress(value: string): string {
  return TronWeb.address.toHex(value).slice(2).padStart(64, '0').toLowerCase();
}

function callData(method: NilePsmMethod, argumentAddress: string, amountBaseUnits: string): string {
  const selector = TronWeb.sha3(method).replace(/^0x/, '').slice(0, 8).toLowerCase();
  return selector + encodeAddress(argumentAddress) + uint(amountBaseUnits, '호출 수량', true).toString(16).padStart(64, '0');
}

function chainParameter(response: unknown, key: string): bigint {
  const parameters = object(response, '체인 매개변수').chainParameter;
  if (!Array.isArray(parameters)) throw new Error('Nile 체인 매개변수를 확인할 수 없습니다.');
  const item = parameters.find(value => value && typeof value === 'object' &&
    (value as Record<string, unknown>).key === key);
  if (!item) throw new Error(`${key} 체인 매개변수를 확인할 수 없습니다.`);
  return uint(object(item, key).value, key, true);
}

function safeNumber(value: bigint, label: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label}: TronWeb 안전 정수 범위를 초과합니다.`);
  return Number(value);
}

function stepSpec(step: NilePsmStep, state: NilePsmState) {
  const gem = state.quote.gemAmountRaw;
  const usdd = state.quote.usddAmountRaw;
  const wallet = canonicalAddress(state.walletAddress, '지갑');
  switch (step) {
    case 'approve_usdd':
      return { direction: 'buy' as const, method: 'approve(address,uint256)' as const,
        contractAddress: state.usddAddress, argumentAddress: state.psmAddress,
        amountBaseUnits: usdd, asset: { symbol: 'USDD', address: state.usddAddress, decimals: 18 } };
    case 'buy_gem':
      return { direction: 'buy' as const, method: 'buyGem(address,uint256)' as const,
        contractAddress: state.psmAddress, argumentAddress: wallet,
        amountBaseUnits: gem, asset: { symbol: 'USDT', address: state.usdtAddress, decimals: 6 } };
    case 'approve_usdt':
      return { direction: 'sell' as const, method: 'approve(address,uint256)' as const,
        contractAddress: state.usdtAddress, argumentAddress: state.gemJoinAddress,
        amountBaseUnits: gem, asset: { symbol: 'USDT', address: state.usdtAddress, decimals: 6 } };
    case 'sell_gem':
      return { direction: 'sell' as const, method: 'sellGem(address,uint256)' as const,
        contractAddress: state.psmAddress, argumentAddress: wallet,
        amountBaseUnits: gem, asset: { symbol: 'USDT', address: state.usdtAddress, decimals: 6 } };
  }
}

function assertPsmState(step: NilePsmStep, state: NilePsmState): void {
  const C = NILE_PSM_CONTRACTS;
  if (state.chain !== 'nile' || !sameAddress(state.psmAddress, C.psm) ||
      !sameAddress(state.gemJoinAddress, C.gemJoin) ||
      !sameAddress(state.usdtAddress, C.usdt) || !sameAddress(state.usddAddress, C.usdd) ||
      state.usdtTransferFeeBasisPointsRaw !== '0' || state.usdtPaused || state.usdtDeprecated ||
      !TronWeb.isAddress(state.walletAddress) || state.blockedReasons.length > 0 ||
      Object.values(state.contractCodeHashes).some(hash => !/^[0-9a-fA-F]{64}$/.test(hash))) {
    throw new Error('Nile PSM의 실제 계약 연결·실행 조건을 확인할 수 없습니다.');
  }
  const direction = step === 'approve_usdd' || step === 'buy_gem' ? 'buy_gem' : 'sell_gem';
  if (state.quote.direction !== direction) throw new Error('Nile PSM 미리보기 방향이 다릅니다.');
  const quoted = direction === 'buy_gem'
    ? quoteNilePsmBuy(state.quote.gemAmountRaw, state.toutRaw)
    : quoteNilePsmSell(state.quote.gemAmountRaw, state.tinRaw);
  if (quoted.usddAmountRaw !== state.quote.usddAmountRaw || quoted.feeUsddRaw !== state.quote.feeUsddRaw) {
    throw new Error('PSM 계약 수수료와 계산 수량이 일치하지 않습니다.');
  }
  const required = direction === 'buy_gem' ? BigInt(quoted.usddAmountRaw) : BigInt(quoted.gemAmountRaw);
  const balance = direction === 'buy_gem' ? BigInt(state.usddBalanceRaw) : BigInt(state.usdtBalanceRaw);
  const allowance = direction === 'buy_gem'
    ? BigInt(state.usddAllowanceToPsmRaw) : BigInt(state.usdtAllowanceToGemJoinRaw);
  const capacity = direction === 'buy_gem' ? BigInt(state.exitCapacityUsdtRaw) : BigInt(state.entryCapacityUsdtRaw);
  if (balance < required || capacity < BigInt(quoted.gemAmountRaw) ||
      direction === 'buy_gem' && !state.buyEnabled || direction === 'sell_gem' && !state.sellEnabled) {
    throw new Error('PSM 지갑 잔고·스위치·용량이 시험 거래에 부족합니다.');
  }
  if (step.startsWith('approve_') ? allowance >= required : allowance < required) {
    throw new Error(step.startsWith('approve_')
      ? '이미 충분한 승인 수량이 있습니다. 중복 승인을 생략해 주세요.'
      : '해당 토큰의 확정된 승인 수량이 부족합니다. 승인 거래부터 완료해 주세요.');
  }
}

function safeStateFingerprint(state: NilePsmState): string {
  const { fetchedAt: _fetchedAt, sourceUrl: _sourceUrl, source: _source, ...stable } = state;
  return createHash('sha256').update(JSON.stringify(stable)).digest('hex');
}

function previewFingerprint(value: Pick<NilePsmPreview,
  'step' | 'walletAddress' | 'contractAddress' | 'method' | 'argumentAddress' | 'amountBaseUnits' |
  'gemAmountRaw' | 'feeLimitSun' | 'estimatedFeeSun' | 'maxFeeSun' | 'state'>): string {
  return createHash('sha256').update(JSON.stringify([
    value.step, value.walletAddress, value.contractAddress, value.method, value.argumentAddress,
    value.amountBaseUnits, value.gemAmountRaw, value.feeLimitSun, value.estimatedFeeSun,
    value.maxFeeSun, safeStateFingerprint(value.state),
  ])).digest('hex');
}

function beforeState(preview: NilePsmPreview): PsmBefore {
  return {
    step: preview.step, gemAmountRaw: preview.gemAmountRaw,
    usddAmountRaw: preview.state.quote.usddAmountRaw,
    usddBalanceRaw: preview.state.usddBalanceRaw,
    usdtBalanceRaw: preview.state.usdtBalanceRaw,
    usddAllowanceRaw: preview.state.usddAllowanceToPsmRaw,
    usdtAllowanceRaw: preview.state.usdtAllowanceToGemJoinRaw,
  };
}

function recordedBefore(intent: ActionIntent): PsmBefore {
  let value: Record<string, unknown>;
  try { value = object(JSON.parse(intent.positionVersion) as unknown, 'PSM 이전 상태'); }
  catch { throw new Error('PSM 거래 전 잔고 증거를 복원할 수 없습니다.'); }
  if (!['approve_usdd', 'buy_gem', 'approve_usdt', 'sell_gem'].includes(String(value.step))) {
    throw new Error('PSM 거래 전 단계 증거가 올바르지 않습니다.');
  }
  for (const key of ['gemAmountRaw', 'usddAmountRaw', 'usddBalanceRaw', 'usdtBalanceRaw',
    'usddAllowanceRaw', 'usdtAllowanceRaw'] as const) uint(value[key], key);
  return value as PsmBefore;
}

function assertCallTransaction(transaction: unknown, preview: NilePsmPreview, signed: boolean, now: number): void {
  const tx = object(transaction, '거래 원문');
  const raw = object(tx.raw_data, '거래 raw_data');
  if (!Array.isArray(raw.contract) || raw.contract.length !== 1 ||
      !Number.isSafeInteger(raw.fee_limit) || BigInt(raw.fee_limit as number) !== BigInt(preview.feeLimitSun) ||
      !Number.isSafeInteger(raw.expiration) || (raw.expiration as number) <= now ||
      typeof tx.txID !== 'string' || !TX_ID.test(tx.txID) ||
      typeof tx.raw_data_hex !== 'string' || !HEX.test(tx.raw_data_hex)) {
    throw new Error('PSM 거래의 원문·원 txID·수수료·유효 시간이 다릅니다.');
  }
  const call = object(raw.contract[0], '계약 호출');
  const value = object(object(call.parameter, '계약 인자').value, '계약 값');
  const zero = (item: unknown) => item === undefined || item === 0 || item === '0';
  if (call.type !== 'TriggerSmartContract' ||
      !sameAddress(String(value.owner_address), preview.walletAddress) ||
      !sameAddress(String(value.contract_address), preview.contractAddress) ||
      String(value.data).replace(/^0x/, '').toLowerCase() !== callData(preview.method, preview.argumentAddress, preview.amountBaseUnits) ||
      !zero(value.call_value) || !zero(value.call_token_value) || !zero(value.token_id)) {
    throw new Error('PSM 거래의 계정·계약·함수·수량·TRX 전송값이 미리보기와 다릅니다.');
  }
  if (!signed) return;
  if (!Array.isArray(tx.signature) || tx.signature.length !== 1 || !utils.transaction.txCheck(tx)) {
    throw new Error('PSM 서명 거래의 무결성을 확인할 수 없습니다.');
  }
  try {
    const signer = utils.crypto.ecRecover(tx.txID, tx.signature[0] as string);
    if (!sameAddress(signer, preview.walletAddress)) throw new Error('signer mismatch');
  } catch { throw new Error('PSM 거래 서명자가 예약된 지갑과 다릅니다.'); }
}

function assertCurrentPreview(preview: NilePsmPreview, now: number): void {
  if (preview.chain !== 'nile' || preview.source.chain !== 'nile' || preview.source.mode !== 'live' ||
      preview.source.accessMethod !== 'rpc' || preview.source.fetchedAt !== preview.state.fetchedAt ||
      preview.state.chain !== 'nile' || !sameAddress(preview.walletAddress, preview.state.walletAddress) ||
      preview.state.source.chain !== 'nile' || preview.state.source.mode !== 'live' ||
      preview.state.source.accessMethod !== 'rpc' || preview.state.source.fetchedAt !== preview.state.fetchedAt ||
      Date.parse(preview.state.fetchedAt) > now || now - Date.parse(preview.state.fetchedAt) > PREVIEW_LIFETIME_MS ||
      !Number.isFinite(Date.parse(preview.expiresAt)) || Date.parse(preview.expiresAt) <= now ||
      Date.parse(preview.expiresAt) > now + PREVIEW_LIFETIME_MS ||
      !UINT.test(preview.feeLimitSun) || !UINT.test(preview.maxFeeSun) ||
      !UINT.test(preview.estimatedFeeSun) || BigInt(preview.feeLimitSun) <= 0n ||
      BigInt(preview.feeLimitSun) > BigInt(Number.MAX_SAFE_INTEGER) ||
      BigInt(preview.maxFeeSun) < BigInt(preview.feeLimitSun) ||
      preview.maxFeeBaseUnits !== preview.maxFeeSun || preview.estimatedFeeBaseUnits !== preview.estimatedFeeSun ||
      preview.approvalScope !== null || !/^nile:psm:roundtrip:v1:[0-9a-f]{64}$/.test(preview.planId)) {
    throw new Error('Nile PSM 미리보기가 만료되었거나 실행 조건과 다릅니다.');
  }
  assertPsmState(preview.step, preview.state);
  const spec = stepSpec(preview.step, preview.state);
  if (preview.direction !== spec.direction || preview.method !== spec.method ||
      !sameAddress(preview.contractAddress, spec.contractAddress) ||
      !sameAddress(preview.argumentAddress, spec.argumentAddress) ||
      preview.amountBaseUnits !== spec.amountBaseUnits || preview.gemAmountRaw !== preview.state.quote.gemAmountRaw ||
      preview.asset.symbol !== spec.asset.symbol || preview.asset.decimals !== spec.asset.decimals ||
      !preview.asset.address || !sameAddress(preview.asset.address, spec.asset.address) ||
      BigInt(preview.state.trxBalanceSun) < BigInt(preview.maxFeeSun) ||
      preview.fingerprint !== previewFingerprint(preview)) {
    throw new Error('Nile PSM 미리보기의 자산·계약·수량·지갑 잔고가 일치하지 않습니다.');
  }
}

function samePreview(before: NilePsmPreview, after: NilePsmPreview): boolean {
  return before.fingerprint === after.fingerprint && before.step === after.step &&
    before.planId === after.planId && before.quoteVersion === after.quoteVersion &&
    before.amountBaseUnits === after.amountBaseUnits && before.feeLimitSun === after.feeLimitSun &&
    sameAddress(before.walletAddress, after.walletAddress);
}

/** Read a fresh PSM state, simulate this exact call and bound both Energy and Bandwidth. */
export async function createNilePsmPreview(input: {
  walletAddress: string; gemAmountRaw: string; step: NilePsmStep;
}, deps: { readState?: typeof readNilePsmState; rpc?: Rpc; now?: () => number } = {}): Promise<NilePsmPreview> {
  const now = deps.now ?? Date.now;
  const rpc = deps.rpc ?? ((endpoint, body) => postTronRpc('nile', endpoint, body));
  const walletAddress = canonicalAddress(input.walletAddress, 'Nile 지갑');
  const direction: NilePsmDirection = input.step === 'approve_usdd' || input.step === 'buy_gem' ? 'buy_gem' : 'sell_gem';
  const state = await (deps.readState ?? readNilePsmState)({ walletAddress,
    gemAmountRaw: input.gemAmountRaw, direction });
  assertPsmState(input.step, state);
  const spec = stepSpec(input.step, state);
  const parameter = encodeAddress(spec.argumentAddress) + uint(spec.amountBaseUnits, '호출 수량', true).toString(16).padStart(64, '0');
  const request = { owner_address: walletAddress, contract_address: spec.contractAddress,
    function_selector: spec.method, parameter, visible: true };
  let energy: bigint;
  try {
    const estimate = object(await rpc('/wallet/estimateenergy', request), 'Energy 추정');
    if (object(estimate.result, 'Energy 결과').result !== true) throw new Error('Energy 사전 실행 실패');
    energy = uint(estimate.energy_required, '예상 Energy', true);
  } catch {
    const simulated = object(await rpc('/wallet/triggerconstantcontract', request), '계약 사전 실행');
    if (object(simulated.result, '사전 실행 결과').result !== true) throw new Error('PSM 계약 사전 실행에 실패했습니다.');
    energy = uint(simulated.energy_used, '예상 Energy', true);
  }
  const parameters = await rpc('/wallet/getchainparameters', {});
  const energyPrice = chainParameter(parameters, 'getEnergyFee');
  const bandwidthPrice = chainParameter(parameters, 'getTransactionFee');
  const maximumFeeLimit = chainParameter(parameters, 'getMaxFeeLimit');
  const feeLimit = energy * energyPrice * 2n;
  if (feeLimit > maximumFeeLimit) throw new Error('PSM 예상 Energy 상한이 Nile 최대 허용 수수료를 초과합니다.');
  const draft = object(await rpc('/wallet/triggersmartcontract', {
    ...request, fee_limit: safeNumber(feeLimit, 'Energy 상한'),
  }), '미서명 거래');
  if (object(draft.result, '미서명 거래 결과').result !== true) throw new Error('PSM 미서명 거래를 구성할 수 없습니다.');
  const transaction = object(draft.transaction, '미서명 거래 원문');
  if (typeof transaction.raw_data_hex !== 'string' || !HEX.test(transaction.raw_data_hex)) {
    throw new Error('PSM 거래의 Bandwidth 크기를 확인할 수 없습니다.');
  }
  const bandwidthFeeUpperBound = (BigInt(transaction.raw_data_hex.length / 2) + SIGNED_CONTRACT_OVERHEAD_BYTES) * bandwidthPrice;
  const maxFee = feeLimit + bandwidthFeeUpperBound;
  if (BigInt(state.trxBalanceSun) < maxFee) throw new Error('Nile TRX가 이 단계의 최대 거래 수수료에 부족합니다.');
  const source: Source = { sourceUrl: state.sourceUrl, chain: 'nile', fetchedAt: state.fetchedAt,
    sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };
  const planId = `nile:psm:roundtrip:v1:${createHash('sha256').update(JSON.stringify([walletAddress, state.quote.gemAmountRaw])).digest('hex')}`;
  const quoteVersion = createHash('sha256').update(JSON.stringify([state.contractCodeHashes,
    state.tinRaw, state.toutRaw, state.quote, state.entryCapacityUsdtRaw, state.exitCapacityUsdtRaw])).digest('hex');
  const preview: NilePsmPreview = {
    id: randomUUID(), planId, needsVersion: 1, quoteVersion,
    walletAddress, chain: 'nile', asset: spec.asset,
    amountBaseUnits: spec.amountBaseUnits, contractAddress: spec.contractAddress,
    method: spec.method, argumentAddress: spec.argumentAddress, step: input.step, direction: spec.direction,
    gemAmountRaw: state.quote.gemAmountRaw, approvalScope: null,
    estimatedFeeBaseUnits: (energy * energyPrice + bandwidthFeeUpperBound).toString(),
    maxFeeBaseUnits: maxFee.toString(), estimatedFeeSun: (energy * energyPrice + bandwidthFeeUpperBound).toString(),
    maxFeeSun: maxFee.toString(), feeLimitSun: feeLimit.toString(),
    expiresAt: new Date(now() + PREVIEW_LIFETIME_MS).toISOString(), fingerprint: '',
    risks: ['Nile 시험 거래입니다. 승인과 전환은 각각 별도 TronLink 서명이 필요하며, 수수료는 실제 영수증에서 확인합니다.'],
    source, state,
  };
  preview.fingerprint = previewFingerprint(preview);
  assertCurrentPreview(preview, now());
  assertCallTransaction(transaction, preview, false, now());
  return preview;
}

/** Server-side PSM approval gate. This object never signs or broadcasts a transaction. */
export function createNilePsmApprovalService(input: {
  ledger: Ledger;
  refreshPreview: (preview: NilePsmPreview) => Promise<NilePsmPreview>;
  readBalances: (walletAddress: string) => Promise<NilePsmBalances>;
  readTransaction?: (txId: string) => Promise<NileTransactionResult>;
  verifyNileReferenceBlock: (signedTransaction: unknown) => Promise<void>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const readTransaction = input.readTransaction ?? readSolidifiedNileTransaction;
  const targetPosition = (account: string) => `nile:${canonicalAddress(account, '지갑')}:${NILE_PSM_CONTRACTS.psm}`;

  function ownedIntent(account: string, intentId: string): ActionIntent {
    const intent = input.ledger.getIntent(intentId);
    if (!intent || intent.chain !== 'nile' || !sameAddress(intent.account, account) ||
        intent.targetPosition !== targetPosition(account)) throw new Error('해당 Nile PSM 거래 의도를 찾을 수 없습니다.');
    return intent;
  }

  function assertIntentPreview(intent: ActionIntent, preview: NilePsmPreview): void {
    const action = preview.step === 'buy_gem' ? 'swap_out' : preview.step === 'sell_gem' ? 'swap_in' : 'approve';
    if (intent.action !== action || intent.planId !== preview.planId || intent.previewId !== preview.id ||
        intent.previewFingerprint !== preview.fingerprint || intent.previewExpiresAt !== preview.expiresAt ||
        intent.amountBaseUnits !== preview.amountBaseUnits || intent.maxFeeBaseUnits !== preview.maxFeeSun ||
        intent.targetMethod !== preview.method || !sameAddress(intent.account, preview.walletAddress) ||
        !sameAddress(intent.targetContract, preview.contractAddress)) {
      throw new Error('저장된 PSM 거래 의도와 미리보기가 다릅니다.');
    }
  }

  async function reserve(account: string, preview: NilePsmPreview, confirmedPreviewId: string): Promise<ActionIntent> {
    assertCurrentPreview(preview, now());
    if (!sameAddress(account, preview.walletAddress) || confirmedPreviewId !== preview.id) {
      throw new Error('인증 지갑 또는 사용자님이 확인한 미리보기 ID가 다릅니다.');
    }
    if (input.ledger.listUnresolved().some(intent => intent.chain === 'nile' && sameAddress(intent.account, account))) {
      throw new Error('같은 Nile 지갑에 미확정 거래가 있습니다. 원 txID를 먼저 확인해 주세요.');
    }
    const latest = await input.refreshPreview(preview);
    assertCurrentPreview(latest, now());
    if (!samePreview(preview, latest)) throw new Error('PSM 계약 상태·수수료·잔고가 바뀌었습니다. 새 미리보기를 확인해 주세요.');
    const action = preview.step === 'buy_gem' ? 'swap_out' : preview.step === 'sell_gem' ? 'swap_in' : 'approve';
    const positionVersion = JSON.stringify(beforeState(preview));
    return input.ledger.reserveIntent({
      chain: 'nile', account: preview.walletAddress, policyVersion: 1,
      triggerId: createTriggerId({ kind: 'chain_event', sourceId: preview.id, positionVersion }),
      action, targetPosition: targetPosition(account), positionVersion,
      receiptBalanceBeforeBaseUnits: preview.step === 'approve_usdd' || preview.step === 'buy_gem'
        ? preview.state.usddBalanceRaw : preview.state.usdtBalanceRaw,
      planId: preview.planId, quoteVersion: preview.quoteVersion,
      previewId: preview.id, previewFingerprint: preview.fingerprint, previewExpiresAt: preview.expiresAt,
      amountBaseUnits: preview.amountBaseUnits, maxFeeBaseUnits: preview.maxFeeSun,
      targetContract: preview.contractAddress, targetMethod: preview.method,
    });
  }

  async function acceptSigned(account: string, request: { intentId: string; preview: NilePsmPreview;
    signedTransaction: unknown }): Promise<ActionIntent> {
    const intent = ownedIntent(account, request.intentId);
    assertIntentPreview(intent, request.preview);
    assertCurrentPreview(request.preview, now());
    assertCallTransaction(request.signedTransaction, request.preview, true, now());
    await input.verifyNileReferenceBlock(request.signedTransaction);
    return input.ledger.recordSignedTransaction(intent.id, request.signedTransaction);
  }

  function beginBroadcast(account: string, request: { intentId: string; preview: NilePsmPreview }) {
    const intent = ownedIntent(account, request.intentId);
    assertIntentPreview(intent, request.preview);
    assertCurrentPreview(request.preview, now());
    const signedTransaction = input.ledger.getSignedTransaction(intent.id);
    assertCallTransaction(signedTransaction, request.preview, true, now());
    return { intent: input.ledger.markBroadcastAttempt(intent.id), signedTransaction };
  }

  function recordBroadcastResult(account: string, intentId: string, accepted: boolean | null): ActionIntent {
    ownedIntent(account, intentId);
    return input.ledger.recordBroadcastResult(intentId, accepted);
  }

  async function reconcile(account: string, intentId: string): Promise<NilePsmReconciliation> {
    const intent = ownedIntent(account, intentId);
    if (!intent.txId) throw new Error('조회할 원 txID가 없습니다.');
    const observation = await readTransaction(intent.txId);
    if (observation.txId.toLowerCase() !== intent.txId.toLowerCase() ||
        observation.source.chain !== 'nile' || observation.source.mode !== 'live' ||
        observation.source.accessMethod !== 'rpc') throw new Error('원 txID의 Nile RPC 관측이 아닙니다.');
    if (observation.status !== 'confirmed' && observation.status !== 'failed') {
      return { intent, observation, balances: null };
    }
    const receipt = observation.receipt;
    if (!receipt || String(receipt.id).toLowerCase() !== intent.txId.toLowerCase() ||
        !receipt.receipt || typeof receipt.receipt !== 'object' ||
        observation.actualFeeSun === null ||
        BigInt(uint(receipt.fee ?? '0', '영수증 수수료')) !== BigInt(uint(observation.actualFeeSun, '실제 수수료')) ||
        (observation.status === 'confirmed') !== ((receipt.receipt as Record<string, unknown>).result === 'SUCCESS')) {
      throw new Error('PSM 거래의 solidified 영수증·실행 결과·수수료가 맞지 않습니다.');
    }
    if (Date.parse(observation.source.fetchedAt) < Date.parse(intent.broadcastStartedAt ?? intent.updatedAt) ||
        Date.parse(observation.source.fetchedAt) > now()) throw new Error('방송 이후의 Nile 영수증이 아닙니다.');
    if (intent.status === 'confirmed' || intent.status === 'failed') {
      if (intent.status !== observation.status) throw new Error('확정된 PSM 거래 결과와 영수증이 다릅니다.');
      return { intent, observation, balances: null };
    }
    let balances: NilePsmBalances | null = null;
    if (observation.status === 'confirmed') {
      const started = now();
      balances = await input.readBalances(intent.account);
      if (balances.chain !== 'nile' || !sameAddress(balances.walletAddress, intent.account) ||
          !sameAddress(balances.usdtAddress, NILE_PSM_CONTRACTS.usdt) ||
          !sameAddress(balances.usddAddress, NILE_PSM_CONTRACTS.usdd) ||
          balances.source.chain !== 'nile' || balances.source.mode !== 'live' ||
          balances.source.accessMethod !== 'rpc' || balances.source.fetchedAt !== balances.fetchedAt ||
          Date.parse(balances.fetchedAt) < started || Date.parse(balances.fetchedAt) > now()) {
        throw new Error('PSM 거래 후 동일 토큰·지갑의 최신 잔고 관측이 아닙니다.');
      }
      const before = recordedBefore(intent);
      const oldUsdd = BigInt(before.usddBalanceRaw);
      const oldUsdt = BigInt(before.usdtBalanceRaw);
      const newUsdd = BigInt(balances.usddBalanceRaw);
      const newUsdt = BigInt(balances.usdtBalanceRaw);
      const gem = BigInt(before.gemAmountRaw);
      const usdd = BigInt(before.usddAmountRaw);
      if (before.step === 'approve_usdd') {
        if (BigInt(balances.usddAllowanceToPsmRaw) !== usdd || oldUsdd !== newUsdd || oldUsdt !== newUsdt) {
          throw new Error('USDD 승인 후 정확한 allowance·잔고 상태가 확인되지 않았습니다.');
        }
      } else if (before.step === 'approve_usdt') {
        if (BigInt(balances.usdtAllowanceToGemJoinRaw) !== gem || oldUsdd !== newUsdd || oldUsdt !== newUsdt) {
          throw new Error('USDT 승인 후 정확한 allowance·잔고 상태가 확인되지 않았습니다.');
        }
      } else if (before.step === 'buy_gem') {
        if (oldUsdd < usdd || oldUsdd - newUsdd !== usdd || newUsdt < oldUsdt || newUsdt - oldUsdt !== gem) {
          throw new Error('USDD→USDT 전환 후 실제 수령·지출 수량이 미리보기와 다릅니다.');
        }
      } else if (oldUsdt < gem || oldUsdt - newUsdt !== gem || newUsdd < oldUsdd || newUsdd - oldUsdd !== usdd) {
        throw new Error('USDT→USDD 전환 후 실제 수령·지출 수량이 미리보기와 다릅니다.');
      }
    }
    return { intent: input.ledger.recordSolidifiedOutcome(intent.id, {
      txId: intent.txId, status: observation.status, solidifiedAt: new Date(now()).toISOString(), receipt,
    }), observation, balances };
  }

  function cancel(account: string, intentId: string): ActionIntent {
    ownedIntent(account, intentId);
    return input.ledger.cancelReservation(intentId);
  }

  function unresolved(account: string): ActionIntent[] {
    return input.ledger.listUnresolved().filter(intent => intent.chain === 'nile' &&
      sameAddress(intent.account, account) && intent.targetPosition === targetPosition(account));
  }

  return { reserve, acceptSigned, beginBroadcast, recordBroadcastResult, reconcile, cancel, unresolved };
}
