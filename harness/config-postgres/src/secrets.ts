import { and, eq } from 'drizzle-orm';
import { envSecretValue, type SecretSource } from '@harness/config-api';
import { clientSecrets, decrypt, encrypt, loadKey, type Db } from '@harness/db';
import { ConfigError, type EnvSource, type Logger } from '@harness/shared';

export interface PostgresSecretSourceOptions {
  db: Db;
  /** Where `HARNESS_ENCRYPTION_KEY` comes from, and where an `{ env }` reference is read. */
  env: EnvSource;
  log: Logger;
}

/**
 * Store one tenant's secret, encrypted with the deployment's key.
 *
 * The platform's control plane writes these rows itself, in its own transaction, against the
 * column contract in spec section 6; this exists so that a test, an operator and the runbook have
 * one way to put a secret in the store, and so that the kernel's own writer and the envelope it
 * writes are the ones the suite exercises. A second write of the same `(client_id, name)` is a
 * rotation and replaces the row — a secret has one current value, and a history of credentials is
 * a history of things that still open doors.
 *
 * **A rotation reaches a running tenant when that tenant next opens**, not when the row is
 * written: `resolveSecrets` runs once per open, so an already-open tenant keeps the value it
 * resolved until its document version moves or the host restarts. Onboarding needs no restart;
 * rotating does.
 */
export async function writeClientSecret(
  db: Db,
  secret: { clientId: string; name: string; value: string },
  key: Buffer,
): Promise<void> {
  const ciphertext = encrypt(secret.value, key);
  await db
    .insert(clientSecrets)
    .values({ clientId: secret.clientId, name: secret.name, ciphertext })
    .onConflictDoUpdate({
      target: [clientSecrets.clientId, clientSecrets.name],
      set: { ciphertext, updatedAt: new Date() },
    });
}

/**
 * Secrets from `client_secrets`: the source a pooled host runs.
 *
 * The key is loaded **once, here**, rather than per resolution: a deployment whose
 * `HARNESS_ENCRYPTION_KEY` is missing or the wrong length is a deployment that is wrong, and it
 * should fail where it is configured rather than on the first tenant that happens to name a
 * stored secret.
 *
 * Every message this raises names the client and the secret's *name*, never its value, never the
 * row and never the ciphertext (invariant 21) — and the client is added by `resolveSecrets`,
 * which is the only caller that knows which surface asked.
 */
export function postgresSecretSource(opts: PostgresSecretSourceOptions): SecretSource {
  const key = loadKey(opts.env);
  return {
    name: 'postgres',
    async resolve(clientId, ref) {
      // An `{ env }` reference means the environment under every source (spec section 4.10): a
      // document that mixes a stored bot token with a deployment-wide variable is the ordinary
      // case, not an error.
      if ('env' in ref) return envSecretValue(opts.env, ref.env);
      const [row] = await opts.db
        .select({ ciphertext: clientSecrets.ciphertext })
        .from(clientSecrets)
        // The tenant's own rows and no others. This predicate is invariant 21.
        .where(and(eq(clientSecrets.clientId, clientId), eq(clientSecrets.name, ref.ref)))
        .limit(1);
      if (!row) throw new ConfigError("this deployment's secret store holds no such secret for that client");
      try {
        return decrypt(row.ciphertext, key);
      } catch (err) {
        // The envelope did not open: a restored database, a rotated key, a corrupt row. The
        // line names the tenant and the *kind* of failure and not what the failure said — a
        // decryption error can carry the bytes it failed on, which is the reason the old version
        // of this line was wrong to write `describeError(err)` into it (invariant 21).
        const kind = err instanceof Error ? err.constructor.name : typeof err;
        opts.log.warn(`config-postgres: a stored secret for ${clientId} did not decrypt (${kind})`);
        throw new ConfigError(
          "this deployment's secret store holds a value that does not open with HARNESS_ENCRYPTION_KEY",
        );
      }
    },
  };
}
