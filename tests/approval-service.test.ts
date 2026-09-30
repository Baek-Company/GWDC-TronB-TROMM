import { randomBytes } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Trx, TronWeb, utils } from 'tronweb';
import { createNilePlans } from '../shared/planning';
import { productQuoteSchema, userNeedsSchema, type Observation, type UserNeeds } from '../shared/schemas';
import { verifyNileApprovalPlan } from '../server/agent/approval-plan';
import { createNileApprovalService } from '../server/agent/approval-service';
import { createActionLedger, createTriggerId } from '../server/agent/ledger';
import { NILE_PSM_CONTRACTS } from '../server/nile-psm';
import { NILE_CHAIN_ID, NILE_JTRX_CANDIDATE,
  type NileDepositPreview, type NileTransactionResult, type NileWithdrawalPreview } from '../server/transactions';

const fixedNow = Date.parse('2026-09-30T03:00:00.000Z');
const origin = 'http://127.0.0.1:5173';
const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: new Date(fixedNow).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };
const needs = userNeedsSchema.parse({ chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
  amount: '100', startDate: '2026-09-30', endDate: '2026-10-30', expenses: [], liquidReserve: '0',
  riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
  inputVersion: 1, confirmedVersion: 1 });

function wallet() {
  const privateKey = randomBytes(32).toString('hex');
  const address = TronWeb.address.fromPrivateKey(privateKey);
  if (!address) throw new Error('시험 지갑 생성 실패');
  return { privateKey, address };
}

function preview(address: string): NileDepositPreview {
  return {
    id: 'approval-preview-1', planId: `nile:justlend_jtrx:80_20:v2:${'a'.repeat(64)}`,
    needsVersion: 1, quoteVersion: 'quote-1', walletAddress: address,
    chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
    amountBaseUnits: '1000000', contractAddress: NILE_JTRX_CANDIDATE,
    method: 'mint()', approvalScope: null,
    estimatedFeeBaseUnits: '1000000', maxFeeBaseUnits: '2000000', feeLimitSun: '1500000',
    expiresAt: new Date(fixedNow + 45_000).toISOString(), fingerprint: 'fingerprint-1', risks: [], source,
    state: {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress: address, contractAddress: NILE_JTRX_CANDIDATE,
      comptrollerAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', jtrxDecimals: 8,
      contractCodeHash: 'abc', walletBalanceSun: '300000000', jtrxBalanceRaw: '0',
      marketCashSun: '1000000000', exchangeRateRaw: '2000000000000000000',
      supplyRatePerBlockRaw: '100', availableEnergy: '0', availableBandwidth: '600',
      estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000',
      estimatedFeeSun: '1000000', feeLimitSun: '1500000',
      bandwidthFeeUpperBoundSun: '500000', maxFeeSun: '2000000', amountSun: '1000000', source,
    },
  };
}

function withdrawalPreview(deposit: NileDepositPreview): NileWithdrawalPreview {
  return {
    ...deposit,
    id: 'withdrawal-preview-1', fingerprint: 'withdrawal-fingerprint-1',
    asset: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
    amountBaseUnits: '50000', method: 'redeem(uint256)', expectedUnderlyingSun: '100000',
    state: {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress: deposit.walletAddress,
      contractAddress: NILE_JTRX_CANDIDATE, comptrollerAddress: deposit.state.comptrollerAddress,
      contractCodeHash: 'abc', jtrxDecimals: 8,
      walletBalanceSun: '300000000', jtrxBalanceRaw: '100000', jtrxAmountRaw: '50000',
      marketCashSun: '1000000000', exchangeRateStoredRaw: '2000000000000000000',
      exchangeRateCurrentRaw: '2000000000000000000', expectedUnderlyingSun: '100000',
      supplyRatePerBlockRaw: '100', availableEnergy: '0', availableBandwidth: '600',
      estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000',
      estimatedFeeSun: '1000000', feeLimitSun: '1500000',
      bandwidthFeeUpperBoundSun: '500000', estimatedBandwidthBytes: '500',
      maxFeeSun: '2000000', source,
    },
  };
}

function signedTransaction(account: { privateKey: string; address: string }, extras: Record<string, unknown> = {}) {
  const raw_data = {
    ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
    expiration: fixedNow + 60_000, timestamp: fixedNow, fee_limit: 1_500_000,
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(account.address),
      contract_address: TronWeb.address.toHex(NILE_JTRX_CANDIDATE),
      call_value: 1_000_000,
      data: TronWeb.sha3('mint()').replace(/^0x/, '').slice(0, 8),
      ...extras,
    } } }],
  };
  const pb = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  const raw_data_hex = utils.transaction.txPbToRawDataHex(pb);
  const signature = utils.crypto.ECKeySign(Buffer.from(txID, 'hex'), Buffer.from(account.privateKey, 'hex'));
  return { raw_data, raw_data_hex, txID, signature: [signature] };
}

