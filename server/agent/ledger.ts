import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, lstatSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { chainSchema, instantSchema } from '../../shared/schemas';

const hex64 = /^[0-9a-f]{64}$/i;
const unsignedInteger = /^\d+$/;
const actionSchema = z.enum(['approve', 'swap_in', 'deposit', 'withdraw', 'swap_out', 'revoke']);
const nonempty = z.string().trim().min(1);

const intentDraftSchema = z.object({
  chain: chainSchema,
  account: nonempty,
  policyVersion: z.number().int().positive(),
  triggerId: z.string().regex(hex64),
  action: actionSchema,
  targetPosition: nonempty,
  positionVersion: nonempty,
  // Required by the coordinator before it can confirm a successful position-changing transaction.
  // Optional for older ledger rows; those rows remain unresolved until independently reconciled.
  receiptBalanceBeforeBaseUnits: z.string().regex(unsignedInteger).optional(),
  cycleId: instantSchema.nullable().optional(),
  planId: nonempty,
  needsDigest: z.string().regex(hex64).optional(),
  quoteVersion: nonempty.optional(),
  planCheck: z.enum(['matched_current_needs', 'matched_prior_deposit']).optional(),
  previewId: nonempty,
  previewFingerprint: nonempty,
  previewExpiresAt: instantSchema,
  amountBaseUnits: z.string().regex(unsignedInteger).refine(value => BigInt(value) > 0n),
  maxFeeBaseUnits: z.string().regex(unsignedInteger),
  targetContract: nonempty,
  targetMethod: nonempty,
});

export type ActionIntentDraft = z.infer<typeof intentDraftSchema>;
export type ActionIntentStatus =
  | 'reserved' | 'signed' | 'broadcasting' | 'pending' | 'unknown'
  | 'confirmed' | 'failed' | 'cancelled';

export interface ActionIntent extends ActionIntentDraft {
  id: string;
  status: ActionIntentStatus;
  txId: string | null;
  signedDigest: string | null;
  broadcastStartedAt: string | null;
  createdAt: string;
  updatedAt: string;
  solidifiedAt: string | null;
  receipt: unknown | null;
}

export interface SolidifiedOutcome {
  txId: string;
  status: 'confirmed' | 'failed';
  solidifiedAt: string;
  receipt: Record<string, unknown>;
}

export interface LedgerPolicyUsage {
  source: 'ledger';
  verified: true;
  chain: 'mainnet' | 'nile';
  account: string;
  policyVersion: number;
  asOf: string;
  utcDay: string;
  confirmedDepositSunToday: string;
  confirmedDepositSunTotal: string;
  pendingDepositSunToday: string;
  pendingDepositSunTotal: string;
  confirmedActionsToday: number;
  confirmedActionsTotal: number;
  failedActionsToday: number;
  failedActionsTotal: number;
  pendingActionsToday: number;
  pendingActionsTotal: number;
  latestSettledAt: string | null;
  usedCycleIds: string[];
}

type Row = Record<string, unknown>;

function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function accountAddress(value: string): string {
  if (!TronWeb.isAddress(value)) throw new Error('유효한 TRON 계정 주소가 필요합니다.');
  return TronWeb.address.fromHex(TronWeb.address.toHex(value));
}

function canonicalDraft(input: ActionIntentDraft): ActionIntentDraft {
  const value = intentDraftSchema.parse(input);
  if (!TronWeb.isAddress(value.targetContract)) throw new Error('유효한 대상 계약 주소가 필요합니다.');
  return {
    ...value,
    account: accountAddress(value.account),
    targetContract: accountAddress(value.targetContract),
  };
}

/** A scheduled bucket or chain event and its observed position version have one stable trigger ID. */
export function createTriggerId(input: {
  kind: 'schedule' | 'chain_event'; sourceId: string; positionVersion: string;
}): string {
  if (!input.sourceId.trim() || !input.positionVersion.trim()) throw new Error('트리거 원천과 포지션 버전이 필요합니다.');
  return digest(JSON.stringify([input.kind, input.sourceId, input.positionVersion]));
}

