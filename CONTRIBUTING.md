# Contributing

`ARCHITECTURE.md` explains the four layers, the packages and the pack contract. This is the
how-to.

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

3. Add it to the exported array at the bottom of that file. `ALL_TOOLS` in `src/tools/catalog.ts`
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

A pack is an area of the product — credentialing, document scanning, whatever comes next — that
core loads through a contract instead of importing by name.

1. `mkdir -p packs/<name>/src` and give it a `package.json` named `@harness/pack-<name>`, with
   `"." : "./src/index.ts"` in `exports` and `@harness/pack-api` and `@harness/shared` in
   `dependencies`. **Never** depend on `@harness/core-tools`; `pnpm arch` fails the build on it.
2. Export `pack` from `src/index.ts`:

   ```ts
   import path from 'node:path';
   import { fileURLToPath } from 'node:url';
   import { definePack } from '@harness/pack-api';

   const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

   export const pack = definePack({
     name: 'scanning',
     version: '0.1.0',
     documentKinds: extraction.document_kinds,
     extraction, // the parsed schema/provider.json
     formsDir: path.join(root, 'forms'),
     skillsDir: path.join(root, 'skills'),
     policy: { external: 'approval' },
     evals: { injectionFile: path.join(root, 'evals', 'injection.jsonl') },
   });
   ```

   `formsDir` and `skillsDir` must be absolute and resolved from `import.meta.url`:
   `definePack` refuses a relative one, because it would resolve against whatever directory the
   harness process started in.

3. Write `schema/provider.json` — fields, credentials, `document_kinds`. Every field marked
   `restricted` must be `source: 'redaction'` and must satisfy core's `isRestrictedName`, or
   the value would be stored in plaintext; `loadPacks` validates this at startup and names the
   field it rejected.
4. Add the package to `@harness/core-tools`'s `dependencies` so pnpm can resolve the dynamic
   import, and name it in `HARNESS_PACKS` in the client's `.env`:
   `HARNESS_PACKS=@harness/pack-healthcare,@harness/pack-scanning`.
5. Pack-specific tools are optional: `tools: (deps) => [...]` on the `Pack`. They receive core's
   dependency bag as `unknown`, because a pack cannot see `ToolDeps`. Core's own tool names win
   a collision.
6. Run `pnpm surface:record` if the pack changes the published tool list, and say so in the
   commit.

The first pack named in `HARNESS_PACKS` answers `deps.packs.manifest()` and
`deps.packs.formsDir()`; `documentKinds()` unions them all. If a second pack needs its own
manifest per document, that is a feature to design, not a line to change.

`Pack.policy` is declared but not yet merged into `deps.policy`: a pack's policy is carried,
not applied. Set the client's `HARNESS_POLICY_FILE` if you need a different action-class table
today.

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

## Adding an environment variable

Read it in `app/`, or through an `@harness/shared` env helper, and never anywhere else.
Document it in `.env.example` in the same commit: `surface.test.ts` scans the source for every
name the code reads and fails on any the example file does not document.

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

Formatting gets its own commit. If a diff carries reformatting-only hunks alongside a real
change, the file was edited without the formatter: run `pnpm format` and restage.

## Before you push

```bash
pnpm -r typecheck
pnpm lint          # zero errors; the type-aware warnings are a known backlog, see pnpm lint:strict
pnpm arch          # zero violations: every rule is an error
pnpm format:check
pnpm test
```
