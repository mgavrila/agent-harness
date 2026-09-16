# Architecture

This document is for someone who did not write this code and has to change it safely.
Read it before adding a tool, a domain or a package. `CONTRIBUTING.md` is the how-to;
this is the why.

> **Where the tree is today.** The maintainability revamp (`docs/superpowers/specs/2026-09-16-maintainability-revamp-design.md`)
> is landing one package at a time. This document describes the **target**, because the
> target is what every remaining task is judged against. Anything marked
> _(target state, landing in Tasks 4–8)_ is not in the tree yet: the layer folders, the two
> new packages and the pack contract arrive with those tasks. The tooling, the layer rules
> and the surface snapshot described at the end are in place now, in warn mode, so that the
> moves can be checked as they happen.

## The four layers

Every package has the same shape. Imports travel in one direction only, and
`.dependency-cruiser.cjs` fails the build when they do not.

| Layer      | Folder                | Holds                                                                                                                                            | May import                                                  |
| ---------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| shared     | `src/shared/`         | pure helpers with no domain knowledge; in core-tools the `redaction/` modules                                                                    | node built-ins, third-party packages, `@harness/shared`     |
| domain     | `src/domain/<name>/`  | one folder per domain: `types.ts` first, then `repository.ts` (SQL), pure logic modules, `prompts.ts` where a model is involved, and the tests   | `shared/`, other domains' `types.ts` and exported functions |
| tools      | `src/tools/<name>.ts` | `defineTool` calls only: validate input, call the domain, shape output. No SQL, no regex, no prompt strings                                      | `domain/`, `shared/`                                        |
| app        | `src/app/`            | `server.ts` (the composition root: dependencies from the environment, pack loading, tool registration), `main.ts` (the process entrypoint), CLIs | everything                                                  |
| public API | `src/index.ts`        | the only module other packages may import, alongside the subpaths `package.json#exports` declares                                                | `domain/`, `tools/`, `shared/` — never `app/`               |

Two conventions keep the tree readable:

- A domain that needs one module is one file, `src/domain/<name>.ts`. It gets a folder as
  soon as it needs a second module or a `types.ts` shared between them.
- Files are named for what they do — `types.ts`, `repository.ts`, `render.ts`, `prompts.ts`,
  `layout.ts` — never for the package or the folder they sit in. Two files in one package
  never share a basename unless they do the same job for different domains.

## The packages

```
harness/shared      generic helpers: env, errors, paths, log, subprocess, jsonl, csv.
                    No domain knowledge, no workspace dependency. Bottom of the graph.
                    (target state, landing in Task 4)
harness/pack-api    the Pack contract and definePack(). Depends on @harness/shared and zod
                    only, so a pack never has to depend on core-tools.
                    (target state, landing in Tasks 4-8)
harness/db          schema, migrations, the pool, the encryption primitives.
harness/gateway     the routing schema and the LiteLLM config renderer.
harness/core-tools  the MCP server: the tooling kernel, every domain, every tool.
harness/approvals   the Slack app: cards, decisions, the effects dispatcher, the health endpoint.
evals               the eval runner, scorers, judge and report.
packs/healthcare    a pack: the provider schema, form templates, skills, the synthetic corpus.
scripts             the client scaffolder.
```

The target dependency graph, with every arrow pointing at something lower:

```
shared  <-  pack-api  <-  { core-tools, packs/* }
shared  <-  db        <-  core-tools  <-  { approvals, evals }
shared  <-  gateway   <-  { core-tools, evals }
core-tools  ..>  packs/*        (runtime only: dynamic import, never a static one)
```

`scripts` is a leaf. There are no cycles. The dotted arrow is the important one: core-tools
declares each pack in `dependencies` so that pnpm can resolve it, but reaches it only through
a dynamic `import()` at startup. `.dependency-cruiser.cjs` carries the rule that forbids a
static import of any `@harness/pack-*` from core-tools source, so the kernel keeps compiling
and running with no pack installed.

## Packs are plug-ins, not dependencies _(target state, landing in Tasks 4–8)_

