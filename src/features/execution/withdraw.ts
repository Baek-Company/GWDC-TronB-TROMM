import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { actionPreviewSchema, executionRecordSchema, type ExecutionRecord, type Observation } from '../../../shared/schemas';
import { sameSafeNileWithdrawal } from '../../../shared/nile-withdrawal-revalidation';
import { assertNileBandwidthBudgetEvidence, assertNileWithdrawalBandwidthBudget } from '../../../shared/nile-bandwidth';
import type { NileTransactionResult, NileWithdrawalPreview } from '../../../server/transactions';
import { assertWalletEpoch, getWalletEpoch, requireNileWallet } from '../../wallet';
import { assertSameSignedTransaction, verifyNileUnresolvedIntent,
  type NileApprovalGateway, type NileUnresolvedIntent } from './approval-api';
import { assertNoOtherNilePendingExecution, mergeExecutionRecord, readTxEvidence,
  requireCurrentNilePlanId, reserveNilePendingExecution, saveTxEvidence,
  settleNilePendingExecution, withNileExecutionLock, type RecordStore } from './safety';

const RECORD_PREFIX = 'gwdc:nile-withdrawal:v1:';
const PREVIEW_PREFIX = 'gwdc:nile-withdrawal-preview:v1:';
const TX_ID_RE = /^[0-9a-fA-F]{64}$/;

export class WithdrawalPreviewChangedError extends Error {
  constructor(public readonly updatedPreview: NileWithdrawalPreview | null,
    message = '환매 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.') {
    super(message);
    this.name = 'WithdrawalPreviewChangedError';
  }
}

function key(planId: string, walletAddress: string): string {
  return `${RECORD_PREFIX}${planId}:${walletAddress}`;
}
function previewKey(planId: string, walletAddress: string): string {
  return `${PREVIEW_PREFIX}${planId}:${walletAddress}`;
}

function storage(override?: RecordStore): RecordStore {
  if (override) return override;
  if (typeof window === 'undefined') throw new Error('브라우저 저장소가 필요합니다.');
  return window.localStorage;
}

export function getNileWithdrawalRecord(planId: string, walletAddress: string,
  store?: RecordStore): ExecutionRecord | null {
  const records = listNileWithdrawalRecords(planId, walletAddress, store);
  return records.at(-1) ?? null;
}

export function listNileWithdrawalRecords(planId: string, walletAddress: string,
  store?: RecordStore): ExecutionRecord[] {
  const target = storage(store);
  const value = target.getItem(key(planId, walletAddress));
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error('Invalid withdrawal history');
    return parsed.map(record => {
      const validated = executionRecordSchema.parse(record);
      const evidence = validated.txId ? readTxEvidence(target, validated.txId) : null;
      return evidence ? mergeExecutionRecord(validated, evidence) : validated;
    });
  }
  catch { throw new Error('저장된 환매 기록이 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.'); }
}

export function getNileWithdrawalPreview(planId: string, walletAddress: string,
  store?: Pick<Storage, 'getItem' | 'setItem'>): NileWithdrawalPreview | null {
  const value = storage(store).getItem(previewKey(planId, walletAddress));
  if (!value) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    const preview = actionPreviewSchema.extend({
      feeLimitSun: z.string().regex(/^\d+$/),
      expectedUnderlyingSun: z.string().regex(/^\d+$/),
      state: z.object({ jtrxBalanceRaw: z.string().regex(/^\d+$/) }),
    }).parse(parsed);
    if (preview.planId !== planId || preview.walletAddress !== walletAddress ||
        preview.chain !== 'nile' || preview.method !== 'redeem(uint256)' ||
        preview.asset.symbol !== 'jTRX' || preview.asset.address !== preview.contractAddress) {
      throw new Error('withdrawal preview mismatch');
    }
    return parsed as NileWithdrawalPreview;
  } catch { throw new Error('저장된 환매 미리보기가 손상되었습니다. 원 거래를 확인할 때까지 재서명하지 마세요.'); }
}

