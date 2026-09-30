import { z } from 'zod';
import { TronWeb } from 'tronweb';
import Decimal from 'decimal.js';

const decimalString = z.string().regex(/^\d+(\.\d+)?$/);
const address = z.string().refine(value => TronWeb.isAddress(value), 'Invalid TRON address');
export const marketSchema = z.object({
  address, symbol: z.string(), underlyingSymbol: z.string(), underlyingAddress: address,
  underlyingDecimal: z.number().int().min(0).max(36),
  supplyRate: decimalString, borrowRate: decimalString,
  cash: decimalString, totalBorrows: decimalString, exchangeRate: decimalString,
});
export const marketEnvelopeSchema = z.object({
  code: z.literal(0), data: z.object({ tokenList: z.array(marketSchema).min(1) }),
});
export type Market = z.infer<typeof marketSchema>;
export type MarketSnapshot = {
  source: string; network: 'mainnet'; fetchedAt: string;
  sourceUpdatedAt: null; mode: 'live'; markets: Market[];
};
export function parseMarkets(value: unknown): Market[] {
  return marketEnvelopeSchema.parse(value).data.tokenList;
}
export function formatRate(value: string): string {
  return new Decimal(value).times(100).toFixed(4);
}

// UI input is a decimal string. Never round token amounts silently.
export function toBaseUnits(amount: string, decimals: number): string {
  if (!/^\d+(\.\d+)?$/.test(amount) || !Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error('금액과 토큰 소수 자릿수를 확인해 주세요.');
  }
  const [whole, fraction = ''] = amount.split('.');
  if (fraction.length > decimals) throw new Error('토큰의 소수 자릿수를 초과했습니다.');
  const units = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (units > 2n ** 256n - 1n) throw new Error('uint256 금액 범위를 초과했습니다.');
  return units.toString();
}
