# Plan 1: Foundation — Workspace, Database, Policy-Wrapped Core Tools

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A running MCP server (`core-tools`) over stdio whose every tool call passes through the action-class policy and lands in an append-only audit log, with the providers, deadlines, and audit toolsets working against Postgres.

**Architecture:** pnpm workspace with two packages. `@harness/db` owns the Drizzle schema, migrations, the Postgres client, and AES-GCM encryption for restricted columns. `@harness/core-tools` owns a `defineTool` registry that wraps each handler with policy (auto, approval, blocked) and audit before registering it on an `McpServer`, plus the toolsets. Tests drive the real server in-process through `createMcpHandler` and a `Client`, against a `harness_test` database in the Compose Postgres.

**Tech Stack:** Node 22+, pnpm 11, TypeScript 5, zod v4, `@modelcontextprotocol/server` 2.x and `@modelcontextprotocol/client` 2.x, drizzle-orm + drizzle-kit, `pg`, vitest 5, tsx, Postgres 16 in Docker Compose.

**Spec:** `docs/superpowers/specs/2026-09-15-agent-harness-credentialing-design.md` (sections 4.3, 4.5, 4.6, 6, 8, 10).

## Plan series

This spec is delivered in three plans. Each one ends with software that runs and is tested on its own.

| Plan | Delivers | Spec sections |
|---|---|---|
| **1 (this plan)** | Workspace, Postgres schema and migrations, encryption, policy + audit wrapper, providers/deadlines/audit toolsets, stdio entrypoint | 4.3, 4.5 (table only), 4.6, 6, 10 |
| 2 | Model gateway (LiteLLM compose service and routing.yaml), document pipeline (ingest, OCR, redact, extract), verify (NPPES), synthetic data generator, extraction and injection evals | 4.2, 4.4, 7, 8 |
| 3 | Hermes compose service and client config, SOUL, four skills, Slack approvals app, forms toolset, approvals execute, nightly playbook, new-client scaffold, demo script | 4.1, 4.5, 4.7, 4.8, 5, 9 |

## Global Constraints

- Node `>=22`, pnpm `11.x`, TypeScript `strict: true`, ESM only (`"type": "module"`).
- zod is imported as `import * as z from 'zod/v4'` everywhere (the MCP SDK v2 requires zod v4 schemas).
- MCP tool names use underscores, never dots: `providers_upsert`, not `providers.upsert`.
- Action classes are exactly: `read`, `write.internal`, `external`, `financial`, `destructive`.
- Default policy: read=auto, write.internal=auto, external=approval, financial=blocked, destructive=approval.
- Field statuses are exactly: `pending`, `extracted`, `verified`, `rejected`. Confidence threshold default `0.85`.
- Restricted values (SSN, EIN, DEA numbers, credential numbers) are stored only in `bytea` encrypted columns; the plaintext column stays null.
- `audit_log` is append-only; a trigger rejects UPDATE and DELETE.
- Secrets only in `.env`; `.env.example` documents every variable. `.env` is gitignored.
- Every commit message ends with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`. Commit identity is repo-local: `Andrei Gavrila <andrei.gavrila94@gmail.com>`.
- Tests that touch the database run serially (`fileParallelism: false`) and truncate all tables in `beforeEach`.

## File structure

```
agent-harness/
  package.json                      workspace root scripts
  pnpm-workspace.yaml
  tsconfig.base.json
  .nvmrc
  .env.example
  harness/
    compose/
      docker-compose.yml            postgres only in this plan
      postgres/init.sql             creates harness_test
    db/
      package.json                  @harness/db
      tsconfig.json
      drizzle.config.ts
      vitest.config.ts
      drizzle/                      generated SQL migrations (committed)
      src/
        schema.ts                   all tables
        client.ts                   createDb()
        migrate.ts                  runMigrations()
        crypto.ts                   encrypt/decrypt/loadKey
        testing.ts                  TEST_DATABASE_URL, resetDatabase()
        test-global-setup.ts        migrate harness_test once per vitest run
        index.ts                    re-exports
        schema.test.ts
        crypto.test.ts
    core-tools/
      package.json                  @harness/core-tools
      tsconfig.json
      vitest.config.ts
      src/
        policy.ts                   ActionClass, Policy, decide(), parsePolicy(), loadPolicy()
        audit.ts                    writeAudit()
        registry.ts                 defineTool(), registerTools(), ToolDeps
        server.ts                   createCoreToolsServer(deps)
        main.ts                     stdio entrypoint
        testing.ts                  makeTestDeps(), makeTestClient()
        test-global-setup.ts
        deadlines/compute.ts        pure date math
        tools/providers.ts
        tools/deadlines.ts
        tools/audit.ts
        policy.test.ts
        registry.test.ts
        deadlines/compute.test.ts
        tools/providers.test.ts
        tools/deadlines.test.ts
        tools/audit.test.ts
        main.test.ts                stdio smoke test
```

---

### Task 1: Workspace scaffold and Postgres

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `.nvmrc`, `.env.example`
- Create: `harness/compose/docker-compose.yml`, `harness/compose/postgres/init.sql`
- Modify: `.gitignore` (add `node_modules/`, `dist/`)

**Interfaces:**
- Produces: `pnpm test` and `pnpm typecheck` run across all workspace packages; `pnpm db:up` starts Postgres with databases `harness` and `harness_test`; root scripts other tasks call.

- [ ] **Step 1: Write the root package.json**

```json
{
  "name": "agent-harness",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.4.0",
  "engines": { "node": ">=22" },
  "scripts": {
    "test": "pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "db:up": "docker compose -f harness/compose/docker-compose.yml up -d postgres",
    "db:down": "docker compose -f harness/compose/docker-compose.yml down",
    "db:migrate": "pnpm --filter @harness/db migrate"
  }
}
```

- [ ] **Step 2: Write pnpm-workspace.yaml, tsconfig.base.json, .nvmrc**

`pnpm-workspace.yaml`:
```yaml
packages:
  - 'harness/*'
  - 'evals'
```

`tsconfig.base.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "types": ["node"],
    "noEmit": true
  }
}
```

`.nvmrc`:
```
22
```

- [ ] **Step 3: Write the Compose file and Postgres init script**

`harness/compose/docker-compose.yml`:
```yaml
services:
  postgres:
    image: postgres:16
    environment:
      POSTGRES_USER: harness
      POSTGRES_PASSWORD: harness
      POSTGRES_DB: harness
    ports:
      - "5432:5432"
    volumes:
      - pgdata:/var/lib/postgresql/data
      - ./postgres/init.sql:/docker-entrypoint-initdb.d/01-init.sql:ro
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U harness -d harness"]
      interval: 5s
      timeout: 3s
      retries: 10

volumes:
  pgdata: {}
```

`harness/compose/postgres/init.sql`:
```sql
CREATE DATABASE harness_test;
```

- [ ] **Step 4: Write .env.example and extend .gitignore**

`.env.example`:
```
# Postgres (docker compose defaults)
DATABASE_URL=postgres://harness:harness@localhost:5432/harness
TEST_DATABASE_URL=postgres://harness:harness@localhost:5432/harness_test

# 32 random bytes, base64. Generate with: openssl rand -base64 32
HARNESS_ENCRYPTION_KEY=

# Which client instance this process serves (matches clients/<name>/)
HARNESS_CLIENT=demo-practice

# Identity recorded in the audit log for calls from the agent runtime
CORE_TOOLS_CALLER=hermes

# Optional: path to a policy.yaml overriding the default action-class table
HARNESS_POLICY_FILE=
```

Append to `.gitignore`:
```
# node
node_modules/
dist/
```

- [ ] **Step 5: Start Postgres and verify both databases exist**

Run:
```bash
pnpm db:up
sleep 5
docker compose -f harness/compose/docker-compose.yml exec postgres psql -U harness -d harness -c '\l' | grep -E 'harness(_test)?'
```
Expected: two lines, `harness` and `harness_test`.

If `harness_test` is missing because a `pgdata` volume already existed, run `pnpm db:down && docker volume rm compose_pgdata && pnpm db:up`.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-workspace.yaml tsconfig.base.json .nvmrc .env.example .gitignore harness/compose
git commit -m "chore: pnpm workspace scaffold and Postgres compose service

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: `@harness/db` schema and migrations

**Files:**
- Create: `harness/db/package.json`, `harness/db/tsconfig.json`, `harness/db/drizzle.config.ts`, `harness/db/vitest.config.ts`
- Create: `harness/db/src/schema.ts`, `harness/db/src/client.ts`, `harness/db/src/migrate.ts`, `harness/db/src/testing.ts`, `harness/db/src/test-global-setup.ts`, `harness/db/src/index.ts`
- Create: `harness/db/drizzle/0000_*.sql` (generated), `harness/db/drizzle/0001_audit_append_only.sql`
- Test: `harness/db/src/schema.test.ts`

**Interfaces:**
- Produces:
  - `createDb(url?: string): { db: Db; pool: pg.Pool; close(): Promise<void> }` where `Db = NodePgDatabase<typeof schema>`.
  - `runMigrations(url?: string): Promise<void>`.
  - `TEST_DATABASE_URL: string`, `resetDatabase(db: Db): Promise<void>`.
  - Tables exported from `schema.ts`: `providers, documents, fields, credentials, deadlines, approvals, runs, modelCalls, auditLog`.

- [ ] **Step 1: Create the package and install dependencies**

`harness/db/package.json`:
```json
{
  "name": "@harness/db",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./schema": "./src/schema.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "generate": "drizzle-kit generate",
    "migrate": "tsx src/migrate.ts"
  }
}
```

`harness/db/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "drizzle.config.ts", "vitest.config.ts"]
}
```

Run:
```bash
cd harness/db
pnpm add drizzle-orm pg
pnpm add -D drizzle-kit @types/pg tsx typescript vitest @types/node
cd ../..
```
Expected: lockfile written, no peer warnings that mention zod.

- [ ] **Step 2: Write the schema**

`harness/db/src/schema.ts`:
```ts
import {
  pgTable, uuid, text, timestamp, boolean, real, integer, jsonb, date,
  customType, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  name: text('name').notNull(),
  npi: text('npi'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('providers_client_name_idx').on(t.client, t.name),
  uniqueIndex('providers_client_npi_uq').on(t.client, t.npi),
]);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').references(() => providers.id),
  kind: text('kind'),
  storagePath: text('storage_path').notNull(),
  sha256: text('sha256').notNull(),
  pages: integer('pages'),
  ocrUsed: boolean('ocr_used').notNull().default(false),
  ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
});

