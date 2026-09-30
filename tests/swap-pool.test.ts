import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { readMainnetUsdtTrxPool, SUNSWAP_V2_ROUTER } from '../server/data/swap-pool';
import { MAINNET_USDD_ADDRESS, MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import { callConstant, readContract } from '../server/data/tron-rpc';

vi.mock('../server/data/tron-rpc', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/tron-rpc')>()),
  callConstant: vi.fn(), readContract: vi.fn(),
}));

const wtrx = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const factory = 'TH5dhX7o39afSbfDT2e3c9k4itWjNKD4D9';
const pair = 'TBXW4hS5KYjjbJXDpnrPf4zhkLwrpUjbyz';
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (value: string) => TronWeb.address.toHex(value).slice(2).padStart(64, '0');

beforeEach(() => {
  vi.mocked(readContract).mockReset().mockImplementation(async (_chain, address) => ({
    address, hasCode: true, abiFunctions: [], codeHash: null,
  }));
  vi.mocked(callConstant).mockReset().mockImplementation(async (_chain, address, selector) => {
    if (address === SUNSWAP_V2_ROUTER && selector === 'WETH()') return addressWord(wtrx);
    if (address === SUNSWAP_V2_ROUTER && selector === 'factory()') return addressWord(factory);
    if (address === factory && selector === 'getPair(address,address)') return addressWord(pair);
    if (address === pair && selector === 'token0()') return addressWord(MAINNET_USDT_ADDRESS);
    if (address === pair && selector === 'token1()') return addressWord(wtrx);
    if (address === pair && selector === 'getReserves()') return `${word(1000000000n)}${word(2000000000n)}${word(0n)}`;
    if (selector === 'decimals()') return word(6n);
    throw new Error(`Unexpected ${address} ${selector}`);
  });
});

describe('SunSwap pool read boundary', () => {
  it('uses verified pair tokens, units and reserves for a read-only snapshot', async () => {
    const result = await readMainnetUsdtTrxPool();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value).toMatchObject({ reserveUsdtRaw: '1000000000', reserveTrxRaw: '2000000000',
      feeAssumptionVerified: false, executionReady: false });
    expect(callConstant).toHaveBeenCalledWith('mainnet', factory, 'getPair(address,address)',
      `${addressWord(MAINNET_USDT_ADDRESS)}${addressWord(wtrx)}`);
  });

  it('rejects a pool whose second token is not wrapped TRX', async () => {
    vi.mocked(callConstant).mockImplementation(async (_chain, address, selector) => {
      if (address === SUNSWAP_V2_ROUTER && selector === 'WETH()') return addressWord(wtrx);
      if (address === SUNSWAP_V2_ROUTER && selector === 'factory()') return addressWord(factory);
      if (address === factory) return addressWord(pair);
      if (selector === 'token0()') return addressWord(MAINNET_USDT_ADDRESS);
      if (selector === 'token1()') return addressWord(MAINNET_USDD_ADDRESS);
      if (selector === 'getReserves()') return `${word(1n)}${word(2n)}${word(0n)}`;
      return word(6n);
    });
    const result = await readMainnetUsdtTrxPool();
    expect(result.status).toBe('unavailable');
  });
});
