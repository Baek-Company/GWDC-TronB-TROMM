import { afterEach, describe, expect, it, vi } from 'vitest';
import { NILE_JTRX_CANDIDATE } from '../server/transactions';
import type { ExecutionRecord } from '../shared/schemas';
import { listNileUnresolvedIntents, verifyNileUnresolvedIntent,
  type NileApprovalGateway, type NileUnresolvedIntent } from '../src/features/execution/approval-api';
import { cancelNileDepositReservation, getNileExecutionRecord,
  synchronizeNileDepositIntent } from '../src/features/execution';
import { getNileWithdrawalRecord, refreshNileWithdrawalRecord,
  cancelNileWithdrawalReservation, synchronizeNileWithdrawalIntent } from '../src/features/execution/withdraw';
import { assertNoOtherNilePendingExecution } from '../src/features/execution/safety';

const wallet = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const contract = NILE_JTRX_CANDIDATE;
const planId = `nile:justlend_jtrx:80_20:v2:${'c'.repeat(64)}`;
const txId = 'a'.repeat(64);
const now = '2026-09-30T00:00:00.000Z';
const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: now, sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const };

function intent(action: 'deposit' | 'withdraw', status: NileUnresolvedIntent['status']): NileUnresolvedIntent {
  return {
    id: 'b'.repeat(64), chain: 'nile', account: wallet, action, status,
    txId: status === 'reserved' ? null : txId,
    planId, quoteVersion: 'quote-1', previewId: 'preview-1',
    amountBaseUnits: action === 'deposit' ? '80000000' : '50000000',
    targetContract: contract, targetPosition: `nile:${wallet}:${contract}`,
    targetMethod: action === 'deposit' ? 'mint()' : 'redeem(uint256)',
    previewExpiresAt: '2026-09-30T00:03:00.000Z', createdAt: now, updatedAt: now,
  };
}

function memoryStore() {
  const data = new Map<string, string>();
  return { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); },
    get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null };
}

function installLocks() {
  const held = new Set<string>();
  vi.stubGlobal('navigator', { locks: { request: async <T>(name: string, _options: unknown,
    callback: (lock: { name: string } | null) => Promise<T>) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); }
    finally { held.delete(name); }
  } } });
}

afterEach(() => vi.unstubAllGlobals());

