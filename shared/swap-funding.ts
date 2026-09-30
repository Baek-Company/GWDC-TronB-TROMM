const SCALE = 1_000_000n;

export type SwapPool = { reserveUsdtRaw: string; reserveTrxRaw: string; feeNumerator: 997 };

function rawUsdt(amount: string): bigint {
  if (!/^\d+(?:\.\d{1,6})?$/.test(amount)) throw new Error('USDT 금액은 소수점 6자리까지 입력해 주세요.');
  const [whole, fraction = ''] = amount.split('.');
  return BigInt(whole) * SCALE + BigInt(fraction.padEnd(6, '0'));
}

function format(raw: bigint): string {
  return `${raw / SCALE}.${(raw % SCALE).toString().padStart(6, '0')}`;
}

export function constantProductOut(inputRaw: bigint, reserveInRaw: bigint, reserveOutRaw: bigint,
  feeNumerator: bigint): bigint {
  if (inputRaw <= 0n || reserveInRaw <= 0n || reserveOutRaw <= 0n || feeNumerator <= 0n || feeNumerator > 1000n) {
    throw new Error('교환 금액 또는 풀 잔고가 유효하지 않습니다.');
  }
  return inputRaw * feeNumerator * reserveOutRaw / (reserveInRaw * 1000n + inputRaw * feeNumerator);
}

/** Immediate reserve-math illustration only; future price and transaction costs remain unknown. */
export function previewUsdtTrxFunding(amountUsdt: string, pool: SwapPool) {
  const inputRaw = rawUsdt(amountUsdt);
  const usdtReserve = BigInt(pool.reserveUsdtRaw);
  const trxReserve = BigInt(pool.reserveTrxRaw);
  if (inputRaw <= 0n || inputRaw >= usdtReserve || trxReserve <= 0n) throw new Error('풀 잔고 대비 교환 금액이 유효하지 않습니다.');
  const trxOut = constantProductOut(inputRaw, usdtReserve, trxReserve, BigInt(pool.feeNumerator));
  if (trxOut <= 0n || trxOut >= trxReserve) throw new Error('교환 결과가 토큰 최소 단위에 미치지 못합니다.');
  const usdtBack = constantProductOut(trxOut, trxReserve - trxOut, usdtReserve + inputRaw,
    BigInt(pool.feeNumerator));
  return { inputUsdt: format(inputRaw), trxOutAtSnapshot: format(trxOut),
    usdtBackImmediateAtSnapshot: format(usdtBack),
    immediateRoundTripLossUsdt: format(inputRaw - usdtBack),
    feeAssumption: '0.3% per swap', futureExitUsdt: null, networkCostUsdt: null,
    stakeRewardApr: null, eligibleForPlan: false } as const;
}
