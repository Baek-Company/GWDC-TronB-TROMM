import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { calculatePlan } from '../shared/planning';
import { proposeAdjustment, reviewPlanPosition, type PositionFlow } from '../shared/review';
import { type ExecutionRecord, type Observation, type ProductQuote, type UserNeeds } from '../shared/schemas';
import { confirmedNileDepositFlow, matchesConfirmedNileDepositFlow } from '../src/lib/review-evidence';
import { NileWorkflow, persistNilePlanSnapshot, recoverNilePlanSnapshot } from '../src/features/execution/NileWorkflow';
import { ReviewPanel } from '../src/features/review/ReviewPanel';

const start = '2026-09-29T03:00:00.000Z';
const submitted = '2026-09-29T05:01:00.000Z';
const confirmed = '2026-09-29T05:02:00.000Z';
const finish = '2026-10-29T06:00:00.000Z';
const trx = { symbol: 'TRX', address: null, decimals: 6 };
const jtrx = { symbol: 'jTRX', address: 'TJTRX', decimals: 8 };
const live = (fetchedAt: string) => ({
  sourceUrl: 'https://nile.trongrid.io/walletsolidity', chain: 'nile' as const,
  fetchedAt, sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const,
});

function needs(overrides: Partial<UserNeeds> = {}): UserNeeds {
  return {
    chain: 'nile', asset: trx, amount: '100', startDate: '2026-09-29', endDate: '2026-10-29',
    expenses: [], liquidReserve: '20', riskPreference: 'balanced', acceptsUsddRisk: false,
    timezone: 'Asia/Seoul', inputVersion: 1, confirmedVersion: 1, ...overrides,
  };
}

function quote(): ProductQuote {
  return {
    id: 'nile-jtrx', quoteVersion: 'q1', product: 'justlend_jtrx', chain: 'nile',
    marketAddress: jtrx.address, inputToken: trx, depositToken: trx, receiptToken: jtrx,
    baseRate: { kind: 'apy', rate: '0.05' }, reward: null,
    liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 }, conversion: null,
    costs: [
      { kind: 'deposit', amount: '0', asset: trx, conversionRateToInput: null, estimatedAt: start, source: live(start) },
      { kind: 'withdraw', amount: '0', asset: trx, conversionRateToInput: null, estimatedAt: start, source: live(start) },
    ], status: 'active', risks: [], source: live(start),
  };
}

const plan = calculatePlan(needs(), quote(), { now: new Date(start), allocation: '80', scenario: '80_20' });
const address = 'TNILEWALLET';
const positionId = `nile:${address}:${jtrx.address}`;

function record(overrides: Partial<ExecutionRecord> = {}): ExecutionRecord {
  return {
    id: 'r1', planId: plan.id, previewId: 'preview1', walletAddress: address, chain: 'nile',
    txId: 'deposit-tx', status: 'confirmed', receipt: { result: 'SUCCESS' }, actualFeeBaseUnits: '1000000',
    createdAt: '2026-09-29T05:00:00.000Z', submittedAt: submitted, confirmedAt: confirmed, error: null,
    ...overrides,
  };
}

function observation(rawBalance: string, rawValue: string, fetchedAt = finish,
  overrides: Partial<Observation> = {}): Observation {
  return {
    id: `o-${fetchedAt}`, planId: plan.id, positionId, walletAddress: address, chain: 'nile',
    receiptToken: jtrx, receiptBalanceBaseUnits: rawBalance, exchangeRateRaw: '1000000000000000000',
    underlyingToken: trx, underlyingValueBaseUnits: rawValue, source: live(fetchedAt), ...overrides,
  };
}

