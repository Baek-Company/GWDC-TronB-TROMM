import { afterEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { createNileExecutionGateway, NILE_JTRX_CANDIDATE, type NileDepositPreview,
  type NileRpc, type NileWithdrawalPreview } from '../server/transactions';
import { executeNileDeposit as executeNileDepositWithApproval, getNileExecutionRecord, PreviewChangedError,
  refreshNileExecutionRecord as refreshNileExecutionRecordWithApproval } from '../src/features/execution';
import { executeNileWithdrawal as executeNileWithdrawalWithApproval, getNileWithdrawalPreview, getNileWithdrawalRecord, listNileWithdrawalRecords,
  refreshNileWithdrawalRecord as refreshNileWithdrawalRecordWithApproval,
  WithdrawalPreviewChangedError } from '../src/features/execution/withdraw';
import type { NileApprovalGateway, NileApprovalPreview } from '../src/features/execution/approval-api';
import { getWalletState, requireNileWallet, watchWallet } from '../src/wallet';
import { assertNoOtherNilePendingExecution, readTxEvidence, saveTxEvidence,
  withNileExecutionLock } from '../src/features/execution/safety';
import { matchesNileDepositPreview, matchesNileWithdrawalPreview } from '../src/features/execution/preview-context';
import { nileWithdrawalResultSchema } from '../src/features/execution/NileWithdrawalPanel';
import { createTranslator } from '../src/lib/i18n';

const walletAddress = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';
const contractAddress = NILE_JTRX_CANDIDATE;
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const txId = 'a'.repeat(64);
const comptroller = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const nilePlanId = (scenario = '80_20') => `nile:justlend_jtrx:${scenario}:v2:${'c'.repeat(64)}`;

function installLocks() {
  const held = new Set<string>();
  const request = vi.fn(async <T>(name: string, _options: unknown, callback: (lock: { name: string } | null) => Promise<T>) => {
    if (held.has(name)) return callback(null);
    held.add(name);
    try { return await callback({ name }); }
    finally { held.delete(name); }
  });
  vi.stubGlobal('navigator', { locks: { request } });
  return { request };
}

function fakeRpc(overrides: {
  balanceSun?: string; jtrxBalanceRaw?: string; marketCashSun?: string;
  listed?: boolean; runtimeCode?: string; failEstimate?: boolean; redeemErrorCode?: bigint;
  accountAddress?: string; emptyAccount?: boolean;
  storedRateRaw?: bigint; currentRateRaw?: bigint; failCurrentRate?: boolean;
  simulatedEnergy?: number; estimatedEnergy?: number; energyPenalty?: number;
  availableEnergy?: number; availableBandwidth?: number;
  dynamicEnergyMaxFactor?: number; dynamicEnergyEnabled?: boolean;
  redeemContractRet?: string;
} = {}): NileRpc {
  return async (path, body) => {
    if (path === 'wallet/getcontractinfo') {
      if (body.value === comptroller) return { runtimecode: '6001' };
      return {
        runtimecode: overrides.runtimeCode ?? '60016000',
        smart_contract: { contract_address: contractAddress, abi: { entrys: [
          ...['symbol', 'decimals', 'balanceOf', 'exchangeRateStored', 'exchangeRateCurrent', 'getCash', 'comptroller', 'supplyRatePerBlock'].map(name => ({ name, type: 'Function', stateMutability: 'View' })),
          { name: 'redeem', type: 'Function', stateMutability: 'Nonpayable', inputs: [{ type: 'uint256' }] },
          { name: 'mint', type: 'Function', stateMutability: 'Payable', inputs: [] },
        ] } },
      };
    }
    if (path === 'wallet/triggerconstantcontract') {
      const selector = String(body.function_selector);
      if (selector === 'comptroller()') return { result: { result: true }, constant_result: [word(BigInt(`0x${TronWeb.address.toHex(comptroller).slice(2)}`))] };
      if (selector === 'decimals()') return { result: { result: true }, constant_result: [word(8n)] };
      if (selector === 'symbol()') return { result: { result: true }, constant_result: [word(32n) + word(4n) + Buffer.from('jTRX').toString('hex').padEnd(64, '0')] };
      if (selector === 'markets(address)') return { result: { result: true }, constant_result: [word(overrides.listed === false ? 0n : 1n) + word(0n) + word(0n)] };
      if (selector === 'balanceOf(address)') return { result: { result: true }, constant_result: [word(BigInt(overrides.jtrxBalanceRaw ?? '100000000'))] };
      if (selector === 'exchangeRateStored()') return { result: { result: true }, constant_result: [word(overrides.storedRateRaw ?? 2_000_000_000_000_000_000n)] };
      if (selector === 'exchangeRateCurrent()') {
        if (overrides.failCurrentRate) throw new Error('current rate unavailable');
        return { result: { result: true }, constant_result: [word(overrides.currentRateRaw ?? 2_000_000_000_000_000_000n)] };
      }
      if (selector === 'getCash()') return { result: { result: true }, constant_result: [word(BigInt(overrides.marketCashSun ?? '1000000000'))] };
      if (selector === 'supplyRatePerBlock()') return { result: { result: true }, constant_result: [word(100n)] };
      if (selector === 'mint()') return { result: { result: true }, energy_used: 100_000 };
      if (selector === 'redeem(uint256)') return { result: { result: true },
        constant_result: [word(overrides.redeemErrorCode ?? 0n)],
        energy_used: overrides.simulatedEnergy ?? 100_000,
        ...(overrides.energyPenalty === undefined ? {} : { energy_penalty: overrides.energyPenalty }),
        ...(overrides.redeemContractRet === undefined ? {} : { ret: [{ contractRet: overrides.redeemContractRet }] }) };
    }
    if (path === 'wallet/getaccount') return overrides.emptyAccount ? {} :
      { address: overrides.accountAddress ?? walletAddress, balance: overrides.balanceSun ?? '300000000' };
    if (path === 'wallet/getaccountresource') return { EnergyLimit: overrides.availableEnergy ?? 0,
      EnergyUsed: 0, freeNetLimit: overrides.availableBandwidth ?? 600, freeNetUsed: 0 };
    if (path === 'wallet/getchainparameters') return { chainParameter: [
      { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 15_000_000_000 },
      ...(overrides.dynamicEnergyMaxFactor === undefined ? [] :
        [{ key: 'getDynamicEnergyMaxFactor', value: overrides.dynamicEnergyMaxFactor }]),
      ...(overrides.dynamicEnergyEnabled === undefined ? [] :
        [{ key: 'getAllowDynamicEnergy', value: overrides.dynamicEnergyEnabled ? 1 : 0 }]),
    ] };
    if (path === 'wallet/estimateenergy') {
      if (overrides.failEstimate) throw new Error('this node does not support estimate energy');
      return { result: { result: true }, energy_required: overrides.estimatedEnergy ?? 100_000 };
    }
    if (path === 'wallet/triggersmartcontract') return { result: { result: true }, transaction: { raw_data_hex: 'ab'.repeat(250) } };
    throw new Error(`Unexpected RPC ${path}`);
  };
}

function gateway(rpc = fakeRpc(), now = () => Date.parse('2026-09-29T03:00:00.000Z')) {
  return createNileExecutionGateway({ rpc, now });
}

describe('Nile jTRX preflight and receipts', () => {
  it('binds account balances to the requested wallet, accepting matching hex and an empty new account', async () => {
    expect((await gateway(fakeRpc({ accountAddress: TronWeb.address.toHex(walletAddress) }))
      .readNileWalletBalance(walletAddress)).balanceSun).toBe('300000000');
    expect((await gateway(fakeRpc({ emptyAccount: true })).readNileWalletBalance(walletAddress)).balanceSun).toBe('0');
    const wrong = fakeRpc({ accountAddress: contractAddress });
    await expect(gateway(wrong).readNileWalletBalance(walletAddress)).rejects.toThrow('계정 주소');
    await expect(gateway(wrong).createNileDepositPreview({
      planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1', address: walletAddress, amountSun: '80000000',
    })).rejects.toThrow('계정 주소');
    await expect(gateway(wrong).createNileWithdrawalPreview({
      planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1', address: walletAddress, jtrxAmountRaw: '50000000',
    })).rejects.toThrow('계정 주소');
  });

  it('uses the current read-only exchange rate for observations and fails closed when unavailable', async () => {
    const observed = await gateway(fakeRpc({ storedRateRaw: 2_000_000_000_000_000_000n,
      currentRateRaw: 3_000_000_000_000_000_000n })).observeNileJtrxPosition({
      planId: nilePlanId(), address: walletAddress,
    });
    expect(observed.exchangeRateRaw).toBe('3000000000000000000');
    expect(observed.underlyingValueBaseUnits).toBe('300000000');
    await expect(gateway(fakeRpc({ failCurrentRate: true })).observeNileJtrxPosition({
      planId: nilePlanId(), address: walletAddress,
    })).rejects.toThrow('current rate unavailable');
  });

  it('enforces the documented immediate full-exit liquidity policy for a test deposit', async () => {
    const input = { planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, amountSun: '80000000' };
    await expect(gateway(fakeRpc({ marketCashSun: '0' })).createNileDepositPreview(input))
      .rejects.toThrow('시연 정책상');
    await expect(gateway(fakeRpc({ marketCashSun: '79999999' })).createNileDepositPreview(input))
      .rejects.toThrow('출구 유동성');
    await expect(gateway(fakeRpc({ marketCashSun: '80000000' })).createNileDepositPreview(input))
      .resolves.toMatchObject({ chain: 'nile', amountBaseUnits: '80000000' });
  });

  it('keeps a stable fingerprint when only fetched time changes, and updates it on balance changes', async () => {
    let timestamp = Date.parse('2026-09-29T03:00:00.000Z');
    const input = { planId: 'plan-nile-80', needsVersion: 2, quoteVersion: 'quote-1', address: walletAddress, amountSun: '80000000' };
    const first = await gateway(fakeRpc(), () => timestamp).createNileDepositPreview(input);
    timestamp += 1000;
    const second = await gateway(fakeRpc(), () => timestamp).createNileDepositPreview(input);
    const changed = await gateway(fakeRpc({ balanceSun: '300000001' }), () => timestamp).createNileDepositPreview(input);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.id).not.toBe(second.id);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
    expect(first.chain).toBe('nile');
    expect(first.method).toBe('mint()');
    expect(BigInt(first.state.walletBalanceSun)).toBeGreaterThan(BigInt(first.amountBaseUnits) + BigInt(first.maxFeeBaseUnits!));
  });

  it('gives both Nile approval previews 180 seconds for wallet prompts while retaining explicit expiry', async () => {
    const timestamp = Date.parse('2026-09-29T03:00:00.000Z');
    const client = gateway(fakeRpc(), () => timestamp);
    const deposit = await client.createNileDepositPreview({
      planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, amountSun: '80000000',
    });
    const withdrawal = await client.createNileWithdrawalPreview({
      planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, jtrxAmountRaw: '50000000',
    });
    expect(Date.parse(deposit.expiresAt) - timestamp).toBe(180_000);
    expect(Date.parse(withdrawal.expiresAt) - timestamp).toBe(180_000);
  });

  it('blocks absent contract code, unlisted markets, and insufficient fee reserve', async () => {
    const input = { planId: 'p', needsVersion: 1, quoteVersion: 'q', address: walletAddress, amountSun: '80000000' };
    await expect(gateway(fakeRpc({ runtimeCode: '' })).createNileDepositPreview(input)).rejects.toThrow('런타임 코드');
    await expect(gateway(fakeRpc({ listed: false })).createNileDepositPreview(input)).rejects.toThrow('활성 목록');
    await expect(gateway(fakeRpc({ balanceSun: '80000000' })).createNileDepositPreview(input)).rejects.toThrow('수수료 재원');
  });

  it('uses a read-only simulation only when estimateEnergy is explicitly unsupported', async () => {
    const preview = await gateway(fakeRpc({ failEstimate: true })).createNileDepositPreview({
      planId: 'p', needsVersion: 1, quoteVersion: 'q', address: walletAddress, amountSun: '80000000',
    });
    expect(preview.state.estimatedEnergy).toBe('100000');
  });

  it('aborts both Nile previews on an estimateEnergy rate limit or timeout without building a transaction', async () => {
    for (const message of ['Nile RPC HTTP 429', 'The operation was aborted due to timeout']) {
      const base = fakeRpc();
      const rpc = vi.fn<NileRpc>(async (path, body, precise) => {
        if (path === 'wallet/estimateenergy') throw new Error(message);
        return base(path, body, precise);
      });
      await expect(gateway(rpc).createNileDepositPreview({
        planId: 'p', needsVersion: 1, quoteVersion: 'q', address: walletAddress, amountSun: '80000000',
      })).rejects.toThrow(message);
      await expect(gateway(rpc).createNileWithdrawalPreview({
        planId: 'p', needsVersion: 1, quoteVersion: 'q', address: walletAddress, jtrxAmountRaw: '50000000',
      })).rejects.toThrow(message);
      expect(rpc.mock.calls.some(([path]) => path === 'wallet/triggersmartcontract')).toBe(false);
    }
  });

  it('reports only an on-chain fee ceiling for a future withdrawal without jTRX holdings', async () => {
    const bound = await gateway().readNileRedeemCostBound();
    expect(bound.estimatedFeeSun).toBeNull();
    expect(bound.energyFeeLimitSun).toBe('15000000000');
    expect(BigInt(bound.maxFeeSun)).toBeGreaterThan(BigInt(bound.energyFeeLimitSun));
  });

  it('builds a Nile withdrawal preview only for owned jTRX, available cash, and redeem success code', async () => {
    const input = { planId: 'plan-1', needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, jtrxAmountRaw: '50000000' };
    const result = await gateway().createNileWithdrawalPreview(input);
    expect(result.method).toBe('redeem(uint256)');
    expect(result.asset).toEqual({ symbol: 'jTRX', address: contractAddress, decimals: 8 });
    expect(result.expectedUnderlyingSun).toBe('100000000');
    const parsedResponse = nileWithdrawalResultSchema.parse({ status: 'ready', preview: result });
    expect(parsedResponse.status).toBe('ready');
    if (parsedResponse.status === 'ready') {
      // The client must retain the server state used again immediately before signing.
      expect(parsedResponse.preview.state).toEqual(result.state);
    }
    await expect(gateway(fakeRpc({ jtrxBalanceRaw: '49999999' })).createNileWithdrawalPreview(input))
      .rejects.toThrow('jTRX 잔고');
    await expect(gateway(fakeRpc({ marketCashSun: '99999999' })).createNileWithdrawalPreview(input))
      .rejects.toThrow('유동성');
    await expect(gateway(fakeRpc({ balanceSun: '0' })).createNileWithdrawalPreview(input))
      .rejects.toThrow('수수료');
    await expect(gateway(fakeRpc({ redeemErrorCode: 3n })).createNileWithdrawalPreview(input))
      .rejects.toThrow('오류 코드');
    const deferred = await gateway(fakeRpc({ redeemErrorCode: 3n })).probeNileWithdrawal({
      address: walletAddress, jtrxAmountRaw: '50000000',
    });
    expect(deferred.status).toBe('deferred');
    if (deferred.status === 'deferred') expect(deferred.reason).toContain('오류 코드');
  });

  it('separates the wallet resource-adjusted burn from the full-burn and fee-limit budgets', async () => {
    const state = await gateway(fakeRpc({ availableEnergy: 20_000, availableBandwidth: 100 }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' });
    expect(state.estimatedEnergy).toBe('100000');
    expect(state.estimatedBandwidthBytes).toBe('384');
    expect(state.estimatedFeeSun).toBe('8284000');
    expect(state.fullBurnFeeSun).toBe('10384000');
    expect(state.feeLimitSun).toBe('20000000');
    expect(state.maxFeeSun).toBe('20384000');

    const fullyCovered = await gateway(fakeRpc({ availableEnergy: 100_000, availableBandwidth: 600 }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' });
    expect(fullyCovered.estimatedFeeSun).toBe('0');
    expect(fullyCovered.fullBurnFeeSun).toBe('10384000');
    expect(fullyCovered.maxFeeSun).toBe('20384000');
    await expect(gateway(fakeRpc({ availableEnergy: 100_000, availableBandwidth: 600, balanceSun: '0' }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' }))
      .rejects.toThrow('최대 수수료');
  });

  it('compares both successful Energy readings and sizes the cap from the dynamic maximum factor when present', async () => {
    const state = await gateway(fakeRpc({ simulatedEnergy: 100_000, estimatedEnergy: 90_000,
      energyPenalty: 25_000, dynamicEnergyMaxFactor: 30_000 }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' });
    expect(state.estimatedEnergy).toBe('100000');
    expect(state.simulatedEnergy).toBe('100000');
    expect(state.estimateEnergyRequired).toBe('90000');
    expect(state.dynamicEnergyMaxFactorRaw).toBe('30000');
    expect(state.feeLimitBasis).toBe('dynamic_max_factor');
    expect(state.feeLimitSun).toBe('30000000');

    const higherEstimate = await gateway(fakeRpc({ simulatedEnergy: 100_000, estimatedEnergy: 120_000,
      energyPenalty: 25_000, dynamicEnergyMaxFactor: 30_000 }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' });
    expect(higherEstimate.estimatedEnergy).toBe('120000');
    expect(higherEstimate.feeLimitSun).toBe('48000000');

    const disabled = await gateway(fakeRpc({ dynamicEnergyEnabled: false, dynamicEnergyMaxFactor: 30_000 }))
      .readNileWithdrawalState({ address: walletAddress, jtrxAmountRaw: '50000000' });
    expect(disabled.dynamicEnergyMaxFactorRaw).toBe('0');
    expect(disabled.feeLimitBasis).toBe('current_energy_2x');
    expect(disabled.feeLimitSun).toBe('20000000');
  });

  it('does not treat a failed TVM simulation or invalid Energy penalty as a successful redeem', async () => {
    const input = { address: walletAddress, jtrxAmountRaw: '50000000' };
    await expect(gateway(fakeRpc({ redeemContractRet: 'REVERT' })).readNileWithdrawalState(input))
      .rejects.toThrow('TVM 결과');
    await expect(gateway(fakeRpc({ energyPenalty: 100_001 })).readNileWithdrawalState(input))
      .rejects.toThrow('동적 Energy');
  });

  it('keeps withdrawal fingerprint stable across timestamps and changes it on market cash changes', async () => {
    let timestamp = Date.parse('2026-09-29T03:00:00.000Z');
    const input = { planId: 'plan-1', needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, jtrxAmountRaw: '50000000' };
    const first = await gateway(fakeRpc(), () => timestamp).createNileWithdrawalPreview(input);
    timestamp += 1000;
    const second = await gateway(fakeRpc(), () => timestamp).createNileWithdrawalPreview(input);
    const changed = await gateway(fakeRpc({ marketCashSun: '900000000' }), () => timestamp).createNileWithdrawalPreview(input);
    expect(first.fingerprint).toBe(second.fingerprint);
    expect(first.fingerprint).not.toBe(changed.fingerprint);
  });

  it('classifies solidified SUCCESS and failure, while empty or uncertain reads never imply success', async () => {
    const success = gateway(async path => {
      if (path.endsWith('gettransactionbyid')) return { txID: txId };
      return { id: txId, receipt: { result: 'SUCCESS' }, fee: '12345' };
    });
    expect((await success.readSolidifiedNileTransaction(txId)).status).toBe('confirmed');
    const failure = gateway(async path => {
      if (path.endsWith('gettransactionbyid')) return { txID: txId };
      return { id: txId, receipt: { result: 'REVERT' }, fee: '12345' };
    });
    expect((await failure.readSolidifiedNileTransaction(txId)).status).toBe('failed');
    const pending = gateway(async () => ({}));
    expect((await pending.readSolidifiedNileTransaction(txId)).status).toBe('pending');
    const unknown = gateway(async () => { throw new Error('RPC unavailable'); });
    expect((await unknown.readSolidifiedNileTransaction(txId)).status).toBe('unknown');
  });

  it('observes the same Nile wallet and jTRX contract with exact BigInt units', async () => {
    const observation = await gateway().observeNileJtrxPosition({ planId: 'plan-1', address: walletAddress });
    expect(observation.planId).toBe('plan-1');
    expect(observation.walletAddress).toBe(walletAddress);
    expect(observation.receiptBalanceBaseUnits).toBe('100000000');
    expect(observation.underlyingValueBaseUnits).toBe('200000000');
  });
});

function memoryStore() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); },
    get length() { return values.size; }, key: (index: number) => [...values.keys()][index] ?? null };
}

function preview(): NileDepositPreview {
  const fetchedAt = new Date().toISOString();
  return {
    id: 'preview-1', planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1',
    walletAddress, chain: 'nile', asset: { symbol: 'TRX', address: null, decimals: 6 },
    amountBaseUnits: '80000000', contractAddress, method: 'mint()', approvalScope: null,
    estimatedFeeBaseUnits: '1000000', maxFeeBaseUnits: '2000000', feeLimitSun: '1500000',
    expiresAt: new Date(Date.now() + 60_000).toISOString(), fingerprint: 'fingerprint-1', risks: [],
    source: { sourceUrl: 'https://nile.trongrid.io', chain: 'nile', fetchedAt, sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' },
    state: {
      chain: 'nile', chainId: '0xcd8690dc', walletAddress, contractAddress, comptrollerAddress: comptroller, jtrxDecimals: 8,
      contractCodeHash: 'abc', walletBalanceSun: '300000000', jtrxBalanceRaw: '0', marketCashSun: '1000000000',
      exchangeRateRaw: '2000000000000000000', supplyRatePerBlockRaw: '100', availableEnergy: '0', availableBandwidth: '600',
      estimatedEnergy: '10000', energyPriceSun: '100', bandwidthPriceSun: '1000', estimatedFeeSun: '1000000',
      feeLimitSun: '1500000', bandwidthFeeUpperBoundSun: '500000', maxFeeSun: '2000000', amountSun: '80000000',
      source: { sourceUrl: 'https://nile.trongrid.io', chain: 'nile', fetchedAt, sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' },
    },
  };
}

function installWallet(host = 'https://nile.trongrid.io', account = walletAddress) {
  installLocks();
  const transaction = {
    txID: txId, raw_data_hex: 'ab'.repeat(150),
    raw_data: {
      expiration: Date.now() + 60_000, fee_limit: 1_500_000,
      contract: [{ type: 'TriggerSmartContract', parameter: { value: {
        owner_address: TronWeb.address.toHex(account), contract_address: TronWeb.address.toHex(contractAddress),
        call_value: 80_000_000, data: TronWeb.sha3('mint()').slice(2, 10),
      } } }],
    },
  };
  const sign = vi.fn(async () => ({ ...transaction, signature: ['abc'] }));
  const broadcast = vi.fn(async (_signedTransaction: unknown) => ({ result: true }));
  const build = vi.fn(async () => ({ result: { result: true }, transaction }));
  const web = { defaultAddress: { base58: account }, fullNode: { host }, trx: { sign, sendRawTransaction: broadcast },
    transactionBuilder: { triggerSmartContract: build } };
  vi.stubGlobal('window', { tron: { isTronLink: true, tronWeb: web, request: vi.fn() }, localStorage: memoryStore() });
  return { sign, broadcast, build };
}

function installWithdrawalWallet(amountRaw = '50000000', memoBytes = 0) {
  installLocks();
  const selector = TronWeb.sha3('redeem(uint256)').slice(2, 10);
  const transaction = {
    txID: txId, raw_data_hex: 'cd'.repeat(150), raw_data: {
      ref_block_bytes: '0001', ref_block_hash: 'ab'.repeat(8),
      timestamp: Date.now(), expiration: Date.now() + 60_000, fee_limit: 20_000_000,
      ...(memoBytes ? { data: 'ab'.repeat(memoBytes) } : {}),
      contract: [{ type: 'TriggerSmartContract', parameter: { value: {
        owner_address: TronWeb.address.toHex(walletAddress), contract_address: TronWeb.address.toHex(contractAddress),
        call_value: 0, data: selector + BigInt(amountRaw).toString(16).padStart(64, '0'),
      } } }],
    },
  };
  const sign = vi.fn(async () => ({ ...transaction, signature: ['ab'.repeat(65)] }));
  const broadcast = vi.fn(async (_signedTransaction: unknown) => ({ result: true }));
  const build = vi.fn(async () => ({ result: { result: true }, transaction }));
  const web = { defaultAddress: { base58: walletAddress }, fullNode: { host: 'https://nile.trongrid.io' },
    trx: { sign, sendRawTransaction: broadcast }, transactionBuilder: { triggerSmartContract: build } };
  vi.stubGlobal('window', { tron: { isTronLink: true, tronWeb: web, request: vi.fn() }, localStorage: memoryStore() });
  return { sign, broadcast, build };
}

function confirmedDeposit(planId: string): import('../shared/schemas').ExecutionRecord {
  return { id: 'deposit-record', planId, previewId: 'deposit-preview', walletAddress,
    chain: 'nile', txId: 'b'.repeat(64), approvalIntentId: 'a'.repeat(64),
    status: 'confirmed', receipt: { receipt: { result: 'SUCCESS' } },
    actualFeeBaseUnits: '12345', createdAt: new Date().toISOString(), submittedAt: new Date().toISOString(),
    confirmedAt: new Date().toISOString(), error: null };
}

function mockApprovalGateway() {
  const reservations = new Map<string, { previewId: string; walletAddress: string;
    status: string; signed: Record<string, unknown> | null }>();
  const durableBroadcastPayloads: Record<string, unknown>[] = [];
  let authenticatedAddress: string | null = null;
  let nextIntent = 0;
  const requireReservation = (intentId: string, value?: NileApprovalPreview) => {
    const reservation = reservations.get(intentId);
    if (!reservation || value && reservation.previewId !== value.id) throw new Error('Unknown server reservation');
    return reservation;
  };
  const approval = {
    authenticate: vi.fn(async (address: string) => {
      if (!TronWeb.isAddress(address)) throw new Error('Invalid wallet address');
      authenticatedAddress = address;
    }),
    reserve: vi.fn(async (value: NileApprovalPreview, confirmedPreviewId: string) => {
      if (authenticatedAddress !== value.walletAddress || confirmedPreviewId !== value.id) {
        throw new Error('Unconfirmed server reservation');
      }
      const intentId = (++nextIntent).toString(16).padStart(64, '0');
      reservations.set(intentId, { previewId: value.id, walletAddress: value.walletAddress,
        status: 'reserved', signed: null });
      return intentId;
    }),
    acceptSigned: vi.fn(async (intentId: string, value: NileApprovalPreview, signed: unknown) => {
      const reservation = requireReservation(intentId, value);
      if (reservation.status !== 'reserved' || !signed || typeof signed !== 'object' || Array.isArray(signed) ||
          typeof (signed as Record<string, unknown>).txID !== 'string') throw new Error('Invalid signed transaction');
      reservation.signed = signed as Record<string, unknown>;
      reservation.status = 'signed';
      return reservation.signed.txID as string;
    }),
    beginBroadcast: vi.fn(async (intentId: string, value: NileApprovalPreview) => {
      const reservation = requireReservation(intentId, value);
      if (reservation.status !== 'signed' || !reservation.signed) throw new Error('No durable signed transaction');
      reservation.status = 'broadcasting';
      const durablePayload = structuredClone(reservation.signed);
      durableBroadcastPayloads.push(durablePayload);
      return durablePayload;
    }),
    recordBroadcastResult: vi.fn(async (intentId: string, accepted: boolean | null) => {
      const reservation = requireReservation(intentId);
      if (reservation.status !== 'broadcasting') throw new Error('Not broadcasting');
      reservation.status = accepted === true ? 'pending' : 'unknown';
    }),
    cancel: vi.fn(async (intentId: string) => {
      const reservation = requireReservation(intentId);
      if (reservation.status !== 'reserved') throw new Error('Cannot cancel signed transaction');
      reservation.status = 'cancelled';
    }),
    reconcile: vi.fn(async (intentId: string, address: string) => {
      const reservation = requireReservation(intentId);
      if (reservation.walletAddress !== address) throw new Error('Wrong server wallet');
      // The mock server may have observed a solidified receipt before a separate read catches up.
      const status = ['pending', 'unknown'].includes(reservation.status) ? 'confirmed' : reservation.status;
      return { status, txId: reservation.signed?.txID as string | null ?? null };
    }),
  } satisfies NileApprovalGateway;
  return { ...approval, durableBroadcastPayloads };
}

// Every execution in this suite uses a wallet-bound, stateful stand-in for the approval server.
type DepositInput = Parameters<typeof executeNileDepositWithApproval>[0];
type WithdrawalInput = Parameters<typeof executeNileWithdrawalWithApproval>[0];
const approvalByIntent = new Map<string, NileApprovalGateway>();
async function executeNileDeposit(input: Omit<DepositInput, 'approval'> & { approval?: NileApprovalGateway }) {
  const approval = input.approval ?? mockApprovalGateway();
  const record = await executeNileDepositWithApproval({ ...input, approval });
  if (record.approvalIntentId) approvalByIntent.set(record.approvalIntentId, approval);
  return record;
}
async function executeNileWithdrawal(input: Omit<WithdrawalInput, 'approval'> & { approval?: NileApprovalGateway }) {
  const approval = input.approval ?? mockApprovalGateway();
  const record = await executeNileWithdrawalWithApproval({ ...input, approval });
  if (record.approvalIntentId) approvalByIntent.set(record.approvalIntentId, approval);
  return record;
}
function refreshNileExecutionRecord(input: Parameters<typeof refreshNileExecutionRecordWithApproval>[0]) {
  const approval = input.approval ?? approvalByIntent.get(input.record.approvalIntentId ?? '');
  return refreshNileExecutionRecordWithApproval({ ...input, approval });
}
function refreshNileWithdrawalRecord(input: Parameters<typeof refreshNileWithdrawalRecordWithApproval>[0]) {
  const approval = input.approval ?? approvalByIntent.get(input.record.approvalIntentId ?? '');
  return refreshNileWithdrawalRecordWithApproval({ ...input, approval });
}

afterEach(() => { vi.unstubAllGlobals(); approvalByIntent.clear(); });

describe('TronLink one-shot Nile execution', () => {
  it('uses one browser lock for the same Nile wallet across different plans and actions', async () => {
    const { request } = installLocks();
    let entered!: () => void;
    let release!: () => void;
    const atTask = new Promise<void>(resolve => { entered = resolve; });
    const continueTask = new Promise<void>(resolve => { release = resolve; });
    const first = withNileExecutionLock('deposit', nilePlanId(), walletAddress, async () => {
      entered();
      await continueTask;
    });
    await atTask;
    await expect(withNileExecutionLock('withdraw', nilePlanId('50_50'),
      TronWeb.address.toHex(walletAddress), async () => {})).rejects.toThrow('다른 탭');
    expect(request.mock.calls[0][0]).toBe(request.mock.calls[1][0]);
    release();
    await first;
  });

  it('blocks another plan until the original Nile transaction has a final receipt', async () => {
    const { sign } = installWallet();
    const store = memoryStore();
    const value = preview();
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord: () => {}, store };
    const pending = await executeNileDeposit(options);
    const next = { ...value, id: 'preview-other-plan', planId: nilePlanId('50_50') };
    expect(() => assertNoOtherNilePendingExecution(store, 'withdraw', value.planId, walletAddress))
      .toThrow('다른 계획 또는 동작');
    await expect(executeNileDeposit({ ...options, preview: next, confirmPreviewId: next.id,
      refreshPreview: async () => next })).rejects.toThrow('다른 계획');
    expect(sign).toHaveBeenCalledOnce();

    await refreshNileExecutionRecord({ record: pending, store, onRecord: () => {},
      readTransaction: async originalTxId => ({ txId: originalTxId, status: 'confirmed',
        receipt: { receipt: { result: 'SUCCESS' } }, actualFeeSun: '12345', reason: null,
        source: value.source }),
    });
    expect(() => assertNoOtherNilePendingExecution(store, 'deposit', next.planId, walletAddress)).not.toThrow();
  });

  it('finds an older pending plan without an active index and fails closed on corrupt wallet records', () => {
    const store = memoryStore();
    const older = { ...confirmedDeposit(nilePlanId()), status: 'pending', receipt: null, confirmedAt: null };
    store.setItem(`gwdc:nile-execution:v1:${older.planId}:${walletAddress}`, JSON.stringify(older));
    expect(() => assertNoOtherNilePendingExecution(store, 'deposit', nilePlanId('50_50'), walletAddress))
      .toThrow('다른 계획');
    store.setItem(`gwdc:nile-execution:v1:${older.planId}:${walletAddress}`, '{');
    expect(() => assertNoOtherNilePendingExecution(store, 'deposit', nilePlanId('50_50'), walletAddress))
      .toThrow('손상');
  });

  it('uses the final txID evidence when an older per-plan pending record was not updated', () => {
    const store = memoryStore();
    const older = { ...confirmedDeposit(nilePlanId()), status: 'pending' as const, receipt: null, confirmedAt: null };
    store.setItem(`gwdc:nile-execution:v1:${older.planId}:${walletAddress}`, JSON.stringify(older));
    store.setItem(`gwdc:nile-active:v1:${walletAddress}`, JSON.stringify(older));
    saveTxEvidence(store, { ...older, status: 'confirmed', receipt: { receipt: { result: 'SUCCESS' } },
      confirmedAt: new Date().toISOString() });
    expect(() => assertNoOtherNilePendingExecution(store, 'deposit', nilePlanId('50_50'), walletAddress)).not.toThrow();
  });

  it('matches deposit previews against the invested allocation, not total holdings', () => {
    const value = preview();
    const plan = { id: value.planId, needsVersion: value.needsVersion, quoteVersion: value.quoteVersion,
      allocation: { invested: '80', held: '20', protected: '20' } };
    expect(matchesNileDepositPreview(value, plan, 1, walletAddress, 'nile')).toBe(true);
    expect(matchesNileDepositPreview(value, { ...plan, allocation: { ...plan.allocation, invested: '100' } },
      1, walletAddress, 'nile')).toBe(false);
    expect(matchesNileDepositPreview(value, plan, 2, walletAddress, 'nile')).toBe(false);
    expect(matchesNileDepositPreview(value, plan, 1, contractAddress, 'nile')).toBe(false);
  });

  it('fails closed without browser locks and rejects a legacy plan before asking for a signature', async () => {
    const { sign } = installWallet();
    const value = preview();
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord: () => {}, store: memoryStore() };
    vi.stubGlobal('navigator', {});
    await expect(executeNileDeposit(options)).rejects.toThrow('탭 간 거래 잠금');
    installLocks();
    await expect(executeNileDeposit({ ...options, preview: { ...value, planId: 'nile:justlend_jtrx:80_20:v1:q1:a80' } }))
      .rejects.toThrow('이전 형식');
    expect(sign).not.toHaveBeenCalled();
  });

  it('allows only one same-plan signature across concurrent tab requests and preserves tx evidence', async () => {
    const { sign, build } = installWallet();
    const value = preview();
    const store = memoryStore();
    const original = build.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const atBuilder = new Promise<void>(resolve => { entered = resolve; });
    const continueBuilder = new Promise<void>(resolve => { release = resolve; });
    build.mockImplementationOnce(async () => { entered(); await continueBuilder; return original(); });
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord: () => {}, store };
    const first = executeNileDeposit(options);
    await atBuilder;
    await expect(executeNileDeposit(options)).rejects.toThrow('다른 탭');
    release();
    const submitted = await first;
    expect(submitted.txId).toBe(txId);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(readTxEvidence(store, txId)?.id).toBe(submitted.id);
    await expect(executeNileDeposit(options)).rejects.toThrow('원 txID');
  });

  it('keeps pre-sign failures retryable and requires an opening observation before signing when configured', async () => {
    const { sign, build } = installWallet();
    const value = preview();
    const store = memoryStore();
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord: () => {}, store };
    build.mockRejectedValueOnce(new Error('builder unavailable'));
    await expect(executeNileDeposit(options)).rejects.toThrow('builder unavailable');
    expect(getNileExecutionRecord(value.planId, walletAddress, store)).toMatchObject({ status: 'rejected', txId: null });
    expect(sign).not.toHaveBeenCalled();
    await expect(executeNileDeposit({ ...options, readOpeningObservation: async () => {
      throw new Error('opening unavailable');
    }, onOpeningObservation: () => {} })).rejects.toThrow('opening unavailable');
    expect(sign).not.toHaveBeenCalled();
    const opening = await gateway().observeNileJtrxPosition({ planId: value.planId, address: walletAddress });
    const savedOpening = vi.fn();
    const pending = await executeNileDeposit({ ...options,
      readOpeningObservation: async () => opening, onOpeningObservation: savedOpening });
    expect(savedOpening).toHaveBeenCalledOnce();
    expect(pending.status).toBe('pending');
    expect(sign).toHaveBeenCalledOnce();
  });

  it('rechecks the confirmed Nile inputs after transaction building and before TronLink signing', async () => {
    const { sign, build } = installWallet();
    const value = preview();
    let conditionsCurrent = true;
    const original = build.getMockImplementation()!;
    build.mockImplementationOnce(async () => {
      conditionsCurrent = false;
      return original();
    });
    const store = memoryStore();
    await expect(executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {}, store,
      assertBeforeSign: () => {
        if (!conditionsCurrent) throw new Error('Nile 조건 변경');
      },
    })).rejects.toThrow('Nile 조건 변경');
    expect(sign).not.toHaveBeenCalled();
    expect(getNileExecutionRecord(value.planId, walletAddress, store)).toMatchObject({
      status: 'rejected', txId: null,
    });
  });

  it('distinguishes a user-rejected deposit signature from another pre-broadcast wallet error', async () => {
    const { sign, broadcast } = installWallet();
    const value = preview();
    const store = memoryStore();
    const approval = mockApprovalGateway();
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord: () => {}, store, approval };
    sign.mockRejectedValueOnce(Object.assign(new Error('user rejected'), { code: 4001 }));
    expect((await executeNileDeposit(options)).status).toBe('rejected');
    expect(approval.cancel).toHaveBeenCalledOnce();
    expect(approval.beginBroadcast).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    sign.mockRejectedValueOnce(new Error('wallet unavailable'));
    await expect(executeNileDeposit(options)).rejects.toThrow('wallet unavailable');
    expect(approval.cancel).toHaveBeenCalledTimes(2);
    expect(getNileExecutionRecord(value.planId, walletAddress, store)).toMatchObject({
      status: 'rejected', txId: null,
    });
    expect((await executeNileDeposit(options)).status).toBe('pending');
    expect(sign).toHaveBeenCalledTimes(3);
  });

  it('rejects a lookalike RPC host or changed wallet account', () => {
    installWallet('https://nile.trongrid.io.evil.example');
    expect(getWalletState().networkKey).toBe('unknown');
    expect(() => requireNileWallet(walletAddress)).toThrow('Nile');
    installWallet('https://nile.trongrid.io', contractAddress);
    expect(() => requireNileWallet(walletAddress)).toThrow('계정');
  });

  it('invalidates Nile execution immediately when TronLink reports a chain switch', () => {
    installWallet();
    const listeners = new Map<string, (value: unknown) => void>();
    window.tron!.on = (event, listener) => { listeners.set(event, listener); };
    window.tron!.removeListener = (event) => { listeners.delete(event); };
    window.addEventListener = vi.fn();
    window.removeEventListener = vi.fn();
    const stop = watchWallet(() => {});
    listeners.get('chainChanged')?.({ chainId: '0x2b6653dc' });
    expect(() => requireNileWallet(walletAddress)).toThrow('Nile');
    listeners.get('chainChanged')?.({ chainId: '0xcd8690dc' });
    expect(() => requireNileWallet(walletAddress)).not.toThrow();
    stop();
  });

  it('signs once after direct confirmation, preserves the original txID, and blocks duplicate submission', async () => {
    const { sign, broadcast } = installWallet();
    const store = memoryStore();
    const value = preview();
    const approval = mockApprovalGateway();
    const onRecord = vi.fn();
    const options = { preview: value, confirmPreviewId: value.id, refreshPreview: async () => value,
      confirmAction: () => true, onRecord, store, approval };
    const record = await executeNileDeposit(options);
    expect(record.status).toBe('pending');
    expect(record.txId).toBe(txId);
    expect(record).toMatchObject({ action: 'deposit', amountBaseUnits: value.amountBaseUnits,
      contractAddress: value.contractAddress });
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(approval.acceptSigned).toHaveBeenCalledTimes(1);
    expect(approval.beginBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toBe(approval.durableBroadcastPayloads[0]);
    expect(broadcast.mock.calls[0][0]).not.toBe(await sign.mock.results[0].value);
    expect(getNileExecutionRecord(value.planId, value.walletAddress, store)?.txId).toBe(txId);
    await expect(executeNileDeposit(options)).rejects.toThrow('원 txID');
    expect(sign).toHaveBeenCalledTimes(1);
  });

  it('does not ask TronLink to sign when the server cannot reserve a deposit', async () => {
    const { sign, broadcast, build } = installWallet();
    const value = preview();
    const approval = mockApprovalGateway();
    approval.reserve.mockRejectedValueOnce(new Error('server reservation unavailable'));
    await expect(executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {},
      store: memoryStore(), approval })).rejects.toThrow('server reservation unavailable');
    expect(approval.authenticate).toHaveBeenCalledWith(walletAddress);
    expect(approval.reserve).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast a deposit when the signed transaction is not accepted by the server', async () => {
    const { sign, broadcast } = installWallet();
    const value = preview();
    const approval = mockApprovalGateway();
    approval.acceptSigned.mockRejectedValueOnce(new Error('server signed receipt unavailable'));
    const result = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {},
      store: memoryStore(), approval });
    expect(result.status).toBe('unknown');
    expect(result.txId).toBe(txId);
    expect(sign).toHaveBeenCalledOnce();
    expect(approval.beginBroadcast).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('localizes the deposit confirmation while preserving its exact terms and rejection gate', async () => {
    const { sign, broadcast } = installWallet();
    const confirm = vi.fn((_message?: string) => false);
    window.confirm = confirm;
    const value = preview();
    const approval = mockApprovalGateway();
    const result = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, onRecord: () => {}, store: memoryStore(),
      approval, t: createTranslator('en') });
    expect(confirm).toHaveBeenCalledWith(`Deposit 80 TRX into jTRX on Nile?\n` +
      `Contract: ${contractAddress}\nEstimated fee: 1 TRX\nMaximum fee: 2 TRX\nWithdrawal requires market liquidity.`);
    expect(result.status).toBe('rejected');
    expect(approval.reserve).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, onRecord: () => {}, store: memoryStore() });
    expect(confirm.mock.calls[1][0]).toContain('Nile에서 80 TRX를 jTRX에 예치하시겠습니까?');
  });

  it('cancels before signing on changed conditions or a direct user rejection', async () => {
    const { sign } = installWallet();
    const value = preview();
    const changed = { ...value, fingerprint: 'different' };
    await expect(executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => changed, confirmAction: () => true, onRecord: () => {}, store: memoryStore(),
    })).rejects.toBeInstanceOf(PreviewChangedError);
    expect(sign).not.toHaveBeenCalled();
    const rejected = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => false, onRecord: () => {}, store: memoryStore(),
    });
    expect(rejected.status).toBe('rejected');
    expect(sign).not.toHaveBeenCalled();
  });

  it('keeps an ambiguous broadcast unknown and only refreshes the original ID', async () => {
    const { sign, broadcast } = installWallet();
    broadcast.mockRejectedValueOnce(new Error('timeout'));
    const value = preview();
    const store = memoryStore();
    const record = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {}, store,
    });
    expect(record.status).toBe('unknown');
    await expect(executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {}, store,
    })).rejects.toThrow('원 txID');
    expect(sign).toHaveBeenCalledTimes(1);
    const refreshed = await refreshNileExecutionRecord({ record, store, onRecord: () => {},
      readTransaction: async queried => ({ txId: queried, status: 'pending', receipt: null, actualFeeSun: null,
        reason: null, source: value.source }),
    });
    expect(refreshed.record.status).toBe('pending');
    expect(refreshed.record.txId).toBe(txId);
  });

  it('records a solidified receipt and observes only the same Nile plan and position', async () => {
    const { broadcast } = installWallet();
    const value = preview();
    const store = memoryStore();
    broadcast.mockResolvedValueOnce({ result: true });
    const pending = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {}, store,
    });
    const observation = await gateway().observeNileJtrxPosition({ planId: value.planId, address: walletAddress });
    const final = await refreshNileExecutionRecord({ record: pending, store, onRecord: () => {},
      readTransaction: async queried => ({ txId: queried, status: 'confirmed', receipt: { id: queried, receipt: { result: 'SUCCESS' } },
        actualFeeSun: '12345', reason: null, source: value.source }),
      readObservation: async () => observation,
    });
    expect(final.record.status).toBe('confirmed');
    expect(final.record.actualFeeBaseUnits).toBe('12345');
    expect(final.record.confirmationSource).toEqual(value.source);
    expect(final.observation?.positionId).toContain(contractAddress);
    await expect(refreshNileExecutionRecord({ record: final.record, store, onRecord: () => {},
      readTransaction: async queried => ({ txId: queried, status: 'pending', receipt: null, actualFeeSun: null,
        reason: null, source: value.source }),
    })).rejects.toThrow('확정된 거래');
  });

  it('does not let a late pending read erase a confirmed deposit receipt', async () => {
    installWallet();
    const value = preview();
    const store = memoryStore();
    const pending = await executeNileDeposit({ preview: value, confirmPreviewId: value.id,
      refreshPreview: async () => value, confirmAction: () => true, onRecord: () => {}, store });
    let release!: (result: import('../server/transactions').NileTransactionResult) => void;
    const delayed = new Promise<import('../server/transactions').NileTransactionResult>(resolve => { release = resolve; });
    const slow = refreshNileExecutionRecord({ record: pending, store, onRecord: () => {}, readTransaction: () => delayed });
    const receipt = { id: txId, receipt: { result: 'SUCCESS' } };
    const final = await refreshNileExecutionRecord({ record: pending, store, onRecord: () => {},
      readTransaction: async () => ({ txId, status: 'confirmed', receipt, actualFeeSun: '12345',
        reason: null, source: value.source }) });
    release({ txId, status: 'pending', receipt: null, actualFeeSun: null, reason: null, source: value.source });
    expect((await slow).record.status).toBe('confirmed');
    expect(getNileExecutionRecord(value.planId, walletAddress, store)).toMatchObject({
      status: 'confirmed', receipt, actualFeeBaseUnits: '12345',
    });
    expect(readTxEvidence(store, txId)?.confirmedAt).toBe(final.record.confirmedAt);
  });
});

