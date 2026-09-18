# Plan 10: Knowledge and the run API — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel a knowledge base it can cite from, filtered by who is asking, and give the host an HTTP way to drive a run. A client's `knowledge/` folder is walked by `knowledge_sync` into `knowledge_documents` and `knowledge_chunks`, each chunk carrying a `tsvector` and a `vector(1024)` embedding from the gateway's new `embed` route; `knowledge_search` runs a cosine top-k and a `ts_rank_cd` top-k, both filtered by `client` and by the caller's level or an explicit principal grant *before* ranking, fuses them by reciprocal rank and returns chunks with their path, title and timestamp so the model can cite them. The run API is four routes in the host — open a run and stream it, cancel one, read a thread, read status — behind a bearer token on a loopback bind, with a new `http` surface plug-in giving those runs a thread key and an identity namespace. At the end of this plan a caller asks over HTTP and gets a cited answer drawn only from the documents their level allows, and a run driven over HTTP streams its events and stops when cancelled.

**Architecture:** Five moves. (1) **pgvector.** Migration 0013 adds `knowledge_sources`, `knowledge_documents` and `knowledge_chunks` with an HNSW index on the embedding and GIN indexes on the tsvector and on the principals array; because `drizzle-kit generate` writes no `CREATE EXTENSION` and hand-editing a generated migration is forbidden here, `runMigrations` issues `CREATE EXTENSION IF NOT EXISTS vector` before the migrator, and the Compose Postgres image becomes `pgvector/pgvector:pg16`, which CI already uses. (2) **The `embed` route.** `@harness/gateway` gains a fifth route; `embedTexts` in core-tools calls `POST /v1/embeddings` on the gateway and records a `model_calls` row; the fake gateway in `@harness/runtime-api` learns the same endpoint and answers deterministic unit vectors, so retrieval is tested end to end with no provider. (3) **Knowledge in core-tools.** `domain/knowledge/` holds the chunker (1,000 characters, 200 overlap, own code), the frontmatter reader, the repository, the sync and the fused search; `tools/knowledge.ts` publishes `knowledge_search` (`read`) and `knowledge_sync` (`write.internal`; the plan first said `admin`, which the policy blocks for the `service` principal the shipped playbook runs as — corrected during execution). (4) **The host's turn learns a watcher.** `TurnInput.observe` is called with the run id, then every `RunEvent`, then the turn's own outcome — the one hook the run API needs and the only change to `runTurn`. (5) **The run API.** `surfaces/http` is a new surface plug-in loaded through `HARNESS_SURFACES`; `harness/host/src/domain/api/` is a `node:http` server with hand-written Server-Sent Events, a bearer check, a body cap and per-thread serialisation, started by `app/main.ts` beside the health server.

**Tech Stack:** Node `>=22`, pnpm `11.4.0`, TypeScript 7 in every package (`typescript@6.0.3` at the workspace root only), ESM only, zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `^0.45.2` + drizzle-kit `^0.31.10`, `@modelcontextprotocol/server`/`client` v2, vitest 5, Postgres 16 with pgvector 0.8.6. **No new third-party dependency.** One new workspace package, `@harness/surface-http`, which depends only on `@harness/surface-api` and `@harness/shared`, as every adapter does.

