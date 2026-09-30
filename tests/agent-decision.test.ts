import { describe, expect, it } from 'vitest';
import { decidePlanSet } from '../shared/agent-decision';
import type { Plan } from '../shared/schemas';

function plan(kind: Plan['kind'], values: Partial<Plan> = {}): Plan {
  return { id: kind, kind, eligibility: { status: 'eligible', reasons: [] },
    netYield: kind === 'hold' ? '0' : '1', netYieldBasis: 'all_verified', roundTripCost: '0',
    source: { sourceUrl: 'https://example.org/verified-rpc', chain: 'mainnet', fetchedAt: '2026-09-29T00:00:00.000Z',
      sourceUpdatedAt: '2026-09-29T00:00:00.000Z', mode: 'live', accessMethod: 'rpc' },
    ...values } as Plan;
}

describe('read-only agent decision', () => {
  it('distinguishes an eligible hold ID from an absent recommendation', () => {
    const hold = plan('hold');
    expect(decidePlanSet({ plans: [hold, plan('justlend_jusdt', {
      eligibility: { status: 'excluded', reasons: ['quote_stale'] }, netYield: null,
      netYieldBasis: 'unavailable',
    })], recommendedPlanId: hold.id })).toMatchObject({
      action: 'insufficient_data', planId: hold.id, executionEligible: false,
    });
  });

  it('recommends only positive eligible net yield and never grants execution', () => {
    const candidate = plan('justlend_jusdt');
    expect(decidePlanSet({ plans: [plan('hold'), candidate], recommendedPlanId: candidate.id }))
      .toMatchObject({ action: 'recommend', planId: candidate.id, executionEligible: false });
    expect(decidePlanSet({ plans: [plan('hold'), plan('justlend_jusdt', { netYield: '-1' })],
      recommendedPlanId: 'hold' })).toMatchObject({ action: 'hold', reasonCodes: ['non_positive_net_yield'] });
  });

  it('does not promote a positive but non-live or costless plan into a recommendation', () => {
    const candidate = plan('justlend_jusdt');
    expect(decidePlanSet({ plans: [plan('hold'), { ...candidate, source: { ...candidate.source!, mode: 'snapshot' } }],
      recommendedPlanId: candidate.id })).toMatchObject({ action: 'insufficient_data', reasonCodes: ['non_live_data'] });
    expect(decidePlanSet({ plans: [plan('hold'), { ...candidate, roundTripCost: null }],
      recommendedPlanId: candidate.id })).toMatchObject({ action: 'insufficient_data', reasonCodes: ['cost_unverified'] });
  });
});
