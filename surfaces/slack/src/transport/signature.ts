import { createHmac, timingSafeEqual } from 'node:crypto';

/** Slack's signature version prefix, and the only one there has ever been. */
const VERSION = 'v0';

/**
 * How far a request's timestamp may be from this clock, in seconds.
 *
 * Five minutes, which is what Slack's own guidance says: long enough for a slow network and a
 * container whose clock drifted a little, short enough that a captured request is not a key.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

export type SignatureFailure = 'missing_signature' | 'bad_signature' | 'stale_timestamp';
export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

/** The signature a request with this body and this timestamp must carry. */
export function signRequest(secret: string, timestamp: string, body: string): string {
  return `${VERSION}=${createHmac('sha256', secret).update(`${VERSION}:${timestamp}:${body}`).digest('hex')}`;
}

/**
 * Is this request Slack's?
 *
 * HMAC-SHA256 over `v0:<timestamp>:<raw body>` with this app's signing secret, compared against
 * `X-Slack-Signature` in constant time. Nothing here parses the body and nothing here logs: the
 * whole point of verifying is that it happens before anything trusts a byte of what arrived
 * (invariant 15), and every input to this function is somebody else's.
 *
 * The clock is checked first. A replay of a request whose signature is perfectly valid is stale,
 * and reporting it as stale tells an operator to look at a clock or at a captured request, while
 * reporting it as a bad signature would send them to look at a secret that is fine.
 */
export function verifySignature(opts: {
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  secret: string;
  nowSeconds: number;
}): SignatureCheck {
  const signature = opts.signature ?? '';
  const timestamp = opts.timestamp ?? '';
  if (signature === '' || timestamp === '') return { ok: false, reason: 'missing_signature' };
  const sent = Number(timestamp);
  // A timestamp that is not a number cannot be inside any window, and it is the same failure as
  // one that is outside it: there is no moment this request claims to have been made at.
  if (!Number.isInteger(sent)) return { ok: false, reason: 'stale_timestamp' };
  if (Math.abs(opts.nowSeconds - sent) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const offered = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(signRequest(opts.secret, timestamp, opts.body), 'utf8');
  // Length first: `timingSafeEqual` throws on a mismatch, and a length is all that comparing them
  // can leak — which a caller who could measure the comparison would learn anyway.
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
