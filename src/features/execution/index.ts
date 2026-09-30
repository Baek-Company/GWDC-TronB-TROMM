import { TronWeb } from 'tronweb';
import type { Translate } from '../../lib/i18n';
import { actionPreviewSchema, executionRecordSchema, type ExecutionRecord, type Observation, type UserNeeds } from '../../../shared/schemas';
import type { NileDepositPreview, NileTransactionResult } from '../../../server/transactions';
import { assertWalletEpoch, getWalletEpoch, requireNileWallet } from '../../wallet';
import { assertSameSignedTransaction, verifyNileUnresolvedIntent,
  type NileApprovalGateway, type NileUnresolvedIntent } from './approval-api';
import { assertNoOtherNilePendingExecution, mergeExecutionRecord, readTxEvidence,
  requireCurrentNilePlanId, reserveNilePendingExecution, saveTxEvidence,
  settleNilePendingExecution, withNileExecutionLock, type RecordStore } from './safety';

const RECORD_PREFIX = 'gwdc:nile-execution:v1:';
const TX_ID_RE = /^[0-9a-fA-F]{64}$/;

export class PreviewChangedError extends Error {
  constructor(public readonly updatedPreview: NileDepositPreview | null, message = '거래 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.') {
    super(message);
    this.name = 'PreviewChangedError';
  }
}

function key(planId: string, walletAddress: string): string {
  return `${RECORD_PREFIX}${planId}:${walletAddress}`;
}

function storage(override?: RecordStore): RecordStore {
  if (override) return override;
  if (typeof window === 'undefined') throw new Error('브라우저 저장소가 필요합니다.');
  return window.localStorage;
}

export function getNileExecutionRecord(planId: string, walletAddress: string,
  store?: RecordStore): ExecutionRecord | null {
  const target = storage(store);
  const value = target.getItem(key(planId, walletAddress));
  if (!value) return null;
  try {
    const record = executionRecordSchema.parse(JSON.parse(value));
    const evidence = record.txId ? readTxEvidence(target, record.txId) : null;
    return evidence ? mergeExecutionRecord(record, evidence) : record;
  }
  catch { throw new Error('저장된 거래 기록이 손상되었습니다. 새 서명 전에 원 거래 상태를 확인해 주세요.'); }
}

function depositRecoveryRecord(intent: NileUnresolvedIntent, current: ExecutionRecord | null): ExecutionRecord {
  if (intent.action !== 'deposit' || intent.targetMethod !== 'mint()') {
    throw new Error('예치 복구 대상이 아닌 서버 거래 의도입니다.');
  }
  if (current && current.approvalIntentId !== intent.id && ['failed', 'rejected'].includes(current.status)) {
    current = null;
  }
  const tentativeReserved = intent.status === 'reserved' && current?.status === 'unknown' &&
    !!current.txId && TX_ID_RE.test(current.txId) && current.submittedAt === null &&
    current.receipt === null && current.actualFeeBaseUnits === null && current.confirmedAt === null;
  if (current && (current.action !== 'deposit' || current.chain !== 'nile' ||
      current.planId !== intent.planId || current.previewId !== intent.previewId ||
      current.walletAddress !== intent.account || current.amountBaseUnits !== intent.amountBaseUnits ||
      current.contractAddress !== intent.targetContract || current.approvalIntentId !== intent.id ||
      current.txId && !tentativeReserved && current.txId.toLowerCase() !== intent.txId?.toLowerCase() ||
      ['confirmed', 'failed', 'rejected'].includes(current.status))) {
    throw new Error('로컬 예치 기록과 서버 미해결 의도가 다릅니다. 새 서명을 진행하지 마세요.');
  }
  if (intent.status === 'reserved' && current?.txId && !tentativeReserved) {
    throw new Error('서명 전 서버 예약에 다른 원 txID가 연결되어 있습니다.');
  }
  const hasSignedBytes = intent.txId !== null;
  return executionRecordSchema.parse({
    id: current?.id ?? intent.id, action: 'deposit', planId: intent.planId, previewId: intent.previewId,
    walletAddress: intent.account, chain: 'nile', approvalIntentId: intent.id,
    txId: tentativeReserved ? current!.txId : intent.txId, amountBaseUnits: intent.amountBaseUnits,
    contractAddress: intent.targetContract,
    status: hasSignedBytes || tentativeReserved ? current?.status === 'pending' ? 'pending' : 'unknown' : 'awaiting_signature',
    receipt: current?.receipt ?? null, actualFeeBaseUnits: current?.actualFeeBaseUnits ?? null,
    createdAt: current?.createdAt ?? intent.createdAt,
    submittedAt: hasSignedBytes ? current?.submittedAt ?? intent.updatedAt : null,
    confirmedAt: null,
    error: tentativeReserved
      ? '서버가 서명 거래를 접수하지 않았고 방송도 시작하지 않았습니다. 서명 전 예약을 취소해 주세요.'
      : hasSignedBytes
      ? '서버에 원 거래가 남아 있습니다. 재서명·재방송하지 말고 원 txID를 조회해 주세요.'
      : '서명 전 서버 예약이 남아 있습니다. 예약 취소를 확인한 뒤 새 거래를 시작해 주세요.',
  });
}