function withdrawalRecoveryRecord(intent: NileUnresolvedIntent, current: ExecutionRecord | null,
  preview: NileWithdrawalPreview | null): ExecutionRecord {
  if (intent.action !== 'withdraw' || intent.targetMethod !== 'redeem(uint256)') {
    throw new Error('환매 복구 대상이 아닌 서버 거래 의도입니다.');
  }
  if (preview && (preview.id !== intent.previewId || preview.planId !== intent.planId ||
      preview.walletAddress !== intent.account || preview.contractAddress !== intent.targetContract ||
      preview.amountBaseUnits !== intent.amountBaseUnits || preview.quoteVersion !== intent.quoteVersion)) {
    throw new Error('저장된 환매 미리보기와 서버 거래 의도가 다릅니다. 새 서명을 진행하지 마세요.');
  }
  const tentativeReserved = intent.status === 'reserved' && current?.status === 'unknown' &&
    !!current.txId && TX_ID_RE.test(current.txId) && current.submittedAt === null &&
    current.receipt === null && current.actualFeeBaseUnits === null && current.confirmedAt === null;
  if (current && (current.action !== 'withdraw' || current.chain !== 'nile' ||
      current.planId !== intent.planId || current.previewId !== intent.previewId ||
      current.walletAddress !== intent.account || current.amountBaseUnits !== intent.amountBaseUnits ||
      current.contractAddress !== intent.targetContract || current.approvalIntentId !== intent.id ||
      current.txId && !tentativeReserved && current.txId.toLowerCase() !== intent.txId?.toLowerCase() ||
      ['confirmed', 'failed', 'rejected'].includes(current.status))) {
    throw new Error('로컬 환매 기록과 서버 미해결 의도가 다릅니다. 새 서명을 진행하지 마세요.');
  }
  if (intent.status === 'reserved' && current?.txId && !tentativeReserved) {
    throw new Error('서명 전 환매 예약에 다른 원 txID가 연결되어 있습니다.');
  }
  const hasSignedBytes = intent.txId !== null;
  return executionRecordSchema.parse({
    id: current?.id ?? intent.id, action: 'withdraw', planId: intent.planId, previewId: intent.previewId,
    walletAddress: intent.account, chain: 'nile', approvalIntentId: intent.id,
    txId: tentativeReserved ? current!.txId : intent.txId, amountBaseUnits: intent.amountBaseUnits,
    contractAddress: intent.targetContract,
    status: hasSignedBytes || tentativeReserved ? current?.status === 'pending' ? 'pending' : 'unknown' : 'awaiting_signature',
    receipt: current?.receipt ?? null, actualFeeBaseUnits: current?.actualFeeBaseUnits ?? null,
    createdAt: current?.createdAt ?? intent.createdAt,
    submittedAt: hasSignedBytes ? current?.submittedAt ?? intent.updatedAt : null,
    confirmedAt: null,
    error: tentativeReserved
      ? '서버가 환매 서명 거래를 접수하지 않았고 방송도 시작하지 않았습니다. 서명 전 예약을 취소해 주세요.'
      : hasSignedBytes
      ? '서버에 원 환매 거래가 남아 있습니다. 재서명·재방송하지 말고 원 txID를 조회해 주세요.'
      : '서명 전 환매 예약이 남아 있습니다. 예약 취소를 확인한 뒤 새 거래를 시작해 주세요.',
  });
}

function recoveryHistory(intent: NileUnresolvedIntent, store: RecordStore): {
  current: ExecutionRecord | null; preview: NileWithdrawalPreview | null;
} {
  const records = listNileWithdrawalRecords(intent.planId, intent.account, store);
  const current = records.find(record => record.approvalIntentId === intent.id) ?? null;
  if (!current && records.some(record => ['awaiting_signature', 'submitted', 'pending', 'unknown'].includes(record.status))) {
    throw new Error('다른 로컬 환매가 미해결 상태입니다. 원 txID를 확인해 주세요.');
  }
  return { current, preview: getNileWithdrawalPreview(intent.planId, intent.account, store) };
}

