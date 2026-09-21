# Plan 11b: Transport and publishing — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take the socket out of the kernel and put a version on it. The Slack adapter stops holding a Socket Mode connection and becomes a request handler: the surface contract gains an optional `http` seam, the host mounts every tenant's handler at `/tenants/<clientId>/<path>` on the one HTTP server it already runs, and a signed Slack event delivered over HTTPS runs a turn on a host that holds no socket and can therefore be paused, pooled and put behind an ingress. Bolt goes with `SLACK_APP_TOKEN` and the dependency. Then the repository stops being a checkout: seven contract packages become publishable with a real build step, a tagged release runs the gates, pushes the host and files images to GHCR and attaches the package tarballs and the two architecture snapshots to a GitHub Release, and Compose pulls that image instead of building from the working tree. `@harness/sandbox-api` is reserved as an interface with a conformance kit and no implementation. At the end of this plan the platform repository can pin a version of this kernel instead of a commit, and a tenant's Slack workspace reaches a host through a URL.

**Architecture:** Five moves. (1) **A seam.** `SurfaceSession` gains `http?: { path; handle }` in `@harness/surface-api`, with `SurfaceHttpRequest`, `SurfaceHttpResponse` and a refusal shape the host audits. `MemorySurface` implements it behind `mountHttp()`, so the reference adapter is also the seam's reference implementation and every host test drives the thing that ships. (2) **One server, one mount rule.** The run API's listener becomes the host's HTTP server and always starts; its bearer check becomes route-aware, `/v1/*` behind the bearer and `/tenants/*` in front of it, protected by the surface's own verification. One rule for every deployment shape: `/tenants/<clientId>/<path>`, resolved through the pool's existing `ClientResolver`, so a dedicated host refuses a foreign client id and audits it (invariant 19), and a surface's refusal is audited exactly once by the host (invariant 15). The host never names a vendor: the path and the reason are data the surface supplies. (3) **Slack over HTTPS.** `transport/events.ts` replaces `transport/bolt.ts`: HMAC-SHA256 verification over `v0:<timestamp>:<raw body>` with a five-minute window, `url_verification`, acknowledge-then-run, one URL for event callbacks and interactive payloads, and `auth.test` for the bot identity Bolt's context used to supply. The classifier and the thread memory move out unchanged; the fake transport stays. (4) **Publishing.** Seven packages get `private: false`, a `tsconfig.build.json` that emits ESM and declarations into `dist/`, `files`, and a `publishConfig.exports` pnpm applies at pack time; `release.yml` on a `v*` tag runs the gates, pushes two images to GHCR and creates a Release with the tarballs and the two snapshots; Compose pulls `ghcr.io/mgavrila/agent-harness-host:${HARNESS_IMAGE_TAG}` and builds nothing. (5) **A reserved seam.** `@harness/sandbox-api` declares `SandboxProvider`, `Sandbox`, `SandboxSession` and `ExecResult`, ships `MemorySandboxProvider` and `sandboxProviderConformance`, and nothing imports it.

**Tech Stack:** Node `>=22`, pnpm `11.4.0`, TypeScript 7 (`^7.0.2`) in every package with `typescript@6.0.3` at the workspace root only, ESM only, zod v4 as `import * as z from 'zod/v4'`, vitest `^5.0.0`. **No new third-party dependency.** `@slack/web-api@8.1.1` moves from a type-only import to a runtime one — the same resolution, already in the lockfile — and `@slack/bolt@5.1.0` is removed, which takes `@slack/oauth`, `@slack/socket-mode` and the express types out of the lockfile with it. One new workspace package: `@harness/sandbox-api`, with no dependency but `@harness/shared`.

**Spec:** `docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md` — this plan is section 5.2, "Plan 11b — transport and publishing". It implements decisions 2b, 9, 10 and 14; sections 4.6, 4.7 and the "Sandboxes (reserved)" paragraph of 4.8; the first bullet of section 7; invariant 15 and invariant 19 as it applies to an HTTP path; section 9's transport-test rule and its compose-snapshot sentence; and the exit criterion of section 10's row 11b — "a Slack event delivered over HTTPS to a host with no socket runs a turn; a tag publishes packages and image". It starts from `worktree-plan-11b-transport-publishing` at `1f7ef57`, which is `main` with Plan 11a merged. Section 12's constraints 1–4 are answered by named tasks below.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`.
- **The four gates plus the suite pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; up to 25 type-aware warnings are the known backlog), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test`. No task ends red and no gate is parked.
- **Local test environment.** Run the suite with these three variables in front of the command and nothing else; never source `.env`:
  ```
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder
  ```
  Those databases exist; do not create or drop them, and run no container command against either.
- **No migration in this plan.** **No task touches `harness/db/src/domain/schema.ts` or `harness/db/drizzle/`.** The one new audit row this plan writes goes into `audit_log` as it stands: `decision` is a plain `text` column with no check constraint, so widening the `Decision` union in `@harness/core-tools` by one member is a type change and nothing else.
- **Environment variables.** One is deleted and one is added, and both are Compose-and-documentation work as much as code:
  | Variable | Read today by | Change |
  |---|---|---|
  | `SLACK_APP_TOKEN` | `surfaces/slack/src/config.ts` (`slackConfig`), passed to Bolt in `transport/bolt.ts` | **Deleted.** Task 3 deletes the reader and the `Surface.secrets` entry; Task 4 deletes it from `.env.example`, from `harness/compose/docker-compose.yml` and from the `surface.test.ts` assertion that requires it to be defined |
  | `HARNESS_IMAGE_TAG` | nothing; it is interpolated by Compose only | **Added in Task 4** and documented in `.env.example`. `.env.ci` is **deleted** in the same task rather than given a value: its one consumer was the Compose build command Task 4 replaces |
  `SLACK_SIGNING_SECRET` is **first read by code** in Task 3. It is already documented in `.env.example` and already passed by Compose, so no task has to add it; `harness/core-tools/src/app/surface.test.ts` scans every non-test source file for environment reads and fails on a name `.env.example` does not document, and a name that stops being read may stay documented without failing anything.
- **Snapshots.** The **tool-surface snapshot** (`docs/architecture/tool-surface.json`) is byte-identical in **every task of this plan**: no task adds, removes or re-describes a tool, and the recorder's fixture document declares `surfaces: { memory: {}, http: {} }` with no Slack section at all. `git status --short docs/architecture` proves it. The **Compose snapshot** (`docs/architecture/compose-surface.yaml`) changes in exactly **one** task, **Task 4**, which is the only task that edits `harness/compose/docker-compose.yml` and the only one that runs `pnpm surface:record`. Every other task leaves both files byte-identical, and a task that finds otherwise has broken something it did not mean to.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its **empty allowlist**, and the suite's own assertion that it stays empty is untouched. `MESSAGING_FORBIDDEN` gains `socket ?mode` in Task 8, and `harness/approvals/src/host-vocabulary.test.ts`'s copy of the same regex gains it in the same task; both self-checks gain a line proving the new alternative matches what it claims and does not match an ordinary `socket`. **`harness/host/src` never names a vendor**: the new HTTP dispatch says "surface", "mount path", "client id" and "refusal reason", and every vendor-shaped string in it — the path, the reason, the response headers — is data a surface supplied.
- **Architecture rules.** `@harness/sandbox-api` adds **one `PACKAGES` row** and **one `WORKSPACE_DIRS` entry** to `.dependency-cruiser.cjs`, exactly as that file's "HOW A NEW PACKAGE IS ADDED" note says, and nothing else there changes. `a-surface-imports-only-api-and-shared` is not weakened: the Slack adapter imports `@harness/surface-api`, `@harness/shared`, itself, `node:crypto` and `@slack/web-api`, and its own tests are not exempt from the rule either. `the-host-never-statically-imports-a-plugin` is not weakened: the host reaches a surface's HTTP handler through the `SurfaceSession` objects its pool already holds, never through an import.
- **No new third-party dependency anywhere.** `@slack/web-api@^8.1.1` is already a declared dependency of `@harness/surface-slack` and is already resolved in the lockfile; this plan changes only whether the import is type-only. `@slack/bolt` is removed, and `pnpm install` will shrink the lockfile by `@slack/bolt`, `@slack/oauth`, `@slack/socket-mode`, `@slack/logger` and the `@types/express` peer. `@harness/sandbox-api` takes no dependency but `@harness/shared` and the three devDependencies every package has. `release.yml` uses only the three GitHub Actions `ci.yml` already uses — `actions/checkout@v4`, `pnpm/action-setup@v4`, `actions/setup-node@v4` — and does its registry work with the `docker` and `gh` CLIs the runner ships.
- **No backwards compatibility (spec decision 2b).** No shim, no dual code path, no "still works" clause, no deprecation comment. Socket mode is deleted, not disabled. Every task lists the files it **deletes**, and the deletion happens in that task.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **No test sleeps longer than 200 ms**, and no test waits for a real interval. A listening test binds `127.0.0.1:0` and reads the port off the socket; `waitFor(ready, timeoutMs)` in `harness/host/src/testing.ts` is the polling helper, and it is what a test uses to wait for a turn that an acknowledged request started asynchronously.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up`, `pnpm db:down` or `pnpm demo:up` from a task.** `docker compose ... config` is read-only and is what `pnpm surface:record` uses. `docker build` is not run from a task either: Task 4 edits the workflow that runs it and Task 7 writes the workflow that pushes it, and neither builds an image locally.
- Do not push from a task. Do not open a pull request from a task. Do not create a tag: the version bump and the tag are the user's, after this plan's pull request merges.

---

## Facts verified for this plan

Read out of this worktree (`worktree-plan-11b-transport-publishing` at `1f7ef57`) or run in a scratch on 2026-09-21. The grounding map at `.superpowers/sdd/os-boundary/grounding-11b.md` is the full record; what follows is what a task below depends on, re-verified where a mistake would cost a task its gates.

### The Slack adapter as it stands

