import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TronWeb, utils } from 'tronweb';
import type { Observation } from '../shared/schemas';
import { createNileApprovalCoordinator } from '../server/agent/coordinator';
import { createActionLedger, createTriggerId } from '../server/agent/ledger';
import { NILE_CHAIN_ID, NILE_JTRX_CANDIDATE, type NileDepositPreview, type NileTransactionResult,
  type NileWithdrawalPreview } from '../server/transactions';
import { signedNileBandwidthBytes } from '../shared/nile-bandwidth';

const fixedNow = Date.parse('2026-09-29T03:00:00.000Z');
const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: new Date(fixedNow).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };

function wallet() {
  const privateKey = randomBytes(32).toString('hex');
  const address = TronWeb.address.fromPrivateKey(privateKey);
  if (!address) throw new Error('시험 지갑 생성 실패');
  return { privateKey, address };
}

function preview(address: string): NileDepositPreview {
  return {
    id: 'preview-1', planId: 'nile-plan-1', needsVersion: 1, quoteVersion: 'quote-1',
    walletAddress: address, chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
    amountBaseUnits: '80000000', contractAddress: NILE_JTRX_CANDIDATE, method: 'mint()', approvalScope: null,
    estimatedFeeBaseUnits: '1000000', maxFeeBaseUnits: '2000000', feeLimitSun: '1500000',
    expiresAt: new Date(fixedNow + 45_000).toISOString(), fingerprint: 'fingerprint-1', risks: [], source,
    state: {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress: address, contractAddress: NILE_JTRX_CANDIDATE,
      comptrollerAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', jtrxDecimals: 8,
      contractCodeHash: 'abc', walletBalanceSun: '300000000', jtrxBalanceRaw: '0', marketCashSun: '1000000000',
      exchangeRateRaw: '2000000000000000000', supplyRatePerBlockRaw: '100', availableEnergy: '0',
      availableBandwidth: '600', estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000',
      estimatedFeeSun: '1000000', feeLimitSun: '1500000', bandwidthFeeUpperBoundSun: '500000',
      maxFeeSun: '2000000', amountSun: '80000000', source,
    },
  };
}

function transaction(account: { privateKey: string; address: string }, overrides: {
  contractAddress?: string; callValue?: number; signerPrivateKey?: string;
} = {}) {
  const raw_data = {
    ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
    expiration: fixedNow + 60_000, timestamp: fixedNow, fee_limit: 1_500_000,
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(account.address),
      contract_address: TronWeb.address.toHex(overrides.contractAddress ?? NILE_JTRX_CANDIDATE),
      call_value: overrides.callValue ?? 80_000_000,
      data: TronWeb.sha3('mint()').replace(/^0x/, '').slice(0, 8),
    } } }],
  };
  const pb = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  const raw_data_hex = utils.transaction.txPbToRawDataHex(pb);
  const signature = utils.crypto.ECKeySign(
    Buffer.from(txID, 'hex'), Buffer.from(overrides.signerPrivateKey ?? account.privateKey, 'hex'),
  );
  return { raw_data, raw_data_hex, txID, signature: [signature] };
}

function withdrawalTransaction(account: { privateKey: string; address: string }, memoBytes = 0) {
  const raw_data = {
    ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
    expiration: fixedNow + 60_000, timestamp: fixedNow, fee_limit: 20_000_000,
    ...(memoBytes ? { data: 'ab'.repeat(memoBytes) } : {}),
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(account.address),
      contract_address: TronWeb.address.toHex(NILE_JTRX_CANDIDATE),
      call_value: 0,
      data: TronWeb.sha3('redeem(uint256)').replace(/^0x/, '').slice(0, 8) +
        BigInt(50_000_000).toString(16).padStart(64, '0'),
    } } }],
  };
  const pb = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  const raw_data_hex = utils.transaction.txPbToRawDataHex(pb);
  const signature = utils.crypto.ECKeySign(Buffer.from(txID, 'hex'), Buffer.from(account.privateKey, 'hex'));
  return { raw_data, raw_data_hex, txID, signature: [signature] };
}

