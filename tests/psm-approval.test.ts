import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { TronWeb, utils } from 'tronweb';
import { createActionLedger, createTriggerId } from '../server/agent/ledger';
import { NILE_PSM_CONTRACTS, quoteNilePsmBuy, type NilePsmState } from '../server/nile-psm';
import { createNilePsmApprovalService, createNilePsmPreview, type NilePsmPreview } from '../server/psm-approval';
import { NILE_JTRX_CANDIDATE, type NileTransactionResult } from '../server/transactions';

const fixedNow = Date.parse('2026-09-30T03:00:00.000Z');
const C = NILE_PSM_CONTRACTS;
const quote = quoteNilePsmBuy('1000000', '2000000000000000');
const source = (time: number) => ({ sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract',
  chain: 'nile' as const, fetchedAt: new Date(time).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const });

function wallet() {
  const privateKey = randomBytes(32).toString('hex');
  const address = TronWeb.address.fromPrivateKey(privateKey);
  if (!address) throw new Error('test wallet');
  return { address, privateKey };
}

function state(address: string, time = fixedNow): NilePsmState {
  return {
    chain: 'nile', walletAddress: address,
    psmAddress: C.psm, gemJoinAddress: C.gemJoin, usdtAddress: C.usdt, usddAddress: C.usdd,
    vatAddress: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t',
    usdtBalanceRaw: '0', usddBalanceRaw: '10000000000000000000',
    usdtAllowanceToGemJoinRaw: '0', usddAllowanceToPsmRaw: '0',
    trxBalanceSun: '100000000', fetchedAt: new Date(time).toISOString(),
    sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract', source: source(time),
    contractCodeHashes: { psm: 'a'.repeat(64), gemJoin: 'b'.repeat(64),
      usdt: 'c'.repeat(64), usdd: 'd'.repeat(64), vat: 'e'.repeat(64) },
    sellEnabled: true, buyEnabled: true, tinRaw: '1200000000000000', toutRaw: '2000000000000000',
    usdtTransferFeeBasisPointsRaw: '0', usdtPaused: false, usdtDeprecated: false,
    entryCapacityUsdtRaw: '100000000', exitCapacityUsdtRaw: '100000000',
    quote, needsApproval: true, blockedReasons: [],
  };
}

function fakeRpc(now: number) {
  return async (endpoint: string, body: Record<string, unknown>): Promise<unknown> => {
    if (endpoint === '/wallet/estimateenergy') return { result: { result: true }, energy_required: 1000 };
    if (endpoint === '/wallet/getchainparameters') return { chainParameter: [
      { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1 },
      { key: 'getMaxFeeLimit', value: 1000000000 },
    ] };
    if (endpoint === '/wallet/triggersmartcontract') {
      const selector = TronWeb.sha3(String(body.function_selector)).replace(/^0x/, '').slice(0, 8);
      return { result: { result: true }, transaction: {
        txID: 'a'.repeat(64), raw_data_hex: 'ab'.repeat(100),
        raw_data: { fee_limit: body.fee_limit, expiration: now + 60_000,
          contract: [{ type: 'TriggerSmartContract', parameter: { value: {
            owner_address: TronWeb.address.toHex(String(body.owner_address)),
            contract_address: TronWeb.address.toHex(String(body.contract_address)),
            call_value: 0, data: selector + body.parameter,
          } } }],
        },
      } };
    }
    throw new Error(`unexpected RPC ${endpoint}`);
  };
}

function signedTransaction(walletAccount: ReturnType<typeof wallet>, preview: NilePsmPreview,
  argumentAddress = preview.argumentAddress, signingAccount = walletAccount) {
  const selector = TronWeb.sha3(preview.method).replace(/^0x/, '').slice(0, 8);
  const addressWord = TronWeb.address.toHex(argumentAddress).slice(2).padStart(64, '0');
  const amountWord = BigInt(preview.amountBaseUnits).toString(16).padStart(64, '0');
  const raw_data = {
    ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
    timestamp: fixedNow, expiration: fixedNow + 60_000, fee_limit: Number(preview.feeLimitSun),
    contract: [{ type: 'TriggerSmartContract', parameter: { value: {
      owner_address: TronWeb.address.toHex(walletAccount.address),
      contract_address: TronWeb.address.toHex(preview.contractAddress),
      call_value: 0, data: selector + addressWord + amountWord,
    } } }],
  };
  const pb = utils.transaction.txJsonToPb({ raw_data });
  const txID = utils.transaction.txPbToTxID(pb).replace(/^0x/, '');
  const raw_data_hex = utils.transaction.txPbToRawDataHex(pb);
  const signature = utils.crypto.ECKeySign(Buffer.from(txID, 'hex'), Buffer.from(signingAccount.privateKey, 'hex'));
  return { raw_data, txID, raw_data_hex, signature: [signature] };
}

