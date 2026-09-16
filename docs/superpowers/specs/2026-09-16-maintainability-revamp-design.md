# Maintainability revamp — design

**Date:** 2026-09-16
**Status:** approved in discussion; awaiting written review
**Scope:** restructure inside the existing workspace packages; no behaviour change; no schema change
**Baseline:** main at 83c4aab (Plans 1, 1.1, 2 and 3 merged; 522 tests across 7 packages)

## 1. Goal

Make the codebase maintainable by people who did not write it. Today the
package graph is clean (db → core-tools → approvals/evals, gateway → core-tools,
no cycles) but inside the packages a reader meets four-concern files
(`tools/providers.ts`, `documents/extract.ts`, `synthetic/generate.ts`), two
`storage.ts` and two `audit.ts`, three copies of `useTestDb`, a byte-identical
restricted-value regex list in two packages, env parsing reinvented per package,
22 hand-formatted `console.error` calls in one package, and no stated rule for
where new code goes.

After the revamp every package has the same four layers, one public entry
point, explicit interfaces for every cross-boundary dependency, one home for
each cross-cutting concern, tooling that fails the build when a layer is
crossed the wrong way, and documentation written for a human reader.

Non-goals: new features, package boundary changes, schema or migration changes,
tool renames, env variable renames, changes to the Hermes/LiteLLM/compose
runtime shape.

## 2. Layers (every package)

Imports are allowed only downward. dependency-cruiser enforces this.

| Layer | Folder | Contains | May import |
|---|---|---|---|
| shared | `src/shared/` | pure helpers with no domain knowledge: env, errors, paths, log, subprocess, jsonl, csv; in core-tools also `redaction/` | node, third-party libraries |
| domain | `src/domain/<name>/` | one folder per domain: `types.ts` (interfaces first), `repository.ts` (SQL), pure logic modules, `prompts.ts` where a model is involved, tests | shared, other domains' `types.ts` and public functions |
| tools | `src/tools/<name>.ts` | `defineTool` calls only: validate input, call the domain, shape output; no SQL, no regex, no prompt strings | domain, shared |
| app | `src/app/` | `server.ts` (composition root: deps from env, tool registration), `main.ts` (process entrypoint), CLI files | everything |
| public API | `src/index.ts` | the only module other packages may import (plus declared subpaths such as `./testing`) | domain, shared, tools; never `app/` |

Rules:
- A concern gets a folder when it has more than one file or a type of its own.
- Files are named by responsibility (`repository.ts`, `prompts.ts`, `types.ts`,
  `render.ts`), never by the package or domain name, so no two files in a
  package share a basename with different responsibilities.
- Test files live beside the code they test (`*.test.ts`) and are never
  imported by production code.
- Fakes live beside the interface they implement and are exported under the
  package's `./testing` subpath.

Domain folders per package:

- core-tools: `tooling` (kernel: registry, execution, context, policy, audit
  writer), `storage`, `documents`, `models`, `providers`, `deadlines`, `forms`, `approvals`, `effects`, `verify`.
- approvals: `poller`, `decisions`, `render`, `sinks`, `execute`, `health`,
  `runner`; Slack handlers under `slack/`; `app/`.
- evals: `cases`, `pipeline`, `score`, `judge`, `report`; `app/cli.ts`.
- pack healthcare: `synthetic/` split into `rng.ts`, `fixtures.ts`, `pdf.ts`,
  `plan.ts`, `cli.ts`; `forms/` unchanged in shape; `schema/` unchanged.
- db, gateway, scripts: already small; they get the layout, a README and the
  shared `useTestDb`.

## 3. Shared modules (one home per concern)

All in `harness/core-tools/src/shared/` and exported from the core-tools
public API so approvals, evals and the pack import them instead of keeping
copies.

| Module | Exports | Replaces |
|---|---|---|
| `env.ts` | `numberFromEnv`, `booleanFromEnv`, `requiredEnv`, `optionalEnv`, one `{ min, max, integer }` option shape, one error wording | `server.ts:numberFromEnv/booleanFromEnv`, `approvals/main.ts:numberFromEnv`, `child-env.ts:requiredFrom` |
| `errors.ts` | `ToolError` (agent-visible), `ModelOutputError`, `ConfigError` (startup misconfiguration), `describeError(err)` | the two classes in registry.ts/models.ts; ad-hoc `err instanceof Error ? err.message : String(err)` |
| `paths.ts` | `realOrNearestAncestor`, `assertInsideRoot(candidate, root, onEscape)` | the three containment implementations (documents/storage.ts, storage.ts, approvals/sinks.ts); the sink keeps its own call as defence in depth |
| `log.ts` | `createLogger(scope)` → `info/warn/error(message, err?)`; formats once, never prints payloads | 33 raw `console.*` call sites outside CLIs |
| `subprocess.ts` | `runBounded(cmd, args, { timeoutMs, cwd })` | the `execFile` wrappers in documents/text.ts, synthetic/generate.ts, forms/generate-templates.ts |
| `jsonl.ts` | `readJsonl`, `writeJsonl` with line numbers in errors | inline readers in evals/cases.ts, evals/run.ts, synthetic/generate.ts |
| `csv.ts` | `csvCell` (RFC 4180 quoting + formula guard) | forms/roster.ts private helper |
| `redaction/patterns.ts` | SSN/EIN/DEA patterns with their validity gates, `containsRestrictedPattern` | `tools/harness.ts:RESTRICTED_TEXT_PATTERNS`, `approvals/render.ts:RESTRICTED_PATTERNS` |
| `redaction/names.ts` | `isRestrictedName` with the ordinal-suffix rule, `MASKED` | `tools/providers.ts` |
| `redaction/text.ts` | `redactPages`, `assertRedacted`, `fieldNameFor` | `documents/redact.ts` |

