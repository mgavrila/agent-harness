# Plan 4: Maintainability revamp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restructure every workspace package onto one four-layer shape (shared → domain → tools → app) with a single public entry point, one home for each cross-cutting concern, lint and architecture tooling that fails the build when a layer is crossed the wrong way, and documentation a newcomer can read — changing no behaviour at all.

**Architecture:** Three moves, repeated per package. (1) A `src/shared/` layer holds the pure helpers that are currently reinvented per package — env parsing, the three error types, path containment, logging, bounded subprocesses, JSONL, CSV quoting and the redaction patterns — and `@harness/core-tools` exports them through its public API so `@harness/approvals`, `@harness/evals` and the pack import them instead of keeping copies. (2) Each package's business code moves into `src/domain/<name>/` folders whose `types.ts` declares every interface reached across a boundary, with the production adapter and the fake beside it; `src/tools/` shrinks to `defineTool` calls; `src/app/` becomes the only place that reads the environment and composes dependencies. (3) ESLint 9 flat config, Prettier and dependency-cruiser enforce the layering, and a public-surface snapshot test (MCP tool list with JSON schemas, the set of environment variable names, the rendered Compose config) fails the suite the moment a rename or a lost export escapes.

**Tech Stack:** unchanged runtime (Node `>=22`, pnpm `11.4.0`, TypeScript `7.0.2` strict ESM, zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `0.45`, `@modelcontextprotocol/server`/`client` v2, `@slack/bolt` `5.1`, vitest 5, Postgres 16), plus new **dev-only** tooling: ESLint `9.39.5`, `typescript-eslint` `8.70.0` driven by a root-only `typescript` `6.0.3` (see "Facts verified" — typescript-eslint refuses to load against TypeScript 7), `eslint-plugin-import-x` `4.17.1`, `eslint-import-resolver-typescript` `4.4.5`, `eslint-plugin-unused-imports` `4.4.1`, `eslint-config-prettier` `10.1.8`, `globals` `17.12.0`, Prettier `3.9.7`, `dependency-cruiser` `16.10.4`.

**Spec:** `docs/superpowers/specs/2026-09-16-maintainability-revamp-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript strict ESM everywhere; zod is always imported as `import * as z from 'zod/v4'`.
- **NO behaviour change.** Tool names, tool input and output JSON schemas, environment variable names, database migrations and the Compose file's shape are all unchanged. Nothing in this plan adds a migration; the drizzle no-op check stays green.
- **Test assertions are untouched.** Test files move with the code they test, and a test file may be *split* along its existing `describe` boundaries, but no `expect(...)` line is rewritten. The only new tests allowed are tests for newly introduced shared helpers; the only deletions allowed are literal duplicates (the same test body now covered once in `shared/`).
- **The full suite — 522 tests across 7 packages — is green after every task.**
- **The public-surface snapshot test from Task 1 is green after every task.**
- **Imports only go downward:** `shared → domain → tools → app`. `shared/` imports only Node built-ins and third-party libraries. A domain may import `shared/`, and other domains' `types.ts` and exported functions. `tools/` imports `domain/` and `shared/`. `app/` imports everything. `src/index.ts` imports `domain/`, `tools/` and `shared/`, and **never** `app/`.
- **Other packages import only a package's `index.ts` or one of its declared subpath exports.** No package ever deep-imports `../other-package/src/...`.
- **Exactly three deliberate error types:** `ToolError` (agent-visible), `ModelOutputError` (a `ToolError` subclass), `ConfigError` (startup misconfiguration). They are declared once, in `harness/core-tools/src/shared/errors.ts`. Everything else is a plain `Error` that the tooling kernel masks. `@harness/db` is the one exception and it is deliberate: it sits below `core-tools` in the graph and cannot import it without a cycle, so it keeps plain `Error`. ARCHITECTURE.md says so.
- **No `console.*` outside `shared/log.ts` and CLI entrypoints** (`src/app/**`, and the three pack/script CLI files). ESLint enforces it.
- **No `process.env` outside `shared/env.ts` and `app/`.** ESLint enforces it.
- **No `throw new Error` inside `tools/`.** ESLint enforces it. `new Error(...)` as a *value* is still fine; only the `throw` form is restricted.
- A domain that needs only one module is a single file `src/domain/<name>.ts`. It gets a folder as soon as it needs a second module or a `types.ts` shared between modules. Files are named by responsibility (`types.ts`, `repository.ts`, `render.ts`, `prompts.ts`), never after the package or the folder they sit in, so no two files in a package share a basename with different responsibilities.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **Never run `docker compose up`, `docker compose down` or `pnpm db:up`/`pnpm db:down`.** The local stack is shared with other checkouts and other sessions. `docker compose ... config` is read-only and is used by the surface test; that one is fine.
- **Never source `.env` into the shell before running tests.** A crypto test asserts the behaviour of an unset `HARNESS_ENCRYPTION_KEY`, and a sourced `.env` makes it pass for the wrong reason.
- Test database: `postgres://harness:harness@localhost:15432/harness_test`. Evals database: `postgres://harness:harness@localhost:15432/harness_evals`. Both already exist; do not create or drop them.
- Do not push from a task.

---
## Facts verified for this plan

Everything below was executed against this checkout on 2026-09-16. Quote the command, not memory.

| Fact | Value | How it was checked |
|---|---|---|
| ESLint 9 latest | `9.39.5` (ESLint 10.10.0 also exists; this plan pins 9) | `npm view eslint@9 version` |
| typescript-eslint latest | `8.70.0`; no v9 exists (`dist-tags`: latest 8.70.0, canary 8.70.1-alpha.21) | `npm view typescript-eslint dist-tags` |
| **typescript-eslint does not run on TypeScript 7** | Hard refusal at import time: `Error: typescript-eslint does not support TS 7.0.` It also declares `peerDependencies.typescript: ">=4.8.4 <6.1.0"`, which npm rejects outright. | Installed `eslint@9.39.5 typescript-eslint@8.70.0 typescript@7.0.2` in a throwaway project and ran `npx eslint src` |
| **The fix: TypeScript 6 at the workspace root only** | With `typescript@6.0.3` as a *root* devDependency and `typescript@7.0.2` kept in every package, `pnpm exec eslint` type-checks happily and `pnpm --filter <pkg> exec tsc --version` still prints `Version 7.0.2`. This is the side-by-side arrangement the TypeScript 7 release notes describe. | Built a two-package pnpm workspace with exactly that split and ran both commands |
| TypeScript 6 latest | `6.0.3` | `npm view typescript@6 version` |
| eslint-plugin-import-x | `4.17.1`. Needs `eslint-import-resolver-typescript` ≥ 4 or every `import-x/*` rule reports `Resolve error: typescript with invalid interface loaded as resolver`. | Reproduced the resolve error, then installed `eslint-import-resolver-typescript@4.4.5` and it cleared |
| eslint-import-resolver-typescript | `4.4.5` | `npm view eslint-import-resolver-typescript version` |
| eslint-plugin-import-x pulls a native binary | `unrs-resolver@1.12.2` has a build script, so pnpm refuses to build it until it is listed under `allowBuilds:` in `pnpm-workspace.yaml` | `pnpm add -D eslint-plugin-import-x` printed `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: unrs-resolver@1.12.2` |
| eslint-plugin-unused-imports | `4.4.1`, peer `eslint ^8 \|\| ^9 \|\| ^10` | `npm view eslint-plugin-unused-imports@4.4.1 peerDependencies` |
| eslint-config-prettier | `10.1.8` | `npm view eslint-config-prettier version` |
| globals | `17.12.0` | `npm view globals version` |
| Prettier | `3.9.7` | `npm view prettier version` |
| dependency-cruiser | `16.10.4`, engines `^18.17 \|\| >=20`. **Pinned to 16 on purpose**: 17.4.3 requires `^20.12 \|\| ^22 \|\| >=24` and 18.3.1 requires `^22 \|\| ^24 \|\| >=26`, which excludes Node 23 and Node 25. Contributors on Node 25 exist. | `npm view dependency-cruiser@{16,17,18} engines`; `node --version` on this machine prints `v25.9.0` |
| dependency-cruiser needs a glob, not a directory | `depcruise harness/core-tools/src` cruises **0 modules**. `depcruise 'harness/core-tools/src/**/*.ts'` cruises them all. Also set `options.enhancedResolveOptions.extensions` explicitly. | Ran both forms against a scratch package |
| dependency-cruiser severities map to exit codes | `severity: 'warn'` prints the violation and exits **0**; `severity: 'error'` exits **1**. That is what makes the warn-then-error migration in Task 11 work. | Ran a deliberately violating fixture at each severity and echoed `$?` |
| Graphviz is **not** installed here | `which dot` finds nothing. `pnpm arch:graph` needs it; Task 11 installs it. | `which dot` |
| The three project rules work as ESLint selectors | `no-console` off for `shared/log.ts`; `MemberExpression[object.name="process"][property.name="env"]` flags `process.env.X` in `domain/` and not in `app/`, and leaves `process.argv` alone; `ThrowStatement > NewExpression[callee.name="Error"]` flags `throw new Error(...)` in `tools/` and leaves `const e = new Error(...)` alone | Built the exact config in a scratch workspace against fixtures in `shared/`, `domain/`, `tools/` and `app/` |
| **Two flat-config blocks that both set `no-restricted-syntax` do not merge** | The later block *replaces* the rule for any file both blocks match. The tools-layer block therefore has to repeat the `process.env` selector alongside the `throw new Error` one, or `tools/` silently loses the environment rule. | Observed exactly this failure in the scratch workspace, then fixed it by listing both selectors |
| Prettier reformats 68 of 115 TypeScript files at `printWidth: 120` | Line lengths today: p50 35, p90 86, p99 127, max 268; 251 lines over 120 columns, 49 over 140. 120 is the smallest width that does not rewrap the whole codebase. | `prettier --list-different` over `harness packs evals scripts`; `awk` over every source line |
| `docker compose --env-file .env.example ... config` **does not work** | `error while interpolating services.litellm.environment.LITELLM_MASTER_KEY: required variable LITELLM_MASTER_KEY is missing a value`. Filling in placeholders makes it succeed, but then the `hermes` service's `env_file: ../../.env` injects **the developer's real `.env`** into the output: the render printed a live `GEMINI_API_KEY` and a live `HARNESS_ENCRYPTION_KEY`. It also prints absolute host paths. None of that can be committed. | Ran the command as written, then again with a placeholder env file, and grepped the output |
| **The fix: `--no-interpolate --no-path-resolution`** | `docker compose -f harness/compose/docker-compose.yml --profile demo --profile build-only config --no-interpolate --no-path-resolution` renders all six services in 294 deterministic lines, keeps `${VAR:-default}` and `${VAR:?msg}` literal, keeps `env_file` as an unread reference, needs no `.env` at all and contains no secret and no host path. | Ran it and grepped for the machine's real API key: zero hits |
| The MCP surface is snapshot-able in-process | `connectInProcess(() => createCoreToolsServer(deps))` then `client.listTools()` returns all 22 tools with `inputSchema` and `outputSchema` as resolved JSON Schema; serialised and sorted it is 2247 lines of JSON. No database connection is needed to list tools. | Ran a scratch script against this checkout |
| Every environment variable the code reads is already in `.env.example` | 26 names, from `process.env.X` plus the string-literal first argument of `numberFromEnv`/`booleanFromEnv`/`required`/`requiredFrom`. Zero missing. | `grep` for both forms, then checked each against `.env.example` |
| Which core-tools subpath exports other packages actually import | `./storage` (approvals `app/main.ts`, `sinks.ts`), `./effects` (approvals `sinks.ts`, `runner.ts`, `sinks.test.ts`), `./fake-gateway` (evals `judge.test.ts`, `pipeline.test.ts`, `run.test.ts`), `./in-process` (evals `pipeline.ts`). **`./testing`, `./models` and `./reconcile` are imported by nobody outside core-tools.** | `grep -rn "@harness/core-tools" harness/approvals/src evals/src harness/gateway` |
| The gateway config appears in 11 test fixtures across 5 files | `harness/core-tools/src/models.test.ts`, `.../tools/documents.test.ts`, `evals/src/{run,judge,pipeline}.test.ts` | `grep -rn "gateway: {" --include='*.test.ts'` |
| The real render function is `renderLiteLlmConfig` | Lowercase `Llm`, not `LiteLLM`. The codebase survey misspells it. | `harness/gateway/render-config.ts:56` |

## Decisions where the spec and "no behaviour change" pull apart

Spec section 4 asks for several dependencies to be reshaped into interfaces carried on `ToolDeps`. Global Constraints forbid rewriting test fixtures. Where those collide, this plan takes the following line, and Task 1's ARCHITECTURE.md records each one.

1. **Interfaces are declared and adapted; `ToolDeps` keeps carrying configuration.** `ModelGateway`, `Storage` and `VerifyRegistry` are all declared in their domain's `types.ts`, each with a named production adapter (`httpGateway`, `fileStorage`, `nppesRegistry`) and a fake beside it. But `ToolDeps.gateway` stays `GatewayConfig`, `ToolDeps.storageDir` stays `string` and `ToolDeps.verify` stays `VerifyConfig`, and the adapters are constructed inside the domain from those values. **Why:** swapping `ToolDeps.gateway` for an object would rewrite 11 gateway fixtures in 5 test files and change `RunOptions.gateway`, which is `@harness/evals`'s public API — both forbidden here. The seam the spec wants exists and is testable; only the wiring is deferred. Revisit when a non-HTTP model provider or a non-filesystem store actually arrives.

2. **`redaction/patterns.ts` ships two pattern sets, not one.** `tools/harness.ts:RESTRICTED_TEXT_PATTERNS` and `approvals/render.ts:RESTRICTED_PATTERNS` are byte-identical to each other — three strict-`\d` shape regexes with no validity gate. `documents/redact.ts:PATTERNS` are different: OCR-tolerant, and gated on SSA allocation rules and the DEA check digit. Collapsing them into one list would change behaviour in both directions (a shape-only `AB1234567` stops tripping the Slack guard; an OCR-noisy `O12-34-5678` starts tripping it). So the module exports `containsRestrictedPattern` over the strict shape set — killing the byte-identical duplicate, which is the stated goal — and `redactPages`/`assertRedacted` keep the gated set. One module, one test file, two documented tiers.

3. **`@harness/db` gets its own ten-line `shared/log.ts`.** It has three `console.*` sites and sits below `core-tools` in the package graph, so it cannot import the shared logger without a cycle. Spec section 8 declined a `@harness/shared` package and said to revisit "if a package that does not depend on core-tools ever needs the helpers"; this is that case, and the answer for now is a local copy of one tiny module rather than a new package. ARCHITECTURE.md flags it for revisit.

4. **The Compose surface is snapshotted with `--no-interpolate --no-path-resolution`,** not with `--env-file .env.example`. See the two "Facts verified" rows above: the `--env-file` form cannot run without placeholder secrets, and once it runs it copies the developer's real `.env` into the output through the `hermes` service's `env_file`. `.env.example` is left exactly as it is.

5. **`packs/healthcare` cannot import the shared helpers, and neither can `scripts`.** Spec section 3 says approvals, evals *and the pack* import them from core-tools' public API. The pack is a **dependency** of core-tools — `documents/manifest.ts` reads `@harness/pack-healthcare/schema` — so importing back is a cycle. The pack therefore keeps its own bounded `execFile` call in `synthetic/pdf.ts` and its own two-line JSONL write in `synthetic/generate.ts`. Same argument as `@harness/db`'s logger, same entry in ARCHITECTURE.md's "Three deliberate duplications", same trigger for revisiting the declined `@harness/shared` package. This is the one spec item this plan does not fully deliver.

6. **`./testing` survives Task 11 even though no other package imports it.** Spec section 2 names it as the subpath every package exports its fakes under, and each package README documents it. Task 11 removes `./models` and `./reconcile`, which nothing names at all.

---
## File structure

Every file that moves, across all seven packages, old path → new path. A row that says **split** is a file whose contents are divided across several new files; the task that owns it lists exactly which export lands where. Paths are relative to the repository root.

### New at the repository root (Task 1)

| New file | Responsibility |
|---|---|
| `eslint.config.js` | ESLint 9 flat config: typescript-eslint type-aware, import-x, unused-imports, and the three project rules scoped by path |
| `.prettierrc` | `printWidth: 120`, single quotes, semicolons, `trailingComma: all` |
| `.prettierignore` | build output, generated PDFs, drizzle snapshots, the committed surface snapshots |
| `.dependency-cruiser.cjs` | the layer rules, all at `severity: 'warn'` until Task 11 |
| `.editorconfig` | 2-space, LF, UTF-8, final newline |
| `.vscode/extensions.json` | recommends `dbaeumer.vscode-eslint` and `esbenp.prettier-vscode` |
| `ARCHITECTURE.md` | the layer table, package map, the path of one tool call, the three invariants, the three error types, where each cross-cutting concern lives |
| `CONTRIBUTING.md` | adding a tool / domain / pack / client / migration / test; commit conventions; local stack commands |
| `docs/architecture/tool-surface.json` | committed snapshot: 22 tool names with their input and output JSON schemas |
| `docs/architecture/compose-surface.yaml` | committed snapshot: the rendered Compose config |
| `harness/core-tools/src/surface.test.ts` | the test that checks all three surfaces (moves to `src/app/` in Task 7) |
| `harness/core-tools/src/record-surface.ts` | regenerates both snapshots (moves to `src/app/` in Task 7) |

### `@harness/db` (Task 2)

| Old | New |
|---|---|
| `harness/db/src/crypto.ts` | `harness/db/src/shared/crypto.ts` |
| `harness/db/src/crypto.test.ts` | `harness/db/src/shared/crypto.test.ts` |
| — | `harness/db/src/shared/log.ts`, `harness/db/src/shared/log.test.ts` (new) |
| `harness/db/src/schema.ts` | `harness/db/src/domain/schema.ts` |
| `harness/db/src/schema.test.ts` | `harness/db/src/domain/schema.test.ts` |
| `harness/db/src/client.ts` | `harness/db/src/domain/client.ts` |
| `harness/db/src/migrate.ts` | **split** → `harness/db/src/domain/migrate.ts` (`runMigrations`) + `harness/db/src/app/migrate.ts` (the CLI) |
| `harness/db/src/index.ts` | unchanged path, import paths rewritten |
| `harness/db/src/testing.ts` | unchanged path, gains `useTestDb` |
| `harness/db/src/test-global-setup.ts` | unchanged path, import paths rewritten |
| — | `harness/db/README.md` (new) |

### `@harness/gateway` (Task 3)

| Old | New |
|---|---|
| `harness/gateway/routing.schema.ts` | **split** → `harness/gateway/src/domain/routing/types.ts` (`ROUTES`, `Route`, `RouteSpec`, `RoutingFile`) + `harness/gateway/src/domain/routing/parse.ts` (`parseRouting`) |
| `harness/gateway/render-config.ts` | **split** → `harness/gateway/src/domain/routing/render.ts` (`apiKeyEnvFor`, `renderLiteLlmConfig`) + `harness/gateway/src/app/render-config.ts` (`renderClientConfig` + the CLI) |
| `harness/gateway/render-config.test.ts` | **split** → `harness/gateway/src/domain/routing/parse.test.ts` (`describe('routing.schema')`) + `harness/gateway/src/domain/routing/render.test.ts` (`describe('apiKeyEnvFor')`, `describe('renderLiteLlmConfig')`) |
| — | `harness/gateway/src/index.ts` (new) |
| `harness/gateway/litellm.config.yaml` | unchanged (generated artefact, still written to the package root) |
| `harness/gateway/README.md` | unchanged path, rewritten |

### `@harness/core-tools` — shared layer (Task 4)

| Old | New |
|---|---|
| `harness/core-tools/src/server.ts:40-66` (`numberFromEnv`, `booleanFromEnv`) | `harness/core-tools/src/shared/env.ts` (joined by `requiredEnv`, `optionalEnv`) |
| `harness/core-tools/src/server.test.ts` | `harness/core-tools/src/shared/env.test.ts` (whole file; assertions untouched) |
| `harness/core-tools/src/registry.ts:11-16` (`ToolError`) and `src/models.ts:183-188` (`ModelOutputError`) | `harness/core-tools/src/shared/errors.ts` (joined by `ConfigError`, `describeError`) |
| — | `harness/core-tools/src/shared/errors.test.ts` (new) |
| `harness/core-tools/src/documents/storage.ts:25-40` (`realOrNearestAncestor`) | `harness/core-tools/src/shared/paths.ts` (joined by `assertInsideRoot`) |
| — | `harness/core-tools/src/shared/paths.test.ts` (new) |
| — | `harness/core-tools/src/shared/log.ts`, `shared/log.test.ts` (new) |
| — | `harness/core-tools/src/shared/subprocess.ts`, `shared/subprocess.test.ts` (new) |
| — | `harness/core-tools/src/shared/jsonl.ts`, `shared/jsonl.test.ts` (new) |
| `harness/core-tools/src/forms/roster.ts:42-69` (`csvCell` + its three constants) | `harness/core-tools/src/shared/csv.ts` |
| `harness/core-tools/src/forms/roster.test.ts` `describe('csvCell')` | `harness/core-tools/src/shared/csv.test.ts` |
| `harness/core-tools/src/tools/harness.ts:62-66` and `harness/approvals/src/render.ts:18-26` (the duplicated shape regexes) | `harness/core-tools/src/shared/redaction/patterns.ts` (`containsRestrictedPattern`) |
| `harness/core-tools/src/documents/redact.ts` (pattern machinery, `isValidDea`) | `harness/core-tools/src/shared/redaction/patterns.ts` |
| `harness/core-tools/src/documents/redact.ts` (`redactPages`, `assertRedacted`, `fieldNameFor`) | `harness/core-tools/src/shared/redaction/text.ts` |
| `harness/core-tools/src/documents/redact.test.ts` | **split** → `shared/redaction/patterns.test.ts` (`describe('isValidDea')`) + `shared/redaction/text.test.ts` (the other three describes) |
| `harness/core-tools/src/tools/providers.ts:33-65` (`RESTRICTED_NAME_KEYS`, `RESTRICTED_NAME_SUFFIXES`, `isRestrictedName`, `MASKED`) | `harness/core-tools/src/shared/redaction/names.ts` |
| `harness/core-tools/src/tools/providers.test.ts` `describe('isRestrictedName')` | `harness/core-tools/src/shared/redaction/names.test.ts` |

### `@harness/core-tools` — tooling kernel (Task 5)

| Old | New |
|---|---|
| `harness/core-tools/src/registry.ts` | **split** → `src/domain/tooling/types.ts` (`SessionContext`, `ToolDeps`, `ToolDef`, `AnyToolDef`, `AuditBase`, `DEFAULT_CONFIDENCE_THRESHOLD`), `src/domain/tooling/registry.ts` (`defineTool`, `registerTools`), `src/domain/tooling/execution.ts` (`runAuto`, `runForApproval`, `runBlocked`, `handleUnexpectedError`, the envelope helpers), `src/domain/tooling/context.ts` (`auditBaseFor`, `preservingContext`, `restoreContext`, `withCurrentTool`), `src/domain/approvals/repository.ts` (`createOrReuseApproval`) |
| `harness/core-tools/src/registry.test.ts` | `harness/core-tools/src/domain/tooling/registry.test.ts` |
| `harness/core-tools/src/policy.ts` | `harness/core-tools/src/domain/tooling/policy.ts` |
| `harness/core-tools/src/policy.test.ts` | `harness/core-tools/src/domain/tooling/policy.test.ts` |
| `harness/core-tools/src/audit.ts` | `harness/core-tools/src/domain/tooling/audit.ts` |
| `harness/core-tools/src/audit.test.ts` | `harness/core-tools/src/domain/tooling/audit.test.ts` |
| `harness/core-tools/src/reconcile.ts` | `harness/core-tools/src/domain/tooling/reconcile.ts` |
| `harness/core-tools/src/reconcile.test.ts` | `harness/core-tools/src/domain/tooling/reconcile.test.ts` |
| `harness/core-tools/src/in-process.ts` | `harness/core-tools/src/domain/tooling/in-process.ts` |

### `@harness/core-tools` — storage, documents, models (Task 6)

| Old | New |
|---|---|
| `harness/core-tools/src/storage.ts` + `src/documents/storage.ts` | **split** → `src/domain/storage/types.ts` (`Storage`, `WriteFileInput`, `WrittenFile`), `src/domain/storage/layout.ts` (`storageRoot`, `outRoot`, `contentTag`, `documentTextPath`, `toStorageRelative`), `src/domain/storage/file-store.ts` (`resolveStoragePath`, `resolveOutFile`, `readDocumentBytes`, `sha256File`, `writeOutFile`, `fileStorage`) |
| `harness/core-tools/src/storage.test.ts` | **split** → `src/domain/storage/layout.test.ts` + `src/domain/storage/file-store.test.ts` |
| `harness/core-tools/src/documents/storage.test.ts` | `src/domain/storage/file-store.test.ts` (appended; `describe('documentTextPath')` goes to `layout.test.ts`) |
| `harness/core-tools/src/documents/extract.ts` | **split** → `src/domain/documents/types.ts`, `src/domain/documents/manifest.ts`, `src/domain/documents/schema.ts`, `src/domain/documents/prompts.ts`, `src/domain/documents/parse.ts` |
| `harness/core-tools/src/documents/extract.test.ts` | **split** → `src/domain/documents/manifest.test.ts`, `schema.test.ts`, `prompts.test.ts`, `parse.test.ts` |
| `harness/core-tools/src/documents/text.ts` | `harness/core-tools/src/domain/documents/text.ts` |
| `harness/core-tools/src/documents/text.test.ts` | `harness/core-tools/src/domain/documents/text.test.ts` |
| `harness/core-tools/src/models.ts` | **split** → `src/domain/models/types.ts` (`ModelGateway`, `GatewayConfig`, `ModelMessage`, `JsonSchemaSpec`, `ModelCallOptions`, `ModelCallResult`, `Route`, `ROUTES`) + `src/domain/models/gateway.ts` (`gatewayFromEnv`, `httpGateway`, `callModel`, `callModelJson`) |
| `harness/core-tools/src/models.test.ts` | `harness/core-tools/src/domain/models/gateway.test.ts` |
| `harness/core-tools/src/fake-gateway.ts` | `harness/core-tools/src/domain/models/fake.ts` |

### `@harness/core-tools` — remaining domains, tools, index, app (Task 7)

| Old | New |
|---|---|
| `harness/core-tools/src/tools/providers.ts` | **split** → `src/domain/providers/types.ts` (`FieldInput`, `CredentialInput`, `UpsertProviderInput`, `UpsertProviderResult`), `src/domain/providers/mask.ts` (`maskField`, `maskCredential`, `fieldValueColumns`), `src/domain/providers/repository.ts` (`requireProvider`, `findOrCreateProvider`, `upsertField`, `upsertCredential`, `upsertProviderRecord`), and a thinned `src/tools/providers.ts` |
| `harness/core-tools/src/tools/providers.test.ts` | `harness/core-tools/src/tools/providers.test.ts` (path unchanged; import paths rewritten) |
| `harness/core-tools/src/deadlines/compute.ts` | `harness/core-tools/src/domain/deadlines/compute.ts` |
| `harness/core-tools/src/deadlines/compute.test.ts` | `harness/core-tools/src/domain/deadlines/compute.test.ts` |
| `harness/core-tools/src/forms/templates.ts` | **split** → `src/domain/forms/types.ts` (the zod schemas and inferred types) + `src/domain/forms/templates.ts` (`defaultFormsDir`, `loadManifest`, `getTemplate`, `mappingLabel`) |
| `harness/core-tools/src/forms/templates.test.ts` | `harness/core-tools/src/domain/forms/templates.test.ts` |
| `harness/core-tools/src/forms/fill.ts` | `harness/core-tools/src/domain/forms/fill.ts` (`ProviderData`/`ResolvedMapping` move to `forms/types.ts`) |
| `harness/core-tools/src/forms/fill.test.ts` | `harness/core-tools/src/domain/forms/fill.test.ts` |
| `harness/core-tools/src/forms/roster.ts` | `harness/core-tools/src/domain/forms/roster.ts` (`RosterRow`/`ROSTER_COLUMNS` move to `forms/types.ts`) |
| `harness/core-tools/src/forms/roster.test.ts` | `harness/core-tools/src/domain/forms/roster.test.ts` |
| `harness/core-tools/src/tools/forms.ts:22-44` (`loadProviderData`) and `:126-130` (`fieldValue`) | `harness/core-tools/src/domain/forms/provider-data.ts` (joined by `buildRoster`) |
| `harness/core-tools/src/tools/forms.ts:123-124, 211-234` (`MAX_RELEASE_BYTES`, the `forms_release` body) | `harness/core-tools/src/domain/forms/release.ts` |
| `harness/core-tools/src/effects.ts` | **split** → `src/domain/effects/types.ts` (`SinkHandler`, `SinkRegistry`, `StageEffectInput`, `DispatchOptions`, `DispatchResult`) + `src/domain/effects/outbox.ts` (`stageEffect`, `dispatchStagedEffects`) |
| `harness/core-tools/src/effects.test.ts` | `harness/core-tools/src/domain/effects/outbox.test.ts` |
| `harness/core-tools/src/tools/verify.ts` | **split** → `src/domain/verify/types.ts` (`VerifyConfig`, `VerifyRegistry`, `NppesRecord`), `src/domain/verify/names.ts` (`namesMatch`), `src/domain/verify/nppes.ts` (`NPPES_DEFAULT_BASE_URL`, `nppesRegistry`), and a thinned `src/tools/verify.ts` |
| `harness/core-tools/src/tools/verify.test.ts` | **split** → `src/domain/verify/names.test.ts` (`describe('namesMatch')`) + `src/tools/verify.test.ts` (the two tool describes) |
| `harness/core-tools/src/tools/approvals.ts` | **split** → `src/domain/approvals/execute.ts` (`executeApproval`) + a thinned `src/tools/approvals.ts` |
| `harness/core-tools/src/tools/approvals.test.ts` | path unchanged; import paths rewritten |
| `harness/core-tools/src/tools/documents.ts` | **split** → `src/domain/documents/pipeline.ts` (`requireDocument`, `readForModel`, `assertPromptRedacted`, `viewOf`, `ingestDocument`, `classifyDocument`, `extractDocument`) + a thinned `src/tools/documents.ts` |
| `harness/core-tools/src/tools/documents.test.ts` | path unchanged; import paths rewritten |
| `harness/core-tools/src/tools/{audit,deadlines,forms,harness}.ts` | paths unchanged; import paths rewritten |
| `harness/core-tools/src/server.ts` | **split** → `src/app/server.ts` (`ALL_TOOLS`, `createCoreToolsServer`, `buildDepsFromEnv`) + `src/index.ts` (the public API barrel) |
| `harness/core-tools/src/main.ts` | `harness/core-tools/src/app/main.ts` |
| `harness/core-tools/src/main.test.ts` | `harness/core-tools/src/app/main.test.ts` |
| `harness/core-tools/src/skills-frontmatter.test.ts` | `harness/core-tools/src/app/skills-frontmatter.test.ts` |
| `harness/core-tools/src/surface.test.ts` | `harness/core-tools/src/app/surface.test.ts` |
| `harness/core-tools/src/record-surface.ts` | `harness/core-tools/src/app/record-surface.ts` |
| `harness/core-tools/src/testing.ts` | path unchanged; becomes a barrel over the domain fakes |
| `harness/core-tools/src/test-global-setup.ts` | path unchanged |

### `@harness/approvals` (Task 8)

| Old | New |
|---|---|
| `harness/approvals/src/slack.ts` | **split** → `src/domain/slack/types.ts` (`SlackApi` and its five argument interfaces, `SlackPostResult`) + `src/domain/slack/web-client.ts` (`webClientApi`) |
| `harness/approvals/src/testing.ts` `FakeSlack` | `harness/approvals/src/domain/slack/fake.ts` |
| `harness/approvals/src/testing.ts` `FakeCoreToolsClient` | `harness/approvals/src/domain/execute/fake.ts` |
| `harness/approvals/src/testing.ts` `useTestDb` | **deleted**; `src/testing.ts` re-exports `useTestDb` from `@harness/db/testing` |
| `harness/approvals/src/app.ts` | `harness/approvals/src/domain/slack/handlers.ts` |
| `harness/approvals/src/app.test.ts` | `harness/approvals/src/domain/slack/handlers.test.ts` |
| `harness/approvals/src/render.ts` | **split** → `src/domain/render/types.ts` (`ApprovalRow`, `EditModalMetadata`, the six Slack ids) + `src/domain/render/blocks.ts` (`payloadPreview`, `approvalBlocks`, `approvalFallbackText`, `decidedBlocks`) + `src/domain/render/modal.ts` (`editModalView`, `parseEditModalMetadata`) |
| `harness/approvals/src/render.ts:18-26` (`RESTRICTED_PATTERNS`, `containsRestrictedPattern`) | **deleted**; imported from `@harness/core-tools` |
| `harness/approvals/src/render.test.ts` | **split** → `src/domain/render/blocks.test.ts` (`containsRestrictedPattern`, `payloadPreview`, `approvalBlocks`, `decidedBlocks`) + `src/domain/render/modal.test.ts` (`editModalView`, `parseEditModalMetadata`) |
| `harness/approvals/src/execute.ts` | **split** → `src/domain/execute/types.ts` (`CoreToolsClient`, `ExecuteOutcome`, `McpLauncher`) + `src/domain/execute/mcp-client.ts` (`createMcpCoreToolsClient`) |
| `harness/approvals/src/execute.test.ts` | `harness/approvals/src/domain/execute/mcp-client.test.ts` |
| `harness/approvals/src/poller.ts` | `harness/approvals/src/domain/poller.ts` |
| `harness/approvals/src/poller.test.ts` | `harness/approvals/src/domain/poller.test.ts` |
| `harness/approvals/src/decisions.ts` | `harness/approvals/src/domain/decisions.ts` |
| `harness/approvals/src/decisions.test.ts` | `harness/approvals/src/domain/decisions.test.ts` |
| `harness/approvals/src/sinks.ts` | `harness/approvals/src/domain/sinks.ts` |
| `harness/approvals/src/sinks.test.ts` | `harness/approvals/src/domain/sinks.test.ts` |
| `harness/approvals/src/health.ts` | `harness/approvals/src/domain/health.ts` |
| `harness/approvals/src/health.test.ts` | `harness/approvals/src/domain/health.test.ts` |
| `harness/approvals/src/runner.ts` | `harness/approvals/src/domain/runner.ts` |
| `harness/approvals/src/runner.test.ts` | `harness/approvals/src/domain/runner.test.ts` |
| `harness/approvals/src/child-env.ts` | `harness/approvals/src/app/child-env.ts` (`requiredFrom` deleted; `requiredEnv` imported from `@harness/core-tools`) |
| `harness/approvals/src/child-env.test.ts` | `harness/approvals/src/app/child-env.test.ts` |
| `harness/approvals/src/main.ts` | `harness/approvals/src/app/main.ts` (its private `numberFromEnv` deleted) |
| `harness/approvals/src/index.ts` | path unchanged; re-export paths rewritten |
| `harness/approvals/src/testing.ts` | path unchanged; becomes a barrel |
| — | `harness/approvals/README.md` (new) |

### `@harness/evals` (Task 9)

| Old | New |
|---|---|
| `evals/src/cases.ts` | `evals/src/domain/cases.ts` (its private `readJsonlRows` deleted; `readJsonl` imported from `@harness/core-tools`) |
| `evals/src/cases.test.ts` | `evals/src/domain/cases.test.ts` |
| `evals/src/pipeline.ts` | `evals/src/domain/pipeline.ts` |
| `evals/src/pipeline.test.ts` | `evals/src/domain/pipeline.test.ts` |
| `evals/src/score.ts` | `evals/src/domain/score.ts` |
| `evals/src/score.test.ts` | `evals/src/domain/score.test.ts` |
| `evals/src/judge.ts` | **split** → `src/domain/judge/types.ts` (`FREE_TEXT_FIELDS`, `JudgeItem`, `JudgeVerdict`, `JudgeResult`) + `src/domain/judge/prompts.ts` (`JUDGE_SCHEMA`, `JUDGE_SYSTEM_PROMPT`, `JudgeReply`) + `src/domain/judge/verdict.ts` (`judgeFreeText`) |
| `evals/src/judge.test.ts` | **split** → `src/domain/judge/types.test.ts` (`describe('FREE_TEXT_FIELDS')`) + `src/domain/judge/verdict.test.ts` (`describe('judgeFreeText')`) |
| `evals/src/report.ts` | **split** → `src/domain/report/types.ts` (`SplitReport`, `Report`, `Delta`, `BaselineComparison`, `BuildReportInput`, `METRIC_KEYS`) + `src/domain/report/build.ts` (`buildReport`, `compareToBaseline`, `DEFAULT_TOLERANCE`) + `src/domain/report/render.ts` (`renderMarkdown`) |
| `evals/src/report.test.ts` | **split** → `src/domain/report/build.test.ts` (three describes) + `src/domain/report/render.test.ts` (`describe('renderMarkdown')`) |
| `evals/src/run.ts` | **split** → `src/domain/orchestrate.ts` (`RunOptions`, `selectCases`, `injectionCasesFor`, `runEvals`) + `src/app/cli.ts` (`parseLimitFlag`, `parseUpdateBaselineFlag`, the entrypoint) |
| `evals/src/run.test.ts` | **split** → `src/domain/orchestrate.test.ts` (`runEvals`, `selectCases`, `injectionCasesFor`) + `src/app/cli.test.ts` (`parseUpdateBaselineFlag`, `parseLimitFlag`, `CLI`) |
| — | `evals/src/index.ts` (new public API), `evals/README.md` (new) |

### `packs/healthcare` and `scripts` (Task 10)

| Old | New |
|---|---|
| `packs/healthcare/synthetic/generate.ts` | **split** → `synthetic/types.ts` (`SyntheticKind`, `SyntheticProvider`, `GroundTruthCredential`, `GroundTruthDocument`, `GroundTruth`, `GenerateOptions`, `PageSpec`, `DocumentPlan`), `synthetic/rng.ts` (`mulberry32`, `pick`, `digits`, `luhnNpi`, `deaNumber`, `ssn`), `synthetic/fixtures.ts` (the name/state/school/carrier tables, `STATE_BOARD`, `isoDate`, `makeProvider`), `synthetic/pdf.ts` (`writeTextPdf`, `writeScanPdf`), `synthetic/plan.ts` (`planFor`, `injectionPlan`), `synthetic/generate.ts` (`assertSafeToClear`, `generate`), `synthetic/cli.ts` (the entrypoint) |
| `packs/healthcare/synthetic/generate.test.ts` | **split** → `synthetic/rng.test.ts` (`describe('identifier generators')`) + `synthetic/generate.test.ts` (`describe('generate')`, `describe('clearing the output directory')`) |
| `packs/healthcare/forms/generate-templates.ts` | `packs/healthcare/forms/generate-templates.ts` (path unchanged; it is already a single-purpose CLI) |
| `scripts/new-client.ts` | **split** → `scripts/src/domain/scaffold.ts` (`NewClientOptions`, `NewClientResult`, `titleCase`, `newClient`) + `scripts/src/app/cli.ts` (the entrypoint) |
| `scripts/new-client.test.ts` | `scripts/src/domain/scaffold.test.ts` |
| — | `packs/healthcare/README.md` is rewritten; `scripts/README.md` is new |

## Task dependency

The tasks are strictly sequential and each one must land before the next starts.

- **Task 1** installs the tooling and records the surface snapshot from unmoved code. Every later task depends on it, because every later task's gate is "the snapshot test still passes".
- **Tasks 2 and 3** (`db`, `gateway`) are the two packages nothing else in this plan reshapes. They come first because `db` gains the single `useTestDb` that Tasks 4 and 8 delete their copies of, and because `gateway`'s `./routing` subpath is what `core-tools`'s models domain imports in Task 6.
- **Task 4** must precede 5, 6 and 7: those tasks' files import `shared/errors.ts`, `shared/paths.ts`, `shared/log.ts` and `shared/redaction/*`.
- **Task 5** must precede 6 and 7: every domain module imports `ToolDeps` from `domain/tooling/types.ts`.
- **Task 6** must precede 7: `tools/documents.ts` and `tools/forms.ts` import the storage, documents and models domains.
- **Task 7** must precede 8, 9 and 10: those packages import the new `@harness/core-tools` public API for `createLogger`, `requiredEnv`, `numberFromEnv`, `containsRestrictedPattern`, `readJsonl` and `runBounded`.
- **Tasks 8, 9 and 10** touch three disjoint packages and could in principle run in parallel, but each ends with a full-suite run, so run them in order.
- **Task 11** is last by definition: it flips every cruiser rule to error, which only passes once every package has moved.

---

---

## Tasks
### Task 1: Tooling, the public-surface snapshot, and the first two documents

**Files:**
- Create: `eslint.config.js`, `.prettierrc`, `.prettierignore`, `.editorconfig`, `.vscode/extensions.json`, `.dependency-cruiser.cjs`
- Create: `harness/core-tools/src/record-surface.ts`, `harness/core-tools/src/surface.test.ts`
- Create: `docs/architecture/tool-surface.json`, `docs/architecture/compose-surface.yaml` (both generated, both committed)
- Create: `ARCHITECTURE.md`, `CONTRIBUTING.md`
- Modify: `package.json` (root — dev dependencies and scripts), `pnpm-workspace.yaml` (one `allowBuilds` entry)
- Modify: every `*.ts` file Prettier and `eslint --fix` rewrite (68 of 115 by measurement), in one dedicated commit

**Interfaces:**
- Consumes: `createCoreToolsServer(deps: ToolDeps): McpServer` from `harness/core-tools/src/server.ts`; `connectInProcess(factory: () => McpServer): Promise<{ client: Client; close: () => Promise<void> }>` from `harness/core-tools/src/in-process.ts`; `DEFAULT_POLICY: Policy` from `harness/core-tools/src/policy.ts`; `DEFAULT_CONFIDENCE_THRESHOLD: number` and `type ToolDeps` from `harness/core-tools/src/registry.ts`; `NPPES_DEFAULT_BASE_URL: string` from `harness/core-tools/src/tools/verify.ts`.
- Produces, from `harness/core-tools/src/record-surface.ts` (Task 7 moves this file to `src/app/record-surface.ts` and nothing else about it changes):
  - `interface ToolSurfaceEntry { name: string; inputSchema: unknown; outputSchema: unknown }`
  - `function surfaceDeps(): ToolDeps`
  - `function readToolSurface(): Promise<ToolSurfaceEntry[]>`
  - `function readComposeSurface(repoRoot: string): Promise<string>`
  - `function readEnvNames(repoRoot: string): Promise<string[]>`
  - `function envNamesFromExample(file: string): Promise<string[]>`
  - `const ENV_READING_HELPERS: readonly string[]`
  - `const ARCHITECTURE_DIR = 'docs/architecture'`
- Produces, for every later task: the root scripts `pnpm lint`, `pnpm lint:fix`, `pnpm format`, `pnpm format:check`, `pnpm arch`, `pnpm arch:graph`, `pnpm surface:record`, and a `pnpm test` that runs lint first.

---

- [ ] **Step 1: Allow the native resolver build, then install the tooling**

`eslint-plugin-import-x` depends on `unrs-resolver`, which has a postinstall build step. pnpm refuses to run it unless the package is listed, so edit `pnpm-workspace.yaml` **first** — otherwise the install ends with `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: unrs-resolver@1.12.2` and every `import-x/*` rule reports a resolve error.

`pnpm-workspace.yaml` becomes:

```yaml
packages:
  - 'harness/*'
  - 'packs/*'
  - 'evals'
  - 'scripts'
allowBuilds:
  esbuild: true
  unrs-resolver: true
```

Then, from the repository root:

```bash
pnpm add -D -w \
  eslint@9.39.5 \
  @eslint/js@9.39.5 \
  typescript-eslint@8.70.0 \
  typescript@6.0.3 \
  eslint-plugin-import-x@4.17.1 \
  eslint-import-resolver-typescript@4.4.5 \
  eslint-plugin-unused-imports@4.4.1 \
  eslint-config-prettier@10.1.8 \
  globals@17.12.0 \
  prettier@3.9.7 \
  dependency-cruiser@16.10.4
```

**`typescript@6.0.3` at the root is not a mistake and is not a downgrade.** typescript-eslint refuses to load against TypeScript 7 — it throws `Error: typescript-eslint does not support TS 7.0.` at import time, before it lints anything. The supported arrangement is to run it against the TypeScript 6 API side by side. Every package keeps `typescript: ^7.0.2` in its own `devDependencies`, so `pnpm -r typecheck` still compiles with 7; only ESLint, resolved from the root, sees 6. Verify both halves immediately:

```bash
pnpm --filter @harness/core-tools exec tsc --version   # expect: Version 7.0.2
node -e "console.log(require('typescript/package.json').version)"   # expect: 6.0.3
```

If typescript-eslint ever ships a release whose `peerDependencies.typescript` includes `>=7`, delete the root `typescript` entry and this note together. Until then, do **not** "fix" the duplication.

- [ ] **Step 2: Write `.prettierrc` and `.prettierignore`**

`printWidth: 120` is measured, not guessed: the codebase's 99th-percentile line is 127 characters and 251 lines exceed 120, so Prettier's default 80 would rewrap essentially every file and bury the restructure in noise.

`.prettierrc`:

```json
{
  "printWidth": 120,
  "singleQuote": true,
  "semi": true,
  "trailingComma": "all",
  "arrowParens": "always",
  "endOfLine": "lf"
}
```

`.prettierignore`:

```
node_modules
pnpm-lock.yaml
harness/db/drizzle
harness/gateway/litellm.config.yaml
packs/healthcare/forms/*.pdf
packs/healthcare/synthetic/out
evals/results
evals/baseline.json
docs/architecture/tool-surface.json
docs/architecture/compose-surface.yaml
storage
```

`harness/gateway/litellm.config.yaml`, `docs/architecture/*` and `evals/baseline.json` are generated files compared byte-for-byte by a test or by `git status`; reformatting them would make the generator and the checked-in copy disagree forever.

- [ ] **Step 3: Write `.editorconfig` and the VS Code recommendation file**

`.editorconfig`:

```
root = true

[*]
charset = utf-8
end_of_line = lf
indent_style = space
indent_size = 2
insert_final_newline = true
trim_trailing_whitespace = true

[*.md]
trim_trailing_whitespace = false
```

`.vscode/extensions.json`:

```json
{
  "recommendations": ["dbaeumer.vscode-eslint", "esbenp.prettier-vscode"]
}
```

- [ ] **Step 4: Write `eslint.config.js`**

Three things in this file are easy to get wrong, so they are called out in comments in the file itself:

1. **Two flat-config blocks that both set `no-restricted-syntax` do not merge.** The later block replaces the rule for every file both blocks match. The `tools/` block therefore repeats the `process.env` selector next to the `throw new Error` one.
2. **`import-x` needs `eslint-import-resolver-typescript` ≥ 4.** Without it every `import-x/*` rule reports `Resolve error: typescript with invalid interface loaded as resolver`, which looks like a config bug and is a missing package.
3. **Rules the codebase violates today land at `warn`, not `error`.** Each package task promotes its own source root to `error` by appending one string to `STRICT_LAYER_ROOTS`, and Task 11 promotes what is left. A rule set at `error` on day one would make Task 1 unlandable: `harness/core-tools/src/effects.ts:122` and 22 sites in `@harness/approvals` call `console.error`, `harness/core-tools/src/tools/forms.ts:216` throws a bare `Error` inside `tools/`, `process.env` is read in nine non-`app/` files, and `registry.ts` sits in three type-only import cycles.

```js
// ESLint 9 flat config for the whole workspace.
//
// Layering is enforced in two places and they do different jobs: dependency-cruiser
// (.dependency-cruiser.cjs) owns "which folder may import which folder", and this file
// owns "which construct may appear in which folder". Read ARCHITECTURE.md for the layers.
//
// Type-aware linting runs against TypeScript 6, installed at the workspace root only.
// typescript-eslint refuses to load against TypeScript 7 (`Error: typescript-eslint does
// not support TS 7.0.`), while every package still compiles with TypeScript 7 via its own
// `tsc --noEmit`. Do not "tidy up" the duplicate typescript dependency.
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import importX from 'eslint-plugin-import-x';
import unusedImports from 'eslint-plugin-unused-imports';
import prettierConfig from 'eslint-config-prettier';
import globals from 'globals';

/**
 * The environment is read in exactly two places: the shared `env.ts` helpers, which own the
 * parsing and the error wording, and `app/`, which is the composition root. A domain that
 * needs a value takes it as a parameter or reads it through an `env.ts` helper — calling the
 * helper is fine anywhere, because the ban is on the `process.env` syntax, not on the value.
 */
const NO_PROCESS_ENV = {
  selector: 'MemberExpression[object.name="process"][property.name="env"]',
  message: 'Read the environment through shared/env.ts (requiredEnv / optionalEnv / numberFromEnv / booleanFromEnv), or in app/.',
};

/**
 * Only a ToolError's message reaches the agent; a plain Error is masked by the kernel and
 * lands in the audit log. A tool that throws a bare Error is therefore telling the caller
 * nothing on purpose, which is almost never what the author meant.
 * `new Error(...)` as a value is untouched; only the `throw` form is restricted.
 */
const NO_BARE_THROW = {
  selector: 'ThrowStatement > NewExpression[callee.name="Error"]',
  message: 'tools/ throws ToolError for an expected failure. A bare Error is masked and the caller learns nothing.',
};

/**
 * Source roots whose layer rules are promoted from warn to error. Each package task appends its
 * own root here as it lands (e.g. 'harness/db/src'); Task 11 appends whatever is left. Adding a
 * root is the *only* edit a package task makes to this file.
 */
const STRICT_LAYER_ROOTS = [];

/** console.* belongs in the logger and in process entrypoints, nowhere else. */
const CONSOLE_IS_FINE = [
  '**/src/shared/log.ts',
  '**/src/app/**/*.ts',
  'packs/healthcare/synthetic/cli.ts',
  'packs/healthcare/forms/generate-templates.ts',
];

/**
 * @harness/db sits below the shared layer: importing core-tools from it would be a cycle, so
 * it reads its two variables (DATABASE_URL, HARNESS_ENCRYPTION_KEY) as default parameters
 * that every caller can override. Revisit if it ever grows a third.
 */
const PROCESS_ENV_IS_FINE = ['**/src/shared/env.ts', '**/src/app/**/*.ts', '**/*.test.ts', 'harness/db/src/**/*.ts'];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      'harness/db/drizzle/**',
      'packs/healthcare/synthetic/out/**',
      'evals/results/**',
      'storage/**',
      '**/*.d.ts',
    ],
  },

  js.configs.recommended,

  // Syntax-only rules: these are clean today and stay errors.
  ...tseslint.configs.recommended,

  // Type-aware rules. They run (projectService below switches them on) but land as warnings:
  // the existing code trips require-await and the no-unsafe-* family in places, and fixing
  // that is a separate piece of work from moving files. `pnpm lint` does not fail on warnings.
  ...tseslint.configs.recommendedTypeChecked.map((entry) =>
    entry.rules
      ? {
          ...entry,
          rules: Object.fromEntries(
            Object.entries(entry.rules).map(([rule, value]) => [
              rule,
              // Keep each rule's own options; change only the severity.
              Array.isArray(value) ? ['warn', ...value.slice(1)] : 'warn',
            ]),
          ),
        }
      : entry,
  ),

  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  {
    files: ['**/*.ts'],
    languageOptions: {
      globals: { ...globals.node },
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { 'unused-imports': unusedImports },
    rules: {
      // unused-imports owns unused bindings; the two built-ins must be off or they double-report.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      'unused-imports/no-unused-imports': 'error',
      'unused-imports/no-unused-vars': [
        'error',
        { vars: 'all', varsIgnorePattern: '^_', args: 'after-used', argsIgnorePattern: '^_', caughtErrors: 'none' },
      ],

      'import-x/order': [
        'error',
        {
          groups: ['builtin', 'external', 'internal', 'parent', 'sibling', 'index'],
          'newlines-between': 'never',
        },
      ],
      'import-x/no-default-export': 'error',
      // Warn until Task 11: registry.ts <-> tools/verify.ts, registry.ts <-> models.ts and
      // registry.ts <-> effects.ts are type-only cycles today, and Tasks 5-7 are what remove them.
      'import-x/no-cycle': ['warn', { maxDepth: Infinity }],

      'no-console': 'warn',
      'no-restricted-syntax': ['warn', NO_PROCESS_ENV],
    },
  },

  { files: CONSOLE_IS_FINE, rules: { 'no-console': 'off' } },
  { files: PROCESS_ENV_IS_FINE, rules: { 'no-restricted-syntax': 'off' } },

  // The tools layer carries both selectors. Listing only NO_BARE_THROW here would switch the
  // environment rule back off for every file under tools/ — see the comment at the top.
  {
    files: ['**/src/tools/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['warn', NO_PROCESS_ENV, NO_BARE_THROW] },
  },

  // Promoted roots. Empty until Task 2 appends the first one. The two exemption blocks are
  // repeated inside, because the promotion blocks above them would otherwise switch console
  // back on for app/ and the environment rule back on for tests.
  ...(STRICT_LAYER_ROOTS.length === 0
    ? []
    : [
        {
          files: STRICT_LAYER_ROOTS.map((root) => `${root}/**/*.ts`),
          rules: {
            'no-console': 'error',
            'import-x/no-cycle': ['error', { maxDepth: Infinity }],
            'no-restricted-syntax': ['error', NO_PROCESS_ENV],
          },
        },
        {
          files: STRICT_LAYER_ROOTS.map((root) => `${root}/tools/**/*.ts`),
          ignores: ['**/*.test.ts'],
          rules: { 'no-restricted-syntax': ['error', NO_PROCESS_ENV, NO_BARE_THROW] },
        },
        { files: CONSOLE_IS_FINE, rules: { 'no-console': 'off' } },
        { files: PROCESS_ENV_IS_FINE, rules: { 'no-restricted-syntax': 'off' } },
      ]),

  // Config files legitimately default-export, and are not in any package's tsconfig `include`
  // in a way the project service can type-check, so the type-aware rules are switched off here.
  {
    files: ['**/vitest.config.ts', '**/drizzle.config.ts', '**/test-global-setup.ts', 'eslint.config.js'],
    rules: { 'import-x/no-default-export': 'off' },
  },
  {
    files: ['eslint.config.js', '**/*.cjs', '**/*.mjs'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: { ...globals.node } },
  },

  // Last, so it wins: turns off every rule Prettier already decides.
  prettierConfig,
);
```

- [ ] **Step 5: Write `.dependency-cruiser.cjs`**

Every layer rule is generated per package from one table, so that a package task flips its own rules by changing one word — `severity: 'warn'` to `severity: 'error'` on its row — and nothing else. That is the migration the spec asks for.

```js
/**
 * Architecture rules for the whole workspace.
 *
 * ESLint owns "which construct may appear in which folder"; this file owns "which folder may
 * import which folder". The layers, in the only direction imports may travel:
 *
 *     shared  ->  domain  ->  tools  ->  app
 *
 *   shared/   pure helpers, no domain knowledge. Imports node built-ins and third-party only.
 *   domain/   one folder per domain: types.ts first, then repository.ts, prompts.ts, render.ts.
 *   tools/    defineTool calls only: validate input, call the domain, shape output.
 *   app/      the composition root and the process entrypoints. May import everything.
 *   index.ts  the only module other packages may import, plus the declared subpath exports.
 *
 * HOW A PACKAGE FLIPS TO ERROR
 * ----------------------------
 * Every rule below starts at the severity its PACKAGES row names. A package task that has
 * finished moving its files changes exactly one word on its own row:
 *
 *     { name: 'db', src: 'harness/db/src', severity: 'warn' },
 *                                                    ^^^^^^ becomes 'error'
 *
 * Nothing else in this file changes. `pnpm arch` then exits 1 on any violation in that
 * package while the others keep reporting warnings and exiting 0. Task 11 flips the last rows.
 *
 * Run it with `pnpm arch`. depcruise needs a GLOB, not a directory: `depcruise harness/db/src`
 * cruises zero modules and reports a cheerful success.
 */

const { existsSync, readFileSync } = require('node:fs');
const path = require('node:path');

/** @type {{ name: string, src: string, severity: 'warn' | 'error' }[]} */
const PACKAGES = [
  { name: 'db', src: 'harness/db/src', severity: 'warn' },
  { name: 'gateway', src: 'harness/gateway/src', severity: 'warn' },
  { name: 'core-tools', src: 'harness/core-tools/src', severity: 'warn' },
  { name: 'approvals', src: 'harness/approvals/src', severity: 'warn' },
  { name: 'evals', src: 'evals/src', severity: 'warn' },
];

/** Escape a path so it can sit inside a regular expression. */
const re = (p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The four upward-import bans, plus "nothing outside app/ imports app/", for one package. */
function layerRules({ name, src, severity }) {
  const at = (folder) => `^${re(src)}/${folder}/`;
  return [
    {
      name: `${name}-shared-imports-only-libraries`,
      comment: `${src}/shared holds pure helpers. It may import node built-ins and third-party packages, and nothing else from this package.`,
      severity,
      from: { path: at('shared') },
      to: { path: `^${re(src)}/(domain|tools|app)/` },
    },
    {
      name: `${name}-domain-does-not-import-tools-or-app`,
      comment: `A domain is called by tools/ and app/; it never calls back into them.`,
      severity,
      from: { path: at('domain') },
      to: { path: `^${re(src)}/(tools|app)/` },
    },
    {
      name: `${name}-tools-do-not-import-app`,
      comment: `tools/ is registered by app/, not the other way round.`,
      severity,
      from: { path: at('tools') },
      to: { path: at('app') },
    },
    {
      name: `${name}-public-api-does-not-import-app`,
      comment: `index.ts is what other packages import. Pulling app/ in would drag the composition root, dotenv and the process entrypoints into every consumer.`,
      severity,
      from: { path: `^${re(src)}/index\\.ts$` },
      to: { path: at('app') },
    },
    {
      name: `${name}-nothing-imports-app-but-app`,
      comment: `Only app/ imports app/. Its own tests are the one exception.`,
      severity,
      from: { path: `^${re(src)}/`, pathNot: [at('app'), '\\.test\\.ts$'] },
      to: { path: at('app') },
    },
  ];
}

/** Every workspace package directory, in the order pnpm-workspace.yaml lists them. */
const WORKSPACE_DIRS = [
  'harness/db',
  'harness/gateway',
  'harness/core-tools',
  'harness/approvals',
  'evals',
  'packs/healthcare',
  'scripts',
];

/**
 * The files a package's `package.json#exports` map points at, relative to the repository root.
 * Reading the map rather than hard-coding a list is what keeps this rule correct for free: a
 * task that adds or removes a subpath export changes what is reachable, and nothing here has
 * to be edited to match.
 */
function publicEntries(dir) {
  const manifest = path.join(dir, 'package.json');
  if (!existsSync(manifest)) return [];
  const map = JSON.parse(readFileSync(manifest, 'utf8')).exports ?? {};
  return Object.values(map)
    .filter((target) => typeof target === 'string')
    .map((target) => path.posix.join(dir, target.replace(/^\.\//, '')));
}

/** One package may reach another only at a path that package's exports map names. */
function crossPackageRule(dir) {
  const entries = publicEntries(dir);
  return {
    name: `only-public-entry-of-${dir.replace(/\//g, '-')}`,
    comment: `Reach ${dir} through its package name or one of its declared subpath exports (${entries.join(', ') || 'none'}), never by a path into its source tree.`,
    severity: 'warn',
    from: { pathNot: `^${re(dir)}/` },
    to: { path: `^${re(dir)}/`, pathNot: entries.map((entry) => `^${re(entry)}$`) },
  };
}

/** Rules that are not scoped to one package. */
const GLOBAL_RULES = [
  {
    name: 'no-circular',
    comment:
      'A cycle means two modules are really one. Warn until Task 11 of the maintainability plan: registry.ts sits in three type-only cycles that Tasks 5 to 7 remove.',
    severity: 'warn',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-test-imported-by-production',
    comment: 'A *.test.ts file is never imported by shipping code. Fixtures belong under the package testing.ts subpath.',
    severity: 'warn',
    from: { pathNot: '\\.test\\.ts$' },
    to: { path: '\\.test\\.ts$' },
  },
  {
    name: 'no-orphans',
    comment: 'A module nothing imports and that is not an entrypoint is dead. Entrypoints, configs and declaration files are exempt.',
    severity: 'warn',
    from: {
      orphan: true,
      pathNot: [
        '\\.d\\.ts$',
        '(^|/)[.][^/]+\\.(js|cjs|mjs|ts)$',
        '(^|/)(vitest|drizzle|eslint)\\.config\\.(js|cjs|mjs|ts)$',
        '(^|/)test-global-setup\\.ts$',
        '(^|/)(main|cli|migrate|record-surface|generate-templates|render-config)\\.ts$',
      ],
    },
    to: {},
  },
  ...WORKSPACE_DIRS.map(crossPackageRule),
];

module.exports = {
  forbidden: [...PACKAGES.flatMap(layerRules), ...GLOBAL_RULES],
  options: {
    doNotFollow: { path: 'node_modules' },
    exclude: { path: '(^|/)node_modules/|(^|/)drizzle/|(^|/)out/|(^|/)results/' },
    tsPreCompilationDeps: true,
    // Without this, depcruise resolves .js/.json only and every .ts import is "unresolvable".
    enhancedResolveOptions: { extensions: ['.ts', '.js', '.json'] },
    reporterOptions: { dot: { collapsePattern: '^(harness|packs|evals|scripts)/[^/]+/(src/)?(shared|domain|tools|app)(/[^/]+)?' } },
  },
};
```

dependency-cruiser resolves `@harness/db` through the pnpm symlink down to the real file, `harness/db/src/index.ts`, which is why `crossPackageRule` compares against the resolved targets of the `exports` map rather than against the specifier text. A package with no `exports` map (`@harness/scripts`) yields an empty allow-list, so any import into it is reported — correct, because nothing may import it.

- [ ] **Step 6: Add the root scripts**

Replace the `scripts` block's first line and add six entries. The full `scripts` block afterwards:

```json
  "scripts": {
    "lint": "eslint .",
    "lint:fix": "eslint . --fix",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "arch": "depcruise 'harness/*/src/**/*.ts' 'evals/src/**/*.ts' 'packs/*/**/*.ts' 'scripts/**/*.ts'",
    "arch:graph": "depcruise 'harness/*/src/**/*.ts' 'evals/src/**/*.ts' 'packs/*/**/*.ts' 'scripts/**/*.ts' --output-type dot | dot -T svg > docs/architecture/graph.svg",
    "surface:record": "pnpm --filter @harness/core-tools exec tsx src/record-surface.ts",
    "test": "pnpm lint && pnpm -r --if-present test",
    "typecheck": "pnpm -r --if-present typecheck",
    "db:up": "docker compose --env-file .env -f harness/compose/docker-compose.yml up -d postgres",
    "db:down": "docker compose --env-file .env -f harness/compose/docker-compose.yml down",
    "db:migrate": "pnpm --filter @harness/db migrate",
    "gateway:config": "pnpm --filter @harness/gateway render",
    "gateway:up": "docker compose --env-file .env -f harness/compose/docker-compose.yml up -d litellm",
    "gateway:logs": "docker compose --env-file .env -f harness/compose/docker-compose.yml logs -f litellm",
    "forms:generate": "pnpm --filter @harness/pack-healthcare forms:generate",
    "synth": "pnpm --filter @harness/pack-healthcare generate",
    "synth:fast": "pnpm --filter @harness/pack-healthcare generate -- --scans=false",
    "evals": "pnpm --filter @harness/evals start",
    "evals:baseline": "pnpm --filter @harness/evals start -- --update-baseline=true",
    "approvals": "pnpm --filter @harness/approvals start",
    "new-client": "pnpm --filter @harness/scripts exec tsx new-client.ts",
    "demo:up": "docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d --build",
    "demo:down": "docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo down",
    "demo:logs": "docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo logs -f hermes approvals",
    "demo:playbooks": "docker compose --env-file .env -f harness/compose/docker-compose.yml exec hermes bash /opt/data/cron/playbooks.sh"
  },
```

`arch:graph` needs Graphviz, which is not installed on a fresh machine. Task 11 installs it and generates the SVG; do not run `arch:graph` here.

- [ ] **Step 7: Run the formatters and commit that on its own**

```bash
pnpm lint:fix
pnpm format
```

`lint:fix` reorders imports (many test files put `vitest` above the `node:` built-ins, which `import-x/order` corrects) and strips unused imports; `format` then rewrites 68 of the 115 TypeScript files. Run them in that order, because `eslint --fix` produces code Prettier then normalises.

Verify nothing but formatting changed:

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
git add -A
git commit -m "style: apply prettier and eslint --fix across the workspace"
```

This is the one formatting commit. Every later commit in this plan must contain no reformatting-only hunks; if one appears, it means a file was edited without the formatter and `pnpm format` should be re-run before staging.

- [ ] **Step 8: Write the surface recorder**

Create `harness/core-tools/src/record-surface.ts`. It is both a library (the test imports it) and a CLI (`pnpm surface:record` regenerates the two snapshots). Task 7 moves it to `src/app/record-surface.ts` and changes nothing else about it.

```ts
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { connectInProcess } from './in-process.js';
import { DEFAULT_POLICY } from './policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from './registry.js';
import { createCoreToolsServer } from './server.js';
import { NPPES_DEFAULT_BASE_URL } from './tools/verify.js';

const run = promisify(execFile);

/** Where both snapshots live, relative to the repository root. */
export const ARCHITECTURE_DIR = 'docs/architecture';

export interface ToolSurfaceEntry {
  name: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

/**
 * Dependencies good enough to *register* every tool and no further. `registerTools` writes
 * each definition into `deps.tools` and reads its schemas; it never calls a handler, so
 * nothing below is ever used. The database handle is a null cast on purpose: recording the
 * public surface must not need Postgres, or the snapshot could not be regenerated offline.
 */
export function surfaceDeps(): ToolDeps {
  return {
    db: null as unknown as ToolDeps['db'],
    client: 'surface',
    caller: 'surface',
    policy: { ...DEFAULT_POLICY },
    encryptionKey: Buffer.alloc(32),
    now: () => new Date('2026-01-01T00:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', timeoutMs: 1_000, maxCallsPerRun: 1 },
    storageDir: '/nonexistent/surface',
    formsDir: '/nonexistent/surface',
    restrictedToModel: false,
    verify: {
      nppesEnabled: false,
      nppesBaseUrl: NPPES_DEFAULT_BASE_URL,
      stateLicenseEnabled: false,
      timeoutMs: 1_000,
    },
    sinks: {},
    context: {},
    tools: new Map(),
  };
}

/**
 * Every MCP tool this server publishes, with the JSON Schema a client actually receives —
 * not the zod object, the resolved schema, because that is what an agent reads and what a
 * rename or a widened field would change.
 */
export async function readToolSurface(): Promise<ToolSurfaceEntry[]> {
  const { client, close } = await connectInProcess(() => createCoreToolsServer(surfaceDeps()));
  try {
    const { tools } = await client.listTools();
    return (tools as { name: string; inputSchema: unknown; outputSchema?: unknown }[])
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await close();
  }
}

/**
 * The rendered Compose config.
 *
 * `--no-interpolate --no-path-resolution` is what makes this snapshot-able at all, and both
 * flags are load-bearing:
 *
 *   - Without `--no-interpolate`, Compose refuses to render (`required variable
 *     LITELLM_MASTER_KEY is missing a value`) unless a filled-in `.env` exists — and when one
 *     does, the `hermes` service's `env_file: ../../.env` copies the developer's real API
 *     keys straight into the output. Nothing like that can be committed.
 *   - Without `--no-path-resolution`, every bind mount is rewritten to an absolute host path,
 *     so the snapshot differs on every machine.
 *
 * Both `--profile` flags are needed because `config` omits services whose profile is not
 * enabled, and `approvals`, `hermes`, `hermes-init` and `core-tools` all have one.
 */
export async function readComposeSurface(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(
      'docker',
      [
        'compose',
        '-f',
        'harness/compose/docker-compose.yml',
        '--profile',
        'demo',
        '--profile',
        'build-only',
        'config',
        '--no-interpolate',
        '--no-path-resolution',
      ],
      { cwd: repoRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `could not render the Compose config. The docker CLI has to be on PATH; the stack does not have to be running. ${detail}`,
    );
  }
}

/**
 * Helpers whose first argument is the name of an environment variable. The scan below reads
 * their call sites as well as bare `process.env.X`, because after the shared env module lands
 * most reads go through one of these and a scan that only looked for `process.env` would see
 * almost nothing. Add a wrapper here when you add one to the code.
 */
export const ENV_READING_HELPERS = [
  'numberFromEnv',
  'booleanFromEnv',
  'requiredEnv',
  'optionalEnv',
  'required',
  'requiredFrom',
  'seconds',
  'port',
] as const;

const SOURCE_ROOTS = ['harness', 'packs', 'evals', 'scripts'];
const DIRECT_ENV = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const INDEXED_ENV = /process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g;
const HELPER_ENV = new RegExp(String.raw`\b(?:${ENV_READING_HELPERS.join('|')})\(\s*(?:env,\s*)?'([A-Z][A-Z0-9_]*)'`, 'g');

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/** Every environment variable name the shipping code reads, sorted and deduplicated. */
export async function readEnvNames(repoRoot: string): Promise<string[]> {
  const names = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const file of await sourceFiles(path.join(repoRoot, root))) {
      const text = await readFile(file, 'utf8');
      for (const pattern of [DIRECT_ENV, INDEXED_ENV, HELPER_ENV]) {
        for (const match of text.matchAll(pattern)) names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

/** Every name `.env.example` documents, commented-out lines included. */
export async function envNamesFromExample(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.join(repoRoot, ARCHITECTURE_DIR);
  await mkdir(outDir, { recursive: true });
  const tools = await readToolSurface();
  await writeFile(path.join(outDir, 'tool-surface.json'), `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'compose-surface.yaml'), await readComposeSurface(repoRoot), 'utf8');
  console.error(`recorded ${tools.length} tools and the compose config into ${ARCHITECTURE_DIR}/`);
}
```

- [ ] **Step 9: Write the failing surface test**

Create `harness/core-tools/src/surface.test.ts`. Write it before the snapshots exist, so the first run fails for the right reason.

```ts
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  ARCHITECTURE_DIR,
  envNamesFromExample,
  readComposeSurface,
  readEnvNames,
  readToolSurface,
  type ToolSurfaceEntry,
} from './record-surface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const architecture = path.join(repoRoot, ARCHITECTURE_DIR);

/**
 * Names that must appear in the environment scan. They are here to catch the scan breaking
 * silently: DATABASE_URL is a bare `process.env.X`, APPROVALS_POLL_SECONDS is only reachable
 * through the `seconds()` wrapper, and VERIFY_NPPES_ENABLED only through `booleanFromEnv`.
 * If a refactor moves a read out of reach of every pattern, this fails instead of the whole
 * check quietly passing on an empty list.
 */
const SCAN_ANCHORS = [
  'DATABASE_URL',
  'LITELLM_MASTER_KEY',
  'HARNESS_STORAGE_DIR',
  'VERIFY_NPPES_ENABLED',
  'APPROVALS_POLL_SECONDS',
  'SLACK_APPROVALS_CHANNEL',
];

describe('public surface', () => {
  it('publishes exactly the recorded MCP tools, with the recorded schemas', async () => {
    const recorded = JSON.parse(await readFile(path.join(architecture, 'tool-surface.json'), 'utf8')) as ToolSurfaceEntry[];
    expect(await readToolSurface()).toEqual(recorded);
  }, 30_000);

  it('reads no environment variable that .env.example does not document', async () => {
    const read = await readEnvNames(repoRoot);
    for (const anchor of SCAN_ANCHORS) expect(read).toContain(anchor);
    const documented = await envNamesFromExample(path.join(repoRoot, '.env.example'));
    expect(read.filter((name) => !documented.includes(name))).toEqual([]);
  });

  it('renders the Compose config the repository recorded, with no secret in it', async () => {
    const rendered = await readComposeSurface(repoRoot);
    // --no-interpolate leaves every ${VAR} unexpanded, so a real key can only appear here if
    // someone hard-coded one into the compose file.
    expect(rendered).not.toMatch(/AIza[0-9A-Za-z_-]{10}|sk-[0-9A-Za-z]{16}|xox[baps]-/);
    expect(rendered).toBe(await readFile(path.join(architecture, 'compose-surface.yaml'), 'utf8'));
  }, 60_000);
});
```

- [ ] **Step 10: Run it and watch it fail**

```bash
pnpm --filter @harness/core-tools exec vitest run src/surface.test.ts
```
Expected: three failures, the first two on `ENOENT: no such file or directory, open '.../docs/architecture/tool-surface.json'` and the third on the missing `compose-surface.yaml`.

- [ ] **Step 11: Record the snapshots and watch it pass**

```bash
pnpm surface:record
```
Expected on stderr: `recorded 22 tools and the compose config into docs/architecture/`

```bash
wc -l docs/architecture/tool-surface.json docs/architecture/compose-surface.yaml
```
Expected: roughly 2247 and 294 lines. Sanity-check that no secret leaked in:

```bash
grep -nE 'AIza|sk-[0-9A-Za-z]{16}|xox[baps]-' docs/architecture/compose-surface.yaml || echo "clean"
```
Expected: `clean`

```bash
pnpm --filter @harness/core-tools exec vitest run src/surface.test.ts
```
Expected: `Test Files 1 passed`, `Tests 3 passed`.

- [ ] **Step 12: Write the ARCHITECTURE.md draft**

Create `ARCHITECTURE.md` at the repository root. Task 11 adds the generated graph and the final package map; everything below is written now, because the rules it states are what the remaining ten tasks are judged against.

````markdown
# Architecture

This document is for someone who did not write this code and has to change it safely.
Read it before adding a tool, a domain or a package. `CONTRIBUTING.md` is the how-to;
this is the why.

## The four layers

Every package has the same shape. Imports travel in one direction only, and
`.dependency-cruiser.cjs` fails the build when they do not.

| Layer | Folder | Holds | May import |
|---|---|---|---|
| shared | `src/shared/` | pure helpers with no domain knowledge: `env.ts`, `errors.ts`, `paths.ts`, `log.ts`, `subprocess.ts`, `jsonl.ts`, `csv.ts`, and in core-tools `redaction/` | node built-ins, third-party packages |
| domain | `src/domain/<name>/` | one folder per domain: `types.ts` first, then `repository.ts` (SQL), pure logic modules, `prompts.ts` where a model is involved, and the tests | `shared/`, other domains' `types.ts` and exported functions |
| tools | `src/tools/<name>.ts` | `defineTool` calls only: validate input, call the domain, shape output. No SQL, no regex, no prompt strings | `domain/`, `shared/` |
| app | `src/app/` | `server.ts` (the composition root: dependencies from the environment, tool registration), `main.ts` (the process entrypoint), CLIs | everything |
| public API | `src/index.ts` | the only module other packages may import, alongside the subpaths `package.json#exports` declares | `domain/`, `tools/`, `shared/` — never `app/` |

Two conventions keep the tree readable:

- A domain that needs one module is one file, `src/domain/<name>.ts`. It gets a folder as
  soon as it needs a second module or a `types.ts` shared between them.
- Files are named for what they do — `types.ts`, `repository.ts`, `render.ts`, `prompts.ts`,
  `layout.ts` — never for the package or the folder they sit in. Two files in one package
  never share a basename unless they do the same job for different domains.

## The packages

```
harness/db          schema, migrations, the pool, the encryption primitives. Bottom of the graph.
harness/gateway     the routing schema and the LiteLLM config renderer.
harness/core-tools  the MCP server: the tooling kernel, every domain, every tool, shared/.
harness/approvals   the Slack app: cards, decisions, the effects dispatcher, the health endpoint.
evals               the eval runner, scorers, judge and report.
packs/healthcare    content: the provider schema, form templates, skills, the synthetic corpus.
scripts             the client scaffolder.
```

The dependency graph is `db -> core-tools -> {approvals, evals}` and `gateway -> core-tools`,
with `packs/healthcare` read by core-tools through `createRequire('@harness/pack-healthcare/schema')`
and `scripts` a leaf. There are no cycles.

## The path of one tool call

An agent calls `documents_extract`. What happens, in order:

1. **Registration.** `app/server.ts` built `ToolDeps` from the environment at startup and
   handed every definition to `registerTools`, which wrapped each one in an MCP callback.
2. **Lineage.** The callback splits `derived_from` off the arguments — it is the registry's
   own argument, audited as lineage and never passed to the handler or hashed.
3. **Policy.** `decide(tool.actionClass, deps.policy)` returns `auto`, `approval` or `blocked`.
   `blocked` writes an audit row and returns; `approval` parks a row and returns its id.
4. **Transaction.** `auto` opens one transaction. The handler and its audit row commit
   together, so a handler that throws leaves neither its writes nor a success row behind.
5. **Handler.** The tool validates its input, calls the domain, and shapes the output. It
   holds no SQL and no prompt text.
6. **Audit.** The audit row is written inside the same transaction, carrying the arguments
   hash, the action class, the session context and the record ids the tool reported.
7. **Effects.** Anything that leaves the process is staged, never sent: `stageEffect` writes
   an encrypted row to `tool_effects` in the handler's transaction, and the approvals app's
   dispatcher sends it later, exactly once per idempotency key.
8. **Error masking.** Only a `ToolError`'s message reaches the caller. Anything else becomes
   "internal error; see audit log", because a raw message can carry a restricted value.

## The three invariants

Break any of these and the harness is not safe to run against real data.

1. **Every query is scoped to `deps.client`.** A tool that reads or writes a row without a
   client predicate is a tenant leak. `requireProvider` and `requireDocument` exist so that
   no handler has to remember.
2. **Restricted identifiers are redacted before a model sees them.** `redactPages` runs over
   the text, `assertRedacted` runs over the exact messages about to be serialised, and both
   use the same patterns. The defence repeats on the way out: masked on read, checked again
   before Slack, checked again in the file sink.
3. **Only a `ToolError` reaches an agent.** Everything else is masked by the kernel and kept
   in `audit_log.error`, where an operator reads it with psql.

## The three error types

Declared once, in `harness/core-tools/src/shared/errors.ts`:

| Type | Means | Who sees the message |
|---|---|---|
| `ToolError` | an expected failure the caller can act on: bad input, a missing record, a disabled feature | the agent |
| `ModelOutputError` (a `ToolError`) | the model's reply did not parse or did not match the schema; the message carries zod issue paths only | the agent |
| `ConfigError` | the process is misconfigured and cannot start | the operator, at startup |

Everything else is a plain `Error`. `@harness/db` is the single exception: it sits below the
shared layer and importing core-tools from it would be a cycle, so it throws plain `Error`
and keeps its own ten-line `shared/log.ts`. Revisit if a second package below core-tools
ever needs the shared helpers — spec section 8 declined a `@harness/shared` package for now.

## Where each cross-cutting concern lives

All in `harness/core-tools/src/shared/`, re-exported from the package's public API so that
`@harness/approvals`, `@harness/evals` and the pack import them instead of keeping copies.

| Concern | Module | Exports |
|---|---|---|
| environment parsing | `shared/env.ts` | `numberFromEnv`, `booleanFromEnv`, `requiredEnv`, `optionalEnv` |
| errors | `shared/errors.ts` | `ToolError`, `ModelOutputError`, `ConfigError`, `describeError` |
| path containment | `shared/paths.ts` | `realOrNearestAncestor`, `assertInsideRoot` |
| logging | `shared/log.ts` | `createLogger` |
| bounded subprocesses | `shared/subprocess.ts` | `runBounded` |
| JSONL | `shared/jsonl.ts` | `readJsonl`, `writeJsonl` |
| CSV quoting | `shared/csv.ts` | `csvCell` |
| restricted patterns | `shared/redaction/patterns.ts` | `containsRestrictedPattern`, `isValidDea` |
| restricted field names | `shared/redaction/names.ts` | `isRestrictedName`, `MASKED` |
| redaction | `shared/redaction/text.ts` | `redactPages`, `assertRedacted`, `fieldNameFor` |

`shared/redaction/patterns.ts` deliberately carries **two** pattern sets. The strict-shape
set behind `containsRestrictedPattern` is the last-line guard on anything about to reach a
human channel; it matches on shape alone and over-reports on purpose. The OCR-tolerant,
validity-gated set behind `redactPages` is what decides whether a value gets encrypted onto
a provider record, where a false positive would fabricate an SSN. Collapsing them into one
list would change behaviour in both directions.

## Deciding where new code goes

Ask, in order:

1. Does it know anything about providers, documents, approvals or models? If not, it is
   `shared/`. If a second package would want it, it is `shared/` in core-tools and it gets
   re-exported from the public API.
2. Is it an agent-callable action? Then its *definition* is a file in `tools/` and its
   *logic* is a function in `domain/`. A `defineTool` block longer than about forty lines
   is logic that has not moved yet.
3. Does it read the environment, open a connection, or start a process? Then it is `app/`.
   Nothing else may read `process.env`.
4. Does something outside this package need it? Then it is exported from `index.ts`, and the
   fake beside it is exported from `./testing`. Nothing else is reachable.

## Tooling

| Command | What it checks |
|---|---|
| `pnpm lint` | ESLint 9 flat config: type-aware typescript-eslint, import ordering and cycles, unused imports, and the three project rules (`no-console`, `process.env`, `throw new Error` in `tools/`) |
| `pnpm format:check` | Prettier |
| `pnpm arch` | dependency-cruiser: the layer rules, "no cycles", "no test imported by production code", "no orphans", "other packages import only a declared entry point" |
| `pnpm arch:graph` | writes `docs/architecture/graph.svg` (needs Graphviz) |
| `pnpm surface:record` | regenerates `docs/architecture/tool-surface.json` and `compose-surface.yaml` |
| `pnpm test` | lint, then every package's vitest suite |

ESLint's type-aware rules run against TypeScript **6**, installed at the workspace root only,
because typescript-eslint refuses to load against TypeScript 7. Every package still compiles
with TypeScript 7 through its own `tsc --noEmit`. That duplication is deliberate; delete it
when typescript-eslint supports 7.

The type-aware rules land as warnings, not errors: the existing code trips `require-await`
and the `no-unsafe-*` family in places, and clearing that is separate work from moving files.
`import-x/no-cycle`, `no-console` and the `process.env` rule are promoted from warning to
error per package, by appending the package's source root to `STRICT_LAYER_ROOTS` in
`eslint.config.js`; dependency-cruiser is promoted the same way, by changing one `severity`
on that package's row in `.dependency-cruiser.cjs`.

## Proof that a refactor changed nothing

`harness/core-tools/src/app/surface.test.ts` compares three things against committed
snapshots on every run:

- the MCP tool list, with each tool's input and output JSON Schema, against
  `docs/architecture/tool-surface.json`;
- every environment variable name the code reads, against `.env.example`;
- the rendered Compose config, against `docs/architecture/compose-surface.yaml`.

A renamed tool, a widened schema, an undocumented variable or a changed service definition
fails the suite. Regenerate the snapshots with `pnpm surface:record` only when the change is
intended, and say so in the commit message.
````

- [ ] **Step 13: Write CONTRIBUTING.md**

Create `CONTRIBUTING.md` at the repository root.

````markdown
# Contributing

## Getting a working checkout

```bash
pnpm install
cp .env.example .env            # then set HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm db:up                      # Postgres 16 on 127.0.0.1:15432, databases harness and harness_test
pnpm db:migrate
pnpm test
```

`pnpm db:up` starts a container shared by every checkout on the machine. Do not run
`pnpm db:down` while a colleague may be testing. Every Compose command goes through a `pnpm`
script so that it carries `--env-file .env`; running `docker compose` by hand without it
reads the wrong environment.

**Never source `.env` into your shell before running tests.** One crypto test asserts what
happens when `HARNESS_ENCRYPTION_KEY` is unset, and a sourced `.env` makes it pass for the
wrong reason.

## Adding a tool

1. Put the logic in a domain: a function in `src/domain/<name>/` that takes `ToolDeps` and
   plain arguments. Write its test beside it.
2. Add the definition to `src/tools/<area>.ts`:

   ```ts
   const providersArchive = defineTool({
     name: 'providers_archive',
     description: 'One sentence an agent can act on, then the constraints.',
     actionClass: 'write.internal',
     input: z.object({ provider_id: z.string().uuid() }),
     output: z.object({ provider_id: z.string(), status: z.literal('archived') }),
     handler: async ({ provider_id }, deps) => archiveProvider(deps, provider_id),
     recordIds: ({ provider_id }) => [provider_id],
   });
   ```

3. Add it to the exported array at the bottom of that file. `ALL_TOOLS` in `app/server.ts`
   already spreads it.
4. Choose the action class honestly: `read`, `write.internal`, `external`, `financial`,
   `destructive`. `external` parks an approval; `financial` is blocked by default.
5. Throw `ToolError` for anything the caller can fix. Never `throw new Error` in `tools/` —
   its message is masked and the caller learns nothing.
6. Never send anything from a handler. Stage it with `stageEffect` and let the dispatcher send it.
7. Add `redact` if any argument can carry a restricted value: the parked approval stores the
   plaintext payload as jsonb.
8. Regenerate the surface snapshot and say so in the commit:
   `pnpm surface:record`.

## Adding a domain

Create `src/domain/<name>/types.ts` first and write the interfaces before the code. Put the
production adapter and the fake beside it. If the domain needs only one module, make it
`src/domain/<name>.ts` instead and split later.

## Adding a pack

A pack is content, not code: `schema/`, `forms/`, `skills/`, `evals/`, `policy.yaml`, and a
`synthetic/` corpus generator. Declare what core-tools may read in `package.json#exports`;
anything not exported is unreachable, which is the point.

## Adding a client

```bash
pnpm new-client --pack healthcare --name acme-clinic
```

Then fill in `clients/acme-clinic/.env.example`, review `SOUL.md` and `policy.yaml`, and read
"Onboarding a client" in `docs/runbook.md`.

## Adding a migration

Edit `harness/db/src/domain/schema.ts` first, then, from `harness/db/`:

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit generate   # run it twice; the second run must print "No schema changes"
```

**Plain `generate`, never `--custom`.** A custom migration is not reflected in the snapshot,
so the next generate re-emits the change and the two diverge silently.

## Adding a test

Tests live beside the code they test, named `*.test.ts`, and are never imported by shipping
code. Database tests use the real Postgres on `127.0.0.1:15432` and truncate between tests
through `useTestDb()` from `@harness/db/testing`. Fakes come from a package's `./testing`
subpath: `FakeGateway`, `FakeSlack`, `FakeCoreToolsClient`, `makeTestDeps`, `connectTools`.
No test makes a real network call, a real Slack call or a real model call.

## Commit conventions

Conventional prefix, imperative subject, no trailer of any kind:

```
feat(core-tools): add providers_archive
fix(approvals): release the poller claim when the post fails
refactor(evals): move the report renderer into its own module
docs: describe the effects outbox in the runbook
style: apply prettier and eslint --fix across the workspace
chore(deps): pin dependency-cruiser to 16.10.4
```

No `Co-Authored-By`, no generation notice. Commits belong to the person who made them.

## Before you push

```bash
pnpm -r typecheck
pnpm lint
pnpm arch
pnpm test
```
````

- [ ] **Step 14: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
pnpm lint
```
Expected: warnings only — `no-console`, `no-restricted-syntax`, `import-x/no-cycle` and the
type-aware family. **No errors.** If `import-x/*` reports `Resolve error: typescript with
invalid interface loaded as resolver`, `eslint-import-resolver-typescript` did not install;
go back to Step 1.

```bash
pnpm arch
```
Expected: a list of warnings ending in something like
`x N dependency violations (0 errors, N warnings)` and **exit 0**. Confirm the exit code, because
a warn-only run still prints a red `x`:

```bash
pnpm arch > /dev/null 2>&1; echo $?
```
Expected: `0`

```bash
pnpm -r test
```
Expected: 7 packages pass; 525 tests (the 522 that exist today plus the three in
`surface.test.ts`).

- [ ] **Step 15: Commit**

Three commits, so a reviewer can read the tooling, the snapshot and the documents apart. The
formatting commit from Step 7 is already in.

```bash
git add eslint.config.js .prettierrc .prettierignore .editorconfig .vscode/extensions.json .dependency-cruiser.cjs package.json pnpm-workspace.yaml pnpm-lock.yaml
git commit -m "chore(tooling): add eslint, prettier and dependency-cruiser"

git add harness/core-tools/src/record-surface.ts harness/core-tools/src/surface.test.ts docs/architecture/tool-surface.json docs/architecture/compose-surface.yaml
git commit -m "test(core-tools): snapshot the tool, environment and compose surfaces"

git add ARCHITECTURE.md CONTRIBUTING.md
git commit -m "docs: add ARCHITECTURE.md and CONTRIBUTING.md"
```

---
### Task 2: `@harness/db` — the layout, the one `useTestDb`, the README

`@harness/db` sits at the bottom of the dependency graph, so it moves first and it is the
only package that keeps its own tiny logger. It also becomes the single home of `useTestDb`,
which exists in three copies today.

**Files:**
- Move: `harness/db/src/crypto.ts` → `harness/db/src/shared/crypto.ts`
- Move: `harness/db/src/crypto.test.ts` → `harness/db/src/shared/crypto.test.ts`
- Move: `harness/db/src/schema.ts` → `harness/db/src/domain/schema.ts`
- Move: `harness/db/src/schema.test.ts` → `harness/db/src/domain/schema.test.ts`
- Move: `harness/db/src/client.ts` → `harness/db/src/domain/client.ts`
- Move: `harness/db/src/migrate.ts` → `harness/db/src/domain/migrate.ts`, then split its CLI out into `harness/db/src/app/migrate.ts`
- Create: `harness/db/src/shared/log.ts`, `harness/db/src/shared/log.test.ts`, `harness/db/README.md`
- Modify: `harness/db/src/index.ts`, `harness/db/src/testing.ts`, `harness/db/src/test-global-setup.ts`, `harness/db/package.json`, `harness/db/drizzle.config.ts`
- Modify: `harness/core-tools/src/testing.ts` (its `useTestDb` becomes a re-export), `harness/approvals/src/testing.ts` (same)
- Modify: `eslint.config.js` (one entry in `STRICT_LAYER_ROOTS`), `.dependency-cruiser.cjs` (one word on the `db` row)

**Interfaces:**
- Consumes: nothing from earlier tasks except the tooling from Task 1.
- Produces:
  - `createLogger(scope: string): Logger` from `harness/db/src/shared/log.ts`, where `interface Logger { info(message: string, err?: unknown): void; warn(message: string, err?: unknown): void; error(message: string, err?: unknown): void }`. **Local to `@harness/db` and not exported from the package**; core-tools declares its own in Task 4 with the same signature.
  - `useTestDb(): Db` from `@harness/db/testing` — creates a pool against `TEST_DATABASE_URL`, truncates in `beforeEach`, closes in `afterAll`.
  - Unchanged and still exported from `@harness/db`: every table from `domain/schema.ts`, `bytea`, `createDb`, `withTransaction`, `type Db`, `runMigrations`, `encrypt`, `decrypt`, `loadKey`, `generateKey`.
  - Unchanged and still exported from `@harness/db/testing`: `TEST_DATABASE_URL`, `resetDatabase`.
  - Unchanged and still exported from `@harness/db/schema`: the schema module.

---

- [ ] **Step 1: Write the failing logger test**

Create `harness/db/src/shared/log.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest';
import { createLogger } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('prefixes every line with its scope and writes to stderr', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').info('pool opened');
    expect(spy).toHaveBeenCalledWith('db: pool opened');
  });

  it('appends an error message without the stack', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').error('pool failed', new Error('connection refused'));
    expect(spy).toHaveBeenCalledWith('db: pool failed: connection refused');
  });

  it('describes a thrown non-Error without crashing', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('db').warn('odd', 'just a string');
    expect(spy).toHaveBeenCalledWith('db: odd: just a string');
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
pnpm --filter @harness/db exec vitest run src/shared/log.test.ts
```
Expected: FAIL, `Failed to resolve import "./log.js"`.

- [ ] **Step 3: Write the logger**

Create `harness/db/src/shared/log.ts`:

```ts
/**
 * A logger for @harness/db only.
 *
 * This is a deliberate second copy of core-tools' `shared/log.ts`, and the duplication is the
 * point: @harness/db is the bottom of the dependency graph, so importing core-tools from here
 * would be a cycle. The module is ten lines and has one job. If a second package below
 * core-tools ever needs the shared helpers, that is the moment to revisit the `@harness/shared`
 * package the design declined — see ARCHITECTURE.md, "The three error types".
 *
 * Output goes to stderr, always. stdout belongs to whatever a CLI is actually printing.
 */
export interface Logger {
  info(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

/** A message, never a payload: an error's message but never its stack, and never a row. */
function line(scope: string, message: string, err: unknown): string {
  if (err === undefined) return `${scope}: ${message}`;
  return `${scope}: ${message}: ${err instanceof Error ? err.message : String(err)}`;
}

export function createLogger(scope: string): Logger {
  const write = (message: string, err: unknown): void => {
    // eslint-disable-next-line no-console -- this module is the one place console is allowed
    console.error(line(scope, message, err));
  };
  return {
    info: (message, err) => write(message, err),
    warn: (message, err) => write(message, err),
    error: (message, err) => write(message, err),
  };
}
```

The `eslint-disable-next-line` is redundant today — `eslint.config.js` already exempts
`**/src/shared/log.ts` — and is there so that the exemption is visible at the call site.

- [ ] **Step 4: Run it and watch it pass**

```bash
pnpm --filter @harness/db exec vitest run src/shared/log.test.ts
```
Expected: `Tests 3 passed`.

- [ ] **Step 5: Move the files**

```bash
cd harness/db
mkdir -p src/shared src/domain src/app
git mv src/crypto.ts src/shared/crypto.ts
git mv src/crypto.test.ts src/shared/crypto.test.ts
git mv src/schema.ts src/domain/schema.ts
git mv src/schema.test.ts src/domain/schema.test.ts
git mv src/client.ts src/domain/client.ts
git mv src/migrate.ts src/domain/migrate.ts
cd ../..
```

- [ ] **Step 6: Rewrite the import paths the move broke**

```bash
cd harness/db
# domain/client.ts and domain/migrate.ts now sit one level down.
sed -i '' "s#from './schema.js'#from './schema.js'#" src/domain/client.ts   # unchanged: both are in domain/
sed -i '' "s#from './client.js'#from './client.js'#" src/domain/migrate.ts  # unchanged: both are in domain/
# testing.ts and test-global-setup.ts stayed at the src root and now point into domain/.
sed -i '' "s#from './client.js'#from './domain/client.js'#" src/testing.ts
sed -i '' "s#from './migrate.js'#from './domain/migrate.js'#" src/test-global-setup.ts
# The two test files moved with their code; their sibling imports still resolve, except
# schema.test.ts, which reaches testing.ts at the src root.
sed -i '' "s#from './testing.js'#from '../testing.js'#" src/domain/schema.test.ts
cd ../..
```

`src/domain/client.ts` also gains the logger. Replace its `pool.on('error', ...)` block:

```ts
import { drizzle, type NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgDatabase } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { createLogger } from '../shared/log.js';
import * as schema from './schema.js';

const log = createLogger('db');
```

and, inside `createDb`:

```ts
  // An idle client that dies (server restart, network drop) emits on the pool;
  // without a listener node-postgres turns that into an unhandled 'error' event
  // and takes the process down.
  pool.on('error', (err) => {
    log.error('postgres pool error', err);
  });
```

The message changes from `postgres pool error: <msg>` to `db: postgres pool error: <msg>`.
No test asserts it; `grep -rn "postgres pool error" harness packs evals scripts` confirms one
call site and no assertion.

- [ ] **Step 7: Split the migrate CLI out of the domain**

`src/domain/migrate.ts` keeps only the library function. Replace the whole file with:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { createDb } from './client.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const migrationsFolder = path.resolve(here, '../../drizzle');

export async function runMigrations(url?: string): Promise<void> {
  const { db, close } = createDb(url);
  try {
    await migrate(db, { migrationsFolder });
  } finally {
    await close();
  }
}
```

`../../drizzle` rather than `../drizzle`: the file moved from `src/` to `src/domain/`, so the
folder is one level further up. Getting this wrong makes every test fail in global setup with
"no migrations found", which is the loudest possible signal, but check it anyway.

Create `src/app/migrate.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { runMigrations } from '../domain/migrate.js';
import { createLogger } from '../shared/log.js';

const log = createLogger('db');
const here = path.dirname(fileURLToPath(import.meta.url));

// CLI only: tests call runMigrations() with an explicit URL and must not pick
// up the developer's repository-root .env.
loadEnv({ path: path.resolve(here, '../../../../.env'), quiet: true });

runMigrations()
  .then(() => {
    log.info('migrations applied');
  })
  .catch((err: unknown) => {
    log.error('migration failed', err);
    process.exit(1);
  });
```

`../../../../.env` — the file is now at `harness/db/src/app/`, four levels below the repository
root, where the old one was three.

The old file guarded its CLI behind `if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))`.
That guard is gone because the file is now an entrypoint and nothing imports it. `app/` is the
only layer where that is true.

- [ ] **Step 8: Point the package script and drizzle-kit at the new paths**

`harness/db/package.json`: change one script.

```json
    "migrate": "tsx src/app/migrate.ts",
```

`harness/db/drizzle.config.ts`: change one line.

```ts
  schema: './src/domain/schema.ts',
```

**Miss this and `drizzle-kit generate` silently sees an empty schema and emits a migration
that drops every table.** Step 12 is the check that catches it.

- [ ] **Step 9: Update `index.ts` and add `useTestDb` to `testing.ts`**

`harness/db/src/index.ts` in full:

```ts
export * from './domain/schema.js';
export { createDb, withTransaction, type Db } from './domain/client.js';
export { runMigrations } from './domain/migrate.js';
export { encrypt, decrypt, loadKey, generateKey } from './shared/crypto.js';
```

`harness/db/src/testing.ts` in full:

```ts
import { sql } from 'drizzle-orm';
import { afterAll, beforeEach } from 'vitest';
import { createDb, type Db } from './domain/client.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';

/**
 * Wipe every table between tests.
 *
 * `audit_log` carries a BEFORE TRUNCATE trigger that makes it append-only, so
 * the truncate is bracketed by an explicit disable/enable. This is a test-only
 * escape hatch: it works because the test role owns the tables. In production
 * the application role must not own them, so it cannot do this — see the
 * "Database roles" section of docs/runbook.md.
 */
export async function resetDatabase(db: Db): Promise<void> {
  await db.execute(sql`ALTER TABLE audit_log DISABLE TRIGGER USER`);
  try {
    await db.execute(sql`
      TRUNCATE TABLE audit_log, tool_effects, model_calls, runs, approvals, deadlines,
        credentials, fields, documents, providers CASCADE
    `);
  } finally {
    await db.execute(sql`ALTER TABLE audit_log ENABLE TRIGGER USER`);
  }
}

/**
 * The database for one test file: emptied before each test and closed when the
 * file finishes. Call it once at module scope; test files run in their own
 * worker, so each gets its own pool.
 *
 * This is the only copy. @harness/core-tools and @harness/approvals each had a
 * byte-identical one and now re-export this from their own `./testing` subpath, because
 * the truncation list and the append-only bracketing above have to agree with it exactly.
 */
export function useTestDb(): Db {
  const { db, close } = createDb(TEST_DATABASE_URL);
  beforeEach(() => resetDatabase(db));
  afterAll(() => close());
  return db;
}
```

Importing `vitest` from a file that ships in the `./testing` subpath is intentional and is
already how core-tools' and approvals' copies worked: `./testing` is only ever imported by a
test, and `vitest` is a devDependency of every package.

- [ ] **Step 10: Delete the two duplicate copies**

In `harness/core-tools/src/testing.ts`, delete the `useTestDb` function (its import of
`createDb` and `beforeEach`/`afterAll` go with it) and re-export instead. The import line
becomes:

```ts
import { TEST_DATABASE_URL, resetDatabase, useTestDb } from '@harness/db/testing';
```

and near the other re-exports at the bottom of the file:

```ts
export { useTestDb } from '@harness/db/testing';
```

`createDb`, `beforeEach` and `afterAll` are now unused in that file; `pnpm lint:fix` removes
the dead imports. `TEST_DATABASE_URL` and `resetDatabase` may also become unused — check with
`pnpm lint` and let `lint:fix` clean up.

In `harness/approvals/src/testing.ts`, do the same: delete the `useTestDb` function and its
`createDb`/`vitest` imports, and replace them with

```ts
export { useTestDb } from '@harness/db/testing';
```

Every `import { ..., useTestDb } from './testing.js'` in both packages keeps working
unchanged, so no test file is touched.

- [ ] **Step 11: Write the README**

Create `harness/db/README.md`:

````markdown
# @harness/db

Schema, migrations, the connection pool and the encryption primitives. Everything else in the
workspace sits above this package; it imports nothing from the workspace itself.

## Layout

```
src/shared/crypto.ts    AES-256-GCM encrypt/decrypt, key loading
src/shared/log.ts       a scoped stderr logger (local: importing core-tools would be a cycle)
src/domain/schema.ts    every table, index and constraint — the drizzle-kit source of truth
src/domain/client.ts    createDb, withTransaction, the Db type
src/domain/migrate.ts   runMigrations
src/app/migrate.ts      the `pnpm --filter @harness/db migrate` entrypoint
src/index.ts            the public API
src/testing.ts          ./testing: TEST_DATABASE_URL, resetDatabase, useTestDb
```

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
````

- [ ] **Step 12: Prove no migration appeared**

```bash
cd harness/db && pnpm drizzle-kit generate; cd ../..
```
Expected: `No schema changes, nothing to migrate 😴`. Anything else means
`drizzle.config.ts` still points at the old schema path — fix it and, if a migration file was
written, delete it and revert `harness/db/drizzle/meta/_journal.json`.

```bash
git status --porcelain harness/db/drizzle
```
Expected: no output.

- [ ] **Step 13: Promote `@harness/db` to error severity**

In `eslint.config.js`:

```js
const STRICT_LAYER_ROOTS = ['harness/db/src'];
```

In `.dependency-cruiser.cjs`, one word on one row:

```js
  { name: 'db', src: 'harness/db/src', severity: 'error' },
```

- [ ] **Step 14: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
pnpm lint
```
Expected: no errors under `harness/db/`. Warnings elsewhere are expected and fine.

```bash
pnpm arch
```
Expected: `0 errors`. If `db-...` rules report errors, a file is importing upward; fix the
import, not the severity.

```bash
pnpm -r test
```
Expected: 7 packages pass, 528 tests (525 after Task 1, plus the three logger tests).

- [ ] **Step 15: Commit**

```bash
git add harness/db harness/core-tools/src/testing.ts harness/approvals/src/testing.ts eslint.config.js .dependency-cruiser.cjs
git commit -m "refactor(db): adopt the shared/domain/app layout and own the single useTestDb"
```

---
### Task 3: `@harness/gateway` — the layout and the README

The gateway package has no `src/` at all today: four files sit at the package root. It is
small, it has one consumer (`@harness/core-tools` imports `@harness/gateway/routing`), and it
is the last package before core-tools starts moving.

**Files:**
- Move: `harness/gateway/routing.schema.ts` → `harness/gateway/src/domain/routing/types.ts`, then split `parseRouting` out into `harness/gateway/src/domain/routing/parse.ts`
- Move: `harness/gateway/render-config.ts` → `harness/gateway/src/domain/routing/render.ts`, then split `renderClientConfig` and the CLI out into `harness/gateway/src/app/render-config.ts`
- Move: `harness/gateway/render-config.test.ts` → `harness/gateway/src/domain/routing/render.test.ts`, then split `describe('routing.schema')` out into `harness/gateway/src/domain/routing/parse.test.ts`
- Create: `harness/gateway/src/index.ts`
- Modify: `harness/gateway/package.json`, `harness/gateway/tsconfig.json`, `harness/gateway/README.md`
- Modify: `eslint.config.js`, `.dependency-cruiser.cjs` (one entry each)
- Unmoved on purpose: `harness/gateway/litellm.config.yaml` (Compose bind-mounts it at that exact path), `harness/gateway/vitest.config.ts`

**Interfaces:**
- Consumes: nothing from Tasks 1–2 beyond the tooling.
- Produces:
  - From `@harness/gateway/routing` (unchanged specifier, new target `./src/domain/routing/types.ts`): `ROUTES: readonly ['chat','extract','reason','judge']`, `type Route`, `RouteSpec` (zod object and inferred type), `RoutingFile` (zod object and inferred type). `@harness/core-tools`'s models domain imports `ROUTES` and `type Route` from here in Task 6 exactly as `models.ts` does today.
  - From `@harness/gateway`: `parseRouting(yamlText: string): RoutingFile`, `apiKeyEnvFor(model: string): string`, `renderLiteLlmConfig(routing: RoutingFile): string`, and everything `./routing` exports.
  - Not exported: `renderClientConfig(client: string): Promise<string>` stays in `app/` and is reachable only through `pnpm gateway:config`.

---

- [ ] **Step 1: Create the tree and move the three files**

```bash
cd harness/gateway
mkdir -p src/domain/routing src/app
git mv routing.schema.ts src/domain/routing/types.ts
git mv render-config.ts src/domain/routing/render.ts
git mv render-config.test.ts src/domain/routing/render.test.ts
cd ../..
```

- [ ] **Step 2: Split `parseRouting` out of `types.ts`**

Delete this block from the end of `src/domain/routing/types.ts`:

```ts
export function parseRouting(yamlText: string): RoutingFile {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = RoutingFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`routing.yaml is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
```

and delete the now-unused `import { parse as parseYaml } from 'yaml';` from its top. The file
keeps `ROUTES`, `Route`, `RouteSpec` and `RoutingFile`, and its header comment becomes:

```ts
/**
 * The four named routes from spec section 4.2. Callers ask for a *job*
 * (`extract`), never a provider, so a routing change is a config change.
 * This is the single definition; @harness/core-tools imports it through the
 * `@harness/gateway/routing` subpath.
 */
```

Create `src/domain/routing/parse.ts`:

```ts
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { RoutingFile } from './types.js';

/**
 * Parse a client's routing.yaml, or fail with the whole list of problems rather than the
 * first one. `z.prettifyError` is what turns a zod issue tree into something an operator can
 * act on; the CLI prints it verbatim.
 */
export function parseRouting(yamlText: string): RoutingFile {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = RoutingFile.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`routing.yaml is invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
```

- [ ] **Step 3: Split the CLI out of `render.ts`**

Delete everything from `const here = path.dirname(...)` to the end of
`src/domain/routing/render.ts` — that is `here`, `repoRoot`, `renderClientConfig` and the
`if (process.argv[1] ...)` block — and delete the three now-unused imports at its top:
`readFile`, `writeFile` and `fileURLToPath`. The first line becomes:

```ts
import path from 'node:path';
```

`path` is still used by nothing in the remaining file, so delete that too; `pnpm lint:fix`
will tell you. What is left is `PROVIDER_KEY_ENV`, `apiKeyEnvFor`, `Deployment`, `deployment`,
`HEADER` and `renderLiteLlmConfig`, with `import { stringify as stringifyYaml } from 'yaml';`
and `import { ROUTES, type RoutingFile } from './types.js';` at the top.

Create `src/app/render-config.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouting } from '../domain/routing/parse.js';
import { renderLiteLlmConfig } from '../domain/routing/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// harness/gateway/src/app -> harness/gateway
const packageRoot = path.resolve(here, '../..');
// harness/gateway/src/app -> the repository root
const repoRoot = path.resolve(here, '../../../..');

/**
 * Render one client's routing table into the LiteLLM config the Compose service mounts.
 *
 * The target stays at the package root, not beside this file: `docker-compose.yml` bind-mounts
 * `../gateway/litellm.config.yaml` and that path is part of the deployment, not of the source
 * layout.
 */
export async function renderClientConfig(client: string): Promise<string> {
  const source = path.join(repoRoot, 'clients', client, 'routing.yaml');
  const target = path.join(packageRoot, 'litellm.config.yaml');
  const routing = parseRouting(await readFile(source, 'utf8'));
  await writeFile(target, renderLiteLlmConfig(routing), 'utf8');
  return target;
}

const client = process.env.HARNESS_CLIENT ?? 'demo-practice';
renderClientConfig(client)
  .then((target) => {
    console.log(`rendered ${client} routing to ${target}`);
  })
  .catch((err: unknown) => {
    // parseRouting exists to turn an invalid routing.yaml into a readable
    // z.prettifyError listing. Without this, the rejection went unhandled
    // and the operator got a stack trace with that listing buried in it.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
```

The `if (process.argv[1] ...)` guard is gone: nothing imports this file any more, so it is
unconditionally an entrypoint. `console.log` is correct here and ESLint allows it — this is
`app/`, and the rendered path is the command's output, so it belongs on stdout.

- [ ] **Step 4: Split the test**

`src/domain/routing/render.test.ts` keeps `describe('apiKeyEnvFor')` and
`describe('renderLiteLlmConfig')`. Its imports become:

```ts
import { describe, it, expect } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseRouting } from './parse.js';
import { ROUTES } from './types.js';
import { apiKeyEnvFor, renderLiteLlmConfig } from './render.js';
```

Move `describe('routing.schema', ...)` — lines 23 to 49 of the original file, unchanged
assertions and all — into a new `src/domain/routing/parse.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { parseRouting } from './parse.js';
import { ROUTES } from './types.js';

// <the describe('routing.schema') block, moved verbatim>
```

Drop from each file whichever of `parseYaml`, `ROUTES` or `parseRouting` it no longer uses;
`pnpm lint` names them.

- [ ] **Step 5: Write the public API**

Create `src/index.ts`:

```ts
export { ROUTES, RouteSpec, RoutingFile, type Route } from './domain/routing/types.js';
export { parseRouting } from './domain/routing/parse.js';
export { apiKeyEnvFor, renderLiteLlmConfig } from './domain/routing/render.js';
```

`renderClientConfig` is deliberately absent: it writes a file at a fixed path and reads the
`clients/` tree, which is composition-root work.

- [ ] **Step 6: Point `package.json` and `tsconfig.json` at `src/`**

`harness/gateway/package.json`:

```json
{
  "name": "@harness/gateway",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./routing": "./src/domain/routing/types.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "render": "tsx src/app/render-config.ts"
  },
  "dependencies": {
    "yaml": "^2.9.1",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "tsx": "^4.23.13",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

`harness/gateway/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

The root `gateway:config` script still reads `pnpm --filter @harness/gateway render`, so it
needs no change. `@harness/core-tools/src/models.ts` still reads
`import { ROUTES, type Route } from '@harness/gateway/routing';` — the specifier is unchanged
and only its target moved, which is the point of a subpath export.

- [ ] **Step 7: Prove the renderer still writes the same bytes**

The generated config is committed, so the check is that regenerating it produces no diff.

```bash
pnpm gateway:config
```
Expected: `rendered demo-practice routing to /…/harness/gateway/litellm.config.yaml`

```bash
git status --porcelain harness/gateway/litellm.config.yaml
```
Expected: no output. Anything else means the renderer changed or the target path is wrong.

- [ ] **Step 8: Rewrite the README**

Replace `harness/gateway/README.md` with:

````markdown
# @harness/gateway

The model routing table and the LiteLLM config renderer. Every model call in the harness names
a *job* — `chat`, `extract`, `reason`, `judge` — never a provider, so switching providers is a
change to `clients/<name>/routing.yaml` and nothing else.

## Layout

```
src/domain/routing/types.ts   ROUTES, Route, RouteSpec, RoutingFile — the zod schema
src/domain/routing/parse.ts   parseRouting: routing.yaml -> RoutingFile, with a readable error
src/domain/routing/render.ts  apiKeyEnvFor, renderLiteLlmConfig: RoutingFile -> LiteLLM YAML
src/app/render-config.ts      the `pnpm gateway:config` entrypoint
src/index.ts                  the public API
litellm.config.yaml           GENERATED. Compose bind-mounts this exact path; do not move it.
```

## Public API

`@harness/gateway` exports `ROUTES`, `type Route`, `RouteSpec`, `RoutingFile`, `parseRouting`,
`apiKeyEnvFor` and `renderLiteLlmConfig`. `@harness/gateway/routing` is the routing types on
their own; `@harness/core-tools` imports `ROUTES` from there so that the harness and the proxy
can never disagree about which routes exist.

The rendered config never contains a key — only `os.environ/NAME` references — which is why it
is safe to commit. `RouteSpec` is `.strict()` so that an inline `api_key:` in a routing file
fails loudly instead of being dropped.

## Testing

```bash
pnpm --filter @harness/gateway test
```

No database, no network. `pnpm gateway:config` regenerates `litellm.config.yaml`; if
`git status` is dirty afterwards, either the renderer or the client's routing table changed,
and the diff says which.
````

- [ ] **Step 9: Promote `@harness/gateway` to error severity**

`eslint.config.js`:

```js
const STRICT_LAYER_ROOTS = ['harness/db/src', 'harness/gateway/src'];
```

`.dependency-cruiser.cjs`:

```js
  { name: 'gateway', src: 'harness/gateway/src', severity: 'error' },
```

- [ ] **Step 10: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
pnpm lint
```
Expected: no errors under `harness/gateway/` or `harness/db/`.

```bash
pnpm arch
```
Expected: `0 errors`.

```bash
pnpm -r test
```
Expected: 7 packages pass, 528 tests. The gateway's own count is unchanged — the file split
moved describes, it did not add or remove a single `it`.

- [ ] **Step 11: Commit**

```bash
git add harness/gateway eslint.config.js .dependency-cruiser.cjs
git commit -m "refactor(gateway): adopt the domain/app layout behind src/"
```

---
### Task 4: `@harness/core-tools` — the `shared/` layer, with every caller switched

Ten modules, each the single home of a concern that is currently reinvented per file. Nothing
moves out of `src/` yet; this task only creates `src/shared/` and rewires the callers inside
core-tools. Tasks 8, 9 and 10 switch the other packages once the public API exists.

**Files:**
- Create: `harness/core-tools/src/shared/env.ts`, `errors.ts`, `paths.ts`, `log.ts`, `subprocess.ts`, `jsonl.ts`, `csv.ts`
- Create: `harness/core-tools/src/shared/redaction/patterns.ts`, `names.ts`, `text.ts`
- Create: `harness/core-tools/src/shared/errors.test.ts`, `paths.test.ts`, `log.test.ts`, `subprocess.test.ts`, `jsonl.test.ts`
- Move: `harness/core-tools/src/server.test.ts` → `harness/core-tools/src/shared/env.test.ts`
- Move: `harness/core-tools/src/forms/roster.test.ts` `describe('csvCell')` → `harness/core-tools/src/shared/csv.test.ts`
- Move: `harness/core-tools/src/tools/providers.test.ts` `describe('isRestrictedName')` → `harness/core-tools/src/shared/redaction/names.test.ts`
- Move: `harness/core-tools/src/documents/redact.test.ts` → **split** into `harness/core-tools/src/shared/redaction/patterns.test.ts` and `text.test.ts`
- Delete: `harness/core-tools/src/documents/redact.ts` (its contents move into `shared/redaction/`)
- Modify: `src/server.ts`, `src/registry.ts`, `src/models.ts`, `src/policy.ts`, `src/storage.ts`, `src/effects.ts`, `src/documents/storage.ts`, `src/documents/text.ts`, `src/documents/extract.ts`, `src/forms/roster.ts`, `src/forms/fill.ts`, `src/tools/providers.ts`, `src/tools/harness.ts`, `src/tools/documents.ts`
- Modify: `harness/core-tools/package.json` (no new dependency; only the note below)

**Interfaces:**
- Consumes: `useTestDb` from `@harness/db/testing` (Task 2).
- Produces, all re-exported from `@harness/core-tools` at the end of this task so Tasks 8–10 can reach them:

  ```ts
  // shared/errors.ts
  class ToolError extends Error { constructor(message: string) }
  class ModelOutputError extends ToolError { constructor(route: string, detail: string) }
  class ConfigError extends Error { constructor(message: string) }
  function describeError(err: unknown): string

  // shared/env.ts
  interface NumberEnvOptions { min: number; max: number; integer?: boolean; unit?: string }
  function numberFromEnv(name: string, fallback: number, options: NumberEnvOptions): number
  function booleanFromEnv(name: string, env?: NodeJS.ProcessEnv): boolean
  function requiredEnv(name: string, hint?: string, env?: NodeJS.ProcessEnv): string
  function optionalEnv(name: string, env?: NodeJS.ProcessEnv): string | undefined

  // shared/paths.ts
  type EscapeReason = 'lexical' | 'real' | 'unreadable'
  interface InsideRootOptions { allowRoot?: boolean; onUnreadable?: 'rethrow' | 'escape' }
  function realOrNearestAncestor(target: string): Promise<string>
  function assertInsideRoot(candidate: string, root: string, onEscape: (reason: EscapeReason) => never, options?: InsideRootOptions): Promise<string>

  // shared/log.ts
  interface Logger { info(message: string, err?: unknown): void; warn(message: string, err?: unknown): void; error(message: string, err?: unknown): void }
  function createLogger(scope: string): Logger

  // shared/subprocess.ts
  interface RunBoundedOptions { timeoutMs: number; cwd?: string; maxBuffer?: number }
  type RunBoundedOutcome = { ok: true; stdout: string; stderr: string } | { ok: false; reason: 'timeout' | 'failed' }
  function runBounded(command: string, args: string[], options: RunBoundedOptions): Promise<RunBoundedOutcome>

  // shared/jsonl.ts
  interface JsonlRow<T> { value: T; line: number }
  function readJsonl<T>(file: string, label?: string): Promise<JsonlRow<T>[]>
  function writeJsonl(file: string, rows: readonly unknown[]): Promise<void>

  // shared/csv.ts
  function csvCell(value: string | null | undefined): string

  // shared/redaction/patterns.ts
  type RestrictedKind = 'ssn' | 'ein' | 'dea'
  interface RestrictedPattern { kind: RestrictedKind; regex: RegExp; toValue: (raw: string) => string; accept: (raw: string) => boolean; identity: (value: string) => string }
  const RESTRICTED_PATTERNS: RestrictedPattern[]
  function containsRestrictedPattern(text: string): boolean
  function isValidDea(candidate: string): boolean

  // shared/redaction/names.ts
  const MASKED = '[restricted]'
  function isRestrictedName(name: string): boolean

  // shared/redaction/text.ts
  interface RedactablePage { num: number; text: string }
  interface RedactionHit { kind: RestrictedKind; value: string; token: string; fieldName: string; page: number }
  interface RedactedText { pages: RedactablePage[]; hits: RedactionHit[] }
  function fieldNameFor(kind: RestrictedKind, ordinal: number): string
  function redactPages(pages: readonly RedactablePage[]): RedactedText
  function assertRedacted(text: string): void
  ```

**Two error messages change, and nothing reads either one.** `shared/env.ts` has one wording,
so `HARNESS_GATEWAY_MAX_CALLS_PER_RUN must be a whole number between 1 and 10000` becomes
`... must be an integer between ...`, and approvals' `APPROVALS_POLL_SECONDS must be between
1 and 86400 seconds` becomes `... must be a number between 1 and 86400 seconds`. Both are
startup-failure strings; `grep -rn "whole number" .` and the `gatewayFromEnv` describe in
`models.test.ts` confirm no test, no document and no runbook quotes either. Every other
message — including `must be a number between 1 and 720`, which `server.test.ts` does assert —
comes out byte-identical.

---

- [ ] **Step 1: Write the errors module**

No failing-test-first here: `ToolError` and `ModelOutputError` are existing code being moved,
and their behaviour is already covered by `registry.test.ts` and `models.test.ts`. Only
`ConfigError` and `describeError` are new, and Step 2 tests them.

Create `harness/core-tools/src/shared/errors.ts`:

```ts
/**
 * The only three error types this codebase raises deliberately. Everything else is a plain
 * `Error`, which the tooling kernel masks before it can reach an agent — see `runAuto`.
 *
 * The distinction is not stylistic. A raw error message can carry a provider's name, a row id
 * or a restricted identifier, so the kernel replaces it with "internal error; see audit log"
 * and keeps the real one in `audit_log.error`. A `ToolError` is the author saying "this
 * message is safe and the caller can act on it".
 */

/** An expected failure the caller can do something about. Its message reaches the agent. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolError';
  }
}

/**
 * The model's output failed to parse as JSON, or parsed but did not match the caller's zod
 * schema. Gateway-side `strict: true` on the response schema is a request, not a guarantee
 * every provider honors, so this is checked again on this side. The message carries only the
 * zod issue paths and zod's own type-name wording, never a value from the reply, which may
 * contain document text — so, unlike most failures, it is safe to surface to the agent, which
 * needs the field detail to have any chance of recovering. A `ToolError` subclass for exactly
 * that reason: only a `ToolError`'s message reaches the caller.
 */
export class ModelOutputError extends ToolError {
  constructor(route: string, detail: string) {
    super(`model output invalid on route ${route}: ${detail}`);
    this.name = 'ModelOutputError';
  }
}

/**
 * The process is misconfigured and must not start. Raised only from `shared/env.ts` and from
 * `app/`, never from a handler: by the time a tool runs, configuration is settled.
 */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

/**
 * The message of whatever was thrown, for a log line or an audit row. One definition, because
 * `err instanceof Error ? err.message : String(err)` was written out at 30-odd call sites and
 * two of them had already drifted into printing the whole error object.
 */
export function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
```

- [ ] **Step 2: Write the failing tests for the new helpers**

Create `harness/core-tools/src/shared/errors.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { ConfigError, ModelOutputError, ToolError, describeError } from './errors.js';

describe('the three error types', () => {
  it('names itself, so an audit row says which kind it was', () => {
    expect(new ToolError('nope').name).toBe('ToolError');
    expect(new ConfigError('nope').name).toBe('ConfigError');
    expect(new ModelOutputError('extract', 'npi: expected string').name).toBe('ModelOutputError');
  });

  it('makes ModelOutputError a ToolError, so its message reaches the agent', () => {
    expect(new ModelOutputError('extract', 'npi: expected string')).toBeInstanceOf(ToolError);
    expect(new ModelOutputError('extract', 'npi: expected string').message).toBe(
      'model output invalid on route extract: npi: expected string',
    );
  });

  it('keeps ConfigError out of the ToolError family, so the kernel never surfaces it', () => {
    expect(new ConfigError('HARNESS_STORAGE_DIR must be set')).not.toBeInstanceOf(ToolError);
  });
});

describe('describeError', () => {
  it('takes an Error apart to its message', () => {
    expect(describeError(new Error('boom'))).toBe('boom');
  });

  it('stringifies anything else rather than printing [object Object]', () => {
    expect(describeError('boom')).toBe('boom');
    expect(describeError(42)).toBe('42');
    expect(describeError(null)).toBe('null');
  });
});
```

- [ ] **Step 3: Run it and watch it pass**

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/errors.test.ts
```
Expected: `Tests 5 passed`. (These pass on the first run because Step 1 already wrote the
module — the moved classes had to move as a unit with their consumers, and writing a failing
test for `class ToolError extends Error {}` would be theatre.)

- [ ] **Step 4: Write the environment module**

Create `harness/core-tools/src/shared/env.ts`:

```ts
import { ConfigError } from './errors.js';

/**
 * The environment is read here and in `app/`, nowhere else; ESLint enforces it. A domain that
 * needs a value takes it as a parameter, or calls one of these — calling is fine anywhere,
 * because the ban is on the `process.env` syntax and not on the value.
 *
 * One reader per kind, so no variable can be validated more loosely than its neighbour. The
 * bug that motivated `booleanFromEnv` is in its own comment below.
 */

export interface NumberEnvOptions {
  min: number;
  max: number;
  /** Reject a fractional value. Ports and counts; not thresholds. */
  integer?: boolean;
  /** Appended to the failure message, e.g. `seconds`. */
  unit?: string;
}

/**
 * Read a numeric variable, falling back when it is unset or empty. A present but unparseable
 * or out-of-range value is a configuration error and fails startup rather than silently
 * becoming `NaN` — an unvalidated typo in a port makes `listen(NaN)` pick an arbitrary free
 * port, and the process then looks healthy while nothing can reach it.
 */
export function numberFromEnv(name: string, fallback: number, options: NumberEnvOptions): number {
  const { min, max, integer = false, unit } = options;
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  const wellFormed = integer ? Number.isInteger(value) : Number.isFinite(value);
  if (!wellFormed || value < min || value > max) {
    throw new ConfigError(
      `${name} must be ${integer ? 'an integer' : 'a number'} between ${min} and ${max}${unit ? ` ${unit}` : ''}`,
    );
  }
  return value;
}

/**
 * Read a boolean variable. `true` and `1` are on; everything else — unset, empty, `false`,
 * `0`, `no`, a typo — is off. Case and surrounding whitespace are ignored.
 *
 * Every flag goes through this one helper so none can be read differently from another.
 * Before it, `VERIFY_NPPES_ENABLED` alone disabled on the literal `'false'` while its
 * neighbours enabled on the literal `'true'`, so `VERIFY_NPPES_ENABLED=0` left outbound
 * registry lookups switched on while the same spelling switched everything else off. Every
 * one of these defaults to off: a deployment that sets nothing makes no outbound calls and
 * sends nothing restricted to a model.
 */
export function booleanFromEnv(name: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env[name]?.trim().toLowerCase();
  return raw === 'true' || raw === '1';
}

/**
 * Read a variable that has no sensible default, or fail startup naming it. An empty string
 * counts as unset, or a half-filled `.env` starts a process that fails later and further from
 * the cause.
 *
 * `env` is a parameter because `coreToolsChildEnv` in @harness/approvals reads an environment
 * it is handed rather than its own, and its tests pass a fixture.
 */
export function requiredEnv(name: string, hint = '', env: NodeJS.ProcessEnv = process.env): string {
  const value = env[name];
  if (!value || value.trim() === '') throw new ConfigError(`${name} is not set${hint}`);
  return value;
}

/** A variable with no default and no requirement. An empty string reads as absent. */
export function optionalEnv(name: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = env[name];
  return value === undefined || value.trim() === '' ? undefined : value;
}
```

- [ ] **Step 5: Move the environment tests and extend them**

```bash
cd harness/core-tools
git mv src/server.test.ts src/shared/env.test.ts
sed -i '' "s#from './server.js'#from './env.js'#" src/shared/env.test.ts
cd ../..
```

The moved file's two describes — `numberFromEnv` and `booleanFromEnv` — keep every assertion
exactly as written, including `` `${NAME} must be a number between 1 and 720` ``, which is why
the unified wording had to produce that string verbatim for the no-integer, no-unit case.

Append the new coverage to `src/shared/env.test.ts`:

```ts
describe('numberFromEnv with integer and unit', () => {
  it('rejects a fractional value when integer is set', () => {
    process.env[NAME] = '8787.5';
    expect(() => numberFromEnv(NAME, 8787, { min: 1, max: 65_535, integer: true })).toThrow(
      `${NAME} must be an integer between 1 and 65535`,
    );
  });

  it('names the unit in the failure', () => {
    process.env[NAME] = '0';
    expect(() => numberFromEnv(NAME, 5, { min: 1, max: 86_400, unit: 'seconds' })).toThrow(
      `${NAME} must be a number between 1 and 86400 seconds`,
    );
  });
});

describe('requiredEnv', () => {
  it('returns the value', () => {
    process.env[NAME] = 'sk-test';
    expect(requiredEnv(NAME)).toBe('sk-test');
  });

  it('treats an empty or whitespace value as unset and appends the hint', () => {
    process.env[NAME] = '   ';
    expect(() => requiredEnv(NAME, ' (see docs/runbook.md)')).toThrow(`${NAME} is not set (see docs/runbook.md)`);
  });

  it('reads an environment it is handed, so a caller can validate a child process env', () => {
    expect(requiredEnv(NAME, '', { [NAME]: 'from-a-fixture' })).toBe('from-a-fixture');
    expect(() => requiredEnv(NAME, '', {})).toThrow(`${NAME} is not set`);
  });
});

describe('optionalEnv', () => {
  it('is undefined when unset or empty, and the value otherwise', () => {
    expect(optionalEnv(NAME)).toBeUndefined();
    process.env[NAME] = '  ';
    expect(optionalEnv(NAME)).toBeUndefined();
    process.env[NAME] = '/srv/harness-storage';
    expect(optionalEnv(NAME)).toBe('/srv/harness-storage');
  });
});
```

and widen the import at the top of the file to
`import { booleanFromEnv, numberFromEnv, optionalEnv, requiredEnv } from './env.js';`.

- [ ] **Step 6: Run the environment tests**

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/env.test.ts
```
Expected: `Tests 22 passed` — the 16 that moved (`it.each` counts one per case: four numeric, one plus four plus seven boolean) plus the 6 above.

- [ ] **Step 7: Write the paths module**

Create `harness/core-tools/src/shared/paths.ts`:

```ts
import { realpath } from 'node:fs/promises';
import path from 'node:path';

/**
 * Resolve symlinks in `target`, walking up to the nearest existing ancestor when `target`
 * itself does not exist yet and re-appending the remaining segments untouched (a path segment
 * that does not exist cannot itself be a symlink, so this is safe).
 */
export async function realOrNearestAncestor(target: string): Promise<string> {
  const remainder: string[] = [];
  let current = target;
  for (;;) {
    try {
      const real = await realpath(current);
      return remainder.length > 0 ? path.join(real, ...remainder) : real;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const parent = path.dirname(current);
      if (parent === current) throw err; // reached the filesystem root; give up
      remainder.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Why a candidate was refused. Callers map these onto their own error wording. */
export type EscapeReason = 'lexical' | 'real' | 'unreadable';

export interface InsideRootOptions {
  /** Whether `candidate` resolving to `root` itself counts as inside it. Default true. */
  allowRoot?: boolean;
  /**
   * What to do when `realpath` fails for a reason other than a missing path — ELOOP, EACCES,
   * ENOTDIR. `'rethrow'` (the default) propagates the original error, which is what the two
   * storage callers want, because the errno message never reaches a caller. `'escape'` reports
   * it through `onEscape`, for the Slack sink, whose failures land in a plaintext column and
   * must never quote a path.
   */
  onUnreadable?: 'rethrow' | 'escape';
}

/**
 * The single containment primitive for the whole file store: three implementations of this
 * check used to sit in three files, and the one in the Slack sink had already drifted.
 *
 * Both the lexical path and the symlink-resolved path are compared, and both are necessary.
 * Lexical alone is not enough because every reader here follows symlinks: a link planted under
 * the root passes `path.relative` and then serves whatever it points at. Real-path alone is not
 * enough either, because the target may not exist yet.
 *
 * The separator in `realRoot + path.sep` matters: `${realRoot}-evil` starts with `realRoot` and
 * is not inside it.
 *
 * `onEscape` must throw. It is typed `never` so that TypeScript narrows after a call, and
 * `fail` below turns a caller that returns anyway into a loud failure rather than a silently
 * approved path.
 */
export async function assertInsideRoot(
  candidate: string,
  root: string,
  onEscape: (reason: EscapeReason) => never,
  options: InsideRootOptions = {},
): Promise<string> {
  const { allowRoot = true, onUnreadable = 'rethrow' } = options;
  const fail = (reason: EscapeReason): never => {
    onEscape(reason);
    throw new Error(`assertInsideRoot: onEscape returned for "${reason}"; it must throw`);
  };

  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) fail('lexical');
  if (!allowRoot && rel === '') fail('lexical');

  let realRoot: string;
  let realResolved: string;
  try {
    realRoot = await realOrNearestAncestor(resolvedRoot);
    realResolved = await realOrNearestAncestor(resolved);
  } catch (err) {
    if (onUnreadable === 'rethrow') throw err;
    return fail('unreadable');
  }

  if (!allowRoot && realResolved === realRoot) fail('real');
  if (realResolved !== realRoot && !realResolved.startsWith(realRoot + path.sep)) fail('real');
  return resolved;
}
```

- [ ] **Step 8: Write the failing paths test**

Create `harness/core-tools/src/shared/paths.test.ts`:

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { assertInsideRoot, realOrNearestAncestor } from './paths.js';

let root: string;
let outside: string;

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-paths-root-'));
  outside = await mkdtemp(path.join(tmpdir(), 'harness-paths-outside-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

const refuse = (reason: string): never => {
  throw new Error(`refused: ${reason}`);
};

describe('realOrNearestAncestor', () => {
  it('resolves a path that does not exist yet by walking up to one that does', async () => {
    const deep = path.join(root, 'a', 'b', 'c.txt');
    expect(await realOrNearestAncestor(deep)).toBe(path.join(await realOrNearestAncestor(root), 'a', 'b', 'c.txt'));
  });
});

describe('assertInsideRoot', () => {
  it('accepts a path under the root and returns it resolved', async () => {
    await mkdir(path.join(root, 'out'), { recursive: true });
    expect(await assertInsideRoot('out/file.pdf', root, refuse)).toBe(path.join(root, 'out', 'file.pdf'));
  });

  it('refuses a traversal lexically, before touching the filesystem', async () => {
    await expect(assertInsideRoot('../escape.txt', root, refuse)).rejects.toThrow('refused: lexical');
  });

  it('refuses a sibling whose name merely starts with the root', async () => {
    await expect(assertInsideRoot(`${root}-evil/file`, root, refuse)).rejects.toThrow('refused: lexical');
  });

  it('refuses a symlink that lexically sits inside but points out', async () => {
    await writeFile(path.join(outside, 'secret.txt'), 'x', 'utf8');
    await symlink(path.join(outside, 'secret.txt'), path.join(root, 'link.txt'));
    await expect(assertInsideRoot('link.txt', root, refuse)).rejects.toThrow('refused: real');
  });

  it('accepts the root itself by default and refuses it when allowRoot is false', async () => {
    expect(await assertInsideRoot('.', root, refuse)).toBe(root);
    await expect(assertInsideRoot('.', root, refuse, { allowRoot: false })).rejects.toThrow('refused: lexical');
  });

  it('reports an unreadable path through onEscape only when asked to', async () => {
    const loop = path.join(root, 'loop');
    await symlink(loop, loop);
    await expect(assertInsideRoot('loop', root, refuse, { onUnreadable: 'escape' })).rejects.toThrow(
      'refused: unreadable',
    );
    // The default propagates the original errno error instead, so a caller that can safely
    // surface it keeps the detail.
    await expect(assertInsideRoot('loop', root, refuse)).rejects.toThrow(/ELOOP/);
  });

  it('turns an onEscape that forgets to throw into a loud failure', async () => {
    await expect(
      assertInsideRoot('../escape.txt', root, (() => undefined) as unknown as (reason: string) => never),
    ).rejects.toThrow('it must throw');
  });
});
```

- [ ] **Step 9: Run it**

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/paths.test.ts
```
Expected: `Tests 8 passed`.

- [ ] **Step 10: Write the logger**

Create `harness/core-tools/src/shared/log.ts`. Identical in shape to `@harness/db`'s copy —
see ARCHITECTURE.md for why there are two — but this one is exported from the public API and
is what `@harness/approvals`, `@harness/evals` and the pack use.

```ts
import { describeError } from './errors.js';

/**
 * The one place `console` is allowed outside a process entrypoint.
 *
 * Two rules the call sites depend on. First, everything goes to **stderr**: this package runs
 * as an MCP server over stdio, so anything on stdout corrupts the protocol frame. Second, a
 * log line carries a message and at most an error's message — never a payload, never a row,
 * never a stack. A restricted identifier that reaches a log has escaped every other guard.
 */
export interface Logger {
  info(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  error(message: string, err?: unknown): void;
}

function line(scope: string, message: string, err: unknown): string {
  return err === undefined ? `${scope}: ${message}` : `${scope}: ${message}: ${describeError(err)}`;
}

/** A logger that prefixes every line with `scope`, e.g. `createLogger('effects')`. */
export function createLogger(scope: string): Logger {
  const write = (message: string, err: unknown): void => {
    // eslint-disable-next-line no-console -- this module is the one place console is allowed
    console.error(line(scope, message, err));
  };
  return {
    info: (message, err) => write(message, err),
    warn: (message, err) => write(message, err),
    error: (message, err) => write(message, err),
  };
}
```

Create `harness/core-tools/src/shared/log.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createLogger } from './log.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('createLogger', () => {
  it('writes to stderr, never stdout, because stdio carries the MCP frame', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const out = vi.spyOn(console, 'log').mockImplementation(() => {});
    createLogger('effects').info('dispatched 3');
    expect(err).toHaveBeenCalledWith('effects: dispatched 3');
    expect(out).not.toHaveBeenCalled();
  });

  it('appends an error message and nothing else from the error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    const thrown = new Error('connection refused');
    createLogger('effects').error('dispatch failed', thrown);
    expect(err).toHaveBeenCalledWith('effects: dispatch failed: connection refused');
    expect(err.mock.calls[0][0]).not.toContain(thrown.stack?.split('\n')[1] ?? 'at ');
  });

  it('describes a thrown non-Error', () => {
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    createLogger('effects').warn('odd', { sink: 'slack' });
    expect(err).toHaveBeenCalledWith('effects: odd: [object Object]');
  });
});
```

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/log.test.ts
```
Expected: `Tests 3 passed`.

- [ ] **Step 11: Write the subprocess module**

Create `harness/core-tools/src/shared/subprocess.ts`:

```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface RunBoundedOptions {
  /** Hard ceiling. The child is SIGKILLed, not SIGTERMed, so a wedged binary cannot ignore it. */
  timeoutMs: number;
  cwd?: string;
  maxBuffer?: number;
}

/**
 * Deliberately no stdout on the failure branch. `tesseract` and `pdftoppm` print fragments of
 * the page they were reading, and a caller that pasted that into an error message would put
 * document text into `audit_log.error`. Callers map `reason` onto their own fixed wording.
 */
export type RunBoundedOutcome =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; reason: 'timeout' | 'failed' };

/**
 * True when `execFile` rejected because the process was killed for running past its `timeout`,
 * rather than failing on its own. Node sets `killed` only when something sent the process a
 * signal, and `killSignal: 'SIGKILL'` below is the only thing that does, so this is unambiguous.
 */
function isTimeout(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { killed?: boolean }).killed === true;
}

/**
 * Run a child process with a hard time limit. The three `execFile` wrappers this replaces
 * (OCR, the synthetic corpus rasteriser, the form-template builder) each reimplemented the
 * timeout plumbing, and only one of them set `killSignal`.
 */
export async function runBounded(
  command: string,
  args: string[],
  options: RunBoundedOptions,
): Promise<RunBoundedOutcome> {
  try {
    const { stdout, stderr } = await run(command, args, {
      timeout: options.timeoutMs,
      killSignal: 'SIGKILL',
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.maxBuffer === undefined ? {} : { maxBuffer: options.maxBuffer }),
    });
    return { ok: true, stdout, stderr };
  } catch (err) {
    return { ok: false, reason: isTimeout(err) ? 'timeout' : 'failed' };
  }
}
```

Create `harness/core-tools/src/shared/subprocess.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { runBounded } from './subprocess.js';

describe('runBounded', () => {
  it('returns stdout on success', async () => {
    const outcome = await runBounded('node', ['-e', 'process.stdout.write("hello")'], { timeoutMs: 10_000 });
    expect(outcome).toEqual({ ok: true, stdout: 'hello', stderr: '' });
  });

  it('reports a non-zero exit as failed, with no output attached', async () => {
    const outcome = await runBounded('node', ['-e', 'process.stdout.write("secret"); process.exit(3)'], {
      timeoutMs: 10_000,
    });
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
  });

  it('reports a missing binary as failed rather than throwing ENOENT', async () => {
    const outcome = await runBounded('harness-no-such-binary', [], { timeoutMs: 10_000 });
    expect(outcome).toEqual({ ok: false, reason: 'failed' });
  });

  it('kills a process that runs past its limit and reports a timeout', async () => {
    const outcome = await runBounded('node', ['-e', 'setTimeout(() => {}, 30000)'], { timeoutMs: 200 });
    expect(outcome).toEqual({ ok: false, reason: 'timeout' });
  }, 15_000);
});
```

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/subprocess.test.ts
```
Expected: `Tests 4 passed`.

- [ ] **Step 12: Write the JSONL module**

Create `harness/core-tools/src/shared/jsonl.ts`:

```ts
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A parsed row with the 1-based file line it came from. */
export interface JsonlRow<T> {
  value: T;
  line: number;
}

/**
 * Read a JSONL file, carrying the true file line on every row.
 *
 * The line number is why this exists as a helper rather than a `split('\n').map(JSON.parse)`
 * one-liner at three call sites: a validation error and a JSON error in the same file have to
 * point a person at the same line, and a count of non-blank rows does not.
 *
 * `label` names the kind of file in the unreadable-file message, so the eval runner can say
 * "cannot read case file …" exactly as it does today.
 */
export async function readJsonl<T>(file: string, label = 'file'): Promise<JsonlRow<T>[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`cannot read ${label} ${file}`);
  }
  const rows: JsonlRow<T>[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push({ value: JSON.parse(line) as T, line: i + 1 });
    } catch {
      throw new Error(`${path.basename(file)} line ${i + 1} is not valid JSON`);
    }
  }
  return rows;
}

/** Write one JSON document per line, with a trailing newline, so the file appends cleanly. */
export async function writeJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
```

Create `harness/core-tools/src/shared/jsonl.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readJsonl, writeJsonl } from './jsonl.js';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-jsonl-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('readJsonl', () => {
  it('skips blank lines but keeps the true file line on every row', async () => {
    const file = path.join(dir, 'cases.jsonl');
    await writeFile(file, '{"id":"a"}\n\n{"id":"b"}\n', 'utf8');
    expect(await readJsonl<{ id: string }>(file)).toEqual([
      { value: { id: 'a' }, line: 1 },
      { value: { id: 'b' }, line: 3 },
    ]);
  });

  it('names the file and the line a parse failed on', async () => {
    const file = path.join(dir, 'cases.jsonl');
    await writeFile(file, '{"id":"a"}\n{not json}\n', 'utf8');
    await expect(readJsonl(file)).rejects.toThrow('cases.jsonl line 2 is not valid JSON');
  });

  it('uses the caller label when the file cannot be read', async () => {
    await expect(readJsonl(path.join(dir, 'missing.jsonl'), 'case file')).rejects.toThrow(/^cannot read case file /);
  });
});

describe('writeJsonl', () => {
  it('writes one document per line and ends with a newline', async () => {
    const file = path.join(dir, 'out.jsonl');
    await writeJsonl(file, [{ id: 'a' }, { id: 'b' }]);
    expect(await readJsonl<{ id: string }>(file)).toEqual([
      { value: { id: 'a' }, line: 1 },
      { value: { id: 'b' }, line: 2 },
    ]);
  });
});
```

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/jsonl.test.ts
```
Expected: `Tests 4 passed`.

- [ ] **Step 13: Move the CSV cell helper**

Create `harness/core-tools/src/shared/csv.ts` with the three constants and `csvCell` lifted
verbatim out of `src/forms/roster.ts` lines 42-69:

```ts
/** Leading characters a spreadsheet treats as the start of a formula. */
const FORMULA_LEADERS = ['=', '+', '-', '@'];
/** Of those, the two that are unambiguous formula starts, so a tick prefix alone is not trusted: the cell is also quoted. */
const FORCE_QUOTE_LEADERS = ['=', '+'];
/**
 * Whitespace a spreadsheet strips before it decides whether a cell is a
 * formula, so `\t=cmd|…` reaches the parser as `=cmd|…`. Looking only at
 * index 0 misses every one of these.
 */
const STRIPPED_BEFORE_PARSE = /^[\t\r\n ]+/;

/**
 * One CSV cell. Quoting follows RFC 4180; the extra single-quote prefix stops
 * a spreadsheet from evaluating a value that begins with `=`, `+`, `-` or `@`,
 * which is how a name copied out of a document becomes a formula. `=` and `+`
 * are quoted outright rather than relying on the tick alone.
 *
 * The leader is taken after leading tabs, carriage returns, newlines and
 * spaces, because a spreadsheet strips those before parsing: a cell starting
 * `\t=` is a formula to Excel and was not to this guard.
 */
export function csvCell(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  const leader = value.replace(STRIPPED_BEFORE_PARSE, '').charAt(0);
  const defused = FORMULA_LEADERS.includes(leader) ? `'${value}` : value;
  const mustQuote = FORCE_QUOTE_LEADERS.includes(leader) || /[",\n\r]/.test(defused);
  return mustQuote ? `"${defused.replaceAll('"', '""')}"` : defused;
}
```

Delete those lines from `src/forms/roster.ts` and add, at the top of what remains:

```ts
import { csvCell } from '../shared/csv.js';
```

`roster.ts` still re-exports nothing: `csvCell` was exported before and is now reached through
the shared module, so update `src/forms/roster.test.ts` to import it from there.

Move `describe('csvCell', ...)` — lines 24-60 of `src/forms/roster.test.ts`, assertions
untouched — into a new `harness/core-tools/src/shared/csv.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { csvCell } from './csv.js';

// <the describe('csvCell') block, moved verbatim>
```

`src/forms/roster.test.ts` keeps `describe('buildRosterCsv')` and its import line becomes:

```ts
import { ROSTER_COLUMNS, buildRosterCsv, type RosterRow } from './roster.js';
```

- [ ] **Step 14: Write the redaction patterns module**

Create `harness/core-tools/src/shared/redaction/patterns.ts`. Everything from
`src/documents/redact.ts` lines 22-196 moves here unchanged, and `containsRestrictedPattern`
plus its shape set arrive from the two duplicated copies.

```ts
/**
 * Every pattern that recognises a restricted identifier, in one module, in two tiers. The
 * tiers are deliberate and must not be merged.
 *
 *   SHAPE_PATTERNS / containsRestrictedPattern
 *     Three strict-digit shapes, no validity gate. This is the LAST line of defence on text
 *     about to reach a human channel: a Slack card, a decision note, a staged message. It
 *     over-reports on purpose, because a false positive costs an approver one look at the
 *     audit log and a false negative puts an SSN in a channel. Two byte-identical copies of
 *     this list used to live in `tools/harness.ts` and `approvals/render.ts`.
 *
 *   RESTRICTED_PATTERNS
 *     OCR-tolerant and gated on real validity rules (SSA allocation, the DEA check digit).
 *     This is what decides whether a value gets ENCRYPTED ONTO a provider record, where a
 *     false positive fabricates an identifier that was never on the page.
 *
 * Collapsing them into one list changes behaviour in both directions: a shape-only
 * `AB1234567` would stop tripping the Slack guard, and an OCR-noisy `O12-34-5678` would start
 * tripping it.
 */

export type RestrictedKind = 'ssn' | 'ein' | 'dea';

/**
 * Shapes a restricted identifier takes in free text, matched on shape alone. Not anchored to
 * a validity rule, and not OCR-tolerant: this is a guard, not an extractor.
 */
const SHAPE_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number
  /\b\d{2}-\d{7}\b/, // employer identification number
  /\b[A-Za-z]{2}\d{7}\b/, // DEA registration
];

/** True when `text` looks like it carries a restricted identifier. Cheap, and over-reports. */
export function containsRestrictedPattern(text: string): boolean {
  return SHAPE_PATTERNS.some((re) => re.test(text));
}

/**
 * A single tolerant "digit" position. OCR and bad scans routinely turn `0`
 * into the letter `O`, and `1` into `I`, lowercase `l`, or a stray `|` from a
 * broken vertical stroke. Every digit position below accepts this class
 * instead of `\d`, so a scanned form does not smuggle a restricted identifier
 * past redaction just because a character reader misread one glyph. This can
 * over-redact a string that only looks like a restricted number once OCR
 * noise is discounted; that is the intended trade-off here — under-redaction,
 * not over-redaction, is the failure this module exists to prevent.
 */
const D = '[0-9OoIl|]';

/** Replace every OCR look-alike in `s` with the digit it stands in for. Safe to
 * run over a whole match, separators included: none of `-`, ` `, `\n`, `\t`
 * are in the mapped set, so only true digit positions change. */
function normalizeOcr(s: string): string {
  return s.replace(/[OoIl|]/g, (ch) => (ch === 'O' || ch === 'o' ? '0' : '1'));
}

/** Strip everything but digits, e.g. to test SSA allocation rules or to
 * collapse a line-break-split match into one plain number. */
function digitsOnly(s: string): string {
  return s.replace(/\D/g, '');
}

/** One line break, absorbing any indentation that follows it. */
const NL = String.raw`\n[ \t]*`;

/**
 * A separator as it is actually printed on a form: a dash or a space,
 * optionally followed by a single line break where a text layer or OCR pass
 * wrapped the field onto two lines.
 */
const SEP_PRINTED = String.raw`[- ][ \t]*(?:${NL})?`;

/**
 * Either a printed separator or a bare line break, for the case where two
 * groups landed on separate lines with no punctuation at all. The two
 * separator slots in a pattern are independent, so a form is not required to
 * use the same character twice.
 */
const SEP = String.raw`(?:${SEP_PRINTED}|${NL})`;

/**
 * SSN as it is actually printed on a form: three, two, four digits, with a
 * separator between each group (see `SEP`). Area 000, 666 and 900-999, group
 * 00 and serial 0000 are never issued; `isValidSsnDigits` below rejects them
 * to cut false positives on form templates and examples, after OCR
 * normalization and separator stripping — the shape here is intentionally
 * loose (see `D`).
 *
 * At most ONE of the two separator slots may be a bare line break: at least
 * one printed `-` or space has to be there to say "these groups belong to one
 * field". Allowing a bare break at both slots would make any three consecutive
 * unpunctuated lines of 3, 2 and 4 digits — a column of figures on a claims
 * page — an SSN, and `documents_extract` would then write that fabricated
 * nine-digit number onto the provider record as an encrypted `ssn`. A real
 * form that wraps does so at one slot, so nothing legitimate is lost.
 */
const SSN_FORMATTED = new RegExp(
  String.raw`\b${D}{3}(?:${SEP_PRINTED}${D}{2}${SEP}|${SEP}${D}{2}${SEP_PRINTED})${D}{4}\b`,
  'g',
);

/**
 * The same nine digits with no separator at all — how an SSN is typed into a
 * single form field, or how a punctuation-dropping OCR pass renders one.
 * `\b` on both ends keeps this from matching inside a longer digit run, so a
 * ten-digit NPI is left alone: a 9-character window inside a 10-digit run has
 * no boundary on its inner edge.
 */
const SSN_BARE = new RegExp(String.raw`\b${D}{9}\b`, 'g');

/** EIN: two digits, a separator, seven digits. Distinct in shape from the SSN 3-2-4 groups. */
const EIN_FORMATTED = new RegExp(String.raw`\b${D}{2}${SEP}${D}{7}\b`, 'g');

/**
 * DEA registration: two letters then seven digits. The shape alone matches far
 * too much (order numbers, part codes), so a candidate is only a hit when its
 * check digit is right. The two-letter prefix is real registrant-type
 * lettering, not a digit position, so it is never OCR-normalized: doing so
 * would corrupt a legitimate prefix that happens to contain `O` or `I`.
 */
const DEA_SHAPE = new RegExp(String.raw`\b[A-Za-z]{2}${D}{7}\b`, 'g');

/** The DEA check-digit algorithm. Strict on purpose: callers that already
 * have a clean candidate (the synthetic corpus generator, the tests) get an
 * exact answer with no OCR tolerance baked in. */
export function isValidDea(candidate: string): boolean {
  if (!/^[A-Za-z]{2}\d{7}$/.test(candidate)) return false;
  const d = candidate.slice(2).split('').map(Number);
  const sum = d[0] + d[2] + d[4] + 2 * (d[1] + d[3] + d[5]);
  return sum % 10 === d[6];
}

/** SSA allocation rules for a 9-digit SSN, applied after OCR normalization and
 * separator stripping. */
function isValidSsnDigits(nine: string): boolean {
  if (!/^\d{9}$/.test(nine)) return false;
  const area = nine.slice(0, 3);
  const group = nine.slice(3, 5);
  const serial = nine.slice(5, 9);
  if (area === '000' || area === '666' || area.startsWith('9')) return false;
  if (group === '00') return false;
  if (serial === '0000') return false;
  return true;
}

/** The value to store and to validate: OCR look-alikes replaced with digits,
 * and — only when the match crossed a line break — separators dropped
 * entirely so the stored value is the plain joined number rather than one
 * with a newline baked into it. A clean match is returned unchanged. */
function ssnOrEinValue(raw: string): string {
  const normalized = normalizeOcr(raw);
  return raw.includes('\n') ? digitsOnly(normalized) : normalized;
}

function ssnAccept(raw: string): boolean {
  return isValidSsnDigits(digitsOnly(normalizeOcr(raw)));
}

/** The two-letter prefix is left untouched; only the seven digit positions
 * that follow are OCR-normalized. */
function deaValue(raw: string): string {
  return raw.slice(0, 2) + normalizeOcr(raw.slice(2));
}

function deaAccept(raw: string): boolean {
  return isValidDea(deaValue(raw));
}

export interface RestrictedPattern {
  kind: RestrictedKind;
  regex: RegExp;
  /** Build the value to store and report from a raw regex match. */
  toValue: (raw: string) => string;
  /** Accept or reject a raw match — the shape alone is never enough. */
  accept: (raw: string) => boolean;
  /**
   * The identity of a value for token and ordinal purposes. Two matches with
   * the same identity are one value: they share a token and a field name,
   * however each was punctuated on the page.
   */
  identity: (value: string) => string;
}

// Order matters only for readability; the four shapes cannot overlap: each
// requires a separator (or a check digit) the others don't produce.
export const RESTRICTED_PATTERNS: RestrictedPattern[] = [
  // `123-45-6789` and `123456789` are the same SSN, so both collapse to the
  // digits. A DEA number's two-letter prefix is part of the identifier, so its
  // identity is the whole normalized value.
  { kind: 'ssn', regex: SSN_FORMATTED, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ssn', regex: SSN_BARE, toValue: ssnOrEinValue, accept: ssnAccept, identity: digitsOnly },
  { kind: 'ein', regex: EIN_FORMATTED, toValue: ssnOrEinValue, accept: () => true, identity: digitsOnly },
  { kind: 'dea', regex: DEA_SHAPE, toValue: deaValue, accept: deaAccept, identity: (v) => v.toUpperCase() },
];
```

- [ ] **Step 15: Write the redaction names module**

Create `harness/core-tools/src/shared/redaction/names.ts` with lines 28-65 of
`src/tools/providers.ts` moved verbatim:

```ts
/**
 * Field-name stems that always identify a restricted identifier. A caller may
 * mark any field restricted, but may never un-mark one of these: the check is
 * authoritative, so `restricted: false` on an `ssn` is ignored.
 */
const RESTRICTED_NAME_KEYS = ['ssn', 'socialsecurity', 'ein', 'taxid', 'dea'] as const;
/** Suffixes a key may carry: `dea`, `dea_number`, `DEA-No`, `dea_id`, ... */
const RESTRICTED_NAME_SUFFIXES = ['', 'number', 'no', 'id', 'registration'] as const;

/** Stands in for any value a caller is not allowed to read back. */
export const MASKED = '[restricted]';

/**
 * True when `name` denotes a restricted identifier. Normalizes away case and
 * separators, drops a trailing ordinal, then matches a key exactly or a key
 * plus a known suffix — so `deadline` and `npi` are not restricted while
 * `DEA-Number` is.
 *
 * The trailing ordinal matters: `fieldNameFor` in redaction/text.ts names a
 * second distinct value of a kind `ssn_2`, `ein_2`, `dea_number_2`. Those are
 * names this harness generates itself, so a caller replaying an earlier
 * extraction through `providers_upsert` must not be able to land one in the
 * plaintext `fields.value` column just because it carries a suffix.
 */
export function isRestrictedName(name: string): boolean {
  // Separators are already gone, so the ordinal is a bare digit run at the end.
  const stem = name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
    .replace(/\d+$/, '');
  return RESTRICTED_NAME_KEYS.some((key) => RESTRICTED_NAME_SUFFIXES.some((suffix) => stem === `${key}${suffix}`));
}
```

- [ ] **Step 16: Write the redaction text module**

Create `harness/core-tools/src/shared/redaction/text.ts` with lines 1-20 and 153-263 of
`src/documents/redact.ts`, rewired to the patterns module:

```ts
import { RESTRICTED_PATTERNS, type RestrictedKind } from './patterns.js';

/**
 * A page of text, as the document pipeline produces it. Declared here rather than imported
 * from the documents domain, because `shared/` may not import a domain: redaction runs over
 * the shape `{ num, text }` and knows nothing else about a document. `PageText` in
 * `domain/documents/types.ts` is structurally identical, so a `PageText[]` passes straight in.
 */
export interface RedactablePage {
  num: number;
  text: string;
}

export interface RedactionHit {
  kind: RestrictedKind;
  /** The plaintext match, OCR-normalized and (for a line-break split) rejoined. Encrypted by the caller and never persisted or logged in the clear. */
  value: string;
  /** The placeholder left in the text, e.g. `{{ssn:1}}`. */
  token: string;
  /** The `fields.name` this value is stored under. */
  fieldName: string;
  /** 1-based page the first occurrence was on. */
  page: number;
}

export interface RedactedText {
  pages: RedactablePage[];
  hits: RedactionHit[];
}

const CANONICAL_FIELD: Record<RestrictedKind, string> = {
  ssn: 'ssn',
  ein: 'ein',
  dea: 'dea_number',
};

/**
 * The `fields.name` a hit is stored under. The first hit of a kind gets the
 * canonical name so the healthcare pack can refer to `ssn` and `dea_number`
 * directly; a second distinct value is suffixed rather than overwriting.
 * Every name produced here satisfies `isRestrictedName` in redaction/names.ts
 * — it strips exactly this trailing ordinal before matching — so the value is
 * encrypted even if a caller forgets `restricted: true`.
 */
export function fieldNameFor(kind: RestrictedKind, ordinal: number): string {
  return ordinal <= 1 ? CANONICAL_FIELD[kind] : `${CANONICAL_FIELD[kind]}_${ordinal}`;
}

/**
 * Replace every restricted identifier with a stable token and hand the
 * plaintext back to the caller. This runs before anything is written to disk or
 * sent to a model: the redacted pages are what get persisted and prompted, and
 * `hits` are encrypted straight onto the provider record.
 *
 * The same value found twice gets the same token, so a form that repeats an SSN
 * in a header and a signature block still yields one field — including when
 * one occurrence is OCR-noisy and the other is clean, and including when one
 * is written `123-45-6789` and the other `123456789`: numbering is keyed on
 * the digits, not on how the page punctuated them. One value therefore yields
 * one token and one field, never an `ssn` and an `ssn_2` holding the same
 * number.
 */
export function redactPages(pages: readonly RedactablePage[]): RedactedText {
  // kind -> value identity -> assigned ordinal, so numbering is stable across pages.
  const seen = new Map<RestrictedKind, Map<string, number>>();
  const hits: RedactionHit[] = [];

  const redactedPages = pages.map((page) => {
    let text = page.text;
    for (const { kind, regex, toValue, accept, identity } of RESTRICTED_PATTERNS) {
      // Fresh RegExp per page: the module-level literals carry /g lastIndex.
      text = text.replace(new RegExp(regex.source, regex.flags), (match) => {
        if (!accept(match)) return match;
        const value = toValue(match);
        const key = identity(value);
        const byValue = seen.get(kind) ?? new Map<string, number>();
        seen.set(kind, byValue);
        let ordinal = byValue.get(key);
        if (ordinal === undefined) {
          ordinal = byValue.size + 1;
          byValue.set(key, ordinal);
          hits.push({
            kind,
            value,
            token: `{{${kind}:${ordinal}}}`,
            fieldName: fieldNameFor(kind, ordinal),
            page: page.num,
          });
        }
        return `{{${kind}:${ordinal}}}`;
      });
    }
    return { num: page.num, text };
  });

  return { pages: redactedPages, hits };
}

/**
 * The last gate before a prompt leaves the process. A plain `Error`, not a
 * `ToolError`: this failure means the redaction pass has a hole, the message
 * must not be shown to the agent, and it deliberately names only the kind so
 * the value itself is never copied into a log or an audit row. Scans with the
 * same OCR- and line-break-tolerant patterns as `redactPages`, so text that
 * would survive redaction is caught here too.
 */
export function assertRedacted(text: string): void {
  for (const { kind, regex, accept } of RESTRICTED_PATTERNS) {
    for (const m of text.matchAll(new RegExp(regex.source, regex.flags))) {
      if (accept(m[0])) {
        throw new Error(`refusing to send text to a model: a ${kind} value is not redacted`);
      }
    }
  }
}
```

- [ ] **Step 17: Split and move the redaction tests, then delete the old module**

```bash
cd harness/core-tools
git mv src/documents/redact.test.ts src/shared/redaction/text.test.ts
git rm src/documents/redact.ts
cd ../..
```

`src/shared/redaction/text.test.ts` keeps `describe('redactPages')`, `describe('fieldNameFor')`
and `describe('assertRedacted')`, with its import line rewritten to:

```ts
import { assertRedacted, fieldNameFor, redactPages } from './text.js';
```

Move `describe('isValidDea', ...)` — lines 4-22 of the original file, assertions untouched —
into a new `harness/core-tools/src/shared/redaction/patterns.test.ts`, and add three cases
for the guard that now lives beside it:

```ts
import { describe, expect, it } from 'vitest';
import { containsRestrictedPattern, isValidDea } from './patterns.js';

// <the describe('isValidDea') block, moved verbatim>

describe('containsRestrictedPattern', () => {
  it('catches the three printed shapes', () => {
    expect(containsRestrictedPattern('SSN 123-45-6789 on file')).toBe(true);
    expect(containsRestrictedPattern('EIN 12-3456789')).toBe(true);
    expect(containsRestrictedPattern('DEA AB1234563')).toBe(true);
  });

  it('is a shape guard, not an extractor: it does not check the DEA check digit', () => {
    // isValidDea rejects this one; the guard still refuses the text, because a
    // false positive on a Slack card costs a glance and a false negative leaks.
    expect(isValidDea('AB1234567')).toBe(false);
    expect(containsRestrictedPattern('DEA AB1234567')).toBe(true);
  });

  it('leaves ordinary text and a ten-digit NPI alone', () => {
    expect(containsRestrictedPattern('Renew the licence before 2026-03-01')).toBe(false);
    expect(containsRestrictedPattern('NPI 1234567893')).toBe(false);
  });
});
```

- [ ] **Step 18: Run the redaction tests**

```bash
pnpm --filter @harness/core-tools exec vitest run src/shared/redaction
```
Expected: every assertion that was in `redact.test.ts` passes from its new home, plus the
three new `containsRestrictedPattern` cases.

- [ ] **Step 19: Switch every caller inside core-tools**

Fourteen files. Each change is listed in full; none of them alters behaviour.

**`src/registry.ts`** — delete the `ToolError` class (lines 11-16) and re-export it, so that
the 22 files importing `ToolError` from `./registry.js` keep working until Task 5 moves them:

```ts
import { ToolError } from './shared/errors.js';
export { ToolError };
```

Also replace both copies of `err instanceof Error ? err.message : String(err)` (in
`handleUnexpectedError` and `runAuto`) with `describeError(err)`, imported from the same module.

**`src/models.ts`** — delete the `ModelOutputError` class (lines 172-188), import it, and
re-export it for `server.ts`'s barrel:

```ts
import { ModelOutputError, ToolError } from './shared/errors.js';
export { ModelOutputError };
```

Rewrite `gatewayFromEnv` to use the shared readers:

```ts
export function gatewayFromEnv(): GatewayConfig {
  const apiKey = requiredEnv('LITELLM_MASTER_KEY');
  const raw = optionalEnv('HARNESS_GATEWAY_URL') ?? 'http://127.0.0.1:4000';
  return {
    baseUrl: raw.replace(/\/+$/, ''),
    apiKey,
    timeoutMs: numberFromEnv('HARNESS_GATEWAY_TIMEOUT_MS', 120_000, { min: 1_000, max: 600_000 }),
    maxCallsPerRun: numberFromEnv('HARNESS_GATEWAY_MAX_CALLS_PER_RUN', 100, { min: 1, max: 10_000, integer: true }),
  };
}
```

with `import { numberFromEnv, optionalEnv, requiredEnv } from './shared/env.js';` at the top.
`models.test.ts`'s two `gatewayFromEnv` assertions — `/LITELLM_MASTER_KEY/` and the loopback
default — both still hold.

**`src/policy.ts`** — one line, so that `process.env` leaves the domain:

```ts
export async function loadPolicy(filePath: string | undefined = optionalEnv('HARNESS_POLICY_FILE')): Promise<Policy> {
```

with `import { optionalEnv } from './shared/env.js';`.

**`src/server.ts`** — delete `numberFromEnv` (lines 40-48) and `booleanFromEnv` (lines 63-66)
entirely and import them:

```ts
import { booleanFromEnv, numberFromEnv } from './shared/env.js';
```

Then extend the re-export block at the bottom of the file so the other packages can reach the
shared layer from `@harness/core-tools`:

```ts
export { ToolError, ModelOutputError, ConfigError, describeError } from './shared/errors.js';
export { numberFromEnv, booleanFromEnv, requiredEnv, optionalEnv, type NumberEnvOptions } from './shared/env.js';
export { createLogger, type Logger } from './shared/log.js';
export { realOrNearestAncestor, assertInsideRoot, type EscapeReason, type InsideRootOptions } from './shared/paths.js';
export { runBounded, type RunBoundedOptions, type RunBoundedOutcome } from './shared/subprocess.js';
export { readJsonl, writeJsonl, type JsonlRow } from './shared/jsonl.js';
export { csvCell } from './shared/csv.js';
export { containsRestrictedPattern, isValidDea, type RestrictedKind } from './shared/redaction/patterns.js';
export { isRestrictedName, MASKED } from './shared/redaction/names.js';
export {
  redactPages,
  assertRedacted,
  fieldNameFor,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './shared/redaction/text.js';
```

and delete the three lines it supersedes:

```ts
export { registerTools, defineTool, ToolError, DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps, type AnyToolDef } from './registry.js';
export { MASKED, isRestrictedName } from './tools/providers.js';
export { assertRedacted } from './documents/redact.js';
```

replacing the first of them with the same line minus `ToolError`:

```ts
export { registerTools, defineTool, DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps, type AnyToolDef } from './registry.js';
```

and dropping `ModelOutputError` from the `./models.js` export list, since `shared/errors.js`
now provides it. Exporting the same name twice is a compile error, so the typecheck in Step 20
catches any that is missed.

**`src/storage.ts`** — two changes. `storageRoot` stops reading `process.env` directly and
`resolveOutFile` uses the shared containment check:

```ts
import { mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { ToolError, ConfigError } from './shared/errors.js';
import { optionalEnv } from './shared/env.js';
import { assertInsideRoot, realOrNearestAncestor } from './shared/paths.js';

export { realOrNearestAncestor };

export function storageRoot(dir: string | undefined = optionalEnv('HARNESS_STORAGE_DIR')): string {
  if (!dir || dir.trim() === '' || !path.isAbsolute(dir.trim())) {
    throw new ConfigError('HARNESS_STORAGE_DIR must be set to an absolute path');
  }
  return path.resolve(dir.trim());
}
```

`resolveOutFile` becomes:

```ts
export async function resolveOutFile(fileId: string, root: string): Promise<string> {
  if (fileId.trim() === '' || path.isAbsolute(fileId)) {
    throw new ToolError(`file id "${fileId}" must be a path relative to the output directory`);
  }
  return assertInsideRoot(
    fileId,
    outRoot(root),
    () => {
      throw new ToolError(`file id "${fileId}" is outside the output directory`);
    },
    // The out tree itself is not a file id.
    { allowRoot: false },
  );
}
```

`storage.test.ts` asserts the two `ToolError` messages and `HARNESS_STORAGE_DIR must be set to
an absolute path`; all three come out unchanged, and `ConfigError` is not a `ToolError`, which
nothing in that file checks.

**`src/documents/storage.ts`** — delete `realOrNearestAncestor` (lines 15-40) and rewrite
`resolveStoragePath` over the shared check:

```ts
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '../shared/errors.js';
import { assertInsideRoot } from '../shared/paths.js';

export async function resolveStoragePath(storageDir: string, requested: string): Promise<string> {
  if (requested.trim() === '') throw new ToolError('document path is empty');
  return assertInsideRoot(requested, storageDir, () => {
    throw new ToolError('document path is outside HARNESS_STORAGE_DIR');
  });
}
```

Both of `documents/storage.test.ts`'s escape assertions expect exactly
`document path is outside HARNESS_STORAGE_DIR`, and the default `onUnreadable: 'rethrow'`
keeps a non-ENOENT realpath error propagating exactly as it did.

**`src/documents/text.ts`** — replace the `execFile`/`promisify`/`isTimeoutError` block (lines
1-9 and 71-80) with the shared runner, and rewrite the three call sites. The imports become:

```ts
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PDFParse } from 'pdf-parse';
import { ToolError } from '../shared/errors.js';
import { runBounded } from '../shared/subprocess.js';
```

`assertBinary`:

```ts
export async function assertBinary(name: 'tesseract' | 'pdftoppm', timeoutMs = DEFAULT_ASSERT_TIMEOUT_MS): Promise<void> {
  const args = name === 'tesseract' ? ['--version'] : ['-v'];
  const outcome = await runBounded(name, args, { timeoutMs });
  if (outcome.ok) return;
  if (outcome.reason === 'timeout') {
    throw new ToolError(`${name} did not respond within ${timeoutMs}ms while checking it is installed`);
  }
  throw new ToolError(`${name} is not installed; OCR is unavailable. Install it: ${INSTALL_HINT[name]}`);
}
```

`tesseractOnImage`:

```ts
async function tesseractOnImage(imagePath: string, lang: string, timeoutMs: number, page: number): Promise<string> {
  const outcome = await runBounded('tesseract', [imagePath, 'stdout', '-l', lang, '--psm', '6'], {
    maxBuffer: 32 * 1024 * 1024,
    timeoutMs,
  });
  if (outcome.ok) return outcome.stdout;
  if (outcome.reason === 'timeout') throw new ToolError(`ocr timed out on page ${page} of ${path.basename(imagePath)}`);
  throw new ToolError(`OCR failed on ${path.basename(imagePath)}`);
}
```

and the `pdftoppm` call inside `ocrPdf`:

```ts
      const outcome = await runBounded(
        'pdftoppm',
        ['-r', String(dpi), '-png', '-f', String(num), '-l', String(num), absPath, prefix],
        { timeoutMs: rasteriseTimeoutMs },
      );
      if (!outcome.ok) {
        if (outcome.reason === 'timeout') throw new ToolError(`rasterise timed out for ${path.basename(absPath)}`);
        throw new ToolError(`could not rasterise page ${num} of the document`);
      }
```

Every message is byte-identical to today's, which is what `text.test.ts`'s timeout describes
assert on.

**`src/effects.ts`** — one `console.error` becomes a logger line:

```ts
import { createLogger } from './shared/log.js';

const log = createLogger('effects');
```

and inside `finishDispatch`:

```ts
  log.warn(`effect ${id} changed state during dispatch; leaving as-is`);
```

The printed line changes from `effects: effect <id> changed state during dispatch; leaving
as-is` to exactly the same string — the scope prefix the logger adds is the prefix the old
message already carried by hand. Also replace the two `err instanceof Error ? err.message :
String(err)` in this file with `describeError(err)`.

**`src/tools/providers.ts`** — delete lines 28-65 (`RESTRICTED_NAME_KEYS`,
`RESTRICTED_NAME_SUFFIXES`, `isRestrictedName`, `MASKED`) and import them, re-exporting so
that `documents/extract.ts`, `forms/fill.ts` and the tests keep resolving until Task 7:

```ts
import { MASKED, isRestrictedName } from '../shared/redaction/names.js';
export { MASKED, isRestrictedName };
```

**`src/tools/harness.ts`** — delete `RESTRICTED_TEXT_PATTERNS` (lines 57-66) and use the
shared guard:

```ts
import { containsRestrictedPattern } from '../shared/redaction/patterns.js';
```

and in `harnessNotify`'s handler:

```ts
    if (containsRestrictedPattern(text)) {
      throw new ToolError('message refused: it looks like it contains a restricted identifier; restricted values never go to Slack');
    }
```

Same three shapes, same `.some(...)` semantics, same message — `harness.test.ts` asserts the
message and is untouched.

**`src/tools/documents.ts`** — one import line moves:

```ts
import { assertRedacted, redactPages } from '../shared/redaction/text.js';
```

**`src/documents/extract.ts`** and **`src/forms/fill.ts`** — each imports `isRestrictedName`
from `'../tools/providers.js'` today. Point both at the shared module instead:

```ts
import { isRestrictedName } from '../shared/redaction/names.js';
```

That also removes `forms/fill.ts`'s only reason to reach into `tools/`, which is a layer
violation dependency-cruiser will report the moment core-tools is promoted in Task 7.

Finally, `src/documents/extract.ts`'s `superRefine` message names the old home:

```ts
          message: `restricted field "${f.name}" is not recognised by isRestrictedName; add its stem to RESTRICTED_NAME_KEYS in shared/redaction/names.ts`,
```

`extract.test.ts` matches this message with `/not recognised by isRestrictedName/`, so the
tail may change; confirm with `grep -n "not recognised" harness/core-tools/src/documents/extract.test.ts`
before editing and leave the string alone if the test quotes it in full.

`harness/core-tools/package.json` needs no edit in this task: no dependency is added and the
subpath map does not change until Task 7 introduces `index.ts`.

- [ ] **Step 20: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0. A duplicate-export error from `server.ts` here means one of the
superseded export lines in Step 19 was not deleted.

```bash
pnpm lint
```
Expected: no errors. `harness/core-tools/src/effects.ts` should no longer appear in the
`no-console` warnings.

```bash
pnpm arch
```
Expected: `0 errors`. The `core-tools-shared-imports-only-libraries` rule is still at `warn`,
and it should report nothing: `shared/` imports only `node:*` and its own siblings.

```bash
pnpm -r test
```
Expected: 7 packages pass. The count rises from 528 to roughly 550: 5 error tests, 6 new
environment tests, 8 path tests, 3 logger tests, 4 subprocess tests, 4 JSONL tests and 3
`containsRestrictedPattern` tests are added, and nothing is removed — every moved `describe`
keeps every `it`.

- [ ] **Step 21: Commit**

Two commits: the new layer, then the rewiring, so a reviewer can read the modules before
reading their call sites.

```bash
git add harness/core-tools/src/shared
git commit -m "feat(core-tools): add the shared layer for env, errors, paths, logging, subprocess, jsonl, csv and redaction"

git add -A harness/core-tools
git commit -m "refactor(core-tools): read env, errors, paths, logging and redaction from shared/"
```

---
### Task 5: `@harness/core-tools` — `domain/tooling`, the kernel split

`registry.ts` is 373 lines holding five concerns: the dependency contract, the registration
loop, the three execution paths, the session-context plumbing, and the approval-parking write.
This task splits it, and moves `policy.ts`, `audit.ts`, `reconcile.ts` and `in-process.ts` in
beside it. The type-only import cycles between `registry.ts`, `models.ts`, `effects.ts` and
`tools/verify.ts` disappear, because every one of them was reaching for `ToolDeps`.

**Files:**
- Create: `harness/core-tools/src/domain/tooling/types.ts`, `registry.ts`, `execution.ts`, `context.ts`
- Create: `harness/core-tools/src/domain/approvals/repository.ts`
- Move: `harness/core-tools/src/registry.test.ts` → `harness/core-tools/src/domain/tooling/registry.test.ts`
- Move: `harness/core-tools/src/policy.ts` → `harness/core-tools/src/domain/tooling/policy.ts`
- Move: `harness/core-tools/src/policy.test.ts` → `harness/core-tools/src/domain/tooling/policy.test.ts`
- Move: `harness/core-tools/src/audit.ts` → `harness/core-tools/src/domain/tooling/audit.ts`
- Move: `harness/core-tools/src/audit.test.ts` → `harness/core-tools/src/domain/tooling/audit.test.ts`
- Move: `harness/core-tools/src/reconcile.ts` → `harness/core-tools/src/domain/tooling/reconcile.ts`
- Move: `harness/core-tools/src/reconcile.test.ts` → `harness/core-tools/src/domain/tooling/reconcile.test.ts`
- Move: `harness/core-tools/src/in-process.ts` → `harness/core-tools/src/domain/tooling/in-process.ts`
- Delete: `harness/core-tools/src/registry.ts`
- Modify: every file that imported `./registry.js`, `./policy.js`, `./audit.js`, `./reconcile.js` or `./in-process.js` — 24 files, listed in Step 6
- Modify: `harness/core-tools/package.json` (`./in-process` and `./reconcile` retarget)

**Interfaces:**
- Consumes: `ToolError`, `describeError` from `shared/errors.js`; `optionalEnv` from `shared/env.js` (Task 4).
- Produces:

  ```ts
  // domain/tooling/types.ts
  interface SessionContext { runId?: string; skill?: string; skillVersion?: string; tool?: string }
  const DEFAULT_CONFIDENCE_THRESHOLD = 0.85
  interface ToolDeps { db: Db; client: string; caller: string; policy: Policy; encryptionKey: Buffer;
                       now: () => Date; approvalTtlHours: number; confidenceThreshold: number;
                       gateway: GatewayConfig; storageDir: string; formsDir: string;
                       restrictedToModel: boolean; verify: VerifyConfig; sinks: SinkRegistry;
                       context: SessionContext; tools: Map<string, AnyToolDef> }
  interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> { name; description; actionClass;
                       input: I; output: O; handler; recordIds?; redact? }
  type AnyToolDef = ToolDef<any, any>
  type AuditBase = Pick<AuditEntry, 'client'|'caller'|'tool'|'actionClass'|'argsHash'|'runId'|'skill'|'skillVersion'|'derivedFrom'>
  type ToolCallResult = { content: { type: 'text'; text: string }[]; isError: boolean; structuredContent?: Envelope }
  type Envelope = { status: 'ok'; result: unknown } | { status: 'pending'; approval_id: string }

  // domain/tooling/registry.ts
  function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O>
  function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void

  // domain/tooling/execution.ts
  function runAuto(deps: ToolDeps, tool: AnyToolDef, base: AuditBase, args: Record<string, unknown>): Promise<ToolCallResult>
  function runForApproval(deps: ToolDeps, tool: AnyToolDef, base: AuditBase, args: Record<string, unknown>): Promise<ToolCallResult>
  function runBlocked(deps: ToolDeps, tool: AnyToolDef, base: AuditBase): Promise<ToolCallResult>
  function envelope<O extends z.ZodObject>(output: O): z.ZodObject

  // domain/tooling/context.ts
  function auditBaseFor(deps: ToolDeps, tool: AnyToolDef, argsHash: string, derivedFrom?: string[]): AuditBase
  function preservingContext<T>(context: SessionContext, fn: () => Promise<T>): Promise<T>
  function withCurrentTool<T>(context: SessionContext, tool: string, fn: () => Promise<T>): Promise<T>

  // domain/approvals/repository.ts
  function createOrReuseApproval(db: Db, deps: ToolDeps, tool: AnyToolDef, args: unknown, argsHash: string): Promise<typeof approvals.$inferSelect>

  // unchanged, only relocated
  domain/tooling/policy.ts      ACTION_CLASSES, ActionClass, BEHAVIORS, Behavior, Policy, DEFAULT_POLICY, parsePolicy, loadPolicy, decide
  domain/tooling/audit.ts       Decision, AuditEntry, hashArgs, writeAudit
  domain/tooling/reconcile.ts   ReconcileResult, expireApprovals, parkStuckDispatches, reconcile
  domain/tooling/in-process.ts  connectInProcess
  ```

---

- [ ] **Step 1: Move the four whole files**

```bash
cd harness/core-tools
mkdir -p src/domain/tooling src/domain/approvals
git mv src/policy.ts src/domain/tooling/policy.ts
git mv src/policy.test.ts src/domain/tooling/policy.test.ts
git mv src/audit.ts src/domain/tooling/audit.ts
git mv src/audit.test.ts src/domain/tooling/audit.test.ts
git mv src/reconcile.ts src/domain/tooling/reconcile.ts
git mv src/reconcile.test.ts src/domain/tooling/reconcile.test.ts
git mv src/in-process.ts src/domain/tooling/in-process.ts
git mv src/registry.test.ts src/domain/tooling/registry.test.ts
cd ../..
```

Their own imports need one rewrite each, because `shared/` is now two levels up:

```bash
cd harness/core-tools/src/domain/tooling
sed -i '' "s#from '\.\./shared/#from '../../shared/#g" policy.ts audit.ts reconcile.ts in-process.ts
sed -i '' "s#from '\./shared/#from '../../shared/#g" policy.ts audit.ts reconcile.ts in-process.ts
sed -i '' "s#from '\./policy\.js'#from './policy.js'#" audit.ts
sed -i '' "s#from '\./testing\.js'#from '../../testing.js'#" reconcile.test.ts registry.test.ts
sed -i '' "s#from '\./reconcile\.js'#from './reconcile.js'#" reconcile.test.ts
cd ../../../../..
```

`audit.ts` imports `type ActionClass` from `./policy.js` and both files are now in the same
folder, so that line is already correct — the sed above is a no-op that documents it.

- [ ] **Step 2: Write `domain/tooling/types.ts`**

Everything a tool author has to read is in this one file, which is why it carries the long
comments. It is the only module in the package that other domains import for its types.

```ts
import type { McpServer } from '@modelcontextprotocol/server';
import type * as z from 'zod/v4';
import type { Db } from '@harness/db';
import type { SinkRegistry } from '../effects/types.js';
import type { GatewayConfig } from '../models/types.js';
import type { VerifyConfig } from '../verify/types.js';
import type { ActionClass, Policy } from './policy.js';
import type { AuditEntry } from './audit.js';

/**
 * What a session has told us about itself, stamped onto every audit row it produces. One
 * object per process, mutated in place by `harness_set_context` and rewound by
 * `preservingContext` when a transaction rolls back.
 */
export interface SessionContext {
  runId?: string;
  skill?: string;
  skillVersion?: string;
  /** Name of the tool currently executing; set by the registry before calling a handler. */
  tool?: string;
}

/**
 * Extraction confidence at or above which a field is `extracted` rather than
 * `pending` a human. The shipped default, overridable per process by
 * `CONFIDENCE_THRESHOLD`. Exported because the eval suite asserts on the same
 * boundary the tools apply, and two copies of the number would drift: a change
 * to the default would silently move the eval's goalposts with it.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Everything a tool handler is given. This is the package's dependency contract: a handler
 * reaches for nothing outside it, which is what makes every tool testable against
 * `makeTestDeps` and what keeps `process.env` out of the domain.
 *
 * Note what this carries and what it does not. `gateway`, `storageDir` and `verify` are
 * *configuration*, not constructed objects: the domain builds its adapter from them
 * (`httpGateway`, `fileStorage`, `nppesRegistry`), so a test overrides a URL rather than
 * assembling an interface. See ARCHITECTURE.md for why.
 */
export interface ToolDeps {
  db: Db;
  client: string;
  caller: string;
  policy: Policy;
  encryptionKey: Buffer;
  now: () => Date;
  approvalTtlHours: number;
  confidenceThreshold: number;
  /** How to reach the model gateway. Every model call goes through it. */
  gateway: GatewayConfig;
  /**
   * Absolute root of the file store, from `storageRoot()`: required, with no
   * default, so a deployment that has not said where files live fails at
   * startup instead of scattering provider documents into the working
   * directory. One root serves both halves and they do not collide: ingested
   * documents sit where the caller puts them under it (`incoming/`, and their
   * `.redacted.txt` sidecars beside them), and everything a tool generates for
   * a human goes under `<storageDir>/out`. Nothing outside the root is
   * readable: `resolveStoragePath` and `resolveOutFile` both check the lexical
   * path and the symlink-resolved path against it.
   */
  storageDir: string;
  /** Directory holding the active pack's `templates.json` and its PDFs. */
  formsDir: string;
  /**
   * Whether restricted identifiers (SSN, EIN, DEA) may be sent to a model.
   * False for every client by default. Turning it on is a documented decision
   * that requires a BAA with the model provider (spec section 4.4).
   */
  restrictedToModel: boolean;
  /** External registry lookups: which are enabled, and where they live. */
  verify: VerifyConfig;
  /** External-effect senders keyed by sink name (e.g. 'slack'). */
  sinks: SinkRegistry;
  context: SessionContext;
  /** Every registered tool, keyed by name, so a parked action can be replayed by name. Filled by `registerTools`. */
  tools: Map<string, AnyToolDef>;
}

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
  /**
   * Strip restricted values from the arguments before they are written to the
   * approvals table in plaintext jsonb. The full arguments are still stored,
   * encrypted, in `payload_encrypted`. Omit only for tools whose arguments can
   * never carry a restricted value.
   */
  redact?: (args: z.infer<I>) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any, any>;

export type AuditBase = Pick<
  AuditEntry,
  'client' | 'caller' | 'tool' | 'actionClass' | 'argsHash' | 'runId' | 'skill' | 'skillVersion' | 'derivedFrom'
>;

/** A call either produced a result or was parked for a human decision. */
export type Envelope = { status: 'ok'; result: unknown } | { status: 'pending'; approval_id: string };

/**
 * What a tool call resolves to. A type alias rather than an interface, so that
 * it keeps the implicit index signature the MCP callback signature expects.
 */
export type ToolCallResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent?: Envelope;
};

/** Re-exported so a tool author imports one module. `McpServer` appears in `registerTools`. */
export type { McpServer };
```

- [ ] **Step 3: Write `domain/tooling/context.ts`**

Lines 177-265 of the old `registry.ts`, unchanged:

```ts
import type { AnyToolDef, AuditBase, SessionContext, ToolDeps } from './types.js';

/**
 * The identity every audit row carries: who called, which tool, under what
 * session context. One definition so a row written outside the registry — the
 * replay in `approvals_execute` — cannot drift from the rows the registry
 * writes. `derivedFrom` is the caller's lineage claim, not read from context.
 */
export function auditBaseFor(
  deps: ToolDeps,
  tool: AnyToolDef,
  argsHash: string,
  derivedFrom: string[] = [],
): AuditBase {
  return {
    client: deps.client,
    caller: deps.caller,
    tool: tool.name,
    actionClass: tool.actionClass,
    argsHash,
    runId: deps.context.runId ?? null,
    skill: deps.context.skill ?? null,
    skillVersion: deps.context.skillVersion ?? null,
    derivedFrom,
  };
}

/**
 * Undo in-place mutations a handler made to the shared session context when
 * its transaction did not commit. A handler (e.g. `harness_set_context`) may
 * set `deps.context.runId` and insert the matching `runs` row in the same
 * transaction; if that transaction rolls back (a later write throws, the
 * audit write fails, etc.) the in-memory context must not keep pointing at a
 * row that was never persisted, or every later audit write would fail the
 * `audit_log.run_id` foreign key.
 */
function restoreContext(target: SessionContext, snapshot: SessionContext): void {
  for (const key of Object.keys(target) as (keyof SessionContext)[]) delete target[key];
  // Only the keys that actually held a value are put back. A snapshot taken
  // while a key held `undefined` must not reinstate it as an own property, or
  // `'tool' in context` would stay true for a tool that is no longer running:
  // absent and explicitly-undefined have to look the same.
  for (const key of Object.keys(snapshot) as (keyof SessionContext)[]) {
    const value = snapshot[key];
    if (value !== undefined) target[key] = value;
  }
}

/** Run `fn`, rewinding the shared session context to its prior state if `fn` throws. */
export async function preservingContext<T>(context: SessionContext, fn: () => Promise<T>): Promise<T> {
  const snapshot: SessionContext = { ...context };
  try {
    return await fn();
  } catch (err) {
    restoreContext(context, snapshot);
    throw err;
  }
}

/**
 * Run `fn` with `context.tool` naming the tool being executed, so that anything
 * the handler stages (an effect row, say) is attributed to it, and restore the
 * previous name afterwards. Nesting is why the old value is put back rather
 * than cleared: `approvals_execute` replays another tool inside its own call.
 */
export async function withCurrentTool<T>(context: SessionContext, tool: string, fn: () => Promise<T>): Promise<T> {
  const previous = context.tool;
  context.tool = tool;
  try {
    return await fn();
  } finally {
    context.tool = previous;
  }
}
```

`restoreContext` stops being exported: nothing outside this module ever called it, and
`preservingContext` is the only correct way to use it.

- [ ] **Step 4: Write `domain/approvals/repository.ts`**

Lines 130-175 of the old `registry.ts`, unchanged except for its imports. It lives in the
approvals domain rather than in tooling because it writes the `approvals` table; the kernel
calls it, which is a domain calling a domain and is allowed.

```ts
import { and, eq, sql } from 'drizzle-orm';
import { approvals, encrypt, type Db } from '@harness/db';
import type { AnyToolDef, ToolDeps } from '../tooling/types.js';

/**
 * Park an approval, reusing only a *live pending* row. A row that was decided
 * (approved/declined) or has passed its TTL is history: it must not silently
 * satisfy a fresh request. An expired row is retired first, then a new one is
 * parked. Uniqueness is enforced by the partial index
 * `approvals_idempotency_pending_uq`, so concurrent callers race to one insert
 * and the loser re-reads the winner's row.
 */
export async function createOrReuseApproval(
  db: Db,
  deps: ToolDeps,
  tool: AnyToolDef,
  args: unknown,
  argsHash: string,
): Promise<typeof approvals.$inferSelect> {
  const idempotencyKey = `${deps.client}:${tool.name}:${argsHash}`;
  const pendingRow = and(
    eq(approvals.client, deps.client),
    eq(approvals.idempotencyKey, idempotencyKey),
    eq(approvals.status, 'pending'),
  );

  const existing = await db.query.approvals.findFirst({ where: pendingRow });
  if (existing) {
    if (existing.expiresAt > deps.now()) return existing;
    await db.update(approvals).set({ status: 'expired', decidedAt: deps.now() }).where(eq(approvals.id, existing.id));
  }

  const summary = `${tool.name} (${tool.actionClass}) requested by ${deps.caller}`;
  const expiresAt = new Date(deps.now().getTime() + deps.approvalTtlHours * 3600 * 1000);
  await db
    .insert(approvals)
    .values({
      client: deps.client,
      action: tool.name,
      // Plaintext jsonb for humans reviewing the request; restricted values are
      // redacted out of it. The full arguments live in payload_encrypted.
      payload: { tool: tool.name, args: tool.redact ? tool.redact(args) : args },
      payloadEncrypted: encrypt(JSON.stringify({ tool: tool.name, args }), deps.encryptionKey),
      summary,
      requestedBy: deps.caller,
      expiresAt,
      idempotencyKey,
    })
    .onConflictDoNothing({ target: approvals.idempotencyKey, where: sql`status = 'pending'` });
  const row = await db.query.approvals.findFirst({ where: pendingRow });
  if (!row) throw new Error('approval row missing after insert');
  return row;
}
```

- [ ] **Step 5: Write `domain/tooling/execution.ts` and `domain/tooling/registry.ts`**

`execution.ts` takes lines 99-128 and 202-341 of the old `registry.ts`:

```ts
import * as z from 'zod/v4';
import { withTransaction, type Db } from '@harness/db';
import { ToolError, describeError } from '../../shared/errors.js';
import { createOrReuseApproval } from '../approvals/repository.js';
import { writeAudit } from './audit.js';
import { preservingContext, withCurrentTool } from './context.js';
import type { AnyToolDef, AuditBase, Envelope, ToolCallResult, ToolDeps } from './types.js';

/** The envelope every tool's output is wrapped in, so a parked call and a completed one have one shape. */
export function envelope<O extends z.ZodObject>(output: O) {
  return z.object({
    status: z.enum(['ok', 'pending']),
    approval_id: z.string().optional(),
    result: output.optional(),
  });
}

function textResult(payload: unknown, isError = false): ToolCallResult {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return { content: [{ type: 'text', text }], isError };
}

/** A successful call: the envelope is returned both as text and as structured content. */
function envelopeResult(structured: Envelope): ToolCallResult {
  return { ...textResult(structured), structuredContent: structured };
}

/**
 * Last-resort handler for a failure the normal paths could not record: a
 * throwing `now()`, a DB error while parking an approval, or an audit write
 * that itself failed after a handler threw. Never throws — the audit write is
 * wrapped so a secondary failure cannot escape the MCP callback. The message is
 * deliberately generic; the detail is in the audit log when it could be written.
 */
async function handleUnexpectedError(
  db: Db,
  tool: AnyToolDef,
  base: AuditBase,
  err: unknown,
): Promise<ToolCallResult> {
  try {
    await writeAudit(db, { ...base, decision: 'error', error: describeError(err) });
  } catch {
    // best-effort audit write; swallow secondary failure so the callback never throws
  }
  return textResult(`Tool ${tool.name} could not be processed (internal error; see audit log).`, true);
}

/** Policy says no: record the refusal and tell the caller, without running anything. */
export async function runBlocked(deps: ToolDeps, tool: AnyToolDef, base: AuditBase): Promise<ToolCallResult> {
  try {
    await writeAudit(deps.db, { ...base, decision: 'blocked' });
  } catch (err) {
    return await handleUnexpectedError(deps.db, tool, base, err);
  }
  return textResult(`Tool ${tool.name} is blocked by policy (action class ${tool.actionClass}).`, true);
}

/**
 * Policy says a human decides: park the request and return its approval id.
 * The parked row and its audit row commit together, so a request a caller was
 * told about is always one an approver can find.
 */
export async function runForApproval(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const row = await preservingContext(deps.context, () =>
      withTransaction(deps.db, async (tx) => {
        const parked = await createOrReuseApproval(tx, deps, tool, args, base.argsHash);
        await writeAudit(tx, { ...base, decision: 'approval', approvalId: parked.id });
        return parked;
      }),
    );
    return envelopeResult({ status: 'pending', approval_id: row.id });
  } catch (err) {
    return await handleUnexpectedError(deps.db, tool, base, err);
  }
}

/**
 * Policy says go: run the handler and its audit row in one transaction, so a
 * handler that throws leaves neither its writes nor a success row behind. The
 * raw message reaches the caller only for a `ToolError`, which a tool raises
 * deliberately; anything else could carry restricted values and stays in the
 * audit log.
 */
export async function runAuto(
  deps: ToolDeps,
  tool: AnyToolDef,
  base: AuditBase,
  args: Record<string, unknown>,
): Promise<ToolCallResult> {
  try {
    const result = await preservingContext(deps.context, () =>
      withTransaction(deps.db, async (tx) => {
        // Spread keeps the one shared context object, which the handler may mutate.
        const txDeps: ToolDeps = { ...deps, db: tx };
        return await withCurrentTool(deps.context, tool.name, async () => {
          const out = await tool.handler(args, txDeps);
          await writeAudit(tx, { ...base, decision: 'auto', recordIds: tool.recordIds?.(args, out) ?? [] });
          return out;
        });
      }),
    );
    return envelopeResult({ status: 'ok', result });
  } catch (err) {
    const message = describeError(err);
    try {
      await writeAudit(deps.db, { ...base, decision: 'error', error: message });
    } catch (auditErr) {
      return await handleUnexpectedError(deps.db, tool, base, auditErr);
    }
    const text =
      err instanceof ToolError
        ? `Tool ${tool.name} failed: ${message}`
        : `Tool ${tool.name} failed (internal error; see audit log).`;
    return textResult(text, true);
  }
}
```

`registry.ts` is what is left — 40 lines:

```ts
import * as z from 'zod/v4';
import type { McpServer } from '@modelcontextprotocol/server';
import { hashArgs } from './audit.js';
import { auditBaseFor } from './context.js';
import { envelope, runAuto, runBlocked, runForApproval } from './execution.js';
import { decide } from './policy.js';
import type { AnyToolDef, ToolDef, ToolDeps } from './types.js';

/**
 * Declare a tool. The only thing this does at runtime is return its argument; it exists so
 * that `I` and `O` are inferred and a handler's arguments and result are typed from the zod
 * schemas rather than annotated by hand.
 */
export function defineTool<I extends z.ZodObject, O extends z.ZodObject>(def: ToolDef<I, O>): ToolDef<I, O> {
  return def;
}

export function registerTools(server: McpServer, tools: AnyToolDef[], deps: ToolDeps): void {
  for (const tool of tools) deps.tools.set(tool.name, tool);
  for (const tool of tools) {
    const inputSchema = tool.input.extend({
      derived_from: z
        .array(z.string().uuid())
        .max(50)
        .optional()
        .describe('audit_log ids of earlier results these arguments were built from'),
    });
    server.registerTool(
      tool.name,
      { description: tool.description, inputSchema, outputSchema: envelope(tool.output) },
      async (args: Record<string, unknown>) => {
        // `derived_from` is the registry's own argument: it is audited as lineage
        // and never reaches the handler or the arguments hash.
        const { derived_from, ...handlerArgs } = args as Record<string, unknown> & { derived_from?: string[] };
        const base = auditBaseFor(deps, tool, hashArgs(handlerArgs), derived_from ?? []);

        switch (decide(tool.actionClass, deps.policy)) {
          case 'blocked':
            return await runBlocked(deps, tool, base);
          case 'approval':
            return await runForApproval(deps, tool, base, handlerArgs);
          default:
            return await runAuto(deps, tool, base, handlerArgs);
        }
      },
    );
  }
}
```

```bash
git rm harness/core-tools/src/registry.ts
```

- [ ] **Step 6: Rewrite every import of the five moved modules**

Twenty-four files. Run this from the repository root; it is mechanical and `pnpm -r typecheck`
is the check that it was complete.

```bash
cd harness/core-tools/src

# Files at the src root: server.ts, main.ts, storage.ts, effects.ts, models.ts, testing.ts, fake-gateway.ts
sed -i '' \
  -e "s#from './registry.js'#from './domain/tooling/types.js'#g" \
  -e "s#from './policy.js'#from './domain/tooling/policy.js'#g" \
  -e "s#from './audit.js'#from './domain/tooling/audit.js'#g" \
  -e "s#from './reconcile.js'#from './domain/tooling/reconcile.js'#g" \
  -e "s#from './in-process.js'#from './domain/tooling/in-process.js'#g" \
  server.ts main.ts storage.ts effects.ts models.ts testing.ts

# One level down: tools/*, documents/*, forms/*, deadlines/*
sed -i '' \
  -e "s#from '../registry.js'#from '../domain/tooling/types.js'#g" \
  -e "s#from '../policy.js'#from '../domain/tooling/policy.js'#g" \
  -e "s#from '../audit.js'#from '../domain/tooling/audit.js'#g" \
  -e "s#from '../reconcile.js'#from '../domain/tooling/reconcile.js'#g" \
  -e "s#from '../in-process.js'#from '../domain/tooling/in-process.js'#g" \
  tools/*.ts documents/*.ts forms/*.ts deadlines/*.ts

cd ../../..
```

That points everything at `types.js`, which is right for the majority — most of those imports
are `ToolDeps`, `ToolDef`, `AnyToolDef` or `DEFAULT_CONFIDENCE_THRESHOLD`. Six files also want
a *function*, and `pnpm -r typecheck` names each one. Fix them by hand:

| File | Also needs | From |
|---|---|---|
| `src/server.ts` | `registerTools`, `defineTool` | `./domain/tooling/registry.js` |
| `src/testing.ts` | `registerTools` | `./domain/tooling/registry.js` |
| `src/tools/approvals.ts` | `auditBaseFor`, `withCurrentTool` | `../domain/tooling/context.js` |
| `src/tools/approvals.ts` | `defineTool` | `../domain/tooling/registry.js` |
| every other `src/tools/*.ts` | `defineTool` | `../domain/tooling/registry.js` |
| `src/domain/tooling/registry.test.ts` | `defineTool` | `./registry.js` |

`ToolError` is no longer re-exported from the kernel — Task 4 left that re-export on the old
`registry.ts`, which this task deletes. Point every remaining importer at the shared module:

```bash
cd harness/core-tools/src
grep -rln "ToolError" tools documents forms domain storage.ts models.ts effects.ts testing.ts \
  | xargs sed -i '' -e "s#import { ToolError } from '\.\./domain/tooling/types\.js';#import { ToolError } from '../shared/errors.js';#"
cd ../../..
```

That one-liner only catches the simplest import form. `pnpm -r typecheck` lists the rest;
for each, move `ToolError` out of the `types.js` import list and into a
`shared/errors.js` one.

- [ ] **Step 7: Retarget the two subpath exports**

`harness/core-tools/package.json`:

```json
    "./in-process": "./src/domain/tooling/in-process.ts",
    "./reconcile": "./src/domain/tooling/reconcile.ts",
```

Everything else in the `exports` map is unchanged in this task. `evals/src/pipeline.ts`
imports `@harness/core-tools/in-process`; the specifier does not change.

- [ ] **Step 8: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0. Getting here is the bulk of this task; work through the errors in
the order tsc reports them.

```bash
pnpm lint
```
Expected: no errors. The `import-x/no-cycle` warnings for `registry.ts` should be gone — that
was the point of `types.ts`.

```bash
pnpm arch
```
Expected: `0 errors`, and no `no-circular` warnings inside `harness/core-tools/src/domain/`.

```bash
pnpm -r test
```
Expected: 7 packages pass, same count as after Task 4. Not one `it` was added or removed.

- [ ] **Step 9: Commit**

```bash
git add -A harness/core-tools
git commit -m "refactor(core-tools): split the tooling kernel into types, registry, execution and context"
```

---
### Task 6: `@harness/core-tools` — `domain/storage`, `domain/documents`, `domain/models`

Three domains, and the end of the two worst name collisions in the package: `src/storage.ts`
versus `src/documents/storage.ts`, which held two halves of one file store, and
`documents/extract.ts`, which held a manifest parser, a JSON-Schema builder, a prompt and a
reply parser in 341 lines.

**Files:**
- Create: `src/domain/storage/types.ts`, `layout.ts`, `file-store.ts`, `layout.test.ts`, `file-store.test.ts`
- Delete: `src/storage.ts`, `src/storage.test.ts`, `src/documents/storage.ts`, `src/documents/storage.test.ts`
- Create: `src/domain/documents/types.ts`, `manifest.ts`, `schema.ts`, `prompts.ts`, `parse.ts` and their four test files
- Delete: `src/documents/extract.ts`, `src/documents/extract.test.ts`
- Move: `src/documents/text.ts` → `src/domain/documents/text.ts`; `src/documents/text.test.ts` → `src/domain/documents/text.test.ts`
- Create: `src/domain/models/types.ts`, `gateway.ts`
- Move: `src/models.test.ts` → `src/domain/models/gateway.test.ts`; `src/fake-gateway.ts` → `src/domain/models/fake.ts`
- Delete: `src/models.ts`
- Modify: `src/server.ts`, `src/testing.ts`, `src/effects.ts`, `src/tools/documents.ts`, `src/tools/forms.ts`, `src/forms/fill.ts`, `src/forms/templates.ts`, `src/domain/tooling/types.ts`
- Modify: `harness/core-tools/package.json` (`./storage`, `./models` and `./fake-gateway` retarget)

**Interfaces:**
- Consumes: `ToolDeps` and `ToolCallResult` from `domain/tooling/types.js`; `ToolError`, `ConfigError` from `shared/errors.js`; `assertInsideRoot`, `realOrNearestAncestor` from `shared/paths.js`; `runBounded` from `shared/subprocess.js`; `optionalEnv`, `numberFromEnv`, `requiredEnv` from `shared/env.js`; `redactPages`, `assertRedacted`, `isRestrictedName` from `shared/redaction/*` (Tasks 4 and 5).
- Produces:

  ```ts
  // domain/storage/types.ts
  interface WriteFileInput { dir: string; name: string; ext: string; bytes: Uint8Array }
  interface WrittenFile { file_id: string; path: string; bytes: number }
  interface Storage {
    resolveIncoming(requested: string): Promise<string>;
    resolveOut(fileId: string): Promise<string>;
    read(absPath: string): Promise<Uint8Array>;
    write(input: WriteFileInput): Promise<WrittenFile>;
    textPathFor(absPath: string): string;
  }

  // domain/storage/layout.ts
  function storageRoot(dir?: string): string            // throws ConfigError
  function outRoot(root: string): string
  function contentTag(bytes: Uint8Array): string
  function documentTextPath(absPath: string): string
  function toStorageRelative(storageDir: string, absPath: string): string

  // domain/storage/file-store.ts
  function resolveStoragePath(storageDir: string, requested: string): Promise<string>
  function resolveOutFile(fileId: string, root: string): Promise<string>
  function readDocumentBytes(absPath: string): Promise<Uint8Array>
  function sha256File(absPath: string): Promise<string>
  function writeOutFile(input: WriteFileInput, root: string): Promise<WrittenFile>
  function fileStorage(root: string): Storage

  // domain/documents/types.ts
  const DOCUMENT_KINDS = ['state_license','dea_certificate','malpractice_certificate','w9','other'] as const
  type DocumentKind = (typeof DOCUMENT_KINDS)[number]
  interface PageText { num: number; text: string }
  interface ExtractedText { pages: PageText[]; ocrUsed: boolean }
  interface ExtractedField { name: string; value: string; confidence: number; source_page?: number }
  interface ExtractedCredential { kind: 'license'|'dea'|'malpractice'|'board_cert'; issuer?: string; state?: string; issued_at?: string; expires_at?: string; confidence: number; source_page?: number }
  interface ParsedExtraction { documentKind: DocumentKind; fields: ExtractedField[]; credentials: ExtractedCredential[] }

  // domain/documents/manifest.ts
  ManifestField, ManifestCredential, ProviderManifest   // zod objects + inferred types
  function parseManifest(raw: unknown): ProviderManifest
  function loadHealthcareManifest(): ProviderManifest

  // domain/documents/schema.ts
  function buildExtractionSchema(manifest: ProviderManifest): { name: string; schema: Record<string, unknown> }
  function buildClassificationSchema(manifest: ProviderManifest): { name: string; schema: Record<string, unknown> }

  // domain/documents/prompts.ts
  const DATA_BLOCK_SYSTEM_PROMPT: string
  function wrapDocument(pages: PageText[]): string
  function buildClassificationMessages(pages: PageText[]): ModelMessage[]
  function buildExtractionMessages(pages: PageText[], manifest: ProviderManifest): ModelMessage[]

  // domain/documents/parse.ts
  function parseExtraction(raw: unknown, manifest: ProviderManifest): ParsedExtraction

  // domain/documents/text.ts — unchanged exports, relocated
  MIN_CHARS_PER_PAGE, isPdf, pdfPageCount, extractPdfText, assertBinary, ocrPdf, ocrImage, extractDocumentText

  // domain/models/types.ts
  interface GatewayConfig { baseUrl: string; apiKey: string; timeoutMs: number; maxCallsPerRun: number }
  interface ModelMessage { role: 'system'|'user'|'assistant'; content: string }
  interface JsonSchemaSpec { name: string; schema: Record<string, unknown> }
  interface ModelCallOptions { route: Route; messages: ModelMessage[]; jsonSchema?: JsonSchemaSpec; temperature?: number; maxTokens?: number }
  interface ModelCallResult { text: string; model: string; inputTokens: number; outputTokens: number; costUsd: number }
  interface ModelGateway { call(opts: ModelCallOptions): Promise<ModelCallResult> }
  const ROUTES, type Route            // re-exported from @harness/gateway/routing

  // domain/models/gateway.ts
  function gatewayFromEnv(): GatewayConfig
  function httpGateway(config: GatewayConfig): ModelGateway
  function callModel(deps: ToolDeps, opts: ModelCallOptions): Promise<ModelCallResult>
  function callModelJson<T>(deps: ToolDeps, opts: ModelCallOptions & { jsonSchema: JsonSchemaSpec; validate: z.ZodType<T> }): Promise<ModelCallResult & { json: T }>

  // domain/models/fake.ts — unchanged exports, relocated
  startFakeGateway, FakeGateway, FakeGatewayCall, FakeReply, Responder
  ```

---

- [ ] **Step 1: Build the storage domain**

```bash
mkdir -p harness/core-tools/src/domain/storage
```

`src/domain/storage/types.ts`:

```ts
/**
 * The file store, as a domain sees it. Two trees under one root and they do not collide:
 * ingested documents sit where the caller put them (`incoming/…`, with their
 * `.redacted.txt` sidecars beside them) and everything generated for a human goes under
 * `<root>/out`. Nothing outside the root is reachable through either half.
 *
 * `Storage` is the seam: `fileStorage(root)` is the production adapter, and a test that wants
 * a stub implements these five methods. `ToolDeps` carries the root string rather than a
 * constructed `Storage`, so a test overrides a directory rather than assembling an object —
 * see ARCHITECTURE.md.
 */
export interface WriteFileInput {
  /** Subdirectory under `out/`, e.g. `forms` or `roster`. */
  dir: string;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export interface WrittenFile {
  file_id: string;
  path: string;
  bytes: number;
}

export interface Storage {
  /** A caller-supplied ingest path, resolved and proven to be inside the root. */
  resolveIncoming(requested: string): Promise<string>;
  /** A caller-supplied file id, resolved and proven to be inside `out/`. */
  resolveOut(fileId: string): Promise<string>;
  read(absPath: string): Promise<Uint8Array>;
  write(input: WriteFileInput): Promise<WrittenFile>;
  /** Where a document's redacted text lives: beside it, with a fixed suffix. */
  textPathFor(absPath: string): string;
}
```

`src/domain/storage/layout.ts` holds the pure path arithmetic — `storageRoot` (from old
`storage.ts:18-23`, now throwing `ConfigError` and reading through `optionalEnv`), `outRoot`
(`storage.ts:29-31`), `contentTag` (`storage.ts:34-36`), `documentTextPath`
(`documents/storage.ts:91-93`) and `toStorageRelative` (`documents/storage.ts:96-98`), each
with its existing comment. No I/O in this module at all, which is why its test needs no
temporary directory.

`src/domain/storage/file-store.ts` holds everything that touches the disk —
`resolveStoragePath` and `resolveOutFile` in the forms Task 4 left them, `readDocumentBytes`
and `sha256File` (`documents/storage.ts:68-81`), `writeOutFile` (`storage.ts:80-89`) — and
adds the adapter:

```ts
/**
 * The production `Storage`. A thin binding of the free functions above to one root, so a
 * caller holds an object instead of threading `deps.storageDir` through every call, and so a
 * test can hand a domain a stub without a filesystem.
 */
export function fileStorage(root: string): Storage {
  return {
    resolveIncoming: (requested) => resolveStoragePath(root, requested),
    resolveOut: (fileId) => resolveOutFile(fileId, root),
    read: (absPath) => readDocumentBytes(absPath),
    write: (input) => writeOutFile(input, root),
    textPathFor: (absPath) => documentTextPath(absPath),
  };
}
```

Split the two old test files along their describes and delete them:

```bash
cd harness/core-tools
git mv src/storage.test.ts src/domain/storage/file-store.test.ts
git rm src/storage.ts src/documents/storage.ts
cd ../..
```

`src/domain/storage/file-store.test.ts` keeps `describe('storage paths')` from the old
`storage.test.ts` and gains `describe('resolveStoragePath')` and `describe('sha256File')`
moved verbatim out of `src/documents/storage.test.ts`; its imports become

```ts
import { ToolError } from '../../shared/errors.js';
import { contentTag, outRoot, storageRoot } from './layout.js';
import { resolveOutFile, resolveStoragePath, sha256File, writeOutFile } from './file-store.js';
```

`src/domain/storage/layout.test.ts` is new and takes `describe('documentTextPath')` from
`src/documents/storage.test.ts` verbatim, plus a case for the adapter:

```ts
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { documentTextPath, outRoot } from './layout.js';
import { fileStorage } from './file-store.js';

// <describe('documentTextPath'), moved verbatim from documents/storage.test.ts>

describe('fileStorage', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'harness-file-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('binds one root to the five operations a domain needs', async () => {
    const store = fileStorage(root);
    const written = await store.write({ dir: 'forms', name: 'demo', ext: 'pdf', bytes: new Uint8Array([1, 2, 3]) });
    expect(written.path.startsWith(outRoot(root))).toBe(true);
    expect(await store.resolveOut(written.file_id)).toBe(written.path);
    expect(Array.from(await store.read(written.path))).toEqual([1, 2, 3]);
    expect(store.textPathFor('/a/b.pdf')).toBe('/a/b.pdf.redacted.txt');
  });

  it('refuses a file id that leaves the out tree', async () => {
    await expect(fileStorage(root).resolveOut('../escape.pdf')).rejects.toThrow('outside the output directory');
  });
});
```

```bash
git rm harness/core-tools/src/documents/storage.test.ts
```

- [ ] **Step 2: Build the documents domain**

```bash
cd harness/core-tools
mkdir -p src/domain/documents
git mv src/documents/text.ts src/domain/documents/text.ts
git mv src/documents/text.test.ts src/domain/documents/text.test.ts
cd ../..
```

`src/domain/documents/types.ts` is new and holds the hand-written interfaces. `DOCUMENT_KINDS`
comes from old `documents/storage.ts:6-13`; `PageText` and `ExtractedText` from
`documents/text.ts:11-20`; `ExtractedField`, `ExtractedCredential` and `ParsedExtraction` from
`documents/extract.ts:244-265`. Each keeps its comment. Add this header:

```ts
/**
 * The document domain's vocabulary. Interfaces only, so that `manifest.ts`, `schema.ts`,
 * `prompts.ts`, `parse.ts` and `text.ts` can all name the same shapes without importing each
 * other — the zod schemas that validate a pack's manifest live in `manifest.ts`, because a
 * schema is a value and this file holds no values but the one frozen list.
 *
 * `PageText` is structurally identical to `RedactablePage` in shared/redaction/text.ts, which
 * is deliberate and is why redaction can run over a page without the shared layer importing a
 * domain.
 */
```

`src/domain/documents/manifest.ts` takes `documents/extract.ts:1-87`: the `CREDENTIAL_PROPERTIES`
constant, `ManifestField`, `ManifestCredential`, `ProviderManifest` with its `superRefine`,
`parseManifest`, the `createRequire` line and `loadHealthcareManifest` with its module-level
cache. Its imports become:

```ts
import { createRequire } from 'node:module';
import * as z from 'zod/v4';
import { isRestrictedName } from '../../shared/redaction/names.js';
import { CREDENTIAL_KINDS } from '../deadlines/compute.js';
import { DOCUMENT_KINDS } from './types.js';
```

`../deadlines/compute.js` does not exist yet — Task 7 moves it. Until then use
`../../deadlines/compute.js` and change it in Task 7; Task 7's file list says so.

`src/domain/documents/schema.ts` takes `extract.ts:89-177`: `fieldSlot`,
`buildExtractionSchema`, `buildClassificationSchema`. It needs `CREDENTIAL_PROPERTIES`, so
export that constant from `manifest.ts`.

`src/domain/documents/prompts.ts` takes `extract.ts:179-242`: `DATA_BLOCK_SYSTEM_PROMPT`,
`wrapDocument`, `buildClassificationMessages`, `buildExtractionMessages`.

`src/domain/documents/parse.ts` takes `extract.ts:267-341`: `ISO_DATE`, `US_STATE`,
`clampConfidence`, `pageOrUndefined`, `textOrUndefined`, `parseExtraction`.

```bash
git rm harness/core-tools/src/documents/extract.ts
```

Split `src/documents/extract.test.ts` by describe, then delete it:

| Describe in `extract.test.ts` | New home |
|---|---|
| `loadHealthcareManifest` (line 13) | `src/domain/documents/manifest.test.ts` |
| `parseManifest` (line 29) | `src/domain/documents/manifest.test.ts` |
| `buildExtractionSchema` (line 53) | `src/domain/documents/schema.test.ts` |
| `buildClassificationSchema` (line 102) | `src/domain/documents/schema.test.ts` |
| `wrapDocument and the prompts` (line 112) | `src/domain/documents/prompts.test.ts` |
| `parseExtraction` (line 149) | `src/domain/documents/parse.test.ts` |

```bash
git rm harness/core-tools/src/documents/extract.test.ts
rmdir harness/core-tools/src/documents
```

Each new test file imports only what its describes use, from the matching module, plus
`isRestrictedName` from `'../../shared/redaction/names.js'` where the original did. Assertions
are moved verbatim.

`src/domain/documents/text.ts` needs one import fix after the move:

```bash
cd harness/core-tools/src/domain/documents
sed -i '' -e "s#from '\.\./shared/#from '../../shared/#g" text.ts
sed -i '' -e "s#from '\./text\.js'#from './text.js'#" text.test.ts
cd ../../../../..
```

and its `PageText`/`ExtractedText` declarations move into `types.ts`, so `text.ts` gains

```ts
import type { ExtractedText, PageText } from './types.js';
```

and re-exports them for the callers that import them from `text.js` today:

```ts
export type { ExtractedText, PageText };
```

- [ ] **Step 3: Build the models domain**

```bash
cd harness/core-tools
mkdir -p src/domain/models
git mv src/fake-gateway.ts src/domain/models/fake.ts
git mv src/models.test.ts src/domain/models/gateway.test.ts
cd ../..
```

`src/domain/models/types.ts`:

```ts
import { ROUTES, type Route } from '@harness/gateway/routing';

export { ROUTES, type Route };

export interface GatewayConfig {
  /** Origin of the LiteLLM proxy, no trailing slash. */
  baseUrl: string;
  /** The proxy master key. Provider keys never leave the proxy. */
  apiKey: string;
  timeoutMs: number;
  /**
   * The runaway breaker from spec section 4.2. LiteLLM's `max_budget` is a
   * daily cap across everything; this is the per-run one. A loop that calls the
   * extract route a thousand times stays inside the daily budget right up until
   * it does not, and by then the day is gone.
   */
  maxCallsPerRun: number;
}

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface JsonSchemaSpec {
  /** A schema name the provider echoes back. Lowercase, underscores. */
  name: string;
  schema: Record<string, unknown>;
}

export interface ModelCallOptions {
  route: Route;
  messages: ModelMessage[];
  jsonSchema?: JsonSchemaSpec;
  temperature?: number;
  maxTokens?: number;
}

export interface ModelCallResult {
  text: string;
  /** The model the gateway actually used, which may be a fallback. */
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/**
 * One chat completion, and nothing else.
 *
 * The seam exists so that "talk to a model" is a named interface rather than a `fetch` buried
 * in a helper: `httpGateway(config)` is the LiteLLM adapter, and `startFakeGateway` in
 * `fake.ts` is the test double — an actual loopback HTTP server, which exercises the header,
 * the usage block and the cost header that a hand-written stub would skip.
 *
 * Budget accounting and the per-run breaker are deliberately NOT here: they need `ToolDeps`
 * and the database, so they live in `callModel`, which wraps this.
 */
export interface ModelGateway {
  call(opts: ModelCallOptions): Promise<ModelCallResult>;
}
```

`src/domain/models/gateway.ts` takes the rest of old `models.ts`, restructured so the HTTP
call is the adapter and `callModel` is the accounting wrapper:

```ts
export function httpGateway(config: GatewayConfig): ModelGateway {
  return {
    async call(opts) {
      // old models.ts lines 104-147, verbatim, reading `config` where it read `deps.gateway`
      // and throwing the same ToolErrors through the same `gatewayError` helper.
    },
  };
}

export async function callModel(deps: ToolDeps, opts: ModelCallOptions): Promise<ModelCallResult> {
  if (!ROUTES.includes(opts.route)) throw new ToolError(`unknown model route "${opts.route}"`);
  // the per-run breaker, old models.ts lines 91-102, verbatim
  const result = await httpGateway(deps.gateway).call(opts);
  // the model_calls insert, old models.ts lines 149-161, verbatim
  return result;
}
```

`callModelJson` (old lines 166-209) is unchanged except that `ModelOutputError` now comes from
`../../shared/errors.js`. `gatewayFromEnv` is the version Task 4 rewrote over the shared
readers.

`src/domain/models/gateway.test.ts` needs two import rewrites after the move:

```bash
cd harness/core-tools/src/domain/models
sed -i '' \
  -e "s#from './models.js'#from './gateway.js'#g" \
  -e "s#from './registry.js'#from '../tooling/types.js'#g" \
  -e "s#from './testing.js'#from '../../testing.js'#g" \
  gateway.test.ts
sed -i '' -e "s#from './models.js'#from './types.js'#" fake.ts
cd ../../../../..
```

`gateway.test.ts` imports `ModelOutputError`; point that at `'../../shared/errors.js'`.

- [ ] **Step 4: Rewire the callers**

```bash
cd harness/core-tools/src
sed -i '' \
  -e "s#from './models.js'#from './domain/models/gateway.js'#g" \
  -e "s#from './fake-gateway.js'#from './domain/models/fake.js'#g" \
  -e "s#from './storage.js'#from './domain/storage/layout.js'#g" \
  server.ts testing.ts
sed -i '' \
  -e "s#from '../models.js'#from '../domain/models/gateway.js'#g" \
  -e "s#from '../storage.js'#from '../domain/storage/file-store.js'#g" \
  -e "s#from '../documents/extract.js'#from '../domain/documents/parse.js'#g" \
  -e "s#from '../documents/storage.js'#from '../domain/storage/file-store.js'#g" \
  -e "s#from '../documents/text.js'#from '../domain/documents/text.js'#g" \
  tools/*.ts forms/*.ts
cd ../../..
```

Then fix by hand, guided by `pnpm -r typecheck`:

| File | Import it needs |
|---|---|
| `src/server.ts` | `storageRoot`, `outRoot` from `./domain/storage/layout.js`; `gatewayFromEnv` from `./domain/models/gateway.js` |
| `src/tools/documents.ts` | `DOCUMENT_KINDS` from `../domain/documents/types.js`; `documentTextPath`, `toStorageRelative` from `../domain/storage/layout.js`; `readDocumentBytes`, `resolveStoragePath`, `sha256File` from `../domain/storage/file-store.js`; `loadHealthcareManifest` from `../domain/documents/manifest.js`; `buildClassificationSchema`, `buildExtractionSchema` from `../domain/documents/schema.js`; `buildClassificationMessages`, `buildExtractionMessages` from `../domain/documents/prompts.js`; `parseExtraction` from `../domain/documents/parse.js`; `callModelJson`, `type ModelMessage` from `../domain/models/gateway.js` and `../domain/models/types.js` |
| `src/tools/forms.ts` | `resolveOutFile`, `writeOutFile` from `../domain/storage/file-store.js` |
| `src/domain/tooling/types.ts` | its `GatewayConfig` import is already `../models/types.js` from Task 5 and now resolves |
| `src/effects.ts` | unchanged |

- [ ] **Step 5: Retarget three subpath exports**

`harness/core-tools/package.json`:

```json
    "./fake-gateway": "./src/domain/models/fake.ts",
    "./models": "./src/domain/models/gateway.ts",
    "./storage": "./src/domain/storage/layout.ts",
```

`@harness/approvals` imports `outRoot` and `realOrNearestAncestor` from
`@harness/core-tools/storage`. `outRoot` is in `layout.ts`; `realOrNearestAncestor` is not —
it is in `shared/paths.ts` now. Add the re-export to `layout.ts` so the specifier keeps
working until Task 8 switches approvals over:

```ts
// Re-exported for @harness/approvals' Slack file sink, which checks containment again as
// defence in depth. Task 8 points it at the public API and this line goes.
export { realOrNearestAncestor } from '../../shared/paths.js';
```

- [ ] **Step 6: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
pnpm lint
```
Expected: no errors.

```bash
pnpm arch
```
Expected: `0 errors`, and no `core-tools-domain-does-not-import-tools-or-app` warnings —
`domain/documents/manifest.ts` used to reach `tools/providers.ts` for `isRestrictedName` and
Task 4 already pointed it at `shared/`.

```bash
pnpm -r test
```
Expected: 7 packages pass, the same count as after Task 5 plus the two `fileStorage` tests.

- [ ] **Step 7: Commit**

```bash
git add -A harness/core-tools
git commit -m "refactor(core-tools): move storage, documents and models into domain folders"
```

---
### Task 7: `@harness/core-tools` — the last domains, thin tools, `index.ts` and `app/`

The task that finishes core-tools: five more domains, `tools/` reduced to definitions, a
public API, and a composition root that is the only place left reading the environment.

**Files:**
- Create: `src/domain/providers/types.ts`, `mask.ts`, `repository.ts`
- Create: `src/domain/forms/types.ts`, `provider-data.ts`
- Create: `src/domain/effects/types.ts`, `outbox.ts`
- Create: `src/domain/verify/types.ts`, `names.ts`, `nppes.ts`, `names.test.ts`
- Create: `src/domain/approvals/execute.ts`
- Create: `src/domain/documents/pipeline.ts`
- Create: `src/tools/catalog.ts`
- Create: `src/index.ts`
- Create: `harness/core-tools/README.md`
- Move: `src/deadlines/compute.ts` → `src/domain/deadlines/compute.ts` (and its test)
- Move: `src/forms/templates.ts`, `fill.ts`, `roster.ts` → `src/domain/forms/` (and their tests)
- Move: `src/main.ts` → `src/app/main.ts`; `src/main.test.ts` → `src/app/main.test.ts`
- Move: `src/record-surface.ts` → `src/app/record-surface.ts`; `src/surface.test.ts` → `src/app/surface.test.ts`
- Move: `src/skills-frontmatter.test.ts` → `src/tools/skills-frontmatter.test.ts`
- Move: `src/tools/verify.test.ts` `describe('namesMatch')` → `src/domain/verify/names.test.ts`
- Delete: `src/server.ts` (split into `src/tools/catalog.ts`, `src/app/server.ts` and `src/index.ts`), `src/effects.ts`, `src/effects.test.ts`
- Modify: all eight `src/tools/*.ts`, `src/testing.ts`, `harness/core-tools/package.json`, `eslint.config.js`, `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes: everything Tasks 4–6 produced.
- Produces the package's public API — the full `src/index.ts` is in Step 8 — plus:

  ```ts
  // domain/providers/types.ts
  FieldInput, CredentialInput                       // zod objects + inferred types
  interface UpsertProviderInput { name: string; npi?: string; fields: FieldInput[]; credentials: CredentialInput[]; providerId?: string }
  interface UpsertProviderResult { provider_id: string; fields_pending: number; fields_extracted: number; credentials: number }

  // domain/providers/mask.ts
  function fieldValueColumns(value: string, restricted: boolean, key: Buffer): { value: string | null; valueEncrypted: Buffer | null }
  function maskField(f: typeof fields.$inferSelect): { name: string; value: string | null; restricted: boolean; confidence: number | null; status: string; source_page: number | null }
  function maskCredential(c: typeof credentials.$inferSelect): { id: string; kind: string; issuer: string | null; number: string | null; state: string | null; expires_at: string | null }

  // domain/providers/repository.ts
  function requireProvider(deps: ToolDeps, providerId: string): Promise<typeof providers.$inferSelect>
  function upsertProviderRecord(deps: ToolDeps, args: UpsertProviderInput): Promise<UpsertProviderResult>
  function readProvider(deps: ToolDeps, providerId: string): Promise<{ provider; fields; credentials }>
  function searchProviders(deps: ToolDeps, query: string): Promise<{ provider_id: string; name: string; npi: string | null }[]>
  function confirmField(deps: ToolDeps, args: { provider_id: string; field: string; value: string; confirmed_by?: string }): Promise<void>
  function listPendingFields(deps: ToolDeps, providerId: string): Promise<{ name: string; confidence: number | null; source_page: number | null }[]>

  // domain/effects/types.ts
  SinkHandler, SinkRegistry, StageEffectInput, DispatchOptions, DispatchResult
  // domain/effects/outbox.ts
  function stageEffect(deps: ToolDeps, input: StageEffectInput): Promise<{ effect_id: string; staged: boolean }>
  function dispatchStagedEffects(db: Db, sinks: SinkRegistry, opts: DispatchOptions): Promise<DispatchResult>

  // domain/verify/types.ts
  interface VerifyConfig { nppesEnabled: boolean; nppesBaseUrl: string; stateLicenseEnabled: boolean; timeoutMs: number }
  interface NppesRecord { number: string | null; enumerationType: 'NPI-1' | 'NPI-2' | null; name: string | null; status: string | null; state: string | null }
  interface VerifyRegistry { lookupNpi(npi: string): Promise<NppesRecord | null> }
  // domain/verify/nppes.ts
  const NPPES_DEFAULT_BASE_URL = 'https://npiregistry.cms.hhs.gov/api/'
  function nppesRegistry(config: VerifyConfig): VerifyRegistry
  // domain/verify/names.ts
  function namesMatch(a: string, b: string): boolean

  // domain/approvals/execute.ts
  interface ExecutedApproval { approval_id: string; tool: string; status: 'executed'; result: unknown }
  function executeApproval(deps: ToolDeps, approvalId: string): Promise<ExecutedApproval>

  // domain/documents/pipeline.ts
  function requireDocument(deps: ToolDeps, documentId: string): Promise<typeof documents.$inferSelect>
  function documentView(row: typeof documents.$inferSelect): { id; provider_id; kind; storage_path; sha256; pages; ocr_used; has_text; ingested_at }
  function ingestDocument(deps: ToolDeps, args: { path: string; provider_id?: string; kind?: DocumentKind }): Promise<{ document_id; sha256; pages; storage_path; already_ingested }>
  function classifyDocument(deps: ToolDeps, documentId: string): Promise<{ document_id; document_kind; model_kind; confidence }>
  function extractDocument(deps: ToolDeps, args: { document_id: string; provider_id?: string }): Promise<{ document_id; provider_id; document_kind; ocr_used; pages; fields_pending; fields_extracted; credentials; restricted_fields }>

  // domain/forms/provider-data.ts
  function loadProviderData(deps: ToolDeps, providerId: string): Promise<ProviderData>

  // tools/catalog.ts
  const ALL_TOOLS: AnyToolDef[]
  function createCoreToolsServer(deps: ToolDeps): McpServer

  // app/server.ts
  function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }>
  ```

---

- [ ] **Step 1: Move the two folders that need no split**

```bash
cd harness/core-tools
mkdir -p src/domain/deadlines src/domain/forms src/domain/effects src/domain/verify src/domain/providers src/app
git mv src/deadlines/compute.ts src/domain/deadlines/compute.ts
git mv src/deadlines/compute.test.ts src/domain/deadlines/compute.test.ts
rmdir src/deadlines
git mv src/forms/templates.ts src/domain/forms/templates.ts
git mv src/forms/templates.test.ts src/domain/forms/templates.test.ts
git mv src/forms/fill.ts src/domain/forms/fill.ts
git mv src/forms/fill.test.ts src/domain/forms/fill.test.ts
git mv src/forms/roster.ts src/domain/forms/roster.ts
git mv src/forms/roster.test.ts src/domain/forms/roster.test.ts
rmdir src/forms
git mv src/main.ts src/app/main.ts
git mv src/main.test.ts src/app/main.test.ts
git mv src/record-surface.ts src/app/record-surface.ts
git mv src/surface.test.ts src/app/surface.test.ts
git mv src/skills-frontmatter.test.ts src/tools/skills-frontmatter.test.ts
cd ../..
```

Then fix the depth of every `shared/`, `domain/` and `tools/` import in the moved files:

```bash
cd harness/core-tools/src
sed -i '' -e "s#from '\.\./shared/#from '../../shared/#g" -e "s#from '\.\./domain/#from '../#g" \
  domain/deadlines/*.ts domain/forms/*.ts
sed -i '' -e "s#from '\./shared/#from '../shared/#g" -e "s#from '\./domain/#from '../domain/#g" \
  -e "s#from '\./tools/#from '../tools/#g" -e "s#from '\./server\.js'#from './server.js'#g" \
  -e "s#from '\./testing\.js'#from '../testing.js'#g" \
  app/*.ts
sed -i '' -e "s#from '\./server\.js'#from './catalog.js'#" tools/skills-frontmatter.test.ts
cd ../../..
```

The two files now in `app/` need their imports repointed by hand; the sed above only fixed the
prefixes it could see:

| File | Imports |
|---|---|
| `app/main.ts` | `buildDepsFromEnv` from `./server.js` (Step 9 creates it); `createCoreToolsServer` from `../tools/catalog.js`; `reconcile` from `../domain/tooling/reconcile.js`; `hashArgs`, `writeAudit` from `../domain/tooling/audit.js`; `createLogger` from `../shared/log.js` |
| `app/record-surface.ts` | `connectInProcess` from `../domain/tooling/in-process.js`; `DEFAULT_POLICY` from `../domain/tooling/policy.js`; `DEFAULT_CONFIDENCE_THRESHOLD`, `type ToolDeps` from `../domain/tooling/types.js`; `createCoreToolsServer` from `../tools/catalog.js`; `NPPES_DEFAULT_BASE_URL` from `../domain/verify/nppes.js` |
| `app/surface.test.ts` | unchanged — it imports only `./record-surface.js` |

`app/main.ts` and `app/record-surface.ts` also resolve the repository root from
`import.meta.url`; both gain one `..`. In `app/main.ts`:

```ts
loadEnv({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env'), quiet: true });
```

and in `app/record-surface.ts` and `app/surface.test.ts`:

```ts
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
```

`domain/forms/templates.ts`'s `defaultFormsDir` is the same kind of change and is the one most
likely to be missed, because nothing fails at compile time — it silently resolves to a
directory that does not exist and `forms_list_templates` starts reporting "no form templates
are installed". It moved from `src/forms/` to `src/domain/forms/`, one level deeper:

```ts
/**
 * Where the pack's templates live when nothing overrides it: five levels up
 * from `harness/core-tools/src/domain/forms/` is the repository root.
 */
export function defaultFormsDir(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../../packs/healthcare/forms');
}
```

`forms/templates.test.ts` asserts that `defaultFormsDir()` ends in `packs/healthcare/forms`
and that `loadManifest(defaultFormsDir())` parses, so the suite catches a wrong count.

Also point `domain/documents/manifest.ts` at the deadlines module's new home, which Task 6
left pointing one level too far up:

```bash
sed -i '' "s#from '../../deadlines/compute.js'#from '../deadlines/compute.js'#" \
  harness/core-tools/src/domain/documents/manifest.ts
```

- [ ] **Step 2: Build `domain/effects`**

`src/domain/effects/types.ts` takes lines 5-35 and 66-85 of old `src/effects.ts`:
`SinkHandler`, `SinkRegistry`, `StageEffectInput`, `DispatchOptions`, `DispatchResult` and the
internal `DispatchOutcome`, each with its comment.

`src/domain/effects/outbox.ts` takes the rest — `stageEffect`, `claimEffect`,
`finishDispatch`, `sendClaimedEffect`, `dispatchStagedEffects` — plus, at the bottom, a
re-export so that the `./effects` subpath keeps serving `@harness/approvals` both the
functions and the types it imports today:

```ts
export type { DispatchOptions, DispatchResult, SinkHandler, SinkRegistry, StageEffectInput } from './types.js';
```

```bash
cd harness/core-tools
git mv src/effects.test.ts src/domain/effects/outbox.test.ts
git rm src/effects.ts
sed -i '' \
  -e "s#from './effects.js'#from './outbox.js'#" \
  -e "s#from './registry.js'#from '../tooling/registry.js'#" \
  -e "s#from './testing.js'#from '../../testing.js'#" \
  src/domain/effects/outbox.test.ts
cd ../..
```

- [ ] **Step 3: Build `domain/providers`**

`src/domain/providers/types.ts` takes `tools/providers.ts` lines 7-26 (`FieldInput`,
`CredentialInput`) and 176-199 (`UpsertProviderInput`, `UpsertProviderResult`), comments
included. Its only imports are zod and `CREDENTIAL_KINDS` from `../deadlines/compute.js`.

`src/domain/providers/mask.ts` takes `fieldValueColumns` (lines 71-76), `maskField` (79-88)
and `maskCredential` (91-100), and imports `MASKED` from `../../shared/redaction/names.js`.
All three become exported; they were file-private before and three tools now need two of them.

`src/domain/providers/repository.ts` takes `requireProvider` (57-61), `findOrCreateProvider`
(102-117), `upsertField` (119-147), `upsertCredential` (149-174) and `upsertProviderRecord`
(207-222) unchanged, and gains four functions lifted out of the tool handlers so that
`tools/providers.ts` holds no SQL:

```ts
/** `providers_get`: the provider with its fields and credentials, restricted values masked. */
export async function readProvider(deps: ToolDeps, providerId: string) {
  const p = await requireProvider(deps, providerId);
  const fieldRows = await deps.db.select().from(fields).where(eq(fields.providerId, providerId));
  const credentialRows = await deps.db.select().from(credentials).where(eq(credentials.providerId, providerId));
  return {
    provider: { id: p.id, name: p.name, npi: p.npi, status: p.status },
    fields: fieldRows.map(maskField),
    credentials: credentialRows.map(maskCredential),
  };
}

/** `providers_search`: name fragment or exact NPI, at most 20, scoped to the client. */
export async function searchProviders(deps: ToolDeps, query: string) {
  const rows = await deps.db
    .select()
    .from(providers)
    .where(and(eq(providers.client, deps.client), or(ilike(providers.name, `%${query}%`), eq(providers.npi, query))))
    .limit(20);
  return rows.map((r) => ({ provider_id: r.id, name: r.name, npi: r.npi }));
}

/** `providers_confirm_field`: a human's value wins and the field becomes verified. */
export async function confirmField(
  deps: ToolDeps,
  args: { provider_id: string; field: string; value: string; confirmed_by?: string },
): Promise<void> {
  // tools/providers.ts lines 326-343, verbatim, minus the return statement
}

/** `providers_list_pending`: the fields still waiting on a human. */
export async function listPendingFields(deps: ToolDeps, providerId: string) {
  await requireProvider(deps, providerId);
  const rows = await deps.db
    .select()
    .from(fields)
    .where(and(eq(fields.providerId, providerId), eq(fields.status, 'pending')));
  return rows.map((r) => ({ name: r.name, confidence: r.confidence, source_page: r.sourcePage }));
}
```

`src/tools/providers.ts` is left with the five `defineTool` blocks and the exported array.
Every handler becomes one line, and the zod input and output schemas are copied across
**character for character** — they are the published surface and `surface.test.ts` compares
them. For example:

```ts
  handler: async ({ provider_id }, deps) => readProvider(deps, provider_id),
```

Its imports:

```ts
import * as z from 'zod/v4';
import { defineTool, type AnyToolDef } from '../domain/tooling/registry.js';
import { CREDENTIAL_KINDS } from '../domain/deadlines/compute.js';
import { CredentialInput, FieldInput } from '../domain/providers/types.js';
import {
  confirmField,
  listPendingFields,
  readProvider,
  requireProvider,
  searchProviders,
  upsertProviderRecord,
} from '../domain/providers/repository.js';
import { MASKED, isRestrictedName } from '../shared/redaction/names.js';
```

`requireProvider` and `isRestrictedName` were re-exported from `tools/providers.ts` in Task 4
for the other tools files. Drop both re-exports and point those importers at the domain:

```bash
cd harness/core-tools/src/tools
sed -i '' \
  -e "s#import { requireProvider } from './providers.js';#import { requireProvider } from '../domain/providers/repository.js';#" \
  -e "s#from './providers.js'#from '../domain/providers/repository.js'#g" \
  deadlines.ts verify.ts forms.ts documents.ts
cd ../../../..
```

`tools/documents.ts` also imports `upsertProviderRecord`, `type CredentialInput` and
`type FieldInput` from `./providers.js`; the types come from
`../domain/providers/types.js` and the function from the repository. `pnpm -r typecheck`
names each one.

- [ ] **Step 4: Build `domain/verify`**

`src/domain/verify/types.ts`:

```ts
/**
 * External registry lookups.
 *
 * `VerifyRegistry` is the seam: `nppesRegistry(config)` is the production adapter over the
 * public CMS endpoint, and a test double is a plain object with one method — no HTTP stub
 * and no base-URL juggling. `ToolDeps.verify` carries the configuration rather than a built
 * registry, so a test overrides `nppesBaseUrl` exactly as it does today; see ARCHITECTURE.md.
 */
export interface VerifyConfig {
  nppesEnabled: boolean;
  /** Registry endpoint, ending in a slash. Overridden in tests by a local stub. */
  nppesBaseUrl: string;
  stateLicenseEnabled: boolean;
  timeoutMs: number;
}

/**
 * A record the registry returned. Every field but the NPI is nullable,
 * because "the registry holds a record we could not read" and "the registry
 * holds no such NPI" are opposite answers to a credentialing question and
 * must not collapse into one. A record present but missing its enumeration
 * type, its number or its name is reported as found, with nulls where the
 * unreadable parts were.
 */
export interface NppesRecord {
  /** The NPI as the registry echoed it, or null when the record omits it. */
  number: string | null;
  enumerationType: 'NPI-1' | 'NPI-2' | null;
  /** Full name for an individual, organisation name for an organisation. Null when the record does not state one. */
  name: string | null;
  /** 'A' for active. Null when the registry omits it. */
  status: string | null;
  state: string | null;
}

export interface VerifyRegistry {
  /** Null means the registry has no such NPI, which is the expected answer for a synthetic one. */
  lookupNpi(npi: string): Promise<NppesRecord | null>;
}
```

`src/domain/verify/names.ts` takes `TITLES`, `SUFFIXES` and `namesMatch` from
`tools/verify.ts` lines 55-88, verbatim.

`src/domain/verify/nppes.ts` takes `NPPES_DEFAULT_BASE_URL`, the three response interfaces,
`recordFrom` and `fetchNppes`, and wraps the last one in the adapter:

```ts
export function nppesRegistry(config: VerifyConfig): VerifyRegistry {
  return { lookupNpi: (npi) => fetchNppes(npi, config) };
}
```

`fetchNppes` writes one operator line to `process.stderr` today. Replace it with the logger:

```ts
const log = createLogger('verify');
```

and, inside `fetchNppes`'s `Errors` branch, replace
`process.stderr.write(\`NPPES rejected a lookup: ${description}\n\`)` with:

```ts
    if (description) log.warn(`NPPES rejected a lookup: ${description}`);
```

The printed text gains a `verify: ` prefix and moves from `process.stderr.write` to
`console.error`; both land on stderr and no test asserts it —
`grep -rn "NPPES rejected a lookup" harness` finds the one call site.

`src/tools/verify.ts` is left with the two `defineTool` blocks. `verify_nppes`'s handler calls

```ts
    const record = await nppesRegistry(deps.verify).lookupNpi(npi);
```

and everything else in it is unchanged.

```bash
cd harness/core-tools
git mv src/tools/verify.test.ts src/domain/verify/names.test.ts
cd ../..
```

then split it back: `src/domain/verify/names.test.ts` keeps `describe('namesMatch')` (lines
81-93) and imports `namesMatch` from `./names.js`; everything else — the local HTTP stub at
the top of the file and `describe('verify_nppes')` and `describe('verify_state_license')` —
moves into a new `src/tools/verify.test.ts` with its imports pointed at
`../domain/tooling/types.js`, `../shared/errors.js`, `../testing.js`,
`../domain/providers/repository.js` and `./verify.js`.

- [ ] **Step 5: Build `domain/approvals/execute.ts` and `domain/documents/pipeline.ts`**

`src/domain/approvals/execute.ts` takes the whole handler body of `tools/approvals.ts`:

```ts
export interface ExecutedApproval {
  approval_id: string;
  tool: string;
  status: 'executed';
  result: unknown;
}

/**
 * Run an action a human approved. Succeeds at most once per approval: the row must be
 * approved and unexpired, and it becomes `executed` in the same transaction as the action, so
 * a failed action leaves the row approved and retryable.
 *
 * `deps.db` is already the registry's transaction, and the guarded UPDATE below locks the row.
 */
export async function executeApproval(deps: ToolDeps, approvalId: string): Promise<ExecutedApproval> {
  // tools/approvals.ts lines 22-64, verbatim, with `approval_id` renamed to `approvalId`
}
```

`src/tools/approvals.ts` keeps its `defineTool` block with the same name, description, input
and output schemas, and a one-line handler:

```ts
  handler: async ({ approval_id }, deps) => executeApproval(deps, approval_id),
```

`src/domain/documents/pipeline.ts` takes everything from `tools/documents.ts` that is not a
schema: `viewOf` (renamed `documentView`, because `view` says nothing and three tools now call
it), `requireDocument`, `readForModel`, `assertPromptRedacted`, and the three handler bodies
as `ingestDocument`, `classifyDocument` and `extractDocument`. `ClassificationReply` and
`ExtractionReply` move with them — they validate a model reply, which is domain work, not
tool-surface work.

`src/tools/documents.ts` keeps `DocumentView` (the zod object in the published output schema),
the five `defineTool` blocks and the exported array. Each handler is one line.

- [ ] **Step 6: Build `domain/forms/types.ts` and `provider-data.ts`**

`src/domain/forms/types.ts` collects the shapes that `templates.ts`, `fill.ts`, `roster.ts`
and `provider-data.ts` now share: `CREDENTIAL_PROPERTIES`, `TemplateMapping`, `FormTemplate`,
`TemplateManifest` (from `templates.ts` lines 8-50), `ProviderData` and `ResolvedMapping`
(from `fill.ts` lines 6-33), and `ROSTER_COLUMNS` and `RosterRow` (from `roster.ts` lines
1-40). Each keeps its comment, and the three modules import from it.

`src/domain/forms/provider-data.ts` takes `loadProviderData` from `tools/forms.ts` lines 14-44
verbatim, and the `fieldValue` helper from lines 126-130.

`src/domain/forms/release.ts` is new and takes the whole body of `forms_release`'s handler
from `tools/forms.ts` lines 211-234, including `MAX_RELEASE_BYTES`:

```ts
/** Slack rejects very large uploads and a 25 MB roster is a bug, not a roster. */
const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

export interface StagedRelease {
  effect_id: string;
  staged: boolean;
  file_id: string;
  filename: string;
  bytes: number;
}

/**
 * Stage a generated file for delivery. Resolves the id inside the out tree, refuses anything
 * that is not a readable file or is over the size limit, and stages one effect keyed on the
 * content-addressed id, so releasing the same bytes twice is one delivery.
 *
 * The `new Error('not a file')` below is a control-flow sentinel inside its own try, never
 * thrown out of this function — which is why it lives here and not in `tools/`, where the
 * project rule forbids the shape outright.
 */
export async function stageRelease(
  deps: ToolDeps,
  args: { file_id: string; channel?: string },
): Promise<StagedRelease> {
  // tools/forms.ts lines 212-234, verbatim
}
```

`src/tools/forms.ts` keeps the four `defineTool` blocks and the exported array; its
`forms_roster` handler moves its row-building loop into a new
`buildRoster(deps, payer_id, providerIds)` in `provider-data.ts`, so the tool is left with
`const rows = await buildRoster(deps, payer_id, [...new Set(provider_ids)]);` and the two
`writeOutFile` lines, and its `forms_release` handler becomes
`handler: async (args, deps) => stageRelease(deps, args)`.

- [ ] **Step 7: Build `tools/catalog.ts`**

```ts
import { McpServer } from '@modelcontextprotocol/server';
import { registerTools } from '../domain/tooling/registry.js';
import type { AnyToolDef, ToolDeps } from '../domain/tooling/types.js';
import { approvalTools } from './approvals.js';
import { auditTools } from './audit.js';
import { deadlineTools } from './deadlines.js';
import { documentTools } from './documents.js';
import { formTools } from './forms.js';
import { harnessTools } from './harness.js';
import { providerTools } from './providers.js';
import { verifyTools } from './verify.js';

/**
 * Every tool this server publishes, in the order they are registered. The order is not
 * meaningful to MCP but it is what `docs/architecture/tool-surface.json` is sorted against,
 * so adding a toolset here and forgetting to re-record the snapshot fails the suite.
 */
export const ALL_TOOLS: AnyToolDef[] = [
  ...providerTools,
  ...deadlineTools,
  ...auditTools,
  ...approvalTools,
  ...harnessTools,
  ...documentTools,
  ...formTools,
  ...verifyTools,
];

/**
 * An MCP server serving every tool against one set of dependencies. It reads no environment
 * and opens no connection — `app/server.ts` builds the dependencies — which is what lets the
 * eval runner and the surface recorder construct one in-process.
 */
export function createCoreToolsServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: 'core-tools', version: '0.1.0' });
  registerTools(server, ALL_TOOLS, deps);
  return server;
}
```

This lives in `tools/`, not in `app/`, for one reason: `src/index.ts` may not import `app/`,
and `@harness/evals` builds a server from the public API.

- [ ] **Step 8: Write `src/index.ts`**

```ts
/**
 * The public API of @harness/core-tools.
 *
 * This module and the subpaths in `package.json#exports` are the whole of what another
 * package may import. Nothing here reaches into `app/`: the composition root reads the
 * environment, opens a pool and starts a process, and a consumer that imported it would drag
 * all three into its own startup.
 *
 * Adding an export is a deliberate widening of the surface. Ask first whether the caller
 * wants a *fake* instead, which belongs under `./testing`.
 */

// --- The tooling kernel -------------------------------------------------------------------
export { defineTool, registerTools } from './domain/tooling/registry.js';
export { auditBaseFor, preservingContext, withCurrentTool } from './domain/tooling/context.js';
export { hashArgs, writeAudit, type AuditEntry, type Decision } from './domain/tooling/audit.js';
export {
  ACTION_CLASSES,
  BEHAVIORS,
  DEFAULT_POLICY,
  decide,
  loadPolicy,
  parsePolicy,
  type ActionClass,
  type Behavior,
  type Policy,
} from './domain/tooling/policy.js';
export {
  expireApprovals,
  parkStuckDispatches,
  reconcile,
  type ReconcileResult,
} from './domain/tooling/reconcile.js';
export { connectInProcess } from './domain/tooling/in-process.js';
export {
  DEFAULT_CONFIDENCE_THRESHOLD,
  type AnyToolDef,
  type AuditBase,
  type SessionContext,
  type ToolDef,
  type ToolDeps,
} from './domain/tooling/types.js';

// --- The tool catalogue -------------------------------------------------------------------
export { ALL_TOOLS, createCoreToolsServer } from './tools/catalog.js';

// --- Domains ------------------------------------------------------------------------------
export { createOrReuseApproval } from './domain/approvals/repository.js';
export { executeApproval, type ExecutedApproval } from './domain/approvals/execute.js';
export {
  CREDENTIAL_KINDS,
  LEAD_DAYS,
  URGENCY_BUCKETS,
  addDays,
  bucketFor,
  computeDeadlines,
  daysUntil,
  digestKeyFor,
  type CredentialKind,
  type UrgencyBucket,
} from './domain/deadlines/compute.js';
export {
  DOCUMENT_KINDS,
  type DocumentKind,
  type ExtractedText,
  type PageText,
  type ParsedExtraction,
} from './domain/documents/types.js';
export { loadHealthcareManifest, parseManifest, type ProviderManifest } from './domain/documents/manifest.js';
export { dispatchStagedEffects, stageEffect } from './domain/effects/outbox.js';
export {
  type DispatchOptions,
  type DispatchResult,
  type SinkHandler,
  type SinkRegistry,
  type StageEffectInput,
} from './domain/effects/types.js';
export { defaultFormsDir, getTemplate, loadManifest, mappingLabel } from './domain/forms/templates.js';
export { fillTemplatePdf, latestCredential, resolveMappings } from './domain/forms/fill.js';
export { buildRosterCsv } from './domain/forms/roster.js';
export {
  ROSTER_COLUMNS,
  type FormTemplate,
  type ProviderData,
  type ResolvedMapping,
  type RosterRow,
  type TemplateManifest,
  type TemplateMapping,
} from './domain/forms/types.js';
export { callModel, callModelJson, gatewayFromEnv, httpGateway } from './domain/models/gateway.js';
export {
  ROUTES,
  type GatewayConfig,
  type JsonSchemaSpec,
  type ModelCallOptions,
  type ModelCallResult,
  type ModelGateway,
  type ModelMessage,
  type Route,
} from './domain/models/types.js';
export { requireProvider, upsertProviderRecord } from './domain/providers/repository.js';
export {
  CredentialInput,
  FieldInput,
  type UpsertProviderInput,
  type UpsertProviderResult,
} from './domain/providers/types.js';
export {
  contentTag,
  documentTextPath,
  outRoot,
  storageRoot,
  toStorageRelative,
} from './domain/storage/layout.js';
export {
  fileStorage,
  readDocumentBytes,
  resolveOutFile,
  resolveStoragePath,
  sha256File,
  writeOutFile,
} from './domain/storage/file-store.js';
export { type Storage, type WriteFileInput, type WrittenFile } from './domain/storage/types.js';
export { namesMatch } from './domain/verify/names.js';
export { NPPES_DEFAULT_BASE_URL, nppesRegistry } from './domain/verify/nppes.js';
export { type NppesRecord, type VerifyConfig, type VerifyRegistry } from './domain/verify/types.js';

// --- Shared helpers, for the packages above this one ---------------------------------------
export { ConfigError, ModelOutputError, ToolError, describeError } from './shared/errors.js';
export {
  booleanFromEnv,
  numberFromEnv,
  optionalEnv,
  requiredEnv,
  type NumberEnvOptions,
} from './shared/env.js';
export { createLogger, type Logger } from './shared/log.js';
export {
  assertInsideRoot,
  realOrNearestAncestor,
  type EscapeReason,
  type InsideRootOptions,
} from './shared/paths.js';
export { runBounded, type RunBoundedOptions, type RunBoundedOutcome } from './shared/subprocess.js';
export { readJsonl, writeJsonl, type JsonlRow } from './shared/jsonl.js';
export { csvCell } from './shared/csv.js';
export { containsRestrictedPattern, isValidDea, type RestrictedKind } from './shared/redaction/patterns.js';
export { MASKED, isRestrictedName } from './shared/redaction/names.js';
export {
  assertRedacted,
  fieldNameFor,
  redactPages,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './shared/redaction/text.js';
```

- [ ] **Step 9: Write `src/app/server.ts`**

Everything left of the old `src/server.ts` — the composition root, and now the only module in
the package that names an environment variable.

```ts
import path from 'node:path';
import { createDb, loadKey } from '@harness/db';
import { loadPolicy } from '../domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from '../domain/tooling/types.js';
import { gatewayFromEnv } from '../domain/models/gateway.js';
import { storageRoot } from '../domain/storage/layout.js';
import { defaultFormsDir } from '../domain/forms/templates.js';
import { NPPES_DEFAULT_BASE_URL } from '../domain/verify/nppes.js';
import { booleanFromEnv, numberFromEnv, optionalEnv } from '../shared/env.js';

export async function buildDepsFromEnv(): Promise<{ deps: ToolDeps; close: () => Promise<void> }> {
  const { db, close } = createDb();
  const formsDir = optionalEnv('HARNESS_FORMS_DIR');
  const deps: ToolDeps = {
    db,
    client: optionalEnv('HARNESS_CLIENT') ?? 'default',
    caller: optionalEnv('CORE_TOOLS_CALLER') ?? 'hermes',
    policy: await loadPolicy(),
    encryptionKey: loadKey(),
    now: () => new Date(),
    approvalTtlHours: numberFromEnv('APPROVAL_TTL_HOURS', 24, { min: 1, max: 720 }),
    confidenceThreshold: numberFromEnv('CONFIDENCE_THRESHOLD', DEFAULT_CONFIDENCE_THRESHOLD, { min: 0, max: 1 }),
    gateway: gatewayFromEnv(),
    // One root for the whole file store, required and with no default (see
    // storageRoot). Ingested documents live under it as domain/storage lays
    // them out; generated output goes under `<root>/out`.
    storageDir: storageRoot(),
    formsDir: formsDir ? path.resolve(formsDir) : defaultFormsDir(),
    restrictedToModel: booleanFromEnv('HARNESS_RESTRICTED_TO_MODEL'),
    verify: {
      nppesEnabled: booleanFromEnv('VERIFY_NPPES_ENABLED'),
      nppesBaseUrl: optionalEnv('NPPES_BASE_URL') ?? NPPES_DEFAULT_BASE_URL,
      stateLicenseEnabled: booleanFromEnv('VERIFY_STATE_LICENSE_ENABLED'),
      timeoutMs: numberFromEnv('VERIFY_TIMEOUT_MS', 15_000, { min: 1_000, max: 60_000 }),
    },
    sinks: {},
    // One context object per process, shared by every connection this process
    // serves. That is correct for the stdio deployment, where Hermes starts one
    // process per session. A multi-session transport (HTTP) must not reuse this
    // deps object: it has to build one `deps` per session, or one session's run
    // id and skill would be stamped on another session's audit rows.
    context: {},
    tools: new Map(),
  };
  return { deps, close };
}
```

Note the two behaviour-preserving details. `HARNESS_CLIENT ?? 'default'` used
`process.env.HARNESS_CLIENT`, where an empty string would have been kept; `optionalEnv`
treats an empty string as absent, so an empty `HARNESS_CLIENT=` in a `.env` now falls back to
`default` instead of producing a client named `''`. That is a fix, it is unreachable from any
test, and it is worth stating out loud. The `formsDir` line preserves the old
`?.trim() ? path.resolve(...) : defaultFormsDir()` exactly.

```bash
git rm harness/core-tools/src/server.ts
```

`src/app/main.ts` now imports `buildDepsFromEnv` from `./server.js` and
`createCoreToolsServer` from `../tools/catalog.js`, and replaces its four `console.error`
calls with a logger:

```ts
import { createLogger } from '../shared/log.js';

const log = createLogger('core-tools');
```

`main.ts` is a CLI entrypoint, so `console.error` would be allowed there; it uses the logger
anyway so that every line in the process carries the same prefix. The four lines become
`log.info(...)`, `log.warn('reconcile at startup failed', err)` followed by `; continuing` in
the message, `log.info(...)` and `log.error('shutdown after ${signal} failed', err)`.
`main.test.ts` asserts only that the process starts and lists tools, so the wording is free.

- [ ] **Step 10: Repoint `src/testing.ts` and turn it into a barrel over the domain fakes**

Only the import block at the top and the two re-exports at the bottom change. The five
function bodies — `makeTestDeps`, `connectTestClient`, `connectTools`, `resultOf` and
`approvalIdOf` — are edited in place and keep every line they have today, including
`makeTestDeps`'s throwaway `mkdtempSync` storage directory and its unroutable
`nppesBaseUrl`. The file in full, with the unchanged bodies marked:

```ts
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { Client } from '@modelcontextprotocol/client';
import { McpServer } from '@modelcontextprotocol/server';
import { onTestFinished } from 'vitest';
import type { Db } from '@harness/db';
import { connectInProcess } from './domain/tooling/in-process.js';
import { registerTools } from './domain/tooling/registry.js';
import { DEFAULT_POLICY } from './domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type AnyToolDef, type ToolDeps } from './domain/tooling/types.js';
import { defaultFormsDir } from './domain/forms/templates.js';

export function makeTestDeps(db: Db, overrides: Partial<ToolDeps> = {}): ToolDeps {
  /* unchanged: src/testing.ts lines 16-43 as they stand after Task 4 */
}

export type TestClient = Client;

export async function connectTestClient(factory: () => McpServer): Promise<TestClient> {
  /* unchanged: src/testing.ts lines 66-69 */
}

export function connectTools(name: string, tools: AnyToolDef[], deps: ToolDeps): Promise<TestClient> {
  /* unchanged: src/testing.ts lines 73-77 */
}

export function resultOf<T>(res: { structuredContent?: unknown }): T {
  /* unchanged: src/testing.ts lines 82-86 */
}

export function approvalIdOf(res: { structuredContent?: unknown }): string {
  /* unchanged: src/testing.ts lines 91-95 */
}

/** The one `useTestDb`, from the package that owns the truncation list. */
export { useTestDb } from '@harness/db/testing';
/** The fake lives beside the interface it implements; this is where tests reach it. */
export {
  startFakeGateway,
  type FakeGateway,
  type FakeGatewayCall,
  type FakeReply,
  type Responder,
} from './domain/models/fake.js';
```

- [ ] **Step 11: Rewrite the `exports` map and the start script**

`harness/core-tools/package.json`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts",
    "./effects": "./src/domain/effects/outbox.ts",
    "./fake-gateway": "./src/domain/models/fake.ts",
    "./in-process": "./src/domain/tooling/in-process.ts",
    "./models": "./src/domain/models/gateway.ts",
    "./reconcile": "./src/domain/tooling/reconcile.ts",
    "./storage": "./src/domain/storage/layout.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "surface": "tsx src/app/record-surface.ts",
    "start": "tsx src/app/main.ts"
  },
```

Every existing subpath keeps working and keeps its meaning; `.` moves from `server.ts` to
`index.ts`, which is the point of the task. `./models`, `./reconcile` and `./testing` are
imported by no other package today — Task 11 removes the first two. The root
`surface:record` script becomes `pnpm --filter @harness/core-tools surface`; update it in the
root `package.json`.

- [ ] **Step 12: Write the package README**

Create `harness/core-tools/README.md`:

````markdown
# @harness/core-tools

The MCP server every agent talks to: the tooling kernel that applies policy, opens the
transaction and writes the audit row; the domains that hold the actual work; the 22 tools that
expose them; and the shared helpers the packages above this one import instead of copying.

## Layout

```
src/shared/        env, errors, paths, log, subprocess, jsonl, csv, redaction/ — no domain knowledge
src/domain/        tooling, approvals, deadlines, documents, effects, forms, models, providers, storage, verify
src/tools/         22 defineTool blocks in 8 files, plus catalog.ts
src/app/           server.ts (deps from the environment), main.ts (stdio entrypoint), record-surface.ts
src/index.ts       the public API
src/testing.ts     ./testing: makeTestDeps, connectTools, resultOf, approvalIdOf, useTestDb, startFakeGateway
```

## Public API

`@harness/core-tools` exports the kernel, every domain's public functions and types, and the
shared helpers — see `src/index.ts`, which is grouped and commented. The subpaths are
`./testing`, `./effects`, `./fake-gateway`, `./in-process`, `./models`, `./reconcile` and
`./storage`. Nothing under `src/app/` is reachable: the composition root reads the environment
and opens a pool, and a consumer that imported it would inherit both.

## How to test it

```bash
pnpm --filter @harness/core-tools test
```

Tests use the real Postgres on `127.0.0.1:15432` (`harness_test`) through `useTestDb()`, an
in-process MCP client through `connectTools`, and `startFakeGateway` — a real loopback HTTP
server — for anything that calls a model. No test reaches the network, Slack or a model
provider. Do not source `.env` first.

`src/app/surface.test.ts` compares the published tool schemas, the set of environment variable
names and the rendered Compose config against `docs/architecture/`. Regenerate with
`pnpm surface:record` when a change to any of them is intended.

## Adding a tool

See CONTRIBUTING.md. In one line: the logic goes in a domain, the `defineTool` block goes in
`src/tools/<area>.ts` and into that file's exported array, and `ALL_TOOLS` in
`src/tools/catalog.ts` already spreads it.
````

- [ ] **Step 13: Promote `@harness/core-tools` to error severity**

`eslint.config.js`:

```js
const STRICT_LAYER_ROOTS = ['harness/db/src', 'harness/gateway/src', 'harness/core-tools/src'];
```

`.dependency-cruiser.cjs`:

```js
  { name: 'core-tools', src: 'harness/core-tools/src', severity: 'error' },
```

- [ ] **Step 14: Run every gate**

```bash
pnpm -r typecheck
```
Expected: no output, exit 0.

```bash
pnpm lint
```
Expected: no errors. In particular no `no-console` and no `process.env` error anywhere under
`harness/core-tools/src`, and no `throw new Error` error under `src/tools/` — the one in
`tools/forms.ts:216` moved into `domain/forms/provider-data.ts` with the rest of the release
check, where a plain `Error` used as a control-flow sentinel inside a `try` is fine.

```bash
pnpm arch
```
Expected: `0 errors`.

```bash
pnpm -r test
```
Expected: 7 packages pass, the same count as after Task 6. **And the surface test still
passes** — that is the whole proof of this task. If `tool-surface.json` mismatches, a zod
schema was retyped instead of moved; diff the failure and put the original characters back
rather than re-recording.

- [ ] **Step 15: Commit**

Three commits, so the domains, the surface and the documents can be reviewed apart.

```bash
git add harness/core-tools/src/domain harness/core-tools/src/tools
git commit -m "refactor(core-tools): move the last domains out of tools/ and reduce tools to definitions"

git add harness/core-tools/src/index.ts harness/core-tools/src/app harness/core-tools/src/testing.ts harness/core-tools/package.json package.json
git commit -m "refactor(core-tools): add the public API and move the composition root into app/"

git add harness/core-tools/README.md eslint.config.js .dependency-cruiser.cjs
git commit -m "docs(core-tools): add the package README and enforce its layers"
```

---
### Task 8: `@harness/approvals` — shared helpers, one redaction source, a logger, domain folders

The package with the most duplication to remove: a byte-identical copy of the restricted-value
regexes, its own `numberFromEnv` with a third option shape, a `useTestDb` Task 2 already
replaced, and 22 hand-formatted `console.error` calls.

**Files:**
- Create: `src/domain/slack/types.ts`, `web-client.ts`, `fake.ts`, `handlers.ts`
- Create: `src/domain/render/types.ts`, `blocks.ts`, `modal.ts`
- Create: `src/domain/execute/types.ts`, `mcp-client.ts`, `fake.ts`
- Move: `src/poller.ts` → `src/domain/poller.ts` (and its test); `src/decisions.ts`, `src/sinks.ts`, `src/health.ts`, `src/runner.ts` likewise
- Move: `src/app.test.ts` → `src/domain/slack/handlers.test.ts`
- Move: `src/render.test.ts` → **split** into `src/domain/render/blocks.test.ts` and `src/domain/render/modal.test.ts`
- Move: `src/execute.test.ts` → `src/domain/execute/mcp-client.test.ts`
- Move: `src/child-env.ts` → `src/app/child-env.ts` (and its test); `src/main.ts` → `src/app/main.ts`
- Delete: `src/slack.ts`, `src/app.ts`, `src/render.ts`, `src/execute.ts`
- Modify: `src/index.ts`, `src/testing.ts`, `harness/approvals/package.json`
- Create: `harness/approvals/README.md`
- Modify: `eslint.config.js`, `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes, all from `@harness/core-tools`: `containsRestrictedPattern`, `createLogger`, `type Logger`, `numberFromEnv`, `requiredEnv`, `optionalEnv`, `assertInsideRoot`, `outRoot`, `describeError`. From `@harness/core-tools/effects`: `dispatchStagedEffects`, `type DispatchResult`, `type SinkHandler`, `type SinkRegistry`. From `@harness/db/testing`: `useTestDb`.
- Produces: the same public API as today, from the same module, with new internal paths. `src/index.ts` keeps exporting `slackSinks`, `webClientApi`, `type SlackApi`, `postPendingApprovals`, `type PollDeps`, `type PollResult`, `approvalBlocks`, `decidedBlocks`, `editModalView`, `parseEditModalMetadata`, `containsRestrictedPattern`, `payloadPreview`, `type ApprovalRow`, `type EditModalMetadata`, `createMcpCoreToolsClient`, `type CoreToolsClient`, `type ExecuteOutcome`, `type McpLauncher`, `decideApproval`, `threadReplyText`, `type DecisionDeps`, `type DecisionInput`, `type DecisionResult`, `registerApprovalHandlers`, `parseAllowedUsers`, `type ActionArgs`, `type AppDeps`, `type HandlerRegistry`, `type ViewArgs`, `startRunner`, `runPollTick`, `runDispatchTick`, `runReconcileTick`, `collectHealth`, `type RunnerDeps`, `type RunnerHandle`, `type RunnerIntervals`, `type RunnerStatus`, `type RunnerLoopStatus`, `type HealthSnapshot`, `startHealthServer`, `DEFAULT_HEALTH_BIND`, `type HealthServer`. `src/testing.ts` keeps exporting `FakeSlack`, `FakeCoreToolsClient` and `useTestDb`.

---

- [ ] **Step 1: Delete the duplicated regex list**

`src/render.ts` lines 12-26 hold `RESTRICTED_PATTERNS` and `containsRestrictedPattern`, and
the three regexes are byte-identical to the ones Task 4 moved out of
`harness/core-tools/src/tools/harness.ts`. Delete both and import the shared guard. In what
becomes `src/domain/render/blocks.ts`:

```ts
import { containsRestrictedPattern } from '@harness/core-tools';
```

and keep re-exporting it from `src/index.ts`, because `decisions.ts` and the tests import it
from the package today and `render.test.ts` asserts on it directly:

```ts
export { containsRestrictedPattern } from '@harness/core-tools';
```

Confirm the two lists were identical before deleting, so this is a deduplication and not a
behaviour change:

```bash
git show HEAD~8:harness/approvals/src/render.ts | sed -n '18,22p' > /tmp/a
git show HEAD~8:harness/core-tools/src/tools/harness.ts | sed -n '62,66p' > /tmp/b
diff /tmp/a /tmp/b && echo "identical"
```
Expected: `identical`. Adjust the `HEAD~8` to whatever commit precedes Task 4 in your branch;
`git log --oneline` finds it.

- [ ] **Step 2: Delete the local `numberFromEnv`**

`src/main.ts` lines 32-56 hold a third `numberFromEnv` plus the `seconds` and `port` wrappers.
Delete the function and keep the two wrappers, now over the shared reader. In what becomes
`src/app/main.ts`:

```ts
import { numberFromEnv, optionalEnv, requiredEnv } from '@harness/core-tools';

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });
```

and replace the local `required` helper with the shared one, keeping the hint:

```ts
function required(name: string): string {
  const hint = name.startsWith('APPROVALS_SLACK_') ? ' (the approvals app needs its own Slack app; see docs/runbook.md)' : '';
  return requiredEnv(name, hint);
}
```

`src/app/child-env.ts` loses `requiredFrom` entirely and calls the shared reader with the
environment it was handed:

```ts
import { requiredEnv } from '@harness/core-tools';

export function coreToolsChildEnv({ env, client, storageRoot }: ChildEnvInput): Record<string, string> {
  return {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    DATABASE_URL: requiredEnv('DATABASE_URL', '', env),
    HARNESS_ENCRYPTION_KEY: requiredEnv('HARNESS_ENCRYPTION_KEY', '', env),
    // …unchanged…
    LITELLM_MASTER_KEY: requiredEnv('LITELLM_MASTER_KEY', '', env),
    ...(env.HARNESS_POLICY_FILE ? { HARNESS_POLICY_FILE: env.HARNESS_POLICY_FILE } : {}),
    ...(env.HARNESS_FORMS_DIR ? { HARNESS_FORMS_DIR: env.HARNESS_FORMS_DIR } : {}),
    ...(env.HARNESS_GATEWAY_URL ? { HARNESS_GATEWAY_URL: env.HARNESS_GATEWAY_URL } : {}),
  };
}
```

`child-env.test.ts` asserts `/LITELLM_MASTER_KEY is not set/`, `/DATABASE_URL is not set/` and
`/HARNESS_ENCRYPTION_KEY is not set/`. `requiredEnv` produces exactly those strings, and it
treats an empty string as unset exactly as `requiredFrom` did, so line 32's
`LITELLM_MASTER_KEY: ''` case still throws.

- [ ] **Step 3: Delete the duplicate `useTestDb`**

Task 2 already replaced the body with a re-export. Confirm and move on:

```bash
grep -n "useTestDb" harness/approvals/src/testing.ts
```
Expected: one line, `export { useTestDb } from '@harness/db/testing';`.

- [ ] **Step 4: Introduce the logger at all 22 `console.error` sites**

One logger per module, scoped `approvals`, so every line keeps the `approvals: ` prefix it has
today and the hand-written prefix comes out of the message:

```ts
import { createLogger, describeError } from '@harness/core-tools';

const log = createLogger('approvals');
```

The complete list, old path and line, with the call it becomes. Every one of them keeps the
same words on stderr.

| Old site | Becomes |
|---|---|
| `main.ts:176` — the startup banner | `log.info(\`listening (client=${client}, channel=${channel}, buttons=…, modal=…)\`)` |
| `main.ts:181` — `${signal} received, stopping` | `log.info(\`${signal} received, stopping\`)` |
| `main.ts:190` — shutdown failed | `log.error('shutdown failed', err)` |
| `app.ts:81` — ack failed | `log.error('ack failed', err)` |
| `app.ts:90` — could not post an ephemeral notice | `log.error(\`could not post an ephemeral notice to ${userId}\`, err)` |
| `app.ts:102` — user is not an approver | `log.warn(\`user ${userId} is not an approver; refused action on ${approvalId}\`)` |
| `app.ts:110` — malformed approval id | `log.warn(\`rejected a malformed approval id from ${userId}\`)` |
| `app.ts:117` — not actionable | `log.info(\`${approvalId} was not actionable (already decided, expired, or another client's)\`)` |
| `app.ts:140` — handler failed | `log.error(\`${label} handler failed\`, err)` |
| `app.ts:147` — SLACK_ALLOWED_USERS is empty | `log.warn('SLACK_ALLOWED_USERS is empty; all decisions are refused')` |
| `app.ts:161` — Edit without a trigger id | `log.warn(\`Edit on ${value} arrived without a trigger id; cannot open the modal\`)` |
| `app.ts:166` — could not open the note modal | `log.error('could not open the note modal', err)` |
| `app.ts:177` — unreadable private metadata | `log.warn('modal submission arrived with unreadable private metadata')` |
| `app.ts:195` — modal submission handler failed | `log.error('modal submission handler failed', err)` |
| `decisions.ts:54` — no card to update | `log.warn(\`${row.id} has no card to update; the decision is recorded but not shown in Slack\`)` |
| `decisions.ts:70` — could not edit the card | `log.error(\`could not edit the card for ${row.id}\`, err)` |
| `decisions.ts:79` — could not post the thread reply | `log.error(\`could not post the thread reply for ${row.id}\`, err)` |
| `poller.ts:110` — could not post the card | `log.error(\`could not post the card for ${row.id}\`, err)` |
| `poller.ts:128` — posted but could not record the timestamp | `log.error(\`posted the card for ${row.id} but could not record its timestamp; leaving the claim in place so no duplicate is posted\`, err)` |
| `health.ts:52` — health snapshot failed | `log.error('health snapshot failed', err)` |
| `execute.ts:61` — core-tools call failed, reconnecting | `log.warn(\`core-tools call ${name} failed, reconnecting\`, err)` |
| `runner.ts:112` — a loop's tick failed | `log.error(message)` — `message` already carries the loop name and the error |

`log.error(msg, err)` prints `approvals: <msg>: <describeError(err)>`, which is the same string
the hand-written `${err instanceof Error ? err.message : String(err)}` produced. Every
remaining `err instanceof Error ? err.message : String(err)` in the package — in
`decisions.ts:117` and `runner.ts:108`, where the message is stored rather than printed —
becomes `describeError(err)`.

`app.test.ts`, `decisions.test.ts`, `poller.test.ts`, `runner.test.ts` and `health.test.ts`
assert on database rows, Slack fake calls and HTTP responses, never on stderr, so none of them
changes. Confirm before editing:

```bash
grep -rn "console" harness/approvals/src/*.test.ts
```
Expected: no output.

- [ ] **Step 5: Create the domain tree and move the single-module domains**

```bash
cd harness/approvals
mkdir -p src/domain/slack src/domain/render src/domain/execute src/app
git mv src/poller.ts src/domain/poller.ts
git mv src/poller.test.ts src/domain/poller.test.ts
git mv src/decisions.ts src/domain/decisions.ts
git mv src/decisions.test.ts src/domain/decisions.test.ts
git mv src/sinks.ts src/domain/sinks.ts
git mv src/sinks.test.ts src/domain/sinks.test.ts
git mv src/health.ts src/domain/health.ts
git mv src/health.test.ts src/domain/health.test.ts
git mv src/runner.ts src/domain/runner.ts
git mv src/runner.test.ts src/domain/runner.test.ts
git mv src/app.ts src/domain/slack/handlers.ts
git mv src/app.test.ts src/domain/slack/handlers.test.ts
git mv src/execute.test.ts src/domain/execute/mcp-client.test.ts
git mv src/render.test.ts src/domain/render/blocks.test.ts
git mv src/child-env.ts src/app/child-env.ts
git mv src/child-env.test.ts src/app/child-env.test.ts
git mv src/main.ts src/app/main.ts
cd ../..
```

- [ ] **Step 6: Split `slack.ts`, `render.ts` and `execute.ts`**

`src/domain/slack/types.ts` takes `slack.ts` lines 3-59: `SlackPostMessageArgs`,
`SlackUpdateArgs`, `SlackUploadArgs`, `SlackViewOpenArgs`, `SlackEphemeralArgs`,
`SlackPostResult` and `SlackApi`, comments included.

`src/domain/slack/web-client.ts` takes lines 1 and 61-108: `webClientApi` and its three
widen-at-the-boundary casts.

`src/domain/slack/fake.ts` takes `FakeSlack` out of `src/testing.ts`, unchanged, with

```ts
import type { SlackApi, SlackEphemeralArgs, SlackPostMessageArgs, SlackPostResult, SlackUpdateArgs, SlackUploadArgs, SlackViewOpenArgs } from './types.js';
```

`src/domain/render/types.ts` takes `render.ts` lines 1-10 and 126-130: `ApprovalRow`, the six
action and block ids, and `EditModalMetadata`.

`src/domain/render/blocks.ts` takes `payloadPreview`, `slackDate`, `contextBlock`,
`headerBlocks`, `button`, `approvalBlocks`, `approvalFallbackText`, `safeNote`,
`EXECUTION_FAILURE_FALLBACK`, `MAX_EXECUTION_ERROR_LENGTH`, `executionFailureLine` and
`decidedBlocks`.

`src/domain/render/modal.ts` takes `parseEditModalMetadata` and `editModalView`.

`src/domain/execute/types.ts` takes `execute.ts` lines 4-24: `ExecuteOutcome`,
`CoreToolsClient`, `McpLauncher` and the internal `CallResult`.

`src/domain/execute/mcp-client.ts` takes `textOf` and `createMcpCoreToolsClient`.

`src/domain/execute/fake.ts` takes `FakeCoreToolsClient` out of `src/testing.ts`, unchanged.

```bash
cd harness/approvals
git rm src/slack.ts src/render.ts src/execute.ts
cd ../..
```

Split `src/domain/render/blocks.test.ts`: it keeps `describe('containsRestrictedPattern')`,
`describe('payloadPreview')`, `describe('approvalBlocks')` and `describe('decidedBlocks')`;
move `describe('editModalView')` and `describe('parseEditModalMetadata')` into a new
`src/domain/render/modal.test.ts`, assertions untouched.

- [ ] **Step 7: Rewrite every import**

```bash
cd harness/approvals/src
sed -i '' \
  -e "s#from './slack.js'#from './slack/types.js'#g" \
  -e "s#from './render.js'#from './render/blocks.js'#g" \
  -e "s#from './execute.js'#from './execute/types.js'#g" \
  -e "s#from './testing.js'#from '../testing.js'#g" \
  domain/*.ts domain/*.test.ts
sed -i '' \
  -e "s#from './slack.js'#from './types.js'#g" \
  -e "s#from './render.js'#from '../render/types.js'#g" \
  -e "s#from './decisions.js'#from '../decisions.js'#g" \
  -e "s#from './testing.js'#from '../../testing.js'#g" \
  domain/slack/*.ts domain/render/*.ts domain/execute/*.ts
cd ../../..
```

Then fix by hand, guided by `pnpm -r typecheck`:

| File | Imports |
|---|---|
| `domain/poller.ts` | `approvalBlocks`, `approvalFallbackText` from `./render/blocks.js`; `type SlackApi` from `./slack/types.js` |
| `domain/decisions.ts` | `decidedBlocks` from `./render/blocks.js`; `containsRestrictedPattern` from `@harness/core-tools`; `type ApprovalRow` from `./render/types.js`; `type CoreToolsClient`, `type ExecuteOutcome` from `./execute/types.js` |
| `domain/sinks.ts` | `type SinkHandler`, `type SinkRegistry` from `@harness/core-tools/effects`; `assertInsideRoot` from `@harness/core-tools`; `type SlackApi` from `./slack/types.js` |
| `domain/runner.ts` | `dispatchStagedEffects`, `type DispatchResult`, `type SinkRegistry` from `@harness/core-tools/effects`; `type SlackApi` from `./slack/types.js`; `type CoreToolsClient` from `./execute/types.js`; `postPendingApprovals`, `type PollResult` from `./poller.js` |
| `domain/health.ts` | `type HealthSnapshot` from `./runner.js` |
| `domain/slack/handlers.ts` | `decideApproval`, `type DecisionDeps` from `../decisions.js`; the ids from `../render/types.js`; `editModalView`, `parseEditModalMetadata` from `../render/modal.js` |
| `app/main.ts` | `outRoot` from `@harness/core-tools`; everything else from `../domain/...` |

`domain/sinks.ts` is the one behavioural rewrite in this step. Its private `assertUnderRoot`
(lines 47-69) becomes a call to the shared containment check, keeping both of its messages:

```ts
async function assertUnderRoot(candidate: string, root: string, effectId: string): Promise<void> {
  await assertInsideRoot(
    candidate,
    root,
    (reason) => {
      throw new Error(
        reason === 'unreadable'
          ? `slack_file: staged file unavailable (effect ${effectId})`
          : `slack_file: path outside the release directory (effect ${effectId})`,
      );
    },
    // realpath errors (ELOOP, EACCES, ENOTDIR) carry the absolute path in their message;
    // keep it out of the plaintext `tool_effects.last_error`.
    { onUnreadable: 'escape' },
  );
}
```

`realOrNearestAncestor` is no longer imported here; `assertInsideRoot` calls it internally.

- [ ] **Step 8: Rewrite `index.ts` and `testing.ts`**

`src/index.ts`:

```ts
export { slackSinks } from './domain/sinks.js';
export { webClientApi } from './domain/slack/web-client.js';
export type { SlackApi } from './domain/slack/types.js';
export { postPendingApprovals, type PollDeps, type PollResult } from './domain/poller.js';
export { approvalBlocks, approvalFallbackText, decidedBlocks, payloadPreview } from './domain/render/blocks.js';
export { editModalView, parseEditModalMetadata } from './domain/render/modal.js';
export {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_MODAL_CALLBACK_ID,
  EDIT_NOTE_ACTION_ID,
  EDIT_NOTE_BLOCK_ID,
  type ApprovalRow,
  type EditModalMetadata,
} from './domain/render/types.js';
/** The one restricted-value guard, from the package that owns the patterns. */
export { containsRestrictedPattern } from '@harness/core-tools';
export { createMcpCoreToolsClient } from './domain/execute/mcp-client.js';
export type { CoreToolsClient, ExecuteOutcome, McpLauncher } from './domain/execute/types.js';
export {
  decideApproval,
  threadReplyText,
  type DecisionDeps,
  type DecisionInput,
  type DecisionResult,
} from './domain/decisions.js';
export {
  parseAllowedUsers,
  registerApprovalHandlers,
  type ActionArgs,
  type AppDeps,
  type HandlerRegistry,
  type ViewArgs,
} from './domain/slack/handlers.js';
export {
  collectHealth,
  runDispatchTick,
  runPollTick,
  runReconcileTick,
  startRunner,
  type HealthSnapshot,
  type RunnerDeps,
  type RunnerHandle,
  type RunnerIntervals,
  type RunnerLoopStatus,
  type RunnerStatus,
} from './domain/runner.js';
export { DEFAULT_HEALTH_BIND, startHealthServer, type HealthServer } from './domain/health.js';
```

The six Slack ids were reachable from `main.ts` but not exported before; they are now, because
`main.ts` is in `app/` and may not be imported by anything, so the ids have to come from the
public API. That widens the surface by six constants and nothing else.

`src/testing.ts`:

```ts
export { FakeSlack } from './domain/slack/fake.js';
export { FakeCoreToolsClient } from './domain/execute/fake.js';
export { useTestDb } from '@harness/db/testing';
```

- [ ] **Step 9: Write the README**

Create `harness/approvals/README.md`:

````markdown
# @harness/approvals

The Slack app a human approves through. It polls `approvals` for pending rows and posts a
Block Kit card, records the decision, calls `approvals_execute` over a stdio MCP client, and
drains the `tool_effects` outbox through Slack sinks on a timer.

## Layout

```
src/domain/slack/     the SlackApi interface, the WebClient adapter, FakeSlack, the button handlers
src/domain/render/    types (ids, ApprovalRow), blocks (cards), modal (the note dialog)
src/domain/execute/   the CoreToolsClient interface, the stdio MCP adapter, FakeCoreToolsClient
src/domain/poller.ts  claim a pending row, post its card, record the timestamp
src/domain/decisions.ts  the one writer of approvals.status outside core-tools
src/domain/sinks.ts   slack_message and slack_file senders for the outbox
src/domain/runner.ts  three independent loops: poll, dispatch, reconcile
src/domain/health.ts  GET /healthz for the cron watchdogs
src/app/main.ts       Bolt in Socket Mode, the runner, the health server
src/app/child-env.ts  the allowlist the core-tools child process is launched with
src/index.ts          the public API
src/testing.ts        ./testing: FakeSlack, FakeCoreToolsClient, useTestDb
```

## Two Slack apps, not one

This process needs `APPROVALS_SLACK_BOT_TOKEN` and `APPROVALS_SLACK_APP_TOKEN`, which are a
*different* Slack app from Hermes's. Slack routes each Socket Mode event to exactly one of an
app's open connections, so one shared app loses about half of every button click. There is
deliberately no fallback to `SLACK_BOT_TOKEN`.

## What it must never do

- Write `approvals.status` anywhere but `decideApproval`.
- Call a tool handler directly. Execution goes through `approvals_execute` over MCP, so it
  lands in `audit_log` like any other call.
- Put a restricted value on a card. `containsRestrictedPattern` from `@harness/core-tools`
  guards the payload, the decision note and a tool's error text, and the file sink checks
  containment again before it uploads anything.

## Testing

```bash
pnpm --filter @harness/approvals test
```

Real Postgres (`harness_test`) through `useTestDb()`, `FakeSlack` and `FakeCoreToolsClient`
from `./testing`. No real Slack call anywhere in the suite.
````

- [ ] **Step 10: Promote `@harness/approvals` to error severity**

`eslint.config.js`: append `'harness/approvals/src'` to `STRICT_LAYER_ROOTS`.
`.dependency-cruiser.cjs`: `{ name: 'approvals', src: 'harness/approvals/src', severity: 'error' },`

- [ ] **Step 11: Run every gate**

```bash
pnpm -r typecheck
pnpm lint
pnpm arch
pnpm -r test
```
Expected: clean typecheck; **zero `no-console` warnings anywhere in the repository** — this is
the task that removes the last 22; `0 errors` from cruiser; 7 packages pass with the same
count as after Task 7.

```bash
grep -rn "console\." harness packs evals scripts --include='*.ts' | grep -v node_modules | grep -v '/app/' | grep -v 'shared/log.ts' | grep -v 'cli.ts' | grep -v 'generate-templates.ts'
```
Expected: no output.

- [ ] **Step 12: Commit**

```bash
git add -A harness/approvals eslint.config.js .dependency-cruiser.cjs
git commit -m "refactor(approvals): adopt domain folders, the shared helpers and one redaction source"
```

---
### Task 9: `@harness/evals` — domain folders, `app/cli.ts`, README

`run.ts` is 394 lines holding flag parsing, orchestration, scoring aggregation and file I/O.
Splitting it separates "what the eval measures" from "how the command line asks for it", and
lets the package finally have a public API that is not the CLI module.

**Files:**
- Move: `src/cases.ts` → `src/domain/cases.ts`; `src/pipeline.ts` → `src/domain/pipeline.ts`; `src/score.ts` → `src/domain/score.ts` (and their tests)
- Create: `src/domain/judge/types.ts`, `prompts.ts`, `verdict.ts`; delete `src/judge.ts`
- Create: `src/domain/report/types.ts`, `build.ts`, `render.ts`; delete `src/report.ts`
- Create: `src/domain/orchestrate.ts`, `src/app/cli.ts`, `src/index.ts`; delete `src/run.ts`
- Move and split the four affected test files
- Modify: `evals/package.json`, `evals/tsconfig.json` (no change needed — it already includes `src`)
- Create: `evals/README.md`
- Modify: `eslint.config.js`, `.dependency-cruiser.cjs`

**Interfaces:**
- Consumes from `@harness/core-tools`: `readJsonl`, `type JsonlRow`, `createLogger`, `describeError`, `optionalEnv`, plus everything it imports today (`DEFAULT_POLICY`, `DEFAULT_CONFIDENCE_THRESHOLD`, `MASKED`, `createCoreToolsServer`, `defaultFormsDir`, `gatewayFromEnv`, `assertRedacted`, `callModelJson`, `isRestrictedName`, `type GatewayConfig`, `type Policy`, `type ToolDeps`). From `@harness/core-tools/in-process`: `connectInProcess`. From `@harness/core-tools/fake-gateway` in tests: `startFakeGateway`.
- Produces, from the new `evals/src/index.ts`:

  ```ts
  runEvals(opts: RunOptions): Promise<{ report: Report; markdown: string; exitCode: number }>
  selectCases(cases: ExtractionCase[], limit?: number): ExtractionCase[]
  injectionCasesFor(c: ExtractionCase, injectionCases: InjectionCase[]): InjectionCase[]
  type RunOptions
  loadExtractionCases(file: string): Promise<ExtractionCase[]>
  loadInjectionCases(file: string): Promise<InjectionCase[]>
  declaredToolsOf(skillFile: string): string[]
  INTAKE_DECLARED_TOOLS, INTAKE_SKILL_FILE
  type ExtractionCase, type InjectionCase, type ExpectedCredential
  openPipeline(opts: OpenPipelineOptions): Promise<PipelineHandle>
  runCase(handle: PipelineHandle, c: ExtractionCase): Promise<CaseOutcome>
  normalizeMasking(fields: StoredField[]): StoredField[]
  type PipelineHandle, type OpenPipelineOptions
  normalizeValue, scoreExtraction, scoreCalibration, scoreInjection
  type CaseOutcome, type StoredField, type StoredCredential, type Tally, type CalibrationRow, type CalibrationScore
  FREE_TEXT_FIELDS, judgeFreeText, type JudgeItem, type JudgeResult, type JudgeVerdict
  METRIC_KEYS, DEFAULT_TOLERANCE, buildReport, compareToBaseline, renderMarkdown
  type Report, type SplitReport, type BuildReportInput, type BaselineComparison, type Delta
  ```

  `parseLimitFlag` and `parseUpdateBaselineFlag` stay in `src/app/cli.ts` and are **not**
  exported from the package: they parse `process.argv`, which is composition-root work.

---

- [ ] **Step 1: Move the three single-module domains**

```bash
cd evals
mkdir -p src/domain/judge src/domain/report src/app
git mv src/cases.ts src/domain/cases.ts
git mv src/cases.test.ts src/domain/cases.test.ts
git mv src/pipeline.ts src/domain/pipeline.ts
git mv src/pipeline.test.ts src/domain/pipeline.test.ts
git mv src/score.ts src/domain/score.ts
git mv src/score.test.ts src/domain/score.test.ts
cd ..
```

`src/domain/cases.ts` also drops its private `JsonlRow` and `readJsonlRows` (lines 93-119) for
the shared reader, keeping both error messages exactly:

```ts
import { readJsonl } from '@harness/core-tools';

export async function loadJsonl<T = unknown>(file: string): Promise<T[]> {
  return (await readJsonl<T>(file, 'case file')).map((r) => r.value);
}

export async function loadExtractionCases(file: string): Promise<ExtractionCase[]> {
  const rows = await readJsonl<Partial<ExtractionCase>>(file, 'case file');
  // …the rest unchanged…
}

export async function loadInjectionCases(file: string): Promise<InjectionCase[]> {
  const rows = await readJsonl<Partial<InjectionCase>>(file, 'case file');
  // …the rest unchanged…
}
```

`readJsonl` produces `cannot read case file <path>` and
`<basename> line <n> is not valid JSON`, which are the two strings `cases.ts` produced. Its
`INTAKE_SKILL_FILE` resolves the skill relative to `import.meta.url` and the file moved one
level deeper:

```ts
export const INTAKE_SKILL_FILE = path.resolve(here, '../../../packs/healthcare/skills/credentialing-intake/SKILL.md');
```

`cases.test.ts` asserts `declaredToolsOf(INTAKE_SKILL_FILE)` against the real skill, so a
wrong count fails loudly.

- [ ] **Step 2: Split the judge**

`src/domain/judge/types.ts` takes `judge.ts` lines 15-48: `FREE_TEXT_FIELDS`, `JudgeItem`,
`JudgeVerdict`, `JudgeResult`.

`src/domain/judge/prompts.ts` takes lines 50-95: `JUDGE_SCHEMA`, `JudgeReply` and the `SYSTEM`
string, the last renamed `JUDGE_SYSTEM_PROMPT` so that the name says which prompt it is — the
package will have more than one.

`src/domain/judge/verdict.ts` takes `NOTHING_TO_JUDGE` and `judgeFreeText`.

```bash
cd evals
git mv src/judge.test.ts src/domain/judge/verdict.test.ts
git rm src/judge.ts
cd ..
```

`verdict.test.ts` keeps `describe('judgeFreeText')`; move `describe('FREE_TEXT_FIELDS')` into
a new `src/domain/judge/types.test.ts`.

- [ ] **Step 3: Split the report**

`src/domain/report/types.ts` takes `report.ts` lines 3-76: `SplitReport`, `Report`,
`METRIC_KEYS`, `LOWER_IS_BETTER`, `ZERO_TOLERANCE`, `BuildReportInput`, plus `Delta` and
`BaselineComparison` from lines 108-140.

`src/domain/report/build.ts` takes `buildReport`, `DEFAULT_TOLERANCE` and `compareToBaseline`.

`src/domain/report/render.ts` takes `pct` and `renderMarkdown`.

```bash
cd evals
git mv src/report.test.ts src/domain/report/build.test.ts
git rm src/report.ts
cd ..
```

`build.test.ts` keeps `describe('buildReport')`, `describe('buildReport with no judge')` and
`describe('compareToBaseline')`; move `describe('renderMarkdown')` into a new
`src/domain/report/render.test.ts`.

- [ ] **Step 4: Split the runner**

`src/domain/orchestrate.ts` takes `run.ts` lines 1-274 — `RunOptions`, `selectCases`,
`injectionCasesFor`, `warnOnUnmatchedInjectionRows` and `runEvals` — with two changes. The two
`process.stderr.write` calls become logger lines:

```ts
import { createLogger } from '@harness/core-tools';

const log = createLogger('evals');
```

`warnOnUnmatchedInjectionRows`:

```ts
      log.warn(`injection row ${ic.id} names ${ic.path}, which is not an injection document in this corpus; it asserts nothing`);
```

and the per-case failure:

```ts
        log.warn(`FAIL ${c.id}: ${outcome.error}`);
```

Both keep the same words, gain an `evals: ` prefix and move from `process.stderr.write` to
`console.error` inside the logger — both are stderr, and `run.test.ts` asserts on the returned
report and exit code, never on stderr. Confirm with
`grep -n "stderr" evals/src/run.test.ts` before editing.

The `here`/`repoRoot` constants at the top of `run.ts` belong to the CLI and move with it.
`runEvals` takes every path through `RunOptions` already, so `orchestrate.ts` needs neither.

`src/app/cli.ts` takes `run.ts` lines 276-394 — `flagFrom`, `flag`, `parseLimitFlag`,
`parseUpdateBaselineFlag` and the entrypoint block — plus the `here`/`repoRoot` constants,
re-based for the extra level:

```ts
const here = path.dirname(fileURLToPath(import.meta.url));
// evals/src/app -> the repository root
const repoRoot = path.resolve(here, '../../..');
```

and it reads its two environment variables through the shared helpers:

```ts
  const routing = JSON.parse(optionalEnv('EVALS_SERVING_MODEL') ?? '{}') as Record<string, string>;
  // …
  databaseUrl: optionalEnv('EVALS_DATABASE_URL') ?? 'postgres://harness:harness@localhost:15432/harness_evals',
```

The `if (process.argv[1] && …)` guard goes: nothing imports `app/cli.ts`.

```bash
cd evals
git mv src/run.test.ts src/domain/orchestrate.test.ts
git rm src/run.ts
cd ..
```

`orchestrate.test.ts` keeps `describe('runEvals')`, `describe('selectCases')` and
`describe('injectionCasesFor')`. Move `describe('parseUpdateBaselineFlag')`,
`describe('parseLimitFlag')` and `describe('CLI')` into a new `src/app/cli.test.ts`, with the
shared fixture code those three need copied across — `describe('CLI')` spawns the entrypoint,
so update the path it spawns from `src/run.ts` to `src/app/cli.ts`.

- [ ] **Step 5: Write `src/index.ts`**

```ts
/**
 * The public API of @harness/evals.
 *
 * `app/cli.ts` is deliberately absent: it parses `process.argv` and resolves paths against the
 * repository root, which is composition-root work. Run it through `pnpm evals`.
 */
export {
  injectionCasesFor,
  runEvals,
  selectCases,
  type RunOptions,
} from './domain/orchestrate.js';
export {
  INTAKE_DECLARED_TOOLS,
  INTAKE_SKILL_FILE,
  declaredToolsOf,
  loadExtractionCases,
  loadInjectionCases,
  loadJsonl,
  type ExpectedCredential,
  type ExtractionCase,
  type InjectionCase,
} from './domain/cases.js';
export {
  normalizeMasking,
  openPipeline,
  runCase,
  type OpenPipelineOptions,
  type PipelineHandle,
} from './domain/pipeline.js';
export {
  normalizeValue,
  scoreCalibration,
  scoreExtraction,
  scoreInjection,
  type CalibrationRow,
  type CalibrationScore,
  type CaseOutcome,
  type StoredCredential,
  type StoredField,
  type Tally,
} from './domain/score.js';
export { judgeFreeText } from './domain/judge/verdict.js';
export { FREE_TEXT_FIELDS, type JudgeItem, type JudgeResult, type JudgeVerdict } from './domain/judge/types.js';
export { DEFAULT_TOLERANCE, buildReport, compareToBaseline } from './domain/report/build.js';
export { renderMarkdown } from './domain/report/render.js';
export {
  METRIC_KEYS,
  type BaselineComparison,
  type BuildReportInput,
  type Delta,
  type Report,
  type SplitReport,
} from './domain/report/types.js';
```

- [ ] **Step 6: Point `package.json` at the new entry points**

```json
  "exports": {
    ".": "./src/index.ts",
    "./score": "./src/domain/score.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
    "start": "tsx src/app/cli.ts"
  },
```

The root `evals` and `evals:baseline` scripts call `pnpm --filter @harness/evals start`, so
they need no change. `./score` is imported by nothing outside this package; Task 11 removes it.

- [ ] **Step 7: Write the README**

Create `evals/README.md`:

````markdown
# @harness/evals

The offline measurement of the document pipeline. It ingests and extracts every document in a
synthetic corpus through the real core-tools server, scores what was *stored* rather than what
the model said, and compares the result to a committed baseline.

## Layout

```
src/domain/cases.ts       load cases.jsonl and injection.jsonl; read a skill's declared tools
src/domain/pipeline.ts    the real MCP server in-process against a real database
src/domain/score.ts       field, credential, restricted-recall, calibration and injection scoring
src/domain/judge/         a second opinion on free-text misses: types, prompts, verdict
src/domain/report/        types (the metric keys), build (compare to baseline), render (markdown)
src/domain/orchestrate.ts runEvals: selection, the per-case loop, the report, the exit code
src/app/cli.ts            flag parsing and the `pnpm evals` entrypoint
src/index.ts              the public API
```

## Running it

```bash
pnpm synth            # generate the corpus first
pnpm evals            # scores it and writes evals/results/report.{json,md}
pnpm evals:baseline   # the same, then writes the report to evals/baseline.json
```

It uses its own database, `harness_evals`, because it truncates every table between cases.
The exit code is the CI contract: non-zero on a regression, on a metric the baseline measured
that this run did not, or on any failed injection case. "No baseline yet" is not a pass.

## Testing

```bash
pnpm --filter @harness/evals test
```

`startFakeGateway` from `@harness/core-tools/fake-gateway` stands in for the model; no test
calls a provider.
````

- [ ] **Step 8: Promote and run every gate**

`eslint.config.js`: append `'evals/src'` to `STRICT_LAYER_ROOTS`.
`.dependency-cruiser.cjs`: `{ name: 'evals', src: 'evals/src', severity: 'error' },`

```bash
pnpm -r typecheck
pnpm lint
pnpm arch
pnpm -r test
```
Expected: clean; `0 errors`; 7 packages pass with the same count as after Task 8 — the four
split test files move describes, they add nothing.

- [ ] **Step 9: Commit**

```bash
git add -A evals eslint.config.js .dependency-cruiser.cjs
git commit -m "refactor(evals): split the runner into domain modules and an app cli"
```

---
### Task 10: `packs/healthcare` synthetic split, `scripts` tidy, and both READMEs

`synthetic/generate.ts` is 553 lines holding a random-number generator, five fixture tables, a
PDF writer, a rasteriser, four document plans, the orchestration and a CLI. `scripts` is one
177-line file that mixes a scaffolder with its command line.

**A note before starting: neither package may import `@harness/core-tools`.**
`packs/healthcare` is a *dependency* of core-tools (core-tools reads
`@harness/pack-healthcare/schema`), so importing back would be a cycle, and `scripts` has no
reason to. The pack therefore keeps its own bounded `execFile` call and its own two-line JSONL
writer, exactly as `@harness/db` keeps its own logger and for the same reason. Both are
flagged in ARCHITECTURE.md as the places to revisit if the declined `@harness/shared` package
is ever revisited.

**Files:**
- Create: `packs/healthcare/synthetic/types.ts`, `rng.ts`, `fixtures.ts`, `pdf.ts`, `plan.ts`, `cli.ts`, `rng.test.ts`
- Modify: `packs/healthcare/synthetic/generate.ts` (reduced to `assertSafeToClear` and `generate`), `generate.test.ts` (loses one describe)
- Modify: `packs/healthcare/package.json`, `packs/healthcare/README.md`
- Create: `scripts/src/domain/scaffold.ts`, `scripts/src/app/cli.ts`, `scripts/README.md`
- Move: `scripts/new-client.ts` → split as above; `scripts/new-client.test.ts` → `scripts/src/domain/scaffold.test.ts`
- Modify: `scripts/tsconfig.json`, `package.json` (root — the `new-client` script)
- Modify: `.dependency-cruiser.cjs` (two new rows)

**Interfaces:**
- Consumes: nothing new.
- Produces:

  ```ts
  // packs/healthcare/synthetic/types.ts
  type SyntheticKind = 'state_license' | 'dea_certificate' | 'malpractice_certificate' | 'w9'
  interface SyntheticProvider { /* the 30 fields, unchanged */ }
  interface GroundTruthCredential { kind: 'license'|'dea'|'malpractice'|'board_cert'; state?: string; issuer: string; issued_at?: string; expires_at: string }
  interface GroundTruthDocument { document_id; provider_id; kind: SyntheticKind; split: 'text_layer'|'scan'; path; fields; credentials; restricted }
  interface GroundTruth { seed: number; generated_at: string; providers: SyntheticProvider[]; documents: GroundTruthDocument[] }
  interface GenerateOptions { outDir: string; count?: number; seed?: number; scans?: boolean; injection?: boolean }
  interface PageSpec { title: string; lines: string[] }
  interface DocumentPlan { kind: SyntheticKind; pages: PageSpec[]; fields: Record<string,string>; credentials: GroundTruthCredential[]; restricted: Record<string,string> }

  // packs/healthcare/synthetic/rng.ts
  function mulberry32(seed: number): () => number
  function pick<T>(rng: () => number, items: readonly T[]): T
  function digits(rng: () => number, n: number): string
  function luhnNpi(rng: () => number): string
  function deaNumber(rng: () => number, lastInitial: string): string
  function ssn(rng: () => number): string

  // packs/healthcare/synthetic/fixtures.ts
  const STATE_BOARD: Record<string, string>
  function isoDate(year: number, month: number, day: number): string
  function makeProvider(rng: () => number, index: number): SyntheticProvider

  // packs/healthcare/synthetic/pdf.ts
  function writeTextPdf(target: string, pages: PageSpec[]): Promise<void>
  function writeScanPdf(sourcePdf: string, target: string, scratchDir: string): Promise<void>

  // packs/healthcare/synthetic/plan.ts
  function planFor(p: SyntheticProvider): DocumentPlan[]
  function injectionPlan(p: SyntheticProvider): DocumentPlan

  // packs/healthcare/synthetic/generate.ts — unchanged exports
  function assertSafeToClear(outDir: string): Promise<void>
  function generate(options: GenerateOptions): Promise<GroundTruth>

  // scripts/src/domain/scaffold.ts
  interface NewClientOptions { /* unchanged */ }
  interface NewClientResult { /* unchanged */ }
  function titleCase(slug: string): string
  function newClient(opts: NewClientOptions): Promise<NewClientResult>
  ```

---

- [ ] **Step 1: Split the synthetic corpus generator**

Each new module takes a contiguous block of `synthetic/generate.ts` verbatim, comments
included. Nothing is reworded.

| New file | From `generate.ts` |
|---|---|
| `types.ts` | lines 10-86 (`SyntheticKind` through `GenerateOptions`), plus `PageSpec` (206-209) and `DocumentPlan` (254-260) |
| `rng.ts` | lines 88-129 (`mulberry32`, `pick`, `digits`, `luhnNpi`, `deaNumber`, `ssn`) |
| `fixtures.ts` | lines 131-204 (the nine tables, `STATE_BOARD`, `isoDate`, `makeProvider`) |
| `pdf.ts` | lines 1-8 and 211-252 (`execFile`, `promisify`, `writeTextPdf`, `writeScanPdf`) |
| `plan.ts` | lines 262-422 (`planFor`, `injectionPlan`) |
| `cli.ts` | lines 535-553 (`here`, the argument reader, the `generate` call, the banner) |

`pick` and `digits` become exported, because `fixtures.ts` uses them.

`pdf.ts` gains a hard timeout note where `writeScanPdf` shells out. The existing call already
passes `{ timeout: 60_000 }`; add `killSignal: 'SIGKILL'`, which the core-tools wrapper
always sets and this one never did, so a wedged `pdftoppm` that ignores SIGTERM cannot hang a
corpus build:

```ts
  await run('pdftoppm', ['-r', '200', '-png', sourcePdf, prefix], { timeout: 60_000, killSignal: 'SIGKILL' });
```

`generate.ts` keeps `assertSafeToClear` (lines 424-449) and `generate` (451-533) and gains its
imports:

```ts
import { mkdir, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { makeProvider } from './fixtures.js';
import { writeScanPdf, writeTextPdf } from './pdf.js';
import { injectionPlan, planFor } from './plan.js';
import { mulberry32 } from './rng.js';
import type { DocumentPlan, GenerateOptions, GroundTruth, GroundTruthDocument, SyntheticProvider } from './types.js';

export type {
  GenerateOptions,
  GroundTruth,
  GroundTruthCredential,
  GroundTruthDocument,
  SyntheticKind,
  SyntheticProvider,
} from './types.js';
```

The type re-export keeps `@harness/pack-healthcare/generate` serving everything it serves
today; `evals` and the pack's own tests import `type GroundTruth` from it.

`cli.ts`:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};

const outDir = path.resolve(arg('out') ?? path.join(here, 'out'));
const truth = await generate({
  outDir,
  count: Number(arg('count') ?? 20),
  seed: Number(arg('seed') ?? 20260915),
  scans: arg('scans') !== 'false',
});
console.log(
  `generated ${truth.providers.length} providers and ${truth.documents.length} documents in ${outDir}\n` +
    `FABRICATED DATA. The NPIs are check-digit valid but are not registered; NPPES will not find them.`,
);
```

The `if (process.argv[1] && …)` guard goes; nothing imports `cli.ts`.

Point the package script at it:

```json
    "generate": "tsx synthetic/cli.ts",
```

Split the test: `synthetic/generate.test.ts` keeps `describe('generate')` and
`describe('clearing the output directory')`; move `describe('identifier generators')` (lines
33-46) into a new `synthetic/rng.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { deaNumber, luhnNpi, mulberry32 } from './rng.js';

// <describe('identifier generators'), moved verbatim>
```

and drop `deaNumber` and `luhnNpi` from `generate.test.ts`'s import line, which becomes:

```ts
import { assertSafeToClear, generate, type GroundTruth } from './generate.js';
```

- [ ] **Step 2: Prove the corpus is byte-identical**

This is the whole safety argument for splitting a deterministic generator: the same seed must
produce the same bytes. Generate into a scratch directory before and after, and compare.

Before starting Step 1, from the repository root:

```bash
pnpm --filter @harness/pack-healthcare exec tsx synthetic/generate.ts --out=/tmp/corpus-before --count=3 --scans=false
```

After Step 1:

```bash
pnpm --filter @harness/pack-healthcare exec tsx synthetic/cli.ts --out=/tmp/corpus-after --count=3 --scans=false
diff <(cd /tmp/corpus-before && find . -type f | sort | xargs shasum) \
     <(cd /tmp/corpus-after  && find . -type f | sort | xargs shasum) \
  && echo "corpus identical"
```
Expected: `corpus identical`. `ground-truth.json` carries a `generated_at` timestamp, so it
will differ; exclude it or compare the two files with that one key stripped:

```bash
diff <(jq 'del(.generated_at)' /tmp/corpus-before/ground-truth.json) \
     <(jq 'del(.generated_at)' /tmp/corpus-after/ground-truth.json) && echo "ground truth identical"
```
Expected: `ground truth identical`.

```bash
rm -rf /tmp/corpus-before /tmp/corpus-after
```

`--scans=false` because the scan twin needs `pdftoppm` and takes about six times as long; the
text layer is what the split touches.

- [ ] **Step 3: Rewrite the pack README**

Replace `packs/healthcare/README.md`:

````markdown
# @harness/pack-healthcare

Content, not code: everything the harness needs to do credentialing for a medical practice,
with no harness logic in it. This package sits **below** `@harness/core-tools` in the
dependency graph — core-tools reads `@harness/pack-healthcare/schema` — so nothing here may
import core-tools, which is why the corpus generator keeps its own bounded `execFile` call and
its own JSONL writer.

## Layout

```
schema/provider.json      the extraction manifest: fields, credentials, document kinds
forms/templates.json      which PDF field each record value fills
forms/*.pdf               two demo AcroForm templates (generated, committed)
forms/generate-templates.ts   rebuilds them deterministically
skills/                   four SKILL.md files the agent loads
evals/injection.jsonl     the prompt-injection assertions
policy.yaml               the pack's default action-class table
synthetic/types.ts        the ground-truth shapes
synthetic/rng.ts          mulberry32 and the check-digit-valid identifier generators
synthetic/fixtures.ts     the name, state, school, carrier and board tables; makeProvider
synthetic/pdf.ts          writeTextPdf and the rasterised scan twin
synthetic/plan.ts         the four document plans and the injection twin
synthetic/generate.ts     assertSafeToClear and generate
synthetic/cli.ts          the `pnpm synth` entrypoint
```

## Public API

`@harness/pack-healthcare/schema` is `schema/provider.json`. `@harness/pack-healthcare/generate`
is `synthetic/generate.ts`: `generate`, `assertSafeToClear` and the ground-truth types. Nothing
else is reachable.

## Regenerating

```bash
pnpm synth              # the full corpus, text layer and scan twins
pnpm synth:fast         # text layer only, about six times faster
pnpm forms:generate     # rebuild the two AcroForm templates
```

The corpus is **deterministic**: one seed produces byte-identical PDFs, which is what lets the
eval baseline mean anything. If a change to `synthetic/` makes the same seed produce different
bytes, that is a finding, not a detail. `generate` refuses to clear an output directory that
is neither empty nor a corpus it wrote — `ground-truth.json` is the marker.

**Everything here is fabricated.** The NPIs are check-digit valid and unregistered; the SSNs
are in issued ranges so the redaction pass sees them. None of it belongs to anyone.
````

- [ ] **Step 4: Split the client scaffolder**

```bash
cd scripts
mkdir -p src/domain src/app
git mv new-client.ts src/domain/scaffold.ts
git mv new-client.test.ts src/domain/scaffold.test.ts
cd ..
```

`src/domain/scaffold.ts` keeps `NAME_PATTERN`, `MIN_NAME_LENGTH`, `MAX_NAME_LENGTH`,
`DEFAULT_TEMPLATE`, `TEMPLATE_DISPLAY_NAME`, `TEMPLATE_FILES`, `SCRIPT_DIR`,
`NewClientOptions`, `NewClientResult`, `titleCase`, `repoRoot`, `exists`, `substitute`,
`copyTextFile` and `newClient`. `repoRoot` is the one line the move breaks — the file went
from `scripts/` to `scripts/src/domain/`, two levels deeper:

```ts
function repoRoot(): string {
  // scripts/src/domain -> the repository root
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
}
```

`scaffold.test.ts` passes an explicit `root` for every case it can, but at least one exercises
the default; `pnpm --filter @harness/scripts test` is the check.

`src/app/cli.ts` takes the entrypoint block (lines 150-177), with its `console.log` calls
unchanged — it is a CLI and prints to stdout on purpose — and one import:

```ts
import path from 'node:path';
import { newClient } from '../domain/scaffold.js';
```

Its `if (process.argv[1] && …)` guard, if present, goes.

`scripts/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Root `package.json`:

```json
    "new-client": "pnpm --filter @harness/scripts exec tsx src/app/cli.ts",
```

Check nothing else names the old path:

```bash
grep -rn "new-client.ts" --exclude-dir=node_modules --exclude-dir=.git .
```
Expected: only `docs/runbook.md` and `README.md`, if they mention it; update those lines if so.

- [ ] **Step 5: Write the scripts README**

Create `scripts/README.md`:

````markdown
# @harness/scripts

Repository tooling. One command today: the client scaffolder.

```
src/domain/scaffold.ts   newClient: copy a client template, substituting the slug and display name
src/app/cli.ts           the `pnpm new-client` entrypoint
```

## Usage

```bash
pnpm new-client --pack healthcare --name acme-clinic
```

It copies `clients/demo-practice/` (or `--template <slug>`) into `clients/acme-clinic/`,
rewrites every mention of the template's slug and display name, preserves the executable bit
on the playbook scripts, and prints what to do next. It never overwrites an existing client
directory.

This package has no `exports` map on purpose: nothing may import it.

## Testing

```bash
pnpm --filter @harness/scripts test
```

Filesystem only — no database, no network.
````

- [ ] **Step 6: Add both packages to the cruiser table**

`.dependency-cruiser.cjs`, two new rows. The pack has no `src/` and its layers are the folders
it already has, so it gets only the global rules; `scripts` gets the full set:

```js
const PACKAGES = [
  { name: 'db', src: 'harness/db/src', severity: 'error' },
  { name: 'gateway', src: 'harness/gateway/src', severity: 'error' },
  { name: 'core-tools', src: 'harness/core-tools/src', severity: 'error' },
  { name: 'approvals', src: 'harness/approvals/src', severity: 'error' },
  { name: 'evals', src: 'evals/src', severity: 'error' },
  { name: 'scripts', src: 'scripts/src', severity: 'error' },
];
```

`eslint.config.js`: append `'scripts/src'` to `STRICT_LAYER_ROOTS`. The pack is not added,
because `no-console` in `synthetic/cli.ts` and `forms/generate-templates.ts` is already
exempt and the pack has no layer folders to constrain.

- [ ] **Step 7: Run every gate**

```bash
pnpm -r typecheck
pnpm lint
pnpm arch
pnpm -r test
```
Expected: clean; `0 errors`; 7 packages pass with the same count as after Task 9.

```bash
pnpm forms:generate && git status --porcelain packs/healthcare/forms
```
Expected: no output — the templates are deterministic and this task did not touch their
builder, so a dirty tree here means something else changed.

- [ ] **Step 8: Commit**

```bash
git add -A packs/healthcare
git commit -m "refactor(pack-healthcare): split the synthetic corpus generator into rng, fixtures, pdf, plan and cli"

git add -A scripts package.json .dependency-cruiser.cjs eslint.config.js
git commit -m "refactor(scripts): split the scaffolder from its command line"
```

---
### Task 11: Every rule to error, unused subpaths removed, the graph, the final documents

Everything has moved. This task turns the analysers from reporters into gates, deletes the two
subpath exports nothing imports, generates the dependency graph, and finishes the two
documents Task 1 drafted.

**Files:**
- Modify: `.dependency-cruiser.cjs` (every remaining `severity: 'warn'` → `'error'`)
- Modify: `eslint.config.js` (`import-x/no-cycle`, `no-console` and `no-restricted-syntax` to error globally; `STRICT_LAYER_ROOTS` collapses)
- Modify: `harness/core-tools/package.json` (remove `./models` and `./reconcile`)
- Modify: `evals/package.json` (remove `./score`)
- Create: `docs/architecture/graph.svg`
- Modify: `ARCHITECTURE.md`, `README.md` (root)

**Interfaces:**
- Consumes: everything Tasks 1–10 produced.
- Produces: no new code. `pnpm arch` and `pnpm lint` both fail the build on a layer violation
  from here on.

---

- [ ] **Step 1: Confirm the subpaths are really unused before removing them**

```bash
grep -rn "@harness/core-tools/models\|@harness/core-tools/reconcile\|@harness/evals/score" \
  harness packs evals scripts clients docs --exclude-dir=node_modules
```
Expected: no output. If a hit appears, either the importer is wrong (point it at the package
root) or the subpath stays; do not delete an export something names.

`./testing` is also imported by no other package, and it stays. It is the declared home of
every package's fakes, it is named in ARCHITECTURE.md and in three package READMEs, and the
next package that needs `makeTestDeps` should find it there rather than deep-importing.

- [ ] **Step 2: Remove the two dead subpaths**

`harness/core-tools/package.json`:

```json
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts",
    "./effects": "./src/domain/effects/outbox.ts",
    "./fake-gateway": "./src/domain/models/fake.ts",
    "./in-process": "./src/domain/tooling/in-process.ts",
    "./storage": "./src/domain/storage/layout.ts"
  },
```

`evals/package.json`:

```json
  "exports": {
    ".": "./src/index.ts"
  },
```

Everything those three served is still reachable from the package root: `callModel`,
`callModelJson`, `gatewayFromEnv` and `httpGateway` from `@harness/core-tools`; `reconcile`,
`expireApprovals` and `parkStuckDispatches` likewise; every scorer from `@harness/evals`.

This also tightens the cruiser's `only-public-entry-of-*` rules for free, because they read
the `exports` map: a deep import into `domain/models/gateway.ts` from another package now
fails rather than resolving through a subpath nothing uses.

- [ ] **Step 3: Flip every dependency-cruiser rule to error**

In `.dependency-cruiser.cjs`, `PACKAGES` is already all `'error'` after Task 10. The three
global rules and the cross-package rule are still `'warn'`. Change them:

```js
  {
    name: 'no-circular',
    comment: 'A cycle means two modules are really one. Split the shared part into a types.ts.',
    severity: 'error',
    from: {},
    to: { circular: true },
  },
  {
    name: 'no-test-imported-by-production',
    comment: 'A *.test.ts file is never imported by shipping code. Fixtures belong under the package testing.ts subpath.',
    severity: 'error',
    from: { pathNot: '\\.test\\.ts$' },
    to: { path: '\\.test\\.ts$' },
  },
  {
    name: 'no-orphans',
    comment: 'A module nothing imports and that is not an entrypoint is dead. Entrypoints, configs and declaration files are exempt.',
    severity: 'error',
    // …from/to unchanged…
  },
```

and in `crossPackageRule`, `severity: 'warn'` becomes `severity: 'error'`.

Update the file's header comment: the "HOW A PACKAGE FLIPS TO ERROR" block described a
migration that is now finished. Replace it with:

```
 * EVERY RULE IS AN ERROR. `pnpm arch` exits 1 on any violation, and `pnpm test` runs it.
 * A new package adds a row to PACKAGES at severity 'error' from the start — the warn-then-
 * promote path existed only for the migration that introduced these layers.
```

- [ ] **Step 4: Flip the three ESLint rules to error**

`STRICT_LAYER_ROOTS` has done its job and now covers every package with layers, so collapse
the conditional block into unconditional rules. In `eslint.config.js`, delete the
`STRICT_LAYER_ROOTS` constant and its `...(STRICT_LAYER_ROOTS.length === 0 ? [] : [...])`
block, and change three severities in the main `**/*.ts` block:

```ts
      'import-x/no-cycle': ['error', { maxDepth: Infinity }],
      'no-console': 'error',
      'no-restricted-syntax': ['error', NO_PROCESS_ENV],
```

and in the tools block:

```ts
  {
    files: ['**/src/tools/**/*.ts'],
    ignores: ['**/*.test.ts'],
    rules: { 'no-restricted-syntax': ['error', NO_PROCESS_ENV, NO_BARE_THROW] },
  },
```

The two exemption blocks (`CONSOLE_IS_FINE`, `PROCESS_ENV_IS_FINE`) stay exactly where they
are, after the main block and before the tools block, so they still win.

The type-aware rules from `recommendedTypeChecked` stay at `warn`. Say so in the file:

```js
  // Type-aware rules stay warnings. The existing code trips require-await and the no-unsafe-*
  // family in places, and clearing that is a separate piece of work from moving files.
  // `pnpm lint` does not fail on them; `pnpm lint --max-warnings=0` is how you see the backlog.
```

Add one script so the backlog is measurable:

```json
    "lint:strict": "eslint . --max-warnings=0",
```

- [ ] **Step 5: Run the two analysers and fix what they now reject**

```bash
pnpm arch
```
Expected: `✔ no dependency violations found`. Anything else is a real layer violation; fix the
import, never the severity. The likely survivors and their fixes:

- **`no-orphans` on a domain module nothing imports yet.** Either it is dead and should be
  deleted, or its public function belongs in `index.ts`.
- **`no-circular` between two domains' `types.ts`.** Move the shared type into whichever domain
  owns the concept, or into `shared/`.
- **`only-public-entry-of-*` on a test.** A test importing another package's internals should
  import from that package's `./testing` subpath instead.

```bash
pnpm lint
```
Expected: warnings from the type-aware family only, and **no errors**. If `no-console` fires,
the site is not in `app/`, not `shared/log.ts` and not a pack CLI — it should use a logger. If
`no-restricted-syntax` fires on `process.env`, the read belongs in `app/` or behind an
`env.ts` helper.

- [ ] **Step 6: Generate the graph**

Graphviz is not installed on a fresh machine. Install it:

```bash
brew install graphviz          # Debian/Ubuntu: apt-get install -y graphviz
dot -V
```
Expected: something like `dot - graphviz version 14.0.2`.

```bash
mkdir -p docs/architecture
pnpm arch:graph
```

```bash
ls -l docs/architecture/graph.svg
```
Expected: a file of a few tens of kilobytes. Open it and check three things before committing:
every package appears; the arrows between packages all point the same way
(`db → core-tools → approvals/evals`, `gateway → core-tools`, `pack-healthcare → core-tools`);
and no arrow enters an `app/` cluster from outside its own package. If the graph is an
unreadable hairball, tighten `options.reporterOptions.dot.collapsePattern` in
`.dependency-cruiser.cjs` rather than pruning modules out of the cruise — the graph and the
gate must describe the same thing.

- [ ] **Step 7: Finish ARCHITECTURE.md**

Four edits to the draft from Task 1.

Add the graph under "The packages", above the ASCII list:

```markdown
![Module graph](docs/architecture/graph.svg)

Regenerate with `pnpm arch:graph` (needs Graphviz). The clusters are the four layers; every
arrow is an import that `pnpm arch` allows.
```

Replace the "Tooling" section's last two paragraphs, which describe the migration, with what
is now true:

```markdown
Every architecture rule is an error. `pnpm arch` exits 1 on a layer violation and `pnpm test`
runs it first, so a crossed layer cannot reach a review. ESLint's three project rules
(`no-console`, `process.env` outside `shared/env.ts` and `app/`, `throw new Error` inside
`tools/`) are errors too.

typescript-eslint's type-aware rules are the one thing still reported as warnings: the code
trips `require-await` and the `no-unsafe-*` family in places, and clearing that is separate
work. `pnpm lint:strict` shows the backlog.
```

Add a short section at the end, so the next reader knows which duplications are deliberate:

```markdown
## Three deliberate duplications

Each of these is a copy that a reviewer will want to delete. Do not, without reading the
reason.

1. **`harness/db/src/shared/log.ts`** duplicates core-tools' logger. `@harness/db` is the
   bottom of the graph; importing core-tools from it is a cycle.
2. **`packs/healthcare/synthetic/pdf.ts`** has its own bounded `execFile` and
   `synthetic/generate.ts` its own JSONL writer, instead of `runBounded` and `writeJsonl`.
   The pack is a *dependency* of core-tools — core-tools reads
   `@harness/pack-healthcare/schema` — so the same cycle argument applies.
3. **`shared/redaction/patterns.ts` carries two pattern sets.** The strict-shape set guards
   text on its way to a human; the OCR-tolerant, validity-gated set decides what gets
   encrypted onto a record. Merging them changes behaviour in both directions.

Items 1 and 2 are what spec section 8 meant by "revisit if a package that does not depend on
core-tools ever needs the helpers". Two now do. A `@harness/shared` package holding `log.ts`,
`subprocess.ts` and `jsonl.ts`, depended on by db, the pack and core-tools alike, is the
obvious next move and is deliberately out of scope here.
```

Finally, replace the draft's `src/app/surface.test.ts` path reference if Task 7 moved it
elsewhere, and re-read the whole document against the tree as it now stands: every path it
names must exist.

```bash
grep -oE '`[a-z0-9./_-]+\.(ts|json|yaml|md|svg)`' ARCHITECTURE.md | tr -d '`' | sort -u \
  | while read -r p; do [ -e "$p" ] || echo "MISSING: $p"; done
```
Expected: no output. Paths written as `src/...` without a package prefix are illustrative and
will show up here; check each by eye rather than inventing a prefix for it.

- [ ] **Step 8: Update the root README**

Two edits to `README.md`.

Replace the "Layout" block so it names the layers and the new documents:

````markdown
## Layout

```
harness/db/          schema, migrations, the pool, encryption
harness/gateway/     the routing table and the LiteLLM config renderer
harness/core-tools/  the MCP server: shared/, domain/, tools/, app/
harness/approvals/   the Slack approval app and the effects dispatcher
harness/compose/     the Docker stack
packs/healthcare/    schema, forms, skills, eval sets, the synthetic corpus
clients/             one folder per deployment: SOUL, routing, policy, env
evals/               the runner, scorers, judge and report
scripts/             the client scaffolder
docs/                specs, runbook, demo, promotion gate, architecture
```

Every package has the same four layers — `shared` → `domain` → `tools` → `app` — with one
public entry point. **[ARCHITECTURE.md](ARCHITECTURE.md)** explains them, the path of one tool
call and the three invariants; **[CONTRIBUTING.md](CONTRIBUTING.md)** is how to add a tool, a
domain, a pack, a client, a migration or a test.
````

and add a documents section just before "Run locally":

````markdown
## Documents

| | |
|---|---|
| [ARCHITECTURE.md](ARCHITECTURE.md) | the layers, the package map, the path of a tool call, the three invariants |
| [CONTRIBUTING.md](CONTRIBUTING.md) | how to add a tool, a domain, a pack, a client, a migration, a test |
| [docs/runbook.md](docs/runbook.md) | operating it: audit, effects, reconciliation, storage, the Slack app, onboarding |
| [docs/demo.md](docs/demo.md) | the five-minute demo script |
| [docs/promotion-gate.md](docs/promotion-gate.md) | what an eval run has to clear |
| package READMEs | [db](harness/db/README.md), [gateway](harness/gateway/README.md), [core-tools](harness/core-tools/README.md), [approvals](harness/approvals/README.md), [evals](evals/README.md), [pack-healthcare](packs/healthcare/README.md), [scripts](scripts/README.md) |
````

Also extend the "Run locally" block with the four new commands:

````markdown
```bash
pnpm lint            # eslint: layers, imports, the three project rules
pnpm format          # prettier
pnpm arch            # dependency-cruiser: the layer graph
pnpm test            # lint, then every package's suite
```
````

- [ ] **Step 9: Run every gate, one last time, from a clean tree**

```bash
pnpm -r typecheck
pnpm lint
pnpm arch
pnpm format:check
pnpm -r test
```
Expected: clean typecheck; no lint errors; `✔ no dependency violations found`; Prettier
reports nothing; 7 packages pass.

Then the three proofs that nothing changed:

```bash
pnpm --filter @harness/core-tools exec vitest run src/app/surface.test.ts
```
Expected: `Tests 3 passed` — the 22 tool names and both schemas, the environment variable set
and the Compose config all match what Task 1 recorded, eleven tasks ago.

```bash
cd harness/db && pnpm drizzle-kit generate; cd ../..
git status --porcelain harness/db/drizzle
```
Expected: `No schema changes, nothing to migrate 😴` and no output.

```bash
pnpm gateway:config && pnpm forms:generate && git status --porcelain
```
Expected: no output. Both generators are deterministic and neither their inputs nor their code
changed meaningfully.

- [ ] **Step 10: Commit**

```bash
git add .dependency-cruiser.cjs eslint.config.js package.json harness/core-tools/package.json evals/package.json
git commit -m "chore(tooling): make every layer rule an error and drop the unused subpath exports"

git add docs/architecture/graph.svg
git commit -m "docs: generate the module graph"

git add ARCHITECTURE.md README.md
git commit -m "docs: finish ARCHITECTURE.md and point the root README at it"
```

---

## When every task is done

The branch is ready for the final whole-branch review when all of these hold:

- `pnpm -r typecheck`, `pnpm lint`, `pnpm arch`, `pnpm format:check` and `pnpm -r test` are all clean.
- `docs/architecture/tool-surface.json` is unchanged since Task 1 — `git log --oneline -- docs/architecture/tool-surface.json` shows exactly one commit.
- `docs/architecture/compose-surface.yaml` likewise.
- `git log --oneline --format='%b' | grep -i 'co-authored\|generated with'` finds nothing.
- `harness/db/drizzle/` is untouched: `git diff --stat main -- harness/db/drizzle` is empty.
- Every package has a README, and `ARCHITECTURE.md` and `CONTRIBUTING.md` name only paths that exist.