| Fact | Value | Where |
|---|---|---|
| `@slack/bolt` is imported in exactly one file | `import { App, LogLevel } from '@slack/bolt';` | `surfaces/slack/src/transport/bolt.ts`, line 1 |
| `@slack/web-api` is imported **type-only**; the runtime client comes off Bolt | `import type { WebClient } from '@slack/web-api';` and `const api = webClientApi(bolt.client)` | `transport/web-client.ts`, `transport/bolt.ts` |
| The adapter reads exactly three variables, all through `deps.env` | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`, `SLACK_APPROVALS_CHANNEL` | `surfaces/slack/src/config.ts` |
| `Surface.secrets` for Slack, pinned by a test | `['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']`, asserted sorted in `index.test.ts` | `surfaces/slack/src/index.ts`, `index.test.ts` |
| **No code anywhere reads `SLACK_SIGNING_SECRET`** | The document declares `surfaces.slack.signingSecret` and `assertSecretsPresent` only checks the named variable is non-empty | `harness/config-api/src/document.ts`, `harness/host/src/domain/tenancy/tenant.ts` |
| There is **no** signature verification, **no** `url_verification` handler, **no** retry-header handling and **no** event-id dedupe anywhere in the repository | `grep` for `url_verification`, `challenge`, `x-slack-signature`, `x-slack-request-timestamp` returns nothing outside `docs/superpowers/` | whole tree |
| `SlackTransport` | `{ api: SlackApi; events: SlackEvents; notePostedIn(channel, messageId): void }` | `transport/types.ts` |
| `SlackEvents` | `onAction`, `onView`, `onMessage`, `start(): Promise<void>`, `stop(): Promise<void>` | same |
| The bot identity comes off **Bolt's context** | `identity(context) => ({ userId: context.botUserId, botId: context.botId })`, used by `classifyInbound` for the mention token and the thread rule | `transport/bolt.ts` |
| `SlackApi` has no `auth` member today | `chat`, `files`, `views`, `conversations`, `usergroups`, `users` | `transport/types.ts` |
| `boltTransport` itself has **no test**; the 18 cases in `bolt.test.ts` drive `classifyMessage`, `classifyInbound`, `createThreadMemory` and `THREAD_MEMORY_LIMIT` as pure functions and construct no `App` | | `transport/bolt.test.ts` |
| `downloadAttachments` | `(ts: string, files: readonly SlackFile[], deps: DownloadDeps) => Promise<{ name: string; path: string }[]>`, `DownloadDeps = { token, storageDir, fetch?, log, maxBytes? }` | `transport/files.ts` |
| `fakeSlackSession` builds its config literal and skips the transport entirely | `{ botToken: 'xoxb-test', appToken: 'xapp-test', defaultConversation: 'C0DEMO' }`, wired straight into `createSlackSession` | `surfaces/slack/src/testing.ts` |
| Interactive payloads reach `registerApprovalHandlers` through Bolt's two catch-all registrations | `bolt.action(/.*/)` → `events.onAction` → `session.onAction`; `bolt.view(/.*/)` → `events.onView` → `session.onFormSubmit` | `transport/bolt.ts`, `session.ts`, `harness/approvals/src/domain/handlers.ts` |
| `surfaces/slack` is scanned by **no** vocabulary test | "`surfaces/slack` is exempt from the messaging list because it *is* the messaging vendor" | `harness/core-tools/src/kernel-vocabulary.test.ts`, header comment |
| `surfaces/slack/src` is **not** exempt from the `process.env` ESLint ban | `PROCESS_ENV_IS_FINE` covers `**/src/app/**`, `**/*.test.ts`, `harness/shared/src/env.ts`, `harness/db/src`, `**/drizzle.config.ts` and nothing else | `eslint.config.js` |
| `MESSAGING_FORBIDDEN` contains `bolt` but **not** `socket`, `webhook`, `signature` or `hmac` | `/slack\|bolt\|block ?kit\|thread_ts\|\bblocks\b/i` | `kernel-vocabulary.test.ts`, and the identical copy at `harness/approvals/src/host-vocabulary.test.ts` |

### The surface contract and the host's listeners

| Fact | Value | Where |
|---|---|---|
| `SurfaceSession` members, in order | `name`, `capabilities`, `defaultConversation`, `directory?`, `mention`, `postCard`, `updateCard`, `postText`, `postPrivate`, `uploadFile`, `openForm`, `onAction`, `onFormSubmit`, `onMessage`, `startStream`, `typing?`, `start`, `stop` | `harness/surface-api/src/types.ts` |
| `SurfaceDeps` | `{ env: EnvSource; log: Logger; storageDir: string; tenantKey?: string }` | same |
| `MemorySurface` is both the shipped `@harness/surface-memory` and every host test's surface | `surfaces/memory/src/index.ts` is a 31-line wrapper over `MemorySurface` from `@harness/surface-api/testing` | those files |
| `MemorySurface.say(userId, text, over?)` spreads `tenantHint` **before** `over` | so a test can override the workspace an event claims | `harness/surface-api/src/testing.ts` |
| `loadSurfaces(names, deps, tenantKeys)` splices `tenantKey` in only for a surface named in the map | `Object.hasOwn(tenantKeys, surface.name) ? { ...deps, tenantKey: … } : deps` | `harness/approvals/src/domain/surfaces/registry.ts` |
| `LoadedSurfaces.secrets` is built and **no shipping code reads it** | built at the end of `loadSurfaces`; read only by `dual-surface.test.ts` and `registry.test.ts`. `coreToolsChildEnv` no longer exists; a stale comment in `harness/shared/src/env.ts` still names it | those files |
| **Two** HTTP servers run in the host | `/healthz` on `APPROVALS_HEALTH_PORT` (8787, bind `0.0.0.0` in Compose) and the run API on `HARNESS_HOST_PORT` (8788), the second **only when `HARNESS_HOST_TOKEN` is non-empty** | `harness/host/src/app/main.ts` |
| `handleApiRequest` checks the bearer **before** matching the route | `if (!bearerOk(req.headers.authorization, opts.token)) return json(res, 401, …)` at the top, then the tenant lookup, then the route table | `harness/host/src/domain/api/routes.ts` |
| `bearerOk('Bearer ', '')` is **true** | both buffers are empty, the length check passes and `timingSafeEqual` on two empty buffers returns true — so an always-started listener must refuse `/v1/*` on an empty configured token explicitly | `routes.ts`, read 2026-09-21 |
| `readBody` is exported from `routes.ts` and imported by `routes.test.ts` | it stops consuming past `API_MAX_BODY_BYTES` and resolves `{ ok: false }` without destroying the socket | those files |
| The route table today | `GET /v1/status`, `GET /v1/usage`, `POST /v1/runs`, `POST /v1/runs/:id/cancel`, `GET /v1/threads/:id`; anything else is 404 `no such route` | `routes.ts` |
| `startRunApi(pool, opts)` takes the **pool**, resolves the tenant per request, and `ready` resolves on `'listening'` so a test can bind port 0 | `RunApiOptions = { token: string; bind?: string; port?: number }` | `harness/host/src/domain/api/server.ts`, `types.ts` |
| The resolver, both modes | `dedicatedResolver(clientId, keysOf)` accepts `from: 'api'` with `null` or a matching id and refuses every other; `pooledResolver(lookup)` returns the named id verbatim for `from: 'api'` | `harness/host/src/domain/tenancy/resolver.ts` |
| `HostPool` carries `dedicatedClient: string \| null` | `HostPool extends HostDeps`, and `HostDeps` declares it | `harness/host/src/domain/tenancy/types.ts` |
| `pool.tenantFor(clientId)` re-checks the resolver itself and answers `null` for a client this host may not serve | `if (resolver.resolve({ from: 'api', clientId }) !== clientId) return null;` | `harness/host/src/domain/tenancy/pool.ts` |
| `attachMessageHandlers` is the existing audited refusal, and its shape is what an HTTP refusal copies | `writeAudit(db, { client, caller: \`${surface}:${userId}\`, tool: 'host_message', actionClass: 'read', argsHash: hashArgs({ conversation, tenantHint }), decision: 'unauthorised' })` | `harness/host/src/domain/conversation.ts` |
| `Decision` is a **TypeScript union only** | `'auto' \| 'approval' \| 'blocked' \| 'error' \| 'unauthorised'`; `audit_log.decision` is `text('decision').notNull()` with no enum and no check constraint, and nothing switches exhaustively over the union | `harness/core-tools/src/domain/tooling/audit.ts`, `harness/db/src/domain/schema.ts` |
| `poolFixture(db, opts)` builds a real pool over `MemoryConfigSource`, one `MemorySurface` and one `ScriptedRuntime` per tenant, and `f.surface(clientId)` hands back that tenant's `MemorySurface` | `harness/host/src/testing.ts` |
| `fixtureDocument(overrides)` declares `surfaces: { memory: {}, http: {} }`, `runtime: 'scripted'`, four principals and the healthcare pack | overrides are shallow: pass a whole section | `harness/config-api/src/testing.ts` |
| `surfaceSecretsOf(document)` returns `{ surface, env }` pairs, `signingSecret` **first**, then `botToken` | asserted whole in `document.test.ts` | `harness/config-api/src/document.ts` |
| `buildTenant` calls `loadSurfaces` with the tenant keys, then collects `directories`, then identity, then the runtime | and pushes every session onto the unwind list as it is built | `harness/host/src/domain/tenancy/tenant.ts` |

### Compose, CI and the image

| Fact | Value | Where |
|---|---|---|
| Five services, three of them built from the checkout | `postgres` (pulled), `litellm` (pulled), `files` (builds `files.Dockerfile`, `image: harness-files`, profile `demo`), `core-tools` (builds `core-tools.Dockerfile`, **no `image:` key**, profile `build-only`), `host` (builds `node.Dockerfile`, `image: harness-host`, profile `demo`) | `harness/compose/docker-compose.yml` |
| The `core-tools` service's only purpose is the build | "Built, not started: core-tools is hosted in-process inside `host`… `docker compose build core-tools` proves the image still builds" | same, comment above the service |
| `node.Dockerfile` is a single stage that installs the whole workspace and runs TypeScript through `tsx` | `CMD ["pnpm", "--filter", "@harness/host", "start"]`; no build step, no `dist`, no `pnpm deploy`, and no image name in the file | `harness/compose/node.Dockerfile` |
| `readComposeSurface` shells out to `docker compose … --profile demo --profile build-only config --no-interpolate --no-path-resolution` | both flags load-bearing; `--no-interpolate` is why `${VAR}` survives into the snapshot | `harness/core-tools/src/app/record-surface.ts` |
| `surface.test.ts` pins the service list and two Slack variables | `Object.keys(services).sort()` equals `['core-tools','files','host','litellm','postgres']`; `services.host.image` is `'harness-host'`; `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` must both be **defined** | `harness/core-tools/src/app/surface.test.ts` |
| `.github/workflows/ci.yml` is the **only** workflow; it triggers on `pull_request` and `push: branches: [main]` and has **no tag trigger** | its `images` job runs one command: `docker compose --env-file .env.ci … --profile demo --profile build-only build`, with no login, no tag and no push | that file |
| `.env.ci` is three variables | `HARNESS_CLIENT=fixture`, `HARNESS_ENCRYPTION_KEY=…`, `LITELLM_MASTER_KEY=sk-ci-placeholder` | `.env.ci` |
| `pnpm demo:up` passes `--build` | `docker compose --env-file .env … --profile demo up -d --build` | root `package.json` |

### Publishing, verified by running it

| Fact | Value | Where |
|---|---|---|
| **All 25 workspace packages are `private: true` at `0.1.0`**, every `exports` entry points at a `.ts` source file, and not one declares `publishConfig`, `files`, `main`, `types` or a `build` script | | every `package.json` |
| The root manifest has **no `version` field**, and there is no `.npmrc`, no changesets, no semantic-release and no version tooling of any kind | | root `package.json`, `ls` |
| `tsconfig.base.json` sets `noEmit: true`; every package `tsconfig.json` is `{ "extends": "../../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }` | `target ES2022`, `module ESNext`, `moduleResolution bundler`, `strict`, `esModuleInterop`, `skipLibCheck`, `forceConsistentCasingInFileNames`, `resolveJsonModule`, `types: ["node"]` | those files |
| **`tsc` 7.0.2 emits ESM and declarations from this configuration.** `pnpm exec tsc -p tsconfig.json --noEmit false --declaration --outDir <tmp>` from `harness/shared` produced `.js` and `.d.ts` for every module, with the source's `./errors.js` specifiers preserved | so a build config needs only `noEmit: false`, `declaration: true`, `outDir`, `rootDir` and its own `include`/`exclude` | run 2026-09-21 |
| **A build config must set `rootDir: "src"` and its own `include`**, or the output nests under `dist/src/` and the tests are emitted beside it | adding `--rootDir src` to the package's own `tsconfig.json` fails `TS6059: File 'vitest.config.ts' is not under 'rootDir'`, because that file is in the package `include` | run 2026-09-21 |
| **pnpm applies `publishConfig` at pack time.** A scratch package with `exports` pointing at `./src/*.ts` and `publishConfig.exports` pointing at `./dist/*.js` packed with `pnpm pack --pack-destination out`: the tarball's `package.json` carries the `dist` exports, `publishConfig` itself is gone, and `files: ["dist","README.md"]` limited the tarball to `package/dist/index.js`, `package/dist/index.d.ts`, `package/README.md`, `package/package.json` | this is the mechanism Tasks 6 and 7 depend on | scratch package under the scratchpad, pnpm 11.4.0, 2026-09-21 |
| **pnpm rewrites `workspace:*` at pack time.** `pnpm pack` on `harness/surface-api` produced a manifest with `"@harness/shared": "0.1.0"` | so every published package must carry the **same** version, which is what the `release:version` script is for | run 2026-09-21 |
| Without a `files` field the tarball carries `src/`, the tests and `vitest.config.ts` | the same `pnpm pack` run listed them | same run |
| The tarball name is `<scope-without-@>-<name>-<version>.tgz` | `@harness/surface-api` → `harness-surface-api-0.1.0.tgz` | same run |
| `pnpm --filter <name> exec pnpm pack --pack-destination <dir>` packs that one package into that directory | verified on `@harness/pack-api` | run 2026-09-21 |
| **`dist/` is already ignored**, at the root `.gitignore`'s "node" section, beside `node_modules/` | so no task adds it | `.gitignore` |
| `no-orphans` matches a module with **no incoming and no outgoing** dependencies | a new package whose `index.ts` re-exports `./types.js` and whose `testing.ts` imports both is never an orphan, even though nothing outside the package imports it | `.dependency-cruiser.cjs`, dependency-cruiser 16.10.4 |
| Adding a package is two lines | one `PACKAGES` row for the layer rules, one `WORKSPACE_DIRS` entry for the cross-package rule, which reads the manifest's `exports` map **from disk** | `.dependency-cruiser.cjs`, "HOW A NEW PACKAGE IS ADDED" |
| There is **no `@harness/sandbox-api`**, no `execute` action class and no sandbox anything | `ACTION_CLASSES` is the eight strings at `harness/pack-api/src/policy.ts`; `sandbox_seconds` exists only as a literal-zero column on `usage_runs` | those files |
| No document anywhere mentions a tunnel, ngrok, a registry, `publishConfig`, `docker push` or a release of software | every "release" hit in the docs is the approvals *file release* flow | `grep` over `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/`, every package README |

### Why no new dependency

| Candidate | Why not |
|---|---|
| `@slack/events-api`, `@slack/interactive-messages` | Both are deprecated by Slack in favour of doing exactly what `transport/events.ts` does: verify an HMAC and read a JSON body. The whole of the verification is fifteen lines of `node:crypto`, and a library here would own the one security-relevant path in this plan. |
| An HTTP framework (express, fastify, hono) for the surface mount | The host already runs a `node:http` server with a route table, a body reader with a cap and a bearer check. The mount is one more branch in `handleApiRequest` and one dispatch function. |
| `body-parser` / `qs` for the interactive payload | `application/x-www-form-urlencoded` with one field is `new URLSearchParams(body).get('payload')`, which is in the platform. |
| `changesets`, `semantic-release`, `release-please` | The version is one number across every package, bumped by one `npm version` invocation per package and tagged by a person. A release tool would add a second place versions live and a changelog format nobody asked for. |
| `docker/login-action`, `docker/build-push-action`, `softprops/action-gh-release` | The runner ships `docker` and `gh`. Three fewer third-party actions in a workflow that holds a registry token is worth four lines of shell, and it keeps `release.yml` to the same three actions `ci.yml` already trusts. |
| `tsup`, `unbuild`, `rollup` for the build step | `tsc` already runs in every package for `typecheck` and already emits what a consumer needs: ESM with the source's own `.js` specifiers, plus declarations. Verified above. |

---

## Decisions where the spec leaves a detail open

The first ten are the controller's, recorded with the reasons a reviewer can check. Eleven to fifteen are the places where following one of them exactly required a second choice this plan had to make.

1. **One HTTP mount rule.** `SurfaceSession` gains an optional `http: { path: string; handle(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> }` in `@harness/surface-api`, and the host mounts every tenant's handler at **`/tenants/<clientId>/<path>`** — the surface's `path` carries no leading slash, e.g. `slack/events` — on a dedicated host and a pooled one alike. One rule, no dual path: spec decision 4 lets the host resolve the tenant from "a Slack team id, an HTTP header or a path", and a path is the only one of the three that works before an ingress exists to add a header. A dedicated host refuses any other client id on the path and audits the refusal (invariant 19); the existing `tenantHint` check on the normalised message stays as the second guard, so a workspace that is not this tenant's is still refused after the request has been verified. The host never names a vendor: the path and the refusal reason are data the surface supplies.

2. **One host HTTP server.** The run API's listener — today started only when `HARNESS_HOST_TOKEN` is non-empty, with the bearer checked before any route matches — becomes the host's HTTP server and always starts. The bearer check becomes route-aware: `/v1/*` requires the bearer and answers 401 when `HARNESS_HOST_TOKEN` is empty, `/tenants/*` skips the bearer and is protected by the surface's own verification. `/healthz` stays exactly where it is, on its own port, because a container health check reads it and the runbook documents it. Nothing else changes about ports: the host still listens on `HARNESS_HOST_PORT` (8788), still binds `HARNESS_HOST_BIND`, and Compose still publishes both on loopback.

3. **Refusals are audited once by the host (invariant 15).** `SurfaceHttpResponse = { status: number; headers?: Record<string, string>; body?: string; refusal?: { reason: string } }`. When `refusal` is set the host writes exactly one `audit_log` row — `tool: 'surface_request'`, `decision: 'refused'`, the reason in `error`, the client id in `client`, and a hash of the method and the mount path in `args_hash` — and then sends the response. Nothing of the body is hashed, logged or stored: a request with a bad signature is refused *before* it is parsed, so there is nothing trustworthy in it to record. The surface never touches audit, because a surface imports only `@harness/surface-api`, `@harness/shared` and itself.

4. **Acknowledge, then run.** The Slack handler verifies the signature — HMAC-SHA256 over `v0:<timestamp>:<raw body>` with the tenant's signing secret, compared with `timingSafeEqual`, timestamp within 300 seconds, refusal reasons `missing_signature`, `bad_signature` and `stale_timestamp` — answers a `url_verification` with its challenge, and otherwise returns 200 immediately and hands the classified inbound to the existing pipeline asynchronously. The turn never blocks the acknowledgement, because Slack retries anything it has not heard about in three seconds and a turn takes seconds to minutes. A request carrying `X-Slack-Retry-Num` is answered 200 with `X-Slack-No-Retry: 1` and dropped with one log line: **no dedupe table**, because the only duplicate this can produce is one Slack itself caused, and a table of event ids is a second database write on the hot path plus a sweep nobody has asked for.

5. **One URL for events and interactivity.** The same handler accepts `application/json` event callbacks and `application/x-www-form-urlencoded` interactive payloads (a `payload=` field holding JSON: `block_actions` and `view_submission`), and routes the latter through the existing `SlackEvents` seam, so `registerApprovalHandlers` is untouched and the fake transport still drives every approval test. `SlackApi` gains `auth.test()`, called once at `start()`, so `classifyInbound`'s bot comparison keeps working without Bolt's context. `WebClient` is constructed directly from `@slack/web-api` — a runtime dependency now, at the resolution already in the lockfile. `@slack/bolt` is removed with `transport/bolt.ts`; `SLACK_APP_TOKEN` is deleted everywhere; `Surface.secrets` becomes `['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']`.

6. **Packages publish as release tarballs, the image to GHCR.** GitHub Packages requires an npm scope equal to the repository owner, so `@harness/*` cannot be published there without renaming every package and every import — and that rename waits for the organisation that will own the scope. So `release.yml`, triggered by `push: tags: ['v*']`, runs the gates, builds the two images with `docker build` and pushes `ghcr.io/mgavrila/agent-harness-host:<version>` and `ghcr.io/mgavrila/agent-harness-files:<version>` (logging in with `GITHUB_TOKEN` under `packages: write`), runs `pnpm pack` for every published package into `release/`, and creates the GitHub Release with the tarballs, `docs/architecture/tool-surface.json` and `docs/architecture/compose-surface.yaml` attached and the matching `CHANGELOG.md` section as its body. A consumer pins `https://github.com/mgavrila/agent-harness/releases/download/v<version>/<tarball>`. Switching to a registry later is one step in that workflow and no change anywhere else.

7. **The published set is the contracts and the kits the platform consumes.** `@harness/shared`, `@harness/pack-api`, `@harness/config-api`, `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api` and `@harness/sandbox-api`, each with its `./testing` subpath where it has one — `shared` and `pack-api` have none. Each gets `private: false`, a `build` script emitting ESM and declarations into `dist/` from its own `tsconfig.build.json`, `files: ["dist", "README.md"]`, and a `publishConfig.exports` pointing at `dist/`. The source `exports` keep pointing at `.ts`, so the workspace still runs from source and no import anywhere changes. Every workspace package moves to one version through a root `release:version` script; this plan bumps nothing, because the tag is the user's.

8. **Compose pulls.** Every `build:` block is removed, the two built images become `ghcr.io/mgavrila/agent-harness-{host,files}:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG in .env}`, the `core-tools` build-only service and the `build-only` profile go with `core-tools.Dockerfile`, and `ci.yml`'s `images` job builds both images with `docker build` directly and pushes nothing. `HARNESS_IMAGE_TAG` is documented in `.env.example`, and `.env.ci` is deleted with the Compose build command that was its only reader. The compose snapshot is re-recorded in exactly one task, the one that edits Compose, which also deletes `SLACK_APP_TOKEN` from the file and flips the assertion in `surface.test.ts` that requires it.

9. **`@harness/sandbox-api` is reserved, and nothing imports it.** A leaf package exporting `SandboxProvider`, `Sandbox`, `SandboxSession` and `ExecResult`, plus `@harness/sandbox-api/testing` with an in-memory provider and a conformance suite. No `execute` action class — that is Plan 12 — and no host wiring. One `PACKAGES` row and one `WORKSPACE_DIRS` entry, and nothing in the workspace may import it except its own tests.

10. **Vocabulary and leftovers.** `MESSAGING_FORBIDDEN` gains `socket ?mode` in both copies, the allowlist stays empty; the stale `coreToolsChildEnv` sentence in `harness/shared/src/env.ts` goes; `LoadedSurfaces.secrets` — built, and read by no shipping code — is deleted with its tests adjusted. The documentation gains "Slack over HTTPS", "Local development with a tunnel", "Releasing" and `HARNESS_IMAGE_TAG`, and `CHANGELOG.md` is created with a `0.2.0` section written for the platform team.

11. **The memory surface's HTTP door is off until something mounts it.** The host's dispatch has to be proved against a surface the pool really loaded, and the only surfaces a client document may declare are `slack`, `memory` and `http` (`SURFACE_ORDER`); Slack cannot be used, because `start()` now calls `auth.test` against Slack, and `surfaces/http` opens nothing by design. So `MemorySurface` implements the seam — it is the reference adapter, and the reference implementation of a seam belongs beside the rest of the contract's reference implementation. But it is **off by default**, behind `mountHttp(path = 'messages')`: the memory surface accepts any user id with no authentication at all, which is what it is for, and an unauthenticated message injector is not something a developer's host should grow a door to by accident. `surfaces/memory` never calls it, so no deployment is affected; a host test calls it on the session the pool already opened, which is why the seam is on the session rather than on `Surface`.

12. **A surface reads the environment variable its tenant's document names.** Spec §4.6 says the surface's secrets become `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, and §4.1's document declares both as `SecretRef`s — but nothing hands the adapter the names, so today it would read the two conventional names and ignore the document. The smallest change that fixes that: `surfaceSecretsOf` gains a `field` beside its `surface` and `env`, `loadSurfaces`'s third parameter becomes a per-surface `SurfaceSettings { tenantKey?, secrets? }` instead of a bare key map, and `SurfaceDeps` gains `secrets?: Readonly<Record<string, string>>` — the document's own field name to the environment variable it names. The adapter looks a name up and falls back to the conventional one, which is a default rather than a compatibility path: a single-tenant deployment names the conventional variables and a two-tenant one names two pairs. The host still reads no vendor field: it copies opaque `field` strings out of `surfaceSecretsOf` into a record.

13. **`Decision` gains `'refused'`, and that is the whole database change.** The audited refusal of invariant 15 is not `unauthorised` — nobody was identified, so nobody was refused authorisation — and `audit_log.decision` is a plain text column with no constraint. Widening the union in `@harness/core-tools` by one member is a type change with no migration, and it is what lets a reader of the audit log tell "this deployment refused an unsigned request at the door" from "this deployment refused a person it did not recognise".

14. **The listener keeps the names `startRunApi`, `RunApiOptions` and `RunApiServer`.** It now serves two things, and renaming five exported symbols across `main.ts`, `index.ts` and two test files would be a diff with no behaviour in it. The doc comments say what it serves; `RunApiOptions.token` gains the sentence that an empty token closes `/v1/*` rather than closing the listener.

15. **`json` and `readBody` move to a leaf `domain/api/http.ts`.** `routes.ts` has to call the surface dispatch and the surface dispatch has to read a body, and `no-circular` is an error. The two helpers move to a module that imports nothing of the host's, both callers import them from there, and `routes.test.ts`'s one import line follows. Nothing else about either function changes.

---

## Not in this plan

Listed so a reviewer can see they were considered and left out on purpose.

- **The 11a follow-ups**, every one of them: the per-tenant storage sub-root; the pool's `closing` promise; the slack-groups map's eviction, its audit row and its in-flight memo; the postgres source's version-history conflict; the scaffolder polish; `gateway.test.ts`'s isolation. None is a transport or a publishing question, and folding them in would make this plan's pull request unreviewable.
- **A Teams surface and an Entra identity provider.** Spec decision 9 says Teams is webhook-only and takes the same shape as this plan's Slack work — which is the point of putting the seam in the contract rather than in the adapter — but it has its own spec and waits for Weave's calendar.
- **Everything in Plan 12:** typed model access behind the gateway seam, `correlation` on runs, the event feed, declared MCP and A2A plug-ins, and the `execute` action class. `@harness/sandbox-api` is reserved here **without** the action class precisely because the class is Plan 12's, and adding it now would move the tool surface.
- **A sandbox implementation.** Spec decision 14 reserves the interface and says so in as many words: "No implementation in Plans 11–12."
- **An ingress, a pooled deployment, or TLS.** The host answers HTTP on a loopback-published port; what terminates TLS in front of it is the platform's (P2) or a tunnel on a developer's machine, and the runbook documents the tunnel.
- **An event-id dedupe table**, for the reason in decision 4.
- **Publishing to an npm registry**, for the reason in decision 6.

---

## File structure

Paths are relative to the repository root.

### The HTTP seam in the surface contract (Task 1)

| File | Responsibility |
|---|---|
| `harness/surface-api/src/types.ts` | `SurfaceHttpRequest`, `SurfaceHttpResponse`, `SurfaceHttp`, `SurfaceSession.http?` |
| `harness/surface-api/src/models.ts` | `SURFACE_HTTP_PATH_PATTERN`, `SURFACE_REFUSAL_REASON_PATTERN` |
| `harness/surface-api/src/index.ts` | the new exports |
| `harness/surface-api/src/testing.ts` | `MemorySurface.mountHttp`, `MemorySurface.requests`, `MemorySurface.settled`, the door's handler |
| `surfaces/memory/src/index.test.ts` | one case pinning that the shipped wrapper mounts no door |
| `harness/surface-api/src/http.test.ts` (**new**) | the patterns and the memory door |
| `harness/surface-api/README.md` | the seam |

### The host mounts a surface's handler (Task 2)

`harness/host/src/domain/api/http.ts` (**new**: `json`, `readBody`, moved), `domain/api/surfaces.ts` (**new**) + `surfaces.test.ts` (**new**), `domain/api/routes.ts`, `domain/api/routes.test.ts`, `domain/api/server.ts`, `domain/api/types.ts`, `domain/tenancy/tenant.ts`, `src/app/main.ts`, `src/index.ts`; `harness/core-tools/src/domain/tooling/audit.ts`.

### Slack over HTTPS (Task 3)

`surfaces/slack/src/transport/signature.ts` (**new**) + `signature.test.ts` (**new**), `transport/classify.ts` (**new**, moved) + `classify.test.ts` (**new**, moved), `transport/events.ts` (**new**, taking its `SlackApi` as a defaulted fourth parameter so a test can pass `FakeSlack`) + `events.test.ts` (**new**), `transport/bolt.ts` (**deleted**), `transport/bolt.test.ts` (**deleted**), `transport/types.ts`, `transport/web-client.ts`, `transport/fake.ts`, `src/config.ts`, `src/session.ts`, `src/index.ts`, `src/index.test.ts`, `src/testing.ts`, `package.json`; `harness/surface-api/src/types.ts` (`SurfaceDeps.secrets`); `harness/config-api/src/document.ts` + `document.test.ts`; `harness/approvals/src/domain/surfaces/registry.ts` + `registry.test.ts`; `harness/host/src/domain/tenancy/tenant.ts`; `pnpm-lock.yaml`.

### Compose pulls (Task 4)

`harness/compose/docker-compose.yml`, `harness/compose/core-tools.Dockerfile` (**deleted**), `.env.ci` (**deleted**), `.gitignore`, `harness/core-tools/src/app/record-surface.ts`, `harness/core-tools/src/app/surface.test.ts`, `docs/architecture/compose-surface.yaml` (re-recorded), `.env.example`, `.github/workflows/ci.yml`, root `package.json`.

### The reserved sandbox seam (Task 5)

`harness/sandbox-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/types.ts`, `src/index.ts`, `src/testing.ts`, `src/memory.test.ts`; `.dependency-cruiser.cjs`.

### Publishable packages (Task 6)

`harness/{shared,pack-api,config-api,surface-api,identity-api,runtime-api,sandbox-api}/package.json` and `tsconfig.build.json` (**new**, seven of them); root `package.json`; `scripts/src/domain/packaging.test.ts` (**new**).

### The release workflow (Task 7)

`.github/workflows/release.yml` (**new**), `CHANGELOG.md` (**new**), `scripts/src/domain/changelog.ts` (**new**) + `changelog.test.ts` (**new**), `scripts/src/domain/release-workflow.test.ts` (**new**), `scripts/src/app/changelog-cli.ts` (**new**), root `package.json`.

### Vocabulary and leftovers (Task 8)

`harness/core-tools/src/kernel-vocabulary.test.ts`, `harness/approvals/src/host-vocabulary.test.ts`, `harness/shared/src/env.ts`, `harness/approvals/src/domain/surfaces/registry.ts` + `registry.test.ts`, `harness/approvals/src/domain/surfaces/dual-surface.test.ts`, `.env.example`.

### Documentation (Task 9)

`README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/runbook.md`, `docs/demo.md`, `docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md`, `surfaces/slack/README.md`, `surfaces/memory/README.md`, `harness/surface-api/README.md`, `harness/host/README.md`, `harness/sandbox-api/README.md`, `docs/architecture/graph.svg`.

## Task order

Strictly sequential.

- **Task 1** (the `http` seam in `@harness/surface-api`) first: Tasks 2 and 3 both implement it.
- **Task 2** (the host mounts, route-aware bearer, invariants 15 and 19) before Task 3, so the Slack handler is written against a mount that already works and is already proved.
- **Task 3** (the Slack events transport, Bolt deleted) before Task 4, which deletes the variable whose last reader Task 3 removes.
- **Task 4** (Compose pulls, `HARNESS_IMAGE_TAG`, the CI image job, the **one** compose re-record) before Task 7, which pushes the images Compose now pulls.
- **Task 5** (`@harness/sandbox-api`) before Task 6, which makes it publishable with the other six.
- **Task 6** (build step, `publishConfig`, `files`, `private: false`, `release:version`, the packing test) before Task 7, which packs what it declares.
- **Task 7** (`release.yml`, `CHANGELOG.md`, the workflow's own tests).
- **Task 8** (vocabulary widening, the stale comment, `LoadedSurfaces.secrets`) after Task 3, which is what makes `socket mode` a word no source may contain.
- **Task 9** (documentation) last. No code.

Every task leaves `docs/architecture/tool-surface.json` byte-identical. **Only Task 4 touches `docs/architecture/compose-surface.yaml`**, and it re-records it with `pnpm surface:record`; every other task leaves it byte-identical, and `git status --short docs/architecture` is the check.

---

## Tasks

### Task 1: The `http` seam — a surface can be reached by a request, and the memory surface is its reference implementation

**Files:**
- Modify: `harness/surface-api/src/types.ts` (`SurfaceHttpRequest`, `SurfaceHttpResponse`, `SurfaceHttp`, `SurfaceSession.http?`)
- Modify: `harness/surface-api/src/models.ts` (`SURFACE_HTTP_PATH_PATTERN`, `SURFACE_REFUSAL_REASON_PATTERN`)
- Modify: `harness/surface-api/src/index.ts` (exports)
- Modify: `harness/surface-api/src/testing.ts` (`MemorySurface.mountHttp`, `requests`, `settled`, the handler)
- Create: `harness/surface-api/src/http.test.ts`
- Modify: `surfaces/memory/src/index.test.ts` (one case pinning that the shipped wrapper mounts no door)
- Modify: `harness/surface-api/README.md`
- Delete: nothing.

**Interfaces:**
- Produces:
  - `interface SurfaceHttpRequest { method: string; path: string; headers: Readonly<Record<string, string>>; body: string }`
  - `interface SurfaceHttpResponse { status: number; headers?: Readonly<Record<string, string>>; body?: string; refusal?: { reason: string } }`
  - `interface SurfaceHttp { readonly path: string; handle(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> }`
  - `SurfaceSession.http?: SurfaceHttp`
  - `SURFACE_HTTP_PATH_PATTERN`, `SURFACE_REFUSAL_REASON_PATTERN`
  - `MemorySurface.mountHttp(path?: string): void`, `MemorySurface.requests: SurfaceHttpRequest[]`, `MemorySurface.settled(): Promise<void>`
- Consumes: nothing new.

**`LoadedSurfaces.secrets` is not touched here.** It lives in `@harness/approvals`, not in this contract, and nothing this task writes reads it; its deletion is Task 8. This is said because the brief asked for the removal to be "prepared where the contract is touched", and the contract turns out not to touch it at all.

- [ ] **Step 1: Write the failing test**

Create `harness/surface-api/src/http.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SURFACE_HTTP_PATH_PATTERN, SURFACE_REFUSAL_REASON_PATTERN } from './models.js';
import { MemorySurface } from './testing.js';
import type { MessageEvent, SurfaceHttpRequest } from './types.js';

const post = (body: string, over: Partial<SurfaceHttpRequest> = {}): SurfaceHttpRequest => ({
  method: 'POST',
  path: '',
  headers: { 'content-type': 'application/json' },
  body,
  ...over,
});

describe('the mount path pattern', () => {
  it('accepts the shapes a surface asks to be mounted at', () => {
    for (const path of ['messages', 'slack/events', 'a/b/c', 'x-1_2']) {
      expect(SURFACE_HTTP_PATH_PATTERN.test(path), path).toBe(true);
    }
  });

  it('refuses anything that would escape its mount, change case or be empty', () => {
    // A leading slash would make the host's join ambiguous; `..` would climb out of the tenant's
    // prefix; an upper-case letter is a second spelling of one mount; empty is not a path.
    for (const path of ['', '/messages', 'messages/', 'slack/../v1/runs', 'Slack/events', 'a//b', 'a b']) {
      expect(SURFACE_HTTP_PATH_PATTERN.test(path), path).toBe(false);
    }
  });
});

describe('the refusal reason pattern', () => {
  it('accepts a short token and refuses a sentence', () => {
    for (const reason of ['bad_signature', 'stale_timestamp', 'x']) {
      expect(SURFACE_REFUSAL_REASON_PATTERN.test(reason), reason).toBe(true);
    }
    // It goes into an audit row, so it is a token an operator can group by, never free text that
    // could carry a fragment of what was refused.
    for (const reason of ['Bad signature', 'bad signature', '', 'bad-signature', 'a'.repeat(65)]) {
      expect(SURFACE_REFUSAL_REASON_PATTERN.test(reason), reason).toBe(false);
    }
  });
});

describe('the memory surface as an HTTP door', () => {
  it('offers no door until one is mounted', () => {
    expect(new MemorySurface().http).toBeUndefined();
  });

  it('mounts at "messages" by default, and where it is told otherwise', () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    expect(surface.http?.path).toBe('messages');
    surface.mountHttp('inbound/messages');
    expect(surface.http?.path).toBe('inbound/messages');
  });

  it('delivers a posted message to the registered handler and records the request', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const seen: MessageEvent[] = [];
    surface.onMessage(async (event) => {
      seen.push(event);
    });
    const response = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hello' })));
    expect(response).toEqual({ status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' });
    // Acknowledged first, delivered after: the same shape a real transport needs, so a test of
    // the host's mount waits for the turn rather than for the response.
    await surface.settled();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ surface: 'memory', userId: 'U012', text: 'hello', mentioned: true });
    expect(surface.requests).toHaveLength(1);
    expect(surface.requests[0].body).toBe(JSON.stringify({ userId: 'U012', text: 'hello' }));
  });

  it('refuses a method it does not serve, and says so as a reason rather than a sentence', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post('', { method: 'GET' }));
    expect(response.status).toBe(405);
    expect(response.refusal).toEqual({ reason: 'method_not_allowed' });
  });

  it('refuses a body that is not a message, without repeating it', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    for (const body of ['', 'not json', '{}', '{"userId":"U012"}', '{"text":"hello"}']) {
      const response = await surface.http!.handle(post(body));
      expect(response.status, body).toBe(400);
      expect(response.refusal, body).toEqual({ reason: 'bad_request' });
      expect(response.body ?? '', body).not.toContain('U012');
    }
  });

  it('does not deliver a message when nothing is listening, and does not throw at the caller', async () => {
    const surface = new MemorySurface();
    surface.mountHttp();
    const response = await surface.http!.handle(post(JSON.stringify({ userId: 'U012', text: 'hello' })));
    expect(response.status).toBe(200);
    // The door acknowledged; the delivery had nowhere to go. A surface that threw here would
    // turn a race at startup into a 500 the sender retries.
    await expect(surface.settled()).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-api exec vitest run src/http.test.ts`
Expected: FAIL — `SURFACE_HTTP_PATH_PATTERN` is not exported from `./models.js`, and `MemorySurface` has no `mountHttp`.

- [ ] **Step 3: Declare the three types**

In `harness/surface-api/src/types.ts`, add after `UploadRequest` and before `SurfaceSession`:

```ts
/**
 * One inbound request, as a surface's own transport understands it.
 *
 * `body` is the bytes exactly as they arrived, decoded as UTF-8 and not parsed: a signature is
 * computed over them, and a handler that was given a parsed object could not check one. **The
 * seam is text, not bytes**, which is lossless for the UTF-8 every transport in question sends
 * and is worth knowing for the one that does not: an invalid byte sequence decodes to U+FFFD, so
 * its signature is computed over something other than what arrived and the request is refused as
 * badly signed rather than as malformed. A transport that must sign arbitrary bytes needs this
 * field widened, and that is a contract change rather than a workaround. `path` is what is left
 * of the URL below this surface's mount — empty for the mount itself — so an adapter never sees,
 * and never has to agree with, the tenant prefix the host put in front of it.
 * `headers` are lower-cased, and a header sent twice is the first value: a transport that signs
 * its requests does not send its signature twice, and a handler that had to decide which of two
 * values was real would be the wrong place to decide it.
 */
export interface SurfaceHttpRequest {
  method: string;
  path: string;
  headers: Readonly<Record<string, string>>;
  body: string;
}

/**
 * What the host sends back, and whether it was a refusal.
 *
 * `refusal` is the one field the host reads for itself: when it is set, exactly one `audit_log`
 * row is written before the response goes out (invariant 15), and `reason` is a short token — see
 * `SURFACE_REFUSAL_REASON_PATTERN` — because it lands in a column an operator groups by. Nothing
 * of the request body reaches that row: a refused request has not been authenticated, so there is
 * nothing in it worth recording. A surface never writes audit itself; it may import only this
 * contract, `@harness/shared` and its own modules.
 */
export interface SurfaceHttpResponse {
  status: number;
  headers?: Readonly<Record<string, string>>;
  body?: string;
  refusal?: { reason: string };
}

/**
 * A surface that can be reached by a request rather than by a socket it opened itself.
 *
 * The host mounts this at `/tenants/<clientId>/<path>` on its own HTTP server, one rule for a
 * dedicated deployment and a pooled one alike, and resolves the tenant from the path before it
 * calls `handle`. `path` carries no leading slash and is matched whole or as a prefix of one:
 * `slack/events` answers `/tenants/acme/slack/events` with `path: ''` and
 * `/tenants/acme/slack/events/extra` with `path: 'extra'`.
 *
 * Whatever authenticates the request is this surface's business and nobody else's — a signature
 * over the raw body, a shared token, an upstream header — because it is the transport's own
 * scheme, and the host would have to name a vendor to know about it.
 */
export interface SurfaceHttp {
  readonly path: string;
  handle(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse>;
}
```

and add one member to `SurfaceSession`, immediately after `directory?`:

```ts
  /**
   * Where this surface is reached by a request, when it is reached that way at all.
   *
   * Optional, and absent for a surface that opens its own connection or has no transport: a host
   * mounts what it is offered and nothing else. Spec section 4.6 — this is what lets the Slack
   * adapter hold the Events API without the host holding a Slack-shaped route.
   */
  readonly http?: SurfaceHttp;
```

- [ ] **Step 4: Declare the two patterns**

In `harness/surface-api/src/models.ts`, add at the end of the file, after the two payload type aliases:

```ts
/**
 * A surface's mount path, below the tenant prefix the host puts in front of it.
 *
 * Lowercase, slash-separated, no leading and no trailing slash, and every segment starts with a
 * letter or a digit — so `..` cannot appear and a mount cannot climb out of its tenant's prefix
 * into `/v1/runs`. One spelling per mount, because two surfaces of one tenant claiming the same
 * path is a startup failure and a case-insensitive match would make it a silent one.
 */
export const SURFACE_HTTP_PATH_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

/**
 * A refusal reason: a short lowercase token, at most 64 characters.
 *
 * It is written into `audit_log.error`, which is plaintext an operator reads and groups by, so it
 * names the *kind* of refusal — `bad_signature`, `stale_timestamp` — and can never be a sentence
 * assembled from what was refused. The host replaces anything that does not match with
 * `unspecified` rather than refusing to answer, because a badly declared reason is the surface's
 * bug and dropping the request would hide it behind a second failure.
 */
export const SURFACE_REFUSAL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
```

- [ ] **Step 5: Export them**

In `harness/surface-api/src/index.ts`, extend the models export block:

```ts
export {
  CONVERSATION_ID_PATTERN,
  SURFACE_HTTP_PATH_PATTERN,
  SURFACE_NAME_PATTERN,
  SURFACE_REFUSAL_REASON_PATTERN,
  SurfaceFilePayloadShape,
  SurfaceMessagePayloadShape,
  type SurfaceFilePayload,
  type SurfaceMessagePayload,
} from './models.js';
```

and add `SurfaceHttp`, `SurfaceHttpRequest` and `SurfaceHttpResponse` to the `export type { … } from './types.js'` list, keeping it alphabetical: they go between `Surface` and `SurfaceCapabilities`.

- [ ] **Step 6: Give `MemorySurface` a door**

In `harness/surface-api/src/testing.ts`, add `SurfaceHttp`, `SurfaceHttpRequest` and `SurfaceHttpResponse` to the `import type { … } from './types.js'` list.

Add two fields beside the other recording arrays, after `streams`:

```ts
  /** Every request this surface's door received, in order. Empty until something mounts one. */
  readonly requests: SurfaceHttpRequest[] = [];
  /**
   * Not `readonly`, unlike the contract's own declaration: the door is mounted by a caller rather
   * than by the constructor (see `mountHttp`), and an implementation may widen a property the
   * interface declares `readonly`.
   */
  http?: SurfaceHttp;
```

and one private field beside `seq`:

```ts
  /** The deliveries this door has acknowledged and not yet finished, so a test can await them. */
  private readonly delivering: Promise<void>[] = [];
```

Then add these three members after `say`:

```ts
  /**
   * Mount this surface's inbound door at `path`.
   *
   * **Off until it is called**, and `@harness/surface-memory` never calls it. This surface accepts
   * any user id with no authentication at all — that is what it is for — so a door to it is a way
   * to speak as anybody, and a developer's host should not grow one merely because its document
   * declared the memory surface. A host test mounts it on the session the pool opened: it is the
   * reference implementation of the `http` seam and the thing the host's dispatch is proved
   * against.
   */
  mountHttp(path = 'messages'): void {
    this.http = { path, handle: (request) => this.handleHttp(request) };
  }

  /**
   * Wait for every delivery this door has acknowledged.
   *
   * The door answers before the message is delivered, exactly as a real transport must, so a test
   * that asserted straight after the response would race the handler it is testing.
   */
  async settled(): Promise<void> {
    await Promise.all(this.delivering);
  }

