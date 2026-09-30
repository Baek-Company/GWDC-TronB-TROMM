import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { calculateLiquidity, createMainnetPlans } from '../shared/planning';
import { userNeedsSchema } from '../shared/schemas';
import { I18nProvider } from '../src/lib/i18n';
import { CalculationBasis } from '../src/features/needs/CalculationBasis';
import { UsdtExpectedResult } from '../src/features/demo/UsdtExpectedResult';
import { PlanExplorer, NileFeeEvidence } from '../src/features/plans/PlanExplorer';
import { FundingPanel } from '../src/features/plans/FundingPanel';
import { ReviewPanel } from '../src/features/review/ReviewPanel';
import { ReplayPanel } from '../src/features/review/ReplayPanel';
import { SourcesPanel } from '../src/features/sources/SourcesPanel';

const asset = { symbol: 'USDT', address: null, decimals: 6 };
const needs = userNeedsSchema.parse({
  chain: 'mainnet', asset, amount: '1000', startDate: '2026-09-30', endDate: '2026-10-30',
  expenses: [{ date: '2026-10-07', amount: '200', asset }, { date: '2026-11-14', amount: '100', asset }],
  liquidReserve: '50', riskPreference: 'balanced', acceptsUsddRisk: false,
  acceptsDatedExpenseLiquidityRisk: true, timezone: 'Asia/Seoul', inputVersion: 1, confirmedVersion: 1,
});
function english(children: React.ReactNode) {
  return renderToStaticMarkup(<I18nProvider initialLanguage="en">{children}</I18nProvider>);
}

describe('English planning and review panels', () => {
  it('translates both calculation explanations while preserving amounts and protection limits', () => {
    const basis = english(<CalculationBasis needs={needs} liquidity={calculateLiquidity(needs)} />);
    const result = english(<UsdtExpectedResult needs={needs} />);
    expect(basis).toContain('1,000 − (50 + 300) = 650 USDT');
    expect(basis).toContain('fully protected even after the end date');
    expect(basis).toContain('this selection does not increase the cap');
    expect(result).toContain('650.000000');
    expect(result).toContain('not a JustLend product quote or deposit recommendation');
    expect(result).toContain('Net yield after costs');
    expect(result).toContain('Cannot be calculated');
    expect(basis + result).not.toMatch(/[가-힣]/);
  });

  it('translates initial screens and their accessibility labels', () => {
    const html = english(<><PlanExplorer needs={null} /><FundingPanel needs={null} />
      <ReplayPanel /><SourcesPanel /><UsdtExpectedResult needs={null} />
      <ReviewPanel selectedPlan={null} records={[]} observations={[]} openingObservations={[]}
        positionFlows={[]} flowCoverages={[]} currentNeeds={null} onExport={() => {}} /></>);
    expect(html).toContain('Waiting for confirmation');
    expect(html).toContain('aria-label="USDT to TRX funding example"');
    expect(html).toContain('Load JSON');
    expect(html).toContain('Export records as JSON');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('translates an existing plan and a domain-generated monitoring decision', () => {
    const plan = createMainnetPlans(needs, { jUsdt: null, jUsdd: null }, { now: new Date('2026-09-30T00:00:00Z') }).plans[0];
    const html = english(<ReviewPanel selectedPlan={plan} records={[]} observations={[]} openingObservations={[]}
      positionFlows={[]} flowCoverages={[]} currentNeeds={{ ...needs, confirmedVersion: null }} onExport={() => {}} />);
    expect(html).toContain('Your current goals are not confirmed.');
    expect(html).toContain('No automatic trading or background notifications');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('translates fee evidence and server assumptions without implying verified future fees', () => {
    const now = Date.now();
    const html = english(<NileFeeEvidence scenario={{
      planId: 'nile:80_20', status: 'reference_scenario', basis: 'representative_simulation',
      amountSun: '50000000', jTokenAmountRaw: '4500000000', depositFeeSun: '8000000',
      estimatedRedeemFeeSun: '7000000', stressRedeemFeeSun: '14000000',
      estimatedRoundTripFeeSun: '15000000', stressRoundTripFeeSun: '22000000', feeReserveSun: '22000000',
      postReserveInvestableSun: '28000000', reserveStatus: 'ready',
      referenceAccountAddress: 'TRkqhDpvyaFdjdhZZwJNxL8PrVEukSYvhr', referenceTxIds: [], reason: null,
      sourceUrl: 'https://nile.trongrid.io/wallet/estimateenergy',
      fetchedAt: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
      assumptions: ['미래 무료 Energy와 Bandwidth는 0으로 가정합니다.'],
    }} />);
    expect(html).toContain('Future redemption cost reference');
    expect(html).toContain('7 TRX');
    expect(html).toContain('Future free Energy and Bandwidth are assumed to be zero.');
    expect(html).toContain('not confirmed future fees for your wallet');
    expect(html).not.toMatch(/[가-힣]/);
  });

  it('translates known calculation errors while preserving unknown external details', () => {
    const invalid = { ...needs, amount: '1.0000001' };
    const html = english(<UsdtExpectedResult needs={invalid} />);
    expect(html).toContain('USDT amounts must have at most six decimal places.');
    expect(html).not.toMatch(/[가-힣]/);
  });
});