function setup(initialObservation?: NileTransactionResult, withPositionReader = true) {
  const account = wallet();
  const currentPreview = preview(account.address);
  const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
    now: () => new Date(fixedNow).toISOString() });
  let observation: NileTransactionResult = initialObservation ?? {
    txId: '0'.repeat(64), status: 'unknown', receipt: null, actualFeeSun: null, reason: null, source,
  };
  let refreshed: NileDepositPreview = currentPreview;
  let position: Observation = {
    id: 'position-after', planId: currentPreview.planId,
    positionId: `nile:${account.address}:${NILE_JTRX_CANDIDATE}`,
    walletAddress: account.address, chain: 'nile',
    receiptToken: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
    receiptBalanceBaseUnits: '4000000', exchangeRateRaw: '2000000000000000000',
    underlyingToken: { symbol: 'TRX', address: null, decimals: 6 },
    underlyingValueBaseUnits: '80000000', source,
  };
  const coordinator = createNileApprovalCoordinator({ ledger,
    refreshPreview: async () => refreshed,
    readTransaction: async () => observation,
    readPosition: withPositionReader ? async () => position : undefined,
    now: () => fixedNow,
  });
  const request = {
    preview: currentPreview, confirmedPreviewId: currentPreview.id, policyVersion: 1,
    triggerId: createTriggerId({ kind: 'schedule', sourceId: '2026-09-29T12:00+09:00', positionVersion: 'block-100' }),
    positionVersion: 'block-100',
  };
  return { account, currentPreview, ledger, coordinator, request,
    setObservation: (value: NileTransactionResult) => { observation = value; },
    setPosition: (value: Observation) => { position = value; },
    setRefreshed: (value: NileDepositPreview) => { refreshed = value; } };
}

function withdrawalPreview(address: string): NileWithdrawalPreview {
  const deposit = preview(address);
  return {
    ...deposit, id: 'withdrawal-preview-1', fingerprint: 'withdrawal-fingerprint',
    asset: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
    amountBaseUnits: '50000000', method: 'redeem(uint256)',
    expectedUnderlyingSun: '100000000', estimatedFeeBaseUnits: '10000000',
    maxFeeBaseUnits: '21000000', feeLimitSun: '20000000',
    state: {
      ...deposit.state, jtrxBalanceRaw: '100000000', jtrxAmountRaw: '50000000',
      exchangeRateStoredRaw: '2000000000000000000', exchangeRateCurrentRaw: '2000000000000000000',
      expectedUnderlyingSun: '100000000', estimatedFeeSun: '10000000',
      maxFeeSun: '21000000', feeLimitSun: '20000000',
      estimatedBandwidthBytes: '1000', bandwidthFeeUpperBoundSun: '1000000',
    },
  };
}

function setupWithdrawal() {
  const base = setup();
  const currentPreview = withdrawalPreview(base.account.address);
  let refreshed = currentPreview;
  const coordinator = createNileApprovalCoordinator({
    ledger: base.ledger, refreshPreview: async () => refreshed,
    readTransaction: async () => ({ txId: '0'.repeat(64), status: 'unknown',
      receipt: null, actualFeeSun: null, reason: null, source }),
    now: () => fixedNow,
  });
  return { ...base, currentPreview, coordinator,
    request: { ...base.request, preview: currentPreview, confirmedPreviewId: currentPreview.id },
    setRefreshed: (value: NileWithdrawalPreview) => { refreshed = value; } };
}

