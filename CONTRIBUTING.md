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

First decide whether it is a kernel tool at all. A kernel tool is one that would make sense for
any area of the product: it names records, attachments, documents, deadlines, approvals, audit
or effects. Anything that names a provider, a licence or a payer is a **pack** tool — see
"Adding a pack" below, and `harness/core-tools/src/kernel-vocabulary.test.ts`, whose allowlist
is empty.

1. Put the logic in a domain: a function in `src/domain/<name>/` that takes `ToolDeps` and
   plain arguments. Write its test beside it.
2. Add the definition to `src/tools/<area>.ts`:

   ```ts
   const recordsArchive = defineTool({
     name: 'records_archive',
     description: 'One sentence an agent can act on, then the constraints.',
     actionClass: 'write.internal',
     input: z.object({ record_id: z.string().uuid() }),
     output: z.object({ record_id: z.string(), status: z.literal('archived') }),
     handler: async ({ record_id }, deps) => archiveRecord(deps, record_id),
     recordIds: ({ record_id }) => [record_id],
   });
   ```

3. Add it to the exported array at the bottom of that file. `kernelTools(packs)` in
   `src/tools/catalog.ts` already spreads that array, and `publishedTools` decides what of it
   reaches MCP once the loaded packs have had their say.
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
core loads through a contract instead of importing by name. `packs/stories` is the smallest
complete one; read it alongside this.

1. **Create the package.** `mkdir -p packs/<name>/{src,schema,skills}` and a `package.json`
   named `@harness/pack-<name>`, with `"." : "./src/index.ts"` in `exports` and
   `@harness/pack-api` in `dependencies` (`@harness/shared` too, once you parse an environment
   variable or throw a `ConfigError`). **Never** depend on `@harness/core-tools` or
   `@harness/db`; `pnpm arch` fails the build on either.

2. **Declare what you store.** A record kind is a name, a label, a field manifest, and which of
   those fields make the record's display name:

   ```json
   {
     "kind": "epic",
     "label": "Epic",
     "nameFields": ["title"],
     "fields": [
       { "name": "title", "type": "string", "description": "The epic's title." },
       { "name": "owner", "type": "string", "description": "The person accountable." }
     ]
   }
   ```

   Add `"externalId": { "field": "npi", "digitsOnly": true, "length": 10 }` when the kind has a
   stable outside identifier; the kernel normalises an extracted value the way you describe and
   keeps it unique per client and kind. Add `"genericTools": false` only when your pack ships
   tools of its own for the kind — healthcare does, so its deployment publishes `providers_*`
   and not `records_*`.

   A field marked `"restricted": true` must be `"source": "redaction"` and must satisfy the
   kernel's `isRestrictedName`, or its value would be stored in plaintext. The registry checks
   this when it parses your kinds at startup and names the field it rejected. A restricted field
   may not be a `nameField` or the `externalId`: both columns are plaintext.

3. **Declare what hangs off a record.** An attachment kind is a name, a label, its lead time and
   the properties it carries:

   ```json
   {
     "kind": "source_link",
     "label": "Source link",
     "leadDays": 0,
     "numberRestricted": false,
     "properties": ["issuer"]
   }
   ```

   `leadDays: 0` means the kind never needs renewing, and `deadlines_compute` writes no
   `renewal_start` row for it. A licence with `leadDays: 90` gets one ninety days before it
   expires. A kind that does not list `expires_at` among its properties gets no deadline at all,
   which is what a link to a ticket wants.

4. **Declare what your documents become.** The extraction manifest maps document kinds to
   targets, and a target names a record kind and the prose the model reads:

   ```json
   {
     "version": "1.0.0",
     "document_kinds": ["meeting_notes"],
     "role": "You read product meeting notes and return structured data.",
     "targets": [
       {
         "document_kinds": ["meeting_notes"],
         "record_kind": "epic",
         "schema_name": "epic_extraction",
         "attachments_key": "links",
         "instruction": "Extract the epic these notes describe.",
         "attachment_instruction": "Also list every tracker or document the notes link to, with the system that issued it.",
         "attachment_schema_description": "Trackers and documents these notes link to. Report the system that issued each one, not a URL."
       }
     ]
   }
   ```

   `definePack` refuses a target naming a record kind you did not declare, and a document kind
   no target reaches. The kernel supplies the injection-defence block under your `role` line and
   you cannot replace it; `injection_examples` is where you put the imperatives your own
   paperwork prints, which the kernel quotes back at the model as examples of what not to obey.

   `attachment_instruction` and `attachment_schema_description` are two different strings on
   purpose: the first is the sentence in the prompt's user turn, the second is the `description`
   of the attachment array in the JSON Schema sent as `response_format`. Most packs will want
   them to say much the same thing; they are separate because the healthcare pack's have always
   differed and the surface of a model call is not something to change by accident.

   **Claim your document kinds by name.** A target may claim `"*"`, which picks up every kind no
   other target named, but do not reach for it unless your pack really does read anything: only
   one loaded pack may declare a catch-all, and two packs claiming the same document kind —
   `"*"` counted as a kind — is a `ConfigError` at startup naming both. No pack declares one
   today. `targetFor` resolves an exact claim first, then a declared catch-all, and only for a
   document with no kind at all does it fall back to the primary pack's first target; a
   classified kind no loaded pack claims is a `ToolError` from `documents_extract` naming it.