**Spec:** `docs/superpowers/specs/2026-09-17-kernel-design.md` — this plan is the row "10 Knowledge and run API" of its section 10. It implements section 5.7 (knowledge), section 5.8 (the run API), migration 0013 of section 6, the `knowledge/` folder and the `embed` route of section 7, invariants 7 and 10 of section 8 as they apply to `knowledge_chunks`, and the exit criterion "a cited answer from `clients/demo-practice/knowledge/` at the caller's level; a run driven over HTTP streams and cancels". It starts from `worktree-plan-10-knowledge-run-api` at `be12228`, which **is** `main`: Plan 9 merged as "Merge pull request #3: Plan 9 — memory and playbooks". There is no rebase pending.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`; drizzle-orm `^0.45.2`.
- **The four gates pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; the type-aware warnings are a known backlog), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test` (lint, then every package's suite; needs Postgres on whatever `TEST_DATABASE_URL` names — in this worktree `postgres://harness:harness@localhost:15433/harness_test`, a pgvector database; see `.env.example` and the Facts table; the suites run serially — `fileParallelism: false`). No task ends red and no gate is parked.
- **Migrations:** edit `harness/db/src/domain/schema.ts`, then from `harness/db/` run `pnpm drizzle-kit generate` twice — the second run must print "No schema changes". Never `--custom`, and **never hand-edit a generated `.sql` file**. **Task 1 is the one migration of this plan, `0013_knowledge`.** No other task touches `schema.ts` or `drizzle/`.
- **New environment variables, and only these three:** `HARNESS_EMBED_DIMS` (Task 2), `HARNESS_HOST_TOKEN` and `HARNESS_HOST_BIND` (Task 9), plus `HARNESS_HOST_PORT` (Task 9; see decision 12 for why the spec's bind needs a port beside it) and the Compose-only `HARNESS_HOST_PUBLISHED_PORT` (Task 10, read by no TypeScript). Each is documented in `.env.example` **by the task that first reads it**, because `harness/core-tools/src/app/surface.test.ts` scans every non-test source file for environment reads and fails on a name the example file does not document.
- **Snapshots.** The tool-surface snapshot (`docs/architecture/tool-surface.json`) changes in **Task 6** only, which adds `knowledge_search` and `knowledge_sync`, re-records with `pnpm surface:record`, extends `RECORDED_TOOLS` in `harness/core-tools/src/app/surface.test.ts` from 28 to 30 names and moves the published-tool count in `harness/core-tools/src/app/dual-pack.test.ts` from 33 to 35. The Compose snapshot (`docs/architecture/compose-surface.yaml`) changes in **Task 1** (the Postgres image) and **Task 10** (the host's new port and variables) and in no other task. Every other task leaves both snapshots byte-identical, which `git status --short docs/architecture` proves.
- **One new package: `@harness/surface-http` (Task 8).** It adds one `PACKAGES` row and one `WORKSPACE_DIRS` entry to `.dependency-cruiser.cjs`, exactly as the file's "HOW A NEW PACKAGE IS ADDED" note says, and nothing else there changes. **No new third-party dependency anywhere**: the API server is `node:http`, the Server-Sent Events writer is ours, and the chunker is ours (see the Facts table for why each was not a package).
- **No framework import outside `runtimes/deepagents`.** Nothing in this plan imports `langchain`, `langgraph` or `deepagents`; the chunker is a `RecursiveCharacterTextSplitter`-equivalent written in `harness/core-tools/src/domain/knowledge/chunk.ts`, because the kernel-vocabulary test forbids those words in core-tools.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its **empty allowlist**. `harness/core-tools/src` and `harness/host/src` are scanned for `provider`, `credential`, `licen[cs]e`, `slack`, `bolt`, `blocks`, `deepagents`, `langchain`, `langgraph`, `entra`, `teams`, `demo-practice` and `hermes`: the knowledge modules say "identity plug-in" and "the gateway", never "provider"; the run API's modules name no surface; and Task 8 adds `surfaces/http/src` to the scanned roots for all four word lists, because an HTTP transport that knew a product area, a messaging vendor or a framework would be the coupling the surface contract exists to remove. A `*.test.ts` file is skipped by every scan. **`credential` is the word this plan keeps reaching for and must not write**: a bearer token is a natural thing to call a credential, the scan's own regex is `/provider|credential|licen[cs]e|…/i`, and it matches inside a comment — `kernel-vocabulary.test.ts` asserts that it catches `/** the credential this evidences */`. Say "token", "bearer secret" or "secret" in `harness/host/src` and `surfaces/http/src`. Only `.ts` files are scanned, so `.env.example`, the runbook and Compose may say whatever reads best.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **Host tests use `hostFixture`** (`harness/host/src/testing.ts`: `MemorySurface` + `StaticIdentity` + `ScriptedRuntime` over the real kernel and Postgres). **No test sleeps for more than 200 ms**, and no test waits for a real interval: the scheduler is driven by hand through `tick()`, and the run API's end-to-end test binds `127.0.0.1:0` and reads the port off the listening socket.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up`, `pnpm db:down` or `pnpm demo:up` from a task.** `docker compose ... config` is read-only and is what the surface recorder uses.
- **Never source `.env` into the shell before running tests.**
- Test database: whatever `TEST_DATABASE_URL` names — in this worktree `postgres://harness:harness@localhost:15433/harness_test`, which is a throwaway pgvector container beside the compose-managed Postgres on 15432, not the compose one. It exists; do not create or drop it, and run no container command against either. Task 1's migration test creates and drops `harness_test_migration_0013_<pid>` and `harness_test_migrate_all_<pid>` over that connection, as `migration-0012.test.ts` does. `runMigrations` runs from every package's `test-global-setup.ts`, so 0013 is applied to `harness_test` by the first suite that starts after Task 1.
- Do not push from a task. Do not open a pull request from a task.

---

## Facts verified for this plan

Read out of the worktree at `.claude/worktrees/plan-10-knowledge-run-api` (branch `worktree-plan-10-knowledge-run-api` at `be12228` (main after Plans 7-9)) or run in a scratch on 2026-09-18. File names and identifiers, never line numbers.

### pgvector, and where it is not

| Fact | Value | Where |
|---|---|---|
| The **Compose** Postgres has no pgvector, which is why Task 1 changes the image | the service is `image: postgres:16`, which does not ship the extension; against a `postgres:16` database `CREATE EXTENSION IF NOT EXISTS vector` answers `extension "vector" is not available` | `harness/compose/docker-compose.yml` |
| The **test** database does, and it is not the Compose one | this worktree's `.env` sets `TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test` — a throwaway pgvector container on port **15433**, beside the compose-managed one on 15432, which was left alone. `select name, default_version from pg_available_extensions where name = 'vector'` → `vector \| 0.8.6`, not yet installed | `pg` against `TEST_DATABASE_URL`, 2026-09-18 |
| CI already uses the right image | `.github/workflows/ci.yml`, service `postgres`, `image: pgvector/pgvector:pg16`, with the comment "The image Plan 10 will need for pgvector" | that file |
| `pgvector/pgvector:pg16` ships extension `vector` **0.8.6** | `CREATE EXTENSION` then `select extname, extversion from pg_extension` → `vector | 0.8.6` | throwaway `docker run --rm pgvector/pgvector:pg16`, psql |
| `vector(1024)`, HNSW `vector_cosine_ops`, GIN on a generated `tsvector` and GIN on `text[]` are all valid there | `CREATE TABLE … "embedding" vector(1024) …`; `CREATE INDEX … USING hnsw ("embedding" vector_cosine_ops)`; `CREATE INDEX … USING gin ("tsv")`; `CREATE INDEX … USING gin ("principals")` — all four succeeded; `1 - (embedding <=> $v)` returned `1` for the identical vector; `ts_rank_cd(tsv, plainto_tsquery('english','office closes'))` returned `0.1`; `principals @> ARRAY['u-coordinator']` matched | same probe |
| The embedding column's declared width is readable, and is the plain number | `select atttypmod from pg_attribute where attrelid = 'knowledge_chunks'::regclass and attname = 'embedding'` → `1024`. No `+4` offset, unlike `varchar` | same probe |
| pgvector's HNSW limit is 2,000 dimensions, so 1,024 is inside it | the index built without complaint at 1,024 | same probe |

### drizzle, and the one statement it will not write

| Fact | Value | Where |
|---|---|---|
| drizzle-orm 0.45.2 has a **native** `vector` column type — no `customType` is needed | `vector(name, { dimensions })` → `PgVectorBuilder`; `getSQLType()` renders `vector(N)` | `harness/db/node_modules/drizzle-orm/pg-core/columns/vector_extension/vector.d.ts` |
| `vector_cosine_ops` is a declared index op class | `PgIndexOpClass` includes `vector_l2_ops`, `vector_ip_ops`, `vector_cosine_ops`, `vector_l1_ops`, `halfvec_l2_ops` | `drizzle-orm/pg-core/indexes.d.ts` |
| drizzle-kit 0.31.10 emits **no** `CREATE EXTENSION` | a scratch schema with the three knowledge tables generated `CREATE TABLE "knowledge_chunks" (… "embedding" vector(1024) …)`, `CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);`, the two GIN indexes and the foreign keys — and not one `CREATE EXTENSION` line | `pnpm exec drizzle-kit generate --config=<scratch>` from `harness/db` |
| `extensionsFilters` is not a way to create one | the only value drizzle-kit's `Config` accepts is `'postgis'`, and it *filters* postgis-managed tables out of introspection | `harness/db/node_modules/drizzle-kit/index.d.mts` |
| Generating twice over that schema prints the expected line | second run: `No schema changes, nothing to migrate 😴` | same scratch |
| The generated SQL **fails** without the extension and **succeeds** with it | applied to a fresh database with no extension: `ERROR: type "vector" does not exist`; after `CREATE EXTENSION IF NOT EXISTS vector`, every statement succeeded | same probe |
| **Therefore:** the extension statement goes in `runMigrations`, before `migrate()` | `harness/db/src/domain/migrate.ts` is four lines and is what `db:migrate` and every package's `test-global-setup.ts` call. This is the drizzle-native place: it is not a hand-edited migration, it is idempotent, and `generate` twice still prints "No schema changes" | Task 1 |
| The existing `tsvector` custom type is already in the schema | `export const tsvector = customType<{ data: string; driverData: string }>({ dataType: () => 'tsvector' })`, used by `messages.tsv` with `.generatedAlwaysAs(sql\`to_tsvector('english', "content")\`)` and a GIN index | `harness/db/src/domain/schema.ts` |
| Migration 0012 is the last; the journal's last entry is `idx: 12, tag: 0012_memory_and_playbooks` | | `harness/db/drizzle/meta/_journal.json` |
| `migrationStatements(file)` splits a shipped migration on `--> statement-breakpoint` and drops `--` comment lines; `scratchDatabase(name)` creates and drops a database of its own over `TEST_DATABASE_URL` | | `harness/db/src/domain/migration-sql.test-helpers.ts`, `scratch-database.test-helpers.ts` |
| `resetDatabase` truncates fifteen tables today | `audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries, runs, messages, threads, approvals, deadlines, attachments, fields, documents, records` | `harness/db/src/testing.ts` |

### The gateway and the `embed` route

| Fact | Value | Where |
|---|---|---|
| LiteLLM exposes `POST /v1/embeddings`, OpenAI-compatible | the running proxy's `/openapi.json` lists `/v1/embeddings`, `/embeddings`, `/engines/{model}/embeddings`, `/openai/deployments/{model}/embeddings`; the `/v1/embeddings` description is "Follows the exact same API spec as OpenAI's Embeddings API", security `APIKeyHeader`, request body `{ model: string (required), input: string[] (default []), timeout: int (default 600), … }` | `curl -s http://127.0.0.1:4000/openapi.json`, LiteLLM `1.101.0` |
| The response is the OpenAI shape | `{ object: 'list', data: [{ object: 'embedding', index, embedding: number[] }], model, usage: { prompt_tokens, total_tokens } }` — what `embedTexts` parses | OpenAI embeddings API, which the route above declares it follows |
| `ROUTES` is a four-entry tuple with one definition | `export const ROUTES = ['chat', 'extract', 'reason', 'judge'] as const` in `@harness/gateway/routing`, re-exported by core-tools' `domain/models/types.ts`; `RoutingFile.routes` is a `.strict()` object requiring all four | `harness/gateway/src/domain/routing/types.ts` |
| The renderer loops `ROUTES` and needs no change to take a fifth | `for (const route of ROUTES) { … modelList.push(deployment(route, spec.model, budget, spec.api_base)) }`; `PROVIDER_KEY_ENV` already maps `gemini` → `GEMINI_API_KEY` | `harness/gateway/src/domain/routing/render.ts` |
| `litellm.config.yaml` is a generated, committed file | header "GENERATED FILE - do not edit by hand", regenerated with `pnpm gateway:config`, which reads `clients/$HARNESS_CLIENT/routing.yaml` | `harness/gateway/litellm.config.yaml`, `src/app/render-config.ts` |
| `callModel` posts to `${baseUrl}/v1/chat/completions`, counts calls per run against `gateway.maxCallsPerRun` using `db.$count(modelCalls, …)`, then writes one `model_calls` row with `route`, `model`, `inputTokens`, `outputTokens`, `costUsd` from the `x-litellm-response-cost` header | | `harness/core-tools/src/domain/models/gateway.ts` |
| The fake gateway answers only `/chat/completions` today | `if (req.method !== 'POST' || !req.url?.endsWith('/chat/completions')) { res.writeHead(404).end('{}') }`; it records `calls: FakeGatewayCall[]`, honours `setResponder`, and listens on `127.0.0.1:0` | `harness/runtime-api/src/gateway.ts` |

### Identity, levels and the kernel bag

| Fact | Value | Where |
|---|---|---|
| `LEVELS = ['member','practitioner','lead','admin','service']`; `USER_LEVELS` is the first four | | `harness/shared/src/levels.ts` |
| `levelAtLeast('service', x)` is true only for `x === 'service'`; a person is never "at least a service" | | `harness/identity-api/src/identity.ts` |
| `PRINCIPAL_ID_PATTERN = /^(u\|svc)-[a-z0-9][a-z0-9-]*$/`, exported from `@harness/identity-api`; `CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_@.-]{0,127}$/` and `SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/`, exported from `@harness/shared` | | `identity-api/src/principals.ts`, `shared/src/ids.ts` |
| `KernelConfig` is `ToolDeps` less `db`, `principal`, `context`, `sinks`, `tools`, `kernelTools`, `kernel`; `buildKernelConfig(env)` fills it once per process and `depsForRun(config, { db, principal, context })` clones it per run | | `harness/core-tools/src/domain/tooling/deps.ts`, `config.ts` |
| `ToolDeps` has **no** client-directory member today; the host computes `clientDir` itself in `app/main.ts` as `path.join(repoRoot, 'clients', config.client)`, and `loadPolicy()` reads an explicit `HARNESS_POLICY_FILE` | | `harness/host/src/app/main.ts`, `domain/tooling/policy.ts` |
| The image's working directory is the repository root by another name | `node.Dockerfile`: `WORKDIR /srv/agent-harness`, `COPY clients ./clients`, and Compose bind-mounts `../../clients:/srv/agent-harness/clients:ro` — so a repository root resolved from `import.meta.url` resolves `clients/<name>` correctly in the image and in a checkout alike | `harness/compose/node.Dockerfile`, `docker-compose.yml` |
| `ToolDef` carries `name, description, actionClass, actionClassFor?, input, output, handler, recordIds?, redact?`; `ACTION_CLASSES` includes `read` and `admin`; `DEFAULT_POLICY` makes `read` auto for every level and `admin` auto for `admin` only | | `harness/pack-api/src/types.ts`, `harness/core-tools/src/domain/tooling/policy.ts` |
| `makeTestDeps(db, overrides)` builds a whole `ToolDeps` with `client: 'test'`, `TEST_PRINCIPAL` (`u-test`, practitioner), a frozen clock at `2026-09-15T12:00:00Z` and a throwaway `storageDir`; `testKernelConfig(db, overrides)` in the host strips the per-run members off it | | `harness/core-tools/src/testing.ts`, `harness/host/src/testing.ts` |

### The host, the surfaces and the counts

| Fact | Value | Where |
|---|---|---|
| `runTurn(host, turn)` opens one kernel per run, renders memory, iterates `host.runtime.run(request).events`, applies `FORCED_OUTCOME` for a host abort, checks `containsRestrictedPattern` on the final text only, posts or streams per `deliver`, appends the assistant message and closes the run in a `finally` | | `harness/host/src/domain/conversation.ts` |
| `TurnInput` is `{ thread, principal, role, text, attachments, replyTo, deliver?, skills?, timeoutMs?, costCapUsd? }`; `TurnResult` is `{ runId, status, text, error }`; `TurnDelivery` is `'thread' | 'none' | { surface, conversation }` | | same |
| `cancelRun(host, runId)` returns false when no such run is active **or** its controller is already aborted, and otherwise aborts with `'cancelled'`; its doc comment already says "Plan 10's run API calls this" | | same |
| `serialize(host, threadId, fn)` chains a thread's turns and resolves `undefined` when the host is draining | | same |
| `Host` carries `db, config, client, identity, surfaces, runtime, persona, skills, model, budget, servicePrincipal, log, now, active, turns, draining` | | `harness/host/src/domain/host.ts` |
| `app/main.ts` order: db, `buildKernelConfig`, storage dirs, `clientDir`, identity, service principal, playbooks sync, surfaces, runtime, `host`, `core`, handlers, `startRunner`, `startScheduler`, `startHealthServer`, `session.start()`. Shutdown: `scheduler.stop()` created, `drainActive`, await the scheduler, `runner.stop()`, health, surfaces, runtime, identity, core, db | | `harness/host/src/app/main.ts` |
| `startHealthServer({ port, bind, snapshot })` is the repository's `node:http` pattern: `createServer`, a `ready` promise on `'listening'`, `address()` so a test can pass port 0, and a `close()` promise | | `harness/approvals/src/domain/health.ts` |
| `claimDuePlaybooks(db, { client, now, limit? })` has **no caller that passes `limit`** — `scheduler.ts` calls it with `{ client, now }` and every test does too | `grep -rn claimDuePlaybooks` over the workspace | `harness/host/src/domain/playbooks/repository.ts`, `scheduler.ts`, `repository.test.ts` |
| `SchedulerHandle` is `{ tick(), status(), stop() }` with `SchedulerStatus { lastTickAt, lastOkAt, lastError, lastErrorAt, ticking }`; nothing exposes it over HTTP today and `collectHealth` belongs to `@harness/approvals` and takes the runner, not the scheduler | | `harness/host/src/domain/playbooks/scheduler.ts`, `harness/approvals/src/domain/health.ts` |
| `SurfaceSession` requires `name, capabilities, defaultConversation, mention, postCard, updateCard, postText, postPrivate, uploadFile, openForm, onAction, onFormSubmit, onMessage, startStream, typing?, start, stop`; `SurfaceCapabilities` is `{ forms, privateReply, update, streaming, inlineConfirm }` | | `harness/surface-api/src/types.ts` |
| `surfaces/memory` is the whole of a minimal adapter: a `package.json` with one export and three dependencies, a `tsconfig.json` extending the base, an empty `vitest.config.ts`, a README and one `src/index.ts` calling `defineSurface` | | `surfaces/memory/` |
| **No test enumerates the surface packages or the values of `HARNESS_SURFACES`.** `registry.test.ts` loads `@harness/surface-memory` by name; `surface.test.ts` asserts only that the `host` service *defines* `HARNESS_SURFACES`, not what it holds | `grep -rn 'HARNESS_SURFACES\|loadSurfaces('` over the workspace | `harness/approvals/src/domain/surfaces/registry.test.ts`, `harness/core-tools/src/app/surface.test.ts` |
| A new package costs two lines in `.dependency-cruiser.cjs` | its own `PACKAGES` row at severity `error`, and a `WORKSPACE_DIRS` entry; `a-surface-imports-only-api-and-shared` already covers `^surfaces/([^/]+)/` and needs no edit | `.dependency-cruiser.cjs`, its "HOW A NEW PACKAGE IS ADDED" note |
| `RECORDED_TOOLS` holds **28** names today and `dual-pack.test.ts` asserts `toHaveLength(33)`; adding `knowledge_search` and `knowledge_sync` makes them **30** and **35** (22 kernel tools + 2 = 24, less healthcare's 7 replacements, plus healthcare's 18: 24 − 7 + 18 = 35) | counted off both files | `harness/core-tools/src/app/surface.test.ts`, `dual-pack.test.ts` |
| The Compose snapshot renders a **fully literal** published port as a map and an **interpolated** one as a string | `postgres` and `litellm` render `- host_ip: 127.0.0.1` / `mode: ingress` / `protocol: tcp` / `published: "15432"` / `target: 5432`; the host's health port, which carries `${APPROVALS_HEALTH_HOST_PORT:-8787}`, renders as the single line `- 127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}:8787`, because `--no-interpolate` leaves Compose unable to parse it into parts | `docs/architecture/compose-surface.yaml` |
| The environment scan walks `harness`, `packs`, `surfaces`, `identities`, `runtimes`, `evals`, `scripts` for direct `process.env` reads, indexed reads and calls to `numberFromEnv`, `booleanFromEnv`, `requiredEnv`, `optionalEnv`, `envOrDefault`, `required`, `seconds`, `port` — so `surfaces/http` is scanned from the moment it exists | | `harness/core-tools/src/app/record-surface.ts` |
| The scaffolder copies `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`, `playbooks.yaml`, `.env.example` from `clients/demo-practice`, rewriting the slug and display name; `scaffold.test.ts` pins that list | | `scripts/src/domain/scaffold.ts` |
| `readSkillCatalogue(dirs)` walks each directory in name order, requires a `SKILL.md` with frontmatter `name` (matching the directory), `description` and `version`, and returns `RunSkill[]`; `app/main.ts` calls it with `config.packs.skillsDirs()` | | `harness/host/src/domain/skills.ts` |
| `preflightPlaybook` refuses a playbook whose `skill` is not in `host.skills` — so a playbook that calls `knowledge_sync` needs a skill to name | `skill "<name>" is not in any loaded pack` | `harness/host/src/domain/playbooks/preflight.ts` |

### Why no new dependency

| Candidate | Why not |
|---|---|
| A vector-store client (`pgvector` npm, `@langchain/community`) | drizzle-orm 0.45.2 already renders `vector(N)` and the `<=>` operator is one `sql` fragment. A client would add a second way to talk to the same table. |
| `langchain`'s `RecursiveCharacterTextSplitter` | The kernel-vocabulary test forbids `langchain` in `harness/core-tools/src`, and the splitter is thirty lines with a documented separator list. Task 3 writes it with its own tests. |
| An SSE library (`better-sse`, `sse-channel`) | The wire format is `event: <name>\ndata: <json>\n\n`. `harness/host/src/domain/api/sse.ts` is under forty lines and the repository already hand-writes `text/event-stream` in the fake gateway. |
| An HTTP framework (`express`, `fastify`, `hono`) | Four routes, one bearer check, one body cap. `startHealthServer` is the pattern this repository already uses for a `node:http` listener with a `ready` promise and a `close()`. |
| A YAML frontmatter package (`gray-matter`) | `harness/host/src/domain/skills.ts` already parses frontmatter with one regular expression and the `yaml` package, which core-tools does not yet depend on — so Task 3 reuses the regular expression and parses the small block with `yaml`, which **is** added to `@harness/core-tools`'s dependencies. That is a workspace-wide package already used by `@harness/host`, `@harness/gateway` and `@harness/pack-api`, at the same `^2.9.1`, so the lockfile gains no new resolution. |

---

## Decisions where the spec leaves a detail open

1. **The `CREATE EXTENSION` lives in `runMigrations`, not in migration 0013.** Spec 6 lists `CREATE EXTENSION vector` under 0013, but `drizzle-kit generate` writes no such statement (Facts), and this repository forbids `--custom` and forbids hand-editing a generated `.sql`. The statement is therefore issued by `runMigrations` immediately before `migrate(db, …)`, as `CREATE EXTENSION IF NOT EXISTS vector`: idempotent, run by `pnpm db:migrate` and by every package's `test-global-setup.ts`, and covered by two tests — one that `runMigrations` against a bare scratch database leaves `vector` installed and `knowledge_chunks` created, and one that 0013's shipped SQL replayed *without* it fails with `type "vector" does not exist`, so the ordering is proven rather than assumed. The migration file itself is exactly what the generator wrote.

2. **The embedding width is fixed in the table at 1,024 and `HARNESS_EMBED_DIMS` is checked against it at startup.** A drizzle migration is static SQL and cannot read an environment variable, so `knowledge_chunks.embedding` is `vector(1024)` — the spec's default for `HARNESS_EMBED_DIMS`. `assertEmbedDims(db, dims)` reads `atttypmod` from `pg_attribute` for that column (the plain number, verified above) and throws a `ConfigError` naming both numbers when they differ. It is called from both composition roots, `harness/host/src/app/main.ts` and `harness/core-tools/src/app/main.ts`, before anything connects. Changing the dimension is a new deployment with a new database, and the runbook says so in those words.

3. **A chunk carries `min_level` *and* `min_rank`.** The spec's filter is `min_level <= $level`, which Postgres cannot do on the level's name. `min_level` is the name a human reads in the table and the frontmatter wrote (one of the four `USER_LEVELS`), and `min_rank` is `USER_LEVELS.indexOf(min_level)` — `member` 0, `practitioner` 1, `lead` 2, `admin` 3 — which is what the `WHERE` clause compares and what the index covers. Both are denormalised from the document onto every chunk, as spec 5.7 spells the chunk out.

4. **A `service` principal has rank `-1`, so it sees only what names it.** `levelAtLeast('service', 'member')` is false, and the ranks start at 0, so `min_rank <= -1` matches nothing: a scheduled job reads a knowledge document only when the document's `principals` array carries its id. That is the honest reading of the level ladder and of invariant 7, and it is asserted directly.

5. **The ACL is `client = $1 AND deleted_at IS NULL AND (min_rank <= $rank OR principals @> ARRAY[$principal])`, in the `WHERE` clause of both rankings.** Not applied to a result: a chunk the caller may not see is never ranked, never counted toward `k`, and never reaches the fusion (invariant 7). A frontmatter `min_level: lead` therefore means "a lead, an admin, or a principal this document names by id".

6. **Fusion is reciprocal rank with `RRF_K = 60`.** Each ranking contributes `1 / (RRF_K + rank)` where `rank` is 1-based within that list; a chunk in both lists gets both terms. Both lists are taken at `k` and the fused list is cut to `k`. 60 is the constant the original reciprocal-rank-fusion paper used and the one every implementation since has carried; it is a module constant with that comment, not a knob.

7. **The chunker is a recursive character splitter over `['\n\n', '\n', '. ', ' ', '']` at 1,000 characters with 200 of overlap, and a chunk may reach 1,200.** The overlap is carried from the tail of the previous chunk, cut at the first space inside it so a chunk never begins mid-word, which is why a chunk's bound is `size + overlap` rather than `size`. The test asserts that bound, that the pieces rejoin to the original text once the overlap is removed, and that a document with no separators at all still splits.

8. **`knowledge_sync` re-embeds a document only when its content hash or its access metadata changed.** The key is `(source_id, path)`; the hash is sha256 of the file's whole text, frontmatter included. Unchanged `sha256`, `min_level` and `principals` → the row is touched and nothing is embedded. Changed → the document's chunks are deleted and rewritten, which is one statement because `knowledge_chunks.document_id` is `ON DELETE CASCADE`. A file that has disappeared from the folder is tombstoned (`deleted_at = now()`) and its chunks are deleted, so its rows stay for an operator to see while nothing can retrieve them.

9. **A document whose text trips the restricted-pattern check is skipped, not fatal.** Invariant 10 says a restricted value never reaches `knowledge_chunks`. `knowledge_sync` runs `containsRestrictedPattern` over each chunk before inserting and, on a hit, writes no chunks for that document, tombstones nothing, and returns the path in `skipped: [{ path, reason }]` — so one bad file does not stop the folder from syncing and an operator is told exactly which file to fix. The reason names the category, never the text.

10. **The client folder reaches the kernel as `KernelConfig.clientDir`, derived, with no new environment variable.** `buildKernelConfig` resolves the repository root from `import.meta.url` and sets `clientDir = <root>/clients/<client>`, which is correct in a checkout and in the image alike (`WORKDIR /srv/agent-harness`, `COPY clients ./clients`). `harness/host/src/app/main.ts` stops computing its own copy and uses `config.clientDir`. `knowledge_sync` walks `<clientDir>/knowledge`; a missing folder is an empty sync and one line in the result, never an error.

11. **The run API is four routes in the host, and `http` is a surface plug-in beside it.** Spec 5.8 puts the API in the host, so the server lives in `harness/host/src/domain/api/` and is started by `app/main.ts`. It names no surface: the request body carries `surface`, the API looks it up with `host.surfaces.find(...)`, and the identity plug-in resolves `(surface, userId)` exactly as it does for an adapter — a caller cannot name a principal. `@harness/surface-http` is the surface a headless caller names: it gives those runs a `threads.surface` value, an identity namespace (`surfaces: { http: … }` in `identity.yaml`) and a loaded session for `runTurn` to find.

12. **`HARNESS_HOST_BIND` needs `HARNESS_HOST_PORT` beside it.** A bind address alone does not name a socket, and the repository's own precedent is `APPROVALS_HEALTH_BIND` + `APPROVALS_HEALTH_PORT` + the Compose-only `APPROVALS_HEALTH_HOST_PORT`. So: `HARNESS_HOST_BIND` (default `127.0.0.1`, as the spec says; Compose sets `0.0.0.0` because a container-loopback listener answers no published port), `HARNESS_HOST_PORT` (default `8788`, read by `app/main.ts`), and `HARNESS_HOST_PUBLISHED_PORT` (default `8788`, read by Compose alone and never by TypeScript, which is why it is documented in `.env.example` and absent from the scan).

13. **No token, no API.** `HARNESS_HOST_TOKEN` has no default. Unset or empty, `app/main.ts` starts no listener and logs one line saying the run API is off and which variable turns it on. A control plane that opened a socket with no credential because a variable was missing is the failure this avoids. The token is compared with `timingSafeEqual` over UTF-8 bytes after a length check, and `Surface.secrets`-style handling applies: it is never logged and never forwarded.

14. **The API's turn delivers nowhere: `deliver: 'none'`, and the Server-Sent Events stream is the reply.** The caller of the API is the one waiting for the answer; posting the same answer into the named surface's conversation as well would put a message there that no human asked for. So the turn records both messages on the thread and posts nothing, and everything the caller sees comes over the stream. That also settles `@harness/surface-http`'s capabilities: **`streaming: false`**, and `postText`, `postCard`, `updateCard`, `postPrivate`, `uploadFile`, `openForm` and `startStream` all reject with a `SurfaceError`, because a request-scoped HTTP exchange has no conversation that outlives the request to post into. This is a deliberate departure from the Plan 9 hand-off note's "`capabilities.streaming` true": with the server in the host, as spec 5.8 requires, the adapter never holds the response object a stream would have to write into, and a `startStream` that silently wrote nowhere would be an adapter that lies. **`http` must not be the primary surface** — approval cards have nowhere to go — and `.env.example` and the runbook both say to list it after the primary one.

15. **`runTurn` gains one hook, `observe`, and the API is its only caller.** `TurnInput.observe?: (event: TurnEvent) => void` where `TurnEvent = { type: 'run'; runId } | RunEvent | { type: 'result'; status; text; error }`. It is called once with the run id as soon as the kernel is open, once per event the runtime produces, and once with the turn's own outcome (the host's forced outcomes applied and the final text already passed through the restricted-pattern check). A watcher that throws is logged and swallowed — a turn is not failed by whoever is watching it. It receives the runtime's `text` deltas **unfiltered**, exactly as a streamed surface reply does today; the API's writer is what applies `containsRestrictedPattern` to each delta before it leaves the process, and the `result` frame carries the whole reply already withheld if it tripped.

16. **The API's status route is where the scheduler's status finally surfaces (the Plan 9 carry).** `GET /v1/status` answers six fields — `{ client, surfaces, primary_surface, runs_in_flight, draining, scheduler }` — bearer-protected like every other route. `primary_surface` because the first entry of `HARNESS_SURFACES` is where approval cards go and an operator who has just added `http` to that list wants to see which one won; `draining` because a process on its way out answers every other field normally and a caller deserves to know why its next run will be refused. Counts and names only: never a conversation, a principal or a message. `/healthz` is untouched: its shape is documented in the runbook and is read by container health checks, and widening it is not this plan's business.

17. **`claimDuePlaybooks`'s unused `limit` option is removed (the other Plan 9 carry).** No caller passes it. The bound itself is load-bearing — a tick must not claim an unbounded number of rows — so it becomes a module constant `CLAIM_BATCH = 10` with the comment that says why it exists, and the parameter goes.

18. **An unresolvable user is 403; another principal's thread or run is 404.** A bad or missing bearer token is `401 {"error":"unauthorised"}`. A token that is good but whose `(surface, userId)` resolves to no principal is `403 {"error":"that surface user is not a principal of this deployment"}` — it reveals nothing beyond what the caller already asserted. A thread or a run that exists but belongs to another principal is `404 {"error":"no such thread"}` / `{"error":"no such run"}`, the same answer a nonexistent one gets, so the API never confirms that someone else's row exists.

19. **Limits: a 1 MiB body, ten attachments, 10,000 characters of text, 200 messages on a thread read, and one run per thread.** The body cap is enforced while reading and answers `413`. Attachment paths are checked with `assertInsideRoot` against `<storageDir>/incoming` before the run opens, and an escape is `400`. Concurrency is `serialize(host, thread.id, …)`, the same chain an adapter's message takes, so two requests on one conversation run one after the other rather than over each other.

20. **The demo's `knowledge-sync` playbook names a skill the *host* ships.** *This amends spec 5.3, which says `skills.ts` builds its catalogue "from the loaded packs' `skillsDir`s" — after this plan it builds it from the kernel's own directory and then the packs'. The amendment is deliberate and its reason is below; record it against 5.3 rather than leaving it buried in a decision.* `preflightPlaybook` requires the playbook's skill to be in `host.skills`, and `host.skills` comes only from the packs today — so scheduling the sync would otherwise mean putting a kernel skill inside the healthcare pack. Instead the host gains a skills directory of its own, `harness/host/skills/`, holding exactly one skill, `knowledge-sync`, and `app/main.ts` reads `readSkillCatalogue([kernelSkillsDir(), ...config.packs.skillsDirs()])`. The alternative — making `playbooks.skill` nullable — needs a column change that migration 0013 is not allowed to carry.

21. **The demo's `embed` route points at a Gemini embedding deployment, and the client verifies the width it gets back.** Which vendor model returns exactly 1,024 dimensions is not something this plan can verify: it has no provider key and makes no network call. `embedTexts` therefore sends `dimensions: deps.embedDims` on every request (the OpenAI embeddings parameter, which LiteLLM passes through and `drop_params: true` drops for a deployment that does not take it) **and checks the length of every vector it gets back**, refusing with a fixed `ToolError` naming both numbers. The runbook's "Knowledge" section tells the operator the one `curl` that confirms it before the first sync.

---

## File structure

Paths are relative to the repository root.

### Migration 0013 and the extension (Task 1)

| File | Responsibility |
|---|---|
| `harness/db/src/domain/schema.ts` | `knowledgeSources`, `knowledgeDocuments`, `knowledgeChunks` |
| `harness/db/drizzle/0013_knowledge.sql`, `drizzle/meta/0013_snapshot.json`, `meta/_journal.json` | generated; never hand-edited |
| `harness/db/src/domain/migrate.ts` | `CREATE EXTENSION IF NOT EXISTS vector` before the migrator |
| `harness/db/src/domain/migrate.test.ts` (new) | `runMigrations` over a bare scratch database installs the extension and creates the tables |
| `harness/db/src/domain/migration-0013.test.ts` (new) | replays the shipped SQL; asserts it fails without the extension and succeeds with it |
| `harness/db/src/testing.ts` | `resetDatabase` truncates the three new tables |
| `harness/db/src/domain/schema.test.ts` | inserts a source, a document and a chunk; the cascade |
| `harness/compose/docker-compose.yml`, `docs/architecture/compose-surface.yaml` | `pgvector/pgvector:pg16`; snapshot re-recorded |

### The `embed` route and the embeddings client (Task 2)

| File | Responsibility |
|---|---|
| `harness/gateway/src/domain/routing/types.ts` + `routing.test-helpers.ts` | `ROUTES` gains `embed`; `RoutingFile.routes.embed` |
| `harness/gateway/litellm.config.yaml`, `clients/demo-practice/routing.yaml` | the route, and the re-rendered config |
| `harness/runtime-api/src/gateway.ts` + `gateway.test.ts` | `POST /v1/embeddings`, `fakeEmbedding`, `embeddings`, `setEmbeddingResponder` |
| `harness/core-tools/src/domain/knowledge/embed.ts` + test | `EMBED_ROUTE`, `EMBED_BATCH`, `embedTexts`, `assertEmbedDims` |
| `harness/core-tools/src/domain/tooling/types.ts`, `deps.ts`, `config.ts`, `testing.ts`, `app/record-surface.ts` | `embedDims` and `clientDir` on the bag |
| `harness/core-tools/src/domain/models/gateway.ts` | `callModel` refuses the `embed` route |
| `harness/core-tools/src/app/main.ts`, `harness/host/src/app/main.ts` | `assertEmbedDims` at startup; the host uses `config.clientDir` |
| `.env.example` | `HARNESS_EMBED_DIMS` |

### Knowledge in core-tools (Tasks 3–6)

| File | Responsibility |
|---|---|
| `harness/core-tools/src/domain/knowledge/types.ts` | the constants, `levelRank`, `KnowledgeHit`, `KnowledgeSyncResult`, `ParsedKnowledgeDocument` |
| `harness/core-tools/src/domain/knowledge/chunk.ts` + test | `CHUNK_SIZE`, `CHUNK_OVERLAP`, `chunkText` |
| `harness/core-tools/src/domain/knowledge/document.ts` + test | `parseKnowledgeDocument`, `readKnowledgeFolder` |
| `harness/core-tools/src/domain/knowledge/repository.ts` + test | `findOrCreateSource`, `upsertDocument`, `replaceChunks`, `tombstoneMissing`, `listDocuments` |
| `harness/core-tools/src/domain/knowledge/sync.ts` + test | `syncKnowledge` |
| `harness/core-tools/src/domain/knowledge/search.ts` + test | `searchKnowledge`, `fuseByReciprocalRank` |
| `harness/core-tools/src/tools/knowledge.ts` + test | the two tools |
| `harness/core-tools/src/tools/catalog.ts`, `src/index.ts`, `app/surface.test.ts`, `app/dual-pack.test.ts`, `docs/architecture/tool-surface.json` | publication and the snapshot |

### The host and the run API (Tasks 7, 9)

| File | Responsibility |
|---|---|
| `harness/host/src/domain/conversation.ts` + test | `TurnEvent`, `TurnInput.observe` |
| `harness/host/src/domain/playbooks/repository.ts` + test | `CLAIM_BATCH`; the `limit` option removed |
| `harness/host/src/domain/api/types.ts` | `RunApiOptions`, `RunApiServer`, the limits |
| `harness/host/src/domain/api/sse.ts` + test | `sseStream` |
| `harness/host/src/domain/api/routes.ts` + test | `handleApiRequest`, `bearerOk`, `readBody` |
| `harness/host/src/domain/api/server.ts` + test | `startRunApi` |
| `harness/host/src/app/main.ts`, `src/index.ts`, `src/testing.ts` | wiring, exports, `hostFixture` surfaces |
| `harness/host/skills/knowledge-sync/SKILL.md`, `harness/host/src/domain/skills.ts` | the one kernel skill and `kernelSkillsDir()` |

### The `http` surface (Task 8)

`surfaces/http/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/index.test.ts`; `.dependency-cruiser.cjs` (two lines); `harness/core-tools/src/kernel-vocabulary.test.ts` (four scan rows); `harness/host/package.json` (the workspace dependency).

### Client folder, Compose and docs (Tasks 10–11)

`clients/demo-practice/knowledge/front-desk.md` and `escalation-and-billing.md` (new), `playbooks.yaml`, `identity.yaml`, `routing.yaml`; `scripts/src/domain/scaffold.ts` + test; `harness/compose/docker-compose.yml`, `docs/architecture/compose-surface.yaml`; `.env.example`, `.env.ci`; `docs/runbook.md`, `docs/demo.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `harness/host/README.md`, `harness/core-tools/README.md`, `surfaces/http/README.md`, `docs/architecture/graph.svg`.

## Task order

Strictly sequential.

- **Task 1** (migration 0013, the extension, the Compose image) first: every table below is created here, and the local container has to be recreated on the pgvector image before it runs.
- **Task 2** (the `embed` route, `embedTexts`, `embedDims` and `clientDir` on the bag) before Tasks 3–6.
- **Task 3** (the chunker and the frontmatter reader) before Task 4: the sync calls both.
- **Task 4** (the repository and `syncKnowledge`) before Task 5: the search test seeds through it.
- **Task 5** (`searchKnowledge`, the ACL and the fusion) before Task 6.
- **Task 6** (the two tools, the tool-surface re-record) — the only task that touches `tool-surface.json`.
- **Task 7** (the turn's watcher; the playbook claim's dead option) before Task 9.
- **Task 8** (the `http` surface) before Task 9: Task 9's `.env.example` tells an operator to load it, and Task 10 puts it in Compose. Task 9's own end-to-end test drives the **memory** surface, because the API names no surface and `harness/host/src/testing.ts` may not import an adapter — `the-host-never-statically-imports-a-surface` forbids it.
- **Task 9** (the run API, the three environment variables, `app/main.ts`).
- **Task 10** (Compose, the demo client's knowledge folder, the sync playbook, the kernel skill, the scaffolder) after Task 9.
- **Task 11** (documentation) last.

Tasks 2, 3, 4, 5, 7, 8, 9 and 11 leave both snapshots byte-identical. Task 1 and Task 10 re-record the Compose snapshot. Task 6 re-records the tool-surface snapshot.

---

## Tasks

### Task 1: Migration 0013 — pgvector, `knowledge_sources`, `knowledge_documents`, `knowledge_chunks`

**Files:**
- Modify: `harness/compose/docker-compose.yml` (the `postgres` image)
- Modify: `docs/architecture/compose-surface.yaml` (re-recorded)
- Modify: `harness/db/src/domain/migrate.ts`
- Modify: `harness/db/src/domain/schema.ts`
- Create: `harness/db/drizzle/0013_knowledge.sql`, `harness/db/drizzle/meta/0013_snapshot.json` (generated); `harness/db/drizzle/meta/_journal.json` (updated by the generator)
- Create: `harness/db/src/domain/migration-0013.test.ts`
- Create: `harness/db/src/domain/migrate.test.ts`
- Modify: `harness/db/src/testing.ts` (`resetDatabase`)
- Modify: `harness/db/src/domain/schema.test.ts`

**Interfaces:**
- Consumes: `scratchDatabase` from `./scratch-database.test-helpers.js`, `migrationStatements` from `./migration-sql.test-helpers.js`, `TEST_DATABASE_URL` from `../testing.js`, `createDb` from `./client.js`.
- Produces:
  - `knowledgeSources` (`id, client, name, kind, location, lastSyncedAt, createdAt, updatedAt`), unique on `(client, name)`.
  - `knowledgeDocuments` (`id, client, sourceId, path, title, sha256, minLevel, minRank, principals, updatedAt, deletedAt`), unique on `(sourceId, path)`.
  - `knowledgeChunks` (`id, documentId, client, ordinal, text, tsv, embedding, minLevel, minRank, principals`), `documentId` `ON DELETE CASCADE`, HNSW on `embedding`, GIN on `tsv` and on `principals`.
  - `runMigrations(url?)` installs the `vector` extension before migrating.
  - `resetDatabase` truncating eighteen tables.

- [ ] **Step 1: Prove the database can take the extension, or stop**

Run, from the repository root:

```bash
node --input-type=module -e "
import pg from 'pg';
const c = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15433/harness_test' });
await c.connect();
await c.query('CREATE EXTENSION IF NOT EXISTS vector');
const r = await c.query(\"select extname, extversion from pg_extension where extname = 'vector'\");
console.log(JSON.stringify(r.rows));
await c.end();
" 2>&1
```

(Run it from `harness/db/` if `pg` does not resolve at the root: `cd harness/db && node --input-type=module -e '...'`.)

Expected: `[{"extname":"vector","extversion":"0.8.6"}]`.

`TEST_DATABASE_URL` is whatever `.env` sets it to, and in this worktree that is **not** the compose-managed Postgres: it is `postgres://harness:harness@localhost:15433/harness_test`, a throwaway pgvector container the controller started on port 15433, beside the compose one on 15432. The command above is the only check that matters — it asks the database the suite will actually use.

**If it prints `extension "vector" is not available`, STOP and report BLOCKED.** That means `TEST_DATABASE_URL` is pointing at a plain `postgres:16` after all, and only the controller can fix it. **Run no container command yourself** — not `docker run`, not `docker compose up`, not `docker compose down`, not `pnpm db:up` or `db:down`. Starting, stopping or recreating a database is the controller's step, and the compose-managed container must be left exactly as it is. Say which command printed what, and stop.

- [ ] **Step 2: Point Compose at the image that ships it**

In `harness/compose/docker-compose.yml`, in the `postgres` service, replace `image: postgres:16` with:

```yaml
    # Postgres 16 with pgvector (spec section 7): migration 0013 declares `embedding vector(1024)`
    # and `runMigrations` installs the extension before migrating, which a plain postgres:16
    # cannot answer. Same major version, same data directory layout, so an existing pgdata volume
    # is reused as it is — see "Upgrading from Plan 9" in docs/runbook.md.
    image: pgvector/pgvector:pg16
```

Leave the environment, ports, volumes and healthcheck exactly as they are.

- [ ] **Step 3: Re-record the Compose snapshot and check the diff is one line**

Run, from the repository root:

```bash
pnpm surface:record
git diff --stat docs/architecture
git diff docs/architecture/compose-surface.yaml
```

Expected: `docs/architecture/tool-surface.json` is **unchanged** (`git diff --stat` names only `compose-surface.yaml`), and the only hunk in `compose-surface.yaml` is `-    image: postgres:16` / `+    image: pgvector/pgvector:pg16`. If `tool-surface.json` moved, something else is wrong — stop and report it rather than committing it here.

- [ ] **Step 4: Write the failing schema test**

Append to `harness/db/src/domain/schema.test.ts`, inside `describe('schema', …)`, after the last `it`:

```ts
  it('stores a knowledge source, a document and its chunks, and drops the chunks with the document', async () => {
    const [source] = await db
      .insert(knowledgeSources)
      .values({ client: 'test', name: 'client-folder', kind: 'folder', location: 'clients/test/knowledge' })
      .returning();
    expect(source.lastSyncedAt).toBeNull();
    const [document] = await db
      .insert(knowledgeDocuments)
      .values({
        client: 'test',
        sourceId: source.id,
        path: 'front-desk.md',
        title: 'Front desk',
        sha256: 'a'.repeat(64),
        minLevel: 'member',
        minRank: 0,
      })
      .returning();
    expect(document).toMatchObject({ principals: [], deletedAt: null });
    await db.insert(knowledgeChunks).values([
      {
        documentId: document.id,
        client: 'test',
        ordinal: 0,
        text: 'the office closes at five',
        embedding: Array.from({ length: 1024 }, () => 0.01),
        minLevel: 'member',
        minRank: 0,
      },
      {
        documentId: document.id,
        client: 'test',
        ordinal: 1,
        text: 'escalate anything urgent',
        embedding: Array.from({ length: 1024 }, () => 0.02),
        minLevel: 'lead',
        minRank: 2,
        principals: ['u-coordinator'],
      },
    ]);
    expect(await db.$count(knowledgeChunks)).toBe(2);
    // The generated tsvector is filled by Postgres, so full-text search needs no writer.
    const matched = await db
      .select({ ordinal: knowledgeChunks.ordinal })
      .from(knowledgeChunks)
      .where(sql`${knowledgeChunks.tsv} @@ plainto_tsquery('english', 'office closes')`);
    expect(matched).toEqual([{ ordinal: 0 }]);
    // And the cascade: deleting the document takes its chunks with it, which is what lets a
    // re-sync replace a document's chunks in one statement.
    await db.delete(knowledgeDocuments).where(eq(knowledgeDocuments.id, document.id));
    expect(await db.$count(knowledgeChunks)).toBe(0);
  });
```

At the top of that file, widen the schema import to include `knowledgeChunks, knowledgeDocuments, knowledgeSources` and make sure `eq` and `sql` are imported from `drizzle-orm` (add whichever is missing to the existing import).

- [ ] **Step 5: Run it to verify it fails**

Run: `pnpm --filter @harness/db exec vitest run src/domain/schema.test.ts`
Expected: FAIL — `knowledgeSources`, `knowledgeDocuments` and `knowledgeChunks` are not exported (a typecheck error surfaces as a failed transform).

- [ ] **Step 6: Add the three tables to `schema.ts`**

In `harness/db/src/domain/schema.ts`, add `vector` to the `drizzle-orm/pg-core` import list (beside `customType`, `index`, `integer`, …). Then append the three tables at the end of the file, after `playbookRuns`:

```ts
/**
 * Where a knowledge document came from (spec 5.7). One row per place the sync walks, keyed by
 * name within the client; today the only kind is `folder`, the client's own `knowledge/`
 * directory, and `location` is the path the sync was given, for a human reading the table.
 * A second kind — a wiki, a share — adds a row here and a walker, and nothing below changes.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    location: text('location').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knowledge_sources_client_name_uq').on(t.client, t.name)],
);

/**
 * One markdown document of a source (spec 5.7), keyed by its path within that source. `sha256`
 * is of the file's whole text, frontmatter included, so a document is re-chunked and re-embedded
 * only when it actually changed. `min_level` is the level name the frontmatter carried and
 * `min_rank` is its position in the four user levels — the name is what a human reads, the rank
 * is what the access filter compares, because Postgres cannot order level names. `principals`
 * names individual principals who may read it whatever their level. A file that disappears from
 * the folder is tombstoned with `deleted_at`, never deleted: the row stays for an operator to
 * see while nothing can retrieve it.
 */
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id),
    /** Relative to the source's root, with forward slashes, e.g. `policies/front-desk.md`. */
    path: text('path').notNull(),
    title: text('title').notNull(),
    sha256: text('sha256').notNull(),
    minLevel: text('min_level').notNull(),
    minRank: integer('min_rank').notNull(),
    principals: text('principals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('knowledge_documents_source_path_uq').on(t.sourceId, t.path),
    index('knowledge_documents_client_idx').on(t.client, t.deletedAt),
  ],
);

/**
 * One retrievable piece of a document (spec 5.7). `tsv` is generated by Postgres from `text`, so
 * the lexical ranking needs no writer, and `embedding` is the vector the `embed` route produced.
 * The width is fixed at 1,024 here because a migration is static SQL: `HARNESS_EMBED_DIMS` is
 * checked against this column at startup (`assertEmbedDims`) rather than deciding it, and
 * changing it is a new deployment.
 *
 * `min_level`, `min_rank` and `principals` are copied down from the document on purpose: the
 * access filter has to be in the same WHERE clause as the ranking, and a join to the document
 * for every candidate row would put it one step too late (invariant 7).
 *
 * The three indexes are the three ways this table is read: HNSW with cosine distance for the
 * vector top-k, GIN on the tsvector for the lexical top-k, and GIN on the principals array for
 * the `@>` half of the access filter.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    client: text('client').notNull(),
    /** Position in the document, from 0, so a citation can say where in the page it came from. */
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    embedding: vector('embedding', { dimensions: 1024 }),
    minLevel: text('min_level').notNull(),
    minRank: integer('min_rank').notNull(),
    principals: text('principals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    index('knowledge_chunks_document_ordinal_idx').on(t.documentId, t.ordinal),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_tsv_idx').using('gin', t.tsv),
    index('knowledge_chunks_principals_idx').using('gin', t.principals),
  ],
);
```

- [ ] **Step 7: Generate the migration, twice**

Run, from `harness/db/`:

```bash
pnpm drizzle-kit generate --name knowledge
pnpm drizzle-kit generate
```

Expected: the first run writes `drizzle/0013_knowledge.sql` and `drizzle/meta/0013_snapshot.json` and appends `idx: 13, tag: "0013_knowledge"` to `_journal.json`; the second prints `No schema changes, nothing to migrate 😴`.

Open `drizzle/0013_knowledge.sql` and confirm it contains `CREATE TABLE "knowledge_sources"`, `CREATE TABLE "knowledge_documents"`, `CREATE TABLE "knowledge_chunks"` with `"embedding" vector(1024)` and `"tsv" "tsvector" GENERATED ALWAYS AS (to_tsvector('english', "text")) STORED`, the two foreign keys (the chunk one `ON DELETE cascade`), and these index statements:

```sql
CREATE INDEX "knowledge_chunks_embedding_idx" ON "knowledge_chunks" USING hnsw ("embedding" vector_cosine_ops);
CREATE INDEX "knowledge_chunks_tsv_idx" ON "knowledge_chunks" USING gin ("tsv");
CREATE INDEX "knowledge_chunks_principals_idx" ON "knowledge_chunks" USING gin ("principals");
```

**It will contain no `CREATE EXTENSION` line, and that is expected** — drizzle-kit does not write one. Do not add it by hand; Step 9 puts it where it belongs.

- [ ] **Step 8: Extend `resetDatabase`**

In `harness/db/src/testing.ts`, replace the `TRUNCATE` statement with:

```ts
    await db.execute(sql`
      TRUNCATE TABLE audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries,
        knowledge_chunks, knowledge_documents, knowledge_sources, runs, messages,
        threads, approvals, deadlines, attachments, fields, documents, records CASCADE
    `);
```

- [ ] **Step 9: Install the extension before the migrator**

Replace the whole of `harness/db/src/domain/migrate.ts` with:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../drizzle');

/**
 * Extensions the schema needs, installed before the migrator runs.
 *
 * `drizzle-kit generate` writes `CREATE TABLE`s and `CREATE INDEX`es and never a
 * `CREATE EXTENSION`, and this repository does not hand-edit a generated migration or use
 * `--custom` (see "Writing migrations" in docs/runbook.md). So the one statement the generator
 * cannot write is issued here, on every run, idempotently: migration 0013 declares
 * `embedding vector(1024)` and fails with `type "vector" does not exist` without it.
 *
 * It needs a database role that may create an extension. The application role must not be that
 * role — migrations are run by the owner, which is what "Database roles" in the runbook already
 * says — and `IF NOT EXISTS` makes the second and every later run a no-op rather than an error.
 */
const EXTENSIONS = ['vector'] as const;

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    for (const extension of EXTENSIONS) {
      await db.execute(sql.raw(`CREATE EXTENSION IF NOT EXISTS ${extension}`));
    }
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
```

- [ ] **Step 10: Run the schema test to verify it passes**

Run: `pnpm --filter @harness/db exec vitest run src/domain/schema.test.ts`
Expected: PASS (the package's `test-global-setup.ts` calls `runMigrations`, which installed the extension and then applied 0013 to `harness_test`).

- [ ] **Step 11: Write the two failing migration tests**

Create `harness/db/src/domain/migration-0013.test.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0013_knowledge.sql');
const scratch = scratchDatabase(`harness_test_migration_0013_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

/**
 * No legacy fixture: 0013 creates three tables that reference nothing outside themselves, so the
 * database it replays into starts empty. What it does need is the extension, and the first test
 * below is about exactly that — so the extension is installed inside the tests, not here.
 */
beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, 'SELECT 1'));
});
afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

const apply = async (): Promise<void> => {
  for (const statement of migrationStatements(MIGRATION)) await db.execute(sql.raw(statement));
};

describe('migration 0013_knowledge', () => {
  it('refuses to apply without the vector extension, which is why runMigrations installs it', async () => {
    // The whole reason the CREATE EXTENSION lives in runMigrations rather than in this file: a
    // deployment that ran the migrator alone against a plain Postgres gets this, not a table.
    await expect(apply()).rejects.toThrow(/type "vector" does not exist/);
  });

  it('creates the three tables, the HNSW and GIN indexes, and a 1024-wide embedding column', async () => {
    await db.execute(sql.raw('CREATE EXTENSION IF NOT EXISTS vector'));
    await apply();

    const tables = (
      await db.execute(
        sql.raw(
          `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' AND table_name LIKE 'knowledge%' ORDER BY table_name`,
        ),
      )
    ).rows;
    expect(tables).toEqual([
      { table_name: 'knowledge_chunks' },
      { table_name: 'knowledge_documents' },
      { table_name: 'knowledge_sources' },
    ]);

    // The declared width, read the way assertEmbedDims reads it at startup.
    const [column] = (
      await db.execute(
        sql.raw(
          `SELECT atttypmod FROM pg_attribute WHERE attrelid = 'knowledge_chunks'::regclass AND attname = 'embedding'`,
        ),
      )
    ).rows;
    expect(column).toEqual({ atttypmod: 1024 });

    const indexes = (
      await db.execute(
        sql.raw(
          `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'knowledge_chunks' ORDER BY indexname`,
        ),
      )
    ).rows as { indexname: string; indexdef: string }[];
    const byName = new Map(indexes.map((i) => [i.indexname, i.indexdef]));
    // `pg_indexes.indexdef` is Postgres re-rendering the index it actually built, not the text
    // of the migration: it drops the quotes the generator wrote around every identifier. So the
    // migration file says `USING hnsw ("embedding" vector_cosine_ops)` and this says the same
    // thing unquoted — as the two gin assertions below already do.
    expect(byName.get('knowledge_chunks_embedding_idx')).toContain('USING hnsw (embedding vector_cosine_ops)');
    expect(byName.get('knowledge_chunks_tsv_idx')).toContain('USING gin (tsv)');
    expect(byName.get('knowledge_chunks_principals_idx')).toContain('USING gin (principals)');
  });

  it('cascades a document delete to its chunks, filters by rank and by a named principal, and ranks both ways', async () => {
    const seed = `
      INSERT INTO knowledge_sources (id, client, name, kind, location)
      VALUES ('11111111-1111-4111-8111-111111111111', 'demo', 'client-folder', 'folder', 'clients/demo/knowledge');
      INSERT INTO knowledge_documents (id, client, source_id, path, title, sha256, min_level, min_rank, principals)
      VALUES ('22222222-2222-4222-8222-222222222222', 'demo', '11111111-1111-4111-8111-111111111111',
              'front-desk.md', 'Front desk', '${'a'.repeat(64)}', 'member', 0, '{}'),
             ('33333333-3333-4333-8333-333333333333', 'demo', '11111111-1111-4111-8111-111111111111',
              'escalation.md', 'Escalation', '${'b'.repeat(64)}', 'lead', 2, '{u-analyst}');
      INSERT INTO knowledge_chunks (document_id, client, ordinal, text, embedding, min_level, min_rank, principals)
      VALUES ('22222222-2222-4222-8222-222222222222', 'demo', 0, 'the office closes at five',
              (SELECT ('[' || string_agg('0.01', ',') || ']')::vector FROM generate_series(1, 1024)), 'member', 0, '{}'),
             ('33333333-3333-4333-8333-333333333333', 'demo', 0, 'escalate anything urgent to the duty lead',
              (SELECT ('[' || string_agg('0.02', ',') || ']')::vector FROM generate_series(1, 1024)), 'lead', 2, '{u-analyst}');
    `;
    await db.execute(sql.raw(seed));

    // A member sees one chunk; a lead sees both; an analyst named on the second sees both too.
    const visible = async (rank: number, principal: string): Promise<number> => {
      const [row] = (
        await db.execute(
          sql.raw(
            `SELECT count(*)::int AS n FROM knowledge_chunks c
             JOIN knowledge_documents d ON d.id = c.document_id
             WHERE c.client = 'demo' AND d.deleted_at IS NULL
               AND (c.min_rank <= ${rank} OR c.principals @> ARRAY['${principal}'])`,
          ),
        )
      ).rows as { n: number }[];
      return row.n;
    };
    expect(await visible(0, 'u-nobody')).toBe(1);
    expect(await visible(2, 'u-nobody')).toBe(2);
    expect(await visible(0, 'u-analyst')).toBe(2);
    // A service principal's rank is -1, so nothing clears on level alone.
    expect(await visible(-1, 'u-nobody')).toBe(0);
    expect(await visible(-1, 'u-analyst')).toBe(1);

    // Both rankings answer over the same rows.
    const [lexical] = (
      await db.execute(
        sql.raw(
          `SELECT ordinal FROM knowledge_chunks WHERE tsv @@ plainto_tsquery('english', 'office closes')`,
        ),
      )
    ).rows;
    expect(lexical).toEqual({ ordinal: 0 });
    const nearest = (
      await db.execute(
        sql.raw(
          `SELECT text FROM knowledge_chunks
           ORDER BY embedding <=> (SELECT ('[' || string_agg('0.02', ',') || ']')::vector FROM generate_series(1, 1024))
           LIMIT 1`,
        ),
      )
    ).rows as { text: string }[];
    expect(nearest[0].text).toContain('escalate');

    // And the cascade the re-sync depends on.
    await db.execute(sql.raw(`DELETE FROM knowledge_documents WHERE path = 'escalation.md'`));
    const [left] = (await db.execute(sql.raw('SELECT count(*)::int AS n FROM knowledge_chunks'))).rows as {
      n: number;
    }[];
    expect(left.n).toBe(1);
  });
});
```

Create `harness/db/src/domain/migrate.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import { createDb } from './client.js';
import { runMigrations } from './migrate.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const scratch = scratchDatabase(`harness_test_migrate_all_${process.pid}`);
const scratchUrl = (): string => {
  const parsed = new URL(TEST_DATABASE_URL);
  parsed.pathname = `/harness_test_migrate_all_${process.pid}`;
  return parsed.toString();
};

afterAll(async () => {
  await scratch.drop(TEST_DATABASE_URL);
});

describe('runMigrations', () => {
  it('installs the vector extension and then applies every migration, on a database that had neither', async () => {
    // `create` makes the database and applies a trivial fixture; the point of this test is that
    // runMigrations needs no help beyond that — no pre-installed extension, no manual DDL.
    const { close } = await scratch.create(TEST_DATABASE_URL, 'SELECT 1');
    await close();

    await runMigrations(scratchUrl());

    const { db, close: closeScratch } = createDb(scratchUrl());
    try {
      const [extension] = (
        await db.execute(sql.raw(`SELECT extname FROM pg_extension WHERE extname = 'vector'`))
      ).rows;
      expect(extension).toEqual({ extname: 'vector' });
      const [chunks] = (
        await db.execute(
          sql.raw(
            `SELECT to_regclass('public.knowledge_chunks')::text AS table_name`,
          ),
        )
      ).rows;
      expect(chunks).toEqual({ table_name: 'knowledge_chunks' });
      // Idempotent: a second run is the ordinary case (every test-global-setup calls it).
      await runMigrations(scratchUrl());
    } finally {
      await closeScratch();
    }
  }, 60_000);
});
```

- [ ] **Step 12: Run both migration tests to verify they pass**

Run: `pnpm --filter @harness/db exec vitest run src/domain/migration-0013.test.ts src/domain/migrate.test.ts`
Expected: PASS, four tests.

- [ ] **Step 13: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` shows `compose-surface.yaml` modified and `tool-surface.json` untouched.

- [ ] **Step 14: Commit**

```bash
git add harness/db/src/domain/schema.ts harness/db/drizzle harness/db/src/domain/migrate.ts \
  harness/db/src/domain/migrate.test.ts harness/db/src/domain/migration-0013.test.ts \
  harness/db/src/testing.ts harness/db/src/domain/schema.test.ts \
  harness/compose/docker-compose.yml docs/architecture/compose-surface.yaml
git commit -m "feat(db): add the knowledge tables on pgvector and install the extension before migrating"
```

---

### Task 2: The `embed` route, the embeddings client, and two new members on the kernel bag

