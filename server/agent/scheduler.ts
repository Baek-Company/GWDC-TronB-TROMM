import { TronWeb } from 'tronweb';
import { NILE_JTRX_CANDIDATE } from '../transactions';
import type { ActionIntent, ActionIntentDraft, createActionLedger } from './ledger';
import { evaluateNileAutomation, nileAutomationPolicySchema, nilePolicyUsageSchema,
  type NileAutomationPolicy, type NilePolicyUsage } from './policy';

type Ledger = ReturnType<typeof createActionLedger>;

export interface NileLedgerPolicyInputs {
  ledgerAvailable: boolean;
  usage: NilePolicyUsage | null;
  unresolvedIntents: ActionIntent[] | null;
}

/**
 * Reads a single consistent ledger snapshot for the dedicated Nile jTRX test wallet.
 * Any DB, schema, or address error becomes an unavailable result; policy evaluation then holds.
 * It does not schedule, reserve, sign, or broadcast a transaction.
 */
export function readNileLedgerPolicyInputs(ledger: Ledger, policy: Pick<NileAutomationPolicy,
  'testWalletAddress' | 'version'>): NileLedgerPolicyInputs {
  try {
    if (!TronWeb.isAddress(policy.testWalletAddress)) throw new Error('invalid test wallet');
    const account = TronWeb.address.fromHex(TronWeb.address.toHex(policy.testWalletAddress));
    const targetPosition = `nile:${account}:${NILE_JTRX_CANDIDATE}`;
    const snapshot = ledger.readNilePolicySnapshot({ account, policyVersion: policy.version, targetPosition });
    return {
      ledgerAvailable: true,
      usage: nilePolicyUsageSchema.parse(snapshot.usage),
      unresolvedIntents: snapshot.unresolvedIntents,
    };
  } catch {
    return { ledgerAvailable: false, usage: null, unresolvedIntents: null };
  }
}

/** Builds the only intended B-1 reservation draft from a fresh, fully passing policy assessment. */
export function buildNileScheduledIntentDraft(
  assessment: Parameters<typeof evaluateNileAutomation>[0],
): ActionIntentDraft | null {
  const decision = evaluateNileAutomation(assessment);
  if (decision.status !== 'propose' || !decision.triggerId || !decision.cycleId ||
      !assessment.policy || !assessment.preview || !assessment.wallet) return null;
  const policy = nileAutomationPolicySchema.parse(assessment.policy);
  const preview = assessment.preview;
  const account = TronWeb.address.fromHex(TronWeb.address.toHex(policy.testWalletAddress));
  return {
    chain: 'nile', account, policyVersion: policy.version, triggerId: decision.triggerId,
    action: preview.method === 'mint()' ? 'deposit' : 'withdraw',
    targetPosition: `nile:${account}:${NILE_JTRX_CANDIDATE}`,
    positionVersion: assessment.wallet.positionVersion, cycleId: decision.cycleId,
    receiptBalanceBeforeBaseUnits: preview.state.jtrxBalanceRaw,
    planId: preview.planId, previewId: preview.id, previewFingerprint: preview.fingerprint,
    previewExpiresAt: preview.expiresAt, amountBaseUnits: preview.amountBaseUnits,
    maxFeeBaseUnits: preview.maxFeeBaseUnits!, targetContract: preview.contractAddress,
    targetMethod: preview.method,
  };
}