export async function synchronizeNileDepositIntent(input: {
  intent: NileUnresolvedIntent;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: RecordStore;
}): Promise<ExecutionRecord> {
  const intent = verifyNileUnresolvedIntent(input.intent, input.intent.account);
  requireCurrentNilePlanId(intent.planId);
  return withNileExecutionLock('deposit', intent.planId, intent.account, async () => {
    const target = storage(input.store);
    assertNoOtherNilePendingExecution(target, 'deposit', intent.planId, intent.account);
    const record = depositRecoveryRecord(intent, getNileExecutionRecord(intent.planId, intent.account, target));
    return save(record, input.onRecord, target);
  });
}

export async function cancelNileDepositReservation(input: {
  intent: NileUnresolvedIntent;
  approval: NileApprovalGateway;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: RecordStore;
}): Promise<ExecutionRecord> {
  const intent = verifyNileUnresolvedIntent(input.intent, input.intent.account);
  if (intent.status !== 'reserved') throw new Error('서명된 거래 의도는 취소할 수 없습니다. 원 txID를 확인해 주세요.');
  return withNileExecutionLock('deposit', intent.planId, intent.account, async () => {
    const target = storage(input.store);
    const record = depositRecoveryRecord(intent, getNileExecutionRecord(intent.planId, intent.account, target));
    await input.approval.cancel(intent.id);
    return save({ ...record, status: 'rejected', error: '사용자님이 이전 서명 전 예약을 취소하셨습니다.' },
      input.onRecord, target);
  });
}

async function save(record: ExecutionRecord, onRecord: (record: ExecutionRecord) => void | Promise<void>,
  store?: RecordStore): Promise<ExecutionRecord> {
  const target = storage(store);
  const current = getNileExecutionRecord(record.planId, record.walletAddress, target);
  const historical = current && current.id !== record.id && record.txId &&
    readTxEvidence(target, record.txId)?.id === record.id;
  if (current && current.id !== record.id && !historical &&
      !['failed', 'rejected'].includes(current.status)) {
    throw new Error('다른 원 거래가 이미 저장되었습니다. 새 서명 전에 원 txID를 확인해 주세요.');
  }
  const reconciled = current?.id === record.id ? mergeExecutionRecord(current, record) : record;
  reserveNilePendingExecution(target, reconciled);
  const committed = saveTxEvidence(target, reconciled);
  // An old terminal transaction may be rechecked after a newer attempt exists.
  if (!historical && (!current || current.id === committed.id ||
      Date.parse(committed.createdAt) >= Date.parse(current.createdAt))) {
    target.setItem(key(record.planId, record.walletAddress), JSON.stringify(committed));
  }
  settleNilePendingExecution(target, committed);
  await onRecord(committed);
  return committed;
}