export const fields = pgTable('fields', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  name: text('name').notNull(),
  value: text('value'),
  valueEncrypted: bytea('value_encrypted'),
  restricted: boolean('restricted').notNull().default(false),
  confidence: real('confidence'),
  sourceDocId: uuid('source_doc_id').references(() => documents.id),
  sourcePage: integer('source_page'),
  status: text('status').notNull().default('pending'),
  confirmedBy: text('confirmed_by'),
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
}, (t) => [uniqueIndex('fields_provider_name_uq').on(t.providerId, t.name)]);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  kind: text('kind').notNull(),
  issuer: text('issuer'),
  numberEncrypted: bytea('number_encrypted'),
  state: text('state'),
  issuedAt: date('issued_at', { mode: 'string' }),
  expiresAt: date('expires_at', { mode: 'string' }),
  sourceDocId: uuid('source_doc_id').references(() => documents.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('credentials_provider_idx').on(t.providerId)]);

export const deadlines = pgTable('deadlines', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  credentialId: uuid('credential_id').notNull().references(() => credentials.id),
  kind: text('kind').notNull(),
  dueAt: date('due_at', { mode: 'string' }).notNull(),
  windowDays: integer('window_days').notNull().default(90),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
}, (t) => [uniqueIndex('deadlines_credential_kind_uq').on(t.credentialId, t.kind)]);

export const approvals = pgTable('approvals', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  action: text('action').notNull(),
  payload: jsonb('payload').notNull(),
  summary: text('summary').notNull(),
  requestedBy: text('requested_by').notNull(),
  status: text('status').notNull().default('pending'),
  decidedBy: text('decided_by'),
  decidedAt: timestamp('decided_at', { withTimezone: true }),
  decisionNote: text('decision_note'),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  idempotencyKey: text('idempotency_key').notNull(),
  slackChannel: text('slack_channel'),
  slackTs: text('slack_ts'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('approvals_idempotency_uq').on(t.idempotencyKey)]);

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  caller: text('caller').notNull(),
  channel: text('channel'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

export const modelCalls = pgTable('model_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => runs.id),
  client: text('client').notNull(),
  route: text('route').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable('audit_log', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => runs.id),
  client: text('client').notNull(),
  caller: text('caller').notNull(),
  tool: text('tool').notNull(),
  actionClass: text('action_class').notNull(),
  argsHash: text('args_hash').notNull(),
  recordIds: jsonb('record_ids').notNull().default([]),
  decision: text('decision').notNull(),
  approvalId: uuid('approval_id').references(() => approvals.id),
  error: text('error'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('audit_log_tool_created_idx').on(t.tool, t.createdAt)]);
```

- [ ] **Step 3: Write client.ts, migrate.ts, testing.ts, index.ts, drizzle.config.ts**

`harness/db/src/client.ts`:
```ts
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';
import * as schema from './schema.js';

export type Db = NodePgDatabase<typeof schema>;

export function createDb(url: string | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const pool = new pg.Pool({ connectionString: url });
  const db: Db = drizzle(pool, { schema });
  return { db, pool, close: () => pool.end() };
}
```

`harness/db/src/migrate.ts`:
```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const migrationsFolder = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../drizzle');

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runMigrations().then(() => {
    console.log('migrations applied');
  });
}
```

`harness/db/src/testing.ts`:
```ts
import { sql } from 'drizzle-orm';
import type { Db } from './client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:5432/harness_test';

export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`
    TRUNCATE TABLE audit_log, model_calls, runs, approvals, deadlines,
      credentials, fields, documents, providers CASCADE
  `);
}
```

`harness/db/src/test-global-setup.ts`:
```ts
import { runMigrations } from './migrate.js';
import { TEST_DATABASE_URL } from './testing.js';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}
```

`harness/db/src/index.ts`:
```ts
export * from './schema.js';
export { createDb, type Db } from './client.js';
export { runMigrations } from './migrate.js';
export { encrypt, decrypt, loadKey, generateKey } from './crypto.js';
```
(`crypto.ts` is written in Task 3; create it as an empty module now so the index compiles:)

`harness/db/src/crypto.ts` (temporary):
```ts
export function encrypt(_plain: string, _key: Buffer): Buffer { throw new Error('not implemented'); }
export function decrypt(_blob: Buffer, _key: Buffer): string { throw new Error('not implemented'); }
export function loadKey(_b64?: string): Buffer { throw new Error('not implemented'); }
export function generateKey(): string { throw new Error('not implemented'); }
```

`harness/db/drizzle.config.ts`:
```ts
import { defineConfig } from 'drizzle-kit';

export default defineConfig({
  dialect: 'postgresql',
  schema: './src/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgres://harness:harness@localhost:5432/harness',
  },
});
```

`harness/db/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-global-setup.ts'],
    fileParallelism: false,
  },
});
```

- [ ] **Step 4: Generate the initial migration and the audit trigger migration**

Run:
```bash
cd harness/db
pnpm drizzle-kit generate --name init
pnpm drizzle-kit generate --custom --name audit_append_only
ls drizzle
cd ../..
```
Expected: `drizzle/0000_init.sql` with nine `CREATE TABLE` statements, an empty `drizzle/0001_audit_append_only.sql`, and `drizzle/meta/`.

Fill `harness/db/drizzle/0001_audit_append_only.sql`:
```sql
CREATE OR REPLACE FUNCTION audit_log_readonly() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER audit_log_no_update
BEFORE UPDATE OR DELETE ON audit_log
FOR EACH ROW EXECUTE FUNCTION audit_log_readonly();
```

- [ ] **Step 5: Write the failing schema test**

`harness/db/src/schema.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { createDb, type Db } from './client.js';
import { providers, auditLog } from './schema.js';
import { TEST_DATABASE_URL, resetDatabase } from './testing.js';

let db: Db;
let close: () => Promise<void>;

beforeAll(() => {
  ({ db, close } = createDb(TEST_DATABASE_URL));
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await resetDatabase(db);
});

describe('schema', () => {
  it('inserts and reads a provider', async () => {
    const [row] = await db.insert(providers).values({ client: 'test', name: 'Dr. Ada Lovelace', npi: '1234567890' }).returning();
    const found = await db.query.providers.findFirst({ where: eq(providers.id, row.id) });
    expect(found?.name).toBe('Dr. Ada Lovelace');
    expect(found?.status).toBe('active');
  });

  it('rejects a duplicate npi within a client', async () => {
    await db.insert(providers).values({ client: 'test', name: 'A', npi: '1' });
    await expect(db.insert(providers).values({ client: 'test', name: 'B', npi: '1' })).rejects.toThrow();
  });

  it('audit_log rejects UPDATE and DELETE', async () => {
    const [row] = await db.insert(auditLog).values({
      client: 'test', caller: 'test', tool: 't', actionClass: 'read', argsHash: 'h', decision: 'auto',
    }).returning();
    await expect(db.update(auditLog).set({ decision: 'blocked' }).where(eq(auditLog.id, row.id))).rejects.toThrow(/append-only/);
    await expect(db.delete(auditLog).where(eq(auditLog.id, row.id))).rejects.toThrow(/append-only/);
  });
});
```

- [ ] **Step 6: Run the test to verify it fails**

Run: `pnpm --filter @harness/db test`
Expected: FAIL. If the global setup itself fails with a connection error, Postgres is not up; run `pnpm db:up` and retry. The first run applies migrations, then tests run; expected failures before Step 7 are none if migrations were generated correctly. If all three pass immediately, continue.

- [ ] **Step 7: Make the tests pass**

If `0000_init.sql` lacks the unique index on `(client, npi)` or the trigger migration was not picked up, re-run `pnpm drizzle-kit generate --name init` after deleting `drizzle/` and repeat Step 4. Then:

Run: `pnpm --filter @harness/db test`
Expected: PASS, 3 tests.

- [ ] **Step 8: Typecheck and commit**

Run: `pnpm --filter @harness/db typecheck`
Expected: no errors.

```bash
git add harness/db pnpm-lock.yaml
git commit -m "feat(db): drizzle schema, migrations, append-only audit trigger

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Encryption for restricted columns

**Files:**
- Modify: `harness/db/src/crypto.ts` (replace the stub)
- Test: `harness/db/src/crypto.test.ts`

