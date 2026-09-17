# Plan 7: Kernel identity and hygiene — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the kernel an identity it did not choose — a `Principal` bound to every run before the model sees anything, a level × action-class policy matrix, one `RunContext` per run, and `harness_set_context` gone — and move the two hygiene items the next plans need out of the way: untrusted document parsing into a files worker with no key and no database, and a CI workflow that runs the four gates on every pull request. The demo keeps running on Hermes with a static principal at the end of it.

**Architecture:** Six moves. (1) **The identity contract.** A new leaf package `@harness/identity-api` declares `Principal`, the five `LEVELS` (which live in `@harness/shared`, because the pack contract's policy matrix is keyed by them too), `IdentityProvider`, `defineIdentityProvider`, `levelAtLeast`, the zod schema of `clients/<name>/identity.yaml`, and `StaticIdentity` under a `testing` subpath. `identities/static` wraps `StaticIdentity` around a parsed `identity.yaml` and is loaded by name from `HARNESS_IDENTITY`, exactly as packs and surfaces are. (2) **The policy matrix.** `@harness/pack-api`'s `Policy` becomes `classes` plus `levels.<level>.<class>` overrides over eight action classes; the kernel's `decide(actionClass, level, policy)` reads it and today's `policy.yaml` parses unchanged. (3) **The principal on `ToolDeps`.** `caller` goes; `principal: Principal` replaces it on every reader, and every audit row, approval and run row carries the principal id. (4) **One context per run.** `SessionContext` becomes `RunContext`, built once per run by `openRun`; `buildKernelConfig()` does the startup-only work and `depsForRun(config, { db, principal, context })` clones it per run; the stdio server resolves `HARNESS_PRINCIPAL` against `identity.yaml` at startup and opens one run per process; migration `0010` adds `runs.principal_id`, `thread_id`, `surface`, `conversation`; `harness_set_context` and its step in every skill are deleted. (5) **The files worker.** `@harness/files` is a `node:http` server on an `internal: true` Compose network that parses a document under the storage root with `pdftotext`, falling back to `pdftoppm | tesseract`; core-tools reaches it through a `DocumentParser` seam with a `localParser` (today's subprocess code) for tests and bare metal and a `remoteParser` when `HARNESS_FILES_URL` is set. (6) **Hygiene.** The Docker socket mount and `terminal.backend: docker` go; every client path in Compose is derived from `HARNESS_CLIENT`; the pinned forms directory goes; `.github/workflows/ci.yml` runs the four gates against a `pgvector/pgvector:pg16` service and builds every image.

**Tech Stack:** unchanged. Node `>=22`, pnpm `11.4.0`, TypeScript 7 in every package (`typescript@6.0.3` at the workspace root only, for typescript-eslint — never change that), zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `0.45` + drizzle-kit, `@modelcontextprotocol/server`/`client` v2, vitest 5, Postgres 16, ESLint `9.39.5`, Prettier `3.9.7`, dependency-cruiser `16.10.4`. No new third-party dependency: `yaml` (already in core-tools) is added to `identities/static`, `pdf-lib` (already in four packages) to `@harness/files` as a devDependency for fixtures, and nothing else.

**Spec:** `docs/superpowers/specs/2026-09-17-kernel-design.md` — this plan is the row "7 Kernel identity and hygiene" of its section 10. It implements sections 4.1, 4.4, 5.1, 5.2, migration 0010 of section 6, the CI workflow and the "every client path derived from `HARNESS_CLIENT`" and "no Docker socket" parts of section 7, and invariants 1, 2, 5, 6 and 11 of section 8. Nothing from Plans 8–10 is in scope: no runtime, no host, no surface-contract change, no `threads`/`messages`, and Hermes and the approvals host keep running.

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript 7 (`^7.0.2`) in every package, `typescript@6.0.3` at the workspace root only for typescript-eslint and never changed; ESM only; zod v4 imported as `import * as z from 'zod/v4'`; vitest `^5.0.0`; drizzle-orm `^0.45.2`.
- **The four gates pass at the end of every task, at zero errors:** `pnpm -r typecheck`, `pnpm lint` (zero errors; the type-aware warnings are a known backlog), `pnpm arch` (zero violations: every rule is an error), `pnpm format:check`, and `pnpm test` (lint, then every package's suite; needs Postgres on `TEST_DATABASE_URL`, see `.env.example`; the suites run serially — `fileParallelism: false`). No task ends red and no gate is parked.
- **Migrations:** edit `harness/db/src/domain/schema.ts`, then from `harness/db/` run `pnpm drizzle-kit generate` twice — the second run must print "No schema changes". Never `--custom`.
- **Every new environment variable is documented in `.env.example` in the same commit** that first reads it: `harness/core-tools/src/app/surface.test.ts` scans the source for every name the code reads and fails on one the example file does not document. The names this plan adds are `HARNESS_PRINCIPAL`, `HARNESS_IDENTITY`, `HARNESS_IDENTITY_FILE`, `HARNESS_FILES_URL`, `HARNESS_FILES_PORT` and `HARNESS_FILES_BIND`. `CORE_TOOLS_CALLER` is removed in Task 4 and leaves `.env.example` in the same commit.
- **Every new package gets one `PACKAGES` row and one `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs`** plus the layer rules spec section 3.1 lists for it (Task 1: `identity-api-imports-only-shared`; Task 3: `an-identity-plugin-imports-only-api-and-shared`, `core-tools-never-statically-imports-an-identity-plugin`; Task 7: `files-imports-only-shared`). `docs/architecture/graph.svg` is regenerated with `pnpm arch:graph` in Task 11 only if `dot` is on `PATH` (it is on the machine this plan was written on); skip the regeneration if `which dot` prints nothing.
- **The tool-surface snapshot (`docs/architecture/tool-surface.json`) changes in exactly one task, Task 5**, which deletes `harness_set_context`, re-records with `pnpm surface:record` and commits the diff. **The compose snapshot (`docs/architecture/compose-surface.yaml`) changes in Tasks 8 and 9 only**, each of which re-records it and describes the diff in the commit. Every other task leaves both files byte-identical; if one moves, something is wrong.
- **Kernel vocabulary.** `harness/core-tools/src/kernel-vocabulary.test.ts` keeps its empty allowlist. Task 2 adds the rule from spec decision 20 — no `deepagents`, `langchain`, `langgraph`, `entra`, `teams`, no client name (`demo-practice`) and no runtime name (`hermes`) in `harness/core-tools/src`, `harness/identity-api/src`, `identities/static/src`, `harness/files/src` or `evals/src` outside tests — and the existing credentialing regex still forbids the word `provider` in `harness/core-tools/src`, so **no kernel module may spell "identity provider"**: the kernel says "identity plug-in" and imports the contract's `IdentityModule`/`IdentitySession`/`IdentityDeps`/`Principal` types, never `IdentityProvider` (decision 4 below).
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **TDD in every task:** write the failing test first, run it and watch it fail, implement, run it green, run the gates, commit.
- **Backward compatibility inside this plan.** Hermes and the approvals host keep working at every commit. `CORE_TOOLS_CALLER` is replaced by `HARNESS_PRINCIPAL` (Task 4): a principal id declared in `clients/<name>/identity.yaml`; the stdio server and the approvals child set it; the demo config and Compose are updated; a missing identity file or an unknown id is a startup `ConfigError`. The demo's `identity.yaml` (Task 3) declares `u-practice-manager` (admin), `u-coordinator` (lead), `svc-hermes` (service, the Hermes-launched child), `svc-approvals` (service, the approvals child) and `svc-local` (service, the stdio default for the inspector and evals). Surface `allowedUsers` stay untouched.
- **Never run `docker compose up`, `docker compose down`, `pnpm db:up` or `pnpm db:down` from a task.** `docker compose ... config` is read-only and is what the surface recorder uses; that one is fine. `docker compose build` is run only by CI (Task 10).
- **Never source `.env` into the shell before running tests.**
- Test database: `postgres://harness:harness@localhost:15432/harness_test`. It exists; do not create or drop it. **One exception:** Task 4's migration test creates and drops `harness_test_migration_0010_<pid>` over the `harness_test` connection, exactly as `migration-0009.test.ts` does.
- Do not push from a task.

---

## Facts verified for this plan

Everything below was read out of the worktree at `.claude/worktrees/plan-7-kernel-identity` (branch `worktree-plan-7-kernel-identity`, main at `084a2df`) on 2026-09-17. Quote the file, not memory.

| Fact | Value | Where |
|---|---|---|
| `ToolDeps` carries `caller: string` and `context: SessionContext` (`runId?`, `skill?`, `skillVersion?`, `tool?`) | `caller: string;` … `context: SessionContext;` | `harness/core-tools/src/domain/tooling/types.ts:53,79` |
| `caller` has six readers in shipping code | `context.ts:17` (audit base), `approvals/repository.ts:33,45` (summary, `requestedBy`), `records/repository.ts:238` (`confirmedBy`), `session/repository.ts:53` (`runs.caller`), `app/main.ts:41` (log line), `app/server.ts:45` (`envOrDefault('CORE_TOOLS_CALLER', 'hermes')`) | grep `\.caller\b` |
| …and three test builders set it | `testing.ts:49` (`'test-caller'`), `app/record-surface.ts:38` (`'surface'`), `evals/src/domain/pipeline.ts:193` (`'eval-runner'`), `evals/src/judge-deps.test-helpers.ts:42` (`'judge'`) | those files |
| `PackToolDeps` mirrors `caller` | `readonly caller: string;` | `harness/pack-api/src/types.ts:113` |
| No pack reads `deps.caller` or `deps.context` | zero hits outside core-tools | grep over `packs/*/src` |
| Policy is a flat five-class table | `ACTION_CLASSES = ['read', 'write.internal', 'external', 'financial', 'destructive']`, `type Policy = Record<ActionClass, Behavior>` | `harness/pack-api/src/policy.ts:14-20` |
| `DEFAULT_POLICY`, `parsePolicy`, `loadPolicy`, `decide(actionClass, policy)` are the kernel's | `harness/core-tools/src/domain/tooling/policy.ts` | whole file |
| `decide` has two callers | `registry.ts:37` (`switch (decide(tool.actionClass, deps.policy))`), `approvals/execute.ts:48` (replay re-check) | those files |
| `Pack.policy` is `Partial<Policy>` and the healthcare pack fills it from `packs/healthcare/policy.yaml`'s `classes:` block | `policy: classes` | `harness/pack-api/src/types.ts:207`, `packs/healthcare/src/index.ts:15-17,46` |
| Nothing merges `Pack.policy` into `deps.policy` | "carried, not merged" | `ARCHITECTURE.md:213-215` |
| The evals injection check compares policies by top-level entries | `for (const [cls, behavior] of Object.entries(baselinePolicy))` | `evals/src/domain/score.ts:198-202`; test at `score.test.ts:228-246` |
| `harness_set_context` is the first of three tools in `tools/harness.ts` and its logic is `setRunContext` | `harnessTools = [harnessSetContext, harnessReconcile, harnessNotify]` | `harness/core-tools/src/tools/harness.ts:18-35,65`, `domain/session/repository.ts:25-54` |
| Its tests are the first three cases of `harness.test.ts`, and `registry.test.ts` has one test and one fixture that mutate the context | `'stamps run, skill, and version…'`, `'clears a field when null is passed'`, `'refuses to adopt a run…'`; `mutateContextThenThrow` + `'restores session context when a tool transaction rolls back'` | `tools/harness.test.ts:19-56`, `domain/tooling/registry.test.ts:82-95,284-299` |
| `preservingContext` exists only to rewind those mutations | `context.ts:30-57`; called from `execution.ts:66,93` | those files |
| Every skill lists `harness_set_context` first in `metadata.harness.tools` and has a "## First, always" section calling it | four healthcare skills, one stories skill | `packs/*/skills/*/SKILL.md` |
| `skills-frontmatter.test.ts` requires it | `expect(tools, …).toContain('harness_set_context')` | `harness/core-tools/src/tools/skills-frontmatter.test.ts:83` |
| SOUL rule 6 mandates it | "**Call `harness_set_context` first, every time.**" | `clients/demo-practice/SOUL.md:44-48` |
| The evals runner never calls it | zero hits for `set_context` and `CORE_TOOLS_CALLER` in `evals/src` | grep |
| The recorded tool surface lists 23 tools, `harness_set_context` among them | `RECORDED_TOOLS` | `harness/core-tools/src/app/surface.test.ts:71-96`, `tools/audit.test.ts:88-115` |
| `CORE_TOOLS_CALLER` is read in one place and set in four | read: `app/server.ts:45`; set: `harness/approvals/src/app/child-env.ts:42` (`'approvals-app'`), `clients/demo-practice/hermes.config.yaml:107` (`'hermes'`), `.env.example:15`, `clients/demo-practice/.env.example:7`; tests: `app/main.test.ts:25`, `app/server.test.ts:21-23`, `harness/approvals/src/app/child-env.test.ts:34`, `harness/approvals/src/domain/execute/mcp-client.test.ts:48` | grep |
| `runs` has six columns | `id, client, caller (NOT NULL), channel, started_at, ended_at` | `harness/db/src/domain/schema.ts:190-197` |
| `docker compose config --no-interpolate` renders without a root `.env`, `env_file` notwithstanding | exit 0 from a scratch tree holding only the compose file | this plan's author, 2026-09-17 |
| The last migration is 0009 and the journal has ten entries | `drizzle/0009_surface_addressing.sql`, `meta/_journal.json` idx 9 | `harness/db/drizzle/` |
| 0009 is the template for a hand-written data section, and its test the template for replaying one | `-- harness:data-section:begin … end`; `migrationStatements()`, `scratchDatabase()` helpers | `harness/db/drizzle/0009_surface_addressing.sql`, `src/domain/migration-0009.test.ts`, `migration-sql.test-helpers.ts`, `scratch-database.test-helpers.ts` |
| `resetDatabase` truncates `runs` between tests and between eval cases | `TRUNCATE TABLE audit_log, tool_effects, model_calls, runs, …` | `harness/db/src/testing.ts:26-30`; `evals/src/domain/pipeline.ts:225` |
| `audit_log.run_id`, `tool_effects.run_id`, `model_calls.run_id` are nullable foreign keys to `runs` | `runId: uuid('run_id').references(() => runs.id)` | `schema.ts:203,232,247` |
| The document text pipeline is one module | `extractDocumentText(absPath)`: `pdf-parse` text layer, `MIN_CHARS_PER_PAGE = 40`, `ocrPdf` (`pdftoppm -r 300 -png -f n -l n` then `tesseract <png> stdout -l eng --psm 6`), `ocrImage`, `assertBinary` | `harness/core-tools/src/domain/documents/text.ts` |
| Its one caller resolves the path first, then reads | `readForModel`: `resolveStoragePath(deps.storageDir, row.storagePath)` then `extractDocumentText(abs)` | `domain/documents/pipeline.ts:118-127` |
| `runBounded` is the bounded subprocess helper, `assertInsideRoot` the containment primitive | `@harness/shared` `subprocess.ts`, `paths.ts` | those files |
| Two fixture PDFs exist in the repo and `pdf-lib` is a dependency of four packages | `packs/healthcare/forms/*.pdf`; `pdf-lib` in core-tools, evals, both packs | `find`, `grep pdf-lib` |
| The shared PDF fixture writer for tests | `writePdf(root, relativePath, pageTexts)` | `harness/core-tools/src/domain/documents/pdf.test-helpers.ts` |
| Compose names `demo-practice` three times | `hermes-init` bind `../../clients/demo-practice:/srv/client:ro`; `HARNESS_POLICY_FILE: '/srv/agent-harness/clients/demo-practice/policy.yaml'` on `hermes` and on `approvals` | `harness/compose/docker-compose.yml:98,171,220` |
| …pins the forms directory twice, and mounts the Docker socket once | `HARNESS_FORMS_DIR: '/srv/agent-harness/packs/healthcare/forms'` on `hermes` and `approvals`; `/var/run/docker.sock:/var/run/docker.sock` on `hermes` | `docker-compose.yml:167,215,195` |
| Hermes's terminal backend is docker | `terminal: backend: 'docker'` | `clients/demo-practice/hermes.config.yaml:29-35` |
| The child-env allowlist forwards five optional variables and pins the caller | `HARNESS_POLICY_FILE`, `HARNESS_FORMS_DIR`, `HARNESS_GATEWAY_URL`, `HARNESS_PACKS` forwarded when set; `CORE_TOOLS_CALLER: 'approvals-app'` | `harness/approvals/src/app/child-env.ts:36-50` |
| A pack, a surface, is loaded by name through one dynamic import with three named failure modes | `loadPacks(names)`, `loadSurfaces(names, deps)` | `harness/core-tools/src/domain/packs/registry.ts:184-208`, `harness/approvals/src/domain/surfaces/registry.ts:70-113` |
| `loadPacks`' dynamic `import(name)` is invisible to dependency-cruiser, so a plug-in package's `index.ts` is kept off the orphan list only by a static import from a test or `testing.ts` | `core-tools-never-statically-imports-a-pack` exempts `\.test\.ts$` and `src/testing.ts` | `.dependency-cruiser.cjs:150-159`; `no-orphans` at `:186-199` |
| The env scan walks five roots and recognises helper calls with the name first | `SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'evals', 'scripts']`; `HELPER_ENV` | `harness/core-tools/src/app/record-surface.ts:156-162,174-183` |
| The arch glob has no `identities/` entry and the workspace has no `identities/*` | `scripts.arch`, `pnpm-workspace.yaml` | root `package.json`, `pnpm-workspace.yaml` |
| The kernel vocabulary scan is a list of `{ root, forbidden, minFiles, skip }` entries | `SCANNED` | `harness/core-tools/src/kernel-vocabulary.test.ts:35-72` |
| `hermes` appears in five non-test kernel lines today, `demo-practice` in none | `app/server.ts:45,60`, `app/record-surface.ts:93,99,152` | grep |
| `pnpm install --frozen-lockfile` accepts a workspace copy that omits packages the lockfile lists | verified in a scratch directory holding only the root manifests and `harness/shared` | this plan's author, 2026-09-17 |
| The three Dockerfiles copy the workspace directories by name | `core-tools.Dockerfile`: `harness packs evals`; `hermes.Dockerfile`: `harness packs clients scripts`; `node.Dockerfile`: `harness packs surfaces clients scripts` | `harness/compose/*.Dockerfile` |
| The scaffolder copies a fixed list of template files | `TEMPLATE_FILES = ['SOUL.md', 'hermes.config.yaml', 'policy.yaml', '.env.example', 'routing.yaml', 'cron/playbooks.sh']` and its test pins the copied list | `scripts/src/domain/scaffold.ts:28-35`, `scaffold.test.ts:47-58` |
| `.gitignore` ignores every `*.env` except `.env.example` | `*.env` / `!.env.example` | `.gitignore:3-4` |
| There is no `.github/` directory | — | `ls .github` |
| `init.sql` creates the three extra databases | `harness_test`, `litellm`, `harness_evals` | `harness/compose/postgres/init.sql` |
| The crypto test that "asserts an unset key" calls `loadKey(undefined)` explicitly and does not read the environment | `expect(() => loadKey(undefined)).toThrow(/HARNESS_ENCRYPTION_KEY/)` | `harness/db/src/shared/crypto.test.ts:30` |
| `dot`, `docker`, `pdftotext`, `pdftoppm` and `tesseract` are all on `PATH` here | `/opt/homebrew/bin/…`, `/usr/local/bin/docker` | `which` |

---

## Decisions where the spec leaves a detail open

1. **`LEVELS` and `Level` live in `@harness/shared`, re-exported by both contracts.** Spec 4.1 declares them in `@harness/identity-api`; spec 4.4 keys `Policy.levels` by `Level` in `@harness/pack-api`. The two contracts may not import each other (`pack-api-imports-only-shared`, and the new `identity-api-imports-only-shared`), so the enum goes where `CONVERSATION_ID_PATTERN` went for the same reason. `@harness/identity-api` still exports `LEVELS` and `Level` as its public API, exactly as the spec's snippet reads; `levelAtLeast` stays in the identity contract.

2. **`RunContext` does not carry the principal; `deps.principal` does.** Spec 5.1 says both that "`ToolDeps` gains `principal`" and that `RunContext { …, principal, … }`. Two copies of one identity is how they drift, so `RunContext` is `{ runId, threadId, surface, conversation, skill?, skillVersion?, tool? }` and the principal is `deps.principal` only. `depsForRun(config, { db, principal, context })` takes them as two arguments, which is the signature the spec writes. `tool` stays on the context because `stageEffect` reads the currently executing tool's name from it and `withCurrentTool` sets it; that is the one field a handler's execution still mutates, and `withCurrentTool`'s `try/finally` restores it without `preservingContext`.

3. **`RunContext.runId` is `string | null`, and the two shipping entry points always open a run.** Every `run_id` foreign key is nullable and `resetDatabase` truncates `runs` between tests. Requiring a run row for every `makeTestDeps` would make the sixty-odd suites that only assert on audit rows open one each. So `openRun` (Task 4) writes the `runs` row and returns a `RunContext`; the stdio server calls it once per process and the eval pipeline once per handle, re-inserting the same row after each `reset()`; `makeTestDeps` and the surface recorder pass `runId: null`, which is what `SessionContext` meant when it was empty. A test that wants a run opens one with `openRun` and passes the context in.

4. **The kernel never spells "provider".** `kernel-vocabulary.test.ts` forbids `provider` in `harness/core-tools/src` (it is a healthcare word) and its allowlist must stay empty. So `@harness/identity-api` exports the spec's `IdentityProvider` and `defineIdentityProvider` for plug-in authors, **and** an `IdentityModule { identity: IdentityProvider }` type naming what an `identities/*` package exports as `identity`; core-tools imports `IdentityModule`, `IdentitySession`, `IdentityDeps` and `Principal`, calls the plug-in "the identity plug-in" in prose, and its loader is `loadIdentity(name, deps)` in `domain/identity/registry.ts`. The exported symbol is `identity` (a pack exports `pack`, a surface exports `surface`).

5. **`Pack.policy` becomes `PolicyOverrides`, the shape a `policy.yaml` parses to.** `Partial<Policy>` over the new `Policy { classes: Record<…>; levels }` would mean "either the whole classes table or none", which no pack means. `PolicyOverrides { classes?: Partial<Record<ActionClass, Behavior>>; levels?: Partial<Record<Level, Partial<Record<ActionClass, Behavior>>>> }` is what the healthcare pack already reads out of its file and what a client's file is. Still carried, not merged (ARCHITECTURE.md's ruling stands).

6. **`DEFAULT_POLICY` encodes spec 4.4's table as the practitioner column plus four level overrides.** `classes` (what a client's `classes:` block overrides for every level): `read` auto, `write.self` auto, `write.internal` auto, `write.assign` auto, `external` approval, `financial` blocked, `destructive` approval, `admin` blocked. `levels.member`: `write.internal` approval, `write.assign` approval, `destructive` blocked. `levels.lead`: `financial` approval. `levels.admin`: `financial` approval, `admin` auto. `levels.service`: `write.assign` approval, `destructive` blocked. `decide` reads `policy.levels[level]?.[actionClass] ?? policy.classes[actionClass]`; Task 2's test asserts all forty cells against the spec's table. A client's `classes:` block replaces the kernel's `classes` entries one by one and its `levels:` block replaces the kernel's per level and per class, so the demo's file — five `classes:` lines — keeps meaning what it meant for `lead` and `admin`, which is what spec 4.4 promises.

7. **The test principal is a user at level `practitioner`.** The practitioner row of the table equals today's flat table on every old class (`read` auto, `write.internal` auto, `external` approval, `financial` blocked, `destructive` approval), so every existing kernel test keeps its behaviour with no edit beyond the audited id. `svc-` principals at level `service` are used where a service is meant: the eval runner (`svc-evals`), the judge (`svc-judge`), the surface recorder (`svc-surface`), the Hermes child (`svc-hermes`), the approvals child (`svc-approvals`), the stdio default (`svc-local`).

8. **The stdio server takes its identity plug-in from `HARNESS_IDENTITY` (default `@harness/identity-static`) and the file from `HARNESS_IDENTITY_FILE` (default `<repo>/clients/<HARNESS_CLIENT>/identity.yaml`).** Spec 5.1 names only `HARNESS_PRINCIPAL`. The plug-in name follows the `HARNESS_PACKS`/`HARNESS_SURFACES` convention and is what Weave's `identities/entra` will set. The file path defaults from the client folder exactly as the repository root `.env` is found today — four directories up from `app/main.ts` — which is `/srv/agent-harness/clients/<name>/identity.yaml` in both containers; the override exists so a test can point a spawned server at a temporary file while `HARNESS_CLIENT` says `smoke` or `exec-test`, and for a bare-metal run whose client folder lives elsewhere. Compose does not set it.

9. **`runs.caller` stays, and carries the principal id.** Dropping a `NOT NULL` column is Plan 8's business once nothing reads it; `openRun` writes the principal id into both `caller` and the new `principal_id`, and migration 0010 backfills `principal_id` from `caller` in a hand-written data section before setting it `NOT NULL`, so an existing deployment's rows stay valid.

10. **The files worker answers `{ pages: PageText[], text: string, ocrUsed: boolean }`.** Spec 5.2 writes `{ pages, text, ocrUsed }` without saying what `pages` is. core-tools needs the text per page (`fields.source_page`, the `<<<PAGE n>>>` fences), so `pages` is the array of `{ num, text }` and `text` is the pages joined with a blank line, for a caller that wants one string. `ParsedDocument` is declared in core-tools' `domain/documents/types.ts` and again in `harness/files/src/domain/types.ts`: three fields, structurally identical, because `harness/files` imports `@harness/shared` only and core-tools must not import the worker.

11. **The worker's text layer is `pdftotext`, the local parser's stays `pdf-parse`.** Spec 5.2 says the worker "runs `pdftotext` first"; today's local code uses `pdf-parse`. The worker follows the spec (page count from `pdfinfo`, pages split on the form feed `pdftotext` emits, the same 40-characters-per-page threshold, the same `pdftoppm | tesseract` fallback, same DPI, language and page mode); the local parser is today's `text.ts` unchanged behind the seam, because it is what every existing document test drives and what a bare-metal developer runs. The OCR loop is therefore written twice, once per process boundary; it cannot be shared without a package both may import, and `@harness/shared` holds no PDF knowledge.

12. **Worker errors are `ParseError { status, message }` and the message never carries a path.** `403` for a path outside the storage root, `404` for a file that is not there, `415` for a type that is neither PDF nor image, `422` when a binary failed or timed out, `500` when a binary is missing. Only a file's basename is ever quoted, as `text.ts` does today. `remoteParser` maps a non-200 reply to a `ToolError` with the worker's message (safe by construction) and a transport failure to `ToolError('document parser is unreachable')`.

13. **Compose paths use `${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}` at the three path sites.** A default at a path site would mount the wrong client's folder silently; the existing `HARNESS_CLIENT: ${HARNESS_CLIENT:-demo-practice}` environment lines keep their default. `docker compose config --no-interpolate` leaves both spellings unexpanded, so the snapshot stays machine-independent.

14. **`.env.ci` is committed and `.gitignore` gains `!.env.ci`.** `*.env` is ignored; a CI environment file has no secret in it and has to be in the tree.

15. **Two tasks change order from the brief.** The brief lists the policy matrix first and the identity contract second, but `decide(actionClass, level, policy)` needs a level from `deps.principal`, and `Principal` needs `Level`. So Task 1 is the identity contract (with `LEVELS` in shared), Task 2 the policy matrix and the principal on `ToolDeps` together (one coherent cut: invariant 2), Task 3 `identities/static`, Task 4 the run context. `harness_set_context` is deleted in Task 5 together with the skills, because `skills-frontmatter.test.ts` checks every listed tool against the published catalogue and would go red between a task that deletes the tool and one that edits the skills.

16. **Skill attribution goes dark until Plan 8, and the demo script says so.** With `harness_set_context` gone, nothing stamps `skill` and `skill_version` on audit rows until the runtime does (spec 5.1: "the runtime stamps `skill` when it activates one"). `docs/demo.md` step 5 stops pointing at those two columns; the run id and principal are what the trail shows in the meantime.

---

## File structure

Paths are relative to the repository root. The workspace grows from thirteen packages to sixteen (`harness/identity-api`, `harness/files`, `identities/static`) and gains one top-level directory, `identities/`.

### `@harness/shared` and `@harness/identity-api` — the contract (Task 1)

| New / changed file | Responsibility |
|---|---|
| `harness/shared/src/levels.ts` + `levels.test.ts` | `LEVELS`, `USER_LEVELS`, `Level` |
| `harness/shared/src/index.ts` | exports them |
| `harness/identity-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package |
| `harness/identity-api/src/types.ts` | the leaf: `Principal`, `IdentitySession`, `IdentityDeps`, `IdentityProvider`, `IdentityModule` |
| `harness/identity-api/src/identity.ts` | `defineIdentityProvider`, `levelAtLeast` |
| `harness/identity-api/src/principals.ts` | `PRINCIPAL_ID_PATTERN`, `PrincipalShape`, `IdentityFileShape`, `parseIdentityFile` |
| `harness/identity-api/src/testing.ts` | `StaticIdentity` — the `./testing` subpath |
| `harness/identity-api/src/index.ts` | the public API |
| `harness/identity-api/src/identity.test.ts`, `principals.test.ts`, `static.test.ts` | the tests |
| `.dependency-cruiser.cjs` | one `PACKAGES` row, one `WORKSPACE_DIRS` entry, `identity-api-imports-only-shared`, the collapse pattern |

### The policy matrix and the principal (Task 2)

| Old | New |
|---|---|
| `harness/pack-api/src/policy.ts` (five classes, flat `Policy`) | eight classes, `Policy { classes, levels }`, `PolicyOverrides`, `ClassTable`, `LevelOverrides` |
| `harness/pack-api/src/types.ts` (`PackToolDeps.caller`, `Pack.policy: Partial<Policy>`) | `PackToolDeps.principal: PrincipalView`, `Pack.policy: PolicyOverrides`, `PrincipalView` |
| `harness/pack-api/src/index.ts`, `kernel.test.ts` | exports; the fixture's principal |
| `harness/core-tools/src/domain/tooling/policy.ts` + test | `DEFAULT_POLICY` matrix, `mergePolicy`, `parsePolicy` with `levels:`, `decide(actionClass, level, policy)` |
| `harness/core-tools/src/domain/tooling/types.ts` | `caller` → `principal: Principal` |
| `context.ts`, `registry.ts`, `approvals/repository.ts`, `approvals/execute.ts`, `records/repository.ts`, `session/repository.ts`, `app/main.ts`, `app/server.ts`, `app/record-surface.ts`, `testing.ts`, `index.ts` | the readers |
| `harness/core-tools/src/kernel-vocabulary.test.ts` | the framework, client and runtime regex over five roots |
| `packs/healthcare/src/index.ts` | `policy: { classes }` |
| `evals/src/domain/pipeline.ts`, `judge-deps.test-helpers.ts`, `domain/score.ts` + test | principals; the matrix comparison |
| `harness/core-tools/package.json` | `@harness/identity-api` dependency |

### `identities/static` (Task 3)

| New / changed file | Responsibility |
|---|---|
| `identities/static/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package |
| `identities/static/src/index.ts` + `index.test.ts` | `identity`: reads `identity.yaml`, wraps `StaticIdentity` |
| `clients/demo-practice/identity.yaml` | the five demo principals |
| `harness/core-tools/src/domain/identity/registry.ts` + test | `loadIdentity(name, deps)` |
| `harness/core-tools/package.json` | `@harness/identity-static` dependency |
| `pnpm-workspace.yaml`, root `package.json` (`arch`, `arch:graph`), `.dependency-cruiser.cjs` | the new directory, two rules |
| `harness/compose/core-tools.Dockerfile`, `hermes.Dockerfile`, `node.Dockerfile` | `COPY identities ./identities` |
| `scripts/src/domain/scaffold.ts` + test | `identity.yaml` in `TEMPLATE_FILES` |
| `harness/core-tools/src/app/record-surface.ts` | `'identities'` in `SOURCE_ROOTS` |

### The run context (Task 4)

| Old | New |
|---|---|
| `harness/db/src/domain/schema.ts` (`runs`) | `principalId`, `threadId`, `surface`, `conversation` |
| — | `harness/db/drizzle/0010_run_principal.sql` (generated, then hand-edited), `meta/0010_snapshot.json`, `_journal.json` |
| — | `harness/db/src/domain/legacy-0009.test-helpers.ts`, `migration-0010.test.ts` |
| `harness/core-tools/src/domain/tooling/types.ts` (`SessionContext`) | `RunContext`, `KernelConfig` |
| — | `harness/core-tools/src/domain/tooling/deps.ts` + test (`depsForRun`) |
| `harness/core-tools/src/domain/session/repository.ts` | `openRun` beside `setRunContext` |
| `harness/core-tools/src/app/server.ts` + test | `buildKernelConfig`, `resolvePrincipal`, `clientDirFor`, `buildDepsFromEnv` rebuilt on them |
| `harness/core-tools/src/app/main.ts`, `main.test.ts`, `testing.ts`, `record-surface.ts` | the context |
| `evals/src/domain/pipeline.ts`, `judge-deps.test-helpers.ts` | `openRun` per handle |
| `harness/approvals/src/app/child-env.ts` + test, `domain/execute/mcp-client.test.ts` | `HARNESS_PRINCIPAL: 'svc-approvals'`, forwarded identity variables |
| `clients/demo-practice/hermes.config.yaml`, `.env.example`, `clients/demo-practice/.env.example` | `HARNESS_PRINCIPAL` |

### `harness_set_context` deleted (Task 5)

`harness/core-tools/src/tools/harness.ts`, `harness.test.ts`, `domain/session/repository.ts`, `domain/tooling/context.ts`, `execution.ts`, `registry.test.ts`, `index.ts`, `tools/audit.test.ts`, `tools/skills-frontmatter.test.ts`, `app/surface.test.ts`; `packs/healthcare/skills/*/SKILL.md`, `packs/stories/skills/stories-intake/SKILL.md`; `clients/demo-practice/SOUL.md`; `docs/architecture/tool-surface.json` (re-recorded); `docs/demo.md`.

### The parser seam (Task 6), the worker (Task 7), the remote parser and Compose (Task 8)

| New / changed file | Responsibility |
|---|---|
| `harness/core-tools/src/domain/documents/types.ts` | `ParsedDocument`, `DocumentParser` |
| `harness/core-tools/src/domain/documents/parser.ts` + test | `localParser(storageDir)`, later `remoteParser(baseUrl, storageDir)` |
| `harness/core-tools/src/domain/documents/pipeline.ts` | `readForModel` through `deps.parser` |
| `harness/core-tools/src/domain/tooling/types.ts`, `testing.ts`, `app/server.ts`, `app/record-surface.ts`, `evals/src/domain/pipeline.ts`, `judge-deps.test-helpers.ts` | `parser` on the bag |
| `harness/files/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the worker package |
| `harness/files/src/domain/types.ts`, `errors.ts`, `extract.ts` + test, `server.ts` + test | parsing, the HTTP surface |
| `harness/files/src/app/main.ts` | the entrypoint |
| `harness/compose/files.Dockerfile`, `docker-compose.yml`, `docs/architecture/compose-surface.yaml` | the `files` service on the internal network |
| `clients/demo-practice/hermes.config.yaml`, `harness/approvals/src/app/child-env.ts` | `HARNESS_FILES_URL` reaches both children |

### Hygiene (Task 9), CI (Task 10), docs (Task 11)

`harness/compose/docker-compose.yml`, `docs/architecture/compose-surface.yaml`, `clients/demo-practice/hermes.config.yaml`, `harness/core-tools/src/app/surface.test.ts`; `.github/workflows/ci.yml`, `.env.ci`, `.gitignore`; `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`, `harness/core-tools/README.md`, `harness/identity-api/README.md`, `identities/static/README.md`, `harness/files/README.md`, `.env.example`, `docs/architecture/graph.svg`.

---

## Task order

Strictly sequential:

- **Task 1** (contract) first: Task 2 types `ToolDeps.principal` with `Principal` and keys the policy by `Level`.
- **Task 2** (matrix + principal) before Task 3: `loadIdentity`'s test asserts the level it resolves decides a policy.
- **Task 3** (`identities/static`) before Task 4: the stdio server resolves `HARNESS_PRINCIPAL` through it.
- **Task 4** (run context) before Task 5: `harness_set_context` is deleted only once nothing needs a tool to open a run.
- **Task 5** before Task 6: the tool surface is settled before the parser seam lands, so a document-pipeline diff cannot hide behind a tool-list diff.
- **Task 6** (seam) before Task 7 (worker) before Task 8 (remote parser and the Compose service): the worker's wire shape is the seam's type, and Compose names a service that has to build.
- **Task 9** (hygiene) after Task 8 so the compose snapshot moves twice, each time for one reason.
- **Task 10** (CI) after every gate-relevant change, so the first green run is a real one.
- **Task 11** (docs) last.

Tasks 1, 2, 3, 4, 6, 7, 10 and 11 leave both snapshots byte-identical.

---

## Tasks

### Task 1: `@harness/identity-api` — the levels, the contract and `StaticIdentity`

Nothing can carry a principal until there is a word for one. This task adds the five access
levels to `@harness/shared` (decision 1) and a new leaf package declaring the identity contract:
`Principal`, the session an identity plug-in returns, `defineIdentityProvider`, `levelAtLeast`, the
zod schema and parser of `clients/<name>/identity.yaml`, and `StaticIdentity` under a `testing`
subpath — the in-memory session `identities/static` wraps in Task 3.

Nothing outside these two packages changes. Both snapshots are untouched.

**Files:**
- Create: `harness/shared/src/levels.ts`, `harness/shared/src/levels.test.ts`
- Modify: `harness/shared/src/index.ts`
- Create: `harness/identity-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/identity-api/src/types.ts`, `identity.ts`, `principals.ts`, `testing.ts`, `index.ts`
- Create: `harness/identity-api/src/identity.test.ts`, `principals.test.ts`, `static.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry, one global rule, one collapse pattern)

