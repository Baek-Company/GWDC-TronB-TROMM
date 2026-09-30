import { executionRecordSchema, type ExecutionRecord } from '../../../shared/schemas';
import { normalizeTronAddress } from '../../../shared/tron-address';

export type RecordStore = Pick<Storage, 'getItem' | 'setItem'> &
  { readonly length?: number; key?: (index: number) => string | null };

const TX_PREFIX = 'gwdc:nile-transaction:v1:';
const ACTIVE_PREFIX = 'gwdc:nile-active:v1:';
const DEPOSIT_PREFIX = 'gwdc:nile-execution:v1:';
const WITHDRAWAL_PREFIX = 'gwdc:nile-withdrawal:v1:';
const FINAL = new Set<ExecutionRecord['status']>(['confirmed', 'failed', 'rejected']);
const IN_FLIGHT = new Set<ExecutionRecord['status']>(['awaiting_signature', 'submitted', 'pending', 'unknown']);
const ORDER: Record<ExecutionRecord['status'], number> = {
  preview: 0, awaiting_signature: 1, submitted: 2, unknown: 3,
  pending: 4, confirmed: 5, failed: 5, rejected: 5,
};

export function requireCurrentNilePlanId(planId: string): void {
  if (!/^nile:justlend_jtrx:[^\s]+:v2:[0-9a-f]{64}$/.test(planId)) {
    throw new Error('이전 형식의 계획은 새 거래에 사용할 수 없습니다. Nile 계획을 다시 생성하고 확인해 주세요.');
  }
}

function canonicalWallet(walletAddress: string): string {
  const address = normalizeTronAddress(walletAddress);
  if (!address) throw new Error('Nile 지갑 주소를 확인할 수 없습니다. 거래를 진행하지 않습니다.');
  return address;
}

function activeKey(walletAddress: string): string {
  return `${ACTIVE_PREFIX}${canonicalWallet(walletAddress)}`;
}

function readActiveRecord(store: RecordStore, walletAddress: string): ExecutionRecord | null {
  const raw = store.getItem(activeKey(walletAddress));
  if (!raw) return null;
  try {
    const record = executionRecordSchema.parse(JSON.parse(raw));
    if (record.chain !== 'nile' || canonicalWallet(record.walletAddress) !== canonicalWallet(walletAddress)) {
      throw new Error('active wallet mismatch');
    }
    const evidence = record.txId ? readTxEvidence(store, record.txId) : null;
    return evidence ? mergeExecutionRecord(record, evidence) : record;
  } catch {
    throw new Error('지갑의 기존 Nile 거래 상태가 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.');
  }
}

function storedRecordsForWallet(store: RecordStore, walletAddress: string): ExecutionRecord[] {
  if (typeof store.length !== 'number' || typeof store.key !== 'function') return [];
  const address = canonicalWallet(walletAddress);
  const records: ExecutionRecord[] = [];
  for (let index = 0; index < store.length; index += 1) {
    const name = store.key(index);
    if (!name || (!name.startsWith(DEPOSIT_PREFIX) && !name.startsWith(WITHDRAWAL_PREFIX))) continue;
    if (normalizeTronAddress(name.slice(name.lastIndexOf(':') + 1)) !== address) continue;
    try {
      const raw = store.getItem(name);
      const parsed: unknown = JSON.parse(raw ?? 'null');
      const entries = name.startsWith(WITHDRAWAL_PREFIX) ? parsed : [parsed];
      if (!Array.isArray(entries)) throw new Error('record list mismatch');
      for (const value of entries) {
        const record = executionRecordSchema.parse(value);
        if (record.chain !== 'nile' || canonicalWallet(record.walletAddress) !== address) {
          throw new Error('record wallet mismatch');
        }
        const evidence = record.txId ? readTxEvidence(store, record.txId) : null;
        records.push(evidence ? mergeExecutionRecord(record, evidence) : record);
      }
    } catch {
      throw new Error('지갑의 저장된 Nile 거래 기록이 손상되었습니다. 원 거래를 확인하기 전 재서명하지 마세요.');
    }
  }
  return records;
}

export function assertNoOtherNilePendingExecution(
  store: RecordStore, action: 'deposit' | 'withdraw', planId: string, walletAddress: string,
): void {
  const records = [readActiveRecord(store, walletAddress), ...storedRecordsForWallet(store, walletAddress)];
  if (records.some(record => record && IN_FLIGHT.has(record.status) &&
      (record.planId !== planId || record.action !== action))) {
    throw new Error('같은 Nile 지갑의 다른 계획 또는 동작에 미확정 거래가 있습니다. 원 txID를 확인하고 확정될 때까지 새 거래를 서명하지 마세요.');
  }
}

