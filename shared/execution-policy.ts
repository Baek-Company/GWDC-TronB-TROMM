import type { Plan } from './schemas';

// Nile is a separate, explicitly opted-in technical test. Economic metrics can remain
// unverified, but chain, contract, liquidity, account and deposit fee must be checked
// again by createNileDepositPreview before a wallet signature is requested.
const ECONOMIC_ONLY = new Set(['rate_unavailable', 'cost_unverified', 'fee_reserve_unverified']);

export function canPreviewNileDeposit(plan: Plan): boolean {
  return plan.chain === 'nile' && plan.kind === 'justlend_jtrx'
    && (plan.scenario === '80_20' || plan.scenario === '50_50')
    && plan.quoteVersion !== null && plan.quote !== null
    && plan.quote.source.mode === 'live' && plan.quote.status === 'active'
    && plan.eligibility.status !== 'excluded'
    && plan.eligibility.reasons.every(reason => ECONOMIC_ONLY.has(reason));
}
