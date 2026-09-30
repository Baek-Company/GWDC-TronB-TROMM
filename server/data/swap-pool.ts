import { TronWeb } from 'tronweb';
import { connectionReason, provenance, type DataResult } from './provenance';
import { callConstant, decodeAddress, decodeUint, encodeAddress, readContract } from './tron-rpc';
import { MAINNET_USDT_ADDRESS } from './usdd';

// Candidate router from the uploaded project; relationships are verified on chain on each read.
export const SUNSWAP_V2_ROUTER = 'TKzxdSv2FZKQrEqkKVgp5DcwEXBEKMg2Ax';
export type SwapPoolEvidence = {
  routerAddress: string; factoryAddress: string; pairAddress: string; wtrxAddress: string;
  reserveUsdtRaw: string; reserveTrxRaw: string; feeNumerator: 997;
  feeAssumptionVerified: false; executionReady: false;
};

function equalAddress(left: string, right: string): boolean {
  return TronWeb.address.toHex(left).toLowerCase() === TronWeb.address.toHex(right).toLowerCase();
}

export async function readMainnetUsdtTrxPool(): Promise<DataResult<SwapPoolEvidence>> {
  const source = provenance('https://api.trongrid.io/wallet/triggerconstantcontract', 'mainnet', 'rpc');
  try {
    if (!(await readContract('mainnet', SUNSWAP_V2_ROUTER)).hasCode) throw new Error('Router code missing');
    const [wtrxWord, factoryWord] = await Promise.all([
      callConstant('mainnet', SUNSWAP_V2_ROUTER, 'WETH()'),
      callConstant('mainnet', SUNSWAP_V2_ROUTER, 'factory()'),
    ]);
    const wtrxAddress = decodeAddress(wtrxWord);
    const factoryAddress = decodeAddress(factoryWord);
    if (!(await readContract('mainnet', factoryAddress)).hasCode || !(await readContract('mainnet', wtrxAddress)).hasCode) {
      throw new Error('Factory or wrapped TRX code missing');
    }
    const pairAddress = decodeAddress(await callConstant('mainnet', factoryAddress, 'getPair(address,address)',
      `${encodeAddress(MAINNET_USDT_ADDRESS)}${encodeAddress(wtrxAddress)}`));
    if (!(await readContract('mainnet', pairAddress)).hasCode) throw new Error('Pair code missing');
    const [token0Word, token1Word, reserves, usdtDecimals, wtrxDecimals] = await Promise.all([
      callConstant('mainnet', pairAddress, 'token0()'), callConstant('mainnet', pairAddress, 'token1()'),
      callConstant('mainnet', pairAddress, 'getReserves()'),
      callConstant('mainnet', MAINNET_USDT_ADDRESS, 'decimals()'),
      callConstant('mainnet', wtrxAddress, 'decimals()'),
    ]);
    const token0 = decodeAddress(token0Word);
    const token1 = decodeAddress(token1Word);
    if (!(equalAddress(token0, MAINNET_USDT_ADDRESS) && equalAddress(token1, wtrxAddress))
      && !(equalAddress(token1, MAINNET_USDT_ADDRESS) && equalAddress(token0, wtrxAddress))) {
      throw new Error('Pair tokens mismatch');
    }
    if (decodeUint(usdtDecimals) !== '6' || decodeUint(wtrxDecimals) !== '6'
      || !/^(?:[0-9a-fA-F]{64}){3}$/.test(reserves)) throw new Error('Pool units or reserves mismatch');
    const reserve0 = decodeUint(reserves.slice(0, 64));
    const reserve1 = decodeUint(reserves.slice(64, 128));
    const [reserveUsdtRaw, reserveTrxRaw] = equalAddress(token0, MAINNET_USDT_ADDRESS)
      ? [reserve0, reserve1] : [reserve1, reserve0];
    if (BigInt(reserveUsdtRaw) === 0n || BigInt(reserveTrxRaw) === 0n) throw new Error('Empty pool');
    return { status: 'ready', value: { routerAddress: SUNSWAP_V2_ROUTER, factoryAddress,
      pairAddress, wtrxAddress, reserveUsdtRaw, reserveTrxRaw, feeNumerator: 997,
      feeAssumptionVerified: false, executionReady: false }, source };
  } catch (error) {
    return { status: 'unavailable', reason: connectionReason(error, 'SunSwap USDT/TRX 풀'), source };
  }
}