export async function synchronizeNileWithdrawalIntent(input: {
  intent: NileUnresolvedIntent;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: RecordStore;
}): Promise<ExecutionRecord> {
  const intent = verifyNileUnresolvedIntent(input.intent, input.intent.account);
  requireCurrentNilePlanId(intent.planId);
  return withNileExecutionLock('withdraw', intent.planId, intent.account, async () => {
    const target = storage(input.store);
    assertNoOtherNilePendingExecution(target, 'withdraw', intent.planId, intent.account);
    const { current, preview } = recoveryHistory(intent, target);
    return save(withdrawalRecoveryRecord(intent, current, preview), input.onRecord, target);
  });
}

export async function cancelNileWithdrawalReservation(input: {
  intent: NileUnresolvedIntent;
  approval: NileApprovalGateway;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: RecordStore;
}): Promise<ExecutionRecord> {
  const intent = verifyNileUnresolvedIntent(input.intent, input.intent.account);
  if (intent.status !== 'reserved') throw new Error('서명된 환매 의도는 취소할 수 없습니다. 원 txID를 확인해 주세요.');
  return withNileExecutionLock('withdraw', intent.planId, intent.account, async () => {
    const target = storage(input.store);
    const { current, preview } = recoveryHistory(intent, target);
    const record = withdrawalRecoveryRecord(intent, current, preview);
    await input.approval.cancel(intent.id);
    return save({ ...record, status: 'rejected', error: '사용자님이 이전 서명 전 환매 예약을 취소하셨습니다.' },
      input.onRecord, target);
  });
}

async function save(record: ExecutionRecord, onRecord: (record: ExecutionRecord) => void | Promise<void>,
  store?: RecordStore): Promise<ExecutionRecord> {
  const records = listNileWithdrawalRecords(record.planId, record.walletAddress, store);
  const target = storage(store);
  const validated = executionRecordSchema.parse(record);
  const at = records.findIndex(item => item.id === validated.id);
  const reconciled = at >= 0 ? mergeExecutionRecord(records[at], validated) : validated;
  reserveNilePendingExecution(target, reconciled);
  const committed = saveTxEvidence(target, reconciled);
  if (at >= 0) records[at] = committed;
  else records.push(committed);
  target.setItem(key(record.planId, record.walletAddress), JSON.stringify(records));
  settleNilePendingExecution(target, committed);
  await onRecord(committed);
  return committed;
}

function verifyPreview(preview: NileWithdrawalPreview, now: number) {
  actionPreviewSchema.parse(preview);
  if (preview.chain !== 'nile' || preview.source.chain !== 'nile' || preview.source.mode !== 'live' ||
      preview.asset.symbol !== 'jTRX' || preview.asset.address !== preview.contractAddress ||
      preview.asset.decimals !== 8 || preview.method !== 'redeem(uint256)' || preview.approvalScope !== null ||
      !TronWeb.isAddress(preview.contractAddress) || !/^\d+$/.test(preview.feeLimitSun) ||
      BigInt(preview.feeLimitSun) <= 0n || preview.state.chainId !== '0xcd8690dc' ||
      preview.state.walletAddress !== preview.walletAddress || preview.state.contractAddress !== preview.contractAddress ||
      preview.state.jtrxDecimals !== 8 || preview.state.jtrxAmountRaw !== preview.amountBaseUnits ||
      preview.state.expectedUnderlyingSun !== preview.expectedUnderlyingSun ||
      preview.state.feeLimitSun !== preview.feeLimitSun ||
      preview.state.estimatedFeeSun !== preview.estimatedFeeBaseUnits ||
      preview.state.maxFeeSun !== preview.maxFeeBaseUnits ||
      BigInt(preview.state.jtrxBalanceRaw) < BigInt(preview.amountBaseUnits) ||
      BigInt(preview.state.marketCashSun) < BigInt(preview.expectedUnderlyingSun) ||
      BigInt(preview.state.walletBalanceSun) < BigInt(preview.state.maxFeeSun)) {
    throw new Error('Nile jTRX 환매 미리보기 검증에 실패했습니다.');
  }
  assertNileBandwidthBudgetEvidence(preview.state);
  if (Date.parse(preview.expiresAt) <= now) {
    throw new WithdrawalPreviewChangedError(null, '환매 미리보기가 만료되었습니다. 다시 확인해 주세요.');
  }
}

