import { describe, expect, it, vi } from 'vitest';
import { productQuoteSchema, type Source } from '../shared/schemas';
import { readJusdtSizing, type JusdtCostDependencies } from '../server/data/jusdt-costs';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS,
  type MainnetJusdtMarketEvidence } from '../server/data/jusdt-market';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';

const wallet = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const at = '2026-09-29T09:00:00.000Z';
const validUntil = '2026-09-29T09:01:00.000Z';
const source: Source = { sourceUrl: 'https://api.trongrid.io/wallet/getnowblock',
  chain: 'mainnet', fetchedAt: at, sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };
const word = (number: bigint) => number.toString(16).padStart(64, '0');
const token = (symbol: string, address: string, decimals: number) => ({ symbol, address, decimals });
const quote = productQuoteSchema.parse({
  id: 'jUSDT', quoteVersion: 'market-v1', product: 'justlend_jusdt', chain: 'mainnet',
  marketAddress: MAINNET_JUSDT_ADDRESS,
  inputToken: token('USDT', MAINNET_USDT_ADDRESS, 6),
  depositToken: token('USDT', MAINNET_USDT_ADDRESS, 6),
  receiptToken: token('jUSDT', MAINNET_JUSDT_ADDRESS, 8),
  baseRate: { kind: 'apr', rate: '0.05' }, reward: null,
  liquidity: { exitAvailable: '1000', withdrawalDelayDays: 0 }, conversion: null,
  costs: [], status: 'active', risks: [], source,
});
const marketEvidence: MainnetJusdtMarketEvidence = {
  quoteVersion: 'market-v1',
  marketAddress: MAINNET_JUSDT_ADDRESS, underlyingAddress: MAINNET_USDT_ADDRESS,
  controllerAddress: MAINNET_UNITROLLER_ADDRESS,
  marketCodeIdentity: 'a'.repeat(64), underlyingCodeIdentity: 'b'.repeat(64),
  cashRaw: '1000000000', borrowsRaw: '0', reservesRaw: '0',
  reserveFactorRaw: '0', supplyRatePerBlockRaw: '1', interestRateModelAddress: wallet,
  rateModel: null, source, directorySource: { ...source, accessMethod: 'rest' },
  observationWindow: { firstBlock: '100', lastBlock: '101', startedAt: at, endedAt: at }, validUntil,
};
const input = { walletAddress: wallet, observedUsdtRaw: '1000000000',
  observedTrxSun: '100000000', needsVersion: 1, marketQuote: quote, marketEvidence,
  legs: [{ bucketKey: '2026-10-01', amountUsdtRaw: '200000000', dueDate: '2026-10-01',
    plannedExitDate: '2026-09-30', earningDays: 1 }],
};

function setup(options: { position?: bigint; allowance?: bigint; stalePrice?: boolean;
  twoOwnerKeys?: boolean; failMint?: boolean; estimatedEnergy?: bigint } = {}) {
  const calls: string[] = [];
  let nextBlock = 100;
  const rpc = vi.fn(async (_chain: string, endpoint: string, body: Record<string, unknown>) => {
    calls.push(endpoint);
    if (endpoint === '/wallet/getchainparameters') return { chainParameter: [
      { key: 'getEnergyFee', value: 420 }, { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 1_000_000_000 },
    ] };
    if (endpoint === '/wallet/getaccount') return { address: wallet, balance: 100_000_000,
      owner_permission: { threshold: 1, keys: options.twoOwnerKeys
        ? [{ address: wallet, weight: 1 }, { address: MAINNET_USDT_ADDRESS, weight: 1 }]
        : [{ address: wallet, weight: 1 }] } };
    if (endpoint === '/wallet/getaccountresource') return { EnergyLimit: 0, EnergyUsed: 0,
      freeNetLimit: 0, freeNetUsed: 0, NetLimit: 0, NetUsed: 0 };
    if (endpoint === '/wallet/triggerconstantcontract') {
      const selector = body.function_selector;
      const contract = body.contract_address;
      const value = selector === 'balanceOf(address)'
        ? contract === MAINNET_USDT_ADDRESS ? 1_000_000_000n : options.position ?? 0n
        : selector === 'allowance(address,address)' ? options.allowance ?? 0n
          : selector === 'approve(address,uint256)' ? 1n
            : options.failMint ? 1n : 0n;
      return { result: { result: true }, transaction: { ret: [{}] },
        constant_result: [word(value)], energy_used: 100 };
    }
    if (endpoint === '/wallet/estimateenergy') {
      if (options.estimatedEnergy === undefined) throw new Error('HTTP 404');
      return { result: { result: true }, energy_required: options.estimatedEnergy.toString() };
    }
    if (endpoint === '/wallet/triggersmartcontract') return { result: { result: true },
      transaction: { raw_data_hex: 'aa'.repeat(100) } };
    throw new Error(`unexpected endpoint ${endpoint}`);
  });
  const fetchPrice = vi.fn(async (url: string | URL | Request) => {
    const address = new URL(String(url)).searchParams.get('tokenAddress')!;
    const lastUpdated = Date.parse(at) - (options.stalePrice ? 360_001 : 0);
    return new Response(JSON.stringify({ code: 0, data: { [address]: { quote: { USD: {
      price: address === MAINNET_USDT_ADDRESS ? '1.00' : '0.30', last_updated: lastUpdated,
    } } } } }), { status: 200 });
  });
  const dependencies: JusdtCostDependencies = {
    now: () => new Date(at),
    block: async () => { calls.push('/wallet/getnowblock'); return {
      blockNumber: String(nextBlock++), blockTime: at, fetchedAt: at,
    }; },
    rpc: rpc as JusdtCostDependencies['rpc'], fetchPrice: fetchPrice as unknown as typeof fetch,
  };
  return { calls, rpc, fetchPrice, dependencies };
}

