import { TronWeb } from 'tronweb';
import type { Source } from '../shared/schemas';
import { callConstant, decodeAddress, decodeUint, encodeAddress, readContract, readTrxBalance,
  type ContractInfo } from './data/tron-rpc';

/** Candidate deployment addresses from the USDD team's Nile chain configuration. */
export const NILE_PSM_CONTRACTS = Object.freeze({
  psm: 'TEwUGMSAvbmzjxWoV8JWoSqvQm1A3AXs1V',
  gemJoin: 'TBm4W3JpzsQC4z5mk96fLWZbfNKcfJ5Bxy',
  usdt: 'TZDnq7egPqzi7H4SXy1ABvwaVRvRTaVfJW',
  usdd: 'TYQF9cAeJ3Faq8QXpHxTcFco72DRCQbgFt',
  sourceUrl: 'https://github.com/decentralized-usd/mcp-server-usdd/blob/master/src/core/chains.ts',
});

const WAD = 10n ** 18n;
const TO_18 = 10n ** 12n;
const RAD_PER_USDT_RAW = 10n ** 39n;
const MAX_UINT = (1n << 256n) - 1n;
const UINT = /^\d+$/;

export type NilePsmDirection = 'buy_gem' | 'sell_gem';
export type NilePsmQuote = {
  direction: NilePsmDirection;
  /** Exact USDT output for buy_gem, or exact USDT input for sell_gem; 6 decimals. */
  gemAmountRaw: string;
  /** Exact USDD input for buy_gem, or exact USDD output for sell_gem; 18 decimals. */
  usddAmountRaw: string;
  feeUsddRaw: string;
};

function uint(value: string, label: string, positive = false): bigint {
  if (!UINT.test(value)) throw new Error(`${label}: unsigned integer string required`);
  const parsed = BigInt(value);
  if (parsed > MAX_UINT || (positive && parsed === 0n)) throw new Error(`${label}: outside supported uint256 range`);
  return parsed;
}

function quote(direction: NilePsmDirection, gemAmountRaw: string, feeRaw: string): NilePsmQuote {
  const gem = uint(gemAmountRaw, 'USDT amount', true);
  const feeRate = uint(feeRaw, 'PSM fee');
  if (feeRate > WAD) throw new Error('PSM fee exceeds 100%');
  const gross = gem * TO_18;
  if (gross > MAX_UINT || gross * feeRate > MAX_UINT) throw new Error('PSM quote overflows uint256');
  const fee = gross * feeRate / WAD; // Solidity truncates toward zero.
  const amount = direction === 'buy_gem' ? gross + fee : gross - fee;
  if (amount > MAX_UINT) throw new Error('PSM quote overflows uint256');
  return { direction, gemAmountRaw: gem.toString(), usddAmountRaw: amount.toString(), feeUsddRaw: fee.toString() };
}

export function quoteNilePsmBuy(gemAmountRaw: string, toutRaw: string): NilePsmQuote {
  return quote('buy_gem', gemAmountRaw, toutRaw);
}

export function quoteNilePsmSell(gemAmountRaw: string, tinRaw: string): NilePsmQuote {
  return quote('sell_gem', gemAmountRaw, tinRaw);
}

export type NilePsmBalances = {
  chain: 'nile';
  walletAddress: string;
  usdtAddress: string;
  usddAddress: string;
  usdtBalanceRaw: string;
  usddBalanceRaw: string;
  usdtAllowanceToGemJoinRaw: string;
  usddAllowanceToPsmRaw: string;
  trxBalanceSun: string;
  fetchedAt: string;
  sourceUrl: string;
  source: Source;
};

export type NilePsmState = NilePsmBalances & {
  psmAddress: string;
  gemJoinAddress: string;
  vatAddress: string;
  contractCodeHashes: { psm: string; gemJoin: string; usdt: string; usdd: string; vat: string };
  sellEnabled: boolean;
  buyEnabled: boolean;
  tinRaw: string;
  toutRaw: string;
  usdtTransferFeeBasisPointsRaw: string;
  usdtPaused: boolean;
  usdtDeprecated: boolean;
  /** Maximum additional USDT that can enter before the PSM and global Vat ceilings. */
  entryCapacityUsdtRaw: string;
  /** Smaller of GemJoin USDT and the PSM's own outstanding Vat debt. */
  exitCapacityUsdtRaw: string;
  quote: NilePsmQuote;
  needsApproval: boolean;
  blockedReasons: string[];
};

export type NilePsmReader = {
  call: (address: string, selector: string, parameter?: string) => Promise<string>;
  contract: (address: string) => Promise<ContractInfo>;
  trxBalance: (address: string) => Promise<string>;
  now: () => Date;
};

const defaultReader: NilePsmReader = {
  call: (address, selector, parameter) => callConstant('nile', address, selector, parameter),
  contract: address => readContract('nile', address),
  trxBalance: address => readTrxBalance('nile', address),
  now: () => new Date(),
};

function sameAddress(a: string, b: string): boolean {
  return TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase();
}