const opening = observation('0', '0', '2026-09-29T04:59:00.000Z');
const afterDeposit = observation('80000000', '80000000', '2026-09-29T05:03:00.000Z');
const closed = observation('0', '0');
const coverage = { fromAt: opening.source.fetchedAt, throughAt: finish, source: live(finish) };
function flow(kind: PositionFlow['kind'], amount: string, txId: string, occurredAt: string): PositionFlow {
  return { id: txId, planId: plan.id, positionId, walletAddress: address, chain: 'nile',
    txId, kind, amount, asset: trx, actualFeeInInputAsset: txId === 'deposit-tx' ? '1' : '0',
    occurredAt, solidifiedAt: occurredAt,
    source: live(occurredAt),
  };
}

describe('position review', () => {
  it('constructs a deposit flow only after the same live jTRX position increases', () => {
    const txId = 'a'.repeat(64);
    const verified = record({ action: 'deposit', txId, amountBaseUnits: '80000000',
      contractAddress: jtrx.address!, approvalIntentId: 'c'.repeat(64), confirmationSource: live(confirmed) });
    const created = confirmedNileDepositFlow(plan, verified, opening, afterDeposit);
    expect(created).toMatchObject({ txId, kind: 'deposit', amount: '80',
      actualFeeInInputAsset: '1', positionId, source: live(confirmed) });
    expect(matchesConfirmedNileDepositFlow(plan, verified, created)).toBe(true);
    expect(matchesConfirmedNileDepositFlow(plan, verified, null)).toBe(false);
    expect(matchesConfirmedNileDepositFlow(plan, { ...verified, txId: 'b'.repeat(64) }, created)).toBe(false);
    expect(matchesConfirmedNileDepositFlow(plan, { ...verified, approvalIntentId: undefined }, created)).toBe(false);
    expect(matchesConfirmedNileDepositFlow(plan, verified, { ...created!, positionId: 'other' })).toBe(false);
    const comparable = reviewPlanPosition({ plan, record: verified, observation: closed,
      openingObservation: opening,
      positionFlows: [created!, flow('withdraw', '81', 'withdraw-tx', finish)],
      flowCoverage: coverage });
    expect(comparable.status).toBe('comparable');
    expect(comparable.actualNetChange).toBe('0');
    expect(confirmedNileDepositFlow(plan, { ...verified, status: 'pending' }, opening, afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, { ...verified, confirmationSource: undefined }, opening, afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, { ...verified, amountBaseUnits: undefined }, opening, afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, { ...verified, approvalIntentId: undefined }, opening, afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, null, afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening, null)).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, observation('0', '0', finish), afterDeposit)).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening, observation('0', '0'))).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening,
      observation('80000000', '80000000', submitted))).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening,
      observation('80000000', '80000000', afterDeposit.source.fetchedAt, { walletAddress: 'TOTHER' }))).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening,
      observation('80000000', '80000000', afterDeposit.source.fetchedAt, { positionId: 'other' }))).toBeNull();
    expect(confirmedNileDepositFlow(plan, verified, opening,
      observation('80000000', '80000000', afterDeposit.source.fetchedAt,
        { source: { ...live(afterDeposit.source.fetchedAt), mode: 'snapshot' } }))).toBeNull();
  });

  it('keeps an earlier confirmed Nile plan available for receipt recovery after the date changes', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-30T03:00:00.000Z'));
    const deposit = record({ action: 'deposit', txId: 'a'.repeat(64), amountBaseUnits: '80000000',
      contractAddress: jtrx.address!, approvalIntentId: 'c'.repeat(64), confirmationSource: live(confirmed) });
    const priorInputs = { amount: '100', horizonDays: '30', reserve: '20', expenses: [],
      asOfDate: '2026-09-29', version: 1, confirmedVersion: 1 };
    const localStorage = { getItem: (key: string) => {
      if (key === 'gwdc-nile-needs-v3') return JSON.stringify(priorInputs);
      if (key === `gwdc:nile-execution:v1:${plan.id}:${address}`) return JSON.stringify(deposit);
      return null;
    } };
    vi.stubGlobal('window', { localStorage });
    vi.stubGlobal('localStorage', localStorage);
    try {
      const html = renderToStaticMarkup(createElement(NileWorkflow, {
        wallet: { address, network: 'Nile 테스트넷', networkKey: 'nile', chainId: '0xcd8690dc' },
        onConnect: async () => {}, selectedPlan: plan, historicalRecords: [deposit],
        verifiedDepositFlow: null, onSelect: () => {}, onRestorePlan: () => {},
        onRecord: () => {}, onOpeningObservation: () => {},
        onObservation: () => {}, onWithdrawalFlow: () => {},
      }));
      expect(html).toContain('기존 Nile 거래 복구');
      expect(html).toContain('원 거래 기록');
      expect(html).toContain('같은 Nile jTRX 포지션의 예치 전후 잔고 증가가 확인되지 않았습니다');
      expect(html).not.toContain('Nile 예치 미리보기');
    } finally {
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  });

  it('keeps a wallet-bound original plan snapshot available after another plan is selected', () => {
    const walletAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    const data = new Map<string, string>();
    const store = { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); } };
    persistNilePlanSnapshot(plan, walletAddress, store);
    expect(recoverNilePlanSnapshot(plan.id, walletAddress, store)).toEqual(plan);
    const newerPlan = calculatePlan(needs({ inputVersion: 2, confirmedVersion: 2,
      startDate: '2026-09-30', endDate: '2026-10-30' }), quote(),
    { now: new Date('2026-09-30T03:00:00.000Z'), allocation: '80', scenario: '80_20' });
    persistNilePlanSnapshot(newerPlan, walletAddress, store);
    expect(recoverNilePlanSnapshot(plan.id, walletAddress, store)).toEqual(plan);
    expect(recoverNilePlanSnapshot(newerPlan.id, walletAddress, store)).toEqual(newerPlan);
    expect(() => persistNilePlanSnapshot({ ...plan, startDate: '2026-09-30' }, walletAddress, store))
      .toThrow(/다른 거래 조건/);
    const originalKey = [...data.keys()].find(key => key.endsWith(`:${plan.id}`))!;
    data.set(originalKey, '{broken');
    expect(() => recoverNilePlanSnapshot(plan.id, walletAddress, store)).toThrow(/손상/);
  });

  it('lists an older transaction for recovery when the selected Nile plan changed', () => {
    const walletAddress = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
    const priorRecord = record({ action: 'deposit', walletAddress, txId: 'a'.repeat(64),
      contractAddress: jtrx.address!, approvalIntentId: 'c'.repeat(64) });
    const data = new Map<string, string>();
    const store = { getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, value: string) => { data.set(key, value); } };
    persistNilePlanSnapshot(plan, walletAddress, store);
    const newerPlan = calculatePlan(needs({ inputVersion: 2, confirmedVersion: 2,
      startDate: '2026-09-30', endDate: '2026-10-30' }), quote(),
    { now: new Date('2026-09-30T03:00:00.000Z'), allocation: '80', scenario: '80_20' });
    vi.stubGlobal('window', { localStorage: store });
    vi.stubGlobal('localStorage', store);
    try {
      const html = renderToStaticMarkup(createElement(NileWorkflow, {
        wallet: { address: walletAddress, network: 'Nile 테스트넷', networkKey: 'nile', chainId: '0xcd8690dc' },
        onConnect: async () => {}, selectedPlan: newerPlan, historicalRecords: [priorRecord],
        verifiedDepositFlow: null, onSelect: () => {}, onRestorePlan: () => {},
        onRecord: () => {}, onOpeningObservation: () => {}, onObservation: () => {},
        onWithdrawalFlow: () => {},
      }));
      expect(html).toContain('이전 Nile 원 거래 복구');
      expect(html).toContain('이 계획의 원 거래 열기');
      expect(html).toContain(priorRecord.txId!);
    } finally { vi.unstubAllGlobals(); }
  });

  it('shows stored evidence but withholds investment return without verified flow coverage and redemption amount', () => {
    const txId = 'a'.repeat(64);
    const deposit = record({ action: 'deposit', txId, amountBaseUnits: '80000000',
      contractAddress: jtrx.address!, approvalIntentId: 'c'.repeat(64), confirmationSource: live(confirmed) });
    const verifiedFlow = confirmedNileDepositFlow(plan, deposit, opening, afterDeposit)!;
    const withdrawal = record({ id: 'withdrawal', action: 'withdraw', txId: 'b'.repeat(64),
      amountBaseUnits: '8000000000', createdAt: finish, submittedAt: finish,
      confirmedAt: finish, confirmationSource: live(finish) });
    const html = renderToStaticMarkup(createElement(ReviewPanel, {
      selectedPlan: plan, records: [deposit, withdrawal], observations: [closed],
      openingObservations: [{ recordId: deposit.id, observation: opening }],
      positionFlows: [verifiedFlow], flowCoverages: [], currentNeeds: null, onExport: () => {},
    }));
    expect(html).toContain('예치 전 관측 보존됨');
    expect(html).toContain('검증된 포지션 현금흐름 1건');
    expect(html).toContain('환매 영수증에서 실제 수령 TRX가 검증되지 않아');
    expect(html).toContain('기간 전체의 현금흐름 조회 범위가 검증되지 않았습니다');
    expect(html).toContain('필수 포지션 증거가 완전하지 않아 산출 보류');
    expect(html).not.toContain('계획 대비 비교 가능');
  });

  it('does not confirm performance for a pending or unknown original transaction', () => {
    for (const status of ['pending', 'unknown'] as const) {
      const result = reviewPlanPosition({ plan, record: record({ status, receipt: null, confirmedAt: null }),
        observation: closed });
      expect(result.status).toBe('unconfirmed');
      expect(result.actualNetChange).toBeNull();
      expect(result.varianceFromExpected).toBeNull();
    }
    const failed = reviewPlanPosition({ plan, record: record({ status: 'failed', confirmedAt: null }), observation: closed });
    expect(failed.status).toBe('not_executed');
    expect(failed.actualFee).toBe('1');
    expect(failed.actualNetChange).toBeNull();
  });

  it('does not present a historical observation as live performance', () => {
    const snapshot = observation('0', '0', finish, { source: { ...live(finish), mode: 'snapshot' } });
    const result = reviewPlanPosition({ plan, record: record(), observation: snapshot });
    expect(result.status).toBe('non_live_observation');
    expect(result.varianceFromExpected).toBeNull();
  });

  it('validates chain, wallet, plan and position before using an observation', () => {
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', finish, { chain: 'mainnet' }) })).toThrow();
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', finish, { walletAddress: 'TOTHER' }) })).toThrow();
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', finish, { planId: 'other' }) })).toThrow();
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', finish, { positionId: 'other' }) })).toThrow();
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', finish,
      { underlyingToken: { symbol: 'USDT', address: 'TUSDT', decimals: 6 } }) })).toThrow();
    expect(() => reviewPlanPosition({ plan, record: record(), observation: observation('1', '0') })).toThrow(/환율/);
  });

  it('shows observed holdings and fees but does not invent a return without opening/flow evidence', () => {
    const value = observation('8000000000', '8000000000');
    const result = reviewPlanPosition({ plan, record: record(), observation: value,
      externalExpenses: [{ id: 'rent', date: '2026-10-06', amount: '20', asset: trx }] });
    expect(result.status).toBe('observed');
    expect(result.observedValue).toBe('8000');
    expect(result.actualFee).toBe('1');
    expect(result.actualNetChange).toBeNull();
    expect(result.externalExpenses[0].amount).toBe('20');
  });

  it('keeps external spending out of confirmed investment return and compares only a closed full-period position', () => {
    const flows = [flow('deposit', '80', 'deposit-tx', confirmed),
      flow('withdraw', '81', 'withdraw-tx', finish)];
    const input = { plan, record: record(), observation: closed, openingObservation: opening,
      positionFlows: flows, flowCoverage: coverage };
    const a = reviewPlanPosition(input);
    const b = reviewPlanPosition({ ...input, externalExpenses: [{ id: 'rent', date: '2026-10-06', amount: '200', asset: trx }] });
    expect(a.status).toBe('comparable');
    expect(a.resultKind).toBe('realized');
    expect(a.actualNetChange).toBe('0'); // withdrawn 81 - invested 80 - actual fee 1
    expect(a.varianceFromExpected).not.toBeNull();
    expect(b.actualNetChange).toBe(a.actualNetChange);
    expect(b.varianceFromExpected).toBe(a.varianceFromExpected);
    const noExitFee = reviewPlanPosition({ ...input, positionFlows: [flows[0], { ...flows[1], actualFeeInInputAsset: null }] });
    expect(noExitFee.actualNetChange).toBeNull();
    expect(noExitFee.reasons).toContain('additional_fee_unavailable');
    expect(() => reviewPlanPosition({ ...input, positionFlows: [flows[0], flows[0]] })).toThrow(/중복/);
  });

  it('withholds planned-period variance for an open or early-closed position', () => {
    const early = '2026-10-01T06:00:00.000Z';
    const open = observation('8000000', '8000000', early); // 8 TRX position at 1:1 raw exchange rate
    const openResult = reviewPlanPosition({ plan, record: record(), observation: open, openingObservation: opening,
      positionFlows: [flow('deposit', '80', 'deposit-tx', confirmed)],
      flowCoverage: { fromAt: opening.source.fetchedAt, throughAt: early, source: live(early) },
    });
    expect(openResult.status).toBe('observed');
    expect(openResult.resultKind).toBe('unrealized');
    expect(openResult.varianceFromExpected).toBeNull();
    const earlyClosed = reviewPlanPosition({ plan, record: record(), observation: observation('0', '0', early),
      openingObservation: opening,
      positionFlows: [flow('deposit', '80', 'deposit-tx', confirmed), flow('withdraw', '81', 'withdraw-tx', early)],
      flowCoverage: { fromAt: opening.source.fetchedAt, throughAt: early, source: live(early) },
    });
    expect(earlyClosed.actualNetChange).toBe('0');
    expect(earlyClosed.varianceFromExpected).toBeNull();
  });
});