**Files:**
- Modify: `harness/gateway/src/domain/routing/types.ts`, `routing.test-helpers.ts`
- Test: `harness/gateway/src/domain/routing/parse.test.ts`, `render.test.ts`
- Modify: `clients/demo-practice/routing.yaml`, `harness/gateway/litellm.config.yaml` (re-rendered)
- Modify: `harness/runtime-api/src/gateway.ts`
- Test: `harness/runtime-api/src/gateway.test.ts`
- Create: `harness/core-tools/src/domain/knowledge/embed.ts`
- Test: `harness/core-tools/src/domain/knowledge/embed.test.ts`
- Modify: `harness/core-tools/src/domain/models/types.ts`, `domain/models/gateway.ts`
- Modify: `harness/core-tools/src/domain/tooling/types.ts`, `domain/tooling/config.ts`, `src/testing.ts`, `src/app/record-surface.ts`, `src/app/main.ts`, `src/index.ts`
- Modify: `harness/core-tools/package.json` (`yaml`, used from Task 3 on)
- Modify: `harness/host/src/app/main.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `ToolDeps`, `GatewayConfig`, `modelCalls` from `@harness/db`, `ConfigError` / `ToolError` / `numberFromEnv` from `@harness/shared`.
- Produces:
  - `ROUTES = ['chat', 'extract', 'reason', 'judge', 'embed']` and `RoutingFile.routes.embed`.
  - `EMBED_ROUTE = 'embed'` from `harness/core-tools/src/domain/models/types.ts`.
  - `EMBED_BATCH = 64`; `embedTexts(deps: ToolDeps, texts: readonly string[]): Promise<number[][]>`; `assertEmbedDims(db: Db, dims: number): Promise<void>`.
  - `ToolDeps.embedDims: number` and `ToolDeps.clientDir: string` (so `KernelConfig` carries both).
  - On the fake gateway: `fakeEmbedding(text: string, dimensions: number): number[]`; `FakeGateway.embeddings: FakeEmbeddingCall[]`; `FakeGateway.setEmbeddingResponder(r: EmbeddingResponder): void`.

- [ ] **Step 1: Write the failing routing tests**

In `harness/gateway/src/domain/routing/parse.test.ts`, replace the first `it` with:

```ts
  it('names exactly the five spec routes', () => {
    expect([...ROUTES]).toEqual(['chat', 'extract', 'reason', 'judge', 'embed']);
  });
```

and add, after `'parses a routing file'`:

```ts
  it('requires the embed route, which knowledge_search and knowledge_sync call', () => {
    expect(() => parseRouting(ROUTING.replace(/\n  embed:\n[\s\S]*$/, '\n'))).toThrow(/embed/);
    expect(parseRouting(ROUTING).routes.embed.model).toBe('gemini/gemini-embedding-001');
  });
```

In `harness/gateway/src/domain/routing/render.test.ts`, change the expected deployment list to:

```ts
    expect(parsed.model_list.map((m) => m.model_name)).toEqual([
      'chat',
      'chat-fallback-1',
      'extract',
      'reason',
      'judge',
      'embed',
    ]);
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @harness/gateway exec vitest run`
Expected: FAIL — `ROUTES` has four entries and `routes.embed` does not exist.

- [ ] **Step 3: Add the route**

In `harness/gateway/src/domain/routing/types.ts`, change the routes tuple and its comment to:

```ts
/**
 * The five named routes. Callers ask for a *job* (`extract`, `embed`), never a vendor, so a
 * routing change is a config change. This is the single definition; @harness/core-tools imports
 * it through the `@harness/gateway/routing` subpath.
 *
 * `embed` is the odd one: it is an embeddings deployment, not a chat one, so `callModel` refuses
 * it and `embedTexts` in @harness/core-tools calls `POST /v1/embeddings` instead. It is a route
 * like the others here because everything a route *is* to this file — a model, fallbacks, a
 * daily budget, a rendered LiteLLM deployment — is the same for it.
 */
export const ROUTES = ['chat', 'extract', 'reason', 'judge', 'embed'] as const;
```

and add `embed: RouteSpec,` to the `routes` object of `RoutingFile`, after `judge`.

In `harness/gateway/src/domain/routing/routing.test-helpers.ts`, change the doc comment's first line to `/** All five spec routes, one with a fallback, each with a daily budget. */` and append to `ROUTING`, after the `judge` block and at the same two-space indentation:

```
  embed:
    model: gemini/gemini-embedding-001
    daily_budget_usd: 1
```

Leave the rest of that file's prose alone: `chat:` is still the first route and every route still sits at two spaces, which is what the other tests patch against. `judge:` is no longer the last, so update that sentence of the comment to say `embed:` is.

- [ ] **Step 4: Run the gateway tests to verify they pass**

Run: `pnpm --filter @harness/gateway exec vitest run`
Expected: PASS.

- [ ] **Step 5: Add the route to the demo client and re-render the LiteLLM config**

In `clients/demo-practice/routing.yaml`, after the `judge:` block, add:

```yaml
  # Embeddings for the knowledge base (spec 5.7). Called by knowledge_sync, once per batch of
  # chunks, and by knowledge_search, once per query. The harness asks for
  # HARNESS_EMBED_DIMS dimensions on every request and refuses a vector of any other width, so
  # check this deployment once before the first sync — see "Knowledge" in docs/runbook.md.
  embed:
    model: gemini/gemini-embedding-001
    daily_budget_usd: 1
```

Then run, from the repository root:

```bash
pnpm gateway:config
git diff harness/gateway/litellm.config.yaml
```

Expected: the diff adds one deployment at the end of `model_list`:

```yaml
  - model_name: embed
    litellm_params:
      model: gemini/gemini-embedding-001
      api_key: os.environ/GEMINI_API_KEY
      max_budget: 1
      budget_duration: 1d
```

and nothing else moves.

- [ ] **Step 6: Write the failing fake-gateway test**

Append to `harness/runtime-api/src/gateway.test.ts`, at the end of the file:

```ts
describe('the fake gateway embeddings endpoint', () => {
  it('answers deterministic unit vectors at the width the caller asked for, and records the call', async () => {
    const fake = await startFakeGateway();
    onTestFinished(() => fake.close());

    const response = await fetch(`${fake.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({ model: 'embed', input: ['the office closes at five', 'the office closes at five'], dimensions: 8, user: 'u-1' }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      object: string;
      model: string;
      data: { object: string; index: number; embedding: number[] }[];
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(payload.object).toBe('list');
    expect(payload.model).toBe('embed');
    expect(payload.data.map((d) => d.index)).toEqual([0, 1]);
    expect(payload.data[0].embedding).toHaveLength(8);
    // The same text always embeds the same, which is what makes a retrieval test assertable.
    expect(payload.data[0].embedding).toEqual(payload.data[1].embedding);
    // And it is a unit vector, so a cosine distance is a cosine distance.
    const norm = Math.sqrt(payload.data[0].embedding.reduce((n, x) => n + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(payload.usage.prompt_tokens).toBeGreaterThan(0);

    expect(fake.embeddings).toHaveLength(1);
    expect(fake.embeddings[0]).toMatchObject({
      model: 'embed',
      dimensions: 8,
      user: 'u-1',
      authorization: 'Bearer sk-test',
    });
    expect(fake.embeddings[0].input).toHaveLength(2);
    // Chat calls and embedding calls are recorded separately: a suite asserting on one must not
    // have to filter the other out.
    expect(fake.calls).toEqual([]);
  });

  it('gives different text different directions, and lets a responder force an error or a width', async () => {
    const fake = await startFakeGateway();
    onTestFinished(() => fake.close());
    const embed = async (input: string[]): Promise<Response> =>
      fetch(`${fake.url}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'embed', input, dimensions: 16 }),
      });

    const both = (await (await embed(['alpha beta', 'gamma delta'])).json()) as {
      data: { embedding: number[] }[];
    };
    const dot = both.data[0].embedding.reduce((n, x, i) => n + x * both.data[1].embedding[i], 0);
    expect(dot).toBeCloseTo(0, 10);

    fake.setEmbeddingResponder(() => ({ dimensions: 4 }));
    const narrow = (await (await embed(['alpha'])).json()) as { data: { embedding: number[] }[] };
    expect(narrow.data[0].embedding).toHaveLength(4);

    fake.setEmbeddingResponder(() => ({ status: 429, errorBody: { error: { message: 'over budget' } } }));
    const refused = await embed(['alpha']);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain('over budget');
  });
});
```

Make sure that file's imports include `onTestFinished` from `vitest` and `startFakeGateway` from `./gateway.js` (both are already used there; add whichever is missing).

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @harness/runtime-api exec vitest run src/gateway.test.ts`
Expected: FAIL — the server answers 404 for `/v1/embeddings` and `fake.embeddings` is undefined.

- [ ] **Step 8: Teach the fake gateway embeddings**

In `harness/runtime-api/src/gateway.ts`, add these declarations above `startFakeGateway` (after `Responder`):

```ts
export interface FakeEmbeddingCall {
  model: string;
  input: string[];
  /** The width the caller asked for, when it asked. */
  dimensions: number | undefined;
  user: string | undefined;
  authorization: string | undefined;
}

export interface FakeEmbeddingReply {
  /** The width to answer at. Defaults to the request's `dimensions`, then to 1,024. */
  dimensions?: number;
  /** Exact vectors, one per input, in place of the deterministic ones. */
  vectors?: number[][];
  /** Non-2xx to exercise the error path. Defaults to 200. */
  status?: number;
  errorBody?: unknown;
  promptTokens?: number;
  /** Value for the `x-litellm-response-cost` header. Omit to send no header. */
  costHeader?: string;
  /** Value for the response's `model` field. Defaults to the requested model. */
  modelName?: string;
}

export type EmbeddingResponder = (call: FakeEmbeddingCall) => FakeEmbeddingReply | Promise<FakeEmbeddingReply>;

/** The width the fake answers at when neither the request nor the responder says. */
export const FAKE_EMBED_DIMENSIONS = 1_024;

/**
 * A deterministic unit vector for a string.
 *
 * Each word is hashed (FNV-1a) into one bucket and adds one there; the vector is then normalised.
 * That gives a retrieval test everything it needs from an embedding and nothing a model would
 * give it: the same text always embeds the same, two texts sharing words point the same way, two
 * sharing none are orthogonal, and every vector has length 1 so a cosine distance is comparable.
 * Text with no words at all becomes the first basis vector rather than a zero vector, which
 * pgvector's cosine distance cannot order.
 */
export function fakeEmbedding(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  const tokens = text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token !== '');
  for (const token of tokens) {
    let hash = 2166136261;
    for (let i = 0; i < token.length; i += 1) {
      hash ^= token.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    vector[Math.abs(hash) % dimensions] += 1;
  }
  const norm = Math.sqrt(vector.reduce((sum, x) => sum + x * x, 0));
  if (norm === 0) {
    vector[0] = 1;
    return vector;
  }
  return vector.map((x) => x / norm);
}

interface EmbeddingRequestBody {
  model: string;
  input?: string | string[];
  dimensions?: number;
  user?: string;
}
```

Extend `FakeGateway` with the two new members:

```ts
export interface FakeGateway {
  url: string;
  calls: FakeGatewayCall[];
  /** Embedding requests, recorded apart from `calls` so a suite asserting on one ignores the other. */
  embeddings: FakeEmbeddingCall[];
  setResponder(responder: Responder): void;
  setEmbeddingResponder(responder: EmbeddingResponder): void;
  close(): Promise<void>;
}
```

Inside `startFakeGateway`, add beside `calls` and `respond`:

```ts
  const embeddings: FakeEmbeddingCall[] = [];
  let respondToEmbedding: EmbeddingResponder = () => ({});
```

and, in the request handler, replace the 404 guard with a branch on the path — the embeddings branch first, then the chat one, then the 404:

```ts
      if (req.method !== 'POST') {
        res.writeHead(404).end('{}');
        return;
      }
      if (req.url?.endsWith('/embeddings')) {
        let body: EmbeddingRequestBody;
        try {
          body = JSON.parse(await readBody(req)) as EmbeddingRequestBody;
        } catch {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify({ error: { message: 'the request body is not JSON', type: 'invalid_request_error' } }),
          );
          return;
        }
        // LiteLLM's own schema takes a string or a list; the harness always sends a list, and
        // accepting both here keeps the fake honest about what the real endpoint does.
        const input = typeof body.input === 'string' ? [body.input] : (body.input ?? []);
        const call: FakeEmbeddingCall = {
          model: body.model,
          input,
          dimensions: body.dimensions,
          user: body.user,
          authorization: req.headers.authorization,
        };
        embeddings.push(call);
        const reply = await respondToEmbedding(call);
        if (reply.status && reply.status >= 400) {
          res.writeHead(reply.status, { 'content-type': 'application/json' });
          res.end(JSON.stringify(reply.errorBody ?? { error: { message: 'boom', type: 'test_error' } }));
          return;
        }
        const dimensions = reply.dimensions ?? body.dimensions ?? FAKE_EMBED_DIMENSIONS;
        const headers: Record<string, string> = { 'content-type': 'application/json' };
        if (reply.costHeader !== undefined) headers['x-litellm-response-cost'] = reply.costHeader;
        const promptTokens = reply.promptTokens ?? input.reduce((n, text) => n + Math.ceil(text.length / 4), 0);
        res.writeHead(200, headers);
        res.end(
          JSON.stringify({
            object: 'list',
            model: reply.modelName ?? body.model,
            data: input.map((text, index) => ({
              object: 'embedding',
              index,
              embedding: reply.vectors?.[index] ?? fakeEmbedding(text, dimensions),
            })),
            usage: { prompt_tokens: promptTokens, total_tokens: promptTokens },
          }),
        );
        return;
      }
      if (!req.url?.endsWith('/chat/completions')) {
        res.writeHead(404).end('{}');
        return;
      }
```

and return the two new members from the function:

```ts
  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    embeddings,
    setResponder(next) {
      respond = next;
    },
    setEmbeddingResponder(next) {
      respondToEmbedding = next;
    },
    close: () =>
```

Finally, export the new names from `harness/runtime-api/src/testing.ts` beside `startFakeGateway` — add `FAKE_EMBED_DIMENSIONS`, `fakeEmbedding`, `type EmbeddingResponder`, `type FakeEmbeddingCall` and `type FakeEmbeddingReply` to the existing `export { … } from './gateway.js'` line.

- [ ] **Step 9: Run it to verify it passes**

Run: `pnpm --filter @harness/runtime-api exec vitest run src/gateway.test.ts`
Expected: PASS.

- [ ] **Step 10: Write the failing embeddings-client test**

Create `harness/core-tools/src/domain/knowledge/embed.test.ts`:

```ts
import { sql } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { modelCalls, withTransaction } from '@harness/db';
import { ConfigError, ToolError } from '@harness/shared';
import { openRun } from '../session/repository.js';
import type { ToolDeps } from '../tooling/types.js';
import { makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import { EMBED_BATCH, assertEmbedDims, embedTexts } from './embed.js';

const db = useTestDb();

type FakeGateway = Awaited<ReturnType<typeof startFakeGateway>>;

/** A run, a fake gateway, and deps wired to it at sixteen dimensions. */
async function onFakeGateway(): Promise<{ deps: ToolDeps; fake: FakeGateway }> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const context = await openRun(db, {
    client: 'test',
    principal: {
      id: 'u-test',
      kind: 'user',
      level: 'practitioner',
      displayName: 'Test user',
      surfaces: {},
      attributes: {},
    },
    threadId: null,
    surface: null,
    conversation: null,
  });
  const deps = makeTestDeps(db, {
    context,
    embedDims: 16,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
  });
  return { deps, fake };
}

describe('embedTexts', () => {
  it('asks the embed route for vectors at the configured width and keeps them in order', async () => {
    const { deps } = await onFakeGateway();
    const vectors = await embedTexts(deps, ['the office closes at five', 'escalate anything urgent']);
    expect(vectors).toHaveLength(2);
    expect(vectors[0]).toHaveLength(16);
    expect(vectors[1]).toHaveLength(16);
    expect(vectors[0]).not.toEqual(vectors[1]);
    // The same text, again, is the same vector: a re-sync of an unchanged document is stable.
    expect(await embedTexts(deps, ['the office closes at five'])).toEqual([vectors[0]]);
  });

  it('attributes the spend to the run, on the embed route', async () => {
    const { deps } = await onFakeGateway();
    await embedTexts(deps, ['one', 'two']);
    const rows = await db.select().from(modelCalls);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ route: 'embed', model: 'embed', runId: deps.context.runId, outputTokens: 0 });
    expect(rows[0].inputTokens).toBeGreaterThan(0);
  });

  it('sends at most EMBED_BATCH texts per request', async () => {
    const { deps, fake } = await onFakeGateway();
    const texts = Array.from({ length: EMBED_BATCH + 3 }, (_, i) => `chunk number ${i}`);
    const vectors = await embedTexts(deps, texts);
    expect(vectors).toHaveLength(texts.length);
    expect(fake.embeddings.map((call) => call.input.length)).toEqual([EMBED_BATCH, 3]);
  });

  it('refuses a vector of the wrong width, naming both numbers', async () => {
    const { deps, fake } = await onFakeGateway();
    fake.setEmbeddingResponder(() => ({ dimensions: 8 }));
    await expect(embedTexts(deps, ['one'])).rejects.toThrow(ToolError);
    await expect(embedTexts(deps, ['one'])).rejects.toThrow(
      'model route "embed" returned a 8-dimension vector; this deployment stores 16',
    );
  });

  it('refuses a short answer and a gateway failure, naming the route and never the body', async () => {
    const { deps, fake } = await onFakeGateway();
    fake.setEmbeddingResponder(() => ({ vectors: [Array.from({ length: 16 }, () => 0.1)] }));
    await expect(embedTexts(deps, ['one', 'two'])).rejects.toThrow('returned 1 vector(s) for 2 text(s)');
    fake.setEmbeddingResponder(() => ({ status: 429, errorBody: { error: { message: 'secret prompt echo' } } }));
    const failure = await embedTexts(deps, ['one']).catch((err: unknown) => err as Error);
    expect(failure.message).toBe('model route "embed" is over its daily budget; raise it in clients/<name>/routing.yaml');
    expect(failure.message).not.toContain('secret prompt echo');
  });

  it('embeds nothing for no texts, and makes no call', async () => {
    const { deps, fake } = await onFakeGateway();
    expect(await embedTexts(deps, [])).toEqual([]);
    expect(fake.embeddings).toEqual([]);
  });
});

describe('assertEmbedDims', () => {
  it('passes at the width the column was created with', async () => {
    await expect(assertEmbedDims(db, 1024)).resolves.toBeUndefined();
  });

  it('refuses any other width, naming both numbers and the variable', async () => {
    const failure = await assertEmbedDims(db, 768).catch((err: unknown) => err as Error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toBe(
      'HARNESS_EMBED_DIMS is 768 but knowledge_chunks.embedding stores 1024-dimension vectors; a deployment cannot change its embedding width in place',
    );
  });

  it('says what to run when the table is not there at all', async () => {
    await db.execute(sql.raw('CREATE SCHEMA IF NOT EXISTS knowledge_probe'));
    try {
      // A search_path with no `public` makes `knowledge_chunks` unresolvable, which is what a
      // database that has not been migrated looks like to this check.
      //
      // `SET LOCAL`, inside a transaction, on that transaction's own connection — not a plain
      // `SET` on the pool. `createDb` hands out a `pg.Pool`, a `SET` binds to whichever client
      // happened to serve it, and the next statement is free to land on a different one: the
      // assertion below would then run with `public` still on the path and pass for the wrong
      // reason. Inside a transaction there is one client by construction, and `SET LOCAL` is
      // undone by the rollback, so nothing has to be put back afterwards either.
      await expect(
        withTransaction(db, async (tx) => {
          await tx.execute(sql.raw('SET LOCAL search_path TO knowledge_probe'));
          await assertEmbedDims(tx, 1024);
        }),
      ).rejects.toThrow('knowledge_chunks does not exist; run pnpm db:migrate before starting');
    } finally {
      await db.execute(sql.raw('DROP SCHEMA IF EXISTS knowledge_probe CASCADE'));
    }
  });
});
```

- [ ] **Step 11: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/embed.test.ts`
Expected: FAIL — `./embed.js` does not exist and `makeTestDeps` takes no `embedDims`.

- [ ] **Step 12: Put `embedDims` and `clientDir` on the bag**

In `harness/core-tools/src/domain/tooling/types.ts`, add to `ToolDeps`, after `storageDir`:

```ts
  /**
   * The client's own folder: `clients/<HARNESS_CLIENT>/`, where its persona, policy, identity,
   * playbooks and `knowledge/` live. Derived, never configured — spec section 7 fixes the layout
   * — and resolved from the repository root, which is the image's working directory too.
   */
  clientDir: string;
  /**
   * How wide an embedding vector this deployment stores, from `HARNESS_EMBED_DIMS`. It does not
   * *decide* the width: `knowledge_chunks.embedding` was created at a fixed width by migration
   * 0013, and `assertEmbedDims` refuses to start when the two disagree. It is here so that
   * `embedTexts` asks the gateway for that width and refuses anything else.
   */
  embedDims: number;
```

In `harness/core-tools/src/domain/tooling/config.ts`, add `path` and `fileURLToPath` imports if absent, and add above `buildKernelConfig`:

```ts
// src/domain/tooling -> src/domain -> src -> core-tools -> harness -> the repository root. The
// same root the image has: node.Dockerfile sets WORKDIR /srv/agent-harness and copies `clients`
// under it, so this resolves to the client folder in a checkout and in a container alike.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

/** `clients/<name>/`, the folder spec section 7 lays out. */
export function clientDirFor(client: string): string {
  return path.join(repoRoot, 'clients', client);
}
```

and, inside `buildKernelConfig`, after `const storageDir = storageRoot();`:

```ts
  const client = envOrDefault('HARNESS_CLIENT', 'default', env);
```

then use it: replace the `client:` line of the returned object with `client,`, and add after `storageDir,`:

```ts
    clientDir: clientDirFor(client),
    // 1,024 is what migration 0013 created the column at; `assertEmbedDims` is what proves a
    // deployment has not drifted from it. The ceiling is pgvector's own HNSW limit.
    embedDims: numberFromEnv('HARNESS_EMBED_DIMS', 1_024, { min: 8, max: 2_000, integer: true }, env),
```

In `harness/core-tools/src/testing.ts`, add to the `deps` literal of `makeTestDeps`, after `storageDir,`:

```ts
    // Not a real directory: a test that syncs knowledge passes its own, and one that does not
    // gets a path that simply holds no `knowledge/` folder, which is an empty sync and not an error.
    clientDir: path.join(storageDir, 'client'),
    embedDims: 1_024,
```

In `harness/core-tools/src/app/record-surface.ts`, add to `surfaceDeps()`'s literal, after `storageDir: '/nonexistent/surface',`:

```ts
    clientDir: '/nonexistent/surface',
    embedDims: 1_024,
```

- [ ] **Step 13: Write the embeddings client**

In `harness/core-tools/src/domain/models/types.ts`, add after the `ROUTES` re-export:

```ts
/**
 * The one route that is an embeddings deployment rather than a chat one. `callModel` refuses it
 * — it would post a `messages` array to an endpoint that takes `input` — and `embedTexts` in
 * `domain/knowledge/embed.ts` is its only caller.
 */
export const EMBED_ROUTE: Route = 'embed';
```

In `harness/core-tools/src/domain/models/gateway.ts`, import `EMBED_ROUTE` from `./types.js` (add it to the existing type-only import, as a value import) and add as the second statement of `callModel`, right after the `ROUTES.includes` check:

```ts
  if (opts.route === EMBED_ROUTE) {
    throw new ToolError(`the "${EMBED_ROUTE}" route is an embeddings deployment; call embedTexts, not callModel`);
  }
```

Create `harness/core-tools/src/domain/knowledge/embed.ts`:

```ts
import { sql } from 'drizzle-orm';
import { modelCalls, type Db } from '@harness/db';
import { ConfigError, ToolError } from '@harness/shared';
import { EMBED_ROUTE } from '../models/types.js';
import type { ToolDeps } from '../tooling/types.js';

/**
 * How many texts go in one request to the embed route.
 *
 * A bound, not a tuning knob: the endpoint takes a list, a whole folder in one request would be
 * a megabyte of body and one failure would lose all of it, and a request per chunk would be a
 * round trip per paragraph. Sixty-four is a page or two of prose per call.
 */
export const EMBED_BATCH = 64;

interface EmbeddingsResponse {
  model?: string;
  data?: { index?: number; embedding?: number[] }[];
  usage?: { prompt_tokens?: number };
}

/**
 * A gateway failure reported to the caller carries the route and the HTTP status and nothing
 * else — the same rule `callModel` follows, and for the same reason: a vendor's error body
 * routinely quotes the input back, and this message reaches `audit_log.error` and the agent.
 */
function embedError(status: number, body: string): ToolError {
  if (/budget/i.test(body)) {
    return new ToolError(`model route "${EMBED_ROUTE}" is over its daily budget; raise it in clients/<name>/routing.yaml`);
  }
  if (status === 401 || status === 403) {
    return new ToolError(
      `model route "${EMBED_ROUTE}" was rejected by the gateway (HTTP ${status}); check LITELLM_MASTER_KEY`,
    );
  }
  return new ToolError(`model route "${EMBED_ROUTE}" failed at the gateway (HTTP ${status})`);
}

/**
 * One batch: the OpenAI embeddings wire shape, which LiteLLM's `/v1/embeddings` follows exactly.
 *
 * `dimensions` is sent on every request so a deployment whose model can answer at several widths
 * answers at this one; LiteLLM's `drop_params: true` removes it for a deployment that cannot take
 * it, which is why the *answer* is checked as well as the ask.
 *
 * A `model_calls` row is written for attribution, exactly as `callModel` writes one. The per-run
 * call breaker is deliberately **not** applied: it exists to stop a model looping on a tool, and
 * the number of requests a sync makes is decided by how many files the folder holds, not by
 * anything the model chose. What bounds a sync is the folder and the gateway's daily budget.
 */