  private async handleHttp(request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> {
    this.requests.push(request);
    if (request.method !== 'POST') return { status: 405, refusal: { reason: 'method_not_allowed' } };
    const message = parseMemoryMessage(request.body);
    // The refusal names the kind and nothing else: the body is not repeated, not summarised and
    // not logged, because a refused request is one nobody has authenticated.
    if (!message) return { status: 400, refusal: { reason: 'bad_request' } };
    // Acknowledge, then run. `say` rejects when no handler is registered, which is a race at
    // startup rather than a fault in the request, so it is swallowed here and the sender is told
    // the door took the message.
    this.delivering.push(this.say(message.userId, message.text).catch(() => undefined));
    return { status: 200, headers: { 'content-type': 'application/json' }, body: '{"ok":true}' };
  }
```

and, at the end of the file below the class, the parser:

```ts
/** `{ userId, text }`, or null for anything else. Deliberately not a zod schema: it is two strings. */
function parseMemoryMessage(body: string): { userId: string; text: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  const { userId, text } = (parsed ?? {}) as { userId?: unknown; text?: unknown };
  if (typeof userId !== 'string' || userId === '' || typeof text !== 'string' || text === '') return null;
  return { userId, text };
}
```

- [ ] **Step 7: Pin the door shut in the package that ships it**

Decision 11 rests on one sentence — "`surfaces/memory` never calls `mountHttp()`, so no deployment
is affected" — and that sentence is the whole argument for putting an unauthenticated inbound door
into a package a deployment loads. A one-line edit to a 31-line wrapper would open it on every host
whose document declares the memory surface, and nothing would fail. Add the case that fails.

In `surfaces/memory/src/index.test.ts`, using the `deps()` helper already at the top of that file:

```ts
  it('ships with no inbound door: this surface authenticates nobody', async () => {
    // `MemorySurface.mountHttp()` exists for a host test, which mounts it on the session the pool
    // opened. This wrapper must never call it: anyone who can reach the port would be able to
    // speak as any user id this client's identity plug-in knows.
    const session = await surface.connect(deps());
    expect(session.http).toBeUndefined();
    const keyed = await surface.connect({ ...deps(), tenantKey: 'W-ALPHA' });
    expect(keyed.http).toBeUndefined();
  });
```

- [ ] **Step 8: Run it to verify it passes**

Run:
```bash
pnpm --filter @harness/surface-api test
pnpm --filter @harness/surface-memory test
```
Expected: PASS — `http.test.ts`'s nine cases, the memory wrapper's new one, and the packages' existing suites.

- [ ] **Step 9: Update the package README**

In `harness/surface-api/README.md`, add a section after the one describing `SurfaceSession`, matching the file's existing heading level and voice:

```markdown
## Being reached by a request

A surface that does not open its own connection offers `http`: a mount path and a handler. The
host mounts it at `/tenants/<clientId>/<path>` on the server it already runs for the run API,
resolves the tenant from that path, and calls `handle` with the method, whatever is left of the
path, the lower-cased headers and the raw body — unparsed, because a signature is computed over
the bytes that arrived.

Whatever authenticates the request is the surface's own business: the host cannot check a
transport's signature without knowing the transport. What the host does do is audit. A response
carrying `refusal: { reason }` is written to `audit_log` exactly once, as `surface_request` /
`refused`, with the reason and nothing of the body. `reason` is a short token
(`SURFACE_REFUSAL_REASON_PATTERN`), never a sentence, because it is a column an operator groups
by.

`MemorySurface.mountHttp()` is the reference implementation, and it is off until it is called:
this surface authenticates nobody, so a door to it is a door to speaking as anyone.
```

- [ ] **Step 10: Run the four gates**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder \
  pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && \
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder pnpm test
```
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 11: Commit**

The plan document itself is untracked at the start of this task and lands with this pull request,
so it is committed here, once, rather than being carried by whichever task happens to touch `docs/`.

```
git add harness/surface-api surfaces/memory/src/index.test.ts docs/superpowers/plans/2026-09-21-plan-11b-transport-and-publishing.md
git commit -m "feat(surface-api): let a surface be reached by a request instead of a socket it opened"
```

---

### Task 2: The host mounts a surface's handler — one server, a route-aware bearer, and two audited refusals

**Files:**
- Create: `harness/host/src/domain/api/http.ts` (`json` and `readBody`, moved out of `routes.ts`)
- Create: `harness/host/src/domain/api/surfaces.ts` + `surfaces.test.ts`
- Modify: `harness/host/src/domain/api/routes.ts` (the two helpers leave; the bearer becomes route-aware; `/tenants/*` dispatches)
- Modify: `harness/host/src/domain/api/routes.test.ts` (one import line)
- Modify: `harness/host/src/domain/api/types.ts` (`TENANT_PREFIX`; what an empty `token` now means)
- Modify: `harness/host/src/domain/api/server.ts` (what this listener serves)
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (refuse a bad or duplicated mount at open)
- Modify: `harness/host/src/app/main.ts` (the listener always starts)
- Modify: `harness/host/src/index.ts` (export `TENANT_PREFIX`)
- Modify: `harness/core-tools/src/domain/tooling/audit.ts` (`Decision` gains `'refused'`)
- Delete: nothing.

**Interfaces:**
- Consumes: `SurfaceHttp`, `SurfaceHttpRequest`, `SurfaceHttpResponse`, `SURFACE_HTTP_PATH_PATTERN`, `SURFACE_REFUSAL_REASON_PATTERN` (Task 1); `HostPool`, `ClientResolver`, `writeAudit`, `hashArgs`.
- Produces:
  - `TENANT_PREFIX = '/tenants/'`
  - `handleSurfaceRequest(pool: HostPool, req: IncomingMessage, res: ServerResponse, route: string): Promise<void>`
  - `assertMounts(client: string, sessions: readonly SurfaceSession[]): void`
  - `json(res, status, body, then?)` and `readBody(req)`, in `./http.js` rather than `./routes.js`
  - `Decision` = `'auto' | 'approval' | 'blocked' | 'error' | 'unauthorised' | 'refused'`

- [ ] **Step 1: Write the failing test**

Create `harness/host/src/domain/api/surfaces.test.ts`:

```ts
import type { AddressInfo } from 'node:net';
import { eq } from 'drizzle-orm';
import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { auditLog } from '@harness/db';
import type { Trajectory } from '@harness/runtime-api/testing';
import { MemorySurface } from '@harness/surface-api/testing';
import { ConfigError } from '@harness/shared';
import { poolFixture, useTestDb, waitFor, type PoolFixture } from '../../testing.js';
import { assertMounts } from './surfaces.js';
import { startRunApi } from './server.js';
import { API_MAX_BODY_BYTES } from './types.js';

const db = useTestDb();
const TOKEN = 'sk-host-server-test';

/**
 * One tenant, with the memory surface and nothing else: the surface whose door this mounts.
 *
 * `workspace` is the client's own id, and it is not decoration. It becomes this surface's tenant
 * key, which the host splices into `SurfaceDeps.tenantKey`, which `MemorySurface` reports as the
 * `tenantHint` on every event it delivers — and a pooled host **refuses** a surface event that
 * names no workspace (`pooledResolver`), so a door on a surface with no key would have every
 * message it delivered audited `unauthorised` and dropped. The door calls `say(userId, text)`
 * with no override, so this is the only place the key can come from.
 */
const documentFor = (id: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({ id, displayName: id, runtime: 'scripted', surfaces: { memory: { workspace: id } } }),
  );

/** The fixture's lead, who is `U012` on the memory surface. */
const message = (text: string): string => JSON.stringify({ userId: 'U012', text });

interface Served {
  f: PoolFixture;
  url: string;
  post(path: string, body: string, headers?: Record<string, string>): Promise<Response>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
}

/**
 * A real pool, its tenants' memory doors mounted, and the host's one HTTP server over it.
 *
 * The door is mounted on the session the pool opened rather than on a fixture of one, so what
 * these cases drive is the dispatch that ships: `createHost` loaded `@harness/surface-memory` by
 * the name the document gave, and this is that session.
 */
async function serve(opts: {
  documents: readonly ClientDocument[];
  trajectories?: Readonly<Record<string, Trajectory>>;
  dedicated?: string;
  token?: string;
}): Promise<Served> {
  const f = await poolFixture(db, {
    documents: opts.documents,
    ...(opts.trajectories ? { trajectories: opts.trajectories } : {}),
    ...(opts.dedicated === undefined ? {} : { dedicated: opts.dedicated }),
  });
  for (const tenant of f.pool.tenants.values()) {
    (tenant.host.surfaces.find('memory') as MemorySurface).mountHttp();
  }
  const server = startRunApi(f.pool, { token: opts.token ?? TOKEN, bind: '127.0.0.1', port: 0 });
  await server.ready;
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  onTestFinished(async () => {
    await server.close();
    await f.close();
  });
  return {
    f,
    url,
    post: (path, body, headers = {}) =>
      fetch(`${url}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body }),
    get: (path, headers = {}) => fetch(`${url}${path}`, { headers }),
  };
}

const refusals = async (): Promise<(typeof auditLog.$inferSelect)[]> =>
  db.select().from(auditLog).where(eq(auditLog.decision, 'refused'));

describe('a surface mounted on the host', () => {
  it('runs a turn for the tenant the path names, and answers before the turn finishes', async () => {
    const s = await serve({
      documents: [documentFor('alpha')],
      trajectories: { alpha: [{ say: 'Hello back.' }] },
    });
    const response = await s.post('/tenants/alpha/messages', message('hello'));
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/json');
    expect(await response.text()).toBe('{"ok":true}');
    const surface = s.f.surface('alpha');
    await waitFor(() => surface.texts.length > 0);
    expect(surface.texts[0].text).toBe('Hello back.');
    expect(await refusals()).toEqual([]);
  });

  it('needs no bearer of its own, while the run API still needs one', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // No authorization header at all: the surface's own verification is what protects this path,
    // and a transport that signs its requests cannot also send this deployment's bearer secret.
    expect((await s.post('/tenants/alpha/messages', message('hello'))).status).toBe(200);
    const refused = await s.get('/v1/status');
    expect(refused.status).toBe(401);
    expect(await refused.json()).toEqual({ error: 'unauthorised' });
  });

  it('serves a surface but closes the run API when this deployment set no bearer secret', async () => {
    const s = await serve({ documents: [documentFor('alpha')], token: '' });
    // The listener now always starts, so "no secret" has to mean "no run API" explicitly: two
    // empty buffers compare equal, and a caller sending `Bearer ` would otherwise be let in.
    for (const headers of [{}, { authorization: 'Bearer ' }, { authorization: 'Bearer anything' }]) {
      expect((await s.get('/v1/status', headers)).status, JSON.stringify(headers)).toBe(401);
    }
    expect((await s.post('/tenants/alpha/messages', message('hello'))).status).toBe(200);
  });

  it('audits a refusal exactly once, with the reason and nothing of the body', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // The memory door refuses a body that is not a message. What it refuses is never recorded:
    // a refused request is one nobody has authenticated (invariant 15).
    const response = await s.post('/tenants/alpha/messages', '{"userId":"U012"}');
    expect(response.status).toBe(400);
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'memory:request',
      tool: 'surface_request',
      actionClass: 'read',
      decision: 'refused',
      error: 'bad_request',
    });
    expect(JSON.stringify(rows[0])).not.toContain('U012');
  });

  it('refuses a client a dedicated host does not serve, and audits that too (invariant 19)', async () => {
    const s = await serve({ documents: [documentFor('alpha')], dedicated: 'alpha' });
    const response = await s.post('/tenants/beta/messages', message('hello'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: 'no such route' });
    const rows = await refusals();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client: 'alpha',
      caller: 'http:request',
      tool: 'surface_request',
      decision: 'refused',
      error: 'foreign_client',
    });
    expect([...s.f.pool.tenants.keys()]).toEqual(['alpha']);
  });

  it('routes by the client id in the path, and one tenant never hears another tenant s message', async () => {
    const s = await serve({
      documents: [documentFor('alpha'), documentFor('beta')],
      trajectories: { alpha: [{ say: 'Alpha here.' }], beta: [{ say: 'Beta here.' }] },
    });
    expect((await s.post('/tenants/beta/messages', message('hello'))).status).toBe(200);
    await waitFor(() => s.f.surface('beta').texts.length > 0);
    expect(s.f.surface('beta').texts[0].text).toBe('Beta here.');
    expect(s.f.surface('alpha').texts).toEqual([]);
    expect(s.f.surface('alpha').requests).toEqual([]);
  });

  it('answers 404 for a path no surface claims, for a prefix with no path, and for an unknown client', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // `/tenants/` and `/tenants` are the same string once the router has stripped the trailing
    // slash, and both are below the prefix: they must not fall through to the bearer check.
    for (const path of ['/tenants/alpha/nope', '/tenants/alpha', '/tenants/', '/tenants']) {
      const response = await s.post(path, message('hello'));
      expect(response.status, path).toBe(404);
    }
    // A pooled host has no tenant for this id and no claim to audit: nobody was refused, there is
    // simply nobody there, and the answer is the one a nonexistent route gets.
    expect((await s.post('/tenants/nobody/messages', message('hello'))).status).toBe(404);
    expect(await refusals()).toEqual([]);
  });

  it('tells nobody which clients it serves, because this path has no bearer in front of it', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    // A tenant this host really serves, at a path no surface claims, and a client that does not
    // exist at all. Byte-identical in status and in body: anything else and an unauthenticated
    // caller can enumerate this process's tenants one guess at a time.
    const known = await s.post('/tenants/alpha/nope', message('hello'));
    const unknown = await s.post('/tenants/nobody/nope', message('hello'));
    expect(known.status).toBe(unknown.status);
    expect(await known.text()).toBe(await unknown.text());
    expect(unknown.status).toBe(404);
  });

  it('refuses a body past the cap without ever calling the surface', async () => {
    const s = await serve({ documents: [documentFor('alpha')] });
    const response = await s.post('/tenants/alpha/messages', 'x'.repeat(API_MAX_BODY_BYTES + 1));
    expect(response.status).toBe(413);
    expect(s.f.surface('alpha').requests).toEqual([]);
  });
});

describe('assertMounts', () => {
  const mounted = (name: string, path: string): MemorySurface => {
    const surface = new MemorySurface({ name, conversation: name });
    surface.mountHttp(path);
    return surface;
  };

  it('accepts a tenant whose surfaces claim different paths, and one that claims none', () => {
    expect(() => assertMounts('alpha', [mounted('memory', 'messages'), new MemorySurface()])).not.toThrow();
    expect(() => assertMounts('alpha', [new MemorySurface()])).not.toThrow();
  });

  it('refuses a mount path that could climb out of its tenant prefix', () => {
    const surface = new MemorySurface();
    // Past `mountHttp`, because a session is an object and a real adapter builds its own.
    (surface as { http?: { path: string } }).http = { path: '/v1/runs' };
    expect(() => assertMounts('alpha', [surface])).toThrow(ConfigError);
    expect(() => assertMounts('alpha', [surface])).toThrow(/mount path/);
  });

  it('refuses two surfaces of one tenant claiming one path, naming both', () => {
    const err = (() => {
      try {
        assertMounts('alpha', [mounted('memory', 'messages'), mounted('other', 'messages')]);
      } catch (caught: unknown) {
        return caught as Error;
      }
      return null;
    })();
    expect(err).toBeInstanceOf(ConfigError);
    expect(err?.message).toContain('memory');
    expect(err?.message).toContain('other');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/api/surfaces.test.ts
```
Expected: FAIL — `./surfaces.js` does not exist.

- [ ] **Step 3: Move `json` and `readBody` into a leaf module**

Create `harness/host/src/domain/api/http.ts`, moving both functions **verbatim with their comments** out of `routes.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { API_MAX_BODY_BYTES } from './types.js';

/**
 * The two things every handler on this server does with a socket, in a module that imports
 * nothing of the host's.
 *
 * They live here rather than in `routes.ts` because `routes.ts` dispatches to `surfaces.ts` and
 * `surfaces.ts` has to read a body: a helper in either of them would put the two files in a
 * cycle, and `pnpm arch`'s `no-circular` is an error.
 */

/** `then` runs once the body is on the wire: what the 413 path hangs the socket's teardown on. */
export function json(res: ServerResponse, status: number, body: unknown, then?: () => void): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body), then);
}

/**
 * Read the body, refusing past the cap while it arrives rather than after.
 *
 * Past the cap this stops consuming: the `data` handler comes off and the request is paused, so
 * nothing further is read off the socket and what was already held is released. It does not
 * destroy the connection — a 413 cannot be written down a socket this function has torn up, and a
 * caller told nothing learns nothing. The caller answers, and hangs the teardown on the answer
 * being flushed, so the read stays bounded either way.
 */
export async function readBody(req: IncomingMessage): Promise<{ ok: true; text: string } | { ok: false }> {
  return new Promise((resolve) => {
    let chunks: Buffer[] = [];
    let size = 0;
    const onData = (chunk: Buffer): void => {
      size += chunk.length;
      if (size > API_MAX_BODY_BYTES) {
        // Both, because removing the last `data` listener does not by itself stop a flowing stream.
        req.off('data', onData);
        req.pause();
        chunks = [];
        resolve({ ok: false });
        return;
      }
      chunks.push(chunk);
    };
    req.on('data', onData);
    // Already settled if the cap tripped; a promise keeps its first answer.
    req.on('end', () => resolve({ ok: true, text: Buffer.concat(chunks).toString('utf8') }));
    req.on('error', () => resolve({ ok: false }));
  });
}
```

Then, in `routes.ts`: delete both function bodies, and import them instead — `import { json, readBody } from './http.js';` — keeping the import block's existing ordering. `routes.ts` no longer exports `readBody`.

In `harness/host/src/domain/api/routes.test.ts`, change line 4 from

```ts
import { bearerOk, readBody } from './routes.js';
```

to

```ts
import { readBody } from './http.js';
import { bearerOk } from './routes.js';
```

- [ ] **Step 4: Add the tenant prefix and say what an empty token means**

In `harness/host/src/domain/api/types.ts`, add after `CLIENT_HEADER`:

```ts
/**
 * Where every tenant's surface mounts hang: `/tenants/<clientId>/<the surface's own path>`.
 *
 * One rule for a dedicated host and a pooled one alike (spec decision 4, which allows the tenant
 * to be resolved from a workspace key the surface carries, an HTTP header, or a path). A path, not
 * a header, because a path is the only one of the three a transport that knows nothing about this
 * deployment can be told to use — an app's request URL is configured once, in the app, and it
 * carries the tenant with it. Nothing below this prefix is behind the bearer: what protects it is
 * the surface's own verification of its own transport's signature.
 */
export const TENANT_PREFIX = '/tenants/';
```

**Nothing in this comment, or in any other line this task writes into `harness/host/src`, may name
a vendor.** `kernel-vocabulary.test.ts` scans that tree for `/slack|bolt|block ?kit|thread_ts|\bblocks\b|socket ?mode/i`
over the raw text of every non-test file, with an empty allowlist, and spec §4.6 names the rule
outright. Quoting the spec's own wording of decision 4 would have failed the gate, which is why
the sentence above paraphrases it. Step 13 greps for it.

and replace the doc comment on `RunApiOptions.token`:

```ts
export interface RunApiOptions {
  /**
   * `HARNESS_HOST_TOKEN`. **Empty closes `/v1/*`, it does not close the listener**: this server
   * also carries every tenant's surface mounts, which have their own protection and must answer
   * whether or not this deployment uses the run API. An empty token is refused explicitly rather
   * than compared, because two empty buffers compare equal and `Bearer ` would otherwise pass.
   */
  token: string;
  bind?: string;
  port?: number;
}
```

- [ ] **Step 5: Write the dispatch**

Create `harness/host/src/domain/api/surfaces.ts`:

```ts
import type { IncomingMessage, ServerResponse } from 'node:http';
import { hashArgs, writeAudit } from '@harness/core-tools';
import type { Db } from '@harness/db';
import { ConfigError } from '@harness/shared';
import {
  SURFACE_HTTP_PATH_PATTERN,
  SURFACE_REFUSAL_REASON_PATTERN,
  type SurfaceHttp,
  type SurfaceHttpResponse,
  type SurfaceSession,
} from '@harness/surface-api';
import type { HostPool } from '../tenancy/types.js';
import { json, readBody } from './http.js';
import { API_MAX_BODY_BYTES, TENANT_PREFIX } from './types.js';

/**
 * Serving a surface that is reached by a request (spec section 4.6).
 *
 * Nothing here knows what a surface's transport is. A session offers a mount path and a handler;
 * this file resolves which tenant a request belongs to, hands the handler the method, the rest of
 * the path, the lower-cased headers and the raw body, and sends back what it answers. The path
 * and the refusal reason are data a surface supplied, which is why `harness/host/src` can carry
 * this and still name no vendor.
 */

/** A surface that claimed this request, and where its own path starts. */
interface Mounted {
  session: SurfaceSession;
  http: SurfaceHttp;
  subPath: string;
}

/**
 * Refuse a tenant whose surfaces cannot be mounted, at open rather than at the first request.
 *
 * Two failures, both of them somebody's configuration: a path that is not a mount path — a
 * leading slash, an upper-case letter, a `..` segment that would climb out of the tenant prefix
 * into `/v1/runs` — and two of one tenant's surfaces claiming the same one, where whichever
 * loaded first would quietly take the other's traffic.
 */
export function assertMounts(client: string, sessions: readonly SurfaceSession[]): void {
  const claimed = new Map<string, string>();
  for (const session of sessions) {
    const mount = session.http;
    if (!mount) continue;
    if (!SURFACE_HTTP_PATH_PATTERN.test(mount.path)) {
      throw new ConfigError(
        `client "${client}": surface "${session.name}" asks for the mount path "${mount.path}", which is not one: lowercase letters, digits, hyphens and underscores in slash-separated segments, with no leading or trailing slash`,
      );
    }
    const owner = claimed.get(mount.path);
    if (owner !== undefined) {
      throw new ConfigError(
        `client "${client}": surfaces "${owner}" and "${session.name}" both ask for the mount path "${mount.path}"`,
      );
    }
    claimed.set(mount.path, session.name);
  }
}

/** The first surface whose mount path is this path, or is a prefix of it. */
function mountFor(sessions: readonly SurfaceSession[], path: string): Mounted | null {
  for (const session of sessions) {
    const http = session.http;
    if (!http) continue;
    if (path === http.path) return { session, http, subPath: '' };
    if (path.startsWith(`${http.path}/`)) return { session, http, subPath: path.slice(http.path.length + 1) };
  }
  return null;
}

/**
 * Lower-cased, and a header sent twice is its first value.
 *
 * Node hands a repeated header back as an array; a transport that signs its requests sends its
 * signature once, and a handler that had to choose between two would be the wrong place for that
 * decision to live.
 */
function headersOf(req: IncomingMessage): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    headers[name.toLowerCase()] = Array.isArray(value) ? (value[0] ?? '') : value;
  }
  return headers;
}

/**
 * One row, and only one, per refused request (invariant 15).
 *
 * The reason and the mount path, never the body: a refused request has not been authenticated, so
 * nothing in it is worth recording and everything in it might be somebody's. A reason that is not
 * a reason — a sentence, an empty string, a surface's bug — is recorded as `unspecified` rather
 * than dropped, because losing the row would hide the refusal behind the mistake.
 */
async function auditRefusal(
  db: Db,
  entry: { client: string; asked: string; caller: string; method: string; path: string; reason: string },
): Promise<void> {
  await writeAudit(db, {
    client: entry.client,
    caller: entry.caller,
    tool: 'surface_request',
    actionClass: 'read',
    // `asked` is the client id the request named, which on a dedicated host is not `client`. It is
    // hashed rather than written out for the reason every `args_hash` is — it is a caller's string
    // — and it is in here at all so that two refusals naming two different tenants can be told
    // apart by an operator who is counting them.
    argsHash: hashArgs({ asked: entry.asked, method: entry.method, path: entry.path }),
    decision: 'refused',
    error: SURFACE_REFUSAL_REASON_PATTERN.test(entry.reason) ? entry.reason : 'unspecified',
  });
}

function send(res: ServerResponse, response: SurfaceHttpResponse): void {
  // The surface's own headers win: it knows what it is answering. Plain text is the default
  // because an acknowledgement is usually empty and a body typed `application/json` that is not
  // JSON is worse than one typed as text.
  res.writeHead(response.status, { 'content-type': 'text/plain; charset=utf-8', ...(response.headers ?? {}) });
  res.end(response.body ?? '');
}

/**
 * Serve one request below `/tenants/`.
 *
 * `/tenants/<clientId>/<path>`: the client id is resolved through the pool's own resolver, so a
 * dedicated host refuses any other client's id and audits it (invariant 19) and a pooled host
 * opens whichever tenant the path names.
 *
 * **Every miss below this prefix answers the same thing**: `404 {"error":"no such route"}`,
 * whether the client does not exist, this host does not serve it, or it serves it and no surface
 * of it claims that path. This prefix is in front of the bearer by design, so a body that said
 * "no such client" would let anyone who can reach the port enumerate which tenants this process
 * holds — the property the run API keeps with a bearer in front of it, and which this path has to
 * keep with nothing in front of it. The distinction still exists where it is useful: a dedicated
 * host's refusal is a tenant boundary somebody tried to cross and is written to the audit log,
 * and a pooled host asked for a client nobody has writes nothing, because nobody was refused —
 * there is nobody there.
 */