**Interfaces:**
- Produces:
  - `loadKey(b64?: string): Buffer` reads `HARNESS_ENCRYPTION_KEY` by default, requires 32 bytes.
  - `generateKey(): string` returns a base64 32-byte key.
  - `encrypt(plain: string, key: Buffer): Buffer` returns `iv(12) || tag(16) || ciphertext`.
  - `decrypt(blob: Buffer, key: Buffer): string` throws on tamper or wrong key.

- [ ] **Step 1: Write the failing tests**

`harness/db/src/crypto.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { encrypt, decrypt, loadKey, generateKey } from './crypto.js';

describe('crypto', () => {
  const key = loadKey(generateKey());

  it('round-trips utf8 text', () => {
    const blob = encrypt('123-45-6789', key);
    expect(Buffer.isBuffer(blob)).toBe(true);
    expect(decrypt(blob, key)).toBe('123-45-6789');
  });

  it('produces different ciphertext for the same input (random iv)', () => {
    expect(encrypt('x', key).equals(encrypt('x', key))).toBe(false);
  });

  it('throws on tampered ciphertext', () => {
    const blob = encrypt('secret', key);
    blob[blob.length - 1] ^= 0xff;
    expect(() => decrypt(blob, key)).toThrow();
  });

  it('throws on wrong key', () => {
    const blob = encrypt('secret', key);
    expect(() => decrypt(blob, loadKey(generateKey()))).toThrow();
  });

  it('rejects keys that are not 32 bytes', () => {
    expect(() => loadKey(Buffer.from('short').toString('base64'))).toThrow(/32 bytes/);
    expect(() => loadKey(undefined)).toThrow(/HARNESS_ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harness/db test -- crypto`
Expected: FAIL with "not implemented".

- [ ] **Step 3: Implement**

`harness/db/src/crypto.ts`:
```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const IV_BYTES = 12;
const TAG_BYTES = 16;

export function generateKey(): string {
  return randomBytes(32).toString('base64');
}

export function loadKey(b64: string | undefined = process.env.HARNESS_ENCRYPTION_KEY): Buffer {
  if (!b64) throw new Error('HARNESS_ENCRYPTION_KEY is not set');
  const key = Buffer.from(b64, 'base64');
  if (key.length !== 32) throw new Error('HARNESS_ENCRYPTION_KEY must decode to 32 bytes');
  return key;
}

export function encrypt(plain: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

export function decrypt(blob: Buffer, key: Buffer): string {
  const iv = blob.subarray(0, IV_BYTES);
  const tag = blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = blob.subarray(IV_BYTES + TAG_BYTES);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @harness/db test`
Expected: PASS, 8 tests.

- [ ] **Step 5: Commit**

```bash
git add harness/db/src/crypto.ts harness/db/src/crypto.test.ts
git commit -m "feat(db): AES-256-GCM encryption for restricted columns

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: `@harness/core-tools` policy module

**Files:**
- Create: `harness/core-tools/package.json`, `harness/core-tools/tsconfig.json`, `harness/core-tools/vitest.config.ts`
- Create: `harness/core-tools/src/policy.ts`, `harness/core-tools/src/test-global-setup.ts`
- Test: `harness/core-tools/src/policy.test.ts`

**Interfaces:**
- Produces:
  - `ACTION_CLASSES`, `type ActionClass`, `type Behavior = 'auto' | 'approval' | 'blocked'`, `type Policy = Record<ActionClass, Behavior>`.
  - `DEFAULT_POLICY: Policy`.
  - `parsePolicy(yamlText: string): Policy` merges a `classes:` map over the defaults, rejects unknown classes or behaviors.
  - `loadPolicy(filePath?: string): Promise<Policy>` reads `HARNESS_POLICY_FILE` or the path given; returns defaults when neither exists.
  - `decide(actionClass: ActionClass, policy: Policy): Behavior`.

- [ ] **Step 1: Create the package and install dependencies**

`harness/core-tools/package.json`:
```json
{
  "name": "@harness/core-tools",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/server.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/main.ts"
  }
}
```

`harness/core-tools/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

`harness/core-tools/vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globalSetup: ['./src/test-global-setup.ts'],
    fileParallelism: false,
  },
});
```

`harness/core-tools/src/test-global-setup.ts`:
```ts
import { runMigrations } from '@harness/db';
import { TEST_DATABASE_URL } from '@harness/db/testing';

export default async function setup(): Promise<void> {
  await runMigrations(TEST_DATABASE_URL);
}
```

Run:
```bash
cd harness/core-tools
pnpm add @modelcontextprotocol/server zod yaml drizzle-orm pg dotenv
pnpm add @harness/db@workspace:*
pnpm add -D @modelcontextprotocol/client tsx typescript vitest @types/node @types/pg
cd ../..
```
Expected: `@harness/db` appears as `"workspace:*"` in package.json dependencies.

- [ ] **Step 2: Write the failing policy tests**

`harness/core-tools/src/policy.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { DEFAULT_POLICY, parsePolicy, decide, loadPolicy } from './policy.js';

describe('policy', () => {
  it('default policy matches the spec table', () => {
    expect(DEFAULT_POLICY).toEqual({
      read: 'auto',
      'write.internal': 'auto',
      external: 'approval',
      financial: 'blocked',
      destructive: 'approval',
    });
  });

  it('parsePolicy merges overrides over defaults', () => {
    const p = parsePolicy('classes:\n  external: auto\n');
    expect(p.external).toBe('auto');
    expect(p.financial).toBe('blocked');
  });

  it('parsePolicy rejects unknown classes and behaviors', () => {
    expect(() => parsePolicy('classes:\n  bogus: auto\n')).toThrow(/bogus/);
    expect(() => parsePolicy('classes:\n  read: maybe\n')).toThrow(/maybe/);
  });

  it('decide returns the behavior for a class', () => {
    expect(decide('financial', DEFAULT_POLICY)).toBe('blocked');
    expect(decide('read', DEFAULT_POLICY)).toBe('auto');
  });

  it('loadPolicy returns defaults when no file is configured', async () => {
    const saved = process.env.HARNESS_POLICY_FILE;
    delete process.env.HARNESS_POLICY_FILE;
    expect(await loadPolicy()).toEqual(DEFAULT_POLICY);
    if (saved !== undefined) process.env.HARNESS_POLICY_FILE = saved;
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm --filter @harness/core-tools test -- policy`
Expected: FAIL, cannot find module `./policy.js`.

- [ ] **Step 4: Implement policy.ts**

`harness/core-tools/src/policy.ts`:
```ts
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';

export const ACTION_CLASSES = ['read', 'write.internal', 'external', 'financial', 'destructive'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const BEHAVIORS = ['auto', 'approval', 'blocked'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export type Policy = Record<ActionClass, Behavior>;

export const DEFAULT_POLICY: Policy = {
  read: 'auto',
  'write.internal': 'auto',
  external: 'approval',
  financial: 'blocked',
  destructive: 'approval',
};

const PolicyFile = z.object({
  classes: z.record(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS)).optional(),
});

export function parsePolicy(yamlText: string): Policy {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = PolicyFile.safeParse(raw);
  if (!parsed.success) {
    const classes = (raw as { classes?: Record<string, unknown> }).classes ?? {};
    const badKey = Object.keys(classes).find((k) => !(ACTION_CLASSES as readonly string[]).includes(k));
    if (badKey) throw new Error(`policy: unknown action class "${badKey}"`);
    const badVal = Object.values(classes).find((v) => !(BEHAVIORS as readonly string[]).includes(String(v)));
    throw new Error(`policy: invalid behavior "${String(badVal)}"`);
  }
  return { ...DEFAULT_POLICY, ...(parsed.data.classes ?? {}) };
}

export async function loadPolicy(filePath: string | undefined = process.env.HARNESS_POLICY_FILE): Promise<Policy> {
  if (!filePath) return { ...DEFAULT_POLICY };
  const text = await readFile(filePath, 'utf8');
  return parsePolicy(text);
}

export function decide(actionClass: ActionClass, policy: Policy): Behavior {
  return policy[actionClass];
}
```

- [ ] **Step 5: Run to verify pass, typecheck, commit**

Run: `pnpm --filter @harness/core-tools test -- policy` → PASS, 5 tests.
Run: `pnpm --filter @harness/core-tools typecheck` → no errors.

```bash
git add harness/core-tools pnpm-lock.yaml
git commit -m "feat(core-tools): action-class policy table and loader

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Tool registry with policy and audit wrapping

**Files:**
- Create: `harness/core-tools/src/audit.ts`, `harness/core-tools/src/registry.ts`, `harness/core-tools/src/testing.ts`
- Test: `harness/core-tools/src/registry.test.ts`

**Interfaces:**
- Consumes: `decide`, `Policy`, `ActionClass` from Task 4; `Db`, `approvals`, `auditLog` from `@harness/db`.
- Produces:
  - `interface ToolDeps { db: Db; client: string; caller: string; policy: Policy; encryptionKey: Buffer; now: () => Date; approvalTtlHours: number; confidenceThreshold: number }`.
  - `defineTool<I, O>(def: ToolDef<I, O>): ToolDef<I, O>` where `ToolDef = { name; description; actionClass; input: z.ZodObject; output: z.ZodObject; handler(args, deps): Promise<O>; recordIds?(args, result): string[] }`.
  - `registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void`.
  - Structured result envelope for every tool: `{ status: 'ok', result }` or `{ status: 'pending', approval_id }`. Blocked and thrown errors return `isError: true`.
  - `writeAudit(db, entry): Promise<void>`.
  - Test helpers: `makeTestDeps(overrides?)`, `makeTestClient(factory)` returning `{ client, close }`.

- [ ] **Step 1: Write audit.ts**

`harness/core-tools/src/audit.ts`:
```ts
import { createHash } from 'node:crypto';
import { auditLog, type Db } from '@harness/db';
import type { ActionClass } from './policy.js';

