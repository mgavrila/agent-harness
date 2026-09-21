import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { migrate, type ClientDocument, type ConfigSource, type LoadedDocument } from '@harness/config-api';
import { clientDocumentVersions, clientDocuments, withTransaction, type Db } from '@harness/db';
import { ConfigError, describeError, type Logger } from '@harness/shared';

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
 * Canonical JSON: the same object is the same string, whatever order its keys arrive in.
 *
 * The stored copy comes back through `jsonb`, which does not keep key order, so a plain
 * `JSON.stringify` comparison would call an identical rewrite a conflict roughly whenever
 * Postgres felt like it.
 *
 * One asymmetry, stated so the next reader does not introduce it: a property whose value is
 * explicitly `undefined` renders here as `null`, while a `jsonb` round trip drops the key
 * altogether — so such a document would compare unequal with itself. A parsed `ClientDocument`
 * has no such property (zod either fills a default or omits the key), which is why this is a note
 * and not a branch.
 */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Write a client's document as its current version, and record that version in the history.
 *
 * The platform's control plane is the real writer; this exists so that a test, the scaffolder and
 * an operator have one way to put a document in the store, and so that the history is never
 * written without the live row moving with it.
 *
 * **A version string is written once** (spec section 6, rule 3). Writing `(client_id, version)`
 * again with *different* content is refused: the history insert is `onConflictDoNothing`, so a
 * rewrite would otherwise move the live document and keep the old history — the one case where
 * the history lies. An identical rewrite stays a no-op, which is what the conformance suite
 * already asserts.
 *
 * The comparison is **inside the transaction, after the insert**, and that order is the whole of
 * why it is correct. The insert is what serialises two concurrent writers: the loser's
 * `ON CONFLICT DO NOTHING` waits for the winner to commit and then returns nothing, so the read
 * that follows it sees the winner's row and compares against a document that is really stored.
 * A read *before* the insert would have both writers see an empty table and decide against a
 * document neither of them had written.
 *
 * This rule binds the two writers differently and deliberately: the kernel's own writer enforces
 * it in code, and the platform's control plane — which writes the tables directly and gets a
 * refusal from nothing — is bound by the contract in spec section 6 alone. It writes content-hash
 * versions, so it cannot breach it by accident.
 */
export async function writeClientDocument(
  db: Db,
  document: ClientDocument,
  version: string,
  createdBy: string | null = null,
): Promise<void> {
  const row = { document: document as unknown as Record<string, unknown>, version };
  await withTransaction(db, async (tx) => {
    const inserted = await tx
      .insert(clientDocumentVersions)
      .values({ clientId: document.id, version, document: row.document, createdBy })
      .onConflictDoNothing()
      .returning({ id: clientDocumentVersions.id });
    if (inserted.length === 0) {
      const [stored] = await tx
        .select({ document: clientDocumentVersions.document })
        .from(clientDocumentVersions)
        .where(and(eq(clientDocumentVersions.clientId, document.id), eq(clientDocumentVersions.version, version)))
        .limit(1);
      if (stored && canonical(stored.document) !== canonical(row.document)) {
        throw new ConfigError(
          `client "${document.id}": version "${version}" is already stored with different content; a version string identifies one document, so write a new version rather than rewriting this one`,
        );
      }
    }
    await tx
      .insert(clientDocuments)
      .values({ clientId: document.id, schemaVersion: document.schemaVersion, ...row })
      .onConflictDoUpdate({
        target: clientDocuments.clientId,
        set: { schemaVersion: document.schemaVersion, ...row, updatedAt: new Date() },
      });
  });
}

/**
 * A row's `knowledge.path` is absolute or the document is refused.
 *
 * A directory source resolves a relative path against the client's own directory; a row has no
 * directory, so a relative path here is a document somebody wrote for the other source. Refusing
 * it names the fix; resolving it against the process's working directory would serve a tenant
 * whatever happened to be next to the host binary.
 */
function assertAbsoluteKnowledge(document: ClientDocument): ClientDocument {
  if (document.knowledge.source === 'dir' && !path.isAbsolute(document.knowledge.path)) {
    throw new ConfigError(
      `client "${document.id}": knowledge.path "${document.knowledge.path}" must be absolute in a stored document, because a row has no directory to be relative to`,
    );
  }
  return document;
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
    const document = assertAbsoluteKnowledge(migrate(row.document));
    // The same check the directory source makes of a document against the directory it sits in.
    // Only a corrupt write produces a mismatch, and what it produces is a tenant opened under one
    // key whose every row, audit line and routing claim names another — a boundary crossed by a
    // bad write rather than by a decision.
    if (document.id !== clientId) {
      throw new ConfigError(
        `the row keyed "${clientId}" holds a document that declares id "${document.id}"; a client's key and its document must name the same client`,
      );
    }
    return { document, version: row.version };
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
