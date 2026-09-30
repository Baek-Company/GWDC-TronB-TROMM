import { createHash, randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { createActionLedger, createTriggerId, type ActionIntentDraft } from '../server/agent/ledger';
import { readNileLedgerPolicyInputs } from '../server/agent/scheduler';
import { NILE_JTRX_CANDIDATE } from '../server/transactions';

const account = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const otherAccount = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const target = `nile:${account}:${NILE_JTRX_CANDIDATE}`;
const cycleA = '2026-09-29T23:00:00.000Z';
const cycleB = '2026-09-30T00:00:00.000Z';
const createdDirectories: string[] = [];

afterEach(() => {
  for (const directory of createdDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function testPath() {
  const directory = mkdtempSync(join(tmpdir(), 'gwdc-ledger-usage-'));
  createdDirectories.push(directory);
  return join(directory, 'ledger.sqlite');
}

function draft(label: string, overrides: Partial<ActionIntentDraft> = {}): ActionIntentDraft {
  return {
    chain: 'nile', account, policyVersion: 1,
    triggerId: createTriggerId({ kind: 'schedule', sourceId: label, positionVersion: `position-${label}` }),
    action: 'deposit', targetPosition: target, positionVersion: `position-${label}`, cycleId: cycleA,
    planId: 'plan-1', previewId: `preview-${label}`, previewFingerprint: `fingerprint-${label}`,
    previewExpiresAt: '2026-09-30T00:01:00.000Z', amountBaseUnits: '80000000',
    maxFeeBaseUnits: '2000000', targetContract: NILE_JTRX_CANDIDATE, targetMethod: 'mint()',
    ...overrides,
  };
}

function signedTransaction() {
  const raw_data_hex = 'ab'.repeat(150);
  return { txID: createHash('sha256').update(Buffer.from(raw_data_hex, 'hex')).digest('hex'),
    raw_data_hex, signature: ['test-signature'] };
}

describe('ledger policy projection', () => {
  it('counts confirmed, failed, pending, and UTC-crossing actions once in the scoped target', () => {
    let clock = '2026-09-29T23:59:30.000Z';
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const confirmed = ledger.reserveIntent(draft('confirmed', { amountBaseUnits: '80000000' }));
      const tx = signedTransaction();
      ledger.recordSignedTransaction(confirmed.id, tx);
      ledger.markBroadcastAttempt(confirmed.id);
      ledger.recordBroadcastResult(confirmed.id, true);
      clock = '2026-09-30T00:00:10.000Z';
      ledger.recordSolidifiedOutcome(confirmed.id, { txId: tx.txID, status: 'confirmed',
        solidifiedAt: clock, receipt: { result: 'SUCCESS' } });

      const failed = ledger.reserveIntent(draft('failed', { cycleId: cycleB,
        amountBaseUnits: '60000000', action: 'withdraw', targetMethod: 'redeem(uint256)' }));
      const tx2 = { ...signedTransaction(), raw_data_hex: 'cd'.repeat(150) };
      tx2.txID = createHash('sha256').update(Buffer.from(tx2.raw_data_hex, 'hex')).digest('hex');
      ledger.recordSignedTransaction(failed.id, tx2);
      ledger.markBroadcastAttempt(failed.id);
      clock = '2026-09-30T00:00:15.000Z';
      ledger.recordSolidifiedOutcome(failed.id, { txId: tx2.txID, status: 'failed',
        solidifiedAt: clock, receipt: { result: 'REVERT' } });

      clock = '2026-09-30T00:00:20.000Z';
      const pending = ledger.reserveIntent(draft('pending', { cycleId: '2026-09-30T00:00:20.000Z',
        amountBaseUnits: '25000000' }));
      expect(ledger.reserveIntent(draft('pending', { cycleId: '2026-09-30T00:00:20.000Z',
        amountBaseUnits: '25000000' })).id).toBe(pending.id);

      const snapshot = ledger.readNilePolicySnapshot({ account, policyVersion: 1, targetPosition: target });
      expect(snapshot.usage).toMatchObject({
        utcDay: '2026-09-30', confirmedDepositSunToday: '80000000', confirmedDepositSunTotal: '80000000',
        pendingDepositSunToday: '25000000', pendingDepositSunTotal: '25000000',
        confirmedActionsToday: 1, confirmedActionsTotal: 1, failedActionsToday: 1, failedActionsTotal: 1,
        pendingActionsToday: 1, pendingActionsTotal: 1, latestSettledAt: '2026-09-30T00:00:15.000Z',
      });
      expect(snapshot.usage.usedCycleIds).toEqual([cycleA, cycleB, '2026-09-30T00:00:20.000Z']);
      expect(snapshot.unresolvedIntents.map(intent => intent.id)).toEqual([pending.id]);
      expect(() => ledger.reserveIntent(draft('same-cycle-new-position', { cycleId: cycleB })))
        .toThrow('미해결 거래');
    } finally { ledger.close(); }
  });

  it('blocks a second action in a settled UTC cycle after the position version changes', () => {
    const clock = '2026-09-29T23:59:30.000Z';
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const first = ledger.reserveIntent(draft('first'));
      const tx = signedTransaction();
      ledger.recordSignedTransaction(first.id, tx);
      ledger.markBroadcastAttempt(first.id);
      ledger.recordSolidifiedOutcome(first.id, { txId: tx.txID, status: 'confirmed',
        solidifiedAt: clock, receipt: { result: 'SUCCESS' } });
      expect(() => ledger.reserveIntent(draft('different-position-version', { cycleId: cycleA })))
        .toThrow('같은 UTC 주기');
    } finally { ledger.close(); }
  });

  it('keeps an unresolved reservation in the next UTC day and removes cancelled reservations from usage', () => {
    let clock = '2026-09-29T23:59:30.000Z';
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const pending = ledger.reserveIntent(draft('carried-pending'));
      clock = '2026-09-30T00:00:20.000Z';
      const snapshot = ledger.readNilePolicySnapshot({ account, policyVersion: 1, targetPosition: target });
      expect(snapshot.usage).toMatchObject({ utcDay: '2026-09-30',
        pendingDepositSunToday: '80000000', pendingDepositSunTotal: '80000000',
        pendingActionsToday: 1, pendingActionsTotal: 1 });
      expect(snapshot.unresolvedIntents).toHaveLength(1);
      ledger.cancelReservation(pending.id);
      const cleared = ledger.readNilePolicySnapshot({ account, policyVersion: 1, targetPosition: target });
      expect(cleared.usage.pendingDepositSunToday).toBe('0');
      expect(cleared.usage.pendingActionsTotal).toBe(0);
      expect(cleared.usage.usedCycleIds).toEqual([]);
    } finally { ledger.close(); }
  });

  it('filters policy/account/target usage while exposing other unresolved actions on the same account', () => {
    const clock = '2026-09-29T23:59:30.000Z';
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => clock });
    try {
      const scoped = ledger.reserveIntent(draft('scoped'));
      const otherPolicy = ledger.reserveIntent(draft('other-policy', { policyVersion: 2,
        targetPosition: `nile:${account}:${otherAccount}` }));
      ledger.reserveIntent(draft('other-account', { account: otherAccount,
        targetPosition: `nile:${otherAccount}:${NILE_JTRX_CANDIDATE}` }));
      const snapshot = ledger.readNilePolicySnapshot({ account, policyVersion: 1, targetPosition: target });
      expect(snapshot.usage.pendingDepositSunTotal).toBe('80000000');
      expect(snapshot.unresolvedIntents.map(intent => intent.id).sort()).toEqual([scoped.id, otherPolicy.id].sort());
      const adapted = readNileLedgerPolicyInputs(ledger, { version: 1, testWalletAddress: account });
      expect(adapted.ledgerAvailable).toBe(true);
      expect(adapted.usage?.pendingActionsTotal).toBe(1);
      expect(adapted.unresolvedIntents).toHaveLength(2);
    } finally { ledger.close(); }
    expect(readNileLedgerPolicyInputs(ledger, { version: 1, testWalletAddress: account }))
      .toEqual({ ledgerAvailable: false, usage: null, unresolvedIntents: null });
  });

  it('migrates an older local action_intents table without a cycle column', () => {
    const path = testPath();
    const old = new DatabaseSync(path);
    old.exec(`CREATE TABLE action_intents (
      id TEXT PRIMARY KEY, chain TEXT NOT NULL, account TEXT NOT NULL, policy_version INTEGER NOT NULL,
      trigger_id TEXT NOT NULL, action TEXT NOT NULL, target_position TEXT NOT NULL,
      position_version TEXT NOT NULL, draft_json TEXT NOT NULL, draft_digest TEXT NOT NULL,
      status TEXT NOT NULL, tx_id TEXT UNIQUE, signed_digest TEXT, signed_iv BLOB, signed_tag BLOB,
      signed_ciphertext BLOB, broadcast_started_at TEXT, receipt_json TEXT, solidified_at TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    old.close();
    const ledger = createActionLedger({ path, encryptionKey: randomBytes(32),
      now: () => '2026-09-29T23:59:30.000Z' });
    try {
      expect(ledger.reserveIntent(draft('migrated')).cycleId).toBe(cycleA);
      expect(ledger.readNilePolicySnapshot({ account, policyVersion: 1, targetPosition: target })
        .usage.pendingActionsTotal).toBe(1);
    } finally { ledger.close(); }
  });
});