function service(ledger: ReturnType<typeof createActionLedger>, currentPreview: NileDepositPreview | NileWithdrawalPreview,
  now: () => number = () => fixedNow, hooks: {
    refreshPreview?: () => Promise<NileDepositPreview | NileWithdrawalPreview>;
    verifyNileReferenceBlock?: () => Promise<void>;
    verifyDepositPlan?: (needs: UserNeeds, preview: NileDepositPreview) => Promise<{
      needsDigest: string; quoteVersion: string; amountBaseUnits: string;
    }>;
  } = {}) {
  const unknown: NileTransactionResult = { txId: '0'.repeat(64), status: 'unknown', receipt: null,
    actualFeeSun: null, reason: null, source };
  return createNileApprovalService({ ledger, now,
    refreshPreview: hooks.refreshPreview ?? (async () => currentPreview),
    verifyDepositPlan: hooks.verifyDepositPlan ?? (async (_needs, preview) => ({ needsDigest: 'b'.repeat(64),
      quoteVersion: preview.quoteVersion, amountBaseUnits: preview.amountBaseUnits })),
    verifyNileReferenceBlock: hooks.verifyNileReferenceBlock ?? (async () => {}),
    readTransaction: async txId => ({ ...unknown, txId }),
    readPosition: async () => ({
      id: 'position-after', planId: currentPreview.planId,
      positionId: `nile:${currentPreview.walletAddress}:${NILE_JTRX_CANDIDATE}`,
      walletAddress: currentPreview.walletAddress, chain: 'nile',
      receiptToken: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
      receiptBalanceBaseUnits: '50000', exchangeRateRaw: '2000000000000000000',
      underlyingToken: { symbol: 'TRX', address: null, decimals: 6 },
      underlyingValueBaseUnits: '1000000', source,
    } satisfies Observation),
  });
}

function authenticate(api: ReturnType<typeof service>, account: ReturnType<typeof wallet>) {
  const challenge = api.challenge(account.address, origin);
  const signature = Trx.signMessageV2(challenge.message, account.privateKey);
  return api.authenticate({ challengeId: challenge.challengeId, address: account.address, signature }, origin);
}

