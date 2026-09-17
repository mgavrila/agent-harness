# Architecture

This document is for someone who did not write this code and has to change it safely.
Read it before adding a tool, a domain or a package. `CONTRIBUTING.md` is the how-to;
this is the why.

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

![Module graph](docs/architecture/graph.svg)

Regenerate with `pnpm arch:graph` (needs Graphviz). Every arrow is an import that `pnpm arch`
allows, and the graph is cruised from the same globs as the gate, so the two cannot disagree.
Each package's layer folders are collapsed to one node apiece; `index.ts` is left on its own,
because it is the node every cross-package arrow should land on.

```
harness/shared      generic helpers: env, errors, paths, log, subprocess, jsonl, csv.
                    No domain knowledge, no workspace dependency. Bottom of the graph.
harness/pack-api    the Pack contract and definePack(). Depends on @harness/shared and zod
                    only, so a pack never has to depend on core-tools.
harness/db          schema, migrations, the pool, the encryption primitives.
harness/gateway     the routing schema and the LiteLLM config renderer.
harness/core-tools  the MCP server: the pack-agnostic kernel, every domain, every kernel tool.
harness/approvals   the Slack app: cards, decisions, the effects dispatcher, the health endpoint.
evals               the eval runner, scorers, judge and report.
packs/healthcare    a pack: the provider record kind, credential attachment kinds, form
                    templates, skills, the synthetic corpus, and eighteen tools
packs/stories       the proof pack: one record kind, one document kind, one skill, no tools
scripts             the client scaffolder.
```

The dependency graph in one line per layer, with every arrow pointing at something lower:

```
shared  <-  pack-api  <-  { core-tools, packs/* }
shared  <-  db        <-  core-tools  <-  { approvals, evals }
gateway   <-  core-tools      (gateway is the one package with no edge to shared: it needs none)
core-tools  ..>  packs/*        (runtime only: dynamic import, never a static one)
evals       ..>  packs/*        (runtime only: HARNESS_PACKS, --pack; no static import)
```

`scripts` is a leaf. There are no cycles.

## The kernel and a pack

`@harness/core-tools` is a kernel. It knows about documents, records, attachments, deadlines,
approvals, audit and effects, and it knows nothing about medicine. A **pack** is an area of the
product — healthcare credentialing today, document scanning that produces epics tomorrow — and
it is the only place a domain word appears.

`harness/core-tools/src/kernel-vocabulary.test.ts` is what makes that a fact rather than an
intention: it greps the kernel's own source, and `evals/src`, for `provider`, `credential`,
`licence`, `npi`, `nppes`, `malpractice`, `dea_number`, `payer` and `roster`. Tests are
excluded, because a test names what it tests, and so is `shared/redaction/`, whose
`RESTRICTED_NAME_KEYS` is a list of identifier stems the kernel keeps on purpose. **Its
allowlist is empty.** A word that has to appear belongs in a pack.

At startup `app/server.ts` reads `HARNESS_PACKS` — comma-separated package names, default
`@harness/pack-healthcare` — and `loadPacks` (`domain/packs/registry.ts`) imports each one
dynamically into a `PackRegistry` on `ToolDeps`. No shipping module under
`harness/core-tools/src/` names a pack: `pnpm arch` fails the build on a static
`@harness/pack-*` import, with `src/testing.ts` and `*.test.ts` exempt because they need a
registry synchronously. `evals/src` is held to the same rule, exempting `*.test.ts` and
`*.test-helpers.ts`, and the runner reaches a pack only through `HARNESS_PACKS` and `--pack`.

Those exemptions are the only reason the module graph shows an arrow from core-tools, or from
evals, to a pack at all — the graph collapses each package's layers to one node, tests included.
Remove the tests and both arrows go with them.

### The record model

One set of tables carries every pack's data, and `harness/db/src/domain/schema.ts` is where
they are declared.

