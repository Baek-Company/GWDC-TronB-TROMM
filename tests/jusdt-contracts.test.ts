import { describe, expect, it } from 'vitest';
import {
  costEvidenceSchema, jusdtBundleQuoteSchema, jusdtLegQuoteSchema, jusdtQuoteContextSchema,
  jusdtRateModelSchema, jusdtSizingInputsSchema, userNeedsSchema,
} from '../shared/schemas';

const wallet = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const usdt = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const jusdt = 'TXJgMdjVX5dKiQaUi9QobwNxtSQaFqccvd';
const at = '2026-09-29T03:00:00.000Z';
const later = '2026-09-29T03:02:00.000Z';
const source = { sourceUrl: 'https://api.trongrid.io/wallet/triggerconstantcontract',
  chain: 'mainnet' as const, fetchedAt: at, sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };
const window = { firstBlock: '100', lastBlock: '101', startedAt: at, endedAt: at };

function context() {
  return { version: 'context-v1', chain: 'mainnet', walletAddress: wallet, usdtAddress: usdt,
    jusdtAddress: jusdt, marketQuoteVersion: 'market-v1', needsVersion: 2,
    energyPriceSun: '100', bandwidthPriceSun: '1000', maxFeeLimitSun: '100000000',
    trxUsd: '0.3', usdtUsd: '1', availableEnergy: '0', availableBandwidth: '0',
    availableTrxSun: '100000000', observedUsdtRaw: '1000000000', allowanceUsdtRaw: '0',
    sources: [source], observationWindow: window, validUntil: later };
}

function mintCost() {
  return { action: 'mint', basis: 'reference_model', contextVersion: 'context-v1',
    contractAddress: jusdt, selector: 'mint(uint256)', amountRaw: '200000000',
    energyUnits: '50000', bandwidthBytes: '300', estimatedFeeSun: '5300000',
    feeLimitSun: '10000000', bandwidthBudgetSun: '600000', sources: [source],
    referenceTxIds: ['confirmed-tx-1'] };
}

function approveCost() {
  return { ...mintCost(), action: 'approve', contractAddress: usdt,
    selector: 'approve(address,uint256)', referenceTxIds: ['confirmed-approve-1'] };
}

function redeemCost() {
  return { ...mintCost(), action: 'redeem_underlying', selector: 'redeemUnderlying(uint256)',
    amountRaw: '200100000', referenceTxIds: ['confirmed-redeem-1'] };
}

function leg() {
  return { chain: 'mainnet', walletAddress: wallet, needsVersion: 2, bucketKey: 'expense:2026-10-06:0',
    amountUsdtRaw: '200000000', dueDate: '2026-10-06', plannedExitDate: '2026-10-05',
    earningDays: 6, contextVersion: 'context-v1', marketQuoteVersion: 'market-v1',
    mintCost: mintCost(), redeemModelVersion: 'redeem-v1', status: 'scenario_only',
    validUntil: later, quoteVersion: 'leg-v1' };
}

function rateModel() {
  return { kind: 'whitepaper', modelAddress: jusdt, codeIdentity: 'code-v1',
    baseRatePerBlockRaw: '0', multiplierPerBlockRaw: '1000000000',
    jumpMultiplierPerBlockRaw: null, kinkRaw: null, reserveFactorRaw: '100000000000000000',
    cashRaw: '100000000000', borrowsRaw: '10000000000', reservesRaw: '0',
    currentSupplyRatePerBlockRaw: '7000000', source, validUntil: later };
}

