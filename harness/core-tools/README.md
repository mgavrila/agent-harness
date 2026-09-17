# @harness/core-tools

The MCP server every agent talks to, and a **pack-agnostic kernel**: the tooling layer that
applies policy, opens the transaction and writes the audit row; the domains that hold the
actual work; the sixteen kernel tools that expose them; and the shared helpers the packages
above this one import instead of copying.

It knows about records, attachments, documents, deadlines, approvals, audit and effects, and
nothing about any one area of the product. `src/kernel-vocabulary.test.ts` greps this package's
own source for credentialing vocabulary and its allowlist is empty. The 22 tools a default
deployment publishes are four of the sixteen plus the eighteen `@harness/pack-healthcare`
contributes; ARCHITECTURE.md, "The kernel and a pack", is the why.

## Layout

```
src/shared/redaction/  patterns, names, text — domain knowledge; the generic env, errors, paths,
                       log, subprocess, jsonl and csv helpers live in @harness/shared instead
src/domain/        tooling, approvals, audit, deadlines, documents, effects, files, identity, models, packs, records, session, storage
src/tools/         the sixteen kernel defineTool blocks in 6 files, plus catalog.ts
src/app/           server.ts (KernelConfig from the environment, the principal, one run), main.ts (stdio entrypoint), record-surface.ts
src/index.ts       the public API
src/testing.ts     ./testing: makeTestDeps, connectTools, resultOf, approvalIdOf, useTestDb, startFakeGateway, TEST_PRINCIPAL, TEST_CONTEXT
```

## Public API

`@harness/core-tools` exports the kernel, every domain's public functions and types, and the
shared helpers — see `src/index.ts`, which is grouped and commented. The subpaths are
`./testing`, `./effects`, `./in-process`, `./redaction` and `./storage`. A subpath exists so
that a consumer needing one thing does not inherit the whole barrel: the approvals library
takes `containsRestrictedPattern` from `./redaction` and `outRoot` from `./storage` rather than
the package root. Nothing under `src/app/` is reachable: the composition root reads the
environment and opens a pool, and a consumer that imported it would inherit both. There is no
`./fake-gateway` subpath any more — the fake moved to `@harness/runtime-api/testing` (below).

## Configuration

`buildKernelConfig` (`domain/tooling/config.ts`) does the startup-only work once — pack loading,
policy parsing, key loading — from an `EnvSource` a caller passes in; it used to live in
`app/server.ts`, which no other package may import, and moved to the domain layer so
`@harness/host` can call it too, once per process, and clone it into per-run deps with
`depsForRun`. `src/app/server.ts` is still the stdio server's own composition root and reads
almost everything through a helper in `@harness/shared` so no variable is validated more
loosely than its neighbour. Two domains read their own variable the same way, as a default
parameter a caller can override: `storageRoot` (`HARNESS_STORAGE_DIR`) and `loadPolicy`
(`HARNESS_POLICY_FILE`). The third reader, `gatewayFromEnv`, takes no parameter and is the
exception described next.

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

`HARNESS_CLIENT`, `HARNESS_PRINCIPAL` and `HARNESS_IDENTITY` have defaults, and for each an
empty value is a startup `ConfigError` naming the variable rather than a silent fall back.
`HARNESS_PRINCIPAL` names an id the identity plug-in must declare; one it does not is a startup
error too, because a server that started anyway would audit every call as somebody nobody
vouched for. Parsing happens in the files worker when `HARNESS_FILES_URL` is set and in this
process otherwise.

The four `VERIFY_*` and `NPPES_*` variables are **not** read here any more. They are the
healthcare pack's, read in `packs/healthcare/src/config.ts` out of `deps.env`, the environment
whoever builds the dependency bag hands over. That file keeps the rule this one used to apply:
`NPPES_BASE_URL` set but empty is a `ConfigError`, never a silent fall back that would point NPI
lookups at the live CMS endpoint.

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
server — for anything that calls a model. The fake itself lives in `@harness/runtime-api/testing`
now, not here: both runtimes and the kernel's own model-gateway tests need it, and neither
runtime may import this package. `./testing` re-exports it unchanged, so nothing in this
package's own tests moved. No test reaches the network, Slack or a model provider. Do not
source `.env` first.

`src/app/surface.test.ts` compares the published tool schemas, the set of environment variable
names and the rendered Compose config against `docs/architecture/`. Regenerate with
`pnpm surface:record` when a change to any of them is intended.

## Adding a tool

See CONTRIBUTING.md. In one line: the logic goes in a domain, the `defineTool` block goes in
`src/tools/<area>.ts` and into that file's exported array, and `kernelTools(packs)` in
`src/tools/catalog.ts` already spreads it.

### A kernel tool or a pack tool?

A kernel tool is one that would make sense for any area of the product: it names records,
attachments, documents, deadlines, approvals, audit or effects. Anything that names a provider,
a licence or a payer is a pack tool — `src/kernel-vocabulary.test.ts` will tell you so, and its
allowlist is empty. See CONTRIBUTING.md, "Adding a pack", step 6.

What reaches MCP is not this list. `publishedTools` drops a kernel tool a loaded pack replaced,
and drops the five generic `records_*` tools when every loaded record kind sets
`genericTools: false`; `deps.kernelTools` still holds all sixteen by their kernel names, which
is how a pack's wrapper calls the handler it took over.
