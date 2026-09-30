import DecimalBase from 'decimal.js';
import { isCurrentLiveSource } from './provenance';
import type { Eligibility, EligibilityReason, ProductQuote, UserNeeds, Token } from './schemas';

const Decimal = DecimalBase.clone({ precision: 128 });

export function sameToken(a: Token, b: Token): boolean {
  return a.symbol === b.symbol && a.decimals === b.decimals
    && (a.address === b.address || (a.address === null && b.address === null && a.symbol === 'TRX'));
}

export interface EligibilityOptions {
  now?: Date;
  maxQuoteAgeMs?: number;
  expectedExitDeposit?: string;
  walletBalance?: string | null;
  feeReserve?: string | null;
  requireWalletBalance?: boolean;
  requireFeeReserve?: boolean;
  costsVerified?: boolean;
}

// One result can carry both a hard exclusion and information still needed for execution.
export function evaluateEligibility(needs: UserNeeds, quote: ProductQuote | null, allocation: string, options: EligibilityOptions = {}): Eligibility {
  const hard: EligibilityReason[] = [];
  const conditional: EligibilityReason[] = [];
  const add = (list: EligibilityReason[], reason: EligibilityReason) => { if (!list.includes(reason)) list.push(reason); };
  if (needs.confirmedVersion !== needs.inputVersion) add(hard, 'needs_unconfirmed');
  if (needs.expenses.some(expense => !sameToken(expense.asset, needs.asset))) add(hard, 'expense_asset_mismatch');
  if (quote === null) return { status: 'excluded', reasons: [...hard, 'quote_unavailable'] };

  if (quote.chain !== needs.chain || quote.source.chain !== needs.chain) add(hard, 'chain_mismatch');
  if (!sameToken(needs.asset, quote.inputToken)) add(hard, 'asset_mismatch');
  if (quote.marketAddress === null || (quote.inputToken.address === null && quote.inputToken.symbol !== 'TRX')
    || (quote.depositToken.address === null && quote.depositToken.symbol !== 'TRX')
    || quote.receiptToken === null || quote.receiptToken.address === null) add(conditional, 'token_unverified');
  if (quote.product !== 'psm_jusdd' && !sameToken(quote.inputToken, quote.depositToken)) add(hard, 'asset_mismatch');
  if (quote.status === 'inactive') add(hard, 'market_inactive');
  if (quote.status === 'unknown') add(conditional, 'market_unknown');
  if (quote.baseRate === null) add(conditional, 'rate_unavailable');

  const now = options.now ?? new Date();
  if (!isCurrentLiveSource(quote.source, quote.chain, now, options.maxQuoteAgeMs ?? 15 * 60 * 1000)) {
    add(conditional, 'quote_stale');
  }
  if (quote.source.mode !== 'live') add(conditional, 'non_live_data');

  const invested = new Decimal(allocation);
  if (invested.isZero()) add(hard, 'zero_investable');
  if (quote.liquidity.exitAvailable === null || quote.liquidity.withdrawalDelayDays === null) {
    add(conditional, 'liquidity_unverified');
  } else {
    const needed = new Decimal(options.expectedExitDeposit ?? allocation);
    if (new Decimal(quote.liquidity.exitAvailable).lt(needed)) add(hard, 'liquidity_insufficient');
    const horizonDays = (Date.parse(`${needs.endDate}T00:00:00Z`) - Date.parse(`${needs.startDate}T00:00:00Z`)) / 86_400_000;
    if (quote.liquidity.withdrawalDelayDays > horizonDays) add(hard, 'withdrawal_delay');
  }

  if (quote.product === 'psm_jusdd') {
    if (!needs.acceptsUsddRisk) add(hard, 'usdd_risk_declined');
    if (needs.riskPreference === 'conservative') add(hard, 'risk_preference');
    const conversion = quote.conversion;
    if (conversion === null || !conversion.verified || quote.depositToken.address === null
      || conversion.outputTokenAddress === null || conversion.outputTokenAddress !== quote.depositToken.address
      || conversion.entryRate === null || conversion.exitRate === null) {
      add(hard, 'conversion_unverified');
    } else {
      if (conversion.entryCapacity === null) add(conditional, 'entry_capacity_insufficient');
      else if (new Decimal(conversion.entryCapacity).lt(invested)) add(hard, 'entry_capacity_insufficient');
      if (conversion.exitCapacity === null) add(conditional, 'exit_capacity_insufficient');
      else if (new Decimal(conversion.exitCapacity).lt(options.expectedExitDeposit ?? invested.times(conversion.entryRate))) {
        add(hard, 'exit_capacity_insufficient');
      }
    }
  }
  if (options.costsVerified === false) add(conditional, 'cost_unverified');
  if (options.requireWalletBalance) {
    if (options.walletBalance === undefined || options.walletBalance === null) add(conditional, 'balance_unverified');
    else if (new Decimal(options.walletBalance).lt(needs.amount)) add(hard, 'balance_insufficient');
  }
  if (options.requireFeeReserve) {
    if (options.feeReserve === undefined || options.feeReserve === null) add(conditional, 'fee_reserve_unverified');
    else if (new Decimal(needs.amount).minus(invested).lt(options.feeReserve)) add(hard, 'fee_reserve_insufficient');
  }
  return hard.length ? { status: 'excluded', reasons: [...hard, ...conditional] }
    : conditional.length ? { status: 'conditional', reasons: conditional }
      : { status: 'eligible', reasons: [] };
}