function verifyPreview(preview: NileDepositPreview, now: number) {
  actionPreviewSchema.parse(preview);
  if (preview.chain !== 'nile' || preview.source.chain !== 'nile' || preview.source.mode !== 'live' ||
      preview.asset.symbol !== 'TRX' || preview.asset.address !== null || preview.asset.decimals !== 6 ||
      preview.method !== 'mint()' || preview.approvalScope !== null || !TronWeb.isAddress(preview.contractAddress) ||
      !/^\d+$/.test(preview.feeLimitSun) || BigInt(preview.feeLimitSun) <= 0n ||
      preview.state.chainId !== '0xcd8690dc' || preview.state.contractAddress !== preview.contractAddress ||
      preview.state.jtrxDecimals !== 8 ||
      preview.state.walletAddress !== preview.walletAddress || preview.state.amountSun !== preview.amountBaseUnits ||
      preview.state.feeLimitSun !== preview.feeLimitSun || preview.state.maxFeeSun !== preview.maxFeeBaseUnits ||
      preview.state.estimatedFeeSun !== preview.estimatedFeeBaseUnits) {
    throw new Error('Nile jTRX 거래 미리보기 검증에 실패했습니다.');
  }
  if (Date.parse(preview.expiresAt) <= now) throw new PreviewChangedError(null, '거래 미리보기가 만료되었습니다. 다시 확인해 주세요.');
}

function samePreview(before: NileDepositPreview, after: NileDepositPreview): boolean {
  return before.fingerprint === after.fingerprint && before.planId === after.planId &&
    before.needsVersion === after.needsVersion && before.quoteVersion === after.quoteVersion &&
    before.walletAddress === after.walletAddress && before.chain === after.chain &&
    before.contractAddress === after.contractAddress && before.amountBaseUnits === after.amountBaseUnits &&
    before.feeLimitSun === after.feeLimitSun;
}

function checkBuiltTransaction(transaction: unknown, preview: NileDepositPreview) {
  if (!transaction || typeof transaction !== 'object') throw new Error('미서명 거래를 확인할 수 없습니다.');
  const tx = transaction as Record<string, unknown>;
  if (typeof tx.txID !== 'string' || !TX_ID_RE.test(tx.txID)) throw new Error('미서명 거래 ID가 올바르지 않습니다.');
  const raw = tx.raw_data as Record<string, unknown> | undefined;
  const calls = raw?.contract;
  if (!raw || !Array.isArray(calls) || calls.length !== 1 || raw.fee_limit !== Number(preview.feeLimitSun)) {
    throw new Error('거래의 계약 호출 또는 수수료 상한이 미리보기와 다릅니다.');
  }
  const call = calls[0] as Record<string, unknown>;
  const parameter = call?.parameter as Record<string, unknown> | undefined;
  const value = parameter?.value as Record<string, unknown> | undefined;
  const selector = TronWeb.sha3('mint()').replace(/^0x/, '').slice(0, 8).toLowerCase();
  if (call.type !== 'TriggerSmartContract' || !value ||
      value.owner_address !== TronWeb.address.toHex(preview.walletAddress) ||
      value.contract_address !== TronWeb.address.toHex(preview.contractAddress) ||
      value.call_value !== Number(preview.amountBaseUnits) ||
      String(value.data).toLowerCase().replace(/^0x/, '') !== selector) {
    throw new Error('구성된 거래의 계정·계약·금액·메서드가 미리보기와 다릅니다.');
  }
  if (typeof raw.expiration !== 'number' || raw.expiration <= Date.now()) {
    throw new Error('미서명 거래의 유효 시간이 지났습니다.');
  }
}