| Table         | What it holds                                                                                        |
| ------------- | ---------------------------------------------------------------------------------------------------- |
| `records`     | `pack`, `kind`, `name`, `external_id`, `status`, client-scoped. A provider, an epic.                 |
| `fields`      | one name/value per record, plaintext `value` or `value_encrypted`, with a confidence and a status    |
| `attachments` | `kind`, `issuer`, `state`, dates, `number_encrypted`, `properties jsonb`. A licence, a link.         |
| `deadlines`   | keyed on an attachment: one `expiration` row and, when the kind has a lead time, one `renewal_start` |
| `documents`   | unchanged, attached to a record rather than to a provider                                            |

`deadlines` keeps the columns it has always had, `window_days` and `notified_at`. The lead time
is not a column at all: it is `AttachmentKindSpec.leadDays`, which a pack declares and
`computeDeadlines` (`domain/deadlines/compute.ts`) reads at compute time. **Zero lead days means
no renewal deadline**, and an attachment with no `expires_at` gets no deadline of either kind —
the honest answers for a link to a ticket, which is what the stories pack's `source_link` is.

A pack declares what may go in these tables — `RecordKindSpec` and `AttachmentKindSpec` in
`@harness/pack-api` — and ships no migration. `records_upsert` takes its `kind` as an enum built
from the loaded registry, so a kind no loaded pack declares is refused before it can become a
row nothing reads back.

Restricted values live in `bytea` and nowhere else. `records.name`, `records.external_id`,
`fields.value` and `attachments.properties` are plaintext, and `defineRecordKind` refuses a
record kind whose name field or external id is a restricted field, so the rule is checked at
startup rather than discovered in a leak.

### What a pack declares

`Pack` is in `harness/pack-api/src/types.ts`, the leaf module that holds every declaration on
the contract's own reference cycle.

```ts
export const pack = definePack({
  name,
  version,
  records, // RawRecordKind[]: kinds, their field manifests, their name fields
  attachments, // RawAttachmentKind[]: kinds and their lead days
  documentKinds, // what documents_classify may return
  extraction, // per document kind → target record kind, plus the prose the model reads
  formsDir, // optional
  skillsDir,
  policy, // Partial<Policy>: carried, not merged. See below.
  replaces, // kernel tool names this pack's own tools supersede
  tools, // (deps: PackToolDeps) => AnyToolDef[]
  evals, // PackEvals: corpus, cases, intake skill, judged fields, readback
});
```

The record and attachment kinds are handed over **unparsed**. The registry parses each one once,
at construction, against _this build's_ restricted-name rules, because those rules decide what
gets encrypted and so belong to whoever does the encrypting.

### Which pack receives a document

`PackRegistry.targetFor` resolves a classified document to one extraction target, in this order:
an exact claim on the document's kind; then a declared `"*"` catch-all, if any loaded pack has
one; then, **for a document with no kind at all**, the primary pack's first target. A kind that
was declared and claimed by nobody is a `ToolError` from `documents_extract` naming the kind,
not a document quietly written as the wrong record kind.

The **primary pack** is the first entry of `HARNESS_PACKS`. It answers `manifest()`,
`formsDir()` and that unclassified-document target, and nothing else depends on load order:
`registryOf` refuses two loaded packs that claim the same document kind, with `"*"` counted as a
kind, so at most one exact claim and at most one catch-all can exist. No pack declares a
catch-all today; healthcare claims its five kinds by name.

### How the catalogue is built

`createCoreToolsServer` builds two lists, and the difference between them is the whole design.

- **`deps.kernelTools`** — every tool the kernel defines, by its kernel name, filled before any
  replacement. A pack's wrapper calls the handler it wraps through this map.
- **`deps.tools`** — what is published to MCP, which is also what `approvals_execute` replays a
  parked action from.

Three rules turn the first into the second, and `domain/packs/publication.ts` is where each of
them fails loudly. The generic `records_*` tools are published only when at least one loaded
record kind leaves `genericTools` true. A kernel tool named in a loaded pack's `replaces` is
dropped, and a name that is not a kernel tool is a `ConfigError` rather than a silent no-op. Two
sources may not publish, or replace, the same name.