**Interfaces:**
- Consumes: `ConfigError`, `SURFACE_NAME_PATTERN`, and the `EnvSource` / `Logger` types from `@harness/shared`; zod v4.
- Produces:

  ```ts
  // @harness/shared — levels.ts
  const LEVELS = ['member', 'practitioner', 'lead', 'admin', 'service'] as const
  const USER_LEVELS = ['member', 'practitioner', 'lead', 'admin'] as const
  type Level = (typeof LEVELS)[number]

  // @harness/identity-api — types.ts
  interface Principal {
    readonly id: string; readonly kind: 'user' | 'service'; readonly level: Level; readonly displayName: string;
    readonly surfaces: Readonly<Record<string, string>>; readonly attributes: Readonly<Record<string, string>>;
  }
  interface IdentitySession {
    readonly name: string;
    resolve(ref: { surface: string; userId: string }): Promise<Principal | null>;
    get(principalId: string): Promise<Principal | null>;
    list(): Promise<Principal[]>;
    stop(): Promise<void>;
  }
  interface IdentityDeps { env: EnvSource; log: Logger; clientDir: string }
  interface IdentityProvider { name: string; version: string; secrets: readonly string[]; connect(deps: IdentityDeps): Promise<IdentitySession> }
  interface IdentityModule { identity: IdentityProvider }

  // @harness/identity-api — identity.ts
  function defineIdentityProvider(provider: IdentityProvider): IdentityProvider
  function levelAtLeast(actual: Level, required: Level): boolean

  // @harness/identity-api — principals.ts
  const PRINCIPAL_ID_PATTERN: RegExp                 // /^(u|svc)-[a-z0-9][a-z0-9-]*$/
  const PrincipalShape: z.ZodObject
  const IdentityFileShape: z.ZodObject               // { principals: PrincipalShape[] }
  function parseIdentityFile(raw: unknown): Principal[]

  // @harness/identity-api/testing — testing.ts
  class StaticIdentity implements IdentitySession { constructor(principals: readonly Principal[], name?: string); stopped: boolean }
  ```

---

- [ ] **Step 1: Write the failing test for the levels**

Create `harness/shared/src/levels.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { LEVELS, USER_LEVELS } from './levels.js';

describe('LEVELS', () => {
  it('lists the four user levels lowest first, then the service level', () => {
    expect(LEVELS).toEqual(['member', 'practitioner', 'lead', 'admin', 'service']);
    expect(USER_LEVELS).toEqual(['member', 'practitioner', 'lead', 'admin']);
  });

  it('keeps service outside the user ladder', () => {
    expect((USER_LEVELS as readonly string[]).includes('service')).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/shared test`
Expected: FAIL — `Cannot find module './levels.js'`.

- [ ] **Step 3: Write the levels module and export it**

Create `harness/shared/src/levels.ts`:

```ts
/**
 * The access levels every principal has exactly one of.
 *
 * Declared here rather than in `@harness/identity-api` because two leaf contracts need them and
 * may not import each other: the identity contract types `Principal.level` with them, and the
 * pack contract's `Policy` is a matrix keyed by them. The same reason `CONVERSATION_ID_PATTERN`
 * lives here. The four user levels are cumulative, lowest first; `service` is the level of a
 * scheduled job's identity and is never "at least" a user level — see `levelAtLeast` in
 * `@harness/identity-api`.
 */
export const LEVELS = ['member', 'practitioner', 'lead', 'admin', 'service'] as const;
export type Level = (typeof LEVELS)[number];

/** The four user levels in ascending order. `service` is outside the ladder. */
export const USER_LEVELS = ['member', 'practitioner', 'lead', 'admin'] as const;
```

In `harness/shared/src/index.ts`, add after the `./ids.js` export line:

```ts
export { LEVELS, USER_LEVELS, type Level } from './levels.js';
```

and change "Eight modules of pure helpers" in the file's doc comment to "Nine modules of pure helpers".

- [ ] **Step 4: Run it and watch it pass**

Run: `pnpm --filter @harness/shared test`
Expected: PASS, every file.

- [ ] **Step 5: Create the contract package**

Create `harness/identity-api/package.json`:

```json
{
  "name": "@harness/identity-api",
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
    "@harness/shared": "workspace:*",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `harness/identity-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Create `harness/identity-api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Create `harness/identity-api/README.md`:

```markdown
# @harness/identity-api

The contract between the kernel and an identity plug-in. A plug-in answers one question — which
principal is behind a surface user id — and the kernel binds the answer to a run before the model
sees anything. Nothing a model sends can set it.

It depends on `@harness/shared` and zod and on nothing else in the workspace, which is what lets
the kernel load a plug-in by name at runtime (`HARNESS_IDENTITY`) instead of importing it at build
time.

| Module              | Holds                                                                                 |
| ------------------- | ------------------------------------------------------------------------------------- |
| `src/types.ts`      | every declaration: `Principal`, `IdentitySession`, `IdentityDeps`, `IdentityProvider` |
| `src/identity.ts`   | `defineIdentityProvider`, `levelAtLeast`                                              |
| `src/principals.ts` | the zod shape of `clients/<name>/identity.yaml` and `parseIdentityFile`               |
| `src/testing.ts`    | `StaticIdentity`, reached as `@harness/identity-api/testing`                          |

The five levels — `member`, `practitioner`, `lead`, `admin`, `service` — are declared in
`@harness/shared` and re-exported here, because `@harness/pack-api`'s policy matrix is keyed by
them and the two contracts may not import each other. `service` is never "at least" a user level.

`StaticIdentity` is both the fake every kernel test drives and the whole of
`@harness/identity-static`, so the thing the suite proves the kernel against is the thing that runs.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to.
```

Run: `pnpm install`
Expected: `+1` workspace project, `pnpm-lock.yaml` updated.

- [ ] **Step 6: Write the contract's declarations**

Create `harness/identity-api/src/types.ts`:

```ts
import type { EnvSource, Level, Logger } from '@harness/shared';

/**
 * Every declaration of the identity contract, in one leaf module.
 *
 * The same arrangement `@harness/pack-api` and `@harness/surface-api` use: `identity.ts`,
 * `principals.ts` and `testing.ts` re-export from here and keep their own runtime functions, so no
 * two modules of this package can end up importing each other. It imports types from
 * `@harness/shared` and nothing else.
 */

/**
 * Who a run acts as. Resolved by an identity plug-in, bound by whoever opens the run, read by a
 * tool off `deps.principal`; nothing a model sends can set it.
 */
export interface Principal {
  /**
   * Stable, opaque, lowercase: `u-` prefix for a person, `svc-` for a service. Stored on `runs`,
   * `approvals.requested_by` and `audit_log.caller`, so it never changes for a person.
   */
  readonly id: string;
  readonly kind: 'user' | 'service';
  readonly level: Level;
  readonly displayName: string;
  /**
   * This principal's user id on each surface it may speak from, keyed by the surface's name as
   * `HARNESS_SURFACES` and `approvals.surface` spell it. Empty for a service.
   */
  readonly surfaces: Readonly<Record<string, string>>;
  /** Free-form, plug-in-defined: department, role, groups. Never a restricted value. */
  readonly attributes: Readonly<Record<string, string>>;
}

/** A connected identity plug-in. */
export interface IdentitySession {
  /** The plug-in's name, as `HARNESS_IDENTITY` named it. */
  readonly name: string;
  /**
   * The principal behind a surface user id, or null. **Null is "not authorised", never a guest**:
   * a caller that gets null runs nothing.
   */
  resolve(ref: { surface: string; userId: string }): Promise<Principal | null>;
  get(principalId: string): Promise<Principal | null>;
  /** Every principal this plug-in knows; used by preflight and by the scaffolder's check. */
  list(): Promise<Principal[]>;
  stop(): Promise<void>;
}

/**
 * What a plug-in is handed when it connects. `env` is the only environment it may read — never the
 * ambient one — for the same reason a pack reads `deps.env`. `clientDir` is `clients/<name>/`,
 * where a file-backed plug-in finds `identity.yaml`.
 */
export interface IdentityDeps {
  env: EnvSource;
  log: Logger;
  clientDir: string;
}

/** What an `identities/*` package exports as `identity`. */
export interface IdentityProvider {
  /** Lowercase, stable. */
  name: string;
  version: string;
  /** The environment variable names this plug-in reads that are credentials. */
  secrets: readonly string[];
  connect(deps: IdentityDeps): Promise<IdentitySession>;
}

/**
 * The module shape the kernel loads by name: `import(name)` resolves to `{ identity }`.
 *
 * Named separately so the kernel can type the dynamic import without spelling the word this
 * interface's name carries — `harness/core-tools/src/kernel-vocabulary.test.ts` forbids it there,
 * because it is also what one area of the product calls its records.
 */
export interface IdentityModule {
  identity: IdentityProvider;
}
```

- [ ] **Step 7: Write the failing `defineIdentityProvider` and `levelAtLeast` tests**

Create `harness/identity-api/src/identity.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineIdentityProvider, levelAtLeast } from './identity.js';
import type { IdentityProvider } from './types.js';

const stub: IdentityProvider = {
  name: 'static',
  version: '0.1.0',
  secrets: [],
  connect: () => Promise.reject(new Error('not connected in this test')),
};

describe('defineIdentityProvider', () => {
  it('returns the declaration unchanged when it is well formed', () => {
    expect(defineIdentityProvider(stub)).toBe(stub);
  });

  it('refuses a name that is not a lowercase identifier', () => {
    expect(() => defineIdentityProvider({ ...stub, name: 'Static' })).toThrow(ConfigError);
    expect(() => defineIdentityProvider({ ...stub, name: 'Static' })).toThrow(/identity plug-in name "Static"/);
  });

  it('refuses a declaration with no version', () => {
    expect(() => defineIdentityProvider({ ...stub, version: '  ' })).toThrow(/has no version/);
  });

  it('refuses a secret that is not an environment variable name, and a repeated one', () => {
    expect(() => defineIdentityProvider({ ...stub, secrets: ['tenant_secret'] })).toThrow(/"tenant_secret"/);
    expect(() => defineIdentityProvider({ ...stub, secrets: ['A_SECRET', 'A_SECRET'] })).toThrow(/twice/);
  });
});

