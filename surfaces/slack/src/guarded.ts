import { describeError, SurfaceError } from '@harness/shared';

/** This adapter's name, as a client document names it and as `approvals.surface` stores it. */
export const NAME = 'slack';

/**
 * Run one Web API call and turn whatever it throws into a `SurfaceError`.
 *
 * Every method on the contract promises a `SurfaceError` whose message is safe to write into
 * `tool_effects.last_error`, which is plaintext and which an operator pastes into a ticket. The
 * SDK's own rejection is not that: it is a `WebAPIPlatformError` the kernel would mask, and an
 * unwrapped network failure carries a stack. So the message is the surface, the operation, and
 * the underlying message — `op` is the API method's name and never the arguments, so no card
 * text, no note, no filename and no channel can travel in it.
 */
export async function guarded<T>(op: string, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (err) {
    throw new SurfaceError(`${NAME}: ${op} failed: ${describeError(err)}`);
  }
}