The kernel defines seventeen tools. A healthcare-only deployment therefore publishes five of
them and eighteen of the pack's: twelve of those eighteen are wrappers that reproduce the
pre-Plan-5 names and schemas byte for byte, and `docs/architecture/tool-surface.json` is what
proves it. Load the stories pack beside it and the catalogue grows to twenty-eight, by the five
`records_*` tools, because the `epic` kind wants them.

A wrapper that reshapes a result builds its **output schema from `deps`**. `replaces` is
process-wide, so healthcare's `documents_get`, `documents_list` and `documents_extract` also see
another pack's documents; each publishes the narrow pre-Plan-5 schema when no foreign document
kind is loaded and a widened one when there is, and passes a foreign document through in the
kernel's words rather than renaming an epic into a provider.

### What a pack cannot do

It cannot import `@harness/core-tools` or `@harness/db`; `pnpm arch` fails the build on either.
It has no database handle and no SQL. Everything it reads and writes goes through a kernel tool,
which is what keeps client scoping, the confidence threshold, the verified-field rule and the
encryption decision in one place. The kernel operations that are **not** tools — writing a
generated file into the out tree, staging a release, and the two redaction primitives
`isRestrictedName` and `MASKED` — arrive on `deps.kernel`, whose one implementation is
`PACK_KERNEL` in `domain/packs/kernel.ts`.

A pack reads configuration from `deps.env`, never from `process.env`; the ESLint rule enforces
it. Whoever builds the dependency bag decides what a pack sees, which is why an eval run on a
developer's filled-in `.env` cannot switch an outbound lookup on.

`Pack.policy` is part of the contract but `loadPolicy` (`domain/tooling/policy.ts`) does not
read it yet: `deps.policy` is `DEFAULT_POLICY` merged with the client's `HARNESS_POLICY_FILE`
only. A pack's policy is carried, not merged, unchanged from Plan 4's ruling.

`CONTRIBUTING.md`, "Adding a pack", is the worked how-to, with `packs/stories` as the example.

## The path of one tool call

An agent calls `documents_extract`. Every module named here is under
`harness/core-tools/src/`, and the steps run in this order:

1. **Registration.** `app/server.ts` built `ToolDeps` from the environment at startup, loaded
   the packs named by `HARNESS_PACKS`, and handed every definition from `tools/catalog.ts` to
   `registerTools` (`domain/tooling/registry.ts`), which wrapped each one in an MCP callback.
2. **Lineage.** The callback splits `derived_from` off the arguments — it is the registry's
   own argument, audited as lineage and never passed to the handler or hashed by `hashArgs`
   (`domain/tooling/audit.ts`).
3. **Policy.** `decide(tool.actionClass, deps.policy)` (`domain/tooling/policy.ts`) returns
   `auto`, `approval` or `blocked`. `runBlocked` writes an audit row and returns;
   `runForApproval` parks a row through `createOrReuseApproval`
   (`domain/approvals/repository.ts`) and returns its id. Both live in
   `domain/tooling/execution.ts`.
4. **Transaction.** `runAuto` opens one transaction. The handler and its audit row commit
   together, so a handler that throws leaves neither its writes nor a success row behind.
5. **Handler.** The definition in `tools/documents.ts` validates its input and calls
   `extractDocument` (`domain/documents/pipeline.ts`), which redacts the page text, builds the
   model-facing schema from the pack's manifest and stores what came back. The tool file holds
   no SQL and no prompt text.
6. **Audit.** `writeAudit` writes the row inside the same transaction, carrying the arguments
   hash, the action class, the session context and the record ids the tool reported.
7. **Effects.** Anything that leaves the process is staged, never sent: `stageEffect`
   (`domain/effects/outbox.ts`) writes an encrypted row to `tool_effects` in the handler's
   transaction, and the approvals app's dispatcher sends it later, exactly once per
   idempotency key.
8. **Error masking.** Only a `ToolError`'s message reaches the caller. Anything else becomes
   "internal error; see audit log" in `domain/tooling/execution.ts`, because a raw message can
   carry a restricted value.

## What ToolDeps carries, and what it does not