function isUserRejection(error: unknown): boolean {
  return !!error && typeof error === 'object' && 'code' in error && error.code === 4001;
}

function formatSun(value: string): string {
  const raw = BigInt(value);
  const fraction = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return `${raw / 1_000_000n}${fraction ? `.${fraction}` : ''}`;
}

export async function executeNileDeposit(input: {
  preview: NileDepositPreview;
  confirmPreviewId: string;
  refreshPreview: (preview: NileDepositPreview) => Promise<NileDepositPreview>;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  readOpeningObservation?: (preview: NileDepositPreview) => Promise<Observation>;
  onOpeningObservation?: (observation: Observation, record: ExecutionRecord) => void | Promise<void>;
  assertBeforeSign?: () => void;
  expectedWalletEpoch?: number;
  confirmAction?: (preview: NileDepositPreview) => boolean | Promise<boolean>;
  t?: Translate;
  approval: NileApprovalGateway;
  confirmedNeeds?: UserNeeds;
  store?: Pick<Storage, 'getItem' | 'setItem'>;
}): Promise<ExecutionRecord> {
  const { preview, refreshPreview, onRecord, store } = input;
  const t: Translate = input.t ?? (korean => korean);
  requireCurrentNilePlanId(preview.planId);
  verifyPreview(preview, Date.now());
  if (input.confirmPreviewId !== preview.id) throw new Error('사용자님이 확인한 미리보기 ID와 거래 대상이 다릅니다.');
  const walletEpoch = getWalletEpoch();
  if (input.expectedWalletEpoch !== undefined) assertWalletEpoch(input.expectedWalletEpoch);
  return withNileExecutionLock('deposit', preview.planId, preview.walletAddress, async () => {
  // The storage read belongs inside the cross-tab critical section.
  assertNoOtherNilePendingExecution(storage(store), 'deposit', preview.planId, preview.walletAddress);
  const previous = getNileExecutionRecord(preview.planId, preview.walletAddress, store);
  if (previous && ['awaiting_signature', 'submitted', 'pending', 'unknown', 'confirmed'].includes(previous.status)) {
    throw new Error('같은 계획의 원 거래가 진행 중이거나 확정되었습니다. 원 txID를 먼저 조회해 주세요.');
  }
  const record: ExecutionRecord = {
    id: crypto.randomUUID(), action: 'deposit', planId: preview.planId, previewId: preview.id,
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
    if (!samePreview(preview, refreshed)) throw new PreviewChangedError(refreshed);
    requireNileWallet(preview.walletAddress);

    const confirm = input.confirmAction ?? ((value: NileDepositPreview) => window.confirm(
      t(`Nile에서 ${formatSun(value.amountBaseUnits)} TRX를 jTRX에 예치하시겠습니까?\n` +
        `계약: ${value.contractAddress}\n예상 수수료: ${formatSun(value.estimatedFeeBaseUnits!)} TRX\n` +
        `최대 수수료: ${formatSun(value.maxFeeBaseUnits!)} TRX\n출금 시 시장 유동성이 필요합니다.`,
      `Deposit ${formatSun(value.amountBaseUnits)} TRX into jTRX on Nile?\n` +
        `Contract: ${value.contractAddress}\nEstimated fee: ${formatSun(value.estimatedFeeBaseUnits!)} TRX\n` +
        `Maximum fee: ${formatSun(value.maxFeeBaseUnits!)} TRX\nWithdrawal requires market liquidity.`),
    ));
    if (!await confirm(refreshed)) {
      record.status = 'rejected';
      record.error = '사용자님이 거래를 취소하셨습니다.';
      await save(record, onRecord, store);
      return record;
    }
    // The original confirmation expires even if the refreshed values have not changed.
    verifyPreview(preview, Date.now());
    const latest = await refreshPreview(preview);
    verifyPreview(latest, Date.now());
    if (!samePreview(preview, latest)) throw new PreviewChangedError(latest);
    if (input.readOpeningObservation) {
      const opening = await input.readOpeningObservation(latest);
      if (opening.chain !== 'nile' || opening.planId !== preview.planId ||
          opening.walletAddress !== preview.walletAddress ||
          opening.positionId !== `nile:${preview.walletAddress}:${preview.contractAddress}` ||
          opening.receiptToken.address !== preview.contractAddress || opening.source.mode !== 'live') {
        throw new Error('예치 전 같은 Nile 포지션 관측을 확인할 수 없습니다.');
      }
      if (!input.onOpeningObservation) throw new Error('예치 전 관측을 저장할 경로가 없습니다.');
      await input.onOpeningObservation(opening, record);
      verifyPreview(latest, Date.now());
    }
    await input.approval.authenticate(preview.walletAddress);
    requireNileWallet(preview.walletAddress);
    verifyPreview(latest, Date.now());
    intentId = await input.approval.reserve(preview, input.confirmPreviewId, input.confirmedNeeds);
    record.approvalIntentId = intentId;
    const web = requireNileWallet(preview.walletAddress);
    record.status = 'awaiting_signature';
    await save(record, onRecord, store);

    const amount = BigInt(preview.amountBaseUnits);
    const feeLimit = BigInt(preview.feeLimitSun);
    if (amount > BigInt(Number.MAX_SAFE_INTEGER) || feeLimit > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error('TronWeb 안전 정수 범위를 초과했습니다.');
    }
    const built = await web.transactionBuilder.triggerSmartContract(
      preview.contractAddress, 'mint()', { callValue: Number(amount), feeLimit: Number(feeLimit) }, [], preview.walletAddress,
    );
    if (built.result.result !== true) throw new Error('Nile 예치 거래 구성에 실패했습니다.');
    checkBuiltTransaction(built.transaction, preview);
    requireNileWallet(preview.walletAddress);
    assertWalletEpoch(walletEpoch);
    input.assertBeforeSign?.();
    const signed = await web.trx.sign(built.transaction);
    if (signed.txID !== built.transaction.txID || !Array.isArray(signed.signature) || signed.signature.length !== 1 ||
        signed.raw_data_hex !== built.transaction.raw_data_hex) {
      throw new Error('TronLink 서명 결과가 원 거래와 다릅니다.');
    }
    if (!intentId) throw new Error('서명 전 서버 거래 예약을 확인할 수 없습니다.');
    // Keep the signature ID tentative until the server durably acknowledges these bytes.
    tentativeTxId = signed.txID;
    const durableTxId = await input.approval.acceptSigned(intentId, preview, signed);
    if (durableTxId.toLowerCase() !== signed.txID.toLowerCase()) {
      throw new Error('서버 원장의 원 거래 ID와 TronLink 서명 결과가 다릅니다.');
    }
    record.txId = signed.txID;
    // Both the encrypted server ledger and the local evidence hold the original ID before broadcast.
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
      '방송 또는 서버 원장 응답이 불확실합니다. 새 거래를 서명하지 말고 원 txID를 조회해 주세요.';
    await save(record, onRecord, store);
    return record;
  } catch (error) {
    if (error instanceof PreviewChangedError) throw error;
    if (intentId && !record.txId && !tentativeTxId) {
      try { await input.approval.cancel(intentId); }
      catch {
        throw new Error('서명 전 거래 예약의 취소를 확인할 수 없습니다. 서버 원장을 확인하기 전 새 거래를 만들지 마세요.');
      }
    }
    if (tentativeTxId && !record.txId) record.txId = tentativeTxId;
    if (record.status === 'submitted' || record.txId) {
      record.status = 'unknown';
      record.error = '서명 또는 방송 이후 상태가 불확실합니다. 원 txID를 조회해 주세요.';
      await save(record, onRecord, store);
      return record;
    }
    if (record.status === 'awaiting_signature') {
      record.status = 'rejected';
      record.error = isUserRejection(error) ? 'TronLink 서명이 거절되었습니다.' :
        `서명 또는 방송 전 오류로 거래를 제출하지 못했습니다: ${error instanceof Error ? error.message : '알 수 없는 오류'}`;
      await save(record, onRecord, store);
      if (isUserRejection(error)) return record;
    }
    throw error;
  }
  });
}