async function embedBatch(deps: ToolDeps, texts: readonly string[]): Promise<number[][]> {
  let response: Response;
  try {
    response = await fetch(`${deps.gateway.baseUrl}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${deps.gateway.apiKey}` },
      body: JSON.stringify({
        model: EMBED_ROUTE,
        input: texts,
        dimensions: deps.embedDims,
        user: deps.principal.id,
      }),
      signal: AbortSignal.timeout(deps.gateway.timeoutMs),
    });
  } catch (err) {
    const name = err instanceof Error ? err.name : '';
    if (name === 'TimeoutError' || name === 'AbortError') {
      throw new ToolError(`model route "${EMBED_ROUTE}" timed out after ${deps.gateway.timeoutMs}ms`);
    }
    throw new ToolError(`model route "${EMBED_ROUTE}" could not reach the gateway at ${deps.gateway.baseUrl}`);
  }
  if (!response.ok) throw embedError(response.status, await response.text().catch(() => ''));

  const payload = (await response.json()) as EmbeddingsResponse;
  const data = [...(payload.data ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  if (data.length !== texts.length) {
    throw new ToolError(
      `model route "${EMBED_ROUTE}" returned ${data.length} vector(s) for ${texts.length} text(s)`,
    );
  }
  const vectors = data.map((row) => row.embedding ?? []);
  for (const vector of vectors) {
    if (vector.length !== deps.embedDims) {
      throw new ToolError(
        `model route "${EMBED_ROUTE}" returned a ${vector.length}-dimension vector; this deployment stores ${deps.embedDims}`,
      );
    }
  }

  const costHeader = response.headers.get('x-litellm-response-cost');
  const parsedCost = costHeader === null ? Number.NaN : Number(costHeader);
  await deps.db.insert(modelCalls).values({
    runId: deps.context.runId ?? null,
    client: deps.client,
    route: EMBED_ROUTE,
    model: payload.model ?? EMBED_ROUTE,
    inputTokens: payload.usage?.prompt_tokens ?? 0,
    // An embeddings deployment produces no completion tokens; the column stays 0 rather than null
    // so a sum over model_calls needs no special case for this route.
    outputTokens: 0,
    costUsd: Number.isFinite(parsedCost) ? parsedCost : 0,
  });

  return vectors;
}

/** Embed every text, in order, in batches of `EMBED_BATCH`. An empty list makes no call. */
export async function embedTexts(deps: ToolDeps, texts: readonly string[]): Promise<number[][]> {
  const vectors: number[][] = [];
  for (let from = 0; from < texts.length; from += EMBED_BATCH) {
    vectors.push(...(await embedBatch(deps, texts.slice(from, from + EMBED_BATCH))));
  }
  return vectors;
}

/**
 * Refuse to start when `HARNESS_EMBED_DIMS` and the column disagree (decision 2).
 *
 * A drizzle migration is static SQL, so the width is fixed when the table is created and a
 * deployment cannot change it in place: every stored vector would have to be re-embedded, and
 * pgvector would refuse the `ALTER` while an HNSW index existed. `atttypmod` on a `vector` column
 * is the declared width, plainly — no offset, unlike `varchar` — which is what this reads.
 */
export async function assertEmbedDims(db: Db, dims: number): Promise<void> {
  const rows = (
    await db.execute(
      sql`SELECT atttypmod FROM pg_attribute WHERE attrelid = to_regclass('knowledge_chunks') AND attname = 'embedding'`,
    )
  ).rows as { atttypmod: number }[];
  const declared = rows[0]?.atttypmod;
  if (declared === undefined) {
    throw new ConfigError('knowledge_chunks does not exist; run pnpm db:migrate before starting');
  }
  if (declared !== dims) {
    throw new ConfigError(
      `HARNESS_EMBED_DIMS is ${dims} but knowledge_chunks.embedding stores ${declared}-dimension vectors; a deployment cannot change its embedding width in place`,
    );
  }
}
```

- [ ] **Step 14: Run the embeddings test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/embed.test.ts`
Expected: PASS, nine tests — six under `embedTexts`, three under `assertEmbedDims`.

- [ ] **Step 15: Check the width at startup, in both composition roots, and hand the host its client folder**

In `harness/core-tools/src/index.ts`, add under "Domains", after the memory exports:

```ts
export { EMBED_BATCH, assertEmbedDims, embedTexts } from './domain/knowledge/embed.js';
```

and add `EMBED_ROUTE` to the existing `export { ROUTES, … } from './domain/models/types.js'` list, and `clientDirFor` to the `export { buildKernelConfig } from './domain/tooling/config.js'` line.

In `harness/core-tools/src/app/main.ts`, after `const { deps, close } = await buildDepsFromEnv();`, add:

```ts
// Before anything is served: a deployment whose HARNESS_EMBED_DIMS does not match the column
// would fail on the first knowledge write, halfway through a sync, with rows already inserted.
await assertEmbedDims(deps.db, deps.embedDims);
```

with `import { assertEmbedDims } from '../domain/knowledge/embed.js';` beside the other domain imports.

In `harness/host/src/app/main.ts`, after `const config = await buildKernelConfig(process.env);` and the two `mkdir` calls, replace

```ts
const clientDir = path.join(repoRoot, 'clients', config.client);
```

with

```ts
// Derived by the kernel from HARNESS_CLIENT (spec section 7), so the host and core-tools cannot
// disagree about where a client's files are.
const clientDir = config.clientDir;
// The knowledge tables' embedding width is fixed by migration 0013; refuse to start rather than
// fail halfway through the first sync.
await assertEmbedDims(db, config.embedDims);
```

and add `assertEmbedDims` to the existing `import { buildKernelConfig, loadIdentity } from '@harness/core-tools';`.

- [ ] **Step 16: Document the variable**

In `.env.example`, after the `HARNESS_HISTORY_MAX_MESSAGES` block and before `# --- Packs ---`, add:

```
# --- Knowledge ----------------------------------------------------------------
# How wide an embedding vector this deployment stores. The column was created at
# this width by migration 0013 and cannot be changed in place: the harness reads
# the column at startup and refuses to start when the two disagree, so changing
# this means a new database. It is also the width asked of the `embed` route on
# every request, and a vector of any other width is refused.
#HARNESS_EMBED_DIMS=1024
```

- [ ] **Step 17: Add `yaml` to core-tools, for the frontmatter reader Task 3 writes**

In `harness/core-tools/package.json`, add `"yaml": "^2.9.1",` to `dependencies`, in alphabetical order. Then run, from the repository root:

```bash
pnpm install
git diff --stat pnpm-lock.yaml
```

Expected: the lockfile records the existing `yaml@2.9.x` resolution against `@harness/core-tools` and adds no new package — `@harness/host`, `@harness/gateway` and `@harness/pack-api` already depend on the same range.

- [ ] **Step 18: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` prints nothing: no tool was added and Compose did not move.

- [ ] **Step 19: Commit**

```bash
git add harness/gateway harness/runtime-api/src/gateway.ts harness/runtime-api/src/gateway.test.ts \
  harness/runtime-api/src/testing.ts harness/core-tools/src/domain/knowledge harness/core-tools/src/domain/models \
  harness/core-tools/src/domain/tooling/types.ts harness/core-tools/src/domain/tooling/config.ts \
  harness/core-tools/src/testing.ts harness/core-tools/src/app/record-surface.ts harness/core-tools/src/app/main.ts \
  harness/core-tools/src/index.ts harness/core-tools/package.json harness/host/src/app/main.ts \
  clients/demo-practice/routing.yaml .env.example pnpm-lock.yaml
git commit -m "feat(gateway): add the embed route and an embeddings client, and derive the client folder in the kernel"
```

---

### Task 3: The chunker and the knowledge document reader

**Files:**
- Create: `harness/core-tools/src/domain/knowledge/types.ts`
- Create: `harness/core-tools/src/domain/knowledge/chunk.ts`
- Test: `harness/core-tools/src/domain/knowledge/chunk.test.ts`
- Create: `harness/core-tools/src/domain/knowledge/document.ts`
- Test: `harness/core-tools/src/domain/knowledge/document.test.ts`
- Modify: `harness/core-tools/src/index.ts` (exports)

**Interfaces:**
- Consumes: `USER_LEVELS`, `type Level`, `ConfigError` from `@harness/shared`; `PRINCIPAL_ID_PATTERN` from `@harness/identity-api`; `parse as parseYaml` from `yaml` (added to the package in Task 2).
- Produces:
  - `KNOWLEDGE_SOURCE_NAME = 'client-folder'`, `KNOWLEDGE_SOURCE_KIND = 'folder'`, `KNOWLEDGE_SEARCH_LIMIT = 20`, `KNOWLEDGE_DEFAULT_K = 5`, `RRF_K = 60`, `SERVICE_RANK = -1`, `levelRank(level: Level): number`.
  - `interface ParsedKnowledgeDocument { path: string; title: string; minLevel: Level; minRank: number; principals: string[]; sha256: string; body: string }`.
  - `interface KnowledgeHit { chunk_id: string; document_id: string; path: string; title: string; updated_at: string; ordinal: number; text: string; score: number }`.
  - `interface KnowledgeSyncResult { source: string; scanned: number; added: number; updated: number; unchanged: number; removed: number; chunks: number; skipped: { path: string; reason: string }[] }`.
  - `CHUNK_SIZE = 1_000`, `CHUNK_OVERLAP = 200`, `chunkText(text: string, opts?: { size?: number; overlap?: number }): string[]`.
  - `parseKnowledgeDocument(relPath: string, text: string): ParsedKnowledgeDocument`; `readKnowledgeFolder(dir: string): Promise<ParsedKnowledgeDocument[]>`.

- [ ] **Step 1: Write the failing chunker test**

Create `harness/core-tools/src/domain/knowledge/chunk.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from './chunk.js';

/** A paragraph of `words` words, each `Word-<n>`, so a chunk boundary is visible in the text. */
const paragraph = (from: number, words: number): string =>
  Array.from({ length: words }, (_, i) => `word-${from + i}`).join(' ');

describe('chunkText', () => {
  it('leaves a short document whole, and an empty one with no chunks', () => {
    expect(chunkText('the office closes at five')).toEqual(['the office closes at five']);
    expect(chunkText('   \n\n  ')).toEqual([]);
    expect(chunkText('')).toEqual([]);
  });

  it('splits a long document into chunks no larger than size + overlap', () => {
    const text = Array.from({ length: 12 }, (_, i) => paragraph(i * 60, 60)).join('\n\n');
    expect(text.length).toBeGreaterThan(4 * CHUNK_SIZE);
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(4);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(CHUNK_SIZE + CHUNK_OVERLAP);
    // Nothing is lost: every word of the document is somewhere.
    const seen = new Set(chunks.flatMap((c) => c.split(/\s+/)));
    for (const word of text.split(/\s+/)) expect(seen.has(word), word).toBe(true);
  });

  it('overlaps consecutive chunks, and never starts one mid-word', () => {
    const text = Array.from({ length: 8 }, (_, i) => paragraph(i * 40, 40)).join('\n\n');
    const chunks = chunkText(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const head = chunks[i].split(/\s+/)[0];
      // A whole token, not a fragment of one: the overlap is cut at a space.
      expect(head, `chunk ${i}`).toMatch(/^word-\d+$/);
      // And it really is a tail of the chunk before it.
      expect(chunks[i - 1].includes(head), `chunk ${i} overlaps ${i - 1}`).toBe(true);
    }
  });

  it('falls through the separators: paragraphs, then lines, then sentences, then words, then characters', () => {
    // No blank line and no newline anywhere: it still has to split, on sentences.
    const sentences = Array.from({ length: 40 }, (_, i) => `This is sentence number ${i} of the document.`).join(' ');
    const bySentence = chunkText(sentences, { size: 200, overlap: 20 });
    expect(bySentence.length).toBeGreaterThan(3);
    for (const chunk of bySentence) expect(chunk.length).toBeLessThanOrEqual(220);

    // One word, longer than a chunk: the last separator is the empty string, so it splits by
    // character rather than emitting one chunk the embedder would refuse.
    const oneWord = 'x'.repeat(2_500);
    const byCharacter = chunkText(oneWord, { size: 1_000, overlap: 0 });
    expect(byCharacter.length).toBe(3);
    expect(byCharacter.join('')).toBe(oneWord);
  });

  it('keeps the order of the document', () => {
    const text = Array.from({ length: 10 }, (_, i) => paragraph(i * 50, 50)).join('\n\n');
    const chunks = chunkText(text);
    const firstWordIndex = chunks.map((c) => Number(/word-(\d+)/.exec(c)![1]));
    expect([...firstWordIndex].sort((a, b) => a - b)).toEqual(firstWordIndex);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/chunk.test.ts`
Expected: FAIL — `./chunk.js` does not exist.

- [ ] **Step 3: Write the types module**

Create `harness/core-tools/src/domain/knowledge/types.ts`:

```ts
import { USER_LEVELS, type Level } from '@harness/shared';

/**
 * The knowledge base (spec 5.7): a client's own markdown, chunked, embedded and retrievable by
 * whoever the document's frontmatter lets read it.
 *
 * One source per client today — the `knowledge/` folder of `clients/<name>/` — named here rather
 * than derived, because a second kind (a wiki, a share) is a second row with this same shape and
 * nothing below it changes.
 */
export const KNOWLEDGE_SOURCE_NAME = 'client-folder';
export const KNOWLEDGE_SOURCE_KIND = 'folder';

/** The most hits `knowledge_search` will return, and the default when the caller says nothing. */
export const KNOWLEDGE_SEARCH_LIMIT = 20;
export const KNOWLEDGE_DEFAULT_K = 5;

/**
 * The constant in reciprocal rank fusion: `score += 1 / (RRF_K + rank)`, rank counted from 1 in
 * each ranking. 60 is the value the method was published with and the one every implementation
 * since has carried; it damps the difference between the first and second hit of a list enough
 * that a chunk found by both rankings beats one found brilliantly by either. Not a knob.
 */
export const RRF_K = 60;

/**
 * What a principal off the level ladder ranks as (decision 4).
 *
 * `service` is not a user level — `levelAtLeast('service', 'member')` is false — and the user
 * levels start at 0, so anything below them clears nothing: `min_rank <= -1` matches no chunk, and
 * a scheduled job reads a knowledge document only when the document names its principal id.
 */
export const SERVICE_RANK = -1;

/**
 * A level as a number the database can compare (decision 3).
 *
 * The four user levels are a ladder: `member` 0 through `admin` 3, so `min_rank <= $rank` is
 * exactly "this level or above". `indexOf` answers `-1` for anything not on that ladder, which is
 * `SERVICE_RANK` already — the one value that is deliberately what the miss returns.
 */
export function levelRank(level: Level): number {
  return (USER_LEVELS as readonly string[]).indexOf(level);
}

/** One markdown file, read and validated, ready to be upserted and chunked. */
export interface ParsedKnowledgeDocument {
  /** Relative to the source's root, forward slashes, e.g. `policies/front-desk.md`. */
  path: string;
  title: string;
  minLevel: Level;
  minRank: number;
  principals: string[];
  /** sha256 of the file's whole text, frontmatter included: the key that decides a re-embed. */
  sha256: string;
  /** The text below the frontmatter, trimmed. What is chunked. */
  body: string;
}

/** One retrieved chunk, with everything the model needs to cite it. */
export interface KnowledgeHit {
  chunk_id: string;
  document_id: string;
  path: string;
  title: string;
  updated_at: string;
  ordinal: number;
  text: string;
  /** The fused reciprocal-rank score. Comparable within one answer, and meaningless across two. */
  score: number;
}

/** What one `knowledge_sync` did. `skipped` names a document that was refused, and why. */
export interface KnowledgeSyncResult {
  source: string;
  scanned: number;
  added: number;
  updated: number;
  unchanged: number;
  removed: number;
  /** Chunks written this run, across added and updated documents. */
  chunks: number;
  skipped: { path: string; reason: string }[];
}
```

- [ ] **Step 4: Write the chunker**

Create `harness/core-tools/src/domain/knowledge/chunk.ts`:

```ts
/**
 * The chunker (spec 5.7): a `RecursiveCharacterTextSplitter`-equivalent at 1,000 characters with
 * 200 of overlap, written here rather than imported.
 *
 * Imported from where? The published one lives in `langchain`, and `kernel-vocabulary.test.ts`
 * forbids that word in this package — the kernel holds a runtime *contract*, not a framework, and
 * `runtimes/deepagents` is the one directory allowed to name one. What the splitter actually does
 * is thirty lines, so it is thirty lines.
 *
 * The method: try to break on the largest separator that appears — a blank line, then a line, then
 * a sentence, then a word, then any character at all — and recurse into any piece still too long.
 * The pieces are then greedily packed into chunks, and each chunk after the first begins with the
 * tail of the one before it, cut at the first space inside that tail so a chunk never starts
 * mid-word. That cut is why a chunk's real bound is `size + overlap` and not `size`.
 */
export const CHUNK_SIZE = 1_000;
export const CHUNK_OVERLAP = 200;

/**
 * Largest unit first. The empty string is the last resort and means "split by character": without
 * it a single 3,000-character word would come back as one chunk, and a chunk larger than the
 * embedder's own limit is a failure in the middle of a sync rather than here.
 */
const SEPARATORS = ['\n\n', '\n', '. ', ' ', ''] as const;

/** Split, keeping the separator on the end of each piece so rejoining is lossless. */
function splitKeeping(text: string, separator: string): string[] {
  if (separator === '') return [...text];
  const parts = text.split(separator);
  return parts.map((part, i) => (i === parts.length - 1 ? part : part + separator));
}

/** Break `text` down until every piece is at most `size`, using the first separator that helps. */
function pieces(text: string, size: number, separators: readonly string[]): string[] {
  if (text === '') return [];
  if (text.length <= size) return [text];
  const [head, ...rest] = separators;
  if (head === undefined) return [text];
  const parts = splitKeeping(text, head);
  // A separator that did not appear splits nothing; try the next one on the whole text rather
  // than recursing on a single piece that is the text again, which would not terminate.
  if (parts.length <= 1) return pieces(text, size, rest);
  return parts.flatMap((part) => pieces(part, size, rest));
}

/** The last `overlap` characters of `text`, from the first space inside them, so a word stays whole. */
function tailOf(text: string, overlap: number): string {
  if (overlap <= 0) return '';
  const cut = text.slice(Math.max(0, text.length - overlap));
  const space = cut.indexOf(' ');
  return space === -1 ? cut : cut.slice(space + 1);
}

export function chunkText(text: string, opts: { size?: number; overlap?: number } = {}): string[] {
  const size = opts.size ?? CHUNK_SIZE;
  const overlap = opts.overlap ?? CHUNK_OVERLAP;
  const parts = pieces(text.trim(), size, SEPARATORS);
  const chunks: string[] = [];
  let current = '';
  for (const part of parts) {
    if (current !== '' && current.length + part.length > size) {
      chunks.push(current.trim());
      current = tailOf(current, overlap) + part;
    } else {
      current += part;
    }
  }
  if (current.trim() !== '') chunks.push(current.trim());
  return chunks;
}
```

- [ ] **Step 5: Run the chunker test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/chunk.test.ts`
Expected: PASS, five tests.

- [ ] **Step 6: Write the failing document-reader test**

Create `harness/core-tools/src/domain/knowledge/document.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseKnowledgeDocument, readKnowledgeFolder } from './document.js';

const FRONT = `---
title: Front desk
min_level: member
---

The office closes at five.
`;

describe('parseKnowledgeDocument', () => {
  it('reads the frontmatter and hands back the body, the level and its rank', () => {
    const doc = parseKnowledgeDocument('front-desk.md', FRONT);
    expect(doc).toMatchObject({
      path: 'front-desk.md',
      title: 'Front desk',
      minLevel: 'member',
      minRank: 0,
      principals: [],
      body: 'The office closes at five.',
    });
    expect(doc.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('hashes the whole file, frontmatter included, so an access change re-syncs', () => {
    const open = parseKnowledgeDocument('a.md', FRONT);
    const closed = parseKnowledgeDocument('a.md', FRONT.replace('min_level: member', 'min_level: lead'));
    expect(closed.minRank).toBe(2);
    expect(closed.body).toBe(open.body);
    expect(closed.sha256).not.toBe(open.sha256);
  });

  it('defaults a document with no frontmatter to the lowest level and titles it from its heading', () => {
    const doc = parseKnowledgeDocument('policies/holidays.md', '# Public holidays\n\nThe clinic is closed.\n');
    expect(doc).toMatchObject({ title: 'Public holidays', minLevel: 'member', minRank: 0, principals: [] });
    expect(doc.body).toBe('# Public holidays\n\nThe clinic is closed.');
  });

  it('falls back to the file name when there is neither a title nor a heading', () => {
    expect(parseKnowledgeDocument('policies/after-hours.md', 'Call the duty phone.').title).toBe('after-hours');
  });

  it('carries named principals, whatever the level says', () => {
    const doc = parseKnowledgeDocument(
      'billing.md',
      '---\ntitle: Billing\nmin_level: admin\nprincipals: [u-coordinator, svc-playbooks]\n---\n\nRates.\n',
    );
    expect(doc).toMatchObject({ minLevel: 'admin', minRank: 3, principals: ['u-coordinator', 'svc-playbooks'] });
  });

  it('refuses an unknown level, an unknown key and a malformed principal, naming the file', () => {
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: superuser\n---\n\nhi\n')).toThrow(ConfigError);
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: superuser\n---\n\nhi\n')).toThrow(/"x\.md"/);
    // `service` is not a document level: a service principal is named by id or not at all.
    expect(() => parseKnowledgeDocument('x.md', '---\nmin_level: service\n---\n\nhi\n')).toThrow(/min_level/);
    expect(() => parseKnowledgeDocument('x.md', '---\nlevel: lead\n---\n\nhi\n')).toThrow(/level/);
    expect(() => parseKnowledgeDocument('x.md', '---\nprincipals: [Nobody]\n---\n\nhi\n')).toThrow(/principal/);
  });

  it('refuses a document with nothing under the frontmatter', () => {
    expect(() => parseKnowledgeDocument('empty.md', '---\ntitle: Empty\n---\n\n   \n')).toThrow(/is empty/);
  });
});

describe('readKnowledgeFolder', () => {
  it('walks markdown files in path order, including subfolders, and ignores everything else', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-knowledge-'));
    await mkdir(path.join(dir, 'policies'), { recursive: true });
    await mkdir(path.join(dir, '.git'), { recursive: true });
    await writeFile(path.join(dir, 'front-desk.md'), FRONT);
    await writeFile(path.join(dir, 'policies', 'holidays.md'), '# Public holidays\n\nClosed.\n');
    await writeFile(path.join(dir, 'notes.txt'), 'not markdown');
    await writeFile(path.join(dir, '.git', 'hidden.md'), '# Hidden\n\nno\n');
    const docs = await readKnowledgeFolder(dir);
    expect(docs.map((d) => d.path)).toEqual(['front-desk.md', 'policies/holidays.md']);
  });

  it('answers an empty list for a folder that is not there, because a client need not have one', async () => {
    expect(await readKnowledgeFolder(path.join(tmpdir(), 'harness-knowledge-nonexistent'))).toEqual([]);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/document.test.ts`
Expected: FAIL — `./document.js` does not exist.

- [ ] **Step 8: Write the document reader**

Create `harness/core-tools/src/domain/knowledge/document.ts`:

```ts
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { PRINCIPAL_ID_PATTERN } from '@harness/identity-api';
import { ConfigError, USER_LEVELS, type Level } from '@harness/shared';
import { levelRank, type ParsedKnowledgeDocument } from './types.js';

/**
 * A knowledge document's frontmatter (spec 5.7).
 *
 * `min_level` is one of the four *user* levels and never `service`: a level is a ladder a person
 * climbs, and a scheduled job is not on it, so a document a service may read names that service in
 * `principals` (decision 4). `.strict()` for the same reason a routing file is strict — a typo in
 * an access rule must fail loudly rather than be dropped and leave a document more readable than
 * its author meant.
 */
const FrontmatterShape = z
  .object({
    title: z.string().min(1).max(200).optional(),
    min_level: z.enum(USER_LEVELS).default('member'),
    principals: z
      .array(z.string().regex(PRINCIPAL_ID_PATTERN, 'a principal id is u-<slug> or svc-<slug>'))
      .max(50)
      .default([]),
  })
  .strict();

/** The YAML object between the first two `---` lines, when there is one. The same shape `SKILL.md` uses. */
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

function titleFrom(body: string, relPath: string): string {
  const heading = /^#\s+(.+)$/m.exec(body);
  if (heading) return heading[1].trim();
  return path.basename(relPath, path.extname(relPath));
}

/**
 * One markdown file into the row and the chunks it becomes.
 *
 * The hash covers the **whole** text, frontmatter included, so that changing `min_level` or
 * `principals` without touching a word of the body still re-syncs the document — and the copies of
 * those values on every chunk, which is what the access filter reads, move with it (decision 8).
 */
export function parseKnowledgeDocument(relPath: string, text: string): ParsedKnowledgeDocument {
  const match = FRONTMATTER.exec(text);
  const raw: unknown = match ? (parseYaml(match[1]) ?? {}) : {};
  const parsed = FrontmatterShape.safeParse(raw);
  if (!parsed.success) {
    throw new ConfigError(`knowledge document "${relPath}" has invalid frontmatter: ${z.prettifyError(parsed.error)}`);
  }
  const body = (match ? text.slice(match[0].length) : text).trim();
  if (body === '') throw new ConfigError(`knowledge document "${relPath}" is empty`);
  const minLevel = parsed.data.min_level as Level;
  return {
    path: relPath,
    title: parsed.data.title ?? titleFrom(body, relPath),
    minLevel,
    minRank: levelRank(minLevel),
    principals: parsed.data.principals,
    sha256: createHash('sha256').update(text, 'utf8').digest('hex'),
    body,
  };
}

/** Every `.md` under `dir`, relative path first, dot-directories skipped. */
async function markdownFiles(dir: string, prefix = ''): Promise<string[]> {
  const found: string[] = [];
  const entries = (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    // `.git`, `.DS_Store` and friends, and a nested checkout: none of them is a client's knowledge.
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) found.push(...(await markdownFiles(path.join(dir, entry.name), relative)));
    else if (entry.name.endsWith('.md')) found.push(relative);
  }
  return found;
}

/**
 * Read a whole knowledge folder, in path order so a sync is deterministic.
 *
 * A folder that is not there is an **empty list**, not an error: a client with no knowledge base
 * is an ordinary client, and `knowledge_sync` says so in its result rather than failing.
 */
export async function readKnowledgeFolder(dir: string): Promise<ParsedKnowledgeDocument[]> {
  let paths: string[];
  try {
    paths = await markdownFiles(dir);
  } catch {
    return [];
  }
  const documents: ParsedKnowledgeDocument[] = [];
  for (const relative of paths) {
    documents.push(parseKnowledgeDocument(relative, await readFile(path.join(dir, relative), 'utf8')));
  }
  return documents;
}
```

- [ ] **Step 9: Run the document test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/document.test.ts`
Expected: PASS, nine tests.

- [ ] **Step 10: Export the new names**

In `harness/core-tools/src/index.ts`, under "Domains", beside the `embed.js` export added in Task 2, add:

```ts
export {
  KNOWLEDGE_DEFAULT_K,
  KNOWLEDGE_SEARCH_LIMIT,
  KNOWLEDGE_SOURCE_KIND,
  KNOWLEDGE_SOURCE_NAME,
  RRF_K,
  SERVICE_RANK,
  levelRank,
  type KnowledgeHit,
  type KnowledgeSyncResult,
  type ParsedKnowledgeDocument,
} from './domain/knowledge/types.js';
export { CHUNK_OVERLAP, CHUNK_SIZE, chunkText } from './domain/knowledge/chunk.js';
export { parseKnowledgeDocument, readKnowledgeFolder } from './domain/knowledge/document.js';
```

- [ ] **Step 11: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` prints nothing.

- [ ] **Step 12: Commit**

```bash
git add harness/core-tools/src/domain/knowledge harness/core-tools/src/index.ts
git commit -m "feat(knowledge): add the chunker and the markdown frontmatter reader"
```

---

### Task 4: The knowledge repository and `knowledge_sync`'s engine

**Files:**
- Create: `harness/core-tools/src/domain/knowledge/repository.ts`
- Test: `harness/core-tools/src/domain/knowledge/repository.test.ts`
- Create: `harness/core-tools/src/domain/knowledge/sync.ts`
- Test: `harness/core-tools/src/domain/knowledge/sync.test.ts`
- Modify: `harness/core-tools/src/index.ts` (exports)

**Interfaces:**
- Consumes: `knowledgeChunks`, `knowledgeDocuments`, `knowledgeSources`, `withTransaction`, `type Db` from `@harness/db`; `chunkText` (Task 3); `readKnowledgeFolder`, `type ParsedKnowledgeDocument` (Task 3); `KNOWLEDGE_SOURCE_KIND`, `KNOWLEDGE_SOURCE_NAME`, `type KnowledgeSyncResult` (Task 3); `embedTexts` (Task 2); `containsRestrictedPattern` from `../../shared/redaction/patterns.js`; `ToolDeps`.
- Produces:
  - `type DocumentChange = 'added' | 'updated' | 'unchanged'`.
  - `findOrCreateSource(db: Db, client: string, spec: { name: string; kind: string; location: string }, now: Date): Promise<{ id: string }>`.
  - `upsertDocument(db: Db, input: { client: string; sourceId: string; doc: ParsedKnowledgeDocument; now: Date }): Promise<{ id: string; change: DocumentChange }>`.
  - `replaceChunks(db: Db, input: { documentId: string; client: string; doc: ParsedKnowledgeDocument; chunks: readonly string[]; vectors: readonly number[][] }): Promise<number>`.
  - `tombstoneMissing(db: Db, sourceId: string, keep: readonly string[], now: Date): Promise<number>`.
  - `touchSource(db: Db, sourceId: string, now: Date): Promise<void>`.
  - `syncKnowledge(deps: ToolDeps, opts?: { dir?: string }): Promise<KnowledgeSyncResult>`.

- [ ] **Step 1: Write the failing repository test**

Create `harness/core-tools/src/domain/knowledge/repository.test.ts`:

```ts
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { knowledgeChunks, knowledgeDocuments, knowledgeSources } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { parseKnowledgeDocument } from './document.js';
import { findOrCreateSource, replaceChunks, tombstoneMissing, touchSource, upsertDocument } from './repository.js';

const db = useTestDb();
const NOW = new Date('2026-09-15T12:00:00Z');
const LATER = new Date('2026-09-16T12:00:00Z');

const vectorsFor = (chunks: readonly string[]): number[][] =>
  chunks.map((_, i) => Array.from({ length: 1024 }, () => (i + 1) / 100));

const doc = (path: string, text: string) => parseKnowledgeDocument(path, text);

const source = () =>
  findOrCreateSource(db, 'test', { name: 'client-folder', kind: 'folder', location: 'clients/test/knowledge' }, NOW);

describe('findOrCreateSource', () => {
  it('creates one row per client and name, and returns the same one afterwards', async () => {
    const first = await source();
    const again = await source();
    expect(again.id).toBe(first.id);
  });
});

describe('upsertDocument', () => {
  it('adds, then reports unchanged, then updates when the file changed', async () => {
    const { id: sourceId } = await source();
    const original = doc('front-desk.md', '---\ntitle: Front desk\n---\n\nCloses at five.\n');
    const added = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: NOW });
    expect(added.change).toBe('added');

    const same = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: LATER });
    expect(same).toEqual({ id: added.id, change: 'unchanged' });
    // `updated_at` is when the content last changed, which is what a citation shows, so an
    // unchanged document does not get a new one.
    const [untouched] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, added.id));
    expect(untouched.updatedAt).toEqual(NOW);

    const raised = doc('front-desk.md', '---\ntitle: Front desk\nmin_level: lead\n---\n\nCloses at five.\n');
    const changed = await upsertDocument(db, { client: 'test', sourceId, doc: raised, now: LATER });
    expect(changed).toEqual({ id: added.id, change: 'updated' });
    const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, added.id));
    expect(row).toMatchObject({ minLevel: 'lead', minRank: 2, updatedAt: LATER, deletedAt: null });
  });

  it('brings a tombstoned document back as an update when its file reappears', async () => {
    const { id: sourceId } = await source();
    const original = doc('holidays.md', '# Public holidays\n\nClosed.\n');
    const { id } = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: NOW });
    await tombstoneMissing(db, sourceId, [], NOW);
    const back = await upsertDocument(db, { client: 'test', sourceId, doc: original, now: LATER });
    expect(back).toEqual({ id, change: 'updated' });
    const [row] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.id, id));
    expect(row.deletedAt).toBeNull();
  });
});

describe('replaceChunks', () => {
  it('writes the chunks in order with the document access copied onto each, and replaces them wholesale', async () => {
    const { id: sourceId } = await source();
    const parsed = doc('billing.md', '---\ntitle: Billing\nmin_level: lead\nprincipals: [u-analyst]\n---\n\nRates.\n');
    const { id } = await upsertDocument(db, { client: 'test', sourceId, doc: parsed, now: NOW });

    const first = ['alpha', 'beta', 'gamma'];
    expect(
      await replaceChunks(db, { documentId: id, client: 'test', doc: parsed, chunks: first, vectors: vectorsFor(first) }),
    ).toBe(3);
    const rows = await db
      .select()
      .from(knowledgeChunks)
      .where(eq(knowledgeChunks.documentId, id))
      .orderBy(knowledgeChunks.ordinal);
    expect(rows.map((r) => [r.ordinal, r.text])).toEqual([
      [0, 'alpha'],
      [1, 'beta'],
      [2, 'gamma'],
    ]);
    for (const row of rows) {
      expect(row).toMatchObject({ client: 'test', minLevel: 'lead', minRank: 2, principals: ['u-analyst'] });
      expect(row.embedding).toHaveLength(1024);
    }

    const second = ['delta'];
    expect(
      await replaceChunks(db, {
        documentId: id,
        client: 'test',
        doc: parsed,
        chunks: second,
        vectors: vectorsFor(second),
      }),
    ).toBe(1);
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, id))).toBe(1);
  });
});

describe('tombstoneMissing', () => {
  it('tombstones the documents no longer in the folder, drops their chunks, and leaves the rest alone', async () => {
    const { id: sourceId } = await source();
    const kept = doc('kept.md', '# Kept\n\nstill here\n');
    const gone = doc('gone.md', '# Gone\n\nnot any more\n');
    const keptRow = await upsertDocument(db, { client: 'test', sourceId, doc: kept, now: NOW });
    const goneRow = await upsertDocument(db, { client: 'test', sourceId, doc: gone, now: NOW });
    for (const [id, parsed] of [
      [keptRow.id, kept],
      [goneRow.id, gone],
    ] as const) {
      await replaceChunks(db, { documentId: id, client: 'test', doc: parsed, chunks: ['one'], vectors: vectorsFor(['one']) });
    }

    expect(await tombstoneMissing(db, sourceId, ['kept.md'], LATER)).toBe(1);
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.deletedAt])).toEqual([
      ['gone.md', LATER],
      ['kept.md', null],
    ]);
    // The row stays for an operator to see; nothing can retrieve it, because its chunks are gone.
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, goneRow.id))).toBe(0);
    expect(await db.$count(knowledgeChunks, eq(knowledgeChunks.documentId, keptRow.id))).toBe(1);
    // And a second call with the same folder tombstones nothing new.
    expect(await tombstoneMissing(db, sourceId, ['kept.md'], LATER)).toBe(0);
  });
});

describe('touchSource', () => {
  it('records when the folder was last walked', async () => {
    const { id } = await source();
    await touchSource(db, id, LATER);
    const [row] = await db.select().from(knowledgeSources).where(eq(knowledgeSources.id, id));
    expect(row.lastSyncedAt).toEqual(LATER);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/repository.test.ts`
Expected: FAIL — `./repository.js` does not exist.

- [ ] **Step 3: Write the repository**

Create `harness/core-tools/src/domain/knowledge/repository.ts`:

```ts
import { and, eq, inArray, isNull, notInArray, type SQL } from 'drizzle-orm';
import { knowledgeChunks, knowledgeDocuments, knowledgeSources, withTransaction, type Db } from '@harness/db';
import type { ParsedKnowledgeDocument } from './types.js';

/** What one file did to its row this sync. `unchanged` is the case that skips the embedder. */
export type DocumentChange = 'added' | 'updated' | 'unchanged';

/**
 * The client's one source row, by name. `location` is refreshed on every call so a deployment
 * that moved its folder says where it is now; nothing reads it but a human.
 */
export async function findOrCreateSource(
  db: Db,
  client: string,
  spec: { name: string; kind: string; location: string },
  now: Date,
): Promise<{ id: string }> {
  const [row] = await db
    .insert(knowledgeSources)
    .values({ client, name: spec.name, kind: spec.kind, location: spec.location, updatedAt: now })
    .onConflictDoUpdate({
      target: [knowledgeSources.client, knowledgeSources.name],
      set: { kind: spec.kind, location: spec.location, updatedAt: now },
    })
    .returning({ id: knowledgeSources.id });
  return row;
}

/**
 * One file's row, keyed by `(source_id, path)`.
 *
 * The decision to re-embed is `sha256` alone, and that hash covers the frontmatter too — so
 * raising a document's `min_level` re-chunks it, which is what puts the new level on every chunk,
 * where the access filter reads it (decision 8). A tombstoned document whose file has come back is
 * an `updated`, not an `added`: the id is the same and nothing that pointed at it has to move.
 */
export async function upsertDocument(
  db: Db,
  input: { client: string; sourceId: string; doc: ParsedKnowledgeDocument; now: Date },
): Promise<{ id: string; change: DocumentChange }> {
  const { client, sourceId, doc, now } = input;
  const [existing] = await db
    .select({ id: knowledgeDocuments.id, sha256: knowledgeDocuments.sha256, deletedAt: knowledgeDocuments.deletedAt })
    .from(knowledgeDocuments)
    .where(and(eq(knowledgeDocuments.sourceId, sourceId), eq(knowledgeDocuments.path, doc.path)))
    .limit(1);

  if (!existing) {
    const [row] = await db
      .insert(knowledgeDocuments)
      .values({
        client,
        sourceId,
        path: doc.path,
        title: doc.title,
        sha256: doc.sha256,
        minLevel: doc.minLevel,
        minRank: doc.minRank,
        principals: doc.principals,
        updatedAt: now,
      })
      .returning({ id: knowledgeDocuments.id });
    return { id: row.id, change: 'added' };
  }

  if (existing.sha256 === doc.sha256 && existing.deletedAt === null) {
    return { id: existing.id, change: 'unchanged' };
  }

  await db
    .update(knowledgeDocuments)
    .set({
      title: doc.title,
      sha256: doc.sha256,
      minLevel: doc.minLevel,
      minRank: doc.minRank,
      principals: doc.principals,
      updatedAt: now,
      deletedAt: null,
    })
    .where(eq(knowledgeDocuments.id, existing.id));
  return { id: existing.id, change: 'updated' };
}

/**
 * Replace a document's chunks, in one transaction, with the access rules copied onto each of them.
 *
 * Copied rather than joined on purpose: `knowledge_search` puts the access filter in the same
 * WHERE clause as the ranking, so a chunk the caller may not see is never ranked (invariant 7),
 * and a join would put that filter one step too late.
 */
export async function replaceChunks(
  db: Db,
  input: {
    documentId: string;
    client: string;
    doc: ParsedKnowledgeDocument;
    chunks: readonly string[];
    vectors: readonly number[][];
  },
): Promise<number> {
  const { documentId, client, doc, chunks, vectors } = input;
  return withTransaction(db, async (tx) => {
    await tx.delete(knowledgeChunks).where(eq(knowledgeChunks.documentId, documentId));
    if (chunks.length === 0) return 0;
    await tx.insert(knowledgeChunks).values(
      chunks.map((text, ordinal) => ({
        documentId,
        client,
        ordinal,
        text,
        embedding: vectors[ordinal],
        minLevel: doc.minLevel,
        minRank: doc.minRank,
        principals: doc.principals,
      })),
    );
    return chunks.length;
  });
}

/**
 * Tombstone every live document of this source whose path is no longer in the folder, and delete
 * its chunks.
 *
 * The row stays so an operator can see what used to be there and when it went; the chunks go so
 * nothing can retrieve it. `keep` empty means the folder is empty, which is a legitimate state —
 * an operator who deleted the folder's contents meant it — so the `NOT IN` is simply dropped
 * rather than producing the empty-list SQL drizzle cannot build.
 */
export async function tombstoneMissing(
  db: Db,
  sourceId: string,
  keep: readonly string[],
  now: Date,
): Promise<number> {
  const live: (SQL | undefined)[] = [eq(knowledgeDocuments.sourceId, sourceId), isNull(knowledgeDocuments.deletedAt)];
  if (keep.length > 0) live.push(notInArray(knowledgeDocuments.path, [...keep]));
  return withTransaction(db, async (tx) => {
    const gone = await tx
      .update(knowledgeDocuments)
      .set({ deletedAt: now })
      .where(and(...live))
      .returning({ id: knowledgeDocuments.id });
    if (gone.length === 0) return 0;
    await tx.delete(knowledgeChunks).where(
      inArray(
        knowledgeChunks.documentId,
        gone.map((row) => row.id),
      ),
    );
    return gone.length;
  });
}

/** When this source was last walked, whatever the walk found. */
export async function touchSource(db: Db, sourceId: string, now: Date): Promise<void> {
  await db
    .update(knowledgeSources)
    .set({ lastSyncedAt: now, updatedAt: now })
    .where(eq(knowledgeSources.id, sourceId));
}
```

- [ ] **Step 4: Run the repository test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/repository.test.ts`
Expected: PASS, six tests.

- [ ] **Step 5: Write the failing sync test**

Create `harness/core-tools/src/domain/knowledge/sync.test.ts`:

```ts
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { knowledgeChunks, knowledgeDocuments } from '@harness/db';
import { makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';
import { syncKnowledge } from './sync.js';

const db = useTestDb();

/**
 * A client folder with a `knowledge/` directory, and deps whose gateway is the fake. The client
 * name is a parameter so the last test can build a second client and prove one folder's sync
 * leaves the other's documents alone.
 */
async function clientFolder(
  client = 'test',
): Promise<{ deps: ToolDeps; dir: string; write: (rel: string, text: string) => Promise<void> }> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  const dir = path.join(clientDir, 'knowledge');
  await mkdir(dir, { recursive: true });
  const deps = makeTestDeps(db, {
    client,
    clientDir,
    embedDims: 16,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 100 },
  });
  const write = async (rel: string, text: string): Promise<void> => {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  };
  return { deps, dir, write };
}

describe('syncKnowledge', () => {
  it('adds every document, chunks and embeds it, and reports what it did', async () => {
    const { deps, write } = await clientFolder();
    await write('front-desk.md', '---\ntitle: Front desk\n---\n\nThe office closes at five.\n');
    await write('policies/escalation.md', '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate anything urgent.\n');

    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({
      source: 'client-folder',
      scanned: 2,
      added: 2,
      updated: 0,
      unchanged: 0,
      removed: 0,
      chunks: 2,
      skipped: [],
    });
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.minLevel, r.minRank])).toEqual([
      ['front-desk.md', 'member', 0],
      ['policies/escalation.md', 'lead', 2],
    ]);
    const chunks = await db.select().from(knowledgeChunks);
    expect(chunks).toHaveLength(2);
    expect(chunks[0].embedding).toHaveLength(16);
  });

  it('does not re-embed an unchanged document, and does re-embed a changed one', async () => {
    const { deps, write } = await clientFolder();
    await write('a.md', '# A\n\none\n');
    expect((await syncKnowledge(deps)).added).toBe(1);

    const second = await syncKnowledge(deps);
    expect(second).toMatchObject({ scanned: 1, added: 0, updated: 0, unchanged: 1, chunks: 0 });

    await write('a.md', '# A\n\none and two\n');
    const third = await syncKnowledge(deps);
    expect(third).toMatchObject({ scanned: 1, added: 0, updated: 1, unchanged: 0, chunks: 1 });
    const [row] = await db.select().from(knowledgeChunks);
    expect(row.text).toContain('one and two');
  });

  it('tombstones a document whose file is gone and drops its chunks', async () => {
    const { deps, dir, write } = await clientFolder();
    await write('keep.md', '# Keep\n\nhere\n');
    await write('drop.md', '# Drop\n\ngone soon\n');
    expect((await syncKnowledge(deps)).added).toBe(2);

    await rm(path.join(dir, 'drop.md'));
    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({ scanned: 1, added: 0, unchanged: 1, removed: 1, chunks: 0 });
    const rows = await db.select().from(knowledgeDocuments).orderBy(knowledgeDocuments.path);
    expect(rows.map((r) => [r.path, r.deletedAt === null])).toEqual([
      ['drop.md', false],
      ['keep.md', true],
    ]);
    expect(await db.$count(knowledgeChunks)).toBe(1);
  });

  it('skips a document carrying a restricted identifier, naming it, and syncs the rest', async () => {
    const { deps, write } = await clientFolder();
    await write('fine.md', '# Fine\n\nnothing restricted here\n');
    // A social security number in a knowledge document would reach knowledge_chunks, which
    // invariant 10 forbids, and from there the model.
    await write('leaky.md', '# Leaky\n\nThe file number is 123-45-6789 for reference.\n');

    const result = await syncKnowledge(deps);
    expect(result).toMatchObject({ scanned: 2, added: 1, chunks: 1 });
    expect(result.skipped).toEqual([
      { path: 'leaky.md', reason: 'it contains a restricted identifier; remove it from the document and sync again' },
    ]);
    const rows = await db.select().from(knowledgeDocuments);
    expect(rows.map((r) => r.path)).toEqual(['fine.md']);
  });

  it('is an empty sync, not an error, for a client with no knowledge folder', async () => {
    const deps = makeTestDeps(db, { clientDir: path.join(tmpdir(), 'harness-client-nonexistent') });
    expect(await syncKnowledge(deps)).toMatchObject({ scanned: 0, added: 0, removed: 0, chunks: 0, skipped: [] });
  });

  it('leaves another client’s documents alone when it tombstones', async () => {
    const mine = await clientFolder();
    await mine.write('shared-name.md', '# Mine\n\nmine\n');
    await syncKnowledge(mine.deps);

    const theirs = await clientFolder('other-client');
    await theirs.write('different.md', '# Theirs\n\ntheirs\n');
    expect(await syncKnowledge(theirs.deps)).toMatchObject({ scanned: 1, added: 1, removed: 0 });

    // Sources are keyed by client, so the other client's folder holding none of my paths
    // tombstones none of my documents.
    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.client, 'test'));
    expect(rows.map((r) => [r.path, r.deletedAt])).toEqual([['shared-name.md', null]]);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/sync.test.ts`
Expected: FAIL — `./sync.js` does not exist.

- [ ] **Step 7: Write the sync**

Create `harness/core-tools/src/domain/knowledge/sync.ts`:

```ts
import path from 'node:path';
import { containsRestrictedPattern } from '../../shared/redaction/patterns.js';
import type { ToolDeps } from '../tooling/types.js';
import { chunkText } from './chunk.js';
import { readKnowledgeFolder } from './document.js';
import { embedTexts } from './embed.js';
import { findOrCreateSource, replaceChunks, tombstoneMissing, touchSource, upsertDocument } from './repository.js';
import { KNOWLEDGE_SOURCE_KIND, KNOWLEDGE_SOURCE_NAME, type KnowledgeSyncResult } from './types.js';

/** The one refusal a document can earn, in the register every other refusal uses: a category, never the text. */
const RESTRICTED_REASON = 'it contains a restricted identifier; remove it from the document and sync again';

/**
 * Walk the client's knowledge folder into the tables (spec 5.7).
 *
 * The shape of one pass: read every markdown file, upsert each one by `(source, path)`, re-chunk
 * and re-embed only the ones whose hash moved, tombstone the ones whose files are gone, and stamp
 * the source. Nothing is deleted outright and no other client's rows are touched, because every
 * statement is scoped to this client's source row.
 *
 * Invariant 10 is enforced here, before anything is written: a document whose title or whose text
 * trips the restricted-pattern check contributes no chunks and its row is left exactly as it was —
 * a new one is not added, an old one is not updated and not tombstoned — and its path comes back
 * in `skipped`, so one bad file is a line in the result rather than a folder that will not sync.
 *
 * Each document's chunks are replaced in their own transaction rather than the whole folder in
 * one: a batch of embeddings is a network call, and a transaction held open across a network call
 * is a lock held for as long as the gateway feels like taking.
 */
export async function syncKnowledge(deps: ToolDeps, opts: { dir?: string } = {}): Promise<KnowledgeSyncResult> {
  const dir = opts.dir ?? path.join(deps.clientDir, 'knowledge');
  const now = deps.now();
  // A stable, readable location rather than the absolute path, which differs between a checkout
  // and a container and would rewrite the row on every start for no reason.
  const location = opts.dir ?? path.posix.join('clients', deps.client, 'knowledge');
  const { id: sourceId } = await findOrCreateSource(
    deps.db,
    deps.client,
    { name: KNOWLEDGE_SOURCE_NAME, kind: KNOWLEDGE_SOURCE_KIND, location },
    now,
  );

  const documents = await readKnowledgeFolder(dir);
  const result: KnowledgeSyncResult = {
    source: KNOWLEDGE_SOURCE_NAME,
    scanned: documents.length,
    added: 0,
    updated: 0,
    unchanged: 0,
    removed: 0,
    chunks: 0,
    skipped: [],
  };
  // Every path that was on disk this pass, skipped ones included: a document refused for a
  // restricted identifier must not then be tombstoned as if its file had been deleted.
  const seen: string[] = [];

  for (const doc of documents) {
    seen.push(doc.path);
    const chunks = chunkText(doc.body);
    if (containsRestrictedPattern(doc.title) || chunks.some((chunk) => containsRestrictedPattern(chunk))) {
      result.skipped.push({ path: doc.path, reason: RESTRICTED_REASON });
      continue;
    }
    const { id, change } = await upsertDocument(deps.db, { client: deps.client, sourceId, doc, now });
    if (change === 'unchanged') {
      result.unchanged += 1;
      continue;
    }
    const vectors = await embedTexts(deps, chunks);
    result.chunks += await replaceChunks(deps.db, { documentId: id, client: deps.client, doc, chunks, vectors });
    if (change === 'added') result.added += 1;
    else result.updated += 1;
  }

  result.removed = await tombstoneMissing(deps.db, sourceId, seen, now);
  await touchSource(deps.db, sourceId, now);
  return result;
}
```

- [ ] **Step 8: Run the sync test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/sync.test.ts`
Expected: PASS, six tests.

- [ ] **Step 9: Export the new names**

In `harness/core-tools/src/index.ts`, beside the other knowledge exports, add:

```ts
export {
  findOrCreateSource,
  replaceChunks,
  tombstoneMissing,
  touchSource,
  upsertDocument,
  type DocumentChange,
} from './domain/knowledge/repository.js';
export { syncKnowledge } from './domain/knowledge/sync.js';
```

- [ ] **Step 10: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` prints nothing.

- [ ] **Step 11: Commit**

```bash
git add harness/core-tools/src/domain/knowledge harness/core-tools/src/index.ts
git commit -m "feat(knowledge): walk a client's knowledge folder into the tables, hashing to avoid a re-embed"
```

---

### Task 5: `searchKnowledge` — the access filter, the two rankings and the fusion

**Files:**
- Create: `harness/core-tools/src/domain/knowledge/search.ts`
- Test: `harness/core-tools/src/domain/knowledge/search.test.ts`
- Modify: `harness/core-tools/src/index.ts` (exports)

**Interfaces:**
- Consumes: `knowledgeChunks`, `knowledgeDocuments` from `@harness/db`; `embedTexts` (Task 2); `KNOWLEDGE_SEARCH_LIMIT`, `RRF_K`, `levelRank`, `type KnowledgeHit` (Task 3); `ToolDeps`.
- Produces:
  - `interface KnowledgeCandidate { chunk_id: string; document_id: string; path: string; title: string; updated_at: string; ordinal: number; text: string }`.
  - `fuseByReciprocalRank(lists: readonly (readonly KnowledgeCandidate[])[], k: number): KnowledgeHit[]`.
  - `searchKnowledge(deps: ToolDeps, args: { query: string; k: number }): Promise<{ hits: KnowledgeHit[] }>`.

- [ ] **Step 1: Write the failing search test**

Create `harness/core-tools/src/domain/knowledge/search.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Level } from '@harness/shared';
import { makeTestDeps, startFakeGateway, useTestDb } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';
import { fuseByReciprocalRank, searchKnowledge, type KnowledgeCandidate } from './search.js';
import { syncKnowledge } from './sync.js';

const db = useTestDb();

const FILES: Record<string, string> = {
  'front-desk.md':
    '---\ntitle: Front desk\nmin_level: member\n---\n\nThe front desk answers the telephone until five o’clock and takes messages after that.\n',
  'escalation.md':
    '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate an urgent matter to the duty lead by telephone, never by message.\n',
  'billing.md':
    '---\ntitle: Billing rates\nmin_level: admin\nprincipals: [u-analyst, svc-reports]\n---\n\nBilling rates are reviewed every quarter by the finance committee.\n',
};

/** One synced folder and a deps builder that varies only the principal. */
async function synced(): Promise<(level: Level, id?: string) => ToolDeps> {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  await mkdir(path.join(clientDir, 'knowledge'), { recursive: true });
  for (const [name, text] of Object.entries(FILES)) {
    await writeFile(path.join(clientDir, 'knowledge', name), text);
  }
  const depsFor = (level: Level, id = 'u-reader'): ToolDeps =>
    makeTestDeps(db, {
      clientDir,
      gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 200 },
      principal: {
        id,
        kind: level === 'service' ? 'service' : 'user',
        level,
        displayName: 'Reader',
        surfaces: {},
        attributes: {},
      },
    });
  const result = await syncKnowledge(depsFor('admin'));
  expect(result).toMatchObject({ added: 3, skipped: [] });
  return depsFor;
}

const paths = (hits: { path: string }[]): string[] => [...new Set(hits.map((h) => h.path))].sort();

describe('searchKnowledge access', () => {
  it('shows a member only the member-level document, whatever it asks for', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('member'), { query: 'telephone', k: 10 });
    expect(paths(hits)).toEqual(['front-desk.md']);
  });

  it('shows a lead the member and lead documents, and not the admin one', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('lead'), { query: 'telephone', k: 10 });
    expect(paths(hits)).toEqual(['escalation.md', 'front-desk.md']);
  });

  it('shows an admin everything', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'telephone rates', k: 10 });
    expect(paths(hits)).toEqual(['billing.md', 'escalation.md', 'front-desk.md']);
  });

  it('shows a named principal a document above their level, and nothing else above it', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('member', 'u-analyst'), { query: 'telephone rates', k: 10 });
    // `u-analyst` is named on billing.md, so a member sees it; escalation.md names nobody.
    expect(paths(hits)).toEqual(['billing.md', 'front-desk.md']);
  });

  it('shows a service principal only what names it, because a service is not on the level ladder', async () => {
    const depsFor = await synced();
    const named = await searchKnowledge(depsFor('service', 'svc-reports'), { query: 'telephone rates', k: 10 });
    expect(paths(named.hits)).toEqual(['billing.md']);
    const other = await searchKnowledge(depsFor('service', 'svc-nobody'), { query: 'telephone rates', k: 10 });
    expect(other.hits).toEqual([]);
  });

  it('never crosses a client boundary', async () => {
    const depsFor = await synced();
    const deps = depsFor('admin');
    const elsewhere = makeTestDeps(db, {
      clientDir: deps.clientDir,
      gateway: deps.gateway,
      client: 'other-client',
      principal: deps.principal,
    });
    expect((await searchKnowledge(elsewhere, { query: 'telephone', k: 10 })).hits).toEqual([]);
  });
});