`ToolDeps` (`harness/core-tools/src/domain/tooling/types.ts`) is the package's dependency
contract: a handler reaches for nothing outside it, which is what keeps `process.env` out of
the domain and what makes every tool testable against `makeTestDeps`.

Two of its fields — `gateway` and `storageDir` — are **configuration**, not constructed objects.
A URL and a directory, not a `ModelGateway` and a `Storage`. That is deliberate, and it is the
shape a reviewer should expect to argue with, so here is the reasoning. (There used to be a
third, `verify`. It is gone: the four `VERIFY_*` variables are the healthcare pack's now, read
in `packs/healthcare/src/config.ts` out of `deps.env`.)

- **The adapter is built in the domain, from the configuration.** `httpGateway(deps.gateway)`
  inside `callModel` is the one on the live path; `fileStorage(root)` is declared beside the
  same interface but has no caller yet, because every storage call still goes through the free
  functions with `deps.storageDir` threaded in. The interface exists either way, so a second
  implementation is a new function beside the old one and not a change to this type.
- **The fake lives beside the interface, not in the deps bag.** `FakeGateway`
  (`domain/models/fake.ts`) is a loopback HTTP server with a scripted responder, kept next to
  the interface and reachable from `./testing`. A test that wants a scripted model points
  `GatewayConfig.baseUrl` at the fake's URL; it does not assemble an adapter to hand to
  `makeTestDeps`.
- **A test overrides a value, not an object.** This is the practical reason. Pointing a suite at
  `startFakeGateway`'s loopback URL is one field, and every test that only cares about a
  timeout or a storage root stays a one-line override. Threading the three interfaces through
  `ToolDeps` would make each of those tests construct an adapter to say nothing about it.

The cost is real: the domain builds its own adapters, so a caller cannot substitute one without
going through the module that builds it. Wiring the two interfaces through `ToolDeps` is the
fix, and it was deferred on purpose — it touches every handler signature and every test's deps
literal, which is a behaviour-risk refactor and not the file moves this revamp was for.

Three members exist for the **packs** rather than for the kernel, and a kernel handler should
never reach for them:

- **`kernelTools`** — every kernel tool by its kernel name, filled before any replacement, so a
  pack's wrapper can call the handler behind the name it took over. A lookup in `deps.tools`
  would find the wrapper itself and recurse.
- **`kernel`** — the operations that are not tools: `writeOutFile`, `stageRelease`,
  `isRestrictedName` and `MASKED`. A pack cannot import them, so the kernel hands them over.
- **`env`** — the environment a pack's `tools(deps)` reads its own configuration from. Core's
  own configuration is read in `app/` and arrives on this bag already parsed.

## The three invariants

Break any of these and the harness is not safe to run against real data.

1. **Every query is scoped to `deps.client`.** A tool that reads or writes a row without a
   client predicate is a tenant leak. `requireRecord` and `requireDocument` exist so that
   no handler has to remember. `requireRecord` also takes an optional kind, so a pack's own
   renamed read refuses another pack's record rather than returning it through the wrong
   vocabulary.
2. **Restricted identifiers are redacted before a model sees them.** `redactPages` runs over
   the text, `assertRedacted` runs over the exact messages about to be serialised, and both
   use the same patterns. The defence repeats on the way out: masked on read, checked again
   before Slack, checked again in the file sink.
3. **Only a `ToolError` reaches an agent.** Everything else is masked by the kernel and kept
   in `audit_log.error`, where an operator reads it with psql.

## The three error types

Declared once, in `@harness/shared`, at `harness/shared/src/errors.ts`. `@harness/core-tools`
re-exports all three from `src/index.ts`, so a module that reaches `ToolError` through
`@harness/core-tools` rather than `@harness/shared` gets the same class — indirect, not wrong.

| Type                               | Means                                                                                                 | Who sees the message     |
| ---------------------------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| `ToolError`                        | an expected failure the caller can act on: bad input, a missing record, a disabled feature            | the agent                |
| `ModelOutputError` (a `ToolError`) | the model's reply did not parse or did not match the schema; the message carries zod issue paths only | the agent                |
| `ConfigError`                      | the process is misconfigured and cannot start                                                         | the operator, at startup |

