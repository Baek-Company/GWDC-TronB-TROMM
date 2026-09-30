import { userNeedsSchema, type Token, type UserNeeds } from '../../shared/schemas';
import Decimal from 'decimal.js';
import type { MarketSnapshot } from '../../shared/markets';
import type { Profile } from './session';

export function seoulDate(daysFromToday = 0): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric',
  }).formatToParts(new Date());
  const part = (name: string) => Number(parts.find(value => value.type === name)?.value);
  return new Date(Date.UTC(part('year'), part('month') - 1, part('day') + daysFromToday))
    .toISOString().slice(0, 10);
}

export function profileToNeeds(
  profile: Profile, inputVersion: number, confirmedVersion: number | null,
  marketSnapshot?: MarketSnapshot,
): UserNeeds {
  if (!/^\d+$/.test(profile.horizonDays) || !/^\d+$/.test(profile.expenseDay)
    || profile.extraExpenses.some(expense => !/^\d+$/.test(expense.day))) {
    throw new Error('운용 기간과 지출일을 정수로 입력해 주세요.');
  }
  const token: Token = { symbol: 'USDT',
    address: marketSnapshot?.markets.find(market => market.symbol === 'jUSDT')?.underlyingAddress ?? null,
    decimals: 6 };
  const expenses = [
    { amount: profile.expense, day: profile.expenseDay },
    ...profile.extraExpenses,
  ].filter(expense => !/^\d+(?:\.\d+)?$/.test(expense.amount) || !new Decimal(expense.amount).isZero()).map(expense => ({
    date: seoulDate(Number(expense.day)), amount: expense.amount, asset: token,
  }));
  try {
    return userNeedsSchema.parse({
      chain: 'mainnet', asset: token, amount: profile.holdings, startDate: seoulDate(),
      endDate: seoulDate(Number(profile.horizonDays)), expenses,
      liquidReserve: profile.reserve, riskPreference: profile.risk,
      acceptsUsddRisk: profile.acceptsUsddRisk,
      acceptsDatedExpenseLiquidityRisk: profile.acceptsDatedExpenseLiquidityRisk,
      timezone: 'Asia/Seoul',
      inputVersion, confirmedVersion,
    });
  } catch {
    throw new Error('금액·운용 기간·지출일을 확인해 주세요. 기간과 지출일은 1~3650일입니다.');
  }
}
