import { describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { quoteNileHistoricalRedeem, type NileHistoricalRedeemSample } from '../shared/nile-cost-model';
import { readNileRedeemReference, type NileCostRpc } from '../server/data/nile-costs';
import { NILE_JTRX_CANDIDATE } from '../server/data/tron-rpc';

const holder = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const other = 'TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu';
const controller = 'TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t';
const at = new Date('2026-09-30T00:00:00.000Z');
const source = { sourceUrl: 'https://nile.trongrid.io/wallet/triggerconstantcontract',
  chain: 'nile' as const, fetchedAt: at.toISOString(), sourceUpdatedAt: null,
  mode: 'live' as const, accessMethod: 'rpc' as const };
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0');
const constant = (value: bigint | number, energy = 1000) => ({
  result: { result: true }, constant_result: [word(value)], energy_used: energy,
  transaction: { ret: [{}] },
});

function rpcFixture(overrides: { simulate?: object | ((body: Record<string, unknown>) => object);
  estimate?: object | Error; balance?: bigint } = {}) {
  const calls: string[] = [];
  const rpc: NileCostRpc = async (endpoint, body) => {
    calls.push(`${endpoint}:${body.function_selector ?? ''}`);
    if (endpoint === '/wallet/getcontractinfo') {
      if (body.value === controller) return { runtimecode: 'abcd', smart_contract: { contract_address: controller } };
      return { runtimecode: 'aabbcc', smart_contract: { contract_address: NILE_JTRX_CANDIDATE,
        abi: { entrys: ['redeem', 'balanceOf', 'getCash', 'exchangeRateCurrent', 'comptroller'].map(name => ({
          type: 'Function', name,
          ...(name === 'redeem' ? { inputs: [{ type: 'uint256' }] }
            : name === 'balanceOf' ? { inputs: [{ type: 'address' }] } : {}),
        })) } } };
    }
    if (endpoint === '/wallet/getchainparameters') return { chainParameter: [
      { key: 'getEnergyFee', value: 100 }, { key: 'getTransactionFee', value: 1000 },
      { key: 'getMaxFeeLimit', value: 100_000_000 },
    ] };
    if (endpoint === '/wallet/triggerconstantcontract') {
      switch (body.function_selector) {
        case 'exchangeRateCurrent()': return constant(10n ** 18n);
        case 'getCash()': return constant(1_000_000_000);
        case 'comptroller()': return constant(BigInt(`0x${TronWeb.address.toHex(controller).slice(2)}`));
        case 'markets(address)': return constant(1);
        case 'balanceOf(address)': return constant(overrides.balance ?? 1000n);
        case 'redeem(uint256)': return typeof overrides.simulate === 'function'
          ? overrides.simulate(body) : overrides.simulate ?? constant(0);
      }
    }
    if (endpoint === '/wallet/estimateenergy') {
      if (overrides.estimate instanceof Error) throw overrides.estimate;
      return overrides.estimate ?? { result: { result: true }, energy_required: 1200 };
    }
    if (endpoint === '/wallet/triggersmartcontract') return {
      result: { result: true }, transaction: { raw_data_hex: 'ab'.repeat(300) },
    };
    throw new Error(`Unexpected ${endpoint}`);
  };
  return { rpc, calls };
}

describe('Nile read-only future redeem reference', () => {
  it('discovers a separate holder, rechecks current balance and simulates exact amount', async () => {
    const { rpc, calls } = rpcFixture();
    const holders = vi.fn(async () => Response.json({ success: true,
      data: [{ [holder]: '0.00001' }], meta: { at: at.getTime() } }));
    const result = await readNileRedeemReference({ jtrxAmountRaw: '100', excludeWalletAddress: other },
      { rpc, fetchHolders: holders, now: () => at });
    expect(result).toMatchObject({ status: 'ready', basis: 'representative_simulation',
      contractAddress: NILE_JTRX_CANDIDATE, representativeAddress: holder,
      jtrxAmountRaw: '100', representativeBalanceRaw: '1000', expectedUnderlyingSun: '100',
      energyUnits: '1200', bandwidthBytes: '434', estimatedFeeSun: '554000',
      stressFeeSun: '1108000', reason: null });
    expect(calls).toContain('/wallet/triggerconstantcontract:balanceOf(address)');
    expect(calls).toContain('/wallet/triggerconstantcontract:redeem(uint256)');
    expect(holders).toHaveBeenCalledTimes(1);
    expect(calls.every(call => !/broadcast|sign/i.test(call))).toBe(true);
  });

  it('does not use another account as the user wallet quote, or turn failures into zero fees', async () => {
    const { rpc } = rpcFixture({ balance: 99n });
    const insufficient = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder },
      { rpc, now: () => at });
    expect(insufficient).toMatchObject({ status: 'unknown', basis: 'unknown', estimatedFeeSun: null });
    const excluded = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder,
      excludeWalletAddress: holder }, { rpc, now: () => at });
    expect(excluded.status).toBe('unknown');
    const failed = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder },
      { rpc: rpcFixture({ simulate: constant(1) }).rpc, now: () => at });
    expect(failed.status).toBe('unknown');
  });

  it('tries the next indexed holder when the first account cannot redeem', async () => {
    const { rpc } = rpcFixture({ simulate: body => body.owner_address === other
      ? { result: { result: false } } : constant(0) });
    const result = await readNileRedeemReference({ jtrxAmountRaw: '100' }, {
      rpc, now: () => at,
      fetchHolders: async () => Response.json({ success: true,
        data: [{ [other]: '1000' }, { [holder]: '1000' }], meta: { at: at.getTime() } }),
    });
    expect(result).toMatchObject({ status: 'ready', representativeAddress: holder });
  });

  it('uses successful constant Energy only for explicit unsupported estimateenergy', async () => {
    const unsupported = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder },
      { rpc: rpcFixture({ estimate: new Error('this node does not support estimate energy') }).rpc,
        now: () => at });
    expect(unsupported).toMatchObject({ status: 'ready', energyUnits: '1000' });
    const limited = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder },
      { rpc: rpcFixture({ estimate: new Error('HTTP 429') }).rpc, now: () => at });
    expect(limited).toMatchObject({ status: 'unknown', estimatedFeeSun: null });
  });

  it('stops at a strict read budget and rejects a stale holder index', async () => {
    const budget = await readNileRedeemReference({ jtrxAmountRaw: '100', representativeAddress: holder },
      { rpc: rpcFixture().rpc, now: () => at, maxRpcReads: 1 });
    expect(budget).toMatchObject({ status: 'unknown', estimatedFeeSun: null });
    const stale = await readNileRedeemReference({ jtrxAmountRaw: '100' },
      { rpc: rpcFixture().rpc, now: () => at,
        fetchHolders: async () => Response.json({ success: true, data: [{ [holder]: '1000' }],
          meta: { at: at.getTime() - 120_000 } }) });
    expect(stale).toMatchObject({ status: 'unknown', estimatedFeeSun: null });
  });
});

