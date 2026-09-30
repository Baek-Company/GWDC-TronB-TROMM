import { afterEach, describe, expect, it, vi } from 'vitest';
import { calculatePlan, createDatedAllocation } from '../shared/planning';
import { emptyAgentRequest } from '../shared/agent-request';
import type { DatedAllocation, ProductQuote, Source, UserNeeds } from '../shared/schemas';
import { agentRequestChanged, datedPositionState, evaluateDatedAllocationMonitor, evaluateGoalMonitor,
  remainingMonitorNeeds } from '../src/features/review/goal-monitor';
import { readGoalMonitor } from '../src/features/review/monitor-read';

const now = new Date('2026-09-29T03:00:00.000Z');
const token = { symbol: 'TRX', address: null, decimals: 6 };
const receipt = { symbol: 'jTRX', address: 'TJTRX', decimals: 8 };
const source: Source = {
  sourceUrl: 'https://nile.trongrid.io/walletsolidity', chain: 'nile',
  fetchedAt: now.toISOString(), sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc',
};
const needs: UserNeeds = {
  chain: 'nile', asset: token, amount: '100', startDate: '2026-09-29', endDate: '2026-10-29',
  expenses: [{ date: '2026-10-06', amount: '20', asset: token }], liquidReserve: '10',
  riskPreference: 'balanced', acceptsUsddRisk: false, acceptsDatedExpenseLiquidityRisk: true,
  timezone: 'Asia/Seoul',
  inputVersion: 1, confirmedVersion: 1,
};
const quote: ProductQuote = {
  id: 'nile-jtrx', quoteVersion: 'q1', product: 'justlend_jtrx', chain: 'nile',
  marketAddress: receipt.address, inputToken: token, depositToken: token, receiptToken: receipt,
  baseRate: { kind: 'apy', rate: '0.05' }, reward: null,
  liquidity: { exitAvailable: '1000000', withdrawalDelayDays: 0 }, conversion: null,
  costs: [
    { kind: 'deposit', amount: '0', asset: token, conversionRateToInput: null,
      estimatedAt: now.toISOString(), source },
    { kind: 'withdraw', amount: '0', asset: token, conversionRateToInput: null,
      estimatedAt: now.toISOString(), source },
  ], status: 'active', risks: [], source,
};
const originalPlan = calculatePlan(needs, quote, { now, allocation: '50', scenario: '50_50' });
const originalAllocation = createDatedAllocation(needs, [quote], { now, walletBalance: '100',
  requireWalletBalance: true });
const wallet = { address: 'TCONNECTED', balance: '100', balanceToken: token, balanceSource: source,
  position: null };