describe('searchKnowledge results', () => {
  it('returns everything the model needs to cite a chunk', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'duty lead escalate urgent', k: 3 });
    expect(hits.length).toBeGreaterThan(0);
    const top = hits[0];
    expect(top.path).toBe('escalation.md');
    expect(top).toMatchObject({ title: 'Escalation', ordinal: 0 });
    expect(top.text).toContain('Escalate an urgent matter');
    expect(top.updated_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(top.score).toBeGreaterThan(0);
    // Ordered by the fused score, best first.
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
  });

  it('honours k, and clamps a caller that asks for more than the limit', async () => {
    const depsFor = await synced();
    expect((await searchKnowledge(depsFor('admin'), { query: 'telephone', k: 1 })).hits).toHaveLength(1);
    const many = await searchKnowledge(depsFor('admin'), { query: 'telephone', k: 999 });
    expect(many.hits.length).toBeLessThanOrEqual(3);
  });

  it('still answers when no word matches, because a nearest-neighbour search has no threshold', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'zzzz qqqq', k: 2 });
    // The lexical half matches nothing; the vector half still returns its nearest chunks. The
    // tool's description tells the model a hit is the nearest text, not an answer.
    expect(hits.length).toBeGreaterThan(0);
  });

  it('finds a document by an exact word the embedding would not favour', async () => {
    const depsFor = await synced();
    const { hits } = await searchKnowledge(depsFor('admin'), { query: 'quarter', k: 3 });
    expect(hits.map((h) => h.path)).toContain('billing.md');
  });
});