function sample(index: number, energy = 1000): NileHistoricalRedeemSample {
  const blockAt = new Date(at.getTime() - (7 - index) * 60_000).toISOString();
  return {
    chain: 'nile', action: 'redeem(uint256)', contractAddress: NILE_JTRX_CANDIDATE,
    txId: index.toString(16).padStart(64, '0'), jtrxAmountRaw: '100',
    energyUsageTotal: String(energy), signedBytes: '380', actualFeeSun: '500000',
    energyFeeSun: '120000', netFeeSun: '380000',
    blockNumber: String(100 + index), blockAt,
    receiptSource: { ...source, sourceUrl: 'https://nile.trongrid.io/walletsolidity/gettransactioninfobyid' },
    implementationProof: { kind: 'historical_block_code', blockNumber: String(100 + index),
      implementationAddressAtExecution: NILE_JTRX_CANDIDATE,
      implementationAddressNow: NILE_JTRX_CANDIDATE,
      codeHashAtExecution: 'a'.repeat(64), codeHashNow: 'a'.repeat(64),
      source: { ...source, sourceUrl: 'https://archive.example.test/implementation' },
    },
  };
}

describe('Nile historical evidence gate', () => {
  const input = { contractAddress: NILE_JTRX_CANDIDATE, contractCodeHash: 'a'.repeat(64),
    currentImplementationAddress: NILE_JTRX_CANDIDATE,
    currentImplementationCodeHash: 'a'.repeat(64),
    jtrxAmountRaw: '100', energyPriceSun: '100', bandwidthPriceSun: '1000',
    source, validUntil: new Date(at.getTime() + 60_000).toISOString() };

  it('requires five calibration receipts and a later independent holdout', () => {
    expect(quoteNileHistoricalRedeem({ ...input, samples: Array.from({ length: 5 }, (_, i) => sample(i + 1)) }))
      .toMatchObject({ status: 'unknown', estimatedFeeSun: null });
    const ready = quoteNileHistoricalRedeem({ ...input, samples: Array.from({ length: 6 }, (_, i) => sample(i + 1)) });
    expect(ready).toMatchObject({ status: 'ready', basis: 'historical_reference',
      estimatedFeeSun: '480000', stressFeeSun: '960000' });
    if (ready.status === 'ready') expect(ready.referenceTxIds).toHaveLength(6);
  });

  it('rejects a changed historical implementation or failed holdout', () => {
    const samples = Array.from({ length: 6 }, (_, i) => sample(i + 1));
    samples[0] = { ...samples[0], implementationProof: {
      ...samples[0].implementationProof, codeHashAtExecution: 'b'.repeat(64),
    } };
    expect(quoteNileHistoricalRedeem({ ...input, samples }).status).toBe('unknown');
    const badHoldout = Array.from({ length: 6 }, (_, i) => sample(i + 1, i === 5 ? 1001 : 1000));
    expect(quoteNileHistoricalRedeem({ ...input, samples: badHoldout }).status).toBe('unknown');
    const feeMismatch = Array.from({ length: 6 }, (_, i) => sample(i + 1));
    feeMismatch[0] = { ...feeMismatch[0], actualFeeSun: '500001' };
    expect(quoteNileHistoricalRedeem({ ...input, samples: feeMismatch }).status).toBe('unknown');
  });
});
