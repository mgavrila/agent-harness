import { ConfigError, optionalEnv, type EnvSource, type Logger } from '@harness/shared';
import { surfaceSecretsOf, type ClientDocument, type SecretRef } from './document.js';
import type { ResolvedSecrets, SecretSource } from './types.js';

/**
 * What a reference that resolved to nothing is told.
 *
 * One clause for two faults that are the same fault: a variable this deployment did not set, and
 * a stored value that is there and is blank. "Empty is unset" is the rule `requiredEnv` and
 * `optionalEnv` already apply to every other setting in this repository, and a secret is the one
 * place breaking it is worst — an adapter handed an empty bearer opens, connects and fails at the
 * first message, with a transport error nobody can attribute.
 */
const UNSET = 'this deployment does not set it';

/**
 * A secret the environment holds, or a refusal naming nothing but the fact.
 *
 * Shared by both sources, because **an `{ env }` reference always means the environment**,
 * whichever source a deployment configured (spec section 4.10): a document that puts its bot
 * token in a store and its deployment-wide gateway key in a variable is the ordinary case rather
 * than an error.
 *
 * Empty is unset, which is the rule `requiredEnv` and `optionalEnv` already follow, and the
 * message is a clause rather than a sentence — `resolveSecrets` writes the sentence, because it
 * is the only caller that knows which surface and which field asked.
 */
export function envSecretValue(env: EnvSource, name: string): string {
  const value = optionalEnv(name, env);
  if (value === undefined) throw new ConfigError(UNSET);
  return value;
}

/**
 * Today's behaviour, as a source: every secret is an environment variable.
 *
 * A `{ ref }` is refused with the clause Plan 11c inherited from Task 1 — "this deployment has no
 * secret source" — which reads as what it means: this deployment has no secret *store*, so a
 * document that names an entry in one cannot be served here. Configuring
 * `HARNESS_SECRET_SOURCE=postgres` is the fix, and the message stays verbatim because it is the
 * sentence an operator has already seen once.
 */
export function envSecretSource(env: EnvSource): SecretSource {
  return {
    name: 'env',
    // Not `async`: there is nothing here to await, and this repository's lint treats an `async`
    // that awaits nothing in shipping code as a signature nobody checked. Deferring through a
    // resolved promise is what keeps the contract instead — `resolve` promises a promise, so a
    // refusal has to be a rejection and not a synchronous throw, which is what the conformance
    // suite asserts on.
    resolve: (_clientId, ref) =>
      Promise.resolve().then(() => {
        if ('ref' in ref) throw new ConfigError('this deployment has no secret source');
        return envSecretValue(env, ref.env);
      }),
  };
}

/** Where a reference was declared, in the two shapes a refusal needs it. */
interface SecretSite {
  /** `web.token`, `routing.gateway.key`: what a store reference's refusal points at. */
  readonly where: string;
  /** `declares the "web" surface`: what an environment reference's refusal says of the document. */
  readonly declares: string;
}

/**
 * What a broken source's error *is*, with nothing that it says.
 *
 * A constructor name and a `code` are enough to tell a refused connection from a timeout from a
 * decryption failure, and neither can carry a connection string, a statement fragment or a value.
 * `describeError` is deliberately not used here: it answers the message, which is the one part of
 * a driver's error that must never be written down (invariant 21).
 */
function kindOf(err: unknown): string {
  const name = err instanceof Error ? err.constructor.name : typeof err;
  const code = (err as { code?: unknown } | null | undefined)?.code;
  return typeof code === 'string' || typeof code === 'number' ? `${name} (${code})` : name;
}

/**
 * The source's own clause, and only when the source meant it to be read.
 *
 * A `ConfigError` from a source is a sentence about a *reference*, written to be shown. Anything
 * else is a driver, a socket or a decryption failure, and those carry fragments of statements and
 * of values — so neither the caller's message nor **the log line** repeats what it said. The log
 * gets one fixed sentence and the error's kind; `log.ts` states the rule this follows, and
 * invariant 21 names logs explicitly.
 *
 * The error is not passed as the logger's second argument either: `createLogger` appends
 * `describeError` of it, which would put the message back in the line it was kept out of.
 */
function clauseOf(err: unknown, source: SecretSource, log: Logger): string {
  if (err instanceof ConfigError) return err.message;
  log.error(`the "${source.name}" secret source failed: ${kindOf(err)}`);
  return `the "${source.name}" secret source failed`;
}

/**
 * One reference, resolved and checked, or a `ConfigError` naming the client, the place and the
 * reason.
 *
 * The two messages are the ones Plan 11a and Task 1 shipped, byte for byte, because an operator
 * who has seen one of them should not have to learn a second wording for the same fault.
 *
 * **A value that is blank is a value nobody set**, and it is refused here rather than in a source
 * for two reasons. It is the only place every source passes through, so the guarantee an adapter
 * relies on — `secretValues` never carries an empty string — holds for a source nobody in this
 * repository wrote. And the clause is right here and would be wrong there: a blank row *is* a row,
 * so a store's own "holds no such secret for that client" would be untrue, where "this deployment
 * does not set it" is exactly what happened.
 */
async function resolveAt(
  client: string,
  site: SecretSite,
  ref: SecretRef,
  deps: { source: SecretSource; log: Logger },
): Promise<string> {
  try {
    const value = await deps.source.resolve(client, ref);
    // Trimmed only to decide; the value itself is handed on untouched, because a token is opaque
    // bytes and one with a space at either end is a token somebody meant to store.
    if (value.trim() === '') throw new ConfigError(UNSET);
    return value;
  } catch (err) {
    const clause = clauseOf(err, deps.source, deps.log);
    throw new ConfigError(
      'ref' in ref
        ? `client "${client}" names the secret "${ref.ref}" for ${site.where}, and ${clause}`
        : `client "${client}" ${site.declares}, which needs ${ref.env}; ${clause}`,
    );
  }
}

/**
 * Every secret this document names, resolved to its value, before anything else is built.
 *
 * It replaces `assertSecretsPresent` and it runs **before** `buildKernelConfig`, which is a move:
 * a deployment whose secret source is broken should be told that before it is told anything about
 * its gateway, and section 4.11's per-tenant gateway key needs the resolved map *inside*
 * `buildKernelConfig`. Running here is also what makes "add a tenant with no restart" true — a
 * pooled host opens a new tenant on its first request and resolves its secrets then.
 *
 * It reads the typed surface sections through `surfaceSecretsOf`, which is what keeps every
 * vendor's field name out of `harness/host/src`: the host copies opaque `surface` and `field`
 * strings from this map into the bag an adapter is handed.
 */
export async function resolveSecrets(
  document: ClientDocument,
  deps: { source: SecretSource; log: Logger },
): Promise<ResolvedSecrets> {
  const surfaces: Record<string, Record<string, string>> = {};
  for (const ref of surfaceSecretsOf(document)) {
    const value = await resolveAt(
      document.id,
      { where: `${ref.surface}.${ref.field}`, declares: `declares the "${ref.surface}" surface` },
      // Narrowed back to the reference itself: `surface` and `field` are this file's bookkeeping
      // and are no business of a source's.
      'env' in ref ? { env: ref.env } : { ref: ref.ref },
      deps,
    );
    surfaces[ref.surface] = { ...surfaces[ref.surface], [ref.field]: value };
  }
  const gateway = document.routing.gateway;
  if (!gateway) return { surfaces };
  const gatewayKey = await resolveAt(
    document.id,
    { where: 'routing.gateway.key', declares: 'declares a gateway key' },
    gateway.key,
    deps,
  );
  return { surfaces, gatewayKey };
}
