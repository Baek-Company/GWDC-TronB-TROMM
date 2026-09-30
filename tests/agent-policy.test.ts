import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createActionLedger } from '../server/agent/ledger';
import { buildNileScheduledIntentDraft } from '../server/agent/scheduler';
import {
  evaluateNileAutomation, type NileAutomationPolicy, type NilePolicyQuote,
  type NilePolicyUsage, type NileWalletSnapshot,
} from '../server/agent/policy';
import { NILE_CHAIN_ID, NILE_JTRX_CANDIDATE, type NileDepositPreview } from '../server/transactions';

const account = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const originalWallet = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const now = '2026-09-29T03:00:00.000Z';
const source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile' as const,
  fetchedAt: now, sourceUpdatedAt: null, mode: 'live' as const, accessMethod: 'rpc' as const };

function policy(overrides: Partial<NileAutomationPolicy> = {}): NileAutomationPolicy {
  return {
    version: 1, mode: 'nile_test', paused: false, expiresAt: '2026-09-30T00:00:00.000Z',
    testWalletAddress: account, allowedChains: ['nile'], allowedAccounts: [account],
    allowedContracts: [NILE_JTRX_CANDIDATE], allowedMethods: ['mint()', 'redeem(uint256)'],
    maxPerActionSun: '100000000', maxDailyDepositSun: '200000000',
    maxCumulativeDepositSun: '500000000', maxDailyActions: 2, maxCumulativeActions: 5,
    maxFeeSun: '3000000', protectedReserveSun: '50000000', futureFeeReserveSun: '10000000',
    maxQuoteAgeSeconds: 60, maxObservationAgeSeconds: 60, maxBlockDrift: 3,
    schedule: { anchorAt: '2026-09-29T00:00:00.000Z', everyMinutes: 60 },
    ...overrides,
  };
}

function preview(): NileDepositPreview {
  return {
    id: 'preview-1', planId: 'nile-plan-1', needsVersion: 1, quoteVersion: 'quote-1',
    walletAddress: account, chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
    amountBaseUnits: '80000000', contractAddress: NILE_JTRX_CANDIDATE,
    method: 'mint()', approvalScope: null, estimatedFeeBaseUnits: '1000000',
    maxFeeBaseUnits: '2000000', feeLimitSun: '1500000',
    expiresAt: '2026-09-29T03:00:45.000Z', fingerprint: 'fingerprint-1', risks: [], source,
    state: {
      chain: 'nile', chainId: NILE_CHAIN_ID, walletAddress: account,
      contractAddress: NILE_JTRX_CANDIDATE, comptrollerAddress: originalWallet, jtrxDecimals: 8,
      contractCodeHash: 'abc', walletBalanceSun: '300000000', jtrxBalanceRaw: '0',
      marketCashSun: '1000000000', exchangeRateRaw: '2000000000000000000',
      supplyRatePerBlockRaw: '100', availableEnergy: '0', availableBandwidth: '600',
      estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000',
      estimatedFeeSun: '1000000', feeLimitSun: '1500000', bandwidthFeeUpperBoundSun: '500000',
      maxFeeSun: '2000000', amountSun: '80000000', source,
    },
  };
}

function quote(overrides: Partial<NilePolicyQuote> = {}): NilePolicyQuote {
  return {
    planId: 'nile-plan-1', quoteVersion: 'quote-1', chain: 'nile',
    contractAddress: NILE_JTRX_CANDIDATE, marketActive: true, blockNumber: 100,
    exitAvailableSun: '1000000000', expectedGrossYieldSun: '5000000',
    roundTripCostSun: '1000000', source, ...overrides,
  };
}

function usage(overrides: Partial<NilePolicyUsage> = {}): NilePolicyUsage {
  return {
    source: 'ledger', verified: true, chain: 'nile', account, policyVersion: 1,
    asOf: now, utcDay: '2026-09-29', confirmedDepositSunToday: '0',
    confirmedDepositSunTotal: '0', pendingDepositSunToday: '0', pendingDepositSunTotal: '0',
    confirmedActionsToday: 0, confirmedActionsTotal: 0, failedActionsToday: 0,
    failedActionsTotal: 0, pendingActionsToday: 0, pendingActionsTotal: 0,
    latestSettledAt: null, usedCycleIds: [], ...overrides,
  };
}