export async function handleSurfaceRequest(
  pool: HostPool,
  req: IncomingMessage,
  res: ServerResponse,
  route: string,
): Promise<void> {
  const rest = route.slice(TENANT_PREFIX.length);
  const slash = rest.indexOf('/');
  const asked = slash === -1 ? rest : rest.slice(0, slash);
  const path = slash === -1 ? '' : rest.slice(slash + 1);
  if (asked === '' || path === '') return json(res, 404, { error: 'no such route' });
  const method = req.method ?? '';
  if (pool.resolver.resolve({ from: 'api', clientId: asked }) !== asked) {
    if (pool.dedicatedClient !== null) {
      await auditRefusal(pool.db, {
        client: pool.dedicatedClient,
        asked,
        caller: 'http:request',
        method,
        path,
        reason: 'foreign_client',
      });
      pool.log.warn(`a request named a client this host does not serve; refused`);
    }
    return json(res, 404, { error: 'no such route' });
  }
  const tenant = await pool.tenantFor(asked);
  if (!tenant) return json(res, 404, { error: 'no such route' });
  const mount = mountFor(tenant.host.surfaces.all, path);
  if (!mount) return json(res, 404, { error: 'no such route' });
  const body = await readBody(req);
  // Answered, then the socket torn up, for the reason `openRunRoute` gives: a caller told nothing
  // learns nothing, and a caller that keeps sending anyway is cut off rather than read for as
  // long as it likes.
  if (!body.ok) {
    return json(res, 413, { error: `a request body may be at most ${API_MAX_BODY_BYTES} bytes` }, () => req.destroy());
  }
  const response = await mount.http.handle({
    method,
    path: mount.subPath,
    headers: headersOf(req),
    // The bytes as they arrived, decoded as UTF-8 and not parsed: a surface that verifies a
    // signature computes it over exactly this.
    body: body.text,
  });
  if (response.refusal) {
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
  send(res, response);
}
```

- [ ] **Step 6: Make the bearer check route-aware**

In `harness/host/src/domain/api/routes.ts`, add `TENANT_PREFIX` to the `./types.js` import, add `import { handleSurfaceRequest } from './surfaces.js';`, and replace the first two statements of `handleApiRequest`'s body after `route` is computed:

```ts
  const url = new URL(req.url ?? '/', 'http://run-api.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  // In front of the bearer, and deliberately: a tenant's surface is reached by a transport that
  // knows nothing about this deployment's secrets and everything about its own signature, so the
  // check that matters happens inside the surface. Spec section 4.6.
  //
  // The bare prefix is matched as well as everything below it, because the normalisation above
  // strips the trailing slash: `/tenants/` and `/tenants` are both the string `/tenants` by the
  // time this runs, and falling through would answer 401 for a request that names no tenant at
  // all rather than the 404 it deserves. `handleSurfaceRequest` answers that case already — the
  // slice is empty, so there is no client id.
  if (route === '/tenants' || route.startsWith(TENANT_PREFIX)) return handleSurfaceRequest(pool, req, res, route);
  // An empty configured token is refused before it is compared: `timingSafeEqual` on two empty
  // buffers is true, so `Bearer ` would otherwise authenticate a deployment that set no secret.
  if (opts.token === '' || !bearerOk(req.headers.authorization, opts.token)) {
    return json(res, 401, { error: 'unauthorised' });
  }
```

and update the function's doc comment's first line to say what it now routes:

```ts
/**
 * Route one request: the run API below `/v1`, and every tenant's surface mounts below `/tenants`.
 *
 * Every `/v1` route is behind the bearer check, and then behind the tenant check. `/tenants` is
 * in front of both, for the reason in the body, and resolves its tenant from the path.
 *
 * `x-harness-client` names the client on the run API. On a dedicated host it may be absent, and a
 * value that is not that host's client is refused; on a pooled host it is required, because a
 * pool that picked a tenant for a caller who did not name one would pick the wrong one the day it
 * had two. A refusal is 404 with the same body a nonexistent route gets, so the API never
 * confirms that a client somebody guessed at exists — and `handleSurfaceRequest` keeps the same
 * property below `/tenants`, where there is no bearer in front of it to keep it.
 */
```

- [ ] **Step 7: Refuse a bad mount at open**

In `harness/host/src/domain/tenancy/tenant.ts`, add `import { assertMounts } from '../api/surfaces.js';` and call it immediately after the `loadSurfaces` call and before the `opened.push` loop:

```ts
  // Before anything is started: a mount path that could climb out of its tenant prefix, or two
  // surfaces claiming one path, is this client's configuration being wrong, and a tenant that
  // failed at its first request instead would fail it for whoever sent it.
  assertMounts(config.client, surfaces.all);
```

- [ ] **Step 8: Widen `Decision`**

In `harness/core-tools/src/domain/tooling/audit.ts`:

```ts
/**
 * `unauthorised` is the host's own decision (spec 3.2): a message from nobody the identity plug-in
 * knows. `refused` is the other one: a request a surface turned away at the door — an unsigned
 * one, a stale one, one naming another tenant — where nobody was identified at all, so nobody was
 * refused authorisation. Two words because an operator reading the audit log has two questions.
 */
export type Decision = 'auto' | 'approval' | 'blocked' | 'error' | 'unauthorised' | 'refused';
```

`audit_log.decision` is `text('decision').notNull()` with no enum and no check constraint, so this is a type change and **no migration**.

- [ ] **Step 9: Start the listener always**

In `harness/host/src/app/main.ts`, replace the run API block:

```ts
// The host's HTTP server: the run API (spec 5.8) below `/v1`, and every tenant's surface mounts
// below `/tenants` (spec section 4.6). It always listens, because a surface reached by a request
// has to be reachable whether or not this deployment uses the run API — and an empty
// HARNESS_HOST_TOKEN closes `/v1` rather than closing the socket. One listener per process,
// whatever the tenancy: it resolves the tenant a request belongs to per request.
const hostToken = (optionalEnv('HARNESS_HOST_TOKEN') ?? '').trim();
const runApi = startRunApi(pool, {
  token: hostToken,
  bind: envOrDefault('HARNESS_HOST_BIND', DEFAULT_HOST_BIND),
  port: port('HARNESS_HOST_PORT', DEFAULT_HOST_PORT),
});
await runApi.ready;

log.info(
  `listening (mode=${pool.resolver.mode}, tenants=${[...pool.tenants.keys()].join(',') || 'none'}, runApi=${hostToken === '' ? 'closed (set HARNESS_HOST_TOKEN)' : 'open'})`,
);
```

and in `shutdown`, `await runApi?.close();` becomes `await runApi.close();`.

- [ ] **Step 10: Export the prefix**

In `harness/host/src/index.ts`, add `TENANT_PREFIX` to the `./domain/api/types.js` export block, alphabetically after `SSE_KEEPALIVE_MS`.

- [ ] **Step 11: Update the server's doc comment**

In `harness/host/src/domain/api/server.ts`, replace the first paragraph of `startRunApi`'s comment:

```ts
/**
 * The host's HTTP server: the run API (spec 5.8) and every tenant's surface mounts (section 4.6).
 *
 * One listener, because they are one deployment's front door on one port, and a second server
 * would be a second port to publish, a second bind to configure and a second thing to shut down.
 * The name is the run API's because that is what it was; what it serves is in `handleApiRequest`.
 */
```

leaving the rest of that comment — `ready`, `close`, and why it takes the pool — as it is.

- [ ] **Step 12: Run the host suite to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host test
```
Expected: PASS, including `surfaces.test.ts`'s twelve cases and the existing `routes.test.ts`, `server.test.ts` and tenancy suites.

- [ ] **Step 13: Run the four gates, and prove this task named no vendor**

Run:
```bash
grep -rniE 'slack|bolt|block ?kit|thread_ts|\bblocks\b' harness/host/src --include='*.ts' | grep -v '\.test\.ts'
```
Expected: **no output.** This is the one thing spec §4.6 names outright — "the host must not name Slack" — and `kernel-vocabulary.test.ts` enforces it over the raw text of every non-test file in that tree with an empty allowlist, comments included. The grep is here rather than left to the gate because the failure it catches is a sentence somebody wrote while explaining the mount, and the gate's message points at a line number rather than at the habit.

Then run the gate command from Task 1 Step 10.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 14: Commit**

```
git add harness/host/src harness/core-tools/src/domain/tooling/audit.ts
git commit -m "feat(host): mount every tenant's surface at /tenants/<client>/<path> on the one HTTP server"
```

---

### Task 3: Slack over HTTPS — signature verification, one URL, `auth.test`, and Bolt deleted

**Files:**
- Create: `surfaces/slack/src/transport/signature.ts` + `signature.test.ts`
- Create: `surfaces/slack/src/transport/classify.ts` + `classify.test.ts` (both moved out of `bolt.ts` / `bolt.test.ts`)
- Create: `surfaces/slack/src/transport/events.ts` + `events.test.ts`
- Delete: `surfaces/slack/src/transport/bolt.ts`, `surfaces/slack/src/transport/bolt.test.ts`
- Modify: `surfaces/slack/src/transport/types.ts` (`auth`, `SlackAuthTestResult`, `SlackTransport.http?`), `transport/web-client.ts`, `transport/fake.ts`
- Modify: `surfaces/slack/src/config.ts`, `src/session.ts`, `src/index.ts`, `src/index.test.ts`, `src/testing.ts`, `surfaces/slack/package.json`
- Modify: `harness/surface-api/src/types.ts` (`SurfaceDeps.secrets`)
- Modify: `harness/config-api/src/document.ts` (`field` on `surfaceSecretsOf`) + `document.test.ts`
- Modify: `harness/approvals/src/domain/surfaces/registry.ts` (`SurfaceSettings`) + `registry.test.ts`, `harness/approvals/src/index.ts`
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (build the settings)
- Modify: `pnpm-lock.yaml` (by `pnpm install`, not by hand)

**Interfaces:**
- Consumes: `SurfaceHttp`, `SurfaceHttpRequest`, `SurfaceHttpResponse` (Task 1); the mount rule (Task 2).
- Produces:
  - `verifySignature(opts): SignatureCheck`, `signRequest(secret, timestamp, body): string`, `SIGNATURE_WINDOW_SECONDS = 300`
  - `classifyMessage`, `classifyInbound`, `createThreadMemory`, `THREAD_MEMORY_LIMIT`, `Classified`, `ThreadMemory`, `BotIdentity` — the same symbols, from `./classify.js`
  - `eventsTransport(config: SlackConfig, log: Logger, storageDir: string, api?: SlackApi): SlackTransport` — the fourth parameter defaults to `webClientApi(new WebClient(config.botToken))` and exists so a test can substitute `FakeSlack`; `index.ts` passes three arguments — and `SLACK_MOUNT_PATH = 'slack/events'`
  - `SlackApi.auth.test(): Promise<SlackAuthTestResult>`
  - `SlackConfig = { botToken; signingSecret; defaultConversation }`, `slackConfig(env, secrets?)`
  - `SurfaceDeps.secrets?: Readonly<Record<string, string>>`
  - `surfaceSecretsOf(document): { surface: string; field: string; env: string }[]`
  - `SurfaceSettings { tenantKey?; secrets? }`, and `loadSurfaces(names, deps, settings)`

**One consequence, recorded so it is not discovered later.** `slackConfig` looks its variable names up rather than writing them out, so the environment scan in `record-surface.ts` — which matches `requiredEnv('NAME'` and `requiredEnv(env, 'NAME'` — stops seeing `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. Nothing fails: the scan's rule is that every name it *finds* must be documented, `.env.example` documents all three regardless, and `SLACK_APPROVALS_CHANNEL` — one of `SCAN_ANCHORS`, so the scan proves it still runs — stays a literal in the same function.

- [ ] **Step 1: Write the failing signature test**

Create `surfaces/slack/src/transport/signature.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SIGNATURE_WINDOW_SECONDS, signRequest, verifySignature } from './signature.js';

const SECRET = 'a-signing-secret';
const BODY = '{"type":"event_callback"}';
const NOW = 1_789_000_000;
const stamp = String(NOW);

const check = (over: Partial<Parameters<typeof verifySignature>[0]> = {}): ReturnType<typeof verifySignature> =>
  verifySignature({
    signature: signRequest(SECRET, stamp, BODY),
    timestamp: stamp,
    body: BODY,
    secret: SECRET,
    nowSeconds: NOW,
    ...over,
  });

describe('verifySignature', () => {
  it('accepts a request signed with this app s secret', () => {
    expect(check()).toEqual({ ok: true });
  });

  it('computes the digest Slack documents, over v0:<timestamp>:<body>', () => {
    // Written out rather than taken from `signRequest`, so the two cannot drift together.
    const expected = `v0=${createHmac('sha256', SECRET).update(`v0:${stamp}:${BODY}`).digest('hex')}`;
    expect(signRequest(SECRET, stamp, BODY)).toBe(expected);
  });

  it('refuses a request with neither header, and with only one of them', () => {
    expect(check({ signature: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ timestamp: undefined })).toEqual({ ok: false, reason: 'missing_signature' });
    expect(check({ signature: '' })).toEqual({ ok: false, reason: 'missing_signature' });
  });

  it('refuses a signature over a different body, a different secret or a different timestamp', () => {
    expect(check({ body: `${BODY} ` })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check({ secret: 'another-secret' })).toEqual({ ok: false, reason: 'bad_signature' });
    expect(check({ signature: signRequest(SECRET, String(NOW - 1), BODY) })).toEqual({
      ok: false,
      reason: 'bad_signature',
    });
    expect(check({ signature: 'v0=short' })).toEqual({ ok: false, reason: 'bad_signature' });
  });

  it('refuses a replay outside the window, in either direction, and a timestamp that is not one', () => {
    const outside = SIGNATURE_WINDOW_SECONDS + 1;
    for (const at of [NOW + outside, NOW - outside]) {
      expect(check({ nowSeconds: at }), String(at)).toEqual({ ok: false, reason: 'stale_timestamp' });
    }
    // Inside the window in both directions, so the bound is a window and not a deadline.
    for (const at of [NOW + SIGNATURE_WINDOW_SECONDS, NOW - SIGNATURE_WINDOW_SECONDS]) {
      expect(check({ nowSeconds: at }), String(at)).toEqual({ ok: true });
    }
    expect(check({ timestamp: 'now' })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });

  it('checks the clock before the digest, so a valid replay is reported as the replay it is', () => {
    // A request that is perfectly signed and hours old is stale, not unsigned: saying `stale`
    // tells an operator their clock or their attacker, and saying `bad` tells them neither.
    expect(check({ nowSeconds: NOW + 86_400 })).toEqual({ ok: false, reason: 'stale_timestamp' });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-slack exec vitest run src/transport/signature.test.ts`
Expected: FAIL — `./signature.js` does not exist.

- [ ] **Step 3: Write the verifier**

Create `surfaces/slack/src/transport/signature.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/** Slack's signature version prefix, and the only one there has ever been. */
const VERSION = 'v0';

/**
 * How far a request's timestamp may be from this clock, in seconds.
 *
 * Five minutes, which is what Slack's own guidance says: long enough for a slow network and a
 * container whose clock drifted a little, short enough that a captured request is not a key.
 */
export const SIGNATURE_WINDOW_SECONDS = 300;

export type SignatureFailure = 'missing_signature' | 'bad_signature' | 'stale_timestamp';
export type SignatureCheck = { ok: true } | { ok: false; reason: SignatureFailure };

/** The signature a request with this body and this timestamp must carry. */
export function signRequest(secret: string, timestamp: string, body: string): string {
  return `${VERSION}=${createHmac('sha256', secret).update(`${VERSION}:${timestamp}:${body}`).digest('hex')}`;
}

/**
 * Is this request Slack's?
 *
 * HMAC-SHA256 over `v0:<timestamp>:<raw body>` with this app's signing secret, compared against
 * `X-Slack-Signature` in constant time. Nothing here parses the body and nothing here logs: the
 * whole point of verifying is that it happens before anything trusts a byte of what arrived
 * (invariant 15), and every input to this function is somebody else's.
 *
 * The clock is checked first. A replay of a request whose signature is perfectly valid is stale,
 * and reporting it as stale tells an operator to look at a clock or at a captured request, while
 * reporting it as a bad signature would send them to look at a secret that is fine.
 */
export function verifySignature(opts: {
  signature: string | undefined;
  timestamp: string | undefined;
  body: string;
  secret: string;
  nowSeconds: number;
}): SignatureCheck {
  const signature = opts.signature ?? '';
  const timestamp = opts.timestamp ?? '';
  if (signature === '' || timestamp === '') return { ok: false, reason: 'missing_signature' };
  const sent = Number(timestamp);
  // A timestamp that is not a number cannot be inside any window, and it is the same failure as
  // one that is outside it: there is no moment this request claims to have been made at.
  if (!Number.isInteger(sent)) return { ok: false, reason: 'stale_timestamp' };
  if (Math.abs(opts.nowSeconds - sent) > SIGNATURE_WINDOW_SECONDS) return { ok: false, reason: 'stale_timestamp' };
  const offered = Buffer.from(signature, 'utf8');
  const expected = Buffer.from(signRequest(opts.secret, timestamp, opts.body), 'utf8');
  // Length first: `timingSafeEqual` throws on a mismatch, and a length is all that comparing them
  // can leak — which a caller who could measure the comparison would learn anyway.
  if (offered.length !== expected.length || !timingSafeEqual(offered, expected)) {
    return { ok: false, reason: 'bad_signature' };
  }
  return { ok: true };
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @harness/surface-slack exec vitest run src/transport/signature.test.ts`
Expected: PASS, six cases.

- [ ] **Step 5: Move the classifier and the thread memory out of `bolt.ts`**

Create `surfaces/slack/src/transport/classify.ts` holding, **verbatim with their comments**, everything in `bolt.ts` above `boltTransport`: `THREAD_MEMORY_LIMIT`, `THREAD_LOOKUP_LIMIT`, `WARN_INTERVAL_MS`, `Classified`, `classifyMessage`, `boundedMap`, `BotIdentity`, `ThreadMemory`, `createThreadMemory` and `classifyInbound`. Its imports are:

```ts
import type { Logger } from '@harness/shared';
import type { SlackFile } from './files.js';
import type { RawMessage, SlackApi, SlackThreadMessage } from './types.js';
```

Two comments change, because they name a framework this package no longer has:

- On `BotIdentity`, "Bolt puts both on the context; either may be missing" becomes "`auth.test` answers with both at start; either may be missing".
- On `classifyMessage`, nothing changes: it describes Slack's own event semantics and every rule in it — the `USLACKBOT` filter, the `app_mention` duplicate rule, the subtype rule, the thread rule — holds identically over the Events API. **Do not edit the classifier's body.** It is the most carefully tested thing in this package and this plan moves it, nothing else.

Rename the test: `git mv surfaces/slack/src/transport/bolt.test.ts surfaces/slack/src/transport/classify.test.ts`, and change its import line from `./bolt.js` to `./classify.js`. Nothing else in that file changes; it constructs no Bolt `App` today.

- [ ] **Step 6: Give `SlackApi` an `auth.test`**

In `surfaces/slack/src/transport/types.ts`, add the result type beside the other narrow results:

```ts
/** What `auth.test` says about the app a token belongs to. Two ids; nothing else is read. */
export interface SlackAuthTestResult {
  user_id?: string;
  bot_id?: string;
}
```

add the member to `SlackApi`, after `conversations`:

```ts
  /**
   * Who this app is.
   *
   * The mention stripper and the thread rule both compare against the bot's own ids, and over the
   * Events API nothing else carries them: a socket's connection context used to. Called once, at
   * `start()`, so a token that is wrong fails the tenant's open rather than every message.
   */
  auth: {
    test(): Promise<SlackAuthTestResult>;
  };
```

and add the HTTP door to `SlackTransport`:

```ts
export interface SlackTransport {
  api: SlackApi;
  events: SlackEvents;
  notePostedIn(channel: string, messageId: string): void;
  /**
   * Where this transport is reached, when it is reached by a request at all.
   *
   * The real transport offers one and the fake does not: a test drives `FakeSlackEvents` where
   * Slack would, which is the seam the session's own suites were written against.
   */
  http?: SurfaceHttp;
}
```

with `import type { SurfaceHttp } from '@harness/surface-api';` at the top of the file.

Then rewrite the three comments in the same file that describe a framework this package is about
to stop having. The Global Constraints forbid a "still works" clause or a deprecation comment, and
prose pointing at a deleted file is the same debt in a cheaper form. Nothing but the comments
changes — every field name stays:

```ts
/**
 * One block action, narrowed off the interaction payload. Everything transport-shaped is in
 * `events.ts`, so the session and its tests never touch a payload type — the same seam the
 * approvals app already had, moved into the adapter that owns it.
 */
export interface SlackAction {
```

```ts
/** The fields of a `message` or `app_mention` delivery the classifier reads. */
export interface RawMessage {
```

and, in `SlackInbound.teamId`'s comment, "or null where the payload and the connection's own
context both left it out" becomes "or null where neither the event nor the delivery's envelope
carried one".

Read `fake.ts` and `web-client.ts` for the same thing before moving on: `grep -n -i "bolt\|socket" surfaces/slack/src/transport/*.ts` after Step 14 must return nothing but the word `socket` in prose that is about HTTP, and the vocabulary scan does not cover this package, so this is the only check there is.

In `surfaces/slack/src/transport/web-client.ts`, add the adapter, after `conversations`:

```ts
    auth: {
      test: async () => {
        const res = await client.auth.test();
        // Narrowed to the two ids the classifier compares against: the workspace, the app's URL
        // and the user's name are not this adapter's business at start-up.
        return { user_id: res.user_id, bot_id: res.bot_id };
      },
    },
```

`AuthTestResponse` in `@slack/web-api@8.1.1` declares both `user_id?: string` and `bot_id?: string`, so neither needs a cast.

In `surfaces/slack/src/transport/fake.ts`, add `SlackAuthTestResult` to the import list, a field beside the other stubs:

```ts
  /** What `auth.test` answers: the ids this app posts under. */
  authTest: SlackAuthTestResult = { user_id: 'U0BOTUSER', bot_id: 'B0BOTID' };
  /** How many times the identity was fetched, so a test can prove it happens once. */
  authTestCalls = 0;
```

and the member, beside `users`:

```ts
  auth = {
    test: async (): Promise<SlackAuthTestResult> => {
      this.guard();
      this.authTestCalls += 1;
      return this.authTest;
    },
  };
```

- [ ] **Step 7: Write the failing transport test**

Create `surfaces/slack/src/transport/events.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { ActionEvent, FormEvent } from '@harness/surface-api';
import { slackConfig } from '../config.js';
import { createSlackSession } from '../session.js';
import { eventsTransport, SLACK_MOUNT_PATH } from './events.js';
import { FakeSlack } from './fake.js';
import { signRequest } from './signature.js';
import type { SlackInbound, SlackTransport } from './types.js';

const SECRET = 'a-signing-secret';
const env = { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: SECRET, SLACK_APPROVALS_CHANNEL: 'C0DEMO' };
const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };

/**
 * The transport under test, over the fake Web API.
 *
 * The fake is passed in rather than constructed inside: `eventsTransport`'s fourth parameter
 * defaults to a real `WebClient`, and `start()` calls `auth.test`, so a test that let it default
 * would make an HTTPS round trip to slack.com with a fake token and reject. It is also the only
 * way the bot identity these cases assert against — `U0BOTUSER` — can be known.
 */
function transport(): { t: SlackTransport; api: FakeSlack } {
  const api = new FakeSlack();
  return { t: eventsTransport(slackConfig(env), log, '/nonexistent/storage', api), api };
}

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
  };
}

const eventCallback = (event: Record<string, unknown>, teamId = 'T0WORKSPACE'): string =>
  JSON.stringify({ type: 'event_callback', team_id: teamId, event });

const channelMention = {
  type: 'app_mention',
  channel: 'C0ROOM',
  user: 'U0PERSON',
  text: 'hello there',
  ts: '1789000000.000100',
};

/** Wait for what an acknowledged request started; the door answers before the work is done. */
const settle = async (): Promise<void> => {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
};

describe('the Slack transport as an HTTP door', () => {
  it('is mounted at one path, for events and for interactions alike', () => {
    expect(transport().http?.path).toBe(SLACK_MOUNT_PATH);
    expect(SLACK_MOUNT_PATH).toBe('slack/events');
  });

  it('answers the url_verification handshake with the challenge it was given', async () => {
    const { t } = transport();
    const response = await t.http!.handle(signed(JSON.stringify({ type: 'url_verification', challenge: 'c-123' })));
    expect(response.status).toBe(200);
    expect(JSON.parse(response.body ?? '{}')).toEqual({ challenge: 'c-123' });
    expect(response.refusal).toBeUndefined();
  });

  it('refuses an unsigned request, a badly signed one and a stale one, each by its own reason', async () => {
    const { t } = transport();
    const body = eventCallback(channelMention);
    const unsigned = { method: 'POST', path: '', headers: { 'content-type': 'application/json' }, body };
    expect((await t.http!.handle(unsigned)).refusal).toEqual({ reason: 'missing_signature' });
    const wrong = signed(body);
    expect(
      (await t.http!.handle({ ...wrong, headers: { ...wrong.headers, 'x-slack-signature': 'v0=nope' } })).refusal,
    ).toEqual({ reason: 'bad_signature' });
    const old = String(Math.floor(Date.now() / 1000) - 3600);
    expect(
      (
        await t.http!.handle({
          ...wrong,
          headers: { ...wrong.headers, 'x-slack-request-timestamp': old, 'x-slack-signature': signRequest(SECRET, old, body) },
        })
      ).refusal,
    ).toEqual({ reason: 'stale_timestamp' });
  });

  it('drops nothing of a refused request into the answer', async () => {
    const { t } = transport();
    const body = eventCallback({ ...channelMention, text: 'a-secret-sentence' });
    const response = await t.http!.handle({ method: 'POST', path: '', headers: {}, body });
    expect(response.status).toBe(401);
    expect(response.body ?? '').not.toContain('a-secret-sentence');
  });

  it('refuses a content type it does not serve', async () => {
    const response = await transport().t.http!.handle(signed('<xml/>', 'application/xml'));
    expect(response.status).toBe(415);
    expect(response.refusal).toEqual({ reason: 'unsupported_media_type' });
  });

  it('runs the pipeline for an event callback, after acknowledging it', async () => {
    const { t } = transport();
    await t.events.start();
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    const response = await t.http!.handle(signed(eventCallback(channelMention)));
    // Acknowledged before the turn: Slack retries anything it has not heard about in 3 seconds.
    expect(response.status).toBe(200);
    expect(seen).toHaveLength(0);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      userId: 'U0PERSON',
      channel: 'C0ROOM',
      mentioned: true,
      teamId: 'T0WORKSPACE',
      files: [],
    });
  });

  it('asks who this app is once, at start, and strips that mention from the text', async () => {
    const { t, api } = transport();
    await t.events.start();
    // One `auth.test`, at start, and not one per delivery: it is the identity a socket's context
    // used to carry, and it does not change while a process runs.
    expect(api.authTestCalls).toBe(1);
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    await t.http!.handle(signed(eventCallback({ ...channelMention, text: '<@U0BOTUSER> hello there' })));
    await settle();
    expect(seen[0].text).toBe('hello there');
    expect(api.authTestCalls).toBe(1);
  });

  it('drops a retried delivery and tells Slack not to send it again', async () => {
    const { t } = transport();
    await t.events.start();
    const seen: SlackInbound[] = [];
    t.events.onMessage(async (message) => {
      seen.push(message);
    });
    const response = await t.http!.handle(signed(eventCallback(channelMention), 'application/json', { 'x-slack-retry-num': '1' }));
    expect(response.status).toBe(200);
    expect(response.headers?.['x-slack-no-retry']).toBe('1');
    await settle();
    // The first delivery is either in flight or finished; a second turn on one message is worse
    // than a message answered once and slowly.
    expect(seen).toEqual([]);
  });

  it('ignores an event it has no rule for, and says so to nobody', async () => {
    const { t } = transport();
    await t.events.start();
    t.events.onMessage(async () => {
      throw new Error('this event should not have been delivered');
    });
    for (const body of [
      eventCallback({ type: 'reaction_added', channel: 'C0ROOM', ts: '1789000000.000200' }),
      JSON.stringify({ type: 'event_callback' }),
      JSON.stringify({ type: 'something_new' }),
    ]) {
      expect((await t.http!.handle(signed(body))).status, body).toBe(200);
    }
    await settle();
  });

  it('refuses a body that is not the JSON it was told it would be', async () => {
    expect((await transport().t.http!.handle(signed('not json'))).refusal).toEqual({ reason: 'bad_request' });
  });
});

describe('the Slack transport and an interaction', () => {
  const form = (payload: unknown): string => `payload=${encodeURIComponent(JSON.stringify(payload))}`;

  it('delivers a block action to the session s action handler, which is where approvals listen', async () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    const seen: ActionEvent[] = [];
    session.onAction(async (event) => {
      seen.push(event);
    });
    const body = form({
      type: 'block_actions',
      user: { id: 'U0LEAD' },
      channel: { id: 'C0DEMO' },
      trigger_id: 'T-1',
      message: { ts: '1789000000.000300' },
      actions: [{ action_id: 'approve', value: 'a-uuid' }],
    });
    const response = await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'));
    expect(response.status).toBe(200);
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      surface: 'slack',
      userId: 'U0LEAD',
      conversation: 'C0DEMO',
      actionId: 'approve',
      value: 'a-uuid',
      trigger: 'T-1',
    });
  });

  it('delivers a view submission with its metadata and its values', async () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    const seen: FormEvent[] = [];
    session.onFormSubmit(async (event) => {
      seen.push(event);
    });
    const body = form({
      type: 'view_submission',
      user: { id: 'U0LEAD' },
      view: {
        callback_id: 'approval_edit',
        private_metadata: 'an-approval-id',
        state: { values: { note_block: { note_input: { value: 'not this week' } } } },
      },
    });
    const response = await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'));
    // An empty 200 is what closes the modal, which is what accepting a submission means.
    expect(response.status).toBe(200);
    expect(response.body ?? '').toBe('');
    await settle();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ userId: 'U0LEAD', formId: 'approval_edit', metadata: 'an-approval-id' });
  });

  it('refuses a form body with no payload, and one whose payload is not JSON', async () => {
    const { t } = transport();
    for (const body of ['', 'nothing=here', 'payload=not-json']) {
      expect((await t.http!.handle(signed(body, 'application/x-www-form-urlencoded'))).refusal, body).toEqual({
        reason: 'bad_request',
      });
    }
  });

  it('acknowledges an interaction it has no rule for rather than failing it', async () => {
    const { t } = transport();
    expect(
      (await t.http!.handle(signed(form({ type: 'shortcut' }), 'application/x-www-form-urlencoded'))).status,
    ).toBe(200);
  });
});

describe('the session over this transport', () => {
  it('offers the transport s door as its own, so the host can mount it', () => {
    const { t } = transport();
    const session = createSlackSession(t, slackConfig(env));
    expect(session.http?.path).toBe(SLACK_MOUNT_PATH);
  });
});
```

Note the message cases do not exercise `MessageEvent`: the session's own mapping from `SlackInbound` to `MessageEvent` is `session.test.ts`'s subject and is unchanged by this plan, which is why that type is not imported here. `unused-imports/no-unused-imports` is an error in this workspace, so an import nothing uses fails `pnpm lint` rather than warning.

- [ ] **Step 8: Run it to verify it fails**

Run: `pnpm --filter @harness/surface-slack exec vitest run src/transport/events.test.ts`
Expected: FAIL — `./events.js` does not exist.

- [ ] **Step 9: Write the transport**

Create `surfaces/slack/src/transport/events.ts`:

```ts
import { WebClient } from '@slack/web-api';
import type { Logger } from '@harness/shared';
import type { SurfaceHttpRequest, SurfaceHttpResponse } from '@harness/surface-api';
import type { SlackConfig } from '../config.js';
import { classifyInbound, createThreadMemory, type BotIdentity } from './classify.js';
import { downloadAttachments } from './files.js';
import { verifySignature } from './signature.js';
import type {
  RawMessage,
  SlackAction,
  SlackApi,
  SlackEvents,
  SlackInbound,
  SlackTransport,
  SlackView,
} from './types.js';
import { webClientApi } from './web-client.js';

/**
 * Where Slack delivers: one URL for the Events API and for Interactivity alike.
 *
 * Both request URLs in an app's configuration point here. One handler rather than two because the
 * two payloads differ only in their content type, and two mounts would be two things to configure
 * and one more way for an app to be half set up.
 */
export const SLACK_MOUNT_PATH = 'slack/events';

/** An acknowledgement: 200 and nothing else, within the three seconds Slack allows. */
const ACK: SurfaceHttpResponse = { status: 200 };

/** The envelope of an Events API delivery, narrowed to what is read here. */
interface EventEnvelope {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: { type?: string; channel?: string; ts?: string } & Record<string, unknown>;
}

/** An interaction payload, narrowed to what is read here. */
interface InteractivePayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  trigger_id?: string;
  message?: { ts?: string };
  actions?: { action_id?: string; value?: string }[];
  view?: {
    callback_id?: string;
    private_metadata?: string;
    state?: { values?: Record<string, Record<string, { value?: string | null }>> };
  };
}

/** The two event types the classifier has rules for, and only when they carry what it reads. */
function inboundOf(envelope: EventEnvelope): RawMessage | null {
  const event = envelope.event;
  if (!event || (event.type !== 'message' && event.type !== 'app_mention')) return null;
  if (typeof event.channel !== 'string' || typeof event.ts !== 'string') return null;
  return event as unknown as RawMessage;
}

/**
 * A real Slack connection, over HTTPS, holding no socket.
 *
 * The host mounts `http` at `/tenants/<clientId>/slack/events` and hands over every request that
 * arrives there. Nothing here is connected: `start()` asks Slack who this app is and that is all
 * it does, so a paused host resumes by answering its next request, and a pooled host serves as
 * many workspaces as it has tenants — which is the whole reason socket mode goes (spec decision
 * 9).
 *
 * **Acknowledge, then run.** Slack retries a delivery it has not heard about within three seconds
 * and a turn takes seconds to minutes, so every accepted request is answered before the work
 * starts and the work is reported to the log if it fails. A retried delivery is dropped rather
 * than deduplicated: the only duplicate this can see is one Slack sent, the first copy is already
 * in flight or finished, and a table of event ids is a write on the hot path plus a sweep.
 *
 * Both interaction registrations are catch-alls, as the socket's were: the contract takes one
 * action handler and one view handler and dispatches on the id itself, so there is nothing to
 * route here. An interaction this host did not post is acknowledged and dropped by the handler
 * above rather than ignored here — acknowledging something unknown costs nothing, and leaving it
 * unacknowledged shows a person an error for a message this host has no opinion about.
 *
 * `api` is a parameter with a default rather than a construction, for one reason: `start()` calls
 * `auth.test`, and every other Web API call this transport makes goes through the same slice, so
 * a suite that could not substitute `FakeSlack` here would reach slack.com. `index.ts` calls this
 * with three arguments and gets a real `WebClient`.
 */
