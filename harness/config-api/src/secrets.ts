import { ConfigError, describeError, optionalEnv, type EnvSource, type Logger } from '@harness/shared';
import { surfaceSecretsOf, type ClientDocument, type SecretRef, type SurfaceSecretRef } from './document.js';
import type { ResolvedSecrets, SecretSource } from './types.js';

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
  if (value === undefined) throw new ConfigError('this deployment does not set it');
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
    // that awaits nothing in shipping code as a signature nobody checked. The executor is what
    // keeps the contract instead — `resolve` promises a promise, so a refusal has to be a
    // rejection and not a synchronous throw, which is what the conformance suite asserts on.
    resolve: (_clientId, ref) =>
      new Promise<string>((answer) => {
        if ('ref' in ref) throw new ConfigError('this deployment has no secret source');
        answer(envSecretValue(env, ref.env));
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
 * The source's own clause, and only when the source meant it to be read.
 *
 * A `ConfigError` from a source is a sentence about a *reference*, written to be shown. Anything
 * else is a driver, a socket or a decryption failure, and those carry fragments of statements and
 * of values (invariant 21), so the original goes to the log and the caller gets a clause naming
 * the source and nothing else.
 */
function clauseOf(err: unknown, source: SecretSource, log: Logger): string {
  if (err instanceof ConfigError) return err.message;
  log.error(`the "${source.name}" secret source failed: ${describeError(err)}`, err);
  return `the "${source.name}" secret source failed`;
}

/**
 * One reference, resolved, or a `ConfigError` naming the client, the place and the reason.
 *
 * The two messages are the ones Plan 11a and Task 1 shipped, byte for byte, because an operator
 * who has seen one of them should not have to learn a second wording for the same fault.
 */
async function resolveAt(
  client: string,
  site: SecretSite,
  ref: SecretRef,
  deps: { source: SecretSource; log: Logger },
): Promise<string> {
  try {
    return await deps.source.resolve(client, ref);
  } catch (err) {
    const clause = clauseOf(err, deps.source, deps.log);
    throw new ConfigError(
      'ref' in ref
        ? `client "${client}" names the secret "${ref.ref}" for ${site.where}, and ${clause}`
        : `client "${client}" ${site.declares}, which needs ${ref.env}; ${clause}`,
    );
  }
}

/** The site a surface's reference was declared at, in both shapes. */
function surfaceSite(ref: SurfaceSecretRef): SecretSite {
  return { where: `${ref.surface}.${ref.field}`, declares: `declares the "${ref.surface}" surface` };
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
      surfaceSite(ref),
      'env' in ref ? { env: ref.env } : { ref: ref.ref },
      deps,
    );
    surfaces[ref.surface] = { ...surfaces[ref.surface], [ref.field]: value };
  }
  return { surfaces };
}
