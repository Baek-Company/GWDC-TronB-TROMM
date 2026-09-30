type Block = { blockID?: unknown; block_header?: { raw_data?: { number?: unknown; timestamp?: unknown } } };
type Transaction = { raw_data?: { ref_block_bytes?: unknown; ref_block_hash?: unknown;
  timestamp?: unknown; expiration?: unknown } };

const HEX_4 = /^[0-9a-f]{4}$/i;
const HEX_16 = /^[0-9a-f]{16}$/i;
const HEX_64 = /^[0-9a-f]{64}$/i;
const MAX_REF_BLOCK_DISTANCE = 64;
const MAX_HEAD_AGE_MS = 60_000;
const MAX_REF_BLOCK_AGE_MS = 5 * 60_000;
const MAX_TRANSACTION_EXPIRATION_MS = 10 * 60_000;

function verifiedBlock(value: unknown): { id: string; number: number; timestamp: number } {
  if (!value || typeof value !== 'object') throw new Error('Nile 기준 블록을 읽을 수 없습니다.');
  const block = value as Block;
  const id = block.blockID;
  const number = block.block_header?.raw_data?.number;
  const timestamp = block.block_header?.raw_data?.timestamp;
  if (typeof id !== 'string' || !HEX_64.test(id) ||
      typeof number !== 'number' || !Number.isSafeInteger(number) || number < 0 ||
      typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 ||
      BigInt(`0x${id.slice(0, 16)}`) !== BigInt(number)) {
    throw new Error('Nile 기준 블록의 ID·높이·시각이 일치하지 않습니다.');
  }
  return { id: id.toLowerCase(), number, timestamp };
}

/**
 * Bind a signed transaction's TAPOS reference to a recent block read from Nile itself.
 * The readBlock callback must be pinned to a Nile RPC; callers fail closed on an unavailable read.
 */
export async function verifyNileReferenceBlock(transaction: unknown, input: {
  readNowBlock: () => Promise<unknown>;
  readBlockByNumber: (number: number) => Promise<unknown>;
  now?: () => number;
}): Promise<void> {
  const now = input.now?.() ?? Date.now();
  const raw = (transaction as Transaction | null)?.raw_data;
  const bytes = raw?.ref_block_bytes;
  const hash = raw?.ref_block_hash;
  const timestamp = raw?.timestamp;
  const expiration = raw?.expiration;
  if (typeof bytes !== 'string' || !HEX_4.test(bytes) ||
      typeof hash !== 'string' || !HEX_16.test(hash) ||
      typeof expiration !== 'number' || !Number.isSafeInteger(expiration) ||
      expiration <= now || expiration > now + MAX_TRANSACTION_EXPIRATION_MS ||
      typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) ||
      timestamp < now - MAX_REF_BLOCK_AGE_MS || timestamp > now + 10_000 ||
      timestamp >= expiration) {
    throw new Error('서명 거래의 Nile 기준 블록·유효 시간을 확인할 수 없습니다.');
  }
  const head = verifiedBlock(await input.readNowBlock());
  if (head.timestamp < now - MAX_HEAD_AGE_MS || head.timestamp > now + 10_000) {
    throw new Error('Nile 최신 블록 시각이 오래되었거나 미래입니다.');
  }
  const referenceSuffix = Number.parseInt(bytes, 16);
  const distance = ((head.number & 0xffff) - referenceSuffix + 0x10000) % 0x10000;
  if (distance > MAX_REF_BLOCK_DISTANCE || distance > head.number) {
    throw new Error('서명 거래의 기준 블록이 Nile 최신 체인에서 너무 멉니다.');
  }
  const targetNumber = head.number - distance;
  const target = distance === 0 ? head : verifiedBlock(await input.readBlockByNumber(targetNumber));
  if (target.number !== targetNumber ||
      target.id.slice(12, 16) !== bytes.toLowerCase() ||
      target.id.slice(16, 32) !== hash.toLowerCase() ||
      target.timestamp > head.timestamp || target.timestamp < now - MAX_REF_BLOCK_AGE_MS) {
    throw new Error('서명 거래가 최근 Nile 기준 블록을 참조하지 않습니다.');
  }
}