function wallet(overrides: Partial<NileWalletSnapshot> = {}): NileWalletSnapshot {
  return { chain: 'nile', address: account, balanceSun: '300000000', positionVersion: 'block-100',
    blockNumber: 100, source, ...overrides };
}

function assessmentInput(overrides: Partial<Parameters<typeof evaluateNileAutomation>[0]> = {}) {
  return {
    policy: policy(), policyAuthorizationVerified: true, originalWalletAddress: originalWallet,
    signerAvailable: true, preview: preview(), wallet: wallet(), quote: quote(), usage: usage(),
    ledgerAvailable: true, unresolvedIntents: [], scheduledExpenseSun: '20000000', now,
    ...overrides,
  };
}

function assess(overrides: Partial<Parameters<typeof evaluateNileAutomation>[0]> = {}) {
  return evaluateNileAutomation(assessmentInput(overrides));
}

describe('B-1 Nile test-wallet policy', () => {
  it('defaults to observation only and proposes only after every verified input passes', () => {
    expect(assess({ policy: null })).toEqual({ status: 'hold', reasonCodes: ['observe_only'],
      cycleId: null, triggerId: null, spendableSun: null });
    expect(assess({ policy: policy({ mode: undefined }) }).reasonCodes).toEqual(['observe_only']);
    const decision = assess();
    expect(decision).toMatchObject({ status: 'propose', reasonCodes: [],
      cycleId: '2026-09-29T03:00:00.000Z', spendableSun: '218000000' });
    expect(decision.triggerId).toMatch(/^[a-f0-9]{64}$/);
    expect(assess().triggerId).toBe(decision.triggerId);
    expect(assess({ wallet: wallet({ positionVersion: 'block-101' }) }).triggerId).not.toBe(decision.triggerId);
  });

  it('fails closed on authorization, paused/expired policy, signer access, and wallet separation', () => {
    expect(assess({ policyAuthorizationVerified: false }).reasonCodes).toEqual(['policy_unverified']);
    expect(assess({ policy: policy({ paused: true }) }).reasonCodes).toEqual(['paused']);
    expect(assess({ policy: policy({ expiresAt: now }) }).reasonCodes).toEqual(['expired']);
    expect(assess({ signerAvailable: false }).reasonCodes).toEqual(['signer_unavailable']);
    expect(assess({ originalWalletAddress: account }).reasonCodes).toEqual(['dedicated_wallet_unverified']);
    expect(assess({ originalWalletAddress: null }).reasonCodes).toEqual(['dedicated_wallet_unverified']);
    expect(assess({ scheduledExpenseSun: null }).reasonCodes).toEqual(['scheduled_expense_unverified']);
    expect(assess({ ledgerAvailable: false, usage: null, unresolvedIntents: null }).reasonCodes)
      .toEqual(['ledger_unavailable']);
    expect(assess({ wallet: wallet({ source: { ...source, fetchedAt: '2026-09-29T02:59:59.000Z' } }),
      usage: usage({ latestSettledAt: now }) }).reasonCodes)
      .toEqual(['position_not_reobserved']);
  });

  it('enforces chain/account/contract/function allowlists', () => {
    expect(assess({ policy: policy({ allowedChains: [] }) }).reasonCodes).toEqual(['chain_not_allowed']);
    expect(assess({ policy: policy({ allowedAccounts: [] }) }).reasonCodes).toEqual(['account_not_allowed']);
    expect(assess({ policy: policy({ allowedContracts: [] }) }).reasonCodes).toEqual(['contract_not_allowed']);
    expect(assess({ policy: policy({ allowedMethods: ['redeem(uint256)'] }) }).reasonCodes).toEqual(['method_not_allowed']);
  });

  it('enforces exact base-unit per-trade, UTC daily, cumulative, count, fee and protected-fund caps', () => {
    expect(assess({ policy: policy({ maxPerActionSun: '79999999' }) }).reasonCodes).toEqual(['per_action_cap']);
    expect(assess({ usage: usage({ confirmedDepositSunToday: '120000001', confirmedDepositSunTotal: '120000001' }) })
      .reasonCodes).toEqual(['daily_cap']);
    expect(assess({ usage: usage({ confirmedDepositSunTotal: '420000001' }) }).reasonCodes).toEqual(['cumulative_cap']);
    expect(assess({ usage: usage({ confirmedActionsToday: 2, confirmedActionsTotal: 2 }) }).reasonCodes)
      .toEqual(['daily_action_cap']);
    expect(assess({ usage: usage({ confirmedActionsTotal: 5 }) }).reasonCodes)
      .toEqual(['cumulative_action_cap']);
    expect(assess({ policy: policy({ maxFeeSun: '1999999' }) }).reasonCodes).toEqual(['fee_cap']);
    expect(assess({ wallet: wallet({ balanceSun: '150000000' }),
      preview: { ...preview(), state: { ...preview().state, walletBalanceSun: '150000000' } } }).reasonCodes)
      .toEqual(['protected_funds']);
  });

  it('rejects stale or non-live evidence, missing economics, weak exit liquidity, and malformed preview', () => {
    expect(assess({ quote: quote({ source: { ...source, fetchedAt: '2026-09-29T02:58:00.000Z' } }) })
      .reasonCodes).toEqual(['quote_stale']);
    expect(assess({ quote: quote({ source: { ...source, mode: 'snapshot' } }) })
      .reasonCodes).toEqual(['quote_not_live']);
    expect(assess({ wallet: wallet({ blockNumber: 105 }) }).reasonCodes).toEqual(['block_drift']);
    expect(assess({ wallet: wallet({ balanceSun: '310000000' }) }).reasonCodes).toEqual(['wallet_preview_mismatch']);
    expect(assess({ quote: quote({ exitAvailableSun: null }) }).reasonCodes).toEqual(['liquidity_unverified']);
    expect(assess({ quote: quote({ exitAvailableSun: '79999999' }) }).reasonCodes).toEqual(['liquidity_insufficient']);
    expect(assess({ quote: quote({ expectedGrossYieldSun: null }) }).reasonCodes).toEqual(['economics_unverified']);
    expect(assess({ quote: quote({ expectedGrossYieldSun: '1000000' }) }).reasonCodes).toEqual(['nonpositive_net']);
    expect(assess({ preview: { ...preview(), state: { ...preview().state, amountSun: '1' } } }).reasonCodes)
      .toEqual(['invalid_preview']);
  });

  it('uses UTC cycles, ledger intent state, and cycle history to prevent same-cycle repeat proposals', () => {
    const first = assess();
    const ledger = createActionLedger({ path: ':memory:', encryptionKey: randomBytes(32), now: () => now });
    try {
      const draft = buildNileScheduledIntentDraft(assessmentInput());
      expect(draft).toMatchObject({ triggerId: first.triggerId, cycleId: first.cycleId,
        receiptBalanceBeforeBaseUnits: '0' });
      ledger.reserveIntent(draft!);
      expect(buildNileScheduledIntentDraft(assessmentInput({ policy: null }))).toBeNull();
      expect(assess({ unresolvedIntents: ledger.listUnresolved() }).reasonCodes).toEqual(['unresolved_intent']);
      expect(assess({ usage: usage({ usedCycleIds: [first.cycleId!] }) }).reasonCodes).toEqual(['cycle_already_used']);
      const nextDay = '2026-09-30T00:00:00.000Z';
      const next = assess({ now: nextDay, policy: policy({ expiresAt: '2026-10-01T00:00:00.000Z' }),
        preview: { ...preview(), expiresAt: '2026-09-30T00:00:45.000Z', source: { ...source, fetchedAt: nextDay },
          state: { ...preview().state, source: { ...source, fetchedAt: nextDay } } },
        wallet: wallet({ source: { ...source, fetchedAt: nextDay } }),
        quote: quote({ source: { ...source, fetchedAt: nextDay } }),
        usage: usage({ asOf: nextDay, utcDay: '2026-09-30', usedCycleIds: [first.cycleId!] }) });
      expect(next.cycleId).toBe(nextDay);
      expect(next.status).toBe('propose');
      expect(next.triggerId).not.toBe(first.triggerId);
    } finally { ledger.close(); }
  });
});