5. **Export `pack` from `src/index.ts`.** `formsDir` and `skillsDir` must be absolute and
   resolved from `import.meta.url`: `definePack` refuses a relative one, because it would
   resolve against whatever directory the harness process started in. `formsDir` is optional.

6. **Ship tools only if you must.** A pack that leaves `genericTools` true gets `records_*`,
   `documents_*`, `deadlines_*`, `approvals_execute`, `audit_query` and `harness_*` for free,
   and the stories pack ships nothing else. When you do ship tools:

   - `tools: (deps: PackToolDeps) => AnyToolDef[]`, built with `definePackTool`;
   - reach a kernel handler through `deps.kernelTools.get('records_get')`, never
     `deps.tools` — that is the published catalogue and after a replacement it holds your own
     tool under the kernel's name, so a wrapper looking itself up there would recurse;
   - reach the kernel operations that are not tools through `deps.kernel`: `writeOutFile`,
     `stageRelease`, `isRestrictedName` and `MASKED`;
   - read configuration from `deps.env`, never `process.env`. The ESLint rule enforces it, and
     it is what stops an eval run on a filled-in `.env` making a real outbound call;
   - list in `replaces` every kernel tool yours supersedes **under the same name**. A name that
     is not a kernel tool is a startup failure, a name your own `tools(deps)` does not publish is
     a startup failure, and two loaded packs may not replace the same one. A tool of yours under
     a _different_ name is not a replacement and does not belong in the list: `replaces` is
     process-wide, so a name you put there is gone for every other pack too. To keep the generic
     `records_*` tools out of your own deployment, set
     `genericTools: false` on your record kind instead — that is per kind, not per process, and
     it is why the healthcare pack replaces seven names rather than twelve.

   A wrapper that reshapes a result has to cope with another pack's rows reaching it, because
   `replaces` is process-wide. Build the output schema from `deps` and pass a foreign row
   through untouched, as `packs/healthcare/src/tools/aliases.ts` does.

7. **Write the skills.** One `<name>/SKILL.md` per skill under `skillsDir`, with
   `metadata.harness.tools` naming only tools the loaded catalogue publishes;
   `harness/core-tools/src/tools/skills-frontmatter.test.ts` fails the build on a name that is
   not there.

8. **Put the tests where they can run.** A contract-only test lives in the pack's own `src/`,
   as `packs/stories/src/index.test.ts` does. A test that needs the real kernel and Postgres
   cannot live there without a cycle, so it goes in core-tools under
   `src/app/pack-<name>/` — that is where the healthcare tool suites are.

9. **Declare the evals.** `Pack.evals` carries the cases file, the injection file, the corpus
   directory, the intake skill, the judged free-text fields, any env values your tools must see
   pinned under test (`testEnv`), and — only when your pack renames or replaces the pipeline's
   tools — a `readback` block. No restricted field may be in `judgedFields`: its value never
   leaves the database in plaintext, and a judge prompt carrying one would ship it to a
   third-party model. `readback.classifyTool` is declared for completeness and is not driven by
   the runner today. `pnpm evals -- --pack <name>` measures it.

10. **Name it where a deployment is configured.** Add the package to `@harness/core-tools`'s
    `dependencies` so pnpm can resolve the dynamic import, then name it in all three places or
    half the deployment stays on the old pack:

    - the client's `.env`, which Compose interpolates into both services:
      `HARNESS_PACKS=@harness/pack-healthcare,@harness/pack-stories`;
    - `clients/<name>/hermes.config.yaml`, in the `mcp_servers.core-tools.env` block. That block
      is an allowlist — a variable core-tools reads has to be named there or the child never
      sees it — so `HARNESS_PACKS` is written as `'${HARNESS_PACKS}'` and must stay
      interpolated, never pinned to a pack name. The approvals app forwards the real value to
      its own child already (`harness/approvals/src/app/child-env.ts`);
    - `HARNESS_FORMS_DIR`, in that same block and in both Compose services. It is an
      **override**: unset, core-tools takes the forms directory from the first pack in
      `HARNESS_PACKS`; set, it wins.

    Every scaffolded client inherits all three, because `pnpm new-client` copies
    `clients/demo-practice/`.

11. **Run the gates.** `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm test`. If your pack
    changes the published tool list for the default deployment, run `pnpm surface:record` and
    say so in the commit; if it does not, the snapshot must not move.

The first pack named in `HARNESS_PACKS` is the deployment's **primary** pack: it answers
`deps.packs.manifest()`, `deps.packs.formsDir()` and the unclassified-document target.
`documentKinds()`, `recordKinds()` and `attachmentKinds()` union them all. Nothing else depends
on load order, because `registryOf` refuses two packs that claim the same document kind or
declare the same record kind.

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

`pnpm lint` must be at zero errors and `pnpm test` runs it first, so an error cannot reach a
review. The type-aware warnings are the one thing no gate fails on: `pnpm lint:strict` is the
same run with `--max-warnings=0` and is how you see that backlog. It is 18 warnings today,
almost all `no-unsafe-*` at JSON boundaries where narrowing `unknown` is the real fix. Do not
silence one with an inline disable to make the count go down — either narrow the type or leave
it in the backlog. `require-await` is off in tests, fakes and `testing.ts`, where an `async`
with nothing to await is what makes the signature match the interface; it stays a warning in
shipping code.
