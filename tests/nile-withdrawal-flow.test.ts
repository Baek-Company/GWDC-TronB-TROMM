import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { TronWeb } from 'tronweb';
import { calculatePlan } from '../shared/planning';
import type { ExecutionRecord, Observation, ProductQuote, UserNeeds } from '../shared/schemas';
import { NILE_JTRX_CANDIDATE, type NileWithdrawalPreview } from '../server/transactions';
import { confirmedNileWithdrawalFlow } from '../src/lib/review-evidence';
import { NileWithdrawalFeeComparison, NileWithdrawalFeePreview } from '../src/features/execution/NileWithdrawalPanel';

const wallet = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const contract = NILE_JTRX_CANDIDATE;
const trx = { symbol: 'TRX', address: null, decimals: 6 } as const;
const jtrx = { symbol: 'jTRX', address: contract, decimals: 8 } as const;
const txId = 'a'.repeat(64);
const checkedAt = '2026-10-01T05:00:00.000Z';
const source = (fetchedAt: string) => ({ sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt, sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const });
const needs: UserNeeds = { chain: 'nile', asset: trx, amount: '100', startDate: '2026-09-29',
  endDate: '2026-10-29', expenses: [], liquidReserve: '20', riskPreference: 'balanced',
  acceptsUsddRisk: false, timezone: 'Asia/Seoul', inputVersion: 1, confirmedVersion: 1 };
const quote: ProductQuote = { id: 'jtrx', quoteVersion: 'q1', product: 'justlend_jtrx', chain: 'nile',
  marketAddress: contract, inputToken: trx, depositToken: trx, receiptToken: jtrx,
  baseRate: { kind: 'apy', rate: '0.05' }, reward: null,
  liquidity: { exitAvailable: '1000', withdrawalDelayDays: 0 }, conversion: null,
  costs: [
    { kind: 'deposit', amount: '0', asset: trx, conversionRateToInput: null,
      estimatedAt: '2026-09-29T03:00:00.000Z', source: source('2026-09-29T03:00:00.000Z') },
    { kind: 'withdraw', amount: '0', asset: trx, conversionRateToInput: null,
      estimatedAt: '2026-09-29T03:00:00.000Z', source: source('2026-09-29T03:00:00.000Z') },
  ], status: 'active', risks: [], source: source('2026-09-29T03:00:00.000Z') };
const plan = calculatePlan(needs, quote, { now: new Date('2026-09-29T03:00:00.000Z'),
  allocation: '80', scenario: '80_20' });
const preview = { id: 'preview', planId: plan.id, walletAddress: wallet, chain: 'nile',
  contractAddress: contract, amountBaseUnits: '50000000', state: { jtrxBalanceRaw: '100000000' } } as NileWithdrawalPreview;
const observation: Observation = { id: 'after', planId: plan.id,
  positionId: `nile:${wallet}:${contract}`, walletAddress: wallet, chain: 'nile',
  receiptToken: jtrx, receiptBalanceBaseUnits: '50000000', exchangeRateRaw: '2000000000000000000',
  underlyingToken: trx, underlyingValueBaseUnits: '100000000', source: source(checkedAt) };
const internalTransfer = { hash: 'b'.repeat(64), caller_address: TronWeb.address.toHex(contract),
  transferTo_address: TronWeb.address.toHex(wallet), callValueInfo: [{ callValue: '81000000' }] };
const record: ExecutionRecord = { id: 'withdrawal', action: 'withdraw', planId: plan.id,
  previewId: preview.id, walletAddress: wallet, chain: 'nile', txId,
  amountBaseUnits: preview.amountBaseUnits, contractAddress: contract, status: 'confirmed',
  receipt: { id: txId, receipt: { result: 'SUCCESS' }, internal_transactions: [internalTransfer] },
  actualFeeBaseUnits: '200000', createdAt: '2026-10-01T04:58:00.000Z',
  submittedAt: '2026-10-01T04:59:00.000Z', confirmedAt: checkedAt,
  confirmationSource: source(checkedAt), error: null };

