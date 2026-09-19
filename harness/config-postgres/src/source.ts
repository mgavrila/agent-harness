import { eq } from 'drizzle-orm';
import { migrate, type ClientDocument, type ConfigSource, type LoadedDocument } from '@harness/config-api';
import { clientDocumentVersions, clientDocuments, type Db } from '@harness/db';
import { describeError, type Logger } from '@harness/shared';

/**
 * How often a watching host asks whether a client's version has moved.
 *
 * A module constant rather than a variable: a poll interval is not something a deployment gets
 * right by guessing, thirty seconds is inside anybody's tolerance for a config change, and a new
 * environment variable would be one more thing for the environment scan and `.env.example` to
 * carry for no decision anybody wants to make.
 */
export const CONFIG_POLL_MS = 30_000;

export interface PostgresConfigSourceOptions {
  db: Db;
  log: Logger;
  pollMs?: number;
}

/**
 * Write a client's document as its current version, and record that version in the history.
 *
 * The platform's control plane is the real writer; this exists so that a test, the scaffolder and
 * an operator have one way to put a document in the store, and so that the history is never
 * written without the live row moving with it.
 */
export async function writeClientDocument(
  db: Db,
  document: ClientDocument,
  version: string,
  createdBy: string | null = null,
): Promise<void> {
  const row = { document: document as unknown as Record<string, unknown>, version };
  await db
    .insert(clientDocuments)
    .values({ clientId: document.id, schemaVersion: document.schemaVersion, ...row })
    .onConflictDoUpdate({
      target: clientDocuments.clientId,
      set: { schemaVersion: document.schemaVersion, ...row, updatedAt: new Date() },
    });
  await db
    .insert(clientDocumentVersions)
    .values({ clientId: document.id, version, document: row.document, createdBy })
    .onConflictDoNothing();
}

/**
 * Client documents from versioned rows: the source a pooled host runs.
 *
 * The row is validated again on load. A store the platform writes to is not a store the kernel
 * trusts — a document that reached the table through some other path, or through an older
 * schema, is refused here rather than half-serving a tenant.
 */
export function postgresConfigSource(opts: PostgresConfigSourceOptions): ConfigSource {
  const pollMs = opts.pollMs ?? CONFIG_POLL_MS;

  const read = async (clientId: string): Promise<LoadedDocument | null> => {
    const [row] = await opts.db
      .select({ document: clientDocuments.document, version: clientDocuments.version })
      .from(clientDocuments)
      .where(eq(clientDocuments.clientId, clientId))
      .limit(1);
    if (!row) return null;
    return { document: migrate(row.document), version: row.version };
  };

  return {
    name: 'postgres',

    async load(clientId) {
      return read(clientId);
    },

    watch(clientId, onChange) {
      let last: string | null = null;
      const tick = (): void => {
        void opts.db
          .select({ version: clientDocuments.version })
          .from(clientDocuments)
          .where(eq(clientDocuments.clientId, clientId))
          .limit(1)
          .then(([row]) => {
            if (!row) return;
            if (last === null) {
              last = row.version;
              return;
            }
            if (row.version === last) return;
            last = row.version;
            onChange(row.version);
          })
          .catch((err: unknown) => {
            opts.log.warn(`config-postgres: could not read ${clientId}'s version: ${describeError(err)}`);
          });
      };
      tick();
      const timer = setInterval(tick, pollMs);
      timer.unref?.();
      return () => clearInterval(timer);
    },

    async list() {
      const rows = await opts.db.select({ clientId: clientDocuments.clientId }).from(clientDocuments);
      return rows.map((row) => row.clientId).sort();
    },
  };
}