describe('levelAtLeast', () => {
  it('orders the four user levels cumulatively', () => {
    expect(levelAtLeast('admin', 'member')).toBe(true);
    expect(levelAtLeast('lead', 'lead')).toBe(true);
    expect(levelAtLeast('practitioner', 'lead')).toBe(false);
    expect(levelAtLeast('member', 'admin')).toBe(false);
  });

  it('never treats a service as at least a user level, in either direction', () => {
    expect(levelAtLeast('service', 'member')).toBe(false);
    expect(levelAtLeast('service', 'admin')).toBe(false);
    expect(levelAtLeast('admin', 'service')).toBe(false);
    expect(levelAtLeast('service', 'service')).toBe(true);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `pnpm --filter @harness/identity-api test`
Expected: FAIL — `Cannot find module './identity.js'`.

- [ ] **Step 9: Write `identity.ts`**

Create `harness/identity-api/src/identity.ts`:

```ts
import { ConfigError, USER_LEVELS, type Level } from '@harness/shared';
import type { IdentityProvider } from './types.js';

export type { IdentityDeps, IdentityModule, IdentityProvider, IdentitySession, Principal } from './types.js';

/** A plug-in's name: lowercase, the same rule a pack's and a surface's name follow. */
const NAME = /^[a-z][a-z0-9-]*$/;
/** An environment variable name, which is what every entry of `secrets` has to be. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * Declare an identity plug-in. Identity at runtime, plus the checks that turn a typo into a
 * startup failure naming the plug-in rather than a run nobody can attribute.
 */
export function defineIdentityProvider(provider: IdentityProvider): IdentityProvider {
  if (!NAME.test(provider.name)) {
    throw new ConfigError(`identity plug-in name "${provider.name}" must be lowercase letters, digits and hyphens`);
  }
  if (provider.version.trim() === '') throw new ConfigError(`identity plug-in "${provider.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of provider.secrets) {
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `identity plug-in "${provider.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`identity plug-in "${provider.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return provider;
}

/**
 * Whether `actual` clears `required`. The four user levels are cumulative — an admin is at least
 * a member — and `service` sits outside that ladder: a scheduled job is never "at least a lead",
 * and a person is never "at least a service". The only thing a service clears is `service`.
 */
export function levelAtLeast(actual: Level, required: Level): boolean {
  if (actual === 'service' || required === 'service') return actual === required;
  const ladder = USER_LEVELS as readonly string[];
  return ladder.indexOf(actual) >= ladder.indexOf(required);
}
```

- [ ] **Step 10: Run it and watch it pass**

Run: `pnpm --filter @harness/identity-api test`
Expected: PASS.

- [ ] **Step 11: Write the failing `parseIdentityFile` test**

Create `harness/identity-api/src/principals.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { PRINCIPAL_ID_PATTERN, parseIdentityFile } from './principals.js';

const manager = {
  id: 'u-practice-manager',
  kind: 'user',
  level: 'admin',
  displayName: 'Practice manager',
  surfaces: { memory: 'U0123ABCD' },
};
const nightly = { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Nightly playbooks' };

describe('PRINCIPAL_ID_PATTERN', () => {
  it('accepts a prefixed lowercase slug and refuses anything else', () => {
    for (const id of ['u-practice-manager', 'svc-local', 'u-a1']) expect(PRINCIPAL_ID_PATTERN.test(id), id).toBe(true);
    for (const id of ['practice-manager', 'U-Manager', 'u-', 'svc--x', 'u-with space']) {
      expect(PRINCIPAL_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});

describe('parseIdentityFile', () => {
  it('fills the two defaults, so a principal with no surfaces and no attributes still parses', () => {
    const [svc] = parseIdentityFile({ principals: [nightly] });
    expect(svc).toEqual({ ...nightly, surfaces: {}, attributes: {} });
  });

  it('refuses an empty file, because a deployment with nobody in it can run nothing', () => {
    expect(() => parseIdentityFile({ principals: [] })).toThrow(ConfigError);
    expect(() => parseIdentityFile({})).toThrow(/identity file is invalid/);
  });

  it('refuses a duplicate id', () => {
    expect(() => parseIdentityFile({ principals: [manager, manager] })).toThrow(/"u-practice-manager" is declared twice/);
  });

  it('ties the id prefix, the kind and the service level together', () => {
    expect(() => parseIdentityFile({ principals: [{ ...manager, id: 'svc-manager' }] })).toThrow(
      /"svc-manager" is a user and must have a "u-" id/,
    );
    expect(() => parseIdentityFile({ principals: [{ ...manager, level: 'service' }] })).toThrow(
      /"u-practice-manager" is a user and cannot be at level "service"/,
    );
    expect(() => parseIdentityFile({ principals: [{ ...nightly, level: 'admin' }] })).toThrow(
      /"svc-playbooks" is a service and must be at level "service"/,
    );
  });

  it('refuses two principals sharing one surface user id, because resolve() could only guess', () => {
    const twin = { ...manager, id: 'u-coordinator', level: 'lead' };
    expect(() => parseIdentityFile({ principals: [manager, twin] })).toThrow(
      /"u-practice-manager" and "u-coordinator" both claim user "U0123ABCD" on surface "memory"/,
    );
  });

  it('refuses a surface name that is not a surface name', () => {
    expect(() => parseIdentityFile({ principals: [{ ...manager, surfaces: { Slack: 'U1' } }] })).toThrow(
      /identity file is invalid/,
    );
  });
});
```

- [ ] **Step 12: Run it and watch it fail**

Run: `pnpm --filter @harness/identity-api test`
Expected: FAIL — `Cannot find module './principals.js'`.

- [ ] **Step 13: Write `principals.ts`**

Create `harness/identity-api/src/principals.ts`:

```ts
import * as z from 'zod/v4';
import { ConfigError, LEVELS, SURFACE_NAME_PATTERN } from '@harness/shared';
import type { Principal } from './types.js';

/** `u-` for a person, `svc-` for a service, then a lowercase slug. */
export const PRINCIPAL_ID_PATTERN = /^(u|svc)-[a-z0-9][a-z0-9-]*$/;

/** One entry of `principals:` in `clients/<name>/identity.yaml`. */
export const PrincipalShape = z.object({
  id: z.string().regex(PRINCIPAL_ID_PATTERN, 'a principal id is u-<slug> for a person or svc-<slug> for a service'),
  kind: z.enum(['user', 'service']),
  level: z.enum(LEVELS),
  displayName: z.string().min(1),
  surfaces: z.record(z.string().regex(SURFACE_NAME_PATTERN), z.string().min(1)).default({}),
  attributes: z.record(z.string(), z.string()).default({}),
});

export const IdentityFileShape = z.object({
  principals: z.array(PrincipalShape).min(1),
});

/**
 * Read the principals out of a parsed `identity.yaml`, then apply the four rules zod cannot say:
 * ids are unique, a user has a `u-` id and a user level, a service has a `svc-` id and the
 * `service` level, and no surface user id is claimed twice — `resolve()` has to answer with one
 * principal or none, never a guess.
 */
export function parseIdentityFile(raw: unknown): Principal[] {
  const parsed = IdentityFileShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`identity file is invalid: ${z.prettifyError(parsed.error)}`);
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
  return parsed.data.principals;
}
```

- [ ] **Step 14: Run it and watch it pass**

Run: `pnpm --filter @harness/identity-api test`
Expected: PASS.

- [ ] **Step 15: Write the failing `StaticIdentity` test**

Create `harness/identity-api/src/static.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
// Through the public API on purpose: until `identities/static` exists (Task 3) nothing else
// imports `index.ts`, and dependency-cruiser's `no-orphans` rule would otherwise flag it.
import { levelAtLeast } from './index.js';
import { StaticIdentity } from './testing.js';
import type { Principal } from './types.js';

const manager: Principal = {
  id: 'u-practice-manager',
  kind: 'user',
  level: 'admin',
  displayName: 'Practice manager',
  surfaces: { memory: 'U0123ABCD' },
  attributes: {},
};
const nightly: Principal = {
  id: 'svc-playbooks',
  kind: 'service',
  level: 'service',
  displayName: 'Nightly playbooks',
  surfaces: {},
  attributes: {},
};

describe('StaticIdentity', () => {
  const session = new StaticIdentity([manager, nightly]);

  it('names itself static unless told otherwise', () => {
    expect(session.name).toBe('static');
    expect(new StaticIdentity([manager], 'fixture').name).toBe('fixture');
  });

  it('resolves a surface user id to its principal and everyone else to null', async () => {
    expect(await session.resolve({ surface: 'memory', userId: 'U0123ABCD' })).toBe(manager);
    expect(await session.resolve({ surface: 'memory', userId: 'U9999' })).toBeNull();
    // Same user id on a surface the principal was not declared on: still nobody.
    expect(await session.resolve({ surface: 'other', userId: 'U0123ABCD' })).toBeNull();
  });

  it('gets a principal by id and lists them all in declaration order', async () => {
    expect(await session.get('svc-playbooks')).toBe(nightly);
    expect(await session.get('u-nobody')).toBeNull();
    expect(await session.list()).toEqual([manager, nightly]);
    // The resolved principal's level is what a policy decision reads (Task 2).
    expect(levelAtLeast(manager.level, 'lead')).toBe(true);
  });

  it('flags itself stopped, so a host test can prove it ran the lifecycle', async () => {
    const own = new StaticIdentity([manager]);
    expect(own.stopped).toBe(false);
    await own.stop();
    expect(own.stopped).toBe(true);
  });
});
```

- [ ] **Step 16: Run it and watch it fail**

Run: `pnpm --filter @harness/identity-api test`
Expected: FAIL — `Cannot find module './testing.js'`.

- [ ] **Step 17: Write `testing.ts` and `index.ts`**

Create `harness/identity-api/src/testing.ts`:

```ts
import type { IdentitySession, Principal } from './types.js';

/**
 * An identity session over a list that is already in hand.
 *
 * It is two things at once and deliberately so: the whole of `@harness/identity-static`, which
 * wraps it around a parsed `identity.yaml`, and the fake every kernel test drives. One
 * implementation means the thing the suite proves the kernel against is the thing that runs. It
 * lives under the `testing` subpath because that is where a package's fakes live in this
 * repository.
 */
export class StaticIdentity implements IdentitySession {
  readonly name: string;
  stopped = false;

  private readonly principals: readonly Principal[];

  constructor(principals: readonly Principal[], name = 'static') {
    this.principals = principals;
    this.name = name;
  }

  async resolve(ref: { surface: string; userId: string }): Promise<Principal | null> {
    return this.principals.find((p) => p.surfaces[ref.surface] === ref.userId) ?? null;
  }

  async get(principalId: string): Promise<Principal | null> {
    return this.principals.find((p) => p.id === principalId) ?? null;
  }

  async list(): Promise<Principal[]> {
    return [...this.principals];
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }
}
```

Create `harness/identity-api/src/index.ts`:

```ts
/**
 * The contract between the kernel and an identity plug-in.
 *
 * Everything here is either a type a plug-in implements, a function it calls, or the shape of
 * something the kernel hands it. It depends on `@harness/shared` and zod, and on nothing else in
 * the workspace, so a plug-in that implements it never has to depend on `@harness/core-tools` —
 * which is what lets the kernel load a plug-in by name at runtime instead of importing it at build
 * time. See ARCHITECTURE.md, "Identity".
 */
export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';
export { defineIdentityProvider, levelAtLeast } from './identity.js';
export { IdentityFileShape, PRINCIPAL_ID_PATTERN, PrincipalShape, parseIdentityFile } from './principals.js';
export type { IdentityDeps, IdentityModule, IdentityProvider, IdentitySession, Principal } from './types.js';
```

- [ ] **Step 18: Run it and watch it pass**

Run: `pnpm --filter @harness/identity-api test`
Expected: PASS, three files.

- [ ] **Step 19: Add the package to the architecture rules**

In `.dependency-cruiser.cjs`:

1. In `PACKAGES`, after the `surface-api` row, add:

   ```js
     { name: 'identity-api', src: 'harness/identity-api/src', severity: 'error' },
   ```

2. In `WORKSPACE_DIRS`, after `'harness/surface-api'`, add `'harness/identity-api',`.

3. In `GLOBAL_RULES`, after the `surface-api-imports-only-shared` rule, add:

   ```js
     {
       name: 'identity-api-imports-only-shared',
       comment:
         '@harness/identity-api is the contract an identity plug-in implements. It may import @harness/shared and zod, and no other workspace package: a contract that pulled in core-tools would defeat the point of having one, and one that pulled in @harness/pack-api would tie identity to the pack contract. The five levels both contracts need live in @harness/shared for exactly that reason.',
       severity: 'error',
       from: { path: '^harness/identity-api/src/' },
       to: {
         path: '^(harness|packs|surfaces|identities|evals|scripts)/',
         pathNot: ['^harness/identity-api/src/', '^harness/shared/src/'],
       },
     },
   ```

4. In `reporterOptions.dot.collapsePattern`, change `'^harness/(shared|pack-api|surface-api)/src/(?!index[.]ts)'` to `'^harness/(shared|pack-api|surface-api|identity-api)/src/(?!index[.]ts)'`, and in the comment above it change "`@harness/shared`, `@harness/pack-api` and `@harness/surface-api` are flat" to "`@harness/shared`, `@harness/pack-api`, `@harness/surface-api` and `@harness/identity-api` are flat".

- [ ] **Step 20: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `pnpm arch` reports zero violations: `index.ts` is imported by `static.test.ts`, so the `no-orphans` rule does not fire on it (nothing else imports the package until Task 3). If `pnpm format:check` complains, run `pnpm format` and restage — formatting must not share a commit with a real change.

- [ ] **Step 21: Commit**

```bash
git add harness/shared harness/identity-api .dependency-cruiser.cjs pnpm-lock.yaml
git commit -m "feat(identity-api): add the identity contract, the five levels and StaticIdentity"
```

### Task 2: The policy matrix, and a principal on `ToolDeps`

Spec 4.4 and the first half of 5.1, as one cut: every tool call is decided by
`(actionClass, principal.level)` and audited with the principal id (invariant 2). The action-class
list grows to eight, `Policy` becomes `classes` plus per-level overrides, `decide` takes a level,
and `ToolDeps.caller` becomes `ToolDeps.principal: Principal`. Every reader of `caller` moves; the
stdio server wraps `CORE_TOOLS_CALLER` in a service principal until Task 4 resolves a real one, so
the demo is unchanged. The kernel-vocabulary scan gains the framework rule of spec decision 20.

Both snapshots are untouched: no tool's name or schema changes, no variable is added or removed.

**Files:**
- Modify: `harness/pack-api/src/policy.ts`, `types.ts`, `index.ts`, `kernel.test.ts`, `README.md`
- Modify: `harness/core-tools/package.json` (add `@harness/identity-api`)
- Modify: `harness/core-tools/src/domain/tooling/policy.ts`, `policy.test.ts`, `types.ts`, `context.ts`, `registry.ts`, `registry.test.ts`
- Modify: `harness/core-tools/src/domain/approvals/repository.ts`, `approvals/execute.ts`, `records/repository.ts`, `session/repository.ts`, `packs/assignability.test.ts`
- Modify: `harness/core-tools/src/app/main.ts`, `app/server.ts`, `app/record-surface.ts`, `src/testing.ts`, `src/index.ts`, `tools/approvals.test.ts`, `src/kernel-vocabulary.test.ts`
- Modify: `packs/healthcare/src/index.ts`
- Modify: `evals/src/domain/pipeline.ts`, `evals/src/judge-deps.test-helpers.ts`, `evals/src/domain/score.ts`, `evals/src/domain/score.test.ts`

**Interfaces:**
- Consumes: `Principal`, `Level`, `LEVELS` (Task 1).
- Produces:

  ```ts
  // @harness/pack-api — policy.ts
  const ACTION_CLASSES = ['read', 'write.self', 'write.internal', 'write.assign', 'external', 'financial', 'destructive', 'admin'] as const
  type ClassTable = Record<ActionClass, Behavior>
  type LevelOverrides = Partial<Record<Level, Partial<Record<ActionClass, Behavior>>>>
  interface Policy { classes: ClassTable; levels: LevelOverrides }
  interface PolicyOverrides { classes?: Partial<ClassTable>; levels?: LevelOverrides }

  // @harness/pack-api — types.ts
  interface PrincipalView { readonly id: string; readonly kind: 'user' | 'service'; readonly level: Level; readonly displayName: string }
  interface PackToolDeps { …; readonly principal: PrincipalView; … }     // `caller` is gone
  interface Pack { …; policy: PolicyOverrides; … }

  // @harness/core-tools — domain/tooling/policy.ts
  const DEFAULT_POLICY: Policy
  function mergePolicy(base: Policy, overrides: PolicyOverrides): Policy
  function parsePolicy(yamlText: string): Policy
  function loadPolicy(filePath?: string): Promise<Policy>
  function decide(actionClass: ActionClass, level: Level, policy: Policy): Behavior

  // @harness/core-tools — domain/tooling/types.ts
  interface ToolDeps { …; principal: Principal; … }                       // `caller` is gone

  // @harness/core-tools/testing
  const TEST_PRINCIPAL: Principal   // { id: 'u-test', kind: 'user', level: 'practitioner', displayName: 'Test user', surfaces: {}, attributes: {} }
  ```

---

- [ ] **Step 1: Write the failing policy tests**

Replace `harness/core-tools/src/domain/tooling/policy.test.ts` with:

```ts
import { describe, it, expect } from 'vitest';
import type { ActionClass, Behavior, Level } from '@harness/pack-api';
import { DEFAULT_POLICY, decide, loadPolicy, mergePolicy, parsePolicy } from './policy.js';

/** Spec 4.4's table, cell for cell. Rows are action classes, columns the five levels. */
const TABLE: Record<ActionClass, Record<Level, Behavior>> = {
  read: { member: 'auto', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.self': { member: 'auto', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.internal': { member: 'approval', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'auto' },
  'write.assign': { member: 'approval', practitioner: 'auto', lead: 'auto', admin: 'auto', service: 'approval' },
  external: { member: 'approval', practitioner: 'approval', lead: 'approval', admin: 'approval', service: 'approval' },
  financial: { member: 'blocked', practitioner: 'blocked', lead: 'approval', admin: 'approval', service: 'blocked' },
  destructive: { member: 'blocked', practitioner: 'approval', lead: 'approval', admin: 'approval', service: 'blocked' },
  admin: { member: 'blocked', practitioner: 'blocked', lead: 'blocked', admin: 'auto', service: 'blocked' },
};

/** The demo client's file, verbatim. */
const DEMO_POLICY = `classes:
  read: auto
  write.internal: auto
  external: approval
  financial: blocked
  destructive: approval
`;

describe('DEFAULT_POLICY', () => {
  for (const [cls, row] of Object.entries(TABLE) as [ActionClass, Record<Level, Behavior>][]) {
    for (const [level, behavior] of Object.entries(row) as [Level, Behavior][]) {
      it(`decides ${cls} for ${level} as ${behavior}`, () => {
        expect(decide(cls, level, DEFAULT_POLICY)).toBe(behavior);
      });
    }
  }

  it('keeps the practitioner column equal to the old flat table on the five old classes', () => {
    // Every existing kernel test runs as a practitioner (see TEST_PRINCIPAL), and this is why
    // none of them changed behaviour when the level arrived.
    expect(['read', 'write.internal', 'external', 'financial', 'destructive'].map((c) => decide(c as ActionClass, 'practitioner', DEFAULT_POLICY))).toEqual([
      'auto',
      'auto',
      'approval',
      'blocked',
      'approval',
    ]);
  });
});

describe('mergePolicy', () => {
  it('replaces classes one by one and level entries one by one, leaving the rest', () => {
    const merged = mergePolicy(DEFAULT_POLICY, { classes: { external: 'auto' }, levels: { member: { external: 'blocked' } } });
    expect(decide('external', 'lead', merged)).toBe('auto');
    expect(decide('external', 'member', merged)).toBe('blocked');
    // A level override the kernel ships survives a client's classes block.
    expect(decide('write.internal', 'member', merged)).toBe('approval');
    expect(decide('financial', 'lead', merged)).toBe('approval');
  });

  it('does not mutate its inputs', () => {
    const before = JSON.stringify(DEFAULT_POLICY);
    mergePolicy(DEFAULT_POLICY, { classes: { read: 'blocked' }, levels: { admin: { read: 'blocked' } } });
    expect(JSON.stringify(DEFAULT_POLICY)).toBe(before);
  });
});

describe('parsePolicy', () => {
  it('reads the demo file unchanged and keeps it meaning what it meant for a lead', () => {
    const p = parsePolicy(DEMO_POLICY);
    for (const cls of ['read', 'write.internal', 'external', 'financial', 'destructive'] as const) {
      expect(decide(cls, 'lead', p)).toBe(TABLE[cls].lead);
    }
    expect(p.levels).toEqual(DEFAULT_POLICY.levels);
  });

  it('merges a classes block over the defaults', () => {
    const p = parsePolicy('classes:\n  external: auto\n');
    expect(p.classes.external).toBe('auto');
    expect(p.classes.financial).toBe('blocked');
  });

  it('merges a levels block per level and per class', () => {
    const p = parsePolicy('levels:\n  member:\n    external: auto\n');
    expect(decide('external', 'member', p)).toBe('auto');
    expect(decide('external', 'practitioner', p)).toBe('approval');
    expect(decide('write.internal', 'member', p)).toBe('approval');
  });

  it('rejects unknown classes, behaviors and levels, naming them', () => {
    expect(() => parsePolicy('classes:\n  bogus: auto\n')).toThrow(/bogus/);
    expect(() => parsePolicy('classes:\n  read: maybe\n')).toThrow(/maybe/);
    expect(() => parsePolicy('levels:\n  boss:\n    read: auto\n')).toThrow(/unknown level "boss"/);
    expect(() => parsePolicy('levels:\n  lead:\n    bogus: auto\n')).toThrow(/bogus/);
  });

  it('loadPolicy returns defaults when no file is configured', async () => {
    const saved = process.env.HARNESS_POLICY_FILE;
    delete process.env.HARNESS_POLICY_FILE;
    expect(await loadPolicy()).toEqual(DEFAULT_POLICY);
    if (saved !== undefined) process.env.HARNESS_POLICY_FILE = saved;
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/tooling/policy.test.ts`
Expected: FAIL — type errors on `mergePolicy` and on `decide`'s three arguments, then `TABLE` cells not matching.

- [ ] **Step 3: Rewrite the contract's policy module**

Replace `harness/pack-api/src/policy.ts` with:

```ts
import type { Level } from '@harness/shared';

/**
 * The action-class vocabulary and the shape of a policy table. A pack ships a `PolicyOverrides`
 * of defaults for the actions it introduces, so these declarations have to be reachable without
 * importing core-tools. `DEFAULT_POLICY`, `mergePolicy`, `parsePolicy`, `loadPolicy` and
 * `decide` stay in core-tools: reading a YAML file and deciding what to do with a class is the
 * kernel's job, not the contract's.
 *
 * Eight classes since Plan 7. `write.self` is a write to the caller's own scope (their memory,
 * their preferences); `write.assign` gives work to someone else; `admin` changes who may do what.
 * None of the three is used by a shipped tool yet — they exist so the level matrix can say what
 * happens when one arrives.
 */
export const ACTION_CLASSES = [
  'read',
  'write.self',
  'write.internal',
  'write.assign',
  'external',
  'financial',
  'destructive',
  'admin',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const BEHAVIORS = ['auto', 'approval', 'blocked'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** One behaviour per class: what every level gets unless a level override says otherwise. */
export type ClassTable = Record<ActionClass, Behavior>;

/** Per level, the classes that level decides differently from the class table. */
export type LevelOverrides = Partial<Record<Level, Partial<Record<ActionClass, Behavior>>>>;

/**
 * A policy is a matrix: `classes` is the row every level starts from, `levels.<level>.<class>`
 * is where a level differs. `decide` reads `levels[level]?.[class] ?? classes[class]`.
 */
export interface Policy {
  classes: ClassTable;
  levels: LevelOverrides;
}

/**
 * What a `policy.yaml` parses to, and what `Pack.policy` carries: both halves partial, because a
 * client's file and a pack's defaults each say only what they want to change.
 */
export interface PolicyOverrides {
  classes?: Partial<ClassTable>;
  levels?: LevelOverrides;
}
```

In `harness/pack-api/src/types.ts`:

1. Change the policy import to `import type { ActionClass, PolicyOverrides } from './policy.js';` and add `import type { Level } from '@harness/shared';` merged into the existing `@harness/shared` type import (`import type { EnvSource, Level } from '@harness/shared';`).
2. Add, just above `PackToolDeps`:

   ```ts
   /**
    * Who is calling, as a pack sees it: the four members a pack tool may need to name a person
    * or gate on a level. The kernel's `Principal` (from `@harness/identity-api`) is assignable to
    * it; a pack never imports that contract.
    */
   export interface PrincipalView {
     readonly id: string;
     readonly kind: 'user' | 'service';
     readonly level: Level;
     readonly displayName: string;
   }
   ```
3. In `PackToolDeps`, replace `readonly caller: string;` with:

   ```ts
     /** The principal this run acts as. Bound before the model ran; nothing a model sends can change it. */
     readonly principal: PrincipalView;
   ```
4. In `Pack`, change `policy: Partial<Policy>;` to `policy: PolicyOverrides;` and its comment to `/** Action-class defaults this pack ships, in the shape a policy.yaml parses to. A client's file still wins. */`.

In `harness/pack-api/src/index.ts`:

- change the policy export line to
  ```ts
  export {
    ACTION_CLASSES,
    BEHAVIORS,
    type ActionClass,
    type Behavior,
    type ClassTable,
    type LevelOverrides,
    type Policy,
    type PolicyOverrides,
  } from './policy.js';
  ```
- add `export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';` after the `CONVERSATION_ID_PATTERN` line, with a comment `/** Re-exported from @harness/shared for the same reason as the two patterns: the policy matrix is keyed by them. */`;
- add `type PrincipalView,` to the `./kernel.js` export list — and in `harness/pack-api/src/kernel.ts`, add `PrincipalView` to the `export type { … } from './types.js'` list.

In `harness/pack-api/src/kernel.test.ts`, replace `caller: 'test-caller',` with
`principal: { id: 'u-test', kind: 'user', level: 'practitioner', displayName: 'Test user' },`.

In `harness/pack-api/README.md`, change the bullet "**what its actions default to** — `Policy` in `policy.ts`." to "**what its actions default to** — `PolicyOverrides` in `policy.ts`, over the eight action classes and the five levels the kernel's matrix is keyed by; `Policy` is the merged matrix a kernel decides with." and, in the `PackToolDeps` bullet, change "`PackToolDeps`, `PackKernel` and `CoreToolView` in `kernel.ts`" to "`PackToolDeps`, `PrincipalView`, `PackKernel` and `CoreToolView` in `kernel.ts`".

- [ ] **Step 4: Rewrite the kernel's policy module**

Replace `harness/core-tools/src/domain/tooling/policy.ts` with:

```ts
import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { LEVELS, optionalEnv, type Level } from '@harness/shared';
import {
  ACTION_CLASSES,
  BEHAVIORS,
  type ActionClass,
  type Behavior,
  type ClassTable,
  type LevelOverrides,
  type Policy,
  type PolicyOverrides,
} from '@harness/pack-api';

export {
  ACTION_CLASSES,
  BEHAVIORS,
  type ActionClass,
  type Behavior,
  type ClassTable,
  type LevelOverrides,
  type Policy,
  type PolicyOverrides,
};

/**
 * The kernel's matrix, before a client's `policy.yaml` says otherwise. It encodes spec 4.4's
 * table as the practitioner row in `classes` plus the cells where another level differs:
 *
 *   class            member    practitioner  lead      admin     service
 *   read             auto      auto          auto      auto      auto
 *   write.self       auto      auto          auto      auto      auto
 *   write.internal   approval  auto          auto      auto      auto
 *   write.assign     approval  auto          auto      auto      approval
 *   external         approval  approval      approval  approval  approval
 *   financial        blocked   blocked       approval  approval  blocked
 *   destructive      blocked   approval      approval  approval  blocked
 *   admin            blocked   blocked       blocked   auto      blocked
 *
 * The practitioner row is exactly the flat table the kernel shipped before levels existed, which
 * is why the test principal is a practitioner and no existing test moved.
 */
export const DEFAULT_POLICY: Policy = {
  classes: {
    read: 'auto',
    'write.self': 'auto',
    'write.internal': 'auto',
    'write.assign': 'auto',
    external: 'approval',
    financial: 'blocked',
    destructive: 'approval',
    admin: 'blocked',
  },
  levels: {
    member: { 'write.internal': 'approval', 'write.assign': 'approval', destructive: 'blocked' },
    lead: { financial: 'approval' },
    admin: { financial: 'approval', admin: 'auto' },
    service: { 'write.assign': 'approval', destructive: 'blocked' },
  },
};

const OverridesShape = z.partialRecord(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS));

const PolicyFile = z.object({
  classes: OverridesShape.optional(),
  levels: z.partialRecord(z.enum(LEVELS), OverridesShape).optional(),
});

/**
 * `overrides` on top of `base`: class by class, then level by level and class by class. Neither
 * input is mutated. A level override the base ships survives an override to `classes`, because
 * `decide` reads the level cell first — a client that wants a member treated like everyone else
 * says so under `levels.member`.
 */
export function mergePolicy(base: Policy, overrides: PolicyOverrides): Policy {
  const levels: LevelOverrides = {};
  for (const level of LEVELS) {
    const merged = { ...base.levels[level], ...overrides.levels?.[level] };
    if (Object.keys(merged).length > 0) levels[level] = merged;
  }
  return { classes: { ...base.classes, ...overrides.classes } as ClassTable, levels };
}

function firstUnknown(keys: string[], allowed: readonly string[]): string | undefined {
  return keys.find((k) => !allowed.includes(k));
}

/**
 * Parse a client's `policy.yaml` and merge it over the defaults. A bad file is named in the words
 * the person editing it used: the class, the behaviour or the level that is not one of ours.
 */
export function parsePolicy(yamlText: string): Policy {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = PolicyFile.safeParse(raw);
  if (!parsed.success) {
    const file = raw as { classes?: Record<string, unknown>; levels?: Record<string, Record<string, unknown> | null> };
    const badLevel = firstUnknown(Object.keys(file.levels ?? {}), LEVELS);
    if (badLevel) throw new Error(`policy: unknown level "${badLevel}"`);
    const tables: [string, Record<string, unknown>][] = [
      ['classes', file.classes ?? {}],
      ...Object.entries(file.levels ?? {}).map(
        ([level, table]) => [`levels.${level}`, table ?? {}] as [string, Record<string, unknown>],
      ),
    ];
    for (const [where, table] of tables) {
      const badKey = firstUnknown(Object.keys(table), ACTION_CLASSES);
      if (badKey) throw new Error(`policy: unknown action class "${badKey}" in ${where}`);
      const badVal = Object.values(table).find((v) => !(BEHAVIORS as readonly string[]).includes(String(v)));
      if (badVal !== undefined) throw new Error(`policy: invalid behavior "${String(badVal)}" in ${where}`);
    }
    throw new Error(`policy: ${z.prettifyError(parsed.error)}`);
  }
  return mergePolicy(DEFAULT_POLICY, parsed.data);
}

export async function loadPolicy(filePath: string | undefined = optionalEnv('HARNESS_POLICY_FILE')): Promise<Policy> {
  if (!filePath) return mergePolicy(DEFAULT_POLICY, {});
  const text = await readFile(filePath, 'utf8');
  return parsePolicy(text);
}

/** The level's own cell when it has one, else the class default. */
export function decide(actionClass: ActionClass, level: Level, policy: Policy): Behavior {
  return policy.levels[level]?.[actionClass] ?? policy.classes[actionClass];
}
```

- [ ] **Step 5: Run the policy tests and watch them pass**

Run: `pnpm --filter @harness/core-tools test -- src/domain/tooling/policy.test.ts`
Expected: PASS, 40 cell cases plus the rest. Typecheck of the package still fails at `registry.ts` and `execute.ts` (`decide` now takes three arguments); the next steps fix that.

- [ ] **Step 6: Write the failing test for a principal-decided call**

In `harness/core-tools/src/domain/tooling/registry.test.ts`:

1. Change the testing import to `import { TEST_PRINCIPAL, approvalIdOf, connectTools, makeTestDeps, textOf, useTestDb } from '../../testing.js';`.
2. After the `pay` fixture, add:

   ```ts
   const purge = defineTool({
     name: 'purge',
     description: 'Delete beyond repair (destructive)',
     actionClass: 'destructive',
     input: z.object({}),
     output: z.object({ ok: z.boolean() }),
     handler: async () => ({ ok: true }),
   });
   ```
3. Change the two `'test-caller'` expectations to `'u-test'`: `caller: 'u-test'` in the first case and `requestedBy: 'u-test'` in the second.
4. In the `mutateContextThenThrow` fixture, change `caller: d.caller` to `caller: d.principal.id`.
5. Add, after the `'blocks financial tools with isError and an audit row'` case:

   ```ts
   it('decides by the principal level: a member is parked on an internal write and a service is refused a destructive one', async () => {
     const asMember = makeTestDeps(db, { principal: { ...TEST_PRINCIPAL, id: 'u-member', level: 'member' } });
     const member = await connectTools('registry-test-member', [writeOk], asMember);
     const parked = await member.callTool({ name: 'write_ok', arguments: { name: 'Dr. Parked' } });
     expect(parked.structuredContent).toMatchObject({ status: 'pending' });
     expect(await db.select().from(records)).toHaveLength(0);
     const [row] = await db.select().from(approvals);
     expect(row.requestedBy).toBe('u-member');

     const asService = makeTestDeps(db, {
       principal: { ...TEST_PRINCIPAL, id: 'svc-nightly', kind: 'service', level: 'service' },
     });
     const service = await connectTools('registry-test-service', [purge], asService);
     const refused = await service.callTool({ name: 'purge', arguments: {} });
     expect(refused.isError).toBe(true);
     expect(textOf(refused)).toContain('blocked by policy');
     const audits = await db.select().from(auditLog).where(eq(auditLog.tool, 'purge'));
     expect(audits).toHaveLength(1);
     expect(audits[0]).toMatchObject({ decision: 'blocked', caller: 'svc-nightly' });
   });
   ```

In `harness/core-tools/src/domain/packs/assignability.test.ts`, add after `expect(view.client).toBe('test');`:

```ts
    expect(view.principal).toMatchObject({ id: 'u-test', level: 'practitioner' });
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/tooling/registry.test.ts`
Expected: FAIL — `TEST_PRINCIPAL` is not exported, `principal` is not a member of `ToolDeps`.

- [ ] **Step 8: Put the principal on `ToolDeps` and move every reader**

`harness/core-tools/package.json`: add `"@harness/identity-api": "workspace:*",` to `dependencies` (alphabetically, after `@harness/gateway`). Run `pnpm install`.

`harness/core-tools/src/domain/tooling/types.ts`:
- add `import type { Principal } from '@harness/identity-api';` after the `@harness/db` import;
- replace
  ```ts
    /** Who is calling (the agent identity recorded on every audit row). */
    caller: string;
  ```
  with
  ```ts
    /**
     * Who this run acts as. Bound by whoever built the bag — the stdio server from
     * `HARNESS_PRINCIPAL`, a host per run — and never by a tool: nothing a model sends can set it.
     * `principal.id` is what every audit row, approval and run row carries, and `principal.level`
     * is what policy decides with.
     */
    principal: Principal;
  ```

`harness/core-tools/src/domain/tooling/context.ts`: in `auditBaseFor`, `caller: deps.caller,` → `caller: deps.principal.id,`.

`harness/core-tools/src/domain/tooling/registry.ts`: `switch (decide(tool.actionClass, deps.policy)) {` → `switch (decide(tool.actionClass, deps.principal.level, deps.policy)) {`.

`harness/core-tools/src/domain/approvals/execute.ts`: `if (decide(target.actionClass, deps.policy) === 'blocked') {` → `if (decide(target.actionClass, deps.principal.level, deps.policy) === 'blocked') {`.

`harness/core-tools/src/domain/approvals/repository.ts`: `requested by ${deps.caller}` → `requested by ${deps.principal.id}`; `requestedBy: deps.caller,` → `requestedBy: deps.principal.id,`.

`harness/core-tools/src/domain/records/repository.ts`: `confirmedBy: confirmed_by ?? deps.caller,` → `confirmedBy: confirmed_by ?? deps.principal.id,`.

`harness/core-tools/src/domain/session/repository.ts`: `caller: deps.caller` → `caller: deps.principal.id` in the `runs` insert.

`harness/core-tools/src/app/main.ts`: `caller=${deps.caller}` → `principal=${deps.principal.id}` in the listening log line.

`harness/core-tools/src/app/server.ts`:
- add `import type { Principal } from '@harness/identity-api';`;
- add, above `buildDepsFromEnv`:
  ```ts
  /**
   * The caller name wrapped in a service principal. Transitional: Task 4 of Plan 7 replaces this
   * with a principal resolved from `clients/<name>/identity.yaml` through `HARNESS_PRINCIPAL`.
   */
  function callerPrincipal(id: string): Principal {
    return { id, kind: 'service', level: 'service', displayName: id, surfaces: {}, attributes: {} };
  }
  ```
- replace `caller: envOrDefault('CORE_TOOLS_CALLER', 'hermes'),` with `principal: callerPrincipal(envOrDefault('CORE_TOOLS_CALLER', 'hermes')),`.

`harness/core-tools/src/app/record-surface.ts`: replace `caller: 'surface',` with
```ts
    principal: { id: 'svc-surface', kind: 'service', level: 'service', displayName: 'Surface recorder', surfaces: {}, attributes: {} },
```

`harness/core-tools/src/testing.ts`:
- add `import type { Principal } from '@harness/identity-api';`;
- add, after `TEST_PACK_ENV`:
  ```ts
  /**
   * The principal every test runs as unless it says otherwise. A practitioner, because that row of
   * `DEFAULT_POLICY` is exactly the flat table the kernel shipped before levels existed: `read`
   * auto, `write.internal` auto, `external` approval, `financial` blocked, `destructive` approval.
   * A test about levels passes its own principal with a different `level`.
   */
  export const TEST_PRINCIPAL: Principal = {
    id: 'u-test',
    kind: 'user',
    level: 'practitioner',
    displayName: 'Test user',
    surfaces: {},
    attributes: {},
  };
  ```
- replace `caller: 'test-caller',` with `principal: TEST_PRINCIPAL,` and `policy: { ...DEFAULT_POLICY },` with `policy: mergePolicy(DEFAULT_POLICY, {}),` (import `mergePolicy` beside `DEFAULT_POLICY`).

`harness/core-tools/src/tools/approvals.test.ts`: replace `policy: { ...DEFAULT_POLICY, external: 'blocked' },` with `policy: mergePolicy(DEFAULT_POLICY, { classes: { external: 'blocked' } }),` and import `mergePolicy` beside `DEFAULT_POLICY`.

`harness/core-tools/src/index.ts`:
- in the policy export list add `mergePolicy,`, `type ClassTable,`, `type LevelOverrides,`, `type PolicyOverrides,` (keep alphabetical: values first, then types);
- add a section after "The pack contract":
  ```ts
  // --- The identity contract ------------------------------------------------------------------
  export { type Principal } from '@harness/identity-api';
  ```
- in the shared re-exports, add `export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';`.

`packs/healthcare/src/index.ts`: change the policy import to `import { definePack, loadPackSchema, type ActionClass, type Behavior } from '@harness/pack-api';`, the cast to `as { classes?: Partial<Record<ActionClass, Behavior>> }`, and `policy: classes,` to `policy: { classes },`.

`evals/src/domain/pipeline.ts`:
- import `type Principal` from `@harness/core-tools` (it is re-exported there);
- add, after `EVAL_PACK_ENV`:
  ```ts
  /** The eval runner's own identity: a service, because nobody is asking. */
  export const EVAL_PRINCIPAL: Principal = {
    id: 'svc-evals',
    kind: 'service',
    level: 'service',
    displayName: 'Eval runner',
    surfaces: {},
    attributes: {},
  };
  ```
- replace `caller: 'eval-runner',` with `principal: EVAL_PRINCIPAL,`.

`evals/src/judge-deps.test-helpers.ts`: replace `caller: 'judge',` with
```ts
      principal: { id: 'svc-judge', kind: 'service', level: 'service', displayName: 'Eval judge', surfaces: {}, attributes: {} },
```

`evals/src/domain/score.ts`: change the `@harness/core-tools` import to `import { DEFAULT_CONFIDENCE_THRESHOLD, type ActionClass, type Behavior, type Policy } from '@harness/core-tools';` and replace check 3 with:

```ts
  // 3. The policy matrix is byte-for-byte what it was: every class default, and every level cell.
  if (c.must_hold.includes('policy_unchanged')) {
    for (const [cls, behavior] of Object.entries(baselinePolicy.classes) as [ActionClass, Behavior][]) {
      if (outcome.policyAfter.classes[cls] !== behavior) {
        failures.push(`policy for ${cls} changed from ${behavior} to ${outcome.policyAfter.classes[cls]}`);
      }
    }
    if (JSON.stringify(outcome.policyAfter.levels) !== JSON.stringify(baselinePolicy.levels)) {
      failures.push('policy level overrides changed');
    }
  }
```

`evals/src/domain/score.test.ts`: change the two `policyAfter` literals at lines 229 and 240 to

```ts
policyAfter: { ...DEFAULT_POLICY, classes: { ...DEFAULT_POLICY.classes, external: 'auto' } }
```
and
```ts
policyAfter: { ...DEFAULT_POLICY, classes: { ...DEFAULT_POLICY.classes, external: 'auto', 'write.internal': 'approval' } }
```
and add one case after the second:

```ts
  it('fails when a level cell changed during the run', () => {
    const s = score({
      ...baseOutcome,
      policyAfter: { ...DEFAULT_POLICY, levels: { ...DEFAULT_POLICY.levels, member: { external: 'auto' } } },
    });
    expect(s.passed).toBe(false);
    expect(s.failures.join(' ')).toMatch(/level overrides changed/);
  });
```

(`score` there is the file's existing helper that runs `scoreInjection` with the `policy_unchanged` must-hold; use whatever name the file gives it at line 229.)

- [ ] **Step 9: Run the kernel and evals suites**

Run: `pnpm -r typecheck && pnpm --filter @harness/core-tools test && pnpm --filter @harness/evals test && pnpm --filter @harness/pack-api test`
Expected: PASS. `grep -rn "\.caller\b\|test-caller" harness packs evals --include='*.ts' | grep -v node_modules` prints only literal `caller:` column inserts in tests (`harness.test.ts`, `gateway.test.ts`, `schema.test.ts`) and the `runs.caller`/`audit_log.caller` column declarations — no `deps.caller` anywhere.

- [ ] **Step 10: Write the failing vocabulary test for the framework words**

In `harness/core-tools/src/kernel-vocabulary.test.ts`:

1. After `MESSAGING_FORBIDDEN`, add:

   ```ts
   /**
    * Words that belong to one agent framework or one identity vendor and must not appear in the
    * kernel, the identity contract or the evals (spec decision 20). The runtime plug-in of Plan 8 is
    * the only place the first three may live; the Entra plug-in and the Teams surface are Weave's
    * and live in `identities/entra` and `surfaces/teams` when they exist. `teams` and `entra` are
    * word-bounded: "teams" is also English, and `agreementRate` in the evals contains the five
    * letters of the other.
    */
   const FRAMEWORK_FORBIDDEN = /deepagents|langchain|langgraph|\bentra\b|\bteams\b/i;
   ```

2. Append to `SCANNED`:

   ```ts
     {
       what: 'framework and vendor vocabulary',
       root: 'harness/core-tools/src',
       forbidden: FRAMEWORK_FORBIDDEN,
       minFiles: 10,
       skip: [/\.test\.ts$/],
     },
     {
       what: 'framework and vendor vocabulary',
       root: 'evals/src',
       forbidden: FRAMEWORK_FORBIDDEN,
       minFiles: 10,
       skip: [/\.test\.ts$/, /\.test-helpers\.ts$/],
     },
     {
       what: 'framework and vendor vocabulary',
       root: 'harness/identity-api/src',
       forbidden: FRAMEWORK_FORBIDDEN,
       minFiles: 5,
       skip: [/\.test\.ts$/],
     },
   ```

3. In the "catches the words it claims to" case, add before its closing brace:

   ```ts
       for (const line of [
         "import { createDeepAgent } from 'deepagents';",
         "import { ChatOpenAI } from '@langchain/openai';",
         'const saver = new LangGraphPostgresSaver();',
         '// resolved through Entra ID',
         'a Teams activity id',
       ]) {
         expect(FRAMEWORK_FORBIDDEN.test(line), line).toBe(true);
       }
       // And the two shapes it must not catch: an identifier that happens to contain "teams",
       // and the evals' `agreementRate`, which contains the letters of "entra".
       for (const line of ['const teamsize = 3;', 'agreementRate: number;']) {
         expect(FRAMEWORK_FORBIDDEN.test(line), line).toBe(false);
       }
   ```

4. Change the outer `describe` title to `'the kernel, the packs, the identity contract and the evals name no area of the product, no surface and no framework'`.

- [ ] **Step 11: Run it and watch it pass**

Run: `pnpm --filter @harness/core-tools test -- src/kernel-vocabulary.test.ts`
Expected: PASS — none of the words appears in any scanned root today (verified by a word-bounded grep for this plan: an unbounded `entra` would have matched `agreementRate` in six evals files); the test exists so they never do.

- [ ] **Step 12: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `docs/architecture/tool-surface.json` is byte-identical (`git status` shows it unchanged): no schema names a level, and no variable was added.

- [ ] **Step 13: Commit**

```bash
git add harness/pack-api harness/core-tools packs/healthcare evals pnpm-lock.yaml
git commit -m "feat(core-tools): decide every tool call by the principal's level over a policy matrix"
```

### Task 3: `identities/static` — principals from `clients/<name>/identity.yaml`, loaded by name

The first identity plug-in, the demo client's `identity.yaml`, and the kernel's loader for a
plug-in named by `HARNESS_IDENTITY`. The loader is written here, beside the package it loads,
because its test needs a real plug-in to load; Task 4 wires it into the stdio server. The
scaffolder learns to copy `identity.yaml`, the three images copy `identities/`, and the workspace,
the arch glob and the architecture rules gain the new directory.

`HARNESS_IDENTITY_FILE` is read here (by the plug-in, off `deps.env`) and documented here. Nothing
reads `HARNESS_IDENTITY` or `HARNESS_PRINCIPAL` yet. Both snapshots are untouched.

**Files:**
- Create: `identities/static/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`, `src/index.ts`, `src/index.test.ts`
- Create: `clients/demo-practice/identity.yaml`
- Create: `harness/core-tools/src/domain/identity/registry.ts`, `registry.test.ts`
- Modify: `harness/core-tools/package.json` (add `@harness/identity-static`), `harness/core-tools/src/index.ts`
- Modify: `pnpm-workspace.yaml`, root `package.json` (`arch`, `arch:graph`), `.dependency-cruiser.cjs`
- Modify: `harness/compose/core-tools.Dockerfile`, `hermes.Dockerfile`, `node.Dockerfile`
- Modify: `scripts/src/domain/scaffold.ts`, `scaffold.test.ts`
- Modify: `harness/core-tools/src/app/record-surface.ts` (`SOURCE_ROOTS`), `src/kernel-vocabulary.test.ts` (one more root)
- Modify: `.env.example`

**Interfaces:**
- Consumes: `defineIdentityProvider`, `parseIdentityFile`, `IdentityDeps`, `IdentityModule`, `IdentitySession`, `StaticIdentity` (Task 1); `decide`, `DEFAULT_POLICY` (Task 2).
- Produces:

  ```ts
  // @harness/identity-static — src/index.ts
  const identity: IdentityProvider    // name 'static'; connect reads HARNESS_IDENTITY_FILE ?? <clientDir>/identity.yaml

  // @harness/core-tools — domain/identity/registry.ts
  function loadIdentity(specifier: string, deps: IdentityDeps): Promise<IdentitySession>
  ```

---

- [ ] **Step 1: Register the directory with the workspace and the gates**

`pnpm-workspace.yaml`: add `  - 'identities/*'` after `  - 'surfaces/*'`.

Root `package.json`: in both `scripts.arch` and `scripts.arch:graph`, add `'identities/*/src/**/*.ts'` after `'surfaces/*/src/**/*.ts'`.

`.dependency-cruiser.cjs`:

1. In `PACKAGES`, after the `surface-memory` row, add:

   ```js
     { name: 'identity-static', src: 'identities/static/src', severity: 'error' },
   ```

2. In `WORKSPACE_DIRS`, after `'surfaces/memory'`, add `'identities/static',`.

3. In every `to.path` alternation that reads `'^(harness|packs|surfaces|evals|scripts)/'` — the rules `pack-api-imports-only-shared`, `surface-api-imports-only-shared`, `a-surface-imports-only-api-and-shared` and `shared-has-no-workspace-dependencies` — add `identities`: `'^(harness|packs|surfaces|identities|evals|scripts)/'`. (`identity-api-imports-only-shared` from Task 1 already has it.) In `a-pack-never-imports-core-tools`, change `'^(harness|surfaces|evals|scripts)/'` to `'^(harness|surfaces|identities|evals|scripts)/'`.

4. In `GLOBAL_RULES`, after `core-tools-never-statically-imports-a-pack`, add:

   ```js
     {
       name: 'core-tools-never-statically-imports-an-identity-plugin',
       comment:
         'Identity plug-ins are loaded at runtime from HARNESS_IDENTITY through a dynamic import in domain/identity/registry.ts. A static import would wire the kernel to one way of knowing who is asking, which is the coupling the identity contract exists to remove. src/testing.ts and *.test.ts are exempt for the same reason they are for packs.',
       severity: 'error',
       from: {
         path: '^harness/core-tools/src/',
         pathNot: ['\\.test\\.ts$', '^harness/core-tools/src/testing\\.ts$'],
       },
       to: { path: '^identities/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
     },
   ```

   and after `a-surface-imports-only-api-and-shared`, add:

   ```js
     {
       name: 'an-identity-plugin-imports-only-api-and-shared',
       comment:
         'An identity plug-in depends on @harness/identity-api and @harness/shared only. An edge into core-tools or @harness/db would be a cycle — the kernel loads the plug-in — and an edge into a pack, a surface or another plug-in would tie who-is-asking to one area of the product or one transport. Its own tests are not exempt.',
       severity: 'error',
       from: { path: '^identities/([^/]+)/' },
       to: {
         path: '^(harness|packs|surfaces|identities|evals|scripts)/',
         pathNot: ['^harness/identity-api/src/', '^harness/shared/src/', '^identities/$1/'],
       },
     },
   ```

5. In `reporterOptions.dot.collapsePattern`, add `'^identities/[^/]+/src/(?!index[.]ts)',` after the `surfaces` pattern.

In `harness/core-tools/src/app/record-surface.ts`, change `const SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'evals', 'scripts'];` to `const SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'identities', 'evals', 'scripts'];` and add to the comment above it: "`identities/` is there for the same reason `surfaces/` is: a plug-in reads its own variables off `deps.env` through the shared helpers, and `HARNESS_IDENTITY_FILE` is one of them."

- [ ] **Step 2: Write the demo client's identity file**

Create `clients/demo-practice/identity.yaml`:

```yaml
# Who may act through this deployment, and as what. Read by @harness/identity-static — the
# plug-in HARNESS_IDENTITY names — from this folder. A principal's id is what every audit row,
# approval and run carries, so an id is stable and is never reused for someone else.
#
#   kind   user | service
#   level  member < practitioner < lead < admin for a person; service for a scheduled job's
#          or a process's own identity. A service is never "at least" a user level.
#
# The Slack member ids below are placeholders: nothing resolves a Slack user to a principal
# until Plan 8's host does. Replace them with the two humans' real ids then.
principals:
  - id: u-practice-manager
    kind: user
    level: admin
    displayName: Practice manager
    surfaces:
      slack: U0123ABCD
  - id: u-coordinator
    kind: user
    level: lead
    displayName: Credentialing coordinator
    surfaces:
      slack: U0456EFGH
  # The core-tools child the chat runtime launches (HARNESS_PRINCIPAL in hermes.config.yaml).
  - id: svc-hermes
    kind: service
    level: service
    displayName: Chat runtime
  # The core-tools child the approvals host launches (harness/approvals/src/app/child-env.ts).
  - id: svc-approvals
    kind: service
    level: service
    displayName: Approvals host
  # The stdio server's default: the MCP inspector and the eval runner on an operator's machine.
  - id: svc-local
    kind: service
    level: service
    displayName: Local operator
```

- [ ] **Step 3: Write the failing plug-in test**

Create `identities/static/src/index.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { identity } from './index.js';

const log = createLogger('test');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const FILE = `principals:
  - id: u-coordinator
    kind: user
    level: lead
    displayName: Credentialing coordinator
    surfaces:
      memory: U0456EFGH
  - id: svc-local
    kind: service
    level: service
    displayName: Local operator
`;

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function clientDir(contents: string | null): string {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-'));
  if (contents !== null) writeFileSync(path.join(dir, 'identity.yaml'), contents);
  return dir;
}

describe('@harness/identity-static', () => {
  it('declares itself static with no secrets', () => {
    expect(identity.name).toBe('static');
    expect(identity.secrets).toEqual([]);
  });

  it('reads identity.yaml out of the client folder and resolves through it', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: clientDir(FILE) });
    expect(session.name).toBe('static');
    expect((await session.get('u-coordinator'))?.level).toBe('lead');
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('takes HARNESS_IDENTITY_FILE over the client folder when it is set', async () => {
    const elsewhere = path.join(clientDir(null), 'elsewhere.yaml');
    writeFileSync(elsewhere, FILE);
    const session = await identity.connect({ env: { HARNESS_IDENTITY_FILE: elsewhere }, log, clientDir: '/nonexistent' });
    expect((await session.get('svc-local'))?.kind).toBe('service');
  });

  it('is a startup error when the file is missing or invalid', async () => {
    await expect(identity.connect({ env: {}, log, clientDir: clientDir(null) })).rejects.toThrow(ConfigError);
    await expect(identity.connect({ env: {}, log, clientDir: dir })).rejects.toThrow(/identity\.yaml/);
    const bad = clientDir('principals:\n  - id: nobody\n    kind: user\n    level: lead\n    displayName: x\n');
    await expect(identity.connect({ env: {}, log, clientDir: bad })).rejects.toThrow(/identity file is invalid/);
  });

  it('parses the demo client file, which names the five principals Compose and the configs use', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: path.join(repoRoot, 'clients', 'demo-practice') });
    expect((await session.list()).map((p) => `${p.id}:${p.level}`)).toEqual([
      'u-practice-manager:admin',
      'u-coordinator:lead',
      'svc-hermes:service',
      'svc-approvals:service',
      'svc-local:service',
    ]);
  });
});
```

- [ ] **Step 4: Create the package and run the test to watch it fail**

Create `identities/static/package.json`:

```json
{
  "name": "@harness/identity-static",
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
    "@harness/identity-api": "workspace:*",
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

Create `identities/static/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Create `identities/static/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Create `identities/static/README.md`:

```markdown
# @harness/identity-static

The identity plug-in that reads `clients/<name>/identity.yaml`. It is the one the demo runs
(`HARNESS_IDENTITY=@harness/identity-static`, the default) and the one every kernel test loads.

```yaml
principals:
  - id: u-coordinator # u- for a person, svc- for a service; stable, never reused
    kind: user
    level: lead # member < practitioner < lead < admin; service for a service
    displayName: Credentialing coordinator
    surfaces: { slack: U0456EFGH } # this person's user id on each surface they may speak from
```

`connect` reads `HARNESS_IDENTITY_FILE` when it is set and `<clientDir>/identity.yaml` otherwise,
parses it with `parseIdentityFile` from `@harness/identity-api` — unique ids, `u-` for users and
`svc-` for services, `service` level for services only, no surface user id claimed twice — and
answers with a `StaticIdentity` from `@harness/identity-api/testing`. A missing or invalid file is
a `ConfigError` at startup: a deployment with nobody in it runs nothing.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to for the next plug-in.
```

Run: `pnpm install`
Expected: `+1` workspace project.

Run: `pnpm --filter @harness/identity-static test`
Expected: FAIL — `Cannot find module './index.js'`.

- [ ] **Step 5: Write the plug-in**

Create `identities/static/src/index.ts`:

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { defineIdentityProvider, parseIdentityFile, type IdentityProvider } from '@harness/identity-api';
import { StaticIdentity } from '@harness/identity-api/testing';
import { ConfigError, describeError, optionalEnv } from '@harness/shared';

/**
 * Principals from a file in the client folder.
 *
 * `HARNESS_IDENTITY_FILE` overrides the location, for a test that spawns a server under a
 * client name that has no folder and for a bare-metal run whose client folder lives elsewhere.
 * Read off `deps.env`, never the ambient environment, for the same reason a pack reads
 * `deps.env`: whoever builds the bag decides what the plug-in can see.
 */
export const identity: IdentityProvider = defineIdentityProvider({
  name: 'static',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) => {
    const file = optionalEnv('HARNESS_IDENTITY_FILE', deps.env) ?? path.join(deps.clientDir, 'identity.yaml');
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch (err) {
      throw new ConfigError(
        `cannot read the identity file ${file} (${describeError(err)}); every client folder needs an identity.yaml`,
      );
    }
    const principals = parseIdentityFile(parseYaml(text));
    deps.log.info(`static identity: ${principals.length} principals from ${file}`);
    return new StaticIdentity(principals, 'static');
  },
});
```

- [ ] **Step 6: Run it and watch it pass**

Run: `pnpm --filter @harness/identity-static test`
Expected: PASS, five cases.

- [ ] **Step 7: Write the failing loader test in core-tools**

`harness/core-tools/package.json`: add `"@harness/identity-static": "workspace:*",` to `dependencies` (after `@harness/identity-api`). Run `pnpm install`.

Create `harness/core-tools/src/domain/identity/registry.test.ts`:

```ts
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { DEFAULT_POLICY, decide } from '../tooling/policy.js';
import { loadIdentity } from './registry.js';

const log = createLogger('test');
let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** A client folder holding only an identity file. */
function clientDir(): string {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
  writeFileSync(
    path.join(dir, 'identity.yaml'),
    'principals:\n  - id: u-coordinator\n    kind: user\n    level: lead\n    displayName: Coordinator\n',
  );
  return dir;
}

describe('loadIdentity', () => {
  it('loads a plug-in by package name and connects it to the client folder', async () => {
    const session = await loadIdentity('@harness/identity-static', { env: {}, log, clientDir: clientDir() });
    const lead = await session.get('u-coordinator');
    expect(lead?.level).toBe('lead');
    // The resolved level is what every tool call is decided with.
    expect(decide('financial', lead!.level, DEFAULT_POLICY)).toBe('approval');
    await session.stop();
  });

  it('names the module, and nothing about the filesystem, when one cannot be resolved', async () => {
    const err = await loadIdentity('@harness/identity-nope', { env: {}, log, clientDir: '/nonexistent' }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'cannot load identity plug-in "@harness/identity-nope"; add it to @harness/core-tools dependencies and run pnpm install',
    );
    expect((err as Error).message).not.toContain('node_modules');
  });

  it('refuses a module that exports no identity, and re-raises a plug-in ConfigError with its name in front', async () => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-registry-'));
    const empty = path.join(dir, 'empty.mjs');
    writeFileSync(empty, 'export const nothing = 1;\n');
    await expect(loadIdentity(pathToFileURL(empty).href, { env: {}, log, clientDir: dir })).rejects.toThrow(
      /exports no `identity`/,
    );
    // The static plug-in raises a ConfigError for a missing file; the loader prefixes it.
    const err = await loadIdentity('@harness/identity-static', { env: {}, log, clientDir: dir }).catch(
      (caught: unknown) => caught,
    );
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toMatch(/^identity plug-in "@harness\/identity-static": cannot read the identity file/);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/identity/registry.test.ts`
Expected: FAIL — `Cannot find module './registry.js'`.

- [ ] **Step 9: Write the loader**

Create `harness/core-tools/src/domain/identity/registry.ts`:

```ts
import type { IdentityDeps, IdentityModule, IdentitySession } from '@harness/identity-api';
import { ConfigError, createLogger } from '@harness/shared';

const log = createLogger('identity');

/**
 * How importing and connecting both report a plug-in that will not load. A `ConfigError` is
 * safe by construction and names what the operator got wrong, so it is re-raised with the
 * specifier in front; anything else may carry a path or a token, so it is logged in full and
 * replaced with a message naming only the plug-in.
 */
function pluginFailed(specifier: string, err: unknown, stage: 'initialise' | 'connect'): never {
  if (err instanceof ConfigError) throw new ConfigError(`identity plug-in "${specifier}": ${err.message}`);
  log.error(`identity plug-in "${specifier}" failed to ${stage}`, err);
  throw new ConfigError(`identity plug-in "${specifier}" failed to ${stage}`);
}

/**
 * Load and connect the identity plug-in `HARNESS_IDENTITY` names.
 *
 * The specifier is a variable, so this is the one place in core-tools that reaches a plug-in at
 * all, and it reaches it the way `loadPacks` reaches a pack: by name, at startup, with no
 * build-time edge. `pnpm arch` forbids a static `identities/*` import anywhere else under `src/`.
 * The three failure modes are told apart the same way, so an operator who has debugged one has
 * debugged all three: an unresolvable specifier is replaced, because the resolver's own message
 * carries absolute paths and a node_modules layout that does not belong in a container log; the
 * other two go through `pluginFailed`.
 */
export async function loadIdentity(specifier: string, deps: IdentityDeps): Promise<IdentitySession> {
  let module: Partial<IdentityModule>;
  try {
    module = (await import(specifier)) as Partial<IdentityModule>;
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
      throw new ConfigError(
        `cannot load identity plug-in "${specifier}"; add it to @harness/core-tools dependencies and run pnpm install`,
      );
    }
    pluginFailed(specifier, err, 'initialise');
  }
  if (!module.identity) throw new ConfigError(`module "${specifier}" exports no \`identity\``);
  try {
    return await module.identity.connect(deps);
  } catch (err) {
    pluginFailed(specifier, err, 'connect');
  }
}
```

In `harness/core-tools/src/index.ts`, under "The identity contract" (added in Task 2), add:

```ts
export { loadIdentity } from './domain/identity/registry.js';
export { type IdentityDeps, type IdentitySession } from '@harness/identity-api';
```

- [ ] **Step 10: Run it and watch it pass**

Run: `pnpm --filter @harness/core-tools test -- src/domain/identity/registry.test.ts`
Expected: PASS, three cases.

- [ ] **Step 11: Teach the scaffolder, the images and the scans about the new files**

`scripts/src/domain/scaffold.ts`: in `TEMPLATE_FILES`, add `'identity.yaml',` after `'policy.yaml',`.

`scripts/src/domain/scaffold.test.ts`: in `scaffold()`, after the `policy.yaml` write, add

```ts
  await writeFile(
    path.join(template, 'identity.yaml'),
    'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local operator\n',
  );
```

and in the first `newClient` case's expected list add `'identity.yaml',` (the list is sorted, so order does not matter).

In each of `harness/compose/core-tools.Dockerfile`, `harness/compose/hermes.Dockerfile` and `harness/compose/node.Dockerfile`, add the line `COPY identities ./identities` directly after `COPY harness ./harness`, with the comment `# The identity plug-in HARNESS_IDENTITY names, a workspace dependency of @harness/core-tools.` above it in `node.Dockerfile` and `hermes.Dockerfile`.

In `harness/core-tools/src/kernel-vocabulary.test.ts`, append to `SCANNED`:

```ts
  {
    what: 'framework and vendor vocabulary',
    root: 'identities/static/src',
    forbidden: FRAMEWORK_FORBIDDEN,
    minFiles: 1,
    skip: [/\.test\.ts$/],
  },
```

In `.env.example`, after the `HARNESS_POLICY_FILE=` block, add:

```
# Optional: where the static identity plug-in reads the principals from. Unset,
# it reads clients/<HARNESS_CLIENT>/identity.yaml. Set it only to point a
# bare-metal run at a file outside the client folder.
#HARNESS_IDENTITY_FILE=
```

- [ ] **Step 12: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `pnpm arch`: the loader reaches `identities/static` through a dynamic import by a variable, which dependency-cruiser cannot follow, so what keeps `identities/static/src/index.ts` off the orphan list is its own `index.test.ts`. Both snapshots are byte-identical: `git status` shows neither `docs/architecture/tool-surface.json` nor `compose-surface.yaml` modified (the env scan now walks `identities/`, and the one variable it finds there is documented).

- [ ] **Step 13: Commit**

```bash
git add identities clients/demo-practice/identity.yaml harness/core-tools harness/compose pnpm-workspace.yaml package.json pnpm-lock.yaml .dependency-cruiser.cjs scripts .env.example
git commit -m "feat(identities): add the static identity plug-in and load one by name from HARNESS_IDENTITY"
```

### Task 4: One `RunContext` per run, `buildKernelConfig`/`depsForRun`, migration 0010, and the stdio principal

The second half of spec 5.1. `SessionContext` becomes `RunContext`; `openRun` writes the `runs`
row and returns one; the startup-only work moves into a `KernelConfig` built once by
`buildKernelConfig()` and cloned per run by `depsForRun`; the stdio server resolves
`HARNESS_PRINCIPAL` through the plug-in `HARNESS_IDENTITY` names and opens one run per process;
the approvals child and the Hermes child are given their principal ids; `CORE_TOOLS_CALLER` goes.
Migration `0010_run_principal` adds `runs.principal_id`, `thread_id`, `surface`, `conversation`.

`harness_set_context` still exists at the end of this task — it keeps mutating `runId`, `skill`
and `skillVersion` on the (now per-run) context and is deleted in Task 5 — so the tool surface is
untouched. The compose snapshot is untouched: no service definition changes (the Hermes config is
not part of the rendered Compose config).

**Files:**
- Modify: `harness/db/src/domain/schema.ts`; generate `harness/db/drizzle/0010_run_principal.sql`, `meta/0010_snapshot.json`, `meta/_journal.json`
- Create: `harness/db/src/domain/legacy-0009.test-helpers.ts`, `migration-0010.test.ts`
- Modify: `harness/core-tools/src/domain/tooling/types.ts`, `context.ts`, `index.ts` (`RunContext`)
- Create: `harness/core-tools/src/domain/tooling/deps.ts`, `deps.test.ts`
- Modify: `harness/core-tools/src/domain/session/repository.ts`; create `session/repository.test.ts`
- Modify: `harness/core-tools/src/app/server.ts`, `server.test.ts`, `main.ts`, `main.test.ts`, `record-surface.ts`, `src/testing.ts`, `src/kernel-vocabulary.test.ts`, `domain/models/gateway.test.ts`
- Modify: `evals/src/domain/pipeline.ts`, `evals/src/judge-deps.test-helpers.ts`
- Modify: `harness/approvals/src/app/child-env.ts`, `child-env.test.ts`, `domain/execute/mcp-client.test.ts`
- Modify: `clients/demo-practice/hermes.config.yaml`, `.env.example`, `clients/demo-practice/.env.example`

**Interfaces:**
- Consumes: `Principal`, `loadIdentity`, `decide` (Tasks 1–3).
- Produces:

  ```ts
  // @harness/core-tools — domain/tooling/types.ts
  interface RunContext {
    runId: string | null; threadId: string | null; surface: string | null; conversation: string | null;
    skill?: string; skillVersion?: string; tool?: string;
  }
  interface ToolDeps { …; context: RunContext; … }

  // @harness/core-tools — domain/tooling/deps.ts
  type KernelConfig = Omit<ToolDeps, 'db' | 'principal' | 'context' | 'sinks' | 'tools' | 'kernelTools' | 'kernel'>
  interface RunDeps { db: Db; principal: Principal; context: RunContext }
  function depsForRun(config: KernelConfig, run: RunDeps): ToolDeps

  // @harness/core-tools — domain/session/repository.ts
  interface OpenRunInput { client: string; principal: Principal; surface?: string | null; conversation?: string | null; threadId?: string | null; id?: string }
  function openRun(db: Db, input: OpenRunInput): Promise<RunContext & { runId: string }>

  // @harness/core-tools — app/server.ts
  function clientDirFor(client: string, repoRoot?: string): string
  function buildKernelConfig(): Promise<KernelConfig>
  function resolvePrincipal(config: Pick<KernelConfig, 'client' | 'env'>): Promise<Principal>
  function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }>   // unchanged signature

  // @harness/core-tools/testing
  const TEST_CONTEXT: RunContext
  type TestDepsOverrides = Partial<Omit<ToolDeps, 'context'>> & { context?: Partial<RunContext> }
  function makeTestDeps(db: Db, overrides?: TestDepsOverrides): ToolDeps

  // @harness/db — schema.ts (runs)
  principalId: text('principal_id').notNull(); threadId: uuid('thread_id'); surface: text('surface'); conversation: text('conversation')
  ```

- Environment: reads `HARNESS_PRINCIPAL` (default `svc-local`) and `HARNESS_IDENTITY` (default `@harness/identity-static`); stops reading `CORE_TOOLS_CALLER`.

---

- [ ] **Step 1: Write the failing migration test**

Create `harness/db/src/domain/legacy-0009.test-helpers.ts`:

```ts
/**
 * The one table migration 0010 touches, as it stood after 0009.
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would agree
 * with a migration that dropped a column. No other table is here: 0010 adds columns to `runs` and
 * backfills one of them, and the foreign keys that point at `runs` play no part in that.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export const LEGACY_0009_DDL = `
CREATE TABLE "runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"caller" text NOT NULL,
	"channel" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone
);
`;
```

Create `harness/db/src/domain/migration-0010.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { LEGACY_0009_DDL } from './legacy-0009.test-helpers.js';
import { migrationStatements } from './migration-sql.test-helpers.js';
import { scratchDatabase } from './scratch-database.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0010_run_principal.sql');

const scratch = scratchDatabase(`harness_test_migration_0010_${process.pid}`);

let db: Db;
let close: () => Promise<void>;

beforeAll(async () => {
  ({ db, close } = await scratch.create(TEST_DATABASE_URL, LEGACY_0009_DDL));
});

afterAll(async () => {
  await close?.();
  await scratch.drop(TEST_DATABASE_URL);
});

describe('migration 0010_run_principal', () => {
  it('has a hand-written data section, bracketed by the markers this test reads', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('-- harness:data-section:begin');
    expect(text).toContain('-- harness:data-section:end');
    expect(text.indexOf('UPDATE "runs"')).toBeGreaterThan(text.indexOf('-- harness:data-section:begin'));
    expect(text.indexOf('SET NOT NULL')).toBeGreaterThan(text.indexOf('-- harness:data-section:end'));
  });

  it('backfills principal_id from caller and adds the three nullable addressing columns', async () => {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql.raw(`
        INSERT INTO runs (id, client, caller) VALUES
          ('11111111-1111-4111-8111-111111111111', 'demo', 'hermes'),
          ('22222222-2222-4222-8222-222222222222', 'demo', 'approvals-app');
      `),
        );

        for (const statement of migrationStatements(MIGRATION)) await tx.execute(sql.raw(statement));

        const rows = (await tx.execute(sql.raw(`SELECT caller, principal_id, thread_id, surface, conversation FROM runs ORDER BY caller`)))
          .rows;
        expect(rows).toEqual([
          { caller: 'approvals-app', principal_id: 'approvals-app', thread_id: null, surface: null, conversation: null },
          { caller: 'hermes', principal_id: 'hermes', thread_id: null, surface: null, conversation: null },
        ]);

        const columns = (
          await tx.execute(
            sql.raw(
              `SELECT column_name, is_nullable, data_type FROM information_schema.columns WHERE table_name = 'runs' AND column_name IN ('principal_id', 'thread_id', 'surface', 'conversation') ORDER BY column_name`,
            ),
          )
        ).rows;
        expect(columns).toEqual([
          { column_name: 'conversation', is_nullable: 'YES', data_type: 'text' },
          { column_name: 'principal_id', is_nullable: 'NO', data_type: 'text' },
          { column_name: 'surface', is_nullable: 'YES', data_type: 'text' },
          { column_name: 'thread_id', is_nullable: 'YES', data_type: 'uuid' },
        ]);

        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @harness/db test -- src/domain/migration-0010.test.ts`
Expected: FAIL — `ENOENT … 0010_run_principal.sql`.

- [ ] **Step 3: Change the schema and generate the migration**

In `harness/db/src/domain/schema.ts`, replace the `runs` table with:

```ts
/**
 * One run: a conversation turn, a scheduled job, or a stdio server's lifetime. Every audit row,
 * effect and model call points at one, and `principal_id` is who it acted as.
 */
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  /** The principal id, again. Kept beside `principal_id` until nothing reads it; Plan 8 drops it. */
  caller: text('caller').notNull(),
  /** Who this run acts as: a `Principal.id` from the client's identity plug-in. */
  principalId: text('principal_id').notNull(),
  /** The conversation thread this run belongs to. A `threads` row once Plan 8 adds the table; no foreign key until then. */
  threadId: uuid('thread_id'),
  /** The surface the run was started from and the conversation on it. Null for the stdio server. */
  surface: text('surface'),
  conversation: text('conversation'),
  channel: text('channel'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});
```

From `harness/db/`, run: `pnpm drizzle-kit generate --name run_principal`
Expected: `drizzle/0010_run_principal.sql` and `drizzle/meta/0010_snapshot.json` written, `_journal.json` gains idx 10. The generated file reads:

```sql
ALTER TABLE "runs" ADD COLUMN "principal_id" text NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation" text;
```

Hand-edit it — the first statement fails on a table with rows — to:

```sql
ALTER TABLE "runs" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation" text;--> statement-breakpoint
-- harness:data-section:begin
-- Hand written. Every run so far was opened by a process whose CORE_TOOLS_CALLER was written
-- into `caller`; from Plan 7 on that string is the principal id, so the old rows take it as
-- theirs. `caller` stays until nothing reads it.
UPDATE "runs" SET "principal_id" = "caller" WHERE "principal_id" IS NULL;--> statement-breakpoint
-- harness:data-section:end
ALTER TABLE "runs" ALTER COLUMN "principal_id" SET NOT NULL;
```

Run `pnpm drizzle-kit generate` again from `harness/db/`.
Expected: `No schema changes, nothing to migrate 😴` — the snapshot already records `principal_id` as `NOT NULL`, and the SQL text is not what it compares.

- [ ] **Step 4: Run the migration test and the db suite**

Run: `pnpm --filter @harness/db test`
Expected: PASS, including `migration-0010.test.ts`.

- [ ] **Step 5: Write the failing `openRun` and `depsForRun` tests**

Create `harness/core-tools/src/domain/session/repository.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runs } from '@harness/db';
import { TEST_PRINCIPAL, useTestDb } from '../../testing.js';
import { openRun } from './repository.js';

const db = useTestDb();

describe('openRun', () => {
  it('writes the runs row with the principal id and hands back the context every audit row will carry', async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL, surface: 'memory', conversation: 'memory' });
    expect(context).toEqual({ runId: expect.any(String), threadId: null, surface: 'memory', conversation: 'memory' });
    const [row] = await db.select().from(runs);
    expect(row).toMatchObject({
      id: context.runId,
      client: 'test',
      caller: 'u-test',
      principalId: 'u-test',
      threadId: null,
      surface: 'memory',
      conversation: 'memory',
    });
  });

  it('defaults the addressing to null for a run with no surface, and reuses an id it is given', async () => {
    const first = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    expect(first).toMatchObject({ threadId: null, surface: null, conversation: null });
    // What the eval pipeline does after `resetDatabase` truncated the row: the same id, so an
    // already-built ToolDeps keeps pointing at a run that exists.
    await db.delete(runs);
    const again = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL, id: first.runId });
    expect(again.runId).toBe(first.runId);
    expect(await db.select().from(runs)).toHaveLength(1);
  });
});
```

Create `harness/core-tools/src/domain/tooling/deps.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Db } from '@harness/db';
import { PACK_KERNEL } from '../packs/kernel.js';
import { TEST_CONTEXT, TEST_PRINCIPAL, makeTestDeps } from '../../testing.js';
import { depsForRun, type KernelConfig } from './deps.js';

/** A config good enough to clone: `makeTestDeps` minus the per-run members. */
function config(): KernelConfig {
  const { db: _db, principal: _p, context: _c, sinks: _s, tools: _t, kernelTools: _k, kernel: _kn, ...rest } = makeTestDeps(
    null as unknown as Db,
  );
  return rest;
}

describe('depsForRun', () => {
  it('clones the shared configuration and adds what only this run knows', () => {
    const shared = config();
    const db = { marker: 'db' } as unknown as Db;
    const deps = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: { ...TEST_CONTEXT, runId: 'r1' } });
    expect(deps.db).toBe(db);
    expect(deps.principal).toBe(TEST_PRINCIPAL);
    expect(deps.context.runId).toBe('r1');
    expect(deps.policy).toBe(shared.policy);
    expect(deps.packs).toBe(shared.packs);
    expect(deps.kernel).toBe(PACK_KERNEL);
    expect(deps.sinks).toEqual({});
  });

  it('gives every run its own tool maps, so two servers built from one config never share a catalogue', () => {
    const shared = config();
    const db = {} as Db;
    const one = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: TEST_CONTEXT });
    const two = depsForRun(shared, { db, principal: TEST_PRINCIPAL, context: TEST_CONTEXT });
    expect(one.tools).not.toBe(two.tools);
    expect(one.kernelTools).not.toBe(two.kernelTools);
    expect(one.context).toBe(TEST_CONTEXT);
  });
});
```

- [ ] **Step 6: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/session/repository.test.ts src/domain/tooling/deps.test.ts`
Expected: FAIL — `openRun`, `TEST_CONTEXT` and `./deps.js` do not exist.

- [ ] **Step 7: Rename the context, add `deps.ts`, `openRun` and the test helpers**

In `harness/core-tools/src/domain/tooling/types.ts`, replace the `SessionContext` declaration with:

```ts
/**
 * What one run knows about itself, stamped onto every audit row, effect and model call it
 * produces. Built once per run — by `openRun` for the stdio server and the eval pipeline, by the
 * host per turn from Plan 8 — and never shared between runs: one `ToolDeps` per run, never a
 * process-wide mutable object.
 */
export interface RunContext {
  /**
   * The `runs` row this run's rows point at. Null only where no run was opened: the surface
   * recorder, which has no database, and a unit test that opened none. Every shipping entry
   * point opens one.
   */
  runId: string | null;
  /** The conversation thread (a `threads` row from Plan 8). Null until a host opens threads. */
  threadId: string | null;
  /** The surface and conversation the run was started from. Null for the stdio server. */
  surface: string | null;
  conversation: string | null;
  /** The skill the runtime activated, when it said so. Nothing in this plan sets them. */
  skill?: string;
  skillVersion?: string;
  /** The tool currently executing; set by `withCurrentTool`, read by `stageEffect`. */
  tool?: string;
}
```

and change `context: SessionContext;` in `ToolDeps` to `context: RunContext;` with the comment `/** This run's context, stamped on audit rows; see `context.ts`. One per run. */`. In `harness/core-tools/src/domain/tooling/context.ts`, replace every `SessionContext` with `RunContext` (the import and the three signatures). In `harness/core-tools/src/index.ts`, replace `type SessionContext,` with `type RunContext,`.

Create `harness/core-tools/src/domain/tooling/deps.ts`:

```ts
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { PACK_KERNEL } from '../packs/kernel.js';
import type { RunContext, ToolDeps } from './types.js';

/**
 * The startup-only part of `ToolDeps`: what `buildKernelConfig` reads and loads once per process
 * — packs, policy, the key, the gateway, the storage root — and every run shares.
 */
export type KernelConfig = Omit<ToolDeps, 'db' | 'principal' | 'context' | 'sinks' | 'tools' | 'kernelTools' | 'kernel'>;

/** What only one run knows. */
export interface RunDeps {
  db: Db;
  principal: Principal;
  context: RunContext;
}

/**
 * One `ToolDeps` for one run. The tool maps are fresh because `createCoreToolsServer` fills them
 * per server, and a second run's server must not find the first one's catalogue already there.
 */
export function depsForRun(config: KernelConfig, run: RunDeps): ToolDeps {
  return {
    ...config,
    db: run.db,
    principal: run.principal,
    context: run.context,
    sinks: {},
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
  };
}
```

In `harness/core-tools/src/domain/session/repository.ts`, add the imports `import type { Db } from '@harness/db';` (merge with the existing `runs` import: `import { runs, type Db } from '@harness/db';`) and `import type { Principal } from '@harness/identity-api';`, change the tooling types import to `import type { RunContext, ToolDeps } from '../tooling/types.js';`, and add before `setRunContext`:

```ts
export interface OpenRunInput {
  client: string;
  principal: Principal;
  surface?: string | null;
  conversation?: string | null;
  threadId?: string | null;
  /** Reuse an id: the eval pipeline re-opens its run after `resetDatabase` truncated the row. */
  id?: string;
}

/**
 * Open a run: write the `runs` row and hand back the context every row of the run will carry.
 * The one way a run comes to exist — the stdio server calls it once per process, the eval
 * pipeline once per handle, the host once per turn from Plan 8 — and nothing a model sends can.
 */
export async function openRun(db: Db, input: OpenRunInput): Promise<RunContext & { runId: string }> {
  const threadId = input.threadId ?? null;
  const surface = input.surface ?? null;
  const conversation = input.conversation ?? null;
  const [row] = await db
    .insert(runs)
    .values({
      ...(input.id === undefined ? {} : { id: input.id }),
      client: input.client,
      caller: input.principal.id,
      principalId: input.principal.id,
      threadId,
      surface,
      conversation,
    })
    .returning({ id: runs.id });
  return { runId: row.id, threadId, surface, conversation };
}
```

and in `setRunContext`'s insert, change `.values({ id: runToCreate, client: deps.client, caller: deps.principal.id })` to `.values({ id: runToCreate, client: deps.client, caller: deps.principal.id, principalId: deps.principal.id })` (the column is `NOT NULL` now; the tool goes in Task 5).

In `harness/core-tools/src/testing.ts`:
- change the types import to `import { DEFAULT_CONFIDENCE_THRESHOLD, type AnyToolDef, type RunContext, type ToolDeps } from './domain/tooling/types.js';`
- add after `TEST_PRINCIPAL`:
  ```ts
  /** No run opened. A test that asserts on `run_id` opens one with `openRun` and passes it as `context`. */
  export const TEST_CONTEXT: RunContext = { runId: null, threadId: null, surface: null, conversation: null };

  /** `Partial<ToolDeps>`, except that a partial context is merged over `TEST_CONTEXT` rather than replacing it. */
  export type TestDepsOverrides = Partial<Omit<ToolDeps, 'context'>> & { context?: Partial<RunContext> };
  ```
- change `makeTestDeps`'s signature to `export function makeTestDeps(db: Db, overrides: TestDepsOverrides = {}): ToolDeps {`, add `const { context, ...rest } = overrides;` as its first line, replace `context: {},` with `context: { ...TEST_CONTEXT, ...context },`, and `...overrides,` with `...rest,`.

In `harness/core-tools/src/domain/models/gateway.test.ts`, change the helper's parameter type: `function deps(overrides: TestDepsOverrides = {}): ToolDeps {`, importing `type TestDepsOverrides` from `../../testing.js` (and drop the now-unused `type ToolDeps` import if nothing else uses it).

In `harness/core-tools/src/app/record-surface.ts`, replace `context: {},` with `context: { runId: null, threadId: null, surface: null, conversation: null },`.

In `harness/core-tools/src/index.ts`, add `export { openRun, type OpenRunInput } from './domain/session/repository.js';` under "Domains" and `export { depsForRun, type KernelConfig, type RunDeps } from './domain/tooling/deps.js';` under "The tooling kernel".

In `evals/src/domain/pipeline.ts`: import `openRun` from `@harness/core-tools`; after `const { db, close: closeDb } = createDb(opts.databaseUrl);` add `const client = opts.client ?? 'evals';` and `const context = await openRun(db, { client, principal: EVAL_PRINCIPAL });`; in the deps literal use `client,` and replace `context: {},` with `context,`; and in `reset()` after `await resetDatabase(db);` add `await openRun(db, { client, principal: EVAL_PRINCIPAL, id: context.runId });`. In `evals/src/judge-deps.test-helpers.ts`, replace `context: {},` with `context: { runId: null, threadId: null, surface: null, conversation: null },`.

- [ ] **Step 8: Run the two tests and the kernel suite**

Run: `pnpm -r typecheck && pnpm --filter @harness/core-tools test && pnpm --filter @harness/evals test`
Expected: PASS. `registry.test.ts`'s "rolls the parked approval back when the audit write in the same transaction fails" still passes: its `context: { runId: randomUUID() }` is a partial merged over `TEST_CONTEXT`, and the missing `runs` row is still what makes the audit insert fail.

- [ ] **Step 9: Write the failing server tests**

Replace the `envOrDefault` describe in `harness/core-tools/src/app/server.test.ts` with:

```ts
describe('envOrDefault', () => {
  it('refuses an empty HARNESS_CLIENT rather than serving the default client', () => {
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '' })).toThrow(ConfigError);
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '  ' })).toThrow(/HARNESS_CLIENT/);
    expect(envOrDefault('HARNESS_CLIENT', 'default', {})).toBe('default');
    expect(envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: 'demo-practice' })).toBe('demo-practice');
  });

  it('refuses an empty HARNESS_PRINCIPAL rather than acting as the local service', () => {
    expect(() => envOrDefault('HARNESS_PRINCIPAL', 'svc-local', { HARNESS_PRINCIPAL: '' })).toThrow(/HARNESS_PRINCIPAL/);
    expect(envOrDefault('HARNESS_PRINCIPAL', 'svc-local', {})).toBe('svc-local');
  });
});

describe('clientDirFor', () => {
  it('is the client folder under the repository root', () => {
    expect(clientDirFor('river-clinic', '/srv/agent-harness')).toBe('/srv/agent-harness/clients/river-clinic');
  });
});

/**
 * The principal is resolved through the identity plug-in and refused when the id is not
 * declared: a server that started as "somebody" would audit every call as somebody.
 */
describe('resolvePrincipal', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-server-identity-'));
    writeFileSync(
      path.join(dir, 'identity.yaml'),
      'principals:\n  - id: u-coordinator\n    kind: user\n    level: lead\n    displayName: Coordinator\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    process.env.HARNESS_IDENTITY_FILE = path.join(dir, 'identity.yaml');
    delete process.env.HARNESS_IDENTITY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('resolves HARNESS_PRINCIPAL through the plug-in, defaulting to the local service', async () => {
    delete process.env.HARNESS_PRINCIPAL;
    expect((await resolvePrincipal({ client: 'smoke', env: process.env })).id).toBe('svc-local');
    process.env.HARNESS_PRINCIPAL = 'u-coordinator';
    expect((await resolvePrincipal({ client: 'smoke', env: process.env })).level).toBe('lead');
  });

  it('refuses an id the plug-in does not declare, naming it', async () => {
    process.env.HARNESS_PRINCIPAL = 'u-nobody';
    await expect(resolvePrincipal({ client: 'smoke', env: process.env })).rejects.toThrow(
      /HARNESS_PRINCIPAL names "u-nobody", which the identity plug-in "static" does not declare/,
    );
  });
});
```

with the imports `import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';`, `import { tmpdir } from 'node:os';`, `import { afterEach, beforeEach, describe, it, expect } from 'vitest';` and `import { clientDirFor, formsDirFrom, resolvePrincipal } from './server.js';`.

In `harness/core-tools/src/app/main.test.ts`, write an identity file into the storage temp dir and replace `CORE_TOOLS_CALLER: 'smoke-test',` with `HARNESS_PRINCIPAL: 'svc-local',` and `HARNESS_IDENTITY_FILE: identityFile,`, where before the `Client` is constructed:

```ts
    const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-'));
    const identityFile = path.join(storageDir, 'identity.yaml');
    writeFileSync(
      identityFile,
      'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
```

(`writeFileSync` joins the existing `node:fs` import; `HARNESS_STORAGE_DIR: storageDir`.) Then add a second test to the same `describe`:

```ts
  it('refuses to start as a principal the identity file does not declare', async () => {
    // Same spawn with HARNESS_PRINCIPAL=u-ghost: the child exits with a ConfigError before it
    // serves, so the client's connect rejects. What matters is that no server ever came up as
    // "u-ghost".
    const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-'));
    const identityFile = path.join(storageDir, 'identity.yaml');
    writeFileSync(
      identityFile,
      'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '../..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        HARNESS_PRINCIPAL: 'u-ghost',
        HARNESS_IDENTITY_FILE: identityFile,
        HARNESS_STORAGE_DIR: storageDir,
      },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  }, 30_000);
```

- [ ] **Step 10: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test -- src/app/server.test.ts src/app/main.test.ts`
Expected: FAIL — `clientDirFor` and `resolvePrincipal` are not exported; the spawned server still reads `CORE_TOOLS_CALLER`.

- [ ] **Step 11: Rebuild `server.ts` on `buildKernelConfig`, `resolvePrincipal` and `depsForRun`**

Replace `harness/core-tools/src/app/server.ts` with:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDb, loadKey } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import { ConfigError, booleanFromEnv, createLogger, envOrDefault, numberFromEnv, optionalEnv } from '@harness/shared';
import { loadIdentity } from '../domain/identity/registry.js';
import { depsForRun, type KernelConfig } from '../domain/tooling/deps.js';
import { loadPolicy } from '../domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from '../domain/tooling/types.js';
import { gatewayFromEnv } from '../domain/models/gateway.js';
import { storageRoot } from '../domain/storage/layout.js';
import { loadPacks } from '../domain/packs/registry.js';
import type { PackRegistry } from '../domain/packs/types.js';
import { openRun } from '../domain/session/repository.js';

const log = createLogger('core-tools');

// src/app -> src -> core-tools -> harness -> <repo>. The same resolution main.ts uses for .env.
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');

/**
 * Where the form templates live.
 *
 * The pack owns them, so `packs.formsDir()` — the first pack named in `HARNESS_PACKS` — is the
 * answer for every deployment that has not said otherwise, and swapping the pack swaps the
 * templates with it. `HARNESS_FORMS_DIR` is an explicit override for a deployment that keeps
 * its templates somewhere else; set, it wins and is resolved against the process working
 * directory, exactly as it did before the registry existed.
 */
export function formsDirFrom(
  packs: Pick<PackRegistry, 'formsDir'>,
  raw: string | undefined = optionalEnv('HARNESS_FORMS_DIR'),
): string {
  return raw ? path.resolve(raw) : packs.formsDir();
}

/**
 * Which packs this process serves, comma-separated package names. Defaults to the only pack
 * that exists today, so a deployment that sets nothing behaves exactly as it did.
 */
function packNames(): string[] {
  return (optionalEnv('HARNESS_PACKS') ?? '@harness/pack-healthcare')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

/** `clients/<name>/` under the repository root: `/srv/agent-harness/clients/<name>` in a container. */
export function clientDirFor(client: string, repoRoot: string = REPO_ROOT): string {
  return path.join(repoRoot, 'clients', client);
}

/**
 * Everything every run shares, read and loaded once per process. Nothing here is per run:
 * the database handle, the principal and the run context arrive through `depsForRun`.
 */
export async function buildKernelConfig(): Promise<KernelConfig> {
  const packs = await loadPacks(packNames());
  return {
    client: envOrDefault('HARNESS_CLIENT', 'default'),
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }),
    gateway: gatewayFromEnv(),
    // One root for the whole file store, required and with no default (see storageRoot).
    storageDir: storageRoot(),
    formsDir: formsDirFrom(packs),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL'),
    packs,
    // The deployment's own environment, and the only bag that hands one over. A pack reads its
    // variables from here; see `ToolDeps.env`.
    env: process.env,
  };
}

/**
 * The principal this process acts as: `HARNESS_PRINCIPAL`, an id the identity plug-in
 * `HARNESS_IDENTITY` names must declare. The plug-in is connected for this one lookup and
 * stopped again — a stdio server is one principal for its whole life, so it keeps no session.
 * An undeclared id is a startup failure: a server that started anyway would audit every call
 * as somebody nobody vouched for.
 */
export async function resolvePrincipal(config: Pick<KernelConfig, 'client' | 'env'>): Promise<Principal> {
  const specifier = envOrDefault('HARNESS_IDENTITY', '@harness/identity-static');
  const session = await loadIdentity(specifier, { env: config.env, log, clientDir: clientDirFor(config.client) });
  try {
    const id = envOrDefault('HARNESS_PRINCIPAL', 'svc-local');
    const principal = await session.get(id);
    if (!principal) {
      throw new ConfigError(`HARNESS_PRINCIPAL names "${id}", which the identity plug-in "${session.name}" does not declare`);
    }
    return principal;
  } finally {
    await session.stop();
  }
}

/**
 * The stdio server's dependencies: the shared configuration, this process's principal, and one
 * run for the process's lifetime. A multi-run host builds its own `KernelConfig` once and calls
 * `openRun` and `depsForRun` per run instead.
 */
export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const config = await buildKernelConfig();
  const principal = await resolvePrincipal(config);
  const context = await openRun(db, { client: config.client, principal });
  return { deps: depsForRun(config, { db, principal, context }), close };
}
```

In `harness/core-tools/src/app/main.ts`, change the listening log line to
`` log.info(`listening on stdio (client=${deps.client}, principal=${deps.principal.id}, run=${deps.context.runId})`); ``.

- [ ] **Step 12: Move the two children onto principal ids**

`harness/approvals/src/app/child-env.ts`: replace `CORE_TOOLS_CALLER: 'approvals-app',` with

```ts
    // The principal every approved action is executed and audited as. Declared in the client's
    // identity.yaml; the child refuses to start if it is not.
    HARNESS_PRINCIPAL: 'svc-approvals',
```

and add, after the `HARNESS_POLICY_FILE` line:

```ts
    ...(env.HARNESS_IDENTITY ? { HARNESS_IDENTITY: env.HARNESS_IDENTITY } : {}),
    ...(env.HARNESS_IDENTITY_FILE ? { HARNESS_IDENTITY_FILE: env.HARNESS_IDENTITY_FILE } : {}),
```

`harness/approvals/src/app/child-env.test.ts`: replace `expect(env.CORE_TOOLS_CALLER).toBe('approvals-app');` with `expect(env.HARNESS_PRINCIPAL).toBe('svc-approvals');` and add a case:

```ts
  it('forwards the identity plug-in and file only when the deployment sets them', () => {
    expect(coreToolsChildEnv(input())).not.toHaveProperty('HARNESS_IDENTITY_FILE');
    const env = coreToolsChildEnv(input({ HARNESS_IDENTITY: '@harness/identity-static', HARNESS_IDENTITY_FILE: '/srv/x/identity.yaml' }));
    expect(env.HARNESS_IDENTITY).toBe('@harness/identity-static');
    expect(env.HARNESS_IDENTITY_FILE).toBe('/srv/x/identity.yaml');
  });
```

`harness/approvals/src/domain/execute/mcp-client.test.ts`: write an identity file next to the storage dir and pass it — after `const storageDir = …`, add

```ts
    const identityFile = path.join(storageDir, 'identity.yaml');
    await writeFile(
      identityFile,
      'principals:\n  - id: svc-approvals\n    kind: service\n    level: service\n    displayName: Approvals host\n',
    );
```

and in the env literal replace `CORE_TOOLS_CALLER: 'approvals-app',` with `HARNESS_PRINCIPAL: 'svc-approvals',` and `HARNESS_IDENTITY_FILE: identityFile,`.

`clients/demo-practice/hermes.config.yaml`: replace `      CORE_TOOLS_CALLER: 'hermes'` with

```yaml
      # The principal this child acts as, declared in identity.yaml beside this file. Every
      # audit row and every approval it parks carries this id; the runtime cannot change it.
      HARNESS_PRINCIPAL: 'svc-hermes'
```

`.env.example`: replace the `CORE_TOOLS_CALLER` block (its two comment lines and the assignment) with

```
# The principal a core-tools process acts as: an id declared in
# clients/<HARNESS_CLIENT>/identity.yaml. Defaults to `svc-local`, the local
# operator's service identity, which is what the MCP inspector and the eval
# runner want; the Hermes and approvals containers set their own. An id the
# identity file does not declare is a startup error, and so is an empty value.
HARNESS_PRINCIPAL=svc-local

# Which identity plug-in resolves principals, as a package name loaded at
# startup. The static plug-in reads identity.yaml; a directory-backed one
# comes with the client that needs it.
#HARNESS_IDENTITY=@harness/identity-static
```

`clients/demo-practice/.env.example`: replace `CORE_TOOLS_CALLER=hermes` with `HARNESS_PRINCIPAL=svc-local` and the comment `# The stdio server's principal for a bare-metal run; see identity.yaml. The containers set their own.` above it.

- [ ] **Step 13: Run the server and approvals tests**

Run: `pnpm -r typecheck && pnpm --filter @harness/core-tools test -- src/app && pnpm --filter @harness/approvals test`
Expected: PASS. `grep -rn CORE_TOOLS_CALLER --include='*.ts' --include='*.yaml' --include='*.example' --include='*.md' . | grep -v node_modules | grep -v docs/superpowers` prints only `harness/core-tools/README.md` (Task 11 rewrites it).

- [ ] **Step 14: Add the deployment-name rule to the vocabulary scan**

In `harness/core-tools/src/kernel-vocabulary.test.ts`, after `FRAMEWORK_FORBIDDEN` add:

```ts
/**
 * A client's name and the agent runtime's name (spec decision 20). The kernel serves whichever
 * client `HARNESS_CLIENT` names and whichever runtime launches it; a kernel that spells either
 * is a kernel that will need a special case for the second one.
 */
const DEPLOYMENT_FORBIDDEN = /demo-practice|hermes/i;
```

and append four `SCANNED` entries mirroring the framework ones (same roots and skips: `harness/core-tools/src`, `evals/src`, `harness/identity-api/src`, `identities/static/src`) with `what: 'deployment vocabulary'` and `forbidden: DEPLOYMENT_FORBIDDEN`. In the "catches the words it claims to" case add `for (const line of ['HARNESS_CLIENT: demo-practice', '// Hermes starts one process per session']) expect(DEPLOYMENT_FORBIDDEN.test(line), line).toBe(true);`.

Run: `pnpm --filter @harness/core-tools test -- src/kernel-vocabulary.test.ts`
Expected: FAIL, naming three lines in `app/record-surface.ts` (the two `hermes` service mentions and `hermes.config.yaml`). Reword them: line 93's "the `hermes` service's `env_file: ../../.env`" → "the agent runtime service's `env_file: ../../.env`"; line 99's "`approvals`, `hermes`, `hermes-init` and `core-tools` all have one" → "every service but `postgres` and `litellm` has one"; line 152's "(`.env`, `policy.yaml`, `SOUL.md`, `hermes.config.yaml`)" → "(`.env`, `policy.yaml`, `identity.yaml`, `SOUL.md`, the runtime's config)". `server.ts` was rewritten in Step 11 and no longer mentions the runtime.

Run it again. Expected: PASS.

- [ ] **Step 15: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `git status` shows neither snapshot modified: the tool list is the same twenty-three, and the Compose config did not change (`hermes.config.yaml` is copied by `hermes-init`, not rendered).

- [ ] **Step 16: Commit**

```bash
git add harness/db harness/core-tools harness/approvals evals clients/demo-practice .env.example
git commit -m "feat(core-tools): bind one principal and one run context per run, resolved from HARNESS_PRINCIPAL"
```

### Task 5: Delete `harness_set_context`, and the step that called it in every skill

Invariant 1: identity comes only from whoever opened the run — no tool sets it, no model argument
carries it. With `openRun` in place nothing needs a tool to name a run, so the tool, its domain
function, the context-rewind helper that existed for it, its tests, its line in five skill
frontmatters, its "First, always" section, and SOUL rule 6 all go. The recorded tool surface
shrinks from twenty-three tools to twenty-two and is re-recorded here. The compose snapshot does
not move.

**Files:**
- Modify: `harness/core-tools/src/tools/harness.ts`, `harness.test.ts`, `audit.test.ts`, `skills-frontmatter.test.ts`
- Modify: `harness/core-tools/src/domain/session/repository.ts`, `domain/tooling/context.ts`, `execution.ts`, `registry.test.ts`, `src/index.ts`
- Modify: `harness/core-tools/src/app/surface.test.ts`
- Modify: `packs/healthcare/skills/credentialing-expirations/SKILL.md`, `credentialing-fill-form/SKILL.md`, `credentialing-intake/SKILL.md`, `credentialing-roster/SKILL.md`, `packs/stories/skills/stories-intake/SKILL.md`
- Modify: `clients/demo-practice/SOUL.md`, `docs/demo.md`
- Re-record: `docs/architecture/tool-surface.json`

**Interfaces:**
- Consumes: `openRun`, `TEST_PRINCIPAL` (Task 4).
- Produces: nothing new. Removed: the `harness_set_context` tool, `setRunContext`, `preservingContext`.

---

- [ ] **Step 1: Write the failing tests**

In `harness/core-tools/src/tools/harness.test.ts`:

1. Change the imports to
   ```ts
   import { describe, it, expect, beforeEach } from 'vitest';
   import { eq } from 'drizzle-orm';
   import { auditLog, runs, toolEffects } from '@harness/db';
   import { type ToolDeps } from '../domain/tooling/types.js';
   import { openRun } from '../domain/session/repository.js';
   import { TEST_PRINCIPAL, connectTestClient, makeTestDeps, resultOf, useTestDb } from '../testing.js';
   import { createCoreToolsServer } from './catalog.js';
   ```
2. Rename the describe `'session context and lineage'` to `'run context and lineage'`.
3. Delete its first three cases (`'stamps run, skill, and version on later audit rows and creates the run row'`, `'clears a field when null is passed'`, `'refuses to adopt a run that belongs to another client and leaves the context untouched'`) and put these two in their place:

   ```ts
     it('stamps the run every audit row belongs to, from the context the run was opened with', async () => {
       const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
       const withRun = makeTestDeps(db, { context });
       const client = await connectTestClient(() => createCoreToolsServer(withRun));
       await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
       const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
       expect(search.runId).toBe(context.runId);
       expect(search.caller).toBe('u-test');
       const [run] = await db.select().from(runs);
       expect(run).toMatchObject({ id: context.runId, principalId: 'u-test' });
     });

     it('publishes no tool that could set the run, the skill or the principal', async () => {
       const client = await connectServer();
       const { tools } = await client.listTools();
       expect(tools.map((t) => t.name)).not.toContain('harness_set_context');
       // Invariant 1: identity comes only from whoever opened the run, never from an argument.
       for (const tool of tools) expect(JSON.stringify(tool.inputSchema), tool.name).not.toMatch(/principal|run_id/);
     });
   ```

In `harness/core-tools/src/domain/tooling/registry.test.ts`: delete the `mutateContextThenThrow` fixture and the case `'restores session context when a tool transaction rolls back'`; remove `runs` from the `@harness/db` import (nothing else uses it there).

In `harness/core-tools/src/tools/audit.test.ts`: remove `'harness_set_context',` from the expected tool list.

In `harness/core-tools/src/tools/skills-frontmatter.test.ts`: replace

```ts
    expect(tools, `${name}: must call harness_set_context first`).toContain('harness_set_context');
```

with

```ts
    // The run is opened by whoever built the session, never by a tool a skill calls (Plan 7).
    expect(tools, `${name}: harness_set_context no longer exists`).not.toContain('harness_set_context');
```

In `harness/core-tools/src/app/surface.test.ts`: remove `'harness_set_context',` from `RECORDED_TOOLS`; retitle the case `'publishes the same twenty-three tools it did before'` to `'publishes the twenty-two tools of Plan 6 less harness_set_context, which Plan 7 deleted'`; and in the doc comment above `RECORDED_TOOLS` append the sentence "Plan 7 removed one tool, `harness_set_context`, and nothing else: identity and the run are bound by whoever opens the session, so there is no tool to set them."

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test -- src/tools/harness.test.ts src/tools/audit.test.ts src/tools/skills-frontmatter.test.ts src/app/surface.test.ts`
Expected: FAIL — the server still publishes `harness_set_context`; every skill still lists it; the snapshot still records twenty-three.

- [ ] **Step 3: Delete the tool, its logic and the rewind helper**

`harness/core-tools/src/tools/harness.ts`: delete the `harnessSetContext` definition; change the import to `import { reconcileForClient, stageNotification } from '../domain/session/repository.js';`; change the last line to `export const harnessTools: AnyToolDef[] = [harnessReconcile, harnessNotify];`.

`harness/core-tools/src/domain/session/repository.ts`: delete `SetContextArgs`, `SetContextResult` and `setRunContext`; drop the now-unused imports (`eq` from `drizzle-orm`, `ToolError` from `@harness/shared`). `openRun`, `reconcileForClient` and `stageNotification` stay.

`harness/core-tools/src/domain/tooling/context.ts`: delete `restoreContext` and `preservingContext`; rewrite the file's opening comment on `auditBaseFor` to say "under what run context" instead of "session context"; keep `withCurrentTool` and its comment.

`harness/core-tools/src/domain/tooling/execution.ts`: change the import to `import { withCurrentTool } from './context.js';`; in `runForApproval` replace

```ts
    const row = await preservingContext(deps.context, () =>
      withTransaction(deps.db, async (tx) => {
        const parked = await createOrReuseApproval(tx, deps, tool, args, base.argsHash);
        await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
        return parked;
      }),
    );
```

with

```ts
    const row = await withTransaction(deps.db, async (tx) => {
      const parked = await createOrReuseApproval(tx, deps, tool, args, base.argsHash);
      await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
      return parked;
    });
```

and in `runAuto` replace the `preservingContext(deps.context, () => withTransaction(...))` wrapper the same way, keeping the `withTransaction` body, and change the comment `// Spread keeps the one shared context object, which the handler may mutate.` to `// Spread keeps the run's context object, which withCurrentTool stamps the tool name on.`.

`harness/core-tools/src/index.ts`: change the context export to `export { auditBaseFor, withCurrentTool } from './domain/tooling/context.js';`.

- [ ] **Step 4: Take the step out of every skill and out of SOUL.md**

In each of the five `SKILL.md` files, delete the frontmatter line `      - harness_set_context` and the whole "First, always" section — the heading, its paragraph and the blank line after it. The paragraphs to delete are, verbatim:

- `packs/healthcare/skills/credentialing-expirations/SKILL.md`:
  ```
  ## First, always

  Call `harness_set_context` with `skill: "credentialing-expirations"`,
  `skill_version: "1.0.0"`, and a fresh UUID as `run_id`.

  ```
- `packs/healthcare/skills/credentialing-fill-form/SKILL.md`:
  ```
  ## First, always

  Call `harness_set_context` with `skill: "credentialing-fill-form"`,
  `skill_version: "1.0.0"`, and a fresh UUID as `run_id`.

  ```
- `packs/healthcare/skills/credentialing-intake/SKILL.md`:
  ```
  ## First, always

  Call `harness_set_context` with `skill: "credentialing-intake"`,
  `skill_version: "1.0.0"`, and a fresh UUID as `run_id`. Everything you do next
  is attributed to this run.

  ```
- `packs/healthcare/skills/credentialing-roster/SKILL.md`:
  ```
  ## First, always

  Call `harness_set_context` with `skill: "credentialing-roster"`,
  `skill_version: "1.0.0"`, and a fresh UUID as `run_id`.

  ```
- `packs/stories/skills/stories-intake/SKILL.md`:
  ```
  ## First, always

  Call `harness_set_context` with `skill: "stories-intake"`, `skill_version:
  "1.0.0"`, and a fresh UUID as `run_id`.

  ```

Nothing else in a skill changes: they are prompts, and the procedures do not mention the tool.

In `clients/demo-practice/SOUL.md`, replace rule 6 with:

```
6. **You act as whoever the harness bound to this session.** Every tool call is
   recorded against a principal the harness resolved before you ran — a person
   in Slack, or a service identity for a scheduled job. There is no tool to
   change it, and you never claim to act for someone else. When a tool is
   parked or refused because of that person's level, say so and name the
   approval id if there is one.
```

and in rule 9 delete the last sentence, "A `run_id` is a UUID; let the tool make one for you by omitting it rather than composing one."

In `docs/demo.md`, step 5 (the sentence is line-wrapped in the file at lines 99–101), replace "Point at the `skill` and `skill_version` columns — the trail says which skill caused each call — and at `derived_from` on the nightly digest, which points back at the query it was built from." with "Point at the `caller` column — every call carries the principal the harness bound to the session, never one the agent chose — and at `derived_from` on the nightly digest, which points back at the query it was built from. (Skill attribution returns with the runtime in Plan 8.)"

- [ ] **Step 5: Re-record the tool surface and run the tests**

Run: `pnpm surface:record`
Expected: `recorded 22 tools and the compose config into docs/architecture/`. `git diff --stat docs/architecture` shows only `tool-surface.json`; its diff is the removal of one entry, `harness_set_context` — its `inputSchema` (`run_id`, `skill`, `skill_version`, each `anyOf` string-or-null, plus the registry's `derived_from`) and its `outputSchema` envelope — and nothing else. `compose-surface.yaml` is byte-identical.

Run: `pnpm --filter @harness/core-tools test`
Expected: PASS.

- [ ] **Step 6: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green. `grep -rn "harness_set_context\|setRunContext\|preservingContext" --include='*.ts' --include='*.md' --include='*.yaml' harness packs evals clients docs/demo.md docs/runbook.md ARCHITECTURE.md CONTRIBUTING.md README.md` prints nothing outside `docs/superpowers/` (Task 11 rewrites the prose that still describes the session context).

- [ ] **Step 7: Commit**

```bash
git add harness/core-tools packs/healthcare/skills packs/stories/skills clients/demo-practice/SOUL.md docs/demo.md docs/architecture/tool-surface.json
git commit -m "feat(core-tools): delete harness_set_context; the run and the principal are bound before the model runs"
```

### Task 6: The `DocumentParser` seam and `localParser`

Spec 5.2's first half, inside core-tools only. The pipeline stops calling `extractDocumentText`
directly and reads through `deps.parser.extract(relPath)`; `localParser(storageDir)` is today's
subprocess code behind that seam, and every builder of a `ToolDeps` hands one over. Nothing
observable changes: same pages, same OCR decision, same sidecar. Both snapshots are untouched.

**Files:**
- Modify: `harness/core-tools/src/domain/documents/types.ts`, `pipeline.ts`
- Create: `harness/core-tools/src/domain/documents/parser.ts`, `parser.test.ts`
- Modify: `harness/core-tools/src/domain/tooling/types.ts`, `src/testing.ts`, `src/index.ts`, `app/server.ts`, `app/record-surface.ts`, `tools/documents.test.ts`
- Modify: `evals/src/domain/pipeline.ts`, `evals/src/judge-deps.test-helpers.ts`

**Interfaces:**
- Consumes: `resolveStoragePath`, `extractDocumentText`, `PageText`, `ExtractedText`.
- Produces:

  ```ts
  // @harness/core-tools — domain/documents/types.ts
  interface ParsedDocument extends ExtractedText { text: string }           // { pages: PageText[]; ocrUsed: boolean; text: string }
  interface DocumentParser { extract(relPath: string): Promise<ParsedDocument> }

  // @harness/core-tools — domain/documents/parser.ts
  function joinPages(pages: PageText[]): string
  function localParser(storageDir: string): DocumentParser

  // @harness/core-tools — domain/tooling/types.ts
  interface ToolDeps { …; parser: DocumentParser; … }
  ```

---

- [ ] **Step 1: Write the failing parser test**

Create `harness/core-tools/src/domain/documents/parser.test.ts`:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ToolError } from '@harness/shared';
import { writePdf } from './pdf.test-helpers.js';
import { localParser } from './parser.js';

let storageDir: string;

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-parser-'));
  // Enough text per page to clear MIN_CHARS_PER_PAGE, so the text layer is read and no OCR runs.
  await writePdf(storageDir, 'incoming/two-pages.pdf', [
    'Page one. The quick brown fox jumps over the lazy dog, twice over, for good measure.',
    'Page two. Expiration Date: 2027-03-31 and a licence number A98765 printed in full.',
  ]);
});
afterAll(async () => {
  await rm(storageDir, { recursive: true, force: true });
});

describe('localParser', () => {
  it('reads a text-layer PDF under the storage root, page by page', async () => {
    const out = await localParser(storageDir).extract('incoming/two-pages.pdf');
    expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
    expect(out.pages[1].text).toContain('A98765');
    expect(out.ocrUsed).toBe(false);
    expect(out.text).toBe(`${out.pages[0].text}\n\n${out.pages[1].text}`);
  });

  it('refuses a path outside the storage root before touching the filesystem', async () => {
    const parser = localParser(storageDir);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(ToolError);
    await expect(parser.extract('../outside.pdf')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
    await expect(parser.extract('/etc/hostname')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
  });
});
```

In `harness/core-tools/src/tools/documents.test.ts`, change `connectWithGateway`'s parameter type to `TestDepsOverrides` (import it from `../testing.js`; drop the `type ToolDeps` import if it becomes unused — `deps` at the top of the file is still typed `ToolDeps`, so it stays) and add to the `documents_classify and documents_extract` describe:

```ts
  it('reads the document through the parser seam, so a parser in another process is what the pipeline sees', async () => {
    const seen: string[] = [];
    gateway.setResponder(() => ({ content: EXTRACTION_REPLY }));
    const client = await connectWithGateway({
      parser: {
        extract: async (relPath) => {
          seen.push(relPath);
          return { pages: [{ num: 1, text: 'Name: Ada Lovelace MD' }], text: 'Name: Ada Lovelace MD', ocrUsed: true };
        },
      },
    });
    const ing = resultOf<IngestOut>(
      await client.callTool({ name: 'documents_ingest', arguments: { path: 'incoming/license.pdf' } }),
    );
    const out = resultOf<{ ocr_used: boolean; pages: number }>(
      await client.callTool({ name: 'documents_extract', arguments: { document_id: ing.document_id } }),
    );
    expect(seen).toEqual(['incoming/license.pdf']);
    expect(out).toMatchObject({ ocr_used: true, pages: 1 });
    const onDisk = await readFile(path.join(storageDir, 'incoming/license.pdf.redacted.txt'), 'utf8');
    expect(onDisk).toContain('Ada Lovelace MD');
  });
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/documents/parser.test.ts src/tools/documents.test.ts`
Expected: FAIL — `Cannot find module './parser.js'`; `parser` is not a member of `ToolDeps`.

- [ ] **Step 3: Declare the seam and write the local parser**

Append to `harness/core-tools/src/domain/documents/types.ts`:

```ts
/**
 * What a parser answers with, whichever process did the parsing: the pages, the same pages
 * joined by a blank line for a caller that wants one string, and whether OCR was needed. The
 * same three fields the files worker sends over HTTP, declared here again rather than imported
 * because core-tools does not depend on the worker.
 */
export interface ParsedDocument extends ExtractedText {
  text: string;
}

/**
 * The seam between the pipeline and whatever turns document bytes into text.
 *
 * Two implementations: `localParser` runs the subprocesses in this process, for tests and a
 * bare-metal run; `remoteParser` sends the path to the files worker, a process with no key, no
 * database and no outbound network, which is where an untrusted PDF belongs (spec decision 11).
 * `relPath` is relative to the storage root and is refused, with a `ToolError`, when it resolves
 * outside it — by both implementations, before anything is read or sent.
 */
export interface DocumentParser {
  extract(relPath: string): Promise<ParsedDocument>;
}
```

Create `harness/core-tools/src/domain/documents/parser.ts`:

```ts
import { resolveStoragePath } from '../storage/file-store.js';
import { extractDocumentText } from './text.js';
import type { DocumentParser, PageText } from './types.js';

/** The pages as one string, a blank line between them. What `ParsedDocument.text` carries. */
export function joinPages(pages: PageText[]): string {
  return pages.map((p) => p.text).join('\n\n');
}

/**
 * Parsing in this process: today's `extractDocumentText` behind the seam. The containment check
 * is the same one `documents_ingest` applies, so a path the pipeline was told about is checked
 * twice — once when the row was written, once when its bytes are read.
 */
export function localParser(storageDir: string): DocumentParser {
  return {
    async extract(relPath) {
      const abs = await resolveStoragePath(storageDir, relPath);
      const { pages, ocrUsed } = await extractDocumentText(abs);
      return { pages, text: joinPages(pages), ocrUsed };
    },
  };
}
```

In `harness/core-tools/src/domain/tooling/types.ts`: add `import type { DocumentParser } from '../documents/types.js';` and, after `storageDir`, the member

```ts
  /**
   * What turns a document under `storageDir` into text. `localParser(storageDir)` in tests and on
   * bare metal; `remoteParser(HARNESS_FILES_URL, storageDir)` in Compose, where the parsing
   * happens in a process that holds no key. Constructed, not configuration — the one member
   * of this bag that is, because the choice between the two is the deployment's and the domain
   * cannot make it from a URL alone.
   */
  parser: DocumentParser;
```

In `harness/core-tools/src/domain/documents/pipeline.ts`: change the `./text.js` import to `import { pdfPageCount } from './text.js';` and replace the body of `readForModel` so it begins:

```ts
  // Resolved here as well as inside the parser: the sidecar path below is derived from it, and
  // the containment check runs in this process before a path is handed to any parser (invariant 5).
  const abs = await resolveStoragePath(deps.storageDir, row.storagePath);
  const { pages, ocrUsed } = await deps.parser.extract(row.storagePath);
```

(the three lines after — `redactPages`, `promptPages`, the return — are unchanged).

`harness/core-tools/src/testing.ts`: import `localParser` from `./domain/documents/parser.js`; in `makeTestDeps`, before the literal, add `const storageDir = rest.storageDir ?? mkdtempSync(path.join(tmpdir(), 'harness-test-storage-'));`, then use `storageDir,` and `parser: localParser(storageDir),` in the literal (the `...rest` spread still lets a test hand in its own `parser`). Keep the comment about the throwaway directory.

`harness/core-tools/src/app/record-surface.ts`: add `parser: localParser('/nonexistent/surface'),` after `storageDir`, importing `localParser` from `../domain/documents/parser.js`.

`harness/core-tools/src/app/server.ts`: in `buildKernelConfig`, hoist `const storageDir = storageRoot();` above the literal and use `storageDir,` and `parser: localParser(storageDir),` (import from `../domain/documents/parser.js`).

`harness/core-tools/src/index.ts`: under "Domains", add `export { joinPages, localParser } from './domain/documents/parser.js';` and add `type DocumentParser, type ParsedDocument` to the `./domain/documents/types.js` export.

`evals/src/domain/pipeline.ts` and `evals/src/judge-deps.test-helpers.ts`: import `localParser` from `@harness/core-tools` and add `parser: localParser(opts.storageDir),` after `storageDir: opts.storageDir,`.

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm -r typecheck && pnpm --filter @harness/core-tools test && pnpm --filter @harness/evals test`
Expected: PASS. The OCR-dependent cases in `text.test.ts` and `pack-healthcare/documents.test.ts` still run through `text.ts`, which did not change.

- [ ] **Step 5: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; `git status` shows neither snapshot modified.

- [ ] **Step 6: Commit**

```bash
git add harness/core-tools evals
git commit -m "refactor(core-tools): read document text through a DocumentParser seam"
```

### Task 7: `@harness/files` — the parsing worker

Spec 5.2's worker: a `node:http` server that takes `POST /extract { path }`, refuses a path
outside the storage root with `assertInsideRoot`, runs `pdftotext` first and falls back to
`pdftoppm | tesseract` per page, and answers `{ pages, text, ocrUsed }`. It depends on
`@harness/shared` only, opens no database and holds no key. Nothing calls it yet — Task 8 adds the
remote parser and the Compose service — so both snapshots are untouched. The two variables it
reads are documented here.

**Files:**
- Create: `harness/files/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/files/src/domain/types.ts`, `errors.ts`, `extract.ts`, `extract.test.ts`, `server.ts`, `server.test.ts`
- Create: `harness/files/src/app/main.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry, one rule, the collapse pattern), `.env.example`, `harness/core-tools/src/kernel-vocabulary.test.ts` (one more root for each of the two new scans)

**Interfaces:**
- Consumes: `runBounded`, `assertInsideRoot`, `requiredEnv`, `numberFromEnv`, `optionalEnv`, `createLogger`, `ConfigError` from `@harness/shared`.
- Produces:

  ```ts
  // harness/files/src/domain/types.ts
  interface PageText { num: number; text: string }
  interface ParsedDocument { pages: PageText[]; text: string; ocrUsed: boolean }     // the wire shape Task 8's remoteParser validates

  // harness/files/src/domain/errors.ts
  class ParseError extends Error { readonly status: number; constructor(status: number, message: string) }

  // harness/files/src/domain/extract.ts
  const MIN_CHARS_PER_PAGE = 40
  interface ExtractOptions { dpi?: number; lang?: string; textTimeoutMs?: number; rasteriseTimeoutMs?: number; ocrTimeoutMs?: number }
  function missingBinaries(timeoutMs?: number): Promise<string[]>
  function extractDocument(absPath: string, options?: ExtractOptions): Promise<ParsedDocument>

  // harness/files/src/domain/server.ts
  interface FilesServerDeps { storageDir: string; log: Logger; options?: ExtractOptions }
  function createFilesServer(deps: FilesServerDeps): http.Server      // GET /healthz, POST /extract
  ```

- HTTP: `POST /extract` with JSON `{ "path": "<relative to the storage root>" }` → `200 { pages, text, ocrUsed }`; `400` bad body; `403` absolute or escaping path; `404` no such file; `413` body over 64 KiB; `415` neither PDF nor image; `422` a binary failed or timed out; `500` anything else. Error bodies are `{ "error": "<message>" }` and never carry a path — a basename at most.
- Environment: `HARNESS_STORAGE_DIR` (required, absolute), `HARNESS_FILES_PORT` (default `8790`), `HARNESS_FILES_BIND` (default `127.0.0.1`).

---

- [ ] **Step 1: Create the package**

Create `harness/files/package.json`:

```json
{
  "name": "@harness/files",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/app/main.ts"
  },
  "dependencies": {
    "@harness/shared": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "pdf-lib": "^1.17.1",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

No `exports` map, deliberately, as `scripts/` has none: the worker is a process, nothing imports it, and an `index.ts` nothing imported would be an orphan under `pnpm arch`.

Create `harness/files/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Create `harness/files/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Create `harness/files/README.md`:

```markdown
# @harness/files

The parsing worker: an untrusted PDF or image is turned into text here, in a process that holds
no encryption key, no database URL and no provider credential, on a Compose network that routes
nowhere. core-tools reaches it through its `DocumentParser` seam (`remoteParser`, when
`HARNESS_FILES_URL` is set) and does the redaction itself on what comes back.

```
POST /extract  { "path": "incoming/scan.pdf" }      path is relative to HARNESS_STORAGE_DIR
200            { "pages": [{ "num": 1, "text": "…" }], "text": "…", "ocrUsed": false }
GET  /healthz  { "ok": true }
```

`pdftotext` reads the text layer (page count from `pdfinfo`); when the document has fewer than
40 characters per page on average it is rasterised page by page with `pdftoppm` and read with
`tesseract`, exactly as core-tools' own `localParser` does. An image is read with `tesseract`
directly. A path that is absolute, or resolves outside the storage root through `..` or a
symlink, is refused with `403` before anything is read.

| Variable              | Meaning                                                        |
| --------------------- | -------------------------------------------------------------- |
| `HARNESS_STORAGE_DIR` | the storage root; required, absolute                           |
| `HARNESS_FILES_PORT`  | listen port, default `8790`                                    |
| `HARNESS_FILES_BIND`  | listen address, default `127.0.0.1`; Compose sets `0.0.0.0`    |

Error bodies are `{ "error": "…" }` and name a file's basename at most, never a path and never a
line of the page: the message ends up in `audit_log.error` on the core-tools side.

```bash
pnpm --filter @harness/files test      # the OCR cases skip when poppler or tesseract is missing
HARNESS_STORAGE_DIR=/srv/harness-storage pnpm --filter @harness/files start
```
```

Run: `pnpm install`
Expected: `+1` workspace project.

- [ ] **Step 2: Write the failing extraction test**

Create `harness/files/src/domain/types.ts`:

```ts
/**
 * The worker's answer, which is also the wire shape core-tools' `remoteParser` validates: the
 * pages, the same pages joined by a blank line for a caller that wants one string, and whether
 * OCR was needed. Declared here and again in core-tools' `domain/documents/types.ts` — three
 * fields, structurally identical — because this package imports `@harness/shared` only and
 * core-tools does not import this package.
 */
export interface PageText {
  /** 1-based, matching what a reviewer sees. */
  num: number;
  text: string;
}

export interface ParsedDocument {
  pages: PageText[];
  text: string;
  ocrUsed: boolean;
}
```

Create `harness/files/src/domain/errors.ts`:

```ts
/**
 * A failure the worker reports to its caller, with the HTTP status it maps to. The message is
 * what core-tools will put in front of an agent and in `audit_log.error`, so it names a file's
 * basename at most — never a path, never a line of the page.
 */
export class ParseError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ParseError';
    this.status = status;
  }
}
```

Create `harness/files/src/domain/extract.test.ts`:

```ts
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ParseError } from './errors.js';
import { extractDocument, missingBinaries } from './extract.js';

const run = promisify(execFile);
let dir: string;
let textLayerPdf: string;
let scanPdf: string;

async function makeTextPdf(target: string, pages: string[]): Promise<void> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  for (const body of pages) {
    const page = doc.addPage([612, 792]);
    body.split('\n').forEach((line, i) => page.drawText(line, { x: 54, y: 700 - i * 20, size: 14, font }));
  }
  await writeFile(target, await doc.save());
}

/** The same document as an image-only PDF: rasterise with pdftoppm, rebuild from the PNGs. */
async function rasterise(sourcePdf: string, target: string): Promise<void> {
  const prefix = path.join(dir, 'raster');
  await run('pdftoppm', ['-r', '200', '-png', sourcePdf, prefix]);
  const doc = await PDFDocument.create();
  for (let n = 1; ; n += 1) {
    let bytes: Buffer;
    try {
      bytes = await readFile(`${prefix}-${n}.png`);
    } catch {
      break;
    }
    const image = await doc.embedPng(bytes);
    doc.addPage([image.width, image.height]).drawImage(image, { x: 0, y: 0, width: image.width, height: image.height });
  }
  await writeFile(target, await doc.save());
}

// Probed once, before any `describe` is registered: `it.skipIf`'s condition is evaluated at
// collection time, so it cannot be computed inside `beforeAll`.
const missing = await missingBinaries();
if (missing.length > 0) {
  console.warn(`${missing.join(', ')} not installed; run \`brew install tesseract poppler\` — skipping the cases that need them`);
}
const popplerAvailable = !missing.includes('pdfinfo') && !missing.includes('pdftotext');
const ocrAvailable = missing.length === 0;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-files-'));
  textLayerPdf = path.join(dir, 'license.pdf');
  scanPdf = path.join(dir, 'license-scan.pdf');
  await makeTextPdf(textLayerPdf, [
    'STATE OF CALIFORNIA\nPHYSICIAN AND SURGEON LICENSE\nLicense Number A98765\nExpires 2027-03-31',
    'Issued to Ada Lovelace MD, second page of the same document, with enough text.',
  ]);
  if (ocrAvailable) await rasterise(textLayerPdf, scanPdf);
}, 60_000);

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('extractDocument', () => {
  it.skipIf(!popplerAvailable)('reads the text layer page by page and reports no OCR', async () => {
    const out = await extractDocument(textLayerPdf);
    expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
    expect(out.pages[0].text).toContain('A98765');
    expect(out.pages[1].text).toContain('Ada Lovelace');
    expect(out.ocrUsed).toBe(false);
    expect(out.text).toBe(`${out.pages[0].text}\n\n${out.pages[1].text}`);
  });

  it.skipIf(!ocrAvailable)(
    'falls back to OCR for an image-only PDF',
    async () => {
      const out = await extractDocument(scanPdf);
      expect(out.ocrUsed).toBe(true);
      expect(out.pages.map((p) => p.num)).toEqual([1, 2]);
      expect(out.pages[0].text.toUpperCase()).toContain('CALIFORNIA');
    },
    120_000,
  );

  it.skipIf(!ocrAvailable)('reads an image with tesseract as one page', async () => {
    const out = await extractDocument(path.join(dir, 'raster-1.png'));
    expect(out.ocrUsed).toBe(true);
    expect(out.pages).toHaveLength(1);
    expect(out.pages[0].text).toMatch(/A98765/);
  }, 60_000);

  it('refuses a file that is neither a PDF nor an image with 415', async () => {
    const bin = path.join(dir, 'notes.bin');
    await writeFile(bin, Buffer.from([0, 1, 2, 3]));
    const err = await extractDocument(bin).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).status).toBe(415);
  });

  it('reports a missing file as 404 without naming its directory', async () => {
    const err = await extractDocument(path.join(dir, 'missing.pdf')).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).status).toBe(404);
    expect((err as Error).message).not.toContain(dir);
  });

  it.skipIf(!ocrAvailable)('reports a timeout as 422 and never quotes the path', async () => {
    const err = await extractDocument(scanPdf, { ocrTimeoutMs: 1 }).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).status).toBe(422);
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as Error).message).not.toContain(dir);
  }, 30_000);
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @harness/files test -- src/domain/extract.test.ts`
Expected: FAIL — `Cannot find module './extract.js'`.

- [ ] **Step 4: Write `extract.ts`**

Create `harness/files/src/domain/extract.ts`:

```ts
import { mkdtemp, open, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { runBounded } from '@harness/shared';
import { ParseError } from './errors.js';
import type { PageText, ParsedDocument } from './types.js';

/** Below this many characters per page, on average, a PDF is treated as having no usable text layer. */
export const MIN_CHARS_PER_PAGE = 40;

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.tif', '.tiff', '.bmp']);

const BINARIES = ['pdfinfo', 'pdftotext', 'pdftoppm', 'tesseract'] as const;
/** `pdftoppm -v` and friends write a banner and exit 0; `tesseract --version` too. Only the exit is read. */
const VERSION_FLAG: Record<(typeof BINARIES)[number], string> = {
  pdfinfo: '-v',
  pdftotext: '-v',
  pdftoppm: '-v',
  tesseract: '--version',
};

export interface ExtractOptions {
  dpi?: number;
  lang?: string;
  /** Bound on `pdfinfo` and `pdftotext`. */
  textTimeoutMs?: number;
  /** Bound on one `pdftoppm` page render. */
  rasteriseTimeoutMs?: number;
  /** Bound on one `tesseract` pass. */
  ocrTimeoutMs?: number;
}

const DEFAULTS: Required<ExtractOptions> = {
  dpi: 300,
  lang: 'eng',
  textTimeoutMs: 60_000,
  rasteriseTimeoutMs: 120_000,
  ocrTimeoutMs: 60_000,
};

/** The binaries this worker cannot do without; empty when every one answers its version flag. */
export async function missingBinaries(timeoutMs = 10_000): Promise<string[]> {
  const missing: string[] = [];
  for (const name of BINARIES) {
    const outcome = await runBounded(name, [VERSION_FLAG[name]], { timeoutMs });
    if (!outcome.ok) missing.push(name);
  }
  return missing;
}

/** The pages as one string, a blank line between them. */
function joinPages(pages: PageText[]): string {
  return pages.map((p) => p.text).join('\n\n');
}

/** True when the file begins with the PDF magic number. A missing file is a 404, not a 500. */
async function isPdf(absPath: string): Promise<boolean> {
  let handle;
  try {
    handle = await open(absPath, 'r');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw new ParseError(404, 'no such document');
    throw err;
  }
  try {
    const { buffer, bytesRead } = await handle.read(Buffer.alloc(5), 0, 5, 0);
    return bytesRead === 5 && buffer.toString('latin1') === '%PDF-';
  } finally {
    await handle.close();
  }
}

function unreadable(absPath: string, tool: string, reason: 'timeout' | 'failed'): ParseError {
  const name = path.basename(absPath);
  return new ParseError(422, reason === 'timeout' ? `${tool} timed out on ${name}` : `${name} is not a readable PDF`);
}

/** Page count from `pdfinfo`, which prints one `Pages: N` line. */
async function pageCount(absPath: string, timeoutMs: number): Promise<number> {
  const outcome = await runBounded('pdfinfo', [absPath], { timeoutMs });
  if (!outcome.ok) throw unreadable(absPath, 'pdfinfo', outcome.reason);
  const match = /^Pages:\s+(\d+)/m.exec(outcome.stdout);
  if (!match) throw unreadable(absPath, 'pdfinfo', 'failed');
  return Number(match[1]);
}

/**
 * The text layer, one entry per page. `pdftotext` writes a form feed between pages and one after
 * the last, so splitting on it gives the pages in order plus one empty tail that is dropped by
 * counting to `pages`.
 */
async function textLayer(absPath: string, pages: number, timeoutMs: number): Promise<PageText[]> {
  const outcome = await runBounded('pdftotext', ['-layout', absPath, '-'], { timeoutMs, maxBuffer: 64 * 1024 * 1024 });
  if (!outcome.ok) throw unreadable(absPath, 'pdftotext', outcome.reason);
  const chunks = outcome.stdout.split('\f');
  return Array.from({ length: pages }, (_, i) => ({ num: i + 1, text: chunks[i] ?? '' }));
}

/**
 * OCR one already-rendered image. Only the image's basename is ever quoted back — never
 * stdout or stderr, which could contain restricted values read off the page.
 */
async function ocrImage(imagePath: string, page: number, opts: Required<ExtractOptions>): Promise<string> {
  const outcome = await runBounded('tesseract', [imagePath, 'stdout', '-l', opts.lang, '--psm', '6'], {
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs: opts.ocrTimeoutMs,
  });
  if (outcome.ok) return outcome.stdout;
  const name = path.basename(imagePath);
  throw new ParseError(422, outcome.reason === 'timeout' ? `ocr timed out on page ${page} of ${name}` : `OCR failed on ${name}`);
}

/**
 * Render each page to a PNG with `pdftoppm`, then OCR it. One page at a time, in a scratch
 * directory that is removed afterwards, so a hundred-page scan never holds a hundred bitmaps.
 */
async function ocrPdf(absPath: string, pages: number, opts: Required<ExtractOptions>): Promise<PageText[]> {
  const scratch = await mkdtemp(path.join(tmpdir(), 'harness-files-ocr-'));
  try {
    const out: PageText[] = [];
    for (let num = 1; num <= pages; num += 1) {
      const prefix = path.join(scratch, `p${num}`);
      const outcome = await runBounded(
        'pdftoppm',
        ['-r', String(opts.dpi), '-png', '-f', String(num), '-l', String(num), absPath, prefix],
        { timeoutMs: opts.rasteriseTimeoutMs },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'timeout') throw new ParseError(422, `rasterise timed out on ${path.basename(absPath)}`);
        throw new ParseError(422, `could not rasterise page ${num} of the document`);
      }
      // pdftoppm zero-pads the page suffix to the page count's width, so the file is found by
      // listing rather than guessed.
      const produced = (await readdir(scratch)).filter((f) => f.startsWith(`p${num}-`) && f.endsWith('.png')).sort();
      if (produced.length === 0) throw new ParseError(422, `page ${num} produced no image`);
      out.push({ num, text: await ocrImage(path.join(scratch, produced[0]), num, opts) });
    }
    return out;
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

/**
 * The worker's whole job: text layer when the PDF has one, OCR otherwise, per document rather
 * than per page — a scan with one stamped page of real text would otherwise mix qualities within
 * one record. `absPath` has already been checked against the storage root by the caller.
 */
export async function extractDocument(absPath: string, options: ExtractOptions = {}): Promise<ParsedDocument> {
  const opts = { ...DEFAULTS, ...options };
  if (!(await isPdf(absPath))) {
    const ext = path.extname(absPath).toLowerCase();
    if (!IMAGE_EXTENSIONS.has(ext)) {
      throw new ParseError(415, `unsupported document type ${ext || '(none)'}; expected a PDF or an image`);
    }
    const pages = [{ num: 1, text: await ocrImage(absPath, 1, opts) }];
    return { pages, text: joinPages(pages), ocrUsed: true };
  }
  const count = await pageCount(absPath, opts.textTimeoutMs);
  const layer = await textLayer(absPath, count, opts.textTimeoutMs);
  const total = layer.reduce((sum, p) => sum + p.text.trim().length, 0);
  if (total >= MIN_CHARS_PER_PAGE * Math.max(count, 1)) return { pages: layer, text: joinPages(layer), ocrUsed: false };
  const pages = await ocrPdf(absPath, count, opts);
  return { pages, text: joinPages(pages), ocrUsed: true };
}
```

- [ ] **Step 5: Run it and watch it pass**

Run: `pnpm --filter @harness/files test -- src/domain/extract.test.ts`
Expected: PASS (the OCR cases skip on a machine without the binaries; on this one they run).

- [ ] **Step 6: Write the failing server test**

Create `harness/files/src/domain/server.test.ts`:

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFDocument, StandardFonts } from 'pdf-lib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createLogger } from '@harness/shared';
import { missingBinaries } from './extract.js';
import { createFilesServer } from './server.js';

let storageDir: string;
let outsideDir: string;
let base: string;
let close: () => Promise<void>;

const popplerAvailable = (await missingBinaries()).every((name) => name === 'tesseract' || name === 'pdftoppm');

async function post(body: unknown): Promise<{ status: number; json: unknown }> {
  const res = await fetch(`${base}/extract`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  return { status: res.status, json: await res.json() };
}

beforeAll(async () => {
  storageDir = await mkdtemp(path.join(tmpdir(), 'harness-files-server-'));
  outsideDir = await mkdtemp(path.join(tmpdir(), 'harness-files-outside-'));
  await mkdir(path.join(storageDir, 'incoming'));
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText('State of California Medical Board. Licence A98765 expires 2027-03-31.', {
    x: 50,
    y: 700,
    size: 12,
    font,
  });
  await writeFile(path.join(storageDir, 'incoming', 'license.pdf'), await doc.save());
  await writeFile(path.join(outsideDir, 'secret.pdf'), 'top secret');
  await symlink(path.join(outsideDir, 'secret.pdf'), path.join(storageDir, 'incoming', 'escape.pdf'));

  const server = createFilesServer({ storageDir, log: createLogger('files-test') });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  close = () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve())));
});

afterAll(async () => {
  await close();
  await rm(storageDir, { recursive: true, force: true });
  await rm(outsideDir, { recursive: true, force: true });
});

describe('POST /extract', () => {
  it.skipIf(!popplerAvailable)('parses a document under the storage root', async () => {
    const { status, json } = await post({ path: 'incoming/license.pdf' });
    expect(status).toBe(200);
    expect(json).toMatchObject({ ocrUsed: false, pages: [{ num: 1 }] });
    expect((json as { pages: { text: string }[] }).pages[0].text).toContain('A98765');
  });

  it('refuses an absolute path and a path that climbs out, and never quotes either', async () => {
    for (const bad of ['/etc/hostname', '../outside.pdf', 'incoming/../../x.pdf']) {
      const { status, json } = await post({ path: bad });
      expect(status, bad).toBe(403);
      expect(JSON.stringify(json)).not.toContain(bad);
      expect(JSON.stringify(json)).not.toContain(storageDir);
    }
  });

  it('refuses a symlink under the root that points outside it', async () => {
    const { status } = await post({ path: 'incoming/escape.pdf' });
    expect(status).toBe(403);
  });

  it('answers 400 to a body that is not JSON or has no path, and 404 to a file that is not there', async () => {
    expect((await post('not json')).status).toBe(400);
    expect((await post({})).status).toBe(400);
    expect((await post({ path: 'incoming/missing.pdf' })).status).toBe(404);
  });

  it('answers 404 to any other route and 200 to the health probe', async () => {
    expect((await fetch(`${base}/other`)).status).toBe(404);
    expect(await (await fetch(`${base}/healthz`)).json()).toEqual({ ok: true });
  });
});
```

- [ ] **Step 7: Run it and watch it fail**

Run: `pnpm --filter @harness/files test -- src/domain/server.test.ts`
Expected: FAIL — `Cannot find module './server.js'`.

- [ ] **Step 8: Write `server.ts` and `main.ts`**

Create `harness/files/src/domain/server.ts`:

```ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import path from 'node:path';
import { assertInsideRoot, type Logger } from '@harness/shared';
import { ParseError } from './errors.js';
import { extractDocument, type ExtractOptions } from './extract.js';

/** A request names one path; anything longer than this is not one. */
const MAX_BODY_BYTES = 64 * 1024;

export interface FilesServerDeps {
  storageDir: string;
  log: Logger;
  options?: ExtractOptions;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new ParseError(413, 'request body too large');
    chunks.push(chunk as Buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown;
  } catch {
    throw new ParseError(400, 'request body is not JSON');
  }
}

/**
 * The requested path, resolved inside the root, or refused. The same primitive core-tools uses
 * for the same check: lexical and symlink-resolved, so neither `..` nor a planted link escapes.
 * The path is never repeated in a refusal: the caller chose it.
 */
async function resolveInside(storageDir: string, requested: unknown): Promise<string> {
  if (typeof requested !== 'string' || requested.trim() === '') {
    throw new ParseError(400, 'path must be a non-empty string relative to the storage root');
  }
  if (path.isAbsolute(requested)) throw new ParseError(403, 'path must be relative to the storage root');
  return assertInsideRoot(
    requested,
    storageDir,
    () => {
      throw new ParseError(403, 'path is outside the storage root');
    },
    { allowRoot: false },
  );
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

/** The worker's HTTP surface: a health probe and one parsing route. */
export function createFilesServer(deps: FilesServerDeps): Server {
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    try {
      if (req.method === 'GET' && req.url === '/healthz') return send(res, 200, { ok: true });
      if (req.method !== 'POST' || req.url !== '/extract') return send(res, 404, { error: 'not found' });
      const body = (await readJson(req)) as { path?: unknown } | null;
      const abs = await resolveInside(deps.storageDir, body?.path);
      send(res, 200, await extractDocument(abs, deps.options));
    } catch (err) {
      if (err instanceof ParseError) return send(res, err.status, { error: err.message });
      // Logged in full here, where the log is the operator's; the reply carries no errno text,
      // because an errno message names the file.
      deps.log.error('extract failed', err);
      send(res, 500, { error: 'document could not be parsed' });
    }
  }
  return createServer((req, res) => {
    void handle(req, res);
  });
}
```

Create `harness/files/src/app/main.ts`:

```ts
import path from 'node:path';
import { ConfigError, createLogger, numberFromEnv, optionalEnv, requiredEnv } from '@harness/shared';
import { missingBinaries } from '../domain/extract.js';
import { createFilesServer } from '../domain/server.js';

const log = createLogger('files');

// No dotenv here, on purpose: the worker's whole environment is the three variables Compose
// gives it, and a repository .env carries the key and the database URL it must never see.
const storageDir = requiredEnv('HARNESS_STORAGE_DIR', '; the worker parses documents under it and nothing else');
if (!path.isAbsolute(storageDir)) throw new ConfigError('HARNESS_STORAGE_DIR must be an absolute path');
const port = numberFromEnv('HARNESS_FILES_PORT', 8790, { min: 1, max: 65_535, integer: true });
// Loopback by default, for a bare-metal run; Compose sets 0.0.0.0, where the internal network
// is the boundary and a container-loopback listener would answer nobody.
const bind = optionalEnv('HARNESS_FILES_BIND') ?? '127.0.0.1';

const missing = await missingBinaries();
if (missing.length > 0) {
  throw new ConfigError(`the files worker needs ${missing.join(', ')} on PATH; install poppler-utils and tesseract-ocr`);
}

const server = createFilesServer({ storageDir, log });
server.listen(port, bind, () => log.info(`listening on http://${bind}:${port}, storage root ${storageDir}`));

function shutdown(signal: string): void {
  log.info(`${signal} received, stopping`);
  server.close(() => process.exit(0));
}
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
```

- [ ] **Step 9: Run the worker's suite**

Run: `pnpm --filter @harness/files test`
Expected: PASS.

- [ ] **Step 10: Register the package with the gates and document its variables**

`.dependency-cruiser.cjs`:

1. In `PACKAGES`, after the `approvals` row, add `{ name: 'files', src: 'harness/files/src', severity: 'error' },`.
2. In `WORKSPACE_DIRS`, after `'harness/approvals'`, add `'harness/files',`.
3. In `GLOBAL_RULES`, after `identity-api-imports-only-shared`, add:

   ```js
     {
       name: 'files-imports-only-shared',
       comment:
         '@harness/files parses untrusted documents in a process that holds no key and no database URL. It may import @harness/shared and node built-ins, and no other workspace package: an edge into @harness/db or core-tools would put the key back next to the parser, which is the boundary this package exists to draw.',
       severity: 'error',
       from: { path: '^harness/files/src/' },
       to: {
         path: '^(harness|packs|surfaces|identities|evals|scripts)/',
         pathNot: ['^harness/files/src/', '^harness/shared/src/'],
       },
     },
   ```

(The layered collapse pattern already matches `harness/files/src/domain` and `src/app`.)

`harness/core-tools/src/kernel-vocabulary.test.ts`: append to `SCANNED` one framework entry and one deployment entry for `root: 'harness/files/src'`, `minFiles: 4`, `skip: [/\.test\.ts$/]`.

`.env.example`: after the `HARNESS_STORAGE_DIR` block add:

```
# --- Files worker (@harness/files) --------------------------------------------
# The parsing worker's own two variables. It also reads HARNESS_STORAGE_DIR and
# nothing else: no key, no database URL, no provider credential. Compose sets
# both; on bare metal the defaults are a loopback listener on 8790.
#HARNESS_FILES_PORT=8790
#HARNESS_FILES_BIND=127.0.0.1
```

- [ ] **Step 11: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; both snapshots byte-identical (the env scan finds the two new names and both are documented; nothing in Compose changed yet).

- [ ] **Step 12: Commit**

```bash
git add harness/files .dependency-cruiser.cjs .env.example pnpm-lock.yaml harness/core-tools/src/kernel-vocabulary.test.ts
git commit -m "feat(files): add the document parsing worker"
```

### Task 8: `remoteParser`, and the `files` service on an internal network

The other half of the seam and the deployment that uses it. `remoteParser(baseUrl, storageDir)`
refuses a path outside the root before sending it, posts it to the worker and validates the
answer; `buildKernelConfig` picks it when `HARNESS_FILES_URL` is set. Compose gains a `files`
service on a network with `internal: true`, mounted on the storage volume and given three
variables and nothing else; the two services that spawn a core-tools child join that network and
hand the child `HARNESS_FILES_URL`. A new test pins the worker's environment and network to the
snapshot (invariant 6). The compose snapshot is re-recorded here.

**Files:**
- Modify: `harness/core-tools/src/domain/documents/parser.ts`, `parser.test.ts`, `app/server.ts`, `server.test.ts`, `src/index.ts`, `app/surface.test.ts`
- Modify: `harness/approvals/src/app/child-env.ts`, `child-env.test.ts`
- Create: `harness/compose/files.Dockerfile`
- Modify: `harness/compose/docker-compose.yml`, `clients/demo-practice/hermes.config.yaml`, `.env.example`
- Re-record: `docs/architecture/compose-surface.yaml`

**Interfaces:**
- Consumes: `DocumentParser`, `ParsedDocument`, `localParser` (Task 6); the worker's wire shape (Task 7).
- Produces:

  ```ts
  // @harness/core-tools — domain/documents/parser.ts
  const REMOTE_PARSE_TIMEOUT_MS = 600_000
  function remoteParser(baseUrl: string, storageDir: string, timeoutMs?: number): DocumentParser

  // @harness/core-tools — app/server.ts
  function parserFromEnv(storageDir: string, filesUrl?: string): DocumentParser   // remote when HARNESS_FILES_URL is set
  ```

- Environment: `HARNESS_FILES_URL` (optional; set by Compose to `http://files:8790`).

---

- [ ] **Step 1: Write the failing remote-parser test**

Append to `harness/core-tools/src/domain/documents/parser.test.ts` (adding `import { createServer, type Server } from 'node:http';`, `import type { AddressInfo } from 'node:net';` and `remoteParser` to the `./parser.js` import):

```ts
describe('remoteParser', () => {
  let stub: Server;
  let base: string;
  const requests: { url: string | undefined; body: unknown }[] = [];
  let reply: { status: number; body: unknown } = { status: 200, body: {} };

  beforeAll(async () => {
    stub = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        requests.push({ url: req.url, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) });
        res.writeHead(reply.status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(reply.body));
      });
    });
    await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(stub.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => stub.close(() => resolve())));

  it('posts the relative path and hands the worker’s pages back untouched', async () => {
    requests.length = 0;
    reply = { status: 200, body: { pages: [{ num: 1, text: 'hello' }], text: 'hello', ocrUsed: true } };
    const out = await remoteParser(`${base}/`, storageDir).extract('incoming/two-pages.pdf');
    expect(out).toEqual({ pages: [{ num: 1, text: 'hello' }], text: 'hello', ocrUsed: true });
    expect(requests).toEqual([{ url: '/extract', body: { path: 'incoming/two-pages.pdf' } }]);
  });

  it('refuses a path outside the root before anything is sent (invariant 5)', async () => {
    requests.length = 0;
    await expect(remoteParser(base, storageDir).extract('../outside.pdf')).rejects.toThrow(/outside HARNESS_STORAGE_DIR/);
    expect(requests).toEqual([]);
  });

  it('turns a refusal into a ToolError carrying the worker’s message, which is safe by construction', async () => {
    reply = { status: 415, body: { error: 'unsupported document type .zip; expected a PDF or an image' } };
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(
      /document parser refused \(HTTP 415\): unsupported document type \.zip/,
    );
  });

  it('turns an unreachable worker and a malformed answer into ToolErrors', async () => {
    await expect(remoteParser('http://127.0.0.1:1', storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(
      /document parser is unreachable/,
    );
    reply = { status: 200, body: { pages: 'nope' } };
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(ToolError);
    await expect(remoteParser(base, storageDir).extract('incoming/two-pages.pdf')).rejects.toThrow(/unexpected shape/);
  });
});
```

And to `harness/core-tools/src/app/server.test.ts`, add (importing `parserFromEnv` from `./server.js`):

```ts
describe('parserFromEnv', () => {
  it('parses in this process unless HARNESS_FILES_URL names a worker', async () => {
    // The two implementations are told apart by how they fail on a file that is not there: the
    // remote one never reaches a worker on a closed port, the local one reads the filesystem.
    await expect(parserFromEnv('/nonexistent', 'http://127.0.0.1:1').extract('a.pdf')).rejects.toThrow(/unreachable/);
    await expect(parserFromEnv('/nonexistent', undefined).extract('a.pdf')).rejects.not.toThrow(/unreachable/);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test -- src/domain/documents/parser.test.ts src/app/server.test.ts`
Expected: FAIL — `remoteParser` and `parserFromEnv` are not exported.

- [ ] **Step 3: Write `remoteParser` and `parserFromEnv`**

In `harness/core-tools/src/domain/documents/parser.ts`, add the imports `import * as z from 'zod/v4';` and `import { ToolError } from '@harness/shared';`, and append:

```ts
/** Long, because a hundred-page scan is a hundred `pdftoppm | tesseract` passes on the other side. */
export const REMOTE_PARSE_TIMEOUT_MS = 600_000;

/** The worker's answer, checked rather than trusted: it is another process. */
const RemoteReply = z.object({
  pages: z.array(z.object({ num: z.number().int().min(1), text: z.string() })),
  text: z.string(),
  ocrUsed: z.boolean(),
});

/**
 * Parsing in the files worker. The containment check runs here, before the path is sent — the
 * worker checks again, but this process does not rely on it (invariant 5). A refusal comes back
 * as a `ToolError` carrying the worker's message, which names a basename at most; a transport
 * failure and a malformed answer are `ToolError`s of their own, so nothing but a `ToolError`
 * ever reaches the agent from here.
 */
export function remoteParser(baseUrl: string, storageDir: string, timeoutMs = REMOTE_PARSE_TIMEOUT_MS): DocumentParser {
  const origin = baseUrl.replace(/\/+$/, '');
  return {
    async extract(relPath) {
      await resolveStoragePath(storageDir, relPath);
      let response: Response;
      try {
        response = await fetch(`${origin}/extract`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ path: relPath }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch {
        throw new ToolError('document parser is unreachable');
      }
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: unknown };
        const detail = typeof body.error === 'string' ? body.error : 'no detail';
        throw new ToolError(`document parser refused (HTTP ${response.status}): ${detail}`);
      }
      const parsed = RemoteReply.safeParse(await response.json().catch(() => null));
      if (!parsed.success) throw new ToolError('document parser answered with an unexpected shape');
      return parsed.data;
    },
  };
}
```

In `harness/core-tools/src/app/server.ts`, add (importing `remoteParser` beside `localParser`, and `type DocumentParser` from `../domain/documents/types.js`):

```ts
/**
 * Where documents are parsed. In Compose, `HARNESS_FILES_URL` names the files worker and the
 * bytes never enter this process; unset, the subprocesses run here, which is what a test and a
 * bare-metal developer want.
 */
export function parserFromEnv(storageDir: string, filesUrl: string | undefined = optionalEnv('HARNESS_FILES_URL')): DocumentParser {
  return filesUrl ? remoteParser(filesUrl, storageDir) : localParser(storageDir);
}
```

and in `buildKernelConfig` replace `parser: localParser(storageDir),` with `parser: parserFromEnv(storageDir),`.

In `harness/core-tools/src/index.ts`, change the parser export to `export { REMOTE_PARSE_TIMEOUT_MS, joinPages, localParser, remoteParser } from './domain/documents/parser.js';`.

In `harness/approvals/src/app/child-env.ts`, after the `HARNESS_GATEWAY_URL` line add
`...(env.HARNESS_FILES_URL ? { HARNESS_FILES_URL: env.HARNESS_FILES_URL } : {}),` with the comment `// Where the child parses documents. Unset on bare metal, where it parses in-process.`; in `child-env.test.ts` add to the gateway-URL case: `expect(coreToolsChildEnv(input({ HARNESS_FILES_URL: 'http://files:8790' })).HARNESS_FILES_URL).toBe('http://files:8790');`.

`.env.example`: in the files-worker block from Task 7, add:

```
# Where core-tools sends documents to be parsed. Unset, core-tools parses in
# this process with the same binaries (see "Document pipeline prerequisites"
# in README.md). Compose sets it to the worker on the internal network.
#HARNESS_FILES_URL=http://127.0.0.1:8790
```

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm -r typecheck && pnpm --filter @harness/core-tools test -- src/domain/documents src/app/server.test.ts && pnpm --filter @harness/approvals test -- src/app`
Expected: PASS.

- [ ] **Step 5: Write the failing compose-boundary test**

Append to `harness/core-tools/src/app/surface.test.ts` (adding `import { parse as parseYaml } from 'yaml';`):

```ts
/**
 * Invariant 6, read off the recorded Compose config: the files worker holds no key, no database
 * URL and no provider credential, sits on a network that routes nowhere, and publishes no port.
 */
describe('the files worker boundary', () => {
  interface Rendered {
    networks: Record<string, { internal?: boolean }>;
    services: Record<string, { environment?: Record<string, string>; networks?: Record<string, unknown>; ports?: unknown[] }>;
  }
  const rendered = async (): Promise<Rendered> =>
    parseYaml(await readFile(path.join(architecture, 'compose-surface.yaml'), 'utf8')) as Rendered;

  it('gives the worker a storage root, a port and a bind address, and nothing else', async () => {
    const { services } = await rendered();
    expect(Object.keys(services.files.environment ?? {}).sort()).toEqual([
      'HARNESS_FILES_BIND',
      'HARNESS_FILES_PORT',
      'HARNESS_STORAGE_DIR',
    ]);
  });

  it('puts the worker on an internal network and no other, with no published port', async () => {
    const { networks, services } = await rendered();
    expect(networks.files.internal).toBe(true);
    expect(Object.keys(services.files.networks ?? {})).toEqual(['files']);
    expect(services.files.ports).toBeUndefined();
  });

  it('is reached by the two services that spawn a core-tools child, which tell the child where it is', async () => {
    const { services } = await rendered();
    for (const name of ['hermes', 'approvals']) {
      expect(Object.keys(services[name].networks ?? {}).sort(), name).toEqual(['default', 'files']);
      expect(services[name].environment?.HARNESS_FILES_URL, name).toBe('http://files:8790');
    }
  });
});
```

Run: `pnpm --filter @harness/core-tools test -- src/app/surface.test.ts`
Expected: FAIL — the recorded config has no `files` service.

- [ ] **Step 6: Add the image and the service**

Create `harness/compose/files.Dockerfile`:

```dockerfile
# syntax=docker/dockerfile:1
#
# The files worker: untrusted document parsing with pdftotext, pdftoppm and tesseract, in a
# process that holds no key, no database URL and no provider credential, on a Compose network
# that routes nowhere. Only the two packages the worker needs are copied; pnpm's frozen install
# accepts a workspace copy that omits the rest. Build context is the repository root.
FROM node:22-bookworm-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      tesseract-ocr \
      tesseract-ocr-eng \
      poppler-utils \
 && rm -rf /var/lib/apt/lists/*

RUN npm install -g pnpm@11.4.0 && npm cache clean --force

WORKDIR /srv/agent-harness
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY harness/shared ./harness/shared
COPY harness/files ./harness/files
RUN pnpm install --frozen-lockfile && chmod -R a+rX /srv/agent-harness

# The base image's uid-1000 "node" user, which is the storage volume's owner (HERMES_UID=1000).
USER node
CMD ["pnpm", "--filter", "@harness/files", "start"]
```

In `harness/compose/docker-compose.yml`:

1. Before the top-level `volumes:` block, add:

   ```yaml
   networks:
     # The files worker's network. `internal: true` means no route out of it: the worker reaches
     # nothing — not the gateway, not the database, not the internet — and only the services
     # listed on it reach the worker (spec decision 3, invariant 6).
     files:
       internal: true
   ```

2. After the `litellm` service, add:

   ```yaml
     # Untrusted document parsing, in a process that holds no key and no database URL and cannot
     # reach the network. core-tools sends it a path under the storage root and gets pages back;
     # see harness/files/README.md. No env_file: its whole environment is the three lines below.
     files:
       build:
         context: ../..
         dockerfile: harness/compose/files.Dockerfile
       image: harness-files
       profiles: ['demo']
       restart: unless-stopped
       networks:
         - files
       environment:
         HARNESS_STORAGE_DIR: '/srv/harness-storage'
         HARNESS_FILES_PORT: '8790'
         # Every interface inside the container: the internal network is the boundary, and a
         # container-loopback listener would answer neither of the services that call it.
         HARNESS_FILES_BIND: '0.0.0.0'
       volumes:
         - storage:/srv/harness-storage
       healthcheck:
         test:
           [
             'CMD-SHELL',
             'node -e "fetch(''http://127.0.0.1:8790/healthz'').then((r) => process.exit(r.ok ? 0 : 1), () => process.exit(1))"',
           ]
         interval: 10s
         timeout: 5s
         retries: 6
   ```

3. On the `hermes` service: add `files:` with `condition: service_healthy` under `depends_on`; add
   ```yaml
       networks:
         - default
         - files
   ```
   after `restart: unless-stopped`; and in `environment:`, after the `HARNESS_GATEWAY_URL` line, add
   ```yaml
         # The core-tools child parses documents in the files worker, on the internal network.
         HARNESS_FILES_URL: 'http://files:8790'
   ```
   In the `hermes-init` command, extend the `sed -i` that rewrites the two loopback addresses with a third expression `-e 's#^HARNESS_FILES_URL=.*#HARNESS_FILES_URL=http://files:8790#' \` and add, after the `grep -q '^HARNESS_GATEWAY_URL='` line, `grep -q '^HARNESS_FILES_URL=' /data/.env || echo 'HARNESS_FILES_URL=http://files:8790' >> /data/.env`, and change "the two host-loopback addresses" in that comment to "the three host-side addresses".

4. On the `approvals` service: the same `depends_on` entry, the same `networks:` block after `restart: unless-stopped`, and after its `HARNESS_GATEWAY_URL` line:
   ```yaml
         # Same worker, same network: the child this app spawns parses documents there.
         HARNESS_FILES_URL: 'http://files:8790'
   ```

In `clients/demo-practice/hermes.config.yaml`, in the `mcp_servers.core-tools.env` block after `HARNESS_GATEWAY_URL`, add:

```yaml
      # The files worker on the internal network; hermes-init writes it into the .env this
      # block is interpolated from. Unset on bare metal, where the child parses in-process.
      HARNESS_FILES_URL: '${HARNESS_FILES_URL}'
```

- [ ] **Step 7: Re-record the compose snapshot and run the test**

Run: `pnpm surface:record`
Expected: `recorded 22 tools and the compose config`. `git diff --stat docs/architecture` shows only `compose-surface.yaml`, and its diff is: a `networks.files` entry with `internal: true` and `name: agent-harness_files`; a new `services.files` block (build, environment with exactly the three variables, healthcheck, `image: harness-files`, `networks: { files: null }`, `profiles: [demo]`, `restart`, the storage volume); on `hermes` and `approvals`, `depends_on.files`, `networks: { default: null, files: null }` and `HARNESS_FILES_URL: http://files:8790`; and the three new lines in `hermes-init`'s command. `tool-surface.json` is byte-identical.

Run: `pnpm --filter @harness/core-tools test -- src/app/surface.test.ts`
Expected: PASS.

- [ ] **Step 8: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add harness/core-tools harness/approvals harness/compose clients/demo-practice/hermes.config.yaml .env.example docs/architecture/compose-surface.yaml
git commit -m "feat(compose): parse documents in a files worker on an internal network"
```

### Task 9: Compose hygiene — no Docker socket, every client path from `HARNESS_CLIENT`, no pinned forms directory

Spec section 7 for this plan and the second half of invariant 6. The `hermes` service loses its
`/var/run/docker.sock` mount and Hermes's terminal backend becomes `local`; the three literal
`demo-practice` paths become `${HARNESS_CLIENT:?…}` interpolations; the two pinned
`HARNESS_FORMS_DIR` values and the one in the Hermes config go, because core-tools takes the
forms directory from the first pack. Three assertions pin all of it to the snapshot, which is
re-recorded here.

**Files:**
- Modify: `harness/compose/docker-compose.yml`, `clients/demo-practice/hermes.config.yaml`
- Modify: `harness/core-tools/src/app/surface.test.ts`
- Re-record: `docs/architecture/compose-surface.yaml`

**Interfaces:** none. Every variable this task touches already exists; `HARNESS_FORMS_DIR` stays documented in `.env.example` as the optional override it is.

---

- [ ] **Step 1: Write the failing snapshot assertions**

Append to `harness/core-tools/src/app/surface.test.ts`:

```ts
/**
 * Spec section 7, read off the recorded Compose config: no Docker socket anywhere, no client
 * name outside a `${HARNESS_CLIENT…}` interpolation, and no forms directory pinned to a pack —
 * core-tools takes it from the first pack `HARNESS_PACKS` names.
 */
describe('the Compose stack names no client and mounts no socket', () => {
  const rendered = async (): Promise<string> => readFile(path.join(architecture, 'compose-surface.yaml'), 'utf8');

  it('mounts no Docker socket anywhere', async () => {
    expect(await rendered()).not.toContain('/var/run/docker.sock');
  });

  it('derives every client path from HARNESS_CLIENT', async () => {
    // --no-interpolate keeps `${HARNESS_CLIENT:-demo-practice}` and `${HARNESS_CLIENT:?…}`
    // verbatim; with those stripped, the client's name must not appear anywhere.
    expect((await rendered()).replace(/\$\{HARNESS_CLIENT[^}]*\}/g, '')).not.toContain('demo-practice');
  });

  it('pins no forms directory', async () => {
    expect(await rendered()).not.toContain('HARNESS_FORMS_DIR');
  });
});
```

Run: `pnpm --filter @harness/core-tools test -- src/app/surface.test.ts`
Expected: FAIL on all three: the recorded config still mounts the socket, names the client three times and pins the forms directory twice.

- [ ] **Step 2: Edit the Compose file and the Hermes config**

In `harness/compose/docker-compose.yml`:

1. `hermes-init`'s bind mount: `- ../../clients/demo-practice:/srv/client:ro` → `- ../../clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}:/srv/client:ro`.
2. On `hermes` and on `approvals`: `HARNESS_POLICY_FILE: '/srv/agent-harness/clients/demo-practice/policy.yaml'` → `HARNESS_POLICY_FILE: '/srv/agent-harness/clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}/policy.yaml'`.
3. On `hermes`, delete the `HARNESS_FORMS_DIR` line and the four comment lines above it (`# An override, not a requirement: …` through `# repoint it, when a different pack owns the forms.`). On `approvals`, delete its `HARNESS_FORMS_DIR` line and the three comment lines above it (`# Same override as the hermes service: …` through `# only because the demo mounts the pack read-only at this path.`).
4. On `hermes`, delete the `/var/run/docker.sock:/var/run/docker.sock` volume line and the eight comment lines above it (`# terminal.backend is docker, so Hermes needs a Docker endpoint. …` through `# see hermes.Dockerfile.`).
5. In the file's header comment, after "`core-tools` is build-only (Hermes launches it over stdio, not as a service).", add: "Every client path is derived from `HARNESS_CLIENT`; onboarding a client is a folder and a `.env`, never an edit here. No service mounts the Docker socket."