describe('fuseByReciprocalRank', () => {
  const candidate = (id: string): KnowledgeCandidate => ({
    chunk_id: id,
    document_id: `doc-${id}`,
    path: `${id}.md`,
    title: id,
    updated_at: '2026-09-15T12:00:00.000Z',
    ordinal: 0,
    text: id,
  });

  it('adds one over sixty-plus-rank per list, so agreement beats a single brilliant hit', () => {
    const vector = [candidate('a'), candidate('b'), candidate('c')];
    const lexical = [candidate('c'), candidate('b'), candidate('d')];
    const fused = fuseByReciprocalRank([vector, lexical], 4);
    expect(fused.map((h) => h.chunk_id)).toEqual(['b', 'c', 'a', 'd']);
    // b: 1/62 + 1/61; c: 1/63 + 1/61; a: 1/61; d: 1/63.
    expect(fused[0].score).toBeCloseTo(1 / 62 + 1 / 61, 12);
    expect(fused[3].score).toBeCloseTo(1 / 63, 12);
  });

  it('cuts to k and is deterministic on a tie', () => {
    const fused = fuseByReciprocalRank([[candidate('b')], [candidate('a')]], 5);
    expect(fused.map((h) => h.chunk_id)).toEqual(['a', 'b']);
    expect(fuseByReciprocalRank([[candidate('b')], [candidate('a')]], 1).map((h) => h.chunk_id)).toEqual(['a']);
  });

  it('is empty for empty lists', () => {
    expect(fuseByReciprocalRank([[], []], 5)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/search.test.ts`
Expected: FAIL — `./search.js` does not exist.

- [ ] **Step 3: Write the search**

Create `harness/core-tools/src/domain/knowledge/search.ts`:

```ts
import { and, desc, eq, isNotNull, isNull, lte, sql, type InferColumnsDataTypes, type SQL } from 'drizzle-orm';
import { knowledgeChunks, knowledgeDocuments } from '@harness/db';
import type { ToolDeps } from '../tooling/types.js';
import { embedTexts } from './embed.js';
import { KNOWLEDGE_SEARCH_LIMIT, RRF_K, levelRank, type KnowledgeHit } from './types.js';

/** One ranked row, before the two rankings are fused. */
export interface KnowledgeCandidate {
  chunk_id: string;
  document_id: string;
  path: string;
  title: string;
  updated_at: string;
  ordinal: number;
  text: string;
}

/**
 * What this caller may read (spec 5.7, invariant 7): their own client, a document that is not
 * tombstoned, and either a level at or above the chunk's or an explicit grant by principal id.
 *
 * It is a `WHERE` clause and not a filter over a result, which is the whole point: a chunk the
 * caller may not see is never ranked, never counted toward `k`, and never reaches the fusion. A
 * `service` principal's rank is `-1` and so clears nothing on level alone (decision 4).
 */
function visibleTo(deps: ToolDeps): SQL {
  const rank = levelRank(deps.principal.level);
  // Built as one `sql` fragment rather than `and(...)`, which is typed `SQL | undefined` because
  // it is allowed to be handed nothing. It never is here — the three clauses below are literals —
  // so the alternative was a `!` telling the next reader to take that on trust.
  return sql`${eq(knowledgeChunks.client, deps.client)} AND ${isNull(knowledgeDocuments.deletedAt)} AND (${lte(
    knowledgeChunks.minRank,
    rank,
  )} OR ${knowledgeChunks.principals} @> ARRAY[${deps.principal.id}]::text[])`;
}

const COLUMNS = {
  chunkId: knowledgeChunks.id,
  documentId: knowledgeChunks.documentId,
  ordinal: knowledgeChunks.ordinal,
  text: knowledgeChunks.text,
  path: knowledgeDocuments.path,
  title: knowledgeDocuments.title,
  updatedAt: knowledgeDocuments.updatedAt,
};

/**
 * The row shape `COLUMNS` selects, derived from the columns themselves rather than written out
 * beside them. A hand-written copy is a second place to forget: rename a column or widen one to
 * nullable and the copy still compiles, the cast below it still passes, and the mismatch surfaces
 * as a runtime `undefined` somewhere downstream.
 */
type Row = InferColumnsDataTypes<typeof COLUMNS>;

const candidateOf = (row: Row): KnowledgeCandidate => ({
  chunk_id: row.chunkId,
  document_id: row.documentId,
  path: row.path,
  title: row.title,
  updated_at: row.updatedAt.toISOString(),
  ordinal: row.ordinal,
  text: row.text,
});

/**
 * The `k` nearest chunks by cosine distance.
 *
 * `<=>` is pgvector's cosine-distance operator and is what the HNSW index on `embedding` was
 * built for. The vector is bound as a parameter and cast, never interpolated. There is **no
 * distance threshold**: a nearest-neighbour search always answers with its `k` nearest rows,
 * however far away they are, which is why the tool tells the model that a hit is the nearest text
 * rather than an answer.
 */
async function vectorTopK(deps: ToolDeps, vector: readonly number[], k: number): Promise<KnowledgeCandidate[]> {
  const literal = sql`${`[${vector.join(',')}]`}::vector`;
  const rows: Row[] = await deps.db
    .select(COLUMNS)
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(and(visibleTo(deps), isNotNull(knowledgeChunks.embedding)))
    .orderBy(sql`${knowledgeChunks.embedding} <=> ${literal}`)
    .limit(k);
  return rows.map(candidateOf);
}

/**
 * The `k` best chunks by `ts_rank_cd` over the generated `tsv` column.
 *
 * `plainto_tsquery` takes the query as plain words — no operators, so nothing the model writes can
 * widen the match — and a query of stop words alone is the empty query, which matches nothing.
 * `ts_rank_cd` is the cover-density ranking: unlike `ts_rank` it rewards terms appearing close
 * together, which is what spec 5.7 names.
 */
async function lexicalTopK(deps: ToolDeps, query: string, k: number): Promise<KnowledgeCandidate[]> {
  const tsquery = sql`plainto_tsquery('english', ${query})`;
  const rows: Row[] = await deps.db
    .select(COLUMNS)
    .from(knowledgeChunks)
    .innerJoin(knowledgeDocuments, eq(knowledgeDocuments.id, knowledgeChunks.documentId))
    .where(and(visibleTo(deps), sql`${knowledgeChunks.tsv} @@ ${tsquery}`))
    .orderBy(desc(sql`ts_rank_cd(${knowledgeChunks.tsv}, ${tsquery})`))
    .limit(k);
  return rows.map(candidateOf);
}

/**
 * Reciprocal rank fusion: each list contributes `1 / (RRF_K + rank)`, rank counted from 1.
 *
 * Ranks rather than scores, because the two rankings' scores are not comparable — a cosine
 * distance and a cover-density rank are different things measured differently — and the one thing
 * they agree on is order. A chunk both rankings found beats one either found brilliantly, which is
 * the behaviour a hybrid search is for. Ties break on the chunk id so one query always answers in
 * one order.
 */
export function fuseByReciprocalRank(
  lists: readonly (readonly KnowledgeCandidate[])[],
  k: number,
): KnowledgeHit[] {
  const fused = new Map<string, { candidate: KnowledgeCandidate; score: number }>();
  for (const list of lists) {
    list.forEach((candidate, index) => {
      const entry = fused.get(candidate.chunk_id) ?? { candidate, score: 0 };
      entry.score += 1 / (RRF_K + index + 1);
      fused.set(candidate.chunk_id, entry);
    });
  }
  return [...fused.values()]
    .sort((a, b) => b.score - a.score || a.candidate.chunk_id.localeCompare(b.candidate.chunk_id))
    .slice(0, k)
    .map(({ candidate, score }) => ({ ...candidate, score }));
}

/**
 * Hybrid retrieval over this client's knowledge, at this caller's level (spec 5.7).
 *
 * One embedding call for the query, then the two rankings — both already filtered — then the
 * fusion. The embedding is **not** optional: a lexical-only answer looks exactly like a full one,
 * so a broken `embed` route would quietly halve recall for as long as nobody noticed. It fails
 * loudly instead, with the message `embedTexts` raises.
 *
 * `k` is clamped rather than only capped: the tool's schema already guarantees an integer in
 * range, but this function is exported from the package root and a direct caller passing 0 or a
 * negative would otherwise reach Postgres with it.
 */
export async function searchKnowledge(
  deps: ToolDeps,
  args: { query: string; k: number },
): Promise<{ hits: KnowledgeHit[] }> {
  const k = Math.max(1, Math.min(Math.trunc(args.k), KNOWLEDGE_SEARCH_LIMIT));
  const [vector] = await embedTexts(deps, [args.query]);
  const [byVector, byWord] = await Promise.all([
    vectorTopK(deps, vector, k),
    lexicalTopK(deps, args.query, k),
  ]);
  return { hits: fuseByReciprocalRank([byVector, byWord], k) };
}
```

- [ ] **Step 4: Run the search test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/search.test.ts`
Expected: PASS, thirteen tests.

- [ ] **Step 5: Export the new names**

In `harness/core-tools/src/index.ts`, beside the other knowledge exports, add:

```ts
export { fuseByReciprocalRank, searchKnowledge, type KnowledgeCandidate } from './domain/knowledge/search.js';
```

- [ ] **Step 6: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add harness/core-tools/src/domain/knowledge harness/core-tools/src/index.ts
git commit -m "feat(knowledge): rank chunks two ways behind the caller's access filter and fuse them"
```

---

### Task 6: `knowledge_search` and `knowledge_sync`, and the tool surface

**Files:**
- Create: `harness/core-tools/src/tools/knowledge.ts`
- Test: `harness/core-tools/src/tools/knowledge.test.ts`
- Modify: `harness/core-tools/src/tools/catalog.ts`
- Modify: `harness/core-tools/src/app/surface.test.ts` (`RECORDED_TOOLS`, one assertion name)
- Modify: `harness/core-tools/src/app/dual-pack.test.ts` (the published count)
- Modify: `docs/architecture/tool-surface.json` (re-recorded)

**Interfaces:**
- Consumes: `searchKnowledge` (Task 5); `syncKnowledge` (Task 4); `KNOWLEDGE_DEFAULT_K`, `KNOWLEDGE_SEARCH_LIMIT` (Task 3); `defineTool`, `type AnyToolDef`.
- Produces: `knowledgeTools: AnyToolDef[]` holding `knowledge_search` (`read`) and `knowledge_sync` (`write.internal`; the plan first said `admin`, which the policy blocks for the `service` principal the shipped playbook runs as — corrected during execution), added to `kernelTools(packs)`.

- [ ] **Step 1: Write the failing tool test**

Create `harness/core-tools/src/tools/knowledge.test.ts`:

```ts
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, onTestFinished } from 'vitest';
import type { Level } from '@harness/shared';
import { createCoreToolsServer } from './catalog.js';
import { connectTestClient, makeTestDeps, resultOf, startFakeGateway, textOf, useTestDb } from '../testing.js';

const db = useTestDb();

async function client(level: Level, id = 'u-reader') {
  const fake = await startFakeGateway();
  onTestFinished(() => fake.close());
  const clientDir = await mkdtemp(path.join(tmpdir(), 'harness-client-'));
  await mkdir(path.join(clientDir, 'knowledge'), { recursive: true });
  await writeFile(
    path.join(clientDir, 'knowledge', 'front-desk.md'),
    '---\ntitle: Front desk\nmin_level: member\n---\n\nThe front desk answers the telephone until five.\n',
  );
  await writeFile(
    path.join(clientDir, 'knowledge', 'escalation.md'),
    '---\ntitle: Escalation\nmin_level: lead\n---\n\nEscalate an urgent matter to the duty lead.\n',
  );
  const deps = makeTestDeps(db, {
    clientDir,
    gateway: { baseUrl: fake.url, apiKey: 'sk-test', timeoutMs: 5_000, maxCallsPerRun: 200 },
    principal: {
      id,
      kind: 'user',
      level,
      displayName: 'Reader',
      surfaces: {},
      attributes: {},
    },
  });
  return { deps, tools: await connectTestClient(() => createCoreToolsServer(deps)) };
}

describe('knowledge_sync', () => {
  it('is an admin tool: an admin syncs the folder and gets the counts back', async () => {
    const { tools } = await client('admin');
    const result = resultOf<{ source: string; scanned: number; added: number; chunks: number }>(
      await tools.callTool({ name: 'knowledge_sync', arguments: {} }),
    );
    expect(result).toMatchObject({ source: 'client-folder', scanned: 2, added: 2 });
    expect(result.chunks).toBe(2);
  });

  it('is refused for a lead, because it rewrites what everyone can read', async () => {
    const { tools } = await client('lead');
    const refused = await tools.callTool({ name: 'knowledge_sync', arguments: {} });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain('blocked');
  });
});

describe('knowledge_search', () => {
  it('answers a member with the member-level document only, and cites it', async () => {
    const admin = await client('admin');
    await admin.tools.callTool({ name: 'knowledge_sync', arguments: {} });

    const member = await client('member');
    const found = resultOf<{ hits: { path: string; title: string; updated_at: string; text: string }[] }>(
      await member.tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone duty lead' } }),
    );
    expect(found.hits.map((h) => h.path)).toEqual(['front-desk.md']);
    expect(found.hits[0]).toMatchObject({ title: 'Front desk' });
    expect(found.hits[0].text).toContain('front desk');
  });

  it('answers a lead with both, newest access rules applied', async () => {
    const admin = await client('admin');
    await admin.tools.callTool({ name: 'knowledge_sync', arguments: {} });

    const lead = await client('lead');
    const found = resultOf<{ hits: { path: string }[] }>(
      await lead.tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone duty lead', k: 5 } }),
    );
    expect([...new Set(found.hits.map((h) => h.path))].sort()).toEqual(['escalation.md', 'front-desk.md']);
  });

  it('refuses a k above the limit and a query that is too short, at the schema', async () => {
    const { tools } = await client('member');
    const tooBig = await tools.callTool({ name: 'knowledge_search', arguments: { query: 'telephone', k: 99 } });
    expect(tooBig.isError).toBe(true);
    const tooShort = await tools.callTool({ name: 'knowledge_search', arguments: { query: 'a' } });
    expect(tooShort.isError).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/tools/knowledge.test.ts`
Expected: FAIL — `Tool knowledge_sync not found`.

- [ ] **Step 3: Write the two tools**

Create `harness/core-tools/src/tools/knowledge.ts`:

```ts
import * as z from 'zod/v4';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { searchKnowledge } from '../domain/knowledge/search.js';
import { syncKnowledge } from '../domain/knowledge/sync.js';
import { KNOWLEDGE_DEFAULT_K, KNOWLEDGE_SEARCH_LIMIT } from '../domain/knowledge/types.js';

const HitShape = z.object({
  chunk_id: z.string(),
  document_id: z.string(),
  path: z.string(),
  title: z.string(),
  updated_at: z.string(),
  ordinal: z.number(),
  text: z.string(),
  score: z.number(),
});

const knowledgeSearch = defineTool({
  name: 'knowledge_search',
  description:
    'Search this deployment’s knowledge base and get back passages you can cite. Plain words, no operators. ' +
    'Each hit carries the document’s path, title and last-updated time, and the passage itself — quote or ' +
    'paraphrase it and name the path, so the reader can check it. You only ever see documents your level or an ' +
    'explicit grant allows, so an answer you cannot support here is one you should say you do not have. ' +
    'A hit is the nearest passage to your words, not a guarantee that it answers them: read it before you use it.',
  actionClass: 'read',
  input: z.object({
    query: z.string().min(2).max(500),
    k: z.number().int().min(1).max(KNOWLEDGE_SEARCH_LIMIT).default(KNOWLEDGE_DEFAULT_K),
  }),
  output: z.object({ hits: z.array(HitShape) }),
  handler: async (args, deps) => searchKnowledge(deps, args),
});

const knowledgeSync = defineTool({
  name: 'knowledge_sync',
  description:
    'Re-read this deployment’s knowledge folder into the knowledge base: new and changed documents are ' +
    'chunked and embedded again, and a document whose file is gone stops being searchable. Reports how many ' +
    'documents were scanned, added, updated, left alone and removed, how many passages were written, and any ' +
    'document that was skipped, with the reason.',
  actionClass: 'write.internal',
  input: z.object({}),
  output: z.object({
    source: z.string(),
    scanned: z.number(),
    added: z.number(),
    updated: z.number(),
    unchanged: z.number(),
    removed: z.number(),
    chunks: z.number(),
    skipped: z.array(z.object({ path: z.string(), reason: z.string() })),
  }),
  handler: async (_args, deps) => syncKnowledge(deps),
});

export const knowledgeTools: AnyToolDef[] = [knowledgeSearch, knowledgeSync];
```

- [ ] **Step 4: Publish them**

In `harness/core-tools/src/tools/catalog.ts`, add `import { knowledgeTools } from './knowledge.js';` beside the other tool imports, and add `...knowledgeTools,` to the array `kernelTools` returns, after `...harnessTools,` and before `...memoryTools,`.

- [ ] **Step 5: Run the tool test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/tools/knowledge.test.ts`
Expected: PASS, five tests.

- [ ] **Step 6: Re-record the tool surface and move the two counts**

In `harness/core-tools/src/app/surface.test.ts`, add `'knowledge_search',` and `'knowledge_sync',` to `RECORDED_TOOLS`, in alphabetical order: after `'harness_reconcile',` and before `'memory_add',`. Extend that constant's doc comment with one line:

```
 * Plan 10 adds the two knowledge tools of spec 5.7 (Task 6).
```

and change the name of the `it` that asserts the list to:

```ts
  it('publishes the twenty-two tools of Plan 6 less harness_set_context, plus the memory, playbook and knowledge tools of Plans 9 and 10', async () => {
```

In `harness/core-tools/src/app/dual-pack.test.ts`, change the count and its comment to:

```ts
    // Twenty-four kernel tools (sixteen from Plan 7, four memory and two playbook tools from
    // Plan 9, two knowledge tools from Plan 10), seven of them replaced by healthcare, plus
    // healthcare's eighteen: 24 − 7 + 18 = 35. The five records_* survive because the stories
    // pack's `epic` kind leaves genericTools true, so the publication gate does not drop them.
    expect(names).toHaveLength(35);
```

Then run, from the repository root:

```bash
pnpm surface:record
git diff --stat docs/architecture
```

Expected: `tool-surface.json` modified; `compose-surface.yaml` **unchanged**. The diff adds exactly two entries, `knowledge_search` and `knowledge_sync`, and touches no other tool's schema.

- [ ] **Step 7: Run the surface and dual-pack tests**

Run: `pnpm --filter @harness/core-tools exec vitest run src/app/surface.test.ts src/app/dual-pack.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add harness/core-tools/src/tools/knowledge.ts harness/core-tools/src/tools/knowledge.test.ts \
  harness/core-tools/src/tools/catalog.ts harness/core-tools/src/app/surface.test.ts \
  harness/core-tools/src/app/dual-pack.test.ts docs/architecture/tool-surface.json
git commit -m "feat(tools): publish knowledge_search and knowledge_sync"
```

---

### Task 7: The turn learns a watcher, and the playbook claim loses a dead option

**Files:**
- Modify: `harness/host/src/domain/conversation.ts`
- Test: `harness/host/src/domain/conversation.test.ts`
- Modify: `harness/host/src/domain/playbooks/repository.ts`
- Test: `harness/host/src/domain/playbooks/repository.test.ts`
- Modify: `harness/host/src/index.ts` (export `TurnEvent`, `CLAIM_BATCH`)

**Interfaces:**
- Consumes: `type RunEvent` from `@harness/runtime-api`; `type RunStatus` from `@harness/core-tools`.
- Produces:
  - `type TurnEvent = { type: 'run'; runId: string } | RunEvent | { type: 'result'; status: RunStatus; text: string; error: string | null }`.
  - `TurnInput.observe?: (event: TurnEvent) => void`.
  - `CLAIM_BATCH = 10` in `domain/playbooks/repository.ts`; `claimDuePlaybooks(db, { client, now })` — the `limit` option is gone.

- [ ] **Step 1: Write the failing watcher test**

Append to `harness/host/src/domain/conversation.test.ts`, inside the outermost `describe`:

```ts
  it('hands a watcher the run id, every runtime event in order, and the outcome', async () => {
    const f = await hostFixture(db, {
      trajectory: [{ skill: 'sample-skill', version: '1.0.0' }, { tool: 'audit_query', args: {} }, { say: 'all clear' }],
    });
    onTestFinished(() => f.close());
    const thread = await findOrCreateThread(db, {
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: COORDINATOR.id,
    });
    const seen: TurnEvent[] = [];
    const result = await runTurn(f.host, {
      thread,
      principal: COORDINATOR,
      role: 'user',
      text: 'anything overdue?',
      attachments: [],
      replyTo: null,
      observe: (event) => seen.push(event),
    });

    expect(seen[0]).toEqual({ type: 'run', runId: result.runId });
    expect(seen.at(-1)).toEqual({ type: 'result', status: 'done', text: 'all clear', error: null });
    expect(seen.slice(1, -1).map((event) => event.type)).toEqual([
      'skill_activated',
      'tool_call',
      'tool_result',
      'text',
      'done',
    ]);
  });

  it('tells a watcher that a cancelled run was cancelled, with the run id it can cancel by', async () => {
    const f = await hostFixture(db, { trajectory: [{ sleep: 150 }, { say: 'too late' }] });
    onTestFinished(() => f.close());
    const thread = await findOrCreateThread(db, {
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: COORDINATOR.id,
    });
    const seen: TurnEvent[] = [];
    const turn = runTurn(f.host, {
      thread,
      principal: COORDINATOR,
      role: 'user',
      text: 'start something slow',
      attachments: [],
      replyTo: null,
      observe: (event) => {
        seen.push(event);
        // The run id reaches the watcher before the runtime has produced anything, which is what
        // lets the run API answer 202 with an id a caller can immediately cancel by.
        if (event.type === 'run') expect(cancelRun(f.host, event.runId)).toBe(true);
      },
    });
    const result = await turn;
    expect(result.status).toBe('cancelled');
    expect(seen.at(-1)).toEqual({ type: 'result', status: 'cancelled', text: '', error: 'cancelled' });
  });

  it('is not failed by a watcher that throws', async () => {
    const f = await hostFixture(db, { trajectory: [{ say: 'fine' }] });
    onTestFinished(() => f.close());
    const thread = await findOrCreateThread(db, {
      client: 'test',
      surface: 'memory',
      conversation: 'memory',
      principalId: COORDINATOR.id,
    });
    const result = await runTurn(f.host, {
      thread,
      principal: COORDINATOR,
      role: 'user',
      text: 'hello',
      attachments: [],
      replyTo: null,
      observe: () => {
        throw new Error('the socket went away');
      },
    });
    // A watcher is watching, not taking part: a client that hung up mid-run must not turn a
    // finished run into a failed one.
    expect(result).toMatchObject({ status: 'done', text: 'fine', error: null });
  });
```

Add `type TurnEvent` to that file's import from `./conversation.js`, and make sure `cancelRun`, `findOrCreateThread`, `hostFixture`, `COORDINATOR` and `onTestFinished` are all imported there (every one but `TurnEvent` already is).

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/host exec vitest run src/domain/conversation.test.ts`
Expected: FAIL — `TurnEvent` is not exported and `observe` is not a `TurnInput` member.

- [ ] **Step 3: Add the watcher**

In `harness/host/src/domain/conversation.ts`, widen the runtime-api import to `import type { RunEvent, RunRequest, RunSkill } from '@harness/runtime-api';`, and add above `TurnInput`:

```ts
/**
 * What a watcher of a turn sees, in order: the run id as soon as the run is open, every event the
 * runtime produced, and the turn's own outcome once the host has had its say.
 *
 * The middle is the runtime's events **unfiltered** — the same deltas a streamed surface reply
 * gets today, restricted-pattern check and all still to come. A watcher that sends them outside
 * this process is the one that applies the check, which is what the run API's writer does; the
 * closing `result` carries the whole reply already withheld if it tripped.
 */
export type TurnEvent =
  | { type: 'run'; runId: string }
  | RunEvent
  | { type: 'result'; status: RunStatus; text: string; error: string | null };
```

and add to `TurnInput`, after `costCapUsd`:

```ts
  /**
   * Somebody watching this turn as it happens: the run API's stream, and nothing else today. It
   * is told the run id first, so a caller can cancel a run it has not seen a word of yet.
   */
  observe?: (event: TurnEvent) => void;
```

In `runTurn`, **immediately after `host.active.set(runId, { controller, done: finished });`** — not after `const runId = kernel.context.runId;`, which is nine lines earlier — add:

```ts
  /**
   * A watcher is watching, not taking part: its failure is logged and dropped. An HTTP client that
   * hung up mid-run must not turn a finished run into a failed one, and must not skip the
   * `finally` that closes the run row either.
   */
  const emit = (event: TurnEvent): void => {
    if (!turn.observe) return;
    try {
      turn.observe(event);
    } catch (err) {
      host.log.error(`run ${runId}: the turn watcher threw`, err);
    }
  };
  // After `host.active.set`, deliberately. `cancelRun` looks the run up in `host.active` and
  // answers false when it is not there, so a watcher told the run id one line earlier would be
  // handed an id it cannot cancel — and a caller that cancels the instant it reads the first
  // frame is exactly what the run API's stream invites. The test below cancels from inside
  // `observe` and asserts `true`, which is what pins this ordering.
  emit({ type: 'run', runId });
```

In the `for await` loop over `host.runtime.run(request).events`, make `emit(event);` the first statement of the loop body, before the `switch`.

And immediately before the final `return { runId, status, text: safeText, error };`, add:

```ts
      // After the forced outcome and the redaction guard, so a watcher is told what the run
      // actually ended as and reads the text the human would have been sent.
      emit({ type: 'result', status, text: safeText, error });
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @harness/host exec vitest run src/domain/conversation.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing claim-batch test**

In `harness/host/src/domain/playbooks/repository.test.ts`, inside `describe('claimDuePlaybooks', …)`, add:

```ts
  it('claims at most CLAIM_BATCH playbooks in one tick, leaving the rest for the next', async () => {
    const at = new Date('2026-09-16T07:00:00Z');
    await syncPlaybooks(
      db,
      { client: 'test', now: NOW },
      Array.from({ length: CLAIM_BATCH + 2 }, (_, i) => ({ ...nightly, name: `nightly-${i}` })),
    );
    await db.update(playbooks).set({ nextRunAt: at });
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toHaveLength(CLAIM_BATCH);
    expect(await claimDuePlaybooks(db, { client: 'test', now: at })).toHaveLength(2);
  });
```

It uses the file's own `nightly` definition and `NOW`, both already at the top of it, and adds `CLAIM_BATCH` to the import from `./repository.js`.

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @harness/host exec vitest run src/domain/playbooks/repository.test.ts`
Expected: FAIL — `CLAIM_BATCH` is not exported.

- [ ] **Step 7: Replace the option with the constant**

In `harness/host/src/domain/playbooks/repository.ts`, add above `claimDuePlaybooks`:

```ts
/**
 * How many playbooks one tick claims.
 *
 * A bound, not a setting: a tick that claimed every due row would run them all before the next
 * one, and with two hosts on one database the bound is also what keeps one of them from taking the
 * whole queue. Ten is more than any client schedules in one minute, and what a tick leaves behind
 * is still due thirty seconds later. This was a `limit?` option until Plan 10; nothing ever passed
 * one, so it is a constant now and there is one number to find rather than two places to look.
 */
export const CLAIM_BATCH = 10;
```

Change the signature to `opts: { client: string; now: Date }`, delete the `const limit = opts.limit ?? 10;` line, and replace both `.limit(limit)` calls with `.limit(CLAIM_BATCH)`.

In `harness/host/src/index.ts`, add `CLAIM_BATCH` to the existing `export { claimDuePlaybooks, finishPlaybookRun, syncPlaybooks, type ClaimedRun } from './domain/playbooks/repository.js';` and `type TurnEvent` to the `./domain/conversation.js` export list.

- [ ] **Step 8: Run the host suite to verify it passes**

Run: `pnpm --filter @harness/host exec vitest run`
Expected: PASS.

- [ ] **Step 9: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` prints nothing.

- [ ] **Step 10: Commit**

```bash
git add harness/host/src/domain/conversation.ts harness/host/src/domain/conversation.test.ts \
  harness/host/src/domain/playbooks/repository.ts harness/host/src/domain/playbooks/repository.test.ts \
  harness/host/src/index.ts
git commit -m "feat(host): let a caller watch a turn's events, and fix the playbook claim's batch size in code"
```

---

### Task 8: The `http` surface

**Files:**
- Create: `surfaces/http/package.json`, `surfaces/http/tsconfig.json`, `surfaces/http/vitest.config.ts`, `surfaces/http/README.md`
- Create: `surfaces/http/src/index.ts`
- Test: `surfaces/http/src/index.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry)
- Modify: `harness/core-tools/src/kernel-vocabulary.test.ts` (four scan rows)
- Modify: `harness/host/package.json` (workspace dependency)

**Interfaces:**
- Consumes: `defineSurface`, `type Surface`, `type SurfaceSession`, `type SurfaceCapabilities`, `type MessageEvent`, `type ActionEvent`, `type FormEvent`, `type MessageRef`, `type Card`, `type Form`, `type StreamHandle`, `type UploadRequest` from `@harness/surface-api`; `SurfaceError` from `@harness/shared`.
- Produces: package `@harness/surface-http` exporting `surface` (name `http`), plus `HTTP_SURFACE_CONVERSATION = 'api'` for the tests and the docs.

- [ ] **Step 1: Write the failing adapter test**

Create `surfaces/http/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { HTTP_SURFACE_CONVERSATION, surface } from './index.js';

const connect = () => surface.connect({ env: {}, log: { info() {}, warn() {}, error() {} }, storageDir: '/tmp' });

describe('the http surface', () => {
  it('is named http, reads no secret, and opens no transport', async () => {
    expect(surface.name).toBe('http');
    expect(surface.secrets).toEqual([]);
    const session = await connect();
    await session.start();
    await session.stop();
    expect(session.name).toBe('http');
    expect(session.defaultConversation).toBe(HTTP_SURFACE_CONVERSATION);
  });

  it('declares every capability false: a request has no conversation that outlives it', async () => {
    const session = await connect();
    expect(session.capabilities).toEqual({
      forms: false,
      privateReply: false,
      update: false,
      streaming: false,
      inlineConfirm: false,
    });
  });

  it('refuses every way of posting, with a message safe to store, naming the surface', async () => {
    const session = await connect();
    const ref = { surface: 'http', conversation: 'api', id: '1' };
    const card = { id: 'c', title: 't', notice: 'n', body: [], actions: [] };
    await expect(session.postText('api', 'hello')).rejects.toThrow(SurfaceError);
    await expect(session.postText('api', 'hello')).rejects.toThrow(
      'surface "http" cannot post outside a request; the run API answers on the caller’s own stream',
    );
    await expect(session.postCard('api', card)).rejects.toThrow(SurfaceError);
    await expect(session.updateCard(ref, card)).rejects.toThrow(SurfaceError);
    await expect(session.postPrivate('api', 'u-1', 'hello')).rejects.toThrow(SurfaceError);
    await expect(session.uploadFile('api', { path: '/tmp/x', filename: 'x' })).rejects.toThrow(SurfaceError);
    await expect(session.openForm('trigger', { id: 'f', title: 't', submitLabel: 'go', cancelLabel: 'no', fields: [], metadata: '' })).rejects.toThrow(SurfaceError);
    expect(() => session.startStream('api')).toThrow(SurfaceError);
  });

  it('spells a mention as the principal id, because there is nobody to notify', async () => {
    const session = await connect();
    expect(session.mention('u-coordinator')).toBe('@u-coordinator');
  });

  it('accepts the three handlers and never calls them, because nothing arrives out of band', async () => {
    const session = await connect();
    let called = 0;
    session.onMessage(async () => {
      called += 1;
    });
    session.onAction(async () => {
      called += 1;
    });
    session.onFormSubmit(async () => {
      called += 1;
    });
    await session.start();
    await session.stop();
    expect(called).toBe(0);
  });
});
```

- [ ] **Step 2: Create the package and run the test to verify it fails**

Create `surfaces/http/package.json`:

```json
{
  "name": "@harness/surface-http",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*",
    "@harness/surface-api": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `surfaces/http/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Create `surfaces/http/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Add `"@harness/surface-http": "workspace:*",` to `dependencies` in `harness/host/package.json`, in alphabetical order (after `@harness/surface-api`, before `@harness/surface-memory`) — the host declares every adapter it may be told to load, so pnpm can resolve the name.

Run, from the repository root: `pnpm install && pnpm --filter @harness/surface-http exec vitest run`
Expected: FAIL — `./index.js` does not exist.

- [ ] **Step 3: Write the adapter**

Create `surfaces/http/src/index.ts`:

```ts
import { SurfaceError } from '@harness/shared';
import { defineSurface } from '@harness/surface-api';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageEvent,
  MessageRef,
  StreamHandle,
  Surface,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';

/**
 * The conversation a run opened over the API belongs to when the caller names none. A thread key
 * needs one, and this is a name rather than an id because there is no directory of conversations
 * here to take an id from.
 */
export const HTTP_SURFACE_CONVERSATION = 'api';

/** One sentence, safe to store in a plaintext column: it names the surface and what failed, nothing else. */
const CANNOT_POST = 'surface "http" cannot post outside a request; the run API answers on the caller’s own stream';

/**
 * The surface a headless caller speaks as.
 *
 * It opens no socket. The run API's listener lives in the host, because spec 5.8 puts it there,
 * and what this adapter supplies is the other three things a run needs to exist: a `threads.surface`
 * value so an API run has a thread of its own, a namespace for the identity plug-in to resolve
 * `(surface, userId)` in — `surfaces: { http: … }` in `identity.yaml` — and a loaded session for
 * `runTurn` to find.
 *
 * Every capability is false and every way of posting rejects, and both are honest rather than
 * unfinished. An HTTP request has no conversation that outlives it: by the time anything would be
 * posted here, the exchange that could have carried it is over. A run driven through the API is
 * delivered on the caller's own event stream instead (`deliver: 'none'` on the turn), and an
 * approval card raised during one goes where every card goes — the primary surface.
 *
 * **Do not make this the primary surface.** `HARNESS_SURFACES` makes its first entry primary and
 * that is where approval cards are posted, so list this one after a surface a human reads.
 */
function session(): SurfaceSession {
  const refuse = (): never => {
    throw new SurfaceError(CANNOT_POST);
  };
  return {
    name: 'http',
    capabilities: { forms: false, privateReply: false, update: false, streaming: false, inlineConfirm: false },
    defaultConversation: HTTP_SURFACE_CONVERSATION,
    // No directory to look a display name up in, and no syntax to notify with: the id is the
    // honest rendering, and a caller reading it already knows what a principal id is.
    mention: (userId: string) => `@${userId}`,
    postCard: (_conversation: string, _card: Card): Promise<MessageRef> => refuse(),
    updateCard: (_ref: MessageRef, _card: Card): Promise<void> => refuse(),
    postText: (_conversation: string, _text: string): Promise<MessageRef> => refuse(),
    postPrivate: (_conversation: string, _userId: string, _text: string): Promise<void> => refuse(),
    uploadFile: (_conversation: string, _file: UploadRequest): Promise<{ filename: string }> => refuse(),
    openForm: (_trigger: string, _form: Form): Promise<void> => refuse(),
    // Accepted and never called: nothing arrives on this surface out of band. The run API resolves
    // the principal and opens the turn itself, so a message never takes the adapter's inbound path.
    onAction: (_handler: (event: ActionEvent) => Promise<void>) => {},
    onFormSubmit: (_handler: (event: FormEvent) => Promise<void>) => {},
    onMessage: (_handler: (event: MessageEvent) => Promise<void>) => {},
    startStream: (_conversation: string): StreamHandle => refuse(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export const surface: Surface = defineSurface({
  name: 'http',
  version: '0.1.0',
  secrets: [],
  // Not `async`: a surface with no transport has nothing to await on the way up. The run API's
  // own bearer secret is HARNESS_HOST_TOKEN and is read by the host, not by this adapter, which
  // is why `secrets` is empty.
  connect: () => Promise.resolve(session()),
});
```

Create `surfaces/http/README.md`:

```markdown
# @harness/surface-http

The surface a headless caller speaks as, for the run API (`docs/runbook.md`, "The run API").

It opens no socket and posts nothing. The API's listener is in `@harness/host`; this package
supplies the three things a run driven over HTTP still needs: a `threads.surface` value, a
namespace for the identity plug-in to resolve `(surface, userId)` in, and a loaded session for the
host to find. Every capability is false, and every posting method rejects with a `SurfaceError`,
because an HTTP request has no conversation that outlives it.

Load it **after** a surface a human reads:

    HARNESS_SURFACES=@harness/surface-slack,@harness/surface-http

The first entry is the primary surface and is where approval cards are posted; this one could not
post a card if it were asked to. Give each principal that may call the API an `http` entry in
`clients/<name>/identity.yaml`:

    - id: u-coordinator
      surfaces:
        slack: U0456EFGH
        http: coordinator

The value is any stable string: it is what `POST /v1/runs` sends as `userId`, and the identity
plug-in is the only thing that maps it to a principal.
```

- [ ] **Step 4: Run the adapter test to verify it passes**

Run: `pnpm --filter @harness/surface-http exec vitest run`
Expected: PASS, five tests.

- [ ] **Step 5: Register the package with the architecture rules**

In `.dependency-cruiser.cjs`, add to `PACKAGES`, after the `surface-memory` row:

```js
  { name: 'surface-http', src: 'surfaces/http/src', severity: 'error' },
```

and to `WORKSPACE_DIRS`, after `'surfaces/memory'`:

```js
  'surfaces/http',
```

Nothing else in that file changes: `a-surface-imports-only-api-and-shared` already matches `^surfaces/([^/]+)/`.

- [ ] **Step 6: Scan the new package for vocabulary**

In `harness/core-tools/src/kernel-vocabulary.test.ts`, add four entries to `SCANNED`, after the `runtimes/deepagents/src` group:

```ts
  {
    what: 'credentialing vocabulary',
    root: 'surfaces/http/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'messaging vocabulary',
    root: 'surfaces/http/src',
    forbidden: MESSAGING_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'surfaces/http/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'surfaces/http/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
```

and extend that constant's doc comment with:

```
 * `surfaces/http/src` is scanned for all four lists, unlike the other adapters. `surfaces/slack`
 * is exempt from the messaging list because it *is* the messaging vendor; this one is a plain
 * transport that belongs to nobody, and an HTTP adapter that had learned a product area, a
 * messaging vendor or a framework would be exactly the coupling the surface contract removes.
```

- [ ] **Step 7: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. In particular `pnpm arch` reports zero violations with the two new lines, and `git status --short docs/architecture` prints nothing — no tool and no Compose service was added.

- [ ] **Step 8: Commit**

```bash
git add surfaces/http .dependency-cruiser.cjs harness/core-tools/src/kernel-vocabulary.test.ts \
  harness/host/package.json pnpm-lock.yaml
git commit -m "feat(surface-http): add the surface a headless caller speaks as"
```

---

### Task 9: The run API — four routes, a bearer token and a Server-Sent Events stream

**Files:**
- Create: `harness/host/src/domain/api/types.ts`
- Create: `harness/host/src/domain/api/sse.ts`
- Test: `harness/host/src/domain/api/sse.test.ts`
- Create: `harness/host/src/domain/api/repository.ts`
- Create: `harness/host/src/domain/api/routes.ts`
- Test: `harness/host/src/domain/api/routes.test.ts`
- Create: `harness/host/src/domain/api/server.ts`
- Test: `harness/host/src/domain/api/server.test.ts`
- Modify: `harness/host/src/app/main.ts`, `harness/host/src/index.ts`
- Modify: `.env.example`

**Interfaces:**
- Consumes: `runTurn`, `serialize`, `cancelRun`, `type TurnEvent` (Task 7); `findOrCreateThread`, `WITHHELD` from `./threads/repository.js`; `containsRestrictedPattern` from `@harness/core-tools/redaction`; `type SchedulerStatus` from `./playbooks/scheduler.js`; `messages`, `runs`, `threads` from `@harness/db`; `assertInsideRoot`, `CONVERSATION_ID_PATTERN`, `SURFACE_NAME_PATTERN` from `@harness/shared`.
- Produces:
  - `API_MAX_BODY_BYTES = 1_048_576`, `API_MAX_TEXT_CHARS = 10_000`, `API_MAX_ATTACHMENTS = 10`, `API_THREAD_MESSAGES = 200`, `SSE_KEEPALIVE_MS = 15_000`, `DEFAULT_HOST_BIND = '127.0.0.1'`, `DEFAULT_HOST_PORT = 8788`.
  - `interface RunApiOptions { token: string; bind?: string; port?: number; scheduler?: { status(): SchedulerStatus } }`.
  - `interface RunApiServer { ready: Promise<void>; address(): AddressInfo | string | null; close(): Promise<void> }`.
  - `sseStream(res: ServerResponse, opts?: { keepAliveMs?: number }): SseStream` with `SseStream { readonly open: boolean; send(event: string, data: unknown): void; comment(text: string): void; end(): void }`.
  - `bearerOk(header: string | undefined, token: string): boolean`; `readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }>`; `handleApiRequest(host: Host, req: IncomingMessage, res: ServerResponse, opts: RunApiOptions): Promise<void>`. The first two are exported for their own tests: the bearer check and the body cap are the module's two security decisions and neither is legible in an assertion about a 401 or a 413.
  - `findRunFor(db, input): Promise<{ id: string } | null>`; `readThreadFor(db, input): Promise<{ thread: ApiThread; messages: ApiMessage[] } | null>`.
  - `startRunApi(host: Host, opts: RunApiOptions): RunApiServer`.

- [ ] **Step 1: Write the failing Server-Sent Events test**

Create `harness/host/src/domain/api/sse.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sseStream } from './sse.js';

let server: Server;
let url = '';
/**
 * What `stream.open` read either side of `end()`, recorded by the `/open` handler because the
 * stream object itself lives inside the server and a test outside it can only see the bytes.
 */
let openAround: { before: boolean; after: boolean } | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    const stream = sseStream(res, { keepAliveMs: 0 });
    stream.send('run', { type: 'run', runId: 'r-1' });
    stream.comment('still here');
    if (req.url === '/withend') {
      stream.send('result', { type: 'result', status: 'done' });
      stream.end();
      // Everything after `end` is dropped rather than throwing on a finished response.
      stream.send('result', { type: 'result', status: 'done' });
    } else if (req.url === '/open') {
      const before = stream.open;
      stream.end();
      const after = stream.open;
      // Both kinds of write, after the close: neither may reach the body below.
      stream.send('dropped', { type: 'dropped' });
      stream.comment('dropped');
      openAround = { before, after };
    } else {
      stream.end();
    }
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('sseStream', () => {
  it('answers 202 with the event-stream headers a proxy will not buffer', async () => {
    const response = await fetch(`${url}/`);
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    expect(response.headers.get('cache-control')).toBe('no-cache');
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    await response.text();
  });

  it('writes one named frame per event, with the payload as one line of JSON', async () => {
    const body = await (await fetch(`${url}/withend`)).text();
    expect(body).toBe(
      'event: run\ndata: {"type":"run","runId":"r-1"}\n\n: still here\n\nevent: result\ndata: {"type":"result","status":"done"}\n\n',
    );
  });

  it('reports whether it is still open, and drops every write after it closes', async () => {
    const body = await (await fetch(`${url}/open`)).text();
    // `open` is the flag the run API's writer reads before it bothers to build a frame.
    expect(openAround).toEqual({ before: true, after: false });
    // And the drop is real, not just reported: the frame and the comment written after `end`
    // are absent, and nothing threw on a finished response.
    expect(body).toBe('event: run\ndata: {"type":"run","runId":"r-1"}\n\n: still here\n\n');
    expect(body).not.toContain('dropped');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/host exec vitest run src/domain/api/sse.test.ts`
Expected: FAIL — `./sse.js` does not exist.

- [ ] **Step 3: Write the constants and the stream**

Create `harness/host/src/domain/api/types.ts`:

```ts
import type { AddressInfo } from 'node:net';
import type { SchedulerStatus } from '../playbooks/scheduler.js';

/**
 * The run API's limits (spec 5.8, decision 19). Constants, not settings: every one of them is a
 * bound on what one request may cost this process, and a deployment that wanted a different one
 * would be a deployment that had found a use this API was not built for.
 */

/** One request body. Enforced while reading, so a caller cannot stream a gigabyte at the process. */
export const API_MAX_BODY_BYTES = 1_048_576;
/** One message. Longer than any human writes and shorter than a document, which belongs in `incoming/`. */
export const API_MAX_TEXT_CHARS = 10_000;
export const API_MAX_ATTACHMENTS = 10;
/** How many of a thread's **most recent** messages `GET /v1/threads/:id` returns, newest last. */
export const API_THREAD_MESSAGES = 200;
/**
 * How often an idle stream writes a comment line. A run can go minutes between events while a
 * model thinks, and an idle-timeout proxy in between would close the connection; a comment is two
 * bytes of nothing that keeps it open and that every Server-Sent Events client ignores.
 */
export const SSE_KEEPALIVE_MS = 15_000;

/** Loopback, as spec 5.8 says. Compose overrides it, for the reason `APPROVALS_HEALTH_BIND` is overridden. */
export const DEFAULT_HOST_BIND = '127.0.0.1';
export const DEFAULT_HOST_PORT = 8788;

export interface RunApiOptions {
  /** `HARNESS_HOST_TOKEN`. Never empty: with no token there is no API (decision 13). */
  token: string;
  bind?: string;
  port?: number;
  /** The scheduler, so `GET /v1/status` can report it. Absent in a test that starts none. */
  scheduler?: { status(): SchedulerStatus };
}

export interface RunApiServer {
  /** Resolves once the socket is bound; `address()` is null before that. */
  ready: Promise<void>;
  /** The bound address, so a caller can pass port 0 and discover what it got. */
  address(): AddressInfo | string | null;
  close(): Promise<void>;
}
```

Create `harness/host/src/domain/api/sse.ts`:

```ts
import type { ServerResponse } from 'node:http';
import { SSE_KEEPALIVE_MS } from './types.js';

export interface SseStream {
  /** False once `end` has run or the client hung up. Everything written after that is dropped. */
  readonly open: boolean;
  send(event: string, data: unknown): void;
  /** A comment line: ignored by every client, and what keeps an idle connection alive. */
  comment(text: string): void;
  end(): void;
}

/**
 * Server-Sent Events, by hand.
 *
 * The whole format is `event: <name>\ndata: <one line>\n\n`, with `: <text>\n\n` for a comment, so
 * a library would be a dependency for forty lines of string building. The payload is JSON on one
 * line, which is what makes that true: a multi-line payload would need a `data:` prefix per line.
 *
 * `202` because spec 5.8 says so: the run is accepted, and what follows is the run happening. The
 * three headers are the ones that stop something in between buffering the stream into a single
 * response — which is the failure mode that makes a streaming API look merely slow.
 *
 * The keep-alive timer is `unref`ed: an open stream must not be the reason a process will not
 * exit, and the shutdown path closes the connections anyway.
 */
export function sseStream(res: ServerResponse, opts: { keepAliveMs?: number } = {}): SseStream {
  res.writeHead(202, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    // nginx and friends buffer an unknown-length response by default, which turns a stream into
    // one delivery at the end.
    'x-accel-buffering': 'no',
  });
  let open = true;
  const keepAliveMs = opts.keepAliveMs ?? SSE_KEEPALIVE_MS;
  const timer =
    keepAliveMs > 0
      ? setInterval(() => {
          if (open) res.write(': keep-alive\n\n');
        }, keepAliveMs)
      : undefined;
  timer?.unref();
  const stop = (): void => {
    open = false;
    if (timer) clearInterval(timer);
  };
  res.on('close', stop);
  return {
    get open() {
      return open;
    },
    send(event, data) {
      if (!open) return;
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    },
    comment(text) {
      if (!open) return;
      res.write(`: ${text}\n\n`);
    },
    end() {
      if (!open) return;
      stop();
      res.end();
    },
  };
}
```

- [ ] **Step 4: Run the stream test to verify it passes**

Run: `pnpm --filter @harness/host exec vitest run src/domain/api/sse.test.ts`
Expected: PASS, three tests.

- [ ] **Step 5: Write the two reads the API needs**

Create `harness/host/src/domain/api/repository.ts`:

```ts
import { and, desc, eq } from 'drizzle-orm';
import { messages, runs, threads, type Db } from '@harness/db';
import { API_THREAD_MESSAGES } from './types.js';

export interface ApiThread {
  id: string;
  surface: string;
  conversation: string;
  kind: string;
  created_at: string;
  updated_at: string;
}

export interface ApiMessage {
  role: string;
  content: string;
  created_at: string;
}

/**
 * This run, if it is this client's and this principal's.
 *
 * Both halves of that are the point (decision 18): a run of another principal answers exactly what
 * a run that never existed answers, so the API never confirms that someone else's run is there.
 */
export async function findRunFor(
  db: Db,
  input: { client: string; principalId: string; runId: string },
): Promise<{ id: string } | null> {
  const [row] = await db
    .select({ id: runs.id })
    .from(runs)
    .where(and(eq(runs.id, input.runId), eq(runs.client, input.client), eq(runs.principalId, input.principalId)))
    .limit(1);
  return row ?? null;
}

/**
 * This thread and its most recent messages, **newest last**, if it is this client's and this
 * principal's.
 *
 * Read newest-first under the limit and then reversed, which is the only way to take the *tail* of
 * a long thread: `ORDER BY … ASC LIMIT 200` would hand back the two hundred oldest messages, so a
 * caller reading a thread that had run for a month would see how it started and never how it was
 * going. The caller wants the recent end, and gets it in reading order.
 *
 * Ordered by `(created_at, seq)`: two rows written by one transaction carry one timestamp, and
 * `seq` is the tiebreak the whole codebase orders by since Plan 9.
 */
export async function readThreadFor(
  db: Db,
  input: { client: string; principalId: string; threadId: string },
): Promise<{ thread: ApiThread; messages: ApiMessage[] } | null> {
  const [thread] = await db
    .select()
    .from(threads)
    .where(
      and(
        eq(threads.id, input.threadId),
        eq(threads.client, input.client),
        eq(threads.principalId, input.principalId),
      ),
    )
    .limit(1);
  if (!thread) return null;
  const newestFirst = await db
    .select({ role: messages.role, content: messages.content, createdAt: messages.createdAt })
    .from(messages)
    .where(eq(messages.threadId, thread.id))
    .orderBy(desc(messages.createdAt), desc(messages.seq))
    .limit(API_THREAD_MESSAGES);
  const rows = newestFirst.reverse();
  return {
    thread: {
      id: thread.id,
      surface: thread.surface,
      conversation: thread.conversation,
      kind: thread.kind,
      created_at: thread.createdAt.toISOString(),
      updated_at: thread.updatedAt.toISOString(),
    },
    messages: rows.map((row) => ({
      role: row.role,
      content: row.content,
      created_at: row.createdAt.toISOString(),
    })),
  };
}
```

- [ ] **Step 6: Write the routes**

Create `harness/host/src/domain/api/routes.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';
import * as z from 'zod/v4';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Principal } from '@harness/identity-api';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN, assertInsideRoot } from '@harness/shared';
import { cancelRun, runTurn, serialize, type TurnEvent } from '../conversation.js';
import type { Host } from '../host.js';
import { WITHHELD, findOrCreateThread } from '../threads/repository.js';
import { findRunFor, readThreadFor } from './repository.js';
import { sseStream } from './sse.js';
import { API_MAX_ATTACHMENTS, API_MAX_BODY_BYTES, API_MAX_TEXT_CHARS, type RunApiOptions } from './types.js';

/** A uuid, checked before it reaches Postgres: an id of any other shape is "no such thing", not an error. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const OpenRunShape = z
  .object({
    surface: z.string().regex(SURFACE_NAME_PATTERN, 'a surface name is lowercase letters, digits and hyphens'),
    conversation: z.string().regex(CONVERSATION_ID_PATTERN, 'a conversation id carries no spaces or control characters'),
    userId: z.string().min(1).max(200),
    text: z.string().min(1).max(API_MAX_TEXT_CHARS),
    attachments: z
      .array(z.object({ name: z.string().min(1).max(255), path: z.string().min(1).max(512) }).strict())
      .max(API_MAX_ATTACHMENTS)
      .default([]),
  })
  .strict();

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * Constant-time on the bytes, after a length check.
 *
 * `timingSafeEqual` throws on a length mismatch, and comparing lengths first leaks only the
 * token's length, which a caller who can measure a comparison could learn anyway.
 */
export function bearerOk(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const offered = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** Read the body, refusing past the cap while it arrives rather than after. */
export async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > API_MAX_BODY_BYTES) {
        req.destroy();
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false }));
  });
}

type Caller = { ok: true; principal: Principal } | { ok: false; status: number; error: string };

/**
 * Who is asking, resolved exactly as it would be for an adapter's message (spec 5.8, invariant 1).
 *
 * The bearer token says the *caller* may use this API; it does not say who they are acting as.
 * That is the identity plug-in's answer, from a surface and that surface's own user id, so nothing
 * a caller sends can name a principal directly.
 */
async function callerOf(host: Host, ref: { surface: string; userId: string }): Promise<Caller> {
  if (!SURFACE_NAME_PATTERN.test(ref.surface) || ref.userId === '') {
    return { ok: false, status: 400, error: 'surface and userId are required' };
  }
  if (!host.surfaces.find(ref.surface)) {
    return { ok: false, status: 400, error: `surface "${ref.surface}" is not loaded` };
  }
  const principal = await host.identity.resolve(ref);
  if (!principal) {
    return { ok: false, status: 403, error: 'that surface user is not a principal of this deployment' };
  }
  return { ok: true, principal };
}

/**
 * Open a run and stream it (spec 5.8).
 *
 * `deliver: 'none'` (decision 14): the reply is recorded on the thread and posted nowhere, because
 * the caller is the one waiting for it and putting the same answer into the named surface's
 * conversation would be a message nobody there asked for. The stream is the reply.
 *
 * Every text-carrying frame goes through the restricted-pattern check on its way out (invariant
 * 10). A delta is checked on its own, so a pattern split across two deltas is caught only by the
 * closing `result` frame, which carries the whole reply already withheld — the same guarantee a
 * streamed surface reply has today.
 */
async function openRunRoute(host: Host, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  if (!body.ok) return json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` });
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return json(res, 400, { error: 'the request body is not JSON' });
  }
  const parsed = OpenRunShape.safeParse(raw);
  if (!parsed.success) return json(res, 400, { error: z.prettifyError(parsed.error) });
  const input = parsed.data;

  const caller = await callerOf(host, { surface: input.surface, userId: input.userId });
  if (!caller.ok) return json(res, caller.status, { error: caller.error });

  // An attachment is a path under the storage root, not bytes: the same contract an adapter's
  // `MessageEvent` carries. Checked before a run opens, so nothing is audited against a path that
  // was never acceptable.
  const incoming = path.join(host.config.storageDir, 'incoming');
  for (const attachment of input.attachments) {
    try {
      await assertInsideRoot(
        attachment.path,
        incoming,
        () => {
          throw new Error('outside');
        },
        { allowRoot: false },
      );
    } catch {
      return json(res, 400, { error: `attachment "${attachment.name}" is not a path inside the incoming directory` });
    }
  }

  const thread = await findOrCreateThread(host.db, {
    client: host.client,
    surface: input.surface,
    conversation: input.conversation,
    principalId: caller.principal.id,
  });

  const stream = sseStream(res);
  const safe = (text: string): string => (containsRestrictedPattern(text) ? WITHHELD : text);
  const observe = (event: TurnEvent): void => {
    if (event.type === 'text') stream.send('text', { type: 'text', delta: safe(event.delta) });
    else if (event.type === 'done') stream.send('done', { type: 'done', text: safe(event.text) });
    else stream.send(event.type, event);
  };

  try {
    // The same chain an adapter's message takes, so two requests on one conversation run one after
    // the other rather than over each other (decision 19).
    const result = await serialize(host, thread.id, () =>
      runTurn(host, {
        thread,
        principal: caller.principal,
        role: 'user',
        text: input.text,
        attachments: input.attachments,
        replyTo: null,
        deliver: 'none',
        observe,
      }),
    );
    if (result === undefined) {
      stream.send('error', { type: 'error', message: 'the host is shutting down; the run was not started' });
    }
  } catch (err) {
    host.log.error(`the run API failed a turn on thread ${thread.id}`, err);
    stream.send('error', { type: 'error', message: 'the run failed; see the host log' });
  } finally {
    stream.end();
  }
}

/** Cancel a run of the caller's own (spec 5.8). Another principal's run is "no such run" (decision 18). */
async function cancelRoute(host: Host, url: URL, res: ServerResponse, runId: string): Promise<void> {
  const caller = await callerOf(host, {
    surface: url.searchParams.get('surface') ?? '',
    userId: url.searchParams.get('userId') ?? '',
  });
  if (!caller.ok) return json(res, caller.status, { error: caller.error });
  if (!UUID.test(runId)) return json(res, 404, { error: 'no such run' });
  const run = await findRunFor(host.db, { client: host.client, principalId: caller.principal.id, runId });
  if (!run) return json(res, 404, { error: 'no such run' });
  // False when the run has already ended or was already aborted — by the host's own timeout, say.
  // That is an answer, not an error: the caller asked for it to stop and it is stopped.
  return json(res, 200, { run_id: runId, cancelled: cancelRun(host, runId) });
}

/** A thread of the caller's own, most recent messages, newest last (spec 5.8). */
async function threadRoute(host: Host, url: URL, res: ServerResponse, threadId: string): Promise<void> {
  const caller = await callerOf(host, {
    surface: url.searchParams.get('surface') ?? '',
    userId: url.searchParams.get('userId') ?? '',
  });
  if (!caller.ok) return json(res, caller.status, { error: caller.error });
  if (!UUID.test(threadId)) return json(res, 404, { error: 'no such thread' });
  const found = await readThreadFor(host.db, {
    client: host.client,
    principalId: caller.principal.id,
    threadId,
  });
  if (!found) return json(res, 404, { error: 'no such thread' });
  return json(res, 200, found);
}

/**
 * What this process is doing (decision 16): the surfaces it loaded, the runs in flight, and the
 * scheduler's own status, which had nowhere to be reported until this route existed.
 *
 * Counts and names only, never a conversation, a principal or a message — the same rule `/healthz`
 * follows, and for the same reason.
 */
function statusRoute(host: Host, res: ServerResponse, opts: RunApiOptions): void {
  json(res, 200, {
    client: host.client,
    surfaces: host.surfaces.all.map((session) => session.name),
    primary_surface: host.surfaces.primary.name,
    runs_in_flight: host.active.size,
    draining: host.draining,
    scheduler: opts.scheduler?.status() ?? null,
  });
}

/** Route one request. Every route is behind the bearer check, including the status one. */
export async function handleApiRequest(
  host: Host,
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunApiOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://run-api.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (!bearerOk(req.headers.authorization, opts.token)) return json(res, 401, { error: 'unauthorised' });
  if (req.method === 'GET' && route === '/v1/status') return statusRoute(host, res, opts);
  if (req.method === 'POST' && route === '/v1/runs') return openRunRoute(host, req, res);
  const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(route);
  if (req.method === 'POST' && cancel) return cancelRoute(host, url, res, cancel[1]);
  const thread = /^\/v1\/threads\/([^/]+)$/.exec(route);
  if (req.method === 'GET' && thread) return threadRoute(host, url, res, thread[1]);
  return json(res, 404, { error: 'no such route' });
}
```

Create `harness/host/src/domain/api/server.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { Host } from '../host.js';
import { handleApiRequest } from './routes.js';
import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT, type RunApiOptions, type RunApiServer } from './types.js';

/**
 * The run API's listener (spec 5.8).
 *
 * Shaped like `startHealthServer`, and for the same reasons: `ready` resolves on `'listening'` so a
 * test can bind port 0 and read back what it got, and a bind failure still surfaces as the
 * server's own `'error'` event rather than a rejection nobody handled.
 *
 * `close` closes the open connections first. A Server-Sent Events response is open by design, so a
 * plain `close()` would wait for every listening caller to hang up — and shutdown calls this
 * *before* the drain, so nothing new is accepted while the turns in flight unwind.
 */
export function startRunApi(host: Host, opts: RunApiOptions): RunApiServer {
  const server: Server = createServer((req, res) => {
    void handleApiRequest(host, req, res, opts).catch((err: unknown) => {
      // A fixed body. Anything thrown this far is a driver, filesystem or socket error, and those
      // carry fragments of a statement or a path; the detail goes to the log, where an operator
      // can read it.
      host.log.error('the run API failed a request', err);
      if (res.headersSent) res.end();
      else {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end('{"error":"the request failed"}');
      }
    });
  });
  const ready = new Promise<void>((resolve) => server.once('listening', () => resolve()));
  server.listen(opts.port ?? DEFAULT_HOST_PORT, opts.bind ?? DEFAULT_HOST_BIND);
  return {
    ready,
    address: () => server.address(),
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
```

- [ ] **Step 7: Write the failing tests — the two helpers, then the whole API**

The bearer check and the body cap are the two pieces of this module that are worth failing on
their own: one decides whether a stranger gets in, the other whether a stranger can make this
process hold a gigabyte, and neither is legible in an end-to-end assertion about a 401 or a 413.

Create `harness/host/src/domain/api/routes.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { bearerOk, readBody } from './routes.js';
import { API_MAX_BODY_BYTES } from './types.js';

describe('bearerOk', () => {
  it('accepts the exact token and nothing else', () => {
    expect(bearerOk('Bearer sk-right', 'sk-right')).toBe(true);
    expect(bearerOk('Bearer sk-wrong', 'sk-right')).toBe(false);
    // A prefix and a suffix both answer false rather than throwing: `timingSafeEqual` rejects a
    // length mismatch, which is why the length is compared before it is called.
    expect(bearerOk('Bearer sk-righ', 'sk-right')).toBe(false);
    expect(bearerOk('Bearer sk-righty', 'sk-right')).toBe(false);
  });

  it('refuses a missing header, an empty one, and every other scheme', () => {
    // `bearer` lowercase is refused too. The scheme is case-insensitive in the HTTP standard and
    // strict here on purpose: this is one deployment's own control plane, the runbook shows the
    // exact header, and a spelling nobody documented is likelier a broken client than a caller.
    for (const header of [undefined, '', 'sk-right', 'bearer sk-right', 'Basic sk-right', 'Bearer']) {
      expect(bearerOk(header, 'sk-right'), String(header)).toBe(false);
    }
  });
});

type Body = Awaited<ReturnType<typeof readBody>>;

let server: Server;
let url = '';
let deliver: ((body: Body) => void) | null = null;

beforeAll(async () => {
  server = createServer((req, res) => {
    void readBody(req).then((body) => {
      deliver?.(body);
      try {
        res.writeHead(200).end();
      } catch {
        // The cap destroyed the socket before the handler could answer, which is the point of it.
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

/** POST a body and hand back what `readBody` made of it, whether or not the request survived. */
async function sent(body: string): Promise<Body> {
  const read = new Promise<Body>((resolve) => {
    deliver = resolve;
  });
  await fetch(url, { method: 'POST', body }).catch(() => undefined);
  return read;
}

describe('readBody', () => {
  it('reads a whole body, over however many chunks it arrives in', async () => {
    expect(await sent('{"text":"hello"}')).toEqual({ ok: true, text: '{"text":"hello"}' });
    // Comfortably more than one TCP segment, so the `data` handler really is accumulating.
    const long = JSON.stringify({ text: 'y'.repeat(200_000) });
    expect(await sent(long)).toEqual({ ok: true, text: long });
  });

  it('reads an empty body as an empty string, which is a 400 upstream and not a 413', async () => {
    expect(await sent('')).toEqual({ ok: true, text: '' });
  });

  it('refuses a body past the cap while it is still arriving, rather than after', async () => {
    expect(await sent('y'.repeat(API_MAX_BODY_BYTES + 1_024))).toEqual({ ok: false });
  });
});
```

Then create `harness/host/src/domain/api/server.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { messages, threads } from '@harness/db';
import { COORDINATOR, MEMBER, hostFixture, useTestDb, type HostFixture } from '../../testing.js';
import type { Trajectory } from '@harness/runtime-api/testing';
import { startRunApi } from './server.js';
import { API_MAX_BODY_BYTES } from './types.js';

const db = useTestDb();
const TOKEN = 'sk-run-api-test';

interface Api {
  f: HostFixture;
  url: string;
  open(body: unknown, token?: string): Promise<Response>;
  get(path: string, token?: string): Promise<Response>;
  post(path: string, token?: string): Promise<Response>;
}

async function api(trajectory: Trajectory): Promise<Api> {
  const f = await hostFixture(db, { trajectory });
  const server = startRunApi(f.host, { token: TOKEN, bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  const auth = (token = TOKEN): Record<string, string> => ({ authorization: `Bearer ${token}` });
  return {
    f,
    url,
    open: (body, token) =>
      fetch(`${url}/v1/runs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...auth(token) },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      }),
    get: (p, token) => fetch(`${url}${p}`, { headers: auth(token) }),
    post: (p, token) => fetch(`${url}${p}`, { method: 'POST', headers: auth(token) }),
  };
}

/** Frames as they arrive, so a test can act while the run is still in flight. */
async function* frames(response: Response): AsyncGenerator<{ event: string; data: Record<string, unknown> }> {
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true });
    let end = buffer.indexOf('\n\n');
    while (end !== -1) {
      const frame = buffer.slice(0, end);
      buffer = buffer.slice(end + 2);
      const name = /^event: (.+)$/m.exec(frame);
      const data = /^data: (.+)$/m.exec(frame);
      if (name && data) yield { event: name[1], data: JSON.parse(data[1]) as Record<string, unknown> };
      end = buffer.indexOf('\n\n');
    }
  }
}

const collect = async (response: Response): Promise<{ event: string; data: Record<string, unknown> }[]> => {
  const all: { event: string; data: Record<string, unknown> }[] = [];
  for await (const frame of frames(response)) all.push(frame);
  return all;
};

/** The body a run is opened with: the coordinator, on the memory surface, in one conversation. */
const asCoordinator = (text: string): Record<string, unknown> => ({
  surface: 'memory',
  userId: COORDINATOR.surfaces.memory,
  conversation: 'memory',
  text,
});

describe('the run API: authorisation', () => {
  it('refuses every route without a token, and with the wrong one', async () => {
    const a = await api([]);
    for (const response of [
      await fetch(`${a.url}/v1/status`),
      await a.get('/v1/status', 'sk-wrong'),
      await a.open(asCoordinator('hello'), 'sk-wrong'),
    ]) {
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({ error: 'unauthorised' });
    }
  });

  it('refuses a surface user the identity plug-in does not know, without saying who does exist', async () => {
    const a = await api([]);
    const response = await a.open({ ...asCoordinator('hello'), userId: 'U-nobody' });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'that surface user is not a principal of this deployment' });
  });

  it('refuses a surface that is not loaded, and a body that is not the shape', async () => {
    const a = await api([]);
    expect((await a.open({ ...asCoordinator('hello'), surface: 'nowhere' })).status).toBe(400);
    expect((await a.open({ surface: 'memory', userId: 'U012' })).status).toBe(400);
    expect((await a.open('not json')).status).toBe(400);
  });

  it('refuses a body over the cap', async () => {
    const a = await api([]);
    const huge = await a.open({ ...asCoordinator('x'), text: 'y'.repeat(API_MAX_BODY_BYTES + 10) });
    expect(huge.status).toBe(413);
  });

  it('refuses an attachment path that leaves the incoming directory', async () => {
    const a = await api([]);
    const escaping = await a.open({
      ...asCoordinator('here is a file'),
      attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
    });
    expect(escaping.status).toBe(400);
    expect(await escaping.json()).toEqual({
      error: 'attachment "passwd" is not a path inside the incoming directory',
    });
  });
});

describe('the run API: a run', () => {
  it('streams the run id, the runtime events and the outcome, and records the turn on a thread', async () => {
    const a = await api([{ tool: 'audit_query', args: {} }, { say: 'nothing is overdue' }]);
    const response = await a.open(asCoordinator('anything overdue?'));
    expect(response.status).toBe(202);
    expect(response.headers.get('content-type')).toBe('text/event-stream');

    const all = await collect(response);
    expect(all[0].event).toBe('run');
    expect(typeof all[0].data.runId).toBe('string');
    expect(all.map((f) => f.event)).toEqual(['run', 'tool_call', 'tool_result', 'text', 'done', 'result']);
    expect(all.at(-1)!.data).toMatchObject({ status: 'done', text: 'nothing is overdue', error: null });

    // Recorded on a thread of its own, and posted to no surface: the stream is the reply.
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));
    expect(thread).toMatchObject({ surface: 'memory', conversation: 'memory', kind: 'chat' });
    const rows = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(rows.map((r) => r.role)).toEqual(['user', 'assistant']);
    expect(a.f.surface.texts).toEqual([]);
  });

  it('cancels a run in flight, by the id the first frame carried', async () => {
    const a = await api([{ sleep: 200 }, { say: 'too late' }]);
    const response = await a.open(asCoordinator('start something slow'));
    const seen: { event: string; data: Record<string, unknown> }[] = [];
    let runId = '';
    for await (const frame of frames(response)) {
      seen.push(frame);
      if (frame.event === 'run') {
        runId = frame.data.runId as string;
        const cancelled = await a.post(
          `/v1/runs/${runId}/cancel?surface=memory&userId=${COORDINATOR.surfaces.memory}`,
        );
        expect(cancelled.status).toBe(200);
        expect(await cancelled.json()).toEqual({ run_id: runId, cancelled: true });
      }
    }
    expect(seen.at(-1)).toMatchObject({ event: 'result', data: { status: 'cancelled', error: 'cancelled' } });
  });

  it("answers 'no such run' for another principal's run, and for a malformed id", async () => {
    const a = await api([{ say: 'done' }]);
    const opened = await collect(await a.open(asCoordinator('hello')));
    const runId = opened[0].data.runId as string;
    const asMember = await a.post(`/v1/runs/${runId}/cancel?surface=memory&userId=${MEMBER.surfaces.memory}`);
    expect(asMember.status).toBe(404);
    expect(await asMember.json()).toEqual({ error: 'no such run' });
    expect((await a.post(`/v1/runs/not-a-uuid/cancel?surface=memory&userId=${COORDINATOR.surfaces.memory}`)).status).toBe(404);
  });
});

describe('the run API: a thread and the status', () => {
  it("reads back the caller's own thread, newest message last", async () => {
    const a = await api([{ say: 'nothing is overdue' }]);
    await collect(await a.open(asCoordinator('anything overdue?')));
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));

    const response = await a.get(`/v1/threads/${thread.id}?surface=memory&userId=${COORDINATOR.surfaces.memory}`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      thread: { id: string; surface: string; conversation: string; kind: string };
      messages: { role: string; content: string }[];
    };
    expect(body.thread).toMatchObject({ id: thread.id, surface: 'memory', conversation: 'memory', kind: 'chat' });
    expect(body.messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'anything overdue?'],
      ['assistant', 'nothing is overdue'],
    ]);
  });

  it("answers 'no such thread' for another principal's thread, never 403", async () => {
    const a = await api([{ say: 'done' }]);
    await collect(await a.open(asCoordinator('hello')));
    const [thread] = await db.select().from(threads).where(eq(threads.principalId, COORDINATOR.id));
    const response = await a.get(`/v1/threads/${thread.id}?surface=memory&userId=${MEMBER.surfaces.memory}`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such thread' });
  });

  it('reports the surfaces, the runs in flight and the scheduler, and nothing about anyone', async () => {
    const a = await api([]);
    const response = await a.get('/v1/status');
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      client: 'test',
      surfaces: ['memory'],
      primary_surface: 'memory',
      runs_in_flight: 0,
      draining: false,
      scheduler: null,
    });
  });

  it('answers "no such route" for anything else', async () => {
    const a = await api([]);
    expect((await a.get('/v1/nothing')).status).toBe(404);
    expect((await a.get('/')).status).toBe(404);
  });
});
```

- [ ] **Step 8: Run them to verify they fail, then pass**

Run: `pnpm --filter @harness/host exec vitest run src/domain/api/routes.test.ts src/domain/api/server.test.ts`
Expected: FAIL first (the modules did not exist when the tests were written), then PASS once Step 6's files are in place — **seventeen** tests: five in `routes.test.ts` (two `bearerOk`, three `readBody`) and twelve in `server.test.ts` (five authorisation, three run, four thread and status). If the cancel test is flaky, it is because the runtime's `sleep` step is shorter than the round trip; raise the step to 200 ms, which is the ceiling this plan allows, and no higher.

- [ ] **Step 9: Start it from the composition root**

In `harness/host/src/index.ts`, add:

```ts
export {
  API_MAX_ATTACHMENTS,
  API_MAX_BODY_BYTES,
  API_MAX_TEXT_CHARS,
  API_THREAD_MESSAGES,
  DEFAULT_HOST_BIND,
  DEFAULT_HOST_PORT,
  SSE_KEEPALIVE_MS,
  type RunApiOptions,
  type RunApiServer,
} from './domain/api/types.js';
export { startRunApi } from './domain/api/server.js';
export { bearerOk, handleApiRequest } from './domain/api/routes.js';
```

In `harness/host/src/app/main.ts`, add `import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT } from '../domain/api/types.js';` and `import { startRunApi } from '../domain/api/server.js';`, add `optionalEnv` to the `@harness/shared` import, and add after the `startHealthServer(...)` block:

```ts
// The run API (spec 5.8). No token, no listener: a control plane that opened a socket with no
// bearer secret because a variable was missing is the failure this avoids (decision 13). The
// scheduler's handle goes in so `GET /v1/status` can report it, which is the one place that
// status is reachable from.
const hostToken = (optionalEnv('HARNESS_HOST_TOKEN') ?? '').trim();
const runApi =
  hostToken === ''
    ? null
    : startRunApi(host, {
        token: hostToken,
        bind: envOrDefault('HARNESS_HOST_BIND', DEFAULT_HOST_BIND),
        port: port('HARNESS_HOST_PORT', DEFAULT_HOST_PORT),
        scheduler,
      });
if (runApi) await runApi.ready;
```

and extend the `log.info('listening (…)')` line's template with `, runApi=${runApi ? 'on' : 'off (set HARNESS_HOST_TOKEN)'}` before the closing parenthesis.

In `shutdown`, add immediately after `const schedulerStopped = scheduler.stop();`:

```ts
    // Before the drain: nothing new is accepted while the turns in flight unwind, and the open
    // event streams are closed rather than holding the shutdown for as long as a caller listens.
    await runApi?.close();
```

- [ ] **Step 10: Document the three variables**

In `.env.example`, after the `HARNESS_HISTORY_MAX_MESSAGES` block and before the Knowledge block added in Task 2, add:

```
# --- Run API (spec 5.8) -------------------------------------------------------
# An HTTP way to open a run, stream its events, cancel it and read a thread back.
# It is OFF unless HARNESS_HOST_TOKEN is set: a control plane must not open a
# socket with no credential because a variable was missing. Generate one with:
#   openssl rand -hex 24
# Every route wants `Authorization: Bearer <this>`. Who a run acts as is still the
# identity plug-in's answer, from the `surface` and `userId` the request names.
#HARNESS_HOST_TOKEN=

# Interface the API binds. Loopback by default. Inside Compose it is 0.0.0.0 for
# the reason APPROVALS_HEALTH_BIND is: a container-loopback listener answers no
# published port. Exposure is the Compose port mapping, which is loopback-only.
#HARNESS_HOST_BIND=127.0.0.1

# Port the API listens on inside the process.
#HARNESS_HOST_PORT=8788

# Host-side port Compose publishes the API on (127.0.0.1:<this>:8788). Read by
# Compose only, never by the code. Change it if 8788 is taken on your machine.
#HARNESS_HOST_PUBLISHED_PORT=8788

# A caller of the API names a loaded surface and that surface's own user id, so
# add @harness/surface-http to HARNESS_SURFACES — after your primary surface,
# never first — and give each caller an `http:` entry in identity.yaml.
```

- [ ] **Step 11: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. The environment scan in `harness/core-tools/src/app/surface.test.ts` now finds `HARNESS_HOST_TOKEN`, `HARNESS_HOST_BIND` and `HARNESS_HOST_PORT`, and `.env.example` documents all three, so it passes with no change to that test. `git status --short docs/architecture` prints nothing: Compose has not moved yet.

- [ ] **Step 12: Commit**

```bash
git add harness/host/src/domain/api harness/host/src/app/main.ts harness/host/src/index.ts .env.example
git commit -m "feat(host): serve the run API over HTTP, streaming a run's events and cancelling it"
```

(`harness/host/src/domain/api` is the whole directory, so `routes.test.ts` and `server.test.ts` go with it.)

---

### Task 10: Compose, the demo client's knowledge folder, the sync playbook and the scaffolder

**Files:**
- Modify: `harness/compose/docker-compose.yml` (the `host` service)
- Modify: `docs/architecture/compose-surface.yaml` (re-recorded)
- Create: `harness/host/skills/knowledge-sync/SKILL.md`
- Modify: `harness/host/src/domain/skills.ts`, `harness/host/src/app/main.ts`, `harness/host/src/index.ts`
- Test: `harness/host/src/domain/skills.test.ts`
- Test: `harness/host/src/domain/playbooks/preflight.test.ts` (the shipped demo playbook is now two, and one of them names a kernel skill)
- Create: `clients/demo-practice/knowledge/front-desk.md`, `clients/demo-practice/knowledge/escalation-and-billing.md`
- Test: `harness/core-tools/src/domain/knowledge/shipped-documents.test.ts` (new — the shipped demo documents, parsed)
- Modify: `clients/demo-practice/playbooks.yaml`, `clients/demo-practice/identity.yaml`, `clients/demo-practice/SOUL.md`
- Modify: `scripts/src/domain/scaffold.ts`
- Test: `scripts/src/domain/scaffold.test.ts`

**Interfaces:**
- Consumes: `readSkillCatalogue(dirs)`; `newClient(opts)`.
- Produces: `kernelSkillsDir(): string` from `harness/host/src/domain/skills.js`; `TEMPLATE_DIRS = ['knowledge']` in the scaffolder; the `knowledge-sync` skill (`version: 1.0.0`).

- [ ] **Step 1: Write the failing kernel-skill test**

Append to `harness/host/src/domain/skills.test.ts`, inside its outermost `describe`:

```ts
  it('reads the one skill the host itself ships, beside the packs’', async () => {
    const skills = await readSkillCatalogue([kernelSkillsDir()]);
    expect(skills.map((s) => s.name)).toEqual(['knowledge-sync']);
    expect(skills[0]).toMatchObject({ version: '1.0.0' });
    expect(skills[0].description).toContain('knowledge');
  });
```

with `kernelSkillsDir` added to the import from `./skills.js`.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/host exec vitest run src/domain/skills.test.ts`
Expected: FAIL — `kernelSkillsDir` is not exported.

- [ ] **Step 3: Ship the kernel skill**

Create `harness/host/skills/knowledge-sync/SKILL.md`:

```markdown
---
name: knowledge-sync
description: Refresh the knowledge base from this deployment's knowledge folder and report only what needs a human.
version: 1.0.0
---

# Refresh the knowledge base

Call `knowledge_sync` once. It re-reads the deployment's knowledge folder: documents that are new
or have changed are indexed again, and a document whose file is gone stops being searchable.

Then decide whether a human needs to hear about it.

- If `skipped` is empty, reply with the single line `Nothing to report.` and call nothing else. A
  routine refresh is not news.
- If `skipped` is not empty, stage one notice with `harness_notify` listing each skipped path and
  its reason, one per line, and then reply with the single line `Nothing to report.` A skipped
  document is a file somebody has to edit, and it will be skipped again tomorrow until they do.

Report nothing else, call no other tool, and never quote the contents of a document.
```

In `harness/host/src/domain/skills.ts`, add `import { fileURLToPath } from 'node:url';` (and `path`, if it is not already imported) and, above `readSkillCatalogue`:

```ts
// src/domain -> src -> the package root. `skills/` sits beside `src/`, so it ships in the image
// (node.Dockerfile copies the whole `harness` tree) without being compiled.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The skills the kernel itself ships, as opposed to a pack's.
 *
 * Exactly one today: `knowledge-sync`, which the knowledge sync playbook names. It cannot live in
 * a pack — refreshing a knowledge base is not a product area's business, and a deployment that
 * loaded a different pack would lose it — and `preflightPlaybook` requires a playbook's skill to
 * be one the host offers, so the host has to offer it. A second one belongs here too; a third
 * probably means this directory wants its own reason for existing, written down.
 */
export function kernelSkillsDir(): string {
  return path.join(packageRoot, 'skills');
}
```

In `harness/host/src/app/main.ts`, change the host's `skills:` line to:

```ts
  // The kernel's own skills first, then every pack's, so a pack cannot shadow one by name: the
  // catalogue is built in directory order and `readSkillCatalogue` refuses a duplicate directory
  // name within one directory, not across two.
  skills: await readSkillCatalogue([kernelSkillsDir(), ...config.packs.skillsDirs()]),
```

and add `kernelSkillsDir` to the import from `../domain/skills.js`. Add it to `harness/host/src/index.ts`'s `./domain/skills.js` export line as well.

- [ ] **Step 4: Run the skills test to verify it passes**

Run: `pnpm --filter @harness/host exec vitest run src/domain/skills.test.ts`
Expected: PASS.

- [ ] **Step 5: Give the demo client a knowledge folder**

Create `clients/demo-practice/knowledge/front-desk.md`:

```markdown
---
title: Front desk hours and messages
min_level: member
---

# Front desk hours and messages

The front desk answers the telephone from eight in the morning until five in the afternoon,
Monday to Friday, and takes messages outside those hours. A message left after five is returned
the next working day before noon.

Anyone in the practice may be told these hours. They are on the practice website and on the
recorded greeting, so there is nothing here a caller could not already learn.

Holidays follow the state calendar. The desk is closed on a public holiday and the recorded
greeting says when it reopens; nobody is asked to cover a holiday without being told a week
beforehand.
```

Create `clients/demo-practice/knowledge/escalation-and-billing.md`:

```markdown
---
title: Escalation and billing review
min_level: lead
principals: [u-practice-manager]
---

# Escalation and billing review

An urgent matter goes to the duty lead by telephone, never by message, and the duty lead decides
whether it waits until the next working day. "Urgent" means a patient is affected today or a
deadline passes today; everything else is ordinary work and goes in the queue.

Billing rates are reviewed by the finance committee every quarter. The review is minuted and the
minutes are circulated to the leads, who are the only people expected to answer questions about a
rate. Do not quote a rate to anyone who has not asked through a lead.

This document is for a lead and above. The practice manager is named on it explicitly, which
changes nothing for them today and keeps working if the level rules are ever loosened.
```

- [ ] **Step 6: Schedule the sync, and give the two people an API identity**

In `clients/demo-practice/playbooks.yaml`, append a second entry:

```yaml
  # Re-read clients/demo-practice/knowledge/ into the knowledge base, before the practice opens.
  # It runs as the same service principal and delivers nothing: a routine refresh is not news, and
  # the skill stages a notice only when a document was skipped.
  - name: knowledge-sync
    schedule: '30 6 * * *'
    timezone: America/New_York
    skill: knowledge-sync
    prompt: Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.
    principal: svc-playbooks
    deliver: none
    cost_cap_usd: 0.5
    timeout_s: 300
```

In `clients/demo-practice/identity.yaml`, add an `http` entry to the two people, and one sentence to the file's comment:

```yaml
  - id: u-practice-manager
    kind: user
    level: admin
    displayName: Practice manager
    surfaces:
      slack: U0123ABCD
      http: practice-manager
  - id: u-coordinator
    kind: user
    level: lead
    displayName: Credentialing coordinator
    surfaces:
      slack: U0456EFGH
      http: coordinator
```

The comment gains:

```
# An `http:` entry is the id that principal is named by over the run API (docs/runbook.md, "The
# run API"): any stable string, because the API resolves it here exactly as it resolves a Slack
# member id. A principal with no `http:` entry cannot drive a run over the API, which is the
# right default.
```

- [ ] **Step 6a: Teach the shipped-playbook test that there are now two**

`harness/host/src/domain/playbooks/preflight.test.ts` already proves the demo's `playbooks.yaml`
against the real identity and the real skills, in `describe('the shipped demo playbook (I1)')`. It
asserts `expect(playbooks).toHaveLength(1)` and loads skills from the packs alone, so step 6 breaks
it twice over: there are two playbooks now, and the second names a skill no pack ships. Replace the
body of that `it` with a loop over both:

```ts
  it('are valid entries, and pass preflight against the shipped skills and identity', async () => {
    const { playbooks } = await readPlaybooksFile(demoClientDir);
    expect(playbooks.map((p) => p.name)).toEqual(['credentialing-expirations', 'knowledge-sync']);
    for (const playbook of playbooks) {
      expect(playbook).toMatchObject({
        timezone: 'America/New_York',
        principal: 'svc-playbooks',
        deliver: 'none',
        cost_cap_usd: 0.5,
        timeout_s: 300,
      });
    }

    const f = await hostFixture(db, { trajectory: [] });
    // Identity, loaded the way main.ts loads it: the static plug-in over the demo's own file.
    f.host.identity = await loadIdentity('@harness/identity-static', {
      env: {},
      log: f.host.log,
      clientDir: demoClientDir,
    });
    // Skills, loaded the way main.ts loads them — the kernel's own directory first, then the
    // shipped pack's. `knowledge-sync` lives in the first and `credentialing-expirations` in the
    // second, so a catalogue built from either alone would fail one of these two playbooks.
    f.host.skills = await readSkillCatalogue([kernelSkillsDir(), ...testKernelConfig(db).packs.skillsDirs()]);

    for (const playbook of playbooks) {
      const result = await preflightPlaybook(
        f.host,
        row({
          name: playbook.name,
          skill: playbook.skill,
          principalId: playbook.principal,
          surface: playbook.surface ?? null,
          costCapUsd: playbook.cost_cap_usd,
        }),
      );
      expect(result, playbook.name).toMatchObject({ ok: true });
    }
  });
```

Rename the `describe` to `'the shipped demo playbooks (I1)'` and add `kernelSkillsDir` to that
file's import from `../skills.js`.

- [ ] **Step 6b: Prove the shipped knowledge documents, the way the shipped playbook is proved**

Spec section 10's exit criterion for this plan names `clients/demo-practice/knowledge/` by path.
Task 6's tool tests use a `mkdtemp` folder, so without this nothing reads the documents that
actually ship, and a typo in one of their frontmatter blocks would first be noticed by a person
demonstrating the product. This is the same move Plan 9 made for `playbooks.yaml`.

Create `harness/core-tools/src/domain/knowledge/shipped-documents.test.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { readKnowledgeFolder } from './document.js';

// src/domain/knowledge -> src/domain -> src -> core-tools -> harness -> the repository root.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');

describe('the shipped demo knowledge folder', () => {
  it('parses, and the two documents sit at the two levels the demo script relies on', async () => {
    const docs = await readKnowledgeFolder(path.join(repoRoot, 'clients', 'demo-practice', 'knowledge'));
    expect(docs.map((d) => [d.path, d.minLevel, d.minRank])).toEqual([
      ['escalation-and-billing.md', 'lead', 2],
      ['front-desk.md', 'member', 0],
    ]);
    // The whole demo turns on this pair: a member's search reaches the first document and not the
    // second, which is what makes "the assistant says it does not have that" a true answer rather
    // than a coincidence. The practice manager is named on the closed one by id.
    const [escalation, frontDesk] = docs;
    expect(escalation.principals).toEqual(['u-practice-manager']);
    expect(frontDesk.principals).toEqual([]);
    expect(frontDesk.title).toBe('Front desk hours and messages');
    expect(escalation.body).toContain('duty lead');
  });
});
```

`readKnowledgeFolder` walks in path order, which is why `escalation-and-billing.md` is first.

- [ ] **Step 6c: Run the two tests that read the shipped files**

Run:

```bash
pnpm --filter @harness/host exec vitest run src/domain/playbooks/preflight.test.ts
pnpm --filter @harness/core-tools exec vitest run src/domain/knowledge/shipped-documents.test.ts
```

Expected: PASS both. If the first still fails on the skill, `app/main.ts`'s `kernelSkillsDir()`
went in at step 3 but the test's own catalogue did not — they are two separate call sites and both
have to name it.

- [ ] **Step 7: Tell the persona where an answer comes from**

In `clients/demo-practice/SOUL.md`, add a tenth hard rule, after rule 9:

```markdown
10. **A practice answer comes from the knowledge base, with its source.** When you are asked
    something about how this practice works — hours, escalation, billing, a policy —
    `knowledge_search` first and answer from what it returns, naming the document you took it
    from. You see only the documents the person asking is allowed to see, so a search that
    returns nothing useful means you say you do not have it and offer to ask a lead, never that
    you fill the gap from memory. A passage is the nearest text to the question, not proof that
    it answers it: read it before you use it.
```

- [ ] **Step 8: Write the failing scaffolder test**

In `scripts/src/domain/scaffold.test.ts`, add to `scaffold()`:

```ts
  await mkdir(path.join(template, 'knowledge'), { recursive: true });
  await writeFile(
    path.join(template, 'knowledge', 'front-desk.md'),
    '---\ntitle: Front desk\nmin_level: member\n---\n\nDemo Practice answers the telephone until five.\n',
  );
```

change the expected file list in `'copies the template and substitutes the client name everywhere'` to:

```ts
    expect(out.files.sort()).toEqual(
      [
        '.env.example',
        'SOUL.md',
        'identity.yaml',
        'knowledge/front-desk.md',
        'playbooks.yaml',
        'policy.yaml',
        'routing.yaml',
      ].sort(),
    );
```

and add a test:

```ts
  it('copies the knowledge folder, rewriting the client name inside each document', async () => {
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    const document = await readFile(path.join(out.dir, 'knowledge', 'front-desk.md'), 'utf8');
    expect(document).toContain('River Clinic answers the telephone until five.');
    expect(document).toContain('min_level: member');
    expect(document).not.toContain('Demo Practice');
  });

  it('reports a missing knowledge folder as skipped rather than failing', async () => {
    await rm(path.join(root, 'clients', 'demo-practice', 'knowledge'), { recursive: true, force: true });
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    expect(out.skipped).toEqual(['knowledge/']);
    expect(out.files).not.toContain('knowledge/front-desk.md');
  });
```

- [ ] **Step 9: Run it to verify it fails**

Run: `pnpm --filter @harness/scripts exec vitest run`
Expected: FAIL — the knowledge folder is not copied.

- [ ] **Step 10: Copy the folder**

In `scripts/src/domain/scaffold.ts`, add `readdir` to the `node:fs/promises` import, add below `TEMPLATE_FILES`:

```ts
/**
 * Directories copied whole, file by file. Only markdown is taken: a client's knowledge folder is
 * documents, and a stray binary in the template is not something a new client should inherit. A
 * template with no such directory simply reports it under `skipped`, exactly as a missing file is
 * reported, because a client with no knowledge base is an ordinary client.
 */
const TEMPLATE_DIRS = ['knowledge'] as const;
```

and, inside the `try` in `newClient`, after the `for (const relative of TEMPLATE_FILES)` loop:

```ts
    for (const directory of TEMPLATE_DIRS) {
      const from = path.join(templateDir, directory);
      if (!(await exists(from))) {
        skipped.push(`${directory}/`);
        continue;
      }
      for (const entry of (await readdir(from, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue;
        const relative = `${directory}/${entry.name}`;
        await copyTextFile(path.join(templateDir, relative), path.join(dir, relative), templateSlug, name);
        files.push(relative);
      }
    }
```

`copyTextFile` already creates the parent directory, so nothing else is needed.

- [ ] **Step 11: Run the scaffolder tests to verify they pass**

Run: `pnpm --filter @harness/scripts exec vitest run`
Expected: PASS.

- [ ] **Step 12: Give the Compose host service the API and the embedding width**

In `harness/compose/docker-compose.yml`, in the `host` service's `environment` block, change the surfaces default and add the four new lines, keeping the block's existing order (the plug-in names together, then the API):

```yaml
      # The run API surface is loaded beside the primary one so a headless caller has a surface
      # to name. It is never first: the first entry is where approval cards are posted, and this
      # one cannot post a card.
      HARNESS_SURFACES: '${HARNESS_SURFACES:-@harness/surface-slack,@harness/surface-http}'
```

and, after the `HARNESS_HISTORY_MAX_MESSAGES` line:

```yaml
      # The run API (spec 5.8). Unset HARNESS_HOST_TOKEN means no listener at all.
      HARNESS_HOST_TOKEN: '${HARNESS_HOST_TOKEN:-}'
      # Every interface inside the container, for the reason APPROVALS_HEALTH_BIND is: a
      # container-loopback listener answers neither the published port nor another container.
      HARNESS_HOST_BIND: '${HARNESS_HOST_BIND:-0.0.0.0}'
      HARNESS_HOST_PORT: '8788'
      # The width knowledge_chunks.embedding was created at. Changing it means a new database.
      HARNESS_EMBED_DIMS: '${HARNESS_EMBED_DIMS:-1024}'
```

and add to that service's `ports` list, after the health port:

```yaml
      - '127.0.0.1:${HARNESS_HOST_PUBLISHED_PORT:-8788}:8788'
```

- [ ] **Step 13: Re-record the Compose snapshot and check the diff**

Run, from the repository root:

```bash
pnpm surface:record
git diff --stat docs/architecture
git diff docs/architecture/compose-surface.yaml
```

Expected: `tool-surface.json` **unchanged**; `compose-surface.yaml` gains the four environment lines, the changed `HARNESS_SURFACES` default and one port line rendered as the plain string `- 127.0.0.1:${HARNESS_HOST_PUBLISHED_PORT:-8788}:8788` (an interpolated published port cannot be parsed into a map under `--no-interpolate`, which is why the health port renders the same way).

`.env.ci` needs no change: every new variable has a Compose default, and `.env.ci` exists only so `docker compose build` can interpolate the three that do not.

- [ ] **Step 14: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status --short docs/architecture` shows `compose-surface.yaml` modified and nothing else.

- [ ] **Step 15: Commit**

```bash
git add harness/compose/docker-compose.yml docs/architecture/compose-surface.yaml \
  harness/host/skills harness/host/src/domain/skills.ts harness/host/src/domain/skills.test.ts \
  harness/host/src/domain/playbooks/preflight.test.ts \
  harness/core-tools/src/domain/knowledge/shipped-documents.test.ts \
  harness/host/src/app/main.ts harness/host/src/index.ts clients/demo-practice \
  scripts/src/domain/scaffold.ts scripts/src/domain/scaffold.test.ts
git commit -m "feat(demo): ship a knowledge folder, schedule its sync, and publish the run API in Compose"
```

---

### Task 11: Documentation

**Files:**
- Modify: `docs/runbook.md` (a "Knowledge" section, a "The run API" section, "Upgrading from Plan 9", and two lines in "Database roles" and "Writing migrations")
- Modify: `ARCHITECTURE.md`, `README.md`, `CONTRIBUTING.md`, `docs/demo.md`
- Modify: `harness/host/README.md`, `harness/core-tools/README.md`, `harness/db/README.md` if one exists
- Modify: `docs/architecture/graph.svg` (regenerated)

**Interfaces:**
- Consumes: everything Tasks 1–10 produced. Produces no code.

- [ ] **Step 1: Add the runbook's "Knowledge" section**

In `docs/runbook.md`, after the "Memory" section and before "Playbooks", add:

```markdown
## Knowledge

`clients/<name>/knowledge/` is a folder of markdown. `knowledge_sync` walks it into
`knowledge_documents` and `knowledge_chunks`; `knowledge_search` reads it back, filtered by who is
asking. The demo ships two documents and a nightly `knowledge-sync` playbook at 06:30
`America/New_York`.

**A document.** Optional frontmatter between two `---` lines: `title` (default: the first `#`
heading, else the file name), `min_level` (`member`, `practitioner`, `lead` or `admin`; default
`member`), and `principals` (a list of principal ids). Everything below the frontmatter is the
body. A document with neither frontmatter nor body is refused by name at sync time, and so is one
with an unknown key or an unknown level — `service` is not a document level, because a service is
not on the level ladder and is named by id or not at all.

**Who reads what.** `client = <this client> AND deleted_at IS NULL AND (min_rank <= <the caller's
rank> OR principals @> ARRAY[<the caller's id>])`, in the `WHERE` clause of both rankings, so a
passage the caller may not see is never ranked and never counted toward `k` (invariant 7). The
ranks are `member` 0, `practitioner` 1, `lead` 2, `admin` 3, and **`service` is −1**: a scheduled
job reads a knowledge document only when the document names it in `principals`.

**A sync.** `sha256` of the whole file, frontmatter included, decides whether a document is
re-chunked and re-embedded, so raising a `min_level` re-indexes the document and moves the new
level onto every passage. A file that has disappeared is **tombstoned**, not deleted: the row
keeps `deleted_at` so an operator can see what went and when, and its passages are deleted so
nothing can retrieve it. A document whose title or text trips the restricted-pattern check is
**skipped** — no passages, no row change — and its path is in the result's `skipped` list with the
reason (invariant 10). One bad file never stops the folder from syncing.

**Chunking.** 1,000 characters with 200 of overlap, broken on paragraphs first, then lines,
sentences, words and finally characters. A passage can reach 1,200 characters, because the overlap
is cut at a space so a passage never starts mid-word.

**Embeddings.** Route `embed` in `clients/<name>/routing.yaml`, called at `POST /v1/embeddings` on
the gateway, up to 64 passages per request, one `model_calls` row per request on route `embed`.
The column is `vector(1024)` and `HARNESS_EMBED_DIMS` is checked against it at startup: they
disagree and the process refuses to start, because a deployment cannot change its embedding width
in place. **Check the route once before the first sync**, since a deployment whose model answers at
another width is refused per request rather than at startup:

```bash
curl -s http://127.0.0.1:4000/v1/embeddings \
  -H "Authorization: Bearer $LITELLM_MASTER_KEY" -H 'content-type: application/json' \
  -d '{"model":"embed","input":["hello"],"dimensions":1024}' \
  | python3 -c 'import json,sys; print(len(json.load(sys.stdin)["data"][0]["embedding"]))'
```

It must print `1024`.

**Reading the tables.**

```sql
select d.path, d.title, d.min_level, d.principals, d.updated_at, d.deleted_at, count(c.id) as chunks
from knowledge_documents d left join knowledge_chunks c on c.document_id = d.id
where d.client = 'demo-practice' group by d.id order by d.path;
```
```

- [ ] **Step 2: Add the runbook's "The run API" section**

After the "Knowledge" section, add:

```markdown
## The run API

Four routes in the host, on `HARNESS_HOST_BIND:HARNESS_HOST_PORT` (default `127.0.0.1:8788`),
behind `Authorization: Bearer $HARNESS_HOST_TOKEN`. **With no token there is no listener**: the
host logs one line saying the API is off and which variable turns it on.

Who a run acts as is the identity plug-in's answer, never the caller's: every route names a loaded
`surface` and that surface's own user id, which is resolved exactly as an adapter's message is, so
a caller cannot name a principal. Load `@harness/surface-http` in `HARNESS_SURFACES` — **after**
your primary surface, because the first entry is where approval cards go and that one cannot post
a card — and give each caller an `http:` entry in `identity.yaml`.

| Route | What it does |
| --- | --- |
| `POST /v1/runs` | `{ surface, conversation, userId, text, attachments? }` → `202` and a Server-Sent Events stream: `run` with the run id, then the runtime's events, then `result` |
| `POST /v1/runs/:id/cancel?surface=&userId=` | `{ run_id, cancelled }`; `cancelled` is false when the run had already ended |
| `GET /v1/threads/:id?surface=&userId=` | that thread and its **most recent** messages, newest last, at most 200 — the tail of a long thread, not its beginning |
| `GET /v1/status` | the client, the loaded surfaces, the runs in flight, and the scheduler's status |

```bash
curl -N http://127.0.0.1:8788/v1/runs -H "Authorization: Bearer $HARNESS_HOST_TOKEN" \
  -H 'content-type: application/json' \
  -d '{"surface":"http","conversation":"api","userId":"coordinator","text":"What are the front desk hours?"}'
```

**What it does not do.** The reply is recorded on the thread and posted to no surface: the caller
is the one waiting for it, and putting the same answer into the named conversation would be a
message nobody there asked for. Hanging up does not cancel the run — use the cancel route — and
the run's result is on the thread either way. An approval raised during an API run goes where every
approval card goes: the primary surface.

**Limits.** A 1 MiB body, 10,000 characters of text, ten attachments, each a path inside
`<storage>/incoming` (checked before the run opens). A thread read returns at most 200 messages,
and they are the most recent 200 — a longer thread is truncated at the front, never at the end.
One run at a time per thread: a second request on the same conversation waits for the first,
exactly as a second message on a surface does.

**What the answers mean.** `401` is a bad or missing token. `403` is a good token naming a surface
user the identity plug-in does not know. `404` is "no such run" or "no such thread" — and it is
also the answer for a run or thread belonging to **another** principal, on purpose: the API never
confirms that someone else's row exists. `413` is a body over the cap.

**Restricted values.** Every text frame is checked on its way out, and the closing `result` frame
carries the whole reply already withheld if it tripped — the same guarantee a streamed Slack reply
has. A pattern split across two deltas is caught by that final check, not by the deltas.
```

- [ ] **Step 3: Add "Upgrading from Plan 9"**

After the "Upgrading from Plan 8" section, add:

```markdown
## Upgrading from Plan 9

An existing Plan 9 deployment hits all of these. Work through them in order, with the stack down.

1. **Recreate Postgres on the pgvector image.** `harness/compose/docker-compose.yml` now runs
   `pgvector/pgvector:pg16` instead of `postgres:16`. It is the same major version and the same
   data directory layout, so the existing `pgdata` volume is reused as it is: `docker compose pull
   postgres` then `docker compose up -d postgres` recreates the container on the same data. Do not
   delete the volume. On bare metal, install the `vector` extension for your Postgres 16 — the
   `postgresql-16-pgvector` package on Debian and Ubuntu.
2. **Migrate.** `pnpm db:migrate` now issues `CREATE EXTENSION IF NOT EXISTS vector` before the
   migrator and then applies 0013: `knowledge_sources`, `knowledge_documents`, `knowledge_chunks`
   with an HNSW index and two GIN indexes. The extension statement needs a role that may create an
   extension, which the migrating owner already is — see "Database roles". It fails with
   `extension "vector" is not available` if step 1 was skipped, and nothing is applied.
3. **Grant the application role** `SELECT, INSERT, UPDATE` on the three new tables and `DELETE` on
   `knowledge_documents` and `knowledge_chunks`, as under "Database roles". The sync deletes
   passages; it never deletes a document.
4. **Add the `embed` route** to `clients/<name>/routing.yaml` and run `pnpm gateway:config`, then
   restart the gateway. A routing file without it fails to parse at startup, naming the route.
   Check the width once with the `curl` under "Knowledge" before the first sync.
5. **New environment variables**, all optional: `HARNESS_EMBED_DIMS` (default 1024, and it must
   match the column), `HARNESS_HOST_TOKEN` (**unset means no run API**), `HARNESS_HOST_BIND`
   (default `127.0.0.1`, `0.0.0.0` inside Compose), `HARNESS_HOST_PORT` (default 8788) and the
   Compose-only `HARNESS_HOST_PUBLISHED_PORT`.
6. **Optional: turn the run API on.** Set `HARNESS_HOST_TOKEN`, add `@harness/surface-http` to
   `HARNESS_SURFACES` after your primary surface, and add an `http:` entry to each principal in
   `identity.yaml` who may call it.
7. **Optional: add a knowledge folder.** Put markdown in `clients/<name>/knowledge/` and either
   call `knowledge_sync` once as an admin or add the `knowledge-sync` playbook to
   `playbooks.yaml`, which the demo's file now shows. A client with no folder syncs nothing and
   starts fine.
8. **Expect these behaviour changes.** The host now offers one skill of its own,
   `knowledge-sync`, beside the packs'. The published tool count is 30 in the default deployment
   and 35 with both packs loaded. `claimDuePlaybooks` no longer takes a `limit`; the batch is the
   `CLAIM_BATCH` constant, at the same value of 10.
```

- [ ] **Step 4: The two sections that already exist**

In `docs/runbook.md`, under "Database roles", change the two grant statements to:

```sql
GRANT SELECT, INSERT, UPDATE ON TABLE
  records, documents, fields, attachments, deadlines,
  approvals, runs, model_calls, tool_effects,
  memory_entries, playbooks, playbook_runs, threads, messages,
  knowledge_sources, knowledge_documents, knowledge_chunks
TO harness_app;

-- `deadlines_compute` retires deadlines whose attachment lost its expiry date,
-- `memory_remove` forgets an entry, and `knowledge_sync` replaces a document's
-- passages, so these tables also need DELETE. It never deletes a document row:
-- a document whose file is gone is tombstoned with `deleted_at`.
GRANT DELETE ON TABLE deadlines, memory_entries, knowledge_chunks TO harness_app;
```

and add one sentence under them: `Creating an extension is the owner's right, not the application role's: \`runMigrations\` issues \`CREATE EXTENSION IF NOT EXISTS vector\` and runs as the migrating owner, exactly as the migrator does.`

Under "Writing migrations", add after the existing "never `--custom`" rule:

```markdown
`drizzle-kit generate` writes tables, columns and indexes. It does **not** write
`CREATE EXTENSION`, and there is no configuration that makes it — `extensionsFilters` takes only
`postgis` and only filters introspection. An extension the schema needs therefore goes in
`EXTENSIONS` in `harness/db/src/domain/migrate.ts`, which `runMigrations` installs before the
migrator, idempotently, on every call. Do not hand-edit a generated `.sql` to add one: the rule
that `generate` twice prints "No schema changes" is what keeps the snapshot and the migrations
honest, and a hand-edited file is invisible to it. `migration-0013.test.ts` asserts both halves —
that the shipped SQL fails with `type "vector" does not exist` on its own, and that
`runMigrations` on a bare database leaves the extension installed and the tables created.
```

- [ ] **Step 5: ARCHITECTURE.md**

In the "The packages" list, add a row for `surfaces/http` reading `the surface a headless caller speaks as; opens no socket, posts nothing, and exists so a run driven over the run API has a thread key and an identity namespace`.

After the "Identity" section, add:

```markdown
## Knowledge

`knowledge_documents` is one row per markdown file of `clients/<name>/knowledge/`, keyed by its
path within the source; `knowledge_chunks` is one row per retrievable passage, with a generated
`tsvector` and a `vector(1024)` embedding from the gateway's `embed` route.

A chunk carries a **copy** of its document's `min_level`, `min_rank` and `principals`. That
denormalisation is the design, not an oversight: the access filter has to sit in the same `WHERE`
clause as the ranking, so a passage the caller may not see is never ranked and never counted
toward `k` (invariant 7). A join to the document for every candidate row would apply it one step
too late.

`min_rank` is the level's place on the ladder — `member` 0 through `admin` 3 — because Postgres
cannot order level names, and `min_level` is kept beside it because a human reads the table too.
**A `service` principal's rank is −1**: `levelAtLeast('service', 'member')` is false, so a
scheduled job reads a knowledge document only when the document names its principal id.

`knowledge_search` runs a cosine top-k over the HNSW index and a `ts_rank_cd` top-k over the GIN
one, both already filtered, and fuses them by reciprocal rank — each list contributes
`1 / (60 + rank)`. Ranks rather than scores, because a cosine distance and a cover-density rank are
not comparable; the one thing the two rankings agree on is order.

## The run API

Four routes in `@harness/host`, not a surface: spec 5.8 puts the listener in the host, and the
request body names which surface a run belongs to, so the API drives a run on *any* loaded surface
and names none itself. `@harness/surface-http` is what a headless caller names — it supplies a
`threads.surface` value, a namespace for the identity plug-in to resolve `(surface, userId)` in,
and a loaded session for `runTurn` to find — and it opens no socket of its own.

The API's turn is `deliver: 'none'`: the reply is recorded on the thread and posted nowhere,
because the caller is the one waiting for it. The stream is the reply. Everything the caller sees
comes through `TurnInput.observe`, the one hook `runTurn` grew for this: the run id first, then the
runtime's events, then the turn's outcome. A watcher that throws is logged and dropped — it is
watching, not taking part.
```

- [ ] **Step 6: README.md and docs/demo.md**

In `README.md`, wherever the client folder is listed, add `knowledge/       markdown the assistant can cite, filtered by who is asking`; wherever `postgres:16` appears, change it to `pgvector/pgvector:pg16`; and add one line to whatever lists what the host serves: `the run API on 127.0.0.1:8788 when HARNESS_HOST_TOKEN is set (docs/runbook.md, "The run API")`.

In `docs/demo.md`, after the playbook step, add:

````markdown
### A cited answer, at the asker's level

The demo ships two knowledge documents. Sync them once, as the practice manager:

```
@assistant refresh the knowledge base
```

Then ask, as the coordinator (a `lead`):

```
@assistant how do we escalate something urgent?
```

The answer quotes `escalation-and-billing.md` and names it. Ask the same thing as a `member` and
the assistant says it does not have that and offers to ask a lead: `knowledge_search` returned only
`front-desk.md`, because the escalation document is `min_level: lead`. Nothing about the second
document leaks into the refusal — the member's search never ranked it.
````

- [ ] **Step 7: The package READMEs**

In `harness/host/README.md`, add a "The run API" section listing the four routes, the bearer rule,
and that no token means no listener; and one line saying the host now ships one skill of its own in
`skills/`, `knowledge-sync`, offered beside every pack's.

In `harness/core-tools/README.md`, add `domain/knowledge/` to whatever lists the domains — "the
chunker, the frontmatter reader, the repository, the sync and the fused search" — name
`knowledge_search` and `knowledge_sync` in the tool list, and add `HARNESS_EMBED_DIMS` to the
variables it reads.

`surfaces/http/README.md` was written in Task 8; re-read it and check it still matches what
shipped.

- [ ] **Step 8: Regenerate the architecture graph**

Run, from the repository root:

```bash
which dot || echo "install graphviz (brew install graphviz) before this step"
pnpm arch:graph
git diff --stat docs/architecture/graph.svg
```

Expected: the graph gains the `surfaces/http` node. If `dot` is not installed, say so in the task
report and leave `graph.svg` untouched rather than committing a stale or empty one.

- [ ] **Step 9: Run the four gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `pnpm format:check` covers markdown, so a long line in the runbook fails it —
run `pnpm format` if it does.

- [ ] **Step 10: Commit**

```bash
git add docs ARCHITECTURE.md README.md CONTRIBUTING.md harness/host/README.md \
  harness/core-tools/README.md surfaces/http/README.md
git commit -m "docs: document the knowledge base, the run API and the upgrade from Plan 9"
```

---

## Self-review

### 1. Spec coverage

| Spec | Where |
|---|---|
| 5.7, tables `knowledge_sources` / `knowledge_documents` / `knowledge_chunks` with `vector(N)` | Task 1 |
| 5.7, `N` is `HARNESS_EMBED_DIMS`, default 1024, fixed per deployment when the table is created | Task 1 (the column) + Task 2 (`assertEmbedDims`, decision 2) |
| 5.7, route `embed` on LiteLLM at `POST /v1/embeddings` | Task 2 |
| 5.7, chunker `RecursiveCharacterTextSplitter`-equivalent, 1,000 / 200, in `domain/knowledge/chunk.ts` | Task 3 |
| 5.7, `knowledge_search(query, k)` `read`, cosine top-k and `ts_rank_cd` top-k, both with the client-and-level filter, fused by reciprocal rank, returning `path`, `title`, `updated_at` | Task 5 (engine) + Task 6 (tool) |
| 5.7, `knowledge_sync` `write.internal` (was `admin`; see the execution correction), walks `clients/<name>/knowledge/**/*.md`, frontmatter `title` / `min_level` / `principals`, upserts by `sha256`, tombstones removed files | Task 4 (engine) + Task 6 (tool) |
| 5.7, the sync is scheduled as a playbook | Task 10 (the `knowledge-sync` playbook and the kernel skill it names, decision 20) |
| 5.8, `POST /v1/runs` → 202 + a stream of run events; `POST /v1/runs/:id/cancel`; `GET /v1/threads/:id` for the caller's principal only | Task 9 |
| 5.8, bearer `HARNESS_HOST_TOKEN`, bind `HARNESS_HOST_BIND` default `127.0.0.1` | Task 9 (decisions 12 and 13) |
| 5.8, identity resolves `(surface, userId)` exactly as for an adapter, so a caller cannot name a principal | Task 9, `callerOf` |
| 6, migration 0013: `CREATE EXTENSION vector`, the three tables, HNSW and GIN indexes | Task 1 (the extension in `runMigrations`, decision 1) |
| 7, `clients/<name>/knowledge/` in the client folder; `routing.yaml` gains `embed`; Compose Postgres is `pgvector/pgvector:pg16` | Tasks 2, 10; the scaffolder copies the folder (Task 10) |
| 8, invariant 7: knowledge reads filtered by principal and level **before** ranking | Task 5, `visibleTo` in both `WHERE` clauses; asserted in five access tests and again in Task 1's migration test |
| 8, invariant 10: no restricted value in `knowledge_chunks` or a run event | Task 4 (the sync skips such a document) + Task 9 (the stream's `safe()` on `text` and `done`) |
| 8, invariant 11: no client, domain, surface, provider or framework vocabulary in kernel, host or the new adapter | Task 8 extends the scan to `surfaces/http/src`; the empty allowlist stays empty |
| 8, invariant 12: a cancelled run stops within one model call and records `cancelled` | unchanged from Plan 8/9; Task 9's cancel test drives it through the API |
| 10 row 10, "a cited answer from `clients/demo-practice/knowledge/` at the caller's level" | Task 6's tool tests (member sees one document, lead sees both, each hit carrying path and title) + Task 10's demo folder, whose two shipped documents are parsed and their levels asserted by `shipped-documents.test.ts` (Task 10 step 6b), so the path the criterion names is read by the suite and not only by a person following Task 11's demo script |
| 10 row 10, "a run driven over HTTP streams and cancels" | Task 9's `server.test.ts`, on a real socket at `127.0.0.1:0` |

**Carried items from Plan 9, both closed:** `claimDuePlaybooks({ limit })` loses the option for a constant (Task 7, decision 17); the scheduler's status reaches an operator through `GET /v1/status` (Task 9, decision 16). The third — spec 5.3's "memory from a group thread never lands in a private scope" — stays out of scope: the run API adds no direct-or-group flag to `MessageEvent`, so nothing here changes what Plan 9 recorded as a deferral.

**Amendments to the spec, both deliberate and both recorded at the decision that makes them:**
section 5.3's "catalogue from the loaded packs' `skillsDir`s" becomes the kernel's own directory
and then the packs' (decision 20), because a playbook that refreshes a knowledge base must name a
skill no product area owns; and section 5.8's two variables gain `HARNESS_HOST_PORT` beside them
plus the Compose-only `HARNESS_HOST_PUBLISHED_PORT` (decision 12), because a bind address alone
does not name a socket and `APPROVALS_HEALTH_BIND` / `_PORT` / `_HOST_PORT` is the same triple one
service along in the same file. Section 5.8 names three routes and this plan serves four; the
fourth, `GET /v1/status`, is decision 16 and is where the scheduler's status finally reaches an
operator.

**Not covered, deliberately:** nothing in section 5.7 or 5.8 is left out. Section 11 (Weave) is out of scope by the spec's own words.

### 2. Placeholder scan

Searched the plan for `TBD`, `TODO`, `implement later`, `fill in`, `appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above` and `similar to Task`. None present. Every code step carries the actual code; the documentation task carries the actual prose or the exact replacement text, following Plan 9's Task 9. Three softenings were found and removed while writing: a "delete this helper if the linter objects" note in Task 4, a "write the import the other way" note in Task 8, and an apostrophe note in Task 9 — in each case the correct code now sits inline. The one instruction that names a judgement rather than a literal is Task 11's "wherever the client folder is listed" in `README.md`, which is a search the writer performs, not a decision they make.

### 3. Type consistency

- `ToolDeps` gains exactly two members, `clientDir: string` and `embedDims: number` (Task 2), and all four places that build one are updated in that same task: `buildKernelConfig`, `makeTestDeps`, `surfaceDeps` and — through `KernelConfig` — `depsForRun`, which spreads.
- `ParsedKnowledgeDocument` is produced by `parseKnowledgeDocument` (Task 3) and consumed by `upsertDocument` and `replaceChunks` (Task 4) under the same field names: `path`, `title`, `minLevel`, `minRank`, `principals`, `sha256`, `body`.
- `KnowledgeCandidate` (Task 5) and `KnowledgeHit` (Task 3) differ by exactly `score`, and `fuseByReciprocalRank` is what adds it; the tool's `HitShape` (Task 6) lists the eight fields of `KnowledgeHit` and no others.
- `KnowledgeSyncResult` (Task 3) is returned by `syncKnowledge` (Task 4) and is the output schema of `knowledge_sync` (Task 6), field for field: `source, scanned, added, updated, unchanged, removed, chunks, skipped`.
- `levelRank` is defined once (Task 3) and used by both the parser (Task 3) and the search (Task 5); the ranks it produces are the same numbers Task 1's migration test asserts against.
- `TurnEvent` (Task 7) is the type `TurnInput.observe` takes and the type the run API's `observe` narrows on (Task 9); the three shapes — `{ type: 'run'; runId }`, `RunEvent`, `{ type: 'result'; status; text; error }` — are the six frame names the end-to-end test asserts, plus the runtime's own.
- `RunApiOptions` / `RunApiServer` (Task 9's `types.ts`) are what `startRunApi` takes and returns, what `handleApiRequest` reads `token` and `scheduler` from, and what `app/main.ts` fills.
- `EMBED_ROUTE` is declared once in `domain/models/types.ts` (Task 2) and imported by `callModel`'s guard and by `embedTexts`; `'embed'` appears as a bare string only in `ROUTES` and in the two YAML files.
- Counts agree across tasks: `RECORDED_TOOLS` 28 → 30 and `dual-pack` 33 → 35 in Task 6 only, and the runbook's "Upgrading from Plan 9" (Task 11) repeats those two numbers.
- `CLAIM_BATCH` (Task 7) replaces the `limit ?? 10` default at the same value, so no scheduler behaviour moves.