export function eventsTransport(
  config: SlackConfig,
  log: Logger,
  storageDir: string,
  api: SlackApi = webClientApi(new WebClient(config.botToken)),
): SlackTransport {
  const threads = createThreadMemory(api, log);

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;
  let messageHandler: ((message: SlackInbound) => Promise<void>) | null = null;
  /** Who this app is, from `auth.test` at `start()`. A socket's context used to carry it. */
  let bot: BotIdentity = {};

  /** Start work this request has already been acknowledged for; a failure is a log line. */
  const later = (what: string, run: () => Promise<void>): void => {
    void run().catch((err: unknown) => log.error(`${what} failed`, err));
  };

  const deliver = async (raw: RawMessage, teamId: string | undefined): Promise<void> => {
    const handler = messageHandler;
    if (!handler) {
      log.warn('a Slack message arrived before a handler was registered');
      return;
    }
    const classified = await classifyInbound(raw, bot, threads);
    if (!classified) return;
    // The reply the host writes names this message, and only the transport sees which thread it
    // belongs to: a mention inside an existing thread carries a root that is not its own
    // timestamp. Recorded only for a message that will be answered, so ordinary channel chatter
    // does not fill the store.
    if (classified.mentioned) threads.noteInbound(raw.channel, raw.ts, raw.thread_ts ?? raw.ts);
    const files = await downloadAttachments(raw.ts, classified.files, { token: config.botToken, storageDir, log });
    await handler({
      userId: classified.userId,
      channel: raw.channel,
      text: classified.text,
      ts: raw.ts,
      threadTs: raw.thread_ts ?? null,
      mentioned: classified.mentioned,
      files,
      // The event's own `team` where Slack sends one, and the envelope's otherwise: a delivery
      // carries the workspace on the envelope, and the two agree.
      teamId: raw.team ?? teamId ?? null,
    });
  };

  const handleEvent = (body: string): SurfaceHttpResponse => {
    let envelope: EventEnvelope;
    try {
      envelope = JSON.parse(body) as EventEnvelope;
    } catch {
      return { status: 400, refusal: { reason: 'bad_request' } };
    }
    // The one-time handshake when a request URL is saved in an app's configuration. It is signed
    // like everything else, so this answers only a URL whose secret is already right.
    if (envelope.type === 'url_verification') {
      if (typeof envelope.challenge !== 'string') return { status: 400, refusal: { reason: 'bad_request' } };
      return {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ challenge: envelope.challenge }),
      };
    }
    const raw = envelope.type === 'event_callback' ? inboundOf(envelope) : null;
    if (raw) {
      const teamId = envelope.team_id;
      later('a Slack delivery', () => deliver(raw, teamId));
    }
    return ACK;
  };

  const handleInteractive = (body: string): SurfaceHttpResponse => {
    const raw = new URLSearchParams(body).get('payload');
    if (raw === null) return { status: 400, refusal: { reason: 'bad_request' } };
    let payload: InteractivePayload;
    try {
      payload = JSON.parse(raw) as InteractivePayload;
    } catch {
      return { status: 400, refusal: { reason: 'bad_request' } };
    }
    if (payload.type === 'block_actions') {
      const action = payload.actions?.[0];
      const handler = actionHandler;
      if (!action) return ACK;
      if (!handler) {
        log.warn('a Slack action arrived before a handler was registered');
        return ACK;
      }
      const mapped: SlackAction = {
        userId: payload.user?.id ?? 'unknown',
        // The channel the interactive message lives in.
        channel: payload.channel?.id ?? '',
        actionId: action.action_id ?? '',
        value: action.value ?? '',
        triggerId: payload.trigger_id ?? null,
        messageTs: payload.message?.ts ?? null,
      };
      later('a Slack action', () => handler(mapped));
      return ACK;
    }
    if (payload.type === 'view_submission') {
      const view = payload.view;
      const handler = viewHandler;
      if (!view) return ACK;
      if (!handler) {
        log.warn('a Slack view submission arrived before a handler was registered');
        return ACK;
      }
      const mapped: SlackView = {
        userId: payload.user?.id ?? 'unknown',
        callbackId: view.callback_id ?? '',
        privateMetadata: view.private_metadata ?? '',
        state: view.state?.values ?? {},
      };
      later('a Slack view submission', () => handler(mapped));
      // An empty 200 closes the modal, which is what accepting a submission means.
      return ACK;
    }
    return ACK;
  };

  const handle = async (request: SurfaceHttpRequest): Promise<SurfaceHttpResponse> => {
    const check = verifySignature({
      signature: request.headers['x-slack-signature'],
      timestamp: request.headers['x-slack-request-timestamp'],
      body: request.body,
      secret: config.signingSecret,
      nowSeconds: Math.floor(Date.now() / 1000),
    });
    // Before the body is parsed and before anything else is read off it (invariant 15). The host
    // writes the one audit row; this says only which kind of refusal it was.
    if (!check.ok) {
      return { status: check.reason === 'stale_timestamp' ? 400 : 401, refusal: { reason: check.reason } };
    }
    // After the signature, so an unverified request cannot suppress a retry it invented, and
    // before the content-type branch, so one rule covers everything that arrives here. Only the
    // Events API retries — Slack does not resend an interaction — so for an interactivity POST
    // this is a branch that never fires rather than behaviour anyone depends on.
    if (request.headers['x-slack-retry-num'] !== undefined) {
      log.warn('a retried Slack delivery was dropped; the first one is in flight or already done');
      return { status: 200, headers: { 'x-slack-no-retry': '1' } };
    }
    const contentType = (request.headers['content-type'] ?? '').split(';')[0].trim();
    if (contentType === 'application/json') return handleEvent(request.body);
    if (contentType === 'application/x-www-form-urlencoded') return handleInteractive(request.body);
    return { status: 415, refusal: { reason: 'unsupported_media_type' } };
  };

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    onMessage(handler) {
      messageHandler = handler;
    },
    /**
     * Ask Slack who this app is. That is the whole of starting: nothing is connected.
     *
     * The bot's own user id is what the mention stripper removes and what the thread rule matches
     * a thread's messages against, and a socket's connection context used to carry both. One call
     * here means a wrong token fails this tenant's open, loudly, instead of quietly classifying
     * every message as though nobody had been mentioned.
     */
    async start() {
      const identity = await api.auth.test();
      bot = { userId: identity.user_id, botId: identity.bot_id };
      log.info('ready for Slack events over HTTPS');
    },
    /**
     * Nothing to close. The handlers are dropped so a tenant that is shutting down cannot be
     * delivered into by a request that arrives while its surfaces are being stopped.
     */
    async stop() {
      actionHandler = null;
      viewHandler = null;
      messageHandler = null;
    },
  };

  return {
    api,
    events,
    notePostedIn: (channel, threadTs) => threads.notePostedIn(channel, threadTs),
    http: { path: SLACK_MOUNT_PATH, handle },
  };
}
```

- [ ] **Step 10: Thread the door through the session**

In `surfaces/slack/src/session.ts`, add one line to the returned object, immediately after `directory`:

```ts
    // The host mounts this and hands over what arrives; the transport verifies it. Spread rather
    // than assigned, because a session over the fake transport has no door and the contract's
    // `http` is optional rather than nullable.
    ...(transport.http ? { http: transport.http } : {}),
```

- [ ] **Step 11: Read the document's variable names**

In `harness/surface-api/src/types.ts`, add to `SurfaceDeps`, after `tenantKey`:

```ts
  /**
   * The environment variable this client's document named for each of this surface's credentials,
   * keyed by the document's own field name — `{ botToken: 'SLACK_BOT_TOKEN' }`.
   *
   * The counterpart of `Surface.secrets`, which says what an adapter reads: this says what *this
   * tenant* calls it. An adapter falls back to the conventional name for a field the document did
   * not name, so a single-tenant deployment configures nothing; two tenants in one process name
   * two pairs, and neither adapter can read the other's.
   */
  secrets?: Readonly<Record<string, string>>;
```

In `harness/config-api/src/document.ts`, give `surfaceSecretsOf` the field name:

```ts
/**
 * Every environment variable this document's surfaces refer to, with the surface that named it
 * and the field it was named under.
 *
 * The same reason `tenantKeysOf` exists: the typed surface sections are read here, so the host
 * never is. A host that checked a `signingSecret` by name would have a vendor's field in the one
 * process every client runs, which `kernel-vocabulary.test.ts` forbids `harness/host/src`. `field`
 * travels as an opaque string: the host copies it into the bag the adapter is handed, and the
 * adapter — which is allowed to know what its own fields are called — looks its variable up. The
 * value itself never appears: a `SecretRef` names a variable and the deployment's environment
 * holds what it is worth.
 */
export function surfaceSecretsOf(document: ClientDocument): { surface: string; field: string; env: string }[] {
  const secrets: { surface: string; field: string; env: string }[] = [];
  const slack = document.surfaces.slack;
  if (slack) {
    secrets.push(
      { surface: 'slack', field: 'signingSecret', env: slack.signingSecret.env },
      { surface: 'slack', field: 'botToken', env: slack.botToken.env },
    );
  }
  return secrets;
}
```

and in `harness/config-api/src/document.test.ts`, update the one assertion:

```ts
    expect(surfaceSecretsOf(withSlack)).toEqual([
      { surface: 'slack', field: 'signingSecret', env: 'SLACK_SIGNING_SECRET' },
      { surface: 'slack', field: 'botToken', env: 'SLACK_BOT_TOKEN' },
    ]);
```

- [ ] **Step 12: Hand a surface its own settings**

In `harness/approvals/src/domain/surfaces/registry.ts`, replace the `tenantKeys` parameter:

```ts
/**
 * What one client's document says about one of its surfaces, beyond declaring it.
 *
 * Two opaque things, neither of which this package reads: the key an inbound event's tenant hint
 * is matched against, and the environment variable the document named for each of that surface's
 * credentials. Both are built in the host from `@harness/config-api`, which is the one place a
 * typed surface section is read.
 */
export interface SurfaceSettings {
  readonly tenantKey?: string;
  readonly secrets?: Readonly<Record<string, string>>;
}