function intentId(input: ActionIntentDraft): string {
  return digest(JSON.stringify([
    input.chain, input.account, input.policyVersion, input.triggerId, input.action, input.targetPosition,
  ]));
}

function rowToIntent(row: Row): ActionIntent {
  const draft = JSON.parse(String(row.draft_json)) as ActionIntentDraft;
  return {
    ...draft,
    id: String(row.id),
    status: row.status as ActionIntentStatus,
    txId: row.tx_id === null ? null : String(row.tx_id),
    signedDigest: row.signed_digest === null ? null : String(row.signed_digest),
    broadcastStartedAt: row.broadcast_started_at === null ? null : String(row.broadcast_started_at),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
    solidifiedAt: row.solidified_at === null ? null : String(row.solidified_at),
    receipt: row.receipt_json === null ? null : JSON.parse(String(row.receipt_json)) as unknown,
  };
}

function signedPayload(input: unknown): { txId: string; serialized: string; digest: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('서명 거래 객체가 필요합니다.');
  const tx = input as Record<string, unknown>;
  if (typeof tx.txID !== 'string' || !hex64.test(tx.txID) ||
      typeof tx.raw_data_hex !== 'string' || !/^(?:[0-9a-f]{2})+$/i.test(tx.raw_data_hex) ||
      !Array.isArray(tx.signature) || tx.signature.length === 0 ||
      tx.signature.some(signature => typeof signature !== 'string' || signature.length === 0)) {
    throw new Error('원 txID, raw_data_hex, 서명을 확인할 수 없습니다.');
  }
  const txId = tx.txID.toLowerCase();
  if (digest(Buffer.from(tx.raw_data_hex, 'hex')) !== txId) {
    throw new Error('원 txID가 서명 거래 원문과 일치하지 않습니다.');
  }
  const serialized = JSON.stringify(input);
  return { txId, serialized, digest: digest(serialized) };
}

/**
 * Durable local intent ledger. It stores signed transaction bytes encrypted at rest, but does not
 * validate contract calldata against a preview or hold a signing key. The caller must perform
 * those checks before recordSignedTransaction and must not broadcast until markBroadcastAttempt
 * commits. A broadcasting/unknown transaction is reconciled by its original txID only.
 */
