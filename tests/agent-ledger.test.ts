import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { TronWeb } from 'tronweb';
import { createActionLedger, createTriggerId, type ActionIntentDraft } from '../server/agent/ledger';

const account = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const contract = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const now = () => '2026-09-29T03:00:00.000Z';
const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testPath(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gwdc-agent-ledger-'));
  createdDirectories.push(directory);
  return join(directory, 'agent.sqlite');
}

function draft(overrides: Partial<ActionIntentDraft> = {}): ActionIntentDraft {
  return {
    chain: 'nile', account, policyVersion: 1,
    triggerId: createTriggerId({ kind: 'schedule', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-100' }),
    action: 'deposit', targetPosition: `nile:${account}:${contract}`,
    positionVersion: 'block-100', planId: 'plan-1', previewId: 'preview-1',
    previewFingerprint: 'fingerprint-1', previewExpiresAt: '2026-09-29T03:01:00.000Z',
    amountBaseUnits: '80000000', maxFeeBaseUnits: '2000000',
    targetContract: contract, targetMethod: 'mint()',
    ...overrides,
  };
}

function signedTransaction() {
  const raw_data_hex = 'ab'.repeat(150);
  return {
    txID: createHash('sha256').update(Buffer.from(raw_data_hex, 'hex')).digest('hex'),
    raw_data_hex,
    signature: ['test-signature-unique-private-material'],
  };
}

describe('durable action intent ledger', () => {
  it('derives the same trigger for the same event and observation version', () => {
    const original = createTriggerId({ kind: 'schedule', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-100' });
    expect(original).toMatch(/^[0-9a-f]{64}$/);
    expect(createTriggerId({ kind: 'schedule', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-100' })).toBe(original);
    expect(createTriggerId({ kind: 'schedule', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-101' })).not.toBe(original);
    expect(createTriggerId({ kind: 'chain_event', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-100' })).not.toBe(original);
  });

  it('atomically reserves one intent and rejects changed conditions or a competing same-position intent', () => {
    const key = randomBytes(32);
    const path = testPath();
    const firstHandle = createActionLedger({ path, encryptionKey: key, now });
    const secondHandle = createActionLedger({ path, encryptionKey: key, now });
    try {
      const first = firstHandle.reserveIntent(draft());
      const alias = secondHandle.reserveIntent(draft({ account: TronWeb.address.toHex(account) }));
      expect(alias.id).toBe(first.id);
      expect(firstHandle.listEvents(first.id).map(value => value.event)).toEqual(['reserved']);
      expect(() => secondHandle.reserveIntent(draft({ amountBaseUnits: '80000001' }))).toThrow('다른 거래 조건');
      expect(() => secondHandle.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-100' }),
      }))).toThrow('미해결 거래');
      expect(() => secondHandle.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-101' }),
        positionVersion: 'block-101',
      }))).toThrow('미해결 거래');
      expect(firstHandle.getIntent(first.id)?.status).toBe('reserved');
    } finally { firstHandle.close(); secondHandle.close(); }
  });

  it('persists an encrypted original transaction before broadcast and recovers its txID after restart', () => {
    const path = testPath();
    const key = randomBytes(32);
    const transaction = signedTransaction();
    const first = createActionLedger({ path, encryptionKey: key, now });
    const intent = first.reserveIntent(draft());
    expect(() => first.recordSignedTransaction(intent.id, { ...transaction, txID: 'a'.repeat(64) })).toThrow('일치하지');
    expect(first.getIntent(intent.id)?.status).toBe('reserved');
    expect(first.recordSignedTransaction(intent.id, transaction).txId).toBe(transaction.txID);
    expect(first.recordSignedTransaction(intent.id, transaction).status).toBe('signed');
    expect(first.getIntent(intent.id)).not.toHaveProperty('signature');
    expect(first.getSignedTransaction(intent.id)).toEqual(transaction);
    expect(readFileSync(path).includes(Buffer.from('test-signature-unique-private-material'))).toBe(false);
    first.markBroadcastAttempt(intent.id);
    first.close();

    const reopened = createActionLedger({ path, encryptionKey: key, now });
    try {
      expect(reopened.listPendingRecovery()).toMatchObject([{ id: intent.id, txId: transaction.txID, status: 'broadcasting' }]);
      expect(reopened.getSignedTransaction(intent.id)).toEqual(transaction);
      expect(() => reopened.markBroadcastAttempt(intent.id)).toThrow('이미 방송');
      expect(() => reopened.cancelReservation(intent.id)).toThrow('서명 후');
      const unknown = reopened.recordBroadcastResult(intent.id, null);
      expect(unknown.status).toBe('unknown');
      expect(unknown.txId).toBe(transaction.txID);
      expect(() => reopened.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-101' }),
        positionVersion: 'block-101',
      }))).toThrow('미해결 거래');
      expect(reopened.listEvents(intent.id).map(value => value.event)).toEqual([
        'reserved', 'signed', 'broadcast_attempt', 'unknown',
      ]);
    } finally { reopened.close(); }
  });

  it('requires the original txID and immutable solidified outcome before a new observed position version', () => {
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now });
    try {
      const first = ledger.reserveIntent(draft());
      const transaction = signedTransaction();
      ledger.recordSignedTransaction(first.id, transaction);
      ledger.markBroadcastAttempt(first.id);
      ledger.recordBroadcastResult(first.id, true);
      expect(() => ledger.recordSolidifiedOutcome(first.id, {
        txId: 'f'.repeat(64), status: 'confirmed', solidifiedAt: now(), receipt: { result: 'SUCCESS' },
      })).toThrow('원 txID');
      expect(() => ledger.recordSolidifiedOutcome(first.id, {
        txId: transaction.txID, status: 'confirmed', solidifiedAt: now(), receipt: {},
      })).toThrow('비어');
      expect(ledger.recordSolidifiedOutcome(first.id, {
        txId: transaction.txID, status: 'confirmed', solidifiedAt: now(), receipt: { result: 'SUCCESS' },
      }).status).toBe('confirmed');
      expect(ledger.listPendingRecovery()).toEqual([]);
      expect(() => ledger.getSignedTransaction(first.id)).toThrow('저장된 서명 거래');
      expect(() => ledger.recordSolidifiedOutcome(first.id, {
        txId: transaction.txID, status: 'failed', solidifiedAt: now(), receipt: { result: 'REVERT' },
      })).toThrow('변경');
      expect(() => ledger.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-100' }),
      }))).toThrow('관측 버전');
      const second = ledger.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-101' }),
        positionVersion: 'block-101',
      }));
      expect(second.id).not.toBe(first.id);
    } finally { ledger.close(); }
  });

  it('only cancels an unsigned reservation and never accepts a transaction after preview expiry', () => {
    let clock = now();
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const first = ledger.reserveIntent(draft());
      expect(ledger.cancelReservation(first.id).status).toBe('cancelled');
      expect(() => ledger.reserveIntent(draft())).toThrow('취소된 거래 의도');
      const second = ledger.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-100' }),
      }));
      clock = '2026-09-29T03:02:00.000Z';
      expect(ledger.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'next-run', positionVersion: 'block-100' }),
      }))).toMatchObject({ id: second.id, status: 'reserved' });
      expect(() => ledger.recordSignedTransaction(second.id, signedTransaction())).toThrow('만료');
      expect(ledger.getIntent(second.id)?.status).toBe('reserved');
      expect(() => ledger.reserveIntent(draft({
        triggerId: createTriggerId({ kind: 'schedule', sourceId: 'later-run', positionVersion: 'block-101' }),
        positionVersion: 'block-101',
      }))).toThrow('만료');
    } finally { ledger.close(); }
  });

  it('cannot decrypt a persisted signed transaction with a different key', () => {
    const path = testPath();
    const ledger = createActionLedger({ path, encryptionKey: randomBytes(32), now });
    const intent = ledger.reserveIntent(draft());
    ledger.recordSignedTransaction(intent.id, signedTransaction());
    ledger.close();
    const wrongKey = createActionLedger({ path, encryptionKey: randomBytes(32), now });
    try {
      expect(() => wrongKey.getSignedTransaction(intent.id)).toThrow();
      expect(wrongKey.getIntent(intent.id)?.txId).toBe(signedTransaction().txID);
    } finally { wrongKey.close(); }
  });

  it('does not start a broadcast after the preview expires, even if signing finished earlier', () => {
    let clock = now();
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const intent = ledger.reserveIntent(draft());
      ledger.recordSignedTransaction(intent.id, signedTransaction());
      clock = '2026-09-29T03:02:00.000Z';
      expect(() => ledger.markBroadcastAttempt(intent.id)).toThrow('만료된 미리보기');
      expect(ledger.getIntent(intent.id)?.status).toBe('signed');
      expect(ledger.listPendingRecovery()).toMatchObject([{ id: intent.id, status: 'signed' }]);
    } finally { ledger.close(); }
  });
});
