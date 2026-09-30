import { describe, expect, it } from 'vitest';
import { createAssessor } from '../server/agent/assessment';
import { advanceAgentRequest } from '../server/agent/intake';
import { confirmAgentRequest, toUserNeeds } from '../shared/agent-request';
import { createMainnetPlans } from '../shared/planning';
import { canStoreAssessedPlan, canStoreDatedAllocation } from '../src/features/agent/AgentPanel';

const now = new Date('2026-09-29T09:00:00.000Z');
const wallet = { address: '', network: '네트워크 확인 필요', networkKey: 'unknown' as const, chainId: null };

async function readyAssessment() {
  const intake = advanceAgentRequest({
    message: '메인넷에서 1000 USDT 보유, 오늘부터 30일 운용, 지출 없음, 예비액 0 USDT, 보수형',
    utteredAt: now.toISOString(),
  });
  const request = confirmAgentRequest(intake.request);
  const assess = createAssessor({
    mainnetQuotes: async () => ({ jUsdt: null, jUsdd: null, diagnostics: [], psmEvidence: null }),
    now: () => now,
  });
  return { request, assessment: await assess(toUserNeeds(request)) };
}

describe('storing an assessed plan for read-only review', () => {
  it('allows a confirmed hold baseline but not an excluded product or an old input version', async () => {
    const { request, assessment } = await readyAssessment();
    const hold = assessment.plans.find(plan => plan.kind === 'hold')!;
    const unavailableProduct = assessment.plans.find(plan => plan.kind === 'justlend_jusdt')!;
    expect(canStoreAssessedPlan(request, assessment, hold, wallet)).toBe(true);
    expect(canStoreAssessedPlan(request, assessment, unavailableProduct, wallet)).toBe(false);
    expect(canStoreAssessedPlan({ ...request, version: request.version + 1, confirmedVersion: null },
      assessment, hold, wallet)).toBe(false);
  });

  it('rejects a wallet-bound assessment after the connected account or chain changes', async () => {
    const { request, assessment } = await readyAssessment();
    const hold = assessment.plans.find(plan => plan.kind === 'hold')!;
    const bound = { ...assessment, walletAddress: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' };
    expect(canStoreAssessedPlan(request, bound, hold, wallet)).toBe(false);
    expect(canStoreAssessedPlan(request, bound, hold, {
      ...wallet, address: bound.walletAddress, networkKey: 'nile', chainId: '0xcd8690dc',
    })).toBe(false);
    expect(canStoreAssessedPlan(request, bound, hold, {
      ...wallet, address: bound.walletAddress, networkKey: 'mainnet', chainId: '0x2b6653dc',
    })).toBe(true);
  });

  it('keeps a dated allocation separate from a single product plan and rejects stale baselines', async () => {
    const { request, assessment } = await readyAssessment();
    const allocation = createMainnetPlans(toUserNeeds(request), { jUsdt: null, jUsdd: null },
      { now }).datedAllocation!;
    const withAllocation = { ...assessment, datedAllocation: allocation };
    expect(canStoreDatedAllocation(request, withAllocation, allocation, wallet)).toBe(true);
    expect(canStoreDatedAllocation(request, assessment, allocation, wallet)).toBe(false);
    expect(canStoreDatedAllocation({ ...request, version: request.version + 1, confirmedVersion: null },
      withAllocation, allocation, wallet)).toBe(false);
  });
});