export type Decision = 'auto' | 'approval' | 'blocked' | 'error';

export interface AuditEntry {
  client: string;
  caller: string;
  tool: string;
  actionClass: ActionClass;
  argsHash: string;
  decision: Decision;
  recordIds?: string[];
  approvalId?: string | null;
  runId?: string | null;
  error?: string | null;
}

export function hashArgs(args: unknown): string {
  return createHash('sha256').update(JSON.stringify(args ?? null)).digest('hex');
}

export async function writeAudit(db: Db, entry: AuditEntry): Promise<void> {
  await db.insert(auditLog).values({
    client: entry.client,
    caller: entry.caller,
    tool: entry.tool,
    actionClass: entry.actionClass,
    argsHash: entry.argsHash,
    decision: entry.decision,
    recordIds: entry.recordIds ?? [],
    approvalId: entry.approvalId ?? null,
    runId: entry.runId ?? null,
    error: entry.error ?? null,
  });
}
```

- [ ] **Step 2: Write registry.ts**

`harness/core-tools/src/registry.ts`:
```ts
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { decide, type ActionClass, type Policy } from './policy.js';
import { hashArgs, writeAudit } from './audit.js';

export interface ToolDeps {
  db: Db;
  client: string;
  caller: string;
  policy: Policy;
  encryptionKey: Buffer;
  now: () => Date;
  approvalTtlHours: number;
  confidenceThreshold: number;
}

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any, any>;

export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

function envelope<O extends z.ZodObject>(output: O) {
  return z.object({
    status: z.enum(['ok', 'pending']),
    approval_id: z.string().optional(),
    result: output.optional(),
  });
}

function textResult(payload: unknown, isError = false) {
  return { content: [{ type: 'text' as const, text: typeof payload === 'string' ? payload : JSON.stringify(payload) }], isError };
}

async function createOrReuseApproval(db: Db, deps: ToolDeps, tool: AnyToolDef, args: unknown, argsHash: string) {
  const idempotencyKey = `${tool.name}:${argsHash}`;
  const summary = `${tool.name} (${tool.actionClass}) requested by ${deps.caller}`;
  const expiresAt = new Date(deps.now().getTime() + deps.approvalTtlHours * 3600 * 1000);
  await db
    .insert(approvals)
    .values({
      client: deps.client,
      action: tool.name,
      payload: { tool: tool.name, args },
      summary,
      requestedBy: deps.caller,
      expiresAt,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: approvals.idempotencyKey });
  const row = await db.query.approvals.findFirst({ where: eq(approvals.idempotencyKey, idempotencyKey) });
  if (!row) throw new Error('approval row missing after insert');
  return row;
}

export function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void {
  for (const tool of tools) {
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema: tool.input, outputSchema: envelope(tool.output) },
      async (args: Record<string, unknown>) => {
        const behavior = decide(tool.actionClass, deps.policy);
        const argsHash = hashArgs(args);
        const base = { client: deps.client, caller: deps.caller, tool: tool.name, actionClass: tool.actionClass, argsHash };

        if (behavior === 'blocked') {
          await writeAudit(deps.db, { ...base, decision: 'blocked' });
          return textResult(`Tool ${tool.name} is blocked by policy (action class ${tool.actionClass}).`, true);
        }

        if (behavior === 'approval') {
          const row = await createOrReuseApproval(deps.db, deps, tool, args, argsHash);
          await writeAudit(deps.db, { ...base, decision: 'approval', approvalId: row.id });
          const structured = { status: 'pending' as const, approval_id: row.id };
          return { ...textResult(structured), structuredContent: structured };
        }

        try {
          const result = await tool.handler(args, deps);
          await writeAudit(deps.db, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, result) ?? [] });
          const structured = { status: 'ok' as const, result };
          return { ...textResult(structured), structuredContent: structured };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await writeAudit(deps.db, { ...base, decision: 'error', error: message });
          return textResult(`Tool ${tool.name} failed: ${message}`, true);
        }
      },
    );
  }
}
```

- [ ] **Step 3: Write testing.ts**

`harness/core-tools/src/testing.ts`:
```ts
import { randomBytes } from 'node:crypto';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { createMcpHandler, type McpServer } from '@modelcontextprotocol/server';
import { createDb, type Db } from '@harness/db';
import { TEST_DATABASE_URL, resetDatabase } from '@harness/db/testing';
import { DEFAULT_POLICY } from './policy.js';
import type { ToolDeps } from './registry.js';

export function makeTestDeps(db: Db, overrides: Partial<ToolDeps> = {}): ToolDeps {
  return {
    db,
    client: 'test',
    caller: 'test-caller',
    policy: { ...DEFAULT_POLICY },
    encryptionKey: randomBytes(32),
    now: () => new Date('2026-09-15T12:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: 0.85,
    ...overrides,
  };
}

export async function makeTestClient(factory: () => McpServer) {
  const handler = createMcpHandler(factory);
  const transport = new StreamableHTTPClientTransport(new URL('http://test.local/mcp'), {
    fetch: (url, init) => handler.fetch(new Request(url, init)),
  });
  const client = new Client({ name: 'test-harness', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await client.connect(transport);
  return {
    client,
    close: async () => {
      await client.close();
      await handler.close();
    },
  };
}

export function openTestDb() {
  const handle = createDb(TEST_DATABASE_URL);
  return { ...handle, reset: () => resetDatabase(handle.db) };
}
```

- [ ] **Step 4: Write the failing registry test**

`harness/core-tools/src/registry.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import * as z from 'zod/v4';
import { McpServer } from '@modelcontextprotocol/server';
import { approvals, auditLog, type Db } from '@harness/db';
import { defineTool, registerTools } from './registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from './testing.js';

const echo = defineTool({
  name: 'echo_read',
  description: 'Echo (read)',
  actionClass: 'read',
  input: z.object({ text: z.string() }),
  output: z.object({ text: z.string() }),
  handler: async ({ text }) => ({ text }),
  recordIds: () => ['rec-1'],
});

const sendExternal = defineTool({
  name: 'send_external',
  description: 'Send something outside (external)',
  actionClass: 'external',
  input: z.object({ to: z.string() }),
  output: z.object({ sent: z.boolean() }),
  handler: async () => ({ sent: true }),
});

const pay = defineTool({
  name: 'pay',
  description: 'Move money (financial)',
  actionClass: 'financial',
  input: z.object({ amount: z.number() }),
  output: z.object({ ok: z.boolean() }),
  handler: async () => ({ ok: true }),
});

const boom = defineTool({
  name: 'boom',
  description: 'Always throws',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({}),
  handler: async () => {
    throw new Error('kaboom');
  },
});

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

function factory() {
  const server = new McpServer({ name: 'registry-test', version: '0.0.0' });
  registerTools(server, [echo, sendExternal, pay, boom], makeTestDeps(db));
  return server;
}

describe('registerTools', () => {
  it('runs auto tools, returns ok envelope, audits with record ids', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 'hi' } });
    expect(res.structuredContent).toEqual({ status: 'ok', result: { text: 'hi' } });
    const rows = await db.select().from(auditLog);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ tool: 'echo_read', decision: 'auto', recordIds: ['rec-1'], caller: 'test-caller' });
    await c();
  });

  it('parks approval-class tools and creates one approval row per identical request', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const first = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    const second = await client.callTool({ name: 'send_external', arguments: { to: 'payer@example.com' } });
    expect(first.structuredContent).toMatchObject({ status: 'pending' });
    expect(second.structuredContent).toEqual(first.structuredContent);
    const rows = await db.select().from(approvals);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'send_external', status: 'pending', requestedBy: 'test-caller' });
    expect(rows[0].payload).toEqual({ tool: 'send_external', args: { to: 'payer@example.com' } });
    const audits = await db.select().from(auditLog);
    expect(audits.every((a) => a.decision === 'approval' && a.approvalId === rows[0].id)).toBe(true);
    await c();
  });

  it('blocks financial tools with isError and an audit row', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'pay', arguments: { amount: 5 } });
    expect(res.isError).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'pay', decision: 'blocked' });
    await c();
  });

  it('converts thrown errors into isError results and audits them', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'boom', arguments: {} });
    expect(res.isError).toBe(true);
    const rows = await db.select().from(auditLog);
    expect(rows[0]).toMatchObject({ tool: 'boom', decision: 'error', error: 'kaboom' });
    await c();
  });

  it('rejects invalid arguments before the handler runs', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'echo_read', arguments: { text: 42 } });
    expect(res.isError).toBe(true);
    expect(await db.select().from(auditLog)).toHaveLength(0);
    await c();
  });
});
```

- [ ] **Step 5: Run to verify failure, then pass**

Run: `pnpm --filter @harness/core-tools test -- registry`
Expected first: FAIL only if a file above has a typo; otherwise PASS, 5 tests. If `structuredContent` comes back undefined, check that `outputSchema` is passed and that the handler returns `structuredContent` alongside `content`.

- [ ] **Step 6: Typecheck and commit**

Run: `pnpm --filter @harness/core-tools typecheck` → no errors.

```bash
git add harness/core-tools/src
git commit -m "feat(core-tools): defineTool registry with policy and audit wrapping

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Providers toolset