Everything else is a plain `Error`.

`@harness/db` used to be the exception, and the reason was structural: it sits below
core-tools, so importing the error types from core-tools would have been a cycle. That reason
is gone. `@harness/shared` sits below every package, db included, so db imports the same
errors and the same logger as everything else.

What is left is smaller and deliberate. `createDb` (`harness/db/src/domain/client.ts`) and
`loadKey` (`harness/db/src/shared/crypto.ts`) still throw a plain `Error` when `DATABASE_URL`
or `HARNESS_ENCRYPTION_KEY` is missing, where a `ConfigError` is what they mean. They can
reach `ConfigError` now; changing those three throws is the one piece of work this revamp
deliberately left for a follow-up, because the messages are observable — a crypto test asserts
on one — and this branch changed no behaviour.

## Where each cross-cutting concern lives

Seven of them are `@harness/shared`, a package with no workspace dependency of its own, so any
package that needs one — `@harness/db` and every pack included — imports it rather than keeping
a copy. `@harness/gateway` is the one package that declares no dependency on it, because it
uses none of the seven; the dependency is added when it needs one, not in advance.
`@harness/core-tools` re-exports all seven, so a module already importing them from there is
not wrong, only indirect.

| Concern                | Module                                    | Exports                                                         |
| ---------------------- | ----------------------------------------- | --------------------------------------------------------------- |
| environment parsing    | `@harness/shared` `env.ts`                | `numberFromEnv`, `booleanFromEnv`, `requiredEnv`, `optionalEnv` |
| errors                 | `@harness/shared` `errors.ts`             | `ToolError`, `ModelOutputError`, `ConfigError`, `describeError` |
| path containment       | `@harness/shared` `paths.ts`              | `realOrNearestAncestor`, `assertInsideRoot`                     |
| logging                | `@harness/shared` `log.ts`                | `createLogger`                                                  |
| bounded subprocesses   | `@harness/shared` `subprocess.ts`         | `runBounded`                                                    |
| JSONL                  | `@harness/shared` `jsonl.ts`              | `readJsonl`, `writeJsonl`                                       |
| CSV quoting            | `@harness/shared` `csv.ts`                | `csvCell`                                                       |
| restricted patterns    | core-tools `shared/redaction/patterns.ts` | `containsRestrictedPattern`, `isValidDea`                       |
| restricted field names | core-tools `shared/redaction/names.ts`    | `isRestrictedName`, `MASKED`                                    |
| redaction              | core-tools `shared/redaction/text.ts`     | `redactPages`, `assertRedacted`, `fieldNameFor`                 |

The three redaction modules stay in core-tools on purpose: deciding which field names are
restricted and which SSN allocations are real is domain knowledge, and `@harness/shared` holds
none. They are reachable on their own as `@harness/core-tools/redaction`, so the approvals app
can take the guard without inheriting the kernel.

## Deciding where new code goes

Ask, in order:

1. Does it know anything about records, documents, approvals or models? If not, it is a
   generic helper and it belongs in `@harness/shared`, where every package can reach it.
2. Is it content that makes the harness specific to one area — record and attachment kinds,
   document kinds, an extraction manifest, forms, skills, policy defaults, a tool that names
   any of them? Then it belongs in a pack, behind the `@harness/pack-api` contract, and core
   reaches it through the registry. `src/kernel-vocabulary.test.ts` is the second opinion.
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
| `pnpm lint:strict`    | the same, with `--max-warnings=0`: the type-aware backlog, which no gate fails on                                                                                                                        |
| `pnpm format:check`   | Prettier                                                                                                                                                                                                 |
| `pnpm arch`           | dependency-cruiser: the layer rules, "no cycles", "no test imported by production code", "no orphans", "other packages import only a declared entry point", "core-tools never statically imports a pack" |
| `pnpm arch:graph`     | writes `docs/architecture/graph.svg` (needs Graphviz)                                                                                                                                                    |
| `pnpm surface:record` | regenerates `docs/architecture/tool-surface.json` and `compose-surface.yaml`                                                                                                                             |
| `pnpm test`           | lint, then every package's vitest suite                                                                                                                                                                  |

