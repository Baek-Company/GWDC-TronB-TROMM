import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { calculateLiquidity } from '../shared/planning';
import { userNeedsSchema } from '../shared/schemas';
import { CalculationBasis } from '../src/features/needs/CalculationBasis';

const asset = { symbol: 'USDT', address: null, decimals: 6 };

describe('manual liquidity calculation basis', () => {
  it('itemizes dated expenses inside and after the horizon without implying execution', () => {
    const needs = userNeedsSchema.parse({
      chain: 'mainnet', asset, amount: '1000', startDate: '2026-09-30', endDate: '2026-10-30',
      expenses: [
        { date: '2026-10-07', amount: '200', asset },
        { date: '2026-11-14', amount: '100', asset },
      ], liquidReserve: '50', riskPreference: 'balanced', acceptsUsddRisk: false,
      acceptsDatedExpenseLiquidityRisk: false, timezone: 'Asia/Seoul',
      inputVersion: 1, confirmedVersion: null,
    });
    const html = renderToStaticMarkup(<CalculationBasis needs={needs} liquidity={calculateLiquidity(needs)} />);

    expect(html).toContain('이번 계산의 근거');
    expect(html).toContain('data-mode="synthetic"');
    expect(html).toContain('기간 내 지출');
    expect(html).toContain('2026-10-07</time> · 시작일부터 7일 뒤');
    expect(html).toContain('기간 후 지출');
    expect(html).toContain('2026-11-14</time> · 시작일부터 45일 뒤');
    expect(html).toContain('종료일 이후라도 전액 보호');
    expect(html).toContain('1,000 − (50 + 300) = 650 USDT');
    expect(html).toContain('보호액 350 USDT');
    expect(html).toContain('현재 가정 계산은 예정 지출을 전액 보호');
    expect(html).toContain('이 단순 유동성 산식에는 적용하지 않았습니다');
    expect(html).toContain('왕복 거래비용');
    expect(html).toContain('예치 권고나 실행 가능한 거래 금액이 아닙니다');
  });

  it('explains that dated-risk opt-in does not change the ceiling and counts leap days', () => {
    const needs = userNeedsSchema.parse({
      chain: 'mainnet', asset, amount: '10', startDate: '2028-02-28', endDate: '2028-03-03',
      expenses: [{ date: '2028-03-01', amount: '2', asset }], liquidReserve: '1',
      riskPreference: 'conservative', acceptsUsddRisk: true,
      acceptsDatedExpenseLiquidityRisk: true, timezone: 'Asia/Seoul',
      inputVersion: 2, confirmedVersion: 2,
    });
    const html = renderToStaticMarkup(<CalculationBasis needs={needs} liquidity={calculateLiquidity(needs)} />);

    expect(html).toContain('2028-02-28</time> ~ <time dateTime="2028-03-03">2028-03-03</time> (4일)');
    expect(html).toContain('2028-03-01</time> · 시작일부터 2일 뒤');
    expect(html).toContain('10 − (1 + 2) = 7 USDT');
    expect(html).toContain('위험 수용 의향이 기록됐습니다');
    expect(html).toContain('이 선택으로 상한이 늘어나지 않습니다');
    expect(html).toContain('보수형으로 기록했습니다');
    expect(html).toContain('USDD 경로 검토:');
  });

  it('keeps zero scheduled expenses explicit', () => {
    const needs = userNeedsSchema.parse({
      chain: 'mainnet', asset, amount: '10', startDate: '2026-09-30', endDate: '2026-10-30',
      expenses: [], liquidReserve: '2', riskPreference: 'growth', acceptsUsddRisk: false,
      timezone: 'Asia/Seoul', inputVersion: 3, confirmedVersion: null,
    });
    const html = renderToStaticMarkup(<CalculationBasis needs={needs} liquidity={calculateLiquidity(needs)} />);
    expect(html).toContain('등록된 예정 지출이 없습니다');
    expect(html).toContain('10 − (2 + 0) = 8 USDT');
    expect(html).toContain('성장형으로 기록했습니다');
  });
});