**Files:**
- Create: `harness/core-tools/src/tools/providers.ts`
- Test: `harness/core-tools/src/tools/providers.test.ts`

**Interfaces:**
- Consumes: `defineTool`, `ToolDeps`; `encrypt`, `decrypt` from `@harness/db`; tables `providers`, `fields`, `credentials`.
- Produces `providerTools: AnyToolDef[]` with:
  - `providers_upsert` (write.internal): input `{ name, npi?, fields?: FieldInput[], credentials?: CredentialInput[] }` → `{ provider_id, fields_pending, fields_extracted, credentials }`.
  - `providers_get` (read): `{ provider_id }` → `{ provider, fields, credentials }` with restricted values masked as `"[restricted]"`.
  - `providers_search` (read): `{ query }` → `{ providers: [{ provider_id, name, npi }] }`.
  - `providers_confirm_field` (write.internal): `{ provider_id, field, value, confirmed_by? }` → `{ provider_id, field, status: 'verified' }`.
  - `providers_list_pending` (read): `{ provider_id }` → `{ fields: [{ name, confidence, source_page }] }`.
  - Exported schemas `FieldInput`, `CredentialInput` reused by Plan 2's extractor.

- [ ] **Step 1: Write the failing tests**

`harness/core-tools/src/tools/providers.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { eq } from 'drizzle-orm';
import { fields, credentials, decrypt, type Db } from '@harness/db';
import { registerTools, type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { providerTools } from './providers.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db);
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

const factory = () => {
  const server = new McpServer({ name: 'providers-test', version: '0.0.0' });
  registerTools(server, providerTools, deps);
  return server;
};

const upsertArgs = {
  name: 'Dr. Ada Lovelace',
  npi: '1234567890',
  fields: [
    { name: 'first_name', value: 'Ada', confidence: 0.99 },
    { name: 'ssn', value: '123-45-6789', confidence: 0.97, restricted: true },
    { name: 'malpractice_carrier', value: 'MedPro', confidence: 0.6 },
  ],
  credentials: [
    { kind: 'license', issuer: 'CA Medical Board', number: 'A12345', state: 'CA', expires_at: '2027-03-31' },
    { kind: 'dea', number: 'BL1234567', expires_at: '2026-11-30' },
  ],
};

describe('providers tools', () => {
  it('upsert creates provider, encrypts restricted fields, sets statuses by threshold', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const out = (res.structuredContent as { result: { provider_id: string; fields_pending: number; fields_extracted: number; credentials: number } }).result;
    expect(out.fields_pending).toBe(1);
    expect(out.fields_extracted).toBe(2);
    expect(out.credentials).toBe(2);

    const rows = await db.select().from(fields).where(eq(fields.providerId, out.provider_id));
    const ssn = rows.find((r) => r.name === 'ssn')!;
    expect(ssn.value).toBeNull();
    expect(decrypt(ssn.valueEncrypted!, deps.encryptionKey)).toBe('123-45-6789');
    expect(ssn.status).toBe('extracted');
    expect(rows.find((r) => r.name === 'malpractice_carrier')!.status).toBe('pending');

    const creds = await db.select().from(credentials).where(eq(credentials.providerId, out.provider_id));
    expect(creds.every((cr) => cr.numberEncrypted !== null)).toBe(true);
    await c();
  });

  it('upsert is idempotent by (client, npi) and updates existing fields', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const a = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const b = await client.callTool({ name: 'providers_upsert', arguments: { ...upsertArgs, fields: [{ name: 'first_name', value: 'Augusta', confidence: 0.99 }], credentials: [] } });
    const idA = (a.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const idB = (b.structuredContent as { result: { provider_id: string } }).result.provider_id;
    expect(idA).toBe(idB);
    const rows = await db.select().from(fields).where(eq(fields.providerId, idA));
    expect(rows.find((r) => r.name === 'first_name')!.value).toBe('Augusta');
    expect(rows).toHaveLength(3);
    const creds = await db.select().from(credentials).where(eq(credentials.providerId, idA));
    expect(creds).toHaveLength(2);
    await c();
  });

  it('get masks restricted values and returns credentials with masked numbers', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const res = await client.callTool({ name: 'providers_get', arguments: { provider_id: id } });
    const out = (res.structuredContent as { result: { provider: { name: string }; fields: { name: string; value: string | null }[]; credentials: { kind: string; number: string }[] } }).result;
    expect(out.provider.name).toBe('Dr. Ada Lovelace');
    expect(out.fields.find((f) => f.name === 'ssn')!.value).toBe('[restricted]');
    expect(out.fields.find((f) => f.name === 'first_name')!.value).toBe('Ada');
    expect(out.credentials.find((cr) => cr.kind === 'dea')!.number).toBe('[restricted]');
    await c();
  });

  it('search finds by name fragment and by npi', async () => {
    const { client, close: c } = await makeTestClient(factory);
    await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const byName = await client.callTool({ name: 'providers_search', arguments: { query: 'lovelace' } });
    const byNpi = await client.callTool({ name: 'providers_search', arguments: { query: '1234567890' } });
    expect((byName.structuredContent as { result: { providers: unknown[] } }).result.providers).toHaveLength(1);
    expect((byNpi.structuredContent as { result: { providers: unknown[] } }).result.providers).toHaveLength(1);
    await c();
  });

  it('list_pending and confirm_field', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const up = await client.callTool({ name: 'providers_upsert', arguments: upsertArgs });
    const id = (up.structuredContent as { result: { provider_id: string } }).result.provider_id;
    const pending = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect((pending.structuredContent as { result: { fields: { name: string }[] } }).result.fields.map((f) => f.name)).toEqual(['malpractice_carrier']);

    await client.callTool({ name: 'providers_confirm_field', arguments: { provider_id: id, field: 'malpractice_carrier', value: 'MedPro Group', confirmed_by: 'U123' } });
    const row = (await db.select().from(fields).where(eq(fields.providerId, id))).find((r) => r.name === 'malpractice_carrier')!;
    expect(row).toMatchObject({ status: 'verified', value: 'MedPro Group', confirmedBy: 'U123' });
    expect(row.confirmedAt).not.toBeNull();

    const after = await client.callTool({ name: 'providers_list_pending', arguments: { provider_id: id } });
    expect((after.structuredContent as { result: { fields: unknown[] } }).result.fields).toHaveLength(0);
    await c();
  });

  it('get returns isError for unknown provider', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const res = await client.callTool({ name: 'providers_get', arguments: { provider_id: '00000000-0000-0000-0000-000000000000' } });
    expect(res.isError).toBe(true);
    await c();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harness/core-tools test -- providers`
Expected: FAIL, cannot find module `./providers.js`.

- [ ] **Step 3: Implement providers.ts**

