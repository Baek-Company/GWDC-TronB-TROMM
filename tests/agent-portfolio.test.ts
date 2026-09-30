import { describe, expect, it, vi } from 'vitest';
import { TronWeb } from 'tronweb';
import type { Observation, Source } from '../shared/schemas';
import { MAINNET_JUSDT_ADDRESS, MAINNET_UNITROLLER_ADDRESS } from '../server/data/quotes';
import { MAINNET_USDT_ADDRESS } from '../server/data/usdd';
import { NILE_JTRX_CANDIDATE } from '../server/data/tron-rpc';
import type { MainnetJusdtMarketEvidence } from '../server/data/jusdt-market';
import { createPortfolioObserver } from '../server/agent/portfolio';

const WALLET = 'T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb';
const NOW = Date.parse('2026-09-29T09:00:00.000Z');
const word = (value: bigint | number) => BigInt(value).toString(16).padStart(64, '0');
const addressWord = (address: string) => TronWeb.address.toHex(address).slice(2).padStart(64, '0');
const nileSource: Source = { sourceUrl: 'https://nile.trongrid.io', chain: 'nile',
  fetchedAt: '2026-09-29T09:00:00.000Z', sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' };

function nileObservation(): Observation {
  return { id: 'observation-1', planId: 'portfolio-read-only',
    positionId: `nile:${WALLET}:${NILE_JTRX_CANDIDATE}`, walletAddress: WALLET, chain: 'nile',
    receiptToken: { symbol: 'jTRX', address: NILE_JTRX_CANDIDATE, decimals: 8 },
    receiptBalanceBaseUnits: '100000000', exchangeRateRaw: '2000000000000000000',
    underlyingToken: { symbol: 'TRX', address: null, decimals: 6 },
    underlyingValueBaseUnits: '200000000', source: nileSource };
}

describe('read-only portfolio observation', () => {
  it('caps a jUSDT market-bound assessment with one USDT read and marks other amounts unobserved', async () => {
    const mainnetSource: Source = { ...nileSource, chain: 'mainnet' };
    const evidence: MainnetJusdtMarketEvidence = {
      quoteVersion: 'market-v1', marketAddress: MAINNET_JUSDT_ADDRESS,
      underlyingAddress: MAINNET_USDT_ADDRESS, controllerAddress: MAINNET_UNITROLLER_ADDRESS,
      marketCodeIdentity: 'a'.repeat(64), underlyingCodeIdentity: 'b'.repeat(64),
      cashRaw: '1000000000', borrowsRaw: '0', reservesRaw: '0', reserveFactorRaw: '0',
      supplyRatePerBlockRaw: '1', interestRateModelAddress: MAINNET_JUSDT_ADDRESS,
      rateModel: null, directorySource: { ...mainnetSource, accessMethod: 'rest' },
      source: mainnetSource, observationWindow: { firstBlock: '100', lastBlock: '101',
        startedAt: mainnetSource.fetchedAt, endedAt: mainnetSource.fetchedAt },
      validUntil: '2026-09-29T09:01:00.000Z',
    };
    const constant = vi.fn().mockResolvedValue(word(700_000_000));
    const contract = vi.fn();
    const trxBalance = vi.fn();
    const observe = createPortfolioObserver({ constant, contract, trxBalance, now: () => NOW });
    const input = { chain: 'mainnet' as const, address: WALLET,
      declaredHoldings: { asset: 'USDT', amount: '1000' },
      marketEvidence: evidence, marketQuoteVersion: evidence.quoteVersion };
    const result = await observe(input);
    expect(result.walletBalance).toMatchObject({ status: 'ready', amount: '700' });
    expect(result.feeBalance.status).toBe('unknown');
    expect(result.position.status).toBe('unknown');
    expect(constant).toHaveBeenCalledExactlyOnceWith('mainnet', MAINNET_USDT_ADDRESS,
      'balanceOf(address)', addressWord(WALLET));
    expect(contract).not.toHaveBeenCalled();
    expect(trxBalance).not.toHaveBeenCalled();
    const stale = await observe({ ...input, marketQuoteVersion: 'other-version' });
    expect(stale.walletBalance.status).toBe('unknown');
    expect(constant).toHaveBeenCalledTimes(1);
  });

  it('separates a declared Nile amount from TRX and candidate jTRX readings', async () => {
    const nileBalance = vi.fn().mockResolvedValue({ walletAddress: WALLET, chain: 'nile',
      balanceSun: '175000000', source: nileSource });
    const nilePosition = vi.fn().mockResolvedValue(nileObservation());
    const observe = createPortfolioObserver({ nileBalance, nilePosition, now: () => NOW });
    const result = await observe({ chain: 'nile', address: WALLET,
      declaredHoldings: { asset: 'TRX', amount: '250' } });
    expect(result.declaredHoldings).toEqual({ asset: 'TRX', amount: '250' });
    expect(result.walletBalance).toMatchObject({ status: 'ready', amount: '175', amountBaseUnits: '175000000' });
    expect(result.feeBalance).toBe(result.walletBalance);
    expect(result.position).toMatchObject({ status: 'ready', receiptBalance: '1', underlyingValue: '200',
      marketVerified: false, valuationMethod: 'exchangeRateCurrent_simulation' });
    expect(result.observedMinusDeclared).toBe('-75');
    expect(result.block).toMatchObject({ status: 'unknown', number: null });
    expect(result.executionEligible).toBe(false);
    expect(nilePosition).toHaveBeenCalledWith({ planId: 'portfolio-read-only', address: WALLET });
  });

  it('verifies Mainnet USDT and jUSDT identity before reading and valuing the position', async () => {
    const contract = vi.fn(async (_chain: string, address: string) => ({ address, hasCode: true, abiFunctions: [] }));
    const constant = vi.fn(async (_chain: string, contractAddress: string, selector: string, parameter?: string) => {
      if (contractAddress === MAINNET_USDT_ADDRESS && selector === 'decimals()') return word(6);
      if (contractAddress === MAINNET_USDT_ADDRESS && selector === 'balanceOf(address)') {
        expect(parameter).toBe(addressWord(WALLET));
        return word(1_230_000);
      }
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'underlying()') return addressWord(MAINNET_USDT_ADDRESS);
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'comptroller()') return addressWord(MAINNET_UNITROLLER_ADDRESS);
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'decimals()') return word(8);
      if (contractAddress === MAINNET_UNITROLLER_ADDRESS && selector === 'markets(address)') {
        expect(parameter).toBe(addressWord(MAINNET_JUSDT_ADDRESS));
        return word(1);
      }
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'balanceOf(address)') {
        expect(parameter).toBe(addressWord(WALLET));
        return word(100_000_000);
      }
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'exchangeRateCurrent()') return word(2_000_000_000_000_000_000n);
      throw new Error(`unexpected constant selector ${selector}`);
    });
    const trxBalance = vi.fn().mockResolvedValue('9000000');
    const observe = createPortfolioObserver({ contract, constant, trxBalance, now: () => NOW });
    const result = await observe({ chain: 'mainnet', address: WALLET,
      declaredHoldings: { asset: 'USDT', amount: '5' } });
    expect(result.walletBalance).toMatchObject({ status: 'ready', amount: '1.23', amountBaseUnits: '1230000' });
    expect(result.feeBalance).toMatchObject({ status: 'ready', amount: '9', token: { symbol: 'TRX' } });
    expect(result.position).toMatchObject({ status: 'ready', marketVerified: true,
      receiptBalance: '1', underlyingValue: '200', underlyingValueBaseUnits: '200000000' });
    expect(result.observedMinusDeclared).toBe('-3.77');
    expect(result.walletBalance.source?.sourceUrl).toBe('https://api.trongrid.io/wallet/triggerconstantcontract');
    expect(result.walletBalance.source?.fetchedAt).toBe('2026-09-29T09:00:00.000Z');
    expect(result.position.blockNumber).toBeNull();
    expect(result.consistency).toBe('independent_latest_reads');
    expect(constant.mock.calls.every(([, , selector]) => [
      'decimals()', 'balanceOf(address)', 'underlying()', 'comptroller()', 'markets(address)',
      'exchangeRateCurrent()',
    ].includes(selector!))).toBe(true);
  });

  it('keeps Mainnet values unknown when token decimals fail and never reads jUSDT as verified', async () => {
    const constant = vi.fn().mockResolvedValue(word(18));
    const observe = createPortfolioObserver({
      contract: vi.fn(async (_chain, address) => ({ address, hasCode: true, abiFunctions: [] })),
      constant, trxBalance: vi.fn().mockRejectedValue(new Error('HTTP 429')), now: () => NOW,
    });
    const result = await observe({ chain: 'mainnet', address: WALLET,
      declaredHoldings: { asset: 'USDT', amount: '1000' } });
    expect(result.walletBalance).toMatchObject({ status: 'unavailable', amount: null, amountBaseUnits: null });
    expect(result.position).toMatchObject({ status: 'unknown', marketVerified: false, receiptBalance: null });
    expect(result.feeBalance).toMatchObject({ status: 'unknown', amount: null, reason: 'Mainnet 수수료용 TRX 잔액 HTTP 429' });
    expect(result.observedMinusDeclared).toBeNull();
    expect(constant).toHaveBeenCalledTimes(1);
  });

  it('rejects an unlisted jUSDT market while retaining the independently read USDT balance', async () => {
    const constant = vi.fn(async (_chain: string, contractAddress: string, selector: string) => {
      if (contractAddress === MAINNET_USDT_ADDRESS && selector === 'decimals()') return word(6);
      if (contractAddress === MAINNET_USDT_ADDRESS && selector === 'balanceOf(address)') return word(10_000_000);
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'underlying()') return addressWord(MAINNET_USDT_ADDRESS);
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'comptroller()') return addressWord(MAINNET_UNITROLLER_ADDRESS);
      if (contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'decimals()') return word(8);
      if (contractAddress === MAINNET_UNITROLLER_ADDRESS && selector === 'markets(address)') return word(0);
      throw new Error('position amount must not be read for an unlisted market');
    });
    const observe = createPortfolioObserver({
      contract: vi.fn(async (_chain, address) => ({ address, hasCode: true, abiFunctions: [] })),
      constant, trxBalance: vi.fn().mockResolvedValue('1000000'), now: () => NOW,
    });
    const result = await observe({ chain: 'mainnet', address: WALLET });
    expect(result.walletBalance).toMatchObject({ status: 'ready', amount: '10' });
    expect(result.position).toMatchObject({ status: 'unavailable', receiptBalance: null, marketVerified: false });
    expect(constant.mock.calls.some(([, contractAddress, selector]) =>
      contractAddress === MAINNET_JUSDT_ADDRESS && selector === 'balanceOf(address)')).toBe(false);
  });

  it('rejects an invalid address before any RPC read', async () => {
    const nileBalance = vi.fn();
    const observe = createPortfolioObserver({ nileBalance, now: () => NOW });
    await expect(observe({ chain: 'nile', address: 'not-a-tron-address' })).rejects.toThrow('TRON 지갑 주소');
    expect(nileBalance).not.toHaveBeenCalled();
  });
});
