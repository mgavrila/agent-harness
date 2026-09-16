# @harness/core-tools

The MCP server every agent talks to: the tooling kernel that applies policy, opens the
transaction and writes the audit row; the domains that hold the actual work; the 23 tools that
expose them; and the shared helpers the packages above this one import instead of copying.

## Layout

```
src/shared/redaction/  patterns, names, text — domain knowledge; the generic env, errors, paths,
                       log, subprocess, jsonl and csv helpers live in @harness/shared instead
src/domain/        tooling, approvals, audit, deadlines, documents, effects, forms, models, packs, providers, session, storage, verify
src/tools/         23 defineTool blocks in 8 files, plus catalog.ts
src/app/           server.ts (deps from the environment), main.ts (stdio entrypoint), record-surface.ts
src/index.ts       the public API
src/testing.ts     ./testing: makeTestDeps, connectTools, resultOf, approvalIdOf, useTestDb, startFakeGateway
```

## Public API

`@harness/core-tools` exports the kernel, every domain's public functions and types, and the
shared helpers — see `src/index.ts`, which is grouped and commented. The subpaths are
`./testing`, `./effects`, `./fake-gateway`, `./in-process`, `./redaction` and `./storage`. A
subpath exists so that a consumer needing one thing does not
inherit the whole barrel: the approvals app takes `containsRestrictedPattern` from
`./redaction` and `outRoot` from `./storage` rather than the package root. Nothing under
`src/app/` is reachable: the composition root reads the environment and opens a pool, and a
consumer that imported it would inherit both.

## Configuration

`src/app/server.ts` is the composition root and reads almost everything, through a helper in
`@harness/shared` so no variable is validated more loosely than its neighbour. A domain that
owns a default reads its own variable the same way, as a default parameter a caller can
override: `storageRoot` (`HARNESS_STORAGE_DIR`), `loadPolicy` (`HARNESS_POLICY_FILE`) and
`gatewayFromEnv` (`LITELLM_MASTER_KEY`).

**`gatewayFromEnv` in `src/domain/models/gateway.ts` is the documented exception**, and it is
the only one in the workspace. Three more variables — `HARNESS_GATEWAY_URL`,
`HARNESS_GATEWAY_TIMEOUT_MS` and `HARNESS_GATEWAY_MAX_CALLS_PER_RUN` — are read there directly
rather than through a helper, behind the repository's only `no-restricted-syntax` suppression.
The helpers read an empty string as unset; this function has always treated an empty
`HARNESS_GATEWAY_URL` as the literal empty base URL and an empty numeric variable as zero,
which fails the range check and throws at startup. Keeping that exact behaviour is why the rule
is suppressed rather than satisfied. Look there, not only at `app/`, when tracing a gateway
variable.

`.env.example` documents every name; `src/app/surface.test.ts` fails if the code reads one that
file does not list.

`HARNESS_CLIENT`, `CORE_TOOLS_CALLER` and `NPPES_BASE_URL` have defaults, and for those three an
empty value is a startup `ConfigError` naming the variable rather than a silent fall back to the
default. Unset keeps the default. Blanking one of these lines in a `.env` is a half-filled file,
not a choice: an empty caller would audit every call as `hermes`, and an empty registry URL would
point NPI lookups at the live CMS endpoint.

Two smaller wordings changed with the shared helpers, and both are behaviour a `.env` can trip.
`LITELLM_MASTER_KEY` set to whitespace is now rejected at startup exactly as an empty one is —
`requiredEnv` trims before testing — where before only a truly empty value failed. And a numeric
variable out of range now reports `must be an integer between …` for a count or a port and
`must be a number between …` for a threshold, with the unit appended where there is one, instead
of one shared wording for both.

`HARNESS_FORMS_DIR` is an override, not a requirement: unset, the forms directory comes from the
first pack named in `HARNESS_PACKS`, so changing the pack changes the templates with it.

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
