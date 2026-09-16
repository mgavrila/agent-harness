# @harness/core-tools

The MCP server every agent talks to: the tooling kernel that applies policy, opens the
transaction and writes the audit row; the domains that hold the actual work; the 23 tools that
expose them; and the shared helpers the packages above this one import instead of copying.

## Layout

```
src/shared/redaction/  patterns, names, text — domain knowledge; the generic env, errors, paths,
                       log, subprocess, jsonl and csv helpers live in @harness/shared instead
src/domain/        tooling, approvals, deadlines, documents, effects, forms, models, providers, storage, verify
src/tools/         23 defineTool blocks in 8 files, plus catalog.ts
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

## Configuration

`src/app/server.ts` is the only module that names an environment variable, and every value is
read through a helper in `@harness/shared` so no variable is validated more loosely than its
neighbour. `.env.example` documents them all; `src/app/surface.test.ts` fails if the code reads
one that file does not list.

`HARNESS_CLIENT`, `CORE_TOOLS_CALLER` and `NPPES_BASE_URL` have defaults, and for those three an
empty value is a startup `ConfigError` naming the variable rather than a silent fall back to the
default. Unset keeps the default. Blanking one of these lines in a `.env` is a half-filled file,
not a choice: an empty caller would audit every call as `hermes`, and an empty registry URL would
point NPI lookups at the live CMS endpoint.

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
`src/tools/<area>.ts` and into that file's exported array, and `allTools(packs)` in
`src/tools/catalog.ts` already spreads it.