function wordPair(value: string, field: string): [bigint, bigint] {
  if (!/^[0-9a-fA-F]{128,}$/.test(value)) throw new Error(`${field}: invalid ABI result`);
  return [BigInt(`0x${value.slice(0, 64)}`), BigInt(`0x${value.slice(64, 128)}`)];
}

function ilkCapacity(ilkWords: string, globalLineRaw: string, globalDebtRaw: string): bigint {
  if (!/^[0-9a-fA-F]{320,}$/.test(ilkWords)) throw new Error('Vat.ilks: invalid ABI result');
  const art = BigInt(`0x${ilkWords.slice(0, 64)}`);
  const rate = BigInt(`0x${ilkWords.slice(64, 128)}`);
  const line = BigInt(`0x${ilkWords.slice(192, 256)}`);
  const globalLine = uint(globalLineRaw, 'Vat.Line');
  const globalDebt = uint(globalDebtRaw, 'Vat.debt');
  const ilkRoom = line > art * rate ? line - art * rate : 0n;
  const globalRoom = globalLine > globalDebt ? globalLine - globalDebt : 0n;
  return (ilkRoom < globalRoom ? ilkRoom : globalRoom) / RAD_PER_USDT_RAW;
}

export function createNilePsmReadGateway(reader: NilePsmReader = defaultReader) {
  const C = NILE_PSM_CONTRACTS;

  async function readNilePsmBalances(walletAddress: string): Promise<NilePsmBalances> {
    if (!TronWeb.isAddress(walletAddress)) throw new Error('Invalid Nile wallet address');
    const wallet = TronWeb.address.fromHex(TronWeb.address.toHex(walletAddress));
    const [usdtBalance, usddBalance, usdtAllowance, usddAllowance, trxBalanceSun] = await Promise.all([
      reader.call(C.usdt, 'balanceOf(address)', encodeAddress(wallet)),
      reader.call(C.usdd, 'balanceOf(address)', encodeAddress(wallet)),
      reader.call(C.usdt, 'allowance(address,address)', encodeAddress(wallet) + encodeAddress(C.gemJoin)),
      reader.call(C.usdd, 'allowance(address,address)', encodeAddress(wallet) + encodeAddress(C.psm)),
      reader.trxBalance(wallet),
    ]);
    const fetchedAt = reader.now().toISOString();
    const sourceUrl = 'https://nile.trongrid.io/wallet/triggerconstantcontract';
    return {
      chain: 'nile', walletAddress: wallet, usdtAddress: C.usdt, usddAddress: C.usdd,
      usdtBalanceRaw: decodeUint(usdtBalance), usddBalanceRaw: decodeUint(usddBalance),
      usdtAllowanceToGemJoinRaw: decodeUint(usdtAllowance),
      usddAllowanceToPsmRaw: decodeUint(usddAllowance), trxBalanceSun: uint(trxBalanceSun, 'TRX balance').toString(),
      fetchedAt, sourceUrl,
      source: { sourceUrl, chain: 'nile', fetchedAt, sourceUpdatedAt: null, mode: 'live', accessMethod: 'rpc' },
    };
  }

  async function readNilePsmState(input: { walletAddress: string; gemAmountRaw: string;
    direction: NilePsmDirection }): Promise<NilePsmState> {
    if (input.direction !== 'buy_gem' && input.direction !== 'sell_gem') throw new Error('Invalid PSM direction');
    const amount = uint(input.gemAmountRaw, 'USDT amount', true);
    const [psm, gemJoin, usdt, usdd, balances] = await Promise.all([
      reader.contract(C.psm), reader.contract(C.gemJoin), reader.contract(C.usdt), reader.contract(C.usdd),
      readNilePsmBalances(input.walletAddress),
    ]);
    for (const [name, contract] of Object.entries({ psm, gemJoin, usdt, usdd })) {
      if (!contract.hasCode || !contract.codeHash || !sameAddress(contract.address, C[name as keyof typeof C])) {
        throw new Error(`Nile ${name} contract identity is unverified`);
      }
    }
    const [gemJoinWord, usddWord, vatWord, ilk, joinGemWord, joinVatWord, joinIlk,
      joinDecimals, usdtDecimals, usddDecimals, sellFlag, buyFlag, tinRaw, toutRaw,
      usdtFeeBpsRaw, usdtPausedRaw, usdtDeprecatedRaw] = await Promise.all([
        reader.call(C.psm, 'gemJoin()'), reader.call(C.psm, 'usdd()'), reader.call(C.psm, 'vat()'),
        reader.call(C.psm, 'ilk()'), reader.call(C.gemJoin, 'gem()'), reader.call(C.gemJoin, 'vat()'),
        reader.call(C.gemJoin, 'ilk()'), reader.call(C.gemJoin, 'dec()'),
        reader.call(C.usdt, 'decimals()'), reader.call(C.usdd, 'decimals()'),
        reader.call(C.psm, 'sellEnabled()'), reader.call(C.psm, 'buyEnabled()'),
        reader.call(C.psm, 'tin()'), reader.call(C.psm, 'tout()'),
        reader.call(C.usdt, 'basisPointsRate()'), reader.call(C.usdt, 'paused()'),
        reader.call(C.usdt, 'deprecated()'),
      ]);
    if (!sameAddress(decodeAddress(gemJoinWord), C.gemJoin) || !sameAddress(decodeAddress(usddWord), C.usdd)
      || !sameAddress(decodeAddress(joinGemWord), C.usdt)
      || !sameAddress(decodeAddress(vatWord), decodeAddress(joinVatWord))
      || !/^[0-9a-fA-F]{64}$/.test(ilk) || ilk.toLowerCase() !== joinIlk.toLowerCase()
      || decodeUint(joinDecimals) !== '6' || decodeUint(usdtDecimals) !== '6'
      || decodeUint(usddDecimals) !== '18') {
      throw new Error('Nile PSM token, GemJoin, Vat, ilk or decimal linkage differs from the official candidate');
    }
    const vatAddress = decodeAddress(vatWord);
    const vat = await reader.contract(vatAddress);
    if (!vat.hasCode || !vat.codeHash || !sameAddress(vat.address, vatAddress)) {
      throw new Error('Nile PSM Vat contract identity is unverified');
    }
    const [ilkWords, globalLineWord, globalDebtWord, joinReserveWord, urnWord] = await Promise.all([
      reader.call(vatAddress, 'ilks(bytes32)', ilk), reader.call(vatAddress, 'Line()'),
      reader.call(vatAddress, 'debt()'),
      reader.call(C.usdt, 'balanceOf(address)', encodeAddress(C.gemJoin)),
      reader.call(vatAddress, 'urns(bytes32,address)', ilk + encodeAddress(C.psm)),
    ]);
    const entryCapacity = ilkCapacity(ilkWords, decodeUint(globalLineWord), decodeUint(globalDebtWord));
    const reserve = BigInt(decodeUint(joinReserveWord));
    const [, psmDebtWad] = wordPair(urnWord, 'Vat.urns');
    const debtLimitedExit = psmDebtWad / TO_18;
    const exitCapacity = reserve < debtLimitedExit ? reserve : debtLimitedExit;
    const sellEnabled = decodeUint(sellFlag) === '1';
    const buyEnabled = decodeUint(buyFlag) === '1';
    const tin = decodeUint(tinRaw);
    const tout = decodeUint(toutRaw);
    const usdtTransferFeeBasisPointsRaw = decodeUint(usdtFeeBpsRaw);
    const usdtPaused = decodeUint(usdtPausedRaw) !== '0';
    const usdtDeprecated = decodeUint(usdtDeprecatedRaw) !== '0';
    const selectedQuote = input.direction === 'buy_gem'
      ? quoteNilePsmBuy(amount.toString(), tout) : quoteNilePsmSell(amount.toString(), tin);
    const balance = input.direction === 'buy_gem' ? BigInt(balances.usddBalanceRaw) : BigInt(balances.usdtBalanceRaw);
    const required = input.direction === 'buy_gem' ? BigInt(selectedQuote.usddAmountRaw) : amount;
    const allowance = input.direction === 'buy_gem'
      ? BigInt(balances.usddAllowanceToPsmRaw) : BigInt(balances.usdtAllowanceToGemJoinRaw);
    const blockedReasons: string[] = [];
    if (input.direction === 'buy_gem' && !buyEnabled) blockedReasons.push('PSM buyGem is disabled');
    if (input.direction === 'sell_gem' && !sellEnabled) blockedReasons.push('PSM sellGem is disabled');
    if (balance < required) blockedReasons.push('Insufficient input token balance');
    if (input.direction === 'buy_gem' && exitCapacity < amount) blockedReasons.push('Insufficient PSM exit capacity');
    if (input.direction === 'sell_gem' && entryCapacity < amount) blockedReasons.push('Insufficient PSM entry capacity');
    if (usdtTransferFeeBasisPointsRaw !== '0') blockedReasons.push('PSM USDT charges a transfer fee');
    if (usdtPaused) blockedReasons.push('PSM USDT transfers are paused');
    if (usdtDeprecated) blockedReasons.push('PSM USDT is deprecated');
    const fetchedAt = reader.now().toISOString();
    return {
      ...balances, psmAddress: C.psm, gemJoinAddress: C.gemJoin, vatAddress,
      contractCodeHashes: { psm: psm.codeHash!, gemJoin: gemJoin.codeHash!,
        usdt: usdt.codeHash!, usdd: usdd.codeHash!, vat: vat.codeHash },
      sellEnabled, buyEnabled, tinRaw: tin, toutRaw: tout,
      usdtTransferFeeBasisPointsRaw, usdtPaused, usdtDeprecated,
      entryCapacityUsdtRaw: entryCapacity.toString(), exitCapacityUsdtRaw: exitCapacity.toString(),
      quote: selectedQuote, needsApproval: allowance < required, blockedReasons,
      fetchedAt, source: { ...balances.source, fetchedAt },
    };
  }

  return { readNilePsmBalances, readNilePsmState };
}

export const { readNilePsmBalances, readNilePsmState } = createNilePsmReadGateway();