export async function refreshNileExecutionRecord(input: {
  record: ExecutionRecord;
  approval?: NileApprovalGateway;
  readTransaction: (txId: string) => Promise<NileTransactionResult>;
  readObservation?: (record: ExecutionRecord) => Promise<Observation>;
  onRecord: (record: ExecutionRecord) => void | Promise<void>;
  store?: Pick<Storage, 'getItem' | 'setItem'>;
}): Promise<{ record: ExecutionRecord; observation: Observation | null }> {
  const requested = executionRecordSchema.parse(input.record);
  if (requested.chain !== 'nile' || !requested.txId || !TX_ID_RE.test(requested.txId)) throw new Error('조회할 Nile 원 거래 ID가 없습니다.');
  if (!['submitted', 'pending', 'unknown', 'confirmed', 'failed'].includes(requested.status)) {
    throw new Error('이 거래 상태에서는 영수증을 조회할 수 없습니다.');
  }
  const checked = await input.readTransaction(requested.txId);
  if (checked.txId.toLowerCase() !== requested.txId.toLowerCase()) throw new Error('조회 결과의 원 거래 ID가 다릅니다.');
  if (requested.approvalIntentId) {
    if (!input.approval) throw new Error('서버 원장 연결이 없어 이 거래를 확정할 수 없습니다.');
    const ledger = await input.approval.reconcile(requested.approvalIntentId, requested.walletAddress);
    if (ledger.txId?.toLowerCase() !== requested.txId.toLowerCase() ||
        (['confirmed', 'failed'].includes(checked.status) && ledger.status !== checked.status)) {
      throw new Error('원 txID의 서버 원장과 Nile 영수증 상태가 다릅니다. 다시 조회해 주세요.');
    }
  }
  return withNileExecutionLock('deposit', requested.planId, requested.walletAddress, async () => {
  const target = storage(input.store);
  const current = readTxEvidence(target, requested.txId!) ??
    getNileExecutionRecord(requested.planId, requested.walletAddress, target) ?? requested;
  if (current.id !== requested.id || current.txId?.toLowerCase() !== requested.txId?.toLowerCase()) {
    throw new Error('저장된 원 거래 ID와 조회 대상이 다릅니다.');
  }
  if ((current.status === 'confirmed' || current.status === 'failed') && checked.status !== current.status) {
    if (requested.status === current.status || checked.status === 'confirmed' || checked.status === 'failed') {
      throw new Error('확정된 거래 결과와 재조회 결과가 다릅니다. 원 txID의 영수증을 확인해 주세요.');
    }
  }
  const next = executionRecordSchema.parse({ ...current,
    status: checked.status, receipt: checked.receipt, actualFeeBaseUnits: checked.actualFeeSun,
    confirmationSource: checked.status === 'confirmed' || checked.status === 'failed' ? checked.source : current.confirmationSource,
    error: checked.reason, confirmedAt: checked.status === 'confirmed' ? checked.source.fetchedAt : current.confirmedAt,
  });
  const record = await save(next, input.onRecord, input.store);
  if (record.status !== 'confirmed' || !input.readObservation) return { record, observation: null };
  const observation = await input.readObservation(record);
  if (observation.chain !== 'nile' || observation.planId !== record.planId ||
      observation.walletAddress !== record.walletAddress || observation.source.mode !== 'live') {
    throw new Error('같은 Nile 계획과 지갑의 실제 포지션 관측이 아닙니다.');
  }
  return { record, observation };
  });
}