describe('Nile approval coordinator', () => {
  it('rejects a live withdrawal without coherent Bandwidth evidence before reservation', async () => {
    const context = setupWithdrawal();
    try {
      const missing = { ...context.currentPreview, state: {
        ...context.currentPreview.state, estimatedBandwidthBytes: undefined } };
      await expect(context.coordinator.reserveApproved({ ...context.request, preview: missing }))
        .rejects.toThrow('Bandwidth 예산 근거');
      expect(context.ledger.listUnresolved()).toEqual([]);
    } finally { context.ledger.close(); }
  });

  it('rejects a signed withdrawal larger than the approved Bandwidth budget before durable storage', async () => {
    const context = setupWithdrawal();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const ordinary = withdrawalTransaction(context.account);
      expect(utils.transaction.txCheck(ordinary)).toBe(true);
      expect(signedNileBandwidthBytes(ordinary))
        .toBe(BigInt(ordinary.raw_data_hex.length / 2 + 134));
      expect(signedNileBandwidthBytes(ordinary)).toBeLessThanOrEqual(1000n);
      const oversized = withdrawalTransaction(context.account, 1200);
      expect(utils.transaction.txCheck(oversized)).toBe(true);
      expect(signedNileBandwidthBytes(oversized)).toBeGreaterThan(1000n);
      expect(() => context.coordinator.acceptSigned({ intentId: intent.id,
        preview: context.currentPreview, signedTransaction: oversized }))
        .toThrow('Bandwidth 예산을 초과');
      expect(context.ledger.getIntent(intent.id)).toMatchObject({ status: 'reserved', txId: null });
      await expect(context.coordinator.beginBroadcast({ intentId: intent.id,
        preview: context.currentPreview })).rejects.toThrow();
      expect(context.ledger.listEvents(intent.id).filter(event => event.event === 'broadcast_attempt'))
        .toHaveLength(0);
      expect(context.coordinator.acceptSigned({ intentId: intent.id,
        preview: context.currentPreview, signedTransaction: ordinary }).txId).toBe(ordinary.txID);
      const narrowed = { ...context.currentPreview, state: { ...context.currentPreview.state,
        estimatedBandwidthBytes: '100', bandwidthPriceSun: '10000' } };
      await expect(context.coordinator.beginBroadcast({ intentId: intent.id,
        preview: narrowed })).rejects.toThrow('Bandwidth 예산을 초과');
      expect(context.ledger.listEvents(intent.id).filter(event => event.event === 'broadcast_attempt'))
        .toHaveLength(0);
    } finally { context.ledger.close(); }
  });

  it('records one signed intent before a caller broadcasts and reconciles the original solidified txID', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      expect(utils.transaction.txCheck(signed)).toBe(true);
      expect(context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: signed }).txId).toBe(signed.txID);
      const ready = await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      expect(ready.intent.status).toBe('broadcasting');
      expect(ready.signedTransaction).toEqual(signed);
      expect(() => context.ledger.reserveIntent({ ...intent, triggerId: createTriggerId({
        kind: 'schedule', sourceId: 'retry', positionVersion: 'block-101',
      }), positionVersion: 'block-101' })).toThrow('미해결 거래');
      context.coordinator.recordBroadcastResult(intent.id, null);
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null, source });
      const resolved = await context.coordinator.reconcile(intent.id);
      expect(resolved.intent.status).toBe('confirmed');
      expect(resolved.intent.txId).toBe(signed.txID);
      expect(context.ledger.listPendingRecovery()).toEqual([]);
    } finally { context.ledger.close(); }
  });

  it('rejects unconfirmed or changed previews before reserving and mismatched contract or signer before storing a signature', async () => {
    const context = setup();
    try {
      await expect(context.coordinator.reserveApproved({ ...context.request, confirmedPreviewId: 'other' }))
        .rejects.toThrow('확인한 미리보기');
      context.setRefreshed({ ...context.currentPreview, fingerprint: 'changed' });
      await expect(context.coordinator.reserveApproved(context.request)).rejects.toThrow('조건이 바뀌었습니다');
      expect(context.ledger.listUnresolved()).toEqual([]);
      context.setRefreshed(context.currentPreview);
      const intent = await context.coordinator.reserveApproved(context.request);
      expect(() => context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: transaction(context.account, { contractAddress: context.account.address }) }))
        .toThrow('계정·계약');
      expect(() => context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: transaction(context.account, { signerPrivateKey: wallet().privateKey }) }))
        .toThrow('서명자가');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('reserved');
    } finally { context.ledger.close(); }
  });

  it('reserves one withdrawal intent when live cash, fee-wallet balance, or exchange rate improves', async () => {
    const improvements = [
      ['market cash', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, marketCashSun: '1100000000' } })],
      ['fee-wallet balance', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, walletBalanceSun: '400000000' } })],
      ['current exchange rate', (value: NileWithdrawalPreview) => ({ ...value,
        expectedUnderlyingSun: '105000000',
        state: { ...value.state, exchangeRateCurrentRaw: '2100000000000000000',
          expectedUnderlyingSun: '105000000' } })],
    ] as const;
    for (const [condition, change] of improvements) {
      const context = setupWithdrawal();
      try {
        context.setRefreshed({ ...change(context.currentPreview), fingerprint: `improved-${condition}` });
        const intent = await context.coordinator.reserveApproved(context.request);
        expect(intent.action, condition).toBe('withdraw');
        expect(intent.amountBaseUnits, condition).toBe(context.currentPreview.amountBaseUnits);
        expect(context.ledger.listUnresolved(), condition).toHaveLength(1);
      } finally { context.ledger.close(); }
    }
  });

  it('never reserves a withdrawal on changed core inputs, contract evidence, or insufficient exit resources', async () => {
    const changes = [
      ['amount', (value: NileWithdrawalPreview) => ({ ...value, amountBaseUnits: '60000000',
        expectedUnderlyingSun: '120000000', state: { ...value.state,
          jtrxAmountRaw: '60000000', expectedUnderlyingSun: '120000000' } })],
      ['contract', (value: NileWithdrawalPreview) => ({ ...value,
        contractAddress: value.state.comptrollerAddress,
        asset: { ...value.asset, address: value.state.comptrollerAddress },
        state: { ...value.state, contractAddress: value.state.comptrollerAddress } })],
      ['fee ceiling', (value: NileWithdrawalPreview) => ({ ...value,
        feeLimitSun: '20000001', maxFeeBaseUnits: '21000001',
        state: { ...value.state, feeLimitSun: '20000001', maxFeeSun: '21000001' } })],
      ['underlying value', (value: NileWithdrawalPreview) => ({ ...value,
        expectedUnderlyingSun: '95000000', state: { ...value.state,
          exchangeRateCurrentRaw: '1900000000000000000', expectedUnderlyingSun: '95000000' } })],
      ['jTRX holdings', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, jtrxBalanceRaw: '90000000' } })],
      ['contract code', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, contractCodeHash: 'changed-code' } })],
      ['insufficient market cash', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, marketCashSun: '99999999' } })],
      ['insufficient fee balance', (value: NileWithdrawalPreview) => ({ ...value,
        state: { ...value.state, walletBalanceSun: '20999999' } })],
    ] as const;
    for (const [condition, change] of changes) {
      const context = setupWithdrawal();
      try {
        context.setRefreshed({ ...change(context.currentPreview),
          fingerprint: `unsafe-${condition}` });
        await expect(context.coordinator.reserveApproved(context.request), condition).rejects.toThrow();
        expect(context.ledger.listUnresolved(), condition).toEqual([]);
      } finally { context.ledger.close(); }
    }
  });

  it('broadcasts only the durable signed original once if mutable market values change after signing', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview, signedTransaction: signed });
      context.setRefreshed({ ...context.currentPreview, fingerprint: 'changed-before-broadcast' });
      const ready = await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      expect(ready.signedTransaction).toEqual(signed);
      expect(ready.intent).toMatchObject({ status: 'broadcasting', txId: signed.txID });
      await expect(context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview }))
        .rejects.toThrow('이미 방송을 시도했습니다');
      expect(context.ledger.listEvents(intent.id).filter(event => event.event === 'broadcast_attempt')).toHaveLength(1);
      expect(context.ledger.listPendingRecovery()).toHaveLength(1);
    } finally { context.ledger.close(); }
  });

  it('does not mark a successful receipt confirmed until the same position changes in a fresh RPC read', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview, signedTransaction: signed });
      await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      context.coordinator.recordBroadcastResult(intent.id, true);
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null, source });
      const matchingPosition: Observation = {
        id: 'position-after', planId: context.currentPreview.planId,
        positionId: `nile:${context.account.address}:${NILE_JTRX_CANDIDATE}`,
        walletAddress: context.account.address, chain: 'nile',
        receiptToken: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
        receiptBalanceBaseUnits: '4000000', exchangeRateRaw: '2000000000000000000',
        underlyingToken: { symbol: 'TRX', address: null, decimals: 6 },
        underlyingValueBaseUnits: '80000000', source,
      };
      context.setPosition({ ...matchingPosition, receiptBalanceBaseUnits: '0' });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('포지션 변화');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');
      context.setPosition({ ...matchingPosition, source: {
        ...source, fetchedAt: new Date(fixedNow - 1000).toISOString(),
      } });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('최신 RPC 관측');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');
      context.setPosition({ ...matchingPosition, walletAddress: wallet().address });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('동일 Nile 포지션');
      context.setPosition({ ...matchingPosition, positionId: `nile:${context.account.address}:${context.account.address}` });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('동일 Nile 포지션');
      context.setPosition(matchingPosition);
      expect((await context.coordinator.reconcile(intent.id)).intent.status).toBe('confirmed');
    } finally { context.ledger.close(); }
  });

  it('holds a successful receipt when the post-transaction position reader is unavailable', async () => {
    const context = setup(undefined, false);
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview, signedTransaction: signed });
      await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      context.coordinator.recordBroadcastResult(intent.id, true);
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('재관측 경로');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');
    } finally { context.ledger.close(); }
  });

  it('keeps one intent unresolved through pending and unknown reads, then confirms only its own complete receipt', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: signed });
      await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      context.coordinator.recordBroadcastResult(intent.id, true);
      const pending: NileTransactionResult = { txId: signed.txID, status: 'pending', receipt: null,
        actualFeeSun: null, reason: null, source };
      context.setObservation(pending);
      expect((await context.coordinator.reconcile(intent.id)).observation.status).toBe('pending');
      context.setObservation({ ...pending, status: 'unknown', reason: 'RPC timeout' });
      expect((await context.coordinator.reconcile(intent.id)).observation.status).toBe('unknown');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');

      const receipt = { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' };
      context.setObservation({ txId: 'f'.repeat(64), status: 'confirmed', receipt,
        actualFeeSun: '12345', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('원 txID');
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { ...receipt, id: 'f'.repeat(64) }, actualFeeSun: '12345', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('영수증');
      context.setObservation({ txId: signed.txID, status: 'confirmed', receipt,
        actualFeeSun: null, reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('수수료');
      context.setObservation({ txId: signed.txID, status: 'confirmed', receipt,
        actualFeeSun: '999', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('실제 수수료');
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { ...receipt, receipt: { result: 'REVERT' } },
        actualFeeSun: '12345', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('상태');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');

      context.setObservation({ txId: signed.txID, status: 'confirmed', receipt,
        actualFeeSun: '12345', reason: null, source });
      expect((await context.coordinator.reconcile(intent.id)).intent.status).toBe('confirmed');
      context.setObservation(pending);
      expect((await context.coordinator.reconcile(intent.id)).intent.status).toBe('confirmed');
      expect(context.ledger.listEvents(intent.id).map(event => event.event).at(-1)).toBe('confirmed');
    } finally { context.ledger.close(); }
  });

  it('records a solidified revert as failed and never changes that final outcome', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: signed });
      await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      context.coordinator.recordBroadcastResult(intent.id, null);
      context.setObservation({ txId: signed.txID, status: 'failed',
        receipt: { id: signed.txID, receipt: { result: 'REVERT' }, fee: '12345' },
        actualFeeSun: '12345', reason: 'REVERT', source });
      expect((await context.coordinator.reconcile(intent.id)).intent.status).toBe('failed');
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null, source });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('확정된 거래 결과');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('failed');
    } finally { context.ledger.close(); }
  });

  it('does not confirm a receipt observation fetched before the broadcast attempt', async () => {
    const context = setup();
    try {
      const intent = await context.coordinator.reserveApproved(context.request);
      const signed = transaction(context.account);
      context.coordinator.acceptSigned({ intentId: intent.id, preview: context.currentPreview,
        signedTransaction: signed });
      await context.coordinator.beginBroadcast({ intentId: intent.id, preview: context.currentPreview });
      context.coordinator.recordBroadcastResult(intent.id, true);
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null,
        source: { ...source, fetchedAt: new Date(fixedNow - 60_000).toISOString() } });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('최신 Nile RPC 영수증');
      context.setObservation({ txId: signed.txID, status: 'confirmed',
        receipt: { id: signed.txID, receipt: { result: 'SUCCESS' }, fee: '12345' },
        actualFeeSun: '12345', reason: null,
        source: { ...source, fetchedAt: new Date(fixedNow + 60_000).toISOString() } });
      await expect(context.coordinator.reconcile(intent.id)).rejects.toThrow('최신 Nile RPC 영수증');
      expect(context.ledger.getIntent(intent.id)?.status).toBe('pending');
    } finally { context.ledger.close(); }
  });
});
