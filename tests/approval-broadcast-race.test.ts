import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { TronWeb, utils } from 'tronweb';
import { createNileApprovalCoordinator } from '../server/agent/coordinator';
import { createActionLedger, createTriggerId } from '../server/agent/ledger';
import { NILE_CHAIN_ID, NILE_JTRX_CANDIDATE, type NileDepositPreview } from '../server/transactions';

const fixedNow = Date.parse('2026-09-29T03:00:00.000Z');
const source = {
  sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: new Date(fixedNow).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const,
};

function preview(address: string): NileDepositPreview {
  return {
    id: 'preview-1', planId: 'nile-plan-1', needsVersion: 1, quoteVersion: 'quote-1',
    walletAddress: address, chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
    amountBaseUnits: '1000000', contractAddress: NILE_JTRX_CANDIDATE, method: 'mint()', approvalScope: null,
    estimatedFeeBaseUnits: '1000000', maxFeeBaseUnits: '2000000', feeLimitSun: '1500000',
    expiresAt: new Date(fixedNow + 180_000).toISOString(), fingerprint: 'before-signature', risks: [], source,
    state: {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress: address, contractAddress: NILE_JTRX_CANDIDATE,
      comptrollerAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', jtrxDecimals: 8,
      contractCodeHash: 'abc', walletBalanceSun: '1000000000', jtrxBalanceRaw: '0',
      marketCashSun: '1000000000', exchangeRateRaw: '2000000000000000000',
      supplyRatePerBlockRaw: '100', availableEnergy: '0', availableBandwidth: '600',
      estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000',
      estimatedFeeSun: '1000000', feeLimitSun: '1500000', bandwidthFeeUpperBoundSun: '500000',
      maxFeeSun: '2000000', amountSun: '1000000', source,
    },
  };
}

function signedMint(privateKey: string, address: string, expiration = fixedNow + 240_000) {
  const raw_data = {
    ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
    expiration, timestamp: fixedNow, fee_limit: 1_500_000,
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(address),
      contract_address: TronWeb.address.toHex(NILE_JTRX_CANDIDATE),
      call_value: 1_000_000,
      data: TronWeb.sha3('mint()').replace(/^0x/, '').slice(0, 8),
    } } }],
  };
  const protobuf = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(protobuf).replace(/^0x/, '');
  return {
    raw_data, raw_data_hex: utils.transaction.txPbToRawDataHex(protobuf), txID,
    signature: [utils.crypto.ECKeySign(Buffer.from(txID, 'hex'), Buffer.from(privateKey, 'hex'))],
  };
}

describe('Nile approval broadcast after a TronLink signature', () => {
  it('uses the stored original transaction once when only mutable market state changes', async () => {
    const privateKey = randomBytes(32).toString('hex');
    const address = TronWeb.address.fromPrivateKey(privateKey);
    if (!address) throw new Error('시험 지갑 생성 실패');
    const original = preview(address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    const refreshPreview = vi.fn(async () => original);
    const coordinator = createNileApprovalCoordinator({ ledger, refreshPreview,
      readTransaction: async () => { throw new Error('방송 전 조회 불필요'); }, now: () => fixedNow });
    try {
      const intent = await coordinator.reserveApproved({ preview: original, confirmedPreviewId: original.id,
        policyVersion: 1, triggerId: createTriggerId({ kind: 'schedule', sourceId: original.id,
          positionVersion: original.fingerprint }), positionVersion: original.fingerprint });
      const signed = signedMint(privateKey, address);
      coordinator.acceptSigned({ intentId: intent.id, preview: original, signedTransaction: signed });

      // The quote and exit liquidity can move while TronLink's signature prompt is open.
      refreshPreview.mockResolvedValueOnce({ ...original, fingerprint: 'after-signature',
        state: { ...original.state, marketCashSun: '999999999' } });
      const first = await coordinator.beginBroadcast({ intentId: intent.id, preview: original });
      expect(first.intent.status).toBe('broadcasting');
      expect(first.signedTransaction).toEqual(signed);
      expect(refreshPreview).toHaveBeenCalledTimes(1); // Reservation only.
      await expect(coordinator.beginBroadcast({ intentId: intent.id, preview: original }))
        .rejects.toThrow('이미 방송을 시도했습니다');
      expect(ledger.listEvents(intent.id).filter(event => event.event === 'broadcast_attempt')).toHaveLength(1);
    } finally { ledger.close(); }
  });

  it('still rejects a different preview and an expired signed transaction', async () => {
    const privateKey = randomBytes(32).toString('hex');
    const address = TronWeb.address.fromPrivateKey(privateKey);
    if (!address) throw new Error('시험 지갑 생성 실패');
    const original = preview(address);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    let currentTime = fixedNow;
    const coordinator = createNileApprovalCoordinator({ ledger, refreshPreview: async () => original,
      readTransaction: async () => { throw new Error('방송 전 조회 불필요'); }, now: () => currentTime });
    try {
      const intent = await coordinator.reserveApproved({ preview: original, confirmedPreviewId: original.id,
        policyVersion: 1, triggerId: createTriggerId({ kind: 'schedule', sourceId: original.id,
          positionVersion: original.fingerprint }), positionVersion: original.fingerprint });
      coordinator.acceptSigned({ intentId: intent.id, preview: original,
        signedTransaction: signedMint(privateKey, address, fixedNow + 60_000) });
      await expect(coordinator.beginBroadcast({ intentId: intent.id,
        preview: { ...original, amountBaseUnits: '2000000' } })).rejects.toThrow('저장된 거래 의도');
      currentTime = fixedNow + 60_000;
      await expect(coordinator.beginBroadcast({ intentId: intent.id, preview: original }))
        .rejects.toThrow('유효 시간');
      expect(ledger.getIntent(intent.id)?.status).toBe('signed');
    } finally { ledger.close(); }
  });
});