describe('adjustment proposal', () => {
  it('returns an unconfirmed withdrawal suggestion after a larger protected expense', () => {
    const changed = needs({ inputVersion: 2, confirmedVersion: 2, liquidReserve: '30' });
    const proposal = proposeAdjustment({ originalPlan: plan, changedNeeds: changed, newQuote: { ...quote(), quoteVersion: 'q2' },
      now: new Date(start) });
    expect(proposal.direction).toBe('withdraw');
    expect(proposal.amountFromOriginalAllocation).toBe('10');
    expect(proposal.proposedPlan.allocation.invested).toBe('70');
    expect(proposal.proposedPlan.eligibility.reasons).toContain('needs_unconfirmed');
    expect(proposal.requiresConfirmation).toBe(true);
    expect(proposal.canExecute).toBe(false);
    expect(plan.allocation.invested).toBe('80');
  });

  it('treats a new rate quote as a proposal even when the input version is unchanged', () => {
    const proposal = proposeAdjustment({ originalPlan: plan, changedNeeds: needs(),
      newQuote: { ...quote(), quoteVersion: 'q2', baseRate: { kind: 'apy', rate: '0.01' } },
      now: new Date(start) });
    expect(proposal.direction).toBe('none');
    expect(proposal.proposedPlan.id).not.toBe(plan.id);
    expect(proposal.proposedPlan.netYield).not.toBe(plan.netYield);
    expect(proposal.proposedPlan.eligibility.reasons).toContain('needs_unconfirmed');
    expect(proposal.canExecute).toBe(false);
  });
});
