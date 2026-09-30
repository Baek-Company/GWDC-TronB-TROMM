import { sha256 } from '@noble/hashes/sha256';
import { base58check } from '@scure/base';

const tronBase58 = base58check(sha256);

// A TRON account is 0x41 followed by 20 bytes. Base58 addresses must also
// have a valid double-SHA256 checksum; accepting a matching prefix alone is unsafe.
export function normalizeTronAddress(value: string): string | null {
  try {
    const bytes = /^41[\da-f]{40}$/i.test(value)
      ? Uint8Array.from(value.match(/../g)!, part => Number.parseInt(part, 16))
      : tronBase58.decode(value);
    return bytes.length === 21 && bytes[0] === 0x41 ? tronBase58.encode(bytes) : null;
  } catch { return null; }
}
