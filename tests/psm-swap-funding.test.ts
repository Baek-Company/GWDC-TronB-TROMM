import { describe, expect, it } from 'vitest';
import { psmEntryCapacity, psmExitCapacity, psmRates } from '../shared/psm-capacity';
import { previewUsdtTrxFunding } from '../shared/swap-funding';

const word = (value: bigint) => value.toString(16).padStart(64, '0');

describe('imported PSM capacity and funding calculations', () => {
  it('uses both the PSM ilk and global Vat debt ceilings, in exact USDT units', () => {
    const rad = 10n ** 45n;
    const ilk = [word(5n * 10n ** 18n), word(10n ** 27n), word(0n), word(20n * rad), word(0n)].join('');
    expect(psmEntryCapacity(ilk, (12n * rad).toString(), (10n * rad).toString())).toBe('2.000000');
    expect(psmEntryCapacity(ilk)).toBe('15.000000');
    expect(psmEntryCapacity(ilk, (9n * rad).toString(), (10n * rad).toString())).toBe('0.000000');
    expect(() => psmEntryCapacity(ilk.slice(1))).toThrow();
  });

  it('uses exact-out buyGem fee math and conservative GemJoin liquidity', () => {
    expect(psmRates('10000000000000000', '100000000000000000')).toEqual({
      entryRate: '0.99', exitRate: '0.90909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909090909091',
    });
    expect(psmExitCapacity('123456789')).toBe('123.456789');
    expect(() => psmRates('1000000000000000001', '0')).toThrow();
  });

  it('reports reserve math as an ineligible illustration with no future exit or reward', () => {
    const preview = previewUsdtTrxFunding('100', {
      reserveUsdtRaw: '1000000000', reserveTrxRaw: '2000000000', feeNumerator: 997,
    });
    expect(preview.trxOutAtSnapshot).toBe('181.322178');
    expect(preview.usdtBackImmediateAtSnapshot).toBe('99.455066');
    expect(preview.futureExitUsdt).toBeNull();
    expect(preview.networkCostUsdt).toBeNull();
    expect(preview.eligibleForPlan).toBe(false);
    expect(() => previewUsdtTrxFunding('1000', {
      reserveUsdtRaw: '1000000000', reserveTrxRaw: '2000000000', feeNumerator: 997,
    })).toThrow();
  });
});
