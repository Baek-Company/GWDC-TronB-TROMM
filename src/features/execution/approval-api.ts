import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { instantSchema, type UserNeeds } from '../../../shared/schemas';
import type { NileDepositPreview, NileWithdrawalPreview } from '../../../server/transactions';
import { requireNileWallet } from '../../wallet';

export type NileApprovalPreview = NileDepositPreview | NileWithdrawalPreview;

const hexId = z.string().regex(/^[0-9a-f]{64}$/i);
const unresolvedIntentSchema = z.object({
  id: hexId, chain: z.literal('nile'), account: z.string(),
  action: z.enum(['deposit', 'withdraw']),
  status: z.enum(['reserved', 'signed', 'broadcasting', 'pending', 'unknown']),
  txId: hexId.nullable(),
  planId: z.string().regex(/^nile:justlend_jtrx:(?:80_20|50_50):v2:[0-9a-f]{64}$/),
  quoteVersion: z.string().min(1), previewId: z.string().min(1),
  amountBaseUnits: z.string().regex(/^\d+$/), targetContract: z.string(),
  targetPosition: z.string(), targetMethod: z.enum(['mint()', 'redeem(uint256)']),
  previewExpiresAt: instantSchema, createdAt: instantSchema, updatedAt: instantSchema,
}).superRefine((intent, context) => {
  if (intent.status === 'reserved' ? intent.txId !== null : intent.txId === null) {
    context.addIssue({ code: 'custom', path: ['txId'], message: '서버 의도의 원 txID 상태가 맞지 않습니다.' });
  }
  if (intent.action === 'deposit' ? intent.targetMethod !== 'mint()' : intent.targetMethod !== 'redeem(uint256)') {
    context.addIssue({ code: 'custom', path: ['targetMethod'], message: '서버 의도의 거래 동작이 맞지 않습니다.' });
  }
});
export type NileUnresolvedIntent = z.infer<typeof unresolvedIntentSchema>;

export function verifyNileUnresolvedIntent(value: unknown, address: string): NileUnresolvedIntent {
  const intent = unresolvedIntentSchema.parse(value);
  if (!TronWeb.isAddress(address) || !TronWeb.isAddress(intent.account) ||
      !TronWeb.isAddress(intent.targetContract) ||
      TronWeb.address.toHex(intent.account) !== TronWeb.address.toHex(address) ||
      intent.targetPosition !== `nile:${intent.account}:${intent.targetContract}` ||
      BigInt(intent.amountBaseUnits) <= 0n) {
    throw new Error('서버 미해결 의도의 지갑·포지션·금액이 일치하지 않습니다.');
  }
  return intent;
}

export interface NileApprovalGateway {
  authenticate(address: string): Promise<void>;
  reserve(preview: NileApprovalPreview, confirmedPreviewId: string, needs?: UserNeeds,
    depositIntentId?: string): Promise<string>;
  acceptSigned(intentId: string, preview: NileApprovalPreview, signedTransaction: unknown): Promise<string>;
  beginBroadcast(intentId: string, preview: NileApprovalPreview): Promise<Record<string, unknown>>;
  recordBroadcastResult(intentId: string, accepted: boolean | null): Promise<void>;
  cancel(intentId: string): Promise<void>;
  reconcile(intentId: string, address: string): Promise<{ status: string; txId: string | null }>;
}

export function assertSameSignedTransaction(local: unknown, durable: Record<string, unknown>): void {
  if (!local || typeof local !== 'object' || Array.isArray(local) ||
      typeof durable.txID !== 'string' || typeof durable.raw_data_hex !== 'string' ||
      !Array.isArray(durable.signature) ||
      JSON.stringify(local) !== JSON.stringify(durable)) {
    throw new Error('방송 직전 서버 원문 거래와 TronLink 서명 거래가 다릅니다. 원 txID만 조회해 주세요.');
  }
}

type IntentReply = { intent: { id: string; status: string; txId: string | null } };

class ApprovalHttpError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

async function request<T>(path: string, body?: unknown, method: 'GET' | 'POST' = 'POST'): Promise<T> {
  const response = await fetch(`/api/approval/${path}`, {
    method, credentials: 'same-origin',
    ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
  });
  let result: unknown;
  try { result = await response.json(); }
  catch { throw new Error(`Nile 승인 서버 응답을 확인할 수 없습니다. HTTP ${response.status}`); }
  if (!response.ok) {
    const message = result && typeof result === 'object' && 'error' in result &&
      typeof result.error === 'string' ? result.error : `Nile 승인 서버 오류: HTTP ${response.status}`;
    throw new ApprovalHttpError(message, response.status);
  }
  return result as T;
}

