import { describe, expect, it } from 'vitest';
import { TronWeb } from 'tronweb';
import type { ExecutionRecord, PositionFlow, Source } from '../shared/schemas';
import { findNileRoundTripReference, nileRateScenario } from '../src/lib/nile-reference';

const wallet = TronWeb.address.fromHex(`41${'11'.repeat(20)}`);
const otherWallet = TronWeb.address.fromHex(`41${'22'.repeat(20)}`);
const contract = TronWeb.address.fromHex(`41${'33'.repeat(20)}`);
const depositTx = 'a'.repeat(64);
const withdrawTx = 'b'.repeat(64);
const positionId = `nile:${wallet}:${contract}`;
const planId = `nile:justlend_jtrx:80_20:v2:${'c'.repeat(64)}`;
const depositAt = '2026-09-29T22:11:30.465Z';
const withdrawAt = '2026-09-29T22:37:32.829Z';
const source = (at: string): Source => ({ sourceUrl: 'https://nile.trongrid.io/walletsolidity',
  chain: 'nile', mode: 'live', accessMethod: 'rpc', fetchedAt: at, sourceUpdatedAt: null });

function flow(kind: 'deposit' | 'withdraw', overrides: Partial<PositionFlow> = {}): PositionFlow {
  const txId = kind === 'deposit' ? depositTx : withdrawTx;
  const at = kind === 'deposit' ? depositAt : withdrawAt;
  return { id: `${kind}:${txId}`, planId, positionId, walletAddress: wallet, chain: 'nile',
    txId, kind, amount: '1', asset: { symbol: 'TRX', address: null, decimals: 6 },
    actualFeeInInputAsset: kind === 'deposit' ? '8.0894' : '7.2569',
    occurredAt: at, solidifiedAt: at, source: source(at), ...overrides };
}

function record(kind: 'deposit' | 'withdraw', overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  const txId = kind === 'deposit' ? depositTx : withdrawTx;
  const at = kind === 'deposit' ? depositAt : withdrawAt;
  const fee = kind === 'deposit' ? 8_089_400 : 7_256_900;
  const receipt = { id: txId, fee, receipt: { result: 'SUCCESS' },
    ...(kind === 'withdraw' ? { internal_transactions: [{ hash: 'd'.repeat(64),
      caller_address: TronWeb.address.toHex(contract),
      transferTo_address: TronWeb.address.toHex(wallet),
      callValueInfo: [{ callValue: '1000000' }] }] } : {}) };
  return { id: `${kind}-record`, action: kind, planId, previewId: `${kind}-preview`,
    walletAddress: wallet, chain: 'nile', txId, amountBaseUnits: kind === 'deposit' ? '1000000' : '8946435499',
    contractAddress: contract, approvalIntentId: kind === 'deposit' ? 'e'.repeat(64) : 'f'.repeat(64),
    status: 'confirmed', receipt, actualFeeBaseUnits: String(fee),
    createdAt: kind === 'deposit' ? '2026-09-29T22:09:00.000Z' : '2026-09-29T22:34:00.000Z',
    submittedAt: kind === 'deposit' ? '2026-09-29T22:10:13.793Z' : '2026-09-29T22:35:53.330Z',
    confirmedAt: at, confirmationSource: source(at), error: null, ...overrides };
}

const flows = () => [flow('deposit'), flow('withdraw')];
const records = () => [record('deposit'), record('withdraw')];

describe('Nile raw rate scenario', () => {
  it('uses 1e18 mantissa, 3-second slots, and simple interest without turning it into APY', () => {
    expect(nileRateScenario('1000000000', '100', 30)).toEqual({
      aprPercent: '1.0512', grossInterest: '0.0864', rawRate: '1000000000',
    });
    expect(nileRateScenario('0', '1', 0)).toEqual({ aprPercent: '0', grossInterest: '0', rawRate: '0' });
  });

  it('withholds a figure for missing or malformed inputs', () => {
    for (const [rate, invested, days] of [
      [null, '100', 30], ['1e9', '100', 30], ['-1', '100', 30],
      ['1000000000', '-100', 30], ['1000000000', '100', 30.5],
      ['1000000000', '100', -1], ['1000000000', '100', 3651],
    ] as const) expect(nileRateScenario(rate, invested, days)).toBeNull();
  });
});

describe('historical Nile round-trip reference', () => {
  it('shows one receipt-backed, same-position round trip with actual fees', () => {
    expect(findNileRoundTripReference(flows(), records(), wallet)).toEqual({
      deposit: flow('deposit'), withdraw: flow('withdraw'),
      totalFees: '15.3463', netCashFlow: '-15.3463',
    });
    expect(findNileRoundTripReference(flows(), records(), otherWallet)).toBeNull();
  });

  it('rejects a different plan, position, or a missing/extra movement', () => {
    expect(findNileRoundTripReference([flow('deposit')], records(), wallet)).toBeNull();
    expect(findNileRoundTripReference([flow('deposit'), flow('withdraw', { planId: 'other' })], records(), wallet)).toBeNull();
    expect(findNileRoundTripReference([flow('deposit'), flow('withdraw', { positionId: 'other' })], records(), wallet)).toBeNull();
    expect(findNileRoundTripReference([...flows(), flow('deposit', { txId: '9'.repeat(64) })],
      records(), wallet)).toBeNull();
    expect(findNileRoundTripReference(flows(), [...records(), record('deposit', { id: 'another-record' })],
      wallet)).toBeNull();
  });

  it('requires matching confirmed record, receipt, actual fee, and live RPC source', () => {
    const variants: Partial<ExecutionRecord>[] = [
      { status: 'pending' }, { txId: '9'.repeat(64) }, { actualFeeBaseUnits: '1' },
      { confirmationSource: { ...source(withdrawAt), mode: 'snapshot' } },
      { receipt: { ...record('withdraw').receipt as object, id: '9'.repeat(64) } },
      { receipt: { ...record('withdraw').receipt as object, receipt: { result: 'REVERT' } } },
    ];
    for (const variant of variants) {
      expect(findNileRoundTripReference(flows(), [record('deposit'), record('withdraw', variant)], wallet)).toBeNull();
    }
    expect(findNileRoundTripReference([flow('deposit'), flow('withdraw', {
      source: { ...source(withdrawAt), mode: 'snapshot' },
    })], records(), wallet)).toBeNull();
  });

  it('requires the redeemed TRX amount in the same receipt and correct chronological order', () => {
    const original = record('withdraw').receipt as Record<string, unknown>;
    const transfers = original.internal_transactions as Record<string, unknown>[];
    for (const transfer of [
      { ...transfers[0], transferTo_address: TronWeb.address.toHex(otherWallet) },
      { ...transfers[0], rejected: true },
      { ...transfers[0], callValueInfo: [{ callValue: '999999' }] },
    ]) {
      expect(findNileRoundTripReference(flows(), [record('deposit'), record('withdraw', {
        receipt: { ...original, internal_transactions: [transfer] },
      })], wallet)).toBeNull();
    }
    expect(findNileRoundTripReference([flow('deposit', { solidifiedAt: withdrawAt }), flow('withdraw')],
      records(), wallet)).toBeNull();
  });
});