function checkBuiltTransaction(transaction: unknown, preview: NileWithdrawalPreview) {
  if (!transaction || typeof transaction !== 'object') throw new Error('환매 미서명 거래를 확인할 수 없습니다.');
  const tx = transaction as Record<string, unknown>;
  if (typeof tx.txID !== 'string' || !TX_ID_RE.test(tx.txID)) throw new Error('환매 거래 ID가 올바르지 않습니다.');
  const raw = tx.raw_data as Record<string, unknown> | undefined;
  const calls = raw?.contract;
  if (!raw || !Array.isArray(calls) || calls.length !== 1 || raw.fee_limit !== Number(preview.feeLimitSun)) {
    throw new Error('환매 거래의 호출 또는 수수료 상한이 미리보기와 다릅니다.');
  }
  const call = calls[0] as Record<string, unknown>;
  const parameter = call?.parameter as Record<string, unknown> | undefined;
  const value = parameter?.value as Record<string, unknown> | undefined;
  const selector = TronWeb.sha3('redeem(uint256)').replace(/^0x/, '').slice(0, 8).toLowerCase();
  const expectedData = selector + BigInt(preview.amountBaseUnits).toString(16).padStart(64, '0');
  if (call.type !== 'TriggerSmartContract' || !value ||
      value.owner_address !== TronWeb.address.toHex(preview.walletAddress) ||
      value.contract_address !== TronWeb.address.toHex(preview.contractAddress) ||
      (value.call_value !== undefined && value.call_value !== 0) ||
      String(value.data).toLowerCase().replace(/^0x/, '') !== expectedData) {
    throw new Error('환매 거래의 계정·계약·jTRX 수량·메서드가 미리보기와 다릅니다.');
  }
  if (typeof raw.expiration !== 'number' || raw.expiration <= Date.now()) {
    throw new Error('환매 미서명 거래가 만료되었습니다.');
  }
}

function formatUnits(value: string, decimals: number): string {
  const divisor = 10n ** BigInt(decimals);
  const raw = BigInt(value);
  const fraction = (raw % divisor).toString().padStart(decimals, '0').replace(/0+$/, '');
  return `${raw / divisor}${fraction ? `.${fraction}` : ''}`;
}

function isUserRejection(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 4001;
}

