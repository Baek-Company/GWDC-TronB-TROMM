import { describe, expect, it } from 'vitest';
import { TronWeb } from 'tronweb';
import { createNilePsmReadGateway, NILE_PSM_CONTRACTS, quoteNilePsmBuy,
  quoteNilePsmSell, type NilePsmReader } from '../server/nile-psm';
import { encodeAddress } from '../server/data/tron-rpc';

const C = NILE_PSM_CONTRACTS;
const WALLET = 'TBdTYFvC3CYo2hM1qGgj4aTVU6ifhZWfdu';
const VAT = 'TDAv6rniTrqjYqA64VVpnJxFfgmveN2LUA';
const ILK = '50'.repeat(32);
const WAD = 10n ** 18n;
const RAD = 10n ** 45n;
const word = (value: bigint) => value.toString(16).padStart(64, '0');
const addressWord = (address: string) => encodeAddress(address);

function fixture(overrides: Record<string, string> = {}): NilePsmReader {
  const calls: Record<string, string> = {
    [`${C.usdt}|balanceOf(address)|${encodeAddress(WALLET)}`]: word(1_000_000n),
    [`${C.usdd}|balanceOf(address)|${encodeAddress(WALLET)}`]: word(2n * WAD),
    [`${C.usdt}|allowance(address,address)|${encodeAddress(WALLET)}${encodeAddress(C.gemJoin)}`]: word(0n),
    [`${C.usdd}|allowance(address,address)|${encodeAddress(WALLET)}${encodeAddress(C.psm)}`]: word(0n),
    [`${C.psm}|gemJoin()|`]: addressWord(C.gemJoin),
    [`${C.psm}|usdd()|`]: addressWord(C.usdd),
    [`${C.psm}|vat()|`]: addressWord(VAT),
    [`${C.psm}|ilk()|`]: ILK,
    [`${C.gemJoin}|gem()|`]: addressWord(C.usdt),
    [`${C.gemJoin}|vat()|`]: addressWord(VAT),
    [`${C.gemJoin}|ilk()|`]: ILK,
    [`${C.gemJoin}|dec()|`]: word(6n),
    [`${C.usdt}|decimals()|`]: word(6n),
    [`${C.usdd}|decimals()|`]: word(18n),
    [`${C.psm}|sellEnabled()|`]: word(1n),
    [`${C.psm}|buyEnabled()|`]: word(1n),
    [`${C.psm}|tin()|`]: word(1_200_000_000_000_000n),
    [`${C.psm}|tout()|`]: word(2_000_000_000_000_000n),
    [`${C.usdt}|basisPointsRate()|`]: word(0n),
    [`${C.usdt}|paused()|`]: word(0n),
    [`${C.usdt}|deprecated()|`]: word(0n),
    [`${VAT}|ilks(bytes32)|${ILK}`]: [word(2n * WAD), word(10n ** 27n), word(0n), word(10n * RAD), word(0n)].join(''),
    [`${VAT}|Line()|`]: word(12n * RAD),
    [`${VAT}|debt()|`]: word(3n * RAD),
    [`${C.usdt}|balanceOf(address)|${encodeAddress(C.gemJoin)}`]: word(3_000_000n),
    [`${VAT}|urns(bytes32,address)|${ILK}${encodeAddress(C.psm)}`]: word(2n * WAD) + word(2n * WAD),
    ...overrides,
  };
  return {
    call: async (address, selector, parameter = '') => {
      const value = calls[`${address}|${selector}|${parameter}`];
      if (value === undefined) throw new Error(`Missing fixture: ${address} ${selector}`);
      return value;
    },
    contract: async address => ({ address, hasCode: true, abiFunctions: [], codeHash: 'a'.repeat(64) }),
    trxBalance: async () => '100000000',
    now: () => new Date('2026-09-30T00:00:00.000Z'),
  };
}

describe('Nile PSM exact amounts', () => {
  it('quotes exact USDT output and exact USDT input with Solidity fee truncation', () => {
    expect(quoteNilePsmBuy('1000000', '2000000000000000')).toEqual({
      direction: 'buy_gem', gemAmountRaw: '1000000', usddAmountRaw: '1002000000000000000', feeUsddRaw: '2000000000000000',
    });
    expect(quoteNilePsmSell('1000000', '1200000000000000')).toEqual({
      direction: 'sell_gem', gemAmountRaw: '1000000', usddAmountRaw: '998800000000000000', feeUsddRaw: '1200000000000000',
    });
    expect(() => quoteNilePsmBuy('0', '0')).toThrow();
    expect(() => quoteNilePsmSell('1', (WAD + 1n).toString())).toThrow();
    expect(() => quoteNilePsmBuy('1'.repeat(80), '0')).toThrow();
  });

  it('verifies chain links, token units, both capacity limits and exact allowances', async () => {
    const gateway = createNilePsmReadGateway(fixture());
    const balance = await gateway.readNilePsmBalances(WALLET);
    expect(balance.usddBalanceRaw).toBe('2000000000000000000');
    expect(balance.usddAllowanceToPsmRaw).toBe('0');
    expect(balance.source.chain).toBe('nile');
    const state = await gateway.readNilePsmState({ walletAddress: WALLET, gemAmountRaw: '1000000', direction: 'buy_gem' });
    expect(state.entryCapacityUsdtRaw).toBe('8000000');
    expect(state.exitCapacityUsdtRaw).toBe('2000000');
    expect(state.quote.usddAmountRaw).toBe('1002000000000000000');
    expect(state.needsApproval).toBe(true);
    expect(state.blockedReasons).toEqual([]);
    expect(state.contractCodeHashes.psm).toBe('a'.repeat(64));
  });

  it('blocks an insufficient balance or capacity, and rejects a different on-chain token', async () => {
    const normal = createNilePsmReadGateway(fixture());
    const state = await normal.readNilePsmState({ walletAddress: WALLET, gemAmountRaw: '3000000', direction: 'buy_gem' });
    expect(state.blockedReasons).toContain('Insufficient input token balance');
    expect(state.blockedReasons).toContain('Insufficient PSM exit capacity');
    const otherAddress = TronWeb.address.fromHex(TronWeb.address.toHex(VAT));
    const altered = createNilePsmReadGateway(fixture({ [`${C.psm}|usdd()|`]: addressWord(otherAddress) }));
    await expect(altered.readNilePsmState({ walletAddress: WALLET, gemAmountRaw: '1000000', direction: 'buy_gem' }))
      .rejects.toThrow(/token, GemJoin, Vat/);
    const taxed = createNilePsmReadGateway(fixture({ [`${C.usdt}|basisPointsRate()|`]: word(1n) }));
    const taxedState = await taxed.readNilePsmState({ walletAddress: WALLET, gemAmountRaw: '1000000', direction: 'sell_gem' });
    expect(taxedState.blockedReasons).toContain('PSM USDT charges a transfer fee');
  });
});