describe('Nile approval API service', () => {
  it('blocks a jTRX reservation while the same wallet has an unresolved PSM intent', async () => {
    const account = wallet();
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      ledger.reserveIntent({ chain: 'nile', account: account.address, policyVersion: 1,
        triggerId: createTriggerId({ kind: 'chain_event', sourceId: 'psm-pending', positionVersion: 'before-psm' }),
        action: 'approve', targetPosition: `nile:${account.address}:${NILE_PSM_CONTRACTS.psm}`,
        positionVersion: 'before-psm', planId: `nile:psm:roundtrip:v1:${'a'.repeat(64)}`,
        previewId: 'psm-preview', previewFingerprint: 'psm-before',
        previewExpiresAt: new Date(fixedNow + 120_000).toISOString(),
        amountBaseUnits: '1000000000000000000', maxFeeBaseUnits: '1000000',
        targetContract: NILE_PSM_CONTRACTS.usdd, targetMethod: 'approve(address,uint256)',
      });
      const jtrxPreview = preview(account.address);
      await expect(service(ledger, jtrxPreview).reserve(account.address, jtrxPreview,
        jtrxPreview.id, needs)).rejects.toThrow('미확정 PSM 거래');
      expect(ledger.listUnresolved()).toHaveLength(1);
    } finally { ledger.close(); }
  });

  it('requires a one-time wallet message signature bound to the address and local origin', async () => {
    const account = wallet();
    const other = wallet();
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const api = service(ledger, preview(account.address));
      const challenge = api.challenge(account.address, origin);
      const wrong = Trx.signMessageV2(challenge.message, other.privateKey);
      expect(() => api.authenticate({ challengeId: challenge.challengeId,
        address: account.address, signature: wrong }, origin)).toThrow('인증된 Nile 지갑');
      expect(() => api.authenticate({ challengeId: challenge.challengeId,
        address: account.address, signature: Trx.signMessageV2(challenge.message, account.privateKey) }, origin))
        .toThrow('만료되었거나');
      const authenticated = authenticate(api, account);
      expect(api.accountFor(`gwdc_nile_approval=${authenticated.token}`, origin)).toBe(account.address);
      expect(() => api.accountFor(`gwdc_nile_approval=${authenticated.token}`, 'http://localhost:5173'))
        .toThrow('승인 세션');
      const intent = await api.reserve(account.address, preview(account.address), 'approval-preview-1', needs);
      expect(() => api.cancel(other.address, intent.id)).toThrow('인증된 Nile 지갑');
      expect(api.cancel(account.address, intent.id).status).toBe('cancelled');
    } finally { ledger.close(); }
  });

  it('persists a signed original before broadcast, survives restart, and blocks a second transaction', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gwdc-approval-test-'));
    const path = join(directory, 'ledger.sqlite');
    const key = randomBytes(32);
    const account = wallet();
    const currentPreview = preview(account.address);
    let ledger = createActionLedger({ path, encryptionKey: key,
      now: () => new Date(fixedNow).toISOString() });
    try {
      let api = service(ledger, currentPreview);
      const auth = authenticate(api, account);
      expect(api.accountFor(`gwdc_nile_approval=${auth.token}`, origin)).toBe(account.address);
      const intent = await api.reserve(account.address, currentPreview, currentPreview.id, needs);
      const signed = signedTransaction(account);
      expect((await api.acceptSigned(account.address, { intentId: intent.id, preview: currentPreview,
        signedTransaction: signed })).status).toBe('signed');
      expect(ledger.getIntent(intent.id)?.txId).toBe(signed.txID);
      const ready = await api.beginBroadcast(account.address, { intentId: intent.id, preview: currentPreview });
      expect(ready.intent.status).toBe('broadcasting');
      expect(ready.signedTransaction).toEqual(signed);
      ledger.close();
      ledger = createActionLedger({ path, encryptionKey: key,
        now: () => new Date(fixedNow).toISOString() });
      api = service(ledger, currentPreview);
      expect(() => api.accountFor(`gwdc_nile_approval=${auth.token}`, origin)).toThrow('만료되었습니다');
      authenticate(api, account);
      expect(api.unresolved(account.address)).toMatchObject([{ id: intent.id, txId: signed.txID,
        status: 'broadcasting', needsDigest: 'b'.repeat(64), quoteVersion: 'quote-1',
        planCheck: 'matched_current_needs', amountBaseUnits: '1000000' }]);
      expect(ledger.getSignedTransaction(intent.id)).toEqual(signed);
      await expect(api.beginBroadcast(account.address, { intentId: intent.id, preview: currentPreview }))
        .rejects.toThrow('이미 방송을 시도했습니다');
      await expect(api.reserve(account.address, { ...currentPreview, id: 'different-preview' }, 'different-preview', needs))
        .rejects.toThrow('미해결 거래');
      expect(api.recordBroadcastResult(account.address, intent.id, null).status).toBe('unknown');
      expect((await api.reconcile(account.address, intent.id)).intent.status).toBe('unknown');
      expect(api.unresolved(account.address)).toHaveLength(1);
    } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('fails closed when signed bytes cannot be committed and never releases a broadcast payload', async () => {
    const account = wallet();
    const currentPreview = preview(account.address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const broken = { ...ledger, recordSignedTransaction: () => { throw new Error('simulated disk failure'); } };
      const api = service(broken, currentPreview);
      const intent = await api.reserve(account.address, currentPreview, currentPreview.id, needs);
      await expect(api.acceptSigned(account.address, { intentId: intent.id, preview: currentPreview,
        signedTransaction: signedTransaction(account) })).rejects.toThrow('simulated disk failure');
      expect(ledger.getIntent(intent.id)).toMatchObject({ status: 'reserved', txId: null });
      await expect(api.beginBroadcast(account.address, { intentId: intent.id, preview: currentPreview }))
        .rejects.toThrow('저장된 서명 거래가 없습니다');
    } finally { ledger.close(); }
  });

  it('C-06 never releases a persisted signed payload with the wrong ledger encryption key', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'gwdc-approval-key-'));
    const path = join(directory, 'ledger.sqlite');
    const key = randomBytes(32);
    const account = wallet();
    const currentPreview = preview(account.address);
    let ledger = createActionLedger({ path, encryptionKey: key,
      now: () => new Date(fixedNow).toISOString() });
    try {
      let api = service(ledger, currentPreview);
      const intent = await api.reserve(account.address, currentPreview, currentPreview.id, needs);
      const signed = signedTransaction(account);
      await api.acceptSigned(account.address, { intentId: intent.id,
        preview: currentPreview, signedTransaction: signed });
      ledger.close();
      ledger = createActionLedger({ path, encryptionKey: randomBytes(32),
        now: () => new Date(fixedNow).toISOString() });
      api = service(ledger, currentPreview);
      await expect(api.beginBroadcast(account.address, { intentId: intent.id,
        preview: currentPreview })).rejects.toThrow();
      expect(ledger.getIntent(intent.id)).toMatchObject({ status: 'signed', txId: signed.txID,
        broadcastStartedAt: null });
      ledger.close();
      ledger = createActionLedger({ path, encryptionKey: key,
        now: () => new Date(fixedNow).toISOString() });
      expect(ledger.getSignedTransaction(intent.id)).toEqual(signed);
    } finally { ledger.close(); rmSync(directory, { recursive: true, force: true }); }
  });

  it('C-04 permits two approval clients to share one intent and one broadcast attempt only', async () => {
    const account = wallet();
    const currentPreview = preview(account.address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const first = service(ledger, currentPreview);
      const second = service(ledger, currentPreview);
      const [one, two] = await Promise.all([
        first.reserve(account.address, currentPreview, currentPreview.id, needs),
        second.reserve(account.address, currentPreview, currentPreview.id, needs),
      ]);
      expect(one.id).toBe(two.id);
      expect(ledger.listUnresolved()).toHaveLength(1);
      const signed = signedTransaction(account);
      await first.acceptSigned(account.address, { intentId: one.id,
        preview: currentPreview, signedTransaction: signed });
      const attempts = await Promise.allSettled([
        first.beginBroadcast(account.address, { intentId: one.id, preview: currentPreview }),
        second.beginBroadcast(account.address, { intentId: two.id, preview: currentPreview }),
      ]);
      expect(attempts.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      expect(attempts.filter(result => result.status === 'rejected')).toHaveLength(1);
      expect(ledger.getIntent(one.id)).toMatchObject({ status: 'broadcasting', txId: signed.txID });
      expect(ledger.listEvents(one.id).filter(event => event.event === 'broadcast_attempt')).toHaveLength(1);
    } finally { ledger.close(); }
  });

  it('C-03 keeps RPC errors before reservation, signing, and broadcast fail-closed', async () => {
    const account = wallet();
    const currentPreview = preview(account.address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const rateLimited = service(ledger, currentPreview, () => fixedNow, {
        refreshPreview: async () => { throw new Error('Nile RPC HTTP 429'); },
      });
      await expect(rateLimited.reserve(account.address, currentPreview, currentPreview.id, needs))
        .rejects.toThrow('Nile RPC HTTP 429');
      expect(ledger.listUnresolved()).toEqual([]);

      const staleReference = service(ledger, currentPreview, () => fixedNow, {
        verifyNileReferenceBlock: async () => { throw new Error('Nile reference block timeout'); },
      });
      const intent = await staleReference.reserve(account.address, currentPreview, currentPreview.id, needs);
      await expect(staleReference.acceptSigned(account.address, { intentId: intent.id,
        preview: currentPreview, signedTransaction: signedTransaction(account) }))
        .rejects.toThrow('Nile reference block timeout');
      expect(ledger.getIntent(intent.id)).toMatchObject({ status: 'reserved', txId: null });
      expect(() => ledger.markBroadcastAttempt(intent.id)).toThrow('서명 원본');
    } finally { ledger.close(); }
  });

  it('C-02 refuses an approval intent when the real plan verifier sees fees consuming protected spending', async () => {
    const account = wallet();
    const protectedNeeds = userNeedsSchema.parse({ ...needs, amount: '21',
      expenses: [{ date: '2026-10-07', amount: '20', asset: needs.asset }] });
    const quote = productQuoteSchema.parse({ id: 'nile-jtrx', quoteVersion: 'quote-1',
      product: 'justlend_jtrx', chain: 'nile', marketAddress: NILE_JTRX_CANDIDATE,
      inputToken: needs.asset, depositToken: needs.asset,
      receiptToken: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
      baseRate: null, reward: null, liquidity: { exitAvailable: '1000', withdrawalDelayDays: 0 },
      conversion: null, costs: [], status: 'active', risks: [], source });
    const plan = createNilePlans(protectedNeeds, quote, {
      walletBalance: '23', now: new Date(fixedNow),
    }).plans[1];
    expect(plan.allocation.invested).toBe('1');
    const original = preview(account.address);
    const currentPreview = { ...original, planId: plan.id,
      state: { ...original.state, walletBalanceSun: '23000000' } };
    let actualBalanceSun = '21000000';
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const api = service(ledger, currentPreview, () => fixedNow, {
        verifyDepositPlan: (rawNeeds, checkedPreview) => verifyNileApprovalPlan(rawNeeds, checkedPreview, {
          readQuote: async () => ({ jTrx: quote, diagnostics: [] }),
          readWalletBalance: async () => ({ balanceSun: actualBalanceSun }),
          now: () => new Date(fixedNow),
        }),
      });
      await expect(api.reserve(account.address, currentPreview, currentPreview.id, protectedNeeds))
        .rejects.toThrow('예정 지출·예비액');
      expect(ledger.listUnresolved()).toEqual([]);
      actualBalanceSun = '23000000';
      expect((await api.reserve(account.address, currentPreview, currentPreview.id, protectedNeeds)).status)
        .toBe('reserved');
    } finally { ledger.close(); }
  });

  it('C-03 uses only the persisted signed original after pre-sign validation, without a mutable RPC recheck', async () => {
    const account = wallet();
    const currentPreview = preview(account.address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    let reads = 0;
    try {
      const api = service(ledger, currentPreview, () => fixedNow, {
        refreshPreview: async () => {
          reads += 1;
          if (reads === 2) throw new Error('Nile RPC timeout');
          return currentPreview;
        },
      });
      const intent = await api.reserve(account.address, currentPreview, currentPreview.id, needs);
      const signed = signedTransaction(account);
      await api.acceptSigned(account.address, { intentId: intent.id,
        preview: currentPreview, signedTransaction: signed });
      const ready = await api.beginBroadcast(account.address, { intentId: intent.id, preview: currentPreview });
      expect(ready.signedTransaction).toEqual(signed);
      expect(reads).toBe(1);
      expect(ledger.getIntent(intent.id)).toMatchObject({ status: 'broadcasting', txId: signed.txID });
      expect(ledger.listPendingRecovery()).toHaveLength(1);
      await expect(api.beginBroadcast(account.address, { intentId: intent.id, preview: currentPreview }))
        .rejects.toThrow('이미 방송을 시도했습니다');
    } finally { ledger.close(); }
  });

  it('rejects an additional TRC-10 transfer hidden in a jTRX call', async () => {
    const account = wallet();
    const currentPreview = preview(account.address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const api = service(ledger, currentPreview);
      const intent = await api.reserve(account.address, currentPreview, currentPreview.id, needs);
      await expect(api.acceptSigned(account.address, { intentId: intent.id, preview: currentPreview,
        signedTransaction: signedTransaction(account, { call_token_value: 1, token_id: 1000001 }),
      })).rejects.toThrow('계정·계약·함수·수량');
      expect(ledger.getIntent(intent.id)).toMatchObject({ status: 'reserved', txId: null });
    } finally { ledger.close(); }
  });

  it('reserves a withdrawal only against a confirmed same-account deposit intent', async () => {
    const account = wallet();
    const deposit = preview(account.address);
    const withdrawal = withdrawalPreview(deposit);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const depositApi = service(ledger, deposit);
      const original = await depositApi.reserve(account.address, deposit, deposit.id, needs);
      const withdrawalApi = service(ledger, withdrawal);
      await expect(withdrawalApi.reserve(account.address, withdrawal, withdrawal.id))
        .rejects.toThrow('원 예치 의도 ID');
      await expect(withdrawalApi.reserve(account.address, withdrawal, withdrawal.id, undefined, original.id))
        .rejects.toThrow('확정된 Nile 예치 의도');
      const signed = signedTransaction(account);
      await depositApi.acceptSigned(account.address, { intentId: original.id, preview: deposit,
        signedTransaction: signed });
      ledger.recordSolidifiedOutcome(original.id, { txId: signed.txID, status: 'confirmed',
        solidifiedAt: new Date(fixedNow).toISOString(), receipt: { id: signed.txID, receipt: { result: 'SUCCESS' } } });
      const wrongQuote = { ...withdrawal, quoteVersion: 'different-quote' };
      await expect(withdrawalApi.reserve(account.address, wrongQuote, wrongQuote.id, undefined, original.id))
        .rejects.toThrow('확정된 Nile 예치 의도');
      const linked = await withdrawalApi.reserve(account.address, withdrawal, withdrawal.id, undefined, original.id);
      expect(linked).toMatchObject({ action: 'withdraw', status: 'reserved',
        needsDigest: 'b'.repeat(64), quoteVersion: deposit.quoteVersion,
        planCheck: 'matched_prior_deposit', amountBaseUnits: '50000' });
    } finally { ledger.close(); }
  });
});
