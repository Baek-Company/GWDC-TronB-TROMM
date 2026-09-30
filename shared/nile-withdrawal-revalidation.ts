import type { NileWithdrawalPreview } from '../server/transactions';
import { normalizeTronAddress } from './tron-address';

function sameAddress(left: string, right: string): boolean {
  const normalized = normalizeTronAddress(left);
  return normalized !== null && normalized === normalizeTronAddress(right);
}

/** Keep the user's signed terms while allowing fresh, no-worse Nile market reads. */
export function sameSafeNileWithdrawal(before: NileWithdrawalPreview, after: NileWithdrawalPreview): boolean {
  const old = before.state;
  const current = after.state;
  if (before.chain !== 'nile' || after.chain !== 'nile' ||
      before.method !== 'redeem(uint256)' || after.method !== 'redeem(uint256)' ||
      before.planId !== after.planId || before.needsVersion !== after.needsVersion ||
      before.quoteVersion !== after.quoteVersion ||
      !sameAddress(before.walletAddress, after.walletAddress) ||
      !sameAddress(before.contractAddress, after.contractAddress) ||
      before.asset.symbol !== after.asset.symbol || before.asset.decimals !== after.asset.decimals ||
      !before.asset.address || !after.asset.address || !sameAddress(before.asset.address, after.asset.address) ||
      before.approvalScope !== after.approvalScope ||
      before.amountBaseUnits !== after.amountBaseUnits ||
      old.chain !== current.chain || old.chainId !== current.chainId ||
      !sameAddress(old.walletAddress, current.walletAddress) ||
      !sameAddress(old.contractAddress, current.contractAddress) ||
      !sameAddress(old.comptrollerAddress, current.comptrollerAddress) ||
      old.contractCodeHash !== current.contractCodeHash || old.jtrxDecimals !== current.jtrxDecimals ||
      old.jtrxBalanceRaw !== current.jtrxBalanceRaw || old.jtrxAmountRaw !== current.jtrxAmountRaw ||
      before.feeLimitSun !== after.feeLimitSun || old.feeLimitSun !== current.feeLimitSun ||
      before.maxFeeBaseUnits === null || after.maxFeeBaseUnits === null ||
      before.maxFeeBaseUnits !== after.maxFeeBaseUnits || old.maxFeeSun !== current.maxFeeSun ||
      before.estimatedFeeBaseUnits === null || after.estimatedFeeBaseUnits === null ||
      BigInt(after.estimatedFeeBaseUnits) > BigInt(before.estimatedFeeBaseUnits) ||
      BigInt(after.expectedUnderlyingSun) < BigInt(before.expectedUnderlyingSun) ||
      BigInt(current.expectedUnderlyingSun) !== BigInt(after.expectedUnderlyingSun) ||
      BigInt(current.jtrxBalanceRaw) < BigInt(after.amountBaseUnits) ||
      BigInt(current.marketCashSun) < BigInt(after.expectedUnderlyingSun) ||
      BigInt(current.walletBalanceSun) < BigInt(before.maxFeeBaseUnits) ||
      BigInt(after.expectedUnderlyingSun) !==
        BigInt(after.amountBaseUnits) * BigInt(current.exchangeRateCurrentRaw) / 10n ** 18n ||
      before.source.chain !== 'nile' || after.source.chain !== 'nile' ||
      before.source.mode !== 'live' || after.source.mode !== 'live' ||
      old.source.chain !== 'nile' || current.source.chain !== 'nile' ||
      old.source.mode !== 'live' || current.source.mode !== 'live' ||
      Date.parse(after.source.fetchedAt) < Date.parse(before.source.fetchedAt)) return false;

  // A fingerprint alone may not change. A differing fingerprint must be explained
  // by a field that can legitimately move between two live RPC observations.
  const movingFields: (keyof typeof old)[] = [
    'walletBalanceSun', 'marketCashSun', 'exchangeRateStoredRaw', 'exchangeRateCurrentRaw',
    'expectedUnderlyingSun', 'supplyRatePerBlockRaw', 'estimatedEnergy',
    'energyPriceSun', 'bandwidthPriceSun', 'estimatedFeeSun',
    'availableEnergy', 'availableBandwidth', 'fullBurnFeeSun',
    'estimatedBandwidthBytes', 'simulatedEnergy', 'estimateEnergyRequired',
    'dynamicEnergyMaxFactorRaw', 'feeLimitBasis',
  ];
  const marketMoved = movingFields.some(field => old[field] !== current[field]);
  return (before.fingerprint === after.fingerprint) === !marketMoved;
}