`harness/core-tools/src/tools/providers.ts`:
```ts
import * as z from 'zod/v4';
import { and, eq, ilike, or, sql } from 'drizzle-orm';
import { providers, fields, credentials, encrypt, type Db } from '@harness/db';
import { defineTool, type AnyToolDef, type ToolDeps } from '../registry.js';

export const FieldInput = z.object({
  name: z.string().min(1),
  value: z.string(),
  confidence: z.number().min(0).max(1).optional(),
  restricted: z.boolean().optional(),
  source_doc_id: z.string().uuid().optional(),
  source_page: z.number().int().positive().optional(),
});
export type FieldInput = z.infer<typeof FieldInput>;

export const CredentialInput = z.object({
  kind: z.enum(['license', 'dea', 'malpractice', 'board_cert']),
  issuer: z.string().optional(),
  number: z.string().optional(),
  state: z.string().length(2).optional(),
  issued_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  expires_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  source_doc_id: z.string().uuid().optional(),
});
export type CredentialInput = z.infer<typeof CredentialInput>;

const RESTRICTED_FIELD_NAMES = new Set(['ssn', 'ein', 'dea_number', 'tax_id']);

async function findOrCreateProvider(db: Db, deps: ToolDeps, name: string, npi?: string) {
  const existing = npi
    ? await db.query.providers.findFirst({ where: and(eq(providers.client, deps.client), eq(providers.npi, npi)) })
    : await db.query.providers.findFirst({ where: and(eq(providers.client, deps.client), eq(providers.name, name)) });
  if (existing) {
    const [updated] = await db
      .update(providers)
      .set({ name, npi: npi ?? existing.npi, updatedAt: deps.now() })
      .where(eq(providers.id, existing.id))
      .returning();
    return updated;
  }
  const [created] = await db.insert(providers).values({ client: deps.client, name, npi: npi ?? null }).returning();
  return created;
}

async function upsertField(db: Db, deps: ToolDeps, providerId: string, f: FieldInput) {
  const restricted = f.restricted ?? RESTRICTED_FIELD_NAMES.has(f.name);
  const confidence = f.confidence ?? 1;
  const status = confidence >= deps.confidenceThreshold ? 'extracted' : 'pending';
  const values = {
    providerId,
    name: f.name,
    value: restricted ? null : f.value,
    valueEncrypted: restricted ? encrypt(f.value, deps.encryptionKey) : null,
    restricted,
    confidence,
    sourceDocId: f.source_doc_id ?? null,
    sourcePage: f.source_page ?? null,
    status,
  };
  await db
    .insert(fields)
    .values(values)
    .onConflictDoUpdate({
      target: [fields.providerId, fields.name],
      set: { ...values, confirmedBy: null, confirmedAt: null },
    });
  return status;
}

async function upsertCredential(db: Db, deps: ToolDeps, providerId: string, c: CredentialInput) {
  const existing = await db.query.credentials.findFirst({
    where: and(
      eq(credentials.providerId, providerId),
      eq(credentials.kind, c.kind),
      sql`${credentials.state} IS NOT DISTINCT FROM ${c.state ?? null}`,
    ),
  });
  const values = {
    providerId,
    kind: c.kind,
    issuer: c.issuer ?? null,
    numberEncrypted: c.number ? encrypt(c.number, deps.encryptionKey) : null,
    state: c.state ?? null,
    issuedAt: c.issued_at ?? null,
    expiresAt: c.expires_at ?? null,
    sourceDocId: c.source_doc_id ?? null,
  };
  if (existing) {
    await db.update(credentials).set(values).where(eq(credentials.id, existing.id));
  } else {
    await db.insert(credentials).values(values);
  }
}

const providersUpsert = defineTool({
  name: 'providers_upsert',
  description:
    'Create or update a provider record with extracted fields and credentials. Matches an existing provider by NPI (or by name when no NPI). Restricted fields (ssn, ein, dea_number, tax_id) are encrypted and never returned in plaintext.',
  actionClass: 'write.internal',
  input: z.object({
    name: z.string().min(1),
    npi: z.string().regex(/^\d{10}$/).optional(),
    fields: z.array(FieldInput).default([]),
    credentials: z.array(CredentialInput).default([]),
  }),
  output: z.object({
    provider_id: z.string(),
    fields_pending: z.number(),
    fields_extracted: z.number(),
    credentials: z.number(),
  }),
  handler: async (args, deps) => {
    const provider = await findOrCreateProvider(deps.db, deps, args.name, args.npi);
    let pending = 0;
    let extracted = 0;
    for (const f of args.fields) {
      const status = await upsertField(deps.db, deps, provider.id, f);
      if (status === 'pending') pending += 1;
      else extracted += 1;
    }
    for (const c of args.credentials) {
      await upsertCredential(deps.db, deps, provider.id, c);
    }
    const credCount = await deps.db.$count(credentials, eq(credentials.providerId, provider.id));
    return { provider_id: provider.id, fields_pending: pending, fields_extracted: extracted, credentials: credCount };
  },
  recordIds: (_args, result) => [result.provider_id],
});

const providersGet = defineTool({
  name: 'providers_get',
  description: 'Return a provider with its fields and credentials. Restricted values are masked.',
  actionClass: 'read',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    provider: z.object({ id: z.string(), name: z.string(), npi: z.string().nullable(), status: z.string() }),
    fields: z.array(
      z.object({
        name: z.string(),
        value: z.string().nullable(),
        restricted: z.boolean(),
        confidence: z.number().nullable(),
        status: z.string(),
        source_page: z.number().nullable(),
      }),
    ),
    credentials: z.array(
      z.object({
        id: z.string(),
        kind: z.string(),
        issuer: z.string().nullable(),
        number: z.string(),
        state: z.string().nullable(),
        expires_at: z.string().nullable(),
      }),
    ),
  }),
  handler: async ({ provider_id }, deps) => {
    const p = await deps.db.query.providers.findFirst({ where: and(eq(providers.id, provider_id), eq(providers.client, deps.client)) });
    if (!p) throw new Error(`provider ${provider_id} not found`);
    const fs = await deps.db.select().from(fields).where(eq(fields.providerId, provider_id));
    const cs = await deps.db.select().from(credentials).where(eq(credentials.providerId, provider_id));
    return {
      provider: { id: p.id, name: p.name, npi: p.npi, status: p.status },
      fields: fs.map((f) => ({
        name: f.name,
        value: f.restricted ? '[restricted]' : f.value,
        restricted: f.restricted,
        confidence: f.confidence,
        status: f.status,
        source_page: f.sourcePage,
      })),
      credentials: cs.map((c) => ({
        id: c.id,
        kind: c.kind,
        issuer: c.issuer,
        number: c.numberEncrypted ? '[restricted]' : '',
        state: c.state,
        expires_at: c.expiresAt,
      })),
    };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const providersSearch = defineTool({
  name: 'providers_search',
  description: 'Search providers by name fragment or exact NPI.',
  actionClass: 'read',
  input: z.object({ query: z.string().min(1) }),
  output: z.object({ providers: z.array(z.object({ provider_id: z.string(), name: z.string(), npi: z.string().nullable() })) }),
  handler: async ({ query }, deps) => {
    const rows = await deps.db
      .select()
      .from(providers)
      .where(and(eq(providers.client, deps.client), or(ilike(providers.name, `%${query}%`), eq(providers.npi, query))))
      .limit(20);
    return { providers: rows.map((r) => ({ provider_id: r.id, name: r.name, npi: r.npi })) };
  },
});

const providersConfirmField = defineTool({
  name: 'providers_confirm_field',
  description: 'A human confirms or corrects a field value. Marks it verified.',
  actionClass: 'write.internal',
  input: z.object({
    provider_id: z.string().uuid(),
    field: z.string().min(1),
    value: z.string(),
    confirmed_by: z.string().optional(),
  }),
  output: z.object({ provider_id: z.string(), field: z.string(), status: z.literal('verified') }),
  handler: async ({ provider_id, field, value, confirmed_by }, deps) => {
    const existing = await deps.db.query.fields.findFirst({ where: and(eq(fields.providerId, provider_id), eq(fields.name, field)) });
    const restricted = existing?.restricted ?? RESTRICTED_FIELD_NAMES.has(field);
    const values = {
      providerId: provider_id,
      name: field,
      value: restricted ? null : value,
      valueEncrypted: restricted ? encrypt(value, deps.encryptionKey) : null,
      restricted,
      confidence: 1,
      status: 'verified',
      confirmedBy: confirmed_by ?? deps.caller,
      confirmedAt: deps.now(),
    };
    await deps.db
      .insert(fields)
      .values(values)
      .onConflictDoUpdate({ target: [fields.providerId, fields.name], set: values });
    return { provider_id, field, status: 'verified' as const };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const providersListPending = defineTool({
  name: 'providers_list_pending',
  description: 'List fields that still need human confirmation for a provider.',
  actionClass: 'read',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    fields: z.array(z.object({ name: z.string(), confidence: z.number().nullable(), source_page: z.number().nullable() })),
  }),
  handler: async ({ provider_id }, deps) => {
    const rows = await deps.db
      .select()
      .from(fields)
      .where(and(eq(fields.providerId, provider_id), eq(fields.status, 'pending')));
    return { fields: rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage })) };
  },
});

export const providerTools: AnyToolDef[] = [providersUpsert, providersGet, providersSearch, providersConfirmField, providersListPending];
```

- [ ] **Step 4: Run to verify pass**

Run: `pnpm --filter @harness/core-tools test -- providers`
Expected: PASS, 6 tests. If `db.$count` is not available in the installed drizzle version, replace it with `(await deps.db.select().from(credentials).where(eq(credentials.providerId, provider.id))).length`.

- [ ] **Step 5: Typecheck and commit**

Run: `pnpm --filter @harness/core-tools typecheck` → no errors.

```bash
git add harness/core-tools/src/tools/providers.ts harness/core-tools/src/tools/providers.test.ts
git commit -m "feat(core-tools): providers toolset with encrypted restricted fields

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Deadline math and deadlines toolset

**Files:**
- Create: `harness/core-tools/src/deadlines/compute.ts`, `harness/core-tools/src/tools/deadlines.ts`
- Test: `harness/core-tools/src/deadlines/compute.test.ts`, `harness/core-tools/src/tools/deadlines.test.ts`

**Interfaces:**
- Consumes: `providerTools` (to seed data in tests), `defineTool`, tables `credentials`, `deadlines`, `providers`.
- Produces:
  - `daysUntil(dueAt: string, today: Date): number` (UTC calendar days, negative when overdue).
  - `addDays(dateStr: string, days: number): string`.
  - `LEAD_DAYS: Record<CredentialKind, number>` = license 90, dea 90, malpractice 60, board_cert 120.
  - `computeDeadlines(creds: { id: string; kind: string; expiresAt: string | null }[]): { credentialId; kind: 'expiration' | 'renewal_start'; dueAt: string }[]`.
  - `deadlineTools: AnyToolDef[]` with `deadlines_compute` (write.internal) `{ provider_id }` → `{ deadlines: [...] }` and `deadlines_upcoming` (read) `{ window_days?, today? }` → `{ items: [{ provider_id, provider_name, credential_id, credential_kind, kind, due_at, days_left, overdue }] }` sorted by due date.

- [ ] **Step 1: Write the failing compute tests**

`harness/core-tools/src/deadlines/compute.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { daysUntil, addDays, computeDeadlines, LEAD_DAYS } from './compute.js';

