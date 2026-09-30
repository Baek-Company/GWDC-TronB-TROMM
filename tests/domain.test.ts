import { describe, expect, it } from 'vitest';
import { parseMarkets, toBaseUnits, formatRate } from '../shared/markets';
import { estimateYield, previewLiquidity, profileSchema } from '../shared/planning';

describe('money precision', () => {
  it('keeps 18 decimal token amounts beyond Number safe range exact', () => {
    expect(toBaseUnits('123456789.123456789123456789', 18)).toBe('123456789123456789123456789');
  });
  it('rejects silently rounded token amounts and invalid inputs', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
    expect(() => toBaseUnits('Infinity', 18)).toThrow();
    expect(() => toBaseUnits((2n ** 256n).toString(), 0)).toThrow();
  });
  it('converts fractional API yield to display percentage once', () => {
    expect(formatRate('0.064673')).toBe('6.4673');
  });
});
describe('planning assumptions', () => {
  it('separates base yield, reward and costs, including net losses', () => {
    expect(estimateYield({ principal: '1000', days: 365, baseApy: '0.05', rewardApr: '0.02', totalCost: '80' }))
      .toEqual({ baseYield: '50.00000000', rewardYield: '20.00000000', totalCost: '80.00000000', netYield: '-10.00000000' });
  });
  it('uses compounded effective APY over partial years', () => {
    const result = estimateYield({ principal: '1000', days: 180, baseApy: '0.10', rewardApr: '0', totalCost: '0' });
    expect(Number(result.baseYield)).toBeCloseTo(1000 * (1.1 ** (180 / 365) - 1), 7);
  });
  it('rejects impossible liquidity requirements', () => {
    expect(profileSchema.safeParse({asset: 'USDT', amount: '100', horizonDays: 30, liquidReserve: '101', riskPreference: 'conservative'}).success).toBe(false);
  });
  it('protects an upcoming expense, then releases it when the spending date moves past the horizon', () => {
    const input = { holdings: '1000', horizonDays: 30, expense: '200', reserve: '0' };
    expect(previewLiquidity({ ...input, expenseDay: 7 }).investableAmount).toBe('800');
    expect(previewLiquidity({ ...input, expenseDay: 45 })).toMatchObject({
      dueWithinHorizon: false, protectedAmount: '200', investableAmount: '800',
    });
    expect(() => previewLiquidity({ ...input, expenseDay: 7, reserve: '801' })).toThrow();
  });
});
describe('upstream error detection', () => {
  it('rejects HTTP-200 business errors and unexpected schemas', () => {
    expect(() => parseMarkets({code: 500, data: {tokenList: []}})).toThrow();
    expect(() => parseMarkets({code: 0, data: {tokenList: [{supplyRate: 'NaN'}]}})).toThrow();
  });
});