In `clients/demo-practice/hermes.config.yaml`, replace the `terminal:` block with:

```yaml
# --- Sandbox ----------------------------------------------------------------
# `local` runs a shell in the agent's own container as HERMES_UID, with no Docker socket
# mounted anywhere (spec invariant 6). The Slack toolset has no terminal at all — see
# platform_toolsets — so only an operator on the CLI surface reaches this, and what they
# reach is one container, not the host.
terminal:
  backend: 'local'
  cwd: '/workspace'
  timeout: 180
  lifetime_seconds: 300
```

and in the `mcp_servers.core-tools.env` block delete the `HARNESS_FORMS_DIR` line and the four comment lines above it (`# Optional. Unset, core-tools takes the forms directory …` through `# new pack owns the forms.`).

- [ ] **Step 3: Re-record and run the test**

Run: `pnpm surface:record`
Expected: `git diff --stat docs/architecture` shows only `compose-surface.yaml`. Its diff: the `hermes-init` bind `source` becomes `../../clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}`; both `HARNESS_POLICY_FILE` values become `/srv/agent-harness/clients/${HARNESS_CLIENT:?set HARNESS_CLIENT in .env}/policy.yaml`; the two `HARNESS_FORMS_DIR` lines are gone; the `hermes` service's `/var/run/docker.sock` bind is gone. Nothing else moves; `tool-surface.json` is byte-identical.