describe('Nile jTRX withdrawal after a confirmed deposit', () => {
  async function withdrawalPreview(overrides: Parameters<typeof fakeRpc>[0] = {}, amountRaw = '50000000') {
    const generated = await gateway(fakeRpc(overrides), () => Date.now()).createNileWithdrawalPreview({
      planId: nilePlanId(), needsVersion: 1, quoteVersion: 'quote-1',
      address: walletAddress, jtrxAmountRaw: amountRaw,
    });
    return generated;
  }

  it('invalidates a withdrawal preview when the amount, plan, or account changes', async () => {
    const value = await withdrawalPreview();
    const plan = { id: value.planId, needsVersion: value.needsVersion, quoteVersion: value.quoteVersion,
      allocation: { invested: '80', held: '20', protected: '20' } };
    const position = { planId: value.planId, walletAddress, chain: 'nile' as const };
    expect(matchesNileWithdrawalPreview(value, plan, walletAddress, 'nile', position, '0.5')).toBe(true);
    expect(matchesNileWithdrawalPreview(value, plan, walletAddress, 'nile', position, '0.25')).toBe(false);
    expect(matchesNileWithdrawalPreview(value, plan, contractAddress, 'nile', position, '0.5')).toBe(false);
    expect(matchesNileWithdrawalPreview(value, { ...plan, id: 'other' }, walletAddress, 'nile', position, '0.5')).toBe(false);
  });

  it('fails closed without browser locks and blocks legacy plans before withdrawal signing', async () => {
    const preview = await withdrawalPreview();
    const { sign } = installWithdrawalWallet();
    const options = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord: () => {}, store: memoryStore() };
    vi.stubGlobal('navigator', {});
    await expect(executeNileWithdrawal(options)).rejects.toThrow('탭 간 거래 잠금');
    installLocks();
    await expect(executeNileWithdrawal({ ...options, preview: { ...preview,
      planId: 'nile:justlend_jtrx:80_20:v1:q1:a80' } })).rejects.toThrow('이전 형식');
    expect(sign).not.toHaveBeenCalled();
  });

  it('allows only one same-position withdrawal signature across concurrent tabs', async () => {
    const preview = await withdrawalPreview();
    const { sign, build } = installWithdrawalWallet();
    const store = memoryStore();
    const original = build.getMockImplementation()!;
    let entered!: () => void;
    let release!: () => void;
    const atBuilder = new Promise<void>(resolve => { entered = resolve; });
    const continueBuilder = new Promise<void>(resolve => { release = resolve; });
    build.mockImplementationOnce(async () => { entered(); await continueBuilder; return original(); });
    const options = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord: () => {}, store };
    const first = executeNileWithdrawal(options);
    await atBuilder;
    await expect(executeNileWithdrawal(options)).rejects.toThrow('다른 탭');
    release();
    expect((await first).txId).toBe(txId);
    expect(sign).toHaveBeenCalledOnce();
    expect(readTxEvidence(store, txId)?.action).toBe('withdraw');
  });

  it('keeps builder and non-4001 signer errors retryable before broadcast', async () => {
    const preview = await withdrawalPreview();
    const { sign, build } = installWithdrawalWallet();
    const store = memoryStore();
    const options = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord: () => {}, store };
    build.mockRejectedValueOnce(new Error('builder unavailable'));
    await expect(executeNileWithdrawal(options)).rejects.toThrow('builder unavailable');
    expect(getNileWithdrawalRecord(preview.planId, walletAddress, store)).toMatchObject({ status: 'rejected', txId: null });
    sign.mockRejectedValueOnce(new Error('wallet unavailable'));
    await expect(executeNileWithdrawal(options)).rejects.toThrow('wallet unavailable');
    expect(getNileWithdrawalRecord(preview.planId, walletAddress, store)).toMatchObject({ status: 'rejected', txId: null });
    expect((await executeNileWithdrawal(options)).status).toBe('pending');
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('allows a user-rejected withdrawal signature to be retried', async () => {
    const preview = await withdrawalPreview();
    const { sign, broadcast } = installWithdrawalWallet();
    const store = memoryStore();
    const approval = mockApprovalGateway();
    const options = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord: () => {}, store, approval };
    sign.mockRejectedValueOnce(Object.assign(new Error('user rejected'), { code: 4001 }));
    expect((await executeNileWithdrawal(options)).status).toBe('rejected');
    expect(approval.cancel).toHaveBeenCalledOnce();
    expect(approval.beginBroadcast).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
    expect((await executeNileWithdrawal(options)).status).toBe('pending');
    expect(sign).toHaveBeenCalledTimes(2);
  });

  it('keeps a confirmed withdrawal and receipt when an older pending read arrives late', async () => {
    const preview = await withdrawalPreview();
    installWithdrawalWallet();
    const store = memoryStore();
    const pending = await executeNileWithdrawal({ preview, depositRecord: confirmedDeposit(preview.planId),
      confirmPreviewId: preview.id, refreshPreview: async () => preview, confirmAction: () => true,
      onRecord: () => {}, store });
    let release!: (result: import('../server/transactions').NileTransactionResult) => void;
    const delayed = new Promise<import('../server/transactions').NileTransactionResult>(resolve => { release = resolve; });
    const slow = refreshNileWithdrawalRecord({ record: pending, preview, store,
      onRecord: () => {}, readTransaction: () => delayed });
    const receipt = { id: txId, receipt: { result: 'SUCCESS' } };
    await refreshNileWithdrawalRecord({ record: pending, preview, store, onRecord: () => {},
      readTransaction: async () => ({ txId, status: 'confirmed', receipt, actualFeeSun: '20000',
        reason: null, source: preview.source }) });
    release({ txId, status: 'pending', receipt: null, actualFeeSun: null,
      reason: null, source: preview.source });
    expect((await slow).record.status).toBe('confirmed');
    expect(getNileWithdrawalRecord(preview.planId, walletAddress, store)).toMatchObject({
      status: 'confirmed', receipt, actualFeeBaseUnits: '20000',
    });
  });

  it('requires the same confirmed deposit and sends exactly one redeem transaction', async () => {
    const generated = await withdrawalPreview();
    const parsed = nileWithdrawalResultSchema.parse({ status: 'ready', preview: generated });
    if (parsed.status !== 'ready') throw new Error('Expected ready Nile withdrawal preview');
    const preview = parsed.preview as typeof generated;
    const { sign, broadcast, build } = installWithdrawalWallet();
    const store = memoryStore();
    const approval = mockApprovalGateway();
    const onRecord = vi.fn();
    const options = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord, store, approval };
    const submitted = await executeNileWithdrawal(options);
    expect(submitted.status).toBe('pending');
    expect(submitted.txId).toBe(txId);
    expect(submitted).toMatchObject({ action: 'withdraw', amountBaseUnits: preview.amountBaseUnits,
      contractAddress: preview.contractAddress });
    expect(build).toHaveBeenCalledWith(contractAddress, 'redeem(uint256)',
      { feeLimit: 20_000_000 }, [{ type: 'uint256', value: '50000000' }], walletAddress);
    expect(sign).toHaveBeenCalledTimes(1);
    expect(broadcast).toHaveBeenCalledTimes(1);
    expect(approval.acceptSigned).toHaveBeenCalledTimes(1);
    expect(approval.beginBroadcast).toHaveBeenCalledTimes(1);
    expect(broadcast.mock.calls[0][0]).toBe(approval.durableBroadcastPayloads[0]);
    expect(broadcast.mock.calls[0][0]).not.toBe(await sign.mock.results[0].value);
    expect(getNileWithdrawalRecord(preview.planId, walletAddress, store)?.txId).toBe(txId);
    expect(getNileWithdrawalPreview(preview.planId, walletAddress, store)?.fingerprint).toBe(preview.fingerprint);
    expect(getNileExecutionRecord(preview.planId, walletAddress, store)).toBeNull();
    await expect(executeNileWithdrawal(options)).rejects.toThrow('원 txID');
    expect(sign).toHaveBeenCalledTimes(1);
    await expect(executeNileWithdrawal({ ...options,
      depositRecord: { ...options.depositRecord, status: 'pending' as const }, store: memoryStore(),
    })).rejects.toThrow('확정 예치');
  });

  it('accepts improved withdrawal cash, fee-wallet balance, and exchange rate across both rechecks', async () => {
    const original = await withdrawalPreview();
    const improvements = [
      ['market cash', await withdrawalPreview({ marketCashSun: '1100000000' })],
      ['fee-wallet balance', await withdrawalPreview({ balanceSun: '400000000' })],
      ['current exchange rate', await withdrawalPreview({ currentRateRaw: 2_100_000_000_000_000_000n })],
      ['more available Energy', await withdrawalPreview({ availableEnergy: 20_000 })],
      ['more unused Bandwidth', await withdrawalPreview({ availableBandwidth: 650 })],
    ] as const;
    for (const [condition, refreshed] of improvements) {
      expect(refreshed.fingerprint, condition).not.toBe(original.fingerprint);
      if (condition === 'current exchange rate') {
        expect(BigInt(refreshed.expectedUnderlyingSun)).toBeGreaterThan(BigInt(original.expectedUnderlyingSun));
      }
      for (const phase of ['before confirmation', 'after confirmation'] as const) {
        const { sign, broadcast } = installWithdrawalWallet();
        const approval = mockApprovalGateway();
        const confirmAction = vi.fn(() => true);
        const refreshPreview = vi.fn(async (): Promise<NileWithdrawalPreview> => refreshed);
        if (phase === 'after confirmation') refreshPreview.mockResolvedValueOnce(original);
        const result = await executeNileWithdrawal({ preview: original,
          depositRecord: confirmedDeposit(original.planId), confirmPreviewId: original.id,
          refreshPreview, confirmAction, onRecord: () => {}, store: memoryStore(), approval });
        expect(result.status, `${condition} ${phase}`).toBe('pending');
        expect(refreshPreview, `${condition} ${phase}`).toHaveBeenCalledTimes(2);
        expect(confirmAction, `${condition} ${phase}`).toHaveBeenCalledOnce();
        expect(confirmAction, `${condition} ${phase}`).toHaveBeenCalledWith(original);
        expect(approval.reserve, `${condition} ${phase}`).toHaveBeenCalledOnce();
        expect(approval.reserve.mock.calls[0]?.[0], `${condition} ${phase}`).toBe(original);
        expect(sign, `${condition} ${phase}`).toHaveBeenCalledOnce();
        expect(broadcast, `${condition} ${phase}`).toHaveBeenCalledOnce();
      }
    }
  });

  it('blocks changed withdrawal amount, contract, fee, underlying, jTRX holdings, or code before reservation or signing', async () => {
    const original = await withdrawalPreview();
    const otherContract = comptroller;
    const changedFeeLimit = (BigInt(original.feeLimitSun) + 1n).toString();
    const changedMaxFee = (BigInt(original.maxFeeBaseUnits!) + 1n).toString();
    const unsafeChanges = [
      ['amount', await withdrawalPreview({}, '60000000')],
      ['contract', { ...original, fingerprint: 'changed-contract', contractAddress: otherContract,
        asset: { ...original.asset, address: otherContract },
        state: { ...original.state, contractAddress: otherContract } }],
      ['fee ceiling', { ...original, fingerprint: 'changed-fee', feeLimitSun: changedFeeLimit,
        maxFeeBaseUnits: changedMaxFee,
        state: { ...original.state, feeLimitSun: changedFeeLimit, maxFeeSun: changedMaxFee } }],
      ['underlying value', await withdrawalPreview({ currentRateRaw: 1_900_000_000_000_000_000n })],
      ['jTRX holdings', { ...original, fingerprint: 'changed-holdings',
        state: { ...original.state, jtrxBalanceRaw: '90000000' } }],
      ['contract code', { ...original, fingerprint: 'changed-code',
        state: { ...original.state, contractCodeHash: 'different-code' } }],
    ] as const;
    for (const [condition, refreshed] of unsafeChanges) {
      for (const phase of ['before confirmation', 'after confirmation'] as const) {
        const { sign, broadcast } = installWithdrawalWallet();
        const approval = mockApprovalGateway();
        const refreshPreview = vi.fn(async (): Promise<NileWithdrawalPreview> => refreshed);
        if (phase === 'after confirmation') refreshPreview.mockResolvedValueOnce(original);
        await expect(executeNileWithdrawal({ preview: original,
          depositRecord: confirmedDeposit(original.planId), confirmPreviewId: original.id,
          refreshPreview, confirmAction: () => true, onRecord: () => {},
          store: memoryStore(), approval }), `${condition} ${phase}`)
          .rejects.toBeInstanceOf(WithdrawalPreviewChangedError);
        expect(refreshPreview, `${condition} ${phase}`)
          .toHaveBeenCalledTimes(phase === 'before confirmation' ? 1 : 2);
        expect(approval.reserve, `${condition} ${phase}`).not.toHaveBeenCalled();
        expect(sign, `${condition} ${phase}`).not.toHaveBeenCalled();
        expect(broadcast, `${condition} ${phase}`).not.toHaveBeenCalled();
      }
    }
  });

  it('blocks withdrawal when refreshed cash or fee balance no longer covers the approved exit', async () => {
    const original = await withdrawalPreview();
    const insufficient = [
      ['market cash', { ...original, fingerprint: 'insufficient-cash',
        state: { ...original.state,
          marketCashSun: (BigInt(original.expectedUnderlyingSun) - 1n).toString() } }],
      ['fee-wallet balance', { ...original, fingerprint: 'insufficient-fee-balance',
        state: { ...original.state,
          walletBalanceSun: (BigInt(original.maxFeeBaseUnits!) - 1n).toString() } }],
    ] as const;
    for (const [condition, refreshed] of insufficient) {
      for (const phase of ['before confirmation', 'after confirmation'] as const) {
        const { sign, broadcast } = installWithdrawalWallet();
        const approval = mockApprovalGateway();
        const refreshPreview = vi.fn(async (): Promise<NileWithdrawalPreview> => refreshed);
        if (phase === 'after confirmation') refreshPreview.mockResolvedValueOnce(original);
        await expect(executeNileWithdrawal({ preview: original,
          depositRecord: confirmedDeposit(original.planId), confirmPreviewId: original.id,
          refreshPreview, confirmAction: () => true, onRecord: () => {},
          store: memoryStore(), approval }), `${condition} ${phase}`).rejects.toThrow('검증에 실패');
        expect(approval.reserve, `${condition} ${phase}`).not.toHaveBeenCalled();
        expect(sign, `${condition} ${phase}`).not.toHaveBeenCalled();
        expect(broadcast, `${condition} ${phase}`).not.toHaveBeenCalled();
      }
    }
  });

  it('does not ask TronLink to sign when the server cannot reserve a withdrawal', async () => {
    const preview = await withdrawalPreview();
    const { sign, broadcast, build } = installWithdrawalWallet();
    const approval = mockApprovalGateway();
    approval.reserve.mockRejectedValueOnce(new Error('server reservation unavailable'));
    await expect(executeNileWithdrawal({ preview, depositRecord: confirmedDeposit(preview.planId),
      confirmPreviewId: preview.id, refreshPreview: async () => preview, confirmAction: () => true,
      onRecord: () => {}, store: memoryStore(), approval })).rejects.toThrow('server reservation unavailable');
    expect(approval.authenticate).toHaveBeenCalledWith(walletAddress);
    expect(approval.reserve).toHaveBeenCalledOnce();
    expect(build).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast a withdrawal when the signed transaction is not accepted by the server', async () => {
    const preview = await withdrawalPreview();
    const { sign, broadcast } = installWithdrawalWallet();
    const approval = mockApprovalGateway();
    approval.acceptSigned.mockRejectedValueOnce(new Error('server signed receipt unavailable'));
    const result = await executeNileWithdrawal({ preview, depositRecord: confirmedDeposit(preview.planId),
      confirmPreviewId: preview.id, refreshPreview: async () => preview, confirmAction: () => true,
      onRecord: () => {}, store: memoryStore(), approval });
    expect(result.status).toBe('unknown');
    expect(result.txId).toBe(txId);
    expect(sign).toHaveBeenCalledOnce();
    expect(approval.beginBroadcast).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('stops a signed withdrawal before server acceptance when its actual Bandwidth size exceeds the preview', async () => {
    const preview = await withdrawalPreview();
    const { sign, broadcast } = installWithdrawalWallet('50000000', 500);
    const approval = mockApprovalGateway();
    await expect(executeNileWithdrawal({ preview,
      depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true,
      onRecord: () => {}, store: memoryStore(), approval })).rejects.toThrow('Bandwidth 예산을 초과');
    expect(sign).toHaveBeenCalledOnce();
    expect(approval.cancel).toHaveBeenCalledOnce();
    expect(approval.acceptSigned).not.toHaveBeenCalled();
    expect(approval.beginBroadcast).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('rejects a live withdrawal preview missing its Bandwidth evidence before signing', async () => {
    const preview = await withdrawalPreview();
    const { sign } = installWithdrawalWallet();
    await expect(executeNileWithdrawal({ preview: { ...preview,
      state: { ...preview.state, estimatedBandwidthBytes: undefined } },
      depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true,
      onRecord: () => {}, store: memoryStore(), approval: mockApprovalGateway() }))
      .rejects.toThrow('Bandwidth 예산 근거');
    expect(sign).not.toHaveBeenCalled();
  });

  it('localizes the redemption confirmation without bypassing rejection', async () => {
    const value = await withdrawalPreview();
    const { sign, broadcast } = installWithdrawalWallet();
    const confirm = vi.fn((_message?: string) => false);
    window.confirm = confirm;
    const approval = mockApprovalGateway();
    const result = await executeNileWithdrawal({ preview: value,
      depositRecord: confirmedDeposit(value.planId), confirmPreviewId: value.id,
      refreshPreview: async () => value, onRecord: () => {}, store: memoryStore(),
      approval, t: createTranslator('en') });
    const message = confirm.mock.calls[0][0];
    expect(message).toContain('Redeem 0.5 Nile jTRX?');
    expect(message).toContain(`Contract: ${contractAddress}`);
    expect(message).toContain('Estimated proceeds: 100 TRX');
    expect(message).toContain('Exchange rates and market liquidity may change.');
    expect(message).not.toMatch(/[가-힣]/);
    expect(result.status).toBe('rejected');
    expect(approval.reserve).not.toHaveBeenCalled();
    expect(sign).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('stops on condition changes or rejection without asking TronLink to sign', async () => {
    const preview = await withdrawalPreview();
    const { sign } = installWithdrawalWallet();
    const base = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      onRecord: () => {}, store: memoryStore() };
    await expect(executeNileWithdrawal({ ...base,
      refreshPreview: async () => ({ ...preview, fingerprint: 'changed' }), confirmAction: () => true,
    })).rejects.toBeInstanceOf(WithdrawalPreviewChangedError);
    expect(sign).not.toHaveBeenCalled();
    const rejected = await executeNileWithdrawal({ ...base,
      refreshPreview: async () => preview, confirmAction: () => false,
    });
    expect(rejected.status).toBe('rejected');
    expect(sign).not.toHaveBeenCalled();
    await expect(executeNileWithdrawal({ ...base,
      preview: { ...preview, expiresAt: new Date(Date.now() - 1).toISOString() },
      refreshPreview: async () => preview, confirmAction: () => true,
    })).rejects.toBeInstanceOf(WithdrawalPreviewChangedError);
    expect(sign).not.toHaveBeenCalled();
  });

  it('holds ambiguous broadcasts and requires a solidified receipt plus a decreased same-position balance', async () => {
    const preview = await withdrawalPreview();
    const { sign, broadcast } = installWithdrawalWallet();
    broadcast.mockRejectedValueOnce(new Error('timeout'));
    const store = memoryStore();
    const base = { preview, depositRecord: confirmedDeposit(preview.planId), confirmPreviewId: preview.id,
      refreshPreview: async () => preview, confirmAction: () => true, onRecord: () => {}, store };
    const unknown = await executeNileWithdrawal(base);
    expect(unknown.status).toBe('unknown');
    await expect(executeNileWithdrawal(base)).rejects.toThrow('원 txID');
    expect(sign).toHaveBeenCalledTimes(1);
    const observed = await gateway(fakeRpc({ jtrxBalanceRaw: '50000000' })).observeNileJtrxPosition({
      planId: preview.planId, address: walletAddress,
    });
    const final = await refreshNileWithdrawalRecord({ record: unknown, preview, store, onRecord: () => {},
      readTransaction: async queried => ({ txId: queried, status: 'confirmed',
        receipt: { id: queried, receipt: { result: 'SUCCESS' } }, actualFeeSun: '20000',
        reason: null, source: preview.source }),
      readObservation: async () => observed,
    });
    expect(final.record.status).toBe('confirmed');
    expect(final.record.actualFeeBaseUnits).toBe('20000');
    expect(final.record.confirmationSource).toEqual(preview.source);
    expect(final.observation?.receiptBalanceBaseUnits).toBe('50000000');
    const followUp = await gateway(fakeRpc({ jtrxBalanceRaw: '50000000' }), () => Date.now())
      .createNileWithdrawalPreview({ planId: preview.planId, needsVersion: preview.needsVersion,
        quoteVersion: preview.quoteVersion, address: walletAddress, jtrxAmountRaw: '25000000' });
    const declinedFollowUp = await executeNileWithdrawal({ ...base, preview: followUp,
      confirmPreviewId: followUp.id, refreshPreview: async () => followUp, confirmAction: () => false });
    expect(declinedFollowUp.status).toBe('rejected');
    expect(listNileWithdrawalRecords(preview.planId, walletAddress, store)).toHaveLength(2);
    await expect(refreshNileWithdrawalRecord({ record: final.record, preview, store, onRecord: () => {},
      readTransaction: async queried => ({ txId: queried, status: 'confirmed',
        receipt: { id: queried, receipt: { result: 'SUCCESS' } }, actualFeeSun: '20000',
        reason: null, source: preview.source }),
      readObservation: async () => ({ ...observed, receiptBalanceBaseUnits: preview.state.jtrxBalanceRaw }),
    })).rejects.toThrow('잔고 감소');
  });
});
