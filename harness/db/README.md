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
truncate between tests. Do not source `.env` into your shell first: `crypto.test.ts` asserts
the behaviour of an unset `HARNESS_ENCRYPTION_KEY`.

## Migrations

Edit `src/domain/schema.ts`, then from this directory run `pnpm drizzle-kit generate` twice.
The second run must print "No schema changes". Never `--custom`: a hand-written migration is
absent from the snapshot and the next generate re-emits the same change forever.