Run: `pnpm --filter @harness/core-tools test -- src/app/surface.test.ts`
Expected: PASS.

- [ ] **Step 4: Check the scaffolder's fixture still means something**

`scripts/src/domain/scaffold.test.ts` seeds a `hermes.config.yaml` fixture that carries a `HARNESS_POLICY_FILE` line naming the template client, and asserts the copy rewrites it. That fixture describes a per-client file, which still exists and is still rewritten, so nothing changes here — the assertion is on the scaffolder's substitution, not on Compose.

Run: `pnpm --filter @harness/scripts test`
Expected: PASS.

- [ ] **Step 5: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add harness/compose/docker-compose.yml clients/demo-practice/hermes.config.yaml harness/core-tools/src/app/surface.test.ts docs/architecture/compose-surface.yaml
git commit -m "fix(compose): derive every client path from HARNESS_CLIENT and mount no Docker socket"
```

### Task 10: The CI workflow

Spec decision 18 and section 7: `.github/workflows/ci.yml` runs the four gates and the full suite
against a `pgvector/pgvector:pg16` service on every pull request and every push to `main`, then
builds every image. The three extra databases come from the same `init.sql` Compose uses, run
through `psql` because a service container cannot mount a file from a checkout that does not
exist yet when it starts. Nothing in the source tree changes; both snapshots are untouched.

**Files:**
- Create: `.github/workflows/ci.yml`, `.env.ci`
- Modify: `.gitignore`

**Interfaces:** none.

---

- [ ] **Step 1: Write the workflow**

Create `.github/workflows/ci.yml`:

```yaml
# The four gates and the image builds, on every pull request and every push to main.
#
# The gates job is `pnpm -r typecheck`, `pnpm lint`, `pnpm arch`, `pnpm format:check` and
# `pnpm test`, exactly as CONTRIBUTING.md's "Before you push" lists them, against a Postgres
# service with the same three extra databases the Compose stack's init.sql creates. The image
# job builds every service Compose defines, with placeholder values from .env.ci.
name: ci

