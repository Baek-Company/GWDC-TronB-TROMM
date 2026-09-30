import Decimal from 'decimal.js';
import { sameToken } from '../../shared/eligibility';
import { datedAllocationSchema, type DatedAllocation, type UserNeeds } from '../../shared/schemas';

/** A manual profile can be saved as a synthetic review baseline only. */
export function canStoreManualDatedAllocation(needs: UserNeeds, allocation: DatedAllocation): boolean {
  if (!datedAllocationSchema.safeParse(allocation).success
    || needs.confirmedVersion !== needs.inputVersion
    || needs.chain !== 'mainnet' || needs.asset.symbol !== 'USDT'
    || allocation.chain !== needs.chain || !sameToken(allocation.asset, needs.asset)
    || allocation.inputVersion !== needs.inputVersion || allocation.startDate !== needs.startDate
    || allocation.endDate !== needs.endDate || !new Decimal(allocation.amount).eq(needs.amount)
    || !new Decimal(allocation.liquidReserve).eq(needs.liquidReserve)) return false;
  const due = new Map<string, Decimal>();
  for (const expense of needs.expenses.filter(item => item.date <= needs.endDate)) {
    if (!sameToken(expense.asset, needs.asset)) return false;
    due.set(expense.date, (due.get(expense.date) ?? new Decimal(0)).plus(expense.amount));
  }
  const legs = allocation.legs.filter(leg => leg.purpose === 'expense');
  return legs.length === due.size && legs.every(leg => due.get(leg.dueDate)?.eq(leg.amount) === true);
}
