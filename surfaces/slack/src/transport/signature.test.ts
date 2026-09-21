import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_WINDOW_SECONDS, signRequest, verifySignature } from './signature.js';

const SECRET = 'a-signing-secret';
const BODY = '{"type":"event_callback"}';
const NOW = 1_789_000_000;
const stamp = String(NOW);

const check = (over: Partial<Parameters<typeof verifySignature>[0]> = {}): ReturnType<typeof verifySignature> =>
  verifySignature({
    signature: signRequest(SECRET, stamp, BODY),
    timestamp: stamp,
    body: BODY,
    secret: SECRET,
    nowSeconds: NOW,
    ...over,
  });

describe('verifySignature', () => {
  it('accepts a request signed with this app s secret', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('computes the digest Slack documents, over v0:<timestamp>:<body>', () => {
    // Written out rather than taken from `signRequest`, so the two cannot drift together.
    const expected = `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${BODY}`).digest('hex')}`;
    expect(signRequest(SECRET, stamp, BODY)).toBe(expected);
  });

  it('refuses a request with neither header, and with only one of them', () => {
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ signature: '' })).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('refuses a signature over a different body, a different secret or a different timestamp', () => {
    expect(check({ body: `${BODY} ` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check({ secret: 'another-secret' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check({ signature: signRequest(SECRET, String(NOW - 1), BODY) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(check({ signature: 'v0=short' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a replay outside the window, in either direction, and a timestamp that is not one', () => {
    const outside = SIGNATURE_WINDOW_SECONDS + 1;
    for (const at of [NOW + outside, NOW - outside]) {
      expect(check({ nowSeconds: at }), String(at)).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
    // Inside the window in both directions, so the bound is a window and not a deadline.
    for (const at of [NOW + SIGNATURE_WINDOW_SECONDS, NOW - SIGNATURE_WINDOW_SECONDS]) {
      expect(check({ nowSeconds: at }), String(at)).toEqual({ ok: true });
    }
    expect(check({ timestamp: 'now' })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('checks the clock before the digest, so a valid replay is reported as the replay it is', () => {
    // A request that is perfectly signed and hours old is stale, not unsigned: saying `stale`
    // tells an operator their clock or their attacker, and saying `bad` tells them neither.
    expect(check({ nowSeconds: NOW + 86_400 })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});
