# Plan 11c: Platform seams — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the OS the four seams a product built on top of it needs, and nothing else. A tenant with no Slack gets a **web surface**: a real `SurfaceSession` reached over the HTTP seam Plan 11b shipped, with messages in, an event stream out, actions and forms back, and its own bearer. A tenant's **secrets come from a store** instead of from the process environment, resolved once when the tenant opens, so a pooled host onboards a client without a restart. A tenant gets **its own gateway key**, so a model call carries the tenant in the credential rather than in the route name. The run API grows **two read routes** a dashboard can page through. The three tables the platform writes become a **stated contract**, and the one way their history could lie — a version string written twice with different content — becomes a refusal. Underneath all four, the seam itself grows the one shape it was missing: a response that is a stream rather than a buffer.

**Architecture:** Seven moves. (1) **The seam streams.** `SurfaceHttpResponse.body` becomes `string | AsyncIterable<string>`, `SurfaceHttpRequest` gains `clientId` and `signal: AbortSignal`, and the host writes the head, pipes each chunk as it is yielded, ends when the iterable ends and aborts the signal when the client hangs up. `MemorySurface`'s door grows an event stream with resumable ids, so the thing the host's own test drives is the reference implementation. (2) **`SecretSource`.** A two-method contract beside `ConfigSource` in `@harness/config-api`, with `env` shipped in that package and `postgres` shipped in `@harness/config-postgres` over a new `client_secrets` table and `@harness/db`'s AES-GCM envelope. `HARNESS_SECRET_SOURCE=env|postgres`, no default. `assertSecretsPresent` becomes `resolveSecrets`, runs *before* `buildKernelConfig`, and hands each adapter resolved **values** on `SurfaceDeps.secretValues`. (3) **`surfaces/web`.** A new adapter package: four routes under one mount, Server-Sent Events framed by the adapter and written by the host as opaque chunks, a constant-time bearer compare of its own, `tenantHint` taken from the request's `clientId`, and an inbox conversation where approval cards go. (4) **A per-tenant gateway key.** `routing.gateway.key` is a `SecretRef` resolved at open and carried on `GatewayConfig.apiKey`; `RoutingFile` becomes strict so a mistyped key cannot fall back to the process key in silence. (5) **Two read routes.** `GET /v1/approvals` and `GET /v1/memory`, cursor-paged, tenant-scoped, with column lists asserted whole. (6) **The write contract.** `writeClientDocument` refuses a rewritten version, inside the transaction, and the conformance suite carries the case. (7) **The boundary the platform lands inside.** Two dependency-cruiser rules — no kernel package imports the platform's four directories, and `catalog/` imports kernel contracts only — plus tests pinning that the vocabulary scans and the environment scan stay rooted in the kernel's own trees.

**Tech Stack:** Node `>=22`, pnpm `11.4.0`, TypeScript 7 (`^7.0.2`) in every package with `typescript@6.0.3` at the workspace root only, ESM only, zod v4 as `import * as z from 'zod/v4'`, vitest `^5.0.0`. **No new third-party dependency.** Server-Sent Events are string concatenation; the constant-time compare is `node:crypto`'s `timingSafeEqual`; the envelope is `@harness/db`'s existing `encrypt`/`decrypt`. One new workspace package: `@harness/surface-web`, which is an **adapter and is not published**, with no dependency but `@harness/surface-api` and `@harness/shared`.

**Spec:** `docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md` — this plan is sections 14–25, the Plan 11c addendum. It implements decisions 17–23 and the amended 1b; sections 4.9, 4.10, 4.11 and 4.12; section 6's `client_secrets` table and its stable write contract; invariants 20, 21, 22, 23 and 24; section 20's testing additions; and the exit criterion of section 21's row 11c — "a tenant with no Slack talks to its agent through the web surface from the platform's workspace; a tenant added by writing rows — document plus secrets — answers on a pooled host with **no restart**". It starts from `worktree-plan-11c-platform-seams` at `690b370`, which is `main` at `ad57f28` (Plans 11a and 11b merged, plus Task 1 of this plan) with the spec addendum commit on top. Section 23's constraints 11–24 are answered by named tasks below.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`.
- **The four gates plus the suite pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; up to 25 type-aware warnings are the known backlog, and the branch sits **exactly at 25** — spec §12 constraint 23 — so new code that adds a warning has to remove one), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test`. No task ends red and no gate is parked.
- **Local test environment.** Run the suite with these three variables in front of the command and nothing else; never source `.env`:
  ```
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder
  ```
  Those databases exist; do not create or drop them, and run no container command against either.
- **Exactly one migration in this plan, in Task 3.** `client_secrets`, generated by plain `drizzle-kit generate`. **No other task touches `harness/db/src/domain/schema.ts` or `harness/db/drizzle/`.** Task 3 runs the generator **twice** and the second run prints that there is nothing to migrate, which is the check that the committed SQL is what the schema says. `harness/db/src/testing.ts`'s truncation list gains the new table in the same task, or every database-backed suite leaks rows between cases.
- **Environment variables.** One is added and none is deleted:
  | Variable | Read by | Change |
  |---|---|---|
  | `HARNESS_SECRET_SOURCE` | `secretSourceNameFrom` in `harness/core-tools/src/domain/config/registry.ts`, beside `configSourceNameFrom` | **Added in Task 3**, `env` or `postgres`, **no default**. Documented in `.env.example` and passed through by Compose **without a `:-` default** (spec §4.10), which is the one compose edit and the one compose re-record of this plan |
  `harness/core-tools/src/app/surface.test.ts` scans every non-test source file under the seven kernel roots for environment reads and fails on a name `.env.example` does not document. The web surface reads **no** environment variable at all — its one credential arrives resolved on `deps.secretValues` — so it adds nothing to that scan (spec §12 constraint 24).
- **A tenant's secrets are not a deployment's settings.** Task 3 makes `.env.example` a deployment's file: database URLs, `HARNESS_ENCRYPTION_KEY`, `LITELLM_MASTER_KEY`, `HARNESS_HOST_TOKEN`, `HARNESS_SECRET_SOURCE`, the config source, the ports, the image tag. A tenant's bot token, signing secret, web bearer and gateway key are named by its document as `{ ref }` and live in `client_secrets`, written from the platform's own interface. **No variable is deleted**: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL` stay documented as commented-out lines — the Slack adapter still falls back to them for a dedicated host, so the environment scan still reads all three — and Compose still passes them through for exactly that case.
- **Snapshots.** The **tool-surface snapshot** (`docs/architecture/tool-surface.json`) is byte-identical in **every task of this plan**. No task adds, removes or re-describes a tool, and the recorder's fixture document — `fixtureDocument()` in `@harness/config-api/testing`, used by `surfaceDeps()` in `record-surface.ts` — declares `surfaces: { memory: {}, http: {} }`, no `web` section and no `{ ref }`, so nothing this plan adds to the schema reaches it. `git status --short docs/architecture` proves it. The **Compose snapshot** (`docs/architecture/compose-surface.yaml`) changes in exactly **one** task, **Task 3**, which is the only task that edits `harness/compose/docker-compose.yml` and the only one that runs `pnpm surface:record`. Every other task leaves both files byte-identical, and a task that finds otherwise has broken something it did not mean to.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its **empty allowlist**, and the suite's own assertion that it stays empty is untouched. No forbidden word is added or removed in this plan. **`harness/host/src` never names a vendor and never learns the web surface's vocabulary**: not a route name, not an event name, not a frame, not a header. Everything the host writes below `/tenants/` is data an adapter supplied — the mount path, the refusal reason, and now every byte of a streamed body, which the host copies without reading. After Task 8 the scanned trees are stated explicitly and are the same kernel roots they are today: `harness/core-tools/src`, `harness/config-api/src`, `harness/identity-api/src`, `harness/runtime-api/src`, `harness/files/src`, `harness/host/src`, `evals/src`, `packs/healthcare/src`, `packs/stories/src`, `surfaces/http/src`, `identities/static/src`, `identities/slack-groups/src` and `runtimes/deepagents/src`. `surfaces/web/src` is **not** scanned, for the reason `surfaces/slack` is not: an adapter is allowed to know its own transport.
- **Architecture rules.** `@harness/surface-web` adds **one `PACKAGES` row** and **one `WORKSPACE_DIRS` entry** to `.dependency-cruiser.cjs`, exactly as that file's "HOW A NEW PACKAGE IS ADDED" note says (Task 4). Task 8 adds **two** rules and nothing else: `no-kernel-package-imports-the-platform` and `catalog-imports-kernel-contracts-only`. `a-surface-imports-only-api-and-shared` is not weakened: `surfaces/web` imports `@harness/surface-api`, `@harness/shared`, itself and `node:` built-ins, and **its own tests are not exempt either**. `the-host-never-statically-imports-a-plugin` is not weakened: the host reaches the web adapter through the `SurfaceSession` objects its pool already holds, never through an import, and the one host test that drives it is a `*.test.ts`, which that rule exempts.
- **No new third-party dependency anywhere.** `@harness/surface-web` declares `@harness/surface-api` and `@harness/shared` and the three devDependencies every package has, and nothing else: its JSON parsing is `JSON.parse` behind hand-written checks (the shape `MemorySurface`'s door already uses), its framing is string concatenation, and its bearer compare is `node:crypto`. `@harness/config-postgres` already declares `@harness/db` and so already has `encrypt`, `decrypt` and `loadKey`. `pnpm install` adds one workspace link and no registry package.
- **The published set does not change.** The seven publishable packages are `@harness/shared`, `@harness/pack-api`, `@harness/config-api`, `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api` and `@harness/sandbox-api`, and `scripts/src/domain/packaging.test.ts` asserts that list against the manifests. **`@harness/surface-web` is an adapter and declares `"private": true`**, like every other adapter, or that test fails the moment the package lands — `publicPackageNames()` in `scripts/src/domain/workspace.test-helpers.ts` filters on `private !== true`. It carries `"version": "0.1.0"`, because the same test asserts one version across the whole workspace. The `SecretSource` contract and its conformance kit ship inside `@harness/config-api` and its existing `./testing` subpath, so **no new published package and no new published subpath** is created; nothing in `publishConfig`, `files` or `tsconfig.build.json` changes anywhere.
- **No backwards compatibility (spec decision 2b).** No shim, no dual code path, no "still works" clause, no deprecation comment. `assertSecretsPresent` is replaced, not kept beside `resolveSecrets`; `SurfaceDeps.secrets` is renamed to `secretValues` rather than carried alongside it. Every task lists the files and symbols it **deletes**, and the deletion happens in that task.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **No test sleeps longer than 200 ms**, and no test waits for a real interval. A listening test binds `127.0.0.1:0` and reads the port off the socket; `waitFor(ready, timeoutMs)` in `harness/host/src/testing.ts` is the polling helper, and it is what a test uses to wait for a turn that an acknowledged request started asynchronously. A stream test reads the frames it is waiting for off the response body rather than sleeping until they must have arrived.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up`, `pnpm db:down` or `pnpm demo:up` from a task.** `docker compose ... config` is read-only and is what `pnpm surface:record` and `surface.test.ts` already use. `docker build` is not run from a task either.
- Do not push from a task. Do not open a pull request from a task. Do not create a tag and do not bump a version: the version bump and the tag are the user's, after this plan's pull request merges.
- **The platform's transplant has landed.** Decision 1b as amended puts `catalog/`, `control-plane/`, `apps/workspace/` and `deploy/` in this repository, and the platform session's pull request (#16) merged into `main` while this plan was being written; this branch carries it as of `eb21dc6`. So `catalog/` and `control-plane/` exist and are workspace packages, `pnpm arch` cruises both, and `.dependency-cruiser.cjs` already holds four boundary rules the transplant wrote. **Only Task 8 is affected**, and it is now a check-and-close-the-gap task rather than a write-the-rules one; its first step is to merge `main` again in case it has moved. Every other task touches only `harness/`, `surfaces/`, `docs/` and the root `.env.example`, none of which the transplant's own work owns. Two things every task inherits from it: `pnpm arch` now cruises two more trees, so a gate that was green before it is not automatically green after it, and `publicPackageNames()` now expands `catalog` and `control-plane` — both of which declare `"private": true` at `0.1.0`, which is why `packaging.test.ts` still sees exactly seven public packages.

---

## Facts verified for this plan

Read out of this worktree (`worktree-plan-11c-platform-seams` at `690b370`) or run in a scratch on 2026-09-21. What follows is what a task below depends on, re-verified where a mistake would cost a task its gates. Spec §12's constraints 11–24 were each checked against the code; the ones this plan leans on are re-stated here with where they were read.

### The seam as Plan 11b left it

| Fact | Value | Where |
|---|---|---|
| `SurfaceHttpRequest` has exactly four members | `method`, `path`, `headers` (lower-cased, folded), `body` (raw UTF-8 text) | `harness/surface-api/src/types.ts` |
| `SurfaceHttpResponse` has exactly four | `status`, `headers?`, `body?: string`, `refusal?: { reason }` | same |
| `send()` is buffered in both directions | `res.writeHead(response.status, { 'content-type': 'text/plain; charset=utf-8', ...headers }); res.end(response.body ?? '')` | `harness/host/src/domain/api/surfaces.ts` |
| The refusal audit row is written **before** `send` | `if (response.refusal) { await auditRefusal(...); log.warn(...) } send(res, response)` | same |
| The host reads the whole body before calling `handle`, and answers 413 itself | `readBody` caps at `API_MAX_BODY_BYTES` = 1,048,576 and the 413 is written before the socket is destroyed | `domain/api/http.ts`, `surfaces.ts` |
| Every miss below `/tenants/` answers `404 {"error":"no such route"}` | four ways to miss, one answer; only the dedicated host's foreign-client refusal is audited | `surfaces.ts`, `noRoute` |
| A handler that throws is a 500 and **no** audit row | `pool.log.error(...)` then `json(res, 500, { error: 'surface failure' })` | same |
| `assertMounts` refuses a bad path and two overlapping mounts, at tenant open | called from `buildTenant` right after `loadSurfaces` | `surfaces.ts`, `tenancy/tenant.ts` |
| `MemorySurface` is the reference door and is **off** until `mountHttp()` | `surfaces/memory` never calls it, pinned by a case in `surfaces/memory/src/index.test.ts` | `harness/surface-api/src/testing.ts` |
| `MemorySurface.settled()` awaits the deliveries a door acknowledged | a `Set<Promise<void>>` that each delivery removes itself from | same |
| `sseStream` in the host writes `202` and three anti-buffering headers and an unref'd keep-alive | `text/event-stream`, `cache-control: no-cache`, `x-accel-buffering: no`; `res.on('close')` stops it | `harness/host/src/domain/api/sse.ts` |
| The run API's own stream already listens for `res.on('close')` | which is where this plan's `AbortSignal` comes from | same |
| Three files construct a `SurfaceHttpRequest` literal | `harness/surface-api/src/http.test.ts` (`post()` helper), `surfaces/slack/src/transport/events.test.ts` (`signed()` helper plus **three** bare literals, at lines 74, 91 and 116), and `harness/host/src/domain/api/surfaces.ts` (the host itself) | grep, 2026-09-21 |
| The two literals at `events.test.ts` lines 96 and 101 spread `wrong`, which is `signed(body)` | so they inherit the two new fields and need no edit | that file |
| Five assertions read `response.body` as a string | `events.test.ts` lines 85, 118, 131, 277, 433 and `http.test.ts` line 89 | grep, 2026-09-21 |

### Configuration, secrets and tenancy as they stand

| Fact | Value | Where |
|---|---|---|
| `SecretRefShape` is `{ env } \| { ref }`, strict, with `ENV_NAME` and `SECRET_NAME` patterns | landed in `486c0a4` | `harness/config-api/src/document.ts` |
| `SURFACE_ORDER` is `['web', 'slack', 'memory', 'http']`, web first | same commit | same |
| `SurfacesShape.web` is `{ token: SecretRef }`, strict, optional — **and has no `inbox`** | the field this plan adds is one line | same |
| `tenantKeysOf` branches on `slack` and `memory.workspace` **only** | `web` contributes no key today, which on a pooled host would have every web message refused for a null hint | same, and `document.test.ts` asserts the two cases |
| `surfaceSecretsOf` already reports `web.token` | `[{ surface: 'web', field: 'token', ref: 'web-token' }]`, asserted whole | `document.test.ts` |
| `assertSecretsPresent` refuses **every** `{ ref }`, and runs **after** `buildKernelConfig` | its message is `client "<id>" names the secret "<name>" for <surface>.<field>, and this deployment has no secret source` | `harness/host/src/domain/tenancy/tenant.ts` |
| The settings loop just below it filters to `'env' in ref` with a comment saying the other case already threw | both halves change together | same |
| `SurfaceDeps.secrets` is field → **environment variable name**, and `slackConfig` looks the name up | `requiredEnv(secrets.botToken ?? 'SLACK_BOT_TOKEN', …, env)` | `harness/surface-api/src/types.ts`, `surfaces/slack/src/config.ts` |
| `SurfaceSettings` is `{ tenantKey?; secrets? }` and `loadSurfaces` splices it in by surface name | `Object.hasOwn(settings, surface.name)`, own keys only | `harness/approvals/src/domain/surfaces/registry.ts` |
| `configSourceNameFrom` validates against a `SOURCES` tuple with **no default** and `loadConfigSource` dynamic-imports the implementation | the shape `secretSourceNameFrom` / `loadSecretSource` copy line for line | `harness/core-tools/src/domain/config/registry.ts` |
| `HostDeps` is `{ db, env, log, now, source, dedicatedClient }` and `HostPool extends HostDeps` | so a secret source added there reaches `buildTenant` through the pool | `harness/host/src/domain/tenancy/types.ts` |
| `pool.close()` closes the config source (`deps.source.close?.()`) | the secret source is closed in the same place | `harness/host/src/domain/tenancy/pool.ts` |
| `poolFixture(db, opts)` builds `env` itself and carries nothing ambient | `HARNESS_STORAGE_DIR`, `HARNESS_ENCRYPTION_KEY` (32 bytes of `7`, base64), `LITELLM_MASTER_KEY`, then `opts.env` | `harness/host/src/testing.ts` |
| `pool.tenantFor` calls `session.start()` on every surface after the tenant is built | which is why a test may not declare `slack`: `eventsTransport.start()` calls `auth.test` over the network | `pool.ts`, `surfaces/slack/src/transport/events.ts` |
| `buildKernelConfig(document, env)` has exactly **two** callers | `harness/host/src/domain/tenancy/tenant.ts` and `harness/core-tools/src/app/server.ts` (`buildDepsFromEnv`) | grep, 2026-09-21 |
| `main.test.ts` spawns the stdio entrypoint with `env: { ...process.env, … }` and seven explicit names | `DATABASE_URL`, `HARNESS_ENCRYPTION_KEY`, `HARNESS_CONFIG_SOURCE`, `HARNESS_CLIENTS_DIR`, `HARNESS_CLIENT`, `HARNESS_PRINCIPAL`, `HARNESS_STORAGE_DIR`. The spread does not save a new required variable: nothing sets `HARNESS_SECRET_SOURCE` on a CI runner, so it has to be added explicitly | `harness/core-tools/src/app/main.test.ts:60` |
| `gatewayFromEnv(env)` reads `LITELLM_MASTER_KEY` through `requiredEnv` and returns `{ baseUrl, apiKey, timeoutMs, maxCallsPerRun }` | `httpGateway` sends `config.apiKey` as the bearer on every call | `harness/core-tools/src/domain/models/gateway.ts` |
| `RoutingFile` is **not** `.strict()`, unlike `RouteSpec` | an unknown key under `routing:` is silently stripped today | `harness/config-api/src/routing.ts` |
| `parseIdentityFileWithDefaults` refuses only `UNDEFAULTABLE_SURFACE = 'http'`, and the defaults key pattern is `SURFACE_NAME_PATTERN` | so `defaults.web` already parses, and invariant 24's ceiling is new code | `harness/identity-api/src/principals.ts` |
| `levelAtLeast` is exported from `@harness/identity-api` and `USER_LEVELS` from `@harness/shared` | what the ceiling compares against | `identity-api`, `shared/levels.ts` |

### The envelope, measured

| Fact | Value | Where |
|---|---|---|
| `encrypt` is AES-256-GCM, IV 12 random bytes, tag 16, no AAD, blob `iv \|\| tag \|\| ciphertext` | `loadKey` requires `HARNESS_ENCRYPTION_KEY` to decode to exactly 32 bytes | `harness/db/src/shared/crypto.ts` |
| **The spec's test vector is exact.** Key `BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=`, IV `030303030303030303030303`, plaintext `xoxb-test-secret` | produced `03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78`, and decrypting that blob returned the plaintext | run with `node -e` against `node:crypto`, 2026-09-21 |
| `bytea` is a `customType` in the schema and maps to `Buffer` in both directions | `export const bytea = customType<{ data: Buffer; driverData: Buffer }>` | `harness/db/src/domain/schema.ts` |
| The latest migration is `0014_thick_spitfire`, journal index 14 | so this plan's is `0015_<whatever drizzle-kit names it>` | `harness/db/drizzle/`, `meta/_journal.json` |
| `primaryKey` is **not** yet imported in `schema.ts` | the composite primary key needs it added to the `drizzle-orm/pg-core` import list | that file |
| `resetDatabase` truncates nineteen tables by name | a new table not on that list keeps rows between cases | `harness/db/src/testing.ts` |

### The run API and its reads

| Fact | Value | Where |
|---|---|---|
| The route table today | `GET /v1/status`, `GET /v1/usage`, `POST /v1/runs`, `POST /v1/runs/:id/cancel`, `GET /v1/threads/:id`; anything else is 404 `no such route` | `harness/host/src/domain/api/routes.ts` |
| `/v1/*` resolves its tenant from `x-harness-client` through `pool.resolver` then `pool.tenantFor`, and an unresolved tenant is `404 {"error":"no such client"}` | which is what the two new routes copy exactly | same |
| `/v1/usage` answers `{ client, from, to, rows }` and takes no cursor | the new routes answer `{ client, rows, next_cursor }` instead | `routes.ts`, `usage.ts` |
| `usage.test.ts` asserts the row's column list **whole**, with a comment saying why | the shape invariant 23's tests copy | `harness/host/src/domain/api/usage.test.ts` |
| `approvals` columns | `id, client, action, payload, payload_encrypted, summary, requested_by, status, decided_by, decided_at, decision_note, executed_at, expires_at, idempotency_key, surface, conversation_id, message_ref, thread_id, claimed_at, created_at` | `harness/db/src/domain/schema.ts` |
| `memory_entries` columns | `id, client, scope, principal_id, text, created_by, thread_id, created_at` | same |
| `listMemory` orders `asc(created_at), asc(id)` and filters by `visibleTo(client, principalId)` | the read route keeps the order and drops the principal filter, which is why it is not `memory_list` | `harness/core-tools/src/domain/memory/repository.ts` |
| Route-level tests live in `server.test.ts` over a real pool and a real listener; `routes.test.ts` holds the two unit helpers | `api(trajectory)` builds a dedicated host at port 0 | `harness/host/src/domain/api/server.test.ts` |

### The write contract

| Fact | Value | Where |
|---|---|---|
| `writeClientDocument` upserts the live row and `onConflictDoNothing`s the history row, in one `withTransaction` | so a rewritten version moves the document and keeps the old history, silently | `harness/config-postgres/src/source.ts` |
| `client_document_versions` has `uniqueIndex(client_id, version)` | which is the conflict target the refusal hangs on | `schema.ts` |
| `configSourceConformance` already asserts that an identical rewrite is a no-op | "Stable under a re-write too: the same content is the same version" | `harness/config-api/src/testing.ts` |
| The `files` harness returns a **derived** version from `put`, the `postgres` and memory harnesses return the one they were handed | which is how a new conformance case can skip the source that cannot express it | `config-files/src/source.test.ts`, `config-postgres/src/source.test.ts`, `config-api/src/testing.test.ts` |

### The monorepo boundary

| Fact | Value | Where |
|---|---|---|
| **The transplant is on this branch.** `eb21dc6` merges `origin/main`, which carries pull request #16 | `catalog/` and `control-plane/` exist; `apps/` and `deploy/` do not yet | `git log`, 2026-09-21 |
| `pnpm arch`'s globs now cruise the two platform trees as well as the kernel's | `… 'scripts/src/**/*.ts' 'catalog/src/**/*.ts' 'control-plane/src/**/*.ts'` | root `package.json` |
| `pnpm-workspace.yaml` lists `catalog` and `control-plane`, and both manifests are `"private": true` at `0.1.0` | so `publicPackageNames()` expands them and `packaging.test.ts` still sees exactly the seven published names | those files |
| **Four boundary rules already exist**, written by the transplant | `kernel-never-imports-the-platform`, `catalog-imports-kernel-contracts-only`, `control-plane-imports-catalog-and-contracts-only`, `workspace-imports-only-the-control-plane-client` | `.dependency-cruiser.cjs`, `PLATFORM_BOUNDARY_RULES` |
| **The kernel's ban names three of the four directories** | `to: { path: '^(catalog\|control-plane\|apps)/' }` — `deploy/` is missing, and decision 1b names four | same, read 2026-09-21 |
| **depcruise fails on a glob whose parent directory does not exist.** `depcruise 'catalog/src/**/*.ts' …` printed `ERROR: ENOENT: no such file or directory, scandir …/catalog/src` before the merge | so a glob is added when a directory arrives and not before, which is what Task 8's third case asserts | run 2026-09-21 |
| dependency-cruiser follows the dependencies of the modules it cruises (`doNotFollow` is `node_modules` only) | so the kernel's ban fires on a kernel file that imports `deploy/` even though nothing cruises that tree | `.dependency-cruiser.cjs`, options |
| The lint ceiling is still exactly **25 warnings, 0 errors**, with the transplant in | `pnpm lint` printed `✖ 25 problems (0 errors, 25 warnings)` | run 2026-09-21 |
| `.env.example` gained `CONTROL_PLANE_TEST_DATABASE_URL` with the transplant | documented but read by no kernel source, so the one-directional scan is unaffected; Task 8 says why it stays | that file |
| The vocabulary scan's roots are an explicit `SCANNED` list with a `minFiles` floor each, resolved against `repoRoot` | it walks no directory it was not given, so the platform's are outside it by construction | `harness/core-tools/src/kernel-vocabulary.test.ts` |
| The environment scan's roots are `SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts']`, walked from the repository root, and the constant is **not exported** | so a test that wants to pin the list has to export it first | `harness/core-tools/src/app/record-surface.ts` |
| `publicPackageNames()` expands `pnpm-workspace.yaml`'s globs and filters `private !== true` | a new package that forgot `"private": true` joins the published set and fails `packaging.test.ts` | `scripts/src/domain/workspace.test-helpers.ts` |

### Why no new dependency

| Candidate | Why not |
|---|---|
| An SSE library (`sse-channel`, `better-sse`) | The whole format is `id: <n>\nevent: <name>\ndata: <one line>\n\n`, with `: <text>\n\n` for a comment. The host already has one hand-written implementation for the run API, and the adapter's is thirty lines of string building plus a queue. A library here would own the one thing the adapter must keep — its own frame vocabulary. |
| An HTTP framework for the web surface's four routes | The adapter is handed a method, a sub-path, headers and a body by the seam. Routing four paths is a switch. A framework would want the socket, which the adapter never sees. |
| zod, for the three request bodies | `@harness/surface-web` would then carry a third-party dependency for three objects of four fields each, and the refusal messages have to be written by hand anyway — the spec fixes them. The memory door's `parseMemoryMessage` is the shape this follows, and its comment says the same thing: "deliberately not a zod schema; it is two strings". |
| A cursor library | A cursor is `base64url(<iso timestamp>|<uuid>)` and its decoder is eight lines with two failure modes, both of which are a 400. |
| `jose` or a token library for the bearer | The bearer is compared, not parsed: `timingSafeEqual` on two buffers after a length check, which is what `bearerOk` already does in the host and what the arch rule forbids the adapter from reusing. |

---

## Decisions where the spec leaves a detail open

The first eight are the controller's, recorded with the reasons a reviewer can check. Nine to fifteen are the places where following one of them exactly required a second choice this plan had to make.

1. **`resolveSecrets` lives in `@harness/config-api`, not in the host.** Spec §4.10 says `assertSecretsPresent` "becomes `resolveSecrets(document, source)`" and does not say where. It goes in `@harness/config-api/src/secrets.ts`, beside `SecretSource` and next to `surfaceSecretsOf`, for three reasons: it reads the typed document sections, which is exactly the work `tenantKeysOf` and `surfaceSecretsOf` exist to keep out of `harness/host/src`; it needs no type the host owns; and its result, `ResolvedSecrets`, has to be a parameter of `buildKernelConfig` in `@harness/core-tools` (§4.11), which cannot import the host but already imports `@harness/config-api`. The host calls it in `buildTenant` and stays free of every surface's field name.

2. **A refusal is composed: the caller names the site, the source supplies the clause.** `SecretSource.resolve(clientId, ref)` is fixed by the spec at two parameters, so a source cannot know that the ref it was handed is `web.token` — and the two refusal texts the spec quotes verbatim both name the surface and the field. So `resolveSecrets` writes the sentence and the source writes its tail: the `env` source raises `ConfigError('this deployment has no secret source')` for a `{ ref }` and `ConfigError('this deployment does not set it')` for an unset variable, and `resolveSecrets` produces `client "<id>" names the secret "<name>" for <surface>.<field>, and <tail>` or `client "<id>" declares the "<surface>" surface, which needs <NAME>; <tail>`. Both come out **byte-identical to the messages Task 1 and Plan 11a shipped**. Anything that is not a `ConfigError` is a driver or socket failure whose message may carry a statement fragment, so it is logged and replaced with `the "<source>" secret source failed` (invariant 21).

3. **The `env` implementation ships in `@harness/config-api` and is reached by a static import.** Spec §4.10 puts it there, and the package's arch rule allows it: it reads an `EnvSource` from `@harness/shared` and imports nothing else. `loadSecretSource` therefore reaches `envSecretSource` through the ordinary import this file already has, and dynamic-imports `@harness/config-postgres` the way `loadConfigSource` does — the dynamic import is there so that a process reading its secrets from the environment never loads a database driver, and there is nothing to defer for the source that is already in the bundle.

4. **`{ env }` means the environment under every source.** Spec §4.10 says so in as many words, so `envSecretValue(env, name)` is shared: `envSecretSource` is nothing but that function, and `postgresSecretSource` calls it for an `{ env }` ref before it ever looks at a row. A document that mixes the two — a stored bot token and a deployment-wide gateway URL — is the ordinary case.

5. **The web surface is told its inbox through one new optional field on `SurfaceDeps`.** `surfaces.web.inbox` is a document field and `SurfaceSession.defaultConversation` has to return it, and nothing in `SurfaceDeps` could carry it: `tenantKey` is the routing key and `secretValues` are credentials. So `@harness/config-api` gains `surfaceConversationsOf(document)` — the third member of the family `tenantKeysOf` and `surfaceSecretsOf` belong to, reading the typed section so the host never does — `SurfaceSettings` and `SurfaceDeps` each gain `defaultConversation?: string`, and the host copies an opaque string from one to the other. The alternative, an environment variable, is what Slack does for its approvals channel and is exactly wrong here: the inbox is per tenant and a pooled host has no place to put a per-tenant variable.

6. **The web surface's frames are five names, not four — and two of them carry more than one payload.** Spec §4.9 says "the event names are the surface's own — `delta`, `card`, `card_update`, `notice`". A reply that was not streamed has no `delta`, and a streamed one has no end: a client reading only those four cannot tell a finished answer from a pause. So the adapter also emits **`message`**, which is what `postText` sends and what a stream's `end()` sends after its deltas. Two names are then overloaded rather than multiplied: `card` carries `{ message, card }` or `{ form }`, because a form is opened from a card's button and belongs in the same place on the page, and `notice` carries a host's remark about a message, a private note for one person, or this surface's own dropped-frames warning. A client discriminates on a key, which is a thing it can only do if somebody wrote the keys down — so `WEB_EVENTS`' comment, the README and the runbook all list the eight payloads. The host learns none of it, and `kernel-vocabulary.test.ts` still finds none of these names under `harness/host/src`.

7. **`mention(userId)` answers `@<userId>`.** Spec §4.9 says it returns `@<displayName>` "where the principal has one", and nothing hands the adapter a principal: `SurfaceSession.mention` takes a user id and the request body the same section fixes carries no display name. Inventing a body field to make the sentence true would be inventing a contract; the honest answer is the one `surfaces/http` and `surfaces/memory` already give, and a display name reaches the workspace the way every other surface's does — through the identity plug-in, which is what renders it into the rules block. The README says so, and §13.6's open question about scoping the workspace's bearer is where a directory for this surface would be decided.

8. **The SSE retention window is per host, in memory, and capped at 200 frames per conversation.** Spec §13.5 leaves the window open and says it must be decided before the stream is written. Two hundred frames is minutes of a conversation and kilobytes per tenant; it is dropped when the tenant closes. The consequence is stated rather than hidden: a workspace behind an ingress with two hosts can resume only against the host it reconnects to, so a resume that lands elsewhere is answered with the dropped-frames notice the spec requires, which is exactly the signal the workspace needs. A durable window is a table and a write per delta, and it belongs to whichever plan decides the event feed (§13.5, Plan 12).

9. **The host's pipe is backpressure-aware, and the abort is the response's own `close`.** `send` writes the head, then for each chunk calls `res.write` and, when it answers false, waits for `drain` **or** for `close` — whichever comes first, so a client that disappears mid-write cannot leave a generator parked on a `drain` that will never fire. The same `close` aborts the `AbortController` whose signal the request carried, which is what stops the producer. A mid-stream throw is logged the way a throwing `handle` already is and the response is ended; there is no error frame, because the frame vocabulary is the adapter's.

10. **A refusal is decided before the first byte, and the code says so.** The host audits `response.refusal` and *then* calls `send`, which is already the order; this plan adds a comment at that line saying that once the head is written there is no refusal left to declare, and a test that a streaming answer with a `refusal` still writes exactly one row before any chunk. Invariant 20 is therefore unaffected by streaming, which is the claim §4.9 makes.

11. **The gateway key is resolved into `GatewayConfig.apiKey`, and `buildKernelConfig`'s third parameter is required.** Spec §4.11 says every caller changes. The stdio server is the second caller, so `buildDepsFromEnv` builds a secret source of its own and resolves the document's secrets before it builds the config — which makes `HARNESS_SECRET_SOURCE` required for that process too, exactly as `HARNESS_CONFIG_SOURCE` already is. `main.test.ts`'s four spawns set it, and `.env.example` says which processes read it.

12. **The gateway key is proved on `model_calls` through `callModel`, not through a turn.** Spec §9 asks for "a turn each against a fake gateway that records the bearer it was sent". A turn under the scripted runtime makes no model call at all — that is what makes the runtime scriptable — so a turn would prove nothing. The test opens two tenants in one pool, builds each tenant's own run deps from its own `KernelConfig` with `depsForRun`, and calls `callModel` against a fake gateway on `127.0.0.1:0` that records the `authorization` header it was sent. That is the exact path a tool's model call takes, it writes the `model_calls` rows the invariant is about, and it fails if either tenant's key leaks into the other's call.

13. **`RoutingFile` becomes strict in the same commit that adds `routing.gateway`.** Spec §12 constraint 21 rules it. Only `routes` and `defaults` are written anywhere in this repository and `@harness/gateway`'s renderer reads those two, so nothing breaks; what it buys is that `gatway:` is a refusal at load rather than a tenant quietly spending the process key.

14. **The two read routes take a `limit` and refuse one they cannot serve.** Spec §4.12 says `limit` "defaults to 100 and is capped". A silently clamped limit is a caller who believes they have the whole page; a 400 naming the bound is a caller who fixes their query. So `limit` defaults to 100, may be 1 to 500, and anything else — a fraction, a zero, a word, 501 — is a `400` naming the bound, which is how the usage route already treats a window it will not serve.

15. **Invariant 21's "after a run" grep lives in Task 4, not Task 3.** The invariant has two halves: a resolved secret never appears anywhere, and a tenant's `{ ref }` reaches only its own rows. Task 3 proves the second half against the real store and proves the first half over every refusal, error and log line the resolution path produces. The grep over `audit_log` and the host log *after a turn* needs a tenant that both carries a secret and can be opened in a test, and in Task 3 there is no such thing: the only surfaces with secrets are `slack`, whose `start()` calls `auth.test` over the network the moment a pooled host opens it, and `web`, whose package does not exist until Task 4. Task 4 runs the grep, with a stored bearer, a real open and a real turn.

---

## Not in this plan

Listed so a reviewer can see they were considered and left out on purpose.

- **Everything in Plan 12:** Jev and typed model access behind the gateway seam, `correlation` on runs, `GET /v1/events` and its webhook sink, declared MCP and A2A plug-ins, and the `execute` action class. The web surface's SSE stream is **not** the event feed — one is a conversation on one surface, the other is every outcome of a tenant — and they stay separate contracts even though they now share the streaming seam.
- **A durable SSE window.** Decision 8 above; §13.5 is the open question and it belongs with the feed.
- **Rotating a secret without reopening a tenant.** §4.10's rule is a contract on the writer — pair a rotation with a version bump — and §13.8 lists the three mechanisms that would replace it. None is built here.
- **`list` on `SecretSource`.** §4.10 leaves it off and §13.7 records the cost. A host resolves what a document names and never enumerates.
- **Publishing `@harness/config-postgres`.** Decision 21 rules it stays private; §6's table contract is the promise instead, and Task 7 is what makes that promise true for the one rule the code did not keep.
- **The platform's own directories.** The transplant has landed, and no task here writes a line inside `catalog/`, `control-plane/` or a directory that does not yet exist. Task 8 closes one gap in the ban and pins the two scans; it adds no glob for `apps/` or `deploy/`, because depcruise fails outright on a glob whose parent is not there.
- **A Teams surface and an Entra identity plug-in**, and **a sandbox implementation**: §25 leaves all three where Plan 11b left them.
- **The 11a and 11b follow-ups**, every one of them: the pooled-host drain gap on an acknowledged-but-not-active delivery, backoff on a repeated `auth.test`, clock injection, `stop()` recall, the publishing polish list (no `license`, no `main`/`types` fallback, no `engines`, the packed manifest's devDependencies), amd64-only images, and `gh release edit` overwriting a hand-edited body. None of them is a seam the platform is waiting on, and folding them in would make this plan's pull request unreviewable.
- **A `decided` alias on `GET /v1/approvals?status=`.** §4.12's review ruling: the filter vocabulary is the column's own four values, and a second spelling of one fact is how a dashboard starts disagreeing with a database.

---

## File structure

Paths are relative to the repository root.

### Task 1 — the schema (already merged, `486c0a4`)

`harness/config-api/src/document.ts` + `document.test.ts`, `harness/config-api/src/index.ts`, `harness/host/src/domain/tenancy/tenant.ts`. No task below re-does any of it.

### The streaming seam (Task 2)

| File | Responsibility |
|---|---|
| `harness/surface-api/src/types.ts` | `SurfaceHttpRequest.clientId`, `.signal`; `SurfaceHttpResponse.body: string \| AsyncIterable<string>` |
| `harness/surface-api/src/testing.ts` | `MemorySurface`'s event stream: `emit`, `breakStreams`, `openStreams`, `frames`, the `events` sub-path, `bodyText` |
| `harness/surface-api/src/http.test.ts` | the request helper's two new fields, and the five stream cases |
| `harness/surface-api/README.md` | what a streaming door is |
| `harness/host/src/domain/api/surfaces.ts` | `send` pipes an iterable; the abort controller; `clientId` on the request |
| `harness/host/src/domain/api/surfaces.test.ts` | chunks as they are yielded, the end, the throw, the disconnect, the client id |
| `harness/host/src/testing.ts` | `poolFixture` takes a `log` |
| `harness/config-api/src/document.ts` + `document.test.ts` | `tenantKeysOf` gains `web` → the document's own id |
| `surfaces/slack/src/transport/events.test.ts` | the `signed()` helper and two bare literals gain the two fields; five body reads go through `bodyText` |

### Secrets from a store (Task 3)

`harness/config-api/src/types.ts`, `src/secrets.ts` (**new**) + `secrets.test.ts` (**new**), `src/testing.ts`, `src/testing.test.ts`, `src/index.ts`; `harness/config-postgres/src/secrets.ts` (**new**) + `secrets.test.ts` (**new**), `src/index.ts`, `package.json`; `harness/db/src/domain/schema.ts`, `harness/db/drizzle/0015_*.sql` + `meta/` (**generated**), `harness/db/src/testing.ts`; `harness/core-tools/src/domain/config/registry.ts` + `registry.test.ts`, `src/index.ts`; `harness/host/src/domain/tenancy/types.ts`, `tenant.ts`, `tenant.test.ts`, `pool.ts`, `src/app/main.ts`, `src/testing.ts`, `src/domain/tenancy/secrets.test.ts` (**new**); `harness/approvals/src/domain/surfaces/registry.ts`; `harness/surface-api/src/types.ts`; `surfaces/slack/src/index.ts`, `src/config.ts`, `src/index.test.ts`; `.env.example`; `harness/compose/docker-compose.yml`; `docs/architecture/compose-surface.yaml` (**re-recorded**).

### The web surface (Task 4)

`surfaces/web/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/deps.ts`, `src/config.ts`, `src/stream.ts`, `src/door.ts`, `src/session.ts`, `src/index.ts`, `src/stream.test.ts`, `src/door.test.ts`, `src/index.test.ts` (all **new**); `.dependency-cruiser.cjs`; `harness/approvals/package.json`; `harness/host/package.json`; `pnpm-lock.yaml`; `harness/config-api/src/document.ts` (`inbox`, `surfaceConversationsOf`) + `document.test.ts` + `src/index.ts`; `harness/surface-api/src/types.ts` (`SurfaceDeps.defaultConversation`); `harness/approvals/src/domain/surfaces/registry.ts` (`SurfaceSettings.defaultConversation`); `harness/host/src/domain/tenancy/tenant.ts`; `harness/identity-api/src/principals.ts` + `principals.test.ts` (invariant 24); `harness/host/src/domain/api/web-surface.test.ts` (**new**).

### The per-tenant gateway key (Task 5)

`harness/config-api/src/secret-ref.ts` (**new**, `SecretRefShape` moved out of `document.ts` so `routing.ts` can hold it without a cycle), `src/document.ts`, `src/index.ts`, `src/routing.ts` + `routing.test.ts`, `src/secrets.ts` + `secrets.test.ts`, `src/types.ts`; `harness/core-tools/src/domain/tooling/config.ts` + `config.test.ts`, `src/domain/models/gateway.ts` + `gateway.test.ts`, `src/app/server.ts`, `src/app/main.test.ts`; `harness/host/src/domain/tenancy/tenant.ts`, `src/domain/tenancy/gateway-key.test.ts` (**new**).

### Run API reads (Task 6)

`harness/host/src/domain/api/reads.ts` (**new**) + `reads.test.ts` (**new**), `domain/api/routes.ts`, `domain/api/types.ts`, `domain/api/server.test.ts`, `src/index.ts`.

### The write contract (Task 7)

`harness/config-postgres/src/source.ts` + `source.test.ts`; `harness/config-api/src/testing.ts` (the conformance case) + `testing.test.ts`; `docs/runbook.md` (the client store as a write contract).

### The boundary the platform lands inside (Task 8)

`.dependency-cruiser.cjs` (one alternation gains `deploy`); `harness/core-tools/src/kernel-vocabulary.test.ts` (the comment and one case); `harness/core-tools/src/app/record-surface.ts` (export `SOURCE_ROOTS`) + `app/surface.test.ts` (one case); `scripts/src/domain/boundaries.test.ts` (**new**); `runtimes/deepagents/src/domain/run.test.ts` (one case's abort, which is this plan's one unrelated repair).

### Documentation (Task 9)

`docs/runbook.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `CHANGELOG.md`, `harness/surface-api/README.md`, `harness/config-api/README.md`, `harness/config-postgres/README.md`, `harness/host/README.md`, `surfaces/web/README.md`, `surfaces/memory/README.md`, `docs/architecture/graph.svg`.

## Task order

Strictly sequential.

- **Task 2** (the streaming seam) first: Task 4 cannot write an SSE door on a buffered response, and Task 4's tenant hint needs `tenantKeysOf`'s web entry.
- **Task 3** (`SecretSource`, the one migration, `secretValues`) before Task 4, which needs a stored bearer resolved into `deps.secretValues`, and before Task 5, which adds one line to `resolveSecrets`.
- **Task 4** (`surfaces/web`) before Task 5 and Task 6 only by convenience — neither depends on it — but after Task 3, which it needs.
- **Task 5** (the gateway key, `RoutingFile` strict, `buildKernelConfig`'s third parameter) after Task 3, whose `ResolvedSecrets` it extends.
- **Task 6** (the read routes) is independent of 2–5 and runs here so its route additions land on a `routes.ts` nothing else is editing.
- **Task 7** (the version-rewrite refusal and its runbook section) is independent of everything above.
- **Task 8** (the fourth platform directory, and the tests that pin the two scans) after Task 4, which adds the last `PACKAGES` row, so the two edits to `.dependency-cruiser.cjs` do not collide. It merges `main` first, because the platform's side of the same boundary is being written in the same repository.
- **Task 9** (documentation) last. No code.

Every task leaves `docs/architecture/tool-surface.json` byte-identical. **Only Task 3 touches `docs/architecture/compose-surface.yaml`**, and it re-records it with `pnpm surface:record`; every other task leaves it byte-identical, and `git status --short docs/architecture` is the check.

---

## Tasks

### Task 1: The schema — a web surface, a store-backed secret reference, and web first in the order (**done**, `486c0a4`)

Merged as pull request #15 on 2026-09-21, before this plan was written, so that the platform session could link `@harness/config-api` while the rest of 11c was still being specified. It is listed here because six tasks below build on it and a reader of this plan should not have to go looking for what already exists.

What it shipped, in `harness/config-api/src/document.ts` and `harness/host/src/domain/tenancy/tenant.ts`:

- `SecretRefShape = { env: NAME } | { ref: name }`, a strict union with `ENV_NAME = /^[A-Z][A-Z0-9_]*$/` and `SECRET_NAME = /^[a-z][a-z0-9-]*$/`, exported with its inferred `SecretRef` type.
- `SurfacesShape.web = { token: SecretRef }`, strict and optional.
- `SURFACE_ORDER = ['web', 'slack', 'memory', 'http']` — web **first**, so a document that declares `web` and `http` has `web` as its primary and its approval cards have somewhere to go.
- `surfaceSecretsOf` reports `{ surface: 'web', field: 'token', ... }` ahead of Slack's two.
- `assertSecretsPresent` refuses every `{ ref }` at tenant open, with the message Task 3 keeps verbatim.

**Nothing in this task is re-planned below.** Task 2 changes `tenantKeysOf`, which Task 1 deliberately left alone; Task 3 replaces `assertSecretsPresent`; Task 4 adds `inbox` to `SurfacesShape.web`.

---

### Task 2: The streaming seam — a door can answer with a stream, and the memory surface is its reference

**Files:**
- Modify: `harness/surface-api/src/types.ts` (`SurfaceHttpRequest.clientId`, `.signal`; `SurfaceHttpResponse.body`)
- Modify: `harness/surface-api/src/testing.ts` (`MEMORY_EVENTS_SUBPATH`, `MEMORY_FRAME_RETENTION`, `MemoryFrame`, `emit`, `breakStreams`, `frames`, `openStreams`, the stream, `bodyText`)
- Modify: `harness/surface-api/src/http.test.ts` (the request helper, eight new cases)
- Modify: `harness/surface-api/README.md`
- Modify: `harness/host/src/domain/api/surfaces.ts` (`send` pipes; the abort controller; `clientId`)
- Modify: `harness/host/src/domain/api/surfaces.test.ts` (five new cases)
- Modify: `harness/host/src/testing.ts` (`poolFixture` takes a `log`)
- Modify: `harness/config-api/src/document.ts` (`tenantKeysOf` gains `web`)
- Modify: `harness/config-api/src/document.test.ts` (the case for it)
- Modify: `surfaces/slack/src/transport/events.test.ts` (the two new request fields; five body reads)
- Delete: nothing.

**Interfaces:**
- Produces:
  - `SurfaceHttpRequest` = `{ method: string; path: string; headers: Readonly<Record<string, string>>; body: string; clientId: string; signal: AbortSignal }`
  - `SurfaceHttpResponse.body?: string | AsyncIterable<string>`
  - `MemorySurface.emit(event: string, data: unknown): void`, `.breakStreams(message: string): void`, `.frames: MemoryFrame[]`, `.openStreams: number`
  - `MEMORY_EVENTS_SUBPATH = 'events'`, `MEMORY_FRAME_RETENTION = 50`, `interface MemoryFrame { id: number; event: string; data: unknown }`
  - `bodyText(response: SurfaceHttpResponse): Promise<string>` in `@harness/surface-api/testing`
  - `tenantKeysOf` returns `{ surface: 'web', key: document.id }` for a document that declares one
- Consumes: `HostPool`, `ServerResponse`, `AbortController` (`node:` globals only).

- [ ] **Step 1: Write the failing test for the contract half**

Replace the `post` helper at the top of `harness/surface-api/src/http.test.ts` — every existing case goes through it, and the two new fields are what make the file compile against the widened request:

```ts
const post = (body: string, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: '',
  headers: { 'content-type': 'application/json' },
  body,
  // The tenant the host resolved from `/tenants/<clientId>/…` a moment before it called the
  // handler, and a signal it aborts when the caller hangs up. Both are request-scoped, which is
  // why they are on the request rather than on `SurfaceDeps`.
  clientId: 'fixture',
  signal: new AbortController().signal,
  ...over,
});
```

Extend that file's imports:

```ts
import { describe, expect, it } from 'vitest';
import { SURFACE_HTTP_PATH_PATTERN, SURFACE_REFUSAL_REASON_PATTERN } from './models.js';
import { MEMORY_EVENTS_SUBPATH, MEMORY_FRAME_RETENTION, MemorySurface, bodyText } from './testing.js';
import type { MessageEvent, SurfaceHttpRequest } from './types.js';
```

and add this block at the end of the file, after the existing `describe('the memory surface as an HTTP door', …)`:

```ts
describe('the memory surface as a streaming door', () => {
  /** A door with its stream open, and the controller that plays the client hanging up. */
  const opened = async (
    over: Partial<SurfaceHttpRequest> = {},
  ): Promise<{ surface: MemorySurface; chunks: AsyncIterator<string>; hangUp: () => void }> => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const client = new AbortController();
    const response = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, signal: client.signal, ...over }),
    );
    expect(response.status).toBe(200);
    expect(response.headers).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const body = response.body;
    if (typeof body !== 'object') throw new Error('the events sub-path must answer with a stream');
    return { surface, chunks: body[Symbol.asyncIterator](), hangUp: () => client.abort() };
  };

  it('answers the events sub-path with a stream and the message sub-path with a body', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const message = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hi' })));
    expect(typeof message.body).toBe('string');
    const events = await surface.http!.handle(post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH }));
    expect(typeof events.body).toBe('object');
  });

  it('refuses a method the stream does not serve, and says which one it does', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post('', { path: MEMORY_EVENTS_SUBPATH }));
    expect(response.status).toBe(405);
    expect(response.headers).toEqual({ allow: 'GET' });
    // No refusal: a wrong method on a route that exists is a caller's mistake, not a door turning
    // somebody away, and it costs no audit row.
    expect(response.refusal).toBeUndefined();
  });

  it('yields one frame per emit, with a monotonic id, and waits between them', async () => {
    const { surface, chunks } = await opened();
    // Pulled before anything is emitted: the generator is parked, which is the property that
    // makes a stream a stream rather than a buffer read at the end.
    const first = chunks.next();
    surface.emit('note', { n: 1 });
    expect((await first).value).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
    surface.emit('note', { n: 2 });
    expect((await chunks.next()).value).toBe('id: 2\nevent: note\ndata: {"n":2}\n\n');
  });

  it('resumes after the id a client reports, repeating nothing it already had', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    surface.emit('note', { n: 1 });
    surface.emit('note', { n: 2 });
    surface.emit('note', { n: 3 });
    const response = await surface.http!.handle(
      // Lower-cased, because the host lower-cases every header name before an adapter sees one.
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, headers: { 'last-event-id': '2' } }),
    );
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    expect((await chunks.next()).value).toBe('id: 3\nevent: note\ndata: {"n":3}\n\n');
  });

  it('starts from what it still holds when a resume asks for a frame it has dropped', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    for (let n = 1; n <= MEMORY_FRAME_RETENTION + 5; n += 1) surface.emit('note', { n });
    expect(surface.frames).toHaveLength(MEMORY_FRAME_RETENTION);
    const response = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, headers: { 'last-event-id': '1' } }),
    );
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    // The oldest it still has, not the one that was asked for. Saying so to the *client* is the
    // web surface's job (spec 4.9); this door is the seam's reference and keeps no vocabulary.
    expect((await chunks.next()).value).toBe('id: 6\nevent: note\ndata: {"n":6}\n\n');
  });

  it('ends the stream when the request is aborted, and lets the producer go', async () => {
    const { surface, chunks, hangUp } = await opened();
    // Pulled before the count is read: an async generator's body — and so `openStreams += 1` —
    // does not run until the first `next()`. Asserting first would read zero and prove nothing.
    const parked = chunks.next();
    expect(surface.openStreams).toBe(1);
    hangUp();
    expect((await parked).done).toBe(true);
    expect(surface.openStreams).toBe(0);
  });

  it('throws out of the stream when the producer fails, rather than ending it quietly', async () => {
    const { surface, chunks } = await opened();
    const parked = chunks.next();
    surface.breakStreams('the producer gave up');
    await expect(parked).rejects.toThrow('the producer gave up');
    expect(surface.openStreams).toBe(0);
  });

  it('collects either shape of body, which is what a test of a door needs', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    expect(await bodyText(await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hi' }))))).toBe(
      '{"ok":true}',
    );
    surface.emit('note', { n: 1 });
    const stream = await surface.http!.handle(
      post('', { method: 'GET', path: MEMORY_EVENTS_SUBPATH, signal: AbortSignal.abort() }),
    );
    // An already-aborted request: the stream yields what it holds and ends, so `bodyText` returns
    // rather than parking. A test that collected a live stream would never return, and this is
    // the one shape of that call which terminates.
    expect(await bodyText(stream)).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-api exec vitest run src/http.test.ts`
Expected: FAIL — `MEMORY_EVENTS_SUBPATH`, `MEMORY_FRAME_RETENTION` and `bodyText` are not exported from `./testing.js`, and `clientId` and `signal` are not properties of `SurfaceHttpRequest`.

- [ ] **Step 3: Widen the two request fields and the response body**

In `harness/surface-api/src/types.ts`, add two members to `SurfaceHttpRequest`, after `body`:

```ts
  /**
   * The tenant this request is for: the client id the host resolved out of the mount path before
   * it called this handler.
   *
   * It is here rather than on `SurfaceDeps` because it is a property of the request and not of
   * the session — and because it is the one value that cannot be misconfigured. An adapter that
   * has to report which tenant an event belongs to reports this: it is what the host routed on a
   * moment earlier, so a document whose key and id drifted apart cannot make an adapter claim a
   * tenant the host did not route to.
   */
  clientId: string;
  /**
   * Aborted when the caller goes away.
   *
   * A handler that answers with a whole body may ignore it. One that answers with a stream selects
   * on it and returns, so a closed browser tab does not leave a producer pushing frames into a
   * socket nobody is reading. It is also aborted after an ordinary response has been sent, because
   * what the host listens for is the response closing; a handler that has already returned has
   * nothing left to cancel, so that costs nothing.
   */
  signal: AbortSignal;
```

and widen `SurfaceHttpResponse.body`:

```ts
  /**
   * The whole answer, or the answer as it is produced.
   *
   * A **string** is sent in one write and the response ends: an acknowledgement, a JSON body, a
   * challenge. An **async iterable of strings** is a stream: the host writes the head, writes each
   * chunk as it is yielded — waiting for the socket to drain, or for the client to go away — and
   * ends the response when the iterable ends. A chunk is opaque: the host does not know whether it
   * is a Server-Sent Events frame, a line of NDJSON or a fragment of a file, which is what keeps a
   * transport's framing inside the adapter that owns it.
   *
   * A throw out of the iterable is logged the way a throwing `handle` already is and closes the
   * response. There is **no error frame**, because the frame vocabulary is the adapter's: an
   * adapter that wants to tell its client something before it stops yields that something first.
   */
  body?: string | AsyncIterable<string>;
```

and add one paragraph to the end of the existing doc comment on `refusal`, which otherwise stays exactly as it is:

```
 * **A refusal is decided before the first byte.** The host reads this field, writes its one audit
 * row and then sends the head; once the head is written the response is a stream and there is
 * nothing left to declare. An adapter that discovers a problem mid-stream says so in its own
 * frames and ends.
```

- [ ] **Step 4: Give `MemorySurface` an event stream**

In `harness/surface-api/src/testing.ts`, add above the class:

```ts
/** Where this door's event stream lives, below whatever path `mountHttp` was given. */
export const MEMORY_EVENTS_SUBPATH = 'events';

/**
 * How many frames this door keeps for a client that reconnects with `last-event-id`.
 *
 * A reference implementation's window, not a product's: fifty frames is enough for a test to
 * prove that a resume repeats nothing and that a resume past the window starts from what is left,
 * which are the two behaviours the seam has to make possible. What a real adapter's window should
 * be is spec section 13.5.
 */
export const MEMORY_FRAME_RETENTION = 50;

/** One frame this door has sent, and can send again to a client that resumes. */
export interface MemoryFrame {
  id: number;
  event: string;
  data: unknown;
}

/** The wire form of a frame: the whole Server-Sent Events format, which is three lines. */
function frameText(frame: MemoryFrame): string {
  return `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
}
```

Add four fields to the class, beside `requests`:

```ts
  /** Every frame this door has emitted, oldest first, capped at `MEMORY_FRAME_RETENTION`. */
  readonly frames: MemoryFrame[] = [];
  /** How many event streams this door has open. A test asserts it falls back to zero. */
  openStreams = 0;

  private frameSeq = 0;
  /** The streams parked waiting for something to happen, so `emit` can wake them. */
  private readonly waiting = new Set<() => void>();
  /** Set by `breakStreams`: the next pull of every open stream throws this and clears it. */
  private streamFailure: string | null = null;
```

and these members after `settled()`:

```ts
  /**
   * Push one frame to every open stream, and remember it for a client that resumes.
   *
   * This is the door's outbound half. A real adapter emits a frame from its own `postText`,
   * `postCard` and stream handle; this one is driven by a test, because what the seam has to prove
   * is that a chunk reaches the socket when it is produced and not when the handler returns.
   */
  emit(event: string, data: unknown): void {
    this.frameSeq += 1;
    this.frames.push({ id: this.frameSeq, event, data });
    if (this.frames.length > MEMORY_FRAME_RETENTION) this.frames.shift();
    this.wake();
  }

  /**
   * Make the next pull of every open stream throw, the way a producer that failed does.
   *
   * The host's side of that is what this exists to drive: a throw mid-stream is logged and closes
   * the response, and there is no frame for it.
   */
  breakStreams(message: string): void {
    this.streamFailure = message;
    this.wake();
  }

  private wake(): void {
    // A copy, because a waiter removes itself from the set as it runs.
    for (const waiter of [...this.waiting]) waiter();
  }

  /**
   * Park until something happens: a frame, a failure, or the caller going away.
   *
   * The abort listener is removed on every path, so a long-lived signal does not accumulate one
   * listener per frame.
   */
  private async pause(signal: AbortSignal): Promise<void> {
    await new Promise<void>((resolve) => {
      const done = (): void => {
        this.waiting.delete(done);
        signal.removeEventListener('abort', done);
        resolve();
      };
      this.waiting.add(done);
      signal.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The frames after `last-event-id`, then whatever is emitted, until the caller goes away.
   *
   * A resume the window no longer covers starts from the oldest frame still held rather than
   * failing: the client asked to carry on, and the honest answer is "here is where I can carry on
   * from". Telling the client that frames were dropped is a vocabulary question and belongs to an
   * adapter that has one.
   */
  private async *eventStream(request: SurfaceHttpRequest): AsyncGenerator<string> {
    const asked = Number.parseInt(request.headers['last-event-id'] ?? '', 10);
    let sent = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
    this.openStreams += 1;
    try {
      for (;;) {
        const failure = this.streamFailure;
        if (failure !== null) {
          this.streamFailure = null;
          throw new Error(failure);
        }
        const next = this.frames.filter((frame) => frame.id > sent);
        if (next.length > 0) {
          for (const frame of next) {
            sent = frame.id;
            yield frameText(frame);
          }
          continue;
        }
        // The signal is checked **after** the backlog, not before it: a caller that has already
        // hung up still gets what the door was holding, and then the stream ends. Testing it
        // first would make an already-aborted request answer nothing at all, which is the one
        // shape of this call that has to terminate for a collector to be usable on it.
        if (request.signal.aborted) return;
        await this.pause(request.signal);
      }
    } finally {
      // `finally`, so an abort, a throw and a consumer that simply stops pulling all close it.
      this.openStreams -= 1;
    }
  }
```

Then extend `handleHttp` to route on the sub-path, keeping every existing answer exactly as it is:

```ts
  private async handleHttp(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> {
    this.requests.push(request);
    if (request.path === MEMORY_EVENTS_SUBPATH) {
      if (request.method !== 'GET') return { status: 405, headers: { allow: 'GET' } };
      return {
        status: 200,
        // The three headers that stop something in between buffering a stream into one response.
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        body: this.eventStream(request),
      };
    }
    if (request.method !== 'POST') return { status: 405, refusal: { reason: 'method_not_allowed' } };
    const message = parseMemoryMessage(request.body);
    // The refusal names the kind and nothing else: the body is not repeated, not summarised and
    // not logged, because a refused request is one nobody has authenticated.
    if (!message) return { status: 400, refusal: { reason: 'bad_request' } };
    // Acknowledge, then run. `say` rejects when no handler is registered, which is a race at
    // startup rather than a fault in the request, so it is swallowed here and the sender is told
    // the door took the message.
    const delivery = this.say(message.userId, message.text).catch(() => undefined);
    this.delivering.add(delivery);
    void delivery.finally(() => this.delivering.delete(delivery));
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  }
```

Finally, at the end of the file beside `parseMemoryMessage`, the collector every test of a door needs:

```ts
/**
 * A response body as text, whichever shape it is.
 *
 * A string comes back as itself; a stream is drained and joined. **Only call it on a stream that
 * ends** — an aborted request, or a producer that finishes — because a live event stream has no
 * end and this would wait for one. A test that wants to read a live stream pulls its iterator
 * frame by frame instead.
 */
export async function bodyText(response: SurfaceHttpResponse): Promise<string> {
  const body = response.body;
  if (body === undefined) return '';
  if (typeof body === 'string') return body;
  let text = '';
  for await (const chunk of body) text += chunk;
  return text;
}
```

- [ ] **Step 5: Run the contract half green**

Run:
```bash
pnpm --filter @harness/surface-api test
pnpm --filter @harness/surface-memory test
```
Expected: PASS — `http.test.ts`'s original nine cases and the eight new ones, and `surfaces/memory`'s own suite untouched, because the shipped wrapper still mounts no door.

- [ ] **Step 6: Write the failing test for the host half**

In `harness/host/src/domain/api/surfaces.test.ts`: add `MEMORY_EVENTS_SUBPATH` to the `@harness/surface-api/testing` import, extend `serve`'s options with a logger, and add the new describe block. **`Logger` needs no import** — line 9 of that file already reads `import { ConfigError, type Logger } from '@harness/shared';`, and a second import statement from the same module is a lint failure.

The options and the fixture call:

```ts
async function serve(opts: {
  documents: readonly ClientDocument[];
  trajectories?: Readonly<Record<string, Trajectory>>;
  dedicated?: string;
  token?: string;
  log?: Logger;
}): Promise<Served> {
  const f = await poolFixture(db, {
    documents: opts.documents,
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.dedicated === undefined ? {} : { dedicated: opts.dedicated }),
    ...(opts.log ? { log: opts.log } : {}),
  });
```

and the block, at the end of the file:

```ts
describe('a surface that answers with a stream', () => {
  /** One read off a live response, so a case can act while the producer is still running. */
  async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
    const { value, done } = await reader.read();
    return done ? '' : new TextDecoder().decode(value);
  }

  it('writes each chunk as it is yielded, rather than when the handler returns', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const surface = s.f.surface('alpha');
    const response = await s.get(`/tenants/alpha/messages/${MEMORY_EVENTS_SUBPATH}`);
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/event-stream');
    const reader = response.body!.getReader();
    // Emitted one at a time and read one at a time: if the host buffered, the first read would
    // not return until the producer ended, which it never does.
    surface.emit('note', { n: 1 });
    expect(await frame(reader)).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
    surface.emit('note', { n: 2 });
    expect(await frame(reader)).toBe('id: 2\nevent: note\ndata: {"n":2}\n\n');
    await reader.cancel();
  });

  it('hands the surface the client id it resolved from the path', async () => {
    const s = await serve({ documents: [documentFor('alpha'), documentFor('beta')] });
    await s.post('/tenants/beta/messages', message('hello'));
    expect(s.f.surface('beta').requests.at(-1)?.clientId).toBe('beta');
    expect(s.f.surface('alpha').requests).toEqual([]);
  });

  it('aborts the request signal when the caller hangs up, and the producer stops', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const surface = s.f.surface('alpha');
    const response = await s.get(`/tenants/alpha/messages/${MEMORY_EVENTS_SUBPATH}`);
    const reader = response.body!.getReader();
    surface.emit('note', { n: 1 });
    expect(await frame(reader)).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
    expect(surface.openStreams).toBe(1);
    await reader.cancel();
    // The host listens for the response closing and aborts the signal the request carried; the
    // producer selects on it and returns. Polled rather than slept on: the close arrives on the
    // server's tick, not on this one.
    await waitFor(() => surface.openStreams === 0);
  });

  it('closes the response when the producer throws, and says so once in the log', async () => {
    const lines: string[] = [];
    const s = await serve({
      documents: [documentFor('alpha')],
      log: { info() {}, warn() {}, error: (text: string) => lines.push(text) },
    });
    const surface = s.f.surface('alpha');
    const response = await s.get(`/tenants/alpha/messages/${MEMORY_EVENTS_SUBPATH}`);
    const reader = response.body!.getReader();
    surface.emit('note', { n: 1 });
    expect(await frame(reader)).toBe('id: 1\nevent: note\ndata: {"n":1}\n\n');
    surface.breakStreams('the producer gave up');
    // The stream ends rather than erroring at the client: the head said 200 long ago, so there is
    // no status left to change and no frame the host is entitled to invent.
    expect((await reader.read()).done).toBe(true);
    await waitFor(() => lines.length > 0);
    expect(lines[0]).toContain('alpha');
    expect(lines[0]).toContain('memory');
  });

  it('audits a refusal before it writes a byte, whatever shape the body would have been', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // The door streams on GET only. A POST to the events sub-path is a 405 with `allow`, which is
    // not a refusal: no row, and no stream opened.
    const response = await s.post(`/tenants/alpha/messages/${MEMORY_EVENTS_SUBPATH}`, message('hello'));
    expect(response.status).toBe(405);
    expect(response.headers.get('allow')).toBe('GET');
    expect(await refusals()).toEqual([]);
    expect(s.f.surface('alpha').openStreams).toBe(0);
    // And the refusal that *is* one still writes exactly one row, before anything reaches the
    // socket: the door refuses a body that is not a message.
    expect((await s.post('/tenants/alpha/messages', '{"userId":"U012"}')).status).toBe(400);
    expect(await refusals()).toHaveLength(1);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/api/surfaces.test.ts
```
Expected: FAIL — `poolFixture` has no `log` option, and the first streaming case hangs until vitest's timeout because `send` ends the response before the first frame is emitted.

- [ ] **Step 8: Let the fixture take a logger**

In `harness/host/src/testing.ts`, add the type import — the file imports no value from `@harness/shared` today, so the line is new:

```ts
import type { Logger } from '@harness/shared';
```

add one option to `poolFixture`:

```ts
    dedicated?: string;
    env?: Record<string, string | undefined>;
    /**
     * Where this pool's log lines go. Silent by default, which is what a suite wants; a case that
     * asserts on a line — a surface that failed mid-stream, a refusal nothing else records —
     * passes a collector.
     */
    log?: Logger;
```

and pass it through, replacing the inline literal:

```ts
  const pool = await createHost({
    db,
    env,
    log: opts.log ?? { info() {}, warn() {}, error() {} },
```

- [ ] **Step 9: Pipe the stream in the host**

In `harness/host/src/domain/api/surfaces.ts`, add `type Logger` to the existing `@harness/shared` import and replace `send` with these two functions:

```ts
/**
 * Wait for the socket to drain, or for the caller to go away — whichever comes first.
 *
 * `res.write` answers false when the kernel buffer is full, and a producer that ignored that
 * would hold the whole response in this process's memory for a client reading it slowly. Waiting
 * on `drain` alone is the trap on the other side: a client that disappears mid-write never
 * drains, and the generator would be parked forever. So both events settle it — and `close` is
 * also what aborts the request's signal, so the producer is already on its way out.
 */
async function drained(res: ServerResponse): Promise<void> {
  await new Promise<void>((resolve) => {
    const done = (): void => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.once('drain', done);
    res.once('close', done);
  });
}

/**
 * Send what the surface answered: a whole body, or a stream of chunks as they are produced.
 *
 * The head is written once, from the surface's own status and headers, and after that this
 * function copies bytes it does not read. A chunk is whatever the adapter yielded — a
 * Server-Sent Events frame, a line of NDJSON, a fragment of anything — which is what keeps a
 * transport's framing inside the adapter and out of this file.
 *
 * A throw out of the iterable ends the response with what has already been written. There is no
 * error frame and no status change: the status went out with the head, and inventing a frame here
 * would mean this file knew what the adapter's frames look like.
 */
async function send(res: ServerResponse, response: SurfaceHttpResponse, log: Logger, what: string): Promise<void> {
  // The surface's own headers win: it knows what it is answering. Plain text is the default
  // because an acknowledgement is usually empty and a body typed `application/json` that is not
  // JSON is worse than one typed as text.
  res.writeHead(response.status, { 'content-type': 'text/plain; charset=utf-8', ...(response.headers ?? {}) });
  const body = response.body;
  if (body === undefined || typeof body === 'string') {
    res.end(body ?? '');
    return;
  }
  try {
    for await (const chunk of body) {
      if (res.writableEnded || res.destroyed) break;
      if (!res.write(chunk)) await drained(res);
    }
  } catch (err) {
    log.error(`${what} failed mid-stream`, err);
  } finally {
    if (!res.writableEnded) res.end();
  }
}
```

In `handleSurfaceRequest`, build the controller before the handler is called, pass the two new fields, and await `send`. The `try`/`catch` around `handle` and the `auditRefusal` call keep their existing bodies; what changes is the request literal, one comment, and the last line:

```ts
  // The caller going away is the one thing a streaming handler has to be able to hear, and the
  // response's own `close` is where the host hears it. It fires for an ordinary answer too, after
  // that answer has been sent, which costs a handler that has already returned nothing.
  const hungUp = new AbortController();
  res.on('close', () => hungUp.abort());
  let response: SurfaceHttpResponse;
  try {
    response = await mount.http.handle({
      method,
      path: mount.subPath,
      headers: headersOf(req),
      // The bytes as they arrived, decoded as UTF-8 and not parsed: a surface that verifies a
      // signature computes it over exactly this.
      body: body.text,
      // The tenant this request resolved to, a few lines above. An adapter that reports which
      // workspace an event came from reports this one, and cannot disagree with the route the
      // request actually took.
      clientId: tenant.clientId,
      signal: hungUp.signal,
    });
  } catch (err) {
    // ... unchanged: one log line naming the tenant and the mount, then
    // json(res, 500, { error: 'surface failure' }) ...
  }
  if (response.refusal) {
    // Before the head, and that is the whole of invariant 20's ordering: once `send` has written
    // a status there is no refusal left to declare, whether the body is a string or a stream.
    await auditRefusal(pool.db, {
      client: tenant.clientId,
      asked,
      caller: `${mount.session.name}:request`,
      method,
      path,
      reason: response.refusal.reason,
    });
    pool.log.warn(`tenant ${tenant.clientId}: surface "${mount.session.name}" refused a request`);
  }
  await send(
    res,
    response,
    pool.log,
    `tenant ${tenant.clientId}: surface "${mount.session.name}" at "${mount.http.path}"`,
  );
```

- [ ] **Step 10: Give `tenantKeysOf` the web entry**

In `harness/config-api/src/document.ts`:

```ts
export function tenantKeysOf(document: ClientDocument): { surface: string; key: string }[] {
  const keys: { surface: string; key: string }[] = [];
  // A web tenant has no workspace but itself: the requests that reach it are addressed to its own
  // mount, so its own id is the key an inbound event's hint is matched against. Without this a
  // pooled host would refuse every web message for a null hint (`pooledResolver`) while a
  // dedicated one answered — the worst shape a bug can have, because a single-tenant suite would
  // stay green.
  if (document.surfaces.web) keys.push({ surface: 'web', key: document.id });
  if (document.surfaces.slack) keys.push({ surface: 'slack', key: document.surfaces.slack.teamId });
  if (document.surfaces.memory?.workspace) {
    keys.push({ surface: 'memory', key: document.surfaces.memory.workspace });
  }
  return keys;
}
```

and in `harness/config-api/src/document.test.ts`, extend the web case that already exists:

```ts
  it("names a web surface's token, as a store reference distinguishable from an environment one", () => {
    const withWeb = parseClientDocument(
      fixtureDocument({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {}, http: {} } }),
    );
    expect(surfaceSecretsOf(withWeb)).toEqual([{ surface: 'web', field: 'token', ref: 'web-token' }]);
    // Its own id is its tenant key: a web tenant's workspace is itself, and the host routes a
    // request to it by the client id in the mount path.
    expect(tenantKeysOf(withWeb)).toEqual([{ surface: 'web', key: 'fixture' }]);
  });
```

- [ ] **Step 11: Carry the two new fields through the Slack adapter's tests**

`surfaces/slack/src/transport/events.test.ts` builds request literals; the adapter itself needs no change at all, because it reads `method`, `path`, `headers` and `body` and nothing else.

The `signed` helper gains the two fields:

```ts
/** A signed request, as the host would hand one over. */
function signed(body: string, contentType = 'application/json', over: Record<string, string> = {}) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  return {
    method: 'POST',
    path: '',
    headers: {
      'content-type': contentType,
      'x-slack-request-timestamp': timestamp,
      'x-slack-signature': signRequest(SECRET, timestamp, body),
      ...over,
    },
    body,
    // What the host resolved from the mount path, and the signal it aborts when the caller goes
    // away. This transport reads neither — it answers whole bodies — and they are here because
    // the seam requires them.
    clientId: 'fixture',
    signal: new AbortController().signal,
  };
}
```

The three bare literals gain the same two fields. At line 74:

```ts
    const response = await t.http!.handle({
      method: 'GET',
      path: '',
      headers: {},
      body: '',
      clientId: 'fixture',
      signal: new AbortController().signal,
    });
```

at line 91, which is a named local rather than an inline argument:

```ts
    const unsigned = {
      method: 'POST',
      path: '',
      headers: { 'content-type': 'application/json' },
      body,
      clientId: 'fixture',
      signal: new AbortController().signal,
    };
```

and at line 116:

```ts
    const response = await t.http!.handle({
      method: 'POST',
      path: '',
      headers: {},
      body,
      clientId: 'fixture',
      signal: new AbortController().signal,
    });
```

The two literals at lines 96 and 101 spread `wrong`, which is `signed(body)`, so they inherit both
fields and are left alone.

Then the five reads of `response.body` go through the collector, because the field is no longer a string to the type checker. Add `import { bodyText } from '@harness/surface-api/testing';` and rewrite each; all five sit in an `async` test, so `await` needs no other change:

| Line | Was | Becomes |
|---|---|---|
| 85 | `expect(JSON.parse(response.body ?? '{}')).toEqual({ challenge: 'c-123' })` | `expect(JSON.parse(await bodyText(response))).toEqual({ challenge: 'c-123' })` |
| 118 | `expect(response.body ?? '').not.toContain('a-secret-sentence')` | `expect(await bodyText(response)).not.toContain('a-secret-sentence')` |
| 131 | as line 85 | as line 85 |
| 277 | `expect(response.body ?? '').toBe('')` | `expect(await bodyText(response)).toBe('')` |
| 433 | as line 85 | as line 85 |

- [ ] **Step 12: Run the four suites green**

Run:
```bash
pnpm --filter @harness/surface-api test
pnpm --filter @harness/config-api test
pnpm --filter @harness/surface-slack test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test pnpm --filter @harness/host test
```
Expected: PASS — `surfaces.test.ts`'s existing nine cases plus five, `http.test.ts`'s nine plus eight, and `events.test.ts` unchanged in behaviour.

- [ ] **Step 13: Update the package README**

In `harness/surface-api/README.md`, add a subsection under the existing "Being reached by a request", matching that file's heading level and voice:

```markdown
### Answering with a stream

`SurfaceHttpResponse.body` is a string **or** an async iterable of strings. A string is sent in one
write and the response ends. An iterable is a stream: the host writes the head, writes each chunk
as it is yielded — waiting for the socket to drain, or for the client to go away — and ends the
response when the iterable ends. A chunk is opaque to the host, so an adapter keeps every byte of
its own framing: Server-Sent Events, NDJSON, anything.

Two request fields exist for it. `signal` is aborted when the caller goes away, and a producer
selects on it and returns rather than pushing frames into a dead socket. `clientId` is the tenant
the host resolved from the mount path, which is what an adapter reports as an event's
`tenantHint`: it cannot disagree with the route the request actually took.

A **refusal is decided before the first byte**. The host reads `refusal`, writes its one audit row
and then writes the head; after that the response is a stream and there is nothing left to
declare. An adapter that discovers a problem mid-stream says so in its own frames and ends. A
throw out of the iterable is logged and closes the response, with no error frame — the vocabulary
is the adapter's, not the host's.

`MemorySurface`'s door is the reference: `POST <mount>` takes a message, and
`GET <mount>/events` answers a stream with `id:` on every frame and honours `last-event-id`. It
answers `200` where a real adapter may prefer `202` — `@harness/surface-web` does, and so does the
run API's own stream, because "accepted, and what follows is the thing happening" is the truer
reading. The seam fixes neither: the status is the adapter's, like every other byte of its answer.
```

- [ ] **Step 14: Run the four gates**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder \
  pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && \
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder pnpm test
```
Expected: all green, at most 25 lint warnings. `git status --short docs/architecture` is empty.

- [ ] **Step 15: Commit**

The plan document itself is untracked at the start of this task and lands with this pull request, so it is committed here, once, rather than being carried by whichever task happens to touch `docs/`.

```
git add harness/surface-api harness/host/src harness/config-api/src surfaces/slack/src/transport/events.test.ts docs/superpowers/plans/2026-09-21-plan-11c-platform-seams.md
git commit -m "feat(surface-api): let a door answer with a stream and hear the caller hang up"
```

---

### Task 3: Secrets from a store — a `SecretSource`, one migration, and values instead of variable names

**Files:**
- Modify: `harness/config-api/src/types.ts` (`SecretSource`, `ResolvedSecrets`)
- Create: `harness/config-api/src/secrets.ts` + `harness/config-api/src/secrets.test.ts`
- Modify: `harness/config-api/src/testing.ts` (`MemorySecretSource`, `SecretSourceHarness`, `secretSourceConformance`, the two conformance constants)
- Modify: `harness/config-api/src/testing.test.ts` (run the suite over the memory source)
- Modify: `harness/config-api/src/index.ts` (exports)
- Create: `harness/config-postgres/src/secrets.ts` + `harness/config-postgres/src/secrets.test.ts`
- Modify: `harness/config-postgres/src/index.ts` (exports)
- Modify: `harness/db/src/domain/schema.ts` (`clientSecrets`, and `primaryKey` in the import)
- Create: `harness/db/drizzle/0015_<generated>.sql` and its `meta/` entries (**by `drizzle-kit generate`, never by hand**)
- Modify: `harness/db/src/testing.ts` (the truncation list)
- Modify: `harness/core-tools/src/domain/config/registry.ts` (`SECRET_SOURCES`, `secretSourceNameFrom`, `loadSecretSource`)
- Modify: `harness/core-tools/src/domain/config/registry.test.ts` (the cases for both)
- Modify: `harness/core-tools/src/index.ts` (exports)
- Modify: `harness/surface-api/src/types.ts` (`SurfaceDeps.secrets` → `secretValues`)
- Modify: `harness/approvals/src/domain/surfaces/registry.ts` (`SurfaceSettings.secrets` → `secretValues`; **no test in that package changes** — `registry.test.ts`'s `secrets: []` is `Surface.secrets`, the array of variable names, which this rename does not touch, and `dual-surface.test.ts` mentions neither)
- Modify: `harness/host/src/domain/tenancy/types.ts` (`HostDeps.secrets`)
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (`assertSecretsPresent` **deleted**; `resolveSecrets` before `buildKernelConfig`)
- Modify: `harness/host/src/domain/tenancy/pool.ts` (close the secret source)
- Modify: `harness/host/src/app/main.ts` (build it)
- Modify: `harness/host/src/testing.ts` (`poolFixture` takes `secrets`, defaulting to the environment source)
- Modify: `harness/host/src/domain/tenancy/tenant.test.ts` (one `describe` renamed; its assertion is unchanged — Step 17)
- Create: `harness/host/src/domain/tenancy/secrets.test.ts`
- Modify: `surfaces/slack/src/index.ts`, `surfaces/slack/src/config.ts`, `surfaces/slack/src/index.test.ts`
- Modify: `.env.example`, `harness/compose/docker-compose.yml`
- Re-record: `docs/architecture/compose-surface.yaml`
- Delete: `assertSecretsPresent` and its two refusal branches; the `if (!('env' in ref)) continue` guard in `buildTenant`; `SurfaceDeps.secrets`; `SurfaceSettings.secrets`.

**Interfaces:**
- Produces:
  - `interface SecretSource { readonly name: string; resolve(clientId: string, ref: SecretRef): Promise<string>; close?(): Promise<void> }`
  - `interface ResolvedSecrets { readonly surfaces: Readonly<Record<string, Readonly<Record<string, string>>>> }`
  - `envSecretValue(env: EnvSource, name: string): string`, `envSecretSource(env: EnvSource): SecretSource`
  - `resolveSecrets(document: ClientDocument, deps: { source: SecretSource; log: Logger }): Promise<ResolvedSecrets>`
  - `MemorySecretSource`, `SecretSourceHarness`, `secretSourceConformance(makeSource)`, `CONFORMANCE_SECRET_VARIABLE`, `CONFORMANCE_SECRET_VALUE`
  - `postgresSecretSource({ db, env, log }): SecretSource`, `writeClientSecret(db, { clientId, name, value }, key: Buffer): Promise<void>`
  - `clientSecrets` table; `secretSourceNameFrom(env)`, `loadSecretSource(name, deps)`
  - `SurfaceDeps.secretValues?: Readonly<Record<string, string>>`, `SurfaceSettings.secretValues?`, `HostDeps.secrets: SecretSource`
- Consumes: `surfaceSecretsOf`, `SecretRef` (Task 1); `encrypt`, `decrypt`, `loadKey`, `bytea` (`@harness/db`).

- [ ] **Step 1: Write the failing contract test**

Create `harness/config-api/src/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from './document.js';
import { envSecretSource, envSecretValue, resolveSecrets } from './secrets.js';
import { MemorySecretSource, fixtureDocument } from './testing.js';

const log = { info() {}, warn() {}, error() {} };

/** A document that names one secret per shape, so one call exercises both branches. */
const withSecrets = (over: Record<string, unknown>) => parseClientDocument(fixtureDocument(over));

describe('envSecretValue', () => {
  it('answers what the environment holds, and refuses what it does not', () => {
    expect(envSecretValue({ WEB_TOKEN: 'tok' }, 'WEB_TOKEN')).toBe('tok');
    // Empty is unset, the rule every other reader in this repository follows: a half-filled .env
    // must not start a process that fails later and further from the cause.
    for (const env of [{}, { WEB_TOKEN: '' }, { WEB_TOKEN: '   ' }]) {
      expect(() => envSecretValue(env, 'WEB_TOKEN')).toThrow(ConfigError);
    }
  });
});

describe('the env secret source', () => {
  it('is named for what HARNESS_SECRET_SOURCE calls it', () => {
    expect(envSecretSource({}).name).toBe('env');
  });

  it('resolves an environment reference and refuses a store reference', async () => {
    const source = envSecretSource({ WEB_TOKEN: 'tok' });
    expect(await source.resolve('alpha', { env: 'WEB_TOKEN' })).toBe('tok');
    await expect(source.resolve('alpha', { ref: 'web-token' })).rejects.toThrow(ConfigError);
  });
});

describe('resolveSecrets', () => {
  it('answers a map keyed by surface and by the document’s own field name', async () => {
    const document = withSecrets({
      surfaces: {
        slack: {
          teamId: 'T0ABCDEF',
          signingSecret: { env: 'TENANT_A_SIGNING' },
          botToken: { env: 'TENANT_A_BOT' },
        },
      },
    });
    const source = envSecretSource({ TENANT_A_SIGNING: 'sig', TENANT_A_BOT: 'xoxb' });
    expect(await resolveSecrets(document, { source, log })).toEqual({
      surfaces: { slack: { signingSecret: 'sig', botToken: 'xoxb' } },
    });
  });

  it('answers an empty map for a document that names no secret at all', async () => {
    expect(await resolveSecrets(withSecrets({}), { source: envSecretSource({}), log })).toEqual({ surfaces: {} });
  });

  it('refuses a store reference under the env source, in the words a deployment already knows', async () => {
    const document = withSecrets({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } });
    await expect(resolveSecrets(document, { source: envSecretSource({}), log })).rejects.toThrow(
      'client "fixture" names the secret "web-token" for web.token, and this deployment has no secret source',
    );
  });

  it('refuses an environment reference this deployment does not set, naming the surface and the variable', async () => {
    const document = withSecrets({ surfaces: { web: { token: { env: 'WEB_TOKEN' } }, memory: {} } });
    await expect(resolveSecrets(document, { source: envSecretSource({}), log })).rejects.toThrow(
      'client "fixture" declares the "web" surface, which needs WEB_TOKEN; this deployment does not set it',
    );
  });

  it('resolves a store reference through a source that has a store, and keeps two tenants apart', async () => {
    const source = new MemorySecretSource();
    source.put('alpha', 'web-token', 'tok-alpha');
    source.put('beta', 'web-token', 'tok-beta');
    const document = (id: string) =>
      parseClientDocument(
        fixtureDocument({ id, displayName: id, surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } }),
      );
    expect(await resolveSecrets(document('alpha'), { source, log })).toEqual({
      surfaces: { web: { token: 'tok-alpha' } },
    });
    expect(await resolveSecrets(document('beta'), { source, log })).toEqual({
      surfaces: { web: { token: 'tok-beta' } },
    });
  });

  it('never repeats a value, and never repeats what a broken source said (invariant 21)', async () => {
    const lines: unknown[] = [];
    const broken = {
      name: 'broken',
      resolve: async (): Promise<string> => {
        throw new Error('select "ciphertext" from "client_secrets" failed near tok-alpha');
      },
    };
    const document = withSecrets({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {} } });
    const failure = await resolveSecrets(document, {
      source: broken,
      log: { info() {}, warn() {}, error: (...args: unknown[]) => lines.push(args) },
    }).catch((err: unknown) => err as Error);
    // The client and the secret's name, and after that only this source's own name. A driver's
    // message can carry a fragment of a statement and a statement can carry a value, so anything
    // that is not a ConfigError goes to the log and never into a message somebody stores.
    expect(failure.message).toContain('"web-token"');
    expect(failure.message).toContain('the "broken" secret source failed');
    expect(failure.message).not.toContain('tok-alpha');
    expect(failure.message).not.toContain('client_secrets');
    expect(lines).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/config-api exec vitest run src/secrets.test.ts`
Expected: FAIL — `./secrets.js` does not exist and `MemorySecretSource` is not exported from `./testing.js`.

- [ ] **Step 3: Declare the contract**

In `harness/config-api/src/types.ts`, add after `ConfigSource` — and add `SecretRef` to the type import at the top of that file, which today imports only `ClientDocument` from `./document.js`:

```ts
/**
 * Where a secret comes from.
 *
 * Two methods and no `list`, deliberately: a host resolves what a document names and never
 * enumerates, and the platform's control plane owns the store and lists it with its own SQL (spec
 * section 13.7). `name` is what `HARNESS_SECRET_SOURCE` calls this implementation.
 *
 * `resolve` answers the secret's **value**. It raises a `ConfigError` whose message is a clause
 * about the *reference* — "this deployment does not set it", "this deployment's secret store
 * holds no such secret for that client" — and never the value, never the row and never a
 * statement: `resolveSecrets` puts the client, the surface and the field in front of that clause,
 * because the signature here deliberately does not carry them. Anything that is not a
 * `ConfigError` is treated as a source that broke rather than a secret that is missing.
 *
 * Every implementation runs `secretSourceConformance` from `@harness/config-api/testing`, which
 * is what keeps "a source" one thing rather than two.
 */
export interface SecretSource {
  /** Lowercase, stable: `env`, `postgres`. What `HARNESS_SECRET_SOURCE` names. */
  readonly name: string;
  resolve(clientId: string, ref: SecretRef): Promise<string>;
  close?(): Promise<void>;
}

/**
 * Every secret one client's document names, resolved to its value.
 *
 * Keyed by surface, then by the document's own field name — `{ slack: { botToken: 'xoxb-…' } }` —
 * which is the shape `SurfaceDeps.secretValues` carries and the reason the host can hand an
 * adapter its credentials without knowing what any of them are called.
 *
 * **Values, not names.** The bag `Plan 11b` shipped carried environment variable names, and a
 * `{ ref }` has no variable name to carry; the rename from `secrets` to `secretValues` on every
 * site is what stops a reader from looking a value up as though it were a name.
 */
export interface ResolvedSecrets {
  readonly surfaces: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
```

- [ ] **Step 4: Write the `env` source and the resolver**

Create `harness/config-api/src/secrets.ts`:

```ts
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
    resolve: async (_clientId, ref) => {
      if ('ref' in ref) throw new ConfigError('this deployment has no secret source');
      return envSecretValue(env, ref.env);
    },
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
    const value = await resolveAt(document.id, surfaceSite(ref), 'env' in ref ? { env: ref.env } : { ref: ref.ref }, deps);
    surfaces[ref.surface] = { ...surfaces[ref.surface], [ref.field]: value };
  }
  return { surfaces };
}
```

`SurfaceSecretRef` is `{ surface; field } & SecretRef`, so the ref handed to `resolveAt` is narrowed back to the bare union on the way in: an object carrying `surface` and `field` would still satisfy `SecretRef` structurally, and passing it would hand a source two fields the contract does not promise it.

- [ ] **Step 5: Ship the memory source and the conformance suite**

In `harness/config-api/src/testing.ts`, add to the imports `import { envSecretValue } from './secrets.js';`, `import type { SecretSource } from './types.js';` and `ConfigError` (already imported), then add at the end of the file:

```ts
/**
 * The variable every secret-source harness sets, so the suite can prove the `{ env }` path
 * without guessing a name a particular implementation happens to know.
 *
 * A plain constant rather than a `requiredEnv` call, deliberately: the environment scan in
 * `record-surface.ts` reads helper call sites, and a literal here would put a name in
 * `.env.example` that no deployment sets.
 */
export const CONFORMANCE_SECRET_VARIABLE = 'HARNESS_CONFORMANCE_SECRET';
export const CONFORMANCE_SECRET_VALUE = 'conformance-environment-value';

/** A store over secrets already in hand: the one every kernel test drives. */
export class MemorySecretSource implements SecretSource {
  readonly name = 'memory';
  closed = false;

  private readonly values = new Map<string, string>();
  private readonly env: Readonly<Record<string, string | undefined>>;

  constructor(env: Readonly<Record<string, string | undefined>> = { [CONFORMANCE_SECRET_VARIABLE]: CONFORMANCE_SECRET_VALUE }) {
    this.env = env;
  }

  /** Store one tenant's secret. The key is the pair, which is the isolation. */
  put(clientId: string, name: string, value: string): void {
    this.values.set(`${clientId}:${name}`, value);
  }

  async resolve(clientId: string, ref: { env: string } | { ref: string }): Promise<string> {
    if ('env' in ref) return envSecretValue(this.env, ref.env);
    const value = this.values.get(`${clientId}:${ref.ref}`);
    if (value === undefined) throw new ConfigError('this source holds no such secret for that client');
    return value;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** What a secret-source implementation hands the conformance suite so it can drive it. */
export interface SecretSourceHarness {
  source: SecretSource;
  /**
   * Store a secret, for a source that has a store.
   *
   * **Absent for a source that has only the environment**, which is how the suite tells the two
   * apart: the same shape `configSourceConformance` uses for `list`. A source with no `put` is
   * asserted to refuse every `{ ref }`; one with a `put` is asserted to resolve its own tenant's
   * and no other's.
   */
  put?(clientId: string, name: string, value: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * The suite every `SecretSource` runs, so that "a source" is one thing rather than two.
 *
 * `makeSource` is called fresh for each case and its `close` is awaited afterwards, so a case
 * that fails does not leave a connection behind for the next one. The harness's source must
 * resolve `CONFORMANCE_SECRET_VARIABLE` from whatever environment it was built over.
 */
export function secretSourceConformance(makeSource: () => Promise<SecretSourceHarness>): void {
  const withSource = async (body: (harness: SecretSourceHarness) => Promise<void>): Promise<void> => {
    const harness = await makeSource();
    try {
      await body(harness);
    } finally {
      await harness.close();
    }
  };

  describe('SecretSource conformance', () => {
    it('is named in lowercase, which is what HARNESS_SECRET_SOURCE matches', async () => {
      await withSource(async ({ source }) => {
        expect(source.name).toMatch(/^[a-z][a-z0-9-]*$/);
      });
    });

    it('resolves an environment reference, whichever source it is', async () => {
      await withSource(async ({ source }) => {
        expect(await source.resolve('alpha', { env: CONFORMANCE_SECRET_VARIABLE })).toBe(CONFORMANCE_SECRET_VALUE);
      });
    });

    it('refuses an environment reference this deployment does not set', async () => {
      await withSource(async ({ source }) => {
        await expect(source.resolve('alpha', { env: 'HARNESS_CONFORMANCE_UNSET' })).rejects.toThrow(ConfigError);
      });
    });

    it('refuses a store reference it does not hold, without naming the row or the store', async () => {
      await withSource(async ({ source }) => {
        const failure = await source.resolve('alpha', { ref: 'nobody' }).catch((err: unknown) => err as Error);
        expect(failure).toBeInstanceOf(ConfigError);
        // The message is a clause about the reference. The client, the surface and the field are
        // the caller's to add (`resolveSecrets`), and the value is nobody's to repeat.
        expect(failure.message).not.toContain('alpha');
      });
    });

    it('keeps two tenants apart under one secret name, when it has a store at all', async () => {
      await withSource(async (harness) => {
        if (!harness.put) {
          // A source with only the environment refuses every store reference, which is the whole
          // of its behaviour on this path and is asserted above.
          return;
        }
        await harness.put('alpha', 'web-token', 'tok-alpha');
        await harness.put('beta', 'web-token', 'tok-beta');
        expect(await harness.source.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
        expect(await harness.source.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
        // And a tenant that stored nothing reaches neither (invariant 21).
        await expect(harness.source.resolve('gamma', { ref: 'web-token' })).rejects.toThrow(ConfigError);
      });
    });

    it('answers the value it was given back, byte for byte', async () => {
      await withSource(async (harness) => {
        if (!harness.put) return;
        // A bot token, a bearer and a key are all opaque bytes; a source that trimmed or
        // re-encoded one would break the credential without failing anything.
        const value = '  xoxb-with spaces and ünicode \n';
        await harness.put('alpha', 'odd', value);
        expect(await harness.source.resolve('alpha', { ref: 'odd' })).toBe(value);
      });
    });
  });
}
```

and in `harness/config-api/src/testing.test.ts`, run it:

```ts
secretSourceConformance(async () => {
  const source = new MemorySecretSource();
  return {
    source,
    put: async (clientId, name, value) => {
      source.put(clientId, name, value);
    },
    close: async () => {
      await source.close();
    },
  };
});
```

with `MemorySecretSource` and `secretSourceConformance` added to that file's import from `./testing.js`.

- [ ] **Step 6: Export the contract**

In `harness/config-api/src/index.ts`, add the secrets module and the two types:

```ts
export { envSecretSource, envSecretValue, resolveSecrets } from './secrets.js';
```

and extend the `./types.js` export list, keeping it alphabetical: `ResolvedSecrets` and `SecretSource` join `Blueprint`, `ConfigSource`, `JsonPatch`, `LoadedDocument`, `Overlay` and `PatchOp`.

- [ ] **Step 7: Run the contract half green**

Run: `pnpm --filter @harness/config-api test`
Expected: PASS — `secrets.test.ts`'s nine cases and the conformance suite's six over the memory source, beside the existing document, resolve, playbooks, routing and config-source suites.

- [ ] **Step 8: Write the failing store test**

Create `harness/config-postgres/src/secrets.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// No `type Db`: `useTestDb()` hands one back and nothing here writes the type out. An unused
// import is a lint error, not a warning.
import { clientSecrets, decrypt, encrypt, loadKey } from '@harness/db';
import { useTestDb } from '@harness/db/testing';
import { ConfigError } from '@harness/shared';
import {
  CONFORMANCE_SECRET_VALUE,
  CONFORMANCE_SECRET_VARIABLE,
  secretSourceConformance,
} from '@harness/config-api/testing';
import { postgresSecretSource, writeClientSecret } from './secrets.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

/** The deployment key every case here encrypts and decrypts with: 32 bytes, base64. */
const KEY_B64 = Buffer.alloc(32, 7).toString('base64');
const env = { HARNESS_ENCRYPTION_KEY: KEY_B64, [CONFORMANCE_SECRET_VARIABLE]: CONFORMANCE_SECRET_VALUE };

secretSourceConformance(async () => ({
  source: postgresSecretSource({ db, env, log }),
  put: async (clientId, name, value) => {
    await writeClientSecret(db, { clientId, name, value }, loadKey(env));
  },
  close: async () => {},
}));

describe('the envelope', () => {
  /**
   * The vector spec section 4.10 fixes, both ways.
   *
   * It is a test rather than a comment because the platform's control plane encrypts with its own
   * code, in its own language, and only a vector proves the two agree. The IV is injected by
   * building the blob by hand; `encrypt` picks a random one, which is why the round trip below is
   * the half that exercises the shipped function.
   */
  const KEY = Buffer.from('BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=', 'base64');
  const BLOB = '03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78';

  it('decrypts the vector to the plaintext the spec names', () => {
    expect(decrypt(Buffer.from(BLOB, 'hex'), KEY)).toBe('xoxb-test-secret');
  });

  it('round-trips through the shipped pair, with the blob laid out iv || tag || ciphertext', () => {
    const blob = encrypt('xoxb-test-secret', KEY);
    expect(blob).toHaveLength(12 + 16 + 'xoxb-test-secret'.length);
    expect(decrypt(blob, KEY)).toBe('xoxb-test-secret');
  });

  it('stores the raw envelope in the column, not text and not base64', async () => {
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' }, loadKey(env));
    const [row] = await db.select().from(clientSecrets);
    expect(Buffer.isBuffer(row.ciphertext)).toBe(true);
    expect(row.ciphertext.toString('utf8')).not.toContain('tok-alpha');
    expect(decrypt(row.ciphertext, loadKey(env))).toBe('tok-alpha');
  });
});

describe('postgresSecretSource', () => {
  it('reads only the rows of the client it was asked about (invariant 21)', async () => {
    const key = loadKey(env);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' }, key);
    await writeClientSecret(db, { clientId: 'beta', name: 'web-token', value: 'tok-beta' }, key);
    const source = postgresSecretSource({ db, env, log });
    expect(await source.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
    expect(await source.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
  });

  it('rewrites a secret in place, so a rotation is one row and not two', async () => {
    const key = loadKey(env);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'first' }, key);
    await writeClientSecret(db, { clientId: 'alpha', name: 'web-token', value: 'second' }, key);
    expect(await db.select().from(clientSecrets)).toHaveLength(1);
    expect(await postgresSecretSource({ db, env, log }).resolve('alpha', { ref: 'web-token' })).toBe('second');
  });

  it('refuses a value the deployment key cannot open, without repeating the ciphertext', async () => {
    await writeClientSecret(
      db,
      { clientId: 'alpha', name: 'web-token', value: 'tok-alpha' },
      // Somebody else's key: what a restored database or a rotated deployment key produces.
      Buffer.alloc(32, 9),
    );
    const failure = await postgresSecretSource({ db, env, log })
      .resolve('alpha', { ref: 'web-token' })
      .catch((err: unknown) => err as Error);
    expect(failure).toBeInstanceOf(ConfigError);
    expect(failure.message).toContain('HARNESS_ENCRYPTION_KEY');
    expect(failure.message).not.toMatch(/[0-9a-f]{24}/);
  });

  it('refuses to be built at all by a deployment with no usable key', () => {
    // At construction rather than on the first tenant that names a stored secret: a bad key is a
    // deployment that is wrong, and it should say so where it is configured.
    expect(() => postgresSecretSource({ db, env: {}, log })).toThrow(/HARNESS_ENCRYPTION_KEY/);
  });
});
```

- [ ] **Step 9: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres exec vitest run src/secrets.test.ts
```
Expected: FAIL — `./secrets.js` does not exist, and `clientSecrets` is not exported from `@harness/db`.

- [ ] **Step 10: Add the table, and generate the one migration of this plan**

In `harness/db/src/domain/schema.ts`, add `primaryKey` to the `drizzle-orm/pg-core` import list and add the table at the end, after `clientDocumentVersions`:

```ts
/**
 * One tenant's secrets, encrypted with the deployment's own key (spec section 6).
 *
 * Written by the platform's control plane and read by the host, which is why the columns are a
 * contract rather than an implementation detail: `ciphertext` holds the raw AES-256-GCM envelope
 * — `iv(12) || tag(16) || ciphertext`, exactly what `encrypt` in `shared/crypto.ts` produces —
 * and not base64 and not text. `name` is a secret name, the `[a-z][a-z0-9-]*` shape a document's
 * `{ ref }` already enforces.
 *
 * **The primary key is the isolation.** A reference resolved for one tenant selects on
 * `client_id` and can reach no other tenant's row of the same name (invariant 21).
 */
export const clientSecrets = pgTable(
  'client_secrets',
  {
    clientId: text('client_id').notNull(),
    name: text('name').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.clientId, t.name] })],
);
```

Then generate, from the repository root:

```bash
pnpm --filter @harness/db generate
```

Expected: one new file, `harness/db/drizzle/0015_<two words drizzle-kit chose>.sql`, holding a single `CREATE TABLE "client_secrets"` with the composite primary key, plus an entry in `drizzle/meta/_journal.json` and a new `meta/0015_snapshot.json`. **Read the SQL before going on**: it must create one table and alter nothing else. Then run it again:

```bash
pnpm --filter @harness/db generate
```

Expected: `No schema changes, nothing to migrate` — which is the check that the committed SQL is what the schema says. **Do not hand-write or hand-edit either file.**

Finally, in `harness/db/src/testing.ts`, add the table to the truncation list — first, beside the other two client tables:

```ts
    await db.execute(sql`
      TRUNCATE TABLE client_secrets, client_document_versions, client_documents,
        audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries,
        knowledge_chunks, knowledge_documents, knowledge_sources, runs, messages,
        threads, approvals, deadlines, attachments, fields, documents, records CASCADE
    `);
```

- [ ] **Step 11: Write the postgres source**

Create `harness/config-postgres/src/secrets.ts`:

```ts
import { and, eq } from 'drizzle-orm';
import { envSecretValue, type SecretSource } from '@harness/config-api';
import { clientSecrets, decrypt, encrypt, loadKey, type Db } from '@harness/db';
import { ConfigError, describeError, type EnvSource, type Logger } from '@harness/shared';

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
        // detail goes to the log, because a decryption error can carry the bytes it failed on.
        opts.log.warn(`config-postgres: a stored secret for ${clientId} did not decrypt: ${describeError(err)}`);
        throw new ConfigError(
          "this deployment's secret store holds a value that does not open with HARNESS_ENCRYPTION_KEY",
        );
      }
    },
  };
}
```

and export it from `harness/config-postgres/src/index.ts`:

```ts
export { postgresSecretSource, writeClientSecret, type PostgresSecretSourceOptions } from './secrets.js';
```

`@harness/config-postgres`'s manifest needs no change: it already declares `@harness/config-api`, `@harness/db`, `@harness/shared` and `drizzle-orm`.

- [ ] **Step 12: Run the store half green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres test
```
Expected: PASS — the conformance suite's six cases over the real store, the envelope's three and the source's four, beside the existing `source.test.ts`.

- [ ] **Step 13: Let the registry name a secret source**

In `harness/core-tools/src/domain/config/registry.ts`, add beside `SOURCES` and its two functions — `envSecretSource` comes in through the ordinary import this file already has for the config types:

```ts
/** The secret sources this build ships. A third one is a package and one line here. */
const SECRET_SOURCES = ['env', 'postgres'] as const;
```

```ts
/**
 * Where this process resolves a document's secrets from. Required, with no default.
 *
 * No default for the same reason `HARNESS_CONFIG_SOURCE` has none, and more sharply: a host that
 * guessed `env` would come up, open every tenant whose document names only variables, and refuse
 * every tenant whose document names a stored secret — with a message about a deployment having no
 * secret source, which would be a deployment that had one and had not been told.
 */
export function secretSourceNameFrom(env: EnvSource): string {
  const name = requiredEnv('HARNESS_SECRET_SOURCE', ` (one of: ${SECRET_SOURCES.join(', ')})`, env);
  if (!(SECRET_SOURCES as readonly string[]).includes(name)) {
    throw new ConfigError(`HARNESS_SECRET_SOURCE is "${name}"; this build ships ${SECRET_SOURCES.join(' and ')}`);
  }
  return name;
}

/**
 * Build the named secret source.
 *
 * `env` is a static import: it ships inside `@harness/config-api`, which this file already holds
 * for its types, so there is nothing to defer. `postgres` is a dynamic import for the reason
 * `loadConfigSource` uses one — a process that reads its secrets from the environment should not
 * pay for a package that opens a database.
 */
export async function loadSecretSource(name: string, deps: ConfigSourceDeps): Promise<SecretSource> {
  if (name === 'env') return envSecretSource(deps.env);
  if (name === 'postgres') {
    if (!deps.db) throw new ConfigError('the postgres secret source reads its secrets from a database; open one');
    const { postgresSecretSource } = await import('@harness/config-postgres');
    return postgresSecretSource({ db: deps.db, env: deps.env, log: deps.log });
  }
  throw new ConfigError(`no secret source named "${name}"; this build ships ${SECRET_SOURCES.join(' and ')}`);
}
```

with the file's `@harness/config-api` import becoming `import { envSecretSource, type ClientDocument, type ConfigSource, type SecretSource } from '@harness/config-api';`, and both functions added to the `./domain/config/registry.js` export block in `harness/core-tools/src/index.ts`, alphabetically: `configSourceNameFrom`, `loadClientDocument`, `loadConfigSource`, `loadSecretSource`, `secretSourceNameFrom`, `type ConfigSourceDeps`.

In `harness/core-tools/src/domain/config/registry.test.ts`, add the two describes beside the existing ones:

```ts
describe('secretSourceNameFrom', () => {
  it("has no default, because guessing would refuse a tenant whose secrets are in a store", () => {
    expect(() => secretSourceNameFrom({})).toThrow(ConfigError);
    expect(() => secretSourceNameFrom({})).toThrow(/HARNESS_SECRET_SOURCE/);
    expect(secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'env' })).toBe('env');
    expect(secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'postgres' })).toBe('postgres');
  });

  it('refuses a name that is not one of the two, naming both', () => {
    expect(() => secretSourceNameFrom({ HARNESS_SECRET_SOURCE: 'vault' })).toThrow(/env.*postgres/);
  });
});

describe('loadSecretSource', () => {
  it('loads the env source, which needs nothing but the environment it was handed', async () => {
    expect((await loadSecretSource('env', { env: {}, log, db })).name).toBe('env');
  });

  it('loads the postgres source, which needs a key', async () => {
    const env = { HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    expect((await loadSecretSource('postgres', { env, log, db })).name).toBe('postgres');
    await expect(loadSecretSource('postgres', { env: {}, log, db })).rejects.toThrow(/HARNESS_ENCRYPTION_KEY/);
  });

  it('refuses a source nobody ships', async () => {
    await expect(loadSecretSource('vault', { env: {}, log, db })).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 14: Write the failing host test**

Create `harness/host/src/domain/tenancy/secrets.test.ts`. It drives `createHost` directly rather than `poolFixture`, and the reason is worth knowing before the file is written: a pooled `createHost` opens every client its source lists, and every case here is about an open that **fails**, so what a case asserts on is the error `createHost` itself raises. `poolFixture` would throw before it could return a handle to close.

```ts
import { describe, expect, it } from 'vitest';
import { envSecretSource, parseClientDocument, type ClientDocument, type SecretSource } from '@harness/config-api';
import { MemoryConfigSource, MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { createHost } from './pool.js';
import { useTestDb } from '../../testing.js';

const db = useTestDb();
const log = { info() {}, warn() {}, error() {} };

/**
 * A document that declares the web surface and the run API and nothing else.
 *
 * Every case in this file asserts on what happens **before** a surface is loaded:
 * `resolveSecrets` runs first, so a document whose secret cannot be resolved fails with the
 * secret's own message and `@harness/surface-web` is never reached. That ordering is spec section
 * 4.10's, and it is why these cases can drive the web surface's section of the schema in a task
 * that has not built the adapter yet.
 */
const webTenant = (id: string, token: Record<string, string>): ClientDocument =>
  parseClientDocument(fixtureDocument({ id, displayName: id, surfaces: { web: { token }, http: {} } }));

/** A pooled host over one document, with the secret source a case wants to drive. */
async function host(document: ClientDocument, secrets: SecretSource, env: Record<string, string> = {}) {
  return createHost({
    db,
    env: {
      HARNESS_STORAGE_DIR: '/nonexistent/storage',
      HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
      LITELLM_MASTER_KEY: 'sk-test',
      ...env,
    },
    log,
    now: () => new Date('2026-09-15T12:00:00Z'),
    // One document, and `createHost` opens every client the source lists — so the failure a case
    // asserts on is the one `createHost` itself raises, with this tenant's own message in it.
    source: new MemoryConfigSource([{ document, version: 'v1' }]),
    secrets,
    dedicatedClient: null,
  });
}

describe('resolving a tenant’s secrets when it opens', () => {
  it('refuses a store reference when this deployment has no store', async () => {
    // The env source, not an empty `MemorySecretSource`: an empty store refuses a reference it
    // does not hold, and this case is about the source that has no store to hold one in.
    await expect(host(webTenant('alpha', { ref: 'web-token' }), envSecretSource({}))).rejects.toThrow(
      'client "alpha" names the secret "web-token" for web.token, and this deployment has no secret source',
    );
  });

  it('refuses an environment reference this deployment does not set, naming the surface and the variable', async () => {
    await expect(host(webTenant('alpha', { env: 'WEB_TOKEN' }), new MemorySecretSource())).rejects.toThrow(
      'client "alpha" declares the "web" surface, which needs WEB_TOKEN; this deployment does not set it',
    );
  });

  it('refuses a store reference the store does not hold, naming the client and the name and not the row', async () => {
    const failure = await host(webTenant('alpha', { ref: 'web-token' }), new MemorySecretSource()).catch(
      (err: unknown) => err as Error,
    );
    expect(failure.message).toContain('client "alpha"');
    expect(failure.message).toContain('"web-token"');
    expect(failure.message).not.toContain('client_secrets');
  });

  it('resolves before it builds anything, so a broken secret is never a surface’s failure', async () => {
    // The proof that the order changed: `@harness/surface-web` does not exist in this task, so a
    // tenant that got as far as `loadSurfaces` would fail with "cannot load surface". It fails
    // with the secret's message instead.
    const failure = await host(webTenant('alpha', { ref: 'web-token' }), new MemorySecretSource()).catch(
      (err: unknown) => err as Error,
    );
    expect(failure.message).not.toContain('cannot load surface');
  });

  it('keeps two tenants’ secrets apart under one name (invariant 21)', async () => {
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', 'tok-alpha');
    secrets.put('beta', 'web-token', 'tok-beta');
    // Resolved through the contract rather than through an open, because opening needs the
    // adapter Task 4 writes. Both halves of invariant 21 are here: each tenant reads its own, and
    // neither reaches the other's.
    expect(await secrets.resolve('alpha', { ref: 'web-token' })).toBe('tok-alpha');
    expect(await secrets.resolve('beta', { ref: 'web-token' })).toBe('tok-beta');
    await expect(secrets.resolve('gamma', { ref: 'web-token' })).rejects.toThrow();
  });

  it('never writes a resolved value into a refusal, however the source failed', async () => {
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', 'tok-alpha-supersecret');
    // A document that names a *different* secret: the store holds one value for this tenant and
    // the refusal is about another, so a refusal that leaked anything would leak this.
    const failure = await host(webTenant('alpha', { ref: 'other-token' }), secrets).catch(
      (err: unknown) => err as Error,
    );
    expect(failure.message).toContain('"other-token"');
    expect(failure.message).not.toContain('tok-alpha-supersecret');
  });
});
```

- [ ] **Step 15: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/tenancy/secrets.test.ts
```
Expected: FAIL — `HostDeps` has no `secrets`, and `openTenant` still refuses every `{ ref }` with `assertSecretsPresent`'s own copy of the message rather than through the source.

- [ ] **Step 16: Rename the bag, everywhere at once**

`SurfaceDeps.secrets` carried **environment variable names** and now carries **values**, and both are `Readonly<Record<string, string>>` — so changing only the meaning would compile clean and leave `slackConfig` looking a secret value up as a variable name. The rename is what forces every site (spec section 4.10). These are all of them:

`harness/surface-api/src/types.ts`:

```ts
  /**
   * This client's credentials for this surface, resolved to their values, keyed by the document's
   * own field name — `{ botToken: 'xoxb-…' }`.
   *
   * The counterpart of `Surface.secrets`, which says which *variables* an adapter reads when it
   * is given nothing: this is what **this tenant** actually holds, resolved by the host from its
   * document's `SecretRef`s through whatever secret source the deployment configured. An adapter
   * falls back to the conventional variable for a field the document did not name, so a
   * single-tenant deployment configures nothing; two tenants in one process each get their own,
   * and neither adapter can read the other's.
   *
   * **Values, never names, and never logged.** A resolved secret does not appear in a log line,
   * an error message, an audit row, a refusal or a run API response (invariant 21).
   */
  secretValues?: Readonly<Record<string, string>>;
```

`harness/approvals/src/domain/surfaces/registry.ts`:

```ts
export interface SurfaceSettings {
  readonly tenantKey?: string;
  /** This client's credentials for this surface, resolved to their values. Nothing here reads them. */
  readonly secretValues?: Readonly<Record<string, string>>;
}
```

with the interface's own doc comment's second sentence rewritten from "the environment variable the document named for each of that surface's credentials" to "the value behind each of that surface's credentials, resolved by the host before this package saw it".

`surfaces/slack/src/index.ts`:

```ts
    const config = slackConfig(deps.env, deps.secretValues ?? {});
```

`surfaces/slack/src/config.ts` — the fallback survives, but **its expression moves**: from inside `requiredEnv`'s first argument to a `??` around the whole call, which is what keeps the literal variable names in this file where the environment scan can find them:

```ts
/**
 * Read this adapter's configuration out of what the host handed over.
 *
 * `secrets` is what this client's document named, resolved to values by the host's secret source.
 * A deployment that uses the conventional variables — every single-tenant one — declares nothing
 * and gets them from `deps.env`; one running two workspaces in one process resolves two pairs,
 * and each tenant's adapter reads its own.
 */
export function slackConfig(env: EnvSource, secrets: Readonly<Record<string, string>> = {}): SlackConfig {
  return {
    botToken:
      secrets.botToken ?? requiredEnv('SLACK_BOT_TOKEN', ' (the Slack app the host posts as; see docs/runbook.md)', env),
    signingSecret:
      secrets.signingSecret ??
      requiredEnv(
        'SLACK_SIGNING_SECRET',
        ' (the Slack app signing secret, which every inbound request is verified against; see docs/runbook.md)',
        env,
      ),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
```

`surfaces/slack/src/index.test.ts` — the second case's premise changes with the bag:

```ts
  it("uses the values this client's document named, and falls back to the conventional variables", async () => {
    // Two tenants in one process hold two apps, so what an adapter posts as is what its own
    // document named — resolved by the host, from an environment variable or from a store, and
    // handed over as a value.
    const deps = {
      env: { SLACK_APPROVALS_CHANNEL: 'C0TEST' },
      log: createLogger('test'),
      storageDir: '/nonexistent',
      secretValues: { botToken: 'xoxb-tenant-a', signingSecret: 'tenant-a-signing' },
    };
    // Neither conventional variable is in this environment at all, so a `connect` that reached
    // for one would throw a ConfigError naming it.
    await expect(surface.connect(deps)).resolves.toMatchObject({ name: 'slack' });
    // And a deployment that resolved nothing falls back to them, and says which one is missing.
    // Wrapped, because `connect` reads its configuration before it has anything to await and so
    // raises where it stands: the contract says a caller gets a promise, and this asserts what
    // that caller sees whichever way the failure arrives.
    await expect((async () => surface.connect({ ...deps, secretValues: {} }))()).rejects.toThrow(/SLACK_BOT_TOKEN/);
  });
```

- [ ] **Step 17: Resolve at tenant open, and delete the check it replaces**

In `harness/host/src/domain/tenancy/types.ts`, add to `HostDeps`:

```ts
  /**
   * Where this process resolves a tenant's secrets from: `HARNESS_SECRET_SOURCE`.
   *
   * One per process, like the config source, and closed with it. Which secrets a tenant *has* is
   * its document's business; this is only the place they come from.
   */
  secrets: SecretSource;
```

with `SecretSource` added to the `@harness/config-api` type import at the top of that file.

In `harness/host/src/domain/tenancy/tenant.ts`:

- **delete `assertSecretsPresent` entirely**, with its doc comment and both refusal branches.
- add `resolveSecrets` to the `@harness/config-api` import and **remove two names from it**: `surfaceSecretsOf` and `type ClientDocument`. Both appear in this file only inside the function being deleted — `ClientDocument` at the import and in `assertSecretsPresent`'s signature, `surfaceSecretsOf` in its body and in the settings loop the next bullet rewrites — and an unused import is a lint **error** under `unused-imports`, against a ceiling with no headroom.
- replace the first five lines of `buildTenant`'s body — the two destructurings, the
  `buildKernelConfig` call, the `assertSecretsPresent` call and the `runBudget` call — with:

```ts
  const { document, version } = loaded;
  const log = pool.log;
  // Before anything is built, and before `buildKernelConfig` (spec section 4.10). Two reasons the
  // order matters: a deployment whose secret source is broken should be told that before it is
  // told anything about its gateway, and section 4.11's per-tenant gateway key is resolved here
  // and handed to `buildKernelConfig`. It is also what makes "add a tenant with no restart" true
  // — a pooled host opens a new tenant on its first request and resolves its secrets then.
  const secrets = await resolveSecrets(document, { source: pool.secrets, log });
  const config = await buildKernelConfig(document, pool.env);
  const budget = runBudget(config.client, config.gateway, pool.env);
```

- replace the settings loop's second half:

```ts
  // What the document says about each surface it declares: the key an inbound event's hint is
  // matched against, and the value behind each of that surface's credentials. Both come out of
  // `@harness/config-api`, which is where the typed surface sections are read, so this file names
  // no surface's own field — `field` is as opaque here as `env` ever was, and the value it keys
  // is never logged, never audited and never put in a message.
  const settings: Record<string, SurfaceSettings> = {};
  for (const { surface, key } of tenantKeysOf(document)) {
    settings[surface] = { ...settings[surface], tenantKey: key };
  }
  for (const [surface, secretValues] of Object.entries(secrets.surfaces)) {
    settings[surface] = { ...settings[surface], secretValues };
  }
```

In `harness/host/src/domain/tenancy/pool.ts`, close it with the config source in `pool.close()`:

```ts
      await deps.source.close?.();
      // The secret source is per process too, and a postgres one holds nothing but the handle it
      // was given — but a third implementation might, and the contract has a `close` for that.
      await deps.secrets.close?.();
```

In `harness/host/src/app/main.ts`, build it beside the config source:

```ts
const source = await loadConfigSource(configSourceNameFrom(process.env), { env: process.env, log, db });
// Where a tenant's secrets come from: `env` reads this process's environment, `postgres` reads
// `client_secrets`. Required, with no default, for the reason `HARNESS_CONFIG_SOURCE` is.
const secrets = await loadSecretSource(secretSourceNameFrom(process.env), { env: process.env, log, db });
```

with `loadSecretSource` and `secretSourceNameFrom` added to the `@harness/core-tools` import, and `secrets` added to the `createHost` call:

```ts
const pool = await createHost({ db, env: process.env, log, now, source, secrets, dedicatedClient });
```

In `harness/host/src/testing.ts`, give `poolFixture` a source of its own:

```ts
    /**
     * Where this pool resolves its tenants' secrets from.
     *
     * **The environment source by default**, which is what every deployment has today and what
     * every existing case in this package was written against: a document naming an `{ env }`
     * secret this fixture's environment does not set fails with the sentence it has always
     * failed with, and a `{ ref }` is refused with "this deployment has no secret source". A case
     * that wants a store — the web surface's bearer, the gateway key — builds a
     * `MemorySecretSource`, fills it and passes it.
     */
    secrets?: SecretSource;
```

```ts
  const pool = await createHost({
    db,
    env,
    log: opts.log ?? { info() {}, warn() {}, error() {} },
    now: () => new Date('2026-09-15T12:00:00Z'),
    source,
    secrets: opts.secrets ?? envSecretSource(env),
    dedicatedClient: opts.dedicated ?? null,
  });
```

with `envSecretSource` and `type SecretSource` added to the `@harness/config-api` import. The source is built over **this fixture's own `env`**, not the ambient one, for the reason every other value in that bag is: a developer's filled-in `.env` must not reach a tenant and change what a case proves.

**One existing case depends on this default and is the reason it is the environment source.** `harness/host/src/domain/tenancy/tenant.test.ts:52` holds `describe('assertSecretsPresent')`, which opens a pooled host over a document carrying `signingSecret: { ref: 'slack-signing' }` and asserts:

```
client "alpha" names the secret "slack-signing" for slack.signingSecret, and this deployment has no secret source
```

With the environment source as the default that message is produced verbatim by `resolveSecrets` and the assertion needs no change at all — which is the whole argument for the default. What does change is the name of the block it sits in, because the function it names is deleted in this task:

```ts
describe('resolving a tenant’s secrets', () => {
  it('refuses a client whose document names a secret this deployment has no secret source for', async () => {
```

Nothing else in that file moves. A `MemorySecretSource` default would have made the same case fail with "this source holds no such secret for that client" — a store that is empty is not a deployment that has none.

- [ ] **Step 18: Run the host suite green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host test
```
Expected: PASS — `secrets.test.ts`'s six cases and every existing host suite, which is the check that the rename reached every site.

- [ ] **Step 19: Make `.env.example` a deployment's file, not a tenant's**

This is the task that makes a tenant's credentials configurable from the platform's UI, so it is also the task where this repository stops presenting them as things an operator types into a file. **`.env.example` lists deployment variables only** — the database URLs, `HARNESS_ENCRYPTION_KEY`, `LITELLM_MASTER_KEY`, `HARNESS_HOST_TOKEN`, `HARNESS_SECRET_SOURCE`, the config source and clients directory, the ports, the binds, the image tag, the worker's two, the gateway's, the eval runner's — and a **tenant's** secrets are rows in `client_secrets`, written by the control plane and named by that tenant's document as `{ ref }`.

One thing that rule cannot do, and the reason is in this task's own Step 16. `slackConfig`'s conventional-name fallback now reads `requiredEnv('SLACK_BOT_TOKEN', …)` with the name as a **literal**, where today it is `requiredEnv(secrets.botToken ?? 'SLACK_BOT_TOKEN', …)` — an expression the environment scan cannot see. So after this task the scan in `harness/core-tools/src/app/surface.test.ts` reads three names out of that file for the first time: `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL`, the last of which is also one of its `SCAN_ANCHORS`. A name the kernel reads and `.env.example` does not document fails that test. **They therefore stay documented, and stop being settings**: `envNamesFromExample` matches `/^#?\s*([A-Z][A-Z0-9_]*)=/`, so a commented-out line documents a name, and a commented-out line under a heading that says "you are probably not setting this" is exactly what they are.

Nothing else in the kernel reads any of the three (grepped: `surfaces/slack/src/config.ts` and Compose, and nowhere else), so no other handling is needed.

Replace the whole `--- Messaging surfaces ---` section of `.env.example`, from its heading down to and including `SLACK_APPROVALS_CHANNEL=`, with:

```
# --- Tenant secrets are NOT deployment settings -------------------------------
# Everything above this line belongs to a deployment. What belongs to a TENANT —
# a bot token, a signing secret, a web bearer, a gateway key — is named by that
# tenant's client document as `{ ref: <name> }` and stored as a row in
# `client_secrets`, encrypted with HARNESS_ENCRYPTION_KEY. The platform's control
# plane writes those rows; onboarding a tenant changes nothing in this file and
# needs no restart. Set HARNESS_SECRET_SOURCE=postgres for such a deployment.
#
# A DEDICATED host may instead have a document that names `{ env: SOME_NAME }`,
# in which case the operator sets SOME_NAME in that host's environment and the
# document decides what it is called — two tenants in one process would name two
# different variables, which is exactly what a pooled host cannot do and why the
# store exists.
#
# The three names below are the conventional ones the Slack adapter falls back to
# when a tenant's document names nothing. They are commented out because they are
# a dedicated host's business and not this file's; the adapter still reads them,
# which is why they are documented at all. Compose's host service passes all
# three through (see harness/compose/docker-compose.yml) so a dedicated Slack
# host keeps working with no document change.
#SLACK_BOT_TOKEN=
#SLACK_SIGNING_SECRET=
#SLACK_APPROVALS_CHANNEL=
```

The "Who may decide an approval" paragraph that follows it stays where it is: it is about the identity plug-in, not about a credential.

In Compose, the three `SLACK_*` lines in the `host` service's environment keep their values and gain one comment above them:

```yaml
      # Passed through for a DEDICATED host whose tenant document names these conventional
      # variables. A pooled host names nothing here: each tenant's credentials are rows in
      # `client_secrets`, resolved when that tenant opens. `surface.test.ts` asserts that this
      # allowlist still carries the first two.
```

Nothing about the three interpolations changes, so `surface.test.ts`'s assertions that `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` are defined on the host service still hold.

- [ ] **Step 20: Document `HARNESS_SECRET_SOURCE`, in `.env.example` and in Compose**

In `.env.example`, after the `HARNESS_CLIENTS_DIR` block and before `HARNESS_CLIENT`:

```
# --- Where a secret comes from -----------------------------------------------
# Required, with no default, exactly like HARNESS_CONFIG_SOURCE: a host that
# guessed would come up and refuse every tenant whose document names a stored
# secret, with a message saying this deployment has no secret store — which it
# would have had.
#   env       a document's { env: NAME } references read this process's
#             environment, and a { ref: name } reference is refused
#   postgres  a { ref: name } reference is read from client_secrets, decrypted
#             with HARNESS_ENCRYPTION_KEY; { env: NAME } still means this
#             environment, so a document may mix the two
# Read by the host and by the stdio server (both resolve a document's secrets
# before they build anything). See docs/runbook.md, "Secrets from a store".
HARNESS_SECRET_SOURCE=env
```

In `harness/compose/docker-compose.yml`, in the `host` service's environment, directly under `HARNESS_CONFIG_SOURCE`:

```yaml
      # Where a tenant's secrets come from. NO `:-` default, unlike the line above: the no-default
      # rule is the point of this variable, and a Compose default would defeat it exactly where it
      # matters most — a stack that came up reading the wrong secrets and said nothing.
      HARNESS_SECRET_SOURCE: '${HARNESS_SECRET_SOURCE:?set HARNESS_SECRET_SOURCE in .env (env or postgres)}'
```

- [ ] **Step 21: Re-record the compose snapshot, once**

Run:
```bash
pnpm surface:record
git diff --stat docs/architecture
```
Expected: `docs/architecture/compose-surface.yaml` changed and **`docs/architecture/tool-surface.json` did not**. If `tool-surface.json` moved, stop: something in this task changed the tool catalogue, which nothing in this plan is allowed to do.

The recorded line is the literal `${HARNESS_SECRET_SOURCE:?set HARNESS_SECRET_SOURCE in .env (env or postgres)}`, because `--no-interpolate` leaves every `${VAR}` unexpanded — which is also why recording it does not require the variable to be set.

- [ ] **Step 22: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings. `git status --short docs/architecture` shows **only** `compose-surface.yaml`.

Four things the gates prove that would otherwise be silent, and this task moved all four: `surface.test.ts`'s environment scan sees `HARNESS_SECRET_SOURCE` through `requiredEnv` and finds it in `.env.example`; it now also sees `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET` for the first time, because Step 16 turned two expressions into two literals, and finds both as commented-out lines; `SLACK_APPROVALS_CHANNEL` is still read and still documented, which is what keeps that `SCAN_ANCHOR` true; and the compose assertions still pass, because the new line is an addition to the `host` service and the three `SLACK_*` interpolations are untouched.

- [ ] **Step 23: Commit**

```
git add harness/config-api harness/config-postgres harness/db harness/core-tools/src harness/surface-api/src harness/approvals/src harness/host/src surfaces/slack/src .env.example harness/compose/docker-compose.yml docs/architecture/compose-surface.yaml
git commit -m "feat(config-api): resolve a tenant's secrets from a store when it opens"
```

---

### Task 4: The web surface — a tenant with no Slack gets chat, cards and forms over HTTP

**Files:**
- Create: `surfaces/web/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `surfaces/web/src/index.ts`, `config.ts`, `stream.ts`, `session.ts`, `door.ts`
- Create: `surfaces/web/src/stream.test.ts`, `door.test.ts`, `index.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry)
- Modify: `harness/approvals/package.json`, `harness/host/package.json` (the dependency, spec §12 constraint 11)
- Modify: `harness/config-api/src/document.ts` (`SurfacesShape.web.inbox`, `surfaceConversationsOf`) + `document.test.ts` + `src/index.ts`
- Modify: `harness/surface-api/src/types.ts` (`SurfaceDeps.defaultConversation`)
- Modify: `harness/approvals/src/domain/surfaces/registry.ts` (`SurfaceSettings.defaultConversation`)
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (splice it in)
- Modify: `harness/host/src/testing.ts` (`settleDeliveries` awaits any session that has a `settled`)
- Modify: `harness/identity-api/src/principals.ts` + `principals.test.ts` (invariant 24)
- Create: `harness/host/src/domain/api/web-surface.test.ts`
- Delete: nothing.

**Interfaces:**
- Produces:
  - `@harness/surface-web`'s `surface: Surface` (`name: 'web'`, `secrets: []`)
  - `WEB_MOUNT_PATH = 'web'`, `WEB_FRAME_RETENTION = 200`, `WEB_KEEPALIVE_MS = 15_000`, `WEB_EVENTS = ['delta', 'message', 'card', 'card_update', 'notice']`
  - `surfaceConversationsOf(document): { surface: string; conversation: string }[]`
  - `SurfaceDeps.defaultConversation?: string`, `SurfaceSettings.defaultConversation?: string`
  - `CEILED_DEFAULT_SURFACE = 'web'`, `CEILED_DEFAULT_CEILING = 'practitioner'` in `@harness/identity-api`
- Consumes: the streaming seam (Task 2); `deps.secretValues` (Task 3); `assertInsideRoot`, `CONVERSATION_ID_PATTERN` (`@harness/shared`).

- [ ] **Step 1: Declare the package**

Create `surfaces/web/package.json`. **`"private": true` and `"version": "0.1.0"` are both load-bearing**: `scripts/src/domain/packaging.test.ts` asserts that the published set is exactly seven names and that every workspace package carries one version, and this adapter is not published.

```json
{
  "name": "@harness/surface-web",
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

`surfaces/web/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

`surfaces/web/vitest.config.ts` — the same two lines every leaf package has:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Add the two lines `.dependency-cruiser.cjs`'s own header asks for — a `PACKAGES` row after `surface-http`, and a `WORKSPACE_DIRS` entry after `surfaces/http`:

```js
  { name: 'surface-web', src: 'surfaces/web/src', severity: 'error' },
```

```js
  'surfaces/web',
```

Declare it where `loadSurfaces` can resolve it (spec §12 constraint 11: the resolver runs inside `@harness/approvals`, so the specifier has to resolve from **there**, and the host is what actually installs it at runtime). In `harness/approvals/package.json` and `harness/host/package.json`, add to `dependencies`, alphabetically between `@harness/surface-slack` and whatever follows:

```json
    "@harness/surface-web": "workspace:*",
```

Then:

```bash
pnpm install
```

Expected: one workspace link added, no registry package downloaded, and `pnpm-lock.yaml` changed by exactly that.

- [ ] **Step 2: Write the failing stream test**

Create `surfaces/web/src/stream.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConversationStreams, WEB_FRAME_RETENTION } from './stream.js';

/** Read the frames a stream has ready, then stop: every case here drives a finite stream. */
async function drain(stream: AsyncIterable<string>, take: number): Promise<string[]> {
  const chunks: string[] = [];
  for await (const chunk of stream) {
    chunks.push(chunk);
    if (chunks.length >= take) break;
  }
  return chunks;
}

describe('ConversationStreams', () => {
  it('frames an event as Server-Sent Events, with an id that counts from one per conversation', async () => {
    const streams = new ConversationStreams();
    const open = streams.open('inbox', new AbortController().signal, null);
    streams.emit('inbox', 'message', { text: 'hello' });
    streams.emit('inbox', 'message', { text: 'again' });
    // A second conversation counts from one of its own: an id is per conversation, so two pages
    // of the workspace resume independently.
    streams.emit('other', 'message', { text: 'elsewhere' });
    expect(await drain(open, 2)).toEqual([
      'id: 1\nevent: message\ndata: {"text":"hello"}\n\n',
      'id: 2\nevent: message\ndata: {"text":"again"}\n\n',
    ]);
    const second = streams.open('other', new AbortController().signal, null);
    expect(await drain(second, 1)).toEqual(['id: 1\nevent: message\ndata: {"text":"elsewhere"}\n\n']);
  });

  it('replays what a resuming client has not seen, and repeats nothing it has', async () => {
    const streams = new ConversationStreams();
    for (const n of [1, 2, 3]) streams.emit('inbox', 'message', { n });
    expect(await drain(streams.open('inbox', new AbortController().signal, '2'), 1)).toEqual([
      'id: 3\nevent: message\ndata: {"n":3}\n\n',
    ]);
  });

  it('opens a resume past the window with a notice, before the first frame it can still send', async () => {
    const streams = new ConversationStreams();
    for (let n = 1; n <= WEB_FRAME_RETENTION + 3; n += 1) streams.emit('inbox', 'message', { n });
    const frames = await drain(streams.open('inbox', new AbortController().signal, '1'), 2);
    // The notice carries **no id**, deliberately: a client's `Last-Event-ID` must not move to a
    // frame that is an apology rather than a message, or a second reconnection would skip a real
    // one. The workspace has to be able to tell a resumed stream from a complete one, and this is
    // that signal.
    expect(frames[0]).toBe(
      `event: notice\ndata: {"text":"Some earlier messages are no longer available.","dropped":true}\n\n`,
    );
    expect(frames[1]).toBe(`id: 4\nevent: message\ndata: {"n":4}\n\n`);
  });

  it('sends no notice to a client that resumes inside the window', async () => {
    const streams = new ConversationStreams();
    for (const n of [1, 2]) streams.emit('inbox', 'message', { n });
    const frames = await drain(streams.open('inbox', new AbortController().signal, '1'), 1);
    expect(frames[0]).toBe('id: 2\nevent: message\ndata: {"n":2}\n\n');
  });

  it('sends a keep-alive comment on an idle stream, and counts it as no frame', async () => {
    const streams = new ConversationStreams({ keepAliveMs: 20 });
    const frames = await drain(streams.open('inbox', new AbortController().signal, null), 2);
    // A comment line, which every Server-Sent Events client ignores: two bytes of nothing that
    // stop an idle-timeout proxy closing a conversation nobody has spoken in.
    expect(frames).toEqual([': keep-alive\n\n', ': keep-alive\n\n']);
  });

  it('ends a stream when its request is aborted, and forgets it', async () => {
    const streams = new ConversationStreams();
    const client = new AbortController();
    const stream = streams.open('inbox', client.signal, null);
    const iterator = stream[Symbol.asyncIterator]();
    const parked = iterator.next();
    expect(streams.openCount).toBe(1);
    client.abort();
    expect((await parked).done).toBe(true);
    expect(streams.openCount).toBe(0);
  });

  it('drops the oldest frames of a conversation rather than growing without a bound', () => {
    const streams = new ConversationStreams();
    for (let n = 1; n <= WEB_FRAME_RETENTION + 10; n += 1) streams.emit('inbox', 'message', { n });
    expect(streams.held('inbox')).toBe(WEB_FRAME_RETENTION);
    // And a conversation nobody has written to holds nothing at all: a tenant's memory is the
    // conversations it has used, not the ones it could.
    expect(streams.held('never-used')).toBe(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-web exec vitest run src/stream.test.ts`
Expected: FAIL — `./stream.js` does not exist.

- [ ] **Step 4: Write the stream**

Create `surfaces/web/src/stream.ts`:

```ts
/**
 * Server-Sent Events, per conversation, framed here and written by the host as opaque chunks.
 *
 * The whole format is `id: <n>\nevent: <name>\ndata: <one JSON line>\n\n`, with `: <text>\n\n`
 * for a comment, so a library would be a dependency for forty lines of string building — and the
 * framing is the one thing this adapter must own, because the host writes chunks it does not read
 * (spec section 4.9, "what the host learns: nothing").
 *
 * Ids count from 1 **per conversation**, so two pages of the workspace resume independently, and
 * a client reconnects with `Last-Event-ID`.
 */

/**
 * The five frames this surface sends. Named here because the README and the runbook list them.
 *
 * Two of the five carry more than one payload, and a client discriminates on a key rather than on
 * the name, so both are written down here:
 *
 * - `card` is `{ message, card }` for a posted card and `{ form }` for a dialogue this surface
 *   was asked to open. A form has no message of its own — it is opened from a button — which is
 *   why it is not a sixth name: the workspace is being asked to render something in the same
 *   place, and the key says which.
 * - `notice` is `{ message, text, replyTo }` for something the host said *about* a message,
 *   `{ text, userId }` for a private note the workspace routes to one person, and
 *   `{ text, dropped: true }` for the one this surface sends itself, when a resume has fallen
 *   past the window.
 */
export const WEB_EVENTS = ['delta', 'message', 'card', 'card_update', 'notice'] as const;
export type WebEvent = (typeof WEB_EVENTS)[number];

/**
 * How many frames one conversation holds for a client that resumes.
 *
 * In memory, per host, and dropped when the tenant closes (spec section 13.5 leaves the window
 * open and asks for a decision before the stream is written; this is it). Two hundred frames is
 * minutes of a conversation and kilobytes per tenant. The cost is stated rather than hidden: a
 * workspace behind an ingress with two hosts can resume only against the host it reconnects to,
 * and a resume that lands anywhere else opens with the dropped-frames notice below — which is
 * exactly the signal the workspace needs to reload the conversation from the run API instead.
 */
export const WEB_FRAME_RETENTION = 200;

/** How often an idle stream writes a comment line, for the reason `SSE_KEEPALIVE_MS` exists. */
export const WEB_KEEPALIVE_MS = 15_000;

/** What a client is told when it resumes past the window. It carries no id; see `open`. */
const DROPPED_NOTICE = { text: 'Some earlier messages are no longer available.', dropped: true };

interface Frame {
  id: number;
  event: WebEvent;
  data: unknown;
}

interface Conversation {
  frames: Frame[];
  seq: number;
}

export interface ConversationStreamsOptions {
  /** Zero switches the keep-alive off, which is what a test that counts frames wants. */
  keepAliveMs?: number;
}

/** One conversation's frames, and everyone listening to it. */
export class ConversationStreams {
  /** How many streams are open right now, across every conversation. */
  openCount = 0;

  private readonly conversations = new Map<string, Conversation>();
  private readonly waiting = new Set<() => void>();
  private readonly keepAliveMs: number;

  constructor(opts: ConversationStreamsOptions = {}) {
    this.keepAliveMs = opts.keepAliveMs ?? WEB_KEEPALIVE_MS;
  }

  /** How many frames a conversation is holding. A conversation nobody has used holds none. */
  held(conversation: string): number {
    return this.conversations.get(conversation)?.frames.length ?? 0;
  }

  /**
   * Add one frame to a conversation and wake everyone listening to it.
   *
   * A conversation is created by writing to it, which is why there is no route to create one and
   * none to list them (spec section 4.9).
   */
  emit(conversation: string, event: WebEvent, data: unknown): void {
    const held = this.conversations.get(conversation) ?? { frames: [], seq: 0 };
    held.seq += 1;
    held.frames.push({ id: held.seq, event, data });
    if (held.frames.length > WEB_FRAME_RETENTION) held.frames.shift();
    this.conversations.set(conversation, held);
    // A copy, because a waiter removes itself from the set as it runs.
    for (const waiter of [...this.waiting]) waiter();
  }

  /**
   * One client's view of a conversation: what it has not seen, then whatever arrives.
   *
   * `lastEventId` is the `Last-Event-ID` header, which reaches an adapter as the lower-cased
   * `last-event-id` key of the request's headers. A resume the window no longer covers opens with
   * a `notice` frame carrying `dropped: true` **and no `id:` line** — a client's `Last-Event-ID`
   * must not move to a frame that is an apology rather than a message, or a second reconnection
   * would skip a real one.
   */
  open(conversation: string, signal: AbortSignal, lastEventId: string | null): AsyncIterable<string> {
    const asked = Number.parseInt(lastEventId ?? '', 10);
    const resumeAfter = Number.isSafeInteger(asked) && asked > 0 ? asked : 0;
    return this.stream(conversation, signal, resumeAfter);
  }

  private async *stream(conversation: string, signal: AbortSignal, resumeAfter: number): AsyncGenerator<string> {
    this.openCount += 1;
    try {
      let sent = resumeAfter;
      if (resumeAfter > 0) {
        const oldest = this.conversations.get(conversation)?.frames[0]?.id ?? resumeAfter + 1;
        if (oldest > resumeAfter + 1) yield `event: notice\ndata: ${JSON.stringify(DROPPED_NOTICE)}\n\n`;
      }
      for (;;) {
        const next = (this.conversations.get(conversation)?.frames ?? []).filter((frame) => frame.id > sent);
        if (next.length > 0) {
          for (const frame of next) {
            sent = frame.id;
            yield `id: ${frame.id}\nevent: ${frame.event}\ndata: ${JSON.stringify(frame.data)}\n\n`;
          }
          continue;
        }
        // After the backlog, not before it — the same rule `MemorySurface`'s door follows, so the
        // seam's reference implementation and its first real one cannot disagree about what a
        // caller who has already hung up receives.
        if (signal.aborted) return;
        if (await this.pause(signal)) yield ': keep-alive\n\n';
      }
    } finally {
      // `finally`, so an abort, a throw and a consumer that simply stops pulling all close it.
      this.openCount -= 1;
    }
  }

  /**
   * Park until a frame arrives, the caller goes away, or the keep-alive falls due.
   *
   * True means the timer fired and the caller should write a comment line. The timer is `unref`ed
   * for the reason the run API's is: an idle stream must not be why a process will not exit.
   */
  private async pause(signal: AbortSignal): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const settle = (keepAlive: boolean) => (): void => {
        this.waiting.delete(wake);
        signal.removeEventListener('abort', abort);
        if (timer !== undefined) clearTimeout(timer);
        resolve(keepAlive);
      };
      const wake = settle(false);
      const abort = settle(false);
      const timer = this.keepAliveMs > 0 ? setTimeout(settle(true), this.keepAliveMs) : undefined;
      timer?.unref();
      this.waiting.add(wake);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
}
```

- [ ] **Step 5: Run the stream green**

Run: `pnpm --filter @harness/surface-web exec vitest run src/stream.test.ts`
Expected: PASS — seven cases.

- [ ] **Step 6: Write the failing door test**

Create `surfaces/web/src/door.test.ts`. It drives the whole adapter through its seam, which is how a caller reaches it:

```ts
import { describe, expect, it } from 'vitest';
import { bodyText } from '@harness/surface-api/testing';
import type { ActionEvent, FormEvent, MessageEvent, SurfaceHttpRequest, SurfaceSession } from '@harness/surface-api';
import { createWebSession } from './session.js';

const TOKEN = 'wt-0123456789abcdef';
const deps = () => ({
  env: {},
  log: { info() {}, warn() {}, error() {} },
  storageDir: '/nonexistent/storage',
  secretValues: { token: TOKEN },
  defaultConversation: 'inbox',
});

/** One request, as the host hands one over: the sub-path below the mount, and the tenant. */
const request = (over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: 'messages',
  headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
  body: '{}',
  clientId: 'alpha',
  signal: new AbortController().signal,
  ...over,
});

const post = (path: string, body: unknown, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest =>
  request({ path, body: JSON.stringify(body), ...over });

/** The session, and the events its door delivered, so a case can assert on both sides. */
function open(): {
  session: SurfaceSession;
  messages: MessageEvent[];
  actions: ActionEvent[];
  forms: FormEvent[];
} {
  const session = createWebSession(deps());
  const messages: MessageEvent[] = [];
  const actions: ActionEvent[] = [];
  const forms: FormEvent[] = [];
  session.onMessage(async (event) => {
    messages.push(event);
  });
  session.onAction(async (event) => {
    actions.push(event);
  });
  session.onFormSubmit(async (event) => {
    forms.push(event);
  });
  return { session, messages, actions, forms };
}

/** The door answers before it delivers, so a case waits a tick rather than asserting into a race. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the web surface as a door', () => {
  it('is mounted at one path, under which every route hangs', () => {
    expect(createWebSession(deps()).http?.path).toBe('web');
  });

  it('takes a message, answers with its reference, and delivers it afterwards', async () => {
    const { session, messages } = open();
    const response = await session.http!.handle(
      post('messages', { userId: 'U012', conversation: 'inbox', text: 'hello' }),
    );
    expect(response.status).toBe(202);
    expect(response.headers?.['content-type']).toBe('application/json');
    expect(JSON.parse(await bodyText(response))).toEqual({
      message: { surface: 'web', conversation: 'inbox', id: 'w1' },
    });
    // Acknowledged first, delivered after: a turn takes seconds to minutes and the caller is not
    // waiting for it — the reply arrives on the conversation's stream.
    expect(messages).toEqual([]);
    await settle();
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      text: 'hello',
      mentioned: true,
      // The tenant the host resolved from the path, not the key the document declared: it is what
      // the request actually routed on, so the two cannot drift (spec section 4.9).
      tenantHint: 'alpha',
      message: { surface: 'web', conversation: 'inbox', id: 'w1' },
    });
  });

  it('refuses a missing, malformed or wrong bearer with one reason, before it parses anything', async () => {
    const { session, messages } = open();
    for (const headers of [
      { 'content-type': 'application/json' },
      { authorization: 'Bearer' },
      { authorization: `Bearer ${TOKEN}x` },
      { authorization: `Bearer ${TOKEN.slice(0, -1)}` },
      { authorization: `Basic ${TOKEN}` },
    ]) {
      const response = await session.http!.handle(
        post('messages', { userId: 'U012', conversation: 'inbox', text: 'hello' }, { headers }),
      );
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(response.refusal, JSON.stringify(headers)).toEqual({ reason: 'bad_bearer' });
      expect(response.headers?.['content-type']).toBe('application/json');
      // Nothing of the body is read, repeated or delivered: a refused request is one nobody has
      // authenticated (invariant 20).
      expect(await bodyText(response)).toBe('{"error":"unauthorised"}');
    }
    await settle();
    expect(messages).toEqual([]);
  });

  it('refuses a body that is not JSON and a body the route will not take, with no refusal', async () => {
    const { session } = open();
    const notJson = await session.http!.handle(request({ body: 'not json' }));
    expect(notJson.status).toBe(400);
    expect(notJson.refusal).toBeUndefined();
    expect(JSON.parse(await bodyText(notJson))).toEqual({ error: 'the request body is not JSON' });
    for (const body of [{}, { userId: 'U012' }, { userId: 'U012', conversation: 'inbox' }, { conversation: 'inbox', text: 'hi' }, { userId: 'U012', conversation: 'in box', text: 'hi' }]) {
      const response = await session.http!.handle(post('messages', body));
      expect(response.status, JSON.stringify(body)).toBe(400);
      expect(response.refusal, JSON.stringify(body)).toBeUndefined();
      // The message says what was wrong and repeats nothing of what was sent.
      expect(await bodyText(response), JSON.stringify(body)).not.toContain('U012');
    }
  });

  it('refuses an attachment outside the incoming directory, and delivers nothing', async () => {
    const { session, messages } = open();
    const response = await session.http!.handle(
      post('messages', {
        userId: 'U012',
        conversation: 'inbox',
        text: 'here',
        attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
      }),
    );
    expect(response.status).toBe(400);
    expect(response.refusal).toBeUndefined();
    await settle();
    expect(messages).toEqual([]);
  });

  it('answers a known path with the wrong method with 405 and the method it serves', async () => {
    const { session } = open();
    const get = await session.http!.handle(request({ method: 'GET', path: 'messages' }));
    expect(get.status).toBe(405);
    expect(get.headers?.allow).toBe('POST');
    expect(get.refusal).toBeUndefined();
    const stream = await session.http!.handle(request({ path: 'conversations/inbox/events' }));
    expect(stream.status).toBe(405);
    expect(stream.headers?.allow).toBe('GET');
  });

  it('answers a sub-path no route claims with 404 and no refusal', async () => {
    const { session } = open();
    for (const path of ['', 'nope', 'conversations', 'conversations/inbox', 'messages/extra']) {
      const response = await session.http!.handle(request({ path }));
      expect(response.status, path).toBe(404);
      expect(response.refusal, path).toBeUndefined();
    }
  });

  it('opens a conversation stream, and replies land on it', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    expect(response.status).toBe(202);
    expect(response.headers).toEqual({
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      'x-accel-buffering': 'no',
    });
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const first = chunks.next();
    await session.postText('inbox', 'the answer');
    expect((await first).value).toBe(
      'id: 1\nevent: message\ndata: {"message":{"surface":"web","conversation":"inbox","id":"w1"},"text":"the answer","replyTo":null}\n\n',
    );
  });

  it('streams a reply as deltas and closes it with the whole message', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const stream = session.startStream('inbox');
    stream.append('par');
    expect((await chunks.next()).value).toContain('event: delta');
    stream.append('tial');
    expect((await chunks.next()).value).toContain('"delta":"tial"');
    // `message` is what says the reply ended, and it carries the whole text: a client reading only
    // deltas could not tell a finished answer from a pause (plan decision 6).
    await stream.end();
    const last = (await chunks.next()).value as string;
    expect(last).toContain('event: message');
    expect(last).toContain('"text":"partial"');
  });

  it('carries a card, a card update and a private note as their own frames', async () => {
    const { session } = open();
    const response = await session.http!.handle(request({ method: 'GET', path: 'conversations/inbox/events' }));
    const chunks = (response.body as AsyncIterable<string>)[Symbol.asyncIterator]();
    const card = {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [{ id: 'harness_approval_approve', label: 'Approve', style: 'primary' as const, value: 'a-1' }],
    };
    const ref = await session.postCard('inbox', card);
    expect((await chunks.next()).value).toContain('event: card');
    await session.updateCard(ref, { ...card, actions: [] });
    expect((await chunks.next()).value).toContain('event: card_update');
    await session.postPrivate('inbox', 'U012', 'You are not an approver.');
    const note = (await chunks.next()).value as string;
    expect(note).toContain('event: notice');
    // The note names who it is for. The stream is per conversation and is read by the workspace,
    // not by one person's browser, so the workspace routes it — which is exactly what
    // `postPrivate` means on a surface whose client is a server.
    expect(note).toContain('"userId":"U012"');
  });

  it('delivers a button press, with the card it was on', async () => {
    const { session, actions } = open();
    const ref = await session.postCard('inbox', {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [],
    });
    const response = await session.http!.handle(
      post('actions', { userId: 'U012', actionId: 'harness_approval_approve', value: 'a-1', messageRef: ref }),
    );
    expect(response.status).toBe(202);
    expect(JSON.parse(await bodyText(response))).toEqual({});
    await settle();
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      actionId: 'harness_approval_approve',
      value: 'a-1',
      message: ref,
    });
    expect(actions[0].trigger).not.toBeNull();
  });

  it('opens a form on the trigger it handed out, and hands its metadata back on submission', async () => {
    const { session, actions, forms } = open();
    const ref = await session.postCard('inbox', {
      id: 'harness_approval',
      title: 'Approve?',
      notice: 'An approval is waiting.',
      body: [],
      actions: [],
    });
    await session.http!.handle(
      post('actions', { userId: 'U012', actionId: 'harness_approval_edit', value: 'a-1', messageRef: ref }),
    );
    await settle();
    const trigger = actions[0].trigger!;
    await session.openForm(trigger, {
      id: 'harness_approval_edit_modal',
      title: 'Decline with a note',
      submitLabel: 'Decline',
      cancelLabel: 'Cancel',
      fields: [{ id: 'harness_approval_note', label: 'Note', multiline: true, optional: true }],
      metadata: '{"approvalId":"a-1","conversation":"inbox"}',
    });
    const response = await session.http!.handle(
      post('forms', {
        userId: 'U012',
        formId: 'harness_approval_edit_modal',
        values: { harness_approval_note: 'not this week' },
        messageRef: ref,
      }),
    );
    expect(response.status).toBe(202);
    await settle();
    expect(forms).toHaveLength(1);
    expect(forms[0]).toMatchObject({
      surface: 'web',
      userId: 'U012',
      conversation: 'inbox',
      formId: 'harness_approval_edit_modal',
      // The host's own string, carried out with the form and handed back untouched. The adapter
      // remembers it against the conversation the form was opened in; it never reads it.
      metadata: '{"approvalId":"a-1","conversation":"inbox"}',
      values: { harness_approval_note: 'not this week' },
    });
  });

  it('accepts an action and a form this host never posted, because a card it did not post is not an error', async () => {
    const { session, actions, forms } = open();
    const ref = { surface: 'web', conversation: 'inbox', id: 'w99' };
    expect((await session.http!.handle(post('actions', { userId: 'U012', actionId: 'nope', value: 'x', messageRef: ref }))).status).toBe(202);
    expect((await session.http!.handle(post('forms', { userId: 'U012', formId: 'nope', values: {}, messageRef: ref }))).status).toBe(202);
    await settle();
    // Delivered, and the handlers ignore an id they do not know — which is where that decision
    // already lives, for every surface.
    expect(actions).toHaveLength(1);
    expect(forms).toHaveLength(1);
    expect(forms[0].metadata).toBe('');
  });

  it('refuses to connect at all when the document named a token that resolved to nothing', () => {
    expect(() => createWebSession({ ...deps(), secretValues: {} })).toThrow(/token/);
    expect(() => createWebSession({ ...deps(), secretValues: { token: '' } })).toThrow(/token/);
  });

  it('posts where the document said, and to "inbox" when it said nothing', () => {
    expect(createWebSession(deps()).defaultConversation).toBe('inbox');
    expect(createWebSession({ ...deps(), defaultConversation: 'reception' }).defaultConversation).toBe('reception');
  });

  it('declares what it can do, and reads no environment variable to do any of it', () => {
    const session = createWebSession({ ...deps(), env: {} });
    expect(session.capabilities).toEqual({
      streaming: true,
      update: true,
      forms: true,
      privateReply: true,
      inlineConfirm: false,
    });
    expect(session.mention('U012')).toBe('@U012');
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-web exec vitest run src/door.test.ts`
Expected: FAIL — `./session.js` does not exist.

- [ ] **Step 8: Read this client's configuration**

Create `surfaces/web/src/config.ts`:

```ts
import { ConfigError, type SurfaceDeps } from './deps.js';

/** What this adapter needs to serve one tenant. Everything in it comes from the document. */
export interface WebConfig {
  /** The bearer every request carries, resolved by the host from `surfaces.web.token`. */
  token: string;
  /** Where approval cards and notices go: `surfaces.web.inbox`, or the schema's own default. */
  inbox: string;
  /** The root an attachment path is checked against. */
  storageDir: string;
}

/**
 * Read this adapter's configuration out of what the host handed over.
 *
 * **No environment variable, at all.** This surface's one credential is its tenant's, and a
 * per-tenant credential cannot live in a process's environment on a pooled host — which is the
 * whole reason the secret source exists. It arrives resolved on `deps.secretValues`, keyed by the
 * document's own field name, and the conversation cards go to arrives on
 * `deps.defaultConversation`, because both are per tenant and neither is this process's.
 */
export function webConfig(deps: SurfaceDeps): WebConfig {
  const token = deps.secretValues?.token ?? '';
  if (token.trim() === '') {
    throw new ConfigError(
      'surface "web": this client\'s document declares no token for the web surface, or it resolved to an empty value',
    );
  }
  return {
    token,
    // The schema defaults `inbox` and the host passes it through, so this fallback is for a caller
    // that built a session by hand rather than for a document that left it out.
    inbox: deps.defaultConversation ?? 'inbox',
    storageDir: deps.storageDir,
  };
}
```

The import above is written against a one-line re-export module so that every file in this package imports the contract through one path; create `surfaces/web/src/deps.ts`:

```ts
/**
 * Everything this adapter's **shipping** modules import from outside themselves, in one place.
 *
 * `pnpm arch`'s `a-surface-imports-only-api-and-shared` permits exactly `@harness/surface-api`,
 * `@harness/shared` and this package's own files — and its own tests are not exempt. Re-exporting
 * here is a readability choice, not a rule: it puts the whole of this adapter's surface area
 * against the kernel on one screen. A test imports what it needs directly, including
 * `@harness/surface-api/testing`, which the same rule allows and which no shipping module has any
 * business holding.
 */
export { ConfigError, SurfaceError, assertInsideRoot, CONVERSATION_ID_PATTERN } from '@harness/shared';
export { defineSurface } from '@harness/surface-api';
export type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageEvent,
  MessageRef,
  StreamHandle,
  Surface,
  SurfaceDeps,
  SurfaceHttp,
  SurfaceHttpRequest,
  SurfaceHttpResponse,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';
```

- [ ] **Step 9: Write the door**

Create `surfaces/web/src/door.ts`:

```ts
import { timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import {
  CONVERSATION_ID_PATTERN,
  assertInsideRoot,
  type ActionEvent,
  type FormEvent,
  type MessageEvent,
  type MessageRef,
  type SurfaceHttp,
  type SurfaceHttpRequest,
  type SurfaceHttpResponse,
} from './deps.js';
import type { ConversationStreams } from './stream.js';

/**
 * Where the workspace reaches this tenant: `/tenants/<clientId>/web/...`.
 *
 * One mount, four routes under it. The host resolves the tenant from the path before this handler
 * is called and hands the rest of it over as `request.path`, so nothing here ever sees, or has to
 * agree with, the prefix in front of it.
 */
export const WEB_MOUNT_PATH = 'web';

/** One message. Longer than any person writes, and shorter than a document, which belongs in `incoming/`. */
export const WEB_MAX_TEXT_CHARS = 10_000;
/** How many attachments one message may name. The run API's own cap, for the same reason. */
export const WEB_MAX_ATTACHMENTS = 10;

/** A conversation's event stream: `GET web/conversations/<id>/events`. */
const EVENTS_ROUTE = /^conversations\/([^/]+)\/events$/;

/** What the door needs from the session to do its work. The session owns all of it. */
export interface WebInbound {
  readonly token: string;
  readonly storageDir: string;
  readonly streams: ConversationStreams;
  /** The reference this message gets, which is what the caller is answered with. */
  inboundRef(conversation: string): MessageRef;
  /** An opaque handle this surface accepts back in `openForm`, minted per delivered action. */
  triggerFor(conversation: string): string;
  /** The metadata the form with this id was opened with in this conversation; empty for none. */
  metadataFor(conversation: string, formId: string): string;
  deliver(what: string, run: () => Promise<void>): void;
  message(event: MessageEvent): Promise<void>;
  action(event: ActionEvent): Promise<void>;
  form(event: FormEvent): Promise<void>;
}

/** Every answer this door gives that carries JSON, typed so a client can be coded against it. */
const JSON_HEADERS = { 'content-type': 'application/json' } as const;

const json = (status: number, body: unknown): SurfaceHttpResponse => ({
  status,
  headers: JSON_HEADERS,
  body: JSON.stringify(body),
});

/** A refusal the host audits exactly once, with a reason it can group by. */
const refused = (reason: string, error: string): SurfaceHttpResponse => ({
  ...json(401, { error }),
  refusal: { reason },
});

const badRequest = (what: string): SurfaceHttpResponse => json(400, { error: what });

/**
 * Constant-time on the bytes, after a length check.
 *
 * This adapter's own, and not the host's `bearerOk`: `pnpm arch` allows a surface to import
 * `@harness/surface-api` and `@harness/shared` and nothing else, and the host's copy is in
 * neither. The shape is the same and so is the reason — `timingSafeEqual` throws on a length
 * mismatch, and comparing lengths first leaks only the token's length, which a caller who can
 * measure a comparison could learn anyway.
 */
function bearerOk(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header || !header.startsWith(prefix)) return false;
  const offered = Buffer.from(header.slice(prefix.length), 'utf8');
  const expected = Buffer.from(token, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

/** A parsed object, or null for anything a field cannot be read off. */
function objectBody(text: string): Record<string, unknown> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : null;
}

/** A non-empty string no longer than `max`, or null. Deliberately not a zod schema: it is a string. */
function stringField(value: unknown, max: number): string | null {
  return typeof value === 'string' && value !== '' && value.length <= max ? value : null;
}

/** A message reference the workspace got from a frame, narrowed to what is read off it. */
function messageRef(value: unknown): MessageRef | null {
  if (typeof value !== 'object' || value === null) return null;
  const ref = value as { surface?: unknown; conversation?: unknown; id?: unknown };
  const conversation = stringField(ref.conversation, 200);
  const id = stringField(ref.id, 200);
  if (ref.surface !== 'web' || conversation === null || id === null) return null;
  if (!CONVERSATION_ID_PATTERN.test(conversation)) return null;
  return { surface: 'web', conversation, id };
}

/** `[{ name, path }]`, capped, or null when the field is present and is not that. */
function attachments(value: unknown): { name: string; path: string }[] | null {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > WEB_MAX_ATTACHMENTS) return null;
  const out: { name: string; path: string }[] = [];
  for (const entry of value as { name?: unknown; path?: unknown }[]) {
    const name = stringField(entry?.name, 255);
    const file = stringField(entry?.path, 512);
    if (name === null || file === null) return null;
    out.push({ name, path: file });
  }
  return out;
}

/**
 * The four routes, and one bearer in front of all of them.
 *
 * **The bearer is checked first**, before the method, before the route and before a byte of the
 * body is parsed (invariant 20): a caller who cannot authenticate learns neither which routes
 * exist nor whether their body was readable. Every other refusal below is a caller's mistake
 * rather than a door turning somebody away, so none of them carries a `refusal` and none of them
 * costs an audit row.
 */
export function createDoor(inbound: WebInbound): SurfaceHttp {
  const handleMessage = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, 200);
    const conversation = stringField(body.conversation, 200);
    const text = stringField(body.text, WEB_MAX_TEXT_CHARS);
    if (userId === null) return badRequest('userId is required');
    if (conversation === null || !CONVERSATION_ID_PATTERN.test(conversation)) {
      return badRequest('conversation is a conversation id: no spaces and no control characters');
    }
    if (text === null) return badRequest(`text is required and may be at most ${WEB_MAX_TEXT_CHARS} characters`);
    const files = attachments(body.attachments);
    if (files === null) return badRequest(`attachments are at most ${WEB_MAX_ATTACHMENTS} entries of { name, path }`);
    // A path that came from a caller, checked against the one directory a caller may name. Every
    // other adapter stages its own files and its paths are trustworthy by construction; these are
    // not, which is why the run API checks the same thing in the same way.
    const incoming = path.join(inbound.storageDir, 'incoming');
    for (const file of files) {
      try {
        await assertInsideRoot(
          file.path,
          incoming,
          () => {
            throw new Error('outside');
          },
          { allowRoot: false },
        );
      } catch {
        return badRequest(`attachment "${file.name}" is not a path inside the incoming directory`);
      }
    }
    const ref = inbound.inboundRef(conversation);
    // Acknowledge, then run. A turn takes seconds to minutes and the caller is not waiting for it:
    // the reply arrives on this conversation's stream.
    inbound.deliver('a web message', () =>
      inbound.message({
        surface: 'web',
        userId,
        conversation,
        text,
        attachments: files,
        message: ref,
        // Every message on this surface is addressed to the assistant: a workspace that is talking
        // to its agent has no channel chatter to overhear.
        mentioned: true,
        // The tenant the host resolved from the mount path. **Not `deps.tenantKey`**: both would
        // work and this is the one that cannot be misconfigured (spec section 4.9).
        tenantHint: request.clientId,
      }),
    );
    return json(202, { message: ref });
  };

  const handleAction = (request: SurfaceHttpRequest): SurfaceHttpResponse => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, 200);
    const actionId = stringField(body.actionId, 200);
    const value = typeof body.value === 'string' ? body.value : null;
    const ref = messageRef(body.messageRef);
    if (userId === null) return badRequest('userId is required');
    if (actionId === null) return badRequest('actionId is required');
    if (value === null) return badRequest('value is required');
    if (ref === null) return badRequest('messageRef is a reference this surface handed out');
    inbound.deliver('a web action', () =>
      inbound.action({
        surface: 'web',
        userId,
        conversation: ref.conversation,
        message: ref,
        actionId,
        value,
        trigger: inbound.triggerFor(ref.conversation),
      }),
    );
    return json(202, {});
  };

  const handleForm = (request: SurfaceHttpRequest): SurfaceHttpResponse => {
    const body = objectBody(request.body);
    if (!body) return badRequest('the request body is not JSON');
    const userId = stringField(body.userId, 200);
    const formId = stringField(body.formId, 200);
    const ref = messageRef(body.messageRef);
    if (userId === null) return badRequest('userId is required');
    if (formId === null) return badRequest('formId is required');
    if (ref === null) return badRequest('messageRef is a reference this surface handed out');
    const values: Record<string, string> = {};
    const raw = body.values;
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return badRequest('values is an object');
    for (const [key, entry] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof entry !== 'string') return badRequest(`values.${key} is a string`);
      values[key] = entry;
    }
    inbound.deliver('a web form submission', () =>
      inbound.form({
        surface: 'web',
        userId,
        conversation: ref.conversation,
        formId,
        // The host's own string, handed back untouched. The adapter remembered it when the form
        // was opened and never read it; a form this host did not open carries an empty one, and
        // the host's handler answers that the approval no longer exists.
        metadata: inbound.metadataFor(ref.conversation, formId),
        values,
      }),
    );
    return json(202, {});
  };

  const handle = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    if (!bearerOk(request.headers.authorization, inbound.token)) {
      return refused('bad_bearer', 'unauthorised');
    }
    const events = EVENTS_ROUTE.exec(request.path);
    if (events) {
      if (request.method !== 'GET') return { status: 405, headers: { allow: 'GET' } };
      // The same shape `POST …/web/messages` requires of a conversation. Without it a caller
      // could open a stream on an id it could never write to — nothing grows, because `open`
      // only reads the map, but one route accepting what the other refuses is the kind of
      // difference a client is eventually written against.
      if (!CONVERSATION_ID_PATTERN.test(events[1])) return badRequest('conversation is a conversation id');
      return {
        status: 202,
        // The three headers that stop something in between buffering a stream into one response,
        // and the status the run API's own stream answers with: the request is accepted, and what
        // follows is the conversation happening.
        headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'x-accel-buffering': 'no' },
        body: inbound.streams.open(events[1], request.signal, request.headers['last-event-id'] ?? null),
      };
    }
    if (request.path === 'messages' || request.path === 'actions' || request.path === 'forms') {
      if (request.method !== 'POST') return { status: 405, headers: { allow: 'POST' } };
      if (request.path === 'messages') return handleMessage(request);
      return request.path === 'actions' ? handleAction(request) : handleForm(request);
    }
    return json(404, { error: 'no such route' });
  };

  return { path: WEB_MOUNT_PATH, handle };
}
```

- [ ] **Step 10: Write the session**

Create `surfaces/web/src/session.ts`:

```ts
import {
  SurfaceError,
  type ActionEvent,
  type Card,
  type Form,
  type FormEvent,
  type MessageEvent,
  type MessageRef,
  type StreamHandle,
  type SurfaceDeps,
  type SurfaceSession,
  type UploadRequest,
} from './deps.js';
import { webConfig } from './config.js';
import { createDoor, type WebInbound } from './door.js';
import { ConversationStreams } from './stream.js';

const NAME = 'web';

/**
 * How many triggers and open forms one session remembers.
 *
 * Both are short-lived handles a workspace hands straight back, so a bound of a few hundred is
 * generous; what it is really for is a session that runs for weeks without one growing.
 */
const HANDLE_LIMIT = 200;

/** A bounded map: the oldest entry goes when a new one would push it past the limit. */
class Recent<T> {
  private readonly entries = new Map<string, T>();

  set(key: string, value: T): void {
    this.entries.delete(key);
    this.entries.set(key, value);
    if (this.entries.size > HANDLE_LIMIT) {
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) this.entries.delete(oldest);
    }
  }

  get(key: string): T | undefined {
    return this.entries.get(key);
  }
}

/**
 * A session with one member of its own: the deliveries its door has acknowledged.
 *
 * The contract has no `settled`, and should not — it is a thing a *test* needs of an adapter that
 * answers before it delivers, and the host never waits on one. `MemorySurface` carries the same
 * member for the same reason.
 */
export interface WebSession extends SurfaceSession {
  settled(): Promise<void>;
}

/**
 * The web surface: a conversation with an agent, over HTTP, for a tenant with no Slack.
 *
 * Every outbound call becomes a frame on the conversation's stream, and every inbound one arrives
 * at the door (`door.ts`) and is delivered here. What the host sees is a `SurfaceSession` like any
 * other: it posts cards to `defaultConversation`, resolves the writer through the tenant's
 * identity plug-in, and knows nothing about routes, frames or bearers.
 */
export function createWebSession(deps: SurfaceDeps): WebSession {
  const config = webConfig(deps);
  const streams = new ConversationStreams();
  const triggers = new Recent<string>();
  const forms = new Recent<string>();
  /** The deliveries this door has acknowledged and not yet finished, so a caller can await them. */
  const delivering = new Set<Promise<void>>();
  let seq = 0;
  let handles = 0;
  let messageHandler: ((event: MessageEvent) => Promise<void>) | null = null;
  let actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  let formHandler: ((event: FormEvent) => Promise<void>) | null = null;
  let stopped = false;

  const ref = (conversation: string): MessageRef => {
    seq += 1;
    return { surface: NAME, conversation, id: `w${seq}` };
  };

  const inbound: WebInbound = {
    token: config.token,
    storageDir: config.storageDir,
    streams,
    inboundRef: ref,
    triggerFor(conversation) {
      handles += 1;
      const trigger = `t${handles}`;
      triggers.set(trigger, conversation);
      return trigger;
    },
    metadataFor: (conversation, formId) => forms.get(`${conversation}:${formId}`) ?? '',
    /**
     * Start work this request has already been acknowledged for; a failure is a log line.
     *
     * On a later tick rather than now, for the reason the Slack transport gives: `void run()`
     * alone would execute everything up to the turn's first real suspension before the 202 it is
     * owed had been built.
     *
     * Each delivery is held in `delivering` until it settles, so `settled()` can await them. That
     * is not a convenience: a door that answers before it delivers leaves a turn opening a run
     * and writing `messages` rows after the case that started it has returned, and the next
     * case's `TRUNCATE` deadlocks against it (`40P01`). `MemorySurface` carries the same set for
     * the same reason, and `settleDeliveries` in the host's fixture awaits both.
     */
    deliver(what, run) {
      setImmediate(() => {
        // `try` as well as `catch`: a handler that threw where it stands rather than rejecting
        // would escape a bare `.catch` and, at the top of the event loop, take the process down.
        try {
          const delivery = run().catch((err: unknown) => deps.log.error(`${what} failed`, err));
          delivering.add(delivery);
          void delivery.finally(() => delivering.delete(delivery));
        } catch (err: unknown) {
          deps.log.error(`${what} failed`, err);
        }
      });
    },
    async message(event) {
      if (!messageHandler) {
        deps.log.warn('a web message arrived before a handler was registered');
        return;
      }
      await messageHandler(event);
    },
    async action(event) {
      if (!actionHandler) {
        deps.log.warn('a web action arrived before a handler was registered');
        return;
      }
      await actionHandler(event);
    },
    async form(event) {
      if (!formHandler) {
        deps.log.warn('a web form submission arrived before a handler was registered');
        return;
      }
      await formHandler(event);
    },
  };

  /** Every outbound call goes through here, so a stopped session posts nowhere. */
  const emit = (conversation: string, event: Parameters<ConversationStreams['emit']>[1], data: unknown): void => {
    if (stopped) throw new SurfaceError(`${NAME}: this session has been stopped`);
    streams.emit(conversation, event, data);
  };

  return {
    name: NAME,
    capabilities: { streaming: true, update: true, forms: true, privateReply: true, inlineConfirm: false },
    defaultConversation: config.inbox,
    http: createDoor(inbound),

    /**
     * `@<userId>`, and deliberately not a display name.
     *
     * A surface is handed a user id and nothing else; the display name a rules block renders is
     * the identity plug-in's answer, on every surface, and inventing a body field to carry one
     * would be inventing a contract (plan decision 7).
     */
    mention: (userId) => `@${userId}`,

    async postCard(conversation, card: Card) {
      const message = ref(conversation);
      emit(conversation, 'card', { message, card });
      return message;
    },

    async updateCard(message, card: Card) {
      emit(message.conversation, 'card_update', { message, card });
    },

    async postText(conversation, text, opts = {}) {
      const message = ref(conversation);
      emit(conversation, opts.kind === 'notice' ? 'notice' : 'message', {
        message,
        text,
        replyTo: opts.replyTo ?? null,
      });
      return message;
    },

    async postPrivate(conversation, userId, text) {
      // The stream is per conversation and is read by the workspace rather than by one person's
      // browser, so a private note names who it is for and the workspace routes it. That is what
      // `privateReply` means on a surface whose client is a server.
      emit(conversation, 'notice', { text, userId });
    },

    async uploadFile(conversation, file: UploadRequest) {
      const message = ref(conversation);
      // The bytes stay on the host: this frame says a file was released and names it, and how the
      // workspace fetches it is its own business — there is no route here that serves one.
      emit(conversation, 'message', {
        message,
        text: file.comment ?? `Sent a file: ${file.filename}`,
        file: { filename: file.filename },
        replyTo: file.replyTo ?? null,
      });
      return { filename: file.filename };
    },

    async openForm(trigger, form: Form) {
      const conversation = triggers.get(trigger);
      if (conversation === undefined) throw new SurfaceError(`${NAME}: that trigger is no longer open`);
      // Remembered against the conversation it was opened in, and handed back untouched when the
      // form comes in. The adapter never reads it: it is the host's own string.
      forms.set(`${conversation}:${form.id}`, form.metadata);
      emit(conversation, 'card', { form });
    },

    onAction(handler) {
      actionHandler = handler;
    },
    onFormSubmit(handler) {
      formHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },

    startStream(conversation, opts = {}) {
      const message = ref(conversation);
      let text = '';
      return {
        append: (delta) => {
          text += delta;
          emit(conversation, 'delta', { message, delta });
        },
        end: async () => {
          emit(conversation, 'message', { message, text, replyTo: opts.replyTo ?? null });
          return message;
        },
      } satisfies StreamHandle;
    },

    /**
     * Wait for every delivery this door has acknowledged, to the end of its turn.
     *
     * Not part of `SurfaceSession` — it is this adapter's own, the way `MemorySurface.settled` is
     * — and the host's test fixture calls it on any session that has one. It is **not** called
     * from `stop()`: `quiesce` stops a tenant's sessions *before* it drains them, so a `stop`
     * that awaited a whole turn would make a document edit wait out that turn unbounded, where
     * the drain that follows it is bounded on purpose.
     */
    settled: async (): Promise<void> => {
      await Promise.all(delivering);
    },

    /** Nothing to open: the host mounts the door and hands over what arrives. */
    start: () => Promise.resolve(),
    /**
     * Drop the handlers, so a tenant that is shutting down cannot be delivered into by a request
     * that arrives while its surfaces are being stopped, and post nowhere afterwards.
     */
    stop: () => {
      stopped = true;
      messageHandler = null;
      actionHandler = null;
      formHandler = null;
      return Promise.resolve();
    },
  };
}
```

and `surfaces/web/src/index.ts`:

```ts
import { defineSurface, type Surface } from './deps.js';
import { createWebSession } from './session.js';

/**
 * The surface a workspace talks to.
 *
 * A tenant with no Slack has no chat and nowhere to put an approval card: `http` may not be a
 * primary surface by schema rule and `memory` posts nowhere. This is what such a tenant declares
 * instead, and `SURFACE_ORDER` puts it first, so its cards go to its own inbox.
 *
 * It opens nothing. The host mounts its door at `/tenants/<clientId>/web/...` and hands over what
 * arrives; every request carries the tenant's own bearer, which the host resolved from
 * `surfaces.web.token` through whatever secret source the deployment configured.
 */
export const surface: Surface = defineSurface({
  name: 'web',
  version: '0.1.0',
  // None. This adapter reads no environment variable at all: its one credential is its tenant's,
  // and it arrives resolved on `deps.secretValues` (spec section 12, constraint 24).
  secrets: [],
  // Not `async`: building the session opens nothing.
  connect: (deps) => Promise.resolve(createWebSession(deps)),
});
```

Create `surfaces/web/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the web surface declaration', () => {
  it('declares its name and no environment credential at all', () => {
    expect(surface.name).toBe('web');
    // Its one credential is its tenant's, resolved by the host. A name here would be a
    // deployment-wide variable, which is exactly what a pooled host cannot have.
    expect(surface.secrets).toEqual([]);
  });

  it('connects from the document alone, and refuses a tenant whose token resolved to nothing', async () => {
    const deps = {
      env: {},
      log: { info() {}, warn() {}, error() {} },
      storageDir: '/nonexistent',
      secretValues: { token: 'wt-0123456789abcdef' },
      defaultConversation: 'inbox',
    };
    const session = await surface.connect(deps);
    expect(session.name).toBe('web');
    expect(session.defaultConversation).toBe('inbox');
    expect(session.http?.path).toBe('web');
    // Wrapped, because `connect` reads its configuration before it has anything to await and so
    // raises where it stands; the contract says a caller gets a promise.
    await expect((async () => surface.connect({ ...deps, secretValues: {} }))()).rejects.toThrow(/token/);
  });
});
```

- [ ] **Step 11: Run the adapter's own suites green**

Run: `pnpm --filter @harness/surface-web test`
Expected: PASS — seven stream cases, fifteen door cases and two declaration cases.

- [ ] **Step 12: Carry the inbox from the document to the adapter**

Three small edits, and they are the third member of a family that already exists: `tenantKeysOf` carries a routing key, `surfaceSecretsOf` carries a credential, and this carries a conversation — each read out of the typed surface section in `@harness/config-api` so that `harness/host/src` reads none of them.

In `harness/config-api/src/document.ts`, give `SurfacesShape.web` its second field:

```ts
    web: z
      .object({
        /** The bearer every request to this surface carries; only the platform's control plane holds it. */
        token: SecretRefShape,
        /**
         * The conversation this surface posts approval cards and notices to, and the one the
         * workspace opens a stream on first. A conversation is created by writing to it, so this
         * names one rather than declaring it.
         */
        inbox: z.string().regex(CONVERSATION_ID_PATTERN, 'an inbox is a conversation id').default('inbox'),
      })
      .strict()
      .optional(),
```

with `CONVERSATION_ID_PATTERN` added to the `@harness/shared` import at the top of that file.

and add the accessor beside `tenantKeysOf`:

```ts
/**
 * The conversation each surface that has one posts to, by that surface's name.
 *
 * The third of the three readers of the typed surface sections, and it exists for the same reason
 * as the other two: the host copies an opaque `{ surface, conversation }` pair into the bag an
 * adapter is handed and never learns that a web surface has an inbox. A surface whose default
 * conversation is a deployment-wide setting — Slack's approvals channel is an environment
 * variable — contributes nothing here.
 */
export function surfaceConversationsOf(document: ClientDocument): { surface: string; conversation: string }[] {
  const web = document.surfaces.web;
  return web ? [{ surface: 'web', conversation: web.inbox }] : [];
}
```

exported from `harness/config-api/src/index.ts` beside `surfaceSecretsOf`.

In `harness/surface-api/src/types.ts`, one more optional member on `SurfaceDeps`, after `tenantKey`:

```ts
  /**
   * Where this surface posts when nobody names a conversation, when the client's document names
   * one.
   *
   * `SurfaceSession.defaultConversation` is what the host reads, and for most adapters the answer
   * is a deployment-wide setting — Slack's approvals channel is an environment variable. For a
   * surface whose inbox is per tenant there is nowhere else for it to come from, and a pooled
   * host cannot have a per-tenant variable: the document names it and the host passes it through,
   * opaquely, exactly as it passes `tenantKey`.
   */
  defaultConversation?: string;
```

In `harness/approvals/src/domain/surfaces/registry.ts`, the matching member on `SurfaceSettings`:

```ts
  /** Where this surface posts when nobody names a conversation, when the document names one. */
  readonly defaultConversation?: string;
```

In `harness/host/src/domain/tenancy/tenant.ts`, one more loop beside the other two, and `surfaceConversationsOf` added to the `@harness/config-api` import:

```ts
  for (const { surface, conversation } of surfaceConversationsOf(document)) {
    settings[surface] = { ...settings[surface], defaultConversation: conversation };
  }
```

**And one edit in the host's fixture, without which this task's own suite is a cross-file flake.** `settleDeliveries` in `harness/host/src/testing.ts` awaits only `session instanceof MemorySurface`, and its comment explains at length why: a door that answers before it delivers leaves a turn writing rows after the case that started it returned, and the next case's `TRUNCATE` deadlocks against it. The web door is the second such door, so the check becomes structural:

```ts
async function settleDeliveries(pool: HostPool): Promise<void> {
  for (const tenant of pool.tenants.values()) {
    for (const session of tenant.host.surfaces.all) {
      // Duck-typed rather than `instanceof`: two adapters acknowledge before they deliver now,
      // and a third would be a third import in a file that may not import an adapter at all.
      // What the fixture needs is the promise, not the class.
      const settled = (session as { settled?: () => Promise<void> }).settled;
      if (typeof settled === 'function') await settled.call(session);
    }
  }
}
```

`MemorySurface` stays imported in that file for `PoolFixture.surface`'s cast, so nothing else there moves.

and in `harness/config-api/src/document.test.ts`, extend the web case once more:

```ts
    // The inbox the schema defaults, and the one a document names instead. It travels to the
    // adapter the way the tenant key does: opaquely, through the host.
    expect(surfaceConversationsOf(withWeb)).toEqual([{ surface: 'web', conversation: 'inbox' }]);
    const named = parseClientDocument(
      fixtureDocument({ surfaces: { web: { token: { ref: 'web-token' }, inbox: 'reception' }, http: {} } }),
    );
    expect(surfaceConversationsOf(named)).toEqual([{ surface: 'web', conversation: 'reception' }]);
    // A document that declares no web surface names no conversation at all.
    expect(surfaceConversationsOf(parseClientDocument(fixtureDocument()))).toEqual([]);
```

- [ ] **Step 13: Bound what a web default may mint (invariant 24)**

A leaked web token can mint principals through `defaults.web`, and the reason `http` may never have a default reads as a description of this surface — "a single shared bearer token… and the surface user id straight from the request body". The difference the yes relies on is that the platform authenticates the person before it calls, which is a difference in intent rather than in mechanism, so `defaults.web` is **bounded rather than banned** (spec §13.6).

In `harness/identity-api/src/principals.ts`, beside `UNDEFAULTABLE_SURFACE`:

```ts
/**
 * The surface whose default may not mint an approver, and the highest level it may mint.
 *
 * `web` authenticates with one shared bearer and takes the surface user id from the request body,
 * exactly as the run API does — the difference is that the platform's workspace authenticates the
 * person before it calls, which is a difference in intent and not in mechanism. A Slack-less
 * tenant with no default has no way to let a new person speak at all, so a ban is not available;
 * a ceiling is. A leaked web token can therefore mint principals, and none of them can decide an
 * approval, which needs `lead` (invariant 24, spec section 13.6).
 */
export const CEILED_DEFAULT_SURFACE = 'web';
export const CEILED_DEFAULT_CEILING: UserLevel = 'practitioner';
```

and, in `parseIdentityFileWithDefaults`, immediately after the `UNDEFAULTABLE_SURFACE` check:

```ts
  const ceiled = parsed.data.defaults[CEILED_DEFAULT_SURFACE];
  if (ceiled !== undefined && !levelAtLeast(CEILED_DEFAULT_CEILING, ceiled)) {
    throw new ConfigError(
      `identity section: "${CEILED_DEFAULT_SURFACE}" may not default to "${ceiled}"; one shared bearer mints every principal this default describes, so it may not reach "${ceiled}" — "${CEILED_DEFAULT_CEILING}" is the highest it may name`,
    );
  }
```

`principals.ts` imports neither name today. `UserLevel` comes from `./types.js`, which that file already imports; **`levelAtLeast` is declared in `harness/identity-api/src/identity.ts:36`** — not in `@harness/shared`, whose `levels.ts` holds only `LEVELS` and `USER_LEVELS` — so add `import { levelAtLeast } from './identity.js';`. There is no cycle for `no-circular` to catch: `identity.ts` imports `@harness/shared` and `./types.js` and nothing else.

The comparison reads the way it does because `levelAtLeast(actual, required)` is an index test over `USER_LEVELS`, so `!levelAtLeast(CEILED_DEFAULT_CEILING, ceiled)` is true for exactly `lead` and `admin` and false for `member` and `practitioner`.

In `harness/identity-api/src/principals.test.ts`, beside the `http` case:

```ts
  it('bounds what a web default may mint, and admits the levels below the ceiling', () => {
    for (const level of ['member', 'practitioner']) {
      expect(parseIdentityFileWithDefaults({ defaults: { web: level }, principals: [manager] }).defaults).toEqual({
        web: level,
      });
    }
    for (const level of ['lead', 'admin']) {
      expect(() => parseIdentityFileWithDefaults({ defaults: { web: level }, principals: [manager] })).toThrow(
        ConfigError,
      );
      expect(() => parseIdentityFileWithDefaults({ defaults: { web: level }, principals: [manager] })).toThrow(
        /may not default to/,
      );
    }
    // And the ban on the other surface is untouched: `http` may have no default at all.
    expect(() => parseIdentityFileWithDefaults({ defaults: { http: 'member' }, principals: [manager] })).toThrow(
      ConfigError,
    );
  });
```

- [ ] **Step 14: Write the failing end-to-end test, through the real pool**

Create `harness/host/src/domain/api/web-surface.test.ts`. Every case drives a real pooled host over Postgres, with the scripted runtime and the static identity plug-in the document names, and reaches the adapter the way a browser does: over the socket, at `/tenants/<clientId>/web/...`.

```ts
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { APPROVE_ACTION_ID, EDIT_ACTION_ID, EDIT_FORM_ID, EDIT_NOTE_FIELD_ID, postPendingApprovals } from '@harness/approvals';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { hashArgs } from '@harness/core-tools';
import { approvals, auditLog } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { poolFixture, useTestDb, waitFor, type PoolFixture } from '../../testing.js';
import { startRunApi } from './server.js';

const db = useTestDb();
/** The bearer one tenant's document names; each tenant gets its own, stored under one name. */
const tokenFor = (clientId: string): string => `wt-${clientId}-0123456789`;

/**
 * A tenant with a web surface and the run API, and nobody on Slack.
 *
 * `surfaces.web` is first in `SURFACE_ORDER`, so it is the primary surface and its inbox is where
 * approval cards go. The principals are declared on `web` rather than on `memory`: this document
 * loads no memory surface at all, which is what a real workspace tenant looks like.
 */
const webTenant = (id: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { web: { token: { ref: 'web-token' } }, http: {} },
      identity: {
        principals: [
          { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { web: 'U012' } },
          { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { web: 'U345' } },
          { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
          { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' },
        ],
      },
    }),
  );

interface Served {
  f: PoolFixture;
  url: string;
  post(clientId: string, path: string, body: unknown, token?: string): Promise<Response>;
  events(clientId: string, conversation: string, headers?: Record<string, string>): Promise<Response>;
}

/** A pooled host over these tenants, each with its bearer in the store, and the listener over it. */
async function serve(ids: readonly string[], trajectories: Record<string, Trajectory> = {}): Promise<Served> {
  const secrets = new MemorySecretSource();
  for (const id of ids) secrets.put(id, 'web-token', tokenFor(id));
  const f = await poolFixture(db, { documents: ids.map(webTenant), trajectories, secrets });
  const server = startRunApi(f.pool, { token: 'sk-web-surface-test', bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  return {
    f,
    url,
    post: (clientId, path, body, token = tokenFor(clientId)) =>
      fetch(`${url}/tenants/${clientId}/web/${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify(body),
      }),
    events: (clientId, conversation, headers = {}) =>
      fetch(`${url}/tenants/${clientId}/web/conversations/${conversation}/events`, {
        headers: { authorization: `Bearer ${tokenFor(clientId)}`, ...headers },
      }),
  };
}

/** One read off a live stream, so a case can act while the turn is still running. */
async function frame(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const { value, done } = await reader.read();
  return done ? '' : new TextDecoder().decode(value);
}

/** Read frames until one matches, so a case is not sensitive to a keep-alive landing first. */
async function frameMatching(reader: ReadableStreamDefaultReader<Uint8Array>, what: string): Promise<string> {
  for (let read = 0; read < 20; read += 1) {
    const chunk = await frame(reader);
    if (chunk.includes(what)) return chunk;
    if (chunk === '') break;
  }
  throw new Error(`no frame carrying "${what}" arrived`);
}

const refusals = async (): Promise<(typeof auditLog.$inferSelect)[]> =>
  db.select().from(auditLog).where(eq(auditLog.decision, 'refused'));

/**
 * Poll one approval until its status moves off `pending`, and answer with what it moved to.
 *
 * A decision arrives through the door, is acknowledged, and is decided on a later tick, so a case
 * that read the row straight after the 202 would read it before the decision path had run.
 * `waitFor` takes a synchronous predicate and this has to `await` a query, which is why it polls
 * here instead: five milliseconds at a time, bounded by vitest's own test timeout.
 */
async function decidedStatus(id: string): Promise<string> {
  for (;;) {
    const [row] = await db.select({ status: approvals.status }).from(approvals).where(eq(approvals.id, id));
    if (row.status !== 'pending') return row.status;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

describe('a tenant with no Slack, talking to its agent over the web surface', () => {
  it('runs a turn from a posted message and puts the reply on the conversation’s stream', async () => {
    const s = await serve(['alpha'], { alpha: [{ say: 'Hello back.' }] });
    const stream = await s.events('alpha', 'inbox');
    expect(stream.status).toBe(202);
    expect(stream.headers.get('content-type')).toBe('text/event-stream');
    const reader = stream.body!.getReader();
    const response = await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hello' });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({ message: { surface: 'web', conversation: 'inbox', id: 'w1' } });
    const reply = await frameMatching(reader, 'event: message');
    expect(reply).toContain('Hello back.');
    // Every frame carries an id, which is what makes the stream resumable.
    expect(reply).toMatch(/^id: \d+\n/);
    await reader.cancel();
  });

  it('resumes a stream after the last id a client saw, and repeats nothing before it', async () => {
    const s = await serve(['alpha'], { alpha: [{ say: 'First.' }, { say: 'Second.' }] });
    const first = await s.events('alpha', 'inbox');
    const firstReader = first.body!.getReader();
    await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'one' });
    // The **closing** frame of that turn, not the delta before it. A `{ say }` step yields a
    // `text` event and then `done` (`scripted.ts`), and this surface declares `streaming: true`,
    // so `runTurn` opens a stream: `First.` arrives twice, once as a `delta` and once inside the
    // `message` that ends the turn. Resuming after the delta would replay the message and the
    // last assertion below would fail on a frame that is not a second answer.
    const seen = await frameMatching(firstReader, '"text":"First."');
    const lastId = /^id: (\d+)/.exec(seen)![1];
    await firstReader.cancel();
    // A second turn while nobody is listening: the frames are held, and the resume collects them.
    await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'two' });
    const resumed = await s.events('alpha', 'inbox', { 'last-event-id': lastId });
    const resumedReader = resumed.body!.getReader();
    // Whatever arrives first on the resumed stream: the delta of the second turn, never anything
    // of the first. `frameMatching` would scan past a stale frame, so this reads one.
    const next = await frame(resumedReader);
    expect(next).not.toContain('First.');
    expect(await frameMatching(resumedReader, '"text":"Second."')).toContain('Second.');
    await resumedReader.cancel();
  });

  it('refuses a wrong bearer and a missing one with 401, and audits each exactly once', async () => {
    const s = await serve(['alpha']);
    const wrong = await s.post('alpha', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hi' }, 'wrong');
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ error: 'unauthorised' });
    expect(await refusals()).toHaveLength(1);
    const missing = await fetch(`${s.url}/tenants/alpha/web/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    });
    expect(missing.status).toBe(401);
    const rows = await refusals();
    // Counted, not merely found (invariant 20): one request, one row.
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'web:request',
      tool: 'surface_request',
      actionClass: 'read',
      decision: 'refused',
      error: 'bad_bearer',
    });
    // Both halves of invariant 20's sentence. The method and the path **are in** the row, which
    // this recomputes and compares; and they are **not readable from** it, which is the negative
    // below. A row that carried either in the clear would pass one of these and fail the other.
    expect(rows[0].argsHash).toBe(hashArgs({ asked: 'alpha', method: 'POST', path: 'web/messages' }));
    expect(JSON.stringify(rows[0])).not.toContain('messages');
  });

  it('decides an approval from a button press, and updates the card on the stream', async () => {
    const s = await serve(['alpha']);
    const tenant = s.f.tenant('alpha');
    const [row] = await db
      .insert(approvals)
      .values({
        client: 'alpha',
        action: 'forms_release',
        payload: { tool: 'forms_release', args: {} },
        summary: 'forms_release (external) requested by u-coordinator',
        requestedBy: 'u-coordinator',
        idempotencyKey: 'k-web-1',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    // The poller posts to the primary surface's `defaultConversation`, which for this tenant is
    // the inbox its document named — that is what makes the web surface a place a card can go.
    await postPendingApprovals({ db, surface: tenant.host.surfaces.primary, client: 'alpha', now: () => new Date() });
    const card = await frameMatching(reader, 'event: card');
    expect(card).toContain(APPROVE_ACTION_ID);
    const ref = JSON.parse(card.slice(card.indexOf('data: ') + 6)).message as Record<string, string>;
    const response = await s.post('alpha', 'actions', {
      userId: 'U012',
      actionId: APPROVE_ACTION_ID,
      value: row.id,
      messageRef: ref,
    });
    expect(response.status).toBe(202);
    expect(await decidedStatus(row.id)).toBe('approved');
    // The card the workspace is looking at is edited in place, with its buttons taken away.
    expect(await frameMatching(reader, 'event: card_update')).toContain('"actions":[]');
    await reader.cancel();
  });

  it('declines through the edit form, carrying the note the workspace submitted', async () => {
    const s = await serve(['alpha']);
    const tenant = s.f.tenant('alpha');
    const [row] = await db
      .insert(approvals)
      .values({
        client: 'alpha',
        action: 'forms_release',
        payload: { tool: 'forms_release', args: {} },
        summary: 'forms_release (external) requested by u-coordinator',
        requestedBy: 'u-coordinator',
        idempotencyKey: 'k-web-2',
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      })
      .returning();
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    await postPendingApprovals({ db, surface: tenant.host.surfaces.primary, client: 'alpha', now: () => new Date() });
    const card = await frameMatching(reader, 'event: card');
    const ref = JSON.parse(card.slice(card.indexOf('data: ') + 6)).message as Record<string, string>;
    // Edit opens the form, which the adapter sends as a frame and remembers the metadata of.
    await s.post('alpha', 'actions', { userId: 'U012', actionId: EDIT_ACTION_ID, value: row.id, messageRef: ref });
    await frameMatching(reader, EDIT_FORM_ID);
    await s.post('alpha', 'forms', {
      userId: 'U012',
      formId: EDIT_FORM_ID,
      values: { [EDIT_NOTE_FIELD_ID]: 'not this week' },
      messageRef: ref,
    });
    expect(await decidedStatus(row.id)).toBe('declined');
    const [decided] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    // The note the workspace typed reached the decision path, through the metadata the adapter
    // remembered when the form was opened and handed back untouched.
    expect(decided.decisionNote).toBe('not this week');
    await reader.cancel();
  });

  it('answers a caller the identity plug-in does not know with 202, and a notice on the stream', async () => {
    const s = await serve(['alpha']);
    const stream = await s.events('alpha', 'inbox');
    const reader = stream.body!.getReader();
    // The door has already answered by the time identity is consulted: `handleMessage` resolves
    // the principal, and `SurfaceDeps` has no identity access at all (spec section 4.9).
    const response = await s.post('alpha', 'messages', { userId: 'U999', conversation: 'inbox', text: 'let me in' });
    expect(response.status).toBe(202);
    const notice = await frameMatching(reader, 'event: notice');
    expect(notice).toContain('You are not authorised to use this assistant.');
    await reader.cancel();
  });

  it('refuses an attachment outside the incoming directory, and opens no run', async () => {
    const s = await serve(['alpha'], { alpha: [{ say: 'never' }] });
    const response = await s.post('alpha', 'messages', {
      userId: 'U012',
      conversation: 'inbox',
      text: 'here it is',
      attachments: [{ name: 'passwd', path: '../../../../etc/passwd' }],
    });
    expect(response.status).toBe(400);
    expect(await refusals()).toEqual([]);
    // Nothing started: a 400 from the adapter means the run never opened.
    expect(s.f.tenant('alpha').host.active.size).toBe(0);
  });

  it('keeps two tenants on one pooled host apart, in both directions', async () => {
    const s = await serve(['alpha', 'beta'], { alpha: [{ say: 'Alpha here.' }], beta: [{ say: 'Beta here.' }] });
    const alpha = (await s.events('alpha', 'inbox')).body!.getReader();
    const beta = (await s.events('beta', 'inbox')).body!.getReader();
    await s.post('beta', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hello' });
    expect(await frameMatching(beta, 'event: message')).toContain('Beta here.');
    // A message for one tenant is never refused for a missing hint — the adapter reports the
    // client id the host routed on — and it never reaches the other.
    expect(await refusals()).toEqual([]);
    // Alpha's bearer on beta's mount is one tenant reaching for another, and it is refused.
    const crossed = await s.post('beta', 'messages', { userId: 'U012', conversation: 'inbox', text: 'hi' }, tokenFor('alpha'));
    expect(crossed.status).toBe(401);
    expect(await refusals()).toHaveLength(1);
    await alpha.cancel();
    await beta.cancel();
  });

  it('never writes a resolved secret into an audit row, a log line or a response (invariant 21)', async () => {
    const lines: string[] = [];
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'web-token', tokenFor('alpha'));
    const f = await poolFixture(db, {
      documents: [webTenant('alpha')],
      trajectories: { alpha: [{ say: 'Hello back.' }] },
      secrets,
      log: {
        info: (text: string) => lines.push(text),
        warn: (text: string) => lines.push(text),
        error: (text: string) => lines.push(text),
      },
    });
    const server = startRunApi(f.pool, { token: 'sk-web-surface-test', bind: '127.0.0.1', port: 0 });
    await server.ready;
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    onTestFinished(async () => {
      await server.close();
      await f.close();
    });
    const stream = await fetch(`${url}/tenants/alpha/web/conversations/inbox/events`, {
      headers: { authorization: `Bearer ${tokenFor('alpha')}` },
    });
    const reader = stream.body!.getReader();
    const response = await fetch(`${url}/tenants/alpha/web/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tokenFor('alpha')}` },
      body: JSON.stringify({ userId: 'U012', conversation: 'inbox', text: 'hello' }),
    });
    const reply = await frameMatching(reader, 'event: message');
    await reader.cancel();
    // A turn ran, a refusal was audited, and the tenant opened — three paths that each had the
    // token in hand. None of them may have written it anywhere a person or a table can read.
    await fetch(`${url}/tenants/alpha/web/messages`, { method: 'POST', body: '{}' });
    const rows = await db.select().from(auditLog);
    expect(rows.length).toBeGreaterThan(0);
    expect(JSON.stringify(rows)).not.toContain(tokenFor('alpha'));
    expect(lines.join('\n')).not.toContain(tokenFor('alpha'));
    expect(await response.text()).not.toContain(tokenFor('alpha'));
    expect(reply).not.toContain(tokenFor('alpha'));
  });
});
```

Nothing in that file sleeps for an interval: `postPendingApprovals` is awaited directly rather than left to the runner's five-second poll, a stream is read frame by frame rather than after a pause, and `decidedStatus` polls a row at five milliseconds a time.

- [ ] **Step 15: Run it to verify it fails, then green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/api/web-surface.test.ts
```
Expected first: FAIL — `cannot load surface "@harness/surface-web"` before Step 1's `pnpm install` has run, and then failures inside the cases until Steps 8 to 13 are in.
Expected after: PASS — nine cases.

- [ ] **Step 16: Write the package README**

Create `surfaces/web/README.md`:

```markdown
# @harness/surface-web

The surface a workspace talks to: chat, approval cards and forms over HTTP, for a tenant with no
Slack.

```yaml
# in a client document
surfaces:
  web:
    token: { ref: web-token }   # or { env: WEB_TOKEN }
    inbox: inbox                # optional; this is the default
```

`web` is first in `SURFACE_ORDER`, so a document that declares it has it as the primary surface and
its approval cards go to `inbox`. It opens nothing: the host mounts its door at
`/tenants/<clientId>/web/...` and hands over what arrives.

## The four routes

| Method and path | Body | Answers |
| --- | --- | --- |
| `POST …/web/messages` | `{ userId, conversation, text, attachments?: [{ name, path }] }` | `202 {"message": MessageRef}`; the reply arrives on the stream |
| `GET …/web/conversations/<id>/events` | — | `202`, `text/event-stream`, an open stream |
| `POST …/web/actions` | `{ userId, actionId, value, messageRef }` | `202 {}` |
| `POST …/web/forms` | `{ userId, formId, values, messageRef }` | `202 {}` |

Every request carries `Authorization: Bearer <the tenant's token>`, compared in constant time. A
missing, malformed or wrong bearer is `401 {"error":"unauthorised"}` with a refusal the host audits
exactly once, decided before the body is parsed.

## The stream

Server-Sent Events, framed by this adapter and written by the host as opaque chunks:

```
id: <n>\nevent: <name>\ndata: <one JSON line>\n\n
```

`id` counts from 1 per conversation. Five events, two of which carry more than one payload — a
client discriminates on a key, not on the name:

| Event | Payload | Sent when |
| --- | --- | --- |
| `delta` | `{ message, delta }` | a reply is being written |
| `message` | `{ message, text, replyTo }`, plus `file: { filename }` for a released file | a reply is complete |
| `card` | `{ message, card }` | an approval card is posted |
| `card` | `{ form }` | a dialogue is opened from a card's button |
| `card_update` | `{ message, card }` | a posted card is edited in place |
| `notice` | `{ message, text, replyTo }` | the host said something *about* a message |
| `notice` | `{ text, userId }` | a private note, for the workspace to route to one person |
| `notice` | `{ text, dropped: true }` | a resume fell past the window |

Reconnect with `Last-Event-ID` and the stream resumes after that id; a resume past the window
opens with the `dropped` notice, which carries **no id**, so a client's resume point does not move
to an apology.

## What it does not do

It serves no file bytes, creates no conversation (writing to one creates it), lists none, and
reads no environment variable at all — its one credential is its tenant's, resolved by the host
through the deployment's secret source. `mention(userId)` is `@<userId>`: a display name is the
identity plug-in's answer, on every surface.
```

- [ ] **Step 17: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings, and `git status --short docs/architecture` empty.

Three gate-specific things this task has to satisfy, all of them checked by the gates themselves: `pnpm arch` has the new package's two lines and no import out of `surfaces/web/src` but `@harness/surface-api`, `@harness/shared` and its own files; `packaging.test.ts` still sees exactly seven public packages, because the new manifest says `"private": true` at `0.1.0`; and `surface.test.ts`'s environment scan finds no new variable, because this adapter reads none.

- [ ] **Step 18: Commit**

```
git add surfaces/web .dependency-cruiser.cjs pnpm-lock.yaml harness/approvals/package.json harness/host/package.json harness/config-api/src harness/surface-api/src harness/approvals/src harness/host/src harness/identity-api/src
git commit -m "feat(surface-web): a web surface a tenant with no Slack talks to"
```

---

### Task 5: A per-tenant gateway key — the tenant travels in the credential, not in the route name

**Files:**
- Modify: `harness/config-api/src/routing.ts` (`RoutingFile` strict, `gateway.key`) + `routing.test.ts`
- Modify: `harness/config-api/src/types.ts` (`ResolvedSecrets.gatewayKey`)
- Modify: `harness/config-api/src/secrets.ts` (resolve it)
- Modify: `harness/config-api/src/secrets.test.ts` (two cases)
- Modify: `harness/core-tools/src/domain/tooling/config.ts` (`buildKernelConfig`'s third parameter) + `config.test.ts`
- Modify: `harness/core-tools/src/domain/models/gateway.ts` (two messages) + `gateway.test.ts`
- Modify: `harness/core-tools/src/app/server.ts` (the stdio server resolves too) + `src/app/main.test.ts` (the spawn environment)
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (pass the map)
- Create: `harness/host/src/domain/tenancy/gateway-key.test.ts`
- Delete: nothing.

**Interfaces:**
- Produces:
  - `RoutingFile.gateway?: { key: SecretRef }`, and `RoutingFile` is `.strict()`
  - `ResolvedSecrets.gatewayKey?: string`
  - `buildKernelConfig(document: ClientDocument, env: EnvSource, secrets: ResolvedSecrets): Promise<KernelConfig>`
- Consumes: `resolveSecrets` (Task 3); `gatewayFromEnv`, `GatewayConfig`.

- [ ] **Step 1: Write the failing schema test**

In `harness/config-api/src/routing.test.ts`, add:

```ts
describe('the routing section', () => {
  const routes = {
    chat: { model: 'gemini/gemini-3-flash-preview' },
    extract: { model: 'gemini/gemini-3-flash-preview' },
    reason: { model: 'gemini/gemini-3-flash-preview' },
    judge: { model: 'groq/openai/gpt-oss-120b' },
    embed: { model: 'gemini/gemini-embedding-001' },
  };

  it('takes an optional gateway key, as a reference and never as a value', () => {
    const parsed = RoutingFile.parse({ routes, gateway: { key: { ref: 'gateway-key' } } });
    expect(parsed.gateway).toEqual({ key: { ref: 'gateway-key' } });
    expect(RoutingFile.parse({ routes }).gateway).toBeUndefined();
    // A literal key is the one thing this section may never carry, which is what `SecretRefShape`
    // is for — the same rule `RouteSpec.api_key` has had since the gateway renderer existed.
    expect(() => RoutingFile.parse({ routes, gateway: { key: 'sk-live-whatever' } })).toThrow();
  });

  it('refuses a key under a name nobody reads, rather than stripping it', () => {
    // `gatway:` used to be silently dropped, and a tenant would then believe it had its own key
    // while every call went out on the process key — a credential falling back in silence. The
    // section is strict now, so a typo is a refusal at load (spec section 12, constraint 21).
    expect(() => RoutingFile.parse({ routes, gatway: { key: { ref: 'gateway-key' } } })).toThrow();
    expect(() => RoutingFile.parse({ routes, gateway: { keys: { ref: 'gateway-key' } } })).toThrow();
    expect(() => RoutingFile.parse({ routes, defaults: { daily_budget_usd: 2 }, extra: true })).toThrow();
  });
});
```

and in `harness/config-api/src/secrets.test.ts`:

```ts
  it('resolves a tenant’s own gateway key, and leaves it out for a tenant with none', async () => {
    const source = new MemorySecretSource();
    source.put('fixture', 'gateway-key', 'sk-tenant-fixture');
    const document = withSecrets({
      routing: {
        routes: {
          chat: { model: 'gemini/gemini-3-flash-preview' },
          extract: { model: 'gemini/gemini-3-flash-preview' },
          reason: { model: 'gemini/gemini-3-flash-preview' },
          judge: { model: 'groq/openai/gpt-oss-120b' },
          embed: { model: 'gemini/gemini-embedding-001' },
        },
        gateway: { key: { ref: 'gateway-key' } },
      },
    });
    expect(await resolveSecrets(document, { source, log })).toEqual({
      surfaces: {},
      gatewayKey: 'sk-tenant-fixture',
    });
    // A document that names none resolves none: the process key stands, exactly as it does today.
    expect(await resolveSecrets(withSecrets({}), { source, log })).toEqual({ surfaces: {} });
  });

  it('refuses a gateway key the store does not hold, naming where it was declared', async () => {
    const document = withSecrets({
      routing: {
        routes: {
          chat: { model: 'gemini/gemini-3-flash-preview' },
          extract: { model: 'gemini/gemini-3-flash-preview' },
          reason: { model: 'gemini/gemini-3-flash-preview' },
          judge: { model: 'groq/openai/gpt-oss-120b' },
          embed: { model: 'gemini/gemini-embedding-001' },
        },
        gateway: { key: { ref: 'gateway-key' } },
      },
    });
    await expect(resolveSecrets(document, { source: new MemorySecretSource(), log })).rejects.toThrow(
      'client "fixture" names the secret "gateway-key" for routing.gateway.key',
    );
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @harness/config-api exec vitest run src/routing.test.ts src/secrets.test.ts`
Expected: FAIL — an unknown key under `routing:` is stripped rather than refused, `gateway` is not a field, and `resolveSecrets` answers `{ surfaces: {} }` for a document that names one.

- [ ] **Step 3: Add the field and make the section strict**

`routing.ts` needs `SecretRefShape`, which lives in `document.ts` today — and `document.ts` imports `./routing.js`, so an import the other way would be a cycle and `pnpm arch`'s `no-circular` is an error. So the shape moves down to a leaf first: **`SecretRefShape`, its `SecretRef` type and the two patterns they use move verbatim from `document.ts` to a new `harness/config-api/src/secret-ref.ts`**, and `document.ts` and `routing.ts` both import it from there. `ENV_NAME` and `SECRET_NAME` are used nowhere else in `document.ts`, so the move leaves no unused constant behind.

**`index.ts` keeps its two names in the `./document.js` export block and gains no second export of them** — a name exported twice from one module is a duplicate-export error — which works because `document.ts` re-exports what it now imports, as one line beside its other exports:

```ts
// Re-exported, so that every import of a document's own vocabulary still resolves through this
// module: the shape moved to a leaf only because `routing.ts` needs it too and the edge from a
// section back to the document would be a cycle.
export { SecretRefShape, type SecretRef } from './secret-ref.js';
```

`harness/config-api/src/secret-ref.ts` (**new**), holding exactly what `document.ts` declares today — the two patterns, the union, the type, and the doc comment, moved verbatim:

```ts
import * as z from 'zod/v4';

/** An environment variable name, which is what a `SecretRef`'s `env` member names. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A secret store name, which is what a `SecretRef`'s `ref` member names. */
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A reference to a secret, never the secret.
 *
 * `{ env }` names an environment variable the host resolves from its own process environment.
 * `{ ref }` names a secret in the deployment's secret store, resolved by that store when the
 * tenant opens — and refused there, naming the client and the secret, by a deployment whose
 * secret source is the environment. Exactly one of the two, never both and never neither: a
 * document that carried a literal value would be a document that got copied into a ticket, so
 * the schema admits no such shape at all.
 */
export const SecretRefShape = z.union([
  z
    .object({ env: z.string().regex(ENV_NAME, 'a secret reference names an environment variable (A-Z, digits, _)') })
    .strict(),
  z
    .object({
      ref: z
        .string()
        .regex(SECRET_NAME, "a secret reference names a secret in the deployment's secret store (a-z, digits, -)"),
    })
    .strict(),
]);

export type SecretRef = z.infer<typeof SecretRefShape>;
```

Only the comment's last sentence changes, and it changes because it is now false: it used to say that a `{ ref }` is refused while no deployment has a secret store, and Task 3 gave one to every deployment that asks for it.

One more comment goes stale with the move. `harness/config-api/src/types.ts:3` reads "`SecretRef` lives in `document.ts`, next to the `SecretRefShape` it is inferred from." Both halves are now wrong; rewrite it:

```ts
// `SecretRef` and `SecretRefShape` live in `secret-ref.ts`, which `document.ts` and `routing.ts`
// both import — a section of the document cannot import the document.
```

and in `harness/config-api/src/routing.ts`:

```ts
import { SecretRefShape } from './secret-ref.js';
```

```ts
export const RoutingFile = z
  .object({
    routes: z
      .object({ chat: RouteSpec, extract: RouteSpec, reason: RouteSpec, judge: RouteSpec, embed: RouteSpec })
      .strict(),
    /**
     * This tenant's own gateway credential, when it has one.
     *
     * Resolved through the deployment's secret source when the tenant opens and sent as the
     * bearer for that tenant's model calls in place of `LITELLM_MASTER_KEY`. The route names do
     * not change and neither does `model: <route>`: the tenant travels in the credential, because
     * a virtual key already carries its own aliases, its own model allow-list and its own budget.
     * Absent, the process key stands, which is what every deployment does today.
     */
    gateway: z.object({ key: SecretRefShape }).strict().optional(),
    // Unchanged, including its spelled-out `.default({ … })`: `.default({})` supplies the object
    // as-is without running it through the inner schema, so an absent `defaults:` key would
    // otherwise skip the per-field defaults.
    defaults: z
      .object({
        daily_budget_usd: z.number().positive().max(1000).default(1),
        num_retries: z.number().int().min(0).max(5).default(2),
        request_timeout_s: z.number().int().min(5).max(600).default(120),
      })
      .default({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 }),
  })
  // Strict, since Plan 11c. An unknown key here used to be stripped, so a mistyped `gatway:`
  // would leave a tenant believing it had its own credential while every call went out on the
  // process key — a credential falling back in silence, which is the one failure mode a routing
  // file must not have. Only `routes` and `defaults` are written anywhere in this repository and
  // the gateway renderer reads those two, so nothing breaks (spec section 12, constraint 21).
  .strict();
```

- [ ] **Step 4: Resolve it**

In `harness/config-api/src/types.ts`, add to `ResolvedSecrets`:

```ts
  /**
   * This tenant's own gateway credential, when its document names one.
   *
   * Absent for a tenant with none, and the process key then stands — `gatewayFromEnv`'s
   * `LITELLM_MASTER_KEY`, which stays required because it is the key for a tenant that declares
   * none, for the eval runner and for the stdio server.
   */
  readonly gatewayKey?: string;
```

and in `harness/config-api/src/secrets.ts`, one more resolution at the end of `resolveSecrets`:

```ts
  const gateway = document.routing.gateway;
  if (!gateway) return { surfaces };
  const gatewayKey = await resolveAt(
    document.id,
    { where: 'routing.gateway.key', declares: 'declares a gateway key' },
    gateway.key,
    deps,
  );
  return { surfaces, gatewayKey };
```

- [ ] **Step 5: Carry it into the gateway config**

In `harness/core-tools/src/domain/tooling/config.ts`:

```ts
export async function buildKernelConfig(
  document: ClientDocument,
  env: EnvSource,
  secrets: ResolvedSecrets,
): Promise<KernelConfig> {
```

```ts
    // This deployment's gateway, with this tenant's own credential when its document named one.
    // `GatewayConfig.apiKey` is already per tenant and is already the bearer `httpGateway` sends
    // on every call, so the key is the whole of the change: the route names, the wire shape and
    // `model_calls`' own `client` column are untouched (spec section 4.11).
    gateway:
      secrets.gatewayKey === undefined
        ? gatewayFromEnv(env)
        : { ...gatewayFromEnv(env), apiKey: secrets.gatewayKey },
```

with `type ResolvedSecrets` added to that file's `@harness/config-api` import. **`gatewayFromEnv` is still called either way**, and that is deliberate: it is what validates `HARNESS_GATEWAY_URL`, the timeout and the per-run breaker, and `LITELLM_MASTER_KEY` stays required for the reason spec §4.11 gives — a deployment that genuinely has none can set it to a value the gateway will reject.

In `harness/core-tools/src/domain/models/gateway.ts`, rewrite the two sentences that name the wrong credential once a tenant has its own. Both reach `audit_log.error` and the agent, so neither should teach which credential a deployment uses:

```ts
export function gatewayError(route: Route, status: number, body: string): ToolError {
  if (/budget/i.test(body)) {
    // Not "raise it in the client document's routing section": that is right for a route's
    // `daily_budget_usd` and wrong for a virtual key's `max_budget`, which lives in the gateway.
    return new ToolError(`model route "${route}" is over its budget`);
  }
  if (status === 401 || status === 403) {
    // Not "check LITELLM_MASTER_KEY": a tenant with its own key was not rejected on that one.
    return new ToolError(`model route "${route}" was rejected by the gateway (HTTP ${status})`);
  }
  return new ToolError(`model route "${route}" failed at the gateway (HTTP ${status})`);
}
```

and in `harness/core-tools/src/domain/models/gateway.test.ts`, update whichever assertions pin those two strings — search for `LITELLM_MASTER_KEY` and for `routing section` in that file and replace the expectations with the new sentences, keeping each case's own name and comment.

- [ ] **Step 6: Change both callers**

In `harness/host/src/domain/tenancy/tenant.ts`, the map `resolveSecrets` returned is already in hand from Task 3:

```ts
  const config = await buildKernelConfig(document, pool.env, secrets);
```

In `harness/core-tools/src/app/server.ts`, the stdio server resolves its own:

```ts
export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const document = await loadClientDocument({ env: process.env, log, db });
  // The stdio server has one client for its whole life, so it resolves that client's secrets once
  // and lets the source go: a process that serves one client has nothing to watch, and a source
  // left open would hold a connection for the life of the process for no reader — the same
  // reasoning `loadClientDocument` already applies to the config source.
  const source = await loadSecretSource(secretSourceNameFrom(process.env), { env: process.env, log, db });
  const secrets = await resolveSecrets(document, { source, log }).finally(() => source.close?.());
  const config = await buildKernelConfig(document, process.env, secrets);
  const principal = await resolvePrincipal(document, process.env);
  const context = await openRun(db, { client: config.client, principal });
  return { deps: depsForRun(config, { db, principal, context }), close };
}
```

with `resolveSecrets` imported from `@harness/config-api` and `loadSecretSource`/`secretSourceNameFrom` from `../domain/config/registry.js`.

**This makes `HARNESS_SECRET_SOURCE` required for the stdio server too**, which is right — it is the same rule `HARNESS_CONFIG_SOURCE` already has — and it has one consequence in the suite: `harness/core-tools/src/app/main.test.ts` spawns that entrypoint with `env: { ...process.env, … }` and seven explicit names, and the spread saves nothing here because no CI runner sets this one. Add it beside `HARNESS_CONFIG_SOURCE`:

```ts
      HARNESS_CONFIG_SOURCE: 'files',
      // Required, with no default. These documents name their secrets as environment variables,
      // which is what `env` resolves.
      HARNESS_SECRET_SOURCE: 'env',
```

In `harness/core-tools/src/domain/tooling/config.test.ts`, the three `buildKernelConfig` calls take a third argument. The two that assert on ordinary configuration pass `{ surfaces: {} }`; add one case for the key:

```ts
  it("sends this tenant's own gateway key when its document named one, and the process key when it did not", async () => {
    const document = parseClientDocument(fixtureDocument());
    expect((await buildKernelConfig(document, env, { surfaces: {} })).gateway.apiKey).toBe(env.LITELLM_MASTER_KEY);
    const own = await buildKernelConfig(document, env, { surfaces: {}, gatewayKey: 'sk-tenant-alpha' });
    expect(own.gateway.apiKey).toBe('sk-tenant-alpha');
    // And nothing else about the gateway moves: the URL, the timeout and the per-run breaker are
    // the deployment's, whoever the tenant is.
    expect(own.gateway.baseUrl).toBe((await buildKernelConfig(document, env, { surfaces: {} })).gateway.baseUrl);
    expect(own.gateway.maxCallsPerRun).toBe(
      (await buildKernelConfig(document, env, { surfaces: {} })).gateway.maxCallsPerRun,
    );
  });
```

- [ ] **Step 7: Write the failing two-tenant test**

Create `harness/host/src/domain/tenancy/gateway-key.test.ts`:

```ts
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { callModel, depsForRun, openRun } from '@harness/core-tools';
import { modelCalls } from '@harness/db';
import { HOST_PRINCIPAL, poolFixture, useTestDb } from '../../testing.js';

const db = useTestDb();

/** A tenant whose document names its own gateway key, or leaves the process key standing. */
const tenant = (id: string, key?: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { memory: { workspace: id } },
      routing: {
        routes: {
          chat: { model: 'gemini/gemini-3-flash-preview' },
          extract: { model: 'gemini/gemini-3-flash-preview' },
          reason: { model: 'gemini/gemini-3-flash-preview' },
          judge: { model: 'groq/openai/gpt-oss-120b' },
          embed: { model: 'gemini/gemini-embedding-001' },
        },
        ...(key === undefined ? {} : { gateway: { key: { ref: key } } }),
      },
    }),
  );

/**
 * A gateway that records the bearer it was sent and answers a chat completion.
 *
 * The real `httpGateway` talks to it over a real socket on `127.0.0.1:0`, which is what makes
 * this a test of the credential that actually went out rather than of the config that was built.
 */
function fakeGateway(): { url: string; bearers: string[]; close: () => Promise<void> } {
  const bearers: string[] = [];
  const server: Server = createServer((req, res) => {
    bearers.push(req.headers.authorization ?? '');
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          model: 'gemini/gemini-3-flash-preview',
          choices: [{ message: { content: 'ok' } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      );
    });
  });
  server.listen(0, '127.0.0.1');
  return {
    get url() {
      return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    },
    bearers,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

describe('a per-tenant gateway key', () => {
  it('sends each tenant its own bearer, and never the other’s (invariant 22)', async () => {
    const gateway = fakeGateway();
    await new Promise((resolve) => setTimeout(resolve, 0));
    onTestFinished(() => gateway.close());
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'alpha-key', 'sk-tenant-alpha');
    secrets.put('beta', 'beta-key', 'sk-tenant-beta');
    const f = await poolFixture(db, {
      documents: [tenant('alpha', 'alpha-key'), tenant('beta', 'beta-key')],
      secrets,
      env: { HARNESS_GATEWAY_URL: gateway.url },
    });
    onTestFinished(() => f.close());

    // A turn under the scripted runtime makes no model call — that is what makes it scriptable —
    // so the call is made the way a tool makes one: on that tenant's own run deps, built from
    // that tenant's own `KernelConfig` (plan decision 12).
    for (const clientId of ['alpha', 'beta']) {
      const host = f.tenant(clientId).host;
      const context = await openRun(db, { client: clientId, principal: HOST_PRINCIPAL });
      const deps = depsForRun(host.config, { db, principal: HOST_PRINCIPAL, context });
      await callModel(deps, { route: 'chat', messages: [{ role: 'user', content: 'hello' }] });
    }

    expect(gateway.bearers).toEqual(['Bearer sk-tenant-alpha', 'Bearer sk-tenant-beta']);
    // And the attribution is unchanged: one row per call, each naming its own tenant and the
    // route it asked for. The tenant is in the credential *and* in the row, which is what makes
    // a budget and an evaluation record agree about whose call it was.
    const rows = await db.select().from(modelCalls);
    expect(rows.map((row) => `${row.client}:${row.route}`).sort()).toEqual(['alpha:chat', 'beta:chat']);
  });

  it('falls back to the process key for a tenant whose document names none', async () => {
    const gateway = fakeGateway();
    await new Promise((resolve) => setTimeout(resolve, 0));
    onTestFinished(() => gateway.close());
    const f = await poolFixture(db, {
      documents: [tenant('alpha')],
      env: { HARNESS_GATEWAY_URL: gateway.url, LITELLM_MASTER_KEY: 'sk-process' },
    });
    onTestFinished(() => f.close());
    const host = f.tenant('alpha').host;
    const context = await openRun(db, { client: 'alpha', principal: HOST_PRINCIPAL });
    await callModel(depsForRun(host.config, { db, principal: HOST_PRINCIPAL, context }), {
      route: 'chat',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(gateway.bearers).toEqual(['Bearer sk-process']);
  });
});
```

`openRun`, `depsForRun` and `callModel` are all `@harness/core-tools` exports and `@harness/host` already depends on that package, which is why they arrive on one import line above rather than three.

The two `await new Promise((resolve) => setTimeout(resolve, 0))` lines are there because `server.listen` is asynchronous and `address()` is null until it has bound; a zero-millisecond yield is inside this plan's sleep rule, and the alternative — listening on a fixed port — is what makes a suite fail on a machine where that port is taken.

- [ ] **Step 8: Run it, and then the suites that changed**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/tenancy/gateway-key.test.ts
pnpm --filter @harness/config-api test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/core-tools test
```
Expected: PASS — two cases here, `routing.test.ts`'s two new ones, `secrets.test.ts`'s two new ones, and core-tools' config and gateway suites with their updated sentences. `main.test.ts`'s four spawns still come up, which is the check that the new required variable was added to the one place that builds that environment by hand.

- [ ] **Step 9: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings, and `git status --short docs/architecture` empty — the tool surface does not move, because `routing.gateway` is a document field and no tool reads it.

- [ ] **Step 10: Commit**

```
git add harness/config-api/src harness/core-tools/src harness/host/src
git commit -m "feat(gateway): send each tenant its own gateway key, and make the routing section strict"
```

---

### Task 6: Run API reads — two cursor-paged lists a dashboard can hold

**Files:**
- Create: `harness/host/src/domain/api/reads.ts` + `reads.test.ts`
- Modify: `harness/host/src/domain/api/routes.ts` (two routes)
- Modify: `harness/host/src/domain/api/server.test.ts` (the route cases)
- Modify: `harness/host/src/index.ts` (the two limits, for a caller that pages)
- Delete: nothing.

**Interfaces:**
- Produces:
  - `APPROVAL_STATUSES = ['pending', 'approved', 'declined', 'expired']`, `MEMORY_SCOPES = ['principal', 'client']`
  - `READ_DEFAULT_LIMIT = 100`, `READ_MAX_LIMIT = 500`
  - `encodeCursor(at: Date, id: string): string`, `decodeCursor(raw: string): { at: Date; id: string } | null`
  - `readApprovals(db, opts): Promise<Page<ApprovalReadRow>>`, `readMemory(db, opts): Promise<Page<MemoryReadRow>>`
  - `GET /v1/approvals?status=&cursor=&limit=`, `GET /v1/memory?scope=&principal=&cursor=&limit=`
- Consumes: `approvals`, `memoryEntries` (`@harness/db`); the bearer and tenant resolution `handleApiRequest` already does.

- [ ] **Step 1: Write the failing repository test**

Create `harness/host/src/domain/api/reads.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { approvals, memoryEntries } from '@harness/db';
import { useTestDb } from '../../testing.js';
import { decodeCursor, encodeCursor, readApprovals, readMemory } from './reads.js';

const db = useTestDb();

/** One approval of a client, at a known moment, so ordering and paging are assertable. */
async function approval(client: string, at: string, over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(approvals)
    .values({
      client,
      action: 'forms_release',
      payload: { tool: 'forms_release', args: { file_id: 'roster/secret.csv' } },
      payloadEncrypted: Buffer.from('not readable'),
      summary: 'forms_release (external) requested by u-coordinator',
      requestedBy: 'u-coordinator',
      idempotencyKey: `k-${client}-${at}`,
      expiresAt: new Date('2027-01-01T00:00:00Z'),
      createdAt: new Date(at),
      ...over,
    })
    .returning();
  return row.id;
}

async function memory(client: string, at: string, over: Record<string, unknown> = {}): Promise<string> {
  const [row] = await db
    .insert(memoryEntries)
    .values({
      client,
      scope: 'client',
      text: 'the practice closes at four on Fridays',
      createdBy: 'u-coordinator',
      createdAt: new Date(at),
      ...over,
    })
    .returning();
  return row.id;
}

describe('the cursor', () => {
  it('round-trips a sort key and refuses anything that is not one', () => {
    const at = new Date('2026-09-10T09:00:00Z');
    const id = '11111111-2222-3333-4444-555555555555';
    expect(decodeCursor(encodeCursor(at, id))).toEqual({ at, id });
    // Opaque to a caller, and checked rather than trusted: a cursor that does not decode is a
    // 400, never a silent first page.
    for (const raw of ['', 'nonsense', Buffer.from('no-separator').toString('base64url'), Buffer.from('notadate|x').toString('base64url')]) {
      expect(decodeCursor(raw), raw).toBeNull();
    }
  });
});

describe('readApprovals', () => {
  it('answers this tenant’s rows, newest first, and no column the export excludes', async () => {
    await approval('alpha', '2026-09-10T09:00:00Z');
    const newest = await approval('alpha', '2026-09-11T09:00:00Z');
    await approval('beta', '2026-09-12T09:00:00Z');
    const page = await readApprovals(db, { client: 'alpha', limit: 100 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(newest);
    expect(page.next_cursor).toBeNull();
    // The column list, asserted whole (invariant 23). A field added without a thought is a field
    // this fails on, which is the point: an export is the one place content leaves by accident.
    expect(Object.keys(page.rows[0]).sort()).toEqual([
      'action',
      'conversation_id',
      'created_at',
      'decided_at',
      'decided_by',
      'decision_note',
      'executed_at',
      'expires_at',
      'id',
      'requested_by',
      'status',
      'summary',
      'surface',
    ]);
    // The tool's own arguments, encrypted or not, are invariant 16's rule applied to an export it
    // did not name: never in this answer, in either column.
    expect(JSON.stringify(page.rows)).not.toContain('roster/secret.csv');
    expect(JSON.stringify(page.rows)).not.toContain('payload');
  });

  it('filters on the column’s own vocabulary, one value or several', async () => {
    await approval('alpha', '2026-09-10T09:00:00Z');
    await approval('alpha', '2026-09-11T09:00:00Z', { status: 'approved' });
    await approval('alpha', '2026-09-12T09:00:00Z', { status: 'declined' });
    await approval('alpha', '2026-09-13T09:00:00Z', { status: 'expired' });
    expect((await readApprovals(db, { client: 'alpha', statuses: ['pending'], limit: 100 })).rows).toHaveLength(1);
    expect(
      (await readApprovals(db, { client: 'alpha', statuses: ['approved', 'declined'], limit: 100 })).rows.map(
        (row) => row.status,
      ),
    ).toEqual(['declined', 'approved']);
    expect((await readApprovals(db, { client: 'alpha', limit: 100 })).rows).toHaveLength(4);
  });

  it('pages by the sort key, so an insertion cannot shift a page', async () => {
    for (const day of ['10', '11', '12', '13']) await approval('alpha', `2026-09-${day}T09:00:00Z`);
    const first = await readApprovals(db, { client: 'alpha', limit: 2 });
    expect(first.rows).toHaveLength(2);
    expect(first.next_cursor).not.toBeNull();
    // A row written between the two reads lands where its own key puts it and moves nothing.
    await approval('alpha', '2026-09-01T09:00:00Z');
    const second = await readApprovals(db, { client: 'alpha', limit: 2, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual([
      '2026-09-11T09:00:00.000Z',
      '2026-09-10T09:00:00.000Z',
    ]);
    const third = await readApprovals(db, { client: 'alpha', limit: 2, cursor: second.next_cursor });
    expect(third.rows.map((row) => row.created_at)).toEqual(['2026-09-01T09:00:00.000Z']);
    expect(third.next_cursor).toBeNull();
  });

  it('answers an empty page for a tenant with nothing, rather than failing', async () => {
    await approval('beta', '2026-09-10T09:00:00Z');
    expect(await readApprovals(db, { client: 'alpha', limit: 100 })).toEqual({ rows: [], next_cursor: null });
  });
});

describe('readMemory', () => {
  it('answers this tenant’s entries, oldest first, with the entry and whose it is', async () => {
    const first = await memory('alpha', '2026-09-10T09:00:00Z');
    await memory('alpha', '2026-09-11T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    await memory('beta', '2026-09-12T09:00:00Z');
    const page = await readMemory(db, { client: 'alpha', limit: 100 });
    expect(page.rows).toHaveLength(2);
    expect(page.rows[0].id).toBe(first);
    expect(Object.keys(page.rows[0]).sort()).toEqual([
      'created_at',
      'created_by',
      'id',
      'principal_id',
      'scope',
      'text',
    ]);
    // `thread_id` is a join key and is excluded; `text` is included, because a memory page with no
    // memories is not a page, and `memory_list` already returns exactly this to the model.
    expect(JSON.stringify(page.rows)).not.toContain('thread_id');
  });

  it('filters by scope and by principal, which are the tenant’s own columns', async () => {
    await memory('alpha', '2026-09-10T09:00:00Z');
    await memory('alpha', '2026-09-11T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    await memory('alpha', '2026-09-12T09:00:00Z', { scope: 'principal', principalId: 'u-coordinator' });
    expect((await readMemory(db, { client: 'alpha', scope: 'client', limit: 100 })).rows).toHaveLength(1);
    expect((await readMemory(db, { client: 'alpha', scope: 'principal', limit: 100 })).rows).toHaveLength(2);
    const one = await readMemory(db, { client: 'alpha', principal: 'u-member', limit: 100 });
    expect(one.rows.map((row) => row.principal_id)).toEqual(['u-member']);
  });

  it('pages oldest first, in its own direction', async () => {
    for (const day of ['10', '11', '12']) await memory('alpha', `2026-09-${day}T09:00:00Z`);
    const first = await readMemory(db, { client: 'alpha', limit: 2 });
    expect(first.rows.map((row) => row.created_at)).toEqual([
      '2026-09-10T09:00:00.000Z',
      '2026-09-11T09:00:00.000Z',
    ]);
    const second = await readMemory(db, { client: 'alpha', limit: 2, cursor: first.next_cursor });
    expect(second.rows.map((row) => row.created_at)).toEqual(['2026-09-12T09:00:00.000Z']);
    expect(second.next_cursor).toBeNull();
  });

  it('returns no entry of another tenant, whatever the filters say', async () => {
    await memory('beta', '2026-09-10T09:00:00Z', { scope: 'principal', principalId: 'u-member' });
    expect((await readMemory(db, { client: 'alpha', principal: 'u-member', limit: 100 })).rows).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/api/reads.test.ts
```
Expected: FAIL — `./reads.js` does not exist.

- [ ] **Step 3: Write the two reads**

Create `harness/host/src/domain/api/reads.ts`:

```ts
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { approvals, memoryEntries, type Db } from '@harness/db';

/**
 * What the platform's control plane reads, per tenant, for a dashboard and a memory page.
 *
 * Two routes with **identical authentication and tenant resolution** to `/v1/usage` — the bearer,
 * then `x-harness-client` through the pool's resolver — and no principal resolution at all: the
 * caller is the control plane acting for the tenant, not a person acting as themselves. That is
 * why the column lists below are the whole of the guarantee, and why a test asserts each one
 * whole (invariant 23).
 *
 * Snake case, because this is what goes on the wire, exactly as `UsageRow` is.
 */

/** The four values the `approvals.status` column is ever written with, and nothing else. */
export const APPROVAL_STATUSES = ['pending', 'approved', 'declined', 'expired'] as const;
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number];

/** The two scopes a memory entry has. */
export const MEMORY_SCOPES = ['principal', 'client'] as const;

/** How many rows one page holds when a caller names no limit, and the most it may ask for. */
export const READ_DEFAULT_LIMIT = 100;
export const READ_MAX_LIMIT = 500;

export interface Page<T> {
  rows: T[];
  /** The cursor for the next page, or null at the end. */
  next_cursor: string | null;
}

/**
 * One approval of this tenant.
 *
 * `payload` and `payload_encrypted` are the tool's own arguments and are **excluded** — invariant
 * 16's rule applied to an export it did not name, which invariant 23 makes explicit.
 * `idempotency_key`, `message_ref`, `thread_id` and `claimed_at` are the poller's bookkeeping and
 * are excluded too.
 */
export interface ApprovalReadRow {
  id: string;
  action: string;
  summary: string;
  requested_by: string;
  status: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  expires_at: string;
  surface: string | null;
  conversation_id: string | null;
  created_at: string;
}

/**
 * One memory entry of this tenant.
 *
 * `text` is included, because that is the entry — a memory page with no memories is not a page —
 * and because `memory_list` returns exactly this to the model already. `principal_id` is
 * included, which `memory_list`'s own entry shape omits: a tool's caller *is* the principal, and
 * a tenant-scoped export has no such excuse. An id is an id rather than content, so invariant 16
 * does not reach it. `thread_id` is excluded; it is a join key.
 */
export interface MemoryReadRow {
  id: string;
  scope: string;
  principal_id: string | null;
  text: string;
  created_by: string;
  created_at: string;
}

/**
 * The sort key of the last row a page returned, as one opaque string.
 *
 * `(created_at, id)` in that route's own direction, so it is stable under insertion and carries
 * no offset: a row written between two reads lands where its own key puts it and moves no page.
 * base64url, because it travels in a query string.
 */
export function encodeCursor(at: Date, id: string): string {
  return Buffer.from(`${at.toISOString()}|${id}`, 'utf8').toString('base64url');
}

/** The other direction, or null for anything that is not one of ours. */
export function decodeCursor(raw: string): { at: Date; id: string } | null {
  const decoded = Buffer.from(raw, 'base64url').toString('utf8');
  const separator = decoded.indexOf('|');
  if (separator === -1) return null;
  const at = new Date(decoded.slice(0, separator));
  const id = decoded.slice(separator + 1);
  if (Number.isNaN(at.getTime()) || id === '') return null;
  return { at, id };
}

/** `limit + 1` rows, so a page knows whether there is another without counting the table. */
const overRead = (limit: number): number => limit + 1;

function pageOf<T>(rows: T[], limit: number, keyOf: (row: T) => { at: Date; id: string }): Page<T> {
  if (rows.length <= limit) return { rows, next_cursor: null };
  const page = rows.slice(0, limit);
  const last = keyOf(page[page.length - 1]);
  return { rows: page, next_cursor: encodeCursor(last.at, last.id) };
}

export interface ReadApprovalsOptions {
  client: string;
  statuses?: readonly string[];
  cursor?: string | null;
  limit: number;
}

/** One page of this tenant's approvals, newest first. */
export async function readApprovals(db: Db, opts: ReadApprovalsOptions): Promise<Page<ApprovalReadRow>> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db
    .select({
      id: approvals.id,
      action: approvals.action,
      summary: approvals.summary,
      requestedBy: approvals.requestedBy,
      status: approvals.status,
      decidedBy: approvals.decidedBy,
      decidedAt: approvals.decidedAt,
      decisionNote: approvals.decisionNote,
      executedAt: approvals.executedAt,
      expiresAt: approvals.expiresAt,
      surface: approvals.surface,
      conversationId: approvals.conversationId,
      createdAt: approvals.createdAt,
    })
    .from(approvals)
    .where(
      and(
        // The tenant predicate, and there is no way to widen it: the client is the one the request
        // resolved to, never one the caller asked for.
        eq(approvals.client, opts.client),
        opts.statuses && opts.statuses.length > 0 ? inArray(approvals.status, [...opts.statuses]) : undefined,
        // A row comparison, so the pair is compared as one key rather than as two predicates —
        // which is what makes a page stable when two rows share a timestamp.
        after ? sql`(${approvals.createdAt}, ${approvals.id}) < (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(desc(approvals.createdAt), desc(approvals.id))
    .limit(overRead(opts.limit));
  const mapped: ApprovalReadRow[] = rows.map((row) => ({
    id: row.id,
    action: row.action,
    summary: row.summary,
    requested_by: row.requestedBy,
    status: row.status,
    decided_by: row.decidedBy,
    decided_at: row.decidedAt?.toISOString() ?? null,
    decision_note: row.decisionNote,
    executed_at: row.executedAt?.toISOString() ?? null,
    expires_at: row.expiresAt.toISOString(),
    surface: row.surface,
    conversation_id: row.conversationId,
    created_at: row.createdAt.toISOString(),
  }));
  return pageOf(mapped, opts.limit, (row) => ({ at: new Date(row.created_at), id: row.id }));
}

export interface ReadMemoryOptions {
  client: string;
  scope?: string;
  principal?: string;
  cursor?: string | null;
  limit: number;
}

/**
 * One page of this tenant's memory entries, **oldest first** — the order `listMemory` already
 * uses, so a page of this export and a page the model was shown read the same way round.
 */
export async function readMemory(db: Db, opts: ReadMemoryOptions): Promise<Page<MemoryReadRow>> {
  const after = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await db
    .select({
      id: memoryEntries.id,
      scope: memoryEntries.scope,
      principalId: memoryEntries.principalId,
      text: memoryEntries.text,
      createdBy: memoryEntries.createdBy,
      createdAt: memoryEntries.createdAt,
    })
    .from(memoryEntries)
    .where(
      and(
        eq(memoryEntries.client, opts.client),
        opts.scope ? eq(memoryEntries.scope, opts.scope) : undefined,
        opts.principal ? eq(memoryEntries.principalId, opts.principal) : undefined,
        after ? sql`(${memoryEntries.createdAt}, ${memoryEntries.id}) > (${after.at}, ${after.id})` : undefined,
      ),
    )
    .orderBy(asc(memoryEntries.createdAt), asc(memoryEntries.id))
    .limit(overRead(opts.limit));
  const mapped: MemoryReadRow[] = rows.map((row) => ({
    id: row.id,
    scope: row.scope,
    principal_id: row.principalId,
    text: row.text,
    created_by: row.createdBy,
    created_at: row.createdAt.toISOString(),
  }));
  return pageOf(mapped, opts.limit, (row) => ({ at: new Date(row.created_at), id: row.id }));
}
```

- [ ] **Step 4: Run it green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/api/reads.test.ts
```
Expected: PASS — nine cases.

- [ ] **Step 5: Write the failing route test**

In `harness/host/src/domain/api/server.test.ts`, add a describe block. The file's `api(trajectory)` helper already builds a dedicated host at port 0 with the bearer, so these cases need nothing new but rows:

```ts
describe('the read routes', () => {
  /** One approval of the served client, and one of somebody else. */
  async function seed(): Promise<void> {
    for (const client of [CLIENT, 'other']) {
      await db.insert(approvals).values({
        client,
        action: 'forms_release',
        payload: { tool: 'forms_release', args: { file_id: 'roster/secret.csv' } },
        summary: `forms_release (external) requested by u-coordinator`,
        requestedBy: 'u-coordinator',
        idempotencyKey: `k-${client}`,
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
      });
      await db.insert(memoryEntries).values({
        client,
        scope: 'client',
        text: `a note belonging to ${client}`,
        createdBy: 'u-coordinator',
      });
    }
  }

  it('answers both routes behind the bearer, and neither without it', async () => {
    const a = await api([]);
    for (const route of ['/v1/approvals', '/v1/memory']) {
      expect((await a.get(route)).status, route).toBe(200);
      expect((await a.get(route, 'wrong')).status, route).toBe(401);
      expect((await fetch(`${a.url}${route}`)).status, route).toBe(401);
    }
  });

  it('answers this tenant’s rows and none of another’s, in the envelope the platform pages on', async () => {
    const a = await api([]);
    await seed();
    const body = (await (await a.get('/v1/approvals')).json()) as {
      client: string;
      rows: { summary: string }[];
      next_cursor: string | null;
    };
    expect(body.client).toBe(CLIENT);
    expect(body.rows).toHaveLength(1);
    expect(body.next_cursor).toBeNull();
    expect(JSON.stringify(body)).not.toContain('roster/secret.csv');
    const memory = (await (await a.get('/v1/memory')).json()) as { rows: { text: string }[] };
    expect(memory.rows.map((row) => row.text)).toEqual([`a note belonging to ${CLIENT}`]);
  });

  it('accepts the four status values, one or several, and refuses a fifth with a 400 naming them', async () => {
    const a = await api([]);
    for (const status of ['pending', 'approved', 'declined', 'expired', 'approved,declined']) {
      expect((await a.get(`/v1/approvals?status=${status}`)).status, status).toBe(200);
    }
    // There is no `decided` alias: a filter vocabulary that differs from the column is a second
    // spelling of one fact, and a platform engineer asking the obvious must not get a 400 for it.
    const refused = await a.get('/v1/approvals?status=decided');
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toContain('pending');
  });

  it('refuses a scope that is not one, a cursor that does not decode and a limit out of bounds', async () => {
    const a = await api([]);
    expect((await a.get('/v1/memory?scope=everything')).status).toBe(400);
    expect((await a.get('/v1/approvals?cursor=nonsense')).status).toBe(400);
    for (const limit of ['0', '-1', '1.5', 'many', '501']) {
      expect((await a.get(`/v1/approvals?limit=${limit}`)).status, limit).toBe(400);
    }
    expect((await a.get('/v1/approvals?limit=500')).status).toBe(200);
  });

  it('pages, and hands back a cursor that fetches the rest', async () => {
    const a = await api([]);
    for (const n of [1, 2, 3]) {
      await db.insert(memoryEntries).values({
        client: CLIENT,
        scope: 'client',
        text: `note ${n}`,
        createdBy: 'u-coordinator',
      });
    }
    const first = (await (await a.get('/v1/memory?limit=2')).json()) as {
      rows: { text: string }[];
      next_cursor: string;
    };
    expect(first.rows).toHaveLength(2);
    const second = (await (await a.get(`/v1/memory?limit=2&cursor=${encodeURIComponent(first.next_cursor)}`)).json()) as {
      rows: { text: string }[];
      next_cursor: string | null;
    };
    expect(second.rows).toHaveLength(1);
    expect(second.next_cursor).toBeNull();
  });

  it('answers 404 for a client this host does not serve, the way every /v1 route does', async () => {
    const a = await api([]);
    const response = await a.get('/v1/approvals', undefined, { [CLIENT_HEADER]: 'somebody-else' });
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such client' });
  });
});
```

with `approvals` and `memoryEntries` added to that file's `@harness/db` import.

- [ ] **Step 6: Add the two routes**

`harness/host/src/domain/api/types.ts` is **not touched**: the two limits live in `reads.ts` beside the shapes they bound, because they are what a page of an export costs rather than what a request costs. In `harness/host/src/domain/api/routes.ts`, add the two handlers above `handleApiRequest` and two lines to the route table:

```ts
/**
 * One page of this tenant's approvals (spec section 4.12).
 *
 * `status` is the column's own vocabulary and nothing else — `pending`, `approved`, `declined`,
 * `expired`, comma-separated for several — so a dashboard can render what it filtered on. An
 * unknown value is a 400 naming the four rather than an empty page, which is the failure a
 * caller cannot tell from "there are none".
 */
async function approvalsRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const limit = readLimit(url);
  if (limit === null) return json(res, 400, { error: `limit is a whole number between 1 and ${READ_MAX_LIMIT}` });
  const asked = url.searchParams.get('status');
  const statuses = asked === null ? [] : asked.split(',').map((value) => value.trim());
  const unknown = statuses.find((value) => !(APPROVAL_STATUSES as readonly string[]).includes(value));
  if (unknown !== undefined) {
    return json(res, 400, { error: `status is one of ${APPROVAL_STATUSES.join(', ')}, comma-separated for several` });
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && decodeCursor(cursor) === null) return json(res, 400, { error: 'cursor is not one of ours' });
  const page = await readApprovals(host.db, { client: host.client, statuses, cursor, limit });
  return json(res, 200, { client: host.client, ...page });
}

/** One page of this tenant's memory entries (spec section 4.12), oldest first. */
async function memoryRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const limit = readLimit(url);
  if (limit === null) return json(res, 400, { error: `limit is a whole number between 1 and ${READ_MAX_LIMIT}` });
  const scope = url.searchParams.get('scope');
  if (scope !== null && !(MEMORY_SCOPES as readonly string[]).includes(scope)) {
    return json(res, 400, { error: `scope is one of ${MEMORY_SCOPES.join(', ')}` });
  }
  const cursor = url.searchParams.get('cursor');
  if (cursor !== null && decodeCursor(cursor) === null) return json(res, 400, { error: 'cursor is not one of ours' });
  const principal = url.searchParams.get('principal');
  const page = await readMemory(host.db, {
    client: host.client,
    ...(scope === null ? {} : { scope }),
    ...(principal === null ? {} : { principal }),
    cursor,
    limit,
  });
  return json(res, 200, { client: host.client, ...page });
}

/**
 * The page size, or null for one this API will not serve.
 *
 * A limit is refused rather than clamped: a caller handed a silently smaller page believes they
 * have the whole of it, and the one thing a paged export must not do is look complete.
 */
function readLimit(url: URL): number | null {
  const raw = url.searchParams.get('limit');
  if (raw === null) return READ_DEFAULT_LIMIT;
  const limit = Number(raw);
  return Number.isInteger(limit) && limit >= 1 && limit <= READ_MAX_LIMIT ? limit : null;
}
```

```ts
  if (req.method === 'GET' && route === '/v1/usage') return usageRoute(host, url, res);
  if (req.method === 'GET' && route === '/v1/approvals') return approvalsRoute(host, url, res);
  if (req.method === 'GET' && route === '/v1/memory') return memoryRoute(host, url, res);
```

with the imports from `./reads.js` added to that file's import block.

In `harness/host/src/index.ts`, export what a caller that pages needs to agree with:

```ts
export {
  APPROVAL_STATUSES,
  MEMORY_SCOPES,
  READ_DEFAULT_LIMIT,
  READ_MAX_LIMIT,
  type ApprovalReadRow,
  type MemoryReadRow,
  type Page,
} from './domain/api/reads.js';
```

- [ ] **Step 7: Run the host suite green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host test
```
Expected: PASS — `reads.test.ts`'s nine cases, `server.test.ts`'s six new ones and everything that was already there.

- [ ] **Step 8: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings, `git status --short docs/architecture` empty. The tool surface does not move: these are run API routes and no tool reads them.

- [ ] **Step 9: Commit**

```
git add harness/host/src
git commit -m "feat(host): page a tenant's approvals and memory on the run API"
```

---

### Task 7: The write contract — a version string is written once, and the runbook says so

**Files:**
- Modify: `harness/config-postgres/src/source.ts` (`writeClientDocument` refuses a rewrite)
- Modify: `harness/config-postgres/src/source.test.ts` (three cases)
- Modify: `harness/config-api/src/testing.ts` (one conformance case)
- Modify: `harness/config-api/src/testing.test.ts` (the memory source obeys it)
- Modify: `docs/runbook.md` (the client store as a write contract)
- Delete: nothing.

**Interfaces:**
- Produces: `writeClientDocument` raises a `ConfigError` on a rewritten version with different content; `MemoryConfigSource.put` does the same.
- Consumes: `withTransaction`, `clientDocuments`, `clientDocumentVersions`.

- [ ] **Step 1: Write the failing test**

In `harness/config-postgres/src/source.test.ts`, add:

```ts
describe('a version is written once', () => {
  it('refuses the same version with different content, naming the client and the version', async () => {
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1'),
    ).rejects.toThrow(ConfigError);
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1'),
    ).rejects.toThrow(/"fixture".*"v1"/);
  });

  it('leaves both tables exactly as they were when it refuses', async () => {
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Second' })), 'v2');
    await expect(
      writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Rewritten' })), 'v1'),
    ).rejects.toThrow(ConfigError);
    // The live row still says v2 and the history still holds two versions: a refusal rolls the
    // whole transaction back, which is the difference between refusing and half-writing.
    const live = await db.select().from(clientDocuments);
    expect(live[0].version).toBe('v2');
    expect((live[0].document as { displayName: string }).displayName).toBe('Second');
    const history = await db.select().from(clientDocumentVersions);
    expect(history).toHaveLength(2);
    expect(
      history.map((row) => (row.document as { displayName: string }).displayName).sort(),
    ).toEqual(['Fixture', 'Second']);
  });

  it('stays a no-op for an identical rewrite, whatever order the keys arrive in', async () => {
    const document = parseClientDocument(fixtureDocument());
    await writeClientDocument(db, document, 'v1');
    // The stored copy came back through `jsonb`, which does not keep key order, so the comparison
    // has to be canonical rather than a string compare of two serialisations.
    await expect(writeClientDocument(db, { ...document }, 'v1')).resolves.toBeUndefined();
    expect(await db.select().from(clientDocumentVersions)).toHaveLength(1);
  });
});
```

with `clientDocumentVersions` and `ConfigError` added to that file's imports.

In `harness/config-api/src/testing.ts`, add the case to `configSourceConformance`, so **every** source is bound by it:

```ts
    it('refuses a version string written a second time with different content', async () => {
      await withSource(async (harness) => {
        const { source } = harness;
        const assigned = await harness.put(parseClientDocument(fixtureDocument()), 'v1');
        // A source that derives its own version from the content cannot express this case at all:
        // different content *is* a different version there, so there is nothing to collide. Same
        // shape as the `list` skip above.
        if (assigned !== 'v1') return;
        await expect(harness.put(parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v1')).rejects.toThrow(
          ConfigError,
        );
        // And the document it was serving is the one it still serves: a refused write changes
        // nothing, which is what makes a history readable after one.
        const loaded = await source.load('fixture');
        expect(loaded?.document.displayName).toBe('Fixture');
        expect(loaded?.version).toBe(assigned);
      });
    });
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres test
pnpm --filter @harness/config-api test
```
Expected: FAIL in both — the postgres writer moves the live row and keeps the old history silently, and `MemoryConfigSource.put` overwrites whatever it held.

- [ ] **Step 3: Refuse the rewrite, inside the transaction**

In `harness/config-postgres/src/source.ts`, rewrite `writeClientDocument`:

```ts
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
        .where(
          and(eq(clientDocumentVersions.clientId, document.id), eq(clientDocumentVersions.version, version)),
        )
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
```

with `and` added to the `drizzle-orm` import.

Note what did **not** change: the live row still upserts, the history row is still written once, and both are still in one transaction — a live row that moved without a history row is a change nobody can review, and a history row with no live row is a version nobody is serving. The only new thing is the refusal between them.

In `harness/config-api/src/testing.ts`, make `MemoryConfigSource` obey the same rule, because it runs the same suite:

```ts
export class MemoryConfigSource implements ConfigSource {
  readonly name = 'memory';

  private readonly documents = new Map<string, LoadedDocument>();
  /** Every version this source has been handed, so a rewrite can be refused the way a store does. */
  private readonly versions = new Map<string, ClientDocument>();
  private readonly watchers = new Map<string, Set<(version: string) => void>>();
  closed = false;
  ...
  /** Make `document` the current version of its client, notifying every watcher of that client. */
  put(document: ClientDocument, version: string): void {
    const key = `${document.id}:${version}`;
    const stored = this.versions.get(key);
    // The same rule the postgres writer enforces and the platform's control plane is bound by: a
    // version string identifies one document (spec section 6, rule 3). It is here as well as
    // there because the conformance suite is what makes "a source" one thing rather than two.
    if (stored && JSON.stringify(stored) !== JSON.stringify(document)) {
      throw new ConfigError(
        `client "${document.id}": version "${version}" is already stored with different content; a version string identifies one document, so write a new version rather than rewriting this one`,
      );
    }
    this.versions.set(key, document);
    this.documents.set(document.id, { document, version });
    for (const notify of this.watchers.get(document.id) ?? []) notify(version);
  }
```

A plain `JSON.stringify` comparison is enough here and would not be enough in the store: this source keeps the object it was handed, so the keys are in the order the caller built them; a `jsonb` round trip is what makes the canonical form necessary on the other side.

- [ ] **Step 4: Run both suites green**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres test
pnpm --filter @harness/config-api test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-files test
```
Expected: PASS in all three. The files source's harness derives its version from the content, so the new conformance case returns early there — which is the case the suite is written to allow, and is why a content-addressed source can run the same suite as a versioned one.

- [ ] **Step 5: Write the runbook section**

In `docs/runbook.md`, add a section after "Writing migrations" and before "Model calls":

```markdown
## The client store as a write contract

Three tables are written by the platform's control plane and read by the kernel:
`client_documents`, `client_document_versions` and `client_secrets`. `@harness/config-postgres` is
**not published** — the platform must neither copy kernel code nor depend on an unpublished
package — so the columns are the contract instead, and these are the columns as they stand:

```
client_documents
  client_id      text        PRIMARY KEY
  schema_version integer     NOT NULL
  document       jsonb       NOT NULL     -- a whole resolved ClientDocument
  version        text        NOT NULL     -- what a host caches by and what watch reports
  blueprint_ref  text        NULL
  overlay        jsonb       NULL
  updated_at     timestamptz NOT NULL DEFAULT now()

client_document_versions
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid()
  client_id      text        NOT NULL
  version        text        NOT NULL
  document       jsonb       NOT NULL
  created_by     text        NULL
  created_at     timestamptz NOT NULL DEFAULT now()
  UNIQUE (client_id, version)

client_secrets
  client_id      text        NOT NULL
  name           text        NOT NULL     -- [a-z][a-z0-9-]*, what a document's { ref } names
  ciphertext     bytea       NOT NULL     -- the envelope below, raw
  updated_at     timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (client_id, name)
```

Four rules a writer keeps, and the kernel's own writer keeps them too:

1. **Both document tables in one transaction.** A live row that moved without a history row is a
   change nobody can review; a history row with no live row is a version nobody is serving.
2. **The host's watch follows `client_documents.version`.** The `postgres` source polls that one
   column every thirty seconds and reopens the tenant when it changes. A content change that does
   not move `version` is a change the host will not notice, and there is no second signal — which
   is also why rotating a secret is paired with a version bump.
3. **A version string is written once.** Writing `(client_id, version)` again with *different*
   content is refused by the kernel's writer and is forbidden to yours. Write content-hash
   versions and you cannot hit it by accident.
4. **The kernel validates on read regardless.** `migrate` and `parseClientDocument` run on every
   load, the row's key must equal the document's `id`, and `knowledge.path` must be absolute. A
   malformed row fails that tenant and no other.

### The secret envelope

`client_secrets.ciphertext` holds raw bytes, not base64 and not text:

- AES-256-GCM.
- Key: `HARNESS_ENCRYPTION_KEY`, base64, decoded to **exactly 32 raw bytes**.
- IV: 12 random bytes. Tag: 16 bytes. No AAD. Plaintext UTF-8.
- Blob: `iv(12) || tag(16) || ciphertext`.

A vector to check an implementation against, verified in both directions by the kernel's own
suite:

```
key_b64    BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
iv_hex     030303030303030303030303
plaintext  xoxb-test-secret
blob_hex   03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78
```

`writeClientSecret` in `@harness/config-postgres` is the kernel's own writer for that table, and
what a test and an operator use; a control plane writes the row itself, to the same shape.
```

- [ ] **Step 6: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings, `git status --short docs/architecture` empty.

- [ ] **Step 7: Commit**

```
git add harness/config-postgres/src harness/config-api/src docs/runbook.md
git commit -m "feat(config-postgres): refuse a version string written twice with different content"
```

---

### Task 8: The boundary the platform lands inside — the four directories, the scans that must not follow them, and one abort made deterministic

The platform's transplant merged into `main` while this plan was being written and is already on this branch (`eb21dc6`, merging `da1509c`), so `catalog/` and `control-plane/` exist, `pnpm-workspace.yaml` lists both, `pnpm arch`'s globs cruise both, and `.dependency-cruiser.cjs` already carries four boundary rules of the platform's own writing. **The implementer's first step is therefore to check, not to write**: if `main` has moved again, merge it into this branch before touching anything here.

What the kernel still owes after that merge is smaller than it was and is entirely about keeping the boundary true as both sides grow: one directory the ban forgot, and three tests that make the arrangement fail out loud rather than rot quietly.

It also carries this plan's one unrelated repair, because it is the task with no seam in it: a cancellation case in `runtimes/deepagents` that aborts on a timer and therefore races the run it is cancelling. It failed CI on 2026-09-21 on a pull request that touches nothing in that package.

**Files:**
- Modify: `.dependency-cruiser.cjs` (one alternation gains `deploy`)
- Modify: `harness/core-tools/src/kernel-vocabulary.test.ts` (the comment and one case)
- Modify: `harness/core-tools/src/app/record-surface.ts` (export `SOURCE_ROOTS`)
- Modify: `harness/core-tools/src/app/surface.test.ts` (one case)
- Create: `scripts/src/domain/boundaries.test.ts`
- Modify: `runtimes/deepagents/src/domain/run.test.ts` (one case's abort)
- Delete: the `setTimeout` that abort raced on.

**Interfaces:**
- Produces: `SOURCE_ROOTS` exported from `record-surface.ts`; `PLATFORM_DIRS` in the new test.
- Consumes: `.dependency-cruiser.cjs` and the root manifest, read as files; `FakeGateway.setResponder`.

- [ ] **Step 1: Rebase, and see what is actually there**

Run:
```bash
git fetch origin main
git merge --no-edit origin/main
ls -d catalog control-plane apps deploy 2>/dev/null
grep -n 'kernel-never-imports-the-platform' -A 8 .dependency-cruiser.cjs
```
Expected at the time of writing: the merge is already in (`Already up to date`), `catalog` and `control-plane` exist, `apps` and `deploy` do not yet, and the ban reads `to: { path: '^(catalog|control-plane|apps)/' }`.

**If the merge brings conflicts in a file a task above already changed, stop and resolve them before writing anything here** — every other task in this plan touches `harness/`, `surfaces/` and `docs/`, and the transplant touched `.dependency-cruiser.cjs`, `package.json`, `pnpm-workspace.yaml` and `.env.example`, so the only likely overlap is `.dependency-cruiser.cjs`, which Task 4 added two lines to.

- [ ] **Step 2: Write the failing boundary test**

Create `scripts/src/domain/boundaries.test.ts`:

```ts
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './workspace.test-helpers.js';

/**
 * The boundary decision 1b as amended draws, read off the two files that enforce it.
 *
 * One repository, four enforced boundaries: the platform lives in `catalog/`, `control-plane/`,
 * `apps/` and `deploy/`, no kernel package may import any of them, and `catalog/` may import
 * kernel *contracts* only. The rules themselves are in `.dependency-cruiser.cjs`; this asserts
 * that they are there, that they name all four directories, and that everything which exists is
 * actually cruised — because a rule that names a directory nobody cruises is prose, and a
 * directory that is cruised by no glob is invisible to every rule in that file.
 */
const PLATFORM_DIRS = ['catalog', 'control-plane', 'apps', 'deploy'];

const read = (file: string): string => readFileSync(path.join(repoRoot, file), 'utf8');

describe('the platform boundary', () => {
  it('bans an import from every kernel tree into every platform directory', () => {
    const rules = read('.dependency-cruiser.cjs');
    const ban = /name: 'kernel-never-imports-the-platform'[\s\S]*?\n  \},/.exec(rules);
    expect(ban, 'the kernel-never-imports-the-platform rule is gone').not.toBeNull();
    for (const dir of PLATFORM_DIRS) {
      expect(ban![0], dir).toContain(dir);
    }
    // And the `from` side is every kernel tree, not a subset: a rule that had quietly lost
    // `scripts/` would let the one package that reads the workspace reach into the platform.
    for (const tree of ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts']) {
      expect(ban![0], tree).toContain(tree);
    }
  });

  it('lets the catalogue reach kernel contracts and nothing else', () => {
    const rules = read('.dependency-cruiser.cjs');
    // Anchored to the rule, the way the ban above is. Grepping the whole file for these five
    // names would pass on the `PACKAGES` array alone and prove nothing about the exemption.
    const rule = /name: 'catalog-imports-kernel-contracts-only'[\s\S]*?\n  \},/.exec(rules);
    expect(rule, 'the catalog-imports-kernel-contracts-only rule is gone').not.toBeNull();
    // The exemption is a `pathNot` on the contracts' **source paths**: a rule that named packages
    // instead would not fire on a deep import, which is the thing it exists to stop. The rule
    // holds them in one constant, so the assertion follows the constant to its definition.
    const exemption = /pathNot: \[([^\]]*)\]/.exec(rule![0]);
    expect(exemption, 'the rule exempts nothing').not.toBeNull();
    const contracts = new RegExp(`const ${exemption![1].trim()} = '([^']+)'`).exec(rules)?.[1] ?? exemption![1];
    for (const contract of ['config-api', 'identity-api', 'pack-api', 'surface-api', 'shared']) {
      expect(contracts, contract).toContain(contract);
    }
    // And the `from` side is the catalogue's own source tree, not the whole repository.
    expect(rule![0]).toContain("from: { path: '^catalog/src/' }");
  });

  it('cruises every platform directory that exists, so its rules are not prose', () => {
    const manifest = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    for (const dir of PLATFORM_DIRS) {
      if (!existsSync(path.join(repoRoot, dir, 'src'))) continue;
      // depcruise fails outright on a glob whose parent does not exist, so a directory is added
      // to the globs when it arrives and not before — which is exactly what this asserts.
      expect(manifest.scripts.arch, dir).toContain(`${dir}/src/**/*.ts`);
      expect(manifest.scripts['arch:graph'], dir).toContain(`${dir}/src/**/*.ts`);
    }
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @harness/scripts exec vitest run src/domain/boundaries.test.ts`
Expected: FAIL — the first case, because the ban names `catalog`, `control-plane` and `apps` and not `deploy`.

- [ ] **Step 4: Close the gap the ban left**

In `.dependency-cruiser.cjs`, the kernel's ban gains the fourth directory:

```js
  {
    name: 'kernel-never-imports-the-platform',
    comment:
      "The kernel knows nothing about the platform built on top of it. An edge from the kernel into catalog/, control-plane/, apps/ or deploy/ would invert this repository's one boundary that survived the merge. All four, because decision 1b names four: `deploy/` holds compose profiles, the Helm chart and the SandboxTemplates, and a kernel package that read one would be a kernel package that knew how it was deployed.",
    severity: 'error',
    from: { path: '^(harness|packs|surfaces|identities|runtimes|evals|scripts)/' },
    to: { path: '^(catalog|control-plane|apps|deploy)/' },
  },
```

and nothing else in that file changes.

- [ ] **Step 5: Pin the scans to the kernel's own trees**

Two scans walk directories, and neither may follow the platform's. Both already have explicit lists; what is missing is a test that says so, and one comment.

In `harness/core-tools/src/kernel-vocabulary.test.ts`, extend the header comment above `SCANNED` with a paragraph:

```
 * **The scanned roots are the kernel's own, and they do not widen.** Every entry below names a
 * kernel tree; the platform's directories — `catalog/`, `control-plane/`, `apps/` and `deploy/` —
 * are outside this list by construction and must stay outside it. The platform names tenants,
 * customers and vendors because that is what it is for, and a scan that reached it would either
 * fail on the product's own vocabulary or be relaxed until it proved nothing about the kernel.
 * `harness/host/src` is scanned, so no route name, event name or frame from the web surface may
 * appear there.
```

and add a case beside the allowlist one:

```ts
  it('scans the kernel’s own trees and none of the platform’s', () => {
    const roots = [...new Set(SCANNED.map((entry) => entry.root))].sort();
    expect(roots).toEqual([
      'evals/src',
      'harness/config-api/src',
      'harness/core-tools/src',
      'harness/files/src',
      'harness/host/src',
      'harness/identity-api/src',
      'harness/runtime-api/src',
      'identities/slack-groups/src',
      'identities/static/src',
      'packs/healthcare/src',
      'packs/stories/src',
      'runtimes/deepagents/src',
      'surfaces/http/src',
    ]);
    for (const root of roots) {
      expect(root.startsWith('catalog/'), root).toBe(false);
      expect(root.startsWith('control-plane/'), root).toBe(false);
      expect(root.startsWith('apps/'), root).toBe(false);
      expect(root.startsWith('deploy/'), root).toBe(false);
    }
  });
```

Those thirteen are the unique roots `SCANNED` holds today, sorted — read out of the file on 2026-09-21. A task above adds none: this plan scans no new tree, because `surfaces/web/src` is exempt from the messaging list for the reason `surfaces/slack` is, and an adapter is allowed to know its own transport.

In `harness/core-tools/src/app/record-surface.ts`, export the environment scan's roots and extend their comment:

```ts
/**
 * The directories the environment scan walks. This is every place shipping kernel TypeScript
 * lives today.
 *
 * ... (the existing paragraph about `clients/`, `surfaces/`, `identities/` and `runtimes/`) ...
 *
 * **The platform's directories are outside this list and stay outside it** (spec section 12,
 * constraint 16): `catalog/`, `control-plane/`, `apps/` and `deploy/` document their own
 * variables, and pulling them in here would put a product's configuration into the OS's
 * contract. Exported so `surface.test.ts` can assert the list rather than trust it.
 */
export const SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts'];
```

and in `harness/core-tools/src/app/surface.test.ts`, one case:

```ts
  it('scans the kernel’s own source roots, and none of the platform’s', () => {
    expect(SOURCE_ROOTS).toEqual(['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts']);
    for (const dir of ['catalog', 'control-plane', 'apps', 'deploy']) {
      expect(SOURCE_ROOTS, dir).not.toContain(dir);
    }
  });
```

with `SOURCE_ROOTS` added to the import from `./record-surface.js`.

**One thing this deliberately does not do**, and a reader should know why: `.env.example` documents `CONTROL_PLANE_TEST_DATABASE_URL`, which the transplant added, and constraint 16 says a product's configuration does not belong in the OS's contract. The check is one-directional — the scan fails on a variable the kernel *reads* and `.env.example` does not document, never on a documented variable nobody reads — so nothing is red, and deleting the line would take away the one place a developer setting this repository up finds it. The boundary that matters is which directories are *scanned*, and that is what the two cases above pin.

- [ ] **Step 6: Stop a cancellation case racing the run it cancels**

`runtimes/deepagents/src/domain/run.test.ts`, the case named **`ends with error "cancelled" and no done when the signal aborts mid-run`**, aborts on a 50 ms timer while the model call hangs:

```ts
    gateway.setResponder(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
```

Fifty milliseconds is a guess about how long the run takes to reach its first model call, and everything before that call is real work: `bridgeTools` connects an MCP client to a tool-server fixture, `createDeepAgent` builds the graph, `seedFiles` touches the filesystem, and the checkpointer is consulted. On a loaded runner the abort can land before any of it has reached the gateway, and then the composed signal is already aborted when `agent.stream` is called — a different code path, with no model call recorded and, depending on where the graph gives up, no terminal event for the queue to hand back. That is the failure CI saw on 2026-09-21: one error event expected, none arrived, on a pull request that touches nothing in this package.

**The deterministic hook is the fake gateway itself.** `startFakeGateway` pushes the call onto `calls` and *then* awaits the responder:

```ts
      calls.push(call);

      const reply = await respond(call);
```

So a responder that aborts is running at the one moment the case is about: the request is in flight, and `gateway.calls` already holds it. Replace the three lines above with:

```ts
    const controller = new AbortController();
    // Aborted from inside the model call rather than on a timer. The fake records a call before
    // it consults the responder, so by the time this runs the request is in flight and
    // `gateway.calls` already holds exactly one — which is what "mid-run" means here. The timer
    // this replaces was a guess about how long the run takes to reach its first model call, and
    // on a slow runner the abort landed before it, taking a different path through the graph and
    // leaving this case red for a reason that had nothing to do with cancellation.
    gateway.setResponder(() => {
      controller.abort();
      return new Promise<never>(() => {});
    });
```

The rest of the case is unchanged, including both assertions and the name:

```ts
    const events = await run(request({ signal: controller.signal }));
    expect(events).toEqual([{ type: 'error', message: 'cancelled' }]);
    expect(gateway.calls).toHaveLength(1);
```

Three things this relies on, each already true: the responder body runs before the returned promise is awaited, so the abort happens inside `respond(call)` and not a tick later; the promise never resolves, so the response is never written and the run's only way out is the abort, exactly as before; and `FakeGateway.close` calls `server.closeAllConnections()` first — its comment already says "a responder that is still hanging (the cancel tests) holds a connection open" — so the `afterEach` does not wait on it.

**No sleep replaces the timer**, and none is needed: the case now has a happens-before edge rather than a duration. The sibling case below it (`cancels a kernel tool that is still running`) keeps its own 150 ms timer, deliberately — what that one cancels is a tool call, so it has to abort after the model has answered and the bridge has dispatched, and its own assertion (`Date.now() - started` under five seconds against a ten-second tool) is a bound rather than a race. Changing it is a separate question and not this plan's.

- [ ] **Step 7: Run the four suites green**

Run:
```bash
pnpm --filter @harness/scripts test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder \
  pnpm --filter @harness/core-tools test
pnpm --filter @harness/runtime-deepagents test
pnpm arch
```
Expected: PASS — three boundary cases, the vocabulary suite with its new case and its empty allowlist, the surface suite with its new case, the deepagents run suite, and zero architecture violations.

Then run the cancellation case alone, twenty times, because a race that fails once in a hundred on CI passes once locally and proves nothing:

```bash
for i in $(seq 1 20); do
  pnpm --filter @harness/runtime-deepagents exec vitest run src/domain/run.test.ts -t 'aborts mid-run' || break
done
```
Expected: twenty passes. A single failure means the abort still has a window somewhere, and the next thing to read is whether `chatModel` retries an aborted request — a retry would record a second gateway call and fail the second assertion rather than the first.

- [ ] **Step 8: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings, `git status --short docs/architecture` empty.

- [ ] **Step 9: Commit**

Two commits, because they are two changes and a reader bisecting a flaky test should not land on a boundary rule:

```
git add .dependency-cruiser.cjs harness/core-tools/src scripts/src
git commit -m "test(boundaries): pin the four platform directories the kernel may not reach"
git add runtimes/deepagents/src/domain/run.test.ts
git commit -m "test(deepagents): abort from inside the model call instead of racing it on a timer"
```

---

### Task 9: Documentation — what a platform engineer reads before they write a row

No code. Every file below is prose, and the one check that matters is that a reader who has never seen this repository can onboard a tenant, give it a workspace, put its secrets in a store and read its approvals back without asking anybody.

**Files:**
- Modify: `docs/runbook.md` (the web surface; secrets from a store; the gateway key; the read routes)
- Modify: `ARCHITECTURE.md` (surfaces/web, the config sources and the secret source, the one-repository boundaries)
- Modify: `CONTRIBUTING.md` (adding a surface, adding a secret source, the boundary a new top-level directory lands under)
- Modify: `README.md` (the layout, and what a tenant with no Slack looks like)
- Modify: `CHANGELOG.md` (`0.3.0 — unreleased`)
- Modify: `harness/surface-api/README.md`, `harness/config-api/README.md`, `harness/config-postgres/README.md`, `harness/host/README.md`, `surfaces/memory/README.md`, `surfaces/slack/README.md`
- Regenerate: `docs/architecture/graph.svg`
- Delete: nothing.

Task 7 already wrote the runbook's "The client store as a write contract" section, including the envelope and the vector. **This task does not touch it.**

- [ ] **Step 1: The web surface, in the runbook**

In `docs/runbook.md`, after "Slack over HTTPS" and its tunnel subsection, and before "Health", add:

```markdown
### The web surface

A tenant with no Slack declares `surfaces.web` and talks to its agent from the platform's
workspace. Its document:

```yaml
surfaces:
  web:
    token: { ref: web-token }   # or { env: WEB_TOKEN }
    inbox: inbox                # optional; this is the default
  http: {}
identity:
  defaults:
    web: member                 # optional; may not name lead or admin
  principals:
    - { id: u-coordinator, kind: user, level: lead, displayName: Coordinator, surfaces: { web: U012 } }
```

`web` is first in the surface order, so it is the primary surface and approval cards go to
`inbox`. The host mounts its door at `https://<host>/tenants/<clientId>/web/...`, behind whatever
terminates TLS in front of the deployment.

Four routes, each carrying `Authorization: Bearer <the tenant's token>`:

| Method and path | Body | Answers |
| --- | --- | --- |
| `POST …/web/messages` | `{ userId, conversation, text, attachments?: [{ name, path }] }` | `202 {"message": MessageRef}` |
| `GET …/web/conversations/<id>/events` | — | `202`, `text/event-stream` |
| `POST …/web/actions` | `{ userId, actionId, value, messageRef }` | `202 {}` |
| `POST …/web/forms` | `{ userId, formId, values, messageRef }` | `202 {}` |

A conversation is created by writing to it, so there is no route that makes one and none that
lists them. `userId` is that person's id on this surface, and the tenant's identity plug-in
resolves it; a user it does not know is answered `202` and the refusal arrives on the
conversation's stream as a `notice`, because identity is resolved after the door has answered.

The stream is Server-Sent Events:

```
id: 12
event: message
data: {"message":{"surface":"web","conversation":"inbox","id":"w7"},"text":"Hello back.","replyTo":null}
```

Five event names, and two of them carry more than one payload — discriminate on a key, not on the
name:

| Event | Payload |
| --- | --- |
| `delta` | `{ message, delta }` — a reply being written |
| `message` | `{ message, text, replyTo }`, plus `file: { filename }` when a file was released |
| `card` | `{ message, card }` for a posted card, or `{ form }` for a dialogue opened from one |
| `card_update` | `{ message, card }` — the same card, edited in place |
| `notice` | `{ message, text, replyTo }` about a message, `{ text, userId }` for one person, or `{ text, dropped: true }` after a resume past the window |

Reconnect with `Last-Event-ID` and the stream resumes after that id. A resume the host can no
longer cover opens with the `dropped` notice, which carries **no id** so a client's resume point
does not move to an apology — the window is two hundred frames per conversation, in memory, per
host, so a workspace behind an ingress with more than one host should expect that notice and
reload the conversation from the run API rather than trust the gap.

What a caller gets wrong, and what it is told:

| Condition | Answer |
| --- | --- |
| body over 1 MiB | `413`, from the host, before the adapter sees it |
| missing, malformed or wrong bearer | `401 {"error":"unauthorised"}`, one audit row |
| body is not JSON, or fails the route's shape | `400 {"error":"<what was wrong>"}` |
| attachment path outside `<storage>/incoming` | `400`, and no run opens |
| wrong method on a known path | `405` with `allow` |
| sub-path no route claims | `404` |
| an `actionId`, `formId` or conversation nobody knows | `202`; an unknown id is ignored and a new conversation is created by being written to |
```

- [ ] **Step 2: Secrets from a store, in the runbook**

After the section Task 7 wrote, add:

```markdown
## Secrets from a store

`HARNESS_SECRET_SOURCE` says where a document's `SecretRef`s resolve. It is required and has no
default, for the reason `HARNESS_CONFIG_SOURCE` has none: a host that guessed would come up and
refuse every tenant whose document named a stored secret, with a message saying this deployment
had no secret store — which it would have had.

- `env` — `{ env: NAME }` reads the process environment, and `{ ref: name }` is refused when the
  tenant opens. This is every deployment before Plan 11c and every dedicated one after it.
- `postgres` — `{ ref: name }` selects `client_secrets` by `(client_id, name)` and decrypts with
  `HARNESS_ENCRYPTION_KEY`. `{ env: NAME }` **still means the environment**, so a document may mix
  the two: a stored bot token and a deployment-wide gateway URL is the ordinary case.

Secrets resolve **once, when the tenant opens**, before anything else is built — which is what
makes "add a tenant with no restart" true on a pooled host: write the document and the rows, and
the tenant opens on its first request. It is also why a rotation needs one more write.

### A tenant's secrets are not a deployment's settings

This is the rule the rest of this section exists to serve, so it is worth stating on its own.

**`.env.example` and a host's environment are a deployment's**: the database URLs,
`HARNESS_ENCRYPTION_KEY`, `LITELLM_MASTER_KEY`, `HARNESS_HOST_TOKEN`, `HARNESS_SECRET_SOURCE`, the
config source, the ports and the image tag. A **tenant's** credentials — a bot token, a signing
secret, a web bearer, a gateway key — are named by that tenant's document as `{ ref: <name> }` and
stored as rows in `client_secrets`. The control plane writes them from the platform's own
interface; nobody edits a file on a host to onboard a client, and nothing restarts.

A **dedicated** host is the one place `{ env: NAME }` still earns its keep: one tenant, one
process, and an operator who owns both. That tenant's document names its own variables and the
operator sets them in that host's environment. Two tenants in one process would name two different
variables, which is the thing a pooled host cannot do and the reason the store exists.

The Compose stack still passes `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and
`SLACK_APPROVALS_CHANNEL` through to the host, for exactly that dedicated case — they are the
conventional names the Slack adapter falls back to when a document names nothing — and they are
commented out in `.env.example` because they are a dedicated host's business rather than a
deployment default. A pooled host leaves all three unset.

### Rotating a secret

`postgresConfigSource.watch` polls `client_documents.version` and nothing else, so a
`client_secrets` row changing is invisible to a running host. **Pair every rotation with a version
bump on that tenant's document**, in the same transaction the control plane is already opening:

1. write the new `client_secrets` row;
2. write the document again under a new version string;
3. the host notices the version within thirty seconds, drains that tenant's turns and reopens it
   with the new secret.

Rotating without the bump leaves the old value in use until something else reopens the tenant.

### Diagnosing a tenant that will not open

The refusals name the client, the surface, the field and the secret's *name*, and never its value:

```
client "acme" names the secret "web-token" for web.token, and this deployment's secret store holds no such secret for that client
client "acme" declares the "slack" surface, which needs SLACK_BOT_TOKEN; this deployment does not set it
client "acme" names the secret "web-token" for web.token, and this deployment has no secret source
```

The third one means `HARNESS_SECRET_SOURCE=env` and a document that names a stored secret. There
is no `list` on the secret source, deliberately — a host resolves what a document names and never
enumerates — so "what does the store hold for this tenant" is a question you answer with SQL
against `client_secrets`, which is the platform's own table.
```

- [ ] **Step 3: The gateway key and the read routes, in the runbook**

In the "Model calls" section, after the paragraph about `model_calls` rows:

```markdown
### A tenant's own gateway key

`routing.gateway.key` is a `SecretRef`, resolved at tenant open like every other, and sent as the
bearer for that tenant's model calls in place of `LITELLM_MASTER_KEY`:

```yaml
routing:
  gateway:
    key: { ref: gateway-key }
  routes: { … }
```

The route names do not change and neither does the wire shape: the tenant travels in the
credential, because a LiteLLM virtual key already carries its own aliases, its own model
allow-list and its own `max_budget`. A tenant that names no key uses the process key, which is
what every deployment does today — and `LITELLM_MASTER_KEY` stays required either way, because it
is the key for those tenants, for the eval runner and for the stdio server.

`routing:` is strict now: a mistyped `gatway:` is refused when the document loads rather than
leaving a tenant on the process key in silence.
```

and in "The run API", after "Usage":

```markdown
### Approvals and memory

Two cursor-paged reads for a dashboard and a memory page, authenticated and tenant-resolved
exactly like `/v1/usage` — the bearer, then `x-harness-client`:

```
GET /v1/approvals?status=pending&cursor=<opaque>&limit=100
GET /v1/memory?scope=client&principal=u-member&cursor=<opaque>&limit=100
```

Both answer `{ "client": "<id>", "rows": [ … ], "next_cursor": "<opaque>" | null }`. Approvals come
newest first; memory entries come oldest first, the order the model is shown them in. `status` is
the column's own vocabulary — `pending`, `approved`, `declined`, `expired`, comma-separated for
several — and anything else is a `400` naming the four. `limit` defaults to 100, may be 1 to 500,
and is refused rather than clamped outside that.

An approval row carries `id, action, summary, requested_by, status, decided_by, decided_at,
decision_note, executed_at, expires_at, surface, conversation_id, created_at` and nothing else:
the payload is the tool's own arguments and is excluded, encrypted or not. A memory row carries
`id, scope, principal_id, text, created_by, created_at`.

Neither route resolves a principal. The caller is the control plane acting for the tenant, not a
person acting as themselves, so these two are tenant-scoped and nothing narrower — which is why
the column lists are the whole of the guarantee.
```

- [ ] **Step 4: `ARCHITECTURE.md`**

Three edits.

In "The packages", add `surfaces/web` to the table of reference plug-ins, in one line matching the
existing rows: *`@harness/surface-web` — chat, cards and forms over HTTP for a tenant with no
Slack; a `SurfaceSession` over the HTTP seam.*

In "Surfaces", extend the paragraph about what a surface may import with the streaming half:

```markdown
A surface that is reached by a request offers `http`, and its answer may be a whole body or an
async iterable of strings the host pipes as they are produced. The host never reads a chunk: the
web surface's Server-Sent Events frames, its route names and its five event names appear nowhere
in `harness/host/src`, which the vocabulary scan proves with an empty allowlist.
```

In "The client document", after the sentence about `ConfigSource`:

```markdown
Secrets are `SecretRef`s — `{ env: NAME }` or `{ ref: name }` — and never values. Where a `{ ref }`
resolves is a second contract beside `ConfigSource`: `SecretSource`, with `env` shipped in
`@harness/config-api` and `postgres` in `@harness/config-postgres` over `client_secrets` and the
`@harness/db` envelope. `HARNESS_SECRET_SOURCE` names one, with no default. A document's secrets
resolve once, when its tenant opens, before anything else is built, and reach an adapter as
**values** on `SurfaceDeps.secretValues` — the host never learns what any of them are called.
```

and in the section that describes this repository's layout, replace the two-repository sentence
with decision 1b as amended:

```markdown
One repository, four enforced boundaries. `gateway ◄ os ◄ agents ◄ platform`: `harness/` is the
OS, `catalog/` is the agents band, and `control-plane/`, `apps/workspace/` and `deploy/` are the
platform. No kernel package may import any of the four, and `catalog/` may import kernel contracts
only; both are `pnpm arch` rules, and `scripts/src/domain/boundaries.test.ts` asserts that they
are still there and still name all four directories. A directory becomes a repository when it
gains its own owner or release cadence, and the move is mechanical because the boundary was a lint
rule from the first day.
```

- [ ] **Step 5: `CONTRIBUTING.md`**

In "Adding a surface", add two paragraphs at the end:

```markdown
A surface that is reached by a request returns `http: { path, handle }`, and the host mounts it at
`/tenants/<clientId>/<path>`. Answer with a string for a whole body, or with an async iterable of
strings for a stream; the host writes the head, pipes each chunk as it is yielded and ends when
the iterable ends. Read `request.signal` if you stream — it is aborted when the caller goes away —
and `request.clientId` if you have to report which tenant an event belongs to.

Your adapter's credentials arrive **resolved**, on `deps.secretValues`, keyed by the field name
its section of the document uses. Do not read an environment variable for a per-tenant credential:
a pooled host serves several tenants in one process and has nowhere to put one. `surfaces/web` is
the example — it reads no environment variable at all.
```

Add a short section after "Adding a migration":

```markdown
## Adding a secret source

`SecretSource` is two methods in `@harness/config-api`: a `name` and `resolve(clientId, ref)`. Add
the implementation in its own package, add a line to `SECRET_SOURCES` and a branch to
`loadSecretSource` in `harness/core-tools/src/domain/config/registry.ts`, and run
`secretSourceConformance` from `@harness/config-api/testing` against it — the suite is what keeps
"a source" one thing rather than two.

Two rules the contract fixes and the suite checks: `{ env: NAME }` always means the environment,
whichever source is configured, and a failure is a `ConfigError` whose message is a clause about
the *reference* — never the value, never the row and never a statement. `resolveSecrets` puts the
client, the surface and the field in front of your clause, which is why the signature does not
carry them.
```

and in "Adding an environment variable", one sentence:

```markdown
The scan walks the kernel's seven source roots only (`SOURCE_ROOTS` in `record-surface.ts`). The
platform's directories document their own variables and are outside it on purpose.
```

- [ ] **Step 6: `README.md`**

In "Layout", add `surfaces/web` beside `surfaces/slack` and `surfaces/memory`, and add `catalog/`,
`control-plane/` and `deploy/` to the list of top-level directories with one line each saying they
are the platform and that no kernel package imports them.

In "Run locally", add one line to the environment checklist: *`HARNESS_SECRET_SOURCE=env` — where a
document's secret references resolve; required, no default.* And one sentence under it: *what you
set in `.env` is a deployment's — keys, URLs, ports. A tenant's credentials are rows in
`client_secrets`, named by that tenant's document; see "Secrets from a store" in the runbook.*

- [ ] **Step 7: The package READMEs**

- `harness/surface-api/README.md` — already extended in Task 2; add one line to its `SurfaceDeps`
  paragraph saying that `secretValues` carries resolved values and `defaultConversation` the
  conversation this client's document named, and that both are opaque to the host.
- `harness/config-api/README.md` — a section on `SecretSource`: the two methods, the two
  implementations, the conformance kit, and `resolveSecrets` running at tenant open.
- `harness/config-postgres/README.md` — `client_secrets` and `writeClientSecret`, the rewrite
  refusal, and a pointer to the runbook's write contract.
- `harness/host/README.md` — the two new read routes in its route list, and one line saying the
  host pipes a streaming surface response without reading it.
- `surfaces/memory/README.md` — the door's event stream, `emit` and `mountHttp`, and one sentence
  saying it is the seam's reference implementation and not a product surface. **Keep its existing
  warning that the shipped wrapper mounts no door.**
- `surfaces/slack/README.md` — its "This adapter reads `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET`
  and `SLACK_APPROVALS_CHANNEL`" paragraph is now half true and is the last place in the
  repository that presents a tenant's credentials as a deployment's: rewrite it to say the adapter
  is handed resolved values on `deps.secretValues`, that those three are the conventional names it
  falls back to for a field the document did not name, and that a pooled deployment names its own
  per tenant in `client_secrets`.

- [ ] **Step 8: `CHANGELOG.md`**

Add a section above `0.2.0`, written for the team that consumes this kernel. **Leave `## 0.2.0 — unreleased` exactly as it is**: dating a section is what tagging it does, the tag is the user's, and a plan that dated `0.2.0` on its way past would be a plan claiming a release it did not make. Two unreleased sections is the honest state of a repository that has shipped neither.

```markdown
## 0.3.0 — unreleased

The release the platform pins: a tenant with no Slack, secrets that are not environment variables,
and two lists a dashboard can hold.

### Added

- **A web surface.** `surfaces.web: { token: SecretRef; inbox?: string }` declares it, and it is
  first in the surface order, so a tenant that has one has it as its primary surface and its
  approval cards go to its inbox. Four routes under `/tenants/<clientId>/web/`: post a message,
  open a conversation's Server-Sent Events stream, post an action, post a form. Every request
  carries that tenant's own bearer. See "The web surface" in `docs/runbook.md`.
- **Secrets from a store.** `SecretSource` beside `ConfigSource`, with `env` and `postgres`
  implementations and a conformance kit at `@harness/config-api/testing`.
  `HARNESS_SECRET_SOURCE=env|postgres`, **required, no default**. A document's `{ ref: name }`
  resolves from `client_secrets` — one new table — through the AES-256-GCM envelope
  `@harness/db` already ships. A tenant added by writing rows answers on a pooled host with no
  restart.
- **A per-tenant gateway key.** `routing.gateway.key` is a `SecretRef`, resolved at tenant open
  and sent as the bearer for that tenant's model calls. Route names are unchanged; absent, the
  process key stands.
- **`GET /v1/approvals` and `GET /v1/memory`**, cursor-paged, tenant-scoped, authenticated exactly
  like `/v1/usage`. The column lists are in the runbook and are the whole of the guarantee: no
  approval payload, encrypted or not.
- **A streaming seam.** `SurfaceHttpResponse.body` is now `string | AsyncIterable<string>`, and
  `SurfaceHttpRequest` carries `clientId` and `signal`. The host writes the head, pipes each chunk
  as it is yielded and aborts the signal when the caller hangs up.
- **The client store as a stable write contract**: `client_documents`, `client_document_versions`
  and `client_secrets`, at the columns they have today, with the envelope and a test vector.

### Changed

- **`SurfaceDeps.secrets` is now `SurfaceDeps.secretValues`, and carries resolved values rather
  than environment variable names.** A `{ ref }` has no variable name, so the bag could not carry
  one; the rename is what forces every adapter's read to be looked at. An adapter still falls back
  to its conventional variable for a field the document did not name.
- **`routing:` is strict.** An unknown key there used to be stripped, so a mistyped `gatway:`
  would leave a tenant on the process key in silence.
- **A rewritten version is refused.** Writing `(client_id, version)` again with different content
  raises a `ConfigError`; an identical rewrite is still a no-op. Write content-hash versions and
  you will never see it.
- **`.env.example` is a deployment's file now.** A tenant's credentials are rows in
  `client_secrets`, named by its document as `{ ref }` and written from the platform's own
  interface. `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL` are still
  read — they are what the Slack adapter falls back to for a dedicated host whose document names
  nothing — and are still passed by Compose, but they are commented out in the example file
  because they are that host's business rather than a default anybody should fill in.
- `defaults.web` is allowed in the identity section and **may not name `lead` or `admin`**: one
  shared bearer mints every principal such a default describes, and none of them may decide an
  approval.
- `tenantKeysOf` reports a web tenant's own id as its key, so a pooled host routes its messages.

### Upgrading

1. Set `HARNESS_SECRET_SOURCE` in every deployment's `.env`. `env` keeps today's behaviour exactly.
2. Run the migration: one new table, `client_secrets`.
3. If you build a surface adapter, rename `deps.secrets` to `deps.secretValues` and read values
   rather than looking names up.
4. Nothing else changes: no route moved, no tool moved, and the tool surface snapshot is
   byte-identical to `0.2.0`'s.
```

- [ ] **Step 9: Regenerate the graph**

Run:
```bash
pnpm arch:graph
git status --short docs/architecture
```
Expected: `docs/architecture/graph.svg` changed, and **nothing else under `docs/architecture`**. The graph gains one node for `@harness/surface-web` and the edges into `@harness/surface-api` and `@harness/shared`. `dot` has to be on PATH; if it is not, install graphviz rather than hand-editing the file.

- [ ] **Step 10: Read what was written, as a reader**

Two greps, because both failures are silent:

```bash
grep -rniE 'slack|bolt|block ?kit|thread_ts|\bblocks\b|socket[ _-]?mode' harness/host/src --include='*.ts' | grep -v '\.test\.ts'
grep -rn 'hf1-platform\|second repository\|the platform repository' README.md ARCHITECTURE.md CONTRIBUTING.md docs/runbook.md
```
Expected: no output from either. The first is the rule spec §4.9 names outright; the second catches the two-repository wording decision 1b's amendment replaced, which is now wrong everywhere it appears.

- [ ] **Step 11: Run the four gates**

Run the gate command from Task 2 Step 14.
Expected: all green, at most 25 lint warnings. `git status --short docs/architecture` shows **only** `graph.svg`.

- [ ] **Step 12: Commit**

```
git add README.md ARCHITECTURE.md CONTRIBUTING.md CHANGELOG.md docs/runbook.md docs/architecture/graph.svg harness/surface-api/README.md harness/config-api/README.md harness/config-postgres/README.md harness/host/README.md surfaces/memory/README.md surfaces/slack/README.md surfaces/web/README.md
git commit -m "docs: the web surface, secrets from a store, the gateway key and the read routes"
```

---

## Self-review

**Review pass, 2026-09-21**, run against this worktree before the plan was finished: spec coverage sentence by sentence over sections 14–25, a placeholder scan, a type-consistency pass across the eight tasks, the deletion list per task, and a check that every task ends on the gates. What it found is below, with what each finding cost.

### 0. Review round 1, 2026-09-21

An independent read against the spec, the addendum and the code
(`.superpowers/sdd/2026-09-21-plan-11c-platform-seams/plan-11c-review.md`) found six blocking,
thirteen important and thirteen minor problems. **All thirty-two are applied**, and nothing was
ruled against. Each blocking fix was then re-checked everywhere the same name or behaviour
appears, which is where four of the follow-on edits below came from. What changed:

- **B1 — a case asserted `openStreams` before the generator had started.** An async generator's
  body does not run until the first `next()`, so the count was zero. The pull moves above the
  assertion, with the reason in the comment. Task 4's `stream.test.ts` already had this right;
  re-checked, and it is the only other place a plan case reads an open count.
- **B2 — Task 2's `bodyText` case contradicted Task 2's own generator.** `while (!aborted)` never
  runs for an already-aborted request, so the collector would have returned `''`. The loop now
  drains the backlog and *then* tests the signal. **Re-checked across the plan**: Task 4's
  `ConversationStreams.stream` had the same `while (!signal.aborted)` shape and now follows the
  same rule, so the seam's reference implementation and its first real one cannot disagree about
  what a caller who has already hung up receives.
- **B3 — Task 8 declared the flaky-abort repair and had no step for it.** The step was written
  after the reviewer started; it is now reconciled end to end — the prose, the Files list, the
  Interfaces line, Step 6 itself, the second commit's `git add` and the deletion list in §6 below
  all say the same thing, and the responder is the reviewer's shape (`controller.abort()` then a
  promise that never resolves), which reads better than the version that hid the abort inside a
  promise executor.
- **B4 — Task 3 broke `tenant.test.ts:52` and did not list it.** `poolFixture` now defaults its
  secret source to `envSecretSource(env)` rather than a `MemorySecretSource`: an empty store is
  not a deployment that has none, and the environment source keeps that case's refusal byte for
  byte. The file is in Task 3's Files list for the one thing that does change — the `describe` is
  named after a function this task deletes — and Task 4's `serve` passes its own store, which it
  already did.
- **B5 — Task 4's resume case read the delta rather than the closing frame.** A `{ say }` step is
  streamed on a surface that declares `streaming: true`, so `First.` arrives twice; resuming after
  the delta replayed the message. The case now matches `'"text":"First."'`. **Re-checked every
  resume assertion in the plan**: `stream.test.ts`'s four, `http.test.ts`'s two and the pooled one
  here, and this was the only one reading a frame it had not framed itself. The no-op
  `await waitFor(() => true)` beside it went with the rewrite (M12).
- **B6 — a third bare request literal.** `events.test.ts:91` builds `unsigned` as a named local;
  the plan named only lines 74 and 116. The step and the Facts row now name three, and say that
  lines 96 and 101 spread `signed()` and need nothing. **Re-grepped the repository**: those three
  literals, the two helpers and `handleSurfaceRequest` are every construction of a
  `SurfaceHttpRequest` there is, and the only new one is Task 4's own.
- **I1–I13.** `levelAtLeast` is in `identity-api/src/identity.ts`, not in `@harness/shared`, and
  the import is named; deleting `assertSecretsPresent` also orphans `type ClientDocument`, which
  the instruction now says to remove; an unused `type Db` is gone from a new test file; the web
  door's acknowledged deliveries are held in a `delivering` set and `settleDeliveries` awaits any
  session that has a `settled`, which is the latent cross-file deadlock the memory door's fixture
  comment already warns about; `card` and `notice` each carry more than one payload and all eight
  are now written down in `WEB_EVENTS`' comment, the README and the runbook; `buildDepsFromEnv`
  loses its untyped `let`; `surfaces.test.ts` already imports `type Logger`; `types.ts` is out of
  Task 6's Files list; Task 5's test imports core-tools once; the Facts row about `main.test.ts`
  says `{ ...process.env, … }` and why the variable is still needed; §20's dropped-frames notice
  is marked as proved at the unit level, with the reason; `registry.test.ts` and
  `dual-surface.test.ts` are out of Task 3's list, because `Surface.secrets` is not the field
  being renamed; and invariant 20's positive half is asserted against `hashArgs`.
- **M1–M13.** The catalogue rule's case is anchored to the rule rather than to the file;
  `0.2.0`'s heading stays unreleased and the plan says why; `deps.ts`'s comment no longer claims
  the tests go through it; `canonical()` says what it does with an explicit `undefined`; the
  events route checks its conversation id the way the message route does; the three `notice`
  payloads are documented; `timer?.unref()` loses its second optional chain; "first three lines"
  becomes five; the duplicate-export ambiguity in `index.ts` is resolved in one sentence;
  `types.ts:3`'s comment about where `SecretRef` lives is rewritten with the move; the memory
  door's `200` and the web door's `202` are reconciled in one sentence of the surface-api README;
  and `memoryRoute` reads its `principal` parameter once, into a local.

**One requirement arrived with the review and is not from it.** Tenant secrets are configured from
the platform's interface, never from a process environment: Task 3 Step 19 rewrites
`.env.example`'s messaging section into one comment block saying so, Task 9 says it again in the
runbook, the README and `surfaces/slack/README.md`, and the CHANGELOG lists it. **No variable is
deleted**, and the reason is measurable: Task 3 Step 16 turns `requiredEnv(secrets.botToken ?? 'SLACK_BOT_TOKEN', …)`
into `requiredEnv('SLACK_BOT_TOKEN', …)`, which is the first time the environment scan can see
that name at all — so all three Slack names must stay documented, and they stay as commented-out
lines, which `envNamesFromExample`'s own regex accepts. Nothing else in the kernel reads them
(grepped: `surfaces/slack/src/config.ts` and Compose, and nowhere else).

**One thing the reviewer suggested and this plan did not take.** Its "Decisions I would revisit"
asks for Task 4 Step 13 — invariant 24's parse-time ceiling on `defaults.web` — to move into Task
2 or to become a task of its own, because it is independent of the adapter. **Ruling: it stays in
Task 4.** `parseIdentityFileWithDefaults` already admits `defaults.web` today
(`UNDEFAULTABLE_SURFACE` is the string `'http'` and the defaults key pattern is
`SURFACE_NAME_PATTERN`), so the ceiling is only meaningful once a document can declare a web
surface and a request can mint a principal through it — and Task 4 Step 14 is the only place in
the plan where that happens end to end. Moving it earlier would land a bound on a surface nobody
can yet declare, in a task whose own gates could not exercise it.

### 1. What the first pass found, and what changed

1. **The platform's transplant merged into this branch while the plan was being written** (`eb21dc6`, carrying pull request #16). Task 8 was drafted as "write the two rules the transplant lands under"; the rules are already there, written by the platform, and four of them. Task 8 is now a check-and-close task: the kernel's own ban names `catalog`, `control-plane` and `apps` and **not `deploy`**, which decision 1b's four directories require, and nothing pins any of it. The Global Constraints, the Facts table and "Not in this plan" were rewritten to say the transplant has landed rather than that it might.
2. **depcruise fails outright on a glob whose parent directory does not exist** — measured, not assumed: `ERROR: ENOENT: no such file or directory, scandir …/catalog/src`. That is why no task adds a glob for `apps/` or `deploy/`, and why Task 8's third case asserts the glob only for a directory that exists. It is also why the kernel's ban still works for `deploy/`: dependency-cruiser follows the dependencies of what it cruises, so an import *into* an uncruised tree still matches a `to` path.
3. **`routing.ts` cannot import `SecretRefShape` from `document.ts`.** `document.ts` imports `./routing.js`, so the edge back would be a cycle and `no-circular` is an error. Task 5 moves the shape and its two patterns down to a leaf `secret-ref.ts` first, verbatim, with `document.ts` re-exporting the two names so nothing outside the package moves. Without this the gateway key could not be a `SecretRef` at all.
4. **`SurfaceDeps` had no way to carry a per-tenant conversation.** Spec §4.9 says `surfaces.web.inbox` defaults to `inbox` and that `SurfaceSession.defaultConversation` returns it, and says nothing about how it reaches the adapter — and an environment variable, which is how Slack's approvals channel arrives, is exactly what a pooled host cannot have. Decision 5: `surfaceConversationsOf` in `@harness/config-api` and one optional field on `SurfaceDeps` and `SurfaceSettings`, which is the third member of the family `tenantKeysOf` and `surfaceSecretsOf` already form.
5. **The two verbatim refusal texts could not come from the source.** `SecretSource.resolve(clientId, ref)` is fixed at two parameters by the spec and the messages name the surface and the field. Decision 2 composes them: the source raises a clause about the reference, `resolveSecrets` writes the sentence around it, and both come out byte-identical to what Plan 11a and Task 1 shipped. The same split is what keeps a driver's message — which can carry a statement fragment and therefore a value — out of anything a person stores (invariant 21).
6. **A document that declares `slack` cannot be opened in a test.** `pool.tenantFor` calls `session.start()` on every surface, and the Slack transport's `start()` calls `auth.test` over the network. That is why Task 3's tenant-open cases declare `web` (whose secret resolution fails before `loadSurfaces` is reached) and why invariant 21's "after a run" grep is in Task 4 rather than Task 3 — see the rulings below.
7. **Three test files construct a `SurfaceHttpRequest` literal**, and widening the request by two required fields breaks all three. Task 2 names the helper in `http.test.ts`, the helper and the **two** bare literals in `events.test.ts` (lines 74 and 116), and the **five** reads of `response.body` that stop type-checking once the field is a union — with `bodyText` added to `@harness/surface-api/testing` so both files collect a body the same way.
8. **`buildKernelConfig`'s third parameter reaches the stdio server.** Spec §4.11 says every caller changes, and the second caller is `buildDepsFromEnv`, which therefore builds a secret source of its own — which makes `HARNESS_SECRET_SOURCE` required for that process too. `main.test.ts` spawns that entrypoint with `env: { ...process.env, … }`, and the spread saves nothing because no CI runner sets this variable, so Task 5 adds it explicitly; without that line four smoke tests would fail on a variable nobody had told them about.
9. **`resetDatabase`'s truncation list is a literal.** A new table that is not on it keeps rows between cases, which shows up as a foreign suite failing. Task 3 adds `client_secrets` in the same step as the migration.
10. **The lint ceiling survived the transplant**: `pnpm lint` prints `✖ 25 problems (0 errors, 25 warnings)` on this branch, measured. The plan's rule — new code that adds a warning removes one — is therefore live rather than nominal.
11. **A cancellation case in `runtimes/deepagents` aborts on a timer and races the run it cancels**, and failed CI on 2026-09-21 on a pull request that touches nothing in that package. Fifty milliseconds is a guess about how long the run takes to reach its first model call, and an abort that lands earlier takes a different path through the graph — no model call recorded, and, depending on where the graph gives up, no terminal event. The fake gateway records a call **before** it awaits the responder, so a responder that aborts is the happens-before edge the case wanted all along. Task 8 Step 6, with the same assertions and the same name, and no sleep in place of the timer.
12. **The conformance suite binds three sources, not one.** Task 7's new case would have failed `@harness/config-files`, whose version is derived from content and for which "the same version with different content" cannot exist. The case skips exactly the way the `list` case does, on a property of the harness rather than on a name, and `MemoryConfigSource.put` gains the same refusal so that the suite is not asserting about a source that ignores it.

### 2. Spec coverage

| Spec | Where |
|---|---|
| §15 decision 17, a web surface as a `SurfaceSession` over the seam | Task 4, the whole of it |
| §15 decision 18, `SecretSource` with `env` and `postgres`, resolved at tenant open, no default | Task 3 Steps 3–6, 11, 13, 17 |
| §15 decision 19, `routing.gateway.key` sent as the bearer | Task 5 Steps 3–6 |
| §15 decision 20, `GET /v1/approvals` and `GET /v1/memory` | Task 6 |
| §15 decision 21, `@harness/config-postgres` stays unpublished and §6 is the contract | Task 7 Step 5 (the runbook), and the published set is unchanged (Global Constraints) |
| §15 decision 22, a rewritten version is refused | Task 7 Steps 1–3 |
| §15 decision 23, the seam gains a streaming body, `clientId` and `signal` | Task 2 Steps 3, 9 |
| §16, one repository and four boundaries | Task 8; the prose in Task 9 Step 4 |
| §4.9 the four routes, their bodies and their answers | Task 4 Step 9 (`door.ts`), Step 6's cases, Step 16's README |
| §4.9 the seam's three changes, and what does not change | Task 2 Steps 3 and 9; the 413 and the refusal rule are untouched and Task 2's last case asserts both |
| §4.9 `tenantKeysOf` gains `web` → the document id | Task 2 Step 10 |
| §4.9 `tenantHint = request.clientId`, not `deps.tenantKey` | Task 4 Step 9, `handleMessage`, and Task 4 Step 14's pooled case |
| §4.9 `surfaces.web.inbox`, default `inbox`, is where cards go | Task 4 Step 12; Task 4 Step 14's approval case posts through `postPendingApprovals` to the primary surface |
| §4.9 SSE framing, `id:` per frame, `Last-Event-ID`, the dropped-frames notice, the keep-alive | Task 4 Steps 2 and 4 (`stream.ts`) |
| §4.9 attachments checked against `<storageDir>/incoming` with `assertInsideRoot` | Task 4 Step 9, and a case in each of Steps 6 and 14 |
| §4.9 the status-code table, row by row | Task 4 Step 6: bearer, JSON, schema, attachment, method, sub-path, unknown id, unknown conversation; the 413 is Task 2's |
| §4.9 every JSON answer sets `content-type` explicitly, including the 401 | Task 4 Step 9, `JSON_HEADERS` |
| §4.9 identity, `defaults.web` allowed, `IdentitySession.resolve({ surface: 'web' })` | Task 4 Step 13 and Step 14's unknown-user case |
| §4.9 capabilities and `mention` | Task 4 Step 10; `mention` is a deviation, ruled below |
| §4.9 the bearer compared in constant time, by the adapter's own code | Task 4 Step 9, `bearerOk`, with the arch reason in its comment |
| §4.9 "what the host learns: nothing" | Task 2's dispatch names no event; Task 9 Step 10's grep; the vocabulary allowlist stays empty |
| §4.10 the `SecretSource` interface, two methods and no `list` | Task 3 Step 3 |
| §4.10 where each piece lives, `env` in config-api and `postgres` in config-postgres | Task 3 Steps 4 and 11; the registry in Step 13 |
| §4.10 `env`'s two refusals, verbatim | Task 3 Step 4 and Step 1's cases |
| §4.10 `postgres` selects `(client_id, name)` and decrypts; `{ env }` still means the environment | Task 3 Step 11 |
| §4.10 `HARNESS_SECRET_SOURCE`, no default, and Compose passes it through without a `:-` | Task 3 Steps 13 and 20 |
| A tenant's secrets are configured from the platform, not from a process environment (the user's rule, 2026-09-21) | Task 3 Step 19 rewrites `.env.example`'s messaging section; Task 9 Steps 2, 6, 7 and 8 say it in the runbook, the README, the Slack adapter's README and the changelog |
| §4.10 resolution once, at open, **before** `buildKernelConfig` | Task 3 Step 17, and Task 3 Step 14's fourth case proves the order |
| §4.10 `secrets` → `secretValues` at all four sites | Task 3 Step 16, which names all four |
| §4.10 the conventional-name fallback moves outside `requiredEnv` | Task 3 Step 16, `config.ts` |
| §4.10 rotation is paired with a version bump | Task 9 Step 2 |
| §4.10 the envelope and its test vector | Task 3 Step 8 (`the envelope` describe); Task 7 Step 5 documents it |
| §4.10 a resolved secret is a value and is treated as one | invariant 21, below |
| §4.11 `routing.gateway.key`, resolved and carried on `GatewayConfig.apiKey` | Task 5 Steps 3–5 |
| §4.11 a signature change with both callers | Task 5 Step 6 |
| §4.11 `LITELLM_MASTER_KEY` stays required | Task 5 Step 5's comment, and `gatewayFromEnv` is still called |
| §4.11 `model: <route>` unchanged, `model_calls` keeps its `client` | Task 5 Step 7's second assertion |
| §4.11 the two `gatewayError` sentences rewritten | Task 5 Step 5 |
| §4.12 both routes, the envelope, the column lists, the filters, paging, no principal resolution | Task 6 Steps 3 and 6 |
| §4.12 a client this host does not serve is `404 {"error":"no such client"}` | Task 6 Step 5's last case; the route reuses `handleApiRequest`'s own resolution |
| §6 `client_secrets`, and the three tables as a write contract | Task 3 Step 10; Task 7 Step 5 |
| §6 rule 1, both document tables in one transaction | unchanged, and Task 7 Step 3 says so explicitly |
| §6 rule 2, the watch follows `client_documents.version` | Task 7 Step 5; Task 9 Step 2's rotation steps |
| §6 rule 3, a version is written once, compared inside the transaction | Task 7 Step 3, with the ordering argument |
| §6 rule 4, the kernel validates on read regardless | unchanged (`migrate`, the id check, the absolute-path check); Task 7 Step 5 states it |
| Invariant 20 | Task 4 Step 6's bearer case (nothing parsed, nothing delivered) and Step 14's counted-rows case, which asserts both halves: `args_hash` equals `hashArgs({ asked, method, path })`, and the row carries neither in the clear |
| Invariant 21 | Task 3 Steps 1, 8 and 14; Task 4 Step 14's last case; see ruling 3. **Its `RunEvent` clause is vacuous on this path and is not tested**: a secret reaches `SurfaceDeps.secretValues` and `GatewayConfig.apiKey`, and neither is read by anything that builds a `RunEvent` — the runtime is handed `model.apiKey` and emits `text`, `usage`, `tool_call`, `tool_result`, `skill_activated`, `done` and `error`, none of which carries it |
| Invariant 22 | Task 5 Step 7 |
| Invariant 23 | Task 6 Step 1's two whole-column-list assertions and its cross-tenant cases |
| Invariant 24 | Task 4 Step 13 — the **parse-time ceiling**, which is the clause this plan adds. Its first clause, "a principal derived through `defaults.web` never exceeds that default's level", is `principalFromDerivedId`'s existing behaviour: it builds a principal at `defaults[surface]` and at no other level, and `identity-api`'s own suite already covers it |
| §20 the streaming seam's four properties | Task 2 Step 6's four cases |
| §20 the web surface through the real pool, seven named behaviours | Task 4 Step 14, case by case — **except the dropped-frames notice**, which is proved at the unit level in Task 4 Step 2 and not through the pool. Driving it end to end means emitting past `WEB_FRAME_RETENTION`, which is two hundred turns or two hundred hand-written frames on a surface a test can only reach through the socket; `stream.test.ts` drives the same producer the pool uses, with the window as its own constant |
| §20 the pooled tenant hint, and the dedicated refusal unchanged | Task 4 Step 14's two-tenant case; the dedicated refusal is Plan 11b's and is untouched |
| §20 `secretSourceConformance` run by both implementations | Task 3 Steps 5 and 8 |
| §20 the envelope vector as a test | Task 3 Step 8 |
| §20 `client_secrets` isolation, and a `{ ref }` with no row | Task 3 Steps 8 and 14 |
| §20 the gateway key on `model_calls` | Task 5 Step 7 |
| §20 the version-rewrite refusal | Task 7 Step 1 |
| §20 the read routes' column lists, the four statuses and a fifth refused | Task 6 Steps 1 and 5 |
| §20 `defaults.web` bounded | Task 4 Step 13 |
| §20 snapshots: the tool surface byte-identical, the compose snapshot re-recorded once | Global Constraints; Task 3 Step 21 |
| §21 row 11c's exit criterion | "a tenant with no Slack talks to its agent through the web surface": Task 4 Step 14's first case, end to end through a real pool. "A tenant added by writing rows answers with no restart": Task 3 Step 14's cases prove resolution at open, and Task 4 Step 14 opens a tenant whose bearer came out of a store |
| §23 constraints 11, 12, 13, 14, 16, 17, 18, 19, 20, 21, 23, 24 | Task 4 Step 1 (11, 14), Task 4 Steps 9 and 17 (12), Task 8 (13, 16, 17), Task 2 Step 10 (18), Task 3 Step 17 (19), Task 5 (20, 21), Global Constraints (23), Task 4 Step 10 (24) |

**Not covered, and why.** §23 constraint 15 — `pnpm-workspace.yaml`'s globs widening with the transplant — is the transplant's, and it did it: both new packages are `"private": true`, which is what that constraint is about, and Task 4's new package follows the same rule. §13.5's durable SSE window, §13.7's `list` and §13.8's rotation mechanisms are open questions this plan answers with a decision and a contract rather than with code, as those sections ask. §25's Plan 12 list is untouched.

### 3. Rulings

Seven places where the spec, the brief and the code did not all agree, and what this plan decided.

1. **`mention(userId)` answers `@<userId>`.** §4.9 says `@<displayName>` "where the principal has one". `SurfaceSession.mention` takes a user id, the adapter is handed no principal, and the request body §4.9 itself fixes carries no display name — so the sentence has no source to be true from. Inventing a body field would be inventing a contract; the honest answer is the one `surfaces/http` and `surfaces/memory` already give, and a display name reaches the model through the identity plug-in exactly as it does on every other surface. Recorded in decision 7, in the adapter's own comment and in its README.
2. **Five event names, not four.** §4.9 lists `delta`, `card`, `card_update` and `notice` as "the surface's own". A reply that was not streamed has no `delta` and a streamed one has no end, so a client reading only those four cannot tell a finished answer from a pause. The adapter also sends `message`. The host learns none of the five, which is the property that sentence is really about.
3. **Invariant 21's "after a run" grep is in Task 4, not Task 3.** The brief puts it in Task 3. In Task 3 there is no tenant that both carries a secret and can be opened in a test: the only surfaces with credentials are `slack`, whose `start()` calls `auth.test` over the network the moment a pooled host opens it, and `web`, whose package does not exist until Task 4. Task 3 proves the half it can — every refusal, error and log line the resolution path produces, and the store's isolation against a real database — and Task 4 runs the grep over `audit_log` and the host log after a real turn, with a bearer that came out of the store.
4. **The gateway key is proved through `callModel`, not through a turn.** §20 asks for "a turn each against a fake gateway". A turn under the scripted runtime makes no model call at all, so a turn would prove nothing; the test builds each tenant's own run deps from its own `KernelConfig` and makes the call a tool would make, against a fake gateway on `127.0.0.1:0` that records the bearer. Same path, same rows, and it fails if either key leaks.
5. **`resolveSecrets` lives in `@harness/config-api`.** The spec says what it does and not where it is. It reads the typed document sections, which is the work the host is specifically not allowed to do, and its result has to be a parameter of `buildKernelConfig` in a package that cannot import the host. Decision 1.
6. **`SecretRefShape` moves to a leaf module.** A consequence of putting the gateway key in `routing.ts`, and the only alternative — `routing.ts` importing `document.ts` — is a cycle. The move is verbatim and `document.ts` re-exports both names, so no consumer sees it.
7. **Task 8 is smaller than the brief expected.** The brief asked for the one-way rule and the `catalog/` rule to be written "now so the platform's transplant lands under them". The transplant landed first and wrote four rules of its own. What was left is the gap they have — `deploy/` is missing from the kernel's ban — and the three tests that stop any of it rotting: the ban names all four directories, the catalogue rule names the contracts, and every platform directory that exists is actually cruised.

### 4. Placeholder scan

Searched the whole plan for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to Task`, `as needed` and `and so on`. **None present.** Every code step carries the code, every test step carries the test, and every command step carries the command and what it should print.

Two ellipses remain on purpose and neither hides a decision: Task 2 Step 9 marks the `catch` block of `handleSurfaceRequest` as unchanged and says what it contains, and Task 8 Step 5 marks the existing paragraph of a doc comment it is extending. Three steps tell the implementer to **read something and match it** rather than quoting it, each where quoting would be a guess: `harness/core-tools/src/domain/models/gateway.test.ts`'s assertions on the two rewritten sentences (Task 5 Step 5 says which two strings to search for), `ARCHITECTURE.md`'s and `CONTRIBUTING.md`'s existing heading levels and voice (Task 9), and the package READMEs' own shapes (Task 9 Step 7, which says what each must gain).

### 5. Type consistency across tasks

- **`SurfaceHttpRequest`** is six fields — `method`, `path`, `headers`, `body`, `clientId`, `signal` — in Task 2's declaration, in Task 2's host construction, in the two test helpers and three bare literals Task 2 updates, and in Task 4's `door.ts` signature and its own test helper. `body` is a raw string in all of them. Re-grepped after the review: those are every construction of one in the repository.
- **`SurfaceHttpResponse`** is `{ status; headers?; body?: string | AsyncIterable<string>; refusal? }` in Task 2, is what Task 2's `send` reads, and is what Task 4's door returns from every branch. No task invents a fifth field.
- **`SurfaceDeps`** gains exactly two optional members across the plan: `secretValues` (Task 3, renamed from `secrets`) and `defaultConversation` (Task 4). `SurfaceSettings` gains the same two, with the same names and types, and `tenant.ts` fills all three settings fields in three loops over three `@harness/config-api` accessors.
- **`SecretSource`** is `{ name; resolve(clientId, ref); close? }` in Task 3's declaration, in `envSecretSource`, in `MemorySecretSource`, in `postgresSecretSource`, in the conformance harness and in `HostDeps.secrets`. One shape, six sites.
- **`ResolvedSecrets`** is `{ surfaces }` in Task 3 and `{ surfaces; gatewayKey? }` in Task 5 — an addition, never a change — and it is what `resolveSecrets` returns, what `buildTenant` holds, and what `buildKernelConfig`'s third parameter takes in both callers and in `config.test.ts`.
- **`SecretRef`** is `{ env } | { ref }` in Task 1's shipped schema, in Task 3's `resolve` signature, in Task 5's `routing.gateway.key`, and in the leaf module Task 5 moves it to. `resolveSecrets` narrows a `SurfaceSecretRef` back to the bare union before it calls a source, so no source is handed two fields the contract does not promise.
- **The web surface's frames** are the five of `WEB_EVENTS`, declared once in `stream.ts`, emitted from every outbound call in `session.ts` through one `emit` helper, asserted in `door.test.ts` and `web-surface.test.ts`, and listed with all eight of their payloads in `WEB_EVENTS`' own comment, the README and the runbook. `ConversationStreams.emit`'s second parameter is typed by that tuple, so a sixth name is a type error rather than a frame nobody documented.
- **`settled()`** is on `MemorySurface` (Plan 11b) and on `WebSession` (Task 4), with the same signature and the same reason, and `settleDeliveries` in the host's fixture awaits either by structure rather than by class. It is deliberately **not** on `SurfaceSession`: the host never waits on a delivery, and a contract member nothing in production reads is a member the next adapter implements for nobody.
- **The four routes** are the same four strings in `door.ts`, in `door.test.ts`, in `web-surface.test.ts`'s helpers, in the README's table and in the runbook's table. `WEB_MOUNT_PATH` is declared once and `assertMounts` validates it at tenant open like every other mount.
- **`APPROVAL_STATUSES`** is the same four values in `reads.ts`, in the route's refusal message, in Task 6's route case and in the runbook. There is no `decided`.
- **The cursor** is `base64url("<iso>|<uuid>")` in `encodeCursor`, `decodeCursor`, both reads and both routes, and it is opaque everywhere else.
- **`tenantKeysOf`, `surfaceSecretsOf`, `surfaceConversationsOf`** all return `{ surface, … }[]` and are all read in one place, `buildTenant`'s three loops.

### 6. Deletions, per task

Task 1 (done): nothing. Task 2: nothing — two functions change shape and one gains a parameter. Task 3: `assertSecretsPresent` with both its refusal branches, the `if (!('env' in ref)) continue` guard and its comment, `SurfaceDeps.secrets`, `SurfaceSettings.secrets`, two now-orphaned imports in `tenant.ts` (`surfaceSecretsOf` and `type ClientDocument`), the conventional-name expression inside `requiredEnv`'s first argument, and `.env.example`'s messaging-surface settings — the three names stay documented as commented-out lines, so nothing is removed from the environment scan's reach. Task 4: nothing. Task 5: nothing moves out of the workspace — `SecretRefShape` moves *within* `@harness/config-api`, and the two `gatewayError` sentences are rewritten rather than removed. Task 6: nothing. Task 7: the silent-rewrite behaviour, which is a deletion in the only sense that matters — no code path is left that moves a live document while keeping the old history. Task 8: the `setTimeout` that a cancellation case aborted on, replaced by an abort inside the model call rather than removed and left to chance. Task 9: the two-repository wording, everywhere `grep` finds it, which is what Step 10's second grep is for.

### 7. Every task ends green

Eight tasks to execute, eight "Run the four gates" steps, nine commits — Task 8 makes two, because the boundary rules and the flaky abort are two changes and somebody bisecting one should not land on the other — and no gate deferred to a later task. Task 3 is the only one whose gates involve a re-recorded snapshot, and its Step 21 checks `git diff --stat docs/architecture` and stops if `tool-surface.json` moved; Task 9's Step 11 expects `graph.svg` and nothing else. Every other task's gate step expects `git status --short docs/architecture` to be empty. Task 9's Step 10 also runs the vendor grep over `harness/host/src`, because the failure it catches is a sentence somebody wrote while explaining a mount rather than a symbol a compiler would find.

The gate command is cited as "Task 2 Step 14" in Tasks 3 through 9, and it is the same five commands with the same three-variable prefix in every one of them.

### 8. Two things a reviewer should push back on if they disagree

- **The SSE window is two hundred frames, in memory, per host** (decision 8). It is the smallest answer that lets §4.9's resume behaviour exist at all, and it is wrong the day the platform runs two hosts behind one ingress — which is why the dropped-frames notice is mandatory rather than optional, and why §13.5 stays open. If the platform would rather have a table now, that is a different plan and a write per delta.
- **This plan is 6,300 lines against a 4,000–6,000 brief.** The excess is Task 4, which ships a package, its four routes, its stream and an end-to-end suite through a real pool. Splitting the web surface from its host test would produce two tasks that cannot each end green alone, which this plan's own rule forbids.
