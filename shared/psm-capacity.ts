import DecimalBase from 'decimal.js';

const Decimal = DecimalBase.clone({ precision: 128, toExpNeg: -100, toExpPos: 100 });
const WAD = 10n ** 18n;
const RAD_PER_USDT_RAW = 10n ** 39n; // 1e45 rad per USDD / 1e6 USDT raw units

/** Vat.ilks debt ceiling is measured in rad; a PSM sell mints the gross gem amount. */
export function psmEntryCapacity(ilkWords: string, globalLineRaw?: string, globalDebtRaw?: string): string {
  if (!/^(?:[0-9a-fA-F]{64}){5}$/.test(ilkWords)) throw new Error('Invalid Vat.ilks result');
  const words = ilkWords.match(/.{64}/g)!;
  const art = BigInt(`0x${words[0]}`);
  const rate = BigInt(`0x${words[1]}`);
  const line = BigInt(`0x${words[3]}`);
  let room = line > art * rate ? line - art * rate : 0n;
  if (globalLineRaw !== undefined || globalDebtRaw !== undefined) {
    if (!globalLineRaw || !globalDebtRaw || !/^\d+$/.test(globalLineRaw) || !/^\d+$/.test(globalDebtRaw)) {
      throw new Error('Invalid global Vat debt ceiling');
    }
    const globalLine = BigInt(globalLineRaw);
    const globalDebt = BigInt(globalDebtRaw);
    const globalRoom = globalLine > globalDebt ? globalLine - globalDebt : 0n;
    if (globalRoom < room) room = globalRoom;
  }
  return new Decimal((room / RAD_PER_USDT_RAW).toString()).div('1000000').toFixed(6);
}

/** USDT held by GemJoin is a conservative USDD-denominated exit ceiling. */
export function psmExitCapacity(usdtBalanceRaw: string): string {
  if (!/^\d+$/.test(usdtBalanceRaw)) throw new Error('Invalid USDT balance');
  return new Decimal(usdtBalanceRaw).div('1000000').toFixed(6);
}

/** sellGem pays (1 - tin); buyGem takes (1 + tout) USDD for exact USDT output. */
export function psmRates(tinRaw: string, toutRaw: string): { entryRate: string; exitRate: string } {
  if (!/^\d+$/.test(tinRaw) || !/^\d+$/.test(toutRaw)) throw new Error('Invalid PSM fee');
  const tin = BigInt(tinRaw);
  const tout = BigInt(toutRaw);
  if (tin > WAD || tout > WAD) throw new Error('PSM fee outside supported range');
  return { entryRate: new Decimal(WAD - tin).div(WAD.toString()).toString(),
    exitRate: new Decimal(WAD.toString()).div((WAD + tout).toString()).toString() };
}
