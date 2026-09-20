# @harness/db

Schema, migrations, the connection pool and the encryption primitives. Everything else in the
workspace sits above this package; the one workspace package it imports is `@harness/shared`,
which sits below it.

## Layout

```
src/shared/crypto.ts    AES-256-GCM encrypt/decrypt, key loading
src/domain/schema.ts    every table, index and constraint — the drizzle-kit source of truth
src/domain/client.ts    createDb, withTransaction, the Db type
src/domain/migrate.ts   runMigrations
src/app/migrate.ts      the `pnpm --filter @harness/db migrate` entrypoint
src/index.ts            the public API
src/testing.ts          ./testing: TEST_DATABASE_URL, resetDatabase, useTestDb
```

The tables `schema.ts` declares, in the order it declares them:

| Table                                                          | What it holds                                                                                                                                              |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `records`                                                      | one row per thing a pack stores, keyed by `pack` and `kind`. Client-scoped.                                                                                |
| `documents`                                                    | an ingested file, its hash, its page count, and the record it belongs to                                                                                   |
| `attachments`                                                  | what hangs off a record: a kind, an issuer, dates, an encrypted number, `properties`                                                                       |
| `fields`                                                       | one name/value per record, plaintext or encrypted, with a confidence and a status                                                                          |
| `deadlines`                                                    | one row per attachment and deadline kind, with its due date                                                                                                |
| `approvals`, `runs`, `tool_effects`                            | the parked actions, the runs that produced them (each with the principal it acted as, and where it was started from), and the outbox                       |
| `model_calls`, `audit_log`                                     | what was asked of a model, and what every tool call did. `audit_log` is append-only.                                                                       |
| `memory_entries`                                               | one curated fact per row, in a principal's own scope or the client's                                                                                       |
| `playbooks`, `playbook_runs`                                   | the scheduled work read from the client document's `playbooks` section, and one row per firing                                                             |
| `threads`, `messages`                                          | one thread per conversation, and the turns on it                                                                                                           |
| `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` | the client's knowledge folder: one source, one row per markdown file, one row per retrievable passage with its `tsvector` and its `vector(1024)` embedding |
| `client_documents`, `client_document_versions`                 | (Plan 11a) the `postgres` `ConfigSource`: one live document per client, and every version it has had                                                       |
| `usage_runs` (view)                                            | (Plan 11a) per client, principal and day: run counts, tokens, cost, durations, approval counts — no content                                                |

There is no `providers` table and no `credentials` table: migration `0008` replaced them with
`records` and `attachments`, so one pair of tables serves every loaded pack and a pack ships no
migration of its own.

Logging, environment parsing and the error types come from `@harness/shared`, which sits below
this package in the graph and has no workspace dependency of its own.

## Public API

`@harness/db` exports every table and column helper from `domain/schema.ts`, plus `createDb`,
`withTransaction`, `type Db`, `runMigrations`, `encrypt`, `decrypt`, `loadKey` and
`generateKey`. `@harness/db/schema` is the schema module on its own, for drizzle tooling.
`@harness/db/testing` exports `TEST_DATABASE_URL`, `resetDatabase` and `useTestDb`.

`useTestDb()` lives here and only here. Two other packages used to keep a byte-identical copy;
the truncation list has to match `resetDatabase` exactly, and two copies is how they drift.

## Testing

```bash
pnpm --filter @harness/db test
```

Tests run against the real Postgres on `127.0.0.1:15432`, database `harness_test`, and
truncate between tests. The server needs pgvector 0.8 or newer — `knowledge_chunks` declares a
`vector` column, and knowledge search sets `hnsw.iterative_scan`, which 0.8.0 added — which is
what `pnpm db:up`'s `pgvector/pgvector:0.8.1-pg16` gives you. Do not source `.env` into your shell first: `crypto.test.ts` asserts
the behaviour of an unset `HARNESS_ENCRYPTION_KEY`.

## Migrations

Edit `src/domain/schema.ts`, then from this directory run `pnpm drizzle-kit generate` twice.
The second run must print "No schema changes". Never `--custom`: a hand-written migration is
absent from the snapshot and the next generate re-emits the same change forever.

`drizzle-kit generate` never writes `CREATE EXTENSION`, and no configuration makes it:
`extensionsFilters` takes only `postgis` and only filters introspection. An extension the schema
needs goes in `EXTENSIONS` in `src/domain/migrate.ts` instead, which `runMigrations` installs
before the migrator, idempotently, on every call — `vector` is the one entry, and migration 0013
declares `embedding vector(1024)`, which fails with `type "vector" does not exist` without it.
That statement needs a role that may create an extension, which the migrating owner is and the
application role must not be. `src/domain/migration-0013.test.ts` asserts both halves: the shipped
SQL fails on its own against a bare database, and `runMigrations` over the same database leaves
the extension installed and the three tables created.

`0008_generic_records` is the one migration with a hand-written data section, and the one with
no down migration. `docs/runbook.md`, "Migration 0008 and the record model", says why and what
to do if it has to be undone; `src/domain/migration-0008.test.ts` replays the shipped file over
a fixture of the pre-0008 schema on every run.

`0010_run_principal` adds `runs.principal_id` and backfills it from `caller` in a hand-written
data section before setting it `NOT NULL`; `src/domain/migration-0010.test.ts` replays it over a
fixture of the pre-0010 `runs` table.

`0014` (Plan 11a) adds `client_documents`, `client_document_versions` and the `usage_runs` view,
and adds a `NOT NULL` `client` column with no default to `attachments`, `deadlines`, `fields`,
`messages` and `playbook_runs` — a default would have filed every existing row under one tenant,
so this migration has no path from live data: `docs/runbook.md`, "Upgrading to Plan 11a", says the
database is recreated instead. `src/domain/migration-0014.test.ts` replays the shipped file onto a
fresh database, tenant columns and view included; `schema.test.ts` asserts the view's whole column
list against `information_schema`.
