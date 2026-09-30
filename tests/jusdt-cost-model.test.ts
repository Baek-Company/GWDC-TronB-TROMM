import { describe, expect, it } from 'vitest';
import { actionCostSampleSetSchema, jusdtQuoteContextSchema, type ActionCostSampleSet } from '../shared/schemas';
import { approvalBranch, costEvidenceForAction } from '../shared/jusdt-cost-model';

const wallet = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const jusdt = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
const fetchedAt = '2026-09-29T09:00:00.000Z';
const source = { sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract',
  chain: 'mainnet' as const, fetchedAt, sourceUpdatedAt: null, mode: 'live' as const,
  accessMethod: 'rpc' as const };
const context = jusdtQuoteContextSchema.parse({
  version: 'context-1', chain: 'mainnet', walletAddress: wallet, usdtAddress: usdt,
  jusdtAddress: jusdt, marketQuoteVersion: 'quote-1', needsVersion: 1,
  energyPriceSun: '420', bandwidthPriceSun: '1000', maxFeeLimitSun: '1000000000',
  trxUsd: null, usdtUsd: null, availableEnergy: '0', availableBandwidth: '0',
  availableTrxSun: '100000000', observedUsdtRaw: '1000000000', allowanceUsdtRaw: '0',
  sources: [source], observationWindow: { firstBlock: '1', lastBlock: '2',
    startedAt: fetchedAt, endedAt: fetchedAt }, validUntil: '2026-09-29T09:01:00.000Z',
});

function set(amountRaw: string, basis: 'account_simulation' | 'reference_model',
  count = 1): ActionCostSampleSet {
  return actionCostSampleSetSchema.parse({ action: 'mint', contractAddress: jusdt,
    selector: 'mint(uint256)', codeIdentity: 'verified-code-hash', modelVersion: 'model-1',
    validUntil: '2026-09-29T09:02:00.000Z',
    samples: Array.from({ length: count }, (_, index) => ({ basis, amountRaw,
      energyUnits: String(100 + index), signedBytes: String(300 + index),
      txId: basis === 'reference_model' ? index.toString(16).padStart(64, '0') : null,
      source: { ...source, sourceUpdatedAt: basis === 'reference_model' ? fetchedAt : null },
    })),
  });
}

describe('jUSDT read-only action cost model', () => {
  it('uses total bundle allowance with zero, sufficient, and reset branches', () => {
    expect(approvalBranch('100', '100')).toBe('none');
    expect(approvalBranch('0', '100')).toBe('approve');
    expect(approvalBranch('20', '100')).toBe('reset_then_approve');
    expect(approvalBranch(null, '100')).toBe('unknown');
  });

  it('only accepts an exact current-account simulation and leaves sequential free-resource charging to the bundle', () => {
    const evidence = costEvidenceForAction(context, 'mint', '200', [set('200', 'account_simulation')]);
    expect(evidence).toMatchObject({ basis: 'account_simulation', energyUnits: '100',
      bandwidthBytes: '300', estimatedFeeSun: null, feeLimitSun: '84000',
      bandwidthBudgetSun: '600000', referenceTxIds: [] });
    expect(costEvidenceForAction(context, 'mint', '201', [set('200', 'account_simulation')]).basis).toBe('unknown');
  });

  it('requires five distinct matching reference receipts and rejects out-of-range or expired models', () => {
    expect(costEvidenceForAction(context, 'mint', '200', [set('100', 'reference_model', 4)]).basis).toBe('unknown');
    const accepted = costEvidenceForAction(context, 'mint', '200', [set('100', 'reference_model', 5)]);
    expect(accepted).toMatchObject({ basis: 'reference_model', energyUnits: '104',
      bandwidthBytes: '304', estimatedFeeSun: null });
    expect(accepted.referenceTxIds).toHaveLength(5);
    expect(costEvidenceForAction(context, 'mint', '201', [set('100', 'reference_model', 5)]).basis).toBe('unknown');
    expect(costEvidenceForAction(context, 'mint', '200', [{ ...set('200', 'reference_model', 5),
      validUntil: fetchedAt }]).basis).toBe('unknown');
    const old = set('200', 'reference_model', 5);
    expect(costEvidenceForAction(context, 'mint', '200', [{ ...old,
      samples: old.samples.map(sample => ({ ...sample, source: {
        ...sample.source, sourceUpdatedAt: '2026-08-01T09:00:00.000Z',
      } })),
    }]).basis).toBe('unknown');
    const first = set('200', 'reference_model', 3);
    const second = { ...set('200', 'reference_model', 2), modelVersion: 'different-code-model',
      samples: set('200', 'reference_model', 2).samples.map((sample, index) => ({ ...sample,
        txId: (index + 3).toString(16).padStart(64, '0'),
      })) };
    expect(costEvidenceForAction(context, 'mint', '200', [first, second]).basis).toBe('unknown');
  });
});
