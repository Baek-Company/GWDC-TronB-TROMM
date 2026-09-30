import DecimalBase from 'decimal.js';
import { calculateLiquidity, planDays } from './planning';
import { userNeedsSchema, type UserNeeds } from './schemas';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
const EXAMPLE_APY = '0.05';

/** An illustrative USDT calculation, separate from quotes, assessments, and trade previews. */
export type DemoEstimate = {
  mode: 'synthetic';
  chain: 'mainnet';
  asset: 'USDT';
  inputVersion: number;
  startDate: string;
  endDate: string;
  horizonDays: number;
  declaredAmountUsdt: string;
  protectedAmountUsdt: string;
  hypotheticalInvestableUsdt: string;
  projectedGrossInterestUsdt: string;
  roundTripCostUsdt: null;
  projectedNetYieldUsdt: null;
  rateAssumption: {
    kind: 'apy';
    rate: '0.05';
    source: 'fixed_explanatory_example_v1';
    marketObservedAt: null;
  };
  recommendation: 'none';
  walletSized: false;
  executionEligible: false;
};

export function estimateUsdtDemo(rawNeeds: UserNeeds): DemoEstimate {
  const needs = userNeedsSchema.parse(rawNeeds);
  if (needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT' || needs.asset.decimals !== 6) {
    throw new Error('Mainnet USDT 가상 조건만 계산할 수 있습니다.');
  }
  const amounts = [needs.amount, needs.liquidReserve, ...needs.expenses.map(expense => expense.amount)];
  if (amounts.some(amount => new Decimal(amount).decimalPlaces() > 6)) {
    throw new Error('USDT 금액은 소수점 여섯 자리 이내여야 합니다.');
  }
  const horizonDays = planDays(needs);
  const { protectedAmount, investableAmount } = calculateLiquidity(needs);
  const annualFactor = new Decimal(1).plus(EXAMPLE_APY)
    .pow(new Decimal(horizonDays).div(365)).minus(1);
  // USDT has six decimals; round toward zero so the example never overstates interest.
  const projectedGrossInterestUsdt = new Decimal(investableAmount).times(annualFactor)
    .toDecimalPlaces(6, Decimal.ROUND_DOWN).toFixed(6);

  return {
    mode: 'synthetic', chain: 'mainnet', asset: 'USDT',
    inputVersion: needs.inputVersion,
    startDate: needs.startDate, endDate: needs.endDate, horizonDays,
    declaredAmountUsdt: new Decimal(needs.amount).toString(),
    protectedAmountUsdt: protectedAmount,
    hypotheticalInvestableUsdt: investableAmount,
    projectedGrossInterestUsdt,
    roundTripCostUsdt: null, projectedNetYieldUsdt: null,
    rateAssumption: {
      kind: 'apy', rate: EXAMPLE_APY, source: 'fixed_explanatory_example_v1',
      marketObservedAt: null,
    },
    recommendation: 'none', walletSized: false, executionEligible: false,
  };
}
