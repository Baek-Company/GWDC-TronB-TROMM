import { randomBytes } from 'node:crypto';
import { Trx, TronWeb } from 'tronweb';
import type { Observation, UserNeeds } from '../../shared/schemas';
import {
  NILE_CHAIN_ID, NILE_JTRX_CANDIDATE,
  type NileDepositPreview, type NileTransactionResult, type NileWithdrawalPreview,
} from '../transactions';
import { createNileApprovalCoordinator } from './coordinator';
import { createTriggerId, type ActionIntent, type createActionLedger } from './ledger';

type NilePreview = NileDepositPreview | NileWithdrawalPreview;
type Ledger = ReturnType<typeof createActionLedger>;
type Challenge = { account: string; origin: string; message: string; expiresAt: number };
type Session = { account: string; origin: string; expiresAt: number };
const CHALLENGE_LIFETIME_MS = 2 * 60 * 1000;
const SESSION_LIFETIME_MS = 10 * 60 * 1000;
const MAX_ACTIVE = 128;
const ID_RE = /^[0-9a-f]{64}$/;

function accountAddress(value: string): string {
  if (!TronWeb.isAddress(value)) throw new Error('유효한 TRON 지갑 주소가 필요합니다.');
  return TronWeb.address.fromHex(TronWeb.address.toHex(value));
}

function assertAccount(actual: string, expected: string): void {
  if (accountAddress(actual) !== accountAddress(expected)) {
    throw new Error('인증된 Nile 지갑과 거래 지갑이 다릅니다.');
  }
}

/**
 * Browser-approved Nile transaction bridge. Challenge and session state is deliberately in memory:
 * server restart requires wallet reauthentication, while signed tx evidence survives in the ledger.
 * This service never signs or broadcasts a transaction.
 */