The defence layers stay (redact before the model, mask on read, check again
before Slack, check again in the file sink); only the pattern list becomes one
module with one test file.

Test fixtures: `@harness/db/testing` owns the single `useTestDb`; core-tools
and approvals import it. `FakeGateway`, `FakeSlack`, `FakeCoreToolsClient`,
`connectInProcess` keep their roles, move beside their interfaces, and are
documented in each package README.

## 4. Interfaces

Every dependency a domain reaches across a boundary is an interface in a
`types.ts`, with the production adapter and the fake beside it.

- `ToolDeps` moves from `registry.ts` to `domain/tooling/types.ts`, documented
  field by field. `registry.ts` is split into `registry.ts` (`defineTool`,
  `registerTools`), `execution.ts` (auto / approval / blocked paths, the
  transaction, error masking) and `context.ts` (session context, lineage).
- `ModelGateway` (`call`, `callJson`) with the LiteLLM HTTP adapter and
  `FakeGateway`; `ToolDeps.gateway` carries the interface.
- `Storage` (`resolveIncoming`, `resolveOut`, `read`, `write`, `textPathFor`)
  implemented once over the real-path checks; `storage.ts` and
  `documents/storage.ts` collapse into `domain/storage/`.
- `SlackApi` and `Sink`/`SinkRegistry` keep their shapes and move to their
  domains' `types.ts`; `FakeSlack` sits beside `SlackApi`.
- `VerifyRegistry` (`lookupNpi`) so the NPPES test fake is a plain object.
- Errors: exactly three deliberate types (`ToolError`, `ModelOutputError`,
  `ConfigError`); everything else is a plain `Error` masked by the kernel.

core-tools public API (`index.ts`): the tooling kernel, the types above, the
shared helpers; fakes under `./testing`; nothing from `app/`.

## 5. Tooling and documentation

- ESLint 9 flat config at the root: typescript-eslint (type-aware),
  `eslint-plugin-import-x` (ordering, no cycles, no default exports),
  `eslint-plugin-unused-imports`, and project rules: no `console.*` outside
  `shared/log.ts` and CLI entrypoints; no `process.env` outside `shared/env.ts`
  and `app/`; no `throw new Error` inside `tools/`.
- Prettier with a checked-in config; `pnpm lint`, `pnpm format`,
  `pnpm format:check`; `pnpm test` runs lint first. Formatting is applied in one
  dedicated commit.
- dependency-cruiser: the layer rule, "other packages import only `index.ts`
  or declared subpaths", "no test file imported by production code", "no
  orphans". Lands in warn mode with a baseline; each package task flips its
  rules to error. `pnpm arch` runs it; `pnpm arch:graph` writes
  `docs/architecture/graph.svg`.
- `ARCHITECTURE.md`: layers, package map with diagram, the path of one tool
  call (policy → transaction → handler → audit → effects), the three invariants
  (client scoping, redaction before models, only `ToolError` reaches an agent),
  the three error types, where each cross-cutting concern lives, how to decide
  where new code goes.
- `CONTRIBUTING.md`: adding a tool, a domain, a pack, a client, a migration
  (plain `drizzle-kit generate`, never `--custom`), a test; commit conventions;
  local stack commands with `--env-file`.
- One `README.md` per package (purpose, public API, how to test); root README
  links them and the existing runbook, demo and promotion-gate docs.
- `.editorconfig` and a VS Code recommended-extensions file.

## 6. Proof of no behaviour change

- The full suite passes after every task; test files move with their code and
  assertions are untouched. A task may add tests for new shared helpers and
  delete literal duplicates only.
- A public-surface snapshot is recorded before the first move and checked by a
  test: the MCP tool list with input and output JSON schemas, the set of env
  variable names read anywhere, and the rendered compose config (`config`
  output with secrets blanked). A rename or a lost export fails the suite.
- No migration is added and the drizzle no-op check stays green.

## 7. Migration order

One task each, in dependency order, so cruiser rules can turn to error as each
lands:

1. Tooling: ESLint, Prettier (one formatting commit), dependency-cruiser in
   warn mode, the surface snapshot test, ARCHITECTURE.md draft, CONTRIBUTING.md.
2. `@harness/db`: layout, the single `useTestDb`, README.
3. `@harness/gateway`: layout, README.
4. core-tools `shared/` with every caller switched.
5. core-tools `domain/tooling` (registry split, `ToolDeps` types, policy, audit
   writer).
6. core-tools `domain/storage`, `domain/documents` (extract split into
   manifest, schema, prompts, parse), `domain/models`.
7. core-tools `domain/providers`, `deadlines`, `forms`, `approvals`,
   `effects`, `verify`; tools reduced to definitions; `index.ts`; `app/`.
8. `@harness/approvals`: shared helpers, single redaction source, logger,
   domain folders, README.
9. `@harness/evals`: domain folders, `app/cli.ts`, README.
10. `packs/healthcare` synthetic split and `scripts` tidy; READMEs.
11. Cruiser rules to error everywhere; final ARCHITECTURE.md with the graph;
    root README.

Process: subagent-driven development as before (implementer, task review, fix
rounds, final whole-branch review, simplifier pass), on a worktree branch,
merged to main when the final review is clean.

## 8. Open items deliberately left out

- Dormant injection checks and credential-number extraction wait for the
  Plan 4 agent loop.
- A `@harness/shared` package was declined in favour of `core-tools/src/shared/`
  exported through the public API; revisit if a package that does not depend on
  core-tools ever needs the helpers.