function requireIntent(reply: IntentReply, expectedId?: string): IntentReply['intent'] {
  const intent = reply?.intent;
  if (!intent || typeof intent.id !== 'string' || !/^[0-9a-f]{64}$/i.test(intent.id) ||
      expectedId && intent.id !== expectedId) {
    throw new Error('Nile 승인 서버의 거래 의도 응답이 올바르지 않습니다.');
  }
  return intent;
}

/** The browser only sends a signed transaction after a wallet-bound, same-origin server reservation. */
export const browserNileApprovalGateway: NileApprovalGateway = {
  async authenticate(address) {
    const web = requireNileWallet(address);
    const challenge = await request<{ challengeId: string; message: string; expiresAt: string }>('challenge', { address });
    if (!challenge || typeof challenge.challengeId !== 'string' || typeof challenge.message !== 'string' ||
        !challenge.message.includes(address) || !challenge.message.includes('Chain: nile')) {
      throw new Error('Nile 지갑 인증 문구가 요청 계정과 다릅니다.');
    }
    requireNileWallet(address);
    const signature = await web.trx.signMessageV2(challenge.message);
    requireNileWallet(address);
    if (typeof signature !== 'string' || !/^(?:0x)?[0-9a-f]{130}$/i.test(signature)) {
      throw new Error('TronLink 메시지 서명 결과를 확인할 수 없습니다.');
    }
    const result = await request<{ account: string }>('authenticate', {
      challengeId: challenge.challengeId, address, signature,
    });
    if (!result || !TronWeb.isAddress(result.account) ||
        TronWeb.address.toHex(result.account) !== TronWeb.address.toHex(address)) {
      throw new Error('Nile 승인 세션의 지갑 계정이 다릅니다.');
    }
    requireNileWallet(address);
  },
  async reserve(preview, confirmedPreviewId, needs, depositIntentId) {
    if (preview.method === 'mint()' && (!needs || needs.chain !== 'nile' ||
        needs.confirmedVersion !== needs.inputVersion || needs.inputVersion !== preview.needsVersion)) {
      throw new Error('확인된 Nile 지출·예비액 조건이 없어 예치를 예약할 수 없습니다.');
    }
    if (preview.method === 'redeem(uint256)' && (!depositIntentId ||
        !/^[0-9a-f]{64}$/i.test(depositIntentId))) {
      throw new Error('확정된 원 예치의 서버 의도 ID가 없어 환매를 예약할 수 없습니다.');
    }
    const intent = requireIntent(await request<IntentReply>('reserve', {
      preview, confirmedPreviewId, ...(needs ? { needs } : {}),
      ...(depositIntentId ? { depositIntentId } : {}),
    }));
    if (intent.status !== 'reserved') throw new Error('Nile 거래 의도가 예약되지 않았습니다.');
    return intent.id;
  },
  async acceptSigned(intentId, preview, signedTransaction) {
    const intent = requireIntent(await request<IntentReply>('signed', { intentId, preview, signedTransaction }), intentId);
    if (intent.status !== 'signed' || !intent.txId || !/^[0-9a-f]{64}$/i.test(intent.txId)) {
      throw new Error('원 거래 ID가 서버 원장에 접수되지 않았습니다.');
    }
    return intent.txId;
  },
  async beginBroadcast(intentId, preview) {
    const result = await request<IntentReply & { signedTransaction: unknown }>('begin-broadcast', { intentId, preview });
    const intent = requireIntent(result, intentId);
    if (intent.status !== 'broadcasting' || !result.signedTransaction ||
        typeof result.signedTransaction !== 'object' || Array.isArray(result.signedTransaction)) {
      throw new Error('방송 전 서버 원문 거래를 확인할 수 없습니다.');
    }
    return result.signedTransaction as Record<string, unknown>;
  },
  async recordBroadcastResult(intentId, accepted) {
    requireIntent(await request<IntentReply>('broadcast-result', { intentId, accepted }), intentId);
  },
  async cancel(intentId) {
    const intent = requireIntent(await request<IntentReply>('cancel', { intentId }), intentId);
    if (intent.status !== 'cancelled') throw new Error('서명 전 예약 취소가 확인되지 않았습니다.');
  },
  async reconcile(intentId, address) {
    let reply: IntentReply;
    try { reply = await request<IntentReply>('reconcile', { intentId }); }
    catch (error) {
      if (!(error instanceof ApprovalHttpError) || error.status !== 401) throw error;
      await this.authenticate(address);
      reply = await request<IntentReply>('reconcile', { intentId });
    }
    const intent = requireIntent(reply, intentId);
    return { status: intent.status, txId: intent.txId };
  },
};

export async function listNileUnresolvedIntents(address: string): Promise<NileUnresolvedIntent[]> {
  requireNileWallet(address);
  const result = await request<unknown>('unresolved', undefined, 'GET');
  const parsed = z.object({ intents: z.array(z.unknown()) }).parse(result);
  return parsed.intents.map(value => verifyNileUnresolvedIntent(value, address));
}
