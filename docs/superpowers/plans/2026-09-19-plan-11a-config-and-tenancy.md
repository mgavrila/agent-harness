# Plan 11a: Configuration and tenancy — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a client a **document** loaded from outside this repository, and make the host able to serve more than one of them. One versioned schema (`@harness/config-api`) replaces the six-file folder; two `ConfigSource` implementations load it, from a directory named by `HARNESS_CLIENTS_DIR` or from versioned Postgres rows; the host becomes a factory over a `Map<clientId, Tenant>` with a `ClientResolver` that is dedicated when `HARNESS_CLIENT` is set and pooled when it is not; identity learns `defaults` and derived principals and gains a directory-backed provider over Slack user groups; policy learns `tools.hide`; five tables gain their tenant column and two idempotency indexes become per-tenant; runtime token spend is finally persisted and exported through `usage_runs` and `GET /v1/usage`. At the end of this plan two clients run in one host and no kernel tool of one can read a row of the other, and `clients/` holds one fixture that exists only so the suite has a document to read.

**Architecture:** Six moves. (1) **A contract.** `@harness/config-api` is a leaf package holding `ClientDocument`, `Blueprint`, `Overlay`, a lock set of JSON pointers, `resolve`, `migrate` and the `ConfigSource` interface, plus `@harness/config-api/testing` with a `MemoryConfigSource` and a `configSourceConformance(makeSource)` suite every source runs. The routing schema moves into it from `harness/gateway` and the playbook schema from `harness/host`, so one package owns every shape a tenant's configuration has. (2) **Identity by default.** `IdentityFile` gains `defaults`, a per-surface level for everyone the file does not declare, and a derived principal id `u-<surface>-<slug>-<8 hex of sha256>` that the same person lands on in every process and after every restart; `principalFromDerivedId` reads one back; `defaults.http` is refused. `identities/static` stops reading a file and reads its section off `IdentityDeps`. (3) **Two sources.** `harness/config-files` reads `HARNESS_CLIENTS_DIR/<id>/client.yaml` with an `!include` tag for the persona and the skills, resolving an optional `blueprint.yaml` + `overlay.yaml` on load and watching with a debounced `fs.watch`; `harness/config-postgres` reads `client_documents` and writes `client_document_versions`. (4) **The kernel reads the document.** `buildKernelConfig(document, env)` takes a resolved document; `storageRoot`, `loadKey` and `gatewayFromEnv` take the env map explicitly; `clientDirFor` and the module-level `repoRoot` go; `tools.hide` unions into the `hidden` set `publishedTools` already builds. (5) **Tenancy.** `createHost(deps)` returns a `HostPool` holding a `Map<clientId, Tenant>` invalidated through `ConfigSource.watch`; a `Tenant` is today's whole `Host` plus its version, its scheduler, its approvals runner and a `close()`. (6) **Usage.** The host persists every runtime `usage` event as a `model_calls` row, closes `runs` with totals, and a `usage_runs` view feeds `GET /v1/usage`.

**Tech Stack:** Node `>=22`, pnpm `11.4.0`, TypeScript 7 in every package (`typescript@6.0.3` at the workspace root only), ESM only, zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `0.45.2` + drizzle-kit `0.31.10`, `@modelcontextprotocol/server`/`client` v2, vitest 5, Postgres 16 with pgvector 0.8.6, `yaml@^2.9.1` and `croner@10.0.1` (both already in the lockfile at those versions). **No new third-party dependency.** Three new workspace packages: `@harness/config-api`, `@harness/config-files`, `@harness/config-postgres`, and one new plug-in package, `@harness/identity-slack-groups`.

**Spec:** `docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md` — this plan is section 5.1, "Plan 11a — configuration and tenancy". It implements decisions 1, 1b, 2, 2b, 3, 4, 6, 7 and 8; sections 3.5, 4.1, 4.2, 4.3, 4.4 and 4.5; the `client_documents`, partitioning, `runs` totals, `audit_log` drop and `usage_runs` entries of section 6; invariants 13, 14, 16, 18 and 19 of section 8; the testing rules of section 9; and the exit criterion of section 10's row 11a. It starts from `worktree-os-boundary` at `f7c2fc4`, which is `main` (`9b7a822`) plus the two spec commits. There is no rebase pending. Section 12 of the spec lists ten constraints the code imposes; every one of them is answered by a named task below.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`; drizzle-orm `^0.45.2`.
- **The four gates plus the suite pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; the type-aware warnings are a known backlog), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test`. No task ends red and no gate is parked.
- **Local test environment.** Run the suite with these three variables in front of the command and nothing else; never source `.env`:
  ```
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder
  ```
  Those databases exist; do not create or drop them, and run no container command against either.
- **Migrations:** edit `harness/db/src/domain/schema.ts`, then from `harness/db/` run `pnpm drizzle-kit generate` twice — the second run must print "No schema changes". Never `--custom`, and **never hand-edit a generated `.sql` file**. **Task 3 is the one migration of this plan, `0014_tenancy_and_config`, and it carries all three groups of changes: Task 3's own two tables, Task 5's tenant columns and indexes, and Task 8's `usage_runs` view.** Tasks 5 and 8 only *use* what Task 3 created; **no other task touches `schema.ts` or `drizzle/`**.
- **Environment variables.** Exactly two are added: **`HARNESS_CONFIG_SOURCE`** and **`HARNESS_CLIENTS_DIR`**, both first read in **Task 3**, both documented in `.env.example` by Task 3. Six are deleted, each by the task that deletes its last reader, and each removed from `.env.example`, from `.env.ci` where present, from `harness/compose/docker-compose.yml` where present, and from every document that names it:
  | Variable | Read today by | Deleted in |
  |---|---|---|
  | `HARNESS_IDENTITY_FILE` | `identities/static/src/index.ts` | **Task 2** |
  | `HARNESS_POLICY_FILE` | `harness/core-tools/src/domain/tooling/policy.ts` (`loadPolicy`'s default argument) | **Task 4** |
  | `HARNESS_PACKS` | **two readers:** `harness/core-tools/src/domain/tooling/config.ts` (`packNames`) and `evals/src/app/cli.ts`, which reads `process.env.HARNESS_PACKS` raw because `optionalEnv` cannot tell unset from empty | **Task 4** (both readers; the eval runner gains a `--packs` option in the same step) |
  | `HARNESS_SURFACES` | `harness/host/src/app/main.ts` | **Task 6** |
  | `HARNESS_IDENTITY` | `harness/host/src/app/main.ts` and `harness/core-tools/src/app/server.ts` | **Task 4** (both readers, `.env.example` and Compose) |
  | `HARNESS_RUNTIME` | `harness/host/src/app/main.ts` | **Task 6** |
  `HARNESS_CLIENT` stays, with a new meaning: set means a dedicated host, unset means a pooled one. `harness/core-tools/src/app/surface.test.ts` scans every non-test source file for environment reads and fails on a name `.env.example` does not document, so a task that adds a reader and forgets the file fails its own gates.
- **Snapshots.** The **tool-surface snapshot** (`docs/architecture/tool-surface.json`) is byte-identical in **every task of this plan**: `tools.hide` is per tenant and the recorder's fixture document hides nothing, so the default catalogue does not move. `git status --short docs/architecture` proves it. The **Compose snapshot** (`docs/architecture/compose-surface.yaml`) changes in exactly **three** tasks and is re-recorded with `pnpm surface:record` in each, because a task may not end with the snapshot disagreeing with the file: **Task 4** (deletes `HARNESS_POLICY_FILE`, `HARNESS_PACKS` and `HARNESS_IDENTITY` from the `host` service), **Task 6** (deletes `HARNESS_SURFACES` and `HARNESS_RUNTIME`), and **Task 9** (adds the two new variables, moves the clients mount, removes the bake). Tasks 1, 2, 3, 5, 7, 8 and 10 leave it byte-identical. A task that re-records must check `git diff --stat docs/architecture` and stop if `tool-surface.json` moved.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its **empty allowlist**, and the suite's own assertion that it stays empty is untouched. The scanned trees gain rows in Task 1 and Task 7 (see decisions 6 and 7 below for exactly which lists each new package joins and why). `harness/host/src` is scanned for `/slack|bolt|block ?kit|thread_ts|\bblocks\b/i` and for `/demo-practice|hermes/i`: the host says **"tenant"**, **"tenant hint"**, **"surface directory"** and **"the client's document"**, and never a vendor, a product area or a framework. It derives every plug-in specifier from a name with a template literal — `` `@harness/surface-${name}` `` — so no plug-in package name is ever written out in host source.
- **Architecture rules.** Each new package adds **one `PACKAGES` row** and **one `WORKSPACE_DIRS` entry** to `.dependency-cruiser.cjs`, exactly as that file's "HOW A NEW PACKAGE IS ADDED" note says. One new global rule is added, in Task 1, for `@harness/config-api`. **An identity plug-in still imports only `@harness/identity-api` and `@harness/shared`** (`an-identity-plugin-imports-only-api-and-shared`), so `identities/static` and `identities/slack-groups` **never import `@harness/config-api`**: they receive the document's `identity` section, already validated, through `IdentityDeps`. The importers of `@harness/config-api` are `@harness/core-tools`, `@harness/host`, `@harness/gateway`, `@harness/config-files`, `@harness/config-postgres` and `@harness/scripts`, and nothing else.
- **No new third-party dependency anywhere.** `@harness/config-api` takes `yaml@^2.9.1`, `croner@10.0.1` and `zod@^4.6.5`, all already resolved in the lockfile at those exact versions by `@harness/host`, `@harness/gateway`, `@harness/core-tools`, `@harness/pack-api`, `packs/healthcare`, `identities/static` and `evals`, so the lockfile gains no new resolution. YAML is parsed with the `yaml` package's `parse(text, { customTags })`, which is how the `!include` tag is handled — no YAML library is added.
- **No backwards compatibility (spec decision 2b).** No shim, no dual code path, no "still works" clause, no deprecation comment. Every task lists the files it **deletes**, and the deletion happens in that task.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **No test sleeps longer than 200 ms**, and no test waits for a real interval: the scheduler is driven by hand through `tick()`, a `watch` test drives the debounce with an injected timer, and a listening test binds `127.0.0.1:0` and reads the port off the socket. `waitFor(ready, timeoutMs)` in `harness/host/src/testing.ts` is the polling helper.
- **The healthcare pack is loaded explicitly from now on.** After Task 4 deletes `HARNESS_PACKS` there is no ambient default: `surfaceDeps()` in `record-surface.ts` builds its `ToolDeps` from a fixture `ClientDocument` whose `packs` is the literal `['@harness/pack-healthcare']` (as its pack list is a literal today), `makeTestDeps` keeps its literal registry, and any test that needs the pack passes `packs` explicitly. No `test-global-setup.ts` in this workspace reads `HARNESS_PACKS`; none is changed by this plan.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up`, `pnpm db:down` or `pnpm demo:up` from a task.** `docker compose ... config` is read-only and is what `pnpm surface:record` uses.
- Do not push from a task. Do not open a pull request from a task.

---

## Facts verified for this plan

Read out of this worktree (`worktree-os-boundary` at `f7c2fc4`) or run in a scratch on 2026-09-19. File names and identifiers, never line numbers.

### Packages, versions and what is already resolved

| Fact | Value | Where |
|---|---|---|
| The YAML library the workspace already uses | `yaml`, at `^2.9.1` in every manifest that declares it: `harness/host`, `harness/core-tools`, `harness/gateway`, `packs/healthcare`, `identities/static`, `evals`. One resolution. | those `package.json` files |
| `yaml` parses a custom scalar tag with no extra dependency | `parse(text, { customTags: [{ tag: '!include', identify: () => false, resolve: (value) => ({ $include: value }) }] })` over `persona: !include persona.md` returned `{"persona":{"$include":"persona.md"}}`, nested values included | `node --input-type=module` from `harness/host`, 2026-09-19 |
| The cron library | `croner`, at the exact pin `10.0.1`, declared by `@harness/host` alone today | `harness/host/package.json` |
| drizzle versions | drizzle-kit **0.31.10**, drizzle-orm **0.45.2** (resolved, not just declared) | `harness/db/node_modules/*/package.json` |
| **drizzle-kit 0.31.10 does emit a view**, from the manual builder, not the query builder | `pgView('usage_runs', { … columns … }).as(sql\`select …\`)` generated `CREATE VIEW "public"."usage_runs" AS (select …);` after the `CREATE TABLE`, separated by `--> statement-breakpoint` | scratch schema + scratch `drizzle.config.ts` under the scratchpad, `pnpm exec drizzle-kit generate` from `harness/db` |
| Generating twice over a schema with a view prints the expected line | second run: `No schema changes, nothing to migrate 😴` | same scratch, with a **relative** `out` path |
| **A scratch probe must use a relative `out` path** | drizzle-kit 0.31.10 reads a previous snapshot as `` readFileSync(`./${it}`) ``, so an absolute `out` becomes `.//private/tmp/…` and the second run dies `ENOENT`. Generation itself is unaffected, and `harness/db`'s own `drizzle.config.ts` already uses a relative `out`, so **Task 3 Step 5 is not affected** — this is recorded only so a probe that hits it is not mistaken for a schema problem | same scratch |
| The two `pgView` overloads, and which one takes raw SQL | `pgView(name)` returns a `ViewBuilder` whose `as` takes a `TypedQueryBuilder` or a callback; `pgView(name, columns)` returns a `ManualViewBuilder` whose `as(query: SQL)` takes raw SQL. **The second is the one this plan uses.** | `harness/db/node_modules/drizzle-orm/pg-core/view.d.ts` |
| The generated view SQL applies to Postgres and is listed as a view | applied to a scratch database over `TEST_DATABASE_URL`: `select table_name from information_schema.views where table_schema = 'public'` → `usage_runs`; the scratch database was dropped afterwards and `harness_test`'s own tables were never touched | `pg` from `harness/db/node_modules`, 2026-09-19 |
| `resetDatabase` truncates **18** tables inside a disabled audit trigger | `ALTER TABLE audit_log DISABLE TRIGGER USER`, then one `TRUNCATE … CASCADE` over `audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries, knowledge_chunks, knowledge_documents, knowledge_sources, runs, messages, threads, approvals, deadlines, attachments, fields, documents, records`, then `ENABLE TRIGGER USER` in a `finally` | `harness/db/src/testing.ts` |
| The last migration today | journal's last entry is `0013_knowledge`, so this plan's is `0014` | `harness/db/drizzle/meta/_journal.json` |

### How a client is loaded today, and every thread that has to be cut

| Fact | Value | Where |
|---|---|---|
| `clientDirFor(client, root = repoRoot)` resolves under a module-level `repoRoot` computed at import from `import.meta.url` | `path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..')`; nothing in shipping code passes `root` | `harness/core-tools/src/domain/tooling/config.ts` |
| Its callers | `buildKernelConfig` (`clientDir: clientDirFor(client)`); `harness/core-tools/src/app/server.ts` (re-exported for `server.test.ts`, and used to build `IdentityDeps.clientDir`); `evals/src/domain/pipeline.ts`; `evals/src/judge-deps.test-helpers.ts` (`clientDirFor('evals')`); exported from `harness/core-tools/src/index.ts` | grep over the workspace |
| `ToolDeps.clientDir` has exactly **one** shipping consumer | `syncKnowledge`: `const dir = opts.dir ?? path.join(deps.clientDir, 'knowledge')` | `harness/core-tools/src/domain/knowledge/sync.ts` |
| Four reads inside `buildKernelConfig` ignore its `env` argument | `storageRoot()`, `loadPolicy()`, `loadKey()` and `gatewayFromEnv()` each take no env and fall through to the ambient `process.env` | `domain/storage/layout.ts`, `domain/tooling/policy.ts`, `@harness/db`'s `loadKey`, `domain/models/gateway.ts` |
| `gatewayFromEnv` reads three variables inside an `eslint-disable no-restricted-syntax` block, deliberately, so empty-string semantics do not change | `HARNESS_GATEWAY_URL`, `HARNESS_GATEWAY_TIMEOUT_MS`, `HARNESS_GATEWAY_MAX_CALLS_PER_RUN`, plus `LITELLM_MASTER_KEY` through `requiredEnv` | `harness/core-tools/src/domain/models/gateway.ts` |
| **The three-state `HARNESS_PACKS` read**, in **two** places | `packNames(env)` reads `env.HARNESS_PACKS` **directly**, not through `optionalEnv`, so unset means `DEFAULT_PACKS = '@harness/pack-healthcare'` and `''` means no pack; Compose interpolates it with a single dash (`'${HARNESS_PACKS-@harness/pack-healthcare}'`) for the same reason. The eval runner has its own copy of the same three-state read, `packsToMeasure(process.env.HARNESS_PACKS)`, with a comment saying why it is raw — and `evals` is one of the seven roots the environment scan walks, so both go in Task 4 or the scan fails | `domain/tooling/config.ts`, `evals/src/app/cli.ts`, `harness/compose/docker-compose.yml` |
| `loadPolicy(filePath = optionalEnv('HARNESS_POLICY_FILE'))` serves `DEFAULT_POLICY` silently when the variable is unset, so a client's `policy.yaml` is ignored by default | | `domain/tooling/policy.ts` |
| Compose derives the policy path from the client id | `HARNESS_POLICY_FILE: '/srv/agent-harness/clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}/policy.yaml'` | `harness/compose/docker-compose.yml` |
| `envOrDefault` throws `ConfigError` on set-but-empty and returns the default only when unset; `server.test.ts` pins that for `HARNESS_CLIENT` by name | | `harness/shared/src/env.ts`, `harness/core-tools/src/app/server.test.ts` |
| `harness/host/src/app/main.ts` is a top-level-`await` script, not a factory | there is no `createHost()`; `docker-compose.yml` runs `pnpm --filter @harness/host start` = `tsx src/app/main.ts` | that file |
| `Host` members, all one per process | `db, config, client, identity, surfaces, runtime, persona, skills, model, budget, servicePrincipal, log, now, active, turns, draining` | `harness/host/src/domain/host.ts` |
| `openKernel(host, run)` is **already** per-run and already parameterised on `host.config` and `host.client` | it takes `Pick<Host, 'db' \| 'config' \| 'client' \| 'now'>`, so a per-tenant object satisfies it unchanged | `harness/host/src/domain/kernel.ts` |
| `depsForRun(config, { db, principal, context })` clones the `KernelConfig` per run; `KernelConfig = Omit<ToolDeps, 'db'\|'principal'\|'context'\|'sinks'\|'tools'\|'kernelTools'\|'kernel'>`; `RunDeps = { db, principal, context }` | | `harness/core-tools/src/domain/tooling/deps.ts` |
| The three plug-in loaders, all by bare specifier through a dynamic `import(specifier)` | `loadSurfaces(names, deps)` → `LoadedSurfaces { all, primary, secrets, find }` (`harness/approvals/src/domain/surfaces/registry.ts`); `loadIdentity(specifier, deps)` (`harness/core-tools/src/domain/identity/registry.ts`); `loadRuntime(specifier, deps)` (`harness/host/src/domain/runtime/registry.ts`); `loadPacks(names)` (`harness/core-tools/src/domain/packs/registry.ts`). Each replaces `ERR_MODULE_NOT_FOUND` / `ERR_PACKAGE_PATH_NOT_EXPORTED` with a `ConfigError` naming the package to add | those files |
| **The first entry of `HARNESS_SURFACES` is the primary and is where approval cards go**; two adapters with one name is a `ConfigError` | `surfacesOf(sessions, secrets)` takes `sessions[0]` as primary | `harness/approvals/src/domain/surfaces/registry.ts` |
| `IdentityDeps` today | `{ env: EnvSource; log: Logger; clientDir: string }` | `harness/identity-api/src/types.ts` |
| `SurfaceDeps` today | `{ env: EnvSource; log: Logger; storageDir: string }` — no client id, no per-tenant configuration | `harness/surface-api/src/types.ts` |
| `MessageEvent` today | `{ surface, userId, conversation, text, attachments, message: MessageRef \| null, mentioned: boolean }` | `harness/surface-api/src/types.ts` |
| `handleMessage(host, event)` enters the client id at exactly two points | `writeAudit({ client: host.client, caller: \`${surface}:${userId}\`, … })` for a refusal, and `findOrCreateThread({ client: host.client, … })` | `harness/host/src/domain/conversation.ts` |
| The run API picks no client — it is `host.client` on every route | `openRunRoute`, `cancelRoute`, `threadRoute`, `statusRoute` | `harness/host/src/domain/api/routes.ts` |
| `bearerOk(header, token)` is constant-time after a length check; `handleApiRequest` puts it in front of every route including `/v1/status` | | same file |
| The two host tests that read `clients/demo-practice` from the repository root | `harness/host/src/domain/playbooks/preflight.test.ts` (`describe('the shipped demo playbooks (I1)')`, asserting the names `['credentialing-expirations','knowledge-sync']`) and `harness/host/src/domain/playbooks/scheduler.test.ts` (`describe('the shipped knowledge-sync playbook (I1)')`, which also loads that folder's `policy.yaml` and its `knowledge/`) | those files |
| A third test reads the folder through the identity plug-in | `identities/static/src/index.test.ts`, "parses the demo client file, which names the five principals Compose and the configs use" | that file |
| `clients/demo-practice/` holds exactly | `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`, `playbooks.yaml`, `.env.example`, `knowledge/front-desk.md`, `knowledge/escalation-and-billing.md` | `find clients -type f` |
| The scaffolder can only write inside the repository | `newClient` targets `path.join(root, 'clients', name)` with `root` defaulting to a `repoRoot()` resolved from `import.meta.url`; `TEMPLATE_FILES` is the five files plus `.env.example`, `TEMPLATE_DIRS` is `['knowledge']`, `DEFAULT_TEMPLATE` is `'demo-practice'` | `scripts/src/domain/scaffold.ts` |
| The gateway renderer reads the repository root at import and picks a client at module top level | `path.join(repoRoot, 'clients', client, 'routing.yaml')`, `const client = process.env.HARNESS_CLIENT ?? 'demo-practice'` | `harness/gateway/src/app/render-config.ts` |
| The gateway's routing schema, which moves | `ROUTES = ['chat','extract','reason','judge','embed']`, `RouteSpec` (`.strict()`), `RoutingFile` (`routes` `.strict()` with all five, `defaults` with its three fields spelled out twice) in `src/domain/routing/types.ts`, exported through the `./routing` subpath; `parseRouting(yamlText)` in `src/domain/routing/parse.ts` | those files |
| The host's playbook schema, which moves | `DELIVERIES`, `validSchedule`, `validTimezone`, `PlaybookShape` (`.strict()`), `PlaybooksFileShape` (`.strict()`), `PlaybookDefinition`, `parsePlaybooksFile`, plus `readPlaybooksFile(clientDir)` and `nextRunAfter(schedule, timezone, from, where?)` in `harness/host/src/domain/playbooks/schema.ts`; it imports `PRINCIPAL_ID_PATTERN` from `@harness/identity-api` and four patterns from `@harness/shared` | that file |

### The tool catalogue, the snapshots and the scans

| Fact | Value | Where |
|---|---|---|
| **The `hidden` set is the exact seam for `tools.hide`** | `publishedTools(deps, kernel = kernelTools(deps.packs))` builds `const hidden = new Set<string>([...(anyGenericKind ? [] : GENERIC_RECORD_TOOLS), ...(anyDocumentKind ? [] : [...PACK_DOCUMENT_TOOLS, ...PACK_DEADLINE_TOOLS])])` and hands it to `publishedCatalogue(kernel, sources, hidden)`, which drops hidden names before any pack contributes. `deps.kernelTools` still holds every kernel tool, so a pack wrapper can still reach a hidden handler. | `harness/core-tools/src/tools/catalog.ts`, `domain/packs/publication.ts` |
| `surfaceDeps()` pins its pack list as a literal, and its `env` as `{}`, deliberately, so the snapshot describes the shipped default | `loadPacks(['@harness/pack-healthcare'])`, `env: {}`, `client: 'surface'`, `clientDir: '/nonexistent/surface'` | `harness/core-tools/src/app/record-surface.ts` |
| The environment scan | walks `['harness','packs','surfaces','identities','runtimes','evals','scripts']` for `process.env.X`, `process.env['X']` and calls to `ENV_READING_HELPERS = ['numberFromEnv','booleanFromEnv','requiredEnv','optionalEnv','envOrDefault','required','seconds','port']`; `envNamesFromExample` counts commented-out lines | `harness/core-tools/src/app/record-surface.ts`, `app/surface.test.ts` |
| ESLint bans `process.env` outside a short list | `PROCESS_ENV_IS_FINE = ['harness/shared/src/env.ts', '**/src/shared/env.ts', '**/src/app/**/*.ts', '**/*.test.ts', 'harness/db/src/**/*.ts', '**/drizzle.config.ts']` | `eslint.config.js` |
| The four word lists and the trees each is applied to | `DOMAIN_FORBIDDEN`, `MESSAGING_FORBIDDEN = /slack\|bolt\|block ?kit\|thread_ts\|\bblocks\b/i`, `FRAMEWORK_FORBIDDEN = /deepagents\|langchain\|langgraph\|\bentra\b\|\bteams\b/i`, `DEPLOYMENT_FORBIDDEN = /demo-practice\|hermes/i`. `identities/static/src` is scanned for **framework** and **deployment** only, never messaging. `surfaces/slack/src` is scanned by nothing. `ALLOWLIST` is empty and a test asserts it stays empty. | `harness/core-tools/src/kernel-vocabulary.test.ts` |
| The four Compose-snapshot properties beyond the byte match | exactly the five services `['core-tools','files','host','litellm','postgres']`; no `demo-practice` outside a `${HARNESS_CLIENT…}` interpolation; no `HARNESS_FORMS_DIR`; no Docker socket | `harness/core-tools/src/app/surface.test.ts` |
| `.dependency-cruiser.cjs` rules a new package touches | one `PACKAGES` row (layer rules; vacuous for a flat package like `identity-api`), one `WORKSPACE_DIRS` entry (which mints `only-public-entry-of-<dir>` from the manifest's `exports` map). `an-identity-plugin-imports-only-api-and-shared` and `the-host-never-statically-imports-a-plugin` are the two that constrain this plan. | that file |

### The database, as it is

| Fact | Value | Where |
|---|---|---|
| Tables that already carry `client: text('client').notNull()` | `records`, `documents`, `approvals`, `threads`, `runs`, `tool_effects`, `model_calls`, `audit_log`, `memory_entries`, `playbooks`, `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` | `harness/db/src/domain/schema.ts` |
| Tables that do not, and gain it | `attachments` (FK `record_id`), `fields` (FK `record_id`), `deadlines` (FK `record_id` + `attachment_id`), `messages` (FK `thread_id`), `playbook_runs` (FK `playbook_id`) | same |
| The two globally unique idempotency indexes | `approvals_idempotency_pending_uq` on `idempotency_key` alone, partial on `status = 'pending'`; `tool_effects_idempotency_uq` on `idempotency_key` alone | same |
| `runs` columns today | `id, client, principal_id, thread_id, surface, conversation, channel, status, started_at, ended_at` — **no tokens, no cost** | same |
| `model_calls` columns today | `id, run_id, client, route, model, input_tokens, output_tokens, cost_usd, created_at`. Written in exactly two places, both kernel-side: `callModel` and `embedTexts` | `domain/models/gateway.ts`, `domain/knowledge/embed.ts` |
| `audit_log` has three token columns **no call site ever fills** | `input_tokens`, `output_tokens`, `cost_usd`; `writeAudit` accepts them and nothing passes them | `schema.ts`, `domain/tooling/audit.ts` |
| Runtime model spend is dropped after the turn | `runtimes/deepagents` emits `{ type: 'usage', inputTokens, outputTokens, costUsd }`; `harness/host/src/domain/conversation.ts` accumulates it into `spentUsd` for the cost cap and writes nothing | those files |
| `closeRun(db, runId, status, now)` is **not** client-scoped | `where(eq(runs.id, runId))` only | `harness/core-tools/src/domain/session/repository.ts` |
| Startup `reconcile(db, { now })` is deliberately unscoped, "an operator-level task"; `reconcileForClient(deps, staleAfterMinutes)` is the scoped one | | same file, `domain/tooling/reconcile.ts` |
| Every repository that touches the five unpartitioned tables | `core-tools/domain/records/repository.ts` (`fields`, `attachments`), `core-tools/domain/deadlines/repository.ts` (`deadlines`, `attachments`), `core-tools/domain/memory/search.ts` (`messages`, already scoped by a join to `threads`), `core-tools/domain/playbooks/repository.ts` (`playbook_runs` insert), `host/domain/threads/repository.ts` (`messages`), `host/domain/api/repository.ts` (`messages`), `host/domain/playbooks/repository.ts` (`playbook_runs`) | grep over the workspace |
| The checkpointer is one pool per process keyed by `thread_id` only, and thread ids are uuids | `openCheckpointer(databaseUrl)`, `{ configurable: { thread_id: request.threadId } }` | `runtimes/deepagents/src/domain/checkpointer.ts`, `domain/run.ts` |

### Identity: what exists, and what is re-authored from PR #5's branch

| Fact | Value | Where |
|---|---|---|
| Today every principal is declared literally; an unknown surface user resolves to `null` and `handleMessage` refuses | `StaticIdentity.resolve` matches `p.surfaces[ref.surface] === ref.userId` | `harness/identity-api/src/testing.ts`, `host/domain/conversation.ts` |
| `PrincipalShape.displayName` is `.trim().min(1).max(80)` with `/^[^\p{Cc}\p{Cf}\p{Zl}\p{Zp}]+$/u`, because it is rendered into the runtime's rules block | | `harness/identity-api/src/principals.ts`, `runtimes/deepagents/src/domain/prompt.ts` |
| `parseIdentityFile(raw)` applies four rules zod cannot: unique ids, `u-`/`svc-` prefix matching `kind`, `service` level only for services, and no surface user id claimed twice | | `harness/identity-api/src/principals.ts` |
| **The reference implementation of `defaults`, derived ids and `principalFromDerivedId` exists only on PR #5's branch** and is re-authored here with its tests; PR #5 is never merged | `.claude/worktrees/client-hf1-labs/harness/identity-api/src/principals.ts` and `identities/static/src/index.ts`, read read-only on 2026-09-19. Task 2 carries the whole of it inline; the branch is not referenced again. | spec §4.3 |
| The reference's exact digest values, which Task 2's tests reuse verbatim | `principalFromDefault('memory','U0123ABCD','member').id === 'u-memory-u0123abcd-8742d695'`; `('ms-teams','A.User@Example','lead') → 'u-ms-teams-a-user-example-0e7aed07'`; `('memory','@@@','member') → 'u-memory-2ec847d8'`; `('memory','U9','member') → 'u-memory-u9-c5f6f2a2'`; `('memory','U0C0KEB8W3X','member') → 'u-memory-u0c0keb8w3x-6774a381'`; the three that slug alike → `u-memory-bob-smith-example-com-164ad630`, `…-117a667c`, `…-ad154fd2` | the reference's own tests, which Task 2 re-authors |
| Nothing resolves Slack user groups today | `SlackApi` exposes only `chat.postMessage`, `chat.update`, `chat.postEphemeral`, `files.uploadV2`, `views.open`, `conversations.replies`; `webClientApi(client)` adapts a real `WebClient` onto it and `FakeSlack` implements it | `surfaces/slack/src/transport/types.ts`, `web-client.ts`, `fake.ts` |
| A surface passes no display name today | `surfaces/slack/src/session.ts`'s `onMessage` fills `surface, userId, conversation, text, attachments, message, mentioned` and nothing else | that file |

### Compose and the image

| Fact | Value | Where |
|---|---|---|
| The five services | `postgres` (`pgvector/pgvector:0.8.1-pg16`), `litellm`, `files` (profile `demo`), `core-tools` (profile `build-only`), `host` (profile `demo`) | `harness/compose/docker-compose.yml` |
| The `host` service's three volumes | `storage:/srv/harness-storage`, `../../packs:/srv/agent-harness/packs:ro`, `../../clients:/srv/agent-harness/clients:ro` | same |
| `clients` is **also baked into the image** | `COPY clients ./clients` under `WORKDIR /srv/agent-harness` | `harness/compose/node.Dockerfile` |
| `.env.ci` holds three variables only | `HARNESS_CLIENT=demo-practice`, `HARNESS_ENCRYPTION_KEY=…`, `LITELLM_MASTER_KEY=sk-ci-placeholder` | `.env.ci` |
| The root `.env.example` documents every variable this plan deletes | `HARNESS_IDENTITY_FILE`, `HARNESS_POLICY_FILE`, `HARNESS_PACKS`, `HARNESS_SURFACES`, `HARNESS_IDENTITY`, `HARNESS_RUNTIME` are each there, some commented out | `.env.example` |

### Why no new dependency

| Candidate | Why not |
|---|---|
| A JSON Patch library (`fast-json-patch`, `rfc6902`) | The overlay is three operations (`replace`, `add`, `remove`) over JSON pointers, and the lock check has to run *before* an operation applies, which a library's `applyPatch` does not offer. `harness/config-api/src/resolve.ts` is under a hundred lines with its own tests, and its pointer parser is the same one the lock set needs. |
| A YAML `!include` package (`yaml-include`, `js-yaml` with a custom schema) | `yaml@^2.9.1` already takes `customTags` and the workspace already depends on it at one resolution. Verified above. |
| A file watcher (`chokidar`, `watchpack`) | `node:fs`'s `watch` plus a debounce is what `ConfigSource.watch` needs, and the only test of it drives an injected timer rather than the filesystem. |
| A configuration library (`convict`, `cosmiconfig`) | The document is one zod schema this repository already owns the idiom for, and the source is an interface with two implementations. A library would add a second way to say what `ClientDocument` says. |

---

## Decisions where the spec leaves a detail open

1. **A plug-in specifier is derived from a name, never written out in kernel source.** The document names its surfaces by key (`surfaces.slack`, `surfaces.http`), its identity provider by `identityProvider.kind` and its runtime by `runtime`, exactly as spec §4.1 writes them. The host turns each into a package specifier with a template literal — `` `@harness/surface-${name}` ``, `` `@harness/identity-${kind}` ``, `` `@harness/runtime-${name}` `` — so `harness/host/src` never contains the string `slack` or `deepagents` and the kernel-vocabulary scan stays green with an empty allowlist. `packs` stays a list of full package names, as `HARNESS_PACKS` was, because a pack may come from any scope. The three derivations live in one module, `harness/host/src/domain/tenancy/specifiers.ts`, with the rule written down once.

2. **`@harness/config-api` is scanned for three of the four word lists, and deliberately not for the messaging one.** The document schema has to name the surfaces a tenant may declare, and spec §4.1 spells `surfaces.slack` out with `teamId`, `signingSecret` and `botToken`. That is the one place in this repository where a vendor's name is *data the schema admits* rather than a coupling — the same status `surfaces/slack/src` has, which is scanned by nothing. So `harness/config-api/src` joins the **credentialing**, **framework** and **deployment** scans and not the messaging one, and `runtime` in the schema is a plug-in-**name** string (`/^[a-z][a-z0-9-]*$/`) rather than a `z.literal('deepagents')`, so the framework scan passes on the package that would otherwise have had to spell a framework's name. The fixture document sets `runtime: deepagents`, in YAML, which no scan reads. **The allowlist stays empty.**

3. **Identity plug-ins receive the document's `identity` section through `IdentityDeps`; they do not import `@harness/config-api`.** `an-identity-plugin-imports-only-api-and-shared` is an error-severity rule and this plan does not weaken it. `IdentityDeps.clientDir` is replaced by `IdentityDeps.identity: IdentityFile` — the *parsed* section, `{ principals, defaults }`, whose type `@harness/identity-api` already owns. `@harness/config-api` imports `IdentityFileShape` from `@harness/identity-api`, never the other way round, so there is no cycle. `IdentityDeps` also gains `directories` (decision 8).

4. **A `Tenant` wraps today's `Host` rather than replacing it.** `Host` is already, member for member, exactly one tenant's world: its `db`, `config`, `client`, `identity`, `surfaces`, `runtime`, `persona`, `skills`, `model`, `budget` and `servicePrincipal`. Rewriting `runTurn`, `openKernel`, `handleMessage`, the scheduler, `resume.ts`, `preflight.ts` and every host test to take a tenant *beside* a host would be a very large diff that changed no behaviour. So `Tenant = { clientId, version, document, host: Host, scheduler, runner, close() }` and a new `HostPool` holds `Map<clientId, Tenant>`. Every existing host function keeps its signature and receives that tenant's `host`. The isolation of invariant 13 is then structural rather than argued: two tenants are two `Host` objects with two `KernelConfig`s and two `client` strings, and `depsForRun` clones the tenant's own config per run.

5. **`ConfigSource.watch` invalidates; it never hot-swaps a live tenant.** A version change evicts the tenant from the map after its turns in flight have drained, and the next event for that client opens a fresh one. Mutating a running tenant would mean a turn whose policy changed halfway through it. `HostPool.invalidate(clientId)` is the one entry point and it is what `watch` calls.

6. **A pooled host's surfaces are loaded per tenant and still read their secrets from the process environment.** Spec §4.1's `surfaces.slack` section carries `teamId`, `signingSecret` and `botToken` and **not** `appToken` or the approvals channel — because §4.6 deletes socket mode in Plan 11b, and that is where a per-tenant secret is actually threaded into a surface. In Plan 11a the `surfaces` section is *declarative*: it says which surfaces this tenant loads, in what order (first is primary), and what its tenant key is; the host resolves each `SecretRef` at load only to **check that the named environment variable is present**, failing with a `ConfigError` naming the variable and the tenant, and `SurfaceDeps` is unchanged. **The consequence, stated plainly: a pooled host cannot yet serve two live Slack tenants, because both would read one `SLACK_BOT_TOKEN`.** That is Plan 11b's transport work and the platform's ingress (spec §3.4), and nothing in this plan pretends otherwise. Invariant 13 is proved with the memory surface, which is what spec §9 asks for.

7. **A tenant key, not a vendor field, is what the resolver matches.** `MessageEvent` gains `tenantHint?: string`, which a surface fills with whatever identifies the workspace an event came from (the Slack team id). `@harness/config-api` exports `tenantKeysOf(document): { surface: string; key: string }[]`, which knows the typed surface sections and returns opaque pairs; the host builds `Map<`${surface}:${key}`, clientId>` from it and never reads a vendor field itself. The run API's key is the `x-harness-client` header, which names the client id directly.

8. **`SurfaceDirectory` is declared in `@harness/shared`, so both contracts can hold it.** A surface offers `directory?: SurfaceDirectory` and an identity plug-in receives `directories: Readonly<Record<string, SurfaceDirectory>>`; neither package may import the other (`surface-api-imports-only-shared`, `identity-api-imports-only-shared`), and both may import `@harness/shared`. That is the precedent those rules' own comments give for the five levels: "the two id patterns both contracts need live in `@harness/shared` for exactly that reason."

9. **Migration 0014 adds five `NOT NULL` columns with no default, so it applies to empty tables.** `drizzle-kit generate` writes `ALTER TABLE "messages" ADD COLUMN "client" text NOT NULL;`, which Postgres refuses on a table that has rows. Giving the column a default would silently file every existing row under one tenant, which is the opposite of what this migration is for. So Task 3 truncates those five tables in the databases this worktree migrates before generating, the migration test proves the SQL applies to a scratch database, and the runbook's "Upgrading to Plan 11a" section says in so many words that the deployment database is recreated — which decision 2b already requires, because the one live tenant is re-onboarded rather than carried.

10. **`ToolDeps.clientDir` becomes `ToolDeps.knowledgeDir: string | null`.** Its only shipping consumer is `syncKnowledge`, which wants `<clientDir>/knowledge`. The document says `knowledge: { source: 'dir'; path } | { source: 'store' }`, so the derived value is the path itself or `null`; `syncKnowledge` with neither an explicit `dir` nor a `knowledgeDir` raises a `ToolError` naming the document's `knowledge` section rather than walking a directory nobody configured.

11. **A lock is violated when either pointer is a prefix of the other.** An overlay operation at `/policy/classes/read` is refused by a lock on `/policy`, because it edits inside a locked subtree; an operation at `/policy` is refused by a lock on `/policy/classes/read`, because replacing the subtree would replace the locked leaf with it. `ConfigError`'s message names the operation's path and the locked pointer, in that order, and `resolve` stops at the **first** violation so the message is deterministic.

12. **A pooled host opens every client its source lists, at start.** Spec §3.4 has the platform's ingress deliver an event to a host with the tenant id in a header, and that ingress is Plan 11b's and P2's. In Plan 11a each tenant still connects its own surfaces, so a tenant nobody had opened would have nothing listening for it — a pool that opened on demand would never receive the demand. `createHost` therefore warms every id `ConfigSource.list()` returns, and a pooled host over a source that cannot list is a startup `ConfigError` naming both. `tenantFor(clientId)` is already written for open-on-demand and is the path the run API takes, so 11b replaces one loop and nothing else.

13. **`/healthz` keeps its shape for a dedicated host and grows a `tenants` map for a pooled one.** A container health check reads that endpoint and the runbook documents its fields; a dedicated deployment — which is every Compose deployment today — sees exactly what it saw before. A pooled host has no single client to report, so it answers `{ status, tenants: { <id>: <the old shape> } }`, with `status` degraded when any tenant is. Task 10 documents both.

14. **A `runtimes/scripted` package exists so a host test can load a runtime by name.** `createHost` reaches its runtime through `import('@harness/runtime-<name>')`, which is the point of decision 1, and `the-host-never-statically-imports-a-plugin` forbids handing it a session the test constructed. `runtimes/scripted` wraps `ScriptedRuntime` from `@harness/runtime-api/testing` in a real plug-in package — thirty lines and a manifest — and the pool fixture's documents name it. Task 6 Step 11 checks whether one already exists before adding it. It is a reference plug-in like `surfaces/memory`, which exists for the same reason.

15. **The usage export is grouped by day in UTC and carries no free text.** `usage_runs` selects `client`, `principal_id`, `day` (`date_trunc('day', started_at)`), `runs`, `input_tokens`, `output_tokens`, `cost_usd`, `duration_seconds`, four outcome counts, `approvals_requested`, `approvals_decided` and `sandbox_seconds` (a literal `0` until a provider exists). There is no `text`, no `content`, no `args`, no `summary` and no conversation id anywhere in it, and invariant 16's test asserts the view's column list exactly rather than grepping a result.

---

## File structure

Paths are relative to the repository root.

### `@harness/config-api` (Task 1)

| File | Responsibility |
|---|---|
| `harness/config-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package |
| `harness/config-api/src/types.ts` | `CLIENT_DOCUMENT_VERSION`, `SecretRef`, `ClientDocument`, `Blueprint`, `Overlay`, `JsonPatch`, `PatchOp`, `ConfigSource`, `LoadedDocument` |
| `harness/config-api/src/routing.ts` | `ROUTES`, `Route`, `RouteSpec`, `RoutingFile` — moved from `harness/gateway` |
| `harness/config-api/src/playbooks.ts` | `DELIVERIES`, `PlaybookShape`, `PlaybooksFileShape`, `PlaybookDefinition`, `parsePlaybooksFile` — moved from `harness/host` |
| `harness/config-api/src/policy.ts` | `PolicyFileShape`, `ClientPolicyShape` (`+ tools.hide`) |
| `harness/config-api/src/document.ts` | `ClientDocumentShape`, `parseClientDocument`, `migrate`, `tenantKeysOf` |
| `harness/config-api/src/resolve.ts` | `pointerSegments`, `readPointer`, `writePointer`, `resolve`, `LOCK_VIOLATION` |
| `harness/config-api/src/index.ts`, `src/testing.ts` | exports; `MemoryConfigSource`, `fixtureDocument`, `configSourceConformance` |
| `harness/config-api/src/*.test.ts` | the five suites |
| `.dependency-cruiser.cjs` | one `PACKAGES` row, one `WORKSPACE_DIRS` entry, one new global rule |
| `harness/gateway/src/domain/routing/types.ts` (**deleted**), `parse.ts`, `render.ts`, `package.json` | the schema re-exported from config-api |
| `harness/host/src/domain/playbooks/schema.ts` | keeps `nextRunAfter` only; the schema and `readPlaybooksFile` go |
| `harness/core-tools/src/kernel-vocabulary.test.ts` | three scan rows for `harness/config-api/src` |

### Identity defaults and derived principals (Task 2)

`harness/identity-api/src/principals.ts` + `principals.test.ts`, `src/types.ts` (`IdentityDeps`), `src/index.ts`; `identities/static/src/index.ts` + `index.test.ts`, `identities/static/package.json`; `harness/core-tools/src/app/server.ts`, `harness/host/src/app/main.ts`, `harness/core-tools/src/domain/identity/registry.test.ts`; `.env.example`.

### The two sources (Task 3)

`harness/db/src/domain/schema.ts`, `harness/db/drizzle/0014_tenancy_and_config.sql` + `meta/`, `harness/db/src/testing.ts`, `harness/db/src/domain/migration-0014.test.ts`; `harness/config-files/**`, `harness/config-postgres/**`; `harness/core-tools/src/domain/config/registry.ts`; `.dependency-cruiser.cjs`; `.env.example`.

### The kernel reads the document (Task 4)

`harness/core-tools/src/domain/tooling/config.ts`, `policy.ts`, `types.ts`, `deps.ts`, `testing.ts`, `src/tools/catalog.ts`, `src/tools/catalog.test.ts`, `src/domain/storage/layout.ts`, `src/domain/models/gateway.ts`, `src/domain/knowledge/sync.ts`, `src/app/server.ts`, `src/app/main.ts`, `src/app/record-surface.ts`, `src/app/server.test.ts`, `src/index.ts`; `harness/db/src/domain/keys.ts`; `evals/src/domain/pipeline.ts`, `evals/src/judge-deps.test-helpers.ts`; `.env.example`.

### Partitioning and usage columns (Task 5)

`harness/core-tools/src/domain/records/repository.ts`, `domain/deadlines/repository.ts`, `domain/playbooks/repository.ts`, `domain/session/repository.ts`, `domain/tooling/reconcile.ts`, `domain/approvals/repository.ts`; `harness/host/src/domain/threads/repository.ts`, `domain/api/repository.ts`, `domain/playbooks/repository.ts`; their tests.

### The host becomes a factory with tenants (Task 6)

`harness/host/src/domain/tenancy/resolver-types.ts` (the leaf: `InboundRef` and `ClientResolver`, importing nothing from the host), `types.ts`, `specifiers.ts`, `resolver.ts`, `tenant.ts`, `pool.ts` (+ tests); `harness/host/src/app/main.ts`; `harness/host/src/domain/conversation.ts`, `domain/api/routes.ts`, `domain/api/server.ts`, `domain/skills.ts`, `domain/persona.ts` (**deleted**); `harness/host/src/testing.ts`; `harness/surface-api/src/types.ts` (`MessageEvent.tenantHint`); `.env.example`.

### The surface directory and `identities/slack-groups` (Task 7)

`harness/shared/src/directory.ts`, `harness/surface-api/src/types.ts`, `harness/identity-api/src/types.ts`; `surfaces/slack/src/transport/types.ts`, `web-client.ts`, `fake.ts`, `src/directory.ts`, `src/session.ts`, `src/index.ts`; `identities/slack-groups/**`; `.dependency-cruiser.cjs`; `harness/core-tools/src/kernel-vocabulary.test.ts`.

### Usage export (Task 8)

`harness/host/src/domain/api/usage.ts` + test, `domain/api/routes.ts`, `domain/api/types.ts`.

### The fixture, the scaffolder, the gateway renderer and Compose (Task 9)

`clients/fixture/**`, `clients/demo-practice/**` (**deleted**); `scripts/src/domain/scaffold.ts` + test, `scripts/src/app/cli.ts`, `scripts/package.json`; `harness/gateway/src/app/render-config.ts`, `harness/gateway/package.json`; `harness/compose/docker-compose.yml`, `node.Dockerfile`, `docs/architecture/compose-surface.yaml`; `.env.example`, `.env.ci`; `harness/host/src/domain/playbooks/preflight.test.ts`, `scheduler.test.ts`.

### Documentation (Task 10)

`ARCHITECTURE.md`, `CONTRIBUTING.md`, `docs/runbook.md`, `docs/superpowers/specs/2026-09-17-kernel-design.md` (one line in §7), `harness/config-api/README.md`, `harness/config-files/README.md`, `harness/config-postgres/README.md`, `identities/slack-groups/README.md`, `harness/host/README.md`, `harness/core-tools/README.md`, `identities/static/README.md`, `docs/architecture/graph.svg`.

## Task order

Strictly sequential.

- **Task 1** (`@harness/config-api`) first: every later task imports it.
- **Task 2** (identity defaults, derived principals, `IdentityDeps.identity`) before Task 3, because `config-files` fixtures carry a `defaults` table and `parseClientDocument` validates it.
- **Task 3** (migration 0014, `config-files`, `config-postgres`, the source registry, the two new variables) before Tasks 4–9. **The only task that touches `schema.ts` or `drizzle/`.**
- **Task 4** (core-tools reads the document; `HARNESS_POLICY_FILE` and `HARNESS_PACKS` deleted) before Tasks 5, 6 and 9.
- **Task 5** (the tenant columns put to work) before Task 6: the isolation test asserts against them.
- **Task 6** (`createHost`, `Tenant`, `ClientResolver`, the host's own variables deleted, invariants 13 and 19) before Tasks 7, 8 and 9.
- **Task 7** (the surface directory and `identities/slack-groups`) after Task 6, which is what wires `IdentityDeps.directories`.
- **Task 8** (`GET /v1/usage`, invariant 16) after Task 6, which is what writes the rows it reads.
- **Task 9** (the fixture, the scaffolder, the gateway renderer, Compose) after Task 8.
- **Task 10** (documentation) last. No code.

Every task leaves `docs/architecture/tool-surface.json` byte-identical. **Tasks 4, 6 and 9 re-record `docs/architecture/compose-surface.yaml`**, each because it deleted or added a variable on the `host` service and a task may not end with the snapshot disagreeing with the file. Every other task leaves it byte-identical.

---

## Tasks

### Task 1: `@harness/config-api` — the client document, blueprints, overlays and the source contract

**Files:**
- Create: `harness/config-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/config-api/src/types.ts`, `routing.ts`, `playbooks.ts`, `policy.ts`, `document.ts`, `resolve.ts`, `index.ts`, `testing.ts`
- Create: `harness/config-api/src/document.test.ts`, `resolve.test.ts`, `routing.test.ts`, `playbooks.test.ts`, `testing.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry, one new global rule)
- Modify: `harness/core-tools/src/kernel-vocabulary.test.ts` (three scan rows)
- Modify: `harness/gateway/package.json` (dependency on config-api; the `./routing` subpath export removed), `harness/gateway/src/domain/routing/parse.ts`, `render.ts`, `render.test.ts`, `routing.test-helpers.ts`, `parse.test.ts`
- **Delete:** `harness/gateway/src/domain/routing/types.ts`
- Modify: `harness/core-tools/package.json` (dependency on config-api), `harness/core-tools/src/domain/models/types.ts`
- Modify: `harness/host/package.json` (dependency on config-api), `harness/host/src/domain/playbooks/schema.ts`, `repository.ts`, `preflight.ts`, `scheduler.ts`, `schema.test.ts`, `harness/host/src/app/main.ts`
- Modify: `pnpm-workspace.yaml`, `tsconfig.base.json` if it lists project references

**Interfaces:**
- Produces, from `@harness/config-api`:
  - `CLIENT_DOCUMENT_VERSION: 1`
  - `SecretRef = { env: string }`, `SecretRefShape`
  - `ClientDocument` and `ClientDocumentShape`; `parseClientDocument(raw: unknown): ClientDocument`; `migrate(raw: unknown): ClientDocument`
  - `SURFACE_ORDER: readonly ['slack','memory','http']`; `surfaceNamesOf(document): string[]`; `tenantKeysOf(document): { surface: string; key: string }[]`
  - `Blueprint = { document: Omit<ClientDocument,'id'|'displayName'>; lockset: readonly string[]; version: string }`
  - `Overlay = { patch: JsonPatch; version: string }`; `PatchOp`; `JsonPatch`
  - `resolve(blueprint: Blueprint, overlay: Overlay): ClientDocument`
  - `ConfigSource`, `LoadedDocument = { document: ClientDocument; version: string }`
  - `ROUTES`, `Route`, `RouteSpec`, `RoutingFile` (moved from `@harness/gateway/routing`)
  - `DELIVERIES`, `PlaybookShape`, `PlaybooksFileShape`, `PlaybookDefinition`, `parsePlaybooksFile` (moved from `@harness/host`)
  - `PolicyFileShape`, `ClientPolicyShape`
- Produces, from `@harness/config-api/testing`: `fixtureDocument(overrides?)`, `MemoryConfigSource`, `ConfigSourceHarness`, `configSourceConformance(makeSource)`
- Consumes: `IdentityFileShape` and `parseIdentityFileWithDefaults` from `@harness/identity-api` — **Task 2 adds `parseIdentityFileWithDefaults`, so in this task `document.ts` calls `parseIdentityFile` and Task 2 changes the one call site.** `ACTION_CLASSES`, `BEHAVIORS` from `@harness/pack-api`. `ConfigError`, `LEVELS`, `SURFACE_NAME_PATTERN`, `CONVERSATION_ID_PATTERN`, `PLAYBOOK_NAME_PATTERN` from `@harness/shared`.

- [ ] **Step 1: Create the package skeleton**

Create `harness/config-api/package.json`:

```json
{
  "name": "@harness/config-api",
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
    "@harness/identity-api": "workspace:*",
    "@harness/pack-api": "workspace:*",
    "@harness/shared": "workspace:*",
    "croner": "10.0.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `harness/config-api/tsconfig.json`, copied from `harness/identity-api/tsconfig.json` verbatim (read that file and write the same contents).

Create `harness/config-api/vitest.config.ts`, copied from `harness/identity-api/vitest.config.ts` verbatim.

Create `harness/config-api/README.md`:

```markdown
# @harness/config-api

The contract between the kernel and whatever holds a tenant's configuration.

A **client document** is everything a client is: its persona, its principals and their default
levels, its policy, its model routing, its playbooks, its skills, where its knowledge comes from,
which surfaces it serves, which identity plug-in and runtime it loads, and which packs. One zod
schema, one version number, and two ways of reaching one — a directory (`@harness/config-files`)
or versioned rows (`@harness/config-postgres`) — behind the `ConfigSource` interface here.

A **blueprint** is a complete document with placeholders and a **lock set** of JSON pointers. An
**overlay** is a tenant's edits as a small JSON Patch. `resolve(blueprint, overlay)` applies the
patch and refuses, with a `ConfigError` naming the path, any operation that touches a locked
pointer. A finished agent and a customisable one are the same object with different locks.

This package imports `@harness/identity-api`, `@harness/pack-api` and `@harness/shared` and
nothing else in the workspace: it is a contract, and a contract that pulled in the kernel would
defeat the point of having one. **An identity plug-in does not import it** — it receives its own
section of the document through `IdentityDeps`.

`@harness/config-api/testing` ships `fixtureDocument`, an in-memory source, and
`configSourceConformance`, the suite every source implementation runs.
```

Add `harness/config-api` to `pnpm-workspace.yaml` beside the other `harness/*` entries, in the position that keeps the list's existing order (after `harness/pack-api`, before `harness/surface-api` — read the file and match its ordering convention).

- [ ] **Step 2: Register the package with the architecture rules**

In `.dependency-cruiser.cjs`, add to `PACKAGES`, after the `pack-api` row:

```js
  { name: 'config-api', src: 'harness/config-api/src', severity: 'error' },
```

and to `WORKSPACE_DIRS`, after `'harness/pack-api'`:

```js
  'harness/config-api',
```

Then add this rule to `GLOBAL_RULES`, immediately after `identity-api-imports-only-shared`:

```js
  {
    name: 'config-api-imports-only-the-contracts-and-shared',
    comment:
      '@harness/config-api is the contract that says what a client is. It may import @harness/shared, @harness/identity-api (whose IdentityFileShape is the document’s identity section), @harness/pack-api (whose action classes the policy section is keyed by), zod, croner and node built-ins — and no other workspace package. An edge into core-tools, the host or a source implementation would be a cycle: every one of them imports this. The direction is one-way on purpose, which is also why an identity plug-in receives its section through IdentityDeps rather than importing this package.',
    severity: 'error',
    from: { path: '^harness/config-api/src/' },
    to: {
      path: '^(harness|packs|surfaces|identities|runtimes|evals|scripts)/',
      pathNot: [
        '^harness/config-api/src/',
        '^harness/shared/src/',
        '^harness/identity-api/src/',
        '^harness/pack-api/src/',
      ],
    },
  },
```

- [ ] **Step 3: Write the failing document test**

Create `harness/config-api/src/document.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { CLIENT_DOCUMENT_VERSION, migrate, parseClientDocument, surfaceNamesOf, tenantKeysOf } from './document.js';
import { fixtureDocument } from './testing.js';

describe('parseClientDocument', () => {
  it('accepts the fixture document and returns it parsed', () => {
    const document = parseClientDocument(fixtureDocument());
    expect(document.schemaVersion).toBe(CLIENT_DOCUMENT_VERSION);
    expect(document.id).toBe('fixture');
    expect(document.packs).toEqual(['@harness/pack-healthcare']);
    expect(document.runtime).toBe('deepagents');
    // `identity` is today's `IdentityFileShape`: `{ principals }` and nothing else. Task 2 adds
    // `defaults` to that shape and asserts on it there, in the task that makes the field exist.
    expect(document.identity.principals).toHaveLength(4);
    expect(document.plugins).toEqual([]);
  });

  it('orders surfaces so the primary is never the run API', () => {
    const document = parseClientDocument(fixtureDocument());
    expect(surfaceNamesOf(document)).toEqual(['memory', 'http']);
    const withSlack = parseClientDocument(
      fixtureDocument({
        surfaces: {
          http: {},
          slack: { teamId: 'T001', signingSecret: { env: 'SLACK_SIGNING_SECRET' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
        },
      }),
    );
    // Declaration order in the file does not decide it; SURFACE_ORDER does.
    expect(surfaceNamesOf(withSlack)).toEqual(['slack', 'http']);
  });

  it('refuses a document whose only surface is the run API, which cannot post an approval card', () => {
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { http: {} } }))).toThrow(ConfigError);
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { http: {} } }))).toThrow(
      /"http" cannot be a client's primary surface/,
    );
  });

  it('refuses a secret value where a SecretRef is expected', () => {
    const raw = fixtureDocument({
      surfaces: {
        memory: {},
        slack: { teamId: 'T001', signingSecret: 'xoxb-not-a-reference', botToken: { env: 'SLACK_BOT_TOKEN' } },
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(ConfigError);
    expect(() => parseClientDocument(raw)).toThrow(/signingSecret/);
  });

  it('refuses a SecretRef naming something that is not an environment variable', () => {
    const raw = fixtureDocument({
      surfaces: {
        memory: {},
        slack: { teamId: 'T001', signingSecret: { env: 'slack signing secret' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(/env/);
  });

  it('refuses a client id that is not a safe path segment and a safe Postgres value', () => {
    expect(() => parseClientDocument(fixtureDocument({ id: '../escape' }))).toThrow(ConfigError);
    expect(() => parseClientDocument(fixtureDocument({ id: 'Fixture' }))).toThrow(ConfigError);
  });

  it('applies the identity rules zod cannot say', () => {
    const raw = fixtureDocument({
      identity: {
        principals: [
          { id: 'u-one', kind: 'user', level: 'lead', displayName: 'One', surfaces: { memory: 'U1' } },
          { id: 'u-two', kind: 'user', level: 'lead', displayName: 'Two', surfaces: { memory: 'U1' } },
        ],
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(/both claim user "U1" on surface "memory"/);
  });

  it('reserves plugins: an entry is refused until Plan 12 defines one', () => {
    expect(() => parseClientDocument(fixtureDocument({ plugins: [{ kind: 'mcp' }] }))).toThrow(ConfigError);
  });

  it('names the tenant keys a resolver matches, without the caller knowing a vendor field', () => {
    const withSlack = parseClientDocument(
      fixtureDocument({
        surfaces: {
          slack: { teamId: 'T0ABCDEF', signingSecret: { env: 'SLACK_SIGNING_SECRET' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
        },
      }),
    );
    expect(tenantKeysOf(withSlack)).toEqual([{ surface: 'slack', key: 'T0ABCDEF' }]);
    // A surface with nothing that identifies a workspace contributes no key.
    expect(tenantKeysOf(parseClientDocument(fixtureDocument()))).toEqual([]);
  });

  it("names a memory surface's workspace as a tenant key too, which is what a pooled test routes on", () => {
    const pooled = parseClientDocument(fixtureDocument({ surfaces: { memory: { workspace: 'W-ALPHA' }, http: {} } }));
    expect(tenantKeysOf(pooled)).toEqual([{ surface: 'memory', key: 'W-ALPHA' }]);
  });
});

describe('migrate', () => {
  it('accepts schemaVersion 1, which is the only one there is', () => {
    expect(migrate(fixtureDocument()).id).toBe('fixture');
  });

  it('rejects schemaVersion 2 by name, because forward-only means there is nowhere to go', () => {
    expect(() => migrate(fixtureDocument({ schemaVersion: 2 }))).toThrow(ConfigError);
    expect(() => migrate(fixtureDocument({ schemaVersion: 2 }))).toThrow(
      /client document schemaVersion 2 is newer than this build, which knows 1/,
    );
  });

  it('rejects a document with no schemaVersion at all', () => {
    const raw = fixtureDocument();
    delete (raw as Record<string, unknown>).schemaVersion;
    expect(() => migrate(raw)).toThrow(/schemaVersion/);
  });
});
```

- [ ] **Step 4: Run it to verify it fails**

Run: `pnpm --filter @harness/config-api exec vitest run src/document.test.ts`
Expected: FAIL — the package has no `src/` yet, so the transform cannot resolve `./document.js`.

- [ ] **Step 5: Write `src/routing.ts` — the routing schema, moved**

Create `harness/config-api/src/routing.ts` with the exact contents of `harness/gateway/src/domain/routing/types.ts` as it stands today, with the header comment's second sentence changed because the home has moved:

```ts
import * as z from 'zod/v4';

/**
 * The five named routes. Callers ask for a *job* (`extract`, `embed`), never a vendor, so a
 * routing change is a config change. This is the single definition; it lives beside the rest of
 * a client's configuration because `routes` is a section of the client document, and
 * `@harness/gateway` and `@harness/core-tools` both import it from here.
 *
 * `embed` is the odd one: it is an embeddings deployment, not a chat one, so `callModel` refuses
 * it and `embedTexts` in @harness/core-tools calls `POST /v1/embeddings` instead. It is a route
 * like the others here because everything a route *is* to this file — a model, fallbacks, a
 * daily budget, a rendered LiteLLM deployment — is the same for it.
 */
export const ROUTES = ['chat', 'extract', 'reason', 'judge', 'embed'] as const;
export type Route = (typeof ROUTES)[number];

export const RouteSpec = z
  .object({
    /** A LiteLLM model identifier, always provider-prefixed (e.g. `gemini/gemini-3-flash-preview`). */
    model: z.string().min(1),
    /** Only for self-hosted endpoints (vLLM, Ollama). Hosted providers resolve their own base URL. */
    api_base: z.string().url().optional(),
    /** Tried in order when the primary deployment errors or is over budget. */
    fallbacks: z.array(z.string().min(1)).max(3).default([]),
    /** USD per rolling day for this route's deployments. */
    daily_budget_usd: z.number().positive().max(1000).optional(),
  })
  // An inline `api_key:` (or any other typo/unsupported field) must fail loudly
  // rather than be silently dropped — a routing file is not a place to smuggle
  // a literal credential past the generator's os.environ/-only contract.
  .strict();
export type RouteSpec = z.infer<typeof RouteSpec>;

export const RoutingFile = z.object({
  routes: z
    .object({
      chat: RouteSpec,
      extract: RouteSpec,
      reason: RouteSpec,
      judge: RouteSpec,
      embed: RouteSpec,
    })
    .strict(),
  defaults: z
    .object({
      daily_budget_usd: z.number().positive().max(1000).default(1),
      num_retries: z.number().int().min(0).max(5).default(2),
      request_timeout_s: z.number().int().min(5).max(600).default(120),
    })
    // `.default({})` supplies this object as-is without running it through the
    // inner schema, so an entirely absent `defaults:` key would otherwise skip
    // the per-field defaults above. Spell them out here too.
    .default({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 }),
});
export type RoutingFile = z.infer<typeof RoutingFile>;
```

Then **delete** `harness/gateway/src/domain/routing/types.ts`, and in `harness/gateway/src/domain/routing/parse.ts`, `render.ts`, `routing.test-helpers.ts`, `parse.test.ts` and `render.test.ts`, change every `from './types.js'` that reaches a routing symbol to `from '@harness/config-api'`. In `harness/gateway/package.json` add `"@harness/config-api": "workspace:*"` to `dependencies` and **remove** the `"./routing": "./src/domain/routing/types.ts"` entry from `exports`, leaving `exports` as `{ ".": "./src/index.ts" }`. In `harness/core-tools/package.json` add `"@harness/config-api": "workspace:*"` **and remove `"@harness/gateway": "workspace:*"`**, and in `harness/core-tools/src/domain/models/types.ts` change the first line to:

```ts
import { ROUTES, type Route } from '@harness/config-api';
```

That file is the only importer of `@harness/gateway` in `@harness/core-tools` (`grep -rn '@harness/gateway' harness/core-tools/src` hits it and nothing else), so once it points at the contract the dependency names a package nothing imports. It is removed here rather than left: Task 9 adds the **reverse** edge, `gateway → core-tools`, and a dependency with no importer pointing the other way is one refactor away from reading as a cycle.

Then run `pnpm install` so the new workspace links resolve.

- [ ] **Step 6: Write `src/playbooks.ts` — the playbook schema, moved**

Create `harness/config-api/src/playbooks.ts`:

```ts
import { Cron } from 'croner';
import * as z from 'zod/v4';
import { PRINCIPAL_ID_PATTERN } from '@harness/identity-api';
import { CONVERSATION_ID_PATTERN, ConfigError, PLAYBOOK_NAME_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';

/** The name shape lives in `@harness/shared`, because `playbooks_run_now` checks the same one. */
export { PLAYBOOK_NAME_PATTERN };

/** `none`: the run's reply is recorded and posted nowhere. `conversation`: posted once to `surface`/`conversation`. */
export const DELIVERIES = ['none', 'conversation'] as const;

/**
 * Five or six whitespace-separated fields (kernel decision 12), and a pattern that fires at least
 * once.
 *
 * The field count is checked before croner sees the string, because croner is wider than the
 * decision: it also takes seven fields, the `@daily` family of nicknames and an ISO one-shot
 * date, none of which a playbook may use. The `nextRun()` call catches the other half — croner
 * builds an impossible calendar date such as `0 0 30 2 *` without complaint and only reports the
 * impossibility when asked for a firing, which would otherwise be a startup crash inside
 * `syncPlaybooks` rather than a parse error here. Building a job with no callback holds no timer,
 * so both halves are pure computation.
 */
function validSchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/).length;
  if (fields < 5 || fields > 6) return false;
  try {
    return new Cron(schedule).nextRun() !== null;
  } catch {
    return false;
  }
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** One entry of the client document's `playbooks` section (kernel spec 5.6). */
export const PlaybookShape = z
  .object({
    name: z.string().regex(PLAYBOOK_NAME_PATTERN, 'a playbook name is a lowercase slug of at most 64 characters'),
    schedule: z
      .string()
      .refine(validSchedule, 'schedule must be a cron expression of five or six fields that fires at least once'),
    timezone: z
      .string()
      .refine(validTimezone, 'timezone must be an IANA zone name such as UTC or America/New_York')
      .default('UTC'),
    skill: z.string().min(1),
    prompt: z.string().min(1).max(4_000),
    principal: z.string().regex(PRINCIPAL_ID_PATTERN, 'principal must be an id the document declares'),
    surface: z.string().regex(SURFACE_NAME_PATTERN).optional(),
    conversation: z.string().regex(CONVERSATION_ID_PATTERN).optional(),
    deliver: z.enum(DELIVERIES).default('none'),
    cost_cap_usd: z.number().positive().max(1_000),
    timeout_s: z.number().int().min(10).max(3_600).default(600),
    enabled: z.boolean().default(true),
  })
  .strict();

export const PlaybooksFileShape = z.object({ playbooks: z.array(PlaybookShape).default([]) }).strict();

export type PlaybookDefinition = z.infer<typeof PlaybookShape>;

/**
 * Parse a playbooks section, then apply the two rules zod cannot say: names are unique, and a
 * playbook runs as a service — a person's principal on a schedule would act while they are not
 * there (kernel spec 3.3, 5.6).
 */
export function parsePlaybooksFile(raw: unknown): PlaybookDefinition[] {
  const parsed = PlaybooksFileShape.safeParse(raw ?? {});
  if (!parsed.success) throw new ConfigError(`playbooks are invalid: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const p of parsed.data.playbooks) {
    if (seen.has(p.name)) throw new ConfigError(`playbooks: "${p.name}" is declared twice`);
    seen.add(p.name);
    if (!p.principal.startsWith('svc-')) {
      throw new ConfigError(`playbooks: "${p.name}" must run as a service principal (svc-…), not "${p.principal}"`);
    }
  }
  return parsed.data.playbooks;
}
```

Then rewrite `harness/host/src/domain/playbooks/schema.ts` so that it holds **only** `nextRunAfter`, and re-exports nothing it no longer owns:

```ts
import { Cron } from 'croner';
import { ConfigError } from '@harness/shared';

/**
 * The first firing strictly after `from`, in `timezone`. `where` names the playbook, and the
 * client it came from, in the error: a schedule that fires no more is an operator's typo, and the
 * cron string alone does not say which entry to go and fix.
 *
 * The schedule's *shape* is validated in `@harness/config-api`, where the client document's
 * `playbooks` section is declared; this is the one piece of playbook scheduling that needs a
 * clock rather than a schema, so it is the one piece that stayed in the host.
 */
export function nextRunAfter(schedule: string, timezone: string, from: Date, where?: string): Date {
  const next = new Cron(schedule, { timezone }).nextRun(from);
  if (!next) {
    const subject = where === undefined ? `schedule "${schedule}"` : `${where}: schedule "${schedule}"`;
    throw new ConfigError(`${subject} never fires after ${from.toISOString()}`);
  }
  return next;
}
```

`readPlaybooksFile` is **deleted** with that rewrite: playbooks come from the document. In `harness/host/package.json` add `"@harness/config-api": "workspace:*"`. Then, in every host file that imported a playbook symbol from `./schema.js` — `domain/playbooks/repository.ts`, `preflight.ts`, `scheduler.ts` and their tests — import `PlaybookDefinition`, `DELIVERIES`, `PlaybookShape`, `PlaybooksFileShape` and `parsePlaybooksFile` from `@harness/config-api` instead, and keep importing `nextRunAfter` from `./schema.js`. In `harness/host/src/app/main.ts`, replace the `readPlaybooksFile` import and its two call sites with this literal, which Task 6 deletes when it replaces the whole script:

```ts
const playbooksFile = { file: 'client document', present: true, playbooks: [] as PlaybookDefinition[] };
```

with the comment `// Task 6 replaces this whole script with createHost(); the document's playbooks arrive there.` Move `harness/host/src/domain/playbooks/schema.test.ts`'s schema cases into `harness/config-api/src/playbooks.test.ts` (Step 8) and leave only the `nextRunAfter` cases behind.

- [ ] **Step 7: Write `src/policy.ts`, `src/types.ts`, `src/document.ts`**

Create `harness/config-api/src/policy.ts`:

```ts
import * as z from 'zod/v4';
import { ACTION_CLASSES, BEHAVIORS } from '@harness/pack-api';
import { LEVELS } from '@harness/shared';

const OverridesShape = z.partialRecord(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS));

/** The action-class table a client overrides, exactly as `policy.yaml` held it. */
export const PolicyFileShape = z.object({
  classes: OverridesShape.optional(),
  levels: z.partialRecord(z.enum(LEVELS), OverridesShape).optional(),
});

/**
 * A client's whole policy section: the override table, plus the tools this client withholds.
 *
 * `tools.hide` names kernel or pack tools this client does not publish (spec decision 7). It
 * withholds a tool **without** blinding the action class it belongs to, which is the difference
 * from setting that class to `blocked`: everything else in the class still works. A name that no
 * loaded pack or kernel catalogue publishes is not an error — a client that lists a tool it never
 * had is simply a client that does not have it — so the list is validated for shape alone.
 */
export const ClientPolicyShape = PolicyFileShape.extend({
  tools: z
    .object({ hide: z.array(z.string().regex(/^[a-z][a-z0-9_]*$/)).default([]) })
    .strict()
    .default({ hide: [] }),
});
```

Create `harness/config-api/src/types.ts`:

```ts
import type { ClientDocument } from './document.js';

/**
 * A reference to a secret, never the secret.
 *
 * `{ env: 'SLACK_BOT_TOKEN' }` names an environment variable the host resolves from its own
 * process environment. A `{ ref: string }` member into a platform secret store is reserved for
 * the deployment that has one; until then a document that carried a literal value would be a
 * document that got copied into a ticket, so the schema admits no such shape at all.
 */
export interface SecretRef {
  env: string;
}

/** One operation of the JSON Patch subset an overlay may use (spec decision 3). */
export type PatchOp =
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type JsonPatch = readonly PatchOp[];

/**
 * A catalogue entry: a complete document with placeholders, less the two fields that name a
 * tenant, plus the pointers a tenant may not touch.
 *
 * `lockset` is a list of JSON pointers into the document. A finished agent locks `/persona` and
 * `/policy`; a customisable one locks nothing; a subscription tier is a lock set. `/id` and
 * `/displayName` are absent from `document` and may not appear in `lockset`, because the overlay
 * is the only thing that can supply them.
 */
export interface Blueprint {
  document: Omit<ClientDocument, 'id' | 'displayName'>;
  lockset: readonly string[];
  version: string;
}

/** A tenant's edits to a blueprint. */
export interface Overlay {
  patch: JsonPatch;
  version: string;
}

/** What a source answers with: the document, and the version string that identifies it. */
export interface LoadedDocument {
  document: ClientDocument;
  version: string;
}

/**
 * Where a client document comes from.
 *
 * `load` is the whole of what a host needs. `watch` is how a host learns that a document changed
 * without restarting — the callback receives the new version, and the returned function stops
 * watching. `list` is for the platform and for a pooled host that wants to warm its map; a source
 * that cannot enumerate simply does not offer it. `close` releases whatever the source holds.
 *
 * Every implementation runs `configSourceConformance` from `@harness/config-api/testing`, which
 * is what keeps "a source" one thing rather than two.
 */
export interface ConfigSource {
  /** Lowercase, stable: `files`, `postgres`. What `HARNESS_CONFIG_SOURCE` names. */
  readonly name: string;
  load(clientId: string): Promise<LoadedDocument | null>;
  watch?(clientId: string, onChange: (version: string) => void): () => void;
  list?(): Promise<string[]>;
  close?(): Promise<void>;
}
```

Create `harness/config-api/src/document.ts`:

```ts
import * as z from 'zod/v4';
import { IdentityFileShape, parseIdentityFile } from '@harness/identity-api';
import { ConfigError } from '@harness/shared';
import { PlaybooksFileShape, parsePlaybooksFile } from './playbooks.js';
import { ClientPolicyShape } from './policy.js';
import { RoutingFile } from './routing.js';

/** Bumped when a document's shape changes in a way `migrate` has to answer for. */
export const CLIENT_DOCUMENT_VERSION = 1;

/** A client id: a safe path segment, a safe Postgres `client` value, and a safe URL segment. */
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** A plug-in name: the same rule `defineSurface`, `defineIdentityProvider` and `definePack` apply. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** A skill's directory name, which `readSkillCatalogue` requires the frontmatter `name` to match. */
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

/** An environment variable name, which is what a `SecretRef` names. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export const SecretRefShape = z
  .object({ env: z.string().regex(ENV_NAME, 'a secret reference names an environment variable (A-Z, digits, _)') })
  .strict();

/**
 * The surfaces a client may declare, in the order the host loads them.
 *
 * **The order is the schema's, not the file's.** The first loaded surface is the primary — where
 * approval cards go — and a file's key order is not something a YAML writer or a JSON column
 * should be able to change by accident. `http` is last because it cannot post a card, which is
 * the rule `.env.example` used to state in prose about `HARNESS_SURFACES`.
 */
export const SURFACE_ORDER = ['slack', 'memory', 'http'] as const;

/** The one surface that may never be a client's primary. */
const CANNOT_BE_PRIMARY = 'http';

const SurfacesShape = z
  .object({
    slack: z
      .object({
        /** The workspace this client is; the host matches an inbound event's tenant hint against it. */
        teamId: z.string().min(1).max(64),
        signingSecret: SecretRefShape,
        botToken: SecretRefShape,
      })
      .strict()
      .optional(),
    memory: z
      .object({
        /**
         * An optional workspace name for the memory surface, with exactly the role `teamId` has
         * for Slack: it is what an inbound event's tenant hint is matched against. It exists
         * because a pooled host cannot serve two live Slack tenants in this plan (decision 6),
         * and pooled routing still has to be provable end to end — the memory surface is the one
         * spec §9 asks the isolation work to be proved with.
         */
        workspace: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    http: z.object({}).strict().optional(),
  })
  .strict();

export const ClientDocumentShape = z
  .object({
    schemaVersion: z.number().int().min(1),
    id: z.string().regex(CLIENT_ID, 'a client id is lowercase letters, digits and hyphens, 2 to 64 characters'),
    displayName: z.string().trim().min(1).max(120),
    /** Today's SOUL.md body, verbatim. */
    persona: z.string().min(1),
    /** Today's identity.yaml: the declared principals, and the level everyone else gets. */
    identity: IdentityFileShape,
    /** Today's policy.yaml, plus the tools this client withholds. */
    policy: ClientPolicyShape,
    /** Today's routing.yaml. */
    routing: RoutingFile,
    /** Today's playbooks.yaml. */
    playbooks: PlaybooksFileShape,
    /** Today's skills/ directory: name → the whole SKILL.md, frontmatter included. */
    skills: z.record(z.string().regex(SKILL_NAME), z.string().min(1)).default({}),
    knowledge: z
      .discriminatedUnion('source', [
        z.object({ source: z.literal('dir'), path: z.string().min(1) }).strict(),
        z.object({ source: z.literal('store') }).strict(),
      ])
      .default({ source: 'store' }),
    surfaces: SurfacesShape,
    identityProvider: z
      .object({
        kind: z.string().regex(PLUGIN_NAME, 'an identity provider kind is a plug-in name'),
        /** Provider-specific settings; the provider validates them with its own schema. */
        settings: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    runtime: z.string().regex(PLUGIN_NAME, 'a runtime is a plug-in name'),
    /**
     * Declared plug-ins (MCP and A2A endpoints). Reserved: Plan 12 defines the entry shape, and
     * until it does a document that carries one would be a document whose plug-ins nothing runs.
     */
    plugins: z.array(z.unknown()).max(0, 'declared plug-ins arrive in Plan 12').default([]),
    /** Package names, as `HARNESS_PACKS` held them. An empty list is a client with no pack. */
    packs: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ClientDocument = z.infer<typeof ClientDocumentShape>;

/** The surfaces this document declares, in load order; the first is the primary. */
export function surfaceNamesOf(document: ClientDocument): string[] {
  return SURFACE_ORDER.filter((name) => document.surfaces[name] !== undefined);
}

/**
 * The opaque keys an inbound event's tenant hint is matched against, one per surface that has a
 * way of naming the workspace it belongs to.
 *
 * This function is where the typed surface sections are read, so the host never is: it builds its
 * `surface:key → client id` map from these pairs and stays free of any vendor's field name, which
 * `kernel-vocabulary.test.ts` requires of `harness/host/src`.
 */
export function tenantKeysOf(document: ClientDocument): { surface: string; key: string }[] {
  const keys: { surface: string; key: string }[] = [];
  if (document.surfaces.slack) keys.push({ surface: 'slack', key: document.surfaces.slack.teamId });
  if (document.surfaces.memory?.workspace) {
    keys.push({ surface: 'memory', key: document.surfaces.memory.workspace });
  }
  return keys;
}

/**
 * Validate a raw document, then apply the rules zod cannot say: the identity section's four
 * cross-principal rules, the playbooks' two, and the primary-surface rule.
 *
 * Every failure is a `ConfigError`, because every one of them is something a person wrote.
 */
export function parseClientDocument(raw: unknown): ClientDocument {
  const parsed = ClientDocumentShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`client document is invalid: ${z.prettifyError(parsed.error)}`);
  const document = parsed.data;
  // Delegated to the contracts that own each section, so one implementation of each rule exists.
  parseIdentityFile(document.identity);
  parsePlaybooksFile(document.playbooks);
  const surfaces = surfaceNamesOf(document);
  if (surfaces.length === 0) throw new ConfigError(`client "${document.id}" declares no surface; at least one is required`);
  if (surfaces[0] === CANNOT_BE_PRIMARY) {
    throw new ConfigError(
      `client "${document.id}": "${CANNOT_BE_PRIMARY}" cannot be a client's primary surface, because an approval card has nowhere to go; declare a messaging surface beside it`,
    );
  }
  return document;
}

/**
 * A raw document at whatever `schemaVersion` it carries, brought to this build's.
 *
 * Forward only, and there is exactly one version, so today this is a version check and a parse.
 * It exists now rather than when the second version arrives because the alternative is a store
 * full of documents nobody can tell apart.
 */
export function migrate(raw: unknown): ClientDocument {
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== 'number') {
    throw new ConfigError('client document has no numeric schemaVersion; every document declares one');
  }
  if (version > CLIENT_DOCUMENT_VERSION) {
    throw new ConfigError(
      `client document schemaVersion ${version} is newer than this build, which knows ${CLIENT_DOCUMENT_VERSION}; upgrade the host`,
    );
  }
  return parseClientDocument(raw);
}
```

- [ ] **Step 8: Write the moved schemas' tests**

Create `harness/config-api/src/routing.test.ts` with the routing-shape cases that live in `harness/gateway/src/domain/routing/parse.test.ts` today, moved verbatim except that the import becomes `from './routing.js'` and a YAML string becomes a plain object (the YAML parse stays in the gateway):

```ts
import { describe, expect, it } from 'vitest';
import { ROUTES, RoutingFile } from './routing.js';

const route = { model: 'gemini/gemini-3-flash-preview' };
const routes = Object.fromEntries(ROUTES.map((name) => [name, route]));

describe('RoutingFile', () => {
  it('names the five routes and supplies every default when `defaults` is absent', () => {
    const parsed = RoutingFile.parse({ routes });
    expect(Object.keys(parsed.routes).sort()).toEqual([...ROUTES].sort());
    expect(parsed.defaults).toEqual({ daily_budget_usd: 1, num_retries: 2, request_timeout_s: 120 });
    expect(parsed.routes.chat.fallbacks).toEqual([]);
  });

  it('refuses a route that is not one of the five, and a missing one', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, gossip: route } }).success).toBe(false);
    const { embed: _embed, ...four } = routes;
    expect(RoutingFile.safeParse({ routes: four }).success).toBe(false);
  });

  it('refuses an inline key on a route, so a literal credential cannot be smuggled in', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, api_key: 'sk-live' } } }).success).toBe(false);
  });

  it('bounds the fallbacks and the budget', () => {
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, fallbacks: ['a', 'b', 'c', 'd'] } } }).success).toBe(false);
    expect(RoutingFile.safeParse({ routes: { ...routes, chat: { ...route, daily_budget_usd: 0 } } }).success).toBe(false);
  });
});
```

Create `harness/config-api/src/playbooks.test.ts` by moving every case of `harness/host/src/domain/playbooks/schema.test.ts` that exercises `PlaybookShape`, `PlaybooksFileShape` or `parsePlaybooksFile` into it, changing only the import to `from './playbooks.js'` and the two expected messages to the new wording (`playbooks are invalid`, `playbooks: "<name>" is declared twice`, `playbooks: "<name>" must run as a service principal`). Leave the `nextRunAfter` cases in the host's file, with its import narrowed to `./schema.js`.

- [ ] **Step 9: Write `src/resolve.ts`**

Create `harness/config-api/src/resolve.ts`:

```ts
import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from './document.js';
import type { Blueprint, Overlay, PatchOp } from './types.js';

/**
 * The segments of an RFC 6901 JSON pointer, with `~1` and `~0` unescaped.
 *
 * `''` is the whole document and has no segments. Anything that does not begin with `/` is not a
 * pointer, and saying so here is what keeps a typo in a lock set from silently locking nothing.
 */
export function pointerSegments(pointer: string): string[] {
  if (pointer === '') return [];
  if (!pointer.startsWith('/')) throw new ConfigError(`"${pointer}" is not a JSON pointer; one starts with "/"`);
  return pointer
    .slice(1)
    .split('/')
    .map((segment) => segment.replaceAll('~1', '/').replaceAll('~0', '~'));
}

/**
 * Whether `a` and `b` overlap: either is a prefix of the other, or they are equal.
 *
 * Both directions matter (decision 11). An operation *inside* a locked subtree edits something
 * locked; an operation *above* a locked leaf replaces the subtree that leaf is in, which edits it
 * just as surely. Segment-wise rather than string-wise, so `/policy` does not appear to be a
 * prefix of `/policyOverride`.
 */
function pointersOverlap(a: string[], b: string[]): boolean {
  const shared = Math.min(a.length, b.length);
  for (let i = 0; i < shared; i += 1) if (a[i] !== b[i]) return false;
  return true;
}

function container(root: Record<string, unknown>, segments: string[]): Record<string, unknown> {
  let node: unknown = root;
  for (const segment of segments) {
    if (typeof node !== 'object' || node === null) {
      throw new ConfigError(`overlay: /${segments.join('/')} has no container in the blueprint`);
    }
    node = (node as Record<string, unknown>)[segment];
  }
  if (typeof node !== 'object' || node === null) {
    throw new ConfigError(`overlay: /${segments.join('/')} is not an object or array in the blueprint`);
  }
  return node as Record<string, unknown>;
}

/** Read what a pointer names, or `undefined`. Used by `remove` and `replace` to check presence. */
export function readPointer(root: unknown, pointer: string): unknown {
  let node: unknown = root;
  for (const segment of pointerSegments(pointer)) {
    if (typeof node !== 'object' || node === null) return undefined;
    node = (node as Record<string, unknown>)[segment];
  }
  return node;
}

/** Apply one operation in place. `add` and `replace` are the same write; `remove` deletes the key. */
export function writePointer(root: Record<string, unknown>, op: PatchOp): void {
  const segments = pointerSegments(op.path);
  if (segments.length === 0) throw new ConfigError('overlay: the whole document is not a patchable path');
  const last = segments[segments.length - 1];
  const parent = container(root, segments.slice(0, -1));
  if (op.op === 'remove') {
    if (!(last in parent)) throw new ConfigError(`overlay: cannot remove ${op.path}, which the blueprint does not have`);
    if (Array.isArray(parent)) parent.splice(Number(last), 1);
    else delete parent[last];
    return;
  }
  if (op.op === 'replace' && !(last in parent)) {
    throw new ConfigError(`overlay: cannot replace ${op.path}, which the blueprint does not have; use "add"`);
  }
  parent[last] = op.value;
}

/**
 * A blueprint plus a tenant's overlay, under the blueprint's lock set (spec §3.5, decision 3).
 *
 * Every operation is checked against every locked pointer **before** anything is applied, in the
 * order the overlay lists them, and the first violation is the one named — so the message is the
 * same every time for the same overlay. The result is parsed as a whole document, because a patch
 * that left the schema behind is a patch that has to fail here rather than at the first run.
 *
 * `/id` and `/displayName` are what the overlay supplies — a blueprint has neither — so a lock
 * set that named either would describe a blueprint no tenant could instantiate, and is refused.
 */
export function resolve(blueprint: Blueprint, overlay: Overlay): ClientDocument {
  for (const locked of blueprint.lockset) {
    const segments = pointerSegments(locked);
    if (segments.length === 1 && (segments[0] === 'id' || segments[0] === 'displayName')) {
      throw new ConfigError(
        `blueprint ${blueprint.version}: "${locked}" cannot be locked; a tenant's overlay is the only thing that supplies it`,
      );
    }
  }
  const locks = blueprint.lockset.map((pointer) => ({ pointer, segments: pointerSegments(pointer) }));
  for (const op of overlay.patch) {
    const segments = pointerSegments(op.path);
    const hit = locks.find((lock) => pointersOverlap(segments, lock.segments));
    if (hit) {
      throw new ConfigError(
        `overlay ${overlay.version}: ${op.op} ${op.path} touches "${hit.pointer}", which blueprint ${blueprint.version} locks`,
      );
    }
  }
  const draft = structuredClone(blueprint.document) as unknown as Record<string, unknown>;
  for (const op of overlay.patch) writePointer(draft, op);
  return parseClientDocument(draft);
}
```

- [ ] **Step 10: Write `src/index.ts` and `src/testing.ts`**

Create `harness/config-api/src/index.ts`:

```ts
/**
 * What a client is, and where one comes from.
 *
 * Everything here is either a schema a tenant's configuration is validated against, a function
 * the kernel calls to turn a raw document into a resolved one, or the shape of a source. It
 * imports `@harness/identity-api`, `@harness/pack-api`, `@harness/shared`, zod and croner, and
 * nothing else in the workspace, so the two source implementations, the kernel, the host, the
 * gateway renderer and the scaffolder can all hold it without holding each other. See
 * ARCHITECTURE.md, "The client document".
 */
export {
  CLIENT_DOCUMENT_VERSION,
  ClientDocumentShape,
  SURFACE_ORDER,
  SecretRefShape,
  migrate,
  parseClientDocument,
  surfaceNamesOf,
  tenantKeysOf,
  type ClientDocument,
} from './document.js';
export { ClientPolicyShape, PolicyFileShape } from './policy.js';
export {
  DELIVERIES,
  PLAYBOOK_NAME_PATTERN,
  PlaybookShape,
  PlaybooksFileShape,
  parsePlaybooksFile,
  type PlaybookDefinition,
} from './playbooks.js';
export { ROUTES, RouteSpec, RoutingFile, type Route } from './routing.js';
export { pointerSegments, readPointer, resolve, writePointer } from './resolve.js';
export type { Blueprint, ConfigSource, JsonPatch, LoadedDocument, Overlay, PatchOp, SecretRef } from './types.js';
```

Create `harness/config-api/src/testing.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { CLIENT_DOCUMENT_VERSION, parseClientDocument, type ClientDocument } from './document.js';
import type { ConfigSource, LoadedDocument } from './types.js';

/**
 * A complete, valid client document, as a plain object, for a test or a conformance suite to
 * start from. `overrides` are shallow: pass a whole section, not a piece of one.
 *
 * It declares the memory surface and the run API, a scripted-runtime-shaped `runtime`, the
 * healthcare pack and one skill, because those are what the kernel's own suites need. It is NOT
 * the fixture client on disk — `clients/fixture/client.yaml` is, and Task 9 writes it.
 */
export function fixtureDocument(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: CLIENT_DOCUMENT_VERSION,
    id: 'fixture',
    displayName: 'Fixture',
    persona: 'You are the test assistant.',
    identity: {
      principals: [
        { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' } },
        { id: 'u-member', kind: 'user', level: 'member', displayName: 'Member', surfaces: { memory: 'U345' } },
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
        { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' },
      ],
    },
    policy: {},
    routing: {
      routes: {
        chat: { model: 'gemini/gemini-3-flash-preview' },
        extract: { model: 'gemini/gemini-3-flash-preview' },
        reason: { model: 'gemini/gemini-3-flash-preview' },
        judge: { model: 'groq/openai/gpt-oss-120b' },
        embed: { model: 'gemini/gemini-embedding-001' },
      },
    },
    playbooks: { playbooks: [] },
    skills: {},
    knowledge: { source: 'store' },
    surfaces: { memory: {}, http: {} },
    identityProvider: { kind: 'static' },
    runtime: 'deepagents',
    packs: ['@harness/pack-healthcare'],
    ...overrides,
  };
}

/** A source over documents already in hand: the one every kernel test drives. */
export class MemoryConfigSource implements ConfigSource {
  readonly name = 'memory';

  private readonly documents = new Map<string, LoadedDocument>();
  private readonly watchers = new Map<string, Set<(version: string) => void>>();
  closed = false;

  constructor(documents: readonly LoadedDocument[] = []) {
    for (const entry of documents) this.documents.set(entry.document.id, entry);
  }

  /** Make `document` the current version of its client, notifying every watcher of that client. */
  put(document: ClientDocument, version: string): void {
    this.documents.set(document.id, { document, version });
    for (const notify of this.watchers.get(document.id) ?? []) notify(version);
  }

  async load(clientId: string): Promise<LoadedDocument | null> {
    return this.documents.get(clientId) ?? null;
  }

  watch(clientId: string, onChange: (version: string) => void): () => void {
    const set = this.watchers.get(clientId) ?? new Set();
    set.add(onChange);
    this.watchers.set(clientId, set);
    return () => set.delete(onChange);
  }

  async list(): Promise<string[]> {
    return [...this.documents.keys()].sort();
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}

/** What a source implementation hands the conformance suite so it can drive it. */
export interface ConfigSourceHarness {
  source: ConfigSource;
  /**
   * Make `document` the current version of its client, and answer with **the version the source
   * will actually serve for it**.
   *
   * A source that takes caller-supplied versions returns `version` unchanged; one that derives its
   * own — `@harness/config-files` hashes the document's content — returns what it derived. The
   * conformance suite asserts the *property* a version has (it identifies a document, it is stable
   * while the content is, and it moves when the content does) rather than a literal string, which
   * no content-addressed source could satisfy.
   */
  put(document: ClientDocument, version: string): Promise<string>;
  close(): Promise<void>;
}

/**
 * The suite every `ConfigSource` runs, so that "a source" is one thing rather than two.
 *
 * `makeSource` is called fresh for each case and its `close` is awaited afterwards, so a case
 * that fails does not leave a connection or a watcher behind for the next one.
 */
export function configSourceConformance(makeSource: () => Promise<ConfigSourceHarness>): void {
  const withSource = async (body: (harness: ConfigSourceHarness) => Promise<void>): Promise<void> => {
    const harness = await makeSource();
    try {
      await body(harness);
    } finally {
      await harness.close();
    }
  };

  describe('ConfigSource conformance', () => {
    it('answers null for a client it does not hold, rather than throwing', async () => {
      await withSource(async ({ source }) => {
        expect(await source.load('nobody')).toBeNull();
      });
    });

    it('answers a stored document with the version it assigned, and that same version twice', async () => {
      await withSource(async ({ source, put }) => {
        const document = parseClientDocument(fixtureDocument());
        const assigned = await put(document, 'v1');
        const first = await source.load('fixture');
        expect(first?.document.id).toBe('fixture');
        expect(first?.version).toBe(assigned);
        // Stable: two loads of an unchanged document answer the same version.
        expect((await source.load('fixture'))?.version).toBe(assigned);
        // Stable under a re-write too: the same content is the same version.
        expect(await put(document, 'v1')).toBe(assigned);
        expect((await source.load('fixture'))?.version).toBe(assigned);
      });
    });

    it('answers the new document and a different version once changed content is written', async () => {
      await withSource(async ({ source, put }) => {
        const before = await put(parseClientDocument(fixtureDocument()), 'v1');
        const after = await put(parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2');
        const loaded = await source.load('fixture');
        expect(loaded?.document.displayName).toBe('Renamed');
        expect(loaded?.version).toBe(after);
        // A version identifies a document, so changed content is a changed version — whether the
        // source was handed one or derived it from the content itself.
        expect(after).not.toBe(before);
      });
    });

    it('keeps two clients apart', async () => {
      await withSource(async ({ source, put }) => {
        await put(parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'Alpha' })), 'v1');
        await put(parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'Beta' })), 'v1');
        expect((await source.load('alpha'))?.document.displayName).toBe('Alpha');
        expect((await source.load('beta'))?.document.displayName).toBe('Beta');
      });
    });

    it('lists what it holds, sorted, when it can list at all', async () => {
      await withSource(async ({ source, put }) => {
        if (!source.list) return;
        await put(parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'Beta' })), 'v1');
        await put(parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'Alpha' })), 'v1');
        expect(await source.list()).toEqual(['alpha', 'beta']);
      });
    });

    it('refuses a document that is not one, naming the section', async () => {
      await withSource(async ({ source, put }) => {
        await expect(
          put(fixtureDocument({ runtime: 'Not A Plug-in' }) as unknown as ClientDocument, 'v1').then(() =>
            source.load('fixture'),
          ),
        ).rejects.toThrow(ConfigError);
      });
    });
  });
}
```

- [ ] **Step 11: Write the resolve test and the testing test**

Create `harness/config-api/src/resolve.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from './document.js';
import { pointerSegments, readPointer, resolve } from './resolve.js';
import { fixtureDocument } from './testing.js';
import type { Blueprint, Overlay } from './types.js';

function blueprint(lockset: string[]): Blueprint {
  const { id: _id, displayName: _displayName, ...document } = fixtureDocument() as Record<string, unknown>;
  return { document: document as Blueprint['document'], lockset, version: 'bp-1' };
}

const names: Overlay = {
  version: 'ov-1',
  patch: [
    { op: 'add', path: '/id', value: 'acme' },
    { op: 'add', path: '/displayName', value: 'Acme' },
  ],
};

describe('pointerSegments', () => {
  it('splits a pointer and unescapes the two escapes', () => {
    expect(pointerSegments('/policy/classes/write.self')).toEqual(['policy', 'classes', 'write.self']);
    expect(pointerSegments('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(pointerSegments('')).toEqual([]);
  });

  it('refuses something that is not a pointer, so a typo locks loudly rather than nothing', () => {
    expect(() => pointerSegments('policy')).toThrow(ConfigError);
  });
});

describe('resolve', () => {
  it('applies an overlay on an unlocked path and returns a whole, valid document', () => {
    const document = resolve(blueprint(['/persona']), {
      version: 'ov-1',
      patch: [
        ...names.patch,
        { op: 'replace', path: '/displayName', value: 'Acme Clinic' },
        { op: 'add', path: '/policy/classes', value: { external: 'blocked' } },
      ],
    });
    expect(document.id).toBe('acme');
    expect(document.displayName).toBe('Acme Clinic');
    expect(readPointer(document, '/policy/classes/external')).toBe('blocked');
    // The blueprint is untouched: `resolve` clones before it writes.
    expect(readPointer(blueprint([]).document, '/policy/classes')).toBeUndefined();
  });

  it('refuses an operation inside a locked subtree, naming the operation and the lock', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/policy/classes/external', value: 'auto' }],
    };
    expect(() => resolve(blueprint(['/policy']), overlay)).toThrow(ConfigError);
    expect(() => resolve(blueprint(['/policy']), overlay)).toThrow(
      'overlay ov-1: replace /policy/classes/external touches "/policy", which blueprint bp-1 locks',
    );
  });

  it('refuses an operation above a locked leaf, because replacing the subtree replaces the leaf', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/policy', value: {} }],
    };
    expect(() => resolve(blueprint(['/policy/classes/external']), overlay)).toThrow(
      'overlay ov-1: replace /policy touches "/policy/classes/external", which blueprint bp-1 locks',
    );
  });

  it('does not read one pointer as a prefix of another that merely starts the same way', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/persona', value: 'Another persona.' }],
    };
    expect(resolve(blueprint(['/personaNotes']), overlay).persona).toBe('Another persona.');
  });

  it('names the first violation, so the same overlay always gives the same message', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [
        ...names.patch,
        { op: 'replace', path: '/persona', value: 'x' },
        { op: 'replace', path: '/runtime', value: 'other' },
      ],
    };
    expect(() => resolve(blueprint(['/runtime', '/persona']), overlay)).toThrow(/replace \/persona touches "\/persona"/);
  });

  it('refuses a blueprint that locks the two fields only an overlay can supply', () => {
    expect(() => resolve(blueprint(['/id']), names)).toThrow(/"\/id" cannot be locked/);
    expect(() => resolve(blueprint(['/displayName']), names)).toThrow(/cannot be locked/);
  });

  it('refuses a replace of something the blueprint does not have, and a remove of the same', () => {
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'replace', path: '/nothing', value: 1 }] }),
    ).toThrow(/cannot replace \/nothing/);
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'remove', path: '/nothing' }] }),
    ).toThrow(/cannot remove \/nothing/);
  });

  it('refuses a patch that leaves the schema behind, rather than handing back a broken document', () => {
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'replace', path: '/runtime', value: 7 }] }),
    ).toThrow(/client document is invalid/);
  });

  it('removes an unlocked key', () => {
    const document = resolve(blueprint([]), {
      version: 'ov-1',
      patch: [...names.patch, { op: 'remove', path: '/surfaces/http' }],
    });
    expect(document.surfaces.http).toBeUndefined();
  });
});
```

Create `harness/config-api/src/testing.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { parseClientDocument } from './document.js';
import { MemoryConfigSource, configSourceConformance, fixtureDocument } from './testing.js';

configSourceConformance(async () => {
  const source = new MemoryConfigSource();
  return {
    source,
    put: async (document, version) => {
      source.put(parseClientDocument(document), version);
      // This source serves the version it was handed, so that is what it assigned.
      return version;
    },
    close: async () => {
      await source.close();
    },
  };
});

describe('MemoryConfigSource', () => {
  it('tells a watcher of that client, and only that client, about a new version', () => {
    const source = new MemoryConfigSource();
    const seen: string[] = [];
    const stop = source.watch('fixture', (version) => seen.push(version));
    source.put(parseClientDocument(fixtureDocument()), 'v1');
    source.put(parseClientDocument(fixtureDocument({ id: 'other', displayName: 'Other' })), 'v9');
    expect(seen).toEqual(['v1']);
    stop();
    source.put(parseClientDocument(fixtureDocument()), 'v2');
    expect(seen).toEqual(['v1']);
  });
});
```

- [ ] **Step 12: Run the config-api suite to verify it passes**

Run: `pnpm --filter @harness/config-api test`
Expected: PASS — five files, the conformance suite among them.

- [ ] **Step 13: Scan the new package for vocabulary**

In `harness/core-tools/src/kernel-vocabulary.test.ts`, add three rows to `SCANNED`, immediately after the `identities/static/src` deployment row:

```ts
  {
    what: 'credentialing vocabulary',
    root: 'harness/config-api/src',
    forbidden: DOMAIN_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'framework and vendor vocabulary',
    root: 'harness/config-api/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'harness/config-api/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 5,
    skip: [/\.test\.ts$/],
  },
```

and extend the comment above `SCANNED` with this paragraph, before the "**The allowlist is empty**" one:

```
 * `harness/config-api/src` is scanned for three of the four lists and deliberately not for the
 * messaging one. The client document's schema has to name the surfaces a tenant may declare, so
 * `surfaces.slack` with its team id and its two secret references is *data the schema admits*
 * rather than a coupling — the same status `surfaces/slack` itself has, which is scanned by
 * nothing. It is scanned for the other three like any contract: a document schema that knew a
 * product area, a framework or a client's name would be the coupling this package exists to
 * remove, which is also why `runtime` is a plug-in *name* there and not a literal.
```

- [ ] **Step 14: Run the four gates**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder \
  pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && \
  TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test EVALS_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_evals LITELLM_MASTER_KEY=sk-ci-placeholder pnpm test
```
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 15: Commit**

```bash
git add harness/config-api harness/gateway harness/core-tools/package.json \
  harness/core-tools/src/domain/models/types.ts harness/core-tools/src/kernel-vocabulary.test.ts \
  harness/host/package.json harness/host/src/domain/playbooks harness/host/src/app/main.ts \
  .dependency-cruiser.cjs pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(config-api): add the client document, blueprints, overlays and the source contract"
```

---

### Task 2: Identity defaults, derived principals, and an identity plug-in that reads no file

**Files:**
- Modify: `harness/identity-api/src/principals.ts`, `src/types.ts`, `src/index.ts`, `src/principals.test.ts`
- Modify: `identities/static/src/index.ts`, `src/index.test.ts`, `identities/static/package.json`
- Modify: `harness/config-api/src/document.ts` (one call site), `harness/config-api/src/document.test.ts` (the `defaults` assertion, which belongs to the task that makes the field exist)
- Modify: `harness/core-tools/src/app/server.ts`, `harness/core-tools/src/domain/identity/registry.test.ts`
- Modify: `harness/host/src/app/main.ts`
- Modify: `.env.example` (**`HARNESS_IDENTITY_FILE` removed**)

**Interfaces:**
- Consumes: `IdentityFileShape`, `parseIdentityFile`, `PrincipalShape`, `PRINCIPAL_ID_PATTERN` (`@harness/identity-api`); `SURFACE_NAME_PATTERN`, `USER_LEVELS`, `ConfigError` (`@harness/shared`).
- Produces, from `@harness/identity-api`:
  - `type UserLevel = (typeof USER_LEVELS)[number]`
  - `IdentityDefaultsShape`, `UNDEFAULTABLE_SURFACE = 'http'`
  - `interface IdentityFile { principals: Principal[]; defaults: Record<string, UserLevel> }`
  - `parseIdentityFileWithDefaults(raw): IdentityFile`; `parseIdentityFile(raw): Principal[]` keeps its signature
  - `shapeDisplayName(raw: string, fallback: string): string`
  - `principalFromDefault(surface, userId, level, displayName?): Principal | null`
  - `principalFromDerivedId(id, defaults): Principal | null`
  - `IdentityDeps = { env: EnvSource; log: Logger; identity: IdentityFile; settings: Readonly<Record<string, unknown>> }`
- Produces nothing new from `identities/static`; its `identity` export keeps its `name`, `version` and empty `secrets`.

**Scaffolding this task adds and a later task removes.** `IdentityDeps` loses `clientDir` here, but the `ConfigSource` that supplies `document.identity` only arrives in Task 3. So the two composition roots — `harness/core-tools/src/app/server.ts` and `harness/host/src/app/main.ts` — read and parse `identity.yaml` inline for the length of two tasks, in `app/` where a file read is allowed, each marked with the task that deletes it (**Task 4** for the stdio server, **Task 6** for the host). Nothing outside `app/` gains a file path, and no shipped module ends this plan with two ways to find a principal.

- [ ] **Step 1: Write the failing principals test**

Replace the whole of `harness/identity-api/src/principals.test.ts`'s imports with the wider list and append four `describe` blocks. The imports become:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import {
  PRINCIPAL_ID_PATTERN,
  UNDEFAULTABLE_SURFACE,
  parseIdentityFile,
  parseIdentityFileWithDefaults,
  principalFromDefault,
  principalFromDerivedId,
  shapeDisplayName,
} from './principals.js';
```

and these blocks go after the existing `describe('parseIdentityFile', …)`:

```ts
describe('parseIdentityFileWithDefaults', () => {
  it('reads an empty default table when the file has no defaults, and the same principals', () => {
    const file = parseIdentityFileWithDefaults({ principals: [manager, nightly] });
    expect(file.defaults).toEqual({});
    expect(file.principals.map((p) => p.id)).toEqual(['u-practice-manager', 'svc-playbooks']);
    expect(parseIdentityFile({ principals: [manager, nightly] })).toEqual(file.principals);
  });

  it('reads a level per surface', () => {
    expect(parseIdentityFileWithDefaults({ defaults: { memory: 'member' }, principals: [manager] }).defaults).toEqual({
      memory: 'member',
    });
  });

  it('refuses "service" as a default, because a default is what an unknown person gets', () => {
    expect(() => parseIdentityFileWithDefaults({ defaults: { memory: 'service' }, principals: [manager] })).toThrow(
      ConfigError,
    );
    expect(() => parseIdentityFileWithDefaults({ defaults: { memory: 'service' }, principals: [manager] })).toThrow(
      /defaults/,
    );
  });

  it('refuses a surface name that is not a surface name, as `surfaces` does', () => {
    expect(() => parseIdentityFileWithDefaults({ defaults: { Memory: 'member' }, principals: [manager] })).toThrow(
      /identity file is invalid/,
    );
  });

  it('refuses a default on the run API, whose one bearer token would mint principals at will', () => {
    expect(() =>
      parseIdentityFileWithDefaults({ defaults: { [UNDEFAULTABLE_SURFACE]: 'member' }, principals: [manager] }),
    ).toThrow(ConfigError);
    expect(() => parseIdentityFileWithDefaults({ defaults: { http: 'member' }, principals: [manager] })).toThrow(
      /"http" may not have a default; the run API's bearer is one shared secret/,
    );
    // Every other surface is still free to have one.
    expect(parseIdentityFileWithDefaults({ defaults: { memory: 'member' }, principals: [manager] }).defaults).toEqual({
      memory: 'member',
    });
  });
});

describe('shapeDisplayName', () => {
  it('leaves an ordinary name alone', () => {
    expect(shapeDisplayName('Bob Smith', 'u-1')).toBe('Bob Smith');
  });

  it('strips what a rules block must not be handed, in all four categories', () => {
    expect(shapeDisplayName('Bob\nSmith', 'u-1')).toBe('BobSmith');
    expect(shapeDisplayName('Bob Smith', 'u-1')).toBe('BobSmith');
    expect(shapeDisplayName('Bob Smith', 'u-1')).toBe('BobSmith');
    expect(shapeDisplayName('Bob​Smith', 'u-1')).toBe('BobSmith');
    expect(shapeDisplayName('  Bob  ', 'u-1')).toBe('Bob');
  });

  it('bounds the length at the same eighty characters PrincipalShape does', () => {
    expect(shapeDisplayName('x'.repeat(200), 'u-1')).toHaveLength(80);
  });

  it('falls back when nothing survives, because a display name is never empty', () => {
    expect(shapeDisplayName('\n\n', 'u-1')).toBe('u-1');
    expect(shapeDisplayName('', 'u-1')).toBe('u-1');
  });
});

describe('principalFromDefault', () => {
  it('mints a stable id from the surface, the surface user id and its digest', () => {
    expect(principalFromDefault('memory', 'U0123ABCD', 'member')).toEqual({
      id: 'u-memory-u0123abcd-8742d695',
      kind: 'user',
      level: 'member',
      displayName: 'U0123ABCD',
      surfaces: { memory: 'U0123ABCD' },
      attributes: {},
    });
    expect(principalFromDefault('memory', 'U0123ABCD', 'member')).toEqual(
      principalFromDefault('memory', 'U0123ABCD', 'member'),
    );
  });

  it('replaces every character an id may not carry, and keeps the level it was given', () => {
    const minted = principalFromDefault('ms-teams', 'A.User@Example', 'lead');
    expect(minted?.id).toBe('u-ms-teams-a-user-example-0e7aed07');
    expect(minted?.level).toBe('lead');
    expect(PRINCIPAL_ID_PATTERN.test(minted?.id ?? '')).toBe(true);
  });

  it('gives user ids that slug alike different principals, and each of them the same one twice', () => {
    // The whole point of the digest. These three slug to `bob-smith-example-com`, and without it
    // the second and third callers would be handed the first one's principal — their memory,
    // their audit trail, their approvals.
    const ids = ['Bob.Smith@example.com', 'bob-smith-example-com', 'BOB_SMITH_EXAMPLE_COM'];
    const minted = ids.map((userId) => principalFromDefault('memory', userId, 'member'));
    expect(minted.map((p) => p?.id)).toEqual([
      'u-memory-bob-smith-example-com-164ad630',
      'u-memory-bob-smith-example-com-117a667c',
      'u-memory-bob-smith-example-com-ad154fd2',
    ]);
    expect(new Set(minted.map((p) => p?.id)).size).toBe(3);
    for (const [i, userId] of ids.entries()) {
      expect(principalFromDefault('memory', userId, 'member')).toEqual(minted[i]);
      expect(minted[i]?.displayName).toBe(userId);
      expect(minted[i]?.surfaces).toEqual({ memory: userId });
      expect(PRINCIPAL_ID_PATTERN.test(minted[i]?.id ?? '')).toBe(true);
    }
  });

  it('is an id even when nothing of the user id survives the slug', () => {
    expect(principalFromDefault('memory', '@@@', 'member')?.id).toBe('u-memory-2ec847d8');
  });

  it('takes a display name when a directory supplied one, and shapes it', () => {
    const minted = principalFromDefault('memory', 'U9', 'member', 'Bob\nSmith');
    expect(minted?.displayName).toBe('BobSmith');
    // The id does not move: it is derived from the surface user id, never from the name.
    expect(minted?.id).toBe('u-memory-u9-c5f6f2a2');
  });

  it('answers null rather than an id no principal could have', () => {
    expect(principalFromDefault('memory', '', 'member')).toBeNull();
    expect(principalFromDefault('Memory', 'U1', 'member')).toBeNull();
  });
});

describe('principalFromDerivedId', () => {
  const defaults = { memory: 'member' } as const;

  it('reads a minted id back at its surface default, for a process that never minted it', () => {
    const minted = principalFromDefault('memory', 'U0123ABCD', 'member');
    expect(principalFromDerivedId(minted?.id ?? '', defaults)).toEqual({
      id: 'u-memory-u0123abcd-8742d695',
      kind: 'user',
      level: 'member',
      // The raw surface user id is not recoverable from a one-way digest, and nothing needs it.
      displayName: 'u0123abcd',
      surfaces: {},
      attributes: {},
    });
  });

  it('reads the level the document gives that surface now, not the one it gave when the id was minted', () => {
    expect(principalFromDerivedId('u-memory-u0123abcd-8742d695', { memory: 'lead' })?.level).toBe('lead');
  });

  it('takes the longest surface that matches, so one default is not read as another', () => {
    const minted = principalFromDefault('ms-teams', 'A.User@Example', 'lead');
    expect(minted?.id).toBe('u-ms-teams-a-user-example-0e7aed07');
    const both = { ms: 'member', 'ms-teams': 'lead' } as const;
    expect(principalFromDerivedId(minted?.id ?? '', both)).toMatchObject({
      level: 'lead',
      displayName: 'a-user-example',
    });
  });

  it('names an id whose user id sanitised away by the id itself', () => {
    expect(principalFromDerivedId('u-memory-2ec847d8', defaults)?.displayName).toBe('u-memory-2ec847d8');
  });

  it('answers null for a surface with no default, for a declared-looking id, and for no defaults', () => {
    expect(principalFromDerivedId('u-slack-u9-c5f6f2a2', defaults)).toBeNull();
    expect(principalFromDerivedId('u-memory-u0123abcd-8742d695', {})).toBeNull();
    expect(principalFromDerivedId('u-coordinator', defaults)).toBeNull();
    expect(principalFromDerivedId('u-memory-coordinator', defaults)).toBeNull();
    expect(principalFromDerivedId('svc-memory-u9-c5f6f2a2', defaults)).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/identity-api exec vitest run src/principals.test.ts`
Expected: FAIL — `UNDEFAULTABLE_SURFACE`, `parseIdentityFileWithDefaults`, `shapeDisplayName`, `principalFromDefault` and `principalFromDerivedId` are not exported.

- [ ] **Step 3: Write the defaults, the shape helper and the two derivations**

In `harness/identity-api/src/principals.ts`, change the first three lines to:

```ts
import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import { ConfigError, LEVELS, SURFACE_NAME_PATTERN, USER_LEVELS } from '@harness/shared';
import type { Principal } from './types.js';

/** The four levels a person may hold. A `service` level belongs to a declared service, never to a default. */
export type UserLevel = (typeof USER_LEVELS)[number];
```

Add, immediately after `PrincipalShape`:

```ts
/**
 * `defaults:` in the client document's identity section: the level a surface gives someone the
 * document does not declare. A surface with no entry here refuses an unknown user, which is the
 * right default for a deployment whose members are all named.
 *
 * User levels only. `service` is the level of a scheduled job's own identity, and a default is by
 * definition what a person who walked in gets, so the two can never be the same thing.
 *
 * A surface this deployment does not load is not an error here and does nothing: the startup line
 * names the surfaces that have a default, which is where a typo shows up.
 */
export const IdentityDefaultsShape = z.record(
  z.string().regex(SURFACE_NAME_PATTERN),
  z.enum(USER_LEVELS, { error: 'a surface default is a user level: member, practitioner, lead or admin' }),
);
```

Replace `IdentityFileShape` with:

```ts
export const IdentityFileShape = z.object({
  defaults: IdentityDefaultsShape.default({}),
  principals: z.array(PrincipalShape).min(1),
});
```

Then replace the whole of `parseIdentityFile` and everything after it with:

```ts
/**
 * The one surface a default may never name.
 *
 * The run API authenticates with a single shared bearer token and takes the surface user id
 * straight from the request body, so a default there would let one token holder open runs as any
 * number of principals of their own choosing, each writing its own memory and audit rows. Every
 * principal that may drive the API is declared, by name, in the document.
 */
export const UNDEFAULTABLE_SURFACE = 'http';

/** The digest appended to a derived id, in hex characters. */
const DIGEST_LENGTH = 8;

/** What follows `u-<surface>-` in a derived id: an optional slug, then the digest. */
const DERIVED_TAIL = /^(?:(.+)-)?([0-9a-f]{8})$/;

/** The longest a display name may be, and the characters it may not carry. Both from `PrincipalShape`. */
const DISPLAY_NAME_MAX = 80;
const DISPLAY_NAME_FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/** A parsed identity section: who is declared, and what each surface gives everyone else. */
export interface IdentityFile {
  principals: Principal[];
  defaults: Record<string, UserLevel>;
}

/**
 * A name from outside, made safe to render.
 *
 * `PrincipalShape.displayName` *refuses* a name with a line break, because the document is an
 * operator's file and a refusal there is a typo they can fix. A name that arrives from a
 * directory is not theirs to fix and refusing it would lock a real person out of their own
 * deployment, so this strips instead: the four Unicode categories a rules block must not be
 * handed, then a trim, then the same eighty characters. `fallback` is what a name that was
 * nothing but those characters becomes, because a display name is never empty.
 */
export function shapeDisplayName(raw: string, fallback: string): string {
  const cleaned = raw.replaceAll(DISPLAY_NAME_FORBIDDEN, '').trim().slice(0, DISPLAY_NAME_MAX);
  return cleaned === '' ? fallback : cleaned;
}

/** The principals alone, for the callers that never wanted anything else. */
export function parseIdentityFile(raw: unknown): Principal[] {
  return parseIdentityFileWithDefaults(raw).principals;
}

/**
 * Read a parsed identity section, then apply the four rules zod cannot say: ids are unique, a
 * user has a `u-` id and a user level, a service has a `svc-` id and the `service` level, and no
 * surface user id is claimed twice — `resolve()` has to answer with one principal or none, never
 * a guess. The `defaults` table comes back beside the principals, for the plug-in that reads it,
 * and may not name `UNDEFAULTABLE_SURFACE`.
 */
export function parseIdentityFileWithDefaults(raw: unknown): IdentityFile {
  const parsed = IdentityFileShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`identity file is invalid: ${z.prettifyError(parsed.error)}`);
  if (parsed.data.defaults[UNDEFAULTABLE_SURFACE] !== undefined) {
    throw new ConfigError(
      `identity file: "${UNDEFAULTABLE_SURFACE}" may not have a default; the run API's bearer is one shared secret, so every ${UNDEFAULTABLE_SURFACE} user must be declared`,
    );
  }
  const seen = new Set<string>();
  const claims = new Map<string, string>();
  for (const p of parsed.data.principals) {
    if (seen.has(p.id)) throw new ConfigError(`identity file: "${p.id}" is declared twice`);
    seen.add(p.id);
    if (p.kind === 'user') {
      if (!p.id.startsWith('u-')) throw new ConfigError(`identity file: "${p.id}" is a user and must have a "u-" id`);
      if (p.level === 'service') {
        throw new ConfigError(`identity file: "${p.id}" is a user and cannot be at level "service"`);
      }
    } else {
      if (!p.id.startsWith('svc-')) {
        throw new ConfigError(`identity file: "${p.id}" is a service and must have a "svc-" id`);
      }
      if (p.level !== 'service') {
        throw new ConfigError(`identity file: "${p.id}" is a service and must be at level "service"`);
      }
    }
    for (const [surface, userId] of Object.entries(p.surfaces)) {
      const key = `${surface}:${userId}`;
      const already = claims.get(key);
      if (already !== undefined) {
        throw new ConfigError(
          `identity file: "${already}" and "${p.id}" both claim user "${userId}" on surface "${surface}"`,
        );
      }
      claims.set(key, p.id);
    }
  }
  return { principals: parsed.data.principals, defaults: parsed.data.defaults };
}

/**
 * The principal a surface's `defaults` level gives someone the document does not declare.
 *
 * The id is derived, never random, so the same person is the same principal across restarts and
 * across processes: every audit row, approval and run they leave behind is theirs tomorrow too.
 * It is `u-<surface>-<slug>-<digest>`: the surface user id lowercased, with everything an id may
 * not carry replaced by a hyphen, then the first eight hex characters of its SHA-256.
 *
 * **The digest is what makes the derivation injective, and it is not decoration.** Lowercasing and
 * replacing punctuation maps many user ids onto one slug — `Bob.Smith@example.com`,
 * `bob-smith-example-com` and `BOB_SMITH_EXAMPLE_COM` all slug alike — and two people sharing one
 * principal id share per-person memory, an audit trail and an approval history. The digest is over
 * the raw user id, so ids that slug alike land on different principals and the same user id always
 * lands on the same one.
 *
 * `displayName` is what a directory-backed plug-in knows the person as; with none, the surface
 * user id stands in. Either way it goes through `shapeDisplayName`, because it is rendered into
 * the rules block the runtime puts under the persona.
 *
 * Null when no id can be derived — an empty user id, or a surface name that is not one — because a
 * caller that cannot be named is a caller that runs nothing.
 */
export function principalFromDefault(
  surface: string,
  userId: string,
  level: UserLevel,
  displayName?: string,
): Principal | null {
  if (!SURFACE_NAME_PATTERN.test(surface)) return null;
  if (userId === '') return null;
  const slug = userId
    .toLowerCase()
    .replaceAll(/[^a-z0-9-]/g, '-')
    .replaceAll(/-+/g, '-')
    .replaceAll(/^-|-$/g, '');
  const digest = createHash('sha256').update(userId, 'utf8').digest('hex').slice(0, DIGEST_LENGTH);
  const id = slug === '' ? `u-${surface}-${digest}` : `u-${surface}-${slug}-${digest}`;
  // Belt and braces: the two rules above already produce an id of this shape.
  if (!PRINCIPAL_ID_PATTERN.test(id)) return null;
  return {
    id,
    kind: 'user',
    level,
    displayName: shapeDisplayName(displayName ?? userId, id),
    surfaces: { [surface]: userId },
    attributes: {},
  };
}

/**
 * The principal a derived id names, for a process that never minted it.
 *
 * The plug-in's own map of minted principals is process-local, so after a restart nothing
 * remembers the people a default admitted — and an approval raised before the restart names its
 * requester by id. This reads the id back: `u-<surface>-<slug>-<digest>`, where `<surface>` is one
 * the document gives a default, is that surface's default level. Null for anything else, including
 * a derived id on a surface whose default has since been removed: the document is the authority,
 * and a level nobody grants any more is not a level.
 *
 * `surfaces` comes back empty, and that is not an oversight. The digest is one-way and the slug
 * has already lost case and punctuation, so the raw surface user id is not recoverable from the
 * id; a guess would be a claim that this principal speaks as someone. Nothing needs it: a
 * resumed turn is delivered to the thread's own conversation, not looked up from the person, and
 * `resolve` — the only path that starts from a surface user id — mints the full principal itself.
 *
 * Surfaces are tried longest first, so a document that defaults both `chat` and `chat-web` reads
 * `u-chat-web-a-user-0e7aed07` as the second surface's, not as the first's with a slug that
 * happens to start `web-`.
 */
export function principalFromDerivedId(id: string, defaults: Readonly<Record<string, UserLevel>>): Principal | null {
  for (const surface of Object.keys(defaults).sort((a, b) => b.length - a.length)) {
    const prefix = `u-${surface}-`;
    if (!id.startsWith(prefix)) continue;
    const match = DERIVED_TAIL.exec(id.slice(prefix.length));
    if (!match) continue;
    const level = defaults[surface];
    if (level === undefined) continue;
    // A user id that sanitised away entirely leaves the digest alone; there is no slug to show,
    // so the id is the most honest display name available.
    return { id, kind: 'user', level, displayName: match[1] ?? id, surfaces: {}, attributes: {} };
  }
  return null;
}
```

- [ ] **Step 4: Widen the package's exports and its deps type**

In `harness/identity-api/src/index.ts`, replace the `./principals.js` export line with:

```ts
export {
  IdentityDefaultsShape,
  IdentityFileShape,
  PRINCIPAL_ID_PATTERN,
  PrincipalShape,
  UNDEFAULTABLE_SURFACE,
  parseIdentityFile,
  parseIdentityFileWithDefaults,
  principalFromDefault,
  principalFromDerivedId,
  shapeDisplayName,
  type IdentityFile,
  type UserLevel,
} from './principals.js';
```

In `harness/identity-api/src/types.ts`, replace the `IdentityDeps` declaration and its comment with:

```ts
/**
 * What a plug-in is handed when it connects.
 *
 * `env` is the only environment it may read — never the ambient one — for the same reason a pack
 * reads `deps.env`. `identity` is this client's own section of the client document, already
 * validated: the declared principals and the level each surface gives everyone else. **A plug-in
 * is never handed a path**, because a client is not a folder any more, and never handed the whole
 * document, because who is asking is the only part of it that is a plug-in's business.
 * `settings` is whatever the document's `identityProvider.settings` held, which the plug-in
 * validates with its own schema.
 */
export interface IdentityDeps {
  env: EnvSource;
  log: Logger;
  identity: IdentityFile;
  settings: Readonly<Record<string, unknown>>;
}
```

and add `import type { IdentityFile } from './principals.js';` — **no**: `types.ts` must stay a leaf that the other modules re-export from, so instead move the `IdentityFile` interface itself into `types.ts`, above `IdentityDeps`, and have `principals.ts` import it from there:

```ts
/** A parsed identity section: who is declared, and what each surface gives everyone else. */
export interface IdentityFile {
  principals: Principal[];
  defaults: Record<string, UserLevel>;
}
```

with `import type { EnvSource, Level, Logger } from '@harness/shared';` widened to also import `USER_LEVELS`'s element type:

```ts
import type { EnvSource, Level, Logger } from '@harness/shared';

/** The four levels a person may hold. A `service` level belongs to a declared service, never to a default. */
export type UserLevel = Exclude<Level, 'service'>;
```

In `principals.ts`, delete its own `UserLevel` and `IdentityFile` declarations and import both from `./types.js` instead, re-exporting them:

```ts
import type { IdentityFile, Principal, UserLevel } from './types.js';
export type { IdentityFile, UserLevel };
```

- [ ] **Step 5: Run the principals test to verify it passes**

Run: `pnpm --filter @harness/identity-api test`
Expected: PASS.

- [ ] **Step 6: Write the failing plug-in test**

Replace the whole of `identities/static/src/index.test.ts` with:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseIdentityFileWithDefaults, type IdentityFile } from '@harness/identity-api';
import { identity } from './index.js';

const log = { info() {}, warn() {}, error() {} };

const PRINCIPALS = [
  { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U0456EFGH' } },
  { id: 'svc-local', kind: 'service', level: 'service', displayName: 'Local operator' },
];

function file(extra: Record<string, unknown> = {}): IdentityFile {
  return parseIdentityFileWithDefaults({ principals: PRINCIPALS, ...extra });
}

const connect = (identityFile: IdentityFile, logger = log) =>
  identity.connect({ env: {}, log: logger, identity: identityFile, settings: {} });

describe('the static identity plug-in', () => {
  it('declares itself the way every plug-in does, and reads no environment variable', () => {
    expect(identity.name).toBe('static');
    expect(identity.secrets).toEqual([]);
  });

  it('answers for the principals the document declares', async () => {
    const session = await connect(file());
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    expect(await session.get('svc-local')).toMatchObject({ kind: 'service' });
    expect(await session.get('u-nobody')).toBeNull();
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('gives an undeclared user the level its surface defaults to, under an id derived from theirs', async () => {
    const session = await connect(file({ defaults: { memory: 'member' } }));
    const minted = await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' });
    expect(minted).toEqual({
      id: 'u-memory-u0c0keb8w3x-6774a381',
      kind: 'user',
      level: 'member',
      displayName: 'U0C0KEB8W3X',
      surfaces: { memory: 'U0C0KEB8W3X' },
      attributes: {},
    });
    // The same person is the same principal on the next turn, and on the next process.
    expect(await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' })).toEqual(minted);
    expect(await session.get('u-memory-u0c0keb8w3x-6774a381')).toEqual(minted);
  });

  it('leaves a declared principal alone, and names only the newly minted ones in the log', async () => {
    const lines: string[] = [];
    const session = await connect(file({ defaults: { memory: 'member' } }), {
      ...log,
      info: (message: string) => lines.push(message),
    });
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    await session.resolve({ surface: 'memory', userId: 'U9' });
    await session.resolve({ surface: 'memory', userId: 'U9' });
    expect(lines.filter((line) => line.includes('u-memory-u9-c5f6f2a2'))).toHaveLength(1);
    // `list()` stays the document's own answer: what was declared, in the order it was declared.
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('still refuses an undeclared user when the document names no default at all', async () => {
    const session = await connect(file());
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
  });

  it('still refuses an undeclared user on a surface the defaults leave out', async () => {
    const session = await connect(file({ defaults: { memory: 'member' } }));
    expect(await session.resolve({ surface: 'http', userId: 'nobody' })).toBeNull();
  });

  it('answers for a principal a previous process minted, which is where an approval outlives a restart', async () => {
    const first = await connect(file({ defaults: { memory: 'member' } }));
    const minted = await first.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' });
    await first.stop();

    // A second session over the same document, having minted nothing: the approval raised before
    // the restart names its requester by id, and that id has to resolve to the same person.
    const second = await connect(file({ defaults: { memory: 'member' } }));
    const recovered = await second.get(minted?.id ?? '');
    expect(recovered?.id).toBe(minted?.id);
    expect(recovered?.level).toBe('member');
    expect(recovered?.kind).toBe('user');
    // An id of the same shape on a surface the document gives no default is still nobody.
    expect(await second.get('u-http-someone-deadbeef')).toBeNull();
    expect(await second.get('u-memory-nobody')).toBeNull();
  });

  it('refuses a caller whose derived id is already declared, and says so once', async () => {
    // `U9` on `memory` derives `u-memory-u9-c5f6f2a2`. Declaring that id outright would otherwise
    // hand whoever holds it the declared principal's memory, approvals and audit trail.
    const warnings: string[] = [];
    const collides = file({
      defaults: { memory: 'member' },
      principals: [
        ...PRINCIPALS,
        { id: 'u-memory-u9-c5f6f2a2', kind: 'user', level: 'admin', displayName: 'Someone else' },
      ],
    });
    const session = await connect(collides, { ...log, warn: (message: string) => warnings.push(message) });

    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(warnings).toEqual([
      'static identity: derived id "u-memory-u9-c5f6f2a2" is already declared; refusing the caller',
    ]);
    // The declared principal is untouched, and everyone else on the surface still gets a default.
    expect((await session.get('u-memory-u9-c5f6f2a2'))?.level).toBe('admin');
    expect((await session.resolve({ surface: 'memory', userId: 'U8' }))?.level).toBe('member');
  });

  it('refuses a document that defaults the run API surface, whatever level it names', () => {
    expect(() => file({ defaults: { http: 'member' } })).toThrow(ConfigError);
    expect(() => file({ defaults: { http: 'member' } })).toThrow(/"http" may not have a default/);
  });

  it('refuses a document that defaults a surface to the service level', () => {
    expect(() => file({ defaults: { memory: 'service' } })).toThrow(ConfigError);
  });
});
```

- [ ] **Step 7: Run it to verify it fails**

Run: `pnpm --filter @harness/identity-static exec vitest run src/index.test.ts`
Expected: FAIL — `identity.connect` still wants `clientDir`.

- [ ] **Step 8: Rewrite the plug-in to read its section rather than a file**

Replace the whole of `identities/static/src/index.ts` with:

```ts
import {
  defineIdentityProvider,
  principalFromDefault,
  principalFromDerivedId,
  type IdentityProvider,
  type IdentitySession,
  type Principal,
  type UserLevel,
} from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import type { Logger } from '@harness/shared';

/**
 * The declared principals, plus the `defaults` rule for everyone else.
 *
 * A surface named in `defaults` admits someone the document never mentions, at the level the
 * document chose, under an id derived from theirs — `principalFromDefault` derives it, so the
 * same person is the same principal tomorrow and in the next process. A surface with no default
 * refuses an unknown user exactly as this plug-in always has: null is "not authorised", never a
 * guest.
 *
 * `list()` stays the document's own answer, because that is the question preflight and the
 * scaffolder's check are asking: who does this client declare. `get()` does answer for a minted
 * principal, because an approval or an audit row that carries its id has to resolve — including
 * one minted before this process started, which is what `principalFromDerivedId` is for: the map
 * below is lost on every restart, and an approval outlives one.
 */
class IdentityWithDefaults implements IdentitySession {
  readonly name: string;

  private readonly declared: StaticIdentity;
  private readonly defaults: Readonly<Record<string, UserLevel>>;
  private readonly log: Logger;
  /** Minted principals, keyed by their own id, so each one is logged and derived once. */
  private readonly minted = new Map<string, Principal>();
  /** Derived ids a declared principal already holds: refused once with a warning, then silently. */
  private readonly refused = new Set<string>();

  constructor(declared: StaticIdentity, defaults: Readonly<Record<string, UserLevel>>, log: Logger) {
    this.declared = declared;
    this.defaults = defaults;
    this.log = log;
    this.name = declared.name;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    const declared = await this.declared.resolve(ref);
    if (declared) return declared;
    const level = this.defaults[ref.surface];
    if (level === undefined) return null;
    const minted = principalFromDefault(ref.surface, ref.userId, level);
    if (!minted) return null;
    const already = this.minted.get(minted.id);
    if (already) return already;
    if (this.refused.has(minted.id)) return null;
    // A derived id that a declared principal already holds would hand one person another's
    // history, so this caller is refused rather than admitted. It stays a refusal here rather
    // than a load-time error because nothing at load knows which ids will be derived: a check
    // over the declared ids could only guess from their shape, and would refuse a document whose
    // author happened to end an id in eight hex characters. The warning is written once per
    // colliding id, not once per message, so a person who keeps typing does not fill the log.
    if (await this.declared.get(minted.id)) {
      this.refused.add(minted.id);
      this.log.warn(`static identity: derived id "${minted.id}" is already declared; refusing the caller`);
      return null;
    }
    this.minted.set(minted.id, minted);
    this.log.info(`static identity: "${minted.id}" is not declared on ${ref.surface}; acting at level ${level}`);
    return minted;
  }

  async get(principalId: string): Promise<Principal | null> {
    return (
      (await this.declared.get(principalId)) ??
      this.minted.get(principalId) ??
      principalFromDerivedId(principalId, this.defaults)
    );
  }

  async list(): Promise<Principal[]> {
    return this.declared.list();
  }

  async stop(): Promise<void> {
    await this.declared.stop();
  }
}

/**
 * Principals from the client document's identity section.
 *
 * It reads no file and no environment variable: the host resolved the document through its
 * `ConfigSource` and handed this plug-in the one section that is its business. That is why a
 * client can live in a directory outside this repository, or in a table, without this plug-in
 * knowing either.
 */
export const identity: IdentityProvider = defineIdentityProvider({
  name: 'static',
  version: '0.2.0',
  secrets: [],
  connect: async (deps) => {
    const { principals, defaults } = deps.identity;
    const surfaces = Object.keys(defaults);
    deps.log.info(
      `static identity: ${principals.length} principals` +
        (surfaces.length > 0 ? `, and a default level on ${surfaces.join(', ')}` : ''),
    );
    return new IdentityWithDefaults(new StaticIdentity(principals, 'static'), defaults, deps.log);
  },
});
```

In `identities/static/package.json`, remove `"yaml": "^2.9.1"` from `dependencies`: the plug-in parses nothing now. Run `pnpm install`.

- [ ] **Step 9: Run the plug-in test to verify it passes**

Run: `pnpm --filter @harness/identity-static test`
Expected: PASS, twelve cases.

- [ ] **Step 10: Update the three call sites and the loader's test**

In `harness/config-api/src/document.ts`, change the import and the one call so the document's identity section is validated with its defaults:

```ts
import { IdentityFileShape, parseIdentityFileWithDefaults } from '@harness/identity-api';
```

and inside `parseClientDocument`, `parseIdentityFile(document.identity);` becomes `parseIdentityFileWithDefaults(document.identity);`.

`IdentityFileShape` now carries `defaults`, so the document's `identity` section does too. Add the assertion for it to `harness/config-api/src/document.test.ts`'s first case, beside the `principals` one Task 1 wrote — this is the task where `defaults` starts existing, and where the assertion can compile:

```ts
    // `defaults` arrives with this task: an absent `defaults:` is the empty table, which means
    // nobody the file does not declare gets a level, which is what today's behaviour is.
    expect(document.identity.defaults).toEqual({});
```

and one case after it, which is what proves the document validates a section the fixture does not exercise:

```ts
  it('carries the identity defaults through, and refuses a level for the surface that cannot have one', () => {
    const principals = [
      { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' } },
      { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
    ];
    const withDefaults = parseClientDocument(fixtureDocument({ identity: { principals, defaults: { memory: 'member' } } }));
    expect(withDefaults.identity.defaults).toEqual({ memory: 'member' });
    // `http` is the run API: a caller there is a bearer token, not a person, so there is nobody
    // for a default level to be about.
    expect(() => parseClientDocument(fixtureDocument({ identity: { principals, defaults: { http: 'member' } } }))).toThrow(
      ConfigError,
    );
  });
```

Run `pnpm --filter @harness/config-api exec vitest run src/document.test.ts` and expect PASS.

In `harness/core-tools/src/domain/identity/registry.test.ts`, replace every `clientDir: …` in a `loadIdentity` call with the new two members, building the section inline:

```ts
import { parseIdentityFileWithDefaults } from '@harness/identity-api';

const section = parseIdentityFileWithDefaults({
  principals: [{ id: 'svc-local', kind: 'service', level: 'service', displayName: 'Local operator' }],
});
const deps = { env: {}, log, identity: section, settings: {} };
```

and use `deps` (or a spread of it) at every `loadIdentity(...)` call in that file. The `clientDir()` helper and its tmpdir writes go; the three failure cases (unresolvable specifier, a module exporting no `identity`, a plug-in whose `connect` throws) keep their assertions and lose only the directory they were handed.

In `harness/core-tools/src/app/server.ts`, replace the body of `resolvePrincipal` so it reads the section in `app/` and hands it over. Add the three imports at the top (`readFile` from `node:fs/promises`, `path` from `node:path`, `parse as parseYaml` from `yaml`, `parseIdentityFileWithDefaults` from `@harness/identity-api`) and make the function:

```ts
export async function resolvePrincipal(config: Pick<KernelConfig, 'client' | 'env'>): Promise<Principal> {
  const specifier = envOrDefault('HARNESS_IDENTITY', '@harness/identity-static');
  // Task 4 replaces this read with the resolved client document's `identity` section; the stdio
  // server has no ConfigSource until then, and a plug-in is never handed a path.
  const file = path.join(clientDirFor(config.client), 'identity.yaml');
  const section = parseIdentityFileWithDefaults(parseYaml(await readFile(file, 'utf8')));
  const session = await loadIdentity(specifier, { env: config.env, log, identity: section, settings: {} });
  try {
    const id = envOrDefault('HARNESS_PRINCIPAL', 'svc-local');
    const principal = await session.get(id);
    if (!principal) {
      throw new ConfigError(
        `HARNESS_PRINCIPAL names "${id}", which the identity plug-in "${session.name}" does not declare`,
      );
    }
    return principal;
  } finally {
    await session.stop();
  }
}
```

In `harness/core-tools/package.json` add `"yaml": "^2.9.1"` if it is not already there (it is — `domain/tooling/policy.ts` uses it — so check and leave it).

In `harness/host/src/app/main.ts`, replace the `loadIdentity(...)` call with the same shape, marked for Task 6:

```ts
// Task 6 replaces this read with the resolved client document's `identity` section, loaded
// through the ConfigSource; a plug-in is never handed a path.
const identitySection = parseIdentityFileWithDefaults(
  parseYaml(await readFile(path.join(clientDir, 'identity.yaml'), 'utf8')),
);
const identity = await loadIdentity(envOrDefault('HARNESS_IDENTITY', '@harness/identity-static'), {
  env: process.env,
  log,
  identity: identitySection,
  settings: {},
});
```

adding `readFile` to the existing `node:fs/promises` import, `parse as parseYaml` from `yaml`, and `parseIdentityFileWithDefaults` from `@harness/identity-api` to the imports.

- [ ] **Step 11: Delete `HARNESS_IDENTITY_FILE` from `.env.example`**

Remove this block from `.env.example` entirely — the four comment lines and the variable:

```
# Optional: where the static identity plug-in reads the principals from. Unset,
# it reads clients/<HARNESS_CLIENT>/identity.yaml. Set it only to point a
# bare-metal run at a file outside the client folder.
#HARNESS_IDENTITY_FILE=
```

and in the block above it, replace "The static plug-in reads identity.yaml; a directory-backed one comes with the client that needs it." with "The static plug-in answers for the principals the client document declares, and gives everyone else the level `identity.defaults` names for their surface; a directory-backed one resolves group membership instead."

`HARNESS_IDENTITY_FILE` appears nowhere else — not in `.env.ci`, not in `docker-compose.yml`. Confirm with `grep -rn HARNESS_IDENTITY_FILE . --exclude-dir=node_modules --exclude-dir=.git`, which must print nothing.

- [ ] **Step 12: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 13: Commit**

```bash
git add harness/identity-api identities/static harness/config-api/src/document.ts \
  harness/core-tools/src/app/server.ts harness/core-tools/src/domain/identity/registry.test.ts \
  harness/host/src/app/main.ts .env.example pnpm-lock.yaml
git commit -m "feat(identity): give a surface a default level and derive a stable principal from a user id"
```

---

### Task 3: Migration 0014, `@harness/config-files`, `@harness/config-postgres` and the source registry

**Files:**
- Modify: `harness/db/src/domain/schema.ts`, `harness/db/src/testing.ts`
- Create: `harness/db/drizzle/0014_tenancy_and_config.sql`, `harness/db/drizzle/meta/0014_snapshot.json` (generated); `harness/db/drizzle/meta/_journal.json` (updated by the generator)
- Create: `harness/db/src/domain/migration-0014.test.ts`
- Create: `harness/config-files/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/include.ts`, `src/source.ts`, `src/index.ts`, `src/include.test.ts`, `src/source.test.ts`
- Create: `harness/config-postgres/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `test-global-setup.ts`, `src/source.ts`, `src/index.ts`, `src/source.test.ts`
- Create: `harness/core-tools/src/domain/config/registry.ts` + `registry.test.ts`
- Modify: `harness/core-tools/src/index.ts`, `harness/core-tools/package.json`
- Modify: `.dependency-cruiser.cjs`, `pnpm-workspace.yaml`, `.env.example`

**Interfaces:**
- Consumes: `ConfigSource`, `LoadedDocument`, `ClientDocument`, `migrate`, `resolve`, `parseClientDocument`, `Blueprint`, `Overlay` (`@harness/config-api`); `configSourceConformance`, `fixtureDocument` (`@harness/config-api/testing`); `Db`, `createDb` (`@harness/db`); `ConfigError`, `describeError`, `type Logger` (`@harness/shared`). **Not `assertInsideRoot`:** `include.ts` does its own resolved-prefix check, whose error message is the one `include.test.ts` asserts on.
- Produces:
  - `@harness/config-files`: `filesConfigSource(opts: { root: string; log: Logger; watchDebounceMs?: number }): ConfigSource`; `WATCH_DEBOUNCE_MS = 200`; `parseWithIncludes(file: string): Promise<unknown>`; `INCLUDE_TAG = 'include'`.
  - `@harness/config-postgres`: `postgresConfigSource(opts: { db: Db; log: Logger; pollMs?: number }): ConfigSource`; `writeClientDocument(db, document, version, createdBy): Promise<void>`; `CONFIG_POLL_MS = 30_000`.
  - `@harness/core-tools`: `loadConfigSource(name: string, deps: ConfigSourceDeps): Promise<ConfigSource>` where `ConfigSourceDeps = { env: EnvSource; log: Logger; db: Db }`; `configSourceNameFrom(env): string`.
  - `@harness/db`: `clientDocuments`, `clientDocumentVersions`, `usageRuns`; `runs.inputTokens/outputTokens/costUsd`; `client` on `attachments`, `fields`, `deadlines`, `messages`, `playbookRuns`.

- [ ] **Step 1: Empty the five tables that are about to gain a NOT NULL column**

`drizzle-kit generate` writes `ALTER TABLE "messages" ADD COLUMN "client" text NOT NULL;`, which Postgres refuses on a table that already has rows, and giving the column a default would file every existing row under one tenant (decision 9). Run, from the repository root, against each database this worktree migrates:

```bash
cd harness/db && node --input-type=module -e "
import pg from 'pg';
const urls = [
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15433/harness_test',
  process.env.EVALS_DATABASE_URL ?? 'postgres://harness:harness@localhost:15433/harness_evals',
];
for (const connectionString of urls) {
  const c = new pg.Client({ connectionString });
  try { await c.connect(); } catch { console.log('skipped (not reachable):', connectionString); continue; }
  await c.query('TRUNCATE TABLE playbook_runs, messages, deadlines, fields, attachments CASCADE');
  console.log('emptied:', connectionString);
  await c.end();
}
"
```

Expected: `emptied:` for each reachable URL. A database that is not reachable is skipped and says so; do not start one.

- [ ] **Step 2: Write the failing schema test**

Append to `harness/db/src/domain/schema.test.ts`, inside `describe('schema', …)`:

```ts
  it('scopes every row of the five tables that used to be reachable only through a foreign key', async () => {
    const [record] = await db
      .insert(records)
      .values({ client: 'alpha', pack: 'p', kind: 'k', externalId: 'r1', status: 'active' })
      .returning();
    await db.insert(fields).values({ client: 'alpha', recordId: record.id, name: 'n', value: 'v' });
    const [attachment] = await db
      .insert(attachments)
      .values({ client: 'alpha', recordId: record.id, kind: 'licence' })
      .returning();
    await db
      .insert(deadlines)
      .values({ client: 'alpha', recordId: record.id, attachmentId: attachment.id, kind: 'renewal', dueAt: '2026-10-01' });
    expect(await db.$count(fields, eq(fields.client, 'alpha'))).toBe(1);
    expect(await db.$count(deadlines, eq(deadlines.client, 'alpha'))).toBe(1);
  });

  it('lets two clients mint the same idempotency key, which a global unique index forbade', async () => {
    const common = {
      action: 'forms_release',
      payload: {},
      summary: 's',
      requestedBy: 'u-one',
      expiresAt: new Date('2026-10-01T00:00:00Z'),
      idempotencyKey: 'the-same-key',
    };
    await db.insert(approvals).values([
      { ...common, client: 'alpha' },
      { ...common, client: 'beta' },
    ]);
    expect(await db.$count(approvals)).toBe(2);
    // And within one client it is still one live pending request per key.
    await expect(db.insert(approvals).values({ ...common, client: 'alpha' })).rejects.toThrow();
  });

  it("carries a run's totals, and no longer carries them on the audit row", async () => {
    const [run] = await db
      .insert(runs)
      .values({ client: 'alpha', principalId: 'u-one', inputTokens: 120, outputTokens: 34, costUsd: 0.002 })
      .returning();
    expect(run).toMatchObject({ inputTokens: 120, outputTokens: 34 });
    expect(Object.keys(auditLog)).not.toContain('inputTokens');
  });

  it('exports usage without a word of what anybody said', async () => {
    const columns = await db.execute(
      sql`select column_name from information_schema.columns where table_name = 'usage_runs' order by column_name`,
    );
    expect(columns.rows.map((r) => r.column_name)).toEqual([
      'approvals_decided',
      'approvals_requested',
      'client',
      'cost_usd',
      'day',
      'duration_seconds',
      'input_tokens',
      'output_tokens',
      'principal_id',
      'runs',
      'runs_cancelled',
      'runs_done',
      'runs_error',
      'runs_running',
      'sandbox_seconds',
    ]);
  });

  it('stores a client document and its versions', async () => {
    await db.insert(clientDocuments).values({
      clientId: 'alpha',
      schemaVersion: 1,
      document: { id: 'alpha' },
      version: 'v1',
    });
    await db
      .insert(clientDocumentVersions)
      .values({ clientId: 'alpha', version: 'v1', document: { id: 'alpha' }, createdBy: 'u-one' });
    expect(await db.$count(clientDocumentVersions, eq(clientDocumentVersions.clientId, 'alpha'))).toBe(1);
    // One row per client in the live table; the history is where the versions pile up.
    await expect(
      db.insert(clientDocuments).values({ clientId: 'alpha', schemaVersion: 1, document: {}, version: 'v2' }),
    ).rejects.toThrow();
  });
```

Widen that file's schema import to include `attachments, auditLog, clientDocumentVersions, clientDocuments, deadlines, fields, records, runs` and make sure `eq` and `sql` are imported from `drizzle-orm`.

- [ ] **Step 3: Run it to verify it fails**

Run: `pnpm --filter @harness/db exec vitest run src/domain/schema.test.ts`
Expected: FAIL — `clientDocuments` is not exported and `fields.client` does not exist.

- [ ] **Step 4: Edit `schema.ts`**

Add `pgView` to the `drizzle-orm/pg-core` import list.

In `attachments`, `fields` and `deadlines`, add as the second member of each object, right after `id`:

```ts
    /**
     * The tenant. Derivable through `record_id` and always equal to that record's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
```

In `messages`, add the same member after `seq`, with `thread_id` named instead of `record_id` in the comment; in `playbookRuns`, after `id`, with `playbook_id` named instead.

Replace the `approvals` index callback with:

```ts
  (t) => [
    // Partial: only one live pending request per idempotency key, **per client**. Decided and
    // expired rows stay as history and must not block a fresh request; and two tenants that mint
    // the same key are two requests, not one (spec section 6).
    uniqueIndex('approvals_client_idempotency_pending_uq')
      .on(t.client, t.idempotencyKey)
      .where(sql`status = 'pending'`),
  ],
```

and the `tool_effects` one with:

```ts
  (t) => [
    uniqueIndex('tool_effects_client_idempotency_uq').on(t.client, t.idempotencyKey),
    index('tool_effects_status_created_idx').on(t.status, t.createdAt),
  ],
```

In `runs`, add after `endedAt`:

```ts
  /**
   * What this run spent, summed from its own `model_calls` rows when the host closes it.
   *
   * `model_calls` keeps the per-route detail; these three are the run's totals, so the usage
   * export reads one row per run rather than re-aggregating every call. Zero until the run is
   * closed, and zero for ever on a run that made no model call.
   */
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
```

In `auditLog`, **delete** the three lines `inputTokens`, `outputTokens` and `costUsd`: no call site has ever filled them (spec §4.5, decision 2b).

Append at the end of the file:

```ts
/**
 * A client's resolved document, one row per client: what the host loads.
 *
 * `document` is a whole `ClientDocument` as jsonb, already resolved from its blueprint and
 * overlay by whoever wrote it and validated again on load — a store the platform writes to is
 * not a store the kernel trusts. `version` is what a host caches by and what `watch` reports;
 * `blueprint_ref` records which catalogue entry it came from, for an operator reading the table.
 */
export const clientDocuments = pgTable('client_documents', {
  clientId: text('client_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  document: jsonb('document').$type<Record<string, unknown>>().notNull(),
  version: text('version').notNull(),
  blueprintRef: text('blueprint_ref'),
  overlay: jsonb('overlay').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every version a client's document has had, so a change is reviewable and a rollback is a write. */
export const clientDocumentVersions = pgTable(
  'client_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    version: text('version').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('client_document_versions_client_version_uq').on(t.clientId, t.version)],
);

/**
 * What a tenant used, per principal per day (spec section 4.5, invariant 16).
 *
 * Counts, tokens, cost and seconds, and **not one word anybody wrote**: no message, no tool
 * argument, no document text, no conversation id. A full join, because a day can have approvals
 * with no run of its own (an approval decided the morning after it was raised) and runs with no
 * approval, and an export that dropped either would be an invoice that disagreed with the audit
 * log. `sandbox_seconds` is a literal zero until a sandbox provider exists (spec decision 14).
 */
export const usageRuns = pgView('usage_runs', {
  client: text('client').notNull(),
  principalId: text('principal_id').notNull(),
  day: timestamp('day', { withTimezone: true }).notNull(),
  runs: integer('runs').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  runsDone: integer('runs_done').notNull(),
  runsError: integer('runs_error').notNull(),
  runsCancelled: integer('runs_cancelled').notNull(),
  runsRunning: integer('runs_running').notNull(),
  approvalsRequested: integer('approvals_requested').notNull(),
  approvalsDecided: integer('approvals_decided').notNull(),
  sandboxSeconds: integer('sandbox_seconds').notNull(),
}).as(
  sql`with "run_totals" as (
      select "client", "principal_id", date_trunc('day', "started_at") as "day",
        count(*)::int as "runs",
        coalesce(sum("input_tokens"), 0)::int as "input_tokens",
        coalesce(sum("output_tokens"), 0)::int as "output_tokens",
        coalesce(sum("cost_usd"), 0)::real as "cost_usd",
        coalesce(sum(extract(epoch from (coalesce("ended_at", "started_at") - "started_at"))), 0)::int as "duration_seconds",
        count(*) filter (where "status" = 'done')::int as "runs_done",
        count(*) filter (where "status" = 'error')::int as "runs_error",
        count(*) filter (where "status" = 'cancelled')::int as "runs_cancelled",
        count(*) filter (where "status" = 'running')::int as "runs_running"
      from "runs" group by 1, 2, 3
    ), "approval_totals" as (
      select "client", "requested_by" as "principal_id", date_trunc('day', "created_at") as "day",
        count(*)::int as "approvals_requested",
        count(*) filter (where "decided_at" is not null)::int as "approvals_decided"
      from "approvals" group by 1, 2, 3
    )
    select
      coalesce(r."client", a."client") as "client",
      coalesce(r."principal_id", a."principal_id") as "principal_id",
      coalesce(r."day", a."day") as "day",
      coalesce(r."runs", 0) as "runs",
      coalesce(r."input_tokens", 0) as "input_tokens",
      coalesce(r."output_tokens", 0) as "output_tokens",
      coalesce(r."cost_usd", 0) as "cost_usd",
      coalesce(r."duration_seconds", 0) as "duration_seconds",
      coalesce(r."runs_done", 0) as "runs_done",
      coalesce(r."runs_error", 0) as "runs_error",
      coalesce(r."runs_cancelled", 0) as "runs_cancelled",
      coalesce(r."runs_running", 0) as "runs_running",
      coalesce(a."approvals_requested", 0) as "approvals_requested",
      coalesce(a."approvals_decided", 0) as "approvals_decided",
      0 as "sandbox_seconds"
    from "run_totals" r
    full join "approval_totals" a
      on a."client" = r."client" and a."principal_id" = r."principal_id" and a."day" = r."day"`,
);
```

- [ ] **Step 5: Generate the migration, twice**

Run, from `harness/db/`:

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit generate
```

Expected: the first names `0014_<adjective>_<noun>.sql`; **rename nothing** — the journal records whatever it chose, and this plan calls it `0014` for short. The second prints `No schema changes, nothing to migrate 😴`.

Then read the generated `.sql` and confirm, without editing it, that it contains: five `ADD COLUMN "client" text NOT NULL`; `DROP INDEX "approvals_idempotency_pending_uq"` and `DROP INDEX "tool_effects_idempotency_uq"` with the two new `CREATE UNIQUE INDEX` statements on `("client","idempotency_key")`; three `ALTER TABLE "runs" ADD COLUMN`; three `ALTER TABLE "audit_log" DROP COLUMN`; `CREATE TABLE "client_documents"` and `"client_document_versions"`; and one `CREATE VIEW "public"."usage_runs"`. If any is missing, the schema edit is incomplete — fix `schema.ts` and regenerate; never edit the `.sql`.

- [ ] **Step 6: Extend `resetDatabase`**

In `harness/db/src/testing.ts`, add the two new tables to the one `TRUNCATE`, at the front. The statement becomes, exactly — the surrounding `ALTER TABLE audit_log DISABLE TRIGGER USER` and its `finally` are untouched:

```ts
    await db.execute(sql`
      TRUNCATE TABLE client_document_versions, client_documents,
        audit_log, tool_effects, model_calls, playbook_runs, playbooks, memory_entries,
        knowledge_chunks, knowledge_documents, knowledge_sources, runs, messages,
        threads, approvals, deadlines, attachments, fields, documents, records CASCADE
    `);
```

Eighteen tables become twenty. **`usage_runs` is not added**: it is a view, and `TRUNCATE` on one is an error.

- [ ] **Step 7: Write the failing migration test**

Create `harness/db/src/domain/migration-0014.test.ts`, modelled on `migration-0013.test.ts` (read that file for the helper imports and the shape):

```ts
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';
import { runMigrations } from './migrate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const drizzleDir = path.resolve(here, '../../drizzle');

async function migrationFile(prefix: string): Promise<string> {
  const names = (await readdir(drizzleDir)).filter((name) => name.startsWith(prefix) && name.endsWith('.sql'));
  expect(names, `exactly one ${prefix} migration`).toHaveLength(1);
  return path.join(drizzleDir, names[0]);
}

describe('migration 0014', () => {
  it('adds the tenant column to the five tables that lacked one, and nowhere else', async () => {
    const statements = await migrationStatements(await migrationFile('0014'));
    const added = statements
      .filter((s) => /ADD COLUMN "client"/.test(s))
      .map((s) => /ALTER TABLE "([a-z_]+)"/.exec(s)?.[1])
      .sort();
    expect(added).toEqual(['attachments', 'deadlines', 'fields', 'messages', 'playbook_runs']);
    for (const statement of added) expect(statement).toBeTruthy();
    // NOT NULL with no default, deliberately: a default would file every existing row under one
    // tenant, which is the opposite of what this migration is for.
    expect(statements.some((s) => /ADD COLUMN "client" text NOT NULL;?$/.test(s.trim()))).toBe(true);
  });

  it('makes both idempotency keys unique per client rather than globally', async () => {
    const statements = await migrationStatements(await migrationFile('0014'));
    expect(statements.some((s) => s.includes('DROP INDEX "approvals_idempotency_pending_uq"'))).toBe(true);
    expect(statements.some((s) => s.includes('DROP INDEX "tool_effects_idempotency_uq"'))).toBe(true);
    expect(
      statements.some((s) => /CREATE UNIQUE INDEX "approvals_client_idempotency_pending_uq".*"client","idempotency_key"/s.test(s)),
    ).toBe(true);
  });

  it('drops the three audit columns nothing ever wrote', async () => {
    const statements = await migrationStatements(await migrationFile('0014'));
    for (const column of ['input_tokens', 'output_tokens', 'cost_usd']) {
      expect(statements.some((s) => s.includes(`ALTER TABLE "audit_log" DROP COLUMN "${column}"`))).toBe(true);
    }
  });

  it('applies whole to a database that has never seen it, view and all', async () => {
    await scratchDatabase(`harness_test_migration_0014_${process.pid}`, async (url) => {
      await runMigrations(url);
      const { default: pg } = await import('pg');
      const client = new pg.Client({ connectionString: url });
      await client.connect();
      try {
        const views = await client.query(
          `select table_name from information_schema.views where table_schema = 'public'`,
        );
        expect(views.rows.map((r) => r.table_name)).toContain('usage_runs');
        // The export answers on an empty database rather than erroring, which is what a tenant
        // with no runs yet asks it to do.
        const rows = await client.query('select * from usage_runs');
        expect(rows.rows).toEqual([]);
        const columns = await client.query(
          `select column_name from information_schema.columns where table_name = 'messages' and column_name = 'client'`,
        );
        expect(columns.rows).toHaveLength(1);
      } finally {
        await client.end();
      }
    });
  });
});
```

If `scratchDatabase`'s signature in `scratch-database.test-helpers.ts` is not `(name, body)` but something else, match it exactly — read the file and use the form `migration-0013.test.ts` uses.

- [ ] **Step 8: Run both database suites to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/db exec vitest run src/domain/schema.test.ts src/domain/migration-0014.test.ts
```
Expected: PASS.

- [ ] **Step 9: Write the failing `!include` test**

Create `harness/config-files/src/include.test.ts`:

```ts
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseWithIncludes } from './include.js';

async function clientDir(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-config-'));
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, name)), { recursive: true });
    await writeFile(path.join(dir, name), text, 'utf8');
  }
  return dir;
}

describe('parseWithIncludes', () => {
  it('replaces an include with the file it names, at any depth', async () => {
    const dir = await clientDir({
      'client.yaml': 'persona: !include persona.md\nskills:\n  onboarding: !include skills/onboarding.md\n',
      'persona.md': '# Persona\n',
      'skills/onboarding.md': '---\nname: onboarding\n---\n',
    });
    expect(await parseWithIncludes(path.join(dir, 'client.yaml'))).toEqual({
      persona: '# Persona\n',
      skills: { onboarding: '---\nname: onboarding\n---\n' },
    });
  });

  it('leaves a document with no include exactly as it parsed', async () => {
    const dir = await clientDir({ 'client.yaml': 'id: fixture\npacks: []\n' });
    expect(await parseWithIncludes(path.join(dir, 'client.yaml'))).toEqual({ id: 'fixture', packs: [] });
  });

  it('refuses an include that climbs out of the client directory', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include ../../../etc/passwd\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(/outside/);
  });

  it('refuses an absolute include for the same reason', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include /etc/passwd\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
  });

  it('names the file an include points at when it is not there', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include missing.md\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(/missing\.md/);
  });

  it('refuses an include whose value is not a path', async () => {
    const dir = await clientDir({ 'client.yaml': 'persona: !include\n  - a\n' });
    await expect(parseWithIncludes(path.join(dir, 'client.yaml'))).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 10: Create `@harness/config-files` and write the include reader**

Create `harness/config-files/package.json`:

```json
{
  "name": "@harness/config-files",
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
    "@harness/config-api": "workspace:*",
    "@harness/shared": "workspace:*",
    "yaml": "^2.9.1"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `tsconfig.json` and `vitest.config.ts` by copying `harness/identity-api`'s verbatim, and a `README.md` saying, in three sentences, that this source reads `HARNESS_CLIENTS_DIR/<id>/client.yaml`, that `!include` pulls the persona and the skills out into markdown files a human can read, and that `blueprint.yaml` plus `overlay.yaml` are resolved on load when both are present.

Create `harness/config-files/src/include.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError, describeError } from '@harness/shared';

/** The tag a client file uses to pull a long string out into a file beside it: `!include persona.md`. */
export const INCLUDE_TAG = 'include';

/** What the custom tag leaves in the parsed tree, for the walk below to replace. */
interface IncludeMarker {
  $include: string;
}

function isMarker(value: unknown): value is IncludeMarker {
  return typeof value === 'object' && value !== null && typeof (value as IncludeMarker).$include === 'string';
}

/**
 * Read one relative path, refusing anything that leaves the client's own directory.
 *
 * A client document is written by a tenant, and a tenant is not trusted to name a file: an
 * `!include /etc/passwd` or an `!include ../../other-tenant/client.yaml` would make the persona
 * of one client whatever it could reach on the host's filesystem. The check is on the resolved
 * path, so `a/../../b` is caught as surely as `../b`.
 */
async function readIncluded(relative: string, dir: string): Promise<string> {
  const target = path.resolve(dir, relative);
  const root = path.resolve(dir);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ConfigError(`!include "${relative}" is outside the client directory ${root}`);
  }
  try {
    return await readFile(target, 'utf8');
  } catch (err) {
    throw new ConfigError(`!include "${relative}": ${describeError(err)}`);
  }
}

async function expand(node: unknown, dir: string): Promise<unknown> {
  if (isMarker(node)) return readIncluded(node.$include, dir);
  if (Array.isArray(node)) return Promise.all(node.map((entry) => expand(entry, dir)));
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = await expand(value, dir);
    return out;
  }
  return node;
}

/**
 * Parse a YAML file, then replace every `!include <path>` with the contents of that file.
 *
 * Two passes rather than one, because the `yaml` package's custom tags are synchronous and a
 * file read is not. The tag's `resolve` therefore leaves a marker and this walks the tree.
 * A non-scalar `!include` is a `ConfigError` rather than a marker, because `!include [a, b]` is
 * a person meaning something the format does not offer.
 */
export async function parseWithIncludes(file: string): Promise<unknown> {
  const dir = path.dirname(file);
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    throw new ConfigError(`cannot read ${file}: ${describeError(err)}`);
  }
  const raw: unknown = parseYaml(text, {
    customTags: [
      {
        tag: `!${INCLUDE_TAG}`,
        identify: () => false,
        resolve: (value: unknown) => {
          if (typeof value !== 'string' || value.trim() === '') {
            throw new ConfigError(`!${INCLUDE_TAG} takes one path, as a plain string`);
          }
          return { $include: value.trim() } satisfies IncludeMarker;
        },
      },
    ],
  });
  return expand(raw, dir);
}
```

- [ ] **Step 11: Run the include test to verify it passes**

Run: `pnpm --filter @harness/config-files exec vitest run src/include.test.ts`
Expected: PASS, six cases.

- [ ] **Step 12: Write the files source and its conformance run**

Create `harness/config-files/src/source.ts`:

```ts
import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';
import {
  migrate,
  resolve as resolveOverlay,
  type Blueprint,
  type ConfigSource,
  type LoadedDocument,
  type Overlay,
} from '@harness/config-api';
import { ConfigError, describeError, type Logger } from '@harness/shared';
import { parseWithIncludes } from './include.js';

/** How long a burst of filesystem events is allowed to settle before the document is re-read. */
export const WATCH_DEBOUNCE_MS = 200;

/** A client id is a path segment; this is the same shape the document schema enforces. */
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version of a resolved document: the first sixteen hex characters of the SHA-256 of its
 * canonical JSON.
 *
 * Content-addressed rather than a modification time, so an edit that changes nothing does not
 * evict a tenant, an included markdown file that changes *does*, and two hosts reading the same
 * directory agree on what version they are serving.
 */
function versionOf(document: unknown): string {
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex').slice(0, 16);
}

export interface FilesConfigSourceOptions {
  /** `HARNESS_CLIENTS_DIR`: one directory holding one sub-directory per client. */
  root: string;
  log: Logger;
  watchDebounceMs?: number;
}

/**
 * Client documents from a directory outside this repository.
 *
 * `<root>/<id>/client.yaml` is the whole document. `<root>/<id>/blueprint.yaml` plus
 * `<root>/<id>/overlay.yaml` is a catalogue entry and a tenant's edits, resolved here under the
 * blueprint's lock set — which is the shape the platform writes, and the shape a
 * `ConfigError` names a locked path from.
 *
 * This is the source a dedicated deployment runs: a mounted volume, a tenant per directory, and
 * nothing in this repository that names any of them.
 */
export function filesConfigSource(opts: FilesConfigSourceOptions): ConfigSource {
  const root = path.resolve(opts.root);
  const debounceMs = opts.watchDebounceMs ?? WATCH_DEBOUNCE_MS;

  const dirFor = (clientId: string): string => {
    if (!CLIENT_ID.test(clientId)) throw new ConfigError(`"${clientId}" is not a client id`);
    return path.join(root, clientId);
  };

  const read = async (clientId: string): Promise<LoadedDocument | null> => {
    const dir = dirFor(clientId);
    const blueprintFile = path.join(dir, 'blueprint.yaml');
    if (await exists(blueprintFile)) {
      const blueprint = (await parseWithIncludes(blueprintFile)) as Blueprint;
      const overlayFile = path.join(dir, 'overlay.yaml');
      const overlay = (await exists(overlayFile))
        ? ((await parseWithIncludes(overlayFile)) as Overlay)
        : ({ patch: [], version: 'empty' } satisfies Overlay);
      const document = resolveOverlay(blueprint, overlay);
      return { document, version: versionOf(document) };
    }
    const file = path.join(dir, 'client.yaml');
    if (!(await exists(file))) return null;
    const document = migrate(await parseWithIncludes(file));
    if (document.id !== clientId) {
      throw new ConfigError(`${file} declares id "${document.id}" but lives in the directory "${clientId}"`);
    }
    return { document, version: versionOf(document) };
  };

  return {
    name: 'files',

    async load(clientId) {
      return read(clientId);
    },

    watch(clientId, onChange) {
      const dir = dirFor(clientId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last: string | null = null;
      let watcher: FSWatcher;
      const reload = (): void => {
        void read(clientId)
          .then((loaded) => {
            if (!loaded || loaded.version === last) return;
            last = loaded.version;
            onChange(loaded.version);
          })
          .catch((err: unknown) => {
            // A half-saved file is a normal thing to see mid-edit. The tenant in the pool keeps
            // the version it has, and the next event re-reads; a load that still fails when a
            // turn asks for it fails loudly there, where somebody is waiting for an answer.
            opts.log.warn(`config-files: ${clientId} changed but did not parse: ${describeError(err)}`);
          });
      };
      try {
        watcher = watch(dir, { recursive: true }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(reload, debounceMs);
          timer.unref?.();
        });
      } catch (err) {
        throw new ConfigError(`config-files: cannot watch ${dir}: ${describeError(err)}`);
      }
      // Seed the version so the first change is compared against what is on disk now rather
      // than reported as a change from nothing.
      void read(clientId)
        .then((loaded) => {
          last = loaded?.version ?? null;
        })
        .catch(() => {});
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    },

    async list() {
      const { readdir } = await import('node:fs/promises');
      const entries = await readdir(root, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory() && CLIENT_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    },
  };
}
```

Create `harness/config-files/src/index.ts`:

```ts
export { INCLUDE_TAG, parseWithIncludes } from './include.js';
export { WATCH_DEBOUNCE_MS, filesConfigSource, type FilesConfigSourceOptions } from './source.js';
```

Create `harness/config-files/src/source.test.ts`:

```ts
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify as toYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { filesConfigSource } from './source.js';

const log = { info() {}, warn() {}, error() {} };
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function newRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'harness-clients-'));
  roots.push(root);
  return root;
}

async function writeDocument(root: string, document: ClientDocument): Promise<void> {
  const dir = path.join(root, document.id);
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'client.yaml'), toYaml(document), 'utf8');
}

configSourceConformance(async () => {
  const root = await newRoot();
  const source = filesConfigSource({ root, log });
  return {
    source,
    // This source derives its version from the document's content rather than taking one, so the
    // version it assigned is the one a load answers with. The suite asserts what a version *is* —
    // stable while the content is, different when it is not — and never a literal string, which is
    // exactly what lets a content-addressed source run the same suite as a versioned one.
    put: async (document) => {
      const parsed = parseClientDocument(document);
      await writeDocument(root, parsed);
      const loaded = await source.load(parsed.id);
      if (!loaded) throw new Error(`wrote ${parsed.id} and the source does not hold it`);
      return loaded.version;
    },
    close: async () => {},
  };
});

describe('filesConfigSource', () => {
  it('pulls the persona and a skill out of the markdown files beside the document', async () => {
    const root = await newRoot();
    const dir = path.join(root, 'fixture');
    await mkdir(path.join(dir, 'skills'), { recursive: true });
    const raw = { ...fixtureDocument(), persona: undefined, skills: undefined } as Record<string, unknown>;
    delete raw.persona;
    delete raw.skills;
    await writeFile(
      path.join(dir, 'client.yaml'),
      `${toYaml(raw)}persona: !include persona.md\nskills:\n  onboarding: !include skills/onboarding.md\n`,
      'utf8',
    );
    await writeFile(path.join(dir, 'persona.md'), 'You are the fixture assistant.\n', 'utf8');
    await writeFile(path.join(dir, 'skills', 'onboarding.md'), '---\nname: onboarding\n---\nDo the thing.\n', 'utf8');

    const loaded = await filesConfigSource({ root, log }).load('fixture');
    expect(loaded?.document.persona).toBe('You are the fixture assistant.\n');
    expect(loaded?.document.skills.onboarding).toContain('Do the thing.');
  });

  it('resolves a blueprint and an overlay, and refuses one that touches a locked path', async () => {
    const root = await newRoot();
    const dir = path.join(root, 'acme');
    await mkdir(dir, { recursive: true });
    const { id: _id, displayName: _displayName, ...document } = fixtureDocument() as Record<string, unknown>;
    await writeFile(
      path.join(dir, 'blueprint.yaml'),
      toYaml({ document, lockset: ['/persona'], version: 'bp-1' }),
      'utf8',
    );
    await writeFile(
      path.join(dir, 'overlay.yaml'),
      toYaml({
        version: 'ov-1',
        patch: [
          { op: 'add', path: '/id', value: 'acme' },
          { op: 'add', path: '/displayName', value: 'Acme' },
        ],
      }),
      'utf8',
    );
    expect((await filesConfigSource({ root, log }).load('acme'))?.document.displayName).toBe('Acme');

    await writeFile(
      path.join(dir, 'overlay.yaml'),
      toYaml({
        version: 'ov-2',
        patch: [
          { op: 'add', path: '/id', value: 'acme' },
          { op: 'add', path: '/displayName', value: 'Acme' },
          { op: 'replace', path: '/persona', value: 'Something else.' },
        ],
      }),
      'utf8',
    );
    await expect(filesConfigSource({ root, log }).load('acme')).rejects.toThrow(/which blueprint bp-1 locks/);
  });

  it('refuses a document whose id is not the directory it sits in', async () => {
    const root = await newRoot();
    await mkdir(path.join(root, 'alpha'), { recursive: true });
    await writeFile(path.join(root, 'alpha', 'client.yaml'), toYaml(fixtureDocument()), 'utf8');
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('alpha')).rejects.toThrow(/declares id "fixture"/);
  });

  it('refuses a client id that is not one, rather than joining it into a path', async () => {
    const root = await newRoot();
    await expect(filesConfigSource({ root, log }).load('../escape')).rejects.toThrow(ConfigError);
  });

  it('tells a watcher the new version once the writes settle, and only once', async () => {
    const root = await newRoot();
    await writeDocument(root, parseClientDocument(fixtureDocument()));
    const source = filesConfigSource({ root, log, watchDebounceMs: 20 });
    const seen: string[] = [];
    const stop = source.watch?.('fixture', (version) => seen.push(version));
    // Let the seed read settle before the edit, so the first version is the one on disk.
    await new Promise((r) => setTimeout(r, 50));
    await writeDocument(root, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })));
    await writeDocument(root, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })));
    await new Promise((r) => setTimeout(r, 150));
    stop?.();
    expect(seen).toHaveLength(1);
    expect((await source.load('fixture'))?.version).toBe(seen[0]);
  });
});
```

- [ ] **Step 13: Run the files source suite**

Run: `pnpm --filter @harness/config-files test`
Expected: PASS — the conformance suite plus six cases. No sleep in it exceeds 150 ms.

- [ ] **Step 14: Create `@harness/config-postgres`**

Create `harness/config-postgres/package.json`:

```json
{
  "name": "@harness/config-postgres",
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
    "@harness/config-api": "workspace:*",
    "@harness/db": "workspace:*",
    "@harness/shared": "workspace:*",
    "drizzle-orm": "^0.45.2"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Copy `harness/host/vitest.config.ts` and `harness/host/test-global-setup.ts` into `harness/config-postgres/` (this package's suite needs Postgres and migrations, exactly as the host's does), and copy `harness/identity-api/tsconfig.json`. Write a `README.md` of three sentences: versioned rows, one live row per client in `client_documents` and the history in `client_document_versions`, and a `watch` that polls the version column because a host cannot hold a Postgres notification across a restart.

Create `harness/config-postgres/src/source.ts`:

```ts
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
```

Create `harness/config-postgres/src/index.ts`:

```ts
export { CONFIG_POLL_MS, postgresConfigSource, writeClientDocument, type PostgresConfigSourceOptions } from './source.js';
```

Create `harness/config-postgres/src/source.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { parseClientDocument } from '@harness/config-api';
import { configSourceConformance, fixtureDocument } from '@harness/config-api/testing';
import { postgresConfigSource, writeClientDocument } from './source.js';

const { db } = useTestDb();
const log = { info() {}, warn() {}, error() {} };

configSourceConformance(async () => ({
  source: postgresConfigSource({ db, log }),
  // This source serves the version it was handed, so that is the version it assigned.
  put: async (document, version) => {
    await writeClientDocument(db, parseClientDocument(document), version);
    return version;
  },
  close: async () => {},
}));

describe('postgresConfigSource', () => {
  it('keeps every version of a document, not only the live one', async () => {
    const source = postgresConfigSource({ db, log });
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1', 'u-one');
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2', 'u-one');
    expect((await source.load('fixture'))?.version).toBe('v2');
    expect(await source.list?.()).toEqual(['fixture']);
  });

  it('refuses a row that is not a document, rather than half-serving a tenant', async () => {
    await writeClientDocument(db, { ...parseClientDocument(fixtureDocument()), runtime: 'Not A Plug-in' }, 'v1');
    await expect(postgresConfigSource({ db, log }).load('fixture')).rejects.toThrow(/client document is invalid/);
  });

  it('tells a watcher when the version moves, and says nothing while it does not', async () => {
    const source = postgresConfigSource({ db, log, pollMs: 20 });
    await writeClientDocument(db, parseClientDocument(fixtureDocument()), 'v1');
    const seen: string[] = [];
    const stop = source.watch?.('fixture', (version) => seen.push(version));
    await new Promise((r) => setTimeout(r, 60));
    expect(seen).toEqual([]);
    await writeClientDocument(db, parseClientDocument(fixtureDocument({ displayName: 'Renamed' })), 'v2');
    await new Promise((r) => setTimeout(r, 120));
    stop?.();
    expect(seen).toEqual(['v2']);
  });
});
```

- [ ] **Step 15: Register both packages and run their suites**

In `.dependency-cruiser.cjs`, add two `PACKAGES` rows after the `config-api` one:

```js
  { name: 'config-files', src: 'harness/config-files/src', severity: 'error' },
  { name: 'config-postgres', src: 'harness/config-postgres/src', severity: 'error' },
```

and two `WORKSPACE_DIRS` entries in the same place. Add both directories to `pnpm-workspace.yaml`. Run `pnpm install`.

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres test && pnpm --filter @harness/config-files test
```
Expected: PASS for both.

- [ ] **Step 16: Write the failing source-registry test**

Create `harness/core-tools/src/domain/config/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { configSourceNameFrom, loadConfigSource } from './registry.js';

const log = { info() {}, warn() {}, error() {} };
const db = null as never;

describe('configSourceNameFrom', () => {
  it("has no default, because where a client comes from is a deployment's decision", () => {
    expect(() => configSourceNameFrom({})).toThrow(ConfigError);
    expect(() => configSourceNameFrom({})).toThrow(/HARNESS_CONFIG_SOURCE/);
    expect(configSourceNameFrom({ HARNESS_CONFIG_SOURCE: 'files' })).toBe('files');
  });

  it('refuses a name that is not one of the two, naming both', () => {
    expect(() => configSourceNameFrom({ HARNESS_CONFIG_SOURCE: 'etcd' })).toThrow(/files.*postgres/);
  });
});

describe('loadConfigSource', () => {
  it('loads the files source, and refuses one with no directory to read (invariant 18)', async () => {
    await expect(loadConfigSource('files', { env: {}, log, db })).rejects.toThrow(ConfigError);
    await expect(loadConfigSource('files', { env: {}, log, db })).rejects.toThrow(/HARNESS_CLIENTS_DIR/);
    const source = await loadConfigSource('files', { env: { HARNESS_CLIENTS_DIR: '/srv/tenants' }, log, db });
    expect(source.name).toBe('files');
  });

  it('loads the postgres source', async () => {
    expect((await loadConfigSource('postgres', { env: {}, log, db })).name).toBe('postgres');
  });

  it('refuses a source nobody ships', async () => {
    await expect(loadConfigSource('etcd', { env: {}, log, db })).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 17: Write the source registry**

Create `harness/core-tools/src/domain/config/registry.ts`:

```ts
import type { ConfigSource } from '@harness/config-api';
import type { Db } from '@harness/db';
import { ConfigError, requiredEnv, type EnvSource, type Logger } from '@harness/shared';

/** The sources this build ships. A third one is a package and one line here. */
const SOURCES = ['files', 'postgres'] as const;

export interface ConfigSourceDeps {
  env: EnvSource;
  log: Logger;
  /** Only the `postgres` source uses it; the registry does not know which one will. */
  db: Db;
}

/**
 * Which source this process loads its clients from. Required, with no default.
 *
 * A default here would be a guess about a deployment's topology — a dedicated tenant on a mounted
 * volume and a pooled host on a config store are different answers — and the failure a guess
 * produces is a host that started and served nobody. Invariant 18 is the same rule from the other
 * side: the host never reads a client from the repository root, so it has to be told where one is.
 */
export function configSourceNameFrom(env: EnvSource): string {
  const name = requiredEnv('HARNESS_CONFIG_SOURCE', ` (one of: ${SOURCES.join(', ')})`, env);
  if (!(SOURCES as readonly string[]).includes(name)) {
    throw new ConfigError(`HARNESS_CONFIG_SOURCE is "${name}"; this build ships ${SOURCES.join(' and ')}`);
  }
  return name;
}

/**
 * Build the named source.
 *
 * A dynamic import, like every other plug-in loader here, so that `@harness/config-postgres`
 * costs a process that reads a directory nothing at all, and so that adding a third source is a
 * package rather than an edit to the kernel's import graph.
 */
export async function loadConfigSource(name: string, deps: ConfigSourceDeps): Promise<ConfigSource> {
  if (name === 'files') {
    const root = requiredEnv(
      'HARNESS_CLIENTS_DIR',
      ' (the directory holding one sub-directory per client; never this repository)',
      deps.env,
    );
    const { filesConfigSource } = await import('@harness/config-files');
    return filesConfigSource({ root, log: deps.log });
  }
  if (name === 'postgres') {
    const { postgresConfigSource } = await import('@harness/config-postgres');
    return postgresConfigSource({ db: deps.db, log: deps.log });
  }
  throw new ConfigError(`no config source named "${name}"; this build ships ${SOURCES.join(' and ')}`);
}
```

Add `@harness/config-files` and `@harness/config-postgres` to `harness/core-tools/package.json`'s dependencies, so the two dynamic imports resolve. Export both functions from `harness/core-tools/src/index.ts`:

```ts
export { configSourceNameFrom, loadConfigSource, type ConfigSourceDeps } from './domain/config/registry.js';
```

Run `pnpm install`, then `pnpm --filter @harness/core-tools exec vitest run src/domain/config/registry.test.ts`.
Expected: PASS.

- [ ] **Step 18: Document the two new variables**

In `.env.example`, replace the `HARNESS_CLIENT` block with:

```
# --- Where a client comes from ------------------------------------------------
# Required, with no default: a host that guessed would start and serve nobody.
#   files     one directory per client under HARNESS_CLIENTS_DIR
#   postgres  versioned rows in client_documents, written by the platform
HARNESS_CONFIG_SOURCE=files

# The directory holding one sub-directory per client, each with a client.yaml
# (or a blueprint.yaml and an overlay.yaml). NEVER this repository: a client is
# data, and adding one changes nothing here. Required when
# HARNESS_CONFIG_SOURCE=files.
HARNESS_CLIENTS_DIR=/srv/tenants

# Which client this process serves.
#   set    a dedicated host: it serves that client and refuses an event for any
#          other, with an audit row naming both.
#   unset  a pooled host: the client is resolved per run, from the surface's own
#          tenant hint or the run API's x-harness-client header.
# Setting it to an empty value is a startup error, not a request for the default.
HARNESS_CLIENT=fixture
```

Leave every other block alone in this task.

- [ ] **Step 19: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 20: Commit**

```bash
git add harness/db harness/config-files harness/config-postgres \
  harness/core-tools/src/domain/config harness/core-tools/src/index.ts harness/core-tools/package.json \
  .dependency-cruiser.cjs pnpm-workspace.yaml pnpm-lock.yaml .env.example
git commit -m "feat(config): load a client document from a directory or from versioned rows"
```

---

### Task 4: The kernel reads the document — `buildKernelConfig(document, env)`, `tools.hide`, and no ambient environment in a domain

**Files:**
- Modify: `harness/core-tools/src/domain/tooling/config.ts`, `policy.ts`, `types.ts`, `deps.ts`, `harness/core-tools/src/testing.ts`
- Modify: `harness/core-tools/src/tools/catalog.ts` + `catalog.test.ts` (new), `harness/core-tools/src/domain/knowledge/sync.ts` + `sync.test.ts`, `harness/core-tools/src/domain/knowledge/search.test.ts`, `harness/core-tools/src/tools/knowledge.test.ts`
- Modify: `harness/core-tools/src/domain/storage/layout.ts`, `harness/core-tools/src/domain/models/gateway.ts`, `harness/db/src/shared/crypto.ts` (where `loadKey` is; `harness/db/src/index.ts` re-exports it from there)
- Modify: `harness/core-tools/src/app/server.ts` + `server.test.ts`, `harness/core-tools/src/app/main.ts`, `harness/core-tools/src/app/record-surface.ts`, `harness/core-tools/src/index.ts`
- Modify: `evals/src/domain/pipeline.ts`, `evals/src/judge-deps.test-helpers.ts`, `evals/src/app/cli.ts` + `cli.test.ts`, `evals/README.md` (the eval runner's own `HARNESS_PACKS` read becomes a `--packs` option, Step 10)
- Modify: `harness/host/src/app/main.ts`, `harness/host/src/testing.ts`, `harness/host/src/domain/playbooks/scheduler.test.ts`, `preflight.test.ts`
- Modify: `.env.example` (**`HARNESS_POLICY_FILE` and `HARNESS_PACKS` removed**), `harness/compose/docker-compose.yml` (**`HARNESS_POLICY_FILE`, `HARNESS_PACKS` and `HARNESS_IDENTITY` removed**), `docs/architecture/compose-surface.yaml` (re-recorded, Step 11)
- **Delete:** `clientDirFor`, the module-level `repoRoot` and `packNames` from `domain/tooling/config.ts`; `loadPolicy` and `parsePolicy` from `domain/tooling/policy.ts`

**Interfaces:**
- Consumes: `ClientDocument`, `ConfigSource`, `loadConfigSource`, `configSourceNameFrom` (Tasks 1 and 3).
- Produces:
  - `buildKernelConfig(document: ClientDocument, env: EnvSource): Promise<KernelConfig>`
  - `KernelConfig` gains `hiddenTools: readonly string[]`, replaces `clientDir: string` with `knowledgeDir: string | null`, and keeps every other member
  - `storageRoot(env: EnvSource): string`; `loadKey(env: EnvSource): Buffer`; `gatewayFromEnv(env: EnvSource): GatewayConfig`
  - `publishedTools(deps, kernel?)` withholds every name in `deps.hiddenTools`
  - `buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }>` now loads its document through the configured source

- [ ] **Step 1: Write the failing catalogue test**

Create `harness/core-tools/src/tools/catalog.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { makeTestDeps } from '../testing.js';
import { publishedTools } from './catalog.js';

const db = null as never;

describe("publishedTools and the client's hidden list", () => {
  it('publishes the whole catalogue when the client hides nothing', () => {
    const names = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    expect(names).toContain('memory_write');
    expect(names).toContain('knowledge_search');
    expect(new Set(names).size).toBe(names.length);
  });

  it('withholds exactly the names the client hides, and nothing else', () => {
    const before = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    const after = publishedTools(makeTestDeps(db, { hiddenTools: ['knowledge_search', 'memory_write'] })).map(
      (tool) => tool.name,
    );
    expect(after).not.toContain('knowledge_search');
    expect(after).not.toContain('memory_write');
    expect(after).toEqual(before.filter((name) => name !== 'knowledge_search' && name !== 'memory_write'));
  });

  it('leaves a hidden tool reachable to a pack wrapper through the kernel bag', () => {
    const deps = makeTestDeps(db, { hiddenTools: ['knowledge_search'] });
    // `createCoreToolsServer` is what fills `kernelTools`; this asserts the contract publishedTools
    // relies on — every kernel tool is there, hidden or not.
    for (const tool of publishedTools(deps)) expect(tool.name).not.toBe('knowledge_search');
    expect(publishedTools(deps).length).toBeGreaterThan(0);
  });

  it('hiding a name nothing publishes changes nothing, because a client may list a tool it never had', () => {
    const before = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    const after = publishedTools(makeTestDeps(db, { hiddenTools: ['never_existed'] })).map((tool) => tool.name);
    expect(after).toEqual(before);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/tools/catalog.test.ts`
Expected: FAIL — `hiddenTools` is not a member of the test overrides.

- [ ] **Step 3: Put `hiddenTools` and `knowledgeDir` on the bag, and apply the hide**

In `harness/core-tools/src/domain/tooling/types.ts`, replace the `clientDir` member of `ToolDeps` with:

```ts
  /**
   * Where this client's knowledge documents are, when they are a directory.
   *
   * `null` for a client whose knowledge lives in the store rather than on disk — which is what
   * the document's `knowledge: { source: 'store' }` means — and `knowledge_sync` says so by name
   * rather than walking a directory nobody configured. This is the only path a client still has,
   * and it is one the client document supplied, never one derived from where this code lives.
   */
  knowledgeDir: string | null;

  /**
   * Tool names this client does not publish (spec decision 7).
   *
   * Different from setting the tool's action class to `blocked`: hiding `documents_read`
   * withholds that one tool while everything else in the `read` class still works. A name no
   * loaded pack or kernel catalogue publishes is simply not there to hide.
   */
  hiddenTools: readonly string[];
```

In `harness/core-tools/src/tools/catalog.ts`, replace the two lines that build `hidden` with:

```ts
  const hidden = new Set<string>([
    ...(anyGenericKind ? [] : GENERIC_RECORD_TOOLS),
    ...(anyDocumentKind ? [] : [...PACK_DOCUMENT_TOOLS, ...PACK_DEADLINE_TOOLS]),
    // The client's own list, last, because it is the only one of the three a person wrote. It
    // unions rather than replaces: a deployment with no document kind still withholds the
    // document tools, whatever its `tools.hide` says.
    ...deps.hiddenTools,
  ]);
```

and extend `publishedTools`'s doc comment with one sentence: "…plus the names the client's own `policy.tools.hide` withholds, which is how a deployment drops one tool without blinding its action class."

In `harness/core-tools/src/testing.ts`, change `makeTestDeps`'s defaults: `clientDir: path.join(storageDir, 'client')` becomes `knowledgeDir: path.join(storageDir, 'knowledge')`, and add `hiddenTools: []`. Keep `TestDepsOverrides` as `Partial<ToolDeps>` so both are overridable.

In `harness/core-tools/src/domain/knowledge/sync.ts`, replace the directory line:

```ts
  const dir = opts.dir ?? deps.knowledgeDir;
  if (dir === null) {
    throw new ToolError(
      'this client keeps its knowledge in the store, not in a directory; the document\'s `knowledge` section decides which',
    );
  }
```

adding `ToolError` to the `@harness/shared` import if it is not there. Update `sync.test.ts`, `search.test.ts` and `tools/knowledge.test.ts`: every `clientDir` they pass to `makeTestDeps` becomes `knowledgeDir` pointing at the `knowledge` directory itself rather than its parent (they each create `<tmp>/knowledge` already — pass that path). `sync.test.ts`'s "a missing folder is an empty sync" case keeps a non-existent path; add one case there:

```ts
  it('says so by name when the client keeps its knowledge in the store', async () => {
    await expect(syncKnowledge(makeTestDeps(db, { knowledgeDir: null }), {})).rejects.toThrow(/in the store/);
  });
```

- [ ] **Step 4: Run the catalogue and knowledge tests to verify they pass**

Run: `pnpm --filter @harness/core-tools exec vitest run src/tools/catalog.test.ts src/domain/knowledge`
Expected: PASS.

- [ ] **Step 5: Write the failing configuration test**

Create `harness/core-tools/src/domain/tooling/config.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { buildKernelConfig } from './config.js';

const env = {
  HARNESS_STORAGE_DIR: '/tmp/harness-config-test',
  HARNESS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  LITELLM_MASTER_KEY: 'sk-test',
};

describe('buildKernelConfig', () => {
  it('takes the client id, the policy, the packs and the knowledge directory from the document', async () => {
    const document = parseClientDocument(
      fixtureDocument({
        id: 'alpha',
        displayName: 'Alpha',
        policy: { classes: { external: 'blocked' }, tools: { hide: ['documents_read'] } },
        knowledge: { source: 'dir', path: '/srv/tenants/alpha/knowledge' },
      }),
    );
    const config = await buildKernelConfig(document, env);
    expect(config.client).toBe('alpha');
    expect(config.policy.classes.external).toBe('blocked');
    // Merged over the kernel's own matrix, not replacing it.
    expect(config.policy.classes.read).toBe('auto');
    expect(config.hiddenTools).toEqual(['documents_read']);
    expect(config.knowledgeDir).toBe('/srv/tenants/alpha/knowledge');
    expect(config.packs.all.map((pack) => pack.name)).toEqual(['healthcare']);
  });

  it('serves no pack for a document that names none, which used to need an empty variable', async () => {
    const config = await buildKernelConfig(parseClientDocument(fixtureDocument({ packs: [] })), env);
    expect(config.packs.all).toEqual([]);
    expect(config.hiddenTools).toEqual([]);
  });

  it('has no knowledge directory for a document whose knowledge lives in the store', async () => {
    const config = await buildKernelConfig(parseClientDocument(fixtureDocument()), env);
    expect(config.knowledgeDir).toBeNull();
  });

  it('reads the storage root, the key and the gateway from the map it was given, not the ambient one', async () => {
    const config = await buildKernelConfig(parseClientDocument(fixtureDocument()), {
      ...env,
      HARNESS_STORAGE_DIR: '/tmp/harness-somewhere-else',
      HARNESS_GATEWAY_URL: 'http://127.0.0.1:9999',
    });
    expect(config.storageDir).toBe('/tmp/harness-somewhere-else');
    expect(config.gateway.baseUrl).toBe('http://127.0.0.1:9999');
    expect(config.encryptionKey).toHaveLength(32);
  });

  it('fails on a map with no storage root and on one with no gateway key, naming each', async () => {
    const { HARNESS_STORAGE_DIR: _dir, ...noStorage } = env;
    await expect(buildKernelConfig(parseClientDocument(fixtureDocument()), noStorage)).rejects.toThrow(
      /HARNESS_STORAGE_DIR/,
    );
    const { LITELLM_MASTER_KEY: _key, ...noGateway } = env;
    await expect(buildKernelConfig(parseClientDocument(fixtureDocument()), noGateway)).rejects.toThrow(ConfigError);
  });
});
```

- [ ] **Step 6: Run it to verify it fails**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/tooling/config.test.ts`
Expected: FAIL — `buildKernelConfig` takes one argument.

- [ ] **Step 7: Make the four ambient reads take their environment**

In `harness/core-tools/src/domain/storage/layout.ts`, change `storageRoot()` to `storageRoot(env: EnvSource)` and read the variable off `env` through the same helper it uses today. In `harness/db/src/shared/crypto.ts` — which is where `loadKey` lives, and what `harness/db/src/index.ts` re-exports it from — change `loadKey()` to `loadKey(env: EnvSource)` and do the same (`harness/db/src/**` is exempt from the `process.env` ESLint rule, but taking the map is what makes a per-tenant key possible later and what makes this function testable without a global). In `harness/core-tools/src/domain/models/gateway.ts`, change `gatewayFromEnv()` to `gatewayFromEnv(env: EnvSource)`, replace the four reads inside the `eslint-disable no-restricted-syntax` block with reads off `env`, and **delete the disable comment** — there is no ambient read left to excuse. Update every call site of the three (`grep -rn 'storageRoot(\|loadKey(\|gatewayFromEnv(' --include='*.ts'`) to pass the map they already hold; a test that called one with no argument passes `{}` or a small literal.

- [ ] **Step 8: Rewrite `config.ts` and `policy.ts`**

In `harness/core-tools/src/domain/tooling/policy.ts`: delete the `node:fs/promises` and `yaml` imports, delete `parsePolicy`, delete `loadPolicy`, and delete `optionalEnv` from the `@harness/shared` import. `DEFAULT_POLICY`, `mergePolicy` and `decide` stay exactly as they are. Add one sentence to `mergePolicy`'s comment: "The overrides come from the client document's `policy` section, which `@harness/config-api` validated; nothing reads a policy file any more."

In `harness/core-tools/src/domain/tooling/config.ts`, delete the `node:path`/`node:url` `repoRoot` block, `clientDirFor`, `DEFAULT_PACKS` and `packNames`, and replace `buildKernelConfig` with:

```ts
/**
 * Everything every run shares, read and loaded once per tenant.
 *
 * The **document** decides what this client is — its id, its policy, its packs, where its
 * knowledge is — and the **environment** decides what this deployment is: where files live, which
 * key encrypts them, which gateway to call. Nothing here reads the ambient environment, and
 * nothing here resolves a path from where this file happens to sit: both are what stopped one
 * process from serving two clients.
 */
export async function buildKernelConfig(document: ClientDocument, env: EnvSource): Promise<KernelConfig> {
  const packs = await loadPacks(document.packs);
  // One root for the whole file store, required and with no default (see storageRoot).
  const storageDir = storageRoot(env);

  return {
    client: document.id,
    policy: mergePolicy(DEFAULT_POLICY, document.policy),
    hiddenTools: document.policy.tools.hide,
    encryptionKey: loadKey(env),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }, env),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }, env),
    gateway: gatewayFromEnv(env),
    storageDir,
    knowledgeDir: document.knowledge.source === 'dir' ? document.knowledge.path : null,
    // 1,024 is what migration 0013 created the column at; `assertEmbedDims` is what proves a
    // deployment has not drifted from it. The ceiling is pgvector's own HNSW limit.
    embedDims: numberFromEnv('HARNESS_EMBED_DIMS', 1_024, { min: 8, max: 2_000, integer: true }, env),
    parser: parserFromEnv(storageDir, optionalEnv('HARNESS_FILES_URL', env)),
    formsDir: formsDirFrom(packs, optionalEnv('HARNESS_FORMS_DIR', env), storageDir),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL', env),
    packs,
    // The deployment's own environment, and the only bag that hands one over. A pack reads its
    // variables from here; see `ToolDeps.env`.
    env,
  };
}
```

with `DEFAULT_POLICY` and `mergePolicy` imported from `./policy.js` in place of `loadPolicy`, and `ClientDocument` imported as a type from `@harness/config-api`. In `harness/core-tools/src/index.ts`, drop `clientDirFor` from the `./domain/tooling/config.js` export line and drop `loadPolicy` and `parsePolicy` wherever they are exported.

- [ ] **Step 9: Run the configuration test to verify it passes**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/tooling/config.test.ts`
Expected: PASS.

- [ ] **Step 10: Give the stdio server, the recorder and the evals their document**

In `harness/core-tools/src/app/server.ts`, replace the whole file's `clientDirFor` usage and `resolvePrincipal`'s inline read (the Task 2 scaffold) with a load through the configured source:

```ts
import { createDb } from '@harness/db';
import { configSourceNameFrom, loadConfigSource } from '../domain/config/registry.js';
import type { ClientDocument } from '@harness/config-api';
import type { Principal } from '@harness/identity-api';
import { ConfigError, createLogger, envOrDefault } from '@harness/shared';
import { loadIdentity } from '../domain/identity/registry.js';
import { buildKernelConfig } from '../domain/tooling/config.js';
import { depsForRun } from '../domain/tooling/deps.js';
import type { ToolDeps } from '../domain/tooling/types.js';
import { openRun } from '../domain/session/repository.js';

const log = createLogger('core-tools');

/**
 * This process's client, resolved through whatever `HARNESS_CONFIG_SOURCE` names.
 *
 * `HARNESS_CLIENT` is required here, with no default: a stdio server is one client for its whole
 * life, and a default would be a guess at which one. A client the source does not hold is a
 * startup failure naming both the id and the source, because a server that started anyway would
 * serve a client nobody configured.
 */
export async function loadClientDocument(db: Parameters<typeof openRun>[0]): Promise<ClientDocument> {
  const clientId = envOrDefault('HARNESS_CLIENT', '', process.env);
  if (clientId === '') throw new ConfigError('HARNESS_CLIENT names the client this server serves; set it');
  const source = await loadConfigSource(configSourceNameFrom(process.env), { env: process.env, log, db });
  const loaded = await source.load(clientId);
  if (!loaded) throw new ConfigError(`the ${source.name} config source holds no client "${clientId}"`);
  await source.close?.();
  return loaded.document;
}

/**
 * The principal this process acts as: `HARNESS_PRINCIPAL`, an id the client document's identity
 * section must declare. The plug-in is connected for this one lookup and stopped again — a stdio
 * server is one principal for its whole life, so it keeps no session. An undeclared id is a
 * startup failure: a server that started anyway would audit every call as somebody nobody
 * vouched for.
 */
export async function resolvePrincipal(document: ClientDocument, env: NodeJS.ProcessEnv): Promise<Principal> {
  const session = await loadIdentity(`@harness/identity-${document.identityProvider.kind}`, {
    env,
    log,
    identity: parseIdentityFileWithDefaults(document.identity),
    settings: document.identityProvider.settings,
  });
  try {
    const id = envOrDefault('HARNESS_PRINCIPAL', 'svc-local', env);
    const principal = await session.get(id);
    if (!principal) {
      throw new ConfigError(
        `HARNESS_PRINCIPAL names "${id}", which the identity plug-in "${session.name}" does not declare`,
      );
    }
    return principal;
  } finally {
    await session.stop();
  }
}

/**
 * The stdio server's dependencies: this client's document, the configuration it implies, this
 * process's principal, and one run for the process's lifetime. A multi-run host builds its own
 * `KernelConfig` per tenant and calls `openRun` and `depsForRun` per run instead.
 */
export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const document = await loadClientDocument(db);
  const config = await buildKernelConfig(document, process.env);
  const principal = await resolvePrincipal(document, process.env);
  const context = await openRun(db, { client: config.client, principal });
  return { deps: depsForRun(config, { db, principal, context }), close };
}
```

adding `parseIdentityFileWithDefaults` to the `@harness/identity-api` import. **`HARNESS_IDENTITY` is no longer read here** — the document's `identityProvider.kind` names the plug-in, and the specifier is derived from the name (decision 1).

In `harness/core-tools/src/app/server.test.ts`, **delete** the `describe('clientDirFor', …)` block and the `clientDirFor` import; keep the `HARNESS_CLIENT` set-but-empty case, which now asserts against `loadClientDocument`'s own refusal (`/HARNESS_CLIENT/`).

In `harness/core-tools/src/app/record-surface.ts`, replace the hand-written `surfaceDeps()` body's two changed members and build its packs from a document:

```ts
export async function surfaceDeps(): Promise<ToolDeps> {
  // A fixture document rather than an environment, deliberately: the committed snapshot has to
  // describe the shipped default, not whatever the machine recording it happens to have
  // configured. Its `packs` names the one shipped pack and its `policy.tools.hide` is empty, so
  // the recorded catalogue is the whole catalogue — which is also why `tools.hide` can never
  // move this file.
  const document = parseClientDocument(fixtureDocument({ id: 'surface', displayName: 'Surface recorder' }));
  const packs = await loadPacks(document.packs);
  return {
    db: null as unknown as ToolDeps['db'],
    client: document.id,
    principal: {
      id: 'svc-surface',
      kind: 'service',
      level: 'service',
      displayName: 'Surface recorder',
      surfaces: {},
      attributes: {},
    },
    policy: { ...DEFAULT_POLICY },
    hiddenTools: document.policy.tools.hide,
    encryptionKey: Buffer.alloc(32),
    now: () => new Date('2026-01-01T00:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', timeoutMs: 1_000, maxCallsPerRun: 1 },
    storageDir: '/nonexistent/surface',
    knowledgeDir: null,
    embedDims: 1_024,
    parser: localParser('/nonexistent/surface'),
    formsDir: '/nonexistent/surface',
    restrictedToModel: false,
    sinks: {},
    context: { runId: null, threadId: null, surface: null, conversation: null },
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    env: {},
  };
}
```

with `parseClientDocument` imported from `@harness/config-api` and `fixtureDocument` from `@harness/config-api/testing`. **`@harness/config-api` must be a normal dependency of `@harness/core-tools` for this to lint** — it is, from Task 1 — and `@harness/config-api/testing` is reached through its declared subpath export, which `only-public-entry-of-harness-config-api` allows.

In `evals/src/domain/pipeline.ts` and `evals/src/judge-deps.test-helpers.ts`, replace `clientDir: clientDirFor(client)` and `clientDir: clientDirFor('evals')` with `knowledgeDir: null` and add `hiddenTools: []`, dropping `clientDirFor` from the `@harness/core-tools` import. The eval runner syncs no knowledge folder, so `null` is the true answer and not a placeholder.

**The eval runner is the second reader of `HARNESS_PACKS`, and it loses it here.** `evals/src/app/cli.ts` reads `process.env.HARNESS_PACKS` directly, and `evals` is one of the seven roots the environment scan walks, so Step 11 cannot take the variable out of `.env.example` while that read stands — `harness/core-tools/src/app/surface.test.ts`'s "reads no environment variable that `.env.example` does not document" would fail this task. The runner already takes `--pack` to choose among the loaded packs; it takes `--packs` to name them. In `evals/src/app/cli.ts`, change `packNames` and `packsToMeasure` to read the flag's value rather than a variable, keeping the three states the raw read was there for — absent means the shipped pack, `--packs=` means none, and a list means that list:

```ts
/**
 * Which packs this run loads.
 *
 * `--packs=<a,b>` names them; `--pack` then picks one of them when several are. Absent, the
 * default is the shipped pack, so a single-pack run needs no flag at all. Given empty
 * (`--packs=`) it names no pack, which a server serves happily and an eval run cannot:
 * `packsToMeasure` refuses it below, because a run with nothing to measure has no report to
 * write. The three states are why this takes the flag's raw `string | undefined` rather than
 * going through `optionalEnv`-shaped helpers, which cannot tell absent from empty.
 *
 * It is a flag and no longer `HARNESS_PACKS`: a pack list is a property of the client document a
 * server loads, and the eval runner loads no document, so the run says what it measures on the
 * command line that starts it.
 */
export function packNames(raw: string | undefined): string[] {
  return (raw ?? '@harness/pack-healthcare')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

export function packsToMeasure(raw: string | undefined): { ok: true; names: string[] } | { ok: false; error: string } {
  const names = packNames(raw);
  if (names.length === 0) {
    return { ok: false, error: '--packs names no pack; an eval run measures one, so name it there' };
  }
  return { ok: true, names };
}
```

and at the call site replace `packsToMeasure(process.env.HARNESS_PACKS)` with `packsToMeasure(flag('packs'))`, whose comment above it becomes:

```ts
  // Everything the run measures comes off the loaded pack, which is what makes this runner
  // pack-agnostic: it imports none, and `--packs` names what it loads.
```

That call site is the **only** read in `evals/`; every other mention of the name there is prose — `parsePackFlag`'s comment, the `--pack` usage line, `domain/pipeline.ts`, `domain/orchestrate.ts`, `domain/cases.ts`, `domain/pipeline.test.ts` and `evals/README.md` (its intro sentence and its `HARNESS_PACKS=… pnpm evals` example). Reword each of those to `--packs`, because a deleted variable may not be left named in a document (Global Constraints). `grep -rn 'HARNESS_PACKS' evals/` must come back empty when this step is done. In `evals/src/app/cli.test.ts`, the two `packsToMeasure` cases and the two `packNames` cases keep their inputs — both functions still take `string | undefined` — and change only the names and messages they assert: the empty case expects `--packs names no pack`, and each `describe`/`it` title says `--packs` where it said `HARNESS_PACKS`. Add one case to the `--packs` describe, which is what pins the flag to the parser the CLI actually calls:

```ts
  it('reads the pack list off the command line, and no flag still means the shipped pack', () => {
    expect(flagFrom(['node', 'cli.ts'], 'packs')).toBeUndefined();
    expect(packsToMeasure(flagFrom(['node', 'cli.ts'], 'packs'))).toEqual({
      ok: true,
      names: ['@harness/pack-healthcare'],
    });
    expect(packNames(flagFrom(['node', 'cli.ts', '--packs=@harness/pack-stories,@harness/pack-healthcare'], 'packs'))).toEqual([
      '@harness/pack-stories',
      '@harness/pack-healthcare',
    ]);
    expect(packsToMeasure(flagFrom(['node', 'cli.ts', '--packs='], 'packs')).ok).toBe(false);
  });
```

Run `pnpm --filter @harness/evals exec vitest run src/app/cli.test.ts` and expect PASS before moving on.

In `harness/host/src/testing.ts`, `testKernelConfig` derives from `makeTestDeps` and needs no change; confirm with a typecheck.

In `harness/host/src/app/main.ts`, replace `buildKernelConfig(process.env)` with a two-step that Task 6 replaces wholesale:

```ts
// Task 6 replaces this whole script with createHost(); until then the host loads the one client
// HARNESS_CLIENT names through the configured source, exactly as the stdio server does.
const document = await loadClientDocument(db);
const config = await buildKernelConfig(document, process.env);
```

importing `loadClientDocument` from `@harness/core-tools`, and export it from `harness/core-tools/src/index.ts`. Replace `const clientDir = config.clientDir;` and `readPersona(clientDir)` with `document.persona`, the `readPlaybooksFile` scaffold from Task 1 with `parsePlaybooksFile(document.playbooks)`, and the Task 2 identity scaffold with `parseIdentityFileWithDefaults(document.identity)` plus the derived specifier `` `@harness/identity-${document.identityProvider.kind}` ``. `HARNESS_IDENTITY` is no longer read in the host either; **`HARNESS_SURFACES` and `HARNESS_RUNTIME` still are, until Task 6.**

In `harness/host/src/domain/playbooks/scheduler.test.ts`, replace `policy: await loadPolicy(path.join(demoClientDir, 'policy.yaml'))` with the literal the shipped file holds, so nothing reads a policy file:

```ts
      policy: mergePolicy(DEFAULT_POLICY, {
        classes: { read: 'auto', 'write.internal': 'auto', external: 'approval', financial: 'blocked', destructive: 'approval' },
      }),
```

and `clientDir: demoClientDir` with `knowledgeDir: path.join(demoClientDir, 'knowledge')`. In `preflight.test.ts`, the `loadIdentity` call's `clientDir` becomes the two new members, built with `parseIdentityFileWithDefaults(parseYaml(await readFile(path.join(demoClientDir, 'identity.yaml'), 'utf8')))`. **Both of these are Task 9's to move onto the fixture document; here they only stop compiling against a signature that no longer exists.**

- [ ] **Step 11: Delete the two variables**

From `.env.example`, delete the `HARNESS_POLICY_FILE` line and the comment above it, and delete the whole `# --- Packs ---` block including `HARNESS_PACKS=@harness/pack-healthcare`. One other comment there names the variable — `HARNESS_FORMS_DIR`'s, which says the forms directory comes from "the first pack named in HARNESS_PACKS"; change that phrase to "the first pack the client document's `packs` list names". In the `# --- Identity ---` block, delete the `HARNESS_IDENTITY` lines and their comment, and replace them with one sentence: "Which identity plug-in resolves principals is the client document's `identityProvider.kind`, not a variable." In `harness/compose/docker-compose.yml`, delete the `HARNESS_POLICY_FILE:` line from the `host` service, delete the `HARNESS_PACKS:` line and the six-line comment above it, delete the `HARNESS_IDENTITY:` line, and delete `HARNESS_CLIENT` from the `core-tools` service (that service is `build-only` and starts nothing).

The Compose file has changed, so `surface.test.ts`'s byte match against the snapshot now fails. Re-record it here, which is the first of this plan's three Compose-snapshot tasks — 4, 6 and 9, as the Global Constraints and the Task order both name them:

```bash
pnpm surface:record
git diff --stat docs/architecture
```

Expected: only `compose-surface.yaml` is modified; `tool-surface.json` is untouched. **If `tool-surface.json` moved, stop:** `tools.hide` has changed the default catalogue, which this plan forbids.

- [ ] **Step 12: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` names `compose-surface.yaml` and nothing else.

- [ ] **Step 13: Commit**

```bash
git add harness/core-tools harness/db/src/shared/crypto.ts harness/host/src evals/src \
  harness/compose/docker-compose.yml docs/architecture/compose-surface.yaml .env.example
git commit -m "feat(core-tools): build the kernel configuration from a client document and hide the tools it withholds"
```

---

### Task 5: Every repository writes and filters the tenant column, and `closeRun` and `reconcile` take a client

**Files:**
- Modify: `harness/core-tools/src/domain/records/repository.ts` + `repository.test.ts`
- Modify: `harness/core-tools/src/domain/deadlines/repository.ts` + `repository.test.ts`
- Modify: `harness/core-tools/src/domain/playbooks/repository.ts` + `repository.test.ts`
- Modify: `harness/core-tools/src/tools/playbooks.ts` + `playbooks.test.ts` (the two kernel tools that request and read playbook runs pass `deps.client`; this is the file the isolation test's `playbooks_status` call goes through)
- Modify: `harness/core-tools/src/domain/session/repository.ts` + `repository.test.ts`
- Modify: `harness/core-tools/src/domain/tooling/reconcile.ts` + `reconcile.test.ts`
- Modify: `harness/host/src/domain/threads/repository.ts` + `repository.test.ts`
- Modify: `harness/host/src/domain/api/repository.ts` + its test
- Modify: `harness/host/src/domain/playbooks/repository.ts` + `repository.test.ts`
- Modify: `harness/host/src/domain/conversation.ts` (the two `closeRun` call sites, through `finishKernel`), `harness/host/src/domain/kernel.ts`
- Modify: `harness/core-tools/src/app/main.ts` (the startup `reconcile`)

**Interfaces:**
- Consumes: the columns Task 3's migration created.
- Produces (signature changes every caller must match):
  - `closeRun(db, client: string, runId: string, status: RunStatus, now?): Promise<void>`
  - `finishKernel(db, client: string, runId: string, status, now, close): Promise<void>`
  - `reconcile(db, opts: { now: () => Date; staleAfterMs?: number; client: string })` — **`client` becomes required**
  - `appendMessage(db, { client, threadId, role, content, … })`; `recentHistory(db, client, threadId, limit)`
  - `readThreadFor(db, { client, threadId, principalId, limit })` unchanged in shape, now filtering `messages.client` too
  - `claimDuePlaybooks`, `requestPlaybookRun`, `finishPlaybookRun` and every other `playbook_runs` writer take and filter `client`

- [ ] **Step 1: Write the failing isolation test for the record and deadline repositories**

Append to `harness/core-tools/src/domain/records/repository.test.ts`:

```ts
  it("writes the tenant on every field and attachment, and reads back none of another tenant's", async () => {
    const alpha = makeTestDeps(db, { client: 'alpha' });
    const beta = makeTestDeps(db, { client: 'beta' });
    const record = await createRecord(alpha, { pack: 'healthcare', kind: 'provider', externalId: 'r1' });
    await upsertFields(alpha, record.id, [{ name: 'first_name', value: 'Ada' }]);
    await upsertAttachment(alpha, record.id, { kind: 'licence', state: 'NY' });

    const [field] = await db.select().from(fields).where(eq(fields.recordId, record.id));
    expect(field.client).toBe('alpha');
    const [attachment] = await db.select().from(attachments).where(eq(attachments.recordId, record.id));
    expect(attachment.client).toBe('alpha');

    // Beta knows the id — an id is not a secret — and still sees nothing.
    expect(await readRecord(beta, record.id)).toBeNull();
    expect(await db.$count(fields, eq(fields.client, 'beta'))).toBe(0);
  });
```

matching the real helper names in that file (read it: the creators are named there, and this test uses the same ones its neighbours do). Append to `harness/core-tools/src/domain/deadlines/repository.test.ts`:

```ts
  it('computes and lists deadlines for one tenant only', async () => {
    const alpha = makeTestDeps(db, { client: 'alpha' });
    const beta = makeTestDeps(db, { client: 'beta' });
    const record = await createRecord(alpha, { pack: 'healthcare', kind: 'provider', externalId: 'r1' });
    await upsertAttachment(alpha, record.id, { kind: 'licence', state: 'NY', expiresAt: '2026-12-01' });
    await computeDeadlines(alpha, record.id);
    const [row] = await db.select().from(deadlines);
    expect(row.client).toBe('alpha');
    expect(await listDeadlines(beta, { withinDays: 3650 })).toEqual([]);
  });
```

again matching the file's own helper names.

- [ ] **Step 2: Run both to verify they fail**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/records src/domain/deadlines`
Expected: FAIL — the inserts do not set `client`, which is `NOT NULL`.

- [ ] **Step 3: Write the tenant on every insert and filter it on every read**

In `harness/core-tools/src/domain/records/repository.ts`: every `.insert(fields).values(...)` and `.insert(attachments).values(...)` gains `client: deps.client`; every `.update(attachments)` and `.update(fields)` `where` gains `eq(attachments.client, deps.client)` / `eq(fields.client, deps.client)` beside its existing predicate; every `.select().from(fields)` / `.from(attachments)` `where` gains the same. In `harness/core-tools/src/domain/deadlines/repository.ts`: the `.insert(deadlines)` gains `client: deps.client`; the `.select().from(attachments)`, the stale-id `.select().from(deadlines)`, the `.delete(deadlines)` and the listing query each gain `eq(<table>.client, deps.client)`. The listing already joins `records` for its client predicate — **keep that join and add the column predicate as well**: the join proves the record is the tenant's, the column proves the deadline row is, and a row that disagrees is a bug this makes visible rather than silently repairs.

Add this comment once, above the first such predicate in each file:

```ts
  // Belt and braces (spec invariant 13). The foreign key already reaches a row that carries the
  // client, so a correct writer cannot produce a mismatch; a reader that relied on that would be
  // one join away from another tenant's rows the first time a writer was not correct.
```

- [ ] **Step 4: Run them to verify they pass**

Run: `pnpm --filter @harness/core-tools exec vitest run src/domain/records src/domain/deadlines`
Expected: PASS.

- [ ] **Step 5: Write the failing messages, runs and playbook-runs tests**

Append to `harness/host/src/domain/threads/repository.test.ts`:

```ts
  it('writes the tenant on a message and hands back no history from another', async () => {
    const thread = await findOrCreateThread(db, {
      client: 'alpha',
      surface: 'memory',
      conversation: 'C1',
      principalId: 'u-one',
    });
    await appendMessage(db, { client: 'alpha', threadId: thread.id, role: 'user', content: 'hello' });
    const [row] = await db.select().from(messages).where(eq(messages.threadId, thread.id));
    expect(row.client).toBe('alpha');
    expect(await recentHistory(db, 'alpha', thread.id, 10)).toHaveLength(1);
    // The same thread id, asked for as somebody else: nothing, not an error.
    expect(await recentHistory(db, 'beta', thread.id, 10)).toEqual([]);
  });
```

Append to `harness/core-tools/src/domain/session/repository.test.ts`:

```ts
  it("closes only its own tenant's run", async () => {
    const alpha = await openRun(db, { client: 'alpha', principal: TEST_PRINCIPAL });
    await closeRun(db, 'beta', alpha.runId, 'done');
    const [stillRunning] = await db.select().from(runs).where(eq(runs.id, alpha.runId));
    expect(stillRunning.status).toBe('running');
    await closeRun(db, 'alpha', alpha.runId, 'done');
    const [closed] = await db.select().from(runs).where(eq(runs.id, alpha.runId));
    expect(closed.status).toBe('done');
    expect(closed.endedAt).not.toBeNull();
  });
```

Append to `harness/core-tools/src/domain/tooling/reconcile.test.ts`:

```ts
  it("repairs one tenant's rows and leaves the other's alone", async () => {
    // Two expired pending approvals, one per client.
    for (const client of ['alpha', 'beta']) {
      await db.insert(approvals).values({
        client,
        action: 'forms_release',
        payload: {},
        summary: 's',
        requestedBy: 'u-one',
        expiresAt: new Date('2020-01-01T00:00:00Z'),
        idempotencyKey: `k-${client}`,
      });
    }
    const repaired = await reconcile(db, { now: () => new Date('2026-09-15T12:00:00Z'), client: 'alpha' });
    expect(repaired.approvals_expired).toBe(1);
    expect(await db.$count(approvals, and(eq(approvals.client, 'beta'), eq(approvals.status, 'pending')))).toBe(1);
  });
```

Append to `harness/host/src/domain/playbooks/repository.test.ts`:

```ts
  it("claims only its own tenant's due playbooks and writes the tenant on the firing", async () => {
    for (const client of ['alpha', 'beta']) {
      await syncPlaybooks(db, { client, now, file: 'document' }, [definition({ name: 'nightly' })]);
    }
    const claimed = await claimDuePlaybooks(db, { client: 'alpha', now: later });
    expect(claimed).toHaveLength(1);
    const [row] = await db.select().from(playbookRuns);
    expect(row.client).toBe('alpha');
    expect(await claimDuePlaybooks(db, { client: 'gamma', now: later })).toEqual([]);
  });
```

matching that file's own `definition`, `now` and `later` helpers (read it and reuse them).

- [ ] **Step 6: Run them to verify they fail**

Run:
```bash
pnpm --filter @harness/core-tools exec vitest run src/domain/session src/domain/tooling/reconcile.test.ts
pnpm --filter @harness/host exec vitest run src/domain/threads src/domain/playbooks/repository.test.ts
```
Expected: FAIL — the signatures take no client and the inserts set none.

- [ ] **Step 7: Scope `closeRun`, `reconcile`, the messages and the playbook runs**

In `harness/core-tools/src/domain/session/repository.ts`:

```ts
/**
 * Close a run: the status it ended in and when. The one writer of `runs.status` after `openRun`.
 *
 * Scoped to the client, even though a run id is a uuid and cannot collide, because a pooled host
 * closes runs for several tenants from one process and a predicate that is only *probably* enough
 * is not a predicate (spec invariant 13). A run id from another tenant matches nothing and the
 * call is a no-op, which is what a caller that has been handed the wrong id should get.
 */
export async function closeRun(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date = () => new Date(),
): Promise<void> {
  await db
    .update(runs)
    .set({ status, endedAt: now() })
    .where(and(eq(runs.id, runId), eq(runs.client, client)));
}
```

adding `and` to the `drizzle-orm` import. Delete the doc-comment sentence on `reconcileForClient` that says startup runs `reconcile` unscoped.

In `harness/core-tools/src/domain/tooling/reconcile.ts`, make `client` required on the options object and delete the branch that omits the predicate, with this comment on the parameter:

```ts
  /**
   * Whose rows to repair. Required: a pooled host that ran an unscoped repair at startup would
   * expire one tenant's approvals because another tenant's process restarted.
   */
  client: string;
```

In `harness/core-tools/src/app/main.ts`, pass `client: deps.client` to the startup `reconcile`, and change the log line to name the client: `` `reconcile on startup for ${deps.client}: ${JSON.stringify(repaired)}` ``. The host's startup repair moves to Task 6, where it runs once per tenant.

In `harness/host/src/domain/threads/repository.ts`: `appendMessage` takes `client` on its input object and writes it; `recentHistory(db, client, threadId, limit)` gains the client parameter and an `eq(messages.client, client)` predicate beside the thread one. In `harness/host/src/domain/api/repository.ts`, `readThreadFor`'s message query gains `eq(messages.client, opts.client)`.

In `harness/core-tools/src/domain/playbooks/repository.ts` and `harness/host/src/domain/playbooks/repository.ts`: every `.insert(playbookRuns).values(...)` gains `client`, and every `.select()`/`.update()` over `playbookRuns` gains `eq(playbookRuns.client, <the client in hand>)` beside its existing predicate. `claimDuePlaybooks` already takes `{ client, now }`; the join to `playbooks` stays and the column predicate is added beside it, with the same belt-and-braces comment as Step 3. The two kernel tools that request and read playbook runs (`playbooks_run_now`, `playbooks_status`) pass `deps.client`.

In `harness/host/src/domain/kernel.ts`, `finishKernel` gains the client and passes it through:

```ts
export async function finishKernel(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date,
  close: () => Promise<void>,
): Promise<void> {
```

and `openKernel`'s returned `close(status)` passes `host.client`. In `harness/host/src/domain/conversation.ts`, every `appendMessage` call gains `client: host.client` and every `recentHistory` call gains `host.client` as its second argument.

- [ ] **Step 8: Run the four suites to verify they pass**

Run:
```bash
pnpm --filter @harness/core-tools exec vitest run src/domain/session src/domain/tooling/reconcile.test.ts src/domain/playbooks
pnpm --filter @harness/host exec vitest run src/domain/threads src/domain/playbooks src/domain/api
```
Expected: PASS.

- [ ] **Step 9: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 10: Commit**

```bash
git add harness/core-tools/src harness/host/src
git commit -m "feat(db): scope every repository, closeRun and reconcile to the tenant that owns the rows"
```

---

### Task 6: The host becomes a factory with tenants — `createHost`, `Tenant`, `ClientResolver`, invariants 13 and 19

**Files:**
- Create: `harness/host/src/domain/tenancy/specifiers.ts` + `specifiers.test.ts`, `resolver-types.ts`, `types.ts`, `resolver.ts` + `resolver.test.ts`, `skills.ts` + `skills.test.ts`, `tenant.ts`, `pool.ts` + `pool.test.ts`, `isolation.test.ts`
- Modify: `harness/host/src/app/main.ts` (reduced to a thin entrypoint), `harness/host/src/index.ts`, `harness/host/src/testing.ts`
- Modify: `harness/host/src/domain/conversation.ts` (`attachMessageHandlers`), `harness/host/src/domain/api/routes.ts`, `domain/api/server.ts`, `domain/api/types.ts`, `harness/host/src/domain/skills.ts`
- Modify: `harness/surface-api/src/types.ts` (`MessageEvent.tenantHint`), `harness/surface-api/src/testing.ts` (`MemorySurface` passes it)
- Create: `runtimes/scripted/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/index.test.ts`, plus one `PACKAGES` row and one `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs` and one `pnpm-workspace.yaml` line (decision 14; `ls runtimes/` shows only `deepagents`, so it does not exist yet)
- Modify: `harness/host/package.json` (**`"@harness/runtime-scripted": "workspace:*"` in `devDependencies`** — `createHost` resolves the bare specifier through `node_modules`, and every shipped plug-in the host can load is a declared dependency of it today)
- **Delete:** `harness/host/src/domain/persona.ts` and `persona.test.ts` (the persona is a document field, not a file)
- Modify: `.env.example` (**`HARNESS_SURFACES` and `HARNESS_RUNTIME` removed** — `HARNESS_IDENTITY` went in Task 4, both readers and both files), `harness/compose/docker-compose.yml` (the same two; the second of the three Compose re-records, after Task 4 and before Task 9), `docs/architecture/compose-surface.yaml`

**Interfaces:**
- Consumes: `ConfigSource`, `ClientDocument`, `surfaceNamesOf`, `tenantKeysOf`, `parsePlaybooksFile` (`@harness/config-api`); `buildKernelConfig`, `loadConfigSource`, `configSourceNameFrom`, `loadIdentity`, `assertEmbedDims` (`@harness/core-tools`); `loadSurfaces`, `startRunner`, `registerApprovalHandlers`, `surfaceSinks`, `collectHealth`, `startHealthServer` (`@harness/approvals`); `parseIdentityFileWithDefaults` (`@harness/identity-api`).
- Produces, from `@harness/host`:
  - `identitySpecifier(kind): string`, `runtimeSpecifier(name): string`, `surfaceSpecifier(name): string`
  - `type InboundRef = { from: 'surface'; surface: string; tenantHint: string | null } | { from: 'api'; clientId: string | null }` — declared in `tenancy/resolver-types.ts`, the leaf, and re-exported from `tenancy/types.ts`
  - `interface ClientResolver { readonly mode: 'dedicated' | 'pooled'; resolve(ref: InboundRef): string | null }` — same leaf, same re-export
  - `dedicatedResolver(clientId, keysOf): ClientResolver`, `pooledResolver(lookup): ClientResolver`
  - `interface Tenant { clientId; version; document; host: Host; runner; scheduler; close(): Promise<void> }`
  - `interface HostPool { db; log; now; env; source; resolver; tenants: ReadonlyMap<string, Tenant>; tenantFor(clientId): Promise<Tenant | null>; invalidate(clientId): Promise<void>; drain(boundMs): Promise<void>; close(): Promise<void>; draining: boolean }`
  - `createHost(deps: HostDeps): Promise<HostPool>` where `HostDeps = { db: Db; env: EnvSource; log: Logger; now: () => Date; source: ConfigSource; dedicatedClient: string | null }`
  - `openTenant(pool: HostPool, loaded: LoadedDocument): Promise<Tenant>`
  - `materialiseSkills(document, root): Promise<string>`
  - `attachMessageHandlers(pool: { db: Db; log: Logger; resolver: ClientResolver }, tenant: { clientId: string; host: Host }): void` — **the signature changes**, and both parameters are structural so that `conversation.ts` imports no tenancy module but the leaf
  - `startRunApi(pool, opts)` and `handleApiRequest(pool, req, res, opts)` — **both change**
- From `@harness/surface-api`: `MessageEvent.tenantHint?: string`

- [ ] **Step 1: Write the failing specifier and resolver tests**

Create `harness/host/src/domain/tenancy/specifiers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { identitySpecifier, runtimeSpecifier, surfaceSpecifier } from './specifiers.js';

describe('plug-in specifiers', () => {
  it('derives a package name from the name the document gave', () => {
    expect(surfaceSpecifier('memory')).toBe('@harness/surface-memory');
    expect(identitySpecifier('static')).toBe('@harness/identity-static');
    expect(runtimeSpecifier('scripted')).toBe('@harness/runtime-scripted');
  });

  it('refuses a name that is not one, rather than building a specifier out of it', () => {
    for (const bad of ['../evil', 'Memory', '', '@harness/surface-memory', 'a/b']) {
      expect(() => surfaceSpecifier(bad), bad).toThrow(ConfigError);
    }
  });
});
```

Create `harness/host/src/domain/tenancy/resolver.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { dedicatedResolver, pooledResolver } from './resolver.js';

const keysOf = (clientId: string) =>
  clientId === 'alpha' ? [{ surface: 'slack', key: 'T-ALPHA' }] : [{ surface: 'slack', key: 'T-BETA' }];

describe('dedicatedResolver', () => {
  const resolver = dedicatedResolver('alpha', keysOf);

  it('answers its own client for an event that names no workspace', () => {
    expect(resolver.mode).toBe('dedicated');
    expect(resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBe('alpha');
    expect(resolver.resolve({ from: 'api', clientId: null })).toBe('alpha');
  });

  it('answers its own client for its own workspace', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-ALPHA' })).toBe('alpha');
    expect(resolver.resolve({ from: 'api', clientId: 'alpha' })).toBe('alpha');
  });

  it('refuses any other workspace and any other client id (invariant 19)', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-BETA' })).toBeNull();
    expect(resolver.resolve({ from: 'api', clientId: 'beta' })).toBeNull();
  });
});

describe('pooledResolver', () => {
  const resolver = pooledResolver((surface, key) => (surface === 'slack' && key === 'T-BETA' ? 'beta' : null));

  it('takes the client from the workspace the event names', () => {
    expect(resolver.mode).toBe('pooled');
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-BETA' })).toBe('beta');
  });

  it('takes the client from the run API header, because a caller names it directly', () => {
    expect(resolver.resolve({ from: 'api', clientId: 'beta' })).toBe('beta');
  });

  it('refuses an event that names no workspace, because a pool cannot guess', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBeNull();
    expect(resolver.resolve({ from: 'api', clientId: null })).toBeNull();
  });

  it('refuses a workspace nobody claims', () => {
    expect(resolver.resolve({ from: 'surface', surface: 'slack', tenantHint: 'T-NOBODY' })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm --filter @harness/host exec vitest run src/domain/tenancy`
Expected: FAIL — neither module exists.

- [ ] **Step 3: Write the specifiers and the resolver**

Create `harness/host/src/domain/tenancy/specifiers.ts`:

```ts
import { ConfigError } from '@harness/shared';

/** A plug-in name: the same rule `defineSurface`, `defineIdentityProvider` and `defineRuntime` apply. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * The package a plug-in name resolves to.
 *
 * **The specifier is built here and written nowhere.** A client document names its surfaces, its
 * identity provider and its runtime by *name* — `memory`, `static`, `deepagents` — and this turns
 * a name into `@harness/<kind>-<name>` with a template. That is not an aesthetic choice: the
 * vocabulary scan of `harness/host/src` forbids a messaging vendor's name and an agent
 * framework's name in host source, precisely so that the one process every client runs cannot
 * learn which transport or which framework it is serving. A literal here would be that coupling,
 * written down.
 *
 * A name that is not a plug-in name is refused rather than joined into a specifier: the document
 * is data a tenant wrote, and `import('@harness/surface-../../evil')` is a thing a template will
 * happily build.
 */
function specifierFor(kind: 'surface' | 'identity' | 'runtime', name: string): string {
  if (!PLUGIN_NAME.test(name)) {
    throw new ConfigError(`"${name}" is not a ${kind} name; one is lowercase letters, digits and hyphens`);
  }
  return `@harness/${kind}-${name}`;
}

export const surfaceSpecifier = (name: string): string => specifierFor('surface', name);
export const identitySpecifier = (kind: string): string => specifierFor('identity', kind);
export const runtimeSpecifier = (name: string): string => specifierFor('runtime', name);
```

Create `harness/host/src/domain/tenancy/resolver-types.ts`:

```ts
/**
 * What a resolver is, and what it is handed — and **nothing else**.
 *
 * This module is a leaf: it imports no host module, not even a type. That is what lets
 * `conversation.ts` name a `ClientResolver` without the graph closing on itself.
 * `tenancy/types.ts` imports `playbooks/scheduler.ts` for `SchedulerHandle`, and
 * `playbooks/scheduler.ts` imports `conversation.ts` for `runTurn`; `.dependency-cruiser.cjs`
 * sets `tsPreCompilationDeps: true`, so a type-only import is an edge like any other, and
 * `no-circular` is an error. Keeping these two declarations out here is what keeps `pnpm arch`
 * green.
 */

/** Where an inbound thing came from, and what it said about which tenant it belongs to. */
export type InboundRef =
  | {
      from: 'surface';
      surface: string;
      /**
       * Whatever identifies the workspace the event came from, in that surface's own terms, or
       * null for a surface that has no such notion. Opaque here on purpose.
       */
      tenantHint: string | null;
    }
  | { from: 'api'; clientId: string | null };

export interface ClientResolver {
  readonly mode: 'dedicated' | 'pooled';
  /** The client this belongs to, or null — which is a refusal, and is audited. */
  resolve(ref: InboundRef): string | null;
}
```

Create `harness/host/src/domain/tenancy/resolver.ts`:

```ts
import type { ClientResolver, InboundRef } from './resolver-types.js';

/**
 * One client, and nothing else (spec §4.2, invariant 19).
 *
 * `HARNESS_CLIENT` set means this process belongs to one tenant. An event that names no workspace
 * is that tenant's by construction — its own surfaces are the only ones connected. An event that
 * *does* name one is checked against the tenant's own keys, so a misrouted event from another
 * workspace is refused and audited rather than answered with this tenant's data.
 */
export function dedicatedResolver(
  clientId: string,
  keysOf: (clientId: string) => readonly { surface: string; key: string }[],
): ClientResolver {
  return {
    mode: 'dedicated',
    resolve(ref: InboundRef): string | null {
      if (ref.from === 'api') return ref.clientId === null || ref.clientId === clientId ? clientId : null;
      if (ref.tenantHint === null) return clientId;
      const mine = keysOf(clientId).some((k) => k.surface === ref.surface && k.key === ref.tenantHint);
      return mine ? clientId : null;
    },
  };
}

/**
 * Many clients, each named by the event that arrived (spec §3.4).
 *
 * `lookup` answers which client claims a surface's workspace key; the pool builds it from every
 * loaded document's `tenantKeysOf`, so nothing here reads a vendor's field. An event that names no
 * workspace is refused rather than guessed at: a pool that picked a tenant because it only had one
 * would answer with the wrong one the day it had two.
 */
export function pooledResolver(lookup: (surface: string, key: string) => string | null): ClientResolver {
  return {
    mode: 'pooled',
    resolve(ref: InboundRef): string | null {
      if (ref.from === 'api') return ref.clientId;
      if (ref.tenantHint === null) return null;
      return lookup(ref.surface, ref.tenantHint);
    },
  };
}
```

Create `harness/host/src/domain/tenancy/types.ts`:

```ts
import type { ConfigSource, ClientDocument, LoadedDocument } from '@harness/config-api';
import type { startRunner } from '@harness/approvals';
import type { Db } from '@harness/db';
import type { EnvSource, Logger } from '@harness/shared';
import type { Host } from '../host.js';
import type { SchedulerHandle } from '../playbooks/scheduler.js';
import type { ClientResolver } from './resolver-types.js';

/**
 * `InboundRef` and `ClientResolver` are declared in `./resolver-types.js` and re-exported here, so
 * that a caller has one place to import a tenancy type from while `conversation.ts` — which needs
 * only the resolver — can import the leaf and stay out of the cycle this module is part of (this
 * file reaches `playbooks/scheduler.ts`, which reaches `conversation.ts`).
 */
export type { ClientResolver, InboundRef } from './resolver-types.js';

/**
 * One client, running.
 *
 * `host` is the whole of what every host function already takes: its own database handle, its own
 * `KernelConfig`, its own identity session, its own surfaces with their own primary, its own
 * runtime, persona, skills, model and budget. Two tenants are two of these, which is what makes
 * invariant 13 a property of the structure rather than of a predicate somebody remembered to
 * write. `version` is what the pool caches by and what `ConfigSource.watch` moves.
 */
export interface Tenant {
  readonly clientId: string;
  readonly version: string;
  readonly document: ClientDocument;
  readonly host: Host;
  readonly runner: Awaited<ReturnType<typeof startRunner>>;
  readonly scheduler: SchedulerHandle;
  /** Stop everything this tenant holds, in the order a shutdown needs. Never throws. */
  close(): Promise<void>;
}

export interface HostDeps {
  db: Db;
  env: EnvSource;
  log: Logger;
  now: () => Date;
  source: ConfigSource;
  /** `HARNESS_CLIENT` when it is set: this host serves that client and refuses every other. */
  dedicatedClient: string | null;
}

/** Every tenant this process is serving, and the one way to reach another. */
export interface HostPool extends HostDeps {
  readonly resolver: ClientResolver;
  readonly tenants: ReadonlyMap<string, Tenant>;
  /** The tenant for a client id, opening it if the source has one. Null when nobody does. */
  tenantFor(clientId: string): Promise<Tenant | null>;
  /** Drop a tenant whose document moved, after its turns in flight have drained. */
  invalidate(clientId: string): Promise<void>;
  /** Abort every tenant's turns in flight and wait for them, bounded. */
  drain(boundMs: number): Promise<void>;
  close(): Promise<void>;
  draining: boolean;
}

export type { LoadedDocument };
```

- [ ] **Step 4: Run the two tests to verify they pass**

Run: `pnpm --filter @harness/host exec vitest run src/domain/tenancy/specifiers.test.ts src/domain/tenancy/resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing skills-materialiser test**

Create `harness/host/src/domain/tenancy/skills.test.ts`:

```ts
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { readSkillCatalogue } from '../skills.js';
import { materialiseSkills } from './skills.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function root(): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'harness-skills-'));
  roots.push(dir);
  return dir;
}

const SKILL = '---\nname: onboarding\ndescription: Do the thing\nversion: 1.0.0\n---\n\nSteps.\n';

describe('materialiseSkills', () => {
  it('writes one directory per skill, which readSkillCatalogue then reads', async () => {
    const document = parseClientDocument(fixtureDocument({ skills: { onboarding: SKILL } }));
    const dir = await materialiseSkills(document, await root());
    expect(await readFile(path.join(dir, 'onboarding', 'SKILL.md'), 'utf8')).toBe(SKILL);
    const catalogue = await readSkillCatalogue([dir]);
    expect(catalogue.map((skill) => skill.name)).toEqual(['onboarding']);
    expect(catalogue[0].version).toBe('1.0.0');
  });

  it('gives a client with no skill an empty directory rather than no directory', async () => {
    const dir = await materialiseSkills(parseClientDocument(fixtureDocument()), await root());
    expect(await readSkillCatalogue([dir])).toEqual([]);
  });

  it('refuses a skill whose frontmatter name is not the key it was filed under', async () => {
    const document = parseClientDocument(fixtureDocument({ skills: { intake: SKILL } }));
    const dir = await materialiseSkills(document, await root());
    // `readSkillCatalogue` is what catches it, which is the point: a document's skill is validated
    // exactly as a pack's is (spec section 12, item 8).
    await expect(readSkillCatalogue([dir])).rejects.toThrow(ConfigError);
  });

  it("writes one client's skills where another client's cannot be read", async () => {
    const base = await root();
    const alpha = await materialiseSkills(
      parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'A', skills: { onboarding: SKILL } })),
      base,
    );
    const beta = await materialiseSkills(
      parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'B' })),
      base,
    );
    expect(alpha).not.toBe(beta);
    expect(await readSkillCatalogue([beta])).toEqual([]);
  });
});
```

- [ ] **Step 6: Write the materialiser**

Create `harness/host/src/domain/tenancy/skills.ts`:

```ts
import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ClientDocument } from '@harness/config-api';

/**
 * A client's skills, on disk, because that is what a runtime is handed.
 *
 * `RunSkill.dir` is a directory the runtime reads files from, and `readSkillCatalogue` requires a
 * `SKILL.md` whose frontmatter `name` matches its directory's name. A document carries skills as
 * `name → markdown`, which is the right shape for a store and the wrong one for a plug-in, so
 * each entry is written to `<root>/<clientId>/<name>/SKILL.md` before the catalogue is read.
 * Validation is `readSkillCatalogue`'s, unchanged: a document's skill is checked exactly as a
 * pack's is.
 *
 * The directory is rebuilt from scratch every time, so a skill removed from the document is gone
 * from disk, and it is per client, so one tenant's skills are never in another's catalogue.
 */
export async function materialiseSkills(document: ClientDocument, root: string): Promise<string> {
  const dir = path.join(root, document.id);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  for (const [name, markdown] of Object.entries(document.skills)) {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, 'SKILL.md'), markdown, 'utf8');
  }
  return dir;
}
```

Run: `pnpm --filter @harness/host exec vitest run src/domain/tenancy/skills.test.ts`
Expected: PASS.

- [ ] **Step 7: Write `openTenant`**

Create `harness/host/src/domain/tenancy/tenant.ts`:

```ts
import path from 'node:path';
import {
  createInProcessCoreToolsClient,
  loadSurfaces,
  registerApprovalHandlers,
  startRunner,
  surfaceSinks,
} from '@harness/approvals';
import { surfaceNamesOf } from '@harness/config-api';
import { buildKernelConfig, loadIdentity, reconcile } from '@harness/core-tools';
import { outRoot } from '@harness/core-tools/storage';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { ConfigError, numberFromEnv, envOrDefault, describeError } from '@harness/shared';
import { TIMEOUT_MARGIN_MS } from '../conversation.js';
import type { Host } from '../host.js';
import { syncPlaybooks } from '../playbooks/repository.js';
import { SCHEDULER_TICK_MS, startScheduler } from '../playbooks/scheduler.js';
import { decisionDeps } from '../resume.js';
import { loadRuntime } from '../runtime/registry.js';
import { kernelSkillsDir, readSkillCatalogue } from '../skills.js';
import { materialiseSkills } from './skills.js';
import { identitySpecifier, runtimeSpecifier, surfaceSpecifier } from './specifiers.js';
import type { HostPool, LoadedDocument, Tenant } from './types.js';

/** Where a tenant's skills are written, under the deployment's own storage root. */
const SKILLS_SUBDIR = 'skills';

/**
 * Check that every secret the document *refers to* is actually present.
 *
 * A `SecretRef` names an environment variable; the value stays in the process environment and
 * reaches the surface through `deps.env`, exactly as it does today. What the document adds is the
 * chance to fail at load, naming the tenant and the variable, instead of at the first message
 * with a transport error nobody can attribute.
 */
function assertSecretsPresent(document: LoadedDocument['document'], env: Record<string, string | undefined>): void {
  const slack = document.surfaces.slack;
  const refs = slack ? [slack.signingSecret, slack.botToken] : [];
  for (const ref of refs) {
    if ((env[ref.env] ?? '').trim() === '') {
      throw new ConfigError(`client "${document.id}" needs ${ref.env}, which this deployment does not set`);
    }
  }
}

/**
 * Open one client: its configuration, its plug-ins, its playbooks, its loops.
 *
 * Everything a `Host` holds, built from the resolved document and from the deployment's own
 * environment — and nothing shared with another tenant but the database handle, the logger and
 * the clock. The order is the order `app/main.ts` had, and for the same reasons: identity first
 * because the host's own principal has to be declared; playbooks before a surface connects, so a
 * malformed schedule fails with no socket open; the runtime last before the object is built.
 */
export async function openTenant(pool: HostPool, loaded: LoadedDocument): Promise<Tenant> {
  const { document, version } = loaded;
  const env = pool.env as Record<string, string | undefined>;
  const log = pool.log;
  const config = await buildKernelConfig(document, pool.env);
  assertSecretsPresent(document, env);

  const identity = await loadIdentity(identitySpecifier(document.identityProvider.kind), {
    env: pool.env,
    log,
    identity: parseIdentityFileWithDefaults(document.identity),
    settings: document.identityProvider.settings,
  });
  const servicePrincipalId = envOrDefault('HARNESS_HOST_PRINCIPAL', 'svc-host', pool.env);
  const servicePrincipal = await identity.get(servicePrincipalId);
  if (!servicePrincipal || servicePrincipal.kind !== 'service') {
    throw new ConfigError(
      `client "${document.id}": HARNESS_HOST_PRINCIPAL names "${servicePrincipalId}", which the identity plug-in "${identity.name}" does not declare as a service`,
    );
  }

  // The document into the table, once per open, and before a surface or the runtime connects: a
  // playbook added or removed takes effect when the tenant is next opened, a firing missed while
  // the tenant was closed is not replayed, and a malformed schedule fails here.
  const synced = await syncPlaybooks(
    pool.db,
    { client: config.client, now: pool.now(), file: `client document ${version}` },
    document.playbooks.playbooks,
  );

  const surfaces = await loadSurfaces(surfaceNamesOf(document).map(surfaceSpecifier), {
    env: pool.env,
    log,
    storageDir: config.storageDir,
  });
  const runtime = await loadRuntime(runtimeSpecifier(document.runtime), {
    // The one per-tenant thing a runtime is told. `RuntimeDeps` is `{ env, log, databaseUrl,
    // storageDir }` and a pooled host's process environment has no HARNESS_CLIENT — that is what
    // makes it pooled — so a runtime opened for a tenant reads which tenant off the env it is
    // handed. `runtimes/scripted` (Step 11) is the reason this matters; a model-backed runtime
    // ignores it.
    env: { ...pool.env, HARNESS_CLIENT: config.client },
    log,
    databaseUrl: envOrDefault('DATABASE_URL', '', pool.env),
    storageDir: config.storageDir,
  });

  const skillsDir = await materialiseSkills(document, path.join(config.storageDir, SKILLS_SUBDIR));
  const host: Host = {
    db: pool.db,
    config,
    client: config.client,
    identity,
    surfaces,
    runtime,
    persona: document.persona,
    // The kernel's own skills first, then this client's, then every pack's.
    skills: await readSkillCatalogue([kernelSkillsDir(), skillsDir, ...config.packs.skillsDirs()]),
    model: { baseUrl: config.gateway.baseUrl, apiKey: config.gateway.apiKey, route: 'chat', fallbackRoute: 'reason' },
    budget: {
      maxModelCalls: numberFromEnv('HARNESS_RUN_MAX_MODEL_CALLS', 30, { min: 1, max: 1_000, integer: true }, pool.env),
      maxToolCalls: numberFromEnv('HARNESS_RUN_MAX_TOOL_CALLS', 60, { min: 1, max: 5_000, integer: true }, pool.env),
      timeoutMs:
        numberFromEnv('HARNESS_RUN_TIMEOUT_S', 600, { min: 1, max: 86_400, unit: 'seconds' }, pool.env) * 1000,
      timeoutMarginMs: TIMEOUT_MARGIN_MS,
      maxHistoryMessages: numberFromEnv(
        'HARNESS_HISTORY_MAX_MESSAGES',
        40,
        { min: 0, max: 500, integer: true },
        pool.env,
      ),
    },
    servicePrincipal,
    log,
    now: pool.now,
    active: new Map(),
    turns: new Map(),
    draining: false,
  };

  const core = createInProcessCoreToolsClient({
    db: pool.db,
    config,
    client: config.client,
    servicePrincipal,
  });
  const deps = decisionDeps(host, core);
  for (const session of surfaces.all) registerApprovalHandlers(session, deps);

  const seconds = (name: string, fallback: number): number =>
    numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' }, pool.env);
  const runner = startRunner(
    {
      db: pool.db,
      surfaces,
      core,
      sinks: surfaceSinks(surfaces, { outDir: outRoot(config.storageDir) }),
      client: config.client,
      encryptionKey: config.encryptionKey,
      now: pool.now,
    },
    {
      pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
      dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
      reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
      staleAfterMinutes: 10,
    },
  );
  const scheduler = startScheduler(host, { tickMs: SCHEDULER_TICK_MS });

  // This tenant's own startup repair, scoped to this tenant (Task 5): a pooled host that repaired
  // everything each time a tenant opened would expire one client's approvals because another
  // client's document changed.
  try {
    const repaired = await reconcile(pool.db, { now: pool.now, client: config.client });
    log.info(`reconcile for ${config.client}: ${JSON.stringify(repaired)}`);
  } catch (err) {
    log.warn(`reconcile for ${config.client} failed; continuing: ${describeError(err)}`);
  }

  log.info(
    `tenant ${config.client} open (version=${version}, principal=${servicePrincipal.id}, runtime=${runtime.name}, identity=${identity.name}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation}, skills=${host.skills.length}, playbooks=${synced.upserted})`,
  );

  return {
    clientId: config.client,
    version,
    document,
    host,
    runner,
    scheduler,
    close: async () => {
      const stopping = scheduler.stop();
      await Promise.race([stopping, new Promise<void>((r) => setTimeout(r, 10_000).unref())]);
      await runner.stop();
      for (const session of surfaces.all) await session.stop();
      await runtime.stop();
      await identity.stop();
      await core.close();
    },
  };
}
```

- [ ] **Step 8: Write `createHost`**

Create `harness/host/src/domain/tenancy/pool.ts`:

```ts
import { ConfigError, describeError } from '@harness/shared';
import { tenantKeysOf } from '@harness/config-api';
import { attachMessageHandlers, drainActive } from '../conversation.js';
import { dedicatedResolver, pooledResolver } from './resolver.js';
import { openTenant } from './tenant.js';
import type { ClientResolver, HostDeps, HostPool, Tenant } from './types.js';

/** How long a tenant being evicted is given to finish the turns it has in flight. */
const INVALIDATE_DRAIN_MS = 10_000;

/**
 * The process, as a factory over tenants (spec §4.2).
 *
 * Dedicated (`HARNESS_CLIENT` set) opens exactly one tenant at start and refuses every other.
 * Pooled opens every client the source lists — because in Plan 11a each tenant still connects its
 * own surfaces, so a tenant nobody had opened would have nothing listening for it. Plan 11b's
 * ingress is what turns that into open-on-demand; the `tenantFor` path below is already written
 * for it, and the pooled test drives it directly.
 *
 * `watch` never mutates a live tenant: a version change evicts it once its turns have drained,
 * and the next event opens a fresh one. A turn whose policy changed halfway through it is not a
 * feature anybody asked for.
 */
export async function createHost(deps: HostDeps): Promise<HostPool> {
  const tenants = new Map<string, Tenant>();
  const stopWatching = new Map<string, () => void>();
  /** `<surface>:<key>` → client id, rebuilt whenever a tenant opens or closes. */
  const keys = new Map<string, string>();

  const keysOf = (clientId: string): readonly { surface: string; key: string }[] => {
    const tenant = tenants.get(clientId);
    return tenant ? tenantKeysOf(tenant.document) : [];
  };
  const resolver: ClientResolver =
    deps.dedicatedClient === null
      ? pooledResolver((surface, key) => keys.get(`${surface}:${key}`) ?? null)
      : dedicatedResolver(deps.dedicatedClient, keysOf);

  const pool: HostPool = {
    ...deps,
    resolver,
    tenants,
    draining: false,
    async tenantFor(clientId) {
      const open = tenants.get(clientId);
      if (open) return open;
      if (pool.draining) return null;
      if (resolver.resolve({ from: 'api', clientId }) !== clientId) return null;
      const loaded = await deps.source.load(clientId);
      if (!loaded) return null;
      const tenant = await openTenant(pool, loaded);
      tenants.set(clientId, tenant);
      for (const { surface, key } of tenantKeysOf(tenant.document)) keys.set(`${surface}:${key}`, clientId);
      attachMessageHandlers(pool, tenant);
      for (const session of tenant.host.surfaces.all) await session.start();
      const stop = deps.source.watch?.(clientId, (version) => {
        if (version === tenant.version) return;
        deps.log.info(`tenant ${clientId}: document moved to ${version}; reopening`);
        void pool.invalidate(clientId).catch((err: unknown) => {
          deps.log.error(`tenant ${clientId}: could not reopen: ${describeError(err)}`);
        });
      });
      if (stop) stopWatching.set(clientId, stop);
      return tenant;
    },
    async invalidate(clientId) {
      const tenant = tenants.get(clientId);
      if (!tenant) return;
      tenants.delete(clientId);
      for (const { surface, key } of tenantKeysOf(tenant.document)) keys.delete(`${surface}:${key}`);
      stopWatching.get(clientId)?.();
      stopWatching.delete(clientId);
      await drainActive(tenant.host, INVALIDATE_DRAIN_MS);
      await tenant.close();
      // Only after it is shut: a pooled host that reopened while the old one was still draining
      // would have two runtimes and two schedulers for one client.
      if (!pool.draining) await pool.tenantFor(clientId);
    },
    async drain(boundMs) {
      pool.draining = true;
      await Promise.all([...tenants.values()].map((tenant) => drainActive(tenant.host, boundMs)));
    },
    async close() {
      pool.draining = true;
      for (const stop of stopWatching.values()) stop();
      stopWatching.clear();
      for (const tenant of tenants.values()) await tenant.close();
      tenants.clear();
      keys.clear();
      await deps.source.close?.();
    },
  };

  if (deps.dedicatedClient !== null) {
    const tenant = await pool.tenantFor(deps.dedicatedClient);
    if (!tenant) {
      throw new ConfigError(
        `HARNESS_CLIENT names "${deps.dedicatedClient}", which the ${deps.source.name} config source does not hold`,
      );
    }
  } else {
    if (!deps.source.list) {
      throw new ConfigError(
        `HARNESS_CLIENT is unset, so this host is pooled, and the ${deps.source.name} config source cannot list its clients`,
      );
    }
    for (const clientId of await deps.source.list()) await pool.tenantFor(clientId);
    deps.log.info(`pooled host: ${tenants.size} tenants open`);
  }
  return pool;
}
```

- [ ] **Step 9: Change `attachMessageHandlers` and `MessageEvent`**

In `harness/surface-api/src/types.ts`, add to `MessageEvent`, after `mentioned`:

```ts
  /**
   * Whatever identifies the workspace this event came from, in the surface's own terms — the
   * organisation, the team, the tenant of whatever the transport calls one — or absent for a
   * surface with no such notion.
   *
   * Opaque to the host, which matches it against the keys each client's document declares and
   * never reads it as anything but a string. That is how one process serves several clients on
   * one transport without the host learning a vendor's field name.
   */
  tenantHint?: string;
```

In `harness/surface-api/src/testing.ts`, give `MemorySurface` a constructor option `tenantHint?: string` and set it on every event `deliver` produces, so a test can send one tenant's message into another tenant's host.

In `harness/host/src/domain/conversation.ts`, replace `attachMessageHandlers`:

```ts
/**
 * Register the flow on every one of this tenant's surfaces. A handler's failure is logged, never
 * thrown into the adapter.
 *
 * Every event is checked against the pool's resolver before anything else happens. On a dedicated
 * host that is invariant 19: an event whose workspace belongs to another client is refused and
 * audited rather than answered with this client's data. On a pooled host it is the same check
 * from the other side — the surface that delivered the event belongs to this tenant, so an event
 * naming a different workspace has been misrouted and is not this tenant's to answer.
 */
export function attachMessageHandlers(
  pool: { db: Db; log: Logger; resolver: ClientResolver },
  tenant: { clientId: string; host: Host },
): void {
  for (const session of tenant.host.surfaces.all) {
    session.onMessage(async (event) => {
      try {
        const claimed = pool.resolver.resolve({
          from: 'surface',
          surface: event.surface,
          tenantHint: event.tenantHint ?? null,
        });
        if (claimed !== tenant.clientId) {
          await writeAudit(pool.db, {
            client: tenant.clientId,
            caller: `${event.surface}:${event.userId}`,
            tool: 'host_message',
            actionClass: 'read',
            argsHash: hashArgs({ conversation: event.conversation, tenantHint: event.tenantHint ?? null }),
            decision: 'unauthorised',
          });
          pool.log.warn(
            `tenant ${tenant.clientId}: a message on surface "${event.surface}" named another tenant; refused`,
          );
          return;
        }
        await handleMessage(tenant.host, event);
      } catch (err) {
        pool.log.error(`the message handler failed on surface "${session.name}": ${describeError(err)}`);
      }
    });
  }
}
```

**The two parameters are declared structurally, right here, and `conversation.ts` imports neither `HostPool` nor `Tenant`.** `ClientResolver` comes from `./tenancy/resolver-types.js`, the leaf module Step 3 created; `Host` is already imported from `./host.js`; add `type { Db } from '@harness/db'` and `type Logger` to the existing `@harness/shared` import, both of which this file's new body needs anyway for `writeAudit(pool.db, …)` and `pool.log.warn`. `pool.ts` still calls `attachMessageHandlers(pool, tenant)` and passes the whole pool and the whole tenant, which satisfy these shapes structurally.

This is not a stylistic preference, it is what keeps `pnpm arch` green. `tenancy/types.ts` imports `SchedulerHandle` from `playbooks/scheduler.ts`, and `playbooks/scheduler.ts` imports `runTurn`, `serialize`, `RUNTIME_FAILED`, `TurnDelivery`, `TurnInput` and `TurnResult` from `conversation.ts`. An import of `tenancy/types.ts` here — even `import type` — closes the loop `conversation.ts → tenancy/types.ts → playbooks/scheduler.ts → conversation.ts`, and `.dependency-cruiser.cjs` sets `tsPreCompilationDeps: true` with `no-circular` at `severity: 'error'`, so the task would end red. The leaf module imports nothing from the host, so no loop can run through it. **`conversation.ts` may not import `./tenancy/pool.js` or `./tenancy/types.js`.**

- [ ] **Step 10: Make the run API resolve a tenant**

In `harness/host/src/domain/api/types.ts`, **remove `scheduler` from `RunApiOptions`** and add:

```ts
/** The header a caller names its client with, on a pooled host. */
export const CLIENT_HEADER = 'x-harness-client';
```

`scheduler` goes because it is per tenant now, not per process: a pooled host has one scheduler per open tenant and no single one to put in the options a listener was started with. `statusRoute` takes it as an argument instead — `statusRoute(host, res, opts, scheduler)` — and reads `host` for everything else it reports. `RunApiOptions` keeps `token`, `bind` and `port`, which are the listener's and stay one per process. **This is the whole of the change; Step 11 replaces `main.ts` and changes nothing here.**

In `harness/host/src/domain/api/routes.ts`, change `handleApiRequest` to resolve a tenant first and hand its `host` to the route functions, which are otherwise untouched:

```ts
/**
 * Route one request. Every route is behind the bearer check, and then behind the tenant check.
 *
 * `x-harness-client` names the client. On a dedicated host it may be absent, and a value that is
 * not that host's client is refused; on a pooled host it is required, because a pool that picked
 * a tenant for a caller who did not name one would pick the wrong one the day it had two. A
 * refusal is 404 with the same body a nonexistent route gets, so the API never confirms that a
 * client somebody guessed at exists.
 */
export async function handleApiRequest(
  pool: HostPool,
  req: IncomingMessage,
  res: ServerResponse,
  opts: RunApiOptions,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://run-api.invalid');
  const route = url.pathname.replace(/\/+$/, '') || '/';
  if (!bearerOk(req.headers.authorization, opts.token)) return json(res, 401, { error: 'unauthorised' });
  const named = req.headers[CLIENT_HEADER];
  const clientId = typeof named === 'string' && named.trim() !== '' ? named.trim() : null;
  const resolved = pool.resolver.resolve({ from: 'api', clientId });
  const tenant = resolved === null ? null : await pool.tenantFor(resolved);
  if (!tenant) return json(res, 404, { error: 'no such client' });
  const host = tenant.host;
  if (req.method === 'GET' && route === '/v1/status') return statusRoute(host, res, opts, tenant.scheduler);
  if (req.method === 'POST' && route === '/v1/runs') return openRunRoute(host, req, res);
  const cancel = /^\/v1\/runs\/([^/]+)\/cancel$/.exec(route);
  if (req.method === 'POST' && cancel) return cancelRoute(host, url, res, cancel[1]);
  const thread = /^\/v1\/threads\/([^/]+)$/.exec(route);
  if (req.method === 'GET' && thread) return threadRoute(host, url, res, thread[1]);
  return json(res, 404, { error: 'no such route' });
}
```

In `harness/host/src/domain/api/server.ts`, change `startRunApi(host, opts)` to `startRunApi(pool: HostPool, opts: RunApiOptions)` and pass `pool` through to `handleApiRequest`. Update `harness/host/src/domain/api/routes.test.ts` and `server.test.ts`: every call site builds a one-tenant pool through the new `poolFixture` (Step 11) and adds a case asserting that a request naming another client is 404.

- [ ] **Step 11: Replace `app/main.ts` and extend the test fixture**

Replace the whole of `harness/host/src/app/main.ts` with a thin entrypoint:

```ts
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { DEFAULT_HEALTH_BIND, collectHealth, startHealthServer } from '@harness/approvals';
import { assertEmbedDims, configSourceNameFrom, loadConfigSource } from '@harness/core-tools';
import { outRoot, storageRoot } from '@harness/core-tools/storage';
import { createDb } from '@harness/db';
import { createLogger, envOrDefault, numberFromEnv, optionalEnv } from '@harness/shared';
import { startRunApi } from '../domain/api/server.js';
import { DEFAULT_HOST_BIND, DEFAULT_HOST_PORT } from '../domain/api/types.js';
import { SHUTDOWN_DRAIN_MS } from '../domain/conversation.js';
import { createHost } from '../domain/tenancy/pool.js';

const log = createLogger('host');

// src/app -> src -> host -> harness -> <repo>. The .env this deployment was started with; a
// client is not here any more, and nothing below resolves one from this path.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
const now = (): Date => new Date();

const { db, close: closeDb } = createDb();
const storageDir = storageRoot(process.env);
// Belt to the image's braces: the storage volume's layout comes from node.Dockerfile, but an
// operator who mounts a bare directory instead still gets both.
await mkdir(path.join(storageDir, 'incoming'), { recursive: true });
await mkdir(outRoot(storageDir), { recursive: true });
// The knowledge tables' embedding width is fixed by migration 0013; refuse to start rather than
// fail halfway through the first sync. One database, one check, whatever the tenancy.
await assertEmbedDims(db, numberFromEnv('HARNESS_EMBED_DIMS', 1_024, { min: 8, max: 2_000, integer: true }));

const source = await loadConfigSource(configSourceNameFrom(process.env), { env: process.env, log, db });
// Set: a dedicated host, serving one client and refusing every other, with an audit row naming
// both. Unset: a pooled host, resolving the client per event.
const dedicatedClient = (optionalEnv('HARNESS_CLIENT') ?? '').trim() || null;
const pool = await createHost({ db, env: process.env, log, now, source, dedicatedClient });

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  // One tenant: exactly the shape a container health check has always read. Several: the same
  // shape per tenant under `tenants`, because there is no single client to report.
  snapshot: async () => {
    const entries = await Promise.all(
      [...pool.tenants.values()].map(
        async (tenant) => [tenant.clientId, await collectHealth(db, tenant.clientId, tenant.runner, now)] as const,
      ),
    );
    if (dedicatedClient !== null && entries.length === 1) return entries[0][1];
    return { status: entries.every(([, h]) => h.status === 'ok') ? 'ok' : 'degraded', tenants: Object.fromEntries(entries) };
  },
});

// The run API (kernel spec 5.8). No bearer secret, no listener: a control plane that opened a
// socket with no bearer secret because a variable was missing is the failure this avoids.
const hostToken = (optionalEnv('HARNESS_HOST_TOKEN') ?? '').trim();
const runApi =
  hostToken === ''
    ? null
    : startRunApi(pool, {
        token: hostToken,
        bind: envOrDefault('HARNESS_HOST_BIND', DEFAULT_HOST_BIND),
        port: port('HARNESS_HOST_PORT', DEFAULT_HOST_PORT),
      });
if (runApi) await runApi.ready;

log.info(
  `listening (mode=${pool.resolver.mode}, tenants=${[...pool.tenants.keys()].join(',') || 'none'}, runApi=${runApi ? 'on' : 'off (set HARNESS_HOST_TOKEN)'})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    await runApi?.close();
    await pool.drain(SHUTDOWN_DRAIN_MS);
    await pool.close();
    await health.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

(`statusRoute`'s fourth argument and the `RunApiOptions` change were settled in Step 10; nothing about the run API moves here.)

**Delete `harness/host/src/domain/persona.ts` and `persona.test.ts`**; the persona is `document.persona`.

In `harness/host/src/testing.ts`, keep `hostFixture` exactly as it is — every existing host test drives one host and must not move — and add a pool fixture beside it:

```ts
export interface PoolFixture {
  pool: HostPool;
  /** The in-memory source behind the pool, so a test can move a document and invalidate. */
  source: MemoryConfigSource;
  tenant(clientId: string): Tenant;
  surface(clientId: string): MemorySurface;
  close(): Promise<void>;
}

/**
 * A whole pooled host over the real kernel and Postgres, with N tenants.
 *
 * Each tenant gets its own memory surface, its own static identity over its own document, and its
 * own scripted runtime — which is what a real pooled host has, and what makes the isolation test
 * a test of the thing that ships rather than of a fixture that pretends.
 */
export async function poolFixture(
  db: Db,
  opts: {
    documents: readonly ClientDocument[];
    /** Per client id, what its scripted runtime plays back. A client with no entry says nothing. */
    trajectories?: Readonly<Record<string, Trajectory>>;
    dedicated?: string;
    env?: Record<string, string | undefined>;
  },
): Promise<PoolFixture>;
```

Implement it by building a `MemoryConfigSource` over `opts.documents` (each carrying its own `tenantHint`-bearing surface section when the test needs one), calling `createHost` with `{ db, env, log, now, source, dedicatedClient: opts.dedicated ?? null }`, and reaching each tenant's memory surface through `pool.tenants.get(id)!.host.surfaces.find('memory') as MemorySurface`. The env it passes carries `HARNESS_STORAGE_DIR` (a fresh tmpdir), `HARNESS_ENCRYPTION_KEY`, `LITELLM_MASTER_KEY` and nothing else, so no ambient variable reaches a tenant. **Before `createHost`**, it fills the scripted runtime's registry:

```ts
  scriptedTrajectories.clear();
  for (const [clientId, trajectory] of Object.entries(opts.trajectories ?? {})) {
    scriptedTrajectories.set(clientId, trajectory);
  }
```

importing `scriptedTrajectories` from `@harness/runtime-scripted` and `Trajectory` from `@harness/runtime-api/testing`, which `hostFixture` already imports. `close()` clears the registry again, so one test's script cannot reach the next test's tenant.

**`harness/host/src/testing.ts` may import `@harness/surface-memory`, `@harness/identity-static` and `@harness/runtime-scripted`** — `the-host-never-statically-imports-a-plugin` exempts `src/testing.ts` and `*.test.ts` by name, and nothing under `src/app/` or `src/domain/` gains such an import — but `createHost` still reaches every plug-in by *dynamic* import through the specifiers, so the fixture's documents name `memory`, `static` and `scripted`.

**Add the `runtimes/scripted` package** (decision 14; `ls runtimes/` shows only `deepagents`, so it does not exist yet). It is a real plug-in package: a manifest, a `PACKAGES` row and a `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs`, one `pnpm-workspace.yaml` line, and `runtimes/scripted/src/index.ts`:

```ts
import { ScriptedRuntime, type Trajectory } from '@harness/runtime-api/testing';
import type { Runtime, RuntimeDeps, RuntimeSession } from '@harness/runtime-api';

/**
 * What each client's scripted runtime plays back, keyed by client id.
 *
 * A runtime is loaded by *specifier*: the host calls `import('@harness/runtime-scripted')` and is
 * handed `{ runtime }`, and `RuntimeDeps` is `{ env, log, databaseUrl, storageDir }` — there is no
 * channel on it for a test's trajectory, and `the-host-never-statically-imports-a-plugin` forbids
 * handing `createHost` a session a test constructed. So the channel is this module's own state: a
 * test imports this map, fills it before `createHost`, and the dynamic import inside `loadRuntime`
 * resolves **the same module instance** — one workspace package, one specifier, one module record
 * in the loader's registry — so the entry the test wrote is the entry `connect` reads.
 *
 * A client with no entry gets an empty trajectory, which is a runtime that says nothing. That is
 * the right default: most of this plan's tests assert on structure and never drive a turn.
 */
export const scriptedTrajectories = new Map<string, Trajectory>();

export const runtime: Runtime = {
  name: 'scripted',
  version: '0.1.0',
  secrets: [],
  async connect(deps: RuntimeDeps): Promise<RuntimeSession> {
    // Which tenant this session belongs to. `openTenant` overlays it on the env it hands the
    // runtime, because a runtime is loaded once per tenant and this is the only thing it needs to
    // know about which one.
    const clientId = (deps.env.HARNESS_CLIENT ?? '').trim();
    return new ScriptedRuntime(scriptedTrajectories.get(clientId) ?? []);
  },
};
```

with `src/index.test.ts` asserting the two things that make it a plug-in rather than a fake: `connect` with a filled registry returns a session that plays that trajectory back, and `connect` for a client with no entry returns a session whose run ends immediately with no text.

The env overlay that carries the client id is already in `tenant.ts`'s `loadRuntime` call, written in Step 7. `HARNESS_CLIENT` is documented in `.env.example` and keeps its meaning there, so the environment scan over `runtimes/` finds nothing undocumented.

In `harness/host/package.json`, add `"@harness/runtime-scripted": "workspace:*"` to **`devDependencies`**, beside `@harness/pack-healthcare` — `src/testing.ts` imports it statically and `createHost` resolves the bare specifier through `node_modules`, so without the dependency every case in `pool.test.ts` and `isolation.test.ts` fails with `ConfigError: cannot load runtime "@harness/runtime-scripted"`. Then run `pnpm install`.

- [ ] **Step 12: Write the failing tenancy tests**

Create `harness/host/src/domain/tenancy/pool.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { poolFixture } from '../../testing.js';

const { db } = useTestDb();

// Every document here declares the memory surface and nothing else. A Slack surface would make
// `openTenant` demand SLACK_SIGNING_SECRET and SLACK_BOT_TOKEN, and then `loadSurfaces` would open
// a real socket-mode connection from a unit test; decision 6 says plainly that this plan cannot
// serve Slack pooled anyway. `workspace` is the memory surface's tenant key, which is what makes
// pooled routing provable here at all.
const doc = (id: string, workspace?: string) =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { memory: workspace ? { workspace } : {} },
    }),
  );

describe('createHost', () => {
  it('opens exactly the client HARNESS_CLIENT names, and refuses every other (invariant 19)', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')], dedicated: 'alpha' });
    expect([...f.pool.tenants.keys()]).toEqual(['alpha']);
    expect(f.pool.resolver.resolve({ from: 'api', clientId: 'beta' })).toBeNull();
    expect(await f.pool.tenantFor('beta')).toBeNull();
    await f.close();
  });

  it('opens every client the source lists when HARNESS_CLIENT is unset', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')] });
    expect([...f.pool.tenants.keys()].sort()).toEqual(['alpha', 'beta']);
    expect(f.pool.resolver.mode).toBe('pooled');
    await f.close();
  });

  it('gives each tenant its own configuration, its own persona and its own identity session', async () => {
    const f = await poolFixture(db, {
      documents: [
        parseClientDocument(fixtureDocument({ id: 'alpha', displayName: 'A', runtime: 'scripted', persona: 'I am alpha.', surfaces: { memory: {} } })),
        parseClientDocument(fixtureDocument({ id: 'beta', displayName: 'B', runtime: 'scripted', persona: 'I am beta.', surfaces: { memory: {} }, packs: [] })),
      ],
    });
    expect(f.tenant('alpha').host.persona).toBe('I am alpha.');
    expect(f.tenant('beta').host.persona).toBe('I am beta.');
    expect(f.tenant('alpha').host.config.packs.all).toHaveLength(1);
    expect(f.tenant('beta').host.config.packs.all).toEqual([]);
    expect(f.tenant('alpha').host.identity).not.toBe(f.tenant('beta').host.identity);
    await f.close();
  });

  it('routes an event to the tenant whose workspace it names', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha', 'W-ALPHA'), doc('beta', 'W-BETA')] });
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: 'W-BETA' })).toBe('beta');
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: 'W-NOBODY' })).toBeNull();
    // The map the pool built came from each document's `tenantKeysOf`, so a key nobody declared
    // belongs to nobody, and a tenant with no key contributes none.
    expect(f.pool.resolver.resolve({ from: 'surface', surface: 'memory', tenantHint: null })).toBeNull();
    await f.close();
  });

  it('reopens a tenant whose document moved, and keeps the old one out of the map', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha')] });
    const before = f.tenant('alpha');
    f.source.put(parseClientDocument({ ...doc('alpha'), persona: 'Something else.' }), 'v2');
    await f.pool.invalidate('alpha');
    const after = f.tenant('alpha');
    expect(after).not.toBe(before);
    expect(after.host.persona).toBe('Something else.');
    await f.close();
  });
});
```

(`poolFixture` returns its `source` for exactly this case; the `PoolFixture` interface in Step 11 declares it.)

Create `harness/host/src/domain/tenancy/isolation.test.ts`, the invariant-13 suite:

```ts
import { describe, expect, it } from 'vitest';
import { useTestDb } from '@harness/db/testing';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { openKernel } from '../kernel.js';
import { poolFixture } from '../../testing.js';

const { db } = useTestDb();

const doc = (id: string) =>
  parseClientDocument(
    fixtureDocument({ id, displayName: id, runtime: 'scripted', surfaces: { memory: {} } }),
  );

/** One run's kernel client for a tenant, as the tenant's own coordinator. */
async function kernelFor(f: Awaited<ReturnType<typeof poolFixture>>, clientId: string) {
  const host = f.tenant(clientId).host;
  const principal = (await host.identity.get('u-coordinator'))!;
  return openKernel(host, { principal, threadId: null, surface: null, conversation: null });
}

describe('two tenants in one host (invariant 13)', () => {
  it('returns no record, field, memory entry, knowledge chunk, approval, thread or playbook of one to the other', async () => {
    const f = await poolFixture(db, { documents: [doc('alpha'), doc('beta')] });
    const alpha = await kernelFor(f, 'alpha');
    const beta = await kernelFor(f, 'beta');
    try {
      // Alpha writes one of each, through the real kernel tools.
      const created = await alpha.client.callTool({
        name: 'records_create',
        arguments: { pack: 'healthcare', kind: 'provider', external_id: 'p-1' },
      });
      const recordId = (created.structuredContent as { record_id: string }).record_id;
      await alpha.client.callTool({
        name: 'records_update',
        arguments: { record_id: recordId, fields: [{ name: 'first_name', value: 'Ada' }] },
      });
      await alpha.client.callTool({
        name: 'memory_write',
        arguments: { scope: 'client', text: 'Alpha closes at five.', idempotency_key: 'm-1' },
      });
      await alpha.client.callTool({
        name: 'playbooks_status',
        arguments: {},
      });

      // Beta asks every read the kernel publishes, and sees none of it.
      const found = await beta.client.callTool({ name: 'records_find', arguments: { pack: 'healthcare', kind: 'provider', query: 'p-1' } });
      expect((found.structuredContent as { records: unknown[] }).records).toEqual([]);
      const read = await beta.client.callTool({ name: 'records_read', arguments: { record_id: recordId } });
      expect(read.isError ?? false).toBe(true);
      const recalled = await beta.client.callTool({ name: 'memory_search', arguments: { query: 'closes at five' } });
      expect((recalled.structuredContent as { entries: unknown[] }).entries).toEqual([]);
      const known = await beta.client.callTool({ name: 'knowledge_search', arguments: { query: 'closes at five' } });
      expect((known.structuredContent as { hits: unknown[] }).hits).toEqual([]);
      const audited = await beta.client.callTool({ name: 'audit_search', arguments: { limit: 50 } });
      expect(JSON.stringify(audited.structuredContent)).not.toContain('Ada');
      const sessions = await beta.client.callTool({ name: 'session_search', arguments: { query: 'Alpha' } });
      expect(JSON.stringify(sessions.structuredContent)).not.toContain('Alpha closes');
      const approvals = await beta.client.callTool({ name: 'approvals_list', arguments: {} });
      expect((approvals.structuredContent as { approvals: unknown[] }).approvals).toEqual([]);
      const playbooks = await beta.client.callTool({ name: 'playbooks_status', arguments: {} });
      expect(JSON.stringify(playbooks.structuredContent)).not.toContain('alpha');
    } finally {
      await alpha.close('done');
      await beta.close('done');
      await f.close();
    }
  });
});
```

**Before writing this file, read `docs/architecture/tool-surface.json` and use the real tool names and the real argument and result field names** — the eight reads above are the ones this invariant is about, and a name that does not match the snapshot is a test that passes for the wrong reason. If a published read tool is missing from the list, add it: the invariant is "every kernel tool", and the suite is what makes that true.

- [ ] **Step 13: Run the tenancy suites to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/tenancy
```
Expected: PASS.

- [ ] **Step 14: Delete the last three variables**

From `.env.example`, delete the whole `# --- Messaging surfaces ---` block's `HARNESS_SURFACES=` line and the paragraph that explains the ordering, replacing them with: "Which surfaces a client serves, and in what order, is its document's `surfaces` section; the first one the schema lists is the primary, and the run API surface is always last because it cannot post an approval card." Delete the `HARNESS_RUNTIME=` line and its comment, replacing them with: "Which runtime plug-in owns the loop is the client document's `runtime`." From `harness/compose/docker-compose.yml`'s `host` service, delete `HARNESS_SURFACES:` and `HARNESS_RUNTIME:`. Confirm with:

```bash
grep -rn 'HARNESS_SURFACES\|HARNESS_RUNTIME\|HARNESS_IDENTITY\b\|HARNESS_PACKS\|HARNESS_POLICY_FILE\|HARNESS_IDENTITY_FILE' \
  --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=drizzle .
```

Expected: no hit in `*.ts`, `.env.example`, `.env.ci` or `docker-compose.yml`. Hits in `docs/` are Task 10's to fix, and hits in this plan file are the plan describing the deletion.

Re-record the Compose snapshot, as Task 4 did — the second of this plan's three re-records:

```bash
pnpm surface:record
git diff --stat docs/architecture
```

Expected: only `compose-surface.yaml` moved.

- [ ] **Step 15: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green.

- [ ] **Step 16: Commit**

```bash
git add harness/host harness/surface-api runtimes .dependency-cruiser.cjs pnpm-workspace.yaml \
  pnpm-lock.yaml .env.example harness/compose/docker-compose.yml docs/architecture/compose-surface.yaml
git commit -m "feat(host): serve a tenant per run from a client document and refuse every other one"
```

---

### Task 7: The surface directory, and `identities/slack-groups`

**Files:**
- Create: `harness/shared/src/directory.ts`; modify `harness/shared/src/index.ts`
- Modify: `harness/surface-api/src/types.ts` (`SurfaceSession.directory?`), `harness/identity-api/src/types.ts` (`IdentityDeps.directories`)
- Modify: `surfaces/slack/src/transport/types.ts` (two `SlackApi` groups), `web-client.ts`, `fake.ts`, `src/session.ts`, `src/index.ts`
- Create: `surfaces/slack/src/directory.ts` + `directory.test.ts`
- Create: `identities/slack-groups/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/settings.ts`, `src/index.ts`, `src/index.test.ts`
- Modify: `harness/host/src/domain/tenancy/tenant.ts` (wires `directories`), `harness/core-tools/src/domain/identity/registry.test.ts`, `identities/static/src/index.test.ts` (the new `IdentityDeps` member)
- Modify: `.dependency-cruiser.cjs`, `pnpm-workspace.yaml`, `harness/core-tools/src/kernel-vocabulary.test.ts`

**Interfaces:**
- Produces, from `@harness/shared`:
  ```ts
  export interface SurfaceDirectory {
    /** The group ids this user belongs to on that surface. Empty when the user is in none. */
    groupsOf(userId: string): Promise<string[]>;
    /** How that surface says this user is called, or null when it will not say. */
    displayNameOf(userId: string): Promise<string | null>;
  }
  ```
- Produces, from `@harness/surface-api`: `SurfaceSession.directory?: SurfaceDirectory`
- Produces, from `@harness/identity-api`: `IdentityDeps.directories: Readonly<Record<string, SurfaceDirectory>>`
- Produces, from `surfaces/slack`: `SlackApi.usergroups.list`, `SlackApi.usergroups.users.list`, `SlackApi.users.info`; `slackDirectory(api, opts): SurfaceDirectory`
- Produces, from `identities/slack-groups`: `identity: IdentityProvider` named `slack-groups`; `SlackGroupsSettings` and `parseSlackGroupsSettings(raw)`

- [ ] **Step 1: Write the failing directory test**

Create `surfaces/slack/src/directory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { FakeSlack } from './transport/fake.js';
import { slackDirectory } from './directory.js';

describe('slackDirectory', () => {
  it('answers the groups a user is in, from the two calls it takes to find out', async () => {
    const api = new FakeSlack();
    api.usergroupsList = [{ id: 'S-LEADS' }, { id: 'S-STAFF' }];
    api.usergroupMembers = { 'S-LEADS': ['U1'], 'S-STAFF': ['U1', 'U2'] };
    const directory = slackDirectory(api, { now: () => new Date('2026-09-19T00:00:00Z'), cacheMs: 60_000 });
    expect((await directory.groupsOf('U1')).sort()).toEqual(['S-LEADS', 'S-STAFF']);
    expect(await directory.groupsOf('U2')).toEqual(['S-STAFF']);
    expect(await directory.groupsOf('U9')).toEqual([]);
  });

  it('reads the list once per cache window, not once per caller', async () => {
    const api = new FakeSlack();
    api.usergroupsList = [{ id: 'S-LEADS' }];
    api.usergroupMembers = { 'S-LEADS': ['U1'] };
    let clock = new Date('2026-09-19T00:00:00Z');
    const directory = slackDirectory(api, { now: () => clock, cacheMs: 60_000 });
    await directory.groupsOf('U1');
    await directory.groupsOf('U2');
    expect(api.usergroupsListCalls).toBe(1);
    clock = new Date('2026-09-19T00:02:00Z');
    await directory.groupsOf('U1');
    expect(api.usergroupsListCalls).toBe(2);
  });

  it('answers a display name, and null rather than an empty one', async () => {
    const api = new FakeSlack();
    api.users = { U1: { real_name: 'Ada Lovelace' }, U2: {}, U3: { real_name: '   ' } };
    const directory = slackDirectory(api, { now: () => new Date(), cacheMs: 60_000 });
    expect(await directory.displayNameOf('U1')).toBe('Ada Lovelace');
    expect(await directory.displayNameOf('U2')).toBeNull();
    expect(await directory.displayNameOf('U3')).toBeNull();
    expect(await directory.displayNameOf('U9')).toBeNull();
  });

  it('raises the workspace refusal by name rather than answering an empty list of groups', async () => {
    const api = new FakeSlack();
    api.failWith = 'missing_scope';
    const directory = slackDirectory(api, { now: () => new Date(), cacheMs: 60_000 });
    await expect(directory.groupsOf('U1')).rejects.toThrow(/missing_scope/);
  });
});
```

- [ ] **Step 2: Add the three API methods and the fake's half of them**

In `surfaces/slack/src/transport/types.ts`, add two groups to `SlackApi` and the three payload types beside the others:

```ts
export interface SlackUsergroup {
  id: string;
}
export interface SlackUsergroupsListResult {
  usergroups?: SlackUsergroup[];
}
export interface SlackUsergroupUsersResult {
  users?: string[];
}
export interface SlackUserInfoResult {
  user?: { real_name?: string; profile?: { display_name?: string; real_name?: string } };
}
```

and, inside `SlackApi`:

```ts
  /** User groups, which is how a workspace says who is a lead and who is not. */
  usergroups: {
    list(): Promise<SlackUsergroupsListResult>;
    users: { list(args: { usergroup: string }): Promise<SlackUsergroupUsersResult> };
  };
  users: {
    info(args: { user: string }): Promise<SlackUserInfoResult>;
  };
```

In `surfaces/slack/src/transport/web-client.ts`, add the adapters:

```ts
    usergroups: {
      list: () => client.usergroups.list({}),
      users: { list: (args) => client.usergroups.users.list({ usergroup: args.usergroup }) },
    },
    users: {
      // Narrowed to the two name fields the directory reads, so nothing else a Slack profile
      // carries — an email, a phone number, a photo URL — travels past this boundary.
      info: async (args) => {
        const res = await client.users.info({ user: args.user });
        return {
          user: res.user
            ? {
                real_name: res.user.real_name,
                profile: { display_name: res.user.profile?.display_name, real_name: res.user.profile?.real_name },
              }
            : undefined,
        };
      },
    },
```

In `surfaces/slack/src/transport/fake.ts`, add the recording fields and the two groups, in the class's existing style:

```ts
  /** What `usergroups.list` answers. */
  usergroupsList: SlackUsergroup[] = [];
  /** Who is in each group, keyed by its id. */
  usergroupMembers: Record<string, string[]> = {};
  /** What `users.info` answers, keyed by user id. */
  users: Record<string, { real_name?: string; profile?: { display_name?: string } }> = {};
  /** How many times the group list was actually fetched, so a test can prove the cache works. */
  usergroupsListCalls = 0;

  usergroups = {
    list: async (): Promise<SlackUsergroupsListResult> => {
      this.guard();
      this.usergroupsListCalls += 1;
      return { usergroups: this.usergroupsList };
    },
    users: {
      list: async (args: { usergroup: string }): Promise<SlackUsergroupUsersResult> => {
        this.guard();
        return { users: this.usergroupMembers[args.usergroup] ?? [] };
      },
    },
  };

  usersApi = {
    info: async (args: { user: string }): Promise<SlackUserInfoResult> => {
      this.guard();
      return { user: this.users[args.user] };
    },
  };
```

**Name collision:** the class already wants a member called `users` for the fixture data above, and `SlackApi` requires one called `users` holding `info`. Resolve it by naming the fixture map `userProfiles` and the API group `users`, so `FakeSlack` implements the interface literally — rename the two occurrences in the test of Step 1 to match (`api.userProfiles = { … }`) and drop `usersApi`.

- [ ] **Step 3: Write the directory**

Create `surfaces/slack/src/directory.ts`:

```ts
import type { SurfaceDirectory } from '@harness/shared';
import type { SlackApi } from './transport/types.js';

/** How long the whole group membership map is reused before it is fetched again. */
export const DIRECTORY_CACHE_MS = 300_000;

export interface SlackDirectoryOptions {
  now: () => Date;
  cacheMs?: number;
}

/**
 * Who belongs to what, according to the workspace.
 *
 * Two calls, not one per person: `usergroups.list` for the groups and `usergroups.users.list`
 * for each one's members, folded into a `userId → groupIds` map and reused for `cacheMs`. Three
 * hundred people and six groups is seven requests every five minutes, where asking per message
 * would be one per message; a workspace that has just moved somebody is at most one window
 * behind, which is what a directory-backed level is for.
 *
 * A display name is fetched per user and cached for the same window, because it is read once per
 * person and never in a loop.
 *
 * Nothing here is refused quietly: a workspace that will not answer — a missing scope, a rate
 * limit — throws, and the identity plug-in above decides what an unanswerable lookup means.
 */
export function slackDirectory(api: SlackApi, opts: SlackDirectoryOptions): SurfaceDirectory {
  const cacheMs = opts.cacheMs ?? DIRECTORY_CACHE_MS;
  let groups: Map<string, string[]> | null = null;
  let groupsAt = 0;
  const names = new Map<string, { value: string | null; at: number }>();

  const fresh = (at: number): boolean => opts.now().getTime() - at < cacheMs;

  const loadGroups = async (): Promise<Map<string, string[]>> => {
    if (groups && fresh(groupsAt)) return groups;
    const listed = await api.usergroups.list();
    const map = new Map<string, string[]>();
    for (const group of listed.usergroups ?? []) {
      const members = await api.usergroups.users.list({ usergroup: group.id });
      for (const userId of members.users ?? []) {
        map.set(userId, [...(map.get(userId) ?? []), group.id]);
      }
    }
    groups = map;
    groupsAt = opts.now().getTime();
    return map;
  };

  return {
    async groupsOf(userId) {
      return (await loadGroups()).get(userId) ?? [];
    },
    async displayNameOf(userId) {
      const cached = names.get(userId);
      if (cached && fresh(cached.at)) return cached.value;
      const info = await api.users.info({ user: userId });
      const raw = info.user?.profile?.display_name || info.user?.real_name || info.user?.profile?.real_name || '';
      const value = raw.trim() === '' ? null : raw.trim();
      names.set(userId, { value, at: opts.now().getTime() });
      return value;
    },
  };
}
```

In `harness/shared/src/directory.ts`, declare `SurfaceDirectory` with the comment from the Interfaces block above plus this sentence: "It lives here rather than in either contract because both `@harness/surface-api` and `@harness/identity-api` need it and neither may import the other — the same reason the five levels and the two id patterns live here." Export it from `harness/shared/src/index.ts`.

In `harness/surface-api/src/types.ts`, add to `SurfaceSession`:

```ts
  /**
   * Who this surface's users are and what groups they are in, when it can say.
   *
   * Optional: a transport with no notion of a directory simply does not offer one, and an
   * identity plug-in that wanted one is told so at load rather than at the first message.
   */
  readonly directory?: SurfaceDirectory;
```

In `harness/identity-api/src/types.ts`, add to `IdentityDeps`:

```ts
  /**
   * The directories the loaded surfaces offer, by surface name.
   *
   * A directory-backed plug-in reads group membership through this and never imports a surface:
   * `pnpm arch` forbids the edge, and the reason it forbids it is that a plug-in which knew one
   * transport would have to be rewritten for the next one. A surface with no directory is simply
   * absent from the map.
   */
  directories: Readonly<Record<string, SurfaceDirectory>>;
```

Update every `IdentityDeps` literal in the workspace to pass `directories: {}` — `harness/core-tools/src/app/server.ts`, `harness/core-tools/src/domain/identity/registry.test.ts`, `identities/static/src/index.test.ts` — and in `harness/host/src/domain/tenancy/tenant.ts` build the real map from the loaded surfaces:

```ts
  const directories = Object.fromEntries(
    surfaces.all.filter((session) => session.directory).map((session) => [session.name, session.directory!]),
  );
```

moving the `loadIdentity` call **after** `loadSurfaces` so the map exists, and passing `directories` into it. Note in a comment that identity moving after surfaces changes the startup order deliberately: a directory-backed plug-in needs its surface connected before it can ask anything, and the host's own service principal check now happens after the surfaces are up rather than before.

In `surfaces/slack/src/session.ts`, add `directory: slackDirectory(transport.api, { now: () => new Date() })` to the returned `SurfaceSession`, and in `surfaces/slack/src/index.ts` nothing changes — the directory travels on the session.

- [ ] **Step 4: Run the directory test to verify it passes**

Run: `pnpm --filter @harness/surface-slack exec vitest run src/directory.test.ts`
Expected: PASS, four cases.

- [ ] **Step 5: Write the failing provider test**

Create `identities/slack-groups/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, type SurfaceDirectory } from '@harness/shared';
import { parseIdentityFileWithDefaults } from '@harness/identity-api';
import { identity } from './index.js';

const log = { info() {}, warn() {}, error() {} };

function directory(groups: Record<string, string[]>, names: Record<string, string> = {}): SurfaceDirectory {
  return {
    groupsOf: async (userId) => groups[userId] ?? [],
    displayNameOf: async (userId) => names[userId] ?? null,
  };
}

const file = (extra: Record<string, unknown> = {}) =>
  parseIdentityFileWithDefaults({
    principals: [{ id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' }],
    ...extra,
  });

const settings = {
  surface: 'slack',
  groups: [
    { id: 'S-ADMINS', level: 'admin' },
    { id: 'S-LEADS', level: 'lead' },
    { id: 'S-STAFF', level: 'practitioner' },
  ],
  exceptions: [{ userId: 'U-CONTRACTOR', level: 'member' }, { userId: 'U-BANNED', level: 'refuse' }],
  sync: { everySeconds: 300 },
};

const connect = (directories: Record<string, SurfaceDirectory>, extra: Record<string, unknown> = {}) =>
  identity.connect({
    env: {},
    log,
    identity: file({ defaults: { slack: 'member' } }),
    settings: { ...settings, ...extra },
    directories,
  });

describe('the slack-groups identity plug-in', () => {
  it('declares itself, and reads no environment variable of its own', () => {
    expect(identity.name).toBe('slack-groups');
    expect(identity.secrets).toEqual([]);
  });

  it("gives a member of a group that group's level, under a derived id and the directory's name", async () => {
    const session = await connect({ slack: directory({ 'U-LEAD': ['S-LEADS'] }, { 'U-LEAD': 'Ada Lovelace' }) });
    const principal = await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    expect(principal).toMatchObject({ level: 'lead', displayName: 'Ada Lovelace', kind: 'user' });
    expect(principal?.id).toMatch(/^u-slack-u-lead-[0-9a-f]{8}$/);
    // The same person is the same principal, and `get` answers for them.
    expect(await session.get(principal!.id)).toEqual(principal);
  });

  it('takes the first matching group in the order the document lists them', async () => {
    const session = await connect({ slack: directory({ 'U-BOTH': ['S-STAFF', 'S-ADMINS'] }) });
    expect((await session.resolve({ surface: 'slack', userId: 'U-BOTH' }))?.level).toBe('admin');
  });

  it('lets an exception beat a group, and a refusal beat everything', async () => {
    const session = await connect({
      slack: directory({ 'U-CONTRACTOR': ['S-ADMINS'], 'U-BANNED': ['S-ADMINS'] }),
    });
    expect((await session.resolve({ surface: 'slack', userId: 'U-CONTRACTOR' }))?.level).toBe('member');
    expect(await session.resolve({ surface: 'slack', userId: 'U-BANNED' })).toBeNull();
  });

  it("falls to the document's default for someone in no group, and refuses when there is none", async () => {
    const withDefault = await connect({ slack: directory({}) });
    expect((await withDefault.resolve({ surface: 'slack', userId: 'U-NEW' }))?.level).toBe('member');

    const noDefault = await identity.connect({
      env: {},
      log,
      identity: file(),
      settings,
      directories: { slack: directory({}) },
    });
    expect(await noDefault.resolve({ surface: 'slack', userId: 'U-NEW' })).toBeNull();
  });

  it('still answers for a declared principal first, whatever the directory says', async () => {
    const declared = parseIdentityFileWithDefaults({
      defaults: { slack: 'member' },
      principals: [
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
        { id: 'u-owner', kind: 'user', level: 'admin', displayName: 'Owner', surfaces: { slack: 'U-OWNER' } },
      ],
    });
    const session = await identity.connect({
      env: {},
      log,
      identity: declared,
      settings,
      directories: { slack: directory({ 'U-OWNER': ['S-STAFF'] }) },
    });
    expect((await session.resolve({ surface: 'slack', userId: 'U-OWNER' }))?.id).toBe('u-owner');
  });

  it('asks the directory once per sync window, not once per message', async () => {
    let calls = 0;
    const counting: SurfaceDirectory = {
      groupsOf: async () => {
        calls += 1;
        return ['S-LEADS'];
      },
      displayNameOf: async () => null,
    };
    const session = await connect({ slack: counting }, { sync: { everySeconds: 3600 } });
    await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    await session.resolve({ surface: 'slack', userId: 'U-LEAD' });
    expect(calls).toBe(1);
  });

  it('shapes a display name the directory handed it, because it is rendered into a rules block', async () => {
    const session = await connect({ slack: directory({ 'U-X': ['S-LEADS'] }, { 'U-X': 'Ada\nLovelace' }) });
    expect((await session.resolve({ surface: 'slack', userId: 'U-X' }))?.displayName).toBe('AdaLovelace');
  });

  it('refuses a document whose settings are not settings, naming the field', async () => {
    await expect(
      identity.connect({ env: {}, log, identity: file(), settings: { surface: 'slack' }, directories: {} }),
    ).rejects.toThrow(ConfigError);
    await expect(
      identity.connect({ env: {}, log, identity: file(), settings, directories: {} }),
    ).rejects.toThrow(/no surface named "slack" offers a directory/);
  });

  it('answers nothing on a surface it was not configured for', async () => {
    const session = await connect({ slack: directory({ U1: ['S-LEADS'] }) });
    expect(await session.resolve({ surface: 'memory', userId: 'U1' })).toBeNull();
  });
});
```

- [ ] **Step 6: Write the provider**

Create `identities/slack-groups/package.json` (name `@harness/identity-slack-groups`, dependencies `@harness/identity-api` and `@harness/shared` and `zod`, the rest copied from `identities/static/package.json`), `tsconfig.json` and `vitest.config.ts` copied from `identities/static`, and a `README.md` of four sentences: levels come from groups and never from a list; the first matching group wins; `exceptions` beat groups and `refuse` beats everything; and the plug-in never imports a surface, receiving a narrow directory through `IdentityDeps` instead.

Create `identities/slack-groups/src/settings.ts`:

```ts
import * as z from 'zod/v4';
import { USER_LEVELS, ConfigError, SURFACE_NAME_PATTERN } from '@harness/shared';

/**
 * What the client document's `identityProvider.settings` holds for this plug-in.
 *
 * `groups` is ordered and the first match wins, so a workspace where somebody is both a lead and
 * a member of staff has one answer rather than whichever one the directory happened to list
 * first. `exceptions` are checked before `groups`, because they are how a deployment says "this
 * one person, whatever the directory thinks". `refuse` is a level for the purposes of this list
 * and nowhere else: it means the person is not a principal at all.
 */
export const SlackGroupsSettingsShape = z
  .object({
    surface: z.string().regex(SURFACE_NAME_PATTERN).default('slack'),
    groups: z
      .array(z.object({ id: z.string().min(1), level: z.enum(USER_LEVELS) }).strict())
      .min(1, 'a directory-backed provider needs at least one group to map'),
    exceptions: z
      .array(
        z
          .object({ userId: z.string().min(1), level: z.union([z.enum(USER_LEVELS), z.literal('refuse')]) })
          .strict(),
      )
      .default([]),
    sync: z.object({ everySeconds: z.number().int().min(30).max(86_400).default(300) }).strict().default({ everySeconds: 300 }),
  })
  .strict();

export type SlackGroupsSettings = z.infer<typeof SlackGroupsSettingsShape>;

export function parseSlackGroupsSettings(raw: unknown): SlackGroupsSettings {
  const parsed = SlackGroupsSettingsShape.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(`identityProvider.settings are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
```

Create `identities/slack-groups/src/index.ts`:

```ts
import {
  defineIdentityProvider,
  principalFromDefault,
  principalFromDerivedId,
  type IdentityProvider,
  type IdentitySession,
  type Principal,
  type UserLevel,
} from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ConfigError, type Logger, type SurfaceDirectory } from '@harness/shared';
import { parseSlackGroupsSettings, type SlackGroupsSettings } from './settings.js';

/** What a resolution decided, cached until the sync window is over. */
interface Decided {
  principal: Principal | null;
  at: number;
}

/**
 * Levels from group membership, never from a list.
 *
 * Three hundred people are six lines of configuration: a group per level, in order, plus named
 * exceptions and the document's own `defaults` for everyone else. A new hire joins a group and
 * exists; a leaver falls to the default, or to nothing when the document gives none.
 *
 * The order is exceptions, then groups, then the default, because that is the order of how
 * specific each answer is: a person named by id, then a person in a group, then everybody.
 *
 * The plug-in never imports a surface. It receives a `SurfaceDirectory` — two methods, both
 * taking a user id — through `IdentityDeps`, which is what lets one implementation serve any
 * transport whose workspace has a notion of a group, and what `pnpm arch` enforces.
 */
class GroupsIdentity implements IdentitySession {
  readonly name = 'slack-groups';

  private readonly declared: StaticIdentity;
  private readonly defaults: Readonly<Record<string, UserLevel>>;
  private readonly settings: SlackGroupsSettings;
  private readonly directory: SurfaceDirectory;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly decided = new Map<string, Decided>();
  private readonly minted = new Map<string, Principal>();

  constructor(args: {
    declared: StaticIdentity;
    defaults: Readonly<Record<string, UserLevel>>;
    settings: SlackGroupsSettings;
    directory: SurfaceDirectory;
    log: Logger;
    now?: () => number;
  }) {
    this.declared = args.declared;
    this.defaults = args.defaults;
    this.settings = args.settings;
    this.directory = args.directory;
    this.log = args.log;
    this.now = args.now ?? (() => Date.now());
  }

  private levelFor(userId: string, groups: readonly string[]): UserLevel | 'refuse' | null {
    const exception = this.settings.exceptions.find((entry) => entry.userId === userId);
    if (exception) return exception.level;
    const matched = this.settings.groups.find((entry) => groups.includes(entry.id));
    if (matched) return matched.level;
    return this.defaults[this.settings.surface] ?? null;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    const declared = await this.declared.resolve(ref);
    if (declared) return declared;
    if (ref.surface !== this.settings.surface) return null;

    const key = `${ref.surface}:${ref.userId}`;
    const cached = this.decided.get(key);
    if (cached && this.now() - cached.at < this.settings.sync.everySeconds * 1000) return cached.principal;

    const groups = await this.directory.groupsOf(ref.userId);
    const level = this.levelFor(ref.userId, groups);
    if (level === null || level === 'refuse') {
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    const displayName = (await this.directory.displayNameOf(ref.userId)) ?? undefined;
    const minted = principalFromDefault(ref.surface, ref.userId, level, displayName);
    if (!minted) {
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    // A derived id a declared principal already holds would hand one person another's history.
    if (await this.declared.get(minted.id)) {
      this.log.warn(`slack-groups: derived id "${minted.id}" is already declared; refusing the caller`);
      this.decided.set(key, { principal: null, at: this.now() });
      return null;
    }
    this.minted.set(minted.id, minted);
    this.decided.set(key, { principal: minted, at: this.now() });
    return minted;
  }

  async get(principalId: string): Promise<Principal | null> {
    return (
      (await this.declared.get(principalId)) ??
      this.minted.get(principalId) ??
      principalFromDerivedId(principalId, this.defaults)
    );
  }

  async list(): Promise<Principal[]> {
    return this.declared.list();
  }

  async stop(): Promise<void> {
    await this.declared.stop();
  }
}

export const identity: IdentityProvider = defineIdentityProvider({
  name: 'slack-groups',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const settings = parseSlackGroupsSettings(deps.settings);
    const directory = deps.directories[settings.surface];
    if (!directory) {
      throw new ConfigError(
        `no surface named "${settings.surface}" offers a directory; this provider resolves levels from group membership and cannot without one`,
      );
    }
    const { principals, defaults } = deps.identity;
    deps.log.info(
      `slack-groups identity: ${principals.length} declared, ${settings.groups.length} groups, ${settings.exceptions.length} exceptions, syncing every ${settings.sync.everySeconds}s`,
    );
    return new GroupsIdentity({
      declared: new StaticIdentity(principals, 'slack-groups'),
      defaults,
      settings,
      directory,
      log: deps.log,
    });
  },
});
```

- [ ] **Step 7: Register the package and scan it**

Add a `PACKAGES` row `{ name: 'identity-slack-groups', src: 'identities/slack-groups/src', severity: 'error' }` and a `WORKSPACE_DIRS` entry `'identities/slack-groups'` to `.dependency-cruiser.cjs`, and the directory to `pnpm-workspace.yaml`. In `harness/core-tools/src/kernel-vocabulary.test.ts`, add two rows mirroring the ones `identities/static/src` has — **framework** and **deployment**, not messaging:

```ts
  {
    what: 'framework and vendor vocabulary',
    root: 'identities/slack-groups/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 2,
    skip: [/\.test\.ts$/],
  },
  {
    what: 'deployment vocabulary',
    root: 'identities/slack-groups/src',
    forbidden: DEPLOYMENT_FORBIDDEN,
    minFiles: 2,
    skip: [/\.test\.ts$/],
  },
```

with one sentence added to the comment above `SCANNED`: "`identities/slack-groups/src` is exempt from the messaging list for the same reason `surfaces/slack` is — it *is* the vendor — and scanned for the other two like `identities/static`."

Run `pnpm install`, then `pnpm --filter @harness/identity-slack-groups test`.
Expected: PASS, ten cases.

- [ ] **Step 8: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 9: Commit**

```bash
git add harness/shared harness/surface-api harness/identity-api surfaces/slack identities/slack-groups \
  identities/static harness/core-tools/src harness/host/src/domain/tenancy/tenant.ts \
  .dependency-cruiser.cjs pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "feat(identity): resolve a level from a surface's own groups through a narrow directory"
```

---

### Task 8: The usage export — `GET /v1/usage`, and no content in it

**Files:**
- Create: `harness/host/src/domain/api/usage.ts` + `usage.test.ts`
- Modify: `harness/host/src/domain/api/routes.ts`, `domain/api/types.ts`
- Modify: `harness/host/src/domain/conversation.ts` (persist every runtime `usage` event), `harness/host/src/domain/kernel.ts` (close the run with its totals)
- Modify: `harness/core-tools/src/domain/session/repository.ts` (`closeRun` writes the totals)

**Interfaces:**
- Consumes: `usageRuns`, `modelCalls`, `runs` (Task 3); `closeRun(db, client, runId, status, now)` (Task 5); `handleApiRequest(pool, …)` (Task 6).
- Produces:
  - `readUsage(db, opts: { client: string; from: Date; to: Date }): Promise<UsageRow[]>` and `UsageRow`
  - `USAGE_MAX_DAYS = 366`
  - `closeRun(db, client, runId, status, now?, totals?: { inputTokens: number; outputTokens: number; costUsd: number })`
  - `recordRuntimeUsage(host, runId, event): Promise<void>` in `conversation.ts`

- [ ] **Step 1: Write the failing usage test**

Create `harness/host/src/domain/api/usage.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { modelCalls, runs } from '@harness/db';
import { useTestDb } from '@harness/db/testing';
import { readUsage } from './usage.js';

const { db } = useTestDb();

async function seed(client: string, principalId: string, day: string, totals: { i: number; o: number; c: number }) {
  const [run] = await db
    .insert(runs)
    .values({
      client,
      principalId,
      status: 'done',
      startedAt: new Date(`${day}T09:00:00Z`),
      endedAt: new Date(`${day}T09:00:30Z`),
      inputTokens: totals.i,
      outputTokens: totals.o,
      costUsd: totals.c,
    })
    .returning();
  await db
    .insert(modelCalls)
    .values({ runId: run.id, client, route: 'chat', model: 'm', inputTokens: totals.i, outputTokens: totals.o, costUsd: totals.c });
  return run.id;
}

describe('readUsage', () => {
  it("sums a tenant's runs by principal and day", async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 100, o: 20, c: 0.01 });
    await seed('alpha', 'u-one', '2026-09-10', { i: 50, o: 10, c: 0.005 });
    await seed('alpha', 'u-two', '2026-09-11', { i: 7, o: 1, c: 0.001 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    expect(rows).toHaveLength(2);
    const first = rows.find((row) => row.principal_id === 'u-one')!;
    expect(first).toMatchObject({ runs: 2, input_tokens: 150, output_tokens: 30, runs_done: 2 });
    expect(first.cost_usd).toBeCloseTo(0.015, 6);
    expect(first.duration_seconds).toBe(60);
    expect(first.sandbox_seconds).toBe(0);
  });

  it("returns none of another tenant's rows, however wide the window", async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 100, o: 20, c: 0.01 });
    await seed('beta', 'u-one', '2026-09-10', { i: 999, o: 999, c: 9.99 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2020-01-01T00:00:00Z'),
      to: new Date('2030-01-01T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(100);
  });

  it('bounds the window at both ends', async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 1, o: 1, c: 0 });
    await seed('alpha', 'u-one', '2026-09-20', { i: 2, o: 2, c: 0 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-15T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].input_tokens).toBe(2);
  });

  it('carries no message, no tool argument and no conversation (invariant 16)', async () => {
    await seed('alpha', 'u-one', '2026-09-10', { i: 1, o: 1, c: 0 });
    const rows = await readUsage(db, {
      client: 'alpha',
      from: new Date('2026-09-01T00:00:00Z'),
      to: new Date('2026-09-30T00:00:00Z'),
    });
    // The column list, asserted whole. A field added to the view without a thought is a field
    // this fails on, which is the point: an export is the one place content leaves by accident.
    expect(Object.keys(rows[0]).sort()).toEqual([
      'approvals_decided',
      'approvals_requested',
      'client',
      'cost_usd',
      'day',
      'duration_seconds',
      'input_tokens',
      'output_tokens',
      'principal_id',
      'runs',
      'runs_cancelled',
      'runs_done',
      'runs_error',
      'runs_running',
      'sandbox_seconds',
    ]);
  });

  it('answers an empty list for a tenant that has done nothing, rather than failing', async () => {
    expect(
      await readUsage(db, { client: 'nobody', from: new Date('2026-09-01T00:00:00Z'), to: new Date('2026-09-30T00:00:00Z') }),
    ).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm --filter @harness/host exec vitest run src/domain/api/usage.test.ts`
Expected: FAIL — `./usage.js` does not exist.

- [ ] **Step 3: Write the reader**

Create `harness/host/src/domain/api/usage.ts`:

```ts
import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { usageRuns, type Db } from '@harness/db';

/** The widest window one request may ask for: a year and a leap day. */
export const USAGE_MAX_DAYS = 366;

/**
 * One tenant's usage for one principal on one day.
 *
 * Snake case, because this is what goes on the wire and what a billing system reads; every other
 * shape in the run API is the same. The field names are the view's column names exactly, so a
 * column added to `usage_runs` without a thought fails the test that asserts this list.
 */
export interface UsageRow {
  client: string;
  principal_id: string;
  day: string;
  runs: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  duration_seconds: number;
  runs_done: number;
  runs_error: number;
  runs_cancelled: number;
  runs_running: number;
  approvals_requested: number;
  approvals_decided: number;
  sandbox_seconds: number;
}

/**
 * Read `usage_runs` for one tenant over one window.
 *
 * Counts, tokens, cost and seconds, and nothing anybody wrote (invariant 16). The view is where
 * that guarantee lives — it selects no text column at all — and this adds only the tenant
 * predicate and the window, half-open so two adjacent months do not both claim their boundary.
 */
export async function readUsage(db: Db, opts: { client: string; from: Date; to: Date }): Promise<UsageRow[]> {
  const rows = await db
    .select()
    .from(usageRuns)
    .where(and(eq(usageRuns.client, opts.client), gte(usageRuns.day, opts.from), lt(usageRuns.day, opts.to)))
    .orderBy(asc(usageRuns.day), asc(usageRuns.principalId));
  return rows.map((row) => ({
    client: row.client,
    principal_id: row.principalId,
    day: row.day.toISOString(),
    runs: row.runs,
    input_tokens: row.inputTokens,
    output_tokens: row.outputTokens,
    cost_usd: row.costUsd,
    duration_seconds: row.durationSeconds,
    runs_done: row.runsDone,
    runs_error: row.runsError,
    runs_cancelled: row.runsCancelled,
    runs_running: row.runsRunning,
    approvals_requested: row.approvalsRequested,
    approvals_decided: row.approvalsDecided,
    sandbox_seconds: row.sandboxSeconds,
  }));
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `pnpm --filter @harness/host exec vitest run src/domain/api/usage.test.ts`
Expected: PASS, five cases.

- [ ] **Step 5: Persist the runtime's usage and close the run with its totals**

In `harness/core-tools/src/domain/session/repository.ts`, widen `closeRun`:

```ts
export async function closeRun(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date = () => new Date(),
  totals: { inputTokens: number; outputTokens: number; costUsd: number } = { inputTokens: 0, outputTokens: 0, costUsd: 0 },
): Promise<void> {
  await db
    .update(runs)
    .set({ status, endedAt: now(), ...totals })
    .where(and(eq(runs.id, runId), eq(runs.client, client)));
}
```

In `harness/host/src/domain/conversation.ts`, where the `usage` event is handled today — the branch that adds to `spentUsd` for the cost cap — write the row beside it:

```ts
      if (event.type === 'usage') {
        spentUsd += event.costUsd;
        // Until now the runtime's own spend was accumulated for the cost cap and dropped, so the
        // only model calls the database knew about were the kernel's own — which made a usage
        // export a report on the wrong half of the bill (spec section 4.5). One row per usage
        // event, on the same table `callModel` writes to, so `usage_runs` is one join.
        await recordModelCall(host.db, {
          runId: context.runId,
          client: host.client,
          route: 'chat',
          model: host.model.route,
          inputTokens: event.inputTokens,
          outputTokens: event.outputTokens,
          costUsd: event.costUsd,
        });
      }
```

with `recordModelCall` a new exported function in `harness/core-tools/src/domain/models/gateway.ts` — extracted from the insert `callModel` already performs, so there is one writer of `model_calls` and not two:

```ts
/**
 * One `model_calls` row. The kernel's own calls go through `callModel`, which calls this; the
 * host calls it directly for the runtime's `usage` events, whose spend nothing persisted before.
 */
export async function recordModelCall(
  db: Db,
  row: { runId: string | null; client: string; route: string; model: string; inputTokens: number; outputTokens: number; costUsd: number },
): Promise<void> {
  await db.insert(modelCalls).values(row);
}
```

In `harness/host/src/domain/kernel.ts`, have the run close with its own totals, read from the rows it wrote:

```ts
/**
 * Close a run, with what it spent.
 *
 * The totals are summed from this run's own `model_calls` rows rather than counted in memory, so
 * a turn that crashed after writing a call still reports it, and the run row and the call rows
 * can never disagree. `usage_runs` reads `runs` alone for tokens, which is why there is exactly
 * one place they are computed.
 */
export async function finishKernel(
  db: Db,
  client: string,
  runId: string,
  status: RunStatus,
  now: () => Date,
  close: () => Promise<void>,
): Promise<void> {
  const [totals] = await db
    .select({
      inputTokens: sql<number>`coalesce(sum(${modelCalls.inputTokens}), 0)::int`,
      outputTokens: sql<number>`coalesce(sum(${modelCalls.outputTokens}), 0)::int`,
      costUsd: sql<number>`coalesce(sum(${modelCalls.costUsd}), 0)::real`,
    })
    .from(modelCalls)
    .where(and(eq(modelCalls.runId, runId), eq(modelCalls.client, client)));
  await closeRun(db, client, runId, status, now, totals);
  await close();
}
```

matching the existing body's ordering and error handling (read the file: whatever it does today around `close()` stays).

Add one case to `harness/host/src/domain/conversation.test.ts`:

```ts
  it("writes the runtime's own spend, which used to be dropped after the turn", async () => {
    const f = await hostFixture(db, {
      trajectory: [{ usage: { inputTokens: 120, outputTokens: 34, costUsd: 0.002 } }, { say: 'Done.' }],
    });
    const thread = await findOrCreateThread(db, { client: 'test', surface: 'memory', conversation: 'C1', principalId: COORDINATOR.id });
    const result = await runTurn(f.host, { thread, principal: COORDINATOR, role: 'user', text: 'hello', attachments: [], replyTo: null });
    const [run] = await db.select().from(runs).where(eq(runs.id, result.runId));
    expect(run).toMatchObject({ inputTokens: 120, outputTokens: 34, status: 'done' });
    expect(await db.$count(modelCalls, eq(modelCalls.runId, result.runId))).toBe(1);
    await f.close();
  });
```

matching `ScriptedRuntime`'s real trajectory step shape for a usage event — read `harness/runtime-api/src/testing.ts` and use whatever it calls that step.

- [ ] **Step 6: Add the route**

In `harness/host/src/domain/api/routes.ts`, add the handler and wire it in `handleApiRequest` after `/v1/status`:

```ts
/**
 * What this tenant used, per principal per day (spec §4.5, decision 15).
 *
 * `from` and `to` are ISO dates or timestamps, the window is half-open, and a request that names
 * neither gets the last thirty days. Bearer-authenticated and tenant-scoped like every other
 * route, and there is no way to widen it: the client is the one the request resolved to, never
 * one the caller asked for.
 */
async function usageRoute(host: Host, url: URL, res: ServerResponse): Promise<void> {
  const to = url.searchParams.get('to') ? new Date(url.searchParams.get('to')!) : new Date();
  const from = url.searchParams.get('from')
    ? new Date(url.searchParams.get('from')!)
    : new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
  if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) {
    return json(res, 400, { error: 'from and to are ISO timestamps' });
  }
  if (to <= from) return json(res, 400, { error: 'to must be after from' });
  if (to.getTime() - from.getTime() > USAGE_MAX_DAYS * 24 * 60 * 60 * 1000) {
    return json(res, 400, { error: `the window may not exceed ${USAGE_MAX_DAYS} days` });
  }
  return json(res, 200, {
    client: host.client,
    from: from.toISOString(),
    to: to.toISOString(),
    rows: await readUsage(host.db, { client: host.client, from, to }),
  });
}
```

and in `handleApiRequest`:

```ts
  if (req.method === 'GET' && route === '/v1/usage') return usageRoute(host, url, res);
```

Add three cases to `harness/host/src/domain/api/routes.test.ts`: the route answers 200 with the tenant's rows; a request with no bearer is 401 before anything is read; and a request naming another client through `x-harness-client` is 404 and returns nothing of that client's.

- [ ] **Step 7: Run the host suite to verify it passes**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host test
```
Expected: PASS.

- [ ] **Step 8: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `git status --short docs/architecture` is empty.

- [ ] **Step 9: Commit**

```bash
git add harness/host/src harness/core-tools/src
git commit -m "feat(host): persist the runtime's own spend and export usage without a word of content"
```

---

### Task 9: `clients/` becomes one fixture, the scaffolder writes documents, the renderer reads one, and Compose stops baking a client

**Files:**
- Create: `clients/fixture/client.yaml`, `clients/fixture/persona.md`, `clients/fixture/skills/knowledge-refresh/SKILL.md`, `clients/fixture/knowledge/front-desk.md`, `clients/fixture/knowledge/escalation-and-billing.md`
- **Delete:** the whole of `clients/demo-practice/`
- Modify: `harness/host/src/domain/playbooks/preflight.test.ts`, `scheduler.test.ts` (both move onto the fixture document), `harness/host/package.json` (**`"@harness/config-files": "workspace:*"` in `devDependencies`**, which those two tests import)
- Modify: `harness/config-files/src/source.ts` + `source.test.ts`, `harness/config-postgres/src/source.ts` + `source.test.ts` (Step 2: `knowledge.path`)
- Modify: `scripts/src/domain/scaffold.ts` + `scaffold.test.ts`, `scripts/src/app/cli.ts`, `scripts/package.json`
- Modify: `harness/gateway/src/app/render-config.ts`, `harness/gateway/package.json`
- Modify: `harness/compose/docker-compose.yml`, `harness/compose/node.Dockerfile`, `docs/architecture/compose-surface.yaml`
- Modify: `.env.example`, `.env.ci`
- Modify: `harness/core-tools/src/app/surface.test.ts` (the `demo-practice` compose property)

**Interfaces:**
- Consumes: everything Tasks 1–8 produced.
- Produces:
  - `newClient(opts: { name: string; displayName?: string; pack?: string; target?: string; runtime?: string }): Promise<NewClientResult>`, writing `<target>/<name>/client.yaml` plus `persona.md`
  - `renderClientConfig(source: ConfigSource, clientId: string): Promise<string>`
  - `clients/fixture/client.yaml`, the one client document in this repository

- [ ] **Step 1: Write the fixture client**

Create `clients/fixture/persona.md` with the two paragraphs the old `SOUL.md` opened with, rewritten for a fixture rather than a practice (no product-area words: `clients/` is not scanned by the vocabulary test, but the runbook quotes this file and a fixture should read as one):

```markdown
# Fixture assistant

You are the assistant this repository's tests run against. You work in chat with two people, a
coordinator and a member, and you keep their records complete and current.

You are precise, brief, and unhurried. You say what you did, what you found, and what you need.

## Hard rules

1. **Verify before you conclude.** Do not report that something is complete until a tool has told
   you so. When you infer something, say it is an inference and name what would confirm it.
2. **Stop after three consecutive tool errors and report.** Say which tool failed, what it said,
   and what you were trying to do. A human decides the next step.
3. **Never claim an action happened while it is pending approval.** When a tool returns
   `status: "pending"` with an `approval_id`, the action has not happened. Say so and name the id.
4. **You act as whoever the harness bound to this session.** Every tool call is recorded against a
   principal the harness resolved before you ran. There is no tool to change it.
5. **An answer about how this deployment works comes from the knowledge base, with its source.**
   Search first, answer from what comes back, and name the document you took it from. You see only
   what the person asking is allowed to see, so nothing useful means you say so.
```

Create `clients/fixture/skills/knowledge-refresh/SKILL.md`:

```markdown
---
name: knowledge-refresh
description: Re-read this client's knowledge folder into the knowledge base
version: 1.0.0
---

Call `knowledge_sync` once. Say nothing unless it reports a skipped document; if it does, name
each one and the reason it gives, in one message.
```

Move `clients/demo-practice/knowledge/front-desk.md` and `escalation-and-billing.md` to `clients/fixture/knowledge/` unchanged — they are the two documents the knowledge tests read, and their frontmatter is what those tests assert.

Create `clients/fixture/client.yaml`. It is the whole document, with the persona and the skill pulled out by `!include`:

```yaml
# The one client in this repository, and the only reason `clients/` still exists.
#
# It is a fixture: the host suite boots it, the scaffolder copies it, and the runbook points at it
# as the shape a real tenant's document has. A real tenant lives in HARNESS_CLIENTS_DIR or in
# `client_documents`, outside this repository, and onboarding one changes nothing here.
schemaVersion: 1
id: fixture
displayName: Fixture

persona: !include persona.md

identity:
  # Everyone this deployment declares. Anyone else on `memory` is a member, under an id derived
  # from theirs, so the fixture exercises the defaults rule as well as the declared one.
  defaults:
    memory: member
  principals:
    - id: u-coordinator
      kind: user
      level: lead
      displayName: Coordinator
      surfaces:
        memory: U012
        http: coordinator
    - id: u-member
      kind: user
      level: member
      displayName: Member
      surfaces:
        memory: U345
        http: member
    - id: svc-host
      kind: service
      level: service
      displayName: Harness host
    - id: svc-playbooks
      kind: service
      level: service
      displayName: Nightly playbooks
    - id: svc-local
      kind: service
      level: service
      displayName: Local operator

policy:
  classes:
    read: auto
    write.internal: auto
    external: approval
    financial: blocked
    destructive: approval
  tools:
    # Nothing, and deliberately: `tools.hide` must never change the default catalogue, or
    # docs/architecture/tool-surface.json would have to move with it.
    hide: []

routing:
  routes:
    chat:
      model: gemini/gemini-3-flash-preview
      fallbacks:
        - groq/openai/gpt-oss-120b
      daily_budget_usd: 2
    extract:
      model: gemini/gemini-3-flash-preview
      daily_budget_usd: 5
    reason:
      model: gemini/gemini-3-flash-preview
      fallbacks:
        - groq/openai/gpt-oss-120b
      daily_budget_usd: 2
    judge:
      model: groq/openai/gpt-oss-120b
      daily_budget_usd: 1
    embed:
      model: gemini/gemini-embedding-001
      daily_budget_usd: 1
  defaults:
    daily_budget_usd: 1
    num_retries: 2
    request_timeout_s: 120

playbooks:
  playbooks:
    - name: knowledge-refresh
      schedule: '30 6 * * *'
      timezone: America/New_York
      skill: knowledge-refresh
      prompt: Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.
      principal: svc-playbooks
      deliver: none
      cost_cap_usd: 0.5
      timeout_s: 300

skills:
  knowledge-refresh: !include skills/knowledge-refresh/SKILL.md

knowledge:
  source: dir
  path: knowledge

surfaces:
  memory: {}
  http: {}

identityProvider:
  kind: static

runtime: deepagents

packs:
  - '@harness/pack-healthcare'
```

`knowledge.path` here is `knowledge`, relative to the client's own directory. **Step 2 is what makes that resolve**; nothing in this step depends on it yet.

Then **delete** `clients/demo-practice/` entirely.

- [ ] **Step 2: Resolve `knowledge.path` against the client's own directory**

The fixture's `knowledge.path` is `knowledge`, a path relative to the client's own directory, and nothing resolves it yet: `buildKernelConfig` (Task 4) puts `document.knowledge.path` into `KernelConfig.knowledgeDir` verbatim, so a relative path would be resolved against whatever working directory the process happened to start in. A source knows where its documents came from and the kernel does not, so the source is what resolves it. This is a change to two packages Task 3 wrote, and their suites pin their behaviour, so it is its own step with its own re-run.

In `harness/config-files/src/source.ts`, add this beside `versionOf`:

```ts
/**
 * A client's knowledge directory, as an absolute path under the client's own directory.
 *
 * The document says `knowledge: { source: 'dir', path: knowledge }` — a path *relative to the
 * client*, because a document is portable and a tenant does not know where the host mounted it.
 * The same escape check `readIncluded` applies to an `!include` applies here and for the same
 * reason: the path is written by a tenant, and `../../other-tenant/knowledge` would hand one
 * client's documents to another. An already-absolute path is taken as it is, so a deployment that
 * mounts its knowledge somewhere else still can.
 */
function knowledgeAbsolute(document: ClientDocument, dir: string): ClientDocument {
  if (document.knowledge.source !== 'dir') return document;
  const root = path.resolve(dir);
  const target = path.resolve(root, document.knowledge.path);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
    throw new ConfigError(
      `client "${document.id}": knowledge.path "${document.knowledge.path}" is outside the client directory ${root}`,
    );
  }
  return { ...document, knowledge: { source: 'dir', path: target } };
}
```

with `ClientDocument` added to the type import from `@harness/config-api`, and apply it at both of `read`'s two returns:

```ts
      const document = knowledgeAbsolute(resolveOverlay(blueprint, overlay), dir);
      return { document, version: versionOf(document) };
```

and

```ts
    const document = knowledgeAbsolute(migrate(await parseWithIncludes(file)), dir);
```

keeping the `document.id !== clientId` check after it. (`versionOf` hashes the resolved document, so two hosts with the same mount agree on the version and a host that moved its mount opens a fresh tenant — which is correct, because the tenant's knowledge really did move.)

Append two cases to `harness/config-files/src/source.test.ts`:

```ts
  it('resolves a relative knowledge path against the client directory, so the kernel gets an absolute one', async () => {
    const root = await newRoot();
    await writeDocument(root, parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })));
    const loaded = await filesConfigSource({ root, log }).load('fixture');
    expect(loaded?.document.knowledge).toEqual({ source: 'dir', path: path.join(root, 'fixture', 'knowledge') });
  });

  it("refuses a knowledge path that climbs out of the client's own directory", async () => {
    const root = await newRoot();
    await writeDocument(
      root,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: '../other/knowledge' } })),
    );
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(ConfigError);
    await expect(filesConfigSource({ root, log }).load('fixture')).rejects.toThrow(/outside the client directory/);
  });
```

In `harness/config-postgres/src/source.ts`, a relative path has nothing to be relative *to* — there is no directory behind a row — so it is refused on load rather than guessed at. Add, beside `read`:

```ts
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
```

with `path` from `node:path` and `ConfigError` added to the `@harness/shared` import, and change `read`'s return to `{ document: assertAbsoluteKnowledge(migrate(row.document)), version: row.version }`.

Append one case to `harness/config-postgres/src/source.test.ts`:

```ts
  it('refuses a stored document whose knowledge path is relative, because a row has no directory', async () => {
    await writeClientDocument(
      db,
      parseClientDocument(fixtureDocument({ knowledge: { source: 'dir', path: 'knowledge' } })),
      'v1',
    );
    await expect(postgresConfigSource({ db, log }).load('fixture')).rejects.toThrow(/must be absolute/);
  });
```

Run both suites before going on:

```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-files test && \
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/config-postgres test
```

Expected: PASS, three more cases than Task 3 left behind.

- [ ] **Step 3: Move the two host tests onto the fixture**

Both tests load the fixture through `@harness/config-files`, which `@harness/host` does not depend on today. **Add `"@harness/config-files": "workspace:*"` to `harness/host/package.json`'s `devDependencies`** (a test-only import, beside `@harness/pack-healthcare` and the `@harness/runtime-scripted` Task 6 added) and run `pnpm install` before writing either file. Without it `no-unresolvable-workspace-import` fails at error severity and `tsc --noEmit` fails with it.

In `harness/host/src/domain/playbooks/preflight.test.ts`, replace `describe('the shipped demo playbooks (I1)')` with one that reads the fixture through the real source:

```ts
describe('the shipped fixture client (I1)', () => {
  const clientsDir = path.join(repoRoot, 'clients');

  it('is a valid document whose playbooks pass preflight against the shipped skills and identity', async () => {
    const loaded = await filesConfigSource({ root: clientsDir, log }).load('fixture');
    expect(loaded, 'clients/fixture/client.yaml must load').toBeTruthy();
    const document = loaded!.document;
    expect(document.playbooks.playbooks.map((p) => p.name)).toEqual(['knowledge-refresh']);
    for (const playbook of document.playbooks.playbooks) {
      expect(playbook).toMatchObject({ timezone: 'America/New_York', principal: 'svc-playbooks', deliver: 'none' });
    }

    const f = await hostFixture(db, { trajectory: [] });
    f.host.identity = await loadIdentity('@harness/identity-static', {
      env: {},
      log: f.host.log,
      identity: parseIdentityFileWithDefaults(document.identity),
      settings: {},
      directories: {},
    });
    const skillsDir = await materialiseSkills(document, await mkdtemp(path.join(tmpdir(), 'harness-fixture-')));
    f.host.skills = await readSkillCatalogue([kernelSkillsDir(), skillsDir, ...f.host.config.packs.skillsDirs()]);
    for (const playbook of document.playbooks.playbooks) {
      expect(await preflightPlaybook(f.host, rowFor(playbook))).toMatchObject({ ok: true });
    }
    await f.close();
  });
});
```

using that file's own `rowFor`/`row()` helper and its own imports. In `scheduler.test.ts`, replace `describe('the shipped knowledge-sync playbook (I1)')`'s three reads of `clients/demo-practice` with the same load: `policy` becomes `mergePolicy(DEFAULT_POLICY, document.policy)` (undoing Task 4's literal), `knowledgeDir` becomes `path.join(clientsDir, 'fixture', 'knowledge')`, the playbook name becomes `knowledge-refresh`, and the trajectory's skill becomes `knowledge-refresh`. In `harness/core-tools/src/app/surface.test.ts`, replace the property that asserts `demo-practice` appears only inside a `${HARNESS_CLIENT…}` interpolation with one that asserts the compose config contains **no client name at all**:

```ts
  it('names no client anywhere in the compose config, because a client is not in this repository', () => {
    expect(compose).not.toContain('demo-practice');
    expect(compose).not.toContain('/srv/agent-harness/clients');
  });
```

- [ ] **Step 4: Run the two host tests to verify they pass**

Run:
```bash
TEST_DATABASE_URL=postgres://harness:harness@localhost:15433/harness_test \
  pnpm --filter @harness/host exec vitest run src/domain/playbooks
```
Expected: PASS.

- [ ] **Step 5: Write the failing scaffolder test**

Replace `scripts/src/domain/scaffold.test.ts`'s body with cases against the new shape (keep its tmpdir helper and its name-validation cases verbatim):

```ts
  it('writes a client document and its persona into the directory it was given', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
    const result = await newClient({ name: 'river-clinic', displayName: 'River Clinic', pack: 'healthcare', target });
    expect(result.dir).toBe(path.join(target, 'river-clinic'));
    expect(result.files.sort()).toEqual(['client.yaml', 'persona.md']);

    const loaded = await filesConfigSource({ root: target, log }).load('river-clinic');
    expect(loaded?.document.id).toBe('river-clinic');
    expect(loaded?.document.displayName).toBe('River Clinic');
    expect(loaded?.document.packs).toEqual(['@harness/pack-healthcare']);
    expect(loaded?.document.persona).toContain('River Clinic');
  });

  it('writes a client with no pack, which used to need an empty variable', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
    await newClient({ name: 'internal-team', target });
    const loaded = await filesConfigSource({ root: target, log }).load('internal-team');
    expect(loaded?.document.packs).toEqual([]);
  });

  it('never writes inside this repository unless it was pointed at it', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
    const result = await newClient({ name: 'river-clinic', target });
    expect(result.dir.startsWith(target)).toBe(true);
    expect(result.dir).not.toContain(`${path.sep}clients${path.sep}`);
  });

  it('refuses to overwrite a client that is already there', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
    await newClient({ name: 'river-clinic', target });
    await expect(newClient({ name: 'river-clinic', target })).rejects.toThrow(/already exists/);
  });

  it('refuses a pack this build does not ship, before it writes anything', async () => {
    const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
    await expect(newClient({ name: 'river-clinic', pack: 'nope', target })).rejects.toThrow(/no pack named "nope"/);
    await expect(readdir(target)).resolves.toEqual([]);
  });
```

- [ ] **Step 6: Rewrite the scaffolder**

Replace `scripts/src/domain/scaffold.ts` with a writer of the document format. Its header comment becomes:

```ts
/**
 * Create a client, as a document, in a directory that is not this repository.
 *
 *   pnpm new-client --name river-clinic --display-name "River Clinic" --pack healthcare
 *   pnpm new-client --name internal-team --target /srv/tenants
 *
 * A client is content and configuration, never code, and after Plan 11a it is not in this
 * repository either: the target defaults to `HARNESS_CLIENTS_DIR` and the scaffolder refuses to
 * run with neither that nor `--target`. What it writes is one `client.yaml` — the whole document
 * — and one `persona.md` the document `!include`s, because a persona is the one field a person
 * edits as prose. It deliberately does not touch `.env`: secrets are the operator's job.
 */
```

and its body builds the document from `clients/fixture/client.yaml` read through `parseWithIncludes`, replacing `id`, `displayName`, `persona` (the fixture's persona with the display name substituted), `packs` (`[]` or `['@harness/pack-<pack>']`), `knowledge` (kept as `{ source: 'dir', path: 'knowledge' }`) and `playbooks` (emptied — a new client schedules nothing until somebody asks it to). It writes `client.yaml` with `yaml`'s `stringify`, with `persona: !include persona.md` written back in by hand after stringifying (the `yaml` package will not emit a custom tag it did not parse), and `persona.md` beside it. `target` resolves as `opts.target ?? process.env.HARNESS_CLIENTS_DIR`, and with neither it throws:

```ts
    throw new Error(
      'nowhere to write: pass --target or set HARNESS_CLIENTS_DIR. A client does not live in this repository.',
    );
```

`scripts/src/app/cli.ts` gains `--display-name` and `--target`, loses `--template`, and its "Next:" lines become:

```
  1. Fill in <dir>/client.yaml: the principals and their surface ids, the routing table,
     and the surfaces this client serves.
  2. Set HARNESS_CONFIG_SOURCE=files and HARNESS_CLIENTS_DIR=<target> in the deployment's
     environment, and HARNESS_CLIENT=<name> for a dedicated host.
  3. Review <dir>/persona.md and the policy section before the first run.
```

with no mention of Socket Mode, no `COMPOSE_PROJECT_NAME` line, and no `clients/` path. Add `@harness/config-api` and `@harness/config-files` to `scripts/package.json`.

- [ ] **Step 7: Run the scaffolder test to verify it passes**

Run: `pnpm --filter @harness/scripts test`
Expected: PASS.

- [ ] **Step 8: Make the gateway renderer read a document**

Replace `harness/gateway/src/app/render-config.ts` with:

```ts
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configSourceNameFrom, loadConfigSource } from '@harness/core-tools';
import { createLogger, requiredEnv } from '@harness/shared';
import { renderLiteLlmConfig } from '../domain/routing/render.js';
import type { ConfigSource } from '@harness/config-api';

const log = createLogger('gateway');
// harness/gateway/src/app -> harness/gateway. The target stays at the package root because
// docker-compose.yml bind-mounts `../gateway/litellm.config.yaml`: that path is part of the
// deployment, not of the source layout. Nothing here resolves a *client* from a package path.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Render one client's routing table into the LiteLLM config the Compose service mounts. */
export async function renderClientConfig(source: ConfigSource, clientId: string): Promise<string> {
  const loaded = await source.load(clientId);
  if (!loaded) throw new Error(`the ${source.name} config source holds no client "${clientId}"`);
  const target = path.join(packageRoot, 'litellm.config.yaml');
  await writeFile(target, renderLiteLlmConfig(loaded.document.routing), 'utf8');
  return target;
}

const clientId = requiredEnv('HARNESS_CLIENT', ' (whose routing table to render)');
loadConfigSource(configSourceNameFrom(process.env), { env: process.env, log, db: null as never })
  .then((source) => renderClientConfig(source, clientId))
  .then((target) => {
    console.log(`rendered ${clientId} routing to ${target}`);
  })
  .catch((err: unknown) => {
    // The schema exists to turn an invalid routing table into a readable listing; without this
    // the rejection went unhandled and the operator got a stack trace with the listing buried.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
```

**`db: null as never` is only safe because `HARNESS_CONFIG_SOURCE=postgres` would then fail on first use.** Guard it: if `configSourceNameFrom` answers `postgres`, open a real database handle with `createDb()` and close it afterwards. Write that branch rather than leaving the cast — `@harness/gateway` gains `@harness/db` as a dependency for it. Add `@harness/config-api` and `@harness/core-tools` to `harness/gateway/package.json`, and check `pnpm arch` afterwards: `@harness/gateway` gaining an edge to `@harness/core-tools` is new, and if a rule forbids it, move the renderer's composition into `scripts/src/app/` instead and leave `renderClientConfig(routing)` in the gateway taking a `RoutingFile`. **Decide by running `pnpm arch`, and record which way it went in the commit message.**

- [ ] **Step 9: Compose stops baking and bind-mounting a client**

In `harness/compose/node.Dockerfile`, **delete** the `COPY clients ./clients` line and its absence needs no comment — there is nothing to copy. In `harness/compose/docker-compose.yml`, in the `host` service:

- delete the volume `- ../../clients:/srv/agent-harness/clients:ro`
- add `- ${HARNESS_CLIENTS_DIR:-../../clients}:/srv/tenants:ro`
- add to `environment`:
  ```yaml
      # Where a client comes from. `files` reads the volume below; `postgres` reads the database.
      HARNESS_CONFIG_SOURCE: '${HARNESS_CONFIG_SOURCE:-files}'
      HARNESS_CLIENTS_DIR: '/srv/tenants'
  ```
- change `HARNESS_CLIENT: '${HARNESS_CLIENT:-demo-practice}'` to `HARNESS_CLIENT: '${HARNESS_CLIENT-}'`, with the comment: `# One dash: unset means a pooled host, and an empty value must reach the container as empty.`
- in the `core-tools` service, delete nothing further — Task 4 already emptied it of client variables.

In `.env.example`, change `HARNESS_CLIENTS_DIR=/srv/tenants` to the host-side default the Compose mount uses and add the one sentence that Compose mounts it at `/srv/tenants` inside the container. In `.env.ci`, replace `HARNESS_CLIENT=demo-practice` with `HARNESS_CLIENT=fixture`.

Re-record and check the diff — the third and last of this plan's three Compose re-records:

```bash
pnpm surface:record
git diff --stat docs/architecture
git diff docs/architecture/compose-surface.yaml
```

Expected: only `compose-surface.yaml` moved, and its hunks are exactly the two new variables, the changed `HARNESS_CLIENT` interpolation and the changed volume. `tool-surface.json` untouched.

- [ ] **Step 10: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. In particular `surface.test.ts`'s four Compose properties pass, including the new "names no client anywhere" one.

- [ ] **Step 11: Commit**

```bash
git add clients scripts harness/gateway harness/compose harness/config-files harness/config-postgres \
  harness/host/src/domain/playbooks harness/core-tools/src/app/surface.test.ts \
  docs/architecture/compose-surface.yaml .env.example .env.ci pnpm-lock.yaml
git commit -m "feat(clients): keep one fixture document and let a client live outside this repository"
```

---

### Task 10: Documentation

**Files:**
- Modify: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`, `docs/demo.md`
- Modify: `docs/superpowers/specs/2026-09-17-kernel-design.md` (one line in §7)
- Modify: `harness/core-tools/README.md`, `harness/host/README.md`, `identities/static/README.md`, `harness/gateway/README.md`
- Create nothing but the four READMEs Tasks 1, 3 and 7 already wrote; check each still describes what shipped
- Modify: `docs/architecture/graph.svg` (regenerated)

**No code.** If a step here wants a code change, it belongs in the task that shipped the code.

- [ ] **Step 1: Find the runbook and read what is now wrong**

Run: `ls docs/ && grep -rn 'clients/\|HARNESS_PACKS\|HARNESS_SURFACES\|HARNESS_IDENTITY\|HARNESS_POLICY_FILE\|demo-practice\|identity.yaml\|policy.yaml\|routing.yaml\|playbooks.yaml\|SOUL.md' docs ARCHITECTURE.md CONTRIBUTING.md README.md`

Every hit is a line this task rewrites or deletes. Work through them in the order the files are listed; the steps below name the sections that need more than a find-and-replace.

- [ ] **Step 2: `ARCHITECTURE.md` — replace the folder description with "The client document"**

Delete the section that describes `clients/<name>/` as six files and write in its place:

```markdown
## The client document

A client is one document, validated against one schema (`@harness/config-api`), and it is not in
this repository. It carries the persona, the principals and the level each surface gives everyone
else, the policy and the tools the client withholds, the model routing, the playbooks, the skills,
where the knowledge comes from, which surfaces the client serves, which identity plug-in and
runtime it loads, and which packs. Onboarding a client writes a document; it changes nothing here.

A document reaches a host through a **`ConfigSource`**. Two ship: `files`, which reads
`HARNESS_CLIENTS_DIR/<id>/client.yaml` — with `!include` for the persona and the skills, so the
prose a person edits is prose in a file — and `postgres`, which reads versioned rows the platform
writes. `HARNESS_CONFIG_SOURCE` picks one and has no default, because a host that guessed would
start and serve nobody.

A **blueprint** is a complete document with placeholders and a **lock set** of JSON pointers; an
**overlay** is a tenant's edits as a small JSON Patch. `resolve(blueprint, overlay)` applies the
patch and refuses any operation that touches a locked pointer, naming both. A finished agent and a
customisable one are the same object with different locks, and a subscription tier is a lock set.

`clients/fixture/` is the one client in this repository. It exists so the suite has a document to
read, and the scaffolder has one to copy.
```

- [ ] **Step 3: `ARCHITECTURE.md` — update "Identity" and "The host"**

In "Identity", add after the paragraph about declared principals:

```markdown
A document may also give a surface a **default level**: everyone that surface admits who is not
declared acts at that level, under a principal id derived from their surface user id —
`u-<surface>-<slug>-<8 hex of sha256>` — so the same person is the same principal across restarts
and across processes, and every audit row, approval and run they leave behind is still theirs
tomorrow. The digest is what makes the derivation injective: lowercasing and replacing punctuation
maps many user ids onto one slug, and two people sharing one principal id would share one memory
and one audit trail. `http` may never have a default: the run API authenticates with one shared
bearer token, so a default there would let one token holder mint principals at will.

Levels can also come from **groups rather than lists**. `identities/slack-groups` maps a surface's
own user groups to levels, in order, with named exceptions on top and the document's defaults
underneath, cached for `sync.everySeconds`. Three hundred people are six lines of configuration: a
new hire joins a group and exists, a leaver falls to the default or to refusal. It never imports a
surface — `pnpm arch` forbids the edge — and receives a narrow `SurfaceDirectory` (`groupsOf`,
`displayNameOf`) through `IdentityDeps` instead, which is why one implementation will serve any
transport whose workspace has a notion of a group.
```

In "The host", replace the paragraph that describes one process per client with:

```markdown
`createHost(deps)` returns a **pool** over a `Map<clientId, Tenant>`. A tenant is one client's
whole world — its `KernelConfig`, its identity session, its surfaces with their own primary, its
runtime, persona, skills, model, budget, scheduler and approvals runner — built from its resolved
document and cached by that document's version. Two tenants are two of these, which is what makes
the isolation invariant a property of the structure rather than of a predicate somebody remembered
to write.

`HARNESS_CLIENT` decides the shape. **Set**, the host is *dedicated*: it opens that client and
refuses an event for any other, with an audit row naming both. **Unset**, it is *pooled*: the
client comes from the event — a surface's own tenant hint, matched against the keys each document
declares, or the `x-harness-client` header on the run API. A `ConfigSource.watch` that reports a
new version evicts the tenant once its turns have drained; the next event opens a fresh one, so no
turn ever has its policy changed halfway through.
```

- [ ] **Step 4: `ARCHITECTURE.md` — add "Usage"**

```markdown
## Usage

Every run closes with what it spent, summed from its own `model_calls` rows — the kernel's calls
and, since Plan 11a, the runtime's own, which used to be counted for the cost cap and dropped. The
`usage_runs` view groups those totals by client, principal and day, beside run outcomes, durations
and approval counts, and `GET /v1/usage?from&to` returns it for the tenant the request resolved
to, bearer-authenticated like the rest of the run API.

It carries **no content**: no message, no tool argument, no document text, no conversation id. The
view selects no text column at all, and a test asserts its whole column list rather than grepping
a result. Billing, plans and entitlements live above this line; the kernel never knows a customer
paid.
```

- [ ] **Step 5: `CONTRIBUTING.md` — "Adding a client" becomes "Onboarding a tenant"**

Replace that section with:

```markdown
## Onboarding a tenant

You do not. A tenant is a client document in a directory or a table outside this repository, and
onboarding one changes nothing here — that is the boundary this repository is built around.

`pnpm new-client --name <slug> --display-name "<name>" [--pack <pack>] [--target <dir>]` writes
one into `--target`, or into `HARNESS_CLIENTS_DIR` when you have set it. It refuses to run with
neither, because the one place a client must not go is here.

`clients/fixture/` is the exception and the only one: the suite needs a document to read and the
scaffolder needs one to copy. A change to it is a change to the tests, and a pull request that adds
a second client to that directory is a pull request that has misread this section.
```

- [ ] **Step 6: `CONTRIBUTING.md` — "Adding an identity provider"**

Update it for the two things that changed: a plug-in is handed `IdentityDeps` carrying the
document's already-validated `identity` section, its own `settings`, and the `directories` the
loaded surfaces offer — never a path and never the whole document; and a directory-backed plug-in
resolves levels from `groupsOf` rather than from a list, with `identities/slack-groups` as the
worked example. Keep the existing paragraph about `defineIdentityProvider` and the arch rule.

- [ ] **Step 7: The runbook**

In `docs/runbook.md`: rewrite the onboarding section around `pnpm new-client` and a directory
outside the repository; replace every `clients/<name>/<file>.yaml` path with the document's
section name; add an **"Upgrading to Plan 11a"** section saying, in these words, that the
deployment database is recreated — migration 0014 adds five `NOT NULL` tenant columns with no
default, because a default would file every existing row under one tenant — and that the one live
client is re-onboarded as a document rather than carried; update the `/healthz` section for
decision 13 (unchanged for a dedicated host, a `tenants` map for a pooled one); add a **"Usage"**
subsection under the run API showing the one `curl` for `GET /v1/usage?from&to` and saying what is
and is not in it; and add a **"Directory-backed identity"** subsection listing the two Slack scopes
`usergroups:read` and `users:read` that `identities/slack-groups` needs.

- [ ] **Step 8: `README.md`, `docs/demo.md` and the package READMEs**

`README.md`: wherever the client folder is listed, say document. `docs/demo.md`: the demo now
starts from `HARNESS_CLIENTS_DIR` pointing at a directory holding one client, not from
`clients/demo-practice`. `harness/core-tools/README.md`: `buildKernelConfig` takes a document;
`tools.hide`. `harness/host/README.md`: the pool, the tenant, the two modes. `identities/static/README.md`:
it reads a section, not a file, and it has defaults. `harness/gateway/README.md`: the renderer
reads a document through a source. Check the four READMEs Tasks 1, 3 and 7 wrote still describe
what shipped, and fix any sentence that describes an intention rather than the code.

- [ ] **Step 9: One line in the kernel spec**

In `docs/superpowers/specs/2026-09-17-kernel-design.md`, section 7, add after the client-folder
description:

```markdown
> **Superseded by `2026-09-19-hf1-os-boundary-design.md` (Plan 11a).** A client is a document
> loaded through a `ConfigSource` from outside this repository; the six-file folder described here
> is not read by anything.
```

Change nothing else in that spec: it is the record of what was decided then.

- [ ] **Step 10: Regenerate the architecture graph**

Run: `pnpm arch:graph`
Expected: `docs/architecture/graph.svg` gains the four new packages. If `dot` is not on PATH, say so and leave the file — it is a picture, and a stale one is better than a broken one.

- [ ] **Step 11: Run the four gates**

Run the gate command from Task 1 Step 14.
Expected: all green. `pnpm format:check` covers markdown, so a long line fails it — run `pnpm format` if it does.

- [ ] **Step 12: Commit**

```bash
git add ARCHITECTURE.md CONTRIBUTING.md README.md docs harness/core-tools/README.md \
  harness/host/README.md identities/static/README.md harness/gateway/README.md
git commit -m "docs: describe the client document, tenancy, directory identity and the usage export"
```

---

## Self-review

**Review round, 2026-09-19.** `.superpowers/sdd/os-boundary/plan-11a-review.md` read this plan against the worktree and found sixteen issues — seven blocking, nine should-fix — plus five advisory notes; every blocking and should-fix item is applied above, and the advisory notes that were one-line corrections are too.

The seven that would have ended a task red: the eval runner's second `HARNESS_PACKS` read (now a `--packs` option, Task 4); the `conversation.ts → tenancy/types.ts → playbooks/scheduler.ts` import cycle (broken by the leaf `tenancy/resolver-types.ts`, Task 6 Step 3); an `identity.defaults` assertion written a task before the field exists (moved to Task 2); two conformance cases that demanded caller-supplied versions of a content-addressed source (they assert the harness's returned version now); a pooled-routing test that would have opened a real Slack connection (the memory surface gained an optional `workspace` key and the test routes on that); a missing `@harness/runtime-scripted` dependency; and a `poolFixture` trajectory option with no channel to deliver on (a module-level registry in `runtimes/scripted`, filled before `createHost`).

### 1. Spec coverage

| Spec | Where |
|---|---|
| §5.1 `harness/config-api` — document schema, `resolve`, `migrate` | Task 1 |
| §5.1 `harness/config-files`, `harness/config-postgres` | Task 3 |
| §5.1 host `ClientResolver`, per-run config cache, dedicated and pooled modes | Task 6 |
| §5.1 `identities/slack-groups` | Task 7 |
| §5.1 `policy.tools.hide` | Task 4 (the `hidden` set in `catalog.ts`) |
| §5.1 `usage_runs` + `GET /v1/usage` | Task 3 (the view, in the one migration) + Task 8 (the route) |
| §5.1 `clients/` → one fixture; the scaffolder writes the document format | Task 9 |
| §5.1 `clientDirFor`, `HARNESS_IDENTITY_FILE`, `HARNESS_PACKS`, `HARNESS_SURFACES`, `HARNESS_IDENTITY` deleted | Task 4, Task 2, Task 4 (both readers, the eval runner's included), Task 6, Task 4 — the table in Global Constraints names the task for each |
| §5.1 docs | Task 10 |
| §2 decision 2, the client document replacing six files | Task 1 (schema), Task 3 (sources), Task 4 (the kernel reads it), Task 6 (the host reads it) |
| §2 decision 2b, no backwards compatibility | Every task lists what it deletes; `readPlaybooksFile`, `readPersona`, `parsePolicy`, `loadPolicy`, `clientDirFor`, `packNames` and `clients/demo-practice/` all go, none of them behind a flag |
| §2 decision 3, blueprint + overlay + lock set | Task 1 `resolve.ts` and its nine cases; Task 3's files source resolves them on load |
| §2 decision 4, tenancy in the host | Task 6 |
| §2 decision 6, identity at scale | Task 2 (defaults, derived ids) + Task 7 (groups) |
| §2 decision 7, hiding one tool | Task 4 |
| §2 decision 8, usage | Tasks 3 and 8 |
| §2 decision 1b, four boundaries | Nothing to build: `@harness/config-api` is the contract the catalogue implements, and the arch rule added in Task 1 Step 2 is what keeps its direction one-way |
| §3.5, blueprint → overlay → resolved document → `depsForRun` | Task 1 `resolve`, Task 3 `filesConfigSource`, Task 6 `openTenant` |
| §4.1 every `ClientDocument` field | Task 1 Step 7, field for field, including `plugins` reserved at `.max(0)` |
| §4.2 `buildKernelConfig`'s four ambient reads | Task 4 Step 7 |
| §4.2 `repoRoot` computed at import in five places | `tooling/config.ts` (Task 4), `host/src/app/main.ts` (Task 6 — the one that survives resolves `.env`, never a client), `host/src/domain/skills.ts` (kept: it resolves the kernel's **own** `skills/` directory, which §4.2 explicitly exempts), the gateway renderer and the scaffolder (Task 9) |
| §4.2 `closeRun` and startup `reconcile` unscoped | Task 5 |
| §4.2 the first surface is the primary, one per client | Task 1's `SURFACE_ORDER` and the refusal of `http` as primary; Task 6 gives each tenant its own `LoadedSurfaces` |
| §4.2 the checkpointer stays one pool per process | Unchanged, deliberately: thread ids are uuids and `openTenant` does not touch it. The isolation test covers it by driving two tenants' runs against one database |
| §4.2 `HARNESS_HOST_TOKEN` stays one bearer per process | Task 6 keeps it on `RunApiOptions`; the tenant comes from `x-harness-client`, after the bearer check |
| §4.3 `IdentityFile.defaults`, derived ids, `principalFromDerivedId`, `defaults.http` refused | Task 2, re-authored with the reference's own digest values |
| §4.3 `identities/slack-groups`, groups then exceptions then defaults, `sync.everySeconds`, `PrincipalShape` on the name | Task 7 |
| §4.4 `tools.hide` applied in `publishedTools`, absent from the surface, refused like an unknown tool | Task 4 — `publishedCatalogue` already drops a hidden name before any pack contributes, so an unknown-tool call is what a hidden one gets |
| §4.5 the host persists every runtime `usage` event; `runs` gains totals; `audit_log` loses three columns | Tasks 3 and 8 |
| §6 `client_documents`, `client_document_versions`, `runs` totals, `audit_log` drop, `usage_runs`, the five tenant columns, the two idempotency indexes | Task 3, one migration |
| §8 invariant 13 | Task 6 `isolation.test.ts`, tool by tool, plus Task 5's per-repository cases |
| §8 invariant 14 | Task 1 `resolve.test.ts` (both prefix directions, the first violation named, the lock set itself unlockable) |
| §8 invariant 16 | Task 3 (the view's column list asserted in `schema.test.ts`) and Task 8 (asserted again on the wire) |
| §8 invariant 18 | Task 3's registry test: `HARNESS_CONFIG_SOURCE` has no default, `HARNESS_CLIENTS_DIR` is required for `files` |
| §8 invariant 19 | Task 6's resolver and pool tests, and the audited refusal in `attachMessageHandlers` |
| §9 `MemoryConfigSource`, fixtures, `configSourceConformance` every source runs | Task 1 `testing.ts`; Task 3 runs it from both sources |
| §9 two clients in one pooled host with the memory surface and the scripted runtime | Task 6 `poolFixture` and `isolation.test.ts` |
| §9 the tool-surface snapshot grows by nothing; the compose snapshot changes once | Tool surface: unchanged in every task. **Compose: three times, not once** — see the ruling below |
| §12 constraints 1–10 | 1 Global Constraints; 2 Task 4 (`surfaceDeps` from a fixture document); 3 Global Constraints + Tasks 1 and 7; 4 decision 3; 5 the ruling below; 6 Task 4 (`packs: []`); 7 Task 9; 8 Task 6 `materialiseSkills`; 9 Task 6 `app/main.ts`; 10 Task 2 `shapeDisplayName` |

**Not covered, and why.** PR #5 closing unmerged and AMA being re-authored as the platform's first tenant (§5.1's last sentence) is not a change to this repository — it is a GitHub action and a document written in `hf1-platform` — so no task carries it; the controller does it when this plan's pull request merges. Everything else in §5.1 has a task.

### 2. Rulings

Five places where the brief, the spec and the code did not all agree, and what this plan decided.

1. **The Compose snapshot moves three times, not once.** §9 says "the compose snapshot changes once for the new variables", and that is true of the *net* diff. But Task 4 deletes three variables from the `host` service and Task 6 deletes two more, and a task that leaves `surface.test.ts` failing on a byte match is a task that ends red — which the Global Constraints forbid outright. So it is re-recorded in Tasks 4, 6 and 9. The spec's intent (one net change, reviewed once) is preserved: the three diffs are disjoint and the final state is the one §9 describes.

2. **`@harness/config-api` is exempt from the messaging vocabulary scan, and `runtime` is a name rather than a literal.** Spec §4.1 writes `surfaces.slack` with a team id and two secret references, and `runtime: 'deepagents'`. Both would fail the scans this repository runs with an empty allowlist. The ruling: the surfaces schema keeps the spec's shape and the package is scanned for the other three lists only, because a schema that admits a vendor's section is data rather than coupling — `surfaces/slack` has exactly that status; and `runtime` becomes a plug-in-name string, so the fixture document still reads `runtime: deepagents` in YAML while no scanned `.ts` file spells a framework. **The allowlist stays empty**, which was the constraint that mattered.

3. **In Plan 11a a tenant's surface secrets still come from the process environment.** Spec §4.1's `surfaces.slack` carries `signingSecret` but not `appToken` or the approvals channel, because §4.6 deletes socket mode in Plan 11b — which is also where a per-tenant secret is threaded into `SurfaceDeps`. Here the section is declarative: which surfaces load, in what order, what the tenant key is, and which environment variables must be present (checked at load, named in the failure). The honest consequence is stated in decision 6 and again here: **a pooled host cannot yet serve two live Slack tenants.** Invariant 13 is proved with the memory surface, which is what §9 asks for, and 11b plus the platform's ingress is what makes pooled Slack real.

4. **A pooled host warms every client its source lists.** §3.4 has the platform's ingress route an event to a host, and that ingress does not exist until 11b. Until it does, a tenant nobody opened has no surface listening for it, so `createHost` opens them all at start and a pooled host over a source that cannot `list()` is a startup `ConfigError`. `tenantFor` is already the on-demand path and is what the run API uses, so 11b replaces one loop.

5. **The contract is named `SurfaceDirectory`, not `Directory`, and it lives in `@harness/shared`.** The brief called it `Directory`. `@harness/surface-api` and `@harness/identity-api` both need it and neither may import the other, so it goes where the levels and the id patterns already went; and a type called `Directory` in `@harness/shared` beside `path` helpers would read as a filesystem thing. The two methods are the brief's, unchanged: `groupsOf(userId)` and `displayNameOf(userId)`.

Two smaller additions, recorded so a reviewer is not surprised: `ConfigSource` gains `name` (so a failure can say which source holds no such client) and an optional `close()` (so the postgres source can release its poller), beyond §4.1's three members. And `ToolDeps.clientDir` becomes `knowledgeDir: string | null` rather than disappearing, because `syncKnowledge` is its one consumer and the document's `knowledge` section is what now answers it (decision 10).

### 3. Placeholder scan

Searched for `TBD`, `TODO`, `implement later`, `fill in details`, `appropriate error handling`, `add validation`, `handle edge cases`, `write tests for the above`, `similar to Task`, `as needed` and `and so on`. None present. Every code step carries the code; every test step carries the test; every command step carries the command and the expected output.

Four places instruct the implementer to **read a file and match what is there** rather than quoting it, and each is a case where quoting would be a guess this plan has no business making: the real helper names in `records/repository.test.ts` and `deadlines/repository.test.ts` (Task 5 Step 1), the real tool and field names in `docs/architecture/tool-surface.json` (Task 6 Step 12), `ScriptedRuntime`'s trajectory-step shape for a usage event (Task 8 Step 5), and `scratchDatabase`'s signature (Task 3 Step 7). Each says which file to read and what to take from it. **One** step carries a genuine branch — Task 9 Step 8 ("if `pnpm arch` forbids the gateway's new edge, move the composition into `scripts/src/app/`") — and it names the command that decides it and both outcomes. Task 6's `runtimes/scripted` is no longer a branch: the package does not exist, the review checked, and Task 6 Step 11 writes it unconditionally.

### 4. Type consistency

- **`ClientDocument`** has the same fields wherever it is read: `schemaVersion`, `id`, `displayName`, `persona`, `identity`, `policy`, `routing`, `playbooks`, `skills`, `knowledge`, `surfaces`, `identityProvider`, `runtime`, `plugins`, `packs`. Task 1 declares them; Task 3's two sources parse them; Task 4 reads `id`, `policy`, `packs` and `knowledge`; Task 6 reads `persona`, `identity`, `identityProvider`, `runtime`, `surfaces`, `playbooks` and `skills`; Task 9's fixture writes every one of them.
- **`policy.tools.hide`** is `string[]` with a `.default([])` at the schema, `KernelConfig.hiddenTools: readonly string[]` on the bag, and `deps.hiddenTools` at the one place it is applied. Three names for one thing would have been a bug; there is one path.
- **`SecretRef`** is `{ env: string }` in `types.ts`, `SecretRefShape` in `document.ts`, and the only consumer is Task 6's `assertSecretsPresent`. No task invents a second shape.
- **`Tenant`** is `{ clientId, version, document, host, runner, scheduler, close }` in Task 6's `types.ts`, and Tasks 7, 8 and 9 use exactly those members. `Tenant.host` is a `Host` whose own members are untouched, which is why no other host module changed signature.
- **`ClientResolver`** is `{ mode, resolve(ref) }` and `InboundRef` is the two-armed union, both declared in the leaf `tenancy/resolver-types.ts` and re-exported from `tenancy/types.ts`; `dedicatedResolver`, `pooledResolver`, `attachMessageHandlers` and `handleApiRequest` are its four consumers and all four narrow on `ref.from`. `conversation.ts` imports the leaf, never `types.ts`, which is what keeps `no-circular` green (see Task 6 Step 9).
- **`SurfaceDirectory`** is declared once, in `@harness/shared`, and imported by `@harness/surface-api`, `@harness/identity-api`, `surfaces/slack` and `identities/slack-groups`.
- **`ConfigSource`** is `{ name, load, watch?, list?, close? }` and both implementations and `MemoryConfigSource` match it member for member; `configSourceConformance` is what proves it.
- **`ConfigSourceHarness.put`** is `(document, version) => Promise<string>` in all three of its implementations, and the string it answers with is the version that source will serve: the argument for `MemoryConfigSource` and for `@harness/config-postgres`, the content hash for `@harness/config-files`. The conformance suite asserts against that return and never against a literal, which is what lets a content-addressed source run the same suite as a versioned one.
- **`closeRun`** takes `(db, client, runId, status, now?)` from Task 5 and gains a sixth optional `totals` in Task 8; `finishKernel` takes `(db, client, runId, status, now, close)` from Task 5 and keeps it in Task 8. No caller sees two shapes.
- **`IdentityDeps`** is `{ env, log, identity, settings }` after Task 2 and gains `directories` in Task 7; every literal in the workspace is updated in the task that widens it, which the Files lists name.
- **`UserLevel`** is declared once, in `harness/identity-api/src/types.ts`, and `principals.ts` re-exports it; `IdentityDefaultsShape`, `principalFromDefault`, `principalFromDerivedId` and the slack-groups settings all key off it.
- **The usage row's fifteen fields** are the same list in three places and are asserted whole in two of them: `schema.ts`'s `pgView` columns, `schema.test.ts`'s `information_schema` check, `usage.ts`'s `UsageRow`, and `usage.test.ts`'s `Object.keys` assertion.

