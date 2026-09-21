import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { EnvSource } from '@harness/shared';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function generateKey(): string {
  return randomBytes(32).toString('base64');
}

/**
 * The deployment's 32-byte key, off the environment it is handed.
 *
 * The map is a parameter rather than the ambient environment: this package is exempt from the
 * `process.env` rule, but taking the map is what makes a per-tenant key possible later and what
 * makes this function testable without a global.
 */
export function loadKey(env: EnvSource): Buffer {
  const b64 = env.HARNESS_ENCRYPTION_KEY;
  if (!b64) throw new Error('HARNESS_ENCRYPTION_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('HARNESS_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

/**
 * One envelope, `iv || tag || ciphertext`, with the IV supplied.
 *
 * Internal, and reachable from outside this package only through `@harness/db/testing`: the IV is
 * a parameter for exactly one reason, which is that the spec's vector fixes the bytes a fixed key,
 * IV and plaintext must produce, and the platform's control plane encrypts with its own code in
 * its own language. Asserting the vector from *this* side is what proves the two agree. `encrypt`
 * below is the only caller that ships, and it never reuses an IV because it never chooses one.
 */
export function encryptWith(plain: string, key: Buffer, iv: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function encrypt(plain: string, key: Buffer): Buffer {
  return encryptWith(plain, key, randomBytes(IV_BYTES));
}

export function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