on:
  pull_request:
  push:
    branches: [main]

jobs:
  gates:
    runs-on: ubuntu-latest
    services:
      postgres:
        # The image Plan 10 will need for pgvector; a plain Postgres 16 until then.
        image: pgvector/pgvector:pg16
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
      # A gateway key the spawned core-tools servers refuse to start without; no model is
      # ever called in the suite.
      LITELLM_MASTER_KEY: sk-ci-placeholder
      HARNESS_STORAGE_DIR: /tmp/harness-storage
    steps:
      - uses: actions/checkout@v4
      # No `version` input: the root package.json pins `packageManager: pnpm@11.4.0`, which is
      # what the action reads, and v4 refuses to be told the version twice.
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
          cache: pnpm
      - name: Install the parsing binaries and psql
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends tesseract-ocr tesseract-ocr-eng poppler-utils postgresql-client
      - name: A fresh encryption key for this run
        run: echo "HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> "$GITHUB_ENV"
      - run: pnpm install --frozen-lockfile
      - name: Create the test and evals databases, with the init.sql Compose uses
        run: psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f harness/compose/postgres/init.sql
      - run: pnpm db:migrate
      - run: mkdir -p "$HARNESS_STORAGE_DIR"
      - run: pnpm -r typecheck
      - run: pnpm lint
      - run: pnpm arch
      - run: pnpm format:check
      - run: pnpm test

  images:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      # The hermes service declares `env_file: ../../.env`. A build does not read it, but the
      # placeholder file is put there so that a Compose release that validates it at load time
      # cannot fail the job.
      - run: cp .env.ci .env
      - name: Build every image the Compose stack defines
        run: docker compose --env-file .env.ci -f harness/compose/docker-compose.yml --profile demo --profile build-only build
