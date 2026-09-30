import { TronWeb } from 'tronweb';
import { z } from 'zod';
import { actionPreviewSchema, chainSchema, instantSchema, sourceSchema } from '../../shared/schemas';
import { NILE_CHAIN_ID, NILE_JTRX_CANDIDATE, type NileDepositPreview, type NileWithdrawalPreview } from '../transactions';
import { createTriggerId, type ActionIntent } from './ledger';

type NilePreview = NileDepositPreview | NileWithdrawalPreview;
const unsigned = z.string().regex(/^\d+$/);
const address = z.string().refine(value => TronWeb.isAddress(value));

/** Defaults to observation only when mode is omitted. This is a server rule, not an on-chain limit. */
export const nileAutomationPolicySchema = z.object({
  version: z.number().int().positive(),
  mode: z.enum(['observe_only', 'nile_test']).default('observe_only'),
  paused: z.boolean(),
  expiresAt: instantSchema,
  testWalletAddress: address,
  allowedChains: z.array(chainSchema),
  allowedAccounts: z.array(address),
  allowedContracts: z.array(address),
  allowedMethods: z.array(z.enum(['mint()', 'redeem(uint256)'])),
  maxPerActionSun: unsigned,
  maxDailyDepositSun: unsigned,
  maxCumulativeDepositSun: unsigned,
  maxDailyActions: z.number().int().nonnegative(),
  maxCumulativeActions: z.number().int().nonnegative(),
  maxFeeSun: unsigned,
  protectedReserveSun: unsigned,
  futureFeeReserveSun: unsigned,
  maxQuoteAgeSeconds: z.number().int().positive().max(3600),
  maxObservationAgeSeconds: z.number().int().positive().max(3600),
  maxBlockDrift: z.number().int().nonnegative().max(100),
  schedule: z.object({ anchorAt: instantSchema, everyMinutes: z.number().int().positive().max(1440) }),
});
export type NileAutomationPolicy = z.input<typeof nileAutomationPolicySchema>;

export const nileWalletSnapshotSchema = z.object({
  chain: chainSchema,
  address,
  balanceSun: unsigned,
  positionVersion: z.string().min(1),
  blockNumber: z.number().int().positive(),
  source: sourceSchema,
});
export type NileWalletSnapshot = z.infer<typeof nileWalletSnapshotSchema>;

export const nilePolicyQuoteSchema = z.object({
  planId: z.string().min(1),
  quoteVersion: z.string().min(1),
  chain: chainSchema,
  contractAddress: address,
  marketActive: z.boolean(),
  blockNumber: z.number().int().positive(),
  exitAvailableSun: unsigned.nullable(),
  expectedGrossYieldSun: unsigned.nullable(),
  roundTripCostSun: unsigned.nullable(),
  source: sourceSchema,
});
export type NilePolicyQuote = z.infer<typeof nilePolicyQuoteSchema>;

/** The caller must derive this projection from the durable ledger and verified chain observations. */
export const nilePolicyUsageSchema = z.object({
  source: z.literal('ledger'),
  verified: z.boolean(),
  chain: chainSchema,
  account: address,
  policyVersion: z.number().int().positive(),
  asOf: instantSchema,
  utcDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  confirmedDepositSunToday: unsigned,
  confirmedDepositSunTotal: unsigned,
  pendingDepositSunToday: unsigned,
  pendingDepositSunTotal: unsigned,
  confirmedActionsToday: z.number().int().nonnegative(),
  confirmedActionsTotal: z.number().int().nonnegative(),
  failedActionsToday: z.number().int().nonnegative(),
  failedActionsTotal: z.number().int().nonnegative(),
  pendingActionsToday: z.number().int().nonnegative(),
  pendingActionsTotal: z.number().int().nonnegative(),
  latestSettledAt: instantSchema.nullable(),
  usedCycleIds: z.array(z.string().min(1)),
});
export type NilePolicyUsage = z.infer<typeof nilePolicyUsageSchema>;

export const nilePolicyReasonSchema = z.enum([
  'observe_only', 'invalid_policy', 'invalid_time', 'invalid_wallet', 'invalid_preview', 'invalid_quote', 'invalid_usage',
  'scheduled_expense_unverified',
  'policy_unverified', 'paused', 'expired', 'signer_unavailable', 'dedicated_wallet_unverified',
  'chain_not_allowed', 'account_not_allowed', 'contract_not_allowed', 'method_not_allowed',
  'wallet_preview_mismatch', 'preview_expired', 'preview_not_live', 'wallet_not_live', 'wallet_stale',
  'quote_not_live', 'quote_stale', 'quote_mismatch', 'block_drift', 'market_inactive',
  'ledger_unavailable', 'usage_unverified', 'usage_stale', 'position_not_reobserved',
  'unresolved_intent', 'cycle_already_used', 'schedule_not_due',
  'per_action_cap', 'daily_cap', 'cumulative_cap', 'daily_action_cap', 'cumulative_action_cap',
  'fee_cap', 'protected_funds', 'liquidity_unverified', 'liquidity_insufficient',
  'economics_unverified', 'nonpositive_net',
]);
export type NilePolicyReason = z.infer<typeof nilePolicyReasonSchema>;

