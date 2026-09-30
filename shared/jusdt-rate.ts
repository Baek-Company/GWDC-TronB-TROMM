import Decimal from 'decimal.js';
import { jusdtRateModelSchema, type JusdtRateModel } from './schemas';

const WAD = 10n ** 18n;
const BLOCKS_PER_YEAR = 10_512_000n;

function raw(value: string): bigint {
  if (!/^\d+$/.test(value)) throw new Error('Invalid jUSDT rate model integer');
  return BigInt(value);
}

/** Reproduce the integer operations of the currently verified JustLend rate model. */
export function supplyRateForDepositRaw(modelInput: JusdtRateModel, depositUsdtRaw: string): string {
  const model = jusdtRateModelSchema.parse(modelInput);
  const cash = raw(model.cashRaw) + raw(depositUsdtRaw);
  const borrows = raw(model.borrowsRaw);
  const reserves = raw(model.reservesRaw);
  const reserveFactor = raw(model.reserveFactorRaw);
  if (reserveFactor > WAD || cash + borrows < reserves) throw new Error('Invalid jUSDT rate model state');
  const denominator = cash + borrows - reserves;
  const utilization = denominator === 0n ? 0n : borrows * WAD / denominator;
  const base = raw(model.baseRatePerBlockRaw);
  const multiplier = raw(model.multiplierPerBlockRaw);
  let borrowRate: bigint;
  if (model.kind === 'jump') {
    const kink = raw(model.kinkRaw!);
    const jumpMultiplier = raw(model.jumpMultiplierPerBlockRaw!);
    borrowRate = utilization <= kink
      ? base + utilization * multiplier / WAD
      : base + kink * multiplier / WAD + (utilization - kink) * jumpMultiplier / WAD;
  } else {
    borrowRate = base + utilization * multiplier / WAD;
  }
  const rateToPool = borrowRate * (WAD - reserveFactor) / WAD;
  return (utilization * rateToPool / WAD).toString();
}

/** A model is usable only when its current-state output matches the market read. */
export function verifiedScenarioApr(modelInput: JusdtRateModel, depositUsdtRaw: string): string | null {
  const model = jusdtRateModelSchema.parse(modelInput);
  const observed = raw(model.currentSupplyRatePerBlockRaw);
  const calculated = raw(supplyRateForDepositRaw(model, '0'));
  const difference = observed > calculated ? observed - calculated : calculated - observed;
  const tolerance = observed === 0n ? 0n : (observed / 100n) + (observed % 100n === 0n ? 0n : 1n);
  if (difference > (tolerance > 1n ? tolerance : observed === 0n ? 0n : 1n)) return null;
  const after = raw(supplyRateForDepositRaw(model, depositUsdtRaw));
  const scenario = after < observed ? after : observed;
  return new Decimal(scenario.toString()).times(BLOCKS_PER_YEAR.toString()).div(WAD.toString()).toString();
}