describe('Mainnet jUSDT quote contracts', () => {
  it('defaults legacy needs to no scheduled-expense liquidity risk consent', () => {
    const needs = userNeedsSchema.parse({ chain: 'mainnet', asset: { symbol: 'USDT', address: usdt, decimals: 6 },
      amount: '1000', startDate: '2026-09-29', endDate: '2026-10-29', expenses: [],
      liquidReserve: '0', riskPreference: 'balanced', acceptsUsddRisk: false,
      timezone: 'Asia/Seoul', inputVersion: 2, confirmedVersion: 2 });
    expect(needs.acceptsDatedExpenseLiquidityRisk).toBe(false);
  });

  it('rejects invalid addresses, reversed observations and unpriced unknown actions', () => {
    expect(jusdtQuoteContextSchema.safeParse(context()).success).toBe(true);
    expect(jusdtQuoteContextSchema.safeParse({ ...context(), walletAddress: 'TINVALID' }).success).toBe(false);
    expect(jusdtQuoteContextSchema.safeParse({ ...context(),
      observationWindow: { ...window, firstBlock: '102' } }).success).toBe(false);
    expect(costEvidenceSchema.safeParse({ ...mintCost(), basis: 'unknown', referenceTxIds: [] }).success).toBe(false);
    expect(costEvidenceSchema.safeParse({ ...mintCost(), basis: 'reference_model', referenceTxIds: [] }).success).toBe(false);
  });

  it('ties each sized leg to its exact wallet, amount and context', () => {
    expect(jusdtLegQuoteSchema.safeParse(leg()).success).toBe(true);
    expect(jusdtLegQuoteSchema.safeParse({ ...leg(), amountUsdtRaw: '201000000' }).success).toBe(false);
    expect(jusdtLegQuoteSchema.safeParse({ ...leg(), plannedExitDate: '2026-10-07' }).success).toBe(false);
    expect(jusdtSizingInputsSchema.safeParse({ context: context(), legs: [leg()],
      approvalModels: [], redeemModels: [], rateModel: rateModel() }).success).toBe(true);
    expect(jusdtSizingInputsSchema.safeParse({ context: context(), legs: [{ ...leg(), walletAddress: usdt }],
      approvalModels: [], redeemModels: [], rateModel: rateModel() }).success).toBe(false);
    expect(jusdtSizingInputsSchema.safeParse({ context: context(), legs: [leg(), leg()],
      approvalModels: [], redeemModels: [], rateModel: rateModel() }).success).toBe(false);
  });

  it('rejects an incomplete conditional bundle or unsupported rate curve', () => {
    expect(jusdtRateModelSchema.safeParse(rateModel()).success).toBe(true);
    expect(jusdtRateModelSchema.safeParse({ ...rateModel(), kind: 'jump' }).success).toBe(false);
    const bundle = { chain: 'mainnet', walletAddress: wallet, needsVersion: 2,
      contextVersion: 'context-v1', inputTokenAddress: usdt, marketAddress: jusdt,
      selectedLegVersions: ['leg-v1'], approvalActions: 'approve',
      actions: [{ bucketKey: null, cost: approveCost() },
        { bucketKey: 'expense:2026-10-06:0', cost: mintCost() },
        { bucketKey: 'expense:2026-10-06:0', cost: redeemCost() }],
      allowanceUsdtRaw: '0', totalDepositUsdtRaw: '200000000', scenarioRateApr: '0.03',
      expectedCostUsdt: '0.1', stressCostUsdt: '0.2', requiredFeeTrxSun: '10000000',
      availableFeeTrxSun: '100000000', scenarioNetYieldUsdt: '0.1', stressNetYieldUsdt: '0.01',
      observationWindow: window, status: 'scenario_only', validUntil: later, quoteVersion: 'bundle-v1' };
    expect(jusdtBundleQuoteSchema.safeParse(bundle).success).toBe(true);
    expect(jusdtBundleQuoteSchema.safeParse({ ...bundle, actions: [{ bucketKey: null,
      cost: { ...mintCost(), basis: 'unknown', energyUnits: null, bandwidthBytes: null,
        estimatedFeeSun: null, feeLimitSun: null, bandwidthBudgetSun: null, referenceTxIds: [] } }] }).success).toBe(false);
  });
});
