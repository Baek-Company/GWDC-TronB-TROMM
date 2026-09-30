import { describe, expect, it } from 'vitest';
import { buildReferenceModel, verifyReferenceCandidate,
  type ReferenceCandidate } from '../server/data/jusdt-reference-model';

const now = new Date('2026-09-29T09:00:00.000Z');
const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const jusdt = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
const candidate: ReferenceCandidate = {
  action: 'approve', contractAddress: usdt, selector: 'approve(address,uint256)',
  spenderAddress: jusdt, currentCodeIdentity: 'current-code', historicalCodeIdentity: null,
  transaction: {}, solidifiedReceipt: {}, now,
  source: { sourceUrl: 'https://api.trongrid.io/walletsolidity/gettransactioninfobyid',
    chain: 'mainnet', fetchedAt: now.toISOString(), sourceUpdatedAt: null,
    mode: 'live', accessMethod: 'rpc' },
};

describe('jUSDT historical cost evidence', () => {
  it('rejects missing historical implementation identity and incomplete receipts', () => {
    expect(verifyReferenceCandidate(candidate)).toBeNull();
    expect(verifyReferenceCandidate({ ...candidate, historicalCodeIdentity: 'current-code' })).toBeNull();
  });

  it('never emits a model from fewer than five fully verified distinct transactions', () => {
    expect(buildReferenceModel({ action: 'approve', contractAddress: usdt,
      selector: 'approve(address,uint256)', currentCodeIdentity: 'current-code',
      candidates: Array.from({ length: 5 }, () => ({ ...candidate })), now })).toBeNull();
  });
});
