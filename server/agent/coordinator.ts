import { TronWeb, utils } from 'tronweb';
import { actionPreviewSchema, observationSchema, type Observation } from '../../shared/schemas';
import { assertNileBandwidthBudgetEvidence, assertNileWithdrawalBandwidthBudget } from '../../shared/nile-bandwidth';
import { sameSafeNileWithdrawal } from '../../shared/nile-withdrawal-revalidation';
import {
  NILE_CHAIN_ID, NILE_JTRX_CANDIDATE,
  type NileDepositPreview, type NileTransactionResult, type NileWithdrawalPreview,
} from '../transactions';
import type { ActionIntent, ActionIntentDraft, createActionLedger } from './ledger';

type NilePreview = NileDepositPreview | NileWithdrawalPreview;
type Ledger = ReturnType<typeof createActionLedger>;
const isUnsigned = (value: string) => /^\d+$/.test(value);

function sameAddress(left: string, right: string): boolean {
  return TronWeb.isAddress(left) && TronWeb.isAddress(right) &&
    TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

function assertCurrentPreview(preview: NilePreview, now: number): void {
  actionPreviewSchema.parse(preview);
  if (preview.chain !== 'nile' || preview.source.chain !== 'nile' || preview.source.mode !== 'live' ||
      preview.state.chain !== 'nile' || preview.state.chainId !== NILE_CHAIN_ID ||
      preview.state.source.mode !== 'live' || preview.approvalScope !== null ||
      !sameAddress(preview.contractAddress, NILE_JTRX_CANDIDATE) ||
      !sameAddress(preview.walletAddress, preview.state.walletAddress) ||
      !sameAddress(preview.contractAddress, preview.state.contractAddress) ||
      !isUnsigned(preview.feeLimitSun) || BigInt(preview.feeLimitSun) <= 0n ||
      BigInt(preview.feeLimitSun) > BigInt(Number.MAX_SAFE_INTEGER) ||
      preview.feeLimitSun !== preview.state.feeLimitSun ||
      preview.maxFeeBaseUnits !== preview.state.maxFeeSun ||
      preview.estimatedFeeBaseUnits !== preview.state.estimatedFeeSun ||
      !isUnsigned(preview.amountBaseUnits) || BigInt(preview.amountBaseUnits) <= 0n ||
      Date.parse(preview.expiresAt) <= now) {
    throw new Error('Nile 거래 미리보기가 만료되었거나 검증 상태와 다릅니다.');
  }
  if (preview.method === 'mint()') {
    if (preview.asset.symbol !== 'TRX' || preview.asset.address !== null || preview.asset.decimals !== 6 ||
        BigInt(preview.amountBaseUnits) > BigInt(Number.MAX_SAFE_INTEGER) ||
        preview.state.jtrxDecimals !== 8 || preview.state.amountSun !== preview.amountBaseUnits ||
        BigInt(preview.state.walletBalanceSun) < BigInt(preview.amountBaseUnits) + BigInt(preview.state.maxFeeSun) ||
        BigInt(preview.state.marketCashSun) < BigInt(preview.amountBaseUnits)) {
      throw new Error('Nile 예치 잔액·자산·출구 조건이 미리보기와 다릅니다.');
    }
  } else if (preview.method === 'redeem(uint256)') {
    if (preview.asset.symbol !== 'jTRX' || preview.asset.decimals !== 8 ||
        !preview.asset.address || !sameAddress(preview.asset.address, preview.contractAddress) ||
        preview.state.jtrxDecimals !== 8 || preview.state.jtrxAmountRaw !== preview.amountBaseUnits ||
        preview.state.expectedUnderlyingSun !== preview.expectedUnderlyingSun ||
        BigInt(preview.state.jtrxBalanceRaw) < BigInt(preview.amountBaseUnits) ||
        BigInt(preview.state.marketCashSun) < BigInt(preview.expectedUnderlyingSun) ||
        BigInt(preview.state.walletBalanceSun) < BigInt(preview.state.maxFeeSun)) {
      throw new Error('Nile 환매 잔액·자산·출구 조건이 미리보기와 다릅니다.');
    }
    assertNileBandwidthBudgetEvidence(preview.state);
  } else {
    throw new Error('허용되지 않은 Nile 거래 메서드입니다.');
  }
}

function samePreview(before: NilePreview, after: NilePreview): boolean {
  if (before.method === 'redeem(uint256)') {
    return after.method === 'redeem(uint256)' && sameSafeNileWithdrawal(before, after);
  }
  return before.fingerprint === after.fingerprint && before.planId === after.planId &&
    before.needsVersion === after.needsVersion && before.quoteVersion === after.quoteVersion &&
    sameAddress(before.walletAddress, after.walletAddress) &&
    sameAddress(before.contractAddress, after.contractAddress) && before.method === after.method &&
    before.amountBaseUnits === after.amountBaseUnits && before.feeLimitSun === after.feeLimitSun &&
    before.maxFeeBaseUnits === after.maxFeeBaseUnits;
}

function assertIntentPreview(intent: ActionIntent, preview: NilePreview): void {
  if (intent.chain !== 'nile' || !sameAddress(intent.account, preview.walletAddress) ||
      intent.action !== (preview.method === 'mint()' ? 'deposit' : 'withdraw') ||
      intent.planId !== preview.planId || intent.previewId !== preview.id ||
      intent.previewFingerprint !== preview.fingerprint || intent.previewExpiresAt !== preview.expiresAt ||
      intent.amountBaseUnits !== preview.amountBaseUnits || intent.maxFeeBaseUnits !== preview.maxFeeBaseUnits ||
      !sameAddress(intent.targetContract, preview.contractAddress) || intent.targetMethod !== preview.method) {
    throw new Error('저장된 거래 의도와 미리보기가 다릅니다.');
  }
}

function assertSignedTransaction(signedTransaction: unknown, preview: NilePreview, now: number): void {
  if (!signedTransaction || typeof signedTransaction !== 'object' || Array.isArray(signedTransaction)) {
    throw new Error('서명 거래 원문이 필요합니다.');
  }
  const tx = signedTransaction as Record<string, unknown>;
  const raw = tx.raw_data as Record<string, unknown> | undefined;
  if (!raw || !Array.isArray(raw.contract) || raw.contract.length !== 1 ||
      !Array.isArray(tx.signature) || tx.signature.length !== 1 ||
      typeof tx.txID !== 'string' || !/^[a-f0-9]{64}$/i.test(tx.txID) ||
      typeof tx.raw_data_hex !== 'string' || !/^(?:[a-f0-9]{2})+$/i.test(tx.raw_data_hex) ||
      !Number.isSafeInteger(raw.fee_limit) || BigInt(raw.fee_limit as number) !== BigInt(preview.feeLimitSun) ||
      !Number.isSafeInteger(raw.expiration) || (raw.expiration as number) <= now ||
      !utils.transaction.txCheck(tx)) {
    throw new Error('서명 거래의 원문·txID·수수료·유효 시간을 검증할 수 없습니다.');
  }
  const call = raw.contract[0] as Record<string, unknown>;
  const parameter = call.parameter as Record<string, unknown> | undefined;
  const value = parameter?.value as Record<string, unknown> | undefined;
  const selector = TronWeb.sha3(preview.method).replace(/^0x/, '').slice(0, 8).toLowerCase();
  const expectedData = preview.method === 'mint()' ? selector :
    `${selector}${BigInt(preview.amountBaseUnits).toString(16).padStart(64, '0')}`;
  const zeroOrAbsent = (value: unknown) => value === undefined || value === 0 || value === '0';
  if (call.type !== 'TriggerSmartContract' || !value ||
      !sameAddress(String(value.owner_address), preview.walletAddress) ||
      !sameAddress(String(value.contract_address), preview.contractAddress) ||
      String(value.data).replace(/^0x/, '').toLowerCase() !== expectedData ||
      !zeroOrAbsent(value.call_token_value) || !zeroOrAbsent(value.token_id) ||
      (preview.method === 'mint()' ?
        value.call_value !== Number(preview.amountBaseUnits) :
        value.call_value !== undefined && value.call_value !== 0)) {
    throw new Error('서명 거래의 계정·계약·함수·수량이 예약된 미리보기와 다릅니다.');
  }
  try {
    const signature = tx.signature[0] as string;
    const signer = utils.crypto.ecRecover(tx.txID, signature);
    if (!sameAddress(signer, preview.walletAddress)) throw new Error('signer mismatch');
  } catch {
    throw new Error('거래 서명자가 예약된 지갑 계정과 다릅니다.');
  }
  if (preview.method === 'redeem(uint256)') {
    assertNileWithdrawalBandwidthBudget(tx, preview.state);
  }
}

/**
 * Approval-mode state machine for the existing Nile jTRX preview types. This module never signs
 * or broadcasts. The caller must authenticate the wallet owner and bind confirmedPreviewId to a
 * real UI confirmation; execution callers must broadcast only the object returned by beginBroadcast.
 */
export function createNileApprovalCoordinator(input: {
  ledger: Ledger;
  refreshPreview: (preview: NilePreview) => Promise<NilePreview>;
  readTransaction: (txId: string) => Promise<NileTransactionResult>;
  readPosition?: (request: { planId: string; address: string; contractAddress: string }) => Promise<Observation>;
  now?: () => number;
}) {
  const now = input.now ?? Date.now;

  async function reserveApproved(request: {
    preview: NilePreview;
    confirmedPreviewId: string;
    policyVersion: number;
    triggerId: string;
    positionVersion: string;
    needsDigest?: string;
    planCheck?: 'matched_current_needs' | 'matched_prior_deposit';
  }): Promise<ActionIntent> {
    assertCurrentPreview(request.preview, now());
    if (request.confirmedPreviewId !== request.preview.id) throw new Error('사용자가 확인한 미리보기 ID가 다릅니다.');
    const latest = await input.refreshPreview(request.preview);
    assertCurrentPreview(latest, now());
    if (!samePreview(request.preview, latest)) throw new Error('거래 조건이 바뀌었습니다. 새 미리보기를 확인해 주세요.');
    const draft: ActionIntentDraft = {
      chain: 'nile', account: request.preview.walletAddress, policyVersion: request.policyVersion,
      triggerId: request.triggerId, action: request.preview.method === 'mint()' ? 'deposit' : 'withdraw',
      targetPosition: `nile:${TronWeb.address.fromHex(TronWeb.address.toHex(request.preview.walletAddress))}:${NILE_JTRX_CANDIDATE}`,
      positionVersion: request.positionVersion,
      receiptBalanceBeforeBaseUnits: request.preview.state.jtrxBalanceRaw,
      planId: request.preview.planId, needsDigest: request.needsDigest,
      quoteVersion: request.preview.quoteVersion, planCheck: request.planCheck,
      previewId: request.preview.id,
      previewFingerprint: request.preview.fingerprint, previewExpiresAt: request.preview.expiresAt,
      amountBaseUnits: request.preview.amountBaseUnits, maxFeeBaseUnits: request.preview.maxFeeBaseUnits!,
      targetContract: request.preview.contractAddress, targetMethod: request.preview.method,
    };
    return input.ledger.reserveIntent(draft);
  }

  function acceptSigned(request: { intentId: string; preview: NilePreview; signedTransaction: unknown }): ActionIntent {
    const intent = input.ledger.getIntent(request.intentId);
    if (!intent) throw new Error('거래 의도를 찾을 수 없습니다.');
    assertIntentPreview(intent, request.preview);
    assertCurrentPreview(request.preview, now());
    assertSignedTransaction(request.signedTransaction, request.preview, now());
    return input.ledger.recordSignedTransaction(intent.id, request.signedTransaction);
  }

  async function beginBroadcast(request: { intentId: string; preview: NilePreview }): Promise<{
    intent: ActionIntent; signedTransaction: Record<string, unknown>;
  }> {
    const intent = input.ledger.getIntent(request.intentId);
    if (!intent) throw new Error('거래 의도를 찾을 수 없습니다.');
    assertIntentPreview(intent, request.preview);
    assertCurrentPreview(request.preview, now());
    // The complete live snapshot was checked when reserving this intent. Market cash,
    // exchange rate, and wallet resources can change while TronLink asks for a signature;
    // rechecking their exact fingerprint here would strand a valid, already signed tx.
    // Broadcast only the original stored bytes while both the preview and tx are valid.
    const signedTransaction = input.ledger.getSignedTransaction(intent.id);
    assertSignedTransaction(signedTransaction, request.preview, now());
    return { intent: input.ledger.markBroadcastAttempt(intent.id), signedTransaction };
  }

  async function reconcile(intentId: string): Promise<{ intent: ActionIntent; observation: NileTransactionResult }> {
    const intent = input.ledger.getIntent(intentId);
    if (!intent || !intent.txId) throw new Error('복구할 원 txID가 없습니다.');
    const observation = await input.readTransaction(intent.txId);
    if (observation.txId.toLowerCase() !== intent.txId ||
        observation.source.chain !== 'nile' || observation.source.mode !== 'live' ||
        observation.source.accessMethod !== 'rpc') {
      throw new Error('원 txID의 Nile RPC 관측이 아닙니다.');
    }
    const receiptFetchedAt = Date.parse(observation.source.fetchedAt);
    const earliestReceiptRead = Date.parse(intent.broadcastStartedAt ?? intent.updatedAt);
    if (!Number.isFinite(receiptFetchedAt) || receiptFetchedAt < earliestReceiptRead ||
        receiptFetchedAt > now()) {
      throw new Error('방송 이후의 최신 Nile RPC 영수증 관측이 아닙니다.');
    }
    if (observation.status === 'confirmed' || observation.status === 'failed') {
      const receipt = observation.receipt;
      if (!receipt || String(receipt.id).toLowerCase() !== intent.txId ||
          !receipt.receipt || typeof receipt.receipt !== 'object' ||
          !observation.actualFeeSun || !isUnsigned(observation.actualFeeSun)) {
        throw new Error('solidified 영수증·수수료를 확인할 수 없습니다.');
      }
      const receiptFee = String(receipt.fee ?? '0');
      if (!isUnsigned(receiptFee) || BigInt(receiptFee) !== BigInt(observation.actualFeeSun)) {
        throw new Error('solidified 영수증과 실제 수수료가 다릅니다.');
      }
      const executionResult = (receipt.receipt as Record<string, unknown>).result;
      if ((observation.status === 'confirmed' && executionResult !== 'SUCCESS') ||
          (observation.status === 'failed' && executionResult === 'SUCCESS')) {
        throw new Error('solidified 영수증과 거래 상태가 다릅니다.');
      }
      if (observation.status === 'confirmed') {
        if (!input.readPosition || intent.receiptBalanceBeforeBaseUnits === undefined) {
          throw new Error('확정 거래의 이전 포지션과 재관측 경로가 없어 완료로 기록할 수 없습니다.');
        }
        // A cached observation from before the receipt query cannot prove the transaction's result.
        const readStartedAt = now();
        const position = observationSchema.parse(await input.readPosition({
          planId: intent.planId, address: intent.account, contractAddress: intent.targetContract,
        }));
        if (position.chain !== 'nile' || position.source.chain !== 'nile' ||
            position.source.mode !== 'live' || position.source.accessMethod !== 'rpc' ||
            Date.parse(position.source.fetchedAt) < readStartedAt ||
            Date.parse(position.source.fetchedAt) > now() ||
            position.planId !== intent.planId || !sameAddress(position.walletAddress, intent.account) ||
            position.positionId !== intent.targetPosition ||
            position.receiptToken.symbol !== 'jTRX' || position.receiptToken.decimals !== 8 ||
            !position.receiptToken.address || !sameAddress(position.receiptToken.address, intent.targetContract) ||
            position.underlyingToken.symbol !== 'TRX' || position.underlyingToken.address !== null ||
            position.underlyingToken.decimals !== 6) {
          throw new Error('확정 거래 후 동일 Nile 포지션의 최신 RPC 관측이 아닙니다.');
        }
        const before = BigInt(intent.receiptBalanceBeforeBaseUnits);
        const after = BigInt(position.receiptBalanceBaseUnits);
        if (intent.action === 'deposit' ? after <= before :
            intent.action === 'withdraw' ? before < BigInt(intent.amountBaseUnits) ||
              after !== before - BigInt(intent.amountBaseUnits) : true) {
          throw new Error('확정 영수증과 실제 jTRX 포지션 변화가 일치하지 않습니다.');
        }
      }
      // The RPC source time is captured before its requests complete. Using the completed
      // reconciliation time also forces the next policy wallet read to happen afterwards.
      return { intent: input.ledger.recordSolidifiedOutcome(intent.id, {
        txId: intent.txId, status: observation.status, solidifiedAt: new Date(now()).toISOString(), receipt,
      }), observation };
    }
    return { intent, observation };
  }

  return {
    reserveApproved, acceptSigned, beginBroadcast,
    recordBroadcastResult: input.ledger.recordBroadcastResult,
    reconcile,
  };
}