export function createNileApprovalService(input: {
  ledger: Ledger;
  refreshPreview: (preview: NilePreview) => Promise<NilePreview>;
  verifyDepositPlan: (needs: UserNeeds, preview: NileDepositPreview) => Promise<{
    needsDigest: string; quoteVersion: string; amountBaseUnits: string;
  }>;
  verifyNileReferenceBlock: (signedTransaction: unknown) => Promise<void>;
  readTransaction: (txId: string) => Promise<NileTransactionResult>;
  readPosition: (request: { planId: string; address: string; contractAddress: string }) => Promise<Observation>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;
  const challenges = new Map<string, Challenge>();
  const sessions = new Map<string, Session>();
  const coordinator = createNileApprovalCoordinator(input);

  function prune(): void {
    for (const [id, challenge] of challenges) if (challenge.expiresAt <= now()) challenges.delete(id);
    for (const [id, session] of sessions) if (session.expiresAt <= now()) sessions.delete(id);
    if (challenges.size >= MAX_ACTIVE) challenges.delete(challenges.keys().next().value!);
    if (sessions.size >= MAX_ACTIVE) sessions.delete(sessions.keys().next().value!);
  }

  function challenge(address: string, origin: string): { challengeId: string; message: string; expiresAt: string } {
    const account = accountAddress(address);
    if (!origin.startsWith('http://127.0.0.1:') && !origin.startsWith('http://localhost:')) {
      throw new Error('로컬 화면 출처가 필요합니다.');
    }
    prune();
    const challengeId = randomBytes(32).toString('hex');
    const expiresAt = now() + CHALLENGE_LIFETIME_MS;
    const message = [
      'GWDC Nile approval-mode wallet verification',
      `Origin: ${origin}`,
      `Chain: nile (${NILE_CHAIN_ID})`,
      `Account: ${account}`,
      `Nonce: ${challengeId}`,
      `Expires: ${new Date(expiresAt).toISOString()}`,
      'This signature proves wallet control only. It does not approve a transaction.',
    ].join('\n');
    challenges.set(challengeId, { account, origin, message, expiresAt });
    return { challengeId, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  function authenticate(request: { challengeId: string; address: string; signature: string }, origin: string): {
    token: string; account: string; expiresAt: string;
  } {
    if (!ID_RE.test(request.challengeId)) throw new Error('지갑 인증 요청 ID가 올바르지 않습니다.');
    const pending = challenges.get(request.challengeId);
    challenges.delete(request.challengeId); // One attempt consumes the challenge, including a bad signature.
    if (!pending || pending.expiresAt <= now() || pending.origin !== origin) {
      throw new Error('지갑 인증 요청이 만료되었거나 화면 출처가 다릅니다.');
    }
    assertAccount(request.address, pending.account);
    let signer: string;
    try { signer = Trx.verifyMessageV2(pending.message, request.signature); }
    catch { throw new Error('TronLink 메시지 서명을 확인할 수 없습니다.'); }
    assertAccount(signer, pending.account);
    prune();
    const token = randomBytes(32).toString('hex');
    const expiresAt = now() + SESSION_LIFETIME_MS;
    sessions.set(token, { account: pending.account, origin, expiresAt });
    return { token, account: pending.account, expiresAt: new Date(expiresAt).toISOString() };
  }

  function accountFor(cookie: string | undefined, origin?: string): string {
    const token = cookie?.match(/(?:^|;\s*)gwdc_nile_approval=([0-9a-f]{64})(?:;|$)/)?.[1];
    const session = token ? sessions.get(token) : undefined;
    if (!session || session.expiresAt <= now() || origin !== undefined && session.origin !== origin) {
      throw new Error('Nile 승인 세션이 없거나 만료되었습니다. 지갑 서명을 다시 확인해 주세요.');
    }
    return session.account;
  }

  function sameIntentAccount(account: string, intentId: string): ActionIntent {
    const intent = input.ledger.getIntent(intentId);
    if (!intent) throw new Error('거래 의도를 찾을 수 없습니다.');
    assertAccount(intent.account, account);
    if (!/^nile:justlend_jtrx:(?:80_20|50_50):v2:[0-9a-f]{64}$/.test(intent.planId)) {
      throw new Error('Nile jTRX 거래 의도가 아닙니다.');
    }
    return intent;
  }

  async function reserve(account: string, preview: NilePreview, confirmedPreviewId: string,
    needs?: UserNeeds, depositIntentId?: string): Promise<ActionIntent> {
    assertAccount(preview.walletAddress, account);
    if (input.ledger.listUnresolved().some(intent => intent.chain === 'nile' &&
      intent.account === account && /^nile:psm:/.test(intent.planId))) {
      throw new Error('같은 Nile 지갑에 미확정 PSM 거래가 있습니다. 원 txID를 먼저 확인해 주세요.');
    }
    if (preview.chain !== 'nile' || preview.state.chainId !== NILE_CHAIN_ID ||
        accountAddress(preview.contractAddress) !== NILE_JTRX_CANDIDATE ||
        !/^nile:justlend_jtrx:(?:80_20|50_50):v2:[0-9a-f]{64}$/.test(preview.planId)) {
      throw new Error('지원하는 Nile jTRX 계획·계약 미리보기가 아닙니다.');
    }
    let needsDigest: string;
    let planCheck: 'matched_current_needs' | 'matched_prior_deposit';
    if (preview.method === 'mint()') {
      if (!needs || depositIntentId) throw new Error('예치 예약에는 확인된 계획 조건이 필요합니다.');
      const checked = await input.verifyDepositPlan(needs, preview);
      if (checked.quoteVersion !== preview.quoteVersion || checked.amountBaseUnits !== preview.amountBaseUnits) {
        throw new Error('서버가 재계산한 Nile 견적·금액이 미리보기와 다릅니다.');
      }
      needsDigest = checked.needsDigest;
      planCheck = 'matched_current_needs';
    } else {
      if (!depositIntentId || needs) throw new Error('환매 예약에는 확정된 원 예치 의도 ID가 필요합니다.');
      const original = input.ledger.getIntent(depositIntentId);
      if (!original || original.status !== 'confirmed' || original.action !== 'deposit' ||
          original.chain !== 'nile' || original.account !== account ||
          original.planId !== preview.planId || original.quoteVersion !== preview.quoteVersion ||
          original.targetContract !== preview.contractAddress ||
          original.targetPosition !== `nile:${account}:${NILE_JTRX_CANDIDATE}` || !original.needsDigest) {
        throw new Error('같은 지갑·계획의 확정된 Nile 예치 의도를 확인할 수 없습니다.');
      }
      needsDigest = original.needsDigest;
      planCheck = 'matched_prior_deposit';
    }
    const positionVersion = preview.fingerprint;
    const triggerId = createTriggerId({ kind: 'schedule', sourceId: preview.id, positionVersion });
    return coordinator.reserveApproved({ preview, confirmedPreviewId, policyVersion: 1,
      triggerId, positionVersion, needsDigest, planCheck });
  }

  async function acceptSigned(account: string, request: {
    intentId: string; preview: NilePreview; signedTransaction: unknown;
  }): Promise<ActionIntent> {
    sameIntentAccount(account, request.intentId);
    assertAccount(request.preview.walletAddress, account);
    await input.verifyNileReferenceBlock(request.signedTransaction);
    return coordinator.acceptSigned(request);
  }

  async function beginBroadcast(account: string, request: { intentId: string; preview: NilePreview }) {
    sameIntentAccount(account, request.intentId);
    assertAccount(request.preview.walletAddress, account);
    return coordinator.beginBroadcast(request);
  }

  function recordBroadcastResult(account: string, intentId: string, accepted: boolean | null): ActionIntent {
    sameIntentAccount(account, intentId);
    return coordinator.recordBroadcastResult(intentId, accepted);
  }

  async function reconcile(account: string, intentId: string) {
    sameIntentAccount(account, intentId);
    return coordinator.reconcile(intentId);
  }

  function unresolved(account: string): ActionIntent[] {
    return input.ledger.listUnresolved().filter(intent => intent.chain === 'nile' && intent.account === account
      && /^nile:justlend_jtrx:(?:80_20|50_50):v2:[0-9a-f]{64}$/.test(intent.planId));
  }

  function cancel(account: string, intentId: string): ActionIntent {
    sameIntentAccount(account, intentId);
    return input.ledger.cancelReservation(intentId);
  }

  return { challenge, authenticate, accountFor, reserve, acceptSigned, beginBroadcast,
    recordBroadcastResult, reconcile, unresolved, cancel };
}