describe('Nile approval server recovery', () => {
  it('accepts only the connected account and coherent unresolved txID state', async () => {
    const signed = intent('deposit', 'signed');
    expect(verifyNileUnresolvedIntent(signed, wallet).txId).toBe(txId);
    expect(() => verifyNileUnresolvedIntent({ ...signed, txId: null }, wallet)).toThrow();
    expect(() => verifyNileUnresolvedIntent({ ...signed, targetPosition: 'nile:other' }, wallet)).toThrow();
    expect(() => verifyNileUnresolvedIntent(signed, contract)).toThrow();

    vi.stubGlobal('window', { tron: { isTronLink: true, tronWeb: {
      defaultAddress: { base58: wallet }, fullNode: { host: 'https://nile.trongrid.io' },
    } } });
    const fetchMock = vi.fn(async (_url: string, options: RequestInit) => {
      expect(options.method).toBe('GET');
      expect(options.credentials).toBe('same-origin');
      return { ok: true, status: 200, json: async () => ({ intents: [signed] }) };
    });
    vi.stubGlobal('fetch', fetchMock);
    await expect(listNileUnresolvedIntents(wallet)).resolves.toMatchObject([{ id: signed.id, txId }]);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('reconstructs a reserved deposit, then releases it only after server cancellation succeeds', async () => {
    installLocks();
    const store = memoryStore();
    const reserved = intent('deposit', 'reserved');
    const onRecord = vi.fn();
    const recovered = await synchronizeNileDepositIntent({ intent: reserved, onRecord, store });
    expect(recovered).toMatchObject({ status: 'awaiting_signature', txId: null,
      approvalIntentId: reserved.id, planId });
    let unavailable = true;
    const cancel = vi.fn(async () => { if (unavailable) throw new Error('server unavailable'); });
    const approval = { cancel } as unknown as NileApprovalGateway;
    await expect(cancelNileDepositReservation({ intent: reserved, approval, onRecord, store }))
      .rejects.toThrow('server unavailable');
    expect(getNileExecutionRecord(planId, wallet, store)?.status).toBe('awaiting_signature');
    unavailable = false;
    const cancelled = await cancelNileDepositReservation({ intent: reserved, approval, onRecord, store });
    expect(cancelled.status).toBe('rejected');
    expect(getNileExecutionRecord(planId, wallet, store)?.status).toBe('rejected');
    expect(() => assertNoOtherNilePendingExecution(store, 'withdraw', planId, wallet)).not.toThrow();
  });

  it('restores the durable txID without signing and rejects a mismatched local record', async () => {
    installLocks();
    const store = memoryStore();
    const signed = intent('deposit', 'signed');
    const recovered = await synchronizeNileDepositIntent({ intent: signed, onRecord: () => {}, store });
    expect(recovered).toMatchObject({ status: 'unknown', txId, approvalIntentId: signed.id });
    expect(getNileExecutionRecord(planId, wallet, store)?.txId).toBe(txId);
    const conflicting: ExecutionRecord = { ...recovered, txId: null, status: 'awaiting_signature',
      amountBaseUnits: '70000000', submittedAt: null };
    const corruptStore = memoryStore();
    corruptStore.setItem(`gwdc:nile-execution:v1:${planId}:${wallet}`, JSON.stringify(conflicting));
    await expect(synchronizeNileDepositIntent({ intent: signed, onRecord: () => {}, store: corruptStore }))
      .rejects.toThrow('다릅니다');
  });

  it('cancels a server-reserved deposit after a tentative signature without treating the ID as broadcast', async () => {
    installLocks();
    const store = memoryStore();
    const reserved = intent('deposit', 'reserved');
    const tentative: ExecutionRecord = {
      id: 'local-attempt', action: 'deposit', planId, previewId: reserved.previewId,
      walletAddress: wallet, chain: 'nile', approvalIntentId: reserved.id, txId,
      amountBaseUnits: reserved.amountBaseUnits, contractAddress: contract,
      status: 'unknown', receipt: null, actualFeeBaseUnits: null,
      createdAt: now, submittedAt: null, confirmedAt: null,
      error: '서버 서명 접수 결과 불명확',
    };
    store.setItem(`gwdc:nile-execution:v1:${planId}:${wallet}`, JSON.stringify(tentative));
    const recovered = await synchronizeNileDepositIntent({ intent: reserved, onRecord: () => {}, store });
    expect(recovered).toMatchObject({ status: 'unknown', txId, submittedAt: null });
    expect(recovered.error).toContain('접수하지 않았');
    const cancel = vi.fn(async () => {});
    const approval = { cancel } as unknown as NileApprovalGateway;
    const cancelled = await cancelNileDepositReservation({ intent: reserved, approval,
      onRecord: () => {}, store });
    expect(cancel).toHaveBeenCalledWith(reserved.id);
    expect(cancelled).toMatchObject({ status: 'rejected', txId, submittedAt: null });
    expect(getNileExecutionRecord(planId, wallet, store)?.status).toBe('rejected');
    expect(() => assertNoOtherNilePendingExecution(store, 'withdraw', planId, wallet)).not.toThrow();

    const contradictory = memoryStore();
    contradictory.setItem(`gwdc:nile-execution:v1:${planId}:${wallet}`,
      JSON.stringify({ ...tentative, submittedAt: now }));
    await expect(synchronizeNileDepositIntent({ intent: reserved, onRecord: () => {}, store: contradictory }))
      .rejects.toThrow('다릅니다');
  });

  it('promotes a tentative local ID only when the server reports the same durably signed txID', async () => {
    installLocks();
    const store = memoryStore();
    const signed = intent('deposit', 'signed');
    const tentative: ExecutionRecord = {
      id: 'local-attempt', action: 'deposit', planId, previewId: signed.previewId,
      walletAddress: wallet, chain: 'nile', approvalIntentId: signed.id, txId,
      amountBaseUnits: signed.amountBaseUnits, contractAddress: contract,
      status: 'unknown', receipt: null, actualFeeBaseUnits: null,
      createdAt: now, submittedAt: null, confirmedAt: null, error: '접수 응답 불명확',
    };
    store.setItem(`gwdc:nile-execution:v1:${planId}:${wallet}`, JSON.stringify(tentative));
    const recovered = await synchronizeNileDepositIntent({ intent: signed, onRecord: () => {}, store });
    expect(recovered).toMatchObject({ status: 'unknown', txId, submittedAt: signed.updatedAt });
    const conflicting = memoryStore();
    conflicting.setItem(`gwdc:nile-execution:v1:${planId}:${wallet}`,
      JSON.stringify({ ...tentative, txId: 'd'.repeat(64) }));
    await expect(synchronizeNileDepositIntent({ intent: signed, onRecord: () => {}, store: conflicting }))
      .rejects.toThrow('다릅니다');
  });

  it('cancels a server-reserved withdrawal after a tentative signature without losing its local history', async () => {
    installLocks();
    const store = memoryStore();
    const reserved = intent('withdraw', 'reserved');
    const tentative: ExecutionRecord = {
      id: 'local-withdrawal', action: 'withdraw', planId, previewId: reserved.previewId,
      walletAddress: wallet, chain: 'nile', approvalIntentId: reserved.id, txId,
      amountBaseUnits: reserved.amountBaseUnits, contractAddress: contract,
      status: 'unknown', receipt: null, actualFeeBaseUnits: null,
      createdAt: now, submittedAt: null, confirmedAt: null,
      error: '서버 서명 접수 결과 불명확',
    };
    store.setItem(`gwdc:nile-withdrawal:v1:${planId}:${wallet}`, JSON.stringify([tentative]));
    const recovered = await synchronizeNileWithdrawalIntent({ intent: reserved, onRecord: () => {}, store });
    expect(recovered).toMatchObject({ status: 'unknown', txId, submittedAt: null });
    const cancel = vi.fn(async () => {});
    const approval = { cancel } as unknown as NileApprovalGateway;
    const cancelled = await cancelNileWithdrawalReservation({ intent: reserved, approval,
      onRecord: () => {}, store });
    expect(cancelled).toMatchObject({ status: 'rejected', txId, submittedAt: null });
    expect(getNileWithdrawalRecord(planId, wallet, store)?.status).toBe('rejected');
    expect(() => assertNoOtherNilePendingExecution(store, 'deposit', planId, wallet)).not.toThrow();
  });

  it('recovers a signed withdrawal even when its saved preview is absent, for txID-only recheck', async () => {
    installLocks();
    const store = memoryStore();
    const signed = intent('withdraw', 'signed');
    const recovered = await synchronizeNileWithdrawalIntent({ intent: signed, onRecord: () => {}, store });
    expect(recovered).toMatchObject({ status: 'unknown', txId, approvalIntentId: signed.id });
    expect(getNileWithdrawalRecord(planId, wallet, store)?.txId).toBe(txId);
    const approval = { reconcile: vi.fn(async () => ({ status: 'confirmed', txId })) } as unknown as NileApprovalGateway;
    const checked = await refreshNileWithdrawalRecord({ record: recovered, approval, store,
      onRecord: () => {}, readTransaction: async () => ({ txId, status: 'confirmed',
        receipt: { id: txId, receipt: { result: 'SUCCESS' } }, actualFeeSun: '20000',
        reason: null, source }) });
    expect(checked.record.status).toBe('confirmed');
    expect(checked.observation).toBeNull();
  });
});