describe('Nile PSM approval gate', () => {
  it('blocks a PSM reservation while the same wallet has an unresolved jTRX intent', async () => {
    const account = wallet();
    const preview = await createNilePsmPreview({ walletAddress: account.address,
      gemAmountRaw: '1000000', step: 'approve_usdd' }, {
      readState: async () => state(account.address), rpc: fakeRpc(fixedNow), now: () => fixedNow,
    });
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      ledger.reserveIntent({ chain: 'nile', account: account.address, policyVersion: 1,
        triggerId: createTriggerId({ kind: 'chain_event', sourceId: 'jtrx-pending', positionVersion: 'before-jtrx' }),
        action: 'deposit', targetPosition: `nile:${account.address}:${NILE_JTRX_CANDIDATE}`,
        positionVersion: 'before-jtrx', planId: `nile:justlend_jtrx:80_20:v2:${'a'.repeat(64)}`,
        previewId: 'jtrx-preview', previewFingerprint: 'jtrx-before',
        previewExpiresAt: new Date(fixedNow + 120_000).toISOString(),
        amountBaseUnits: '1000000', maxFeeBaseUnits: '1000000',
        targetContract: NILE_JTRX_CANDIDATE, targetMethod: 'mint()',
      });
      const approval = createNilePsmApprovalService({ ledger, refreshPreview: async () => preview,
        readBalances: async () => state(account.address), verifyNileReferenceBlock: async () => {},
        now: () => fixedNow });
      await expect(approval.reserve(account.address, preview, preview.id)).rejects.toThrow('미확정 거래');
      expect(ledger.listUnresolved()).toHaveLength(1);
    } finally { ledger.close(); }
  });

  it('keeps the preview fingerprint stable across fetchedAt changes and reserves only a fresh exact call', async () => {
    const account = wallet();
    let currentTime = fixedNow;
    const build = () => createNilePsmPreview({ walletAddress: account.address,
      gemAmountRaw: '1000000', step: 'approve_usdd' }, {
      readState: async () => state(account.address, currentTime), rpc: fakeRpc(fixedNow), now: () => currentTime,
    });
    const first = await build();
    currentTime += 1000;
    const second = await build();
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.id).not.toBe(second.id);
    expect(first.argumentAddress).toBe(C.psm);
    expect(first.amountBaseUnits).toBe(quote.usddAmountRaw);
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(fixedNow).toISOString() });
    try {
      const approval = createNilePsmApprovalService({ ledger, refreshPreview: async () => build(),
        readBalances: async () => state(account.address), verifyNileReferenceBlock: async () => {},
        now: () => currentTime });
      const intent = await approval.reserve(account.address, first, first.id);
      expect(intent).toMatchObject({ action: 'approve', status: 'reserved',
        targetContract: C.usdd, targetMethod: 'approve(address,uint256)', amountBaseUnits: quote.usddAmountRaw });
      await expect(approval.reserve(account.address, first, first.id)).rejects.toThrow('미확정 거래');
      const mutated = { ...first, argumentAddress: C.gemJoin };
      await expect(approval.reserve(account.address, mutated, mutated.id)).rejects.toThrow();
    } finally { ledger.close(); }
  });

  it('checks the signer and exact calldata, stores signed bytes before broadcast, and confirms the allowance read', async () => {
    const account = wallet();
    let now = fixedNow;
    const preview = await createNilePsmPreview({ walletAddress: account.address,
      gemAmountRaw: '1000000', step: 'approve_usdd' }, {
      readState: async () => state(account.address, now), rpc: fakeRpc(fixedNow), now: () => now,
    });
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(now).toISOString() });
    try {
      let txId = '';
      const approval = createNilePsmApprovalService({ ledger, refreshPreview: async () => preview,
        readBalances: async () => ({ ...state(account.address, now),
          usddAllowanceToPsmRaw: quote.usddAmountRaw,
          fetchedAt: new Date(now).toISOString(), source: source(now) }),
        readTransaction: async id => ({ txId: id, status: 'confirmed',
          receipt: { id, fee: '1000', receipt: { result: 'SUCCESS' } }, actualFeeSun: '1000', reason: null,
          source: source(now) } satisfies NileTransactionResult),
        verifyNileReferenceBlock: async () => {}, now: () => now });
      const intent = await approval.reserve(account.address, preview, preview.id);
      const bad = signedTransaction(account, preview, C.gemJoin);
      await expect(approval.acceptSigned(account.address, { intentId: intent.id,
        preview, signedTransaction: bad })).rejects.toThrow('계정·계약·함수·수량');
      const wrongSigner = signedTransaction(account, preview, preview.argumentAddress, wallet());
      await expect(approval.acceptSigned(account.address, { intentId: intent.id,
        preview, signedTransaction: wrongSigner })).rejects.toThrow('서명자가');
      const signed = signedTransaction(account, preview);
      const accepted = await approval.acceptSigned(account.address, { intentId: intent.id,
        preview, signedTransaction: signed });
      txId = signed.txID;
      expect(accepted).toMatchObject({ status: 'signed', txId });
      const ready = approval.beginBroadcast(account.address, { intentId: intent.id, preview });
      expect(ready.signedTransaction).toEqual(signed);
      expect(ready.intent.status).toBe('broadcasting');
      approval.recordBroadcastResult(account.address, intent.id, true);
      now += 1000;
      const result = await approval.reconcile(account.address, intent.id);
      expect(result).toMatchObject({ intent: { status: 'confirmed', txId },
        observation: { status: 'confirmed', txId },
        balances: { usddAllowanceToPsmRaw: quote.usddAmountRaw } });
    } finally { ledger.close(); }
  });

  it('keeps a solidified buy unresolved until exact USDD spent and USDT received are reread', async () => {
    const account = wallet();
    let now = fixedNow;
    const opening = { ...state(account.address), usddAllowanceToPsmRaw: quote.usddAmountRaw, needsApproval: false };
    const preview = await createNilePsmPreview({ walletAddress: account.address,
      gemAmountRaw: '1000000', step: 'buy_gem' }, {
      readState: async () => ({ ...opening, fetchedAt: new Date(now).toISOString(), source: source(now) }),
      rpc: fakeRpc(fixedNow), now: () => now,
    });
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32),
      now: () => new Date(now).toISOString() });
    try {
      let received = '999999';
      const approval = createNilePsmApprovalService({ ledger, refreshPreview: async () => preview,
        readBalances: async () => ({ ...opening,
          usddBalanceRaw: (BigInt(opening.usddBalanceRaw) - BigInt(quote.usddAmountRaw)).toString(),
          usdtBalanceRaw: received, fetchedAt: new Date(now).toISOString(), source: source(now) }),
        readTransaction: async id => ({ txId: id, status: 'confirmed',
          receipt: { id, fee: '1000', receipt: { result: 'SUCCESS' } }, actualFeeSun: '1000', reason: null,
          source: source(now) }),
        verifyNileReferenceBlock: async () => {}, now: () => now });
      const intent = await approval.reserve(account.address, preview, preview.id);
      const signed = signedTransaction(account, preview);
      await approval.acceptSigned(account.address, { intentId: intent.id, preview, signedTransaction: signed });
      approval.beginBroadcast(account.address, { intentId: intent.id, preview });
      approval.recordBroadcastResult(account.address, intent.id, true);
      now += 1000;
      await expect(approval.reconcile(account.address, intent.id)).rejects.toThrow('실제 수령·지출 수량');
      expect(ledger.getIntent(intent.id)?.status).toBe('pending');
      received = '1000000';
      expect((await approval.reconcile(account.address, intent.id)).intent.status).toBe('confirmed');
    } finally { ledger.close(); }
  });
});