// Save an in-flight marker before writing the per-plan record. If a later storage
// write fails, the marker conservatively blocks another plan from signing.
export function reserveNilePendingExecution(store: RecordStore, record: ExecutionRecord): void {
  if (!IN_FLIGHT.has(record.status)) return;
  const current = readActiveRecord(store, record.walletAddress);
  if (current && IN_FLIGHT.has(current.status) && current.id !== record.id) {
    throw new Error('같은 Nile 지갑의 다른 미확정 거래가 있습니다. 원 txID를 먼저 확인해 주세요.');
  }
  store.setItem(activeKey(record.walletAddress), JSON.stringify(executionRecordSchema.parse(record)));
}

export function settleNilePendingExecution(store: RecordStore, record: ExecutionRecord): void {
  if (IN_FLIGHT.has(record.status)) return;
  const current = readActiveRecord(store, record.walletAddress);
  if (current?.id === record.id) {
    store.setItem(activeKey(record.walletAddress), JSON.stringify(executionRecordSchema.parse(record)));
  }
}

export async function withNileExecutionLock<T>(
  action: 'deposit' | 'withdraw', planId: string, walletAddress: string, task: () => Promise<T>,
): Promise<T> {
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks;
  if (!locks?.request) {
    throw new Error('이 브라우저는 탭 간 거래 잠금을 지원하지 않습니다. 안전한 거래 실행을 위해 지원 브라우저를 사용해 주세요.');
  }
  // One lock per Nile account serializes every plan and both transaction actions.
  const name = `gwdc:nile:wallet:${canonicalWallet(walletAddress)}`;
  return locks.request(name, { mode: 'exclusive', ifAvailable: true }, async lock => {
    if (!lock) throw new Error('다른 탭에서 같은 Nile 지갑의 거래가 진행 중입니다. 해당 탭과 원 txID를 확인해 주세요.');
    return task();
  });
}

export function mergeExecutionRecord(current: ExecutionRecord, next: ExecutionRecord): ExecutionRecord {
  if (current.id !== next.id || current.action !== next.action || current.planId !== next.planId ||
      current.walletAddress !== next.walletAddress || current.chain !== next.chain) {
    throw new Error('저장된 거래 기록과 새 기록의 대상이 다릅니다.');
  }
  if (current.txId && next.txId && current.txId.toLowerCase() !== next.txId.toLowerCase()) {
    throw new Error('같은 거래 기록에 서로 다른 txID가 있습니다. 원 거래를 확인해 주세요.');
  }
  if (FINAL.has(current.status) && next.status !== current.status) return current;
  if (current.txId && !next.txId) return current;
  if (ORDER[next.status] < ORDER[current.status]) return current;
  return executionRecordSchema.parse({
    ...next,
    amountBaseUnits: next.amountBaseUnits ?? current.amountBaseUnits,
    contractAddress: next.contractAddress ?? current.contractAddress,
    confirmationSource: next.confirmationSource ?? current.confirmationSource,
    txId: next.txId ?? current.txId,
    receipt: next.receipt ?? current.receipt,
    actualFeeBaseUnits: next.actualFeeBaseUnits ?? current.actualFeeBaseUnits,
    submittedAt: next.submittedAt ?? current.submittedAt,
    confirmedAt: next.confirmedAt ?? current.confirmedAt,
  });
}

export function readTxEvidence(store: RecordStore, txId: string): ExecutionRecord | null {
  const value = store.getItem(`${TX_PREFIX}${txId.toLowerCase()}`);
  if (!value) return null;
  try {
    const record = executionRecordSchema.parse(JSON.parse(value));
    if (record.txId?.toLowerCase() !== txId.toLowerCase()) throw new Error('txID mismatch');
    return record;
  } catch {
    throw new Error('원 txID별 저장 기록이 손상되었습니다. 새 서명 전에 거래 상태를 확인해 주세요.');
  }
}

export function saveTxEvidence(store: RecordStore, record: ExecutionRecord): ExecutionRecord {
  const validated = executionRecordSchema.parse(record);
  if (!validated.txId) return validated;
  const current = readTxEvidence(store, validated.txId);
  const merged = current ? mergeExecutionRecord(current, validated) : validated;
  store.setItem(`${TX_PREFIX}${validated.txId.toLowerCase()}`, JSON.stringify(merged));
  return merged;
}
