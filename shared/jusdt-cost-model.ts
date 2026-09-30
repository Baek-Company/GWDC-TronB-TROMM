import { actionCostSampleSetSchema, costEvidenceSchema, jusdtQuoteContextSchema,
  type ActionCostSampleSet, type CostEvidence, type JusdtQuoteContext } from './schemas';

const SELECTORS: Record<CostEvidence['action'], string> = {
  approve_zero: 'approve(address,uint256)', approve: 'approve(address,uint256)',
  mint: 'mint(uint256)', redeem_underlying: 'redeemUnderlying(uint256)',
};
const MAX_REFERENCE_AGE_MS = 30 * 86_400_000;

export function approvalBranch(allowanceRaw: string | null, totalRaw: string):
  'none' | 'approve' | 'reset_then_approve' | 'unknown' {
  if (!/^\d+$/.test(totalRaw)) return 'unknown';
  const total = BigInt(totalRaw);
  if (total === 0n) return 'none';
  if (allowanceRaw === null || !/^\d+$/.test(allowanceRaw)) return 'unknown';
  const allowance = BigInt(allowanceRaw);
  return allowance >= total ? 'none' : allowance === 0n ? 'approve' : 'reset_then_approve';
}

function unknown(context: JusdtQuoteContext, action: CostEvidence['action'], amountRaw: string): CostEvidence {
  return costEvidenceSchema.parse({ action, basis: 'unknown', contextVersion: context.version,
    contractAddress: action === 'approve' || action === 'approve_zero'
      ? context.usdtAddress : context.jusdtAddress,
    selector: SELECTORS[action], amountRaw, energyUnits: null, bandwidthBytes: null,
    estimatedFeeSun: null, feeLimitSun: null, bandwidthBudgetSun: null,
    sources: [], referenceTxIds: [] });
}

/**
 * Resolve only already verified observations. The bundle calculator assigns free
 * Energy and Bandwidth in transaction order and fills estimatedFeeSun there.
 */
export function costEvidenceForAction(contextInput: JusdtQuoteContext,
  action: CostEvidence['action'], amountRaw: string,
  sampleSetsInput: ActionCostSampleSet[]): CostEvidence {
  const context = jusdtQuoteContextSchema.parse(contextInput);
  if (!/^\d+$/.test(amountRaw) || (action === 'approve_zero' ? BigInt(amountRaw) !== 0n : BigInt(amountRaw) === 0n)) {
    return unknown(context, action, /^\d+$/.test(amountRaw) ? amountRaw : '0');
  }
  const contractAddress = action === 'approve' || action === 'approve_zero'
    ? context.usdtAddress : context.jusdtAddress;
  const relevant = sampleSetsInput.flatMap(raw => {
    const parsed = actionCostSampleSetSchema.safeParse(raw);
    if (!parsed.success) return [];
    const set = parsed.data;
    if (set.action !== action || set.contractAddress !== contractAddress || set.selector !== SELECTORS[action]
      || Date.parse(set.validUntil) < Date.parse(context.validUntil)) return [];
    return [set];
  });
  const exact = relevant.flatMap(set => set.samples.filter(sample =>
    sample.basis === 'account_simulation' && sample.amountRaw === amountRaw
    && sample.txId === null && sample.source.mode === 'live'
    && Math.abs(Date.parse(context.observationWindow.endedAt) - Date.parse(sample.source.fetchedAt)) <= 60_000));
  let basis: CostEvidence['basis'] = 'unknown';
  let samples: ActionCostSampleSet['samples'] = [];
  if (exact.length > 0) {
    basis = 'account_simulation'; samples = exact;
  } else {
    const target = BigInt(amountRaw);
    const endedAt = Date.parse(context.observationWindow.endedAt);
    for (const set of relevant) {
      const reference = set.samples.filter(sample => {
        const age = endedAt - Date.parse(sample.source.sourceUpdatedAt ?? '');
        return sample.basis === 'reference_model' && sample.txId !== null
          && /^[0-9a-fA-F]{64}$/.test(sample.txId)
          && sample.source.mode === 'live' && age >= 0 && age <= MAX_REFERENCE_AGE_MS
          && (action === 'approve_zero' ? BigInt(sample.amountRaw) === 0n
            : BigInt(sample.amountRaw) * 2n >= target && BigInt(sample.amountRaw) <= target * 2n);
      });
      const unique = new Map(reference.map(sample => [sample.txId, sample]));
      // One code/model identity must independently supply the full evidence set.
      if (unique.size >= 5) {
        basis = 'reference_model'; samples = [...unique.values()]; break;
      }
    }
  }
  if (basis === 'unknown') return unknown(context, action, amountRaw);
  const energy = samples.reduce((high, sample) => BigInt(sample.energyUnits) > high ? BigInt(sample.energyUnits) : high, 0n);
  const bytes = samples.reduce((high, sample) => BigInt(sample.signedBytes) > high ? BigInt(sample.signedBytes) : high, 0n);
  if (energy === 0n || bytes === 0n) return unknown(context, action, amountRaw);
  const feeLimit = energy * 2n * BigInt(context.energyPriceSun);
  if (feeLimit > BigInt(context.maxFeeLimitSun)) return unknown(context, action, amountRaw);
  const bandwidthBudget = bytes * 2n * BigInt(context.bandwidthPriceSun);
  return costEvidenceSchema.parse({ action, basis, contextVersion: context.version,
    contractAddress, selector: SELECTORS[action], amountRaw, energyUnits: energy.toString(),
    bandwidthBytes: bytes.toString(), estimatedFeeSun: null,
    feeLimitSun: feeLimit.toString(), bandwidthBudgetSun: bandwidthBudget.toString(),
    sources: [...new Map(samples.map(sample => [sample.source.sourceUrl + sample.source.fetchedAt, sample.source])).values()],
    referenceTxIds: basis === 'reference_model' ? samples.map(sample => sample.txId!) : [],
  });
}