export async function loadSurfaces(
  names: string[],
  deps: SurfaceDeps,
  settings: Readonly<Record<string, SurfaceSettings>> = {},
): Promise<LoadedSurfaces> {
```

and the `connect` loop's body:

```ts
  const sessions: SurfaceSession[] = [];
  for (const { specifier, surface } of declared) {
    try {
      // Own keys only: `in` would hand an adapter that called itself `constructor` whatever
      // `Object.prototype` has under that name. Absent rather than undefined for a surface the
      // document said nothing about, so an adapter's own default applies.
      const own = Object.hasOwn(settings, surface.name) ? settings[surface.name] : undefined;
      sessions.push(await surface.connect(own ? { ...deps, ...own } : deps));
    } catch (err) {
      surfaceFailed(specifier, err, 'connect');
    }
  }
```

Export the type from `harness/approvals/src/index.ts`, beside `loadSurfaces`:

```ts
export { loadSurfaces, surfacesOf, type LoadedSurfaces, type SurfaceSettings } from './domain/surfaces/registry.js';
```

(match the line's existing shape in that file; only `SurfaceSettings` is added.)

In `harness/host/src/domain/tenancy/tenant.ts`, build the bag:

```ts
  // What the document says about each surface it declares: the key an inbound event's hint is
  // matched against, and the variable it named for each credential. Both come out of
  // `@harness/config-api`, which is where the typed surface sections are read, so this file names
  // no surface's own field — `field` is as opaque here as `env` already was.
  const settings: Record<string, SurfaceSettings> = {};
  for (const { surface, key } of tenantKeysOf(document)) {
    settings[surface] = { ...settings[surface], tenantKey: key };
  }
  for (const { surface, field, env } of surfaceSecretsOf(document)) {
    settings[surface] = { ...settings[surface], secrets: { ...settings[surface]?.secrets, [field]: env } };
  }
  const surfaces = await loadSurfaces(
    surfaceNamesOf(document).map(surfaceSpecifier),
    { env: pool.env, log, storageDir: config.storageDir },
    settings,
  );
```

adding `SurfaceSettings` to the `@harness/approvals` type import.

- [ ] **Step 13: Read the named variables, and drop the app token**

Replace `surfaces/slack/src/config.ts` whole:

```ts
import { requiredEnv, type EnvSource } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  /** What every inbound request is verified against: the app's signing secret. */
  signingSecret: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/**
 * Read this adapter's configuration out of the environment the host handed over.
 *
 * `deps.env` only, never the ambient environment: whoever builds the bag decides what an adapter
 * can see, which is what stops a suite from reaching a real workspace because the machine running
 * it has a filled-in `.env`. One app: chat and approvals share it, so there is one bot token — and
 * one signing secret, because there is one URL Slack delivers to.
 *
 * `secrets` is what this client's document named, field by field. A deployment that uses the
 * conventional variables — every deployment today — declares nothing and gets them; one running
 * two workspaces in one process names two pairs, and each tenant's adapter reads its own.
 */
export function slackConfig(env: EnvSource, secrets: Readonly<Record<string, string>> = {}): SlackConfig {
  return {
    botToken: requiredEnv(
      secrets.botToken ?? 'SLACK_BOT_TOKEN',
      ' (the Slack app the host posts as; see docs/runbook.md)',
      env,
    ),
    signingSecret: requiredEnv(
      secrets.signingSecret ?? 'SLACK_SIGNING_SECRET',
      ' (the Slack app signing secret, which every inbound request is verified against; see docs/runbook.md)',
      env,
    ),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
```

Replace `surfaces/slack/src/index.ts` whole:

```ts
import { defineSurface, type Surface } from '@harness/surface-api';
import { slackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { eventsTransport } from './transport/events.js';

/**
 * Slack, as one messaging surface among several.
 *
 * The host loads this by the name a client document's `surfaces` gives and holds nothing but the
 * contract, so every Slack-shaped thing — Block Kit, a signed request, a `C…` channel id, a `ts` —
 * is behind this package's boundary. What the renderers emit is pinned byte for byte by their own
 * tests, because the cards in a live workspace must not change shape.
 *
 * This adapter holds no connection. Slack delivers to the URL the host mounts, and `start()` only
 * asks who this app is.
 */
export const surface: Surface = defineSurface({
  name: 'slack',
  version: '0.1.0',
  // The token this app posts as, and the secret every inbound request is verified against. There
  // is no app-level token: nothing here opens a socket.
  secrets: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET'],
  // Not `async`: building the transport opens nothing, so there is nothing here to await.
  connect: (deps) => {
    const config = slackConfig(deps.env, deps.secrets ?? {});
    return Promise.resolve(createSlackSession(eventsTransport(config, deps.log, deps.storageDir), config));
  },
});
```

In `surfaces/slack/src/index.test.ts`, the one assertion becomes:

```ts
    expect([...surface.secrets].sort()).toEqual(['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET']);
```

and one case is added, because otherwise the conventional names are the only path the suite ever
takes and the whole of decision 12 — a tenant naming its own variables — is untested:

```ts
import { createLogger } from '@harness/shared';

  it("reads the variables this client's document named, not the conventional ones", async () => {
    // Two tenants in one process hold two apps, so the variable an adapter reads is the one its
    // own document named. `deps.secrets` is field name to variable name, built in the host from
    // `surfaceSecretsOf`, and absent for a deployment that named nothing.
    const deps = {
      env: {
        TENANT_A_BOT: 'xoxb-tenant-a',
        TENANT_A_SIGNING: 'tenant-a-signing',
        SLACK_APPROVALS_CHANNEL: 'C0TEST',
      },
      log: createLogger('test'),
      storageDir: '/nonexistent',
      secrets: { botToken: 'TENANT_A_BOT', signingSecret: 'TENANT_A_SIGNING' },
    };
    // It connects on those two names alone: the conventional ones are not in this environment at
    // all, so a `connect` that reached for them would throw a ConfigError naming them.
    await expect(surface.connect(deps)).resolves.toMatchObject({ name: 'slack' });
    // And a document that named one variable this deployment does not set fails with that name.
    await expect(
      surface.connect({ ...deps, secrets: { ...deps.secrets, signingSecret: 'TENANT_B_SIGNING' } }),
    ).rejects.toThrow(/TENANT_B_SIGNING/);
  });
```

In `surfaces/slack/src/testing.ts`, the config literal's `appToken: 'xapp-test'` becomes `signingSecret: 'a-signing-secret'`, and the comment above `fakeSlackSession` that says "never through `boltTransport`" becomes "never through `eventsTransport`".

In `harness/approvals/src/domain/surfaces/registry.test.ts`, the Slack case's environment and its comment:

```ts
  it('loads slack and http together, in the documented order, with slack primary', async () => {
    // Slack's `connect` builds a transport from env and opens nothing: there is no socket to
    // open any more, and `start()` — which `loadSurfaces` never calls — is the only thing that
    // reaches Slack at all. A fake token is enough to prove the two load together.
    const slackDeps = {
      ...deps,
      env: { SLACK_BOT_TOKEN: 'xoxb-test', SLACK_SIGNING_SECRET: 'a-signing-secret', SLACK_APPROVALS_CHANNEL: 'C0TEST' },
    };
```

- [ ] **Step 14: Delete Bolt**

```
git rm surfaces/slack/src/transport/bolt.ts
```

and in `surfaces/slack/package.json`, delete the `"@slack/bolt": "^5.1.0",` line. `@slack/web-api` stays, at `^8.1.1`, and is now imported for its value rather than its type.

Then:

```
pnpm install
```

Expected: the lockfile loses `@slack/bolt`, `@slack/oauth`, `@slack/socket-mode`, `@slack/logger` and the `@types/express` peer, and gains nothing. Check with `git diff --stat pnpm-lock.yaml` that it only shrank.

- [ ] **Step 15: Run the affected suites to verify they pass**

Run:
```bash
pnpm --filter @harness/surface-slack test
pnpm --filter @harness/config-api test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test pnpm --filter @harness/approvals test
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test pnpm --filter @harness/host test
```
Expected: PASS. `grep -rn "bolt\|@slack/bolt" surfaces/slack/src` returns nothing; `grep -rn "SLACK_APP_TOKEN" --include="*.ts" .` returns only `harness/core-tools/src/app/surface.test.ts`, which Task 4 edits.

- [ ] **Step 16: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `git status --short docs/architecture` is empty — the recorder's fixture document declares no Slack section, so neither snapshot moves.

- [ ] **Step 17: Commit**

```
git add surfaces/slack harness/surface-api harness/config-api harness/approvals harness/host pnpm-lock.yaml
git commit -m "feat(slack): take events over HTTPS with a verified signature and delete socket mode"
```

---

### Task 4: Compose pulls the published image, and CI stops building through Compose

**Files:**
- Modify: `harness/compose/docker-compose.yml` (two `image:` keys, three `build:` blocks gone, one service gone, `SLACK_APP_TOKEN` gone)
- Delete: `harness/compose/core-tools.Dockerfile`, `.env.ci` (its one consumer is the CI command this task replaces)
- Modify: `.gitignore` (the `!.env.ci` negation goes with the file)
- Modify: `harness/core-tools/src/app/record-surface.ts` (no `build-only` profile to render)
- Modify: `harness/core-tools/src/app/surface.test.ts` (the service list, the image, the two Slack variables)
- Modify: `docs/architecture/compose-surface.yaml` (**re-recorded — the only task in this plan that touches it**)
- Modify: `.env.example`
- Modify: `.github/workflows/ci.yml` (the `images` job)
- Modify: root `package.json` (`demo:up` no longer builds)

**Interfaces:**
- Produces: `HARNESS_IMAGE_TAG`, a Compose-only variable; the image references `ghcr.io/mgavrila/agent-harness-host` and `ghcr.io/mgavrila/agent-harness-files`.
- Consumes: nothing. The images do not exist yet — Task 7 is what pushes them — and that is fine: nothing in the gates starts a container, and the first `docker compose up` after this plan merges needs a tag the user has released.

**Both built images get a published name, not just the host's.** Decision 8 removes every `build:` block, and the `files` worker is built from the checkout today; a Compose file with no build instruction and no image for that service would not start. So the two images are released together, under one tag, and `release.yml` pushes both.

- [ ] **Step 1: Write the failing test**

In `harness/core-tools/src/app/surface.test.ts`, change three cases in `describe('the Compose stack names no client and mounts no socket')`. First, the image and the four services:

```ts
  it('runs the host, not an approvals process, and names no plug-in the document names', async () => {
    const { services } = parseYaml(await rendered()) as {
      services: Record<string, { environment?: Record<string, string>; image?: string; build?: unknown }>;
    };
    expect(services.approvals).toBeUndefined();
    // A published image, pulled by tag. Nothing in this stack is built from a checkout any more:
    // a deployment runs a version somebody released, not whatever the working tree happened to
    // hold (spec section 7).
    expect(services.host.image).toBe('ghcr.io/mgavrila/agent-harness-host:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG in .env}');
    expect(services.files.image).toBe('ghcr.io/mgavrila/agent-harness-files:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG in .env}');
    for (const [name, service] of Object.entries(services)) {
      expect(service.build, name).toBeUndefined();
    }
    // What is still this deployment's: which client it serves, and who it serves as.
    for (const name of ['HARNESS_CLIENT', 'HARNESS_HOST_PRINCIPAL']) {
      expect(services.host.environment?.[name], name).toBeDefined();
    }
    // Every plug-in a client names is the document's, not a variable's: its surfaces, its
    // runtime, its identity provider, its policy and its packs.
    for (const name of [
      'HARNESS_SURFACES',
      'HARNESS_RUNTIME',
      'HARNESS_IDENTITY',
      'HARNESS_POLICY_FILE',
      'HARNESS_PACKS',
    ]) {
      expect(services.host.environment?.[name], name).toBeUndefined();
    }
    expect(services.host.environment?.SLACK_ALLOWED_USERS).toBeUndefined();
  });

  it('runs exactly the four services a deployment needs, and no Hermes', async () => {
    const { services } = parseYaml(await rendered()) as { services: Record<string, unknown> };
    // `core-tools` is gone with the build: it was never started, and the only thing it proved was
    // that an image still builds — which is a CI job's business, not a deployment's.
    expect(Object.keys(services).sort()).toEqual(['files', 'host', 'litellm', 'postgres']);
    expect(await rendered()).not.toMatch(/hermes/i);
  });

  it('gives the host the one Slack app: a token to post with and a secret to verify with', async () => {
    const { services } = parseYaml(await rendered()) as {
      services: Record<string, { environment?: Record<string, string> }>;
    };
    expect(services.host.environment?.SLACK_BOT_TOKEN).toBeDefined();
    expect(services.host.environment?.SLACK_SIGNING_SECRET).toBeDefined();
    // Socket mode is gone, and so is the app-level token it needed.
    expect(services.host.environment?.SLACK_APP_TOKEN).toBeUndefined();
    expect(Object.keys(services.host.environment ?? {}).filter((k) => k.startsWith('APPROVALS_SLACK'))).toEqual([]);
  });
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/app/surface.test.ts`
Expected: FAIL — the recorded snapshot still has five services, `image: harness-host` and `SLACK_APP_TOKEN`.

- [ ] **Step 3: Make Compose pull**

In `harness/compose/docker-compose.yml`:

Rewrite the header comment's third sentence, which describes a service that is about to stop existing:

```yaml
# The harness stack.
#
# `postgres` and `litellm` have no profile, so they start with a bare
# `docker compose up`: the database and the model gateway are what everything
# else needs. `files` and `host` are the `demo` profile, and `pnpm demo:up`
# brings up the whole client instance. Nothing here is built: both images are
# pulled by tag from the container registry, and `HARNESS_IMAGE_TAG` in .env
# says which release this deployment runs. No client is named or baked in here:
# the host mounts whatever directory `HARNESS_CLIENTS_DIR` points at, or reads
# the database, and onboarding a client is a document outside this repository,
# never an edit here. No service mounts the Docker socket.
```

**In both service blocks below, only two things change: the three-line `build:` block is deleted
and the `image:` line is replaced.** Everything else each service already declares —
`restart`, `networks`, `environment`, `volumes`, `healthcheck`, `depends_on`, and the comments
above them — stays exactly where it is. The snippets show the first two keys of the service, not
the whole of it.

In the `files` service:

```yaml
  files:
    image: ghcr.io/mgavrila/agent-harness-files:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG in .env}
    profiles: ['demo']
    # ... restart, networks, environment, volumes and healthcheck unchanged
```

Delete the whole `core-tools:` service, including the three comment lines above it.

In the `host` service:

```yaml
  host:
    image: ghcr.io/mgavrila/agent-harness-host:${HARNESS_IMAGE_TAG:?set HARNESS_IMAGE_TAG in .env}
    profiles: ['demo']
    # ... restart, networks, depends_on, environment, ports and volumes unchanged
```

and in its `environment:` map, delete the `SLACK_APP_TOKEN` line and rewrite the comment above `SLACK_BOT_TOKEN`:

```yaml
      # The one Slack app: the token the host posts as, and the signing secret every inbound
      # request is verified against. Slack delivers to a URL now — there is no app-level token
      # and nothing here holds a connection.
      SLACK_BOT_TOKEN: '${SLACK_BOT_TOKEN:-}'
```

Leave everything else in the `host` service — the ports, the volumes, the networks, the other twenty-five variables — exactly as it is.

Then:

```
git rm harness/compose/core-tools.Dockerfile
```

It had one consumer, the service just deleted.

- [ ] **Step 4: Stop rendering a profile that no longer exists**

In `harness/core-tools/src/app/record-surface.ts`, drop the two `'--profile', 'build-only',` argument lines from `readComposeSurface`, and rewrite the last paragraph of its doc comment:

```ts
 * The `demo` profile is needed because `config` omits services whose profile is not enabled, and
 * every service but `postgres` and `litellm` has one.
```

- [ ] **Step 5: Document the tag**

In `.env.example`, add a block immediately after the `HARNESS_ENCRYPTION_KEY` lines and before "Where a client comes from":

```
# --- Which release this deployment runs ---------------------------------------
# The tag of the published images Compose pulls: ghcr.io/mgavrila/agent-harness-host
# and ...-files, both pushed by the release workflow from one tag. Required, with
# no default, because a stack that silently ran `latest` would change under a
# deployment that had not asked it to. See docs/runbook.md, "Releasing".
HARNESS_IMAGE_TAG=0.2.0
```

In `.env.example`'s Slack block, delete the `SLACK_APP_TOKEN=` line. Leave the prose about socket mode for now: Task 8 rewrites the whole block, and a variable that no longer exists in code or Compose fails nothing by being described in a comment.

**Delete `.env.ci`**, and delete the `!.env.ci` negation from `.gitignore`'s secrets block:

```
git rm .env.ci
```

It existed for exactly one command — `docker compose --env-file .env.ci … build`, at `ci.yml:69`,
which Step 6 replaces — and it is named nowhere else in the repository (`ci.yml:6`'s comment is
rewritten in the same step; `grep -rn "\.env\.ci" .` finds no other reader). Keeping it with a
`HARNESS_IMAGE_TAG=ci` line would leave a file whose own header describes a build that no longer
happens, and whose one variable is a tag nothing pulls. Nothing else needs it: `pnpm surface:record`
renders with `--no-interpolate`, so Compose expands no variable and requires no value.

- [ ] **Step 6: Build the images directly in CI**

In `.github/workflows/ci.yml`, replace the `images` job:

```yaml
  images:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # Compose pulls published images now, so there is nothing for it to build. These are the two
      # builds release.yml pushes on a tag; here they only prove the Dockerfiles still build, and
      # nothing is pushed or tagged for a registry.
      - name: Build the host image
        run: docker build -f harness/compose/node.Dockerfile -t agent-harness-host:ci .
      - name: Build the files worker image
        run: docker build -f harness/compose/files.Dockerfile -t agent-harness-files:ci .
```

and the workflow's header comment's last sentence, which is the file's other mention of the file
this task deletes ("The image job builds every image the Compose stack defines, with placeholder
values from .env.ci."):

```yaml
# The image job builds both images the release workflow publishes, and pushes neither.
```

After this step, `grep -rn "\.env\.ci" .` (outside `node_modules`) finds nothing.

In the root `package.json`, `demo:up` stops asking for a build:

```json
    "demo:up": "docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d",
```

- [ ] **Step 7: Re-record the Compose snapshot**

Run: `pnpm surface:record`

Then check what moved:

```bash
git diff --stat docs/architecture
```

Expected: `docs/architecture/compose-surface.yaml` only. **If `tool-surface.json` moved, stop and find out why** — nothing in this task touches a tool, and a moved tool surface means something else changed.

Read the diff of `compose-surface.yaml` and confirm it is exactly: the `core-tools` service gone; `files` and `host` carrying an `image:` with the registry path and no `build:`; `SLACK_APP_TOKEN` gone from the host's environment. `docker` has to be on PATH for this step; the stack does not have to be running.

- [ ] **Step 8: Run the suites to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/core-tools test
```
Expected: PASS, including the byte-for-byte compose comparison and the environment-scan case.

- [ ] **Step 9: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `git status --short docs/architecture` shows `compose-surface.yaml` modified and nothing else.

- [ ] **Step 10: Commit**

```
git add harness/compose docs/architecture harness/core-tools/src/app .env.example .gitignore .github/workflows/ci.yml package.json
git commit -m "build: pull the published images instead of building the stack from the checkout"
```

---

### Task 5: `@harness/sandbox-api` — the seam Plan 12 will implement, and nothing else

**Files:**
- Create: `harness/sandbox-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/sandbox-api/src/types.ts`, `src/index.ts`, `src/testing.ts`, `src/memory.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry)
- Delete: nothing.

**Interfaces:**
- Produces: `SandboxProvider`, `Sandbox`, `SandboxSession`, `ExecResult`, `ExecOptions`; `MemorySandboxProvider` and `sandboxProviderConformance(makeProvider)` from `@harness/sandbox-api/testing`.
- Consumes: `@harness/shared` (for `ToolError`, which a provider raises when a session asks for something it cannot do).

**Nothing imports this package.** No action class, no host wiring, no tool: spec decision 14 reserves the interface and says "No implementation in Plans 11–12", and the `execute` class is Plan 12's, so adding it here would move the tool surface this plan must keep byte-identical. `no-orphans` is satisfied because the package's own modules import each other — `index.ts` re-exports `types.ts`, `testing.ts` imports both — and that rule matches a module with no incoming **and** no outgoing dependencies.

- [ ] **Step 1: Write the failing test**

Create `harness/sandbox-api/src/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import { MemorySandboxProvider, sandboxProviderConformance } from './testing.js';
import type { SandboxSession } from './types.js';

const session: SandboxSession = { client: 'alpha', runId: 'r-1', principalId: 'u-coordinator' };

// Every provider runs this, and today there is one. It is here at all so that the first real
// implementation — agent-sandbox, in its own plan — inherits a suite rather than writing one.
sandboxProviderConformance(() => new MemorySandboxProvider());

describe('MemorySandboxProvider', () => {
  it('plays back the exits a test scripted, in order, and reports what was run', async () => {
    const provider = new MemorySandboxProvider();
    provider.script('node --version', { exitCode: 0, stdout: 'v22.0.0', stderr: '', durationMs: 3 });
    const sandbox = await provider.acquire(session);
    expect(await sandbox.exec('node --version', {})).toEqual({
      exitCode: 0,
      stdout: 'v22.0.0',
      stderr: '',
      durationMs: 3,
    });
    expect(provider.commands).toEqual([{ session, command: 'node --version' }]);
  });

  it('answers a command nobody scripted with a non-zero exit rather than a throw', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    const result = await sandbox.exec('rm -rf /', {});
    expect(result.exitCode).toBe(127);
    expect(result.stderr).toContain('not scripted');
    // The command itself is not repeated: it is a model's argument, and this string is the kind
    // of thing that ends up in an error column.
    expect(result.stderr).not.toContain('rm -rf');
  });

  it('round-trips a file, and refuses to read one nobody wrote', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    await sandbox.putFile('/work/in.csv', new TextEncoder().encode('a,b\n1,2\n'));
    expect(new TextDecoder().decode(await sandbox.getFile('/work/in.csv'))).toBe('a,b\n1,2\n');
    await expect(sandbox.getFile('/work/missing.csv')).rejects.toBeInstanceOf(ToolError);
  });

  it('refuses everything once it has been terminated', async () => {
    const sandbox = await new MemorySandboxProvider().acquire(session);
    await sandbox.terminate();
    await sandbox.terminate(); // idempotent: a caller that unwinds twice is not an error
    await expect(sandbox.exec('ls', {})).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.putFile('/work/a', new Uint8Array())).rejects.toBeInstanceOf(ToolError);
    await expect(sandbox.getFile('/work/a')).rejects.toBeInstanceOf(ToolError);
  });

  it('gives each session its own filesystem, because two runs are two tenants', async () => {
    const provider = new MemorySandboxProvider();
    const mine = await provider.acquire(session);
    const theirs = await provider.acquire({ client: 'beta', runId: 'r-2', principalId: 'u-other' });
    await mine.putFile('/work/secret', new TextEncoder().encode('alpha'));
    await expect(theirs.getFile('/work/secret')).rejects.toBeInstanceOf(ToolError);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/sandbox-api exec vitest run` — which fails first because the package does not exist. That is the failure; create it in the next step and run again.

- [ ] **Step 3: Create the package**

`harness/sandbox-api/package.json`:

```json
{
  "name": "@harness/sandbox-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`harness/sandbox-api/tsconfig.json`:

```json
{ "extends": "../../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }
```

`harness/sandbox-api/vitest.config.ts`: copy `harness/surface-api/vitest.config.ts` exactly — it is the same file in every leaf package, and a leaf with no database needs nothing more.

Then `pnpm install`, so the workspace links the new package.

- [ ] **Step 4: Declare the seam**

`harness/sandbox-api/src/types.ts`:

```ts
/**
 * The contract for running a command somewhere that is not this process (spec decision 14).
 *
 * Reserved, not implemented: nothing in this repository acquires a sandbox, and no action class
 * admits one — `execute` is Plan 12's, and a class added before a provider existed would appear
 * in the published tool surface as a capability nobody has. What this package exists for is the
 * shape: a later plan brings agent-sandbox, a `SandboxClaim` from a tenant's warm pool and a
 * router in front of it, and every one of those is an implementation of `SandboxProvider` rather
 * than a change to the kernel.
 *
 * The unit is a **session**, not a process and not a tenant: one run, of one principal, of one
 * client. A provider may pool, pause or reuse whatever it likes underneath, and the isolation
 * this contract promises is that what one session writes, another session cannot read.
 */

/** Who a sandbox is being acquired for. Everything an implementation may key its isolation on. */
export interface SandboxSession {
  client: string;
  runId: string;
  principalId: string;
}

/** What one command cost and what it said. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** How one command is run. Every field is a bound, because every field is somebody's budget. */
export interface ExecOptions {
  /** Where the command runs. A provider that has one root resolves this under it. */
  cwd?: string;
  /** Extra environment for this command only. A provider never forwards its own. */
  env?: Readonly<Record<string, string>>;
  /** After this, the command is killed and the result reports it. */
  timeoutMs?: number;
}

/** One acquired sandbox. Everything here rejects with a `ToolError` once it is terminated. */
export interface Sandbox {
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  /** Idempotent, and never throws: a caller unwinding twice is not an error. */
  terminate(): Promise<void>;
}

/** Where a sandbox comes from. One per deployment; the tenant is in the session. */
export interface SandboxProvider {
  readonly name: string;
  acquire(session: SandboxSession): Promise<Sandbox>;
}
```

`harness/sandbox-api/src/index.ts`:

```ts
/**
 * The public API of @harness/sandbox-api.
 *
 * Types only: this package reserves a seam (spec decision 14) and implements nothing. The
 * in-memory provider and the conformance suite are under the `./testing` subpath, where every
 * contract package in this workspace keeps its kit.
 */
export type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';
```

- [ ] **Step 5: Write the kit**

`harness/sandbox-api/src/testing.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';

/** The key a session's own filesystem is kept under: one run of one client, never shared. */
const keyOf = (session: SandboxSession): string => `${session.client}:${session.runId}:${session.principalId}`;

/**
 * A sandbox that runs nothing.
 *
 * Files are a map and commands are a script a test writes: what it proves is that a caller's
 * *sequence* is right — acquire, put, exec, get, terminate — not that anything executed. The
 * first real provider is a later plan's, and this is what its conformance run starts from.
 */
export class MemorySandboxProvider implements SandboxProvider {
  readonly name = 'memory';
  /** Every command any session of this provider was asked to run, in order. */
  readonly commands: { session: SandboxSession; command: string }[] = [];

  private readonly scripted = new Map<string, ExecResult>();
  private readonly files = new Map<string, Map<string, Uint8Array>>();

  /** What `exec` answers for this exact command, whichever session runs it. */
  script(command: string, result: ExecResult): void {
    this.scripted.set(command, result);
  }

  async acquire(session: SandboxSession): Promise<Sandbox> {
    const key = keyOf(session);
    // Per session, which is what makes "one run cannot read another's files" a property of the
    // fake rather than a promise in a comment.
    const files = this.files.get(key) ?? new Map<string, Uint8Array>();
    this.files.set(key, files);
    let live = true;
    const assertLive = (what: string): void => {
      if (!live) throw new ToolError(`this sandbox has been terminated and cannot ${what}`);
    };
    return {
      exec: async (command: string, _opts: ExecOptions): Promise<ExecResult> => {
        assertLive('run a command');
        this.commands.push({ session, command });
        const result = this.scripted.get(command);
        // A command nobody scripted is a command that is not there: an exit code, like a shell's,
        // rather than a throw — a provider that threw would make a test of a caller's error
        // handling impossible. The command is not repeated in the message: it is a model's
        // argument and this string is the kind of thing that lands in an error column.
        return result ?? { exitCode: 127, stdout: '', stderr: 'that command is not scripted', durationMs: 0 };
      },
      putFile: async (path: string, bytes: Uint8Array): Promise<void> => {
        assertLive('take a file');
        files.set(path, bytes);
      },
      getFile: async (path: string): Promise<Uint8Array> => {
        assertLive('give a file back');
        const bytes = files.get(path);
        if (!bytes) throw new ToolError('no such file in this sandbox');
        return bytes;
      },
      terminate: async (): Promise<void> => {
        live = false;
      },
    };
  }
}

/**
 * The suite every `SandboxProvider` runs.
 *
 * Called at the top level of a provider's own test file with a factory, exactly as
 * `configSourceConformance` is: what it pins is the contract's promises — a session's files are
 * its own, a terminated sandbox refuses everything, `terminate` is idempotent — so that the
 * second implementation cannot quietly mean something else by them.
 */
export function sandboxProviderConformance(makeProvider: () => SandboxProvider): void {
  const session: SandboxSession = { client: 'conformance', runId: 'r-conformance', principalId: 'u-conformance' };

  describe(`the sandbox provider contract`, () => {
    it('acquires a sandbox for a session and reports a name', async () => {
      const provider = makeProvider();
      expect(provider.name).not.toBe('');
      const sandbox = await provider.acquire(session);
      expect(typeof sandbox.exec).toBe('function');
      await sandbox.terminate();
    });

    it('gives a file back byte for byte', async () => {
      const sandbox = await makeProvider().acquire(session);
      const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
      await sandbox.putFile('/work/bytes.bin', bytes);
      expect([...(await sandbox.getFile('/work/bytes.bin'))]).toEqual([...bytes]);
      await sandbox.terminate();
    });

    it('refuses a file nobody put there, with a ToolError', async () => {
      const sandbox = await makeProvider().acquire(session);
      await expect(sandbox.getFile('/work/nothing')).rejects.toBeInstanceOf(ToolError);
      await sandbox.terminate();
    });

    it('refuses everything after terminate, and terminates idempotently', async () => {
      const sandbox = await makeProvider().acquire(session);
      await sandbox.terminate();
      await sandbox.terminate();
      await expect(sandbox.exec('true', {})).rejects.toBeInstanceOf(ToolError);
    });

    it('keeps one session s files away from another s', async () => {
      const provider = makeProvider();
      const mine = await provider.acquire(session);
      const theirs = await provider.acquire({ client: 'other', runId: 'r-other', principalId: 'u-other' });
      await mine.putFile('/work/mine', new Uint8Array([1]));
      await expect(theirs.getFile('/work/mine')).rejects.toBeInstanceOf(ToolError);
      await mine.terminate();
      await theirs.terminate();
    });
  });
}
```

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @harness/sandbox-api test`
Expected: PASS — five conformance cases and five of the provider's own.

- [ ] **Step 7: Add the two architecture lines**

In `.dependency-cruiser.cjs`, add one `PACKAGES` row after `runtime-api`:

```js
  { name: 'sandbox-api', src: 'harness/sandbox-api/src', severity: 'error' },
```

and one `WORKSPACE_DIRS` entry in the same position:

```js
  'harness/sandbox-api',
```

Nothing else in that file changes: the cross-package rule reads the manifest's `exports` map from disk, and no rule has to say "nothing imports this" because nothing does.

- [ ] **Step 8: Write the README**

`harness/sandbox-api/README.md` (the outer fence is four backticks because the README contains one):

````markdown
# @harness/sandbox-api

The seam for running a command somewhere that is not this process. **Reserved, not implemented**
(spec decision 14): nothing in this repository acquires a sandbox, there is no `execute` action
class yet, and no tool exposes one.

```
SandboxProvider  acquire(session) -> Sandbox
Sandbox          exec(command, opts), putFile(path, bytes), getFile(path), terminate()
SandboxSession   { client, runId, principalId }
ExecResult       { exitCode, stdout, stderr, durationMs }
```

The unit is a session — one run, of one principal, of one client — and the promise is that what
one session writes, another cannot read. A provider may pool, pause or reuse whatever it likes
underneath.

`@harness/sandbox-api/testing` ships `MemorySandboxProvider`, whose files are a map and whose
commands are a script, and `sandboxProviderConformance(makeProvider)`, which every provider runs.
The first real one — agent-sandbox, with a claim from a tenant's warm pool — is its own plan, and
it inherits this suite rather than writing one.
````

- [ ] **Step 9: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green, `pnpm arch` included — the new package's own modules import each other, so nothing in it is an orphan. `git status --short docs/architecture` is empty.

- [ ] **Step 10: Commit**

```
git add harness/sandbox-api .dependency-cruiser.cjs pnpm-lock.yaml
git commit -m "feat(sandbox-api): reserve the execution seam with an in-memory provider and a conformance suite"
```

---

### Task 6: Seven packages become publishable — a build step, `publishConfig`, and a test that packs them

**Files:**
- Modify: `harness/shared/package.json`, `harness/pack-api/package.json`, `harness/config-api/package.json`, `harness/surface-api/package.json`, `harness/identity-api/package.json`, `harness/runtime-api/package.json`, `harness/sandbox-api/package.json`
- Create: a `tsconfig.build.json` in each of those seven directories
- Modify: root `package.json` (`build`, `release:version`)
- Create: `scripts/src/domain/packaging.test.ts`
- Delete: nothing.

**Interfaces:**
- Produces: `pnpm build` (every package that has one), `pnpm release:version <v>`, and seven packages whose tarball exports `dist/`.
- Consumes: `@harness/sandbox-api` (Task 5), which is published with the other six.

**The published set, in dependency order.** `@harness/shared`, `@harness/pack-api`, `@harness/config-api`, `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api`, `@harness/sandbox-api`. This exact list appears again in Task 7's workflow and is asserted against the manifests by the test below, so the two cannot drift.

**Everything else stays private.** `@harness/db`, `@harness/core-tools`, `@harness/approvals`, `@harness/host`, `@harness/gateway`, `@harness/files`, `@harness/evals`, `@harness/scripts`, every pack, every surface, every identity plug-in and every runtime: the platform consumes the contracts and runs the image, and a package it could import but should not is a boundary with a door in it.

- [ ] **Step 1: Write the failing test**

Create `scripts/src/domain/packaging.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { beforeAll, describe, expect, it } from 'vitest';

const run = promisify(execFile);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The packages the platform consumes, in dependency order.
 *
 * Written out rather than derived, and then checked against what the manifests say: a package
 * that became publishable by accident is exactly what this list is for.
 */
const PUBLISHED = [
  '@harness/shared',
  '@harness/pack-api',
  '@harness/config-api',
  '@harness/surface-api',
  '@harness/identity-api',
  '@harness/runtime-api',
  '@harness/sandbox-api',
];

/** Where the workspace's packages live, as pnpm-workspace.yaml lists them. */
const WORKSPACE_PARENTS = ['harness', 'packs', 'surfaces', 'identities', 'runtimes'];
const WORKSPACE_SINGLES = ['evals', 'scripts'];

interface Manifest {
  name: string;
  version: string;
  private?: boolean;
  files?: string[];
  exports?: Record<string, unknown>;
  publishConfig?: { exports?: Record<string, { types?: string; default?: string }> };
  scripts?: Record<string, string>;
}

async function manifests(): Promise<{ dir: string; manifest: Manifest }[]> {
  const dirs: string[] = [...WORKSPACE_SINGLES];
  for (const parent of WORKSPACE_PARENTS) {
    for (const entry of await readdir(path.join(repoRoot, parent), { withFileTypes: true })) {
      if (entry.isDirectory() && existsSync(path.join(repoRoot, parent, entry.name, 'package.json'))) {
        dirs.push(`${parent}/${entry.name}`);
      }
    }
  }
  return Promise.all(
    dirs.map(async (dir) => ({
      dir,
      manifest: JSON.parse(await readFile(path.join(repoRoot, dir, 'package.json'), 'utf8')) as Manifest,
    })),
  );
}

describe('what this repository publishes', () => {
  it('declares exactly the published set as public, and everything else as private', async () => {
    const all = await manifests();
    const publishable = all.filter(({ manifest }) => manifest.private !== true).map(({ manifest }) => manifest.name);
    expect(publishable.sort()).toEqual([...PUBLISHED].sort());
  });

  it('gives every published package one version, so a consumer can resolve the whole set', async () => {
    // pnpm rewrites `workspace:*` to the exact version at pack time, so two packages at two
    // versions is a tarball that cannot resolve its own dependency.
    const all = await manifests();
    const versions = new Set(all.map(({ manifest }) => manifest.version));
    expect([...versions]).toHaveLength(1);
  });

  it('gives every published package a build, a files list and a publishConfig that points at dist', async () => {
    for (const { dir, manifest } of (await manifests()).filter((m) => PUBLISHED.includes(m.manifest.name))) {
      expect(manifest.scripts?.build, dir).toBe('tsc -p tsconfig.build.json');
      expect(manifest.files, dir).toEqual(['dist', 'README.md']);
      expect(existsSync(path.join(repoRoot, dir, 'tsconfig.build.json')), dir).toBe(true);
      expect(existsSync(path.join(repoRoot, dir, 'README.md')), dir).toBe(true);
      // The source map stays in `exports` so the workspace keeps running from `.ts`; the
      // published map is the same subpaths, pointing at what the build emitted.
      expect(Object.keys(manifest.publishConfig?.exports ?? {}), dir).toEqual(Object.keys(manifest.exports ?? {}));
      for (const [subpath, target] of Object.entries(manifest.publishConfig?.exports ?? {})) {
        expect(target.types, `${dir} ${subpath}`).toMatch(/^\.\/dist\/.+\.d\.ts$/);
        expect(target.default, `${dir} ${subpath}`).toMatch(/^\.\/dist\/.+\.js$/);
      }
    }
  });
});

/**
 * The slow one, and worth its seconds: it builds and packs every published package and reads the
 * tarball.
 *
 * Everything above is a manifest read, and a manifest can be right while the tarball is empty —
 * a build that emitted into the wrong directory, a `files` entry that matches nothing, a
 * `publishConfig` pnpm did not apply. This is the only assertion that what a consumer downloads
 * is what this repository meant to publish.
 */
describe('the tarball a consumer downloads', () => {
  let packed: string;

  beforeAll(async () => {
    await run('pnpm', ['build'], { cwd: repoRoot, maxBuffer: 8 * 1024 * 1024 });
    packed = await mkdtemp(path.join(tmpdir(), 'harness-pack-'));
    return async () => {
      await rm(packed, { recursive: true, force: true });
    };
  }, 300_000);

  it.each(PUBLISHED)('%s ships dist, its declarations and its README, and nothing else', async (name) => {
    const out = path.join(packed, name.replace('@harness/', ''));
    await run('pnpm', ['--filter', name, 'exec', 'pnpm', 'pack', '--pack-destination', out], {
      cwd: repoRoot,
      maxBuffer: 8 * 1024 * 1024,
    });
    const [tarball] = await readdir(out);
    expect(tarball).toMatch(/\.tgz$/);
    const { stdout } = await run('tar', ['-xzOf', path.join(out, tarball), 'package/package.json']);
    const manifest = JSON.parse(stdout) as Manifest;
    // pnpm applies publishConfig at pack time and drops it from the published manifest.
    expect(manifest.publishConfig).toBeUndefined();
    expect(manifest.private).toBe(false);
    const listing = (await run('tar', ['-tzf', path.join(out, tarball)])).stdout.split('\n').filter(Boolean);
    expect(listing).toContain('package/package.json');
    expect(listing).toContain('package/README.md');
    // No source, no tests, no vitest config: what ships is what runs.
    expect(listing.filter((entry) => entry.startsWith('package/src/'))).toEqual([]);
    expect(listing.filter((entry) => entry.endsWith('.test.js'))).toEqual([]);
    for (const target of Object.values(manifest.exports ?? {}) as { types?: string; default?: string }[]) {
      for (const file of [target.types, target.default]) {
        expect(listing, `${name} ${String(file)}`).toContain(`package/${String(file).replace('./', '')}`);
      }
    }
    // And what a consumer's lockfile will hold: an exact version rather than a workspace link.
    const deps = (JSON.parse(stdout) as { dependencies?: Record<string, string> }).dependencies ?? {};
    for (const [dependency, range] of Object.entries(deps)) {
      if (dependency.startsWith('@harness/')) expect(range, `${name} -> ${dependency}`).toBe(manifest.version);
    }
  }, 120_000);
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/scripts exec vitest run src/domain/packaging.test.ts`
Expected: FAIL — every package is private and none has a `build` script.

- [ ] **Step 3: Write the seven build configs**

In each of `harness/shared`, `harness/pack-api`, `harness/config-api`, `harness/surface-api`, `harness/identity-api`, `harness/runtime-api` and `harness/sandbox-api`, create `tsconfig.build.json`:

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "declarationMap": false,
    "sourceMap": false,
    "rootDir": "src",
    "outDir": "dist"
  },
  "include": ["src"],
  "exclude": ["src/**/*.test.ts", "src/**/*.test-helpers.ts"]
}
```

Three of those five overrides are load-bearing, and it is worth knowing which: `noEmit: false` because the base config sets `noEmit: true` for every package; `rootDir: "src"` because without it the output nests under `dist/src/`; and its own `include`, because the package's `tsconfig.json` includes `vitest.config.ts`, which is outside `rootDir` and would fail the build with `TS6059`. `declarationMap` and `sourceMap` are off because a consumer of a published contract debugs against the declarations, and a map pointing at sources the tarball does not carry is worse than none.

- [ ] **Step 4: Make the seven manifests publishable**

In each of the seven `package.json` files: set `"private": false`, add `"build": "tsc -p tsconfig.build.json"` as the **first** entry of `scripts`, add `"files": ["dist", "README.md"]` after `exports`, and add a `publishConfig` mapping every subpath its `exports` has.

`@harness/shared` and `@harness/pack-api` have one subpath:

```json
  "files": ["dist", "README.md"],
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" }
    }
  },
```

`@harness/config-api`, `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api` and `@harness/sandbox-api` have two:

```json
  "files": ["dist", "README.md"],
  "publishConfig": {
    "exports": {
      ".": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
      "./testing": { "types": "./dist/testing.d.ts", "default": "./dist/testing.js" }
    }
  },
```

**The source `exports` do not change.** They keep pointing at `./src/index.ts`, which is what makes the workspace run from source, what `.dependency-cruiser.cjs`'s cross-package rule reads, and why no import anywhere in this repository moves. pnpm swaps in `publishConfig` at pack time and drops it from the published manifest — verified.

**Three of the seven ship a `./testing` subpath that imports something the tarball does not carry**, and each has to say so rather than leaving a consumer to find out when the import fails:

- `@harness/config-api/testing` imports `vitest` (`configSourceConformance` is a suite).
- `@harness/sandbox-api/testing` imports `vitest`, for the same reason.
- `@harness/runtime-api/testing` imports `vitest` through `./conformance.js` **and
  `@modelcontextprotocol/server` through `./tool-server.js`** — and that second one is a
  **devDependency** of `@harness/runtime-api` today, so a published `dist/testing.js` would fail
  to resolve it for any consumer. Read `harness/runtime-api/src/conformance.ts` line 1 and
  `src/tool-server.ts` line 3 before this step: those two imports are the whole of the problem.

So `@harness/config-api` and `@harness/sandbox-api` get:

```json
  "peerDependencies": { "vitest": "^5.0.0" },
  "peerDependenciesMeta": { "vitest": { "optional": true } },
```

and `@harness/runtime-api` gets both:

```json
  "peerDependencies": { "@modelcontextprotocol/server": "^2.0.0", "vitest": "^5.0.0" },
  "peerDependenciesMeta": { "@modelcontextprotocol/server": { "optional": true }, "vitest": { "optional": true } },
```

Optional, because the main entry point needs neither: a consumer that imports only the contract installs nothing extra, one that runs a conformance suite already has vitest, and one that wants the MCP tool-server fixture installs the server package deliberately. An optional peer rather than a promotion to `dependencies`, because a published *contract* that dragged an MCP server implementation into every install would make the contract heavier than the thing it describes. `@harness/surface-api/testing` and `@harness/identity-api/testing` import nothing beyond their own package and `@harness/shared`, so they need neither entry — check that claim with `grep -n "^import" harness/surface-api/src/testing.ts harness/identity-api/src/testing.ts` before you skip them.

The packing test in Step 1 asserts the `publishConfig` shape, not the resolvability of a subpath's imports; the changelog bullet Task 7 writes is where a consumer is told what `./testing` costs them.

- [ ] **Step 5: Two root scripts**

In the root `package.json`, add after `typecheck`:

```json
    "build": "pnpm -r --if-present build",
    "release:version": "pnpm -r exec npm version --no-git-tag-version --allow-same-version",
```

`release:version` is how every workspace package reaches one version — `pnpm release:version 0.2.0` — and it is deliberately **not** run by this plan: the version and the tag are the user's. `--no-git-tag-version` because the tag is pushed by hand; `--allow-same-version` so re-running it after a failed release is not an error. It runs in every workspace package and not at the root, which has no `version` field and needs none.

`dist/` needs no `.gitignore` entry: the root file already ignores it, beside `node_modules/`.

- [ ] **Step 6: Run it to verify it passes**

Run: `pnpm --filter @harness/scripts exec vitest run src/domain/packaging.test.ts`
Expected: PASS — three manifest cases and seven tarball cases. The first run builds seven packages and takes about half a minute.

Then confirm the workspace still runs from source rather than from the build it just wrote:

```bash
rm -rf harness/*/dist
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test pnpm --filter @harness/host test
```
Expected: PASS. Nothing resolves through `dist/`; it exists only to be packed.

- [ ] **Step 7: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `pnpm -r typecheck` is unchanged — `tsconfig.build.json` is not the config `typecheck` uses. `git status --short docs/architecture` is empty.

- [ ] **Step 8: Commit**

Staged by name rather than by glob: `harness/*/package.json` would sweep in every manifest in the
workspace, and only these seven changed.

```
git add harness/shared harness/pack-api harness/config-api harness/surface-api \
  harness/identity-api harness/runtime-api harness/sandbox-api package.json scripts/src
git commit -m "build: publish the seven contract packages from a real build instead of from source"
```

---

### Task 7: `release.yml` — a tag runs the gates, pushes two images and writes a release

**Files:**
- Create: `.github/workflows/release.yml`
- Create: `CHANGELOG.md`
- Create: `scripts/src/domain/changelog.ts` + `changelog.test.ts`
- Create: `scripts/src/app/changelog-cli.ts`
- Create: `scripts/src/domain/release-workflow.test.ts`
- Modify: root `package.json` (`release:notes`)
- Delete: nothing.

**Interfaces:**
- Consumes: the published set and `pnpm build` (Task 6); the two image names (Task 4).
- Produces: `readChangelogSection(markdown, version): string`, `pnpm release:notes <version>`, and the workflow.

- [ ] **Step 1: Write the failing tests**

Create `scripts/src/domain/changelog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { readChangelogSection } from './changelog.js';

const CHANGELOG = `# Changelog

All notable changes to this repository, written for the team that consumes it.

## 0.2.0 — 2026-09-21

### Added

- Slack over HTTPS.

## 0.1.0 — 2026-09-19

The first tagged release.
`;

describe('readChangelogSection', () => {
  it('returns one version s section, without its own heading and without the next one', () => {
    const section = readChangelogSection(CHANGELOG, '0.2.0');
    expect(section).toContain('Slack over HTTPS.');
    expect(section).not.toContain('0.1.0');
    expect(section).not.toContain('## 0.2.0');
    expect(section.startsWith('### Added')).toBe(true);
  });

  it('returns the last section, which has no section after it to stop at', () => {
    expect(readChangelogSection(CHANGELOG, '0.1.0')).toBe('The first tagged release.');
  });

  it('refuses a version the changelog does not describe, naming it', () => {
    expect(() => readChangelogSection(CHANGELOG, '0.3.0')).toThrow(ConfigError);
    expect(() => readChangelogSection(CHANGELOG, '0.3.0')).toThrow(/0\.3\.0/);
  });

  it('matches the version rather than a prefix of one', () => {
    // `0.2` must not match the `0.2.0` heading: a release whose notes were another release's is
    // worse than a release with none.
    expect(() => readChangelogSection(CHANGELOG, '0.2')).toThrow(ConfigError);
  });
});
```

Create `scripts/src/domain/release-workflow.test.ts`:

```ts
import { existsSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

interface Workflow {
  on?: { push?: { tags?: string[] } };
  permissions?: Record<string, string>;
  jobs?: Record<string, { steps?: { name?: string; uses?: string; run?: string }[] }>;
}

const workflow = async (): Promise<Workflow> =>
  parseYaml(await readFile(path.join(repoRoot, '.github/workflows/release.yml'), 'utf8')) as Workflow;

const steps = async (): Promise<{ name?: string; uses?: string; run?: string }[]> =>
  Object.values((await workflow()).jobs ?? {}).flatMap((job) => job.steps ?? []);

const scripts = async (): Promise<string> => (await steps()).map((step) => step.run ?? '').join('\n');

/** Every workspace package that is not private: what a release is expected to carry. */
async function publicPackages(): Promise<string[]> {
  const names: string[] = [];
  for (const parent of ['harness', 'packs', 'surfaces', 'identities', 'runtimes']) {
    for (const entry of await readdir(path.join(repoRoot, parent), { withFileTypes: true })) {
      const manifest = path.join(repoRoot, parent, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(manifest)) continue;
      const parsed = JSON.parse(await readFile(manifest, 'utf8')) as { name: string; private?: boolean };
      if (parsed.private !== true) names.push(parsed.name);
    }
  }
  return names;
}

describe('the release workflow', () => {
  it('runs on a version tag and on nothing else', async () => {
    const parsed = await workflow();
    expect(parsed.on?.push?.tags).toEqual(['v*']);
    // No pull_request, no push to a branch, no schedule: a release is something a person did.
    expect(Object.keys(parsed.on ?? {})).toEqual(['push']);
  });

  it('asks for exactly the two permissions it uses', async () => {
    expect((await workflow()).permissions).toEqual({ contents: 'write', packages: 'write' });
  });

  it('runs all five gates before it publishes anything', async () => {
    const text = await scripts();
    const gates = ['pnpm -r typecheck', 'pnpm lint', 'pnpm arch', 'pnpm format:check', 'pnpm test'];
    for (const gate of gates) expect(text, gate).toContain(gate);
    // Every gate is before the first push, so a tag that fails the suite publishes nothing.
    const firstPush = text.indexOf('docker push');
    for (const gate of gates) expect(text.indexOf(gate), gate).toBeLessThan(firstPush);
  });

  it('packs exactly the packages this repository declares public', async () => {
    const text = await scripts();
    const packed = [...text.matchAll(/@harness\/[a-z-]+/g)].map((match) => match[0]);
    expect([...new Set(packed)].sort()).toEqual((await publicPackages()).sort());
  });

  it('pushes both images the Compose stack pulls, at the tag s own version', async () => {
    const text = await scripts();
    for (const image of ['agent-harness-host', 'agent-harness-files']) {
      expect(text, image).toContain(`${image}:$VERSION`);
    }
    expect(text).toContain('docker login');
  });

  it('attaches both architecture snapshots to the release', async () => {
    const text = await scripts();
    expect(text).toContain('docs/architecture/tool-surface.json');
    expect(text).toContain('docs/architecture/compose-surface.yaml');
    expect(text).toContain('release/*.tgz');
  });

  it('uses only the actions CI already uses', async () => {
    const used = (await steps()).flatMap((step) => (step.uses ? [step.uses] : []));
    expect([...new Set(used)].sort()).toEqual(['actions/checkout@v4', 'actions/setup-node@v4', 'pnpm/action-setup@v4']);
  });
});

describe('the changelog', () => {
  it('describes the version the manifests declare', async () => {
    const version = (JSON.parse(await readFile(path.join(repoRoot, 'harness/shared/package.json'), 'utf8')) as {
      version: string;
    }).version;
    const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
    // The release this plan prepares, whether or not the version has been bumped for it yet.
    expect(changelog).toContain('## 0.2.0');
    expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @harness/scripts exec vitest run src/domain/changelog.test.ts src/domain/release-workflow.test.ts`
Expected: FAIL — neither `./changelog.js` nor `.github/workflows/release.yml` exists.

- [ ] **Step 3: Read a version's notes**

Create `scripts/src/domain/changelog.ts`:

```ts
import { ConfigError } from '@harness/shared';

/**
 * One version's section of the changelog, without its own heading and without the next one.
 *
 * The release body is written by a person, in the file the repository already keeps, rather than
 * generated from commit subjects: a consumer reading a release wants to know what moved under
 * them, and "fix(host): tidy" is not that. The heading is `## <version>` followed by anything —
 * a date, usually — and the section ends at the next `## `.
 */
export function readChangelogSection(markdown: string, version: string): string {
  const lines = markdown.split('\n');
  const start = lines.findIndex((line) => new RegExp(`^## ${version.replace(/\./g, '\\.')}(\\s|$)`).test(line));
  if (start === -1) {
    throw new ConfigError(`CHANGELOG.md has no "## ${version}" section; write one before tagging ${version}`);
  }
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}
```

Create `scripts/src/app/changelog-cli.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readChangelogSection } from '../domain/changelog.js';

/**
 * `pnpm release:notes <version>` — one version's section of the changelog, on stdout.
 *
 * The release workflow redirects this into the body of the GitHub Release it creates, so a
 * missing section fails the release before anything is published rather than after.
 */
const version = process.argv[2];
if (!version) {
  process.stderr.write('usage: pnpm release:notes <version>\n');
  process.exit(1);
}
// scripts/src/app -> scripts/src -> scripts -> the repository root
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const changelog = await readFile(path.join(repoRoot, 'CHANGELOG.md'), 'utf8');
process.stdout.write(`${readChangelogSection(changelog, version)}\n`);
```

In the root `package.json`, beside the other two release scripts:

```json
    "release:notes": "pnpm --filter @harness/scripts exec tsx src/app/changelog-cli.ts",
```

- [ ] **Step 4: Write the changelog**

Create `CHANGELOG.md`:

```markdown
# Changelog

What changed in the agent-harness kernel, written for the team that consumes it. Versions are
semantic and every package in a release carries the same one. A release attaches the package
tarballs and the two architecture snapshots; the host and files images are pushed to
`ghcr.io/mgavrila` under the same tag.

## 0.2.0 — unreleased

The release that makes this repository something to depend on rather than something to check out.

### Added

- **Slack over HTTPS.** The Slack surface receives events and interactions as signed requests at
  one URL instead of holding a Socket Mode connection. A host with no socket can be paused,
  resumed, pooled and put behind an ingress. Point both request URLs in the app's configuration —
  Event Subscriptions and Interactivity — at
  `https://<host>/tenants/<clientId>/slack/events`.
- **An HTTP seam on the surface contract.** `SurfaceSession.http` is a mount path and a handler;
  the host mounts every tenant's at `/tenants/<clientId>/<path>` on the port the run API already
  uses. A surface verifies its own transport's signature and may refuse a request with a reason,
  which the host audits exactly once.
- **`@harness/sandbox-api`**, reserved: `SandboxProvider`, `Sandbox`, `SandboxSession` and
  `ExecResult`, with an in-memory provider and a conformance suite. Nothing implements it yet and
  no action class admits one.
- **Published packages.** `@harness/shared`, `@harness/pack-api`, `@harness/config-api`,
  `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api` and
  `@harness/sandbox-api` ship as build output with declarations. Pin them by tarball URL:
  `https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-shared-0.2.0.tgz`,
  and add a `pnpm.overrides` entry for each, because the tarballs depend on one another by exact
  version. The `./testing` subpath of `@harness/config-api`, `@harness/runtime-api` and
  `@harness/sandbox-api` needs `vitest` installed, and `@harness/runtime-api/testing` also needs
  `@modelcontextprotocol/server` for its tool-server fixture; both are declared as optional peers,
  so importing only the contract costs you nothing.
- **`HARNESS_IMAGE_TAG`**, which is the release a Compose deployment runs.

### Changed

- **The host's HTTP server always starts.** `HARNESS_HOST_TOKEN` empty now closes `/v1/*` with a
  401 rather than closing the listener, because the tenant mounts have to answer whether or not a
  deployment uses the run API.
- **Compose pulls.** No service is built from a checkout any more: `host` and `files` are pulled
  from `ghcr.io/mgavrila` at `HARNESS_IMAGE_TAG`.
- `surfaceSecretsOf` reports the document field each secret was named under, and a surface is
  handed the variable names its own tenant's document declared.
- The audit log has a sixth decision, `refused`: a request a surface turned away at the door,
  where nobody was identified and so nobody was refused authorisation.

### Removed

- **Socket mode, `@slack/bolt` and `SLACK_APP_TOKEN`.** A Slack app for this kernel needs a bot
  token and a signing secret, and no app-level token. There is no compatibility path: delete the
  variable and set the request URLs.
- The `core-tools` build-only Compose service and the `build-only` profile.
- `LoadedSurfaces.secrets`, which nothing read.

### Upgrading

1. Release or pull an image tag and set `HARNESS_IMAGE_TAG` in `.env`.
2. In each tenant's Slack app: turn Socket Mode off, set both request URLs to
   `https://<host>/tenants/<clientId>/slack/events`, and remove the app-level token.
3. Delete `SLACK_APP_TOKEN` from every environment file.
4. Put something in front of the host that terminates TLS. For local development, a tunnel —
   see docs/runbook.md, "Local development with a tunnel".
```

- [ ] **Step 5: Write the workflow**

Create `.github/workflows/release.yml`:

```yaml
# Everything a version tag publishes: the five gates, two images to the container registry, and a
# GitHub Release carrying the package tarballs and the two architecture snapshots.
#
# Packages are attached to the release rather than pushed to a registry. GitHub Packages requires
# an npm scope equal to the repository owner, and `@harness/*` cannot be published there without
# renaming every package and every import; that rename waits for the organisation that will own
# the scope. A consumer pins a tarball URL, and moving to a registry later is a change to the last
# two steps of this file and to nothing else.
name: release

on:
  push:
    tags: ['v*']

permissions:
  contents: write
  packages: write

jobs:
  release:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: pgvector/pgvector:0.8.1-pg16
        env:
          POSTGRES_USER: harness
          POSTGRES_PASSWORD: harness
          POSTGRES_DB: harness
        ports:
          - 15432:5432
        options: >-
          --health-cmd "pg_isready -U harness -d harness"
          --health-interval 5s
          --health-timeout 3s
          --health-retries 10
    env:
      DATABASE_URL: postgres://harness:harness@localhost:15432/harness
      TEST_DATABASE_URL: postgres://harness:harness@localhost:15432/harness_test
      EVALS_DATABASE_URL: postgres://harness:harness@localhost:15432/harness_evals
      LITELLM_MASTER_KEY: sk-ci-placeholder
      REGISTRY: ghcr.io
      IMAGE_OWNER: mgavrila
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Read the version off the tag
        run: echo "VERSION=${GITHUB_REF_NAME#v}" >> "$GITHUB_ENV"
      - name: Install the parsing binaries and psql
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils postgresql-client
      - run: pnpm install --frozen-lockfile
      - name: Refuse a tag the packages were not versioned for
        run: |
          declared=$(node -p "require('./harness/shared/package.json').version")
          if [ "$declared" != "$VERSION" ]; then
            echo "tag $GITHUB_REF_NAME does not match the workspace version $declared; run: pnpm release:version $VERSION" >&2
            exit 1
          fi
      - name: Refuse a version the changelog does not describe
        run: pnpm release:notes "$VERSION" > /dev/null
      - name: Create the test and evals databases, with the init.sql Compose uses
        run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f harness/compose/postgres/init.sql
      - run: pnpm db:migrate
      - run: pnpm -r typecheck
      - run: pnpm lint
      - run: pnpm arch
      - run: pnpm format:check
      - run: pnpm test
      - name: Log in to the container registry
        run: echo "${{ secrets.GITHUB_TOKEN }}" | docker login "$REGISTRY" -u "${{ github.actor }}" --password-stdin
      - name: Build and push the host image
        run: |
          docker build -f harness/compose/node.Dockerfile -t "$REGISTRY/$IMAGE_OWNER/agent-harness-host:$VERSION" .
          docker push "$REGISTRY/$IMAGE_OWNER/agent-harness-host:$VERSION"
      - name: Build and push the files worker image
        run: |
          docker build -f harness/compose/files.Dockerfile -t "$REGISTRY/$IMAGE_OWNER/agent-harness-files:$VERSION" .
          docker push "$REGISTRY/$IMAGE_OWNER/agent-harness-files:$VERSION"
      - name: Build every published package
        run: pnpm build
      - name: Pack every published package
        run: |
          mkdir -p release
          for package in @harness/shared @harness/pack-api @harness/config-api @harness/surface-api @harness/identity-api @harness/runtime-api @harness/sandbox-api; do
            pnpm --filter "$package" exec pnpm pack --pack-destination "$PWD/release"
          done
      - name: Write the release notes from the changelog
        run: pnpm release:notes "$VERSION" > release/notes.md
      - name: Create the release
        env:
          GH_TOKEN: ${{ secrets.GITHUB_TOKEN }}
        run: |
          gh release create "$GITHUB_REF_NAME" \
            --title "$GITHUB_REF_NAME" \
            --notes-file release/notes.md \
            release/*.tgz \
            docs/architecture/tool-surface.json \
            docs/architecture/compose-surface.yaml
```

Two things about this file that are deliberate rather than incidental. **The gates run before the first push**, so a tag that fails the suite publishes nothing — and the release-workflow test asserts that ordering rather than trusting it. **It uses the three actions `ci.yml` already uses and nothing else**: `docker` and `gh` are on the runner, and three fewer third-party actions in the one workflow that holds a registry token is worth four lines of shell.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm --filter @harness/scripts test`
Expected: PASS — the changelog's four cases, `release-workflow.test.ts`'s eight (seven over the workflow file and one over the changelog's version), and the packaging suite from Task 6.

- [ ] **Step 7: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `pnpm format:check` covers YAML and markdown, so run `pnpm format` if the new files fail it. `git status --short docs/architecture` is empty.

- [ ] **Step 8: Commit**

```
git add .github/workflows/release.yml CHANGELOG.md scripts/src package.json
git commit -m "build: publish packages, images and snapshots from a version tag"
```

---

### Task 8: The words, the stale comment, and the field nothing read

**Files:**
- Modify: `harness/core-tools/src/kernel-vocabulary.test.ts` (`socket ?mode`, and the self-check)
- Modify: `harness/approvals/src/host-vocabulary.test.ts` (the same regex, the same self-check)
- Modify: `harness/shared/src/env.ts` (a comment naming a function that no longer exists)
- Modify: `harness/approvals/src/domain/surfaces/registry.ts` (`LoadedSurfaces.secrets` goes)
- Modify: `harness/approvals/src/domain/surfaces/registry.test.ts`, `dual-surface.test.ts`
- Modify: `.env.example` (the Slack block's prose)
- Delete: nothing. `stub-surface.test-helpers.ts` **stays** — see Step 5.

**Interfaces:**
- Produces: `LoadedSurfaces = { all, primary, find }`; `surfacesOf(sessions)`.
- Consumes: nothing new.

- [ ] **Step 1: Write the failing test**

In `harness/core-tools/src/kernel-vocabulary.test.ts`, extend the self-check case `catches the words it claims to, so an empty result means the rule ran`. Add one line to the messaging block's positives and one to its negatives:

```ts
    for (const line of [
      "import { App } from '@slack/bolt';",
      'sink: `slack_message`,',
      '// the Block Kit card',
      'thread_ts: row.messageRef,',
      'const blocks = cardBlocks(card);',
      '// opened in Socket Mode',
    ]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(true);
    }
    // And the shapes it must not catch: an ordinary identifier, the words the kernel uses, and a
    // plain socket — the host binds one, and what is forbidden is the transport's own mode.
    for (const line of [
      'const prompt = dataBlockSystemPrompt(role);',
      "sink: 'surface_message',",
      'server.on("connection", (socket) => socket.destroy());',
    ]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(false);
    }
```

`harness/approvals/src/host-vocabulary.test.ts` has its own self-check, `catches the words it claims to, so an empty result means the rule ran`, and its lists are **not** the kernel's — five positives and two negatives, written for what a host might say. Add to them rather than replacing them: `'// opened in Socket Mode'` joins its five positives, and `'server.on("connection", (socket) => socket.destroy());'` joins its two negatives.

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/kernel-vocabulary.test.ts`
Expected: FAIL — `'// opened in Socket Mode'` is not matched.

- [ ] **Step 3: Widen the regex, in both copies**

In `harness/core-tools/src/kernel-vocabulary.test.ts`:

```ts
const MESSAGING_FORBIDDEN = /slack|bolt|block ?kit|thread_ts|\bblocks\b|socket ?mode/i;
```

and extend the paragraph above it:

```ts
 * `socket ?mode` is here since Plan 11b: the Slack adapter receives signed requests now and
 * nothing in this repository holds a vendor's connection, so a kernel that names one is a kernel
 * describing a transport it no longer has. A plain `socket` is not forbidden — the host binds
 * one — and neither is `webhook`, `signature` or `hmac`: those are HTTP, which the host is
 * allowed to know about.
```

Make the identical change to `FORBIDDEN` in `harness/approvals/src/host-vocabulary.test.ts`, with the same sentence in its own comment.

`ALLOWLIST` stays `[]` in both files, and the case asserting that it does is untouched.

- [ ] **Step 4: Run it to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/core-tools exec vitest run src/kernel-vocabulary.test.ts
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/approvals exec vitest run src/host-vocabulary.test.ts
```
Expected: PASS. Every occurrence of the words in this repository was in `surfaces/slack`, which Task 3 rewrote and which no vocabulary test scans.

- [ ] **Step 5: Delete the field nothing read**

In `harness/approvals/src/domain/surfaces/registry.ts`, remove the member from the interface:

```ts
export interface LoadedSurfaces {
  readonly all: readonly SurfaceSession[];
  readonly primary: SurfaceSession;
  /** `undefined` when no loaded surface has that name; the caller decides whether that is an error. */
  find(name: string): SurfaceSession | undefined;
}
```

the parameter from `surfacesOf`:

```ts
/** A set over sessions that are already in hand. Every test uses it; `loadSurfaces` builds one. */
export function surfacesOf(sessions: SurfaceSession[]): LoadedSurfaces {
  if (sessions.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  return {
    all: sessions,
    primary: sessions[0],
    find: (name) => sessions.find((s) => s.name === name),
  };
}
```

and the union from the end of `loadSurfaces`, which becomes `return surfacesOf(sessions);`.

It was built for a child-process allowlist — `coreToolsChildEnv` — that no longer exists: core-tools is hosted in-process, nothing spawns a server with a filtered environment, and a field with no reader is a promise about behaviour nobody implements. `Surface.secrets` itself stays: it is what an adapter declares and what `defineSurface` validates.

In `harness/approvals/src/domain/surfaces/registry.test.ts`, **two** sites read the field. In the first case of `describe('loadSurfaces')`, delete the line

```ts
    expect(surfaces.secrets).toEqual([]);
```

and in the `surfacesOf` case, drop the assertion and the second argument:

```ts
    const surfaces = surfacesOf([memory, other]);
    expect(surfaces.primary).toBe(memory);
    expect(surfaces.find('other')).toBe(other);
    expect(surfaces.find('teams')).toBeUndefined();
```

In `harness/approvals/src/domain/surfaces/dual-surface.test.ts`: delete the whole case `collects the credentials of every loaded adapter, from the adapters themselves` and the doc comment above it; delete the `declared` local and the `slackSurface`/`memorySurface`/`stubSurface` imports it was the only user of; delete `STUB_SECRET` from the `./stub-surface.test-helpers.js` import, which the deleted case was its only user of (`unused-imports/no-unused-imports` is an **error** here, so leaving it fails `pnpm lint`, not just the warning budget); and call `surfacesOf([slack.session, memory, stub])`. `STUB_SECRET` stays exported from the helper file — an export nobody imports is not a lint failure, and it is what the stub's `secrets` list is built from. **Keep `stubSession` and the helper file**: the stub is still the third loaded surface in every other case, which is what makes "cards go to the primary only" a statement about more than a pair. Rewrite the helper's own header comment, which currently promises the union:

```ts
/**
 * A third surface, so that "the primary only" is proved against more than a pair.
 *
 * The memory adapter and the Slack adapter are the two a deployment really loads; a host that
 * posted to the first two of three would pass a suite that only had two. Not shipped, and not a
 * second memory adapter: it has no configuration of its own, and nothing but `name` is asserted
 * against it.
 */
```

and `wire()`'s comment, which says the secrets come off the adapters' own declarations, goes with the case it explained.

- [ ] **Step 6: Delete the stale sentence**

In `harness/shared/src/env.ts`, the paragraph on `requiredEnv`:

```ts
/**
 * Read a variable that has no sensible default, or fail startup naming it. An empty string
 * counts as unset, or a half-filled `.env` starts a process that fails later and further from
 * the cause.
 *
 * `env` is a parameter because a plug-in reads the map on `deps.env` rather than the ambient
 * environment: whoever builds the bag decides what the plug-in can see, which is what stops a
 * suite from reaching a real workspace because the machine running it has a filled-in `.env`.
 */
```

The sentence it replaces named `coreToolsChildEnv` in `@harness/approvals`, which no longer exists.

- [ ] **Step 7: Rewrite the Slack block in `.env.example`**

Replace the comment lines above `SLACK_BOT_TOKEN`:

```
# --- Slack adapter (@harness/surface-slack) ---
# ONE Slack app, receiving events over HTTPS. In the app's configuration, set BOTH request URLs —
# Event Subscriptions and Interactivity & Shortcuts — to
#   https://<this host>/tenants/<clientId>/slack/events
# and leave Socket Mode off; there is no app-level token any more. Bot scopes: chat:write,
# app_mentions:read, channels:history, groups:history, im:history, im:read, im:write,
# mpim:history, users:read, usergroups:read, files:read, files:write. Subscribe the app to the
# message.channels, message.groups, message.im, message.mpim and app_mention events, and invite
# the bot to the channels it should answer in. See docs/runbook.md, "Slack over HTTPS", for how a
# request reaches a host on a developer's machine.
SLACK_BOT_TOKEN=
```

and the comment above `SLACK_SIGNING_SECRET`:

```
# The app's signing secret (Basic Information -> App Credentials). EVERY inbound request is
# verified against it before a byte of the body is read; a request that is unsigned, badly signed
# or more than five minutes old is refused and written to the audit log once. A client document's
# `surfaces.slack.signingSecret` names this variable, and a tenant whose named variable this
# deployment does not set refuses to open, naming both the client and the variable.
SLACK_SIGNING_SECRET=
```

- [ ] **Step 8: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `git status --short docs/architecture` is empty: the environment scan reads `.env.example` for *names*, and no name moved.

- [ ] **Step 9: Commit**

```
git add harness/core-tools/src harness/approvals/src harness/shared/src .env.example
git commit -m "chore: forbid socket mode in the kernel and drop the surface secrets nothing read"
```

---

### Task 9: Documentation

**Files:**
- Modify: `README.md`, `ARCHITECTURE.md`, `CONTRIBUTING.md`
- Modify: `docs/runbook.md`, `docs/demo.md`
- Modify: `docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md` (one amendment note in §4.7)
- Modify: `surfaces/slack/README.md`, `surfaces/memory/README.md`, `harness/host/README.md`
- Modify: `docs/architecture/graph.svg` (regenerated)
- Create nothing: `harness/surface-api/README.md` and `harness/sandbox-api/README.md` were written by Tasks 1 and 5; check each still describes what shipped.

**No code.** If a step here wants a code change, it belongs in the task that shipped the code.

- [ ] **Step 1: Find what is now wrong**

Run:
```bash
grep -rn "Socket Mode\|socket mode\|Bolt\|bolt\|SLACK_APP_TOKEN\|app-level token\|harness-host\|--build" README.md ARCHITECTURE.md CONTRIBUTING.md docs/*.md surfaces/*/README.md harness/*/README.md
```

Every hit is a line this task rewrites or deletes. The steps below name the sections that need more than a find-and-replace.

- [ ] **Step 2: The runbook — "Slack over HTTPS"**

Replace the section `### Slack credentials: one app` whole (the outer fence here is four backticks
because the section itself contains fenced blocks):

````markdown
### Slack over HTTPS

One Slack app per tenant, delivering to a URL. The host holds no connection to Slack at all:
every event and every button press arrives as a signed POST, which is what lets a host be paused,
resumed, pooled behind an ingress, or run as one of many in a process.

| App | Variables | Bot scopes | Other settings |
|---|---|---|---|
| The host's Slack app | `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` | `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `users:read`, `usergroups:read`, `files:read`, `files:write` | Socket Mode **off**, Interactivity on, both request URLs set |

**Both request URLs are the same URL**, and it carries the tenant:

```
https://<this deployment>/tenants/<clientId>/slack/events
```

Set it under **Event Subscriptions → Request URL** and under **Interactivity & Shortcuts →
Request URL**. Slack sends a one-time `url_verification` challenge when each is saved; the host
answers it, over the same verification as everything else, so a URL that saves is a URL whose
signing secret is already right. Subscribe the app to `message.channels`, `message.groups`,
`message.im`, `message.mpim` and `app_mention`, and invite the bot to `SLACK_APPROVALS_CHANNEL`
and to every channel it should answer in.

**There is no app-level token.** `SLACK_APP_TOKEN` is gone, and a deployment that still sets it is
setting nothing.

**Every request is verified before it is read.** HMAC-SHA256 over `v0:<timestamp>:<the raw body>`
with the signing secret, compared in constant time, with a five-minute window. A request that is
unsigned, badly signed or stale is refused before the body is parsed and written to `audit_log`
exactly once, as `surface_request` / `refused`, carrying the reason —
`missing_signature`, `bad_signature`, `stale_timestamp` — and nothing of the body. A repeated
`stale_timestamp` with everything else healthy is a clock: check the container's.

**A retried delivery is dropped.** Slack retries anything it has not heard about within three
seconds; the host answers immediately and runs the turn afterwards, so a retry means the first
copy is already in flight. Those are answered `200` with `X-Slack-No-Retry: 1` and one log line.
The cost of that, stated plainly: when the first copy's turn **fails** before it posts anything,
the retry was the only second chance and it has been discarded, so the message is never answered
and the whole record of it is one `error` line naming the delivery. Watch the host's log for those;
there is no dedupe table and no redelivery to fall back on.

**One app per tenant, or one app across several.** Each tenant's document names the variables its
own credentials live in (`surfaces.slack.botToken` and `surfaces.slack.signingSecret`), so a
pooled host can hold two workspaces' apps at once — and its `surfaces.slack.teamId` must be the
workspace the app is installed in, because that is what an inbound event's workspace is matched
against. Find the id in the `T…` segment of any workspace URL
(`https://app.slack.com/client/T0123456789/…`), or by calling `auth.test` with the bot token.

**A reply inside a thread the bot has already posted in needs no mention**: the thread is the
conversation, so a follow-up written there is answered as it stands. It is the bot's *own* posts
that make a thread its own — another app's messages in a thread, a GitHub or an alerting bot's,
leave it somebody else's — and the refusal a sender the identity plug-in does not know is shown
claims no thread either, so refusing somebody once does not refuse them for every line afterwards.
````

Keep the paragraphs that follow the old section as they are: the thread rule paragraph above is
the same text the file already carries.

- [ ] **Step 3: The runbook — "Local development with a tunnel"**

Add a subsection immediately after "Slack over HTTPS":

````markdown
### Local development with a tunnel

Slack has to reach the host, and the host publishes `8788` on `127.0.0.1`. A tunnel gives that
port a public HTTPS URL for as long as it runs. Nothing in this repository knows about it: it is a
process beside the host, and the only thing that changes is the request URL in the Slack app.

```bash
# Cloudflare, no account needed for a quick tunnel:
cloudflared tunnel --url http://127.0.0.1:8788

# or ngrok:
ngrok http 8788
```

Both print a URL. Put `<that URL>/tenants/<clientId>/slack/events` in both request URLs of the
Slack app and save; Slack's `url_verification` challenge is answered by the host, so a URL that
saves is a tunnel that works.

A quick tunnel's URL changes every time it restarts, and the Slack app has to be re-pointed when
it does. That is the whole of the friction, and it is the reason a shared deployment gets a real
hostname instead.

**In production, something terminates TLS in front of the host.** The host speaks HTTP, binds
whatever `HARNESS_HOST_BIND` says, and trusts nothing about the connection: the signature is what
authenticates a request, so a reverse proxy, an ingress or a tunnel in front of it changes nothing
about what the host checks.
````

- [ ] **Step 4: The runbook — the run API's listener**

Three passages now say something that is no longer true.

At `## The run API`, replace the second sentence:

```markdown
Five routes in the host, on `HARNESS_HOST_BIND:HARNESS_HOST_PORT` (default `127.0.0.1:8788`),
behind `Authorization: Bearer $HARNESS_HOST_TOKEN`, compared in constant time. **With no token
these five routes answer 401** — the listener itself always runs, because it also carries every
tenant's surface mounts under `/tenants/<clientId>/…`, which have their own verification and must
answer whether or not this deployment uses the run API. The host's `listening` line says which it
is: `runApi=open` or `runApi=closed (set HARNESS_HOST_TOKEN)`.
```

In the deployment checklist, the entry describing `HARNESS_HOST_TOKEN` as "**unset means no run
API**" becomes "**unset means the run API answers 401**; the listener runs either way, for the
surface mounts", and the step "**Optional: turn the run API on.**" keeps its text but loses the
sentence about a listener appearing.

The `listening` line's description gains its new spelling: `runApi=open` / `runApi=closed (set
HARNESS_HOST_TOKEN)`.

- [ ] **Step 5: The runbook — "Releasing"**

Add a section after "Upgrading to Plan 11a":

````markdown
## Releasing

A release is a tag. Everything else follows from it.

```bash
pnpm release:version 0.2.0        # every workspace package to one version
# write the 0.2.0 section of CHANGELOG.md, if it is not written
git commit -am "chore: release 0.2.0"
git tag v0.2.0
git push && git push --tags
```

The `release` workflow then, in this order: runs the five gates against a real Postgres, refuses
the tag if the packages are not at that version or the changelog does not describe it, builds and
pushes `ghcr.io/mgavrila/agent-harness-host:0.2.0` and `…/agent-harness-files:0.2.0`, builds and
packs the seven published packages, and creates the GitHub Release with the tarballs,
`tool-surface.json` and `compose-surface.yaml` attached and the changelog section as its body. A
tag that fails a gate publishes nothing.

**What a deployment consumes.** Set `HARNESS_IMAGE_TAG=0.2.0` in `.env`; Compose pulls both images
and builds nothing.

**What the platform repository consumes.** The seven packages are attached to the release as
tarballs, because GitHub Packages requires an npm scope equal to the repository owner and
`@harness/*` is not one. Pin them by URL, and override the transitive names too — the tarballs
depend on one another by exact version:

```json
{
  "dependencies": {
    "@harness/config-api": "https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-config-api-0.2.0.tgz"
  },
  "pnpm": {
    "overrides": {
      "@harness/shared": "https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-shared-0.2.0.tgz",
      "@harness/pack-api": "https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-pack-api-0.2.0.tgz",
      "@harness/identity-api": "https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-identity-api-0.2.0.tgz"
    }
  }
}
```

The published packages are the contracts and their testing kits: `@harness/shared`,
`@harness/pack-api`, `@harness/config-api`, `@harness/surface-api`, `@harness/identity-api`,
`@harness/runtime-api`, `@harness/sandbox-api`. Everything else — the kernel, the host, the
adapters, the packs — is private and is consumed as the image.
````

- [ ] **Step 6: The runbook — "Upgrading to Plan 11b"**

Add a section immediately after "Upgrading to Plan 11a":

```markdown
## Upgrading to Plan 11b

No migration and no data change. Four things move, and three of them are in a Slack app's
configuration.

1. **Release, or pick, an image tag**, and set `HARNESS_IMAGE_TAG` in `.env`. Compose no longer
   builds anything: `pnpm demo:up` pulls. A deployment that wants to run its working tree builds
   its own image with `docker build -f harness/compose/node.Dockerfile` and tags it itself.
2. **Turn Socket Mode off** in the Slack app, set both request URLs to
   `https://<host>/tenants/<clientId>/slack/events`, and delete the app-level token. Delete
   `SLACK_APP_TOKEN` from `.env` and from anything that sets it: nothing reads it.
3. **Put the host somewhere Slack can reach.** A reverse proxy, an ingress, or a tunnel for a
   developer's machine — see "Local development with a tunnel".
4. **Nothing else.** The host's ports, its health check, its database, its documents and its
   identity are unchanged, and a turn taken over HTTPS is the same turn.
```

- [ ] **Step 7: `ARCHITECTURE.md`**

Three edits.

The `surfaces/slack` line in the tree listing:

```
surfaces/slack      the Slack adapter: Block Kit, signed requests over HTTPS, the Web API slice.
```

The tooling table row for `kernel-vocabulary.test.ts` gains the new word in its list: `(slack,
bolt, block kit, thread_ts, blocks, socket mode)`.

And a section after "Surfaces":

```markdown
## Reaching a surface

A surface either opens its own connection or is reached by a request. One that is reached offers
`http`: a mount path and a handler. The host mounts every tenant's at
`/tenants/<clientId>/<path>` on the HTTP server it already runs for the run API — one rule for a
dedicated deployment and a pooled one alike, because a path is the only place a transport that
knows nothing about this deployment can be told to carry the tenant.

The host resolves the client from that path through the same resolver a message goes through, so a
dedicated host refuses another client's id and audits it, and a pooled host opens whichever tenant
the path names. Then it hands the handler the method, the rest of the path, the lower-cased
headers and the **raw** body, because a signature is computed over bytes.

What authenticates the request is the surface's, not the host's: the host cannot check a
transport's signature without knowing the transport, and knowing the transport is what this
boundary exists to avoid. What the host does is audit. A handler that answers with a refusal gets
exactly one `audit_log` row — `surface_request` / `refused` — carrying a short reason and nothing
of the body, because a refused request is one nobody has authenticated.

The Slack adapter is the worked example: one URL for events and interactions, HMAC-SHA256 over
`v0:<timestamp>:<body>` with a five-minute window, `url_verification` answered, an acknowledgement
inside three seconds and the turn run afterwards. `MemorySurface.mountHttp()` is the reference
implementation, off until something calls it.
```

and a section after it:

```markdown
## What this repository publishes

Seven packages and two images, from one tag. The packages are the contracts and their testing
kits — `@harness/shared`, `@harness/pack-api`, `@harness/config-api`, `@harness/surface-api`,
`@harness/identity-api`, `@harness/runtime-api`, `@harness/sandbox-api` — built to `dist/` with
declarations and attached to the GitHub Release as tarballs, with `tool-surface.json` and
`compose-surface.yaml` beside them. The images are the host and the files worker, at
`ghcr.io/mgavrila`, and Compose pulls them by `HARNESS_IMAGE_TAG`.

Everything else is private: the kernel, the host, the adapters, the packs. A consumer runs those
as the image and implements the contracts. That division is the boundary of decision 1b in one
sentence — the platform depends on what this repository *promises*, not on what it *is*.
```

- [ ] **Step 8: `README.md` and `CONTRIBUTING.md`**

`README.md`: the two lines about one Slack app in Socket Mode become

```markdown
One Slack app, receiving events over HTTPS at `/tenants/<clientId>/slack/events`, carries both
chat and approvals; see `docs/runbook.md`, "Slack over HTTPS", for the scopes, the request URLs
and how to reach a host on your own machine.
```

and the sentence about the run API existing only when `HARNESS_HOST_TOKEN` is set becomes "the
run API answers only when `HARNESS_HOST_TOKEN` is set".

`CONTRIBUTING.md`: the worked-example line points at the file the classifier now lives in —
`surfaces/slack`'s `classifyMessage` (`src/transport/classify.ts`) — and the section about writing
a surface gains a paragraph:

```markdown
A surface that is reached by a request rather than by a connection it opens returns
`http: { path, handle }` from `connect`, and the host mounts it at
`/tenants/<clientId>/<path>`. Verify whatever your transport signs with, in the adapter: the host
will not, because it would have to know your transport to try. Answer
`{ status, refusal: { reason } }` for anything you turn away and the host writes the single audit
row; `reason` is a short token, never a sentence, because it goes in a column somebody groups by.
```

- [ ] **Step 9: `docs/demo.md`**

The Slack steps become: create one app, Socket Mode off, Interactivity on, both request URLs
pointing at `https://<tunnel or host>/tenants/<clientId>/slack/events`; paste `SLACK_BOT_TOKEN`,
`SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL` into `.env`; set `HARNESS_IMAGE_TAG`. The
smoke check that printed `SLACK_APP_TOKEN` inside the container prints `SLACK_SIGNING_SECRET`
instead. Add one line under the setup steps saying that `pnpm demo:up` now pulls the image named
by `HARNESS_IMAGE_TAG` and builds nothing.

- [ ] **Step 10: The package READMEs**

`surfaces/slack/README.md`: the header sentence loses "Bolt in Socket Mode" and gains "signed
requests over HTTPS"; the `src/transport/` line lists `classify.ts`, `events.ts`, `signature.ts`,
`files.ts`, `types.ts`, `web-client.ts` and `fake.ts`; the paragraph about Bolt's listeners
becomes the one about the mount and the verification; the line about `SLACK_APP_TOKEN` becomes
`SLACK_SIGNING_SECRET`; and the sentence about `context.botId` says `auth.test` instead.

`surfaces/memory/README.md` gains a paragraph:

```markdown
It is also the reference implementation of the surface contract's `http` seam:
`MemorySurface.mountHttp()` gives it an inbound door that takes `{ userId, text }` as JSON and
delivers it as a message. **It is off until something calls it**, and this package never does:
this surface authenticates nobody, so a door to it is a door to speaking as anyone. A host test
mounts it on the session the pool opened, which is how the host's dispatch is proved against a
surface that really loaded.
```

`harness/host/README.md`: the paragraph about the run API's listener says it always runs, serves
`/v1` behind the bearer and `/tenants/<clientId>/…` in front of it, and that an empty
`HARNESS_HOST_TOKEN` closes the first rather than the socket.

Check `harness/surface-api/README.md` (Task 1) and `harness/sandbox-api/README.md` (Task 5) still
describe what shipped, and fix any sentence that describes an intention rather than the code.

- [ ] **Step 11: One line in the os-boundary spec**

§4.7 says "`release.yml` on a tag runs `pnpm -r publish`", and it cannot: the scope conflict in
decision 6 is a fact about GitHub Packages, not a choice this plan made. Record it where the next
plan will read it, immediately after that sentence in
`docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md`:

```markdown
> **Amended by Plan 11b.** The packages are attached to the GitHub Release as `pnpm pack` tarballs
> rather than pushed with `pnpm -r publish`: GitHub Packages resolves an npm scope to the
> repository owner, and `@harness/*` cannot be published there without renaming every package and
> every import. A consumer pins tarball URLs and a `pnpm.overrides` block. Moving to a registry is
> a change to two steps of `release.yml` and to nothing else.
```

Change nothing else in that spec: it is the record of what was decided, and this is a note about
what the code could not do, not a rewrite of the decision.

- [ ] **Step 12: Regenerate the architecture graph**

Run: `pnpm arch:graph`
Expected: `docs/architecture/graph.svg` gains `@harness/sandbox-api` and loses nothing. If `dot`
is not on PATH, say so and leave the file — it is a picture, and a stale one is better than a
broken one.

- [ ] **Step 13: Run the four gates**

Run the gate command from Task 1 Step 10.
Expected: all green. `pnpm format:check` covers markdown, so a long line fails it — run `pnpm
format` if it does. `git status --short docs/architecture` shows `graph.svg` and nothing else.

- [ ] **Step 14: Commit**

Named rather than `docs`, which would sweep in this plan document — committed once, by Task 1 — as
well as everything else under that directory.

```
git add README.md ARCHITECTURE.md CONTRIBUTING.md docs/runbook.md docs/demo.md \
  docs/architecture/graph.svg docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md \
  surfaces/slack/README.md surfaces/memory/README.md harness/host/README.md
git commit -m "docs: describe Slack over HTTPS, the surface mount, the tunnel and the release"
```

---

## Self-review

**Review pass, 2026-09-21**, run against the worktree before this plan was finished: spec coverage
sentence by sentence, a placeholder scan, a type-consistency pass across the nine tasks, the
deletion list per task, and a check that every task ends on the gates. Eleven things were wrong or
unverified and are fixed above; each is named below with what it cost.

### 0. Review round 1, 2026-09-21

An independent read against the spec, the grounding map and the code
(`.superpowers/sdd/2026-09-21-plan-11b-transport-and-publishing/plan-11b-review.md`) found five
blocking, six important and nine minor problems. **All twenty are applied**, plus the three
concrete additions its "Decisions I would revisit" section asked for. Nothing was ruled against.
What changed, and where:

- **B1 — `/tenants` and `/tenants/` answered 401, not 404.** The router strips a trailing slash
  before matching, so neither satisfied `startsWith('/tenants/')` and both fell through to the
  bearer, failing two entries of Task 2's own loop. The guard is now
  `route === '/tenants' || route.startsWith(TENANT_PREFIX)`, with the reason in the comment, and
  the test says why the two spellings are one string.
- **B2 — every turn Task 2's doors started would have been refused.** A pooled host refuses a
  surface event whose tenant hint is null, the memory door calls `say` with no override, and the
  fixture declared `surfaces: { memory: {} }` — so both turn-running cases would have hung on
  `waitFor` until it threw. `documentFor` now declares `workspace: id`, and the comment above it
  explains the chain from the document to the hint so the next editor does not undo it.
- **B3 — Task 3's transport had no seam for a fake, so four cases called slack.com.**
  `eventsTransport` takes its `SlackApi` as a defaulted fourth parameter; the test passes
  `FakeSlack`, which is also the only way `U0BOTUSER` can be the bot id the mention-stripping case
  asserts against. `FakeSlack.authTestCalls` — added in Step 6 and previously asserted by nothing —
  is now checked, before and after a delivery. The signature change is carried into the task's
  Interfaces block and the file-structure section.
- **B4 — Task 2 wrote "a Slack team id" into `harness/host/src`.** That is the one thing §4.6 names
  outright, and the vocabulary scan reads comments. The sentence paraphrases decision 4 instead, a
  note under it says why the spec's own wording cannot be quoted there, and Task 2's gate step now
  runs the grep itself. I re-grepped every host-bound and core-tools-bound code block in this plan:
  that line was the only hit, and there is none now.
- **B5 — an unauthenticated caller could enumerate a pooled host's tenants.** `/tenants/*` sits in
  front of the bearer by design, and "no such client" versus "no such route" told an anonymous
  caller which ids exist. Every miss below the prefix now answers `404 {"error":"no such route"}`:
  the resolver refusal, the unknown client, the unclaimed path and the empty prefix. The audit row
  still distinguishes them, which is where the distinction belongs. Task 2 gains a case asserting
  that a real tenant at an unclaimed path and a client that does not exist are identical in status
  and body, and the dedicated-host case's expected body follows.
- **I1, I2** — Task 8 missed `registry.test.ts:18`'s `expect(surfaces.secrets).toEqual([])`
  (a typecheck failure) and left `STUB_SECRET` imported with nothing using it (a lint **error**,
  not a warning). Both are named now.
- **I3** — `@harness/runtime-api/testing` reaches `vitest` *and* `@modelcontextprotocol/server`,
  and the second is a devDependency, so the published subpath would not have resolved. Task 6 adds
  both as optional peers, tells the implementer which two files to read first, and the changelog
  bullet says what `./testing` costs a consumer.
- **I4** — Task 4 was leaving `.env.ci` behind with a comment describing the command the same task
  deletes. It is deleted, with its `.gitignore` negation, and the task ends with a grep proving no
  reader is left.
- **I5** — three comments in `surfaces/slack/src/transport/types.ts` point at `bolt.ts`, which
  Task 3 deletes. Task 3 rewrites them, and checks `fake.ts` and `web-client.ts` for the same.
- **I6** — decision 11's whole safety argument is "`surfaces/memory` never calls `mountHttp()`",
  and nothing pinned it. Task 1 adds the case that fails if anyone ever does.
- **M1–M9** — the unused `MessageEvent` import is gone rather than deferred to the linter; the
  `host-vocabulary.test.ts` self-check instruction names its real five-and-two lists; the Compose
  snippets say explicitly that only `build:` and `image:` change; two `git add` lines name files
  instead of globbing (and Task 1 now commits this plan document, once); the retry comment says
  that the interactivity branch never fires; `http.test.ts` has nine cases, not eight, and
  `surfaces.test.ts` twelve; `SurfaceHttpRequest`'s comment says the seam is text rather than
  bytes and what that costs; and the `foreign_client` audit row hashes the id that was asked for,
  so two refusals can be told apart.
- **D1, D3, D5** — the runbook now says that a retry dropped after a failed turn is a message
  never answered, with the log line as its only record; the `./testing` peers are I3's fix; and
  Task 3 gains a case proving a document that names its own variables is honoured, so the
  conventional-name fallback is not the only path the suite exercises. **D2** — §4.7's
  "`pnpm -r publish`" cannot be done for the scope reason in ruling 1, so Task 9 adds an amendment
  note to that section of the spec rather than leaving the next plan to rediscover it.

The four step renumberings this caused (Task 1 gains two steps, Task 9 one) are carried through
every cross-reference: the gate command is "Task 1 Step 10" in all eight tasks that cite it.

### 1. What the first pass found, and what changed

1. **`bearerOk('Bearer ', '')` is `true`.** Two empty buffers have equal length and
   `timingSafeEqual` on them returns true, so making the listener always start would have let a
   caller in to `/v1/*` on a deployment that had set no `HARNESS_HOST_TOKEN` at all — the exact
   deployment the old "no token, no listener" rule protected. Task 2 refuses an empty token before
   it compares anything, and `surfaces.test.ts` drives it with `Bearer `, with a wrong token and
   with no header.
2. **`routes.ts` and a surface dispatch would have been a cycle.** Both need a body reader, and
   `no-circular` is an error. `json` and `readBody` move to a leaf `api/http.ts` (decision 15), and
   `routes.test.ts`'s one import moves with them.
3. **Nothing could hand the Slack adapter the variable names its document declares.** §4.6 says
   the surface's secrets become `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`, and §4.1's document
   declares both as `SecretRef`s, but `SurfaceDeps` carried no way to say which variable this
   tenant used. Decision 12 threads it: `surfaceSecretsOf` gains an opaque `field`,
   `loadSurfaces`'s third parameter becomes `SurfaceSettings`, and `SurfaceDeps` gains `secrets`.
   Without this the "tenant's signing secret" of §4.6 would have been a conventional name in a
   comment.
4. **A consequence of that, recorded rather than discovered later:** `slackConfig` looks its names
   up, so the environment scan stops seeing `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`. Nothing
   fails — the scan's rule is one-directional and `.env.example` documents all three — and
   `SLACK_APPROVALS_CHANNEL`, one of `SCAN_ANCHORS`, stays a literal in the same function, so the
   scan still proves it ran.
5. **The host's dispatch had no surface to be proved against.** A document may declare only
   `slack`, `memory` or `http`; Slack's `start()` now calls `auth.test` over the network and
   `surfaces/http` opens nothing. `MemorySurface` implements the seam, **off until `mountHttp()`**
   (decision 11), so `surfaces.test.ts` drives a session the real pool really loaded and no
   deployment grows an unauthenticated message injector.
6. **Compose has three build blocks, not one.** Decision 8 removes every `build:`, and the `files`
   worker is built from the checkout, so a stack with no build and no image for it would not
   start. Both images are released under one tag and `release.yml` pushes both; `ci.yml` builds
   both with `docker build`. The `core-tools` build-only service goes, as decision 8 allows —
   its own comment says its only purpose is proving an image builds — and `core-tools.Dockerfile`
   goes with it, because it had exactly one consumer. `readComposeSurface` drops `--profile
   build-only` in the same task, or the snapshot would render a profile that no longer exists.
7. **`Decision` is a bare TypeScript union and `audit_log.decision` is unconstrained `text`.**
   So invariant 15's `refused` costs one type change and **no migration**, which is what let this
   plan keep its "no task touches `schema.ts` or `drizzle/`" constraint (decision 13).
8. **`useTestDb()` returns the handle, not `{ db }`.** Plan 11a's Task 8 snippet destructured it;
   the function is `export function useTestDb(): Db`. Both new database-backed test files here use
   the real form.
9. **`dist/` is already gitignored**, beside `node_modules/`. Task 6 was going to add it; it adds
   nothing and says so.
10. **The publishing mechanism was assumed and is now measured.** Three facts were verified by
    running them rather than by reading documentation: pnpm applies `publishConfig.exports` at pack
    time and drops `publishConfig` from the published manifest; pnpm rewrites `workspace:*` to the
    exact version, which is why one version across the set is a correctness requirement and not
    tidiness; and `tsc` 7.0.2 emits ESM and declarations from this base config but needs its own
    `rootDir` and `include`, because the package `tsconfig.json` includes `vitest.config.ts` and
    `TS6059` is what happens otherwise.
11. **One draft assertion in the release-workflow test was nonsense** — a ternary over an object
    literal, left over from an earlier shape of the image check. It is a plain `toContain` over
    `<image>:$VERSION` now, and the paragraph that apologised for it is gone.

Three smaller corrections, recorded so a reviewer is not surprised: `yaml@2` keeps `on` as an
ordinary string key, which is why the release-workflow test can read `parsed.on` (checked, not
assumed); `AuthTestResponse` in `@slack/web-api@8.1.1` declares both `user_id` and `bot_id`, so
`webClientApi`'s new slice needs no cast; and every occurrence of "socket mode" in this
repository's TypeScript is inside `surfaces/slack`, which Task 3 rewrites and which no vocabulary
test scans — so Task 8's widening of `MESSAGING_FORBIDDEN` is green the moment it lands.

### 2. Spec coverage

| Spec | Where |
|---|---|
| §2 decision 9, Slack over HTTPS, socket mode removed | Task 3 |
| §2 decision 9, "local development uses a tunnel (documented in the runbook)" | Task 9 Step 3 |
| §2 decision 10, tagged releases publish packages and the image, with both snapshots as artefacts | Tasks 6 and 7 |
| §2 decision 10, "a changelog written for the platform team" | Task 7 Step 4 |
| §2 decision 14, `@harness/sandbox-api` reserved: acquire, exec, put, get, terminate | Task 5 |
| §2 decision 14, "no implementation in Plans 11–12"; the `execute` class is Plan 12's | Task 5 ships no action class, and the "Not in this plan" list says why |
| §2 decision 2b, no backwards compatibility | Task 3 deletes `bolt.ts` and the dependency; Task 4 deletes the variable, the service and the Dockerfile; Task 8 deletes `LoadedSurfaces.secrets`. Nothing is behind a flag |
| §4.6 `transport/events.ts` replaces `bolt.ts` as the one `SlackTransport` | Task 3 Steps 5, 9 and 14 |
| §4.6 verify `X-Slack-Signature`, HMAC over timestamp and raw body, five-minute window | Task 3 Steps 1–4 |
| §4.6 answer `url_verification` | Task 3 Step 9, `handleEvent` |
| §4.6 acknowledge within 3 seconds and hand the normalised event to the same pipeline | Task 3 Step 9, `later` + `deliver`, proved by the "runs the pipeline after acknowledging" case |
| §4.6 `stream.ts` and `files.ts` unchanged | Neither is touched; `downloadAttachments` is called with the same arguments |
| §4.6 the host must not name Slack | `harness/host/src` gains a path and a reason that are both data; `kernel-vocabulary.test.ts` proves it, with an empty allowlist and one more forbidden word |
| §4.6 the surface contract gains an optional `http: { path, handler }` the host mounts beside the run API | Task 1 declares it (the member is `handle`, because it is a method) and Task 2 mounts it |
| §4.6 `SlackApi` gains `auth.test` so `classifyInbound` keeps its comparison | Task 3 Step 6, and the case that proves the mention is still stripped |
| §4.6 secrets become `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`; `SLACK_APP_TOKEN` goes | Task 3 Step 13, Task 4 Step 5 |
| §4.6 Bolt removed with its dependency; the fake transport stays | Task 3 Step 14; `FakeSlack`/`FakeSlackEvents` are extended, never replaced |
| §4.7 drop `private` on the packages the platform consumes and add `publishConfig` | Task 6 |
| §4.7 `release.yml` on a tag, the image to the registry, both snapshots attached | Task 7 |
| §4.7 "runs `pnpm -r publish`" | **Not literally** — see the ruling below |
| §4.8 "Sandboxes (reserved)" paragraph | Task 5, member for member |
| §5.2 every clause | Slack events transport with signature verification (Task 3); Bolt and socket mode removed (Task 3); Compose pulls the published image (Task 4); `release.yml` (Task 7); `publishConfig` on the consumed packages (Task 6); `@harness/sandbox-api` as an interface with a conformance stub (Task 5); runbook with the tunnel (Task 9) |
| §7 first bullet, "the image is pulled, not built" | Task 4 |
| §8 invariant 15, an invalid or stale event is dropped before parsing and audited once | Task 3 verifies before parsing; Task 2 writes the one row, and `surfaces.test.ts` asserts exactly one row carrying nothing of the body |
| §8 invariant 19 on an HTTP path, a dedicated host refuses another client and audits it | Task 2, `handleSurfaceRequest`, with its own case |
| §9 "tested with signed, unsigned and stale synthetic requests" | Task 3's `signature.test.ts` and `events.test.ts` |
| §9 "the socket-mode tests go with the code" | `bolt.test.ts` becomes `classify.test.ts`: the 18 cases it holds test the classifier and the thread memory, which survive; nothing in it tested a socket |
| §9 the tool-surface snapshot grows by nothing | Byte-identical in all nine tasks, asserted at every gate step |
| §9 the compose snapshot changes once | **Once, in Task 4**, which is the only task that edits Compose |
| §9 the kernel-vocabulary test widens | Task 8 |
| §10 row 11b's exit criterion | "A Slack event delivered over HTTPS to a host with no socket runs a turn": Task 2's mount case runs a turn from a request end to end through a real pool, and Task 3 proves the Slack half from a signed body to the pipeline. "A tag publishes packages and image": Task 7, with a test over the workflow |
| §12 constraint 1, a new variable must be in `.env.example`; plug-ins read `deps.env` | `HARNESS_IMAGE_TAG` documented in Task 4; the Slack adapter still reads `deps.env` only, and its ESLint exemption is unchanged |
| §12 constraint 2, byte-exact snapshots | Global Constraints, and the one re-record in Task 4 |
| §12 constraint 3, the vocabulary test | Task 8, allowlist still empty |
| §12 constraint 4, `pnpm arch`'s plug-in rules | Unchanged and unweakened: the host reaches a handler through a session object it already holds, and the Slack adapter still imports only its contract, `@harness/shared`, itself and third-party packages |

**Not covered, and why.** §9's "no `jev` outside the typed-model implementation package" belongs to
Plan 12, which is what introduces the name. §4.8's typed model access, orchestration seam and
declared plug-ins are Plan 12 by §5.3. The `execute` action class is named in decision 14 but
placed in §5.3, and adding it here would move the tool surface this plan must keep byte-identical.

### 3. Rulings

Four places where the brief, the spec and the code did not all agree, and what this plan decided.

1. **`release.yml` does not run `pnpm -r publish`.** §4.7 says it should, and it cannot: GitHub
   Packages resolves a scope to the repository owner, and `@harness/*` is not `@mgavrila/*`, so
   publishing there means renaming seven packages and every import in the workspace — a rename
   that belongs to whichever organisation ends up owning the scope, not to this plan. The
   artefacts are real either way: tarballs built by `pnpm pack`, with `publishConfig` applied and
   `workspace:*` rewritten, attached to the release. A consumer pins URLs and a `pnpm.overrides`
   block, which the runbook spells out. When there is a registry, the change is two steps of one
   file.
2. **Two images are published, not one.** Decision 6 names the host image; decision 8 removes
   every `build:` block. The `files` worker is built from the checkout today, so honouring the
   second means the first has a sibling. They share a tag, `HARNESS_IMAGE_TAG` names it, and
   `release.yml`'s own test asserts both are pushed.
3. **The memory surface's door is opt-in, and it is the surface the host's dispatch is proved
   against.** The brief allowed either a test-only adapter in `harness/host/src/testing.ts` or the
   memory surface extended. The first cannot work: the host reaches an adapter only by dynamic
   import of `@harness/surface-<name>`, and only three names exist in `SURFACE_ORDER`. So the
   memory surface gets the door — and gets it behind `mountHttp()`, because that surface
   authenticates nobody and a door to it is a door to speaking as anyone.
4. **The listener keeps its names.** `startRunApi`, `RunApiOptions` and `RunApiServer` now serve
   two things. Renaming them would touch `main.ts`, `index.ts` and two test files and change no
   behaviour; the doc comments say what the server carries, and `RunApiOptions.token` says what an
   empty token now means.

### 4. Placeholder scan

Searched the whole plan for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate
error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to
Task`, `as needed` and `and so on`. **None present.** Every code step carries the code, every test
step carries the test, and every command step carries the command and what it should print.

Three steps tell the implementer to **read something and match it** rather than quoting it, and
each is a case where quoting would be a guess this plan has no business making: `harness/surface-
api/README.md`'s existing heading level and voice (Task 1 Step 8); `harness/approvals/src/host-
vocabulary.test.ts`'s self-check, which may or may not exist in the same shape as the kernel's
(Task 8 Step 1, which says what to do in both cases and why); and `harness/surface-api/vitest.
config.ts`, which Task 5 copies because it is the same two-line file in every leaf package. No
step carries an open branch.

### 5. Type consistency across tasks

- **`SurfaceHttpRequest`** is `{ method: string; path: string; headers: Readonly<Record<string,
  string>>; body: string }` in Task 1's declaration, in Task 2's construction and in Task 3's
  handler signature — four fields, same names, same types, and `body` is a raw string in all
  three because a signature is computed over it.
- **`SurfaceHttpResponse`** is `{ status; headers?; body?; refusal? }` in Task 1, is what Task 2
  reads (`refusal` for the audit row, the rest for the socket) and what Task 3 returns. No task
  invents a fifth field.
- **`SurfaceHttp`** is `{ readonly path: string; handle(request): Promise<SurfaceHttpResponse> }`
  in Task 1, is what `SlackTransport.http` holds in Task 3, and is what `mountFor` narrows to in
  Task 2. The member is `handle` everywhere; the word `handler` appears only in prose.
- **The published set** is the same seven names, in the same order, in decision 7, in Task 6's
  `PUBLISHED` constant, in Task 6 Step 4's two `publishConfig` shapes, in Task 7's workflow loop
  and in the changelog — and Task 7's test derives the list from the manifests and compares,
  so the workflow cannot drift from what is actually public.
- **`SurfaceSettings`** is `{ tenantKey?; secrets? }` in `@harness/approvals`, built in
  `tenant.ts` and spread into `SurfaceDeps`, whose own `tenantKey` and `secrets` have exactly
  those types. One shape, three files.
- **`surfaceSecretsOf`** returns `{ surface, field, env }` in Task 3's implementation, in the
  updated `document.test.ts` assertion and in `tenant.ts`'s loop. `assertSecretsPresent` reads
  `surface` and `env` and is untouched.
- **`Decision`** gains exactly one member, and the only new writer is `auditRefusal`, which passes
  the literal `'refused'`.
- **`TENANT_PREFIX`** is declared once, in `api/types.ts`, and read by `routes.ts`, `surfaces.ts`
  and `harness/host/src/index.ts`'s export list. The path it builds — `/tenants/<clientId>/<path>`
  — is spelled the same way in the contract's doc comment, the runbook, the changelog, `.env.
  example` and `ARCHITECTURE.md`.
- **`BotIdentity`** keeps its two optional fields; the only change is where they come from, and
  Task 3 updates the one comment that said where that was.
- **`SlackConfig`** is `{ botToken, signingSecret, defaultConversation }` in `config.ts`, in
  `testing.ts`'s literal and in `events.ts`'s reads. `appToken` exists nowhere after Task 3.
- **`eventsTransport`** takes four parameters — `(config, log, storageDir, api = webClientApi(new
  WebClient(config.botToken)))` — in its implementation, in Task 3's Interfaces block, in the
  file-structure entry, and in the two callers: `index.ts` passes three, `events.test.ts` passes
  four. `SlackApi` is the same type in all of them, and `FakeSlack` already implements it.

### 6. Deletions, per task

Task 1: nothing. Task 2: nothing (two functions move, and the file they move to is new). Task 3:
`transport/bolt.ts`, `transport/bolt.test.ts` (renamed to `classify.test.ts`), the `@slack/bolt`
dependency, the `appToken` field and its `requiredEnv` read, and three comments naming a framework
this package no longer has. Task 4: the `core-tools` Compose service, the `build-only` profile,
`harness/compose/core-tools.Dockerfile`, `.env.ci` and its `.gitignore` negation, three `build:`
blocks, `SLACK_APP_TOKEN` from `.env.example` and Compose, `--build` from `demo:up`. Task 5:
nothing. Task 6: nothing. Task 7: nothing. Task 8: `LoadedSurfaces.secrets`, `surfacesOf`'s second
parameter, one case in `dual-surface.test.ts`, **two** assertions in `registry.test.ts` and the
`STUB_SECRET` import, one stale sentence in `env.ts`. Task 9: the prose everywhere that describes a
socket.

### 7. Every task ends green

Nine tasks, nine "Run the four gates" steps, nine commits, and no gate deferred to a later task.
Task 4 is the only one whose gates involve a re-recorded snapshot, and its step says to check
`git diff --stat docs/architecture` and stop if `tool-surface.json` moved. Every other task's gate
step expects `git status --short docs/architecture` to be empty. Task 2's gate step also runs the
vendor grep over `harness/host/src`, because the failure it catches is a sentence rather than a
symbol. After round 1's renumbering the gate command is cited as "Task 1 Step 10" in all eight
later tasks, and the step numbers inside Tasks 1 and 9 are contiguous.

### 8. Re-run after round 1

The five checks were run again over the edited plan. **Spec coverage**: unchanged except that
§4.6's "the host must not name Slack" is now satisfied rather than violated, and §4.7 gains the
amendment note Task 9 Step 11 writes. **Placeholders**: none — the two sentences that deferred a
decision to the linter ("drop it if the linter says so") and to the file ("if it has one") are
replaced by the answer in both cases. **Type consistency**: `eventsTransport`'s new parameter is
the only signature that moved, and it is listed above; `SurfaceHttpRequest`, `SurfaceHttpResponse`,
`SurfaceHttp`, `SurfaceSettings`, `surfaceSecretsOf` and the published set are untouched by this
round. **Deletions**: `.env.ci` is the one addition, and it is in Task 4's Files list, its Step 5
and §6 above. **Gates**: nine of nine, as above.