describe('Nile redeemed TRX evidence', () => {
  it('uses the same solidified receipt internal TRX transfer and decreased position', () => {
    expect(confirmedNileWithdrawalFlow(plan, record, preview, observation)).toMatchObject({
      id: `withdraw:${txId}`, kind: 'withdraw', amount: '81', asset: trx,
      actualFeeInInputAsset: '0.2', positionId: observation.positionId, source: source(checkedAt),
    });
  });

  it('withholds the inflow when the receipt omits or cannot attribute the transfer', () => {
    const receipt = record.receipt as { id: string; receipt: { result: string }; internal_transactions: unknown[] };
    for (const internal_transactions of [
      [],
      [{ ...internalTransfer, rejected: true }],
      [{ ...internalTransfer, transferTo_address: TronWeb.address.toHex(contract) }],
      [{ ...internalTransfer, callValueInfo: [{ callValue: '81000000', tokenId: '1002000' }] }],
      [internalTransfer, internalTransfer],
      [{ ...internalTransfer, callValueInfo: [{ callValue: Number.MAX_SAFE_INTEGER + 1 }] }],
    ]) {
      expect(confirmedNileWithdrawalFlow(plan, { ...record, receipt: { ...receipt, internal_transactions } },
        preview, observation)).toBeNull();
    }
    expect(confirmedNileWithdrawalFlow(plan, { ...record, receipt: { id: txId,
      receipt: { result: 'SUCCESS' } } }, preview, observation)).toBeNull();
  });

  it('rejects a different txID, position, or unconfirmed receipt', () => {
    expect(confirmedNileWithdrawalFlow(plan, { ...record, status: 'pending', receipt: null,
      confirmedAt: null }, preview, observation)).toBeNull();
    expect(confirmedNileWithdrawalFlow(plan, { ...record, receipt: { ...(record.receipt as object),
      id: 'c'.repeat(64) } }, preview, observation)).toBeNull();
    expect(confirmedNileWithdrawalFlow(plan, record, preview,
      { ...observation, receiptBalanceBaseUnits: '100000000' })).toBeNull();
    expect(confirmedNileWithdrawalFlow(plan, record, preview,
      { ...observation, walletAddress: contract })).toBeNull();
  });
});

describe('Nile withdrawal fee evidence', () => {
  const feePreview = { ...preview, estimatedFeeBaseUnits: '150000', maxFeeBaseUnits: '450000',
    feeLimitSun: '400000', state: { ...preview.state, fullBurnFeeSun: '350000',
      bandwidthFeeUpperBoundSun: '50000', estimatedBandwidthBytes: '384' } } as NileWithdrawalPreview;

  it('separates resource-adjusted burn, zero-resource burn, and the fee budget', () => {
    const html = renderToStaticMarkup(createElement(NileWithdrawalFeePreview, { preview: feePreview }));
    expect(html).toContain('현재 지갑의 가용 자원 반영 예상 소각액');
    expect(html).toContain('0.15 TRX');
    expect(html).toContain('Energy·Bandwidth가 없을 때의 소각 추정액');
    expect(html).toContain('0.35 TRX');
    expect(html).toContain('Energy fee_limit: 0.4 TRX');
    expect(html).toContain('Bandwidth 비용 예산: 0.05 TRX');
    expect(html).toContain('사전 비용 예산 합계: <strong>0.45 TRX</strong>');
    expect(html).toContain('예상 서명 거래 크기 384 bytes');
  });

  it('compares a confirmed receipt fee against the exact saved preview', () => {
    const html = renderToStaticMarkup(createElement(NileWithdrawalFeeComparison,
      { record, preview: feePreview }));
    expect(html).toContain('실제 환매 수수료: <strong>0.2 TRX</strong>');
    expect(html).toContain('서명 전 예상 소각액: 0.15 TRX');
    expect(html).toContain('차이(실제 − 예상): <strong>+0.05 TRX</strong>');
    const cheaper = renderToStaticMarkup(createElement(NileWithdrawalFeeComparison,
      { record: { ...record, actualFeeBaseUnits: '100000' }, preview: feePreview }));
    expect(cheaper).toContain('차이(실제 − 예상): <strong>−0.05 TRX</strong>');
  });

  it('does not show an actual fee before confirmation or compare a different preview', () => {
    const pending = renderToStaticMarkup(createElement(NileWithdrawalFeeComparison,
      { record: { ...record, status: 'pending', receipt: null, confirmedAt: null }, preview: feePreview }));
    expect(pending).toBe('');
    const mismatched = renderToStaticMarkup(createElement(NileWithdrawalFeeComparison,
      { record, preview: { ...feePreview, id: 'another-preview' } }));
    expect(mismatched).toContain('실제 환매 수수료: <strong>0.2 TRX</strong>');
    expect(mismatched).not.toContain('차이(실제 − 예상)');
    expect(mismatched).toContain('미리보기 추정치를 확인할 수 없어');
  });
});
