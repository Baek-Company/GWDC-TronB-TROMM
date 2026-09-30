import { describe, expect, it } from 'vitest';
import { createDatedAllocation, createMainnetPlans } from '../shared/planning';
import type { UserNeeds } from '../shared/schemas';
import { canStoreManualDatedAllocation } from '../src/lib/manual-allocation';
import { initialSession, parseSession } from '../src/lib/session';

const now = new Date('2026-09-29T03:00:00.000Z');
const asset = { symbol: 'USDT', address: 'TUSDT', decimals: 6 };
const needs: UserNeeds = {
  chain: 'mainnet', asset, amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29',
  expenses: [
    { date: '2026-10-06', amount: '125', asset },
    { date: '2026-10-06', amount: '75', asset },
  ], liquidReserve: '100', riskPreference: 'balanced', acceptsUsddRisk: false,
  timezone: 'Asia/Seoul', inputVersion: 3, confirmedVersion: 3,
};
const allocation = createDatedAllocation(needs, [null, null], { now });

describe('manual synthetic allocation baseline', () => {
  it('accepts a matching confirmed profile even when market evidence is incomplete', () => {
    expect(allocation.recommendation).toBe('insufficient_data');
    expect(canStoreManualDatedAllocation(needs, allocation)).toBe(true);
    expect(canStoreManualDatedAllocation({ ...needs, confirmedVersion: null }, allocation)).toBe(false);
    expect(canStoreManualDatedAllocation({ ...needs, inputVersion: 4, confirmedVersion: 4 }, allocation)).toBe(false);
    expect(canStoreManualDatedAllocation({ ...needs, amount: '900' }, allocation)).toBe(false);
    expect(canStoreManualDatedAllocation({ ...needs, expenses: [needs.expenses[0]] }, allocation)).toBe(false);
  });

  it('round trips without an agent assessment or wallet authority and preserves the trade record plan', () => {
    const selectedPlan = createMainnetPlans(needs, { jUsdt: null, jUsdd: null }, { now }).plans[0];
    const session = { ...initialSession(), selectedPlan,
      monitoredAllocation: { allocation, request: null, assessmentId: null,
        selectedAt: now.toISOString(), walletAddress: null } };
    const restored = parseSession(JSON.stringify(session));
    expect(restored.selectedPlan).toEqual(selectedPlan);
    expect(restored.monitoredAllocation).toEqual(session.monitoredAllocation);
    expect(() => parseSession(JSON.stringify({ ...session, monitoredAllocation: {
      ...session.monitoredAllocation, walletAddress: 'TUNVERIFIED',
    } }))).toThrow();
  });
});
