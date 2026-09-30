import { toBaseUnits } from '../../../shared/markets';
import type { Observation, Plan } from '../../../shared/schemas';
import type { NileDepositPreview, NileWithdrawalPreview } from '../../../server/transactions';

type PlanContext = Pick<Plan, 'id' | 'needsVersion' | 'quoteVersion' | 'allocation'>;

export function matchesNileDepositPreview(preview: NileDepositPreview | null, plan: PlanContext | null,
  inputVersion: number, walletAddress: string | null, networkKey: string): boolean {
  if (!preview || !plan || !walletAddress || networkKey !== 'nile') return false;
  try {
    return preview.planId === plan.id && preview.needsVersion === inputVersion &&
      preview.needsVersion === plan.needsVersion && preview.quoteVersion === plan.quoteVersion &&
      preview.walletAddress === walletAddress && preview.amountBaseUnits === toBaseUnits(plan.allocation.invested, 6) &&
      preview.chain === 'nile' && preview.method === 'mint()';
  } catch { return false; }
}

export function matchesNileWithdrawalPreview(preview: NileWithdrawalPreview | null, plan: PlanContext,
  walletAddress: string, networkKey: string, position: Pick<Observation, 'planId' | 'walletAddress' | 'chain'> | null,
  amount: string): boolean {
  if (!preview || !position || networkKey !== 'nile' || position.chain !== 'nile' ||
      position.planId !== plan.id || position.walletAddress !== walletAddress) return false;
  try {
    return preview.planId === plan.id && preview.walletAddress === walletAddress &&
      preview.needsVersion === plan.needsVersion && preview.quoteVersion === plan.quoteVersion &&
      preview.chain === 'nile' && preview.method === 'redeem(uint256)' &&
      preview.amountBaseUnits === toBaseUnits(amount, 8);
  } catch { return false; }
}
