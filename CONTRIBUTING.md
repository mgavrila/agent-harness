# Contributing

> **Where the tree is today.** The maintainability revamp (`docs/superpowers/specs/2026-09-16-maintainability-revamp-design.md`)
> is landing one package at a time. This guide describes the **target**, because the target is
> what new work is judged against. Anything marked _(target state, landing in Tasks 4–8)_ is
> not in the tree yet: the `shared/`, `domain/`, `tools/` and `app/` folders, the
> `@harness/shared` and `@harness/pack-api` packages, and the pack contract arrive with those
> tasks. Today's real path is given beside each one. `ARCHITECTURE.md` explains the layers.

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
   plain arguments. Write its test beside it. _(target state, landing in Tasks 4–8; today the
   domains sit one level up, as `src/documents/`, `src/forms/` and `src/deadlines/`.)_
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
   already spreads it. _(target state, landing in Task 7; `ALL_TOOLS` is in
   `harness/core-tools/src/server.ts` today.)_
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

A pack is the content that makes the harness specific to one area: the document kinds the
classifier may return, the extraction manifest, `forms/` with its `templates.json` and PDFs,
`skills/`, the action-class defaults in `policy.yaml`, an optional `evals/` case file and an
optional `synthetic/` corpus generator.

Core never imports a pack by name. It loads one through the `@harness/pack-api` contract, so
three steps add one:

1. **Export `pack`.** Create `packs/<name>/` and export a `pack` from its entry module, built
   with `definePack()` from `@harness/pack-api`. Declare in `package.json#exports` only what
   anything outside the pack may read; anything not exported is unreachable, which is the
   point.
2. **Add the dependency.** Add `@harness/pack-<name>` to the `dependencies` of
   `@harness/core-tools`, so that pnpm can resolve the dynamic `import()`. Do not add a
   static import — `pnpm arch` forbids one, because the kernel has to compile and run with no
   pack installed.
3. **Switch it on.** Set `HARNESS_PACKS` in the client's `.env` to the comma-separated package
   names to load. It defaults to `@harness/pack-healthcare`.

A pack depends on `@harness/pack-api` and `@harness/shared`, never on `@harness/core-tools`.
If a pack needs something from core-tools, the contract is missing a field.

> The pack contract lands in Tasks 4–8 of the maintainability revamp (spec section 9).
> Until then `packs/healthcare` is reached through `@harness/pack-healthcare/schema` directly
> and the dependency-cruiser rule that forbids that import runs in warn mode.

## Adding a client

```bash
pnpm new-client --pack healthcare --name acme-clinic
```

Then fill in `clients/acme-clinic/.env.example`, review `SOUL.md` and `policy.yaml`, and read
"Onboarding a client" in `docs/runbook.md`.

## Adding a migration

Edit `harness/db/src/domain/schema.ts` first _(target state, landing in Task 5; it is
`harness/db/src/schema.ts` today)_, then, from `harness/db/`:

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
pnpm lint
pnpm arch
pnpm test
```
