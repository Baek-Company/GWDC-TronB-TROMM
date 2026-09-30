import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { calculateLiquidity, createNilePlans } from '../shared/planning';
import { NileWorkflow, nileInputsToNeeds, parseNileInputs, persistNileInputs,
  rolloverNileInputs } from '../src/features/execution/NileWorkflow';

const today = '2026-09-30';

describe('Nile first-screen expense schedule', () => {
  it('protects the default 7-day TRX expense and shows the dated leg separately', () => {
    const inputs = parseNileInputs(null, null, today);
    expect(inputs).toMatchObject({ amount: '100', horizonDays: '30',
      expenses: [{ amount: '20', date: '2026-10-07' }], reserve: '0', asOfDate: today });
    const needs = nileInputsToNeeds({ ...inputs, confirmedVersion: inputs.version }, today);
    expect(needs.expenses).toEqual([{ date: '2026-10-07', amount: '20',
      asset: { symbol: 'TRX', address: null, decimals: 6 } }]);
    expect(calculateLiquidity(needs)).toMatchObject({ protectedAmount: '20', investableAmount: '80' });
    const plans = createNilePlans(needs, null, { now: new Date('2026-09-30T03:00:00.000Z') });
    expect(plans.plans.map(plan => plan.allocation.invested)).toEqual(['0', '80', '50']);
    expect(plans.datedAllocation?.legs[0]).toMatchObject({ purpose: 'expense', dueDate: '2026-10-07',
      amount: '20', decision: 'hold', invested: '0', held: '20' });
    expect(plans.datedAllocation?.executionEligible).toBe(false);
  });

  it('keeps the date in plan identity and protects expenses even after the horizon', () => {
    const inputs = parseNileInputs(null, null, today);
    const first = nileInputsToNeeds({ ...inputs, confirmedVersion: inputs.version }, today);
    const later = nileInputsToNeeds({ ...inputs, expenses: [{ amount: '20', date: '2026-11-08' }], version: 2,
      confirmedVersion: 2 }, today);
    expect(calculateLiquidity(later)).toMatchObject({ protectedAmount: '20', investableAmount: '80',
      dueExpenses: [] });
    expect(createNilePlans(first, null).plans[1].id).not.toBe(createNilePlans(later, null).plans[1].id);
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [{ amount: '20', date: '2026-09-29' }] }, today)).toThrow();
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [{ amount: '0', date: '' }] }, today)).toThrow();
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [{ amount: '101', date: '2026-10-07' }] }, today)).toThrow(/예정 지출액/);
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [{ amount: '0.0000001', date: '2026-10-07' }] }, today)).toThrow(/소수점 6자리/);
  });

  it('rejects sub-sun precision in every Nile TRX input before plan confirmation', () => {
    const inputs = parseNileInputs(null, null, today);
    expect(() => nileInputsToNeeds({ ...inputs, amount: '100.0000001' }, today))
      .toThrow(/가상 계획 금액.*소수점 6자리/);
    expect(() => nileInputsToNeeds({ ...inputs, reserve: '0.0000001' }, today))
      .toThrow(/별도 예비액.*소수점 6자리/);
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [{ amount: '20.0000001', date: '2026-10-07' }] }, today))
      .toThrow(/예정 지출액.*소수점 6자리/);
  });

  it('retains v1 and v2 inputs without silently retaining confirmation', () => {
    const old = { amount: '250', horizonDays: '45', reserve: '20', version: 4, confirmedVersion: 4 };
    const migrated = parseNileInputs(null, JSON.stringify(old), today);
    expect(migrated).toMatchObject({ ...old, expenses: [], asOfDate: today,
      version: 5, confirmedVersion: null });
    expect(nileInputsToNeeds(migrated, today).expenses).toEqual([]);
    const v2 = { ...old, expense: '5', expenseDate: '2026-10-07' };
    const fromV2 = parseNileInputs(null, JSON.stringify(old), today, JSON.stringify(v2));
    expect(fromV2).toMatchObject({ expenses: [{ amount: '5', date: '2026-10-07' }],
      version: 5, confirmedVersion: null });
    expect(parseNileInputs(JSON.stringify(fromV2), JSON.stringify(old), today).expenses[0].amount).toBe('5');
  });

  it('protects multiple dated expenses including those beyond the plan horizon', () => {
    const inputs = parseNileInputs(null, null, today);
    const needs = nileInputsToNeeds({ ...inputs, expenses: [
      { amount: '20', date: '2026-10-07' }, { amount: '30.5', date: '2026-10-14' },
      { amount: '10', date: '2026-11-08' },
    ] }, today);
    expect(needs.expenses.map(expense => expense.date)).toEqual(['2026-10-07', '2026-10-14', '2026-11-08']);
    expect(calculateLiquidity(needs)).toMatchObject({ protectedAmount: '60.5', investableAmount: '39.5' });
    expect(() => nileInputsToNeeds({ ...inputs, expenses: [
      { amount: '80', date: '2026-10-07' }, { amount: '30', date: '2026-10-14' },
    ] }, today)).toThrow(/합계가 보유 금액보다/);
  });

  it('invalidates a confirmed input and its old plan date at KST rollover', () => {
    const confirmed = { ...parseNileInputs(null, null, today), confirmedVersion: 1 };
    expect(rolloverNileInputs(confirmed, today)).toBe(confirmed);
    const changed = parseNileInputs(JSON.stringify(confirmed), null, '2026-10-01');
    expect(changed).toMatchObject({ asOfDate: '2026-10-01', version: 2, confirmedVersion: null });
    expect(changed.expenses).toEqual(confirmed.expenses);
    expect(() => nileInputsToNeeds(confirmed, '2026-10-01')).toThrow(/날짜가 변경/);
    expect(nileInputsToNeeds(changed, '2026-10-01').startDate).toBe('2026-10-01');
  });

  it('fails closed when browser input storage rejects a write', () => {
    const inputs = parseNileInputs(null, null, today);
    expect(() => persistNileInputs(inputs, { setItem: () => { throw new Error('QuotaExceededError'); } }))
      .toThrow(/QuotaExceededError/);
    let written = '';
    expect(persistNileInputs(inputs, { setItem: (_key, value) => { written = value; } })).toBe(written);
    expect(JSON.parse(written)).toEqual(inputs);
  });

  it('shows the expense date, protected amount, and explicit example action before wallet connection', () => {
    vi.stubGlobal('localStorage', { getItem: () => null });
    try {
      const html = renderToStaticMarkup(createElement(NileWorkflow, {
        wallet: { address: '', network: '연결 전', networkKey: 'unknown', chainId: null },
        onConnect: async () => {}, selectedPlan: null, historicalRecords: [], verifiedDepositFlow: null,
        onSelect: () => {}, onRestorePlan: () => {}, onRecord: () => {},
        onOpeningObservation: () => {}, onObservation: () => {}, onWithdrawalFlow: () => {},
      }));
      expect(html).toContain('가상 계획 금액');
      expect(html).toContain('지출 날짜');
      expect(html).toContain('지출 추가');
      expect(html).toContain('7일 뒤 20 TRX 예시 지출 적용');
      expect(html).toContain('지출·예비액 확보 20 TRX');
      expect(html).toContain('전 기간 운용 상한 80 TRX');
      expect(html).toContain('지출·예비액을 차감하기 전의 가상 입력');
    } finally { vi.unstubAllGlobals(); }
  });

  it('shows a storage failure and a retry action instead of claiming the inputs were saved', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('SecurityError'); } });
    try {
      const html = renderToStaticMarkup(createElement(NileWorkflow, {
        wallet: { address: '', network: '연결 전', networkKey: 'unknown', chainId: null },
        onConnect: async () => {}, selectedPlan: null, historicalRecords: [], verifiedDepositFlow: null,
        onSelect: () => {}, onRestorePlan: () => {}, onRecord: () => {},
        onOpeningObservation: () => {}, onObservation: () => {}, onWithdrawalFlow: () => {},
      }));
      expect(html).toContain('Nile 조건 저장소를 읽을 수 없습니다');
      expect(html).toContain('저장 다시 시도');
      expect(html).toContain('disabled=""');
    } finally { vi.unstubAllGlobals(); }
  });
});
