import { describe, expect, it } from 'vitest';
import { TronWeb } from 'tronweb';
import { normalizeTronAddress } from '../src/lib/tron-address';
import { normalizeTronAddress as normalizeSharedTronAddress } from '../shared/tron-address';
import { jusdtQuoteContextSchema } from '../shared/schemas';

const address = 'TXLAQ63Xg1NAzckPwKHvzw7CSEmLMEqcdj';

describe('lightweight TRON wallet address validation', () => {
  it('matches TronWeb for valid Base58Check and hex addresses', () => {
    expect(TronWeb.isAddress(address)).toBe(true);
    expect(normalizeTronAddress(address)).toBe(address);
    expect(normalizeTronAddress(TronWeb.address.toHex(address))).toBe(address);
  });

  it('rejects a changed checksum and the wrong network prefix', () => {
    const altered = `${address.slice(0, -1)}${address.endsWith('1') ? '2' : '1'}`;
    expect(TronWeb.isAddress(altered)).toBe(false);
    expect(normalizeTronAddress(altered)).toBeNull();
    expect(normalizeTronAddress(`42${TronWeb.address.toHex(address).slice(2)}`)).toBeNull();
  });

  it('matches TronWeb and the shared schema across valid representations and malformed input', () => {
    const hex = TronWeb.address.toHex(address);
    const valid = [address, hex, hex.toUpperCase(), ...Array.from({ length: 16 }, (_, index) =>
      `41${index.toString(16).padStart(40, '0')}`)];
    const invalid = [
      '', ' ', ` ${address}`, `${address}\n`, address.toLowerCase(),
      `${address.slice(0, -1)}${address.endsWith('1') ? '2' : '1'}`,
      `0x${hex}`, hex.slice(2), `42${hex.slice(2)}`, hex.slice(0, -1), `${hex}0`,
      'T111111111111111111111111111111111', 'not-a-tron-address',
    ];

    for (const value of valid) {
      expect(TronWeb.isAddress(value)).toBe(true);
      expect(normalizeSharedTronAddress(value)).toBe(TronWeb.address.fromHex(value));
      expect(normalizeTronAddress(value)).toBe(normalizeSharedTronAddress(value));
      expect(jusdtQuoteContextSchema.shape.walletAddress.safeParse(value).success).toBe(true);
    }
    for (const value of invalid) {
      expect(TronWeb.isAddress(value)).toBe(false);
      expect(normalizeSharedTronAddress(value)).toBeNull();
      expect(jusdtQuoteContextSchema.shape.walletAddress.safeParse(value).success).toBe(false);
    }
  });
});