export function createActionLedger(input: { path: string; encryptionKey: Uint8Array; now?: () => string }) {
  if (input.encryptionKey.byteLength !== 32) throw new Error('원장 암호화 키는 32바이트여야 합니다.');
  const key = Buffer.from(input.encryptionKey);
  const now = input.now ?? (() => new Date().toISOString());
  if (input.path !== ':memory:') {
    if (existsSync(input.path) && lstatSync(input.path).isSymbolicLink()) throw new Error('원장 경로는 심볼릭 링크일 수 없습니다.');
    mkdirSync(dirname(input.path), { recursive: true, mode: 0o700 });
  }
  const db = new DatabaseSync(input.path, { timeout: 5000, enableForeignKeyConstraints: true });
  if (input.path !== ':memory:') chmodSync(input.path, 0o600);
  db.exec('PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS action_intents (
      id TEXT PRIMARY KEY,
      chain TEXT NOT NULL,
      account TEXT NOT NULL,
      policy_version INTEGER NOT NULL,
      trigger_id TEXT NOT NULL,
      action TEXT NOT NULL,
      target_position TEXT NOT NULL,
      position_version TEXT NOT NULL,
      cycle_id TEXT,
      draft_json TEXT NOT NULL,
      draft_digest TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('reserved','signed','broadcasting','pending','unknown','confirmed','failed','cancelled')),
      tx_id TEXT UNIQUE,
      signed_digest TEXT,
      signed_iv BLOB,
      signed_tag BLOB,
      signed_ciphertext BLOB,
      broadcast_started_at TEXT,
      receipt_json TEXT,
      solidified_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      UNIQUE (chain, account, policy_version, trigger_id, action, target_position)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_action_per_position_version
      ON action_intents(chain, account, target_position, position_version)
      WHERE status != 'cancelled';
    CREATE UNIQUE INDEX IF NOT EXISTS one_unresolved_per_position
      ON action_intents(chain, account, target_position)
      WHERE status IN ('reserved','signed','broadcasting','pending','unknown');
    CREATE INDEX IF NOT EXISTS action_intents_recovery
      ON action_intents(status, created_at);
    CREATE TABLE IF NOT EXISTS action_intent_events (
      sequence INTEGER PRIMARY KEY AUTOINCREMENT,
      intent_id TEXT NOT NULL REFERENCES action_intents(id),
      event TEXT NOT NULL,
      occurred_at TEXT NOT NULL,
      detail_json TEXT NOT NULL
    );
  `);
  // Existing local ledgers predate the scheduler cycle field. The index is created after migration.
  const columns = db.prepare('PRAGMA table_info(action_intents)').all() as Row[];
  if (!columns.some(column => column.name === 'cycle_id')) db.exec('ALTER TABLE action_intents ADD COLUMN cycle_id TEXT');
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS one_action_per_cycle
    ON action_intents(chain, account, policy_version, target_position, cycle_id)
    WHERE cycle_id IS NOT NULL AND status != 'cancelled'`);

  const select = db.prepare('SELECT * FROM action_intents WHERE id = ?');
  const event = db.prepare('INSERT INTO action_intent_events(intent_id,event,occurred_at,detail_json) VALUES (?,?,?,?)');

  function timestamp(): string { return new Date(instantSchema.parse(now())).toISOString(); }
  function read(id: string): Row {
    const row = select.get(id) as Row | undefined;
    if (!row) throw new Error('거래 의도를 찾을 수 없습니다.');
    return row;
  }
  function transaction<T>(fn: () => T): T {
    db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); db.exec('COMMIT'); return result; }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }

  function reserveIntent(draftInput: ActionIntentDraft): ActionIntent {
    const draft = canonicalDraft(draftInput);
    const at = timestamp();
    const id = intentId(draft);
    const serialized = JSON.stringify(draft);
    const specDigest = digest(serialized);
    return transaction(() => {
      const existing = select.get(id) as Row | undefined;
      if (existing) {
        if (existing.draft_digest !== specDigest) throw new Error('같은 트리거에 다른 거래 조건을 예약할 수 없습니다.');
        if (existing.status === 'cancelled') throw new Error('취소된 거래 의도를 다시 예약할 수 없습니다. 새 트리거가 필요합니다.');
        return rowToIntent(existing);
      }
      if (Date.parse(draft.previewExpiresAt) <= Date.parse(at)) throw new Error('만료된 미리보기로 거래 의도를 예약할 수 없습니다.');
      const blocker = db.prepare(`SELECT id FROM action_intents WHERE chain=? AND account=? AND target_position=? AND
        (position_version=? AND status!='cancelled' OR status IN ('reserved','signed','broadcasting','pending','unknown')) LIMIT 1`)
        .get(draft.chain, draft.account, draft.targetPosition, draft.positionVersion) as Row | undefined;
      if (blocker) throw new Error('같은 포지션에 미해결 거래 또는 이미 사용한 관측 버전이 있습니다. 원 txID를 먼저 확인해 주세요.');
      if (draft.cycleId) {
        const usedCycle = db.prepare(`SELECT id FROM action_intents WHERE chain=? AND account=? AND policy_version=?
          AND target_position=? AND cycle_id=? AND status!='cancelled' LIMIT 1`)
          .get(draft.chain, draft.account, draft.policyVersion, draft.targetPosition, draft.cycleId) as Row | undefined;
        if (usedCycle) throw new Error('같은 UTC 주기에 이미 거래 의도가 있습니다.');
      }
      db.prepare(`INSERT INTO action_intents
        (id,chain,account,policy_version,trigger_id,action,target_position,position_version,cycle_id,draft_json,draft_digest,status,created_at,updated_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, draft.chain, draft.account, draft.policyVersion, draft.triggerId, draft.action,
        draft.targetPosition, draft.positionVersion, draft.cycleId ?? null, serialized, specDigest, 'reserved', at, at,
      );
      event.run(id, 'reserved', at, '{}');
      return rowToIntent(read(id));
    });
  }

  function recordSignedTransaction(id: string, signedTransaction: unknown): ActionIntent {
    const signed = signedPayload(signedTransaction);
    return transaction(() => {
      const current = read(id);
      if (current.status === 'signed' && current.tx_id === signed.txId && current.signed_digest === signed.digest) {
        return rowToIntent(current);
      }
      if (current.status !== 'reserved') throw new Error('이 거래 의도에는 새 서명을 기록할 수 없습니다.');
      if (Date.parse(String(JSON.parse(String(current.draft_json)).previewExpiresAt)) <= Date.parse(timestamp())) {
        throw new Error('만료된 미리보기의 서명을 기록할 수 없습니다.');
      }
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, iv);
      cipher.setAAD(Buffer.from(`${id}:${signed.txId}`));
      const ciphertext = Buffer.concat([cipher.update(signed.serialized, 'utf8'), cipher.final()]);
      const at = timestamp();
      db.prepare(`UPDATE action_intents SET status='signed',tx_id=?,signed_digest=?,signed_iv=?,signed_tag=?,
        signed_ciphertext=?,updated_at=? WHERE id=?`).run(
        signed.txId, signed.digest, iv, cipher.getAuthTag(), ciphertext, at, id,
      );
      event.run(id, 'signed', at, JSON.stringify({ txId: signed.txId }));
      return rowToIntent(read(id));
    });
  }

  function getSignedTransaction(id: string): Record<string, unknown> {
    const row = read(id);
    if (row.tx_id === null || row.signed_iv === null || row.signed_tag === null || row.signed_ciphertext === null) {
      throw new Error('저장된 서명 거래가 없습니다.');
    }
    const decipher = createDecipheriv('aes-256-gcm', key, row.signed_iv as Buffer);
    decipher.setAAD(Buffer.from(`${id}:${row.tx_id}`));
    decipher.setAuthTag(row.signed_tag as Buffer);
    const plaintext = Buffer.concat([decipher.update(row.signed_ciphertext as Buffer), decipher.final()]).toString('utf8');
    if (digest(plaintext) !== row.signed_digest) throw new Error('서명 거래 저장값의 무결성이 맞지 않습니다.');
    return JSON.parse(plaintext) as Record<string, unknown>;
  }

  function markBroadcastAttempt(id: string): ActionIntent {
    return transaction(() => {
      const current = read(id);
      if (current.status !== 'signed' || !current.tx_id) {
        throw new Error('서명 원본이 없거나 이미 방송을 시도했습니다. 원 txID만 조회해 주세요.');
      }
      if (Date.parse(String(JSON.parse(String(current.draft_json)).previewExpiresAt)) <= Date.parse(timestamp())) {
        throw new Error('만료된 미리보기의 거래를 방송할 수 없습니다. 원 txID를 보관하고 상태를 확인해 주세요.');
      }
      const at = timestamp();
      db.prepare("UPDATE action_intents SET status='broadcasting',broadcast_started_at=?,updated_at=? WHERE id=?")
        .run(at, at, id);
      event.run(id, 'broadcast_attempt', at, JSON.stringify({ txId: current.tx_id }));
      return rowToIntent(read(id));
    });
  }

  function recordBroadcastResult(id: string, accepted: boolean | null): ActionIntent {
    return transaction(() => {
      const current = read(id);
      if (current.status !== 'broadcasting') throw new Error('방송 시작 상태가 아닙니다. 원 txID만 조회해 주세요.');
      // A negative/timeout response is ambiguous, not proof that the network never saw the tx.
      const status = accepted === true ? 'pending' : 'unknown';
      const at = timestamp();
      db.prepare('UPDATE action_intents SET status=?,updated_at=? WHERE id=?').run(status, at, id);
      event.run(id, status, at, JSON.stringify({ txId: current.tx_id }));
      return rowToIntent(read(id));
    });
  }

  function recordSolidifiedOutcome(id: string, inputOutcome: SolidifiedOutcome): ActionIntent {
    const outcome = z.object({
      txId: z.string().regex(hex64),
      status: z.enum(['confirmed', 'failed']),
      solidifiedAt: instantSchema,
      receipt: z.record(z.string(), z.unknown()),
    }).parse(inputOutcome);
    if (Object.keys(outcome.receipt).length === 0) throw new Error('확정 영수증이 비어 있습니다.');
    return transaction(() => {
      const current = read(id);
      if (!current.tx_id || current.tx_id !== outcome.txId.toLowerCase()) throw new Error('확정 영수증의 원 txID가 다릅니다.');
      if (current.status === outcome.status) return rowToIntent(current);
      if (!['signed', 'broadcasting', 'pending', 'unknown'].includes(String(current.status))) {
        throw new Error('확정된 거래 결과를 변경할 수 없습니다.');
      }
      const at = timestamp();
      // The signed bytes are only needed while the original tx may require recovery.
      db.prepare(`UPDATE action_intents SET status=?,receipt_json=?,solidified_at=?,updated_at=?,
        signed_iv=NULL,signed_tag=NULL,signed_ciphertext=NULL WHERE id=?`)
        .run(outcome.status, JSON.stringify(outcome.receipt), outcome.solidifiedAt, at, id);
      event.run(id, outcome.status, at, JSON.stringify({ txId: current.tx_id, solidifiedAt: outcome.solidifiedAt }));
      return rowToIntent(read(id));
    });
  }

  function cancelReservation(id: string): ActionIntent {
    return transaction(() => {
      const current = read(id);
      if (current.status !== 'reserved') throw new Error('서명 후 거래 의도는 취소할 수 없습니다. 원 txID를 조회해 주세요.');
      const at = timestamp();
      db.prepare("UPDATE action_intents SET status='cancelled',updated_at=? WHERE id=?").run(at, id);
      event.run(id, 'cancelled', at, '{}');
      return rowToIntent(read(id));
    });
  }

  function readNilePolicySnapshot(inputFilter: {
    account: string; policyVersion: number; targetPosition: string;
  }): { usage: LedgerPolicyUsage; unresolvedIntents: ActionIntent[] } {
    const account = accountAddress(inputFilter.account);
    if (!Number.isSafeInteger(inputFilter.policyVersion) || inputFilter.policyVersion <= 0 ||
        !inputFilter.targetPosition.startsWith(`nile:${account}:`)) {
      throw new Error('Nile 정책 사용량 필터가 올바르지 않습니다.');
    }
    const contract = inputFilter.targetPosition.slice(`nile:${account}:`.length);
    if (!TronWeb.isAddress(contract) || accountAddress(contract) !== contract) {
      throw new Error('정규화된 Nile 포지션 주소가 필요합니다.');
    }
    return transaction(() => {
      const asOf = timestamp();
      const utcDay = asOf.slice(0, 10);
      const rows = db.prepare(`SELECT * FROM action_intents WHERE chain='nile' AND account=? AND
        policy_version=? AND target_position=? ORDER BY created_at,id`)
        .all(account, inputFilter.policyVersion, inputFilter.targetPosition) as Row[];
      const unresolved = db.prepare(`SELECT * FROM action_intents WHERE chain='nile' AND account=? AND
        status IN ('reserved','signed','broadcasting','pending','unknown') ORDER BY created_at,id`)
        .all(account) as Row[];
      let confirmedToday = 0n;
      let confirmedTotal = 0n;
      let pendingToday = 0n;
      let pendingTotal = 0n;
      let confirmedActionsToday = 0;
      let confirmedActionsTotal = 0;
      let failedActionsToday = 0;
      let failedActionsTotal = 0;
      let pendingActionsToday = 0;
      let pendingActionsTotal = 0;
      let latestSettledAt: string | null = null;
      const usedCycles = new Set<string>();
      for (const row of rows) {
        const status = String(row.status);
        if (status === 'cancelled') continue;
        if (row.cycle_id !== null) usedCycles.add(String(row.cycle_id));
        const draft = JSON.parse(String(row.draft_json)) as ActionIntentDraft;
        if ((status === 'confirmed' || status === 'failed') && row.solidified_at !== null) {
          const settledAt = String(row.solidified_at);
          if (latestSettledAt === null || settledAt > latestSettledAt) latestSettledAt = settledAt;
        }
        // A tx observed solidified across UTC midnight consumes both adjacent daily windows.
        // This deliberately overcounts rather than allowing a cap reset during uncertainty.
        const touchedToday = String(row.created_at).slice(0, 10) === utcDay ||
          row.solidified_at !== null && String(row.solidified_at).slice(0, 10) === utcDay;
        if (status === 'confirmed') {
          confirmedActionsTotal += 1;
          if (touchedToday) confirmedActionsToday += 1;
          if (draft.action === 'deposit') {
            const amount = BigInt(draft.amountBaseUnits);
            confirmedTotal += amount;
            if (touchedToday) confirmedToday += amount;
          }
        } else if (status === 'failed') {
          failedActionsTotal += 1;
          if (touchedToday) failedActionsToday += 1;
        } else if (['reserved', 'signed', 'broadcasting', 'pending', 'unknown'].includes(status)) {
          pendingActionsTotal += 1;
          pendingActionsToday += 1; // Carried across midnight while the result is unresolved.
          if (draft.action === 'deposit') {
            const amount = BigInt(draft.amountBaseUnits);
            pendingTotal += amount;
            pendingToday += amount;
          }
        }
      }
      return {
        usage: {
          source: 'ledger', verified: true, chain: 'nile', account, policyVersion: inputFilter.policyVersion,
          asOf, utcDay, confirmedDepositSunToday: confirmedToday.toString(),
          confirmedDepositSunTotal: confirmedTotal.toString(), pendingDepositSunToday: pendingToday.toString(),
          pendingDepositSunTotal: pendingTotal.toString(), confirmedActionsToday, confirmedActionsTotal,
          failedActionsToday, failedActionsTotal, pendingActionsToday, pendingActionsTotal,
          latestSettledAt,
          usedCycleIds: [...usedCycles].sort(),
        } satisfies LedgerPolicyUsage,
        unresolvedIntents: unresolved.map(rowToIntent),
      };
    });
  }

  return {
    reserveIntent,
    recordSignedTransaction,
    getSignedTransaction,
    markBroadcastAttempt,
    recordBroadcastResult,
    recordSolidifiedOutcome,
    cancelReservation,
    readNilePolicySnapshot,
    getIntent: (id: string): ActionIntent | null => {
      const row = select.get(id) as Row | undefined;
      return row ? rowToIntent(row) : null;
    },
    listUnresolved: (): ActionIntent[] => (db.prepare(`SELECT * FROM action_intents WHERE status IN
      ('reserved','signed','broadcasting','pending','unknown') ORDER BY created_at,id`).all() as Row[]).map(rowToIntent),
    listPendingRecovery: (): ActionIntent[] => (db.prepare(`SELECT * FROM action_intents WHERE tx_id IS NOT NULL AND status IN
      ('signed','broadcasting','pending','unknown') ORDER BY created_at,id`).all() as Row[]).map(rowToIntent),
    listEvents: (id: string): Array<{ sequence: number; event: string; occurredAt: string; detail: unknown }> =>
      (db.prepare('SELECT * FROM action_intent_events WHERE intent_id=? ORDER BY sequence').all(id) as Row[]).map(row => ({
        sequence: Number(row.sequence), event: String(row.event), occurredAt: String(row.occurred_at),
        detail: JSON.parse(String(row.detail_json)) as unknown,
      })),
    close: (): void => { db.close(); key.fill(0); },
  };
}