ESLint's type-aware rules run against TypeScript **6**, installed at the workspace root only,
because typescript-eslint refuses to load against TypeScript 7. Every package still compiles
with TypeScript 7 through its own `tsc --noEmit`. That duplication is deliberate; delete it
when typescript-eslint supports 7.

dependency-cruiser cannot tell a type-only import from a value one under the TypeScript 6 it
resolves with, so `no-circular` sees both alike and a contract whose declarations refer to each
other cannot be split into one module per concept. The cycle is broken structurally instead:
`harness/pack-api/src/types.ts` is a leaf holding every declaration on the cycle, and
`pack.ts`, `kernel.ts` and `tool.ts` re-export from it.

Every architecture rule is an error. `pnpm arch` exits 1 on a layer violation and `pnpm test`
runs it first, so a crossed layer cannot reach a review. ESLint's three project rules
(`no-console`, `process.env` outside `@harness/shared`'s `env.ts` and `app/`, `throw new Error`
inside `tools/`) are errors too. Adding a package to the architecture rules is one row in
`PACKAGES` at severity `error` and one entry in `WORKSPACE_DIRS`, and nothing else.

typescript-eslint's type-aware rules are the one thing still reported as warnings: the code
trips `require-await` and the `no-unsafe-*` family in places, and clearing that is separate
work. `pnpm lint:strict` shows the backlog.

## Proof that a refactor changed nothing

`harness/core-tools/src/app/surface.test.ts` compares three things against committed snapshots on
every run:

- the MCP tool list, with each tool's input and output JSON Schema, against
  `docs/architecture/tool-surface.json` — 23 tools today;
- every environment variable name the code reads, against `.env.example`;
- the rendered Compose config, against `docs/architecture/compose-surface.yaml`.

A renamed tool, a widened schema, an undocumented variable or a changed service definition
fails the suite. Regenerate the snapshots with `pnpm surface:record` only when the change is
intended, and say so in the commit message. A new variable name goes into `.env.example` in
the same commit, or this test fails on it — that is how `HARNESS_PACKS` arrived.

The recorder behind it is `harness/core-tools/src/app/record-surface.ts`, which is both the
library the test imports and the CLI `pnpm surface:record` runs.

Two more suites guard the boundary the tool surface cannot see, because a kernel can keep every
schema byte and still know about one area of the product:

| Suite                                              | What it fails on                                                                                                                                                                           |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `harness/core-tools/src/kernel-vocabulary.test.ts` | a credentialing word in `harness/core-tools/src` or `evals/src`, tests and `shared/redaction/` aside. The allowlist is empty, and one case asserts the regex still catches what it claims. |
| `harness/core-tools/src/app/dual-pack.test.ts`     | two packs loaded at once whose catalogues collide, whose documents route to the wrong target, or whose records reach each other's reads. It is the suite `packs/stories` exists for.       |

And `harness/db/src/domain/migration-0008.test.ts` replays the shipped migration file over a
fixture of the pre-0008 schema, so the one hand-written data section in the tree is checked
rather than trusted. See the runbook, "Migration 0008 and the record model".

## One deliberate duplication

`shared/redaction/patterns.ts` carries **two** pattern sets, and a reviewer will want to merge
them. Do not. The strict-shape set behind `containsRestrictedPattern` guards text on its way to
a human channel and over-reports on purpose; the OCR-tolerant, validity-gated set behind
`redactPages` decides what gets encrypted onto a record, where a false positive
fabricates an identifier that was never on the page. Merging them changes behaviour in both
directions: a shape-only `AB1234567` would stop tripping the Slack guard, and an OCR-noisy
`O12-34-5678` would start tripping it.

The two duplications an earlier draft of this document listed — `@harness/db`'s own logger and
the pack's own `execFile` and JSONL helpers — are gone. Both existed because those packages
could not import `@harness/core-tools`; `@harness/shared` sits below all of them and they
import it.