describe('deadline math', () => {
  it('daysUntil counts UTC calendar days', () => {
    expect(daysUntil('2026-09-20', new Date('2026-09-15T23:59:00Z'))).toBe(5);
    expect(daysUntil('2026-09-15', new Date('2026-09-15T00:00:00Z'))).toBe(0);
    expect(daysUntil('2026-09-10', new Date('2026-09-15T12:00:00Z'))).toBe(-5);
  });

  it('addDays handles month ends and leap years', () => {
    expect(addDays('2028-02-28', 1)).toBe('2028-02-29');
    expect(addDays('2027-02-28', 1)).toBe('2027-03-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(addDays('2026-03-31', -90)).toBe('2025-12-31');
  });

  it('computeDeadlines produces expiration and renewal_start per credential with an expiry', () => {
    const out = computeDeadlines([
      { id: 'c1', kind: 'license', expiresAt: '2027-03-31' },
      { id: 'c2', kind: 'malpractice', expiresAt: '2026-11-30' },
      { id: 'c3', kind: 'dea', expiresAt: null },
    ]);
    expect(out).toEqual([
      { credentialId: 'c1', kind: 'expiration', dueAt: '2027-03-31' },
      { credentialId: 'c1', kind: 'renewal_start', dueAt: addDays('2027-03-31', -LEAD_DAYS.license) },
      { credentialId: 'c2', kind: 'expiration', dueAt: '2026-11-30' },
      { credentialId: 'c2', kind: 'renewal_start', dueAt: addDays('2026-11-30', -LEAD_DAYS.malpractice) },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harness/core-tools test -- compute`
Expected: FAIL, cannot find module `./compute.js`.

- [ ] **Step 3: Implement compute.ts**

`harness/core-tools/src/deadlines/compute.ts`:
```ts
export const CREDENTIAL_KINDS = ['license', 'dea', 'malpractice', 'board_cert'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

export const LEAD_DAYS: Record<CredentialKind, number> = {
  license: 90,
  dea: 90,
  malpractice: 60,
  board_cert: 120,
};

const DAY_MS = 86_400_000;

function toUtcMidnight(dateStr: string): number {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function fromUtcMidnight(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function daysUntil(dueAt: string, today: Date): number {
  const todayMidnight = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  return Math.round((toUtcMidnight(dueAt) - todayMidnight) / DAY_MS);
}

export function addDays(dateStr: string, days: number): string {
  return fromUtcMidnight(toUtcMidnight(dateStr) + days * DAY_MS);
}

export interface CredentialLike {
  id: string;
  kind: string;
  expiresAt: string | null;
}

export interface ComputedDeadline {
  credentialId: string;
  kind: 'expiration' | 'renewal_start';
  dueAt: string;
}

export function computeDeadlines(creds: CredentialLike[]): ComputedDeadline[] {
  const out: ComputedDeadline[] = [];
  for (const c of creds) {
    if (!c.expiresAt) continue;
    const lead = LEAD_DAYS[c.kind as CredentialKind] ?? 90;
    out.push({ credentialId: c.id, kind: 'expiration', dueAt: c.expiresAt });
    out.push({ credentialId: c.id, kind: 'renewal_start', dueAt: addDays(c.expiresAt, -lead) });
  }
  return out;
}
```

- [ ] **Step 4: Run compute tests to verify pass**

Run: `pnpm --filter @harness/core-tools test -- compute` → PASS, 3 tests.

- [ ] **Step 5: Write the failing deadlines tool tests**

`harness/core-tools/src/tools/deadlines.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { McpServer } from '@modelcontextprotocol/server';
import { deadlines, type Db } from '@harness/db';
import { registerTools, type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { providerTools } from './providers.js';
import { deadlineTools } from './deadlines.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db, { now: () => new Date('2026-09-15T12:00:00Z') });
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

const factory = () => {
  const server = new McpServer({ name: 'deadlines-test', version: '0.0.0' });
  registerTools(server, [...providerTools, ...deadlineTools], deps);
  return server;
};

async function seed(client: Awaited<ReturnType<typeof makeTestClient>>['client']) {
  const res = await client.callTool({
    name: 'providers_upsert',
    arguments: {
      name: 'Dr. Grace Hopper',
      npi: '1112223334',
      credentials: [
        { kind: 'license', state: 'NY', number: 'L1', expires_at: '2026-10-15' },
        { kind: 'dea', number: 'D1', expires_at: '2027-06-30' },
        { kind: 'malpractice', number: 'M1', expires_at: '2026-09-01' },
      ],
    },
  });
  return (res.structuredContent as { result: { provider_id: string } }).result.provider_id;
}

describe('deadlines tools', () => {
  it('compute writes one row per credential and kind, idempotently', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    const first = await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect((first.structuredContent as { result: { deadlines: unknown[] } }).result.deadlines).toHaveLength(6);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    expect(await db.select().from(deadlines)).toHaveLength(6);
    await c();
  });

  it('upcoming returns items inside the window, flags overdue, sorted by due date', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 90 } });
    const items = (res.structuredContent as { result: { items: { credential_kind: string; kind: string; due_at: string; days_left: number; overdue: boolean; provider_name: string }[] } }).result.items;
    // today 2026-09-15: malpractice expiration 09-01 (overdue), malpractice renewal_start 07-03 (overdue),
    // license renewal_start 07-17 (overdue), license expiration 10-15 (30 days). DEA (2027-06-30, renewal 2027-04-01) is outside.
    expect(items.map((i) => `${i.credential_kind}:${i.kind}`)).toEqual([
      'malpractice:renewal_start',
      'license:renewal_start',
      'malpractice:expiration',
      'license:expiration',
    ]);
    expect(items[0].overdue).toBe(true);
    expect(items[3]).toMatchObject({ days_left: 30, overdue: false, provider_name: 'Dr. Grace Hopper' });
    await c();
  });

  it('upcoming accepts an explicit today', async () => {
    const { client, close: c } = await makeTestClient(factory);
    const id = await seed(client);
    await client.callTool({ name: 'deadlines_compute', arguments: { provider_id: id } });
    const res = await client.callTool({ name: 'deadlines_upcoming', arguments: { window_days: 30, today: '2027-06-15' } });
    const items = (res.structuredContent as { result: { items: { credential_kind: string; kind: string }[] } }).result.items;
    expect(items.some((i) => i.credential_kind === 'dea' && i.kind === 'expiration')).toBe(true);
    await c();
  });
});
```

- [ ] **Step 6: Run to verify failure**

Run: `pnpm --filter @harness/core-tools test -- tools/deadlines`
Expected: FAIL, cannot find module `./deadlines.js`.

- [ ] **Step 7: Implement tools/deadlines.ts**

`harness/core-tools/src/tools/deadlines.ts`:
```ts
import * as z from 'zod/v4';
import { and, asc, eq, lte } from 'drizzle-orm';
import { credentials, deadlines, providers } from '@harness/db';
import { defineTool, type AnyToolDef } from '../registry.js';
import { computeDeadlines, daysUntil, addDays } from '../deadlines/compute.js';

const deadlinesCompute = defineTool({
  name: 'deadlines_compute',
  description: 'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
  actionClass: 'write.internal',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    deadlines: z.array(z.object({ credential_id: z.string(), kind: z.string(), due_at: z.string() })),
  }),
  handler: async ({ provider_id }, deps) => {
    const creds = await deps.db.select().from(credentials).where(eq(credentials.providerId, provider_id));
    const computed = computeDeadlines(creds.map((c) => ({ id: c.id, kind: c.kind, expiresAt: c.expiresAt })));
    for (const d of computed) {
      await deps.db
        .insert(deadlines)
        .values({ providerId: provider_id, credentialId: d.credentialId, kind: d.kind, dueAt: d.dueAt })
        .onConflictDoUpdate({ target: [deadlines.credentialId, deadlines.kind], set: { dueAt: d.dueAt } });
    }
    return { deadlines: computed.map((d) => ({ credential_id: d.credentialId, kind: d.kind, due_at: d.dueAt })) };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const deadlinesUpcoming = defineTool({
  name: 'deadlines_upcoming',
  description: 'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date.',
  actionClass: 'read',
  input: z.object({
    window_days: z.number().int().min(1).max(730).default(90),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        provider_id: z.string(),
        provider_name: z.string(),
        credential_id: z.string(),
        credential_kind: z.string(),
        kind: z.string(),
        due_at: z.string(),
        days_left: z.number(),
        overdue: z.boolean(),
      }),
    ),
  }),
  handler: async ({ window_days, today }, deps) => {
    const todayDate = today ? new Date(`${today}T00:00:00Z`) : deps.now();
    const todayStr = todayDate.toISOString().slice(0, 10);
    const horizon = addDays(todayStr, window_days);
    const rows = await deps.db
      .select({
        providerId: deadlines.providerId,
        providerName: providers.name,
        credentialId: deadlines.credentialId,
        credentialKind: credentials.kind,
        kind: deadlines.kind,
        dueAt: deadlines.dueAt,
      })
      .from(deadlines)
      .innerJoin(credentials, eq(deadlines.credentialId, credentials.id))
      .innerJoin(providers, eq(deadlines.providerId, providers.id))
      .where(and(eq(providers.client, deps.client), lte(deadlines.dueAt, horizon)))
      .orderBy(asc(deadlines.dueAt));
    return {
      items: rows.map((r) => {
        const daysLeft = daysUntil(r.dueAt, todayDate);
        return {
          provider_id: r.providerId,
          provider_name: r.providerName,
          credential_id: r.credentialId,
          credential_kind: r.credentialKind,
          kind: r.kind,
          due_at: r.dueAt,
          days_left: daysLeft,
          overdue: daysLeft < 0,
        };
      }),
    };
  },
});

export const deadlineTools: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
```

- [ ] **Step 8: Run to verify pass, typecheck, commit**

Run: `pnpm --filter @harness/core-tools test` → PASS, all tests so far (5 policy + 5 registry + 6 providers + 3 compute + 3 deadlines = 22).
Run: `pnpm --filter @harness/core-tools typecheck` → no errors.

```bash
git add harness/core-tools/src/deadlines harness/core-tools/src/tools/deadlines.ts harness/core-tools/src/tools/deadlines.test.ts
git commit -m "feat(core-tools): deterministic deadline math and deadlines toolset

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 8: Audit query tool, server assembly, stdio entrypoint

**Files:**
- Create: `harness/core-tools/src/tools/audit.ts`, `harness/core-tools/src/server.ts`, `harness/core-tools/src/main.ts`
- Test: `harness/core-tools/src/tools/audit.test.ts`, `harness/core-tools/src/main.test.ts`
- Modify: `README.md` (add "Run locally" section)

**Interfaces:**
- Consumes: all toolsets, `loadPolicy`, `createDb`, `loadKey`.
- Produces:
  - `auditTools: AnyToolDef[]` with `audit_query` (read): `{ tool?, decision?, since?, limit? }` → `{ entries: [{ id, tool, action_class, decision, caller, record_ids, approval_id, created_at }] }`.
  - `createCoreToolsServer(deps: ToolDeps): McpServer` registering providers, deadlines, and audit toolsets.
  - `buildDepsFromEnv(): Promise<{ deps: ToolDeps; close(): Promise<void> }>`.
  - `main.ts` serves the server over stdio; logs to stderr only.

- [ ] **Step 1: Write the failing audit tool test**

`harness/core-tools/src/tools/audit.test.ts`:
```ts
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { type Db } from '@harness/db';
import { type ToolDeps } from '../registry.js';
import { makeTestDeps, makeTestClient, openTestDb } from '../testing.js';
import { createCoreToolsServer } from '../server.js';

let db: Db;
let close: () => Promise<void>;
let reset: () => Promise<void>;
let deps: ToolDeps;

beforeAll(() => {
  ({ db, close, reset } = openTestDb());
  deps = makeTestDeps(db);
});
afterAll(async () => {
  await close();
});
beforeEach(async () => {
  await reset();
});

describe('audit_query', () => {
  it('lists prior tool calls newest first and filters by tool', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    await client.callTool({ name: 'providers_upsert', arguments: { name: 'Dr. X' } });
    const all = await client.callTool({ name: 'audit_query', arguments: {} });
    const entries = (all.structuredContent as { result: { entries: { tool: string; decision: string }[] } }).result.entries;
    // audit_query itself is audited after it returns, so it is not in its own result
    expect(entries.map((e) => e.tool)).toEqual(['providers_upsert', 'providers_search']);
    const filtered = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_upsert' } });
    expect((filtered.structuredContent as { result: { entries: unknown[] } }).result.entries).toHaveLength(1);
    await c();
  });

  it('server exposes all expected tools', async () => {
    const { client, close: c } = await makeTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name).sort();
    expect(names).toEqual([
      'audit_query',
      'deadlines_compute',
      'deadlines_upcoming',
      'providers_confirm_field',
      'providers_get',
      'providers_list_pending',
      'providers_search',
      'providers_upsert',
    ]);
    await c();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm --filter @harness/core-tools test -- audit`
Expected: FAIL, cannot find module `../server.js`.

- [ ] **Step 3: Implement tools/audit.ts and server.ts**

`harness/core-tools/src/tools/audit.ts`:
```ts
import * as z from 'zod/v4';
import { and, desc, eq, gte, type SQL } from 'drizzle-orm';
import { auditLog } from '@harness/db';
import { defineTool, type AnyToolDef } from '../registry.js';

const auditQuery = defineTool({
  name: 'audit_query',
  description: 'Query the append-only audit log of tool calls for this client. Newest first.',
  actionClass: 'read',
  input: z.object({
    tool: z.string().optional(),
    decision: z.enum(['auto', 'approval', 'blocked', 'error']).optional(),
    since: z.string().datetime().optional(),
    limit: z.number().int().min(1).max(500).default(50),
  }),
  output: z.object({
    entries: z.array(
      z.object({
        id: z.string(),
        tool: z.string(),
        action_class: z.string(),
        decision: z.string(),
        caller: z.string(),
        record_ids: z.array(z.string()),
        approval_id: z.string().nullable(),
        error: z.string().nullable(),
        created_at: z.string(),
      }),
    ),
  }),
  handler: async ({ tool, decision, since, limit }, deps) => {
    const conditions: SQL[] = [eq(auditLog.client, deps.client)];
    if (tool) conditions.push(eq(auditLog.tool, tool));
    if (decision) conditions.push(eq(auditLog.decision, decision));
    if (since) conditions.push(gte(auditLog.createdAt, new Date(since)));
    const rows = await deps.db
      .select()
      .from(auditLog)
      .where(and(...conditions))
      .orderBy(desc(auditLog.createdAt))
      .limit(limit);
    return {
      entries: rows.map((r) => ({
        id: r.id,
        tool: r.tool,
        action_class: r.actionClass,
        decision: r.decision,
        caller: r.caller,
        record_ids: (r.recordIds as string[]) ?? [],
        approval_id: r.approvalId,
        error: r.error,
        created_at: r.createdAt.toISOString(),
      })),
    };
  },
});

export const auditTools: AnyToolDef[] = [auditQuery];
```

`harness/core-tools/src/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/server';
import { createDb, loadKey } from '@harness/db';
import { registerTools, type ToolDeps } from './registry.js';
import { loadPolicy } from './policy.js';
import { providerTools } from './tools/providers.js';
import { deadlineTools } from './tools/deadlines.js';
import { auditTools } from './tools/audit.js';

export const ALL_TOOLS = [...providerTools, ...deadlineTools, ...auditTools];

export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  registerTools(server, ALL_TOOLS, deps);
  return server;
}

export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const deps: ToolDeps = {
    db,
    client: process.env.HARNESS_CLIENT ?? 'default',
    caller: process.env.CORE_TOOLS_CALLER ?? 'hermes',
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: Number(process.env.APPROVAL_TTL_HOURS ?? 24),
    confidenceThreshold: Number(process.env.CONFIDENCE_THRESHOLD ?? 0.85),
  };
  return { deps, close };
}

export { registerTools, defineTool, type ToolDeps, type AnyToolDef } from './registry.js';
```

`harness/core-tools/src/main.ts`:
```ts
import 'dotenv/config';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { buildDepsFromEnv, createCoreToolsServer } from './server.js';

const { deps, close } = await buildDepsFromEnv();

serveStdio(() => createCoreToolsServer(deps));
console.error(`core-tools listening on stdio (client=${deps.client}, caller=${deps.caller})`);

process.on('SIGINT', () => {
  void close().then(() => process.exit(0));
});
process.on('SIGTERM', () => {
  void close().then(() => process.exit(0));
});
```

- [ ] **Step 4: Run audit tests to verify pass**

Run: `pnpm --filter @harness/core-tools test -- audit` → PASS, 2 tests.

- [ ] **Step 5: Write the stdio smoke test**

`harness/core-tools/src/main.test.ts`:
```ts
import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TEST_DATABASE_URL } from '@harness/db/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('stdio entrypoint', () => {
  it('spawns and lists tools', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        CORE_TOOLS_CALLER: 'smoke-test',
      },
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain('providers_upsert');
    await client.close();
  }, 30_000);
});
```

- [ ] **Step 6: Run the full suite**

Run: `pnpm test`
Expected: PASS across `@harness/db` (8) and `@harness/core-tools` (25). If the stdio test times out, run `pnpm --filter @harness/core-tools start` manually with the env from `.env.example` and read stderr for the startup error.

- [ ] **Step 7: Add the Run locally section to README.md**

Append to `README.md`:
```markdown
## Run locally

```bash
pnpm install
cp .env.example .env            # then set HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm db:up                      # Postgres 16 with databases harness and harness_test
pnpm db:migrate
pnpm test
pnpm --filter @harness/core-tools start   # core-tools MCP server on stdio
```

Inspect the tools interactively:

```bash
npx @modelcontextprotocol/inspector pnpm --filter @harness/core-tools start
```
```

- [ ] **Step 8: Typecheck everything and commit**

Run: `pnpm typecheck` → no errors.

```bash
git add harness/core-tools README.md
git commit -m "feat(core-tools): audit query tool, server assembly, stdio entrypoint

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
git push
```

---

## Self-review against the spec

- **4.3 Core tools**: action classes, policy middleware, audit rows, pending envelope: Tasks 4, 5. Providers, deadlines, audit toolsets: Tasks 6, 7, 8. Documents, verify, forms, approvals execute: Plan 2 and Plan 3, by design.
- **4.5 Approval engine**: table and pending-row creation with idempotency and TTL: Task 2 and Task 5. Slack app, decisions, `approvals_execute`, expiry job: Plan 3.
- **4.6 Record store**: all nine tables, encrypted restricted columns, append-only trigger: Tasks 2, 3.
- **6 Security**: encryption at rest, audit trigger, secrets in `.env`: Tasks 1 to 3. Docker terminal backend, injection eval: Plans 2 and 3.
- **8 Testing**: unit tests for deadline math and policy, integration through the real MCP handler, stdio smoke test: Tasks 4 to 8.
- **Run id** (spec 4.3 step 4): audit rows carry a nullable `run_id`; correlating calls to a Hermes session is deferred to Plan 3, where the runtime can pass a session identifier. Noted here so it is not lost.
- **Type consistency**: `ToolDeps` fields (`db, client, caller, policy, encryptionKey, now, approvalTtlHours, confidenceThreshold`) are identical in Tasks 5, 6, 7, 8. Envelope shape `{ status, approval_id?, result? }` is identical in registry and every test. `FieldInput` and `CredentialInput` are exported from Task 6 for Plan 2.