export interface NilePolicyDecision {
  status: 'hold' | 'propose';
  reasonCodes: NilePolicyReason[];
  cycleId: string | null;
  triggerId: string | null;
  spendableSun: string | null;
}

function sameAddress(left: string, right: string): boolean {
  return TronWeb.isAddress(left) && TronWeb.isAddress(right) &&
    TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

function freshness(fetchedAt: string, now: number, maxAgeSeconds: number): boolean {
  const age = now - Date.parse(fetchedAt);
  return age >= 0 && age <= maxAgeSeconds * 1000;
}

function scheduleCycle(anchorAt: string, everyMinutes: number, now: number): string | null {
  const anchor = Date.parse(anchorAt);
  if (now < anchor) return null;
  const period = everyMinutes * 60_000;
  return new Date(anchor + Math.floor((now - anchor) / period) * period).toISOString();
}

function hold(...reasonCodes: NilePolicyReason[]): NilePolicyDecision {
  return { status: 'hold', reasonCodes, cycleId: null, triggerId: null, spendableSun: null };
}

function validNilePreview(preview: NilePreview | null): preview is NilePreview {
  const common = actionPreviewSchema.extend({
    feeLimitSun: unsigned,
    state: z.object({
      chain: z.literal('nile'), chainId: z.literal(NILE_CHAIN_ID),
      walletAddress: address, contractAddress: address, source: sourceSchema,
      jtrxDecimals: z.literal(8), walletBalanceSun: unsigned,
      marketCashSun: unsigned, maxFeeSun: unsigned, feeLimitSun: unsigned,
      estimatedFeeSun: unsigned,
    }),
  }).safeParse(preview);
  if (!common.success || !preview || preview.maxFeeBaseUnits === null ||
      preview.method !== 'mint()' && preview.method !== 'redeem(uint256)') return false;
  if (preview.chain !== 'nile' || preview.state.chain !== 'nile' ||
      !sameAddress(preview.walletAddress, preview.state.walletAddress) ||
      !sameAddress(preview.contractAddress, preview.state.contractAddress) ||
      preview.feeLimitSun !== preview.state.feeLimitSun ||
      preview.maxFeeBaseUnits !== preview.state.maxFeeSun ||
      preview.estimatedFeeBaseUnits !== preview.state.estimatedFeeSun ||
      BigInt(preview.amountBaseUnits) <= 0n || BigInt(preview.feeLimitSun) <= 0n ||
      BigInt(preview.estimatedFeeBaseUnits!) > BigInt(preview.maxFeeBaseUnits) ||
      BigInt(preview.feeLimitSun) > BigInt(preview.maxFeeBaseUnits)) return false;
  if (preview.method === 'mint()') {
    return unsigned.safeParse(preview.state.amountSun).success &&
      preview.state.amountSun === preview.amountBaseUnits &&
      preview.asset.symbol === 'TRX' && preview.asset.address === null && preview.asset.decimals === 6 &&
      BigInt(preview.state.walletBalanceSun) >= BigInt(preview.amountBaseUnits) + BigInt(preview.maxFeeBaseUnits) &&
      BigInt(preview.state.marketCashSun) >= BigInt(preview.amountBaseUnits);
  }
  return unsigned.safeParse(preview.expectedUnderlyingSun).success &&
    unsigned.safeParse(preview.state.jtrxAmountRaw).success &&
    unsigned.safeParse(preview.state.expectedUnderlyingSun).success &&
    unsigned.safeParse(preview.state.jtrxBalanceRaw).success &&
    preview.state.jtrxAmountRaw === preview.amountBaseUnits &&
    preview.state.expectedUnderlyingSun === preview.expectedUnderlyingSun &&
    preview.asset.symbol === 'jTRX' && preview.asset.decimals === 8 &&
    preview.asset.address !== null && sameAddress(preview.asset.address, preview.contractAddress) &&
    BigInt(preview.state.jtrxBalanceRaw) >= BigInt(preview.amountBaseUnits) &&
    BigInt(preview.state.marketCashSun) >= BigInt(preview.expectedUnderlyingSun) &&
    BigInt(preview.state.walletBalanceSun) >= BigInt(preview.maxFeeBaseUnits);
}

/**
 * Pure B-1 scheduler policy. It never signs, broadcasts, reserves an intent, or opens a key.
 * Its inputs are snapshots; a caller must re-evaluate against fresh snapshots immediately before
 * using the ledger's atomic reserveIntent and must still pass the Nile approval coordinator checks.
 */
export function evaluateNileAutomation(input: {
  policy: NileAutomationPolicy | null;
  policyAuthorizationVerified: boolean;
  originalWalletAddress: string | null;
  signerAvailable: boolean;
  preview: NilePreview | null;
  wallet: NileWalletSnapshot | null;
  quote: NilePolicyQuote | null;
  usage: NilePolicyUsage | null;
  ledgerAvailable: boolean;
  unresolvedIntents: ActionIntent[] | null;
  scheduledExpenseSun: string | null;
  now: string;
}): NilePolicyDecision {
  const parsedPolicy = nileAutomationPolicySchema.safeParse(input.policy);
  if (!parsedPolicy.success) return input.policy === null ? hold('observe_only') : hold('invalid_policy');
  const policy = parsedPolicy.data;
  if (policy.mode === 'observe_only') return hold('observe_only');

  const walletResult = nileWalletSnapshotSchema.safeParse(input.wallet);
  if (!walletResult.success) return hold('invalid_wallet');
  if (!validNilePreview(input.preview)) return hold('invalid_preview');
  const quoteResult = nilePolicyQuoteSchema.safeParse(input.quote);
  if (!quoteResult.success) return hold('invalid_quote');
  if (!input.ledgerAvailable) return hold('ledger_unavailable');
  const usageResult = nilePolicyUsageSchema.safeParse(input.usage);
  if (!usageResult.success) return hold('invalid_usage');
  const atResult = instantSchema.safeParse(input.now);
  if (!atResult.success) return hold('invalid_time');
  if (input.scheduledExpenseSun === null || !/^\d+$/.test(input.scheduledExpenseSun))
    return hold('scheduled_expense_unverified');

  const wallet = walletResult.data;
  const preview = input.preview;
  const quote = quoteResult.data;
  const usage = usageResult.data;
  const now = Date.parse(input.now);
  const reasonCodes: NilePolicyReason[] = [];
  const add = (condition: boolean, reason: NilePolicyReason) => { if (condition) reasonCodes.push(reason); };

  add(!input.policyAuthorizationVerified, 'policy_unverified');
  add(policy.paused, 'paused');
  add(Date.parse(policy.expiresAt) <= now, 'expired');
  add(!input.signerAvailable, 'signer_unavailable');
  add(input.originalWalletAddress === null || !TronWeb.isAddress(input.originalWalletAddress) ||
    sameAddress(input.originalWalletAddress, policy.testWalletAddress), 'dedicated_wallet_unverified');
  add(!policy.allowedChains.includes('nile') || wallet.chain !== 'nile' || preview.chain !== 'nile' || quote.chain !== 'nile',
    'chain_not_allowed');
  add(!sameAddress(wallet.address, policy.testWalletAddress) ||
    !sameAddress(preview.walletAddress, policy.testWalletAddress) ||
    !policy.allowedAccounts.some(value => sameAddress(value, policy.testWalletAddress)), 'account_not_allowed');
  add(wallet.balanceSun !== preview.state.walletBalanceSun, 'wallet_preview_mismatch');
  add(!sameAddress(preview.contractAddress, NILE_JTRX_CANDIDATE) ||
    !policy.allowedContracts.some(value => sameAddress(value, preview.contractAddress)), 'contract_not_allowed');
  add(!policy.allowedMethods.includes(preview.method), 'method_not_allowed');
  add(Date.parse(preview.expiresAt) <= now, 'preview_expired');
  add(preview.source.mode !== 'live' || preview.source.chain !== 'nile' ||
    preview.state.source.mode !== 'live' || preview.state.chainId !== NILE_CHAIN_ID ||
    !freshness(preview.source.fetchedAt, now, policy.maxQuoteAgeSeconds), 'preview_not_live');
  add(wallet.source.mode !== 'live' || wallet.source.chain !== 'nile' || wallet.source.accessMethod !== 'rpc', 'wallet_not_live');
  add(!freshness(wallet.source.fetchedAt, now, policy.maxObservationAgeSeconds), 'wallet_stale');
  add(quote.source.mode !== 'live' || quote.source.chain !== 'nile' || quote.source.accessMethod !== 'rpc', 'quote_not_live');
  add(!freshness(quote.source.fetchedAt, now, policy.maxQuoteAgeSeconds), 'quote_stale');
  add(quote.planId !== preview.planId || quote.quoteVersion !== preview.quoteVersion ||
    !sameAddress(quote.contractAddress, preview.contractAddress), 'quote_mismatch');
  add(Math.abs(quote.blockNumber - wallet.blockNumber) > policy.maxBlockDrift, 'block_drift');
  add(!quote.marketActive, 'market_inactive');
  add(!usage.verified || usage.source !== 'ledger' || usage.chain !== 'nile' ||
    !sameAddress(usage.account, policy.testWalletAddress) || usage.policyVersion !== policy.version ||
    usage.utcDay !== new Date(now).toISOString().slice(0, 10) ||
    BigInt(usage.confirmedDepositSunToday) > BigInt(usage.confirmedDepositSunTotal) ||
    BigInt(usage.pendingDepositSunToday) > BigInt(usage.pendingDepositSunTotal) ||
    usage.confirmedActionsToday > usage.confirmedActionsTotal ||
    usage.failedActionsToday > usage.failedActionsTotal ||
    usage.pendingActionsToday > usage.pendingActionsTotal, 'usage_unverified');
  add(!freshness(usage.asOf, now, policy.maxObservationAgeSeconds), 'usage_stale');
  add(usage.latestSettledAt !== null && Date.parse(wallet.source.fetchedAt) < Date.parse(usage.latestSettledAt),
    'position_not_reobserved');
  add(input.unresolvedIntents === null || usage.pendingActionsTotal > 0 ||
    input.unresolvedIntents.some(intent => intent.chain === 'nile' &&
      sameAddress(intent.account, policy.testWalletAddress) &&
      ['reserved', 'signed', 'broadcasting', 'pending', 'unknown'].includes(intent.status)), 'unresolved_intent');

  const cycleId = scheduleCycle(policy.schedule.anchorAt, policy.schedule.everyMinutes, now);
  add(cycleId === null, 'schedule_not_due');
  if (cycleId !== null) add(usage.usedCycleIds.includes(cycleId), 'cycle_already_used');

  const amountSun = preview.method === 'mint()' ? BigInt(preview.amountBaseUnits) :
    BigInt(preview.expectedUnderlyingSun);
  const feeSun = preview.maxFeeBaseUnits === null ? null : BigInt(preview.maxFeeBaseUnits);
  add(amountSun > BigInt(policy.maxPerActionSun), 'per_action_cap');
  if (preview.method === 'mint()') {
    add(BigInt(usage.confirmedDepositSunToday) + BigInt(usage.pendingDepositSunToday) + amountSun >
      BigInt(policy.maxDailyDepositSun), 'daily_cap');
    add(BigInt(usage.confirmedDepositSunTotal) + BigInt(usage.pendingDepositSunTotal) + amountSun >
      BigInt(policy.maxCumulativeDepositSun), 'cumulative_cap');
  }
  add(usage.confirmedActionsToday + usage.failedActionsToday + usage.pendingActionsToday + 1 >
    policy.maxDailyActions, 'daily_action_cap');
  add(usage.confirmedActionsTotal + usage.failedActionsTotal + usage.pendingActionsTotal + 1 >
    policy.maxCumulativeActions, 'cumulative_action_cap');
  add(feeSun === null || feeSun > BigInt(policy.maxFeeSun), 'fee_cap');

  const spendable = BigInt(wallet.balanceSun) - BigInt(input.scheduledExpenseSun) -
    BigInt(policy.protectedReserveSun) - BigInt(policy.futureFeeReserveSun) - (feeSun ?? 0n);
  add(spendable < (preview.method === 'mint()' ? amountSun : 0n), 'protected_funds');
  const exitNeedSun = preview.method === 'mint()' ? amountSun : BigInt(preview.expectedUnderlyingSun);
  add(quote.exitAvailableSun === null, 'liquidity_unverified');
  if (quote.exitAvailableSun !== null) add(BigInt(quote.exitAvailableSun) < exitNeedSun, 'liquidity_insufficient');
  if (preview.method === 'mint()') {
    add(quote.expectedGrossYieldSun === null || quote.roundTripCostSun === null, 'economics_unverified');
    if (quote.expectedGrossYieldSun !== null && quote.roundTripCostSun !== null) {
      add(BigInt(quote.expectedGrossYieldSun) - BigInt(quote.roundTripCostSun) <= 0n, 'nonpositive_net');
    }
  }

  const triggerId = cycleId === null ? null : createTriggerId({
    kind: 'schedule', sourceId: `${policy.version}:${policy.testWalletAddress}:${cycleId}`,
    positionVersion: wallet.positionVersion,
  });
  return {
    status: reasonCodes.length === 0 ? 'propose' : 'hold', reasonCodes,
    cycleId, triggerId, spendableSun: (spendable > 0n ? spendable : 0n).toString(),
  };
}
