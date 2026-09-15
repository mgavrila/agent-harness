import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadKey, generateKey } from './crypto.js';

describe('crypto', () => {
  const key = loadKey(generateKey());

  it('round-trips utf8 text', () => {
    const blob = encrypt('123-45-6789', key);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(decrypt(blob, key)).toBe('123-45-6789');
  });

  it('produces different ciphertext for the same input (random iv)', () => {
    expect(encrypt('x', key).equals(encrypt('x', key))).toBe(false);
  });

  it('throws on tampered ciphertext', () => {
    const blob = encrypt('secret', key);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, key)).toThrow();
  });

  it('throws on wrong key', () => {
    const blob = encrypt('secret', key);
    expect(() => decrypt(blob, loadKey(generateKey()))).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => loadKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(() => loadKey(undefined)).toThrow(/HARNESS_ENCRYPTION_KEY/);
  });
});
