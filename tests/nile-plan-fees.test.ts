import { describe, expect, it, vi } from 'vitest';
import { createNilePlans } from '../shared/planning';
import { productQuoteSchema, userNeedsSchema } from '../shared/schemas';
import { readNilePlanFeeScenarios, type NileFeeReaders } from '../server/nile-plan-fees';
import type { NileDepositState } from '../server/transactions';

const now = Date.parse('2026-09-30T03:00:00.000Z');
const wallet = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const representative = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const market = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
const trx = { symbol: 'TRX', address: null, decimals: 6 } as const;
const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };
const needs = userNeedsSchema.parse({ chain: 'nile', asset: trx, amount: '100',
  startDate: '2026-09-30', endDate: '2026-10-30', expenses: [], liquidReserve: '20',
  riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
  inputVersion: 1, confirmedVersion: 1 });
const quote = productQuoteSchema.parse({ id: 'nile-jtrx', quoteVersion: 'quote-1',
  product: 'justlend_jtrx', chain: 'nile', marketAddress: market,
  inputToken: trx, depositToken: trx, receiptToken: { symbol: 'jTRX', address: market, decimals: 8 },
  baseRate: null, reward: null, liquidity: { exitAvailable: '100000', withdrawalDelayDays: 0 },
  conversion: null, costs: [], status: 'active', risks: [], source });

function plans() { return createNilePlans(needs, quote, { now: new Date(now), walletBalance: '100' }).plans; }

function readers(options: { noReference?: boolean; badContract?: boolean; depositFails?: boolean;
  wrongRepresentative?: boolean } = {}): NileFeeReaders {
  return {
    now: () => now,
    readDepositState: vi.fn(async ({ address, amountSun, contractAddress }) => {
      if (options.depositFails) throw new Error('예치 수수료 재원 부족');
      return { chain: 'nile', walletAddress: address, amountSun,
        contractAddress, exchangeRateRaw: '1000000000000000000',
        estimatedFeeSun: '5000000', maxFeeSun: '10000000', source } as NileDepositState;
    }),
    readRedeemReference: vi.fn(async ({ contractAddress, jtrxAmountRaw }) =>
      options.noReference ? { status: 'unknown' as const, basis: 'unknown' as const, estimatedFeeSun: null,
        stressFeeSun: null, source: null, validUntil: null, reason: '기준 계정 없음' } : {
        status: 'ready' as const, basis: 'representative_simulation' as const, estimatedFeeSun: '6000000',
        stressFeeSun: '12000000', source, validUntil: new Date(now + 120_000).toISOString(),
        reason: null, contractAddress: options.badContract ? wallet : contractAddress, jtrxAmountRaw,
        representativeAddress: options.wrongRepresentative ? wallet : representative,
      }),
  };
}

describe('Nile plan fee scenarios', () => {
  it('computes separate reference costs and keeps canonical verified plan economics unknown', async () => {
    const original = plans();
    const calls = readers();
    const result = await readNilePlanFeeScenarios(needs, original, wallet, '1000000000000000000', calls);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ planId: original[1].id, status: 'reference_scenario',
      basis: 'representative_simulation', amountSun: '80000000',
      estimatedRoundTripFeeSun: '11000000', feeReserveSun: '22000000',
      postReserveInvestableSun: '58000000', reserveStatus: 'insufficient',
      economicDepositSun: '58000000', economicFeeReserveSun: '22000000', economicSizingStatus: 'ready' });
    expect(result[1]).toMatchObject({ amountSun: '50000000', reserveStatus: 'ready',
      economicDepositSun: '50000000', economicSizingStatus: 'ready' });
    expect(original[1].roundTripCost).toBeNull();
    expect(original[1].netYield).toBeNull();
    expect(calls.readDepositState).toHaveBeenCalledWith({ address: wallet,
      amountSun: '58000000', contractAddress: market });
    expect(calls.readRedeemReference).toHaveBeenCalledWith({ jtrxAmountRaw: '58000000',
      contractAddress: market, excludeWalletAddress: wallet });
  });

  it('shows a partial deposit estimate without inventing a future redemption fee', async () => {
    const result = await readNilePlanFeeScenarios(needs, plans(), wallet, '1000000000000000000',
      readers({ noReference: true }));
    expect(result[0]).toMatchObject({ status: 'partial', depositFeeSun: '5000000',
      estimatedRedeemFeeSun: null, estimatedRoundTripFeeSun: null, feeReserveSun: null,
      reserveStatus: 'unknown' });
  });

  it('rejects cross-contract reference data and keeps the two RPC failures distinct', async () => {
    const mismatch = await readNilePlanFeeScenarios(needs, plans(), wallet, '1000000000000000000',
      readers({ badContract: true }));
    expect(mismatch[0].status).toBe('partial');
    expect(mismatch[0].reason).toContain('계약 또는 수량');
    const noDeposit = await readNilePlanFeeScenarios(needs, plans(), wallet, '1000000000000000000',
      readers({ depositFails: true }));
    expect(noDeposit[0]).toMatchObject({ status: 'partial', depositFeeSun: null,
      estimatedRedeemFeeSun: '6000000', estimatedRoundTripFeeSun: null });
    expect(noDeposit[0].reason).toContain('예치 수수료 재원 부족');
  });

  it('does not treat the wallet itself as an independent reference account', async () => {
    const result = await readNilePlanFeeScenarios(needs, plans(), wallet, '1000000000000000000',
      readers({ wrongRepresentative: true }));
    expect(result[0]).toMatchObject({ status: 'partial', estimatedRedeemFeeSun: null,
      economicDepositSun: null, economicSizingStatus: 'unknown' });
  });

  it('does not derive reference values from a stale Nile quote', async () => {
    const stalePlans = createNilePlans(needs, productQuoteSchema.parse({ ...quote,
      source: { ...source, fetchedAt: new Date(now - 16 * 60_000).toISOString() } }),
    { now: new Date(now), walletBalance: '100' }).plans;
    const calls = readers();
    const result = await readNilePlanFeeScenarios(needs, stalePlans, wallet, '1000000000000000000', calls);
    expect(result[0].status).toBe('unknown');
    expect(calls.readDepositState).not.toHaveBeenCalled();
    expect(calls.readRedeemReference).not.toHaveBeenCalled();
  });
});