export async function executeNileWithdrawal(input: {
  preview: NileWithdrawalPreview;
  depositRecord: ExecutionRecord;
  confirmPreviewId: string;
  refreshPreview: (preview: NileWithdrawalPreview) => Promise<NileWithdrawalPreview>;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  expectedWalletEpoch?: number;
  confirmAction?: (preview: NileWithdrawalPreview) => boolean | Promise<boolean>;
  approval: NileApprovalGateway;
  store?: Pick<Storage, 'getItem' | 'setItem'>;
}): Promise<ExecutionRecord> {
  const { preview, refreshPreview, onRecord, store } = input;
  requireCurrentNilePlanId(preview.planId);
  verifyPreview(preview, Date.now());
  const deposit = executionRecordSchema.parse(input.depositRecord);
  if (deposit.status !== 'confirmed' || !deposit.txId || !TX_ID_RE.test(deposit.txId) ||
      !deposit.approvalIntentId || !TX_ID_RE.test(deposit.approvalIntentId) ||
      deposit.chain !== 'nile' || deposit.planId !== preview.planId ||
      deposit.walletAddress !== preview.walletAddress) {
    throw new Error('같은 Nile 계획·지갑의 확정 예치 기록이 필요합니다.');
  }
  if (input.confirmPreviewId !== preview.id) throw new Error('사용자님이 확인한 환매 미리보기 ID와 거래 대상이 다릅니다.');
  const walletEpoch = getWalletEpoch();
  if (input.expectedWalletEpoch !== undefined) assertWalletEpoch(input.expectedWalletEpoch);
  return withNileExecutionLock('withdraw', preview.planId, preview.walletAddress, async () => {
  // The history read and retry decision happen only after acquiring the cross-tab lock.
  assertNoOtherNilePendingExecution(storage(store), 'withdraw', preview.planId, preview.walletAddress);
  const previous = getNileWithdrawalRecord(preview.planId, preview.walletAddress, store);
  if (previous && (['awaiting_signature', 'submitted', 'pending', 'unknown'].includes(previous.status) ||
      (previous.status === 'confirmed' && previous.previewId === preview.id))) {
    throw new Error('이 포지션의 환매 거래가 진행 중이거나 확정되었습니다. 원 txID를 먼저 확인해 주세요.');
  }
  storage(store).setItem(previewKey(preview.planId, preview.walletAddress), JSON.stringify(preview));
  const record: ExecutionRecord = {
    id: crypto.randomUUID(), action: 'withdraw', planId: preview.planId, previewId: preview.id,
    walletAddress: preview.walletAddress, chain: 'nile', txId: null,
    amountBaseUnits: preview.amountBaseUnits, contractAddress: preview.contractAddress,
    status: 'preview', receipt: null, actualFeeBaseUnits: null,
    createdAt: new Date().toISOString(), submittedAt: null, confirmedAt: null, error: null,
  };
  let intentId: string | null = null;
  let tentativeTxId: string | null = null;
  try {
    requireNileWallet(preview.walletAddress);
    assertWalletEpoch(walletEpoch);
    const refreshed = await refreshPreview(preview);
    verifyPreview(refreshed, Date.now());
    if (!sameSafeNileWithdrawal(preview, refreshed)) throw new WithdrawalPreviewChangedError(refreshed);
    requireNileWallet(preview.walletAddress);
    const confirm = input.confirmAction ?? ((value: NileWithdrawalPreview) => window.confirm(
      `Nile jTRX ${formatUnits(value.amountBaseUnits, 8)}개를 환매하시겠습니까?\n` +
      `예상 수령: ${formatUnits(value.expectedUnderlyingSun, 6)} TRX\n계약: ${value.contractAddress}\n` +
      `예상 수수료: ${formatUnits(value.estimatedFeeBaseUnits!, 6)} TRX\n` +
      `최대 수수료: ${formatUnits(value.maxFeeBaseUnits!, 6)} TRX\n환율·시장 유동성이 바뀔 수 있습니다.`,
    ));
    if (!await confirm(preview)) {
      record.status = 'rejected';
      record.error = '사용자님이 환매를 취소하셨습니다.';
      await save(record, onRecord, store);
      return record;
    }
    verifyPreview(preview, Date.now());
    const latest = await refreshPreview(preview);
    verifyPreview(latest, Date.now());
    if (!sameSafeNileWithdrawal(preview, latest)) throw new WithdrawalPreviewChangedError(latest);
    await input.approval.authenticate(preview.walletAddress);
    requireNileWallet(preview.walletAddress);
    verifyPreview(latest, Date.now());
    intentId = await input.approval.reserve(preview, input.confirmPreviewId, undefined,
      deposit.approvalIntentId);
    record.approvalIntentId = intentId;
    const web = requireNileWallet(preview.walletAddress);
    record.status = 'awaiting_signature';
    await save(record, onRecord, store);
    const feeLimit = BigInt(preview.feeLimitSun);
    if (feeLimit > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('TronWeb 수수료 상한의 안전 정수 범위를 초과했습니다.');
    const built = await web.transactionBuilder.triggerSmartContract(preview.contractAddress,
      'redeem(uint256)', { feeLimit: Number(feeLimit) },
      [{ type: 'uint256', value: preview.amountBaseUnits }], preview.walletAddress);
    if (built.result.result !== true) throw new Error('Nile 환매 거래 구성에 실패했습니다.');
    checkBuiltTransaction(built.transaction, preview);
    requireNileWallet(preview.walletAddress);
    assertWalletEpoch(walletEpoch);
    const signed = await web.trx.sign(built.transaction);
    if (signed.txID !== built.transaction.txID || !Array.isArray(signed.signature) || signed.signature.length !== 1 ||
        signed.raw_data_hex !== built.transaction.raw_data_hex) {
      throw new Error('TronLink 환매 서명 결과가 원 거래와 다릅니다.');
    }
    assertNileWithdrawalBandwidthBudget(signed, preview.state);
    if (!intentId) throw new Error('환매 서명 전 서버 거래 예약을 확인할 수 없습니다.');
    tentativeTxId = signed.txID;
    const durableTxId = await input.approval.acceptSigned(intentId, preview, signed);
    if (durableTxId.toLowerCase() !== signed.txID.toLowerCase()) {
      throw new Error('서버 원장의 환매 원 거래 ID와 TronLink 서명 결과가 다릅니다.');
    }
    record.txId = signed.txID;
    record.status = 'submitted';
    record.submittedAt = new Date().toISOString();
    await save(record, onRecord, store);
    requireNileWallet(preview.walletAddress);
    const durableTransaction = await input.approval.beginBroadcast(intentId, preview);
    assertSameSignedTransaction(signed, durableTransaction);
    requireNileWallet(preview.walletAddress);
    let accepted: boolean | null = null;
    try {
      const broadcast = await web.trx.sendRawTransaction(
        durableTransaction as unknown as Parameters<typeof web.trx.sendRawTransaction>[0]);
      accepted = broadcast.result === true;
    } catch {
      accepted = null;
    }
    try { await input.approval.recordBroadcastResult(intentId, accepted); }
    catch { accepted = null; }
    record.status = accepted === true ? 'pending' : 'unknown';
    record.error = accepted === true ? null :
      '환매 방송 또는 서버 원장 응답이 불확실합니다. 새 거래를 서명하지 말고 원 txID를 조회해 주세요.';
    await save(record, onRecord, store);
    return record;
  } catch (error) {
    if (error instanceof WithdrawalPreviewChangedError) throw error;
    if (intentId && !record.txId && !tentativeTxId) {
      try { await input.approval.cancel(intentId); }
      catch {
        throw new Error('서명 전 환매 예약의 취소를 확인할 수 없습니다. 서버 원장을 확인하기 전 새 거래를 만들지 마세요.');
      }
    }
    if (tentativeTxId && !record.txId) record.txId = tentativeTxId;
    if (record.status === 'submitted' || record.txId) {
      record.status = 'unknown';
      record.error = '환매 서명 또는 방송 이후 상태가 불확실합니다. 원 txID를 조회해 주세요.';
      await save(record, onRecord, store);
      return record;
    }
    if (record.status === 'awaiting_signature') {
      record.status = 'rejected';
      record.error = isUserRejection(error) ? 'TronLink 환매 서명이 거절되었습니다.' :
        `서명 또는 방송 전 오류로 환매를 제출하지 못했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
      await save(record, onRecord, store);
      if (isUserRejection(error)) return record;
    }
    throw error;
  }
  });
}

export async function refreshNileWithdrawalRecord(input: {
  record: ExecutionRecord;
  preview?: NileWithdrawalPreview;
  approval?: NileApprovalGateway;
  readTransaction: (txId: string) => Promise<NileTransactionResult>;
  readObservation?: (record: ExecutionRecord) => Promise<Observation>;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: Pick<Storage, 'getItem' | 'setItem'>;
}): Promise<{ record: ExecutionRecord; observation: Observation | null }> {
  const requested = executionRecordSchema.parse(input.record);
  const preview = input.preview;
  if (requested.chain !== 'nile' || requested.action !== 'withdraw' ||
      (preview ? requested.planId !== preview.planId || requested.walletAddress !== preview.walletAddress ||
        requested.previewId !== preview.id : !requested.approvalIntentId) ||
      !requested.txId || !TX_ID_RE.test(requested.txId)) {
    throw new Error('같은 환매 미리보기의 Nile 원 거래 ID가 필요합니다.');
  }
  const checked = await input.readTransaction(requested.txId);
  if (checked.txId.toLowerCase() !== requested.txId.toLowerCase()) throw new Error('환매 조회 결과의 원 거래 ID가 다릅니다.');
  if (requested.approvalIntentId) {
    if (!input.approval) throw new Error('서버 원장 연결이 없어 환매 거래를 확정할 수 없습니다.');
    const ledger = await input.approval.reconcile(requested.approvalIntentId, requested.walletAddress);
    if (ledger.txId?.toLowerCase() !== requested.txId.toLowerCase() ||
        (['confirmed', 'failed'].includes(checked.status) && ledger.status !== checked.status)) {
      throw new Error('원 환매 txID의 서버 원장과 Nile 영수증 상태가 다릅니다. 다시 조회해 주세요.');
    }
  }
  return withNileExecutionLock('withdraw', requested.planId, requested.walletAddress, async () => {
  const target = storage(input.store);
  const latest = listNileWithdrawalRecords(requested.planId, requested.walletAddress, target)
    .find(item => item.id === requested.id);
  const recordBefore = readTxEvidence(target, requested.txId!) ?? latest ?? requested;
  if (recordBefore.id !== requested.id || recordBefore.txId?.toLowerCase() !== requested.txId?.toLowerCase()) {
    throw new Error('저장된 원 환매 거래와 조회 대상이 다릅니다.');
  }
  if ((recordBefore.status === 'confirmed' || recordBefore.status === 'failed') && checked.status !== recordBefore.status) {
    if (requested.status === recordBefore.status || checked.status === 'confirmed' || checked.status === 'failed') {
      throw new Error('확정된 환매 결과와 재조회 결과가 다릅니다.');
    }
  }
  const next = executionRecordSchema.parse({ ...recordBefore,
    status: checked.status, receipt: checked.receipt, actualFeeBaseUnits: checked.actualFeeSun,
    confirmationSource: checked.status === 'confirmed' || checked.status === 'failed' ? checked.source : recordBefore.confirmationSource,
    error: checked.reason, confirmedAt: checked.status === 'confirmed' ? checked.source.fetchedAt : recordBefore.confirmedAt,
  });
  const record = await save(next, input.onRecord, input.store);
  if (record.status !== 'confirmed' || !input.readObservation || !preview) return { record, observation: null };
  const observation = await input.readObservation(record);
  if (observation.chain !== 'nile' || observation.planId !== record.planId ||
      observation.walletAddress !== record.walletAddress ||
      observation.positionId !== `nile:${record.walletAddress}:${preview.contractAddress}` ||
      observation.source.mode !== 'live' ||
      BigInt(observation.receiptBalanceBaseUnits) >= BigInt(preview.state.jtrxBalanceRaw)) {
    throw new Error('같은 Nile 포지션에서 jTRX 잔고 감소를 확인하지 못했습니다.');
  }
  return { record, observation };
  });
}
