import type { ProductQuote, Source } from './schemas';

const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;

export function isCurrentInstant(value: string | null, now: Date, maxAgeMs: number): boolean {
  if (value === null) return false;
  const age = now.getTime() - Date.parse(value);
  return Number.isFinite(age) && age >= -MAX_FUTURE_SKEW_MS && age <= maxAgeMs;
}

// Direct RPC reads describe chain state at fetch time. Aggregated REST data must also
// identify when its underlying data was updated; fetching an old aggregate anew is not freshness.
export function isCurrentLiveSource(
  source: Source | null, chain: ProductQuote['chain'], now: Date, maxAgeMs: number,
): boolean {
  if (source === null || source.chain !== chain || source.mode !== 'live'
    || !isCurrentInstant(source.fetchedAt, now, maxAgeMs)) return false;
  if (source.sourceUpdatedAt !== null) return isCurrentInstant(source.sourceUpdatedAt, now, maxAgeMs);
  return source.accessMethod === 'rpc';
}