describe('Mainnet jUSDT wallet-specific read-only sizing', () => {
  it('binds a fresh zero-position wallet, native TRX and USDT prices, and exact action simulations', async () => {
    const { calls, fetchPrice, dependencies } = setup();
    const result = await readJusdtSizing(input, dependencies);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.context).toMatchObject({ observedUsdtRaw: '1000000000',
      availableTrxSun: '100000000', trxUsd: '0.30', usdtUsd: '1.00', allowanceUsdtRaw: '0' });
    expect(result.value.approvalModels).toHaveLength(1);
    expect(result.value.legs[0].mintCost.basis).toBe('account_simulation');
    expect(result.value.redeemModels).toHaveLength(0);
    expect(calls).toContain('/wallet/triggersmartcontract');
    expect(calls.every(call => !/broadcast|sign/i.test(call))).toBe(true);
    expect(fetchPrice.mock.calls.map(([url]) => new URL(String(url)).searchParams.get('tokenAddress')))
      .toContain('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
  });

  it('holds existing jUSDT positions before trying to model independent redemption', async () => {
    const { calls, dependencies } = setup({ position: 1n });
    const result = await readJusdtSizing(input, dependencies);
    expect(result.status).toBe('unknown');
    expect(calls).not.toContain('/wallet/triggersmartcontract');
  });

  it('rejects market evidence bound to a different quote version before any account read', async () => {
    const { calls, dependencies } = setup();
    const result = await readJusdtSizing({ ...input,
      marketEvidence: { ...marketEvidence, quoteVersion: 'different-market' },
    }, dependencies);
    expect(result.status).toBe('unknown');
    expect(calls).toHaveLength(0);
  });

  it('never converts stale prices or a failed mint into a zero-cost executable quote', async () => {
    const { dependencies } = setup({ stalePrice: true, failMint: true });
    const result = await readJusdtSizing(input, dependencies);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.context.trxUsd).toBeNull();
    expect(result.value.context.usdtUsd).toBeNull();
    expect(result.value.legs[0].mintCost.basis).toBe('unknown');
    expect(result.value.legs[0].mintCost.estimatedFeeSun).toBeNull();
  });

  it('does not accept a SUN price keyed to a different token address', async () => {
    const { dependencies } = setup();
    dependencies.fetchPrice = vi.fn(async () => new Response(JSON.stringify({ code: 0,
      data: { [MAINNET_USDT_ADDRESS]: { quote: { USD: {
        price: '1.00', last_updated: Date.parse(at),
      } } } },
    }), { status: 200 })) as unknown as typeof fetch;
    const result = await readJusdtSizing(input, dependencies);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.context.trxUsd).toBeNull();
    expect(result.value.context.usdtUsd).toBe('1.00');
  });

  it('does not invent signed bandwidth bytes for a multi-key owner permission', async () => {
    const { calls, dependencies } = setup({ twoOwnerKeys: true });
    const result = await readJusdtSizing(input, dependencies);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.legs[0].mintCost.basis).toBe('unknown');
    expect(calls).not.toContain('/wallet/triggersmartcontract');
  });

  it('uses the greater supported Energy estimate and limits this pass to 15 RPC reads', async () => {
    const { calls, dependencies } = setup({ estimatedEnergy: 250n });
    const many = { ...input, legs: Array.from({ length: 8 }, (_, index) => ({
      bucketKey: `bucket-${index}`, amountUsdtRaw: String(100_000_000 + index),
      dueDate: '2026-10-01', plannedExitDate: '2026-09-30', earningDays: 1,
    })) };
    const result = await readJusdtSizing(many, dependencies);
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(calls.length).toBeLessThanOrEqual(15);
    expect(result.value.approvalModels[0].samples[0].energyUnits).toBe('250');
    expect(result.value.legs.filter(leg => leg.mintCost.basis === 'unknown').length).toBeGreaterThan(0);
    expect(result.value.legs).toHaveLength(8);
  });
});
