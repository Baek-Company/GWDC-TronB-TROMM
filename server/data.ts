import { parseMarkets, type MarketSnapshot } from '../shared/markets';
import { NILE_RPC } from './data/tron-rpc';

export const JUSTLEND_URL = 'https://openapi.just.network/lend/jtoken';
export { NILE_RPC };
let cached: MarketSnapshot | undefined;
let inFlight: Promise<MarketSnapshot> | undefined;

export async function readMarkets(force = false): Promise<MarketSnapshot> {
  if (!force && cached && Date.now() - Date.parse(cached.fetchedAt) < 30_000) return cached;
  if (inFlight) return inFlight;
  inFlight = (async () => {
    const response = await fetch(JUSTLEND_URL, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`JustLend HTTP ${response.status}`);
    const markets = parseMarkets(await response.json());
    const snapshot: MarketSnapshot = {
      source: JUSTLEND_URL, network: 'mainnet', fetchedAt: new Date().toISOString(),
      sourceUpdatedAt: null, mode: 'live', markets,
    };
    cached = snapshot;
    return snapshot;
  })();
  try { return await inFlight; } finally { inFlight = undefined; }
}

export async function readNileBlock() {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (process.env.TRONGRID_API_KEY) headers['TRON-PRO-API-KEY'] = process.env.TRONGRID_API_KEY;
  const response = await fetch(`${NILE_RPC}/wallet/getnowblock`, {
    method: 'POST', headers, body: '{}', signal: AbortSignal.timeout(12_000),
  });
  if (!response.ok) throw new Error(`Nile HTTP ${response.status}`);
  const data = await response.json() as { block_header?: { raw_data?: { number?: number; timestamp?: number } } };
  const block = data.block_header?.raw_data;
  if (!block || !Number.isSafeInteger(block.number) || !Number.isSafeInteger(block.timestamp)) {
    throw new Error('Nile block schema mismatch');
  }
  return { source: NILE_RPC, network: 'nile', block: block.number, blockTime: new Date(block.timestamp!).toISOString(), fetchedAt: new Date().toISOString() };
}
