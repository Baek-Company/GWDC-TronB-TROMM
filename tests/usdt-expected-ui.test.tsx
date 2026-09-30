import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { UsdtExpectedResult } from '../src/features/demo/UsdtExpectedResult';
import { userNeedsSchema } from '../shared/schemas';

const token = { symbol: 'USDT', address: null, decimals: 6 };

describe('Mainnet USDT hypothetical result UI', () => {
  it('labels the illustration and leaves net return and execution unresolved', () => {
    const needs = userNeedsSchema.parse({
      chain: 'mainnet', asset: token, amount: '1000', startDate: '2026-09-30',
      endDate: '2026-10-30', expenses: [{ date: '2026-10-07', amount: '200', asset: token }],
      liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
      timezone: 'Asia/Seoul', inputVersion: 1, confirmedVersion: null,
    });
    const html = renderToStaticMarkup(<UsdtExpectedResult needs={needs} />);
    expect(html).toContain('data-mode="synthetic"');
    expect(html).toContain('전 기간 운용 가정액');
    expect(html).toContain('800.000000');
    expect(html).toContain('비용 전 이자');
    expect(html).toContain('비용 차감 후 순익');
    expect(html).toContain('계산 불가');
    expect(html).toContain('상품 추천·거래');
    expect(html).toContain('제공하지 않음');
    expect(html).toContain('2026-10-07 예정 지출');
  });
});