const usdt = { symbol: 'USDT', address: 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t', decimals: 6 };
const jusdt = { symbol: 'jUSDT', address: 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd', decimals: 8 };
const mainSource: Source = { ...source, chain: 'mainnet', sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract' };
const mainNeeds: UserNeeds = { ...needs, chain: 'mainnet', asset: usdt,
  expenses: [{ date: '2026-10-06', amount: '20', asset: usdt }] };
const mainQuote: ProductQuote = { ...quote, id: 'mainnet-jusdt', product: 'justlend_jusdt',
  chain: 'mainnet', marketAddress: jusdt.address, inputToken: usdt, depositToken: usdt,
  receiptToken: jusdt, source: mainSource,
  costs: quote.costs.map(cost => ({ ...cost, asset: usdt, source: mainSource })) };
const mainAllocationBase = createDatedAllocation(mainNeeds, [mainQuote], { now, walletBalance: '100',
  requireWalletBalance: true });
const mainAllocation: DatedAllocation = { ...mainAllocationBase,
  totalInvested: '70', totalHeld: '30',
  legs: mainAllocationBase.legs.map(leg => leg.purpose === 'horizon' ? {
    ...leg, decision: 'invest' as const, eligibility: 'eligible' as const,
    product: 'justlend_jusdt' as const, quoteId: 'mainnet-jusdt', quoteVersion: 'q1',
    invested: '70', held: '10', earningDays: 30, withdrawalRequestDate: '2026-10-29',
    expectedNetYield: '0.1', roundTripCost: '0', source: mainSource,
    sizedQuoteVersion: 'leg-before', bundleQuoteVersion: 'bundle-before',
    validUntil: '2026-09-29T03:02:00.000Z',
  } : leg),
  selectedBundleQuoteVersion: 'bundle-before', selectedBundleStatus: 'partial', selectedBundleNetYield: null,
  selectedBundleQuote: {
    chain: 'mainnet', walletAddress: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb',
    needsVersion: 1, contextVersion: 'context-before', inputTokenAddress: usdt.address!,
    marketAddress: jusdt.address!, selectedLegVersions: [], approvalActions: 'unknown', actions: [],
    allowanceUsdtRaw: null, totalDepositUsdtRaw: '70000000', scenarioRateApr: null,
    expectedCostUsdt: null, stressCostUsdt: null, requiredFeeTrxSun: null,
    availableFeeTrxSun: null, scenarioNetYieldUsdt: null, stressNetYieldUsdt: null,
    observationWindow: { firstBlock: '100', lastBlock: '101', startedAt: now.toISOString(), endedAt: now.toISOString() },
    status: 'partial', validUntil: '2026-09-29T03:02:00.000Z', quoteVersion: 'bundle-before',
  },
};
const observedMainWallet = { address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb', balance: mainAllocation.totalHeld,
  balanceToken: usdt, balanceSource: mainSource,
  position: { status: 'ready' as const, receiptToken: jusdt, receiptBalanceBaseUnits: '7000000000',
    underlyingToken: usdt, underlyingValue: mainAllocation.totalInvested,
    marketVerified: true, source: mainSource } };

function evaluate(overrides: Partial<Parameters<typeof evaluateGoalMonitor>[0]> = {}) {
  return evaluateGoalMonitor({ originalPlan, currentNeeds: needs, latestPlan: originalPlan,
    wallet, expectedWalletAddress: wallet.address, hasConfirmedDeposit: false,
    hasConfirmedWithdrawal: false, requestChanged: false, dataMode: 'live', now, ...overrides });
}

describe('read-only goal monitoring', () => {
  it('maintains only when fresh quote, wallet, liquidity and original objective agree', () => {
    expect(originalPlan.eligibility.status).toBe('eligible');
    expect(evaluate().action).toBe('maintain');
    expect(evaluate({ wallet: { ...wallet, balance: '20' } }).action).toBe('review');
    expect(evaluate({ wallet: null }).action).toBe('hold_new_deposit');
    expect(evaluate({ requiresOriginalWallet: true, originalWalletAddress: null }).action).toBe('review');
    expect(evaluate({ latestPlan: { ...originalPlan, source: { ...source, mode: 'snapshot' } } }).action)
      .toBe('hold_new_deposit');
    expect(evaluate({ dataMode: 'mixed_or_unavailable' }).action).toBe('maintain');
  });

  it('requires the selected market and tokens to remain the same', () => {
    expect(evaluate({ latestPlan: { ...originalPlan, quote: { ...quote,
      marketAddress: 'TOTHER' } } }).action).toBe('review');
    expect(evaluate({ latestPlan: { ...originalPlan, quote: { ...quote,
      receiptToken: { ...receipt, address: 'TOTHER' } } } }).action).toBe('review');
  });

  it('forces review when facts, due spending, or returns change', () => {
    expect(evaluate({ requestChanged: true }).action).toBe('review');
    expect(evaluate({ currentNeeds: { ...needs, inputVersion: 2, confirmedVersion: 2 } }).action).toBe('review');
    expect(evaluate({ latestPlan: { ...originalPlan,
      allocation: { ...originalPlan.allocation, invested: '40' } } }).action).toBe('review');
    expect(evaluate({ now: new Date('2026-10-06T03:00:00.000Z') }).action).toBe('review');
    const lowerQuote = { ...quote, quoteVersion: 'q2', baseRate: { kind: 'apy' as const, rate: '0.01' } };
    const lowerPlan = calculatePlan(needs, lowerQuote, { now, allocation: '50', scenario: '50_50' });
    expect(evaluate({ latestPlan: lowerPlan }).action).toBe('review');
  });

  it('uses the remaining horizon after the first day without treating elapsed yield as a rate drop', () => {
    const later = new Date('2026-09-30T03:00:00.000Z');
    const remaining = remainingMonitorNeeds(needs, later)!;
    expect(remaining.startDate).toBe('2026-09-30');
    const freshSource = { ...source, fetchedAt: later.toISOString() };
    const freshQuote = { ...quote, quoteVersion: 'q2', source: freshSource,
      costs: quote.costs.map(cost => ({ ...cost, estimatedAt: later.toISOString(), source: freshSource })) };
    const newPlan = calculatePlan(remaining, freshQuote, { now: later, allocation: '50', scenario: '50_50' });
    expect(Number(newPlan.netYield)).toBeLessThan(Number(originalPlan.netYield));
    expect(evaluate({ now: later, latestPlan: newPlan,
      wallet: { ...wallet, balanceSource: freshSource } }).action).toBe('maintain');
    expect(remainingMonitorNeeds(needs, new Date('2026-10-06T03:00:00.000Z'))).toBeNull();
  });

  it('does not treat an executed deposit as liquid wallet principal', () => {
    expect(evaluate({ hasConfirmedDeposit: true }).action).toBe('review');
    const position = { status: 'ready' as const, receiptToken: receipt, underlyingToken: token,
      underlyingValue: '51', source };
    expect(evaluate({ hasConfirmedDeposit: true,
      wallet: { ...wallet, balance: '30', position } }).action).toBe('maintain');
    expect(evaluate({ hasConfirmedDeposit: true,
      wallet: { ...wallet, balance: '29', position } }).action).toBe('review');
    expect(evaluate({ hasConfirmedWithdrawal: true }).action).toBe('review');
  });

  it('detects a reset or changed facts even when the request version is reused', () => {
    const original = { ...emptyAgentRequest(), confirmedVersion: 1 };
    expect(agentRequestChanged(original, { ...original, explicitFacts: {
      ...original.explicitFacts, statedHoldings: '100',
    } })).toBe(true);
    expect(agentRequestChanged(original, { ...original, confirmedVersion: null })).toBe(true);
    expect(agentRequestChanged(original, { ...original, evidence: [{ path: 'explicitFacts.startDate',
      messageId: 'm1', excerpt: '오늘', utteredAt: now.toISOString() }] })).toBe(true);
    expect(agentRequestChanged(original, { ...original })).toBe(false);
  });
});

describe('dated allocation monitoring', () => {
  function evaluate(overrides: Partial<Parameters<typeof evaluateDatedAllocationMonitor>[0]> = {}) {
    return evaluateDatedAllocationMonitor({ original: originalAllocation, latest: originalAllocation,
      currentNeeds: needs, wallet, expectedWalletAddress: wallet.address,
      originalWalletAddress: wallet.address, requestChanged: false, dataMode: 'live', now,
      ...overrides });
  }

  it('keeps separately verified date legs without authorizing their trades', () => {
    expect(originalAllocation.legs.length).toBe(2);
    expect(originalAllocation.executionEligible).toBe(false);
    expect(evaluate().action).toBe('maintain');
    expect(evaluate({ wallet: null }).action).toBe('hold_new_deposit');
    expect(evaluate({ requiresOriginalWallet: true, originalWalletAddress: null }).action).toBe('review');
    expect(evaluate({ dataMode: 'mixed_or_unavailable' }).action).toBe('maintain');
    expect(evaluate({ simulationOnly: true }).action).toBe('hold_new_deposit');
  });

  it('reviews a changed or unrecorded date-leg contract route', () => {
    const changed = { ...originalAllocation, legs: originalAllocation.legs.map((leg, index) =>
      index === 0 ? { ...leg, routeIdentity: 'other-route' } : leg) };
    expect(evaluate({ latest: changed }).action).toBe('review');
    const legacy = { ...originalAllocation, legs: originalAllocation.legs.map((leg, index) =>
      index === 0 ? { ...leg, routeIdentity: undefined } : leg) };
    expect(evaluate({ original: legacy }).action).toBe('review');
  });

  it('requests review if one due-date route or amount changes', () => {
    const changed = { ...originalAllocation,
      legs: originalAllocation.legs.map((leg, index) => index === 0
        ? { ...leg, decision: 'hold' as const, product: null, invested: '0' }
        : leg) };
    expect(evaluate({ latest: changed }).action).toBe('review');
    expect(evaluate({ latest: { ...originalAllocation, amount: '90' } }).action).toBe('review');
    expect(evaluate({ requestChanged: true }).action).toBe('review');
  });

  it('compares unchanged legs over the remaining horizon without treating elapsed yield as a loss', () => {
    const later = new Date('2026-09-30T03:00:00.000Z');
    const remaining = remainingMonitorNeeds(needs, later)!;
    const freshSource = { ...source, fetchedAt: later.toISOString() };
    const freshQuote = { ...quote, quoteVersion: 'q2', source: freshSource,
      costs: quote.costs.map(cost => ({ ...cost, estimatedAt: later.toISOString(), source: freshSource })) };
    const current = createDatedAllocation(remaining, [freshQuote], { now: later,
      walletBalance: '100', requireWalletBalance: true });
    expect(Number(current.expectedNetYield)).toBeLessThan(Number(originalAllocation.expectedNetYield));
    expect(evaluate({ latest: current, now: later,
      wallet: { ...wallet, balanceSource: freshSource } }).action).toBe('maintain');
  });
});

describe('observed Mainnet jUSDT monitoring', () => {
  it('separates zero receipt balance, observed holdings and unknown positions', () => {
    expect(datedPositionState(mainAllocation, observedMainWallet, now)).toBe('confirmed_jusdt');
    expect(datedPositionState(mainAllocation, { ...observedMainWallet, position: {
      ...observedMainWallet.position, receiptBalanceBaseUnits: '0', underlyingValue: '0',
    } }, now)).toBe('uninvested');
    expect(datedPositionState(mainAllocation, { ...observedMainWallet, position: null }, now)).toBe('unknown');
  });

  it('does not require deposited principal to remain as liquid USDT', () => {
    const common = { original: mainAllocation, latest: null, currentNeeds: mainNeeds,
      expectedWalletAddress: observedMainWallet.address, originalWalletAddress: observedMainWallet.address,
      requiresOriginalWallet: true, requestChanged: false, dataMode: 'mixed_or_unavailable' as const,
      now, positionState: 'confirmed_jusdt' as const };
    const checked = evaluateDatedAllocationMonitor({ ...common, wallet: observedMainWallet });
    expect(checked.reasons.join(' ')).toContain('환매 성공·비용 견적');
    expect(checked.action).toBe('hold_new_deposit');
    expect(checked.reasons.join(' ')).not.toContain('원 날짜별 배분 총액');
    expect(evaluateDatedAllocationMonitor({ ...common, wallet: { ...observedMainWallet,
      balance: '0' } }).action).toBe('review');
    expect(evaluateDatedAllocationMonitor({ ...common, wallet: { ...observedMainWallet,
      position: null }, positionState: 'unknown' }).action).toBe('review');
  });
});

describe('monitor read contract', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a fresh agent assessment and accepts a nullable dated allocation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/agent/session') return Response.json({ ready: true });
      if (input === '/api/agent/assessment') return Response.json({
        assessedAt: now.toISOString(), plans: [originalPlan], datedAllocation: originalAllocation,
        walletAddress: wallet.address, observedWalletBalance: wallet.balance,
        walletBalanceSource: source, dataMode: 'live',
      });
      throw new Error(`Unexpected path ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const read = await readGoalMonitor({ originalPlan: null, originalAllocation,
      currentNeeds: needs, agentRequest: emptyAgentRequest(), address: wallet.address,
      signal: new AbortController().signal, now });
    expect(read.datedAllocation?.id).toBe(originalAllocation.id);
    expect(read.wallet?.balance).toBe('100');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reuses the assessment position observation for a saved Mainnet jUSDT allocation', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      if (input === '/api/agent/session') return Response.json({ ready: true });
      if (input === '/api/agent/assessment') return Response.json({
        assessedAt: now.toISOString(), plans: [], datedAllocation: null,
        walletAddress: observedMainWallet.address, observedWalletBalance: observedMainWallet.balance,
        walletBalanceSource: mainSource, observedPosition: observedMainWallet.position,
        observedFeeBalance: { amount: '1', source: mainSource }, diagnostics: [], dataMode: 'mixed_or_unavailable',
      });
      throw new Error(`Unexpected path ${input}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    const read = await readGoalMonitor({ originalPlan: null, originalAllocation: mainAllocation,
      currentNeeds: mainNeeds, agentRequest: emptyAgentRequest(), address: observedMainWallet.address,
      signal: new AbortController().signal, now });
    expect(read.positionState).toBe('confirmed_jusdt');
    expect(read.wallet?.position?.underlyingValue).toBe('70');
    expect(read.feeTrxAmount).toBe('1');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
