import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assessment } from '../server/agent/assessment';
import type { AgentRequestState } from '../shared/agent-request';
import { createNilePlans } from '../shared/planning';
import { productQuoteSchema, userNeedsSchema } from '../shared/schemas';
import { NileAgentFeeEvidence, visibleNileFeeScenario } from '../src/features/agent/AgentPanel';

const now = Date.parse('2026-09-30T03:00:00.000Z');
const walletAddress = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const market = 'TKM7w4qFmkXQLEF2MgrQroBYpd5TY7i1pq';
const trx = { symbol: 'TRX', address: null, decimals: 6 } as const;
const source = { sourceUrl: 'https://nile.trongrid.io/wallet/estimateenergy',
  chain: 'nile' as const, fetchedAt: new Date(now).toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };
const needs = userNeedsSchema.parse({ chain: 'nile', asset: trx, amount: '100',
  startDate: '2026-09-30', endDate: '2026-10-30', expenses: [], liquidReserve: '20',
  riskPreference: 'balanced', acceptsUsddRisk: false, timezone: 'Asia/Seoul',
  inputVersion: 1, confirmedVersion: 1 });
const quote = productQuoteSchema.parse({ id: 'nile-jtrx', quoteVersion: 'quote-1',
  product: 'justlend_jtrx', chain: 'nile', marketAddress: market,
  inputToken: trx, depositToken: trx, receiptToken: { symbol: 'jTRX', address: market, decimals: 8 },
  baseRate: null, reward: null,
  liquidity: { exitAvailable: '100000', withdrawalDelayDays: 0 },
  conversion: null, costs: [], status: 'active', risks: [], source });
const plan = createNilePlans(needs, quote, { now: new Date(now), walletBalance: '100' }).plans[1];
const scenario: Assessment['nileFeeScenarios'][number] = {
  planId: plan.id, status: 'reference_scenario', basis: 'representative_simulation',
  amountSun: '80000000', jTokenAmountRaw: '8000000000',
  depositFeeSun: '1000000', estimatedRedeemFeeSun: '2000000', stressRedeemFeeSun: '4000000',
  estimatedRoundTripFeeSun: '3000000', stressRoundTripFeeSun: '5000000', feeReserveSun: '6000000',
  postReserveInvestableSun: '74000000', reserveStatus: 'insufficient',
  economicDepositSun: '74000000', economicFeeReserveSun: '6000000', economicSizingStatus: 'ready',
  referenceAccountAddress: walletAddress, referenceTxIds: [],
  sourceUrl: source.sourceUrl, fetchedAt: source.fetchedAt,
  validUntil: new Date(now + 60_000).toISOString(), reason: null,
  assumptions: ['미래 무료 자원 0'],
};

describe('Nile reference costs in agent assessment', () => {
  it('shows amount-specific fees and reserves as a read-only reference, separate from approval', () => {
    const html = renderToStaticMarkup(<NileAgentFeeEvidence scenario={scenario} now={now + 1_000} />);
    expect(html).toContain('금액별 참고 시나리오');
    expect(html).toContain('미래 환매 비용 참고: 2 TRX');
    expect(html).toContain('스트레스 왕복 비용 5 TRX');
    expect(html).toContain('비용 예비액 반영 후 재계산한 운용 가능액 참고: 74 TRX');
    expect(html).toContain('원래 후보 운용액은 비용 예비액을 남길 수 없어');
    expect(html).toContain('검증된 순익·추천·승인 적격성에 반영되지 않습니다');
  });

  it('hides expired or unproven exit amounts and keeps the entry leg distinct', () => {
    const expired = renderToStaticMarkup(<NileAgentFeeEvidence scenario={scenario} now={now + 60_001} />);
    expect(expired).toContain('참고 근거가 만료');
    expect(expired).not.toContain('환매 비용 참고: 2 TRX');
    const noReferenceAccount = renderToStaticMarkup(<NileAgentFeeEvidence scenario={{ ...scenario,
      referenceAccountAddress: null }} now={now + 1_000} />);
    expect(noReferenceAccount).toContain('현재 예치 비용 참고: 1 TRX');
    expect(noReferenceAccount).not.toContain('환매 비용 참고: 2 TRX');
    expect(noReferenceAccount).not.toContain('왕복 비용 참고: 3 TRX');
    const fiveSamples = renderToStaticMarkup(<NileAgentFeeEvidence scenario={{ ...scenario,
      basis: 'historical_reference', referenceAccountAddress: null,
      referenceTxIds: Array.from({ length: 5 }, (_, index) => String(index).repeat(64)) }}
      now={now + 1_000} />);
    expect(fiveSamples).not.toContain('환매 비용 참고: 2 TRX');
    const sixSamples = renderToStaticMarkup(<NileAgentFeeEvidence scenario={{ ...scenario,
      basis: 'historical_reference', referenceAccountAddress: null,
      referenceTxIds: Array.from({ length: 6 }, (_, index) => String(index).repeat(64)) }}
      now={now + 1_000} />);
    expect(sixSamples).toContain('환매 비용 참고: 2 TRX');
  });

  it('does not expose a reference from another wallet, plan, or input version', () => {
    const request = { version: 1, confirmedVersion: 1,
      explicitFacts: { chain: 'nile', asset: 'TRX' } } as AgentRequestState;
    const assessment = { chain: 'nile', planBasis: 'observed_capped', inputVersion: 1,
      confirmedVersion: 1, walletAddress, plans: [plan], nileFeeScenarios: [scenario] } as Assessment;
    const wallet = { address: walletAddress, networkKey: 'nile' as const,
      network: 'Nile', chainId: '0xcd8690dc' as const };
    expect(visibleNileFeeScenario(request, assessment, plan, wallet)).toEqual(scenario);
    expect(visibleNileFeeScenario(request, assessment, plan,
      { ...wallet, address: 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb' })).toBeNull();
    expect(visibleNileFeeScenario({ ...request, version: 2 }, assessment, plan, wallet)).toBeNull();
    expect(visibleNileFeeScenario(request, { ...assessment,
      nileFeeScenarios: [{ ...scenario, amountSun: '50000000' }] }, plan, wallet)).toBeNull();
  });
});
