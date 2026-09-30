import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { Assessment } from '../server/agent/assessment';
import { emptyAgentRequest } from '../shared/agent-request';
import { jusdtReadOnlyEvidenceSchema, type Source } from '../shared/schemas';
import { JusdtReadOnlyEvidencePanel, visibleJusdtReadOnlyEvidence } from '../src/features/agent/AgentPanel';
import type { getWalletState } from '../src/wallet';

const WALLET = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const NOW = Date.parse('2026-09-29T09:00:00.000Z');
const source: Source = { sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract',
  chain: 'mainnet', fetchedAt: new Date(NOW).toISOString(), sourceUpdatedAt: null,
  mode: 'live', accessMethod: 'rpc' };
const request = { ...emptyAgentRequest(), version: 2, confirmedVersion: 2, intent: 'plan_only' as const,
  explicitFacts: { ...emptyAgentRequest().explicitFacts, chain: 'mainnet' as const, asset: 'USDT' as const } };
const wallet: ReturnType<typeof getWalletState> = {
  address: WALLET, networkKey: 'mainnet', network: 'Mainnet', chainId: '0x2b6653dc',
};
const mint = (amountRaw: string) => ({ action: 'mint' as const, basis: 'account_simulation' as const,
  contextVersion: 'context-1', amountRaw, energyUnits: '100', bandwidthBytes: '200',
  estimatedFeeSun: null, feeLimitSun: '20000', sources: [source] });
const evidence = jusdtReadOnlyEvidenceSchema.parse({
  chain: 'mainnet', walletAddress: WALLET, needsVersion: 2,
  contextVersion: 'context-1', marketQuoteVersion: 'market-1',
  allowanceUsdtRaw: '0', totalCandidateUsdtRaw: '1000000000',
  observationWindow: { firstBlock: '1', lastBlock: '2',
    startedAt: new Date(NOW).toISOString(), endedAt: new Date(NOW).toISOString() },
  validUntil: new Date(NOW + 60_000).toISOString(), approvalActions: 'approve',
  legs: [
    { bucketKey: 'expense:2026-10-06', amountUsdtRaw: '200000000', dueDate: '2026-10-06',
      plannedExitDate: '2026-10-05', quoteVersion: 'leg-200', mintCost: mint('200000000'),
      redeemModelVersion: null, holdReasons: ['future_exit_unknown'] },
    { bucketKey: 'horizon:2026-10-29', amountUsdtRaw: '800000000', dueDate: '2026-10-29',
      plannedExitDate: '2026-10-29', quoteVersion: 'leg-800', mintCost: mint('800000000'),
      redeemModelVersion: null, holdReasons: ['future_exit_unknown'] },
  ], executionEligible: false,
});
const assessment = { chain: 'mainnet', walletAddress: WALLET, inputVersion: 2, confirmedVersion: 2,
  plans: [{ kind: 'justlend_jusdt', quoteVersion: 'market-1', source }],
  jusdtReadOnlyEvidence: evidence } as Assessment;

describe('jUSDT read-only partial evidence', () => {
  it('shows both candidate amounts and unknown redemption without presenting a recommendation', () => {
    const visible = visibleJusdtReadOnlyEvidence(request, assessment, wallet, NOW + 1_000);
    expect(visible?.legs).toHaveLength(2);
    const html = renderToStaticMarkup(createElement(JusdtReadOnlyEvidencePanel,
      { evidence: visible!, marketSource: source }));
    expect(html).toContain('200 USDT');
    expect(html).toContain('800 USDT');
    expect(html).toContain('미래 환매 모델: 미확인');
    expect(html).toContain('공동 승인 분기: 승인 1회');
    expect(html).toContain('시장 조회 출처');
    expect(html).toContain('예치 근거 1: RPC');
    expect(html).toContain('거래 권한이 아닙니다');
    expect(html).not.toContain('예상 순익');
  });

  it('hides evidence for another wallet, network, input or market version and after expiry', () => {
    const visible = (nextAssessment = assessment, nextWallet = wallet,
      nextRequest = request, now = NOW + 1_000) =>
      visibleJusdtReadOnlyEvidence(nextRequest, nextAssessment, nextWallet, now);
    expect(visible({ ...assessment, walletAddress: 'another-wallet' })).toBeNull();
    expect(visible(assessment, { ...wallet, networkKey: 'nile' })).toBeNull();
    expect(visible(assessment, wallet, { ...request, version: 3, confirmedVersion: 3 })).toBeNull();
    expect(visible({ ...assessment, plans: [{ ...assessment.plans[0], quoteVersion: 'other' }] })).toBeNull();
    expect(visible(assessment, wallet, request, NOW + 60_000)).toBeNull();
    expect(visible({ ...assessment, jusdtReadOnlyEvidence: {
      ...evidence, validUntil: new Date(NOW + 120_000).toISOString() } },
    wallet, request, NOW + 60_001)).toBeNull();
    expect(visible({ ...assessment, jusdtReadOnlyEvidence: {
      ...evidence, totalCandidateUsdtRaw: '200000000' } })).toBeNull();
  });
});
