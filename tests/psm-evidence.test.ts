import { describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import { readMainnetPsmEvidence, MAINNET_JUSDD_ADDRESS, MAINNET_USDD_ADDRESS,
  MAINNET_USDT_ADDRESS, PSM_USDT_ADDRESS, PSM_USDT_GEM_JOIN } from '../server/data/usdd';
import { readMarkets } from '../server/data';
import { callConstant, readContract } from '../server/data/tron-rpc';

vi.mock('../server/data', () => ({ readMarkets: vi.fn() }));
vi.mock('../server/data/tron-rpc', async importOriginal => ({
  ...(await importOriginal<typeof import('../server/data/tron-rpc')>()),
  callConstant: vi.fn(), readContract: vi.fn(),
}));

const vat = 'TH5dhX7o39afSbfDT2e3c9k4itWjNKD4D9';
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (value: string) => TronWeb.address.toHex(value).slice(2).padStart(64, '0');

describe('PSM capacity evidence', () => {
  it('joins contract identity, both debt ceilings and actual GemJoin USDT liquidity', async () => {
    vi.mocked(readMarkets).mockResolvedValue({ markets: [{ symbol: 'jUSDD', address: MAINNET_JUSDD_ADDRESS,
      underlyingAddress: MAINNET_USDD_ADDRESS }] } as Awaited<ReturnType<typeof readMarkets>>);
    vi.mocked(readContract).mockImplementation(async (_chain, address) => ({
      address, hasCode: true, abiFunctions: [], codeHash: null,
    }));
    vi.mocked(callConstant).mockImplementation(async (_chain, address, selector) => {
      if (selector === 'sellEnabled()' || selector === 'buyEnabled()' || selector === 'markets(address)') return word(1n);
      if (selector === 'tin()' || selector === 'tout()') return word(0n);
      if (address === MAINNET_JUSDD_ADDRESS && selector === 'underlying()') return addressWord(MAINNET_USDD_ADDRESS);
      if (address === MAINNET_JUSDD_ADDRESS && selector === 'comptroller()') return addressWord(vat);
      if (address === PSM_USDT_ADDRESS && selector === 'usdd()') return addressWord(MAINNET_USDD_ADDRESS);
      if (address === PSM_USDT_ADDRESS && selector === 'gemJoin()') return addressWord(PSM_USDT_GEM_JOIN);
      if (address === PSM_USDT_GEM_JOIN && selector === 'gem()') return addressWord(MAINNET_USDT_ADDRESS);
      if (selector === 'vat()') return addressWord(vat);
      if (selector === 'ilk()') return word(1n);
      if (address === MAINNET_USDT_ADDRESS && selector === 'decimals()') return word(6n);
      if (address === MAINNET_USDD_ADDRESS && selector === 'decimals()') return word(18n);
      if (selector === 'ilks(bytes32)') return [word(5n * 10n ** 18n), word(10n ** 27n), word(0n),
        word(20n * 10n ** 45n), word(0n)].join('');
      if (selector === 'Line()') return word(12n * 10n ** 45n);
      if (selector === 'debt()') return word(10n * 10n ** 45n);
      if (address === MAINNET_USDT_ADDRESS && selector === 'balanceOf(address)') return word(3_000_000n);
      throw new Error(`Unexpected ${address} ${selector}`);
    });
    const result = await readMainnetPsmEvidence();
    expect(result.status).toBe('ready');
    if (result.status !== 'ready') return;
    expect(result.value.entryCapacity).toBe('2.000000');
    expect(result.value.exitCapacity).toBe('3.000000');
    expect(result.value.tokenCompatible).toBe(true);
    expect(result.value.planReady).toBe(false);
    expect(result.value.missing).toContain('승인·전환·예치·인출 거래의 Energy/Bandwidth 비용 미확인');
  });
});
