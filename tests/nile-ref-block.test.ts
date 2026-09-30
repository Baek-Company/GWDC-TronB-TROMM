import { describe, expect, it, vi } from 'vitest';
import { verifyNileReferenceBlock } from '../server/agent/nile-ref-block';

const now = Date.parse('2026-09-30T03:00:00.000Z');
function block(number: number, timestamp: number, hash = 'ab'.repeat(24)) {
  return { blockID: `${number.toString(16).padStart(16, '0')}${hash}`,
    block_header: { raw_data: { number, timestamp } } };
}
const head = block(10_000, now - 3_000, 'cd'.repeat(24));
const reference = block(9_999, now - 6_000);
function signed(overrides: Record<string, unknown> = {}) {
  return { raw_data: {
    ref_block_bytes: reference.blockID.slice(12, 16),
    ref_block_hash: reference.blockID.slice(16, 32),
    timestamp: now - 2_000, expiration: now + 40_000, ...overrides,
  } };
}
function verify(transaction: unknown, latest: unknown = head, target: unknown = reference) {
  const readBlockByNumber = vi.fn(async () => target);
  return { result: verifyNileReferenceBlock(transaction, {
    readNowBlock: async () => latest, readBlockByNumber, now: () => now,
  }), readBlockByNumber };
}

describe('Nile signed-transaction reference block', () => {
  it('accepts only a recent Nile block with matching reference bytes and hash', async () => {
    const valid = verify(signed());
    await expect(valid.result).resolves.toBeUndefined();
    expect(valid.readBlockByNumber).toHaveBeenCalledExactlyOnceWith(9_999);
    await expect(verify(signed({ ref_block_hash: 'ff'.repeat(8) })).result)
      .rejects.toThrow('최근 Nile 기준 블록');
    await expect(verify(signed(), head, block(9_999, now - 6_000, '11'.repeat(24))).result)
      .rejects.toThrow('최근 Nile 기준 블록');
  });

  it('rejects stale heads, missing target blocks, changed heights, and far references', async () => {
    await expect(verify(signed(), block(10_000, now - 61_000)).result).rejects.toThrow('오래되었거나');
    await expect(verify(signed(), head, {}).result).rejects.toThrow('기준 블록의 ID');
    await expect(verify(signed(), head, block(9_998, now - 6_000)).result)
      .rejects.toThrow('최근 Nile 기준 블록');
    await expect(verify(signed({ ref_block_bytes: (10_000 - 65).toString(16).padStart(4, '0') })).result)
      .rejects.toThrow('너무 멉니다');
    await expect(verifyNileReferenceBlock(signed(), {
      readNowBlock: async () => head,
      readBlockByNumber: async () => { throw new Error('Nile RPC unavailable'); }, now: () => now,
    })).rejects.toThrow('Nile RPC unavailable');
  });

  it('rejects expired or long-lived signatures and handles the 16-bit reference rollover', async () => {
    await expect(verify(signed({ expiration: now - 1 })).result).rejects.toThrow('유효 시간');
    await expect(verify(signed({ expiration: now + 11 * 60_000 })).result).rejects.toThrow('유효 시간');
    await expect(verify(signed({ timestamp: now - 6 * 60_000 })).result).rejects.toThrow('유효 시간');
    const rolloverHead = block(65_538, now - 3_000);
    const rolloverReference = block(65_535, now - 12_000);
    const rollover = verify(signed({
      ref_block_bytes: rolloverReference.blockID.slice(12, 16),
      ref_block_hash: rolloverReference.blockID.slice(16, 32),
    }), rolloverHead, rolloverReference);
    await expect(rollover.result).resolves.toBeUndefined();
    expect(rollover.readBlockByNumber).toHaveBeenCalledExactlyOnceWith(65_535);
  });
});