The harness is a foundation that project-specific areas plug into: healthcare credentialing
today, document scanning that produces stories and epics tomorrow. So core loads a pack
through a contract and never imports one by name.

A pack supplies the content that makes the kernel specific to a domain: the document kinds
`documents_classify` may return, the extraction manifest, the forms directory holding
`templates.json` and its PDFs, the skills directory, the action-class policy defaults it
ships, optionally its eval case files, and optionally its own tools.

`app/server.ts` reads `HARNESS_PACKS`, a comma-separated list of package names defaulting to
`@harness/pack-healthcare`, and loads each with a dynamic `import()`. Each module must export
`pack`. The loaded packs become a registry on `ToolDeps`, and `documents_classify`,
`documents_extract`, the `forms_*` tools, the skills frontmatter test and the eval runner all
read from that registry rather than from a hard-coded import.

`@harness/pack-api` owns the contract. The `ProviderManifest`, `Policy` and `AnyToolDef`
types live there, as types only, so the contract has no core-tools dependency; core-tools
re-exports them so existing importers keep working.

## The path of one tool call

An agent calls `documents_extract`. What happens, in order:

1. **Registration.** `app/server.ts` built `ToolDeps` from the environment at startup, loaded
   the packs named by `HARNESS_PACKS`, and handed every definition to `registerTools`, which
   wrapped each one in an MCP callback.
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

Declared once, in `@harness/shared`, at `harness/shared/src/errors.ts`. `@harness/core-tools`
re-exports all three from `src/index.ts`, so a module that still reaches `ToolError` through
`@harness/core-tools` rather than `@harness/shared` gets the same class; Tasks 8 to 11 point
the remaining importers at the shared package directly.

| Type                               | Means                                                                                                 | Who sees the message     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| `ToolError`                        | an expected failure the caller can act on: bad input, a missing record, a disabled feature            | the agent                |
| `ModelOutputError` (a `ToolError`) | the model's reply did not parse or did not match the schema; the message carries zod issue paths only | the agent                |
| `ConfigError`                      | the process is misconfigured and cannot start                                                         | the operator, at startup |

Everything else is a plain `Error`.

`@harness/db` used to be the exception here: it sits below core-tools, so importing the error
types from core-tools would have been a cycle, and it threw plain `Error` and kept its own
ten-line logger. `@harness/shared` removes the exception rather than documenting it. Section 9
of the spec supersedes section 8 on this point: `@harness/shared` sits below every package,
db included, so db imports the same errors and the same logger as everything else, and the
three "deliberate duplications" section 3 recorded — the pack's own `execFile` and JSONL
helpers, and db's logger — all disappear.

## Where each cross-cutting concern lives

All in `@harness/shared`, under `harness/shared/src/`. Every package declares the dependency
directly, so nothing has to re-export them to reach another package.

| Concern              | Module          | Exports                                                         |
| -------------------- | --------------- | --------------------------------------------------------------- |
| environment parsing  | `env.ts`        | `numberFromEnv`, `booleanFromEnv`, `requiredEnv`, `optionalEnv` |
| errors               | `errors.ts`     | `ToolError`, `ModelOutputError`, `ConfigError`, `describeError` |
| path containment     | `paths.ts`      | `realOrNearestAncestor`, `assertInsideRoot`                     |
| logging              | `log.ts`        | `createLogger`                                                  |
| bounded subprocesses | `subprocess.ts` | `runBounded`                                                    |
| JSONL                | `jsonl.ts`      | `readJsonl`, `writeJsonl`                                       |
| CSV quoting          | `csv.ts`        | `csvCell`                                                       |

Redaction stays in core-tools, under `src/shared/redaction/`, because it is domain knowledge
about restricted identifiers rather than a generic helper:

| Concern                | Module                         | Exports                                         |
| ---------------------- | ------------------------------ | ----------------------------------------------- |
| restricted patterns    | `shared/redaction/patterns.ts` | `containsRestrictedPattern`, `isValidDea`       |
| restricted field names | `shared/redaction/names.ts`    | `isRestrictedName`, `MASKED`                    |
| redaction              | `shared/redaction/text.ts`     | `redactPages`, `assertRedacted`, `fieldNameFor` |

