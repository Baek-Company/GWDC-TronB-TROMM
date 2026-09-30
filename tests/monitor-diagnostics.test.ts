import { afterEach, describe, expect, it, vi } from 'vitest';
import { createMainnetPlans } from '../shared/planning';
import type { UserNeeds } from '../shared/schemas';
import { monitorBlockers, safeMonitorError } from '../src/features/review/monitor-diagnostics';
import { readGoalMonitor } from '../src/features/review/monitor-read';

const now = new Date('2026-09-29T03:00:00.000Z');
const token = { symbol: 'USDT', address: 'TUSDT', decimals: 6 };
const needs: UserNeeds = {
  chain: 'mainnet', asset: token, amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29',
  expenses: [{ date: '2026-10-06', amount: '200', asset: token }], liquidReserve: '0',
  riskPreference: 'balanced', acceptsUsddRisk: false, acceptsDatedExpenseLiquidityRisk: true,
  timezone: 'Asia/Seoul',
  inputVersion: 1, confirmedVersion: 1,
};
const plans = createMainnetPlans(needs, { jUsdt: null, jUsdd: null }, { now });
const jUsdt = plans.plans.find(plan => plan.kind === 'justlend_jusdt')!;

describe('goal monitor diagnostics', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('shows the selected product failure and rate limit without leaking provider text or unrelated products', () => {
    const blockers = monitorBlockers({
      originalPlan: jUsdt, originalAllocation: null, latestPlan: jUsdt,
      latestAllocation: null, balanceReason: null, walletIssue: null,
      diagnostics: [
        { name: 'justlend_jusdt', status: 'unknown', reason: 'JustLend HTTP 429 api_key=secret-value' },
        { name: 'usdd_psm', status: 'unavailable', reason: 'USDD HTTP 429' },
      ],
    });
    const text = blockers.map(item => item.message).join(' ');
    expect(text).toContain('상품 견적을 조회하지 못했습니다');
    expect(text).toContain('JustLend jUSDT: 조회 한도(HTTP 429)');
    expect(text).not.toContain('PSM');
    expect(text).not.toContain('secret-value');
  });

  it('ignores an evaluated alternative when the saved legs select only jUSDT', () => {
    const source = {
      sourceUrl: 'https://example.test/quote', chain: 'mainnet' as const,
      fetchedAt: now.toISOString(), sourceUpdatedAt: now.toISOString(), mode: 'live' as const,
    };
    const originalAllocation = {
      ...plans.datedAllocation!,
      legs: plans.datedAllocation!.legs.map((leg, index) => index === 0
        ? { ...leg, product: 'justlend_jusdt' as const } : leg),
      evaluatedQuotes: [
        { product: 'justlend_jusdt' as const, quoteId: 'jusdt', quoteVersion: '1', source },
        { product: 'psm_jusdd' as const, quoteId: 'psm', quoteVersion: '1', source },
      ],
    };
    const text = monitorBlockers({
      originalPlan: null, originalAllocation, latestPlan: null, latestAllocation: null,
      balanceReason: null, walletIssue: null,
      diagnostics: [
        { name: 'justlend_jusdt', status: 'unavailable', reason: 'HTTP 429' },
        { name: 'usdd_psm', status: 'unavailable', reason: 'HTTP 429' },
      ],
    }).map(item => item.message).join(' ');
    expect(text).toContain('JustLend jUSDT: 조회 한도(HTTP 429)');
    expect(text).not.toContain('PSM');
  });

  it('explains that HTTP 403 may be a quota or permission limit', () => {
    const text = monitorBlockers({
      originalPlan: jUsdt, originalAllocation: null, latestPlan: null,
      latestAllocation: null, balanceReason: null, walletIssue: null,
      diagnostics: [{ name: 'justlend_jusdt', status: 'unavailable', reason: 'HTTP 403' }],
    }).map(item => item.message).join(' ');
    expect(text).toContain('API 키·권한과 호출량');
  });

  it('identifies expense-leg evidence and safely summarizes wallet failures', () => {
    const allocation = plans.datedAllocation!;
    const latest = { ...allocation, legs: allocation.legs.map((leg, index) => index === 0
      ? { ...leg, reasons: ['cost_unverified', 'secret=do-not-show'] } : leg) };
    const blockers = monitorBlockers({
      originalPlan: null, originalAllocation: allocation, latestPlan: null,
      latestAllocation: latest, diagnostics: [],
      balanceReason: 'Mainnet USDT 잔액 HTTP 429 token=do-not-show', walletIssue: null,
    });
    const text = blockers.map(item => item.message).join(' ');
    expect(text).toContain('2026-10-06: 승인·예치·출금·네트워크 비용');
    expect(text).toContain('지갑 잔액 RPC 조회 한도(HTTP 429)');
    expect(text).not.toContain('do-not-show');
  });

  it('redacts unknown API errors and preserves only safe next steps', () => {
    expect(safeMonitorError(new Error('key=super-secret endpoint failure'))).not.toContain('super-secret');
    expect(safeMonitorError(new Error('HTTP 429 key=super-secret'))).toContain('조회 한도(HTTP 429)');
  });

  it('carries manual API diagnostics into review without treating the optional PSM path as required', async () => {
    const fetchMock = vi.fn(async (path: RequestInfo | URL) => {
      expect(path).toBe('/api/plans');
      return Response.json({ ...plans, diagnostics: [
        { name: 'justlend_jusdt', status: 'unknown', reason: 'JustLend Mainnet 계약 검증 HTTP 429' },
        { name: 'usdd_psm', status: 'unavailable', reason: 'USDD Mainnet PSM HTTP 429' },
      ] });
    });
    vi.stubGlobal('fetch', fetchMock);
    const read = await readGoalMonitor({ originalPlan: null, originalAllocation: plans.datedAllocation!,
      currentNeeds: needs, agentRequest: null, address: null,
      signal: new AbortController().signal, now });
    expect(read.diagnostics).toHaveLength(2);
    expect(read.walletIssue).toMatch(/TronLink/);
    const text = monitorBlockers({ originalPlan: null, originalAllocation: plans.datedAllocation!,
      latestPlan: null, latestAllocation: read.datedAllocation,
      diagnostics: read.diagnostics, balanceReason: read.balanceReason,
      walletIssue: read.walletIssue }).map(item => item.message).join(' ');
    expect(text).toContain('JustLend jUSDT: 조회 한도(HTTP 429)');
    expect(text).not.toContain('PSM 양방향 경로');
  });
});
