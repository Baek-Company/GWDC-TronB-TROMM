import { describe, expect, it } from 'vitest';
import { estimateUsdtDemo } from '../shared/demo-estimate';
import { userNeedsSchema, type UserNeeds } from '../shared/schemas';

const usdt = { symbol: 'USDT', address: 'TUSDT', decimals: 6 };

function needs(overrides: Partial<UserNeeds> = {}): UserNeeds {
  return userNeedsSchema.parse({
    chain: 'mainnet', asset: usdt, amount: '1000',
    startDate: '2026-09-29', endDate: '2027-09-29',
    expenses: [{ date: '2026-10-06', amount: '200', asset: usdt }],
    liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
    timezone: 'Asia/Seoul', inputVersion: 3, confirmedVersion: 3,
    ...overrides,
  });
}

describe('fixed USDT demo estimate', () => {
  it('protects scheduled spending and reports gross interest without inventing net profit', () => {
    const result = estimateUsdtDemo(needs());
    expect(result).toMatchObject({
      mode: 'synthetic', chain: 'mainnet', asset: 'USDT', inputVersion: 3,
      startDate: '2026-09-29', endDate: '2027-09-29', horizonDays: 365,
      declaredAmountUsdt: '1000', protectedAmountUsdt: '200',
      hypotheticalInvestableUsdt: '800', projectedGrossInterestUsdt: '40.000000',
      roundTripCostUsdt: null, projectedNetYieldUsdt: null,
      rateAssumption: { kind: 'apy', rate: '0.05', source: 'fixed_explanatory_example_v1',
        marketObservedAt: null },
      recommendation: 'none', walletSized: false, executionEligible: false,
    });
  });

  it('keeps the six-decimal balance exact and protects expenses beyond the horizon too', () => {
    const result = estimateUsdtDemo(needs({
      amount: '1000.000005',
      expenses: [
        { date: '2026-10-06', amount: '200.000001', asset: usdt },
        { date: '2027-10-01', amount: '49.999999', asset: usdt },
      ],
      liquidReserve: '50.000001',
    }));
    expect(result.protectedAmountUsdt).toBe('300.000001');
    expect(result.hypotheticalInvestableUsdt).toBe('700.000004');
    expect(result.projectedGrossInterestUsdt).toBe('35.000000');
  });

  it('shows zero gross interest when every USDT is protected', () => {
    const result = estimateUsdtDemo(needs({ liquidReserve: '800' }));
    expect(result.hypotheticalInvestableUsdt).toBe('0');
    expect(result.projectedGrossInterestUsdt).toBe('0.000000');
    expect(result.projectedNetYieldUsdt).toBeNull();
    expect(result.recommendation).toBe('none');
  });

  it('uses the stated dates and does not depend on wallet or market observations', () => {
    const input = needs({ endDate: '2026-10-29' });
    const first = estimateUsdtDemo(input);
    const second = estimateUsdtDemo(input);
    expect(first).toEqual(second);
    expect(first.horizonDays).toBe(30);
    expect(Number(first.projectedGrossInterestUsdt)).toBeGreaterThan(3);
    expect(Number(first.projectedGrossInterestUsdt)).toBeLessThan(4);
    expect(first).not.toHaveProperty('walletAddress');
    expect(first).not.toHaveProperty('marketQuoteVersion');
  });

  it('rejects Nile, unsupported assets, and impossible protected amounts', () => {
    expect(() => estimateUsdtDemo(needs({ chain: 'nile' }))).toThrow(/Mainnet USDT/);
    expect(() => estimateUsdtDemo(needs({ asset: { ...usdt, symbol: 'USDD' },
      expenses: [] }))).toThrow(/Mainnet USDT/);
    expect(() => estimateUsdtDemo(needs({ liquidReserve: '801' }))).toThrow(/예정 지출액/);
    expect(() => estimateUsdtDemo(needs({ amount: '1000.0000001' }))).toThrow(/여섯 자리/);
  });
});