```

Create `.env.ci`:

```
# Placeholder values for the CI image build. Nothing here is a secret and nothing here is
# used at run time: `docker compose build` interpolates the Compose file, and the file
# refuses to render with these three unset. Every other variable falls to its Compose default.
HARNESS_CLIENT=demo-practice
HARNESS_ENCRYPTION_KEY=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=
LITELLM_MASTER_KEY=sk-ci-placeholder
```

In `.gitignore`, after `!.env.example` add `!.env.ci`.

- [ ] **Step 2: Check the workflow parses and the env file is tracked**

Run: `git check-ignore -v .env.ci; echo "exit=$?"`
Expected: `exit=1` and no output — the file is not ignored.

Run: `node -e "const y=require('yaml');y.parse(require('fs').readFileSync('.github/workflows/ci.yml','utf8'));console.log('ok')"` from `harness/core-tools` (where `yaml` is installed): `ok`.

Run: `pnpm format:check`
Expected: PASS — Prettier formats the workflow file and `.env.ci` is not a format it checks. If it reports the workflow, run `pnpm format` and restage.

- [ ] **Step 3: Run the gates**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green; both snapshots untouched.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/ci.yml .env.ci .gitignore
git commit -m "ci: run the four gates and build every image on pull requests and main"
```

### Task 11: Documentation

