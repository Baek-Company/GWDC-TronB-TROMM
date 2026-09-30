import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NileFeeEvidence } from '../src/features/plans/PlanExplorer';

type Scenario = NonNullable<React.ComponentProps<typeof NileFeeEvidence>['scenario']>;
const now = Date.now();
const scenario: Scenario = {
  planId: 'nile:80_20', status: 'reference_scenario', basis: 'representative_simulation',
  amountSun: '50000000', jTokenAmountRaw: '4500000000',
  depositFeeSun: '8000000', estimatedRedeemFeeSun: '7000000', stressRedeemFeeSun: '14000000',
  estimatedRoundTripFeeSun: '15000000', stressRoundTripFeeSun: '22000000', feeReserveSun: '22000000',
  postReserveInvestableSun: '28000000', reserveStatus: 'ready',
  referenceAccountAddress: 'TRkqhDpvyaFdjdhZZwJNxL8PrVEukSYvhr', referenceTxIds: [],
  reason: null, sourceUrl: 'https://nile.trongrid.io/wallet/estimateenergy',
  fetchedAt: new Date(now - 60_000).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
  assumptions: ['미래 무료 Energy와 Bandwidth는 0으로 가정합니다.', '미래 단가 2배는 스트레스 가정입니다.'],
};

describe('Nile future redeem fee UI', () => {
  it('shows a fresh representative simulation as a separate reference, with source and limits', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={scenario} />);
    expect(html).toContain('기준 계정 모의 실행');
    expect(html).toContain('참고 시나리오');
    expect(html).toContain('미래 환매 비용 참고');
    expect(html).toContain('7 TRX');
    expect(html).toContain('미래 환매 스트레스 비용 참고');
    expect(html).toContain('14 TRX');
    expect(html).toContain('왕복 비용 참고');
    expect(html).toContain('15 TRX');
    expect(html).toContain('22 TRX');
    expect(html).toContain('비용 예비액 제외 후 운용 가능액 참고');
    expect(html).toContain('28 TRX');
    expect(html).toContain('조회 출처');
    expect(html).toContain('기준 계정:');
    expect(html).toContain('검증된 왕복 비용·순익·추천 적격성에 포함하지 않으며');
  });

  it('shows only the confirmed entry leg when the redeem leg is missing', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario, status: 'partial',
      basis: 'unknown', estimatedRedeemFeeSun: null, stressRedeemFeeSun: null,
      estimatedRoundTripFeeSun: null, stressRoundTripFeeSun: null, feeReserveSun: null,
      postReserveInvestableSun: null, reserveStatus: 'unknown',
      referenceAccountAddress: null,
      reason: '기준 계정에서 해당 수량의 환매 모의 실행이 실패했습니다.' }} />);
    expect(html).toContain('진입 비용만 확인');
    expect(html).toContain('예치 비용 참고');
    expect(html).not.toContain('미래 환매 비용 참고');
    expect(html).not.toContain('왕복 비용 참고');
    expect(html).toContain('환매 모의 실행이 실패');
  });

  it('shows a redeem-only partial reference without inventing a round trip', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario,
      status: 'partial', depositFeeSun: null, estimatedRoundTripFeeSun: null,
      stressRoundTripFeeSun: null, feeReserveSun: null, postReserveInvestableSun: null,
      reserveStatus: 'unknown', reason: '진입 비용 조회가 실패했습니다.' }} />);
    expect(html).toContain('환매 참고치만 확인');
    expect(html).toContain('미래 환매 비용 참고');
    expect(html).not.toContain('왕복 비용 참고');
    expect(html).toContain('진입 비용 조회가 실패');
  });

  it('requires representative account or enough historical receipt IDs for cost figures', () => {
    const noAccount = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario,
      referenceAccountAddress: null }} />);
    expect(noAccount).toContain('근거 미완전·만료');
    expect(noAccount).not.toContain('15 TRX');

    const historical = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario,
      basis: 'historical_reference', referenceAccountAddress: null,
      referenceTxIds: ['a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 'd'.repeat(64), 'e'.repeat(64), 'f'.repeat(64)] }} />);
    expect(historical).toContain('검증된 과거 유사 거래 모델');
    expect(historical).toContain('확정 거래 표본 6건');
    expect(historical).toContain('15 TRX');
  });

  it('marks a candidate as an economic new-deposit hold when the fee budget cannot be retained', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario,
      postReserveInvestableSun: '0', reserveStatus: 'insufficient' }} />);
    expect(html).toContain('0 TRX');
    expect(html).toContain('경제성 기준의 신규 예치는 보류');
  });

  it('shows an amount-specific cost-only cap without calling it verified profit', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={{ ...scenario,
      amountSun: '80000000', reserveStatus: 'insufficient', economicDepositSun: '58000000',
      economicFeeReserveSun: '22000000', economicSizingStatus: 'ready' }} />);
    expect(html).toContain('예치 가능 상한은 58 TRX');
    expect(html).toContain('수익성이나 거래 승인은 검증되지 않았습니다');
  });

  it('hides all fee numbers when the source is missing or the reference expired', () => {
    for (const stale of [
      { ...scenario, sourceUrl: null },
      { ...scenario, validUntil: new Date(now - 1_000).toISOString() },
    ]) {
      const html = renderToStaticMarkup(<NileFeeEvidence scenario={stale} />);
      expect(html).toContain('근거 미완전·만료');
      expect(html).not.toContain('15 TRX');
      expect(html).not.toContain('22 TRX');
      expect(html).toContain('다시 조회');
    }
  });

  it('does not invent zero fees when there is no scenario', () => {
    const html = renderToStaticMarkup(<NileFeeEvidence scenario={null} />);
    expect(html).toContain('미산정');
    expect(html).toContain('근거 없음');
    expect(html).not.toContain('0 TRX');
  });
});