`shared/redaction/patterns.ts` deliberately carries **two** pattern sets. The strict-shape
set behind `containsRestrictedPattern` is the last-line guard on anything about to reach a
human channel; it matches on shape alone and over-reports on purpose. The OCR-tolerant,
validity-gated set behind `redactPages` is what decides whether a value gets encrypted onto
a provider record, where a false positive would fabricate an SSN. Collapsing them into one
list would change behaviour in both directions.

## Deciding where new code goes

Ask, in order:

1. Does it know anything about providers, documents, approvals or models? If not, it is a
   generic helper and it belongs in `@harness/shared`, where every package can reach it.
2. Is it content that makes the harness specific to one area — document kinds, an extraction
   manifest, forms, skills, policy defaults? Then it belongs in a pack, behind the
   `@harness/pack-api` contract, and core reaches it through the registry.
3. Is it an agent-callable action? Then its _definition_ is a file in `tools/` and its
   _logic_ is a function in `domain/`. A `defineTool` block longer than about forty lines
   is logic that has not moved yet.
4. Does it read the environment, open a connection, load a pack, or start a process? Then it
   is `app/`. Nothing else may read `process.env`.
5. Does something outside this package need it? Then it is exported from `index.ts`, and the
   fake beside it is exported from `./testing`. Nothing else is reachable.

## Tooling

| Command               | What it checks                                                                                                                                                                                           |
| --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm lint`           | ESLint 9 flat config: type-aware typescript-eslint, import ordering and cycles, unused imports, and the three project rules (`no-console`, `process.env`, `throw new Error` in `tools/`)                 |
| `pnpm format:check`   | Prettier                                                                                                                                                                                                 |
| `pnpm arch`           | dependency-cruiser: the layer rules, "no cycles", "no test imported by production code", "no orphans", "other packages import only a declared entry point", "core-tools never statically imports a pack" |
| `pnpm arch:graph`     | writes `docs/architecture/graph.svg` (needs Graphviz)                                                                                                                                                    |
| `pnpm surface:record` | regenerates `docs/architecture/tool-surface.json` and `compose-surface.yaml`                                                                                                                             |
| `pnpm test`           | lint, then every package's vitest suite                                                                                                                                                                  |

ESLint's type-aware rules run against TypeScript **6**, installed at the workspace root only,
because typescript-eslint refuses to load against TypeScript 7. Every package still compiles
with TypeScript 7 through its own `tsc --noEmit`. That duplication is deliberate; delete it
when typescript-eslint supports 7.

The type-aware rules land as warnings, not errors: the existing code trips `require-await`
and the `no-unsafe-*` family in places, and clearing that is separate work from moving files.
`import-x/no-cycle`, `no-console` and the `process.env` rule are promoted from warning to
error per package, by appending the package's source root to `STRICT_LAYER_ROOTS` in
`eslint.config.js`; dependency-cruiser is promoted the same way, by changing one `severity`
on that package's row in `.dependency-cruiser.cjs`. Adding a package to the architecture
rules is one row in `PACKAGES` and one entry in `WORKSPACE_DIRS`, which is how
`@harness/shared` was added and how `@harness/pack-api` will be.

## Proof that a refactor changed nothing

`harness/core-tools/src/app/surface.test.ts` compares three things against committed snapshots on
every run:

- the MCP tool list, with each tool's input and output JSON Schema, against
  `docs/architecture/tool-surface.json` — 23 tools today;
- every environment variable name the code reads, against `.env.example`;
- the rendered Compose config, against `docs/architecture/compose-surface.yaml`.

A renamed tool, a widened schema, an undocumented variable or a changed service definition
fails the suite. Regenerate the snapshots with `pnpm surface:record` only when the change is
intended, and say so in the commit message. `HARNESS_PACKS` is a new name, so the task that
introduces it adds it to `.env.example` in the same commit or this test fails.

The recorder behind it is `harness/core-tools/src/app/record-surface.ts`, which is both the
library the test imports and the CLI `pnpm surface:record` runs.