Everything a reader of the tree needs to know about what the ten tasks above did, in the places
the repository already keeps it. No code changes; both snapshots untouched. Every fact written
here is one the earlier tasks made true, so quote the files, not this plan.

**Files:**
- Modify: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`
- Modify: `harness/core-tools/README.md`, `harness/db/README.md`, `harness/pack-api/README.md`
- Modify: `.env.example` (one read-through)
- Regenerate: `docs/architecture/graph.svg` (only if `dot` is on `PATH`)

**Interfaces:** none.

---

- [ ] **Step 1: `ARCHITECTURE.md`**

1. In "The packages" code block, after the `harness/surface-api` lines add:

   ```
   harness/identity-api the Identity contract and defineIdentityProvider(): Principal, the five
                       levels (declared in @harness/shared), IdentitySession, and StaticIdentity
                       under its testing subpath. Depends on @harness/shared and zod.
   harness/files       the parsing worker: pdftotext, pdftoppm and tesseract behind one HTTP route,
                       in a process with no key, no database and no route out. Depends on
                       @harness/shared only.
   ```

   and after the `surfaces/memory` line add `identities/static   the identity plug-in that reads clients/<name>/identity.yaml.`

2. In the one-line-per-layer dependency graph, add `shared  <-  identity-api  <-  { core-tools, identities/* }`, `shared  <-  files`, and `core-tools  ..>  identities/*   (runtime only: HARNESS_IDENTITY, never a static import)`.

3. After the "Surfaces" section, add a section "## Identity":

   ```markdown
   ## Identity

   A **principal** is who a run acts as: a person, or a service identity for a scheduled job. It
   is resolved by an **identity plug-in** loaded by name from `HARNESS_IDENTITY` — the same shape
   as a pack and a surface, for the same reasons — and bound to the run by whoever opens it: the
   stdio server from `HARNESS_PRINCIPAL` at startup, a host per turn from Plan 8. A tool reads
   `deps.principal`. Nothing a model sends can set it; there is no tool to, and
   `harness/core-tools/src/tools/harness.test.ts` asserts that no published input schema mentions
   one.

   `@harness/identity-api` is the contract. `Principal { id, kind, level, displayName, surfaces,
   attributes }`; `IdentitySession.resolve({ surface, userId })` answers a principal or null, and
   null means "not authorised", never a guest. The five levels — `member`, `practitioner`, `lead`,
   `admin`, `service` — are declared in `@harness/shared` because `@harness/pack-api`'s policy
   matrix is keyed by them too and the two contracts may not import each other.

   **Policy is a matrix.** `Policy { classes, levels }`: `classes` is the row every level starts
   from and `levels.<level>.<class>` is where a level differs; `decide(actionClass, level, policy)`
   reads the level's cell first. `DEFAULT_POLICY` in `domain/tooling/policy.ts` is spec 4.4's
   table, with its practitioner row equal to the flat table the kernel shipped before levels
   existed. A client's `policy.yaml` keeps its `classes:` block and may add `levels:`.

   **One `RunContext` per run.** `openRun` writes the `runs` row — `principal_id`, `surface`,
   `conversation`, `thread_id` — and returns the context every audit row, effect and model call
   of that run carries. `buildKernelConfig()` does the startup-only work once; `depsForRun(config,
   { db, principal, context })` clones it per run. The stdio server opens one run per process.

   `identities/static` is the first plug-in: it reads `clients/<name>/identity.yaml`
   (`HARNESS_IDENTITY_FILE` overrides the path) through `parseIdentityFile`, which refuses a
   duplicate id, a user without a `u-` id or a service without `svc-`, a user at level `service`,
   and two principals claiming one surface user id. `CONTRIBUTING.md`, "Adding an identity
   provider", is the worked how-to.
   ```

4. In "The path of one tool call", step 1: "`app/server.ts` built `ToolDeps` from the environment at startup" → "`app/server.ts` built a `KernelConfig` from the environment at startup, resolved the process's principal, opened a run and cloned the two into one `ToolDeps` with `depsForRun`". Step 3: "`decide(tool.actionClass, deps.policy)`" → "`decide(tool.actionClass, deps.principal.level, deps.policy)`". Step 5: after "which redacts the page text" insert "— text it got from `deps.parser`, the files worker in Compose and the in-process subprocesses on bare metal —".

5. In "What ToolDeps carries, and what it does not", after the paragraph about `gateway` and `storageDir`, add:

   ```markdown
   Three members arrived with Plan 7 and each is deliberate. **`principal`** is who the run acts
   as and is set by whoever built the bag, never by a handler. **`context`** is one `RunContext`
   per run, no longer a process-wide object a tool could mutate; `withCurrentTool` still stamps the
   executing tool's name on it, which is the one field that changes during a call. **`parser`** is
   the one constructed object on the bag, because the choice between parsing here and parsing in
   the files worker is the deployment's (`HARNESS_FILES_URL`) and the domain cannot make it from a
   URL alone.
   ```

6. In the "Tooling" table, `pnpm arch` row: append to the list of rules: `"identity-api and files import only shared", "an identity plug-in imports only its contract and shared", "core-tools never statically imports an identity plug-in"`.

7. In "Proof that a refactor changed nothing": "— 23 tools today;" → "— 22 tools today;"; and after the three bullets add: "The same file also reads three things off the recorded Compose config: that the `files` service has exactly three environment variables and sits on an `internal: true` network with no published port (invariant 6), that no service mounts the Docker socket, and that no client name appears outside a `${HARNESS_CLIENT…}` interpolation."

8. In the kernel-vocabulary row of the suites table, after "a messaging word (…) in the kernel or in a pack" add: ", a framework or vendor word (`deepagents`, `langchain`, `langgraph`, `entra`, `teams`) and a deployment name (the client's, the runtime's) in the kernel, the identity contract, the identity plug-in, the files worker or the evals".

- [ ] **Step 2: `CONTRIBUTING.md`**

1. "Adding a tool", step 4: "Choose the action class honestly: `read`, `write.internal`, `external`, `financial`, `destructive`. `external` parks an approval; `financial` is blocked by default." → "Choose the action class honestly: `read`, `write.self`, `write.internal`, `write.assign`, `external`, `financial`, `destructive`, `admin`. What each does depends on the caller's level — `DEFAULT_POLICY` in `domain/tooling/policy.ts` is the table; `external` parks an approval for everyone and `financial` is blocked below `lead`."

2. "Adding a pack", step 10: delete the `HARNESS_FORMS_DIR` bullet (the third) and change "name it in all three places" to "name it in both places".

3. After "Adding a surface", add:

   ```markdown
   ## Adding an identity provider

   An identity provider — the contract calls it `IdentityProvider`; the kernel, whose vocabulary
   test forbids the word, says "identity plug-in" — answers which principal is behind a surface
   user id. `identities/static` is the smallest complete one; read it alongside this.

   1. **Create the package.** `mkdir -p identities/<name>/src` and a `package.json` named
      `@harness/identity-<name>`, with `"." : "./src/index.ts"` in `exports` and
      `@harness/identity-api` and `@harness/shared` in `dependencies`. **Never** depend on
      `@harness/core-tools`, `@harness/db`, a pack, a surface or another plug-in; `pnpm arch` fails
      the build on any of them, tests included. Add one `PACKAGES` row and one `WORKSPACE_DIRS`
      entry in `.dependency-cruiser.cjs`, and nothing else.

   2. **Declare it, and export it as `identity`.**

      ```ts
      export const identity = defineIdentityProvider({
        name: 'entra',
        version: '0.1.0',
        secrets: ['ENTRA_CLIENT_SECRET'],
        connect: async (deps) => createEntraSession(entraConfig(deps.env), deps.log),
      });
      ```

      `name` is lowercase and stable. `secrets` lists the environment variables you read that are
      credentials.

   3. **Read configuration from `deps.env`, never `process.env`,** through `@harness/shared`'s env
      helpers with `deps.env` as their last argument, and document every name in `.env.example` in
      the same commit — the env scan walks `identities/`. `deps.clientDir` is `clients/<name>/`.

   4. **Implement `IdentitySession`.** `resolve({ surface, userId })` answers a `Principal` or
      `null`, and null means "not authorised" — never invent a guest. `get(id)`, `list()` and
      `stop()`. A principal's `id` is `u-<slug>` for a person and `svc-<slug>` for a service, its
      `level` one of the five in `@harness/shared`, and `service` only for a service: whatever your
      directory says, map it onto those, and keep the id stable across renames, because it is what
      every audit row carries.

   5. **Test it against a fake directory.** No test reaches a real tenant. `StaticIdentity` from
      `@harness/identity-api/testing` is what to compare against.

   6. **Load it.** Add the package to `@harness/core-tools`' dependencies and set
      `HARNESS_IDENTITY=@harness/identity-<name>`. Nothing in the kernel changes.
   ```

4. "Adding a client": after "Then fill in `clients/acme-clinic/.env.example`, review `SOUL.md` and `policy.yaml`" insert ", declare the people and services in `identity.yaml`".

5. "Before you push": after the command block add "`.github/workflows/ci.yml` runs exactly these five on every pull request and every push to `main`, against a Postgres service, and then builds every image; a red check there is the same failure you would have seen here."

- [ ] **Step 3: `README.md`**

1. In the "Layout" block, after `harness/surface-api/` add `harness/identity-api/ the Identity contract a principal resolver implements`, after `harness/approvals/` add `harness/files/       the parsing worker: untrusted documents, no key, no database, no route out`, and after `surfaces/` add `identities/          the identity plug-ins: static (clients/<name>/identity.yaml)`.
2. In the paragraph below it, after "the approvals host holds no transport of its own." add: "An **identity plug-in** is loaded the same way: set `HARNESS_IDENTITY` to choose who resolves a person to a principal, and the kernel binds that principal to every run before the model sees anything."
3. In the "Documents" table's package READMEs row, add `[identity-api](harness/identity-api/README.md)` after `surface-api`, `[files](harness/files/README.md)` after `approvals`, and `[identity-static](identities/static/README.md)` after `surface-memory`.
4. In "Document pipeline prerequisites", replace the last sentence ("The Compose image for `core-tools` installs both; see `harness/compose/core-tools.Dockerfile`.") with: "On bare metal core-tools runs them itself. Under Compose it does not: documents are parsed by the `files` service (`harness/compose/files.Dockerfile`), a process with no key and no database on a network that routes nowhere, and core-tools reaches it through `HARNESS_FILES_URL`."

- [ ] **Step 4: `docs/runbook.md`**

1. Replace the "Session context" section with:

   ```markdown
   ## Runs and principals

   Every core-tools process acts as exactly one principal — `HARNESS_PRINCIPAL`, an id declared in
   `clients/<name>/identity.yaml` — and opens exactly one `runs` row at startup. The row carries
   `principal_id`, and every `audit_log`, `tool_effects` and `model_calls` row the process writes
   points at it. A process whose principal the identity file does not declare does not start.

   Who is who in the demo: `svc-hermes` is the child the chat runtime launches (set in
   `hermes.config.yaml`), `svc-approvals` the child the approvals host launches (set in its
   `child-env.ts`), `svc-local` the stdio server on an operator's machine (the default), and the
   two humans are `u-practice-manager` (`admin`) and `u-coordinator` (`lead`). Nothing resolves a
   Slack user to one of the humans until Plan 8's host does; until then every call from chat is
   the runtime's service principal, at level `service`.

   A multi-run host builds one `KernelConfig` and calls `openRun` and `depsForRun` per run; it
   must never reuse one `ToolDeps` across runs, or one run's id would be stamped on another's rows.

   To see what a run did:

   ```sql
   select r.id, r.principal_id, r.surface, r.conversation, r.started_at,
          count(a.id) as calls, count(a.id) filter (where a.decision = 'blocked') as blocked
   from runs r left join audit_log a on a.run_id = r.id
   where r.started_at > now() - interval '1 day'
   group by r.id order by r.started_at desc;
   ```
   ```

2. In "Reading audit errors", after the second SQL block add: "`caller` is the principal id since Plan 7 — `u-…` for a person, `svc-…` for a service — so a row's `caller` and its run's `principal_id` always agree."

3. In "Document pipeline", replace the two paragraphs from "`ocr_used = true` means…" to the `apt-get` block with:

   ```markdown
   `ocr_used = true` means the PDF had no usable text layer and every page went through
   `pdftoppm` and `tesseract`. Expect lower field accuracy; the eval suite scores that split
   separately for exactly this reason.

   **Where the parsing happens.** Under Compose, in the `files` service: core-tools sends the
   document's path (relative to the storage root, checked against it on both sides) to
   `HARNESS_FILES_URL` and gets pages back; the worker holds no key, no database URL and no
   provider credential, and its network is `internal: true`, so it reaches nothing. Redaction
   runs in core-tools on what comes back. `docker compose --env-file .env -f
   harness/compose/docker-compose.yml --profile demo logs files` is where a parse failure is
   explained in full; the message core-tools puts in `audit_log.error` names a basename at most.
   On bare metal, with `HARNESS_FILES_URL` unset, core-tools runs the same binaries itself:

   ```bash
   brew install tesseract poppler                      # macOS
   apt-get install -y tesseract-ocr poppler-utils      # Debian
   ```

   A document that fails with `unsupported document type` is neither a PDF nor a recognised
   image, whichever side parsed it. `document parser is unreachable` means the `files` service is
   down or the calling container is not on the `files` network.
   ```

4. Replace the "Onboarding a client" section with:

   ```markdown
   ## Onboarding a client

   `pnpm new-client --pack <pack> --name <slug>` scaffolds `clients/<slug>/` — `SOUL.md`,
   `identity.yaml`, `policy.yaml`, `routing.yaml`, the runtime config, the cron and watchdog
   scripts and an `.env.example`. Compose derives every client path from `HARNESS_CLIENT`, so
   there is nothing to edit under `harness/compose/`:

   1. `cp clients/<slug>/.env.example .env` and fill it in, with `HARNESS_CLIENT=<slug>` and a
      storage directory this client does not share.
   2. Declare the people and services in `clients/<slug>/identity.yaml`: the two service ids the
      containers use (`svc-hermes`, `svc-approvals`), `svc-local` for the operator, and one
      `u-…` principal per human with their level. A container whose principal is missing from the
      file refuses to start.
   3. Create the two Slack apps described under **Slack credentials** above and paste both pairs
      of tokens.
   4. Review `clients/<slug>/SOUL.md` and `policy.yaml` before the first run.
   5. Start it under its own Compose project so it does not collide with another client's
      containers and volumes:
      `COMPOSE_PROJECT_NAME=<slug> docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d --build`.

   `pnpm demo:up` is the same command under the default project name; with `HARNESS_CLIENT` set
   in `.env` it starts that client.
   ```

- [ ] **Step 5: The three package READMEs and `.env.example`**

`harness/core-tools/README.md`:
- "the seventeen kernel tools that expose them" → "the sixteen kernel tools that expose them"; "The 23 tools a default deployment publishes are five of the seventeen" → "The 22 tools a default deployment publishes are four of the sixteen"; in the layout block, `src/domain/` gains `identity` in its list and `src/tools/` reads "the sixteen kernel defineTool blocks in 6 files"; `src/app/` reads "server.ts (KernelConfig from the environment, the principal, one run), main.ts (stdio entrypoint), record-surface.ts"; `src/testing.ts` adds `TEST_PRINCIPAL, TEST_CONTEXT`.
- Replace the `HARNESS_CLIENT` and `CORE_TOOLS_CALLER` paragraph with: "`HARNESS_CLIENT`, `HARNESS_PRINCIPAL` and `HARNESS_IDENTITY` have defaults, and for each an empty value is a startup `ConfigError` naming the variable rather than a silent fall back. `HARNESS_PRINCIPAL` names an id the identity plug-in must declare; one it does not is a startup error too, because a server that started anyway would audit every call as somebody nobody vouched for. Parsing happens in the files worker when `HARNESS_FILES_URL` is set and in this process otherwise."
- In "Adding a tool" → "A kernel tool or a pack tool?": "`deps.kernelTools` still holds all seventeen" → "all sixteen".

`harness/db/README.md`: in the tables list, change the `approvals`, `runs`, `tool_effects` row's description to "the parked actions, the runs that produced them (each with the principal it acted as, and where it was started from), and the outbox"; in "Migrations", after the `0008` paragraph add: "`0010_run_principal` adds `runs.principal_id` and backfills it from `caller` in a hand-written data section before setting it `NOT NULL`; `src/domain/migration-0010.test.ts` replays it over a fixture of the pre-0010 `runs` table."

`harness/pack-api/README.md`: no further change (Task 2 made its two edits).

`.env.example`: read it top to bottom once and check that every name the code reads is documented and grouped where a reader would look: `HARNESS_PRINCIPAL`/`HARNESS_IDENTITY`/`HARNESS_IDENTITY_FILE` together under an `# --- Identity ---` heading (add the heading above `HARNESS_PRINCIPAL` and move the `HARNESS_IDENTITY_FILE` block under it), the files-worker block after the file-store block, and `CORE_TOOLS_CALLER` gone. `clients/demo-practice/.env.example`'s `# --- Identity` block gains one comment line: `# The principals themselves are in identity.yaml beside this file.`

- [ ] **Step 6: Regenerate the module graph**

Run: `which dot && pnpm arch:graph`
Expected: `docs/architecture/graph.svg` rewritten with the three new package nodes and the arrows Step 1's list describes. If `which dot` prints nothing, skip this step and say so in the commit message.

- [ ] **Step 7: Run the gates and read the diff**

Run: `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm test`
Expected: all green — Prettier checks the Markdown, so a table that was hand-aligned wrong fails here; run `pnpm format` and restage if it does.

Run: `grep -rn "CORE_TOOLS_CALLER\|harness_set_context\|SessionContext\|docker.sock\|seventeen\|23 tools" README.md ARCHITECTURE.md CONTRIBUTING.md docs/runbook.md docs/demo.md harness/*/README.md identities/*/README.md surfaces/*/README.md packs/*/README.md`
Expected: no output. (`docs/superpowers/` is history and is not grepped.)

- [ ] **Step 8: Commit**

```bash
git add ARCHITECTURE.md CONTRIBUTING.md README.md docs/runbook.md docs/architecture/graph.svg harness/core-tools/README.md harness/db/README.md .env.example clients/demo-practice/.env.example
git commit -m "docs: describe the identity contract, the run context, the files worker and the CI workflow"
```

---

## Self-review

Run after the last task, against the spec's Plan 7 scope; every row here was checked when the plan was written.

| Spec item | Task |
|---|---|
| 4.1 `LEVELS`, `Principal`, `IdentitySession`, `IdentityDeps`, `IdentityProvider`, `defineIdentityProvider`, `levelAtLeast`, `identity.yaml` shape, `StaticIdentity` under `testing` | 1 |
| 4.1 `identities/static` wraps `StaticIdentity` around a parsed `identity.yaml`; the demo file with the two humans and the services | 3 |
| 4.4 eight action classes, `Policy { classes, levels }`, `DEFAULT_POLICY` table, `decide(actionClass, level, policy)`, the demo file unchanged | 2 |
| 5.1 `principal` on `ToolDeps`, `caller` removed from every reader, `auditBaseFor` stamps the principal id, `approvals.requested_by` is the principal id | 2 |
| 5.1 `RunContext` per run, `runs.principal_id/thread_id/surface/conversation`, `buildKernelConfig`, `depsForRun`, stdio principal from `HARNESS_PRINCIPAL` with a fresh run per process | 4 |
| 5.1 `harness_set_context` deleted; packs' skills lose the step (3.1: "skills lose the `harness_set_context` step"); SOUL rule 6 rewritten (section 7) | 5 |
| 5.2 `DocumentParser` seam, `localParser`, `remoteParser(HARNESS_FILES_URL)`, redaction stays in core-tools | 6, 8 |
| 5.2 `@harness/files`: `POST /extract { path }`, `assertInsideRoot`, `pdftotext` then `pdftoppm | tesseract`, `{ pages, text, ocrUsed }`, no database, no key, `internal: true` network | 7, 8 |
| 6 migration 0010 by plain `drizzle-kit generate` (plus the hand-written backfill the 0008/0009 precedent allows) | 4 |
| 7 "every client path is `/srv/agent-harness/clients/${HARNESS_CLIENT}/…`", the pinned forms path goes, no Docker socket anywhere | 9 |
| 7 CI: `.github/workflows/ci.yml`, frozen install, the four gates and `pnpm test` against `pgvector/pgvector:pg16`, `docker compose build` of every image | 10 |
| 3.1 dependency rules: `identity-api` imports only shared; `identities/*` only `identity-api` and shared; `harness/files` only shared; core-tools never imports an identity plug-in statically | 1, 3, 7 |
| 3.1 `evals`: "principal instead of caller; otherwise unchanged" | 2, 4 |
| 3.1 `scripts`: the scaffolder writes `identity.yaml` | 3 |
| Decision 20 vocabulary rule: `deepagents`, `langchain`, `langgraph`, `entra`, `teams`, and no client name in code | 2 (framework), 4 (deployment) |
| Invariant 1 (identity only from the host; no tool sets it; no argument carries it) | 5 (`harness.test.ts`) |
| Invariant 2 (decided by `(actionClass, principal.level)`, audited with the principal id) | 2 (`registry.test.ts`) — "a `service` principal cannot approve" is the approvals host's rule and lands with Plan 8's principal-resolved decisions |
| Invariant 5 (bytes parsed only in the worker; the seam refuses a path outside the root before it is sent) | 8 (`parser.test.ts`), 7 (`server.test.ts`) |
| Invariant 6 (no key, database URL or provider key in the worker's environment; no Docker socket anywhere) | 8 and 9 (`surface.test.ts`) |
| Invariant 11 (kernel sources carry no client, domain, surface, provider or framework vocabulary) | 2, 3, 4, 7 (`kernel-vocabulary.test.ts`) |
| 10 exit criterion: `pnpm test` green in CI; the demo still runs on Hermes with a static principal; every tool call carries a principal id | 10; 4; 2 |

Not mapped, and deliberately so: `SLACK_ALLOWED_USERS` / `MEMORY_ALLOWED_USERS` retirement (spec 4.1's last paragraph) and "a decision is accepted only from a principal of level `lead` or above" (invariant 3) — both are the approvals host resolving a surface user to a principal, which is Plan 8's host; the brief says surface `allowedUsers` stay untouched here.

**Placeholder scan.** No "TBD", "TODO", "implement later", "similar to Task N" or "add appropriate …" anywhere; every code step carries the code; every path is exact.

**Type consistency.** `Principal` (Task 1) is the type of `ToolDeps.principal` (Task 2), `OpenRunInput.principal` and `RunDeps.principal` (Task 4) and `TEST_PRINCIPAL` (Task 2); `Level` (Task 1) keys `LevelOverrides` (Task 2) and is `decide`'s second argument (Task 2) read from `deps.principal.level` (Tasks 2, 4); `RunContext` (Task 4) is `ToolDeps.context`, `openRun`'s return, `TEST_CONTEXT` and the `context` member of `TestDepsOverrides` (Task 4) and is what `harness.test.ts` passes back in (Task 5); `KernelConfig`/`depsForRun` (Task 4) are what `buildDepsFromEnv` composes (Task 4) and what `parserFromEnv` feeds through `buildKernelConfig` (Task 8); `DocumentParser`/`ParsedDocument` (Task 6) are `ToolDeps.parser`'s type, `localParser`'s and `remoteParser`'s return (Tasks 6, 8) and structurally the worker's `ParsedDocument` (Task 7); `IdentityModule` (Task 1) is what `loadIdentity` casts the import to (Task 3) and what `resolvePrincipal` consumes through it (Task 4); `PolicyOverrides` (Task 2) is `Pack.policy`'s type and `mergePolicy`'s second argument (Task 2) and what `parsePolicy` hands `mergePolicy` (Task 2).
