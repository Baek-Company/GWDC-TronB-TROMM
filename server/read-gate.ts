export class ReadLimitError extends Error {
  readonly status = 429;
  constructor() { super('조회 요청이 많습니다. 잠시 후 다시 시도해 주세요.'); }
}

export function createReadGate(options: {
  maxConcurrent?: number; maxStartsPerMinute?: number; maxCacheEntries?: number; now?: () => number;
} = {}) {
  const maxConcurrent = options.maxConcurrent ?? 4;
  const maxStartsPerMinute = options.maxStartsPerMinute ?? 60;
  const maxCacheEntries = options.maxCacheEntries ?? 128;
  const now = options.now ?? Date.now;
  const resultCache = new Map<string, { until: number; value: unknown }>();
  const inFlightReads = new Map<string, Promise<unknown>>();
  let readStarts: number[] = [];

  // The cached value retains its original fetchedAt and data mode. A cache hit
  // must never be represented as a new live provider response.
  return function guardedRead<T>(key: string, ttlMs: number, read: () => Promise<T>): Promise<T> {
    const time = now();
    const cached = resultCache.get(key);
    if (cached && cached.until > time) return Promise.resolve(cached.value as T);
    const active = inFlightReads.get(key);
    if (active) return active as Promise<T>;
    readStarts = readStarts.filter(started => time - started < 60_000);
    if (inFlightReads.size >= maxConcurrent || readStarts.length >= maxStartsPerMinute) {
      throw new ReadLimitError();
    }
    readStarts.push(time);
    const pending = Promise.resolve().then(read).then(value => {
      if (resultCache.size >= maxCacheEntries) resultCache.delete(resultCache.keys().next().value!);
      resultCache.set(key, { until: now() + ttlMs, value });
      return value;
    });
    inFlightReads.set(key, pending);
    void pending.finally(() => { if (inFlightReads.get(key) === pending) inFlightReads.delete(key); }).catch(() => undefined);
    return pending;
  };
}
