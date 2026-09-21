# Contributing

`ARCHITECTURE.md` explains the four layers, the packages and the pack contract. This is the
how-to.

## Getting a working checkout

```bash
pnpm install
cp .env.example .env            # then set HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm db:up                      # Postgres 16 with pgvector on 127.0.0.1:15432, databases harness and harness_test
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
4. Choose the action class honestly: `read`, `write.self`, `write.internal`, `write.assign`,
   `external`, `financial`, `destructive`, `admin`. What each does depends on the caller's
   level — `DEFAULT_POLICY` in `domain/tooling/policy.ts` is the table; `external` parks an
   approval for everyone and `financial` is blocked below `lead`. A tool whose class depends on
   its arguments sets `actionClassFor` as well; `memory_add` is the example.
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
   through untouched, as `packs/healthcare/src/tools/aliases/documents.ts` does.

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

10. **Name it where a client is configured.** Add the package to `@harness/core-tools`'s
    `dependencies` so pnpm can resolve the dynamic import, then add
    `@harness/pack-healthcare` and `@harness/pack-stories` to the client document's own `packs`
    list. That list is the whole answer: `@harness/host` runs core-tools in-process, with no
    child process and no separate env block of its own to keep in step, so naming the packs once,
    in the document, is enough.

    A client `pnpm new-client` scaffolds starts from `clients/fixture/`'s document and takes
    `--pack` as its own `packs` entry; it inherits nothing from another client.

11. **Run the gates.** `pnpm -r typecheck && pnpm lint && pnpm arch && pnpm test`. If your pack
    changes the published tool list for the default deployment, run `pnpm surface:record` and
    say so in the commit; if it does not, the snapshot must not move.

The first pack named in a client document's `packs` is the deployment's **primary** pack: it
answers `deps.packs.manifest()`, `deps.packs.formsDir()` and the unclassified-document target. An
empty `packs` list loads no pack at all, and each of those three then throws naming what is
missing; the kernel's own catalogue is what such a client serves.
`documentKinds()`, `recordKinds()` and `attachmentKinds()` union them all. Nothing else depends
on load order, because `registryOf` refuses two packs that claim the same document kind or
declare the same record kind.

`Pack.policy` is declared but not yet merged into `deps.policy`: a pack's policy is carried,
not applied. Set the client document's own `policy.classes` if you need a different action-class
table today.

**A `classes:` entry does not override a level's own cell.** `decide` reads
`policy.levels[level][class]` first and falls back to `policy.classes[class]`, and the kernel's
`DEFAULT_POLICY` already ships several level cells — `levels.member.destructive: blocked`,
`levels.service.write.assign: approval`, and others. Setting `classes.destructive` in a client
document's own `policy` section therefore does nothing for `member`, whose cell wins regardless;
to loosen or tighten one level, write `levels:`:

```yaml
levels:
  member: { destructive: approval }
```

## Adding a surface

A surface is a place a human is talked to — Slack, Microsoft Teams, Telegram — that the host
loads through a contract instead of importing by name. `surfaces/memory` is the smallest
complete one; read it alongside this, and read `surfaces/slack` for the real thing.

1. **Create the package.** `mkdir -p surfaces/<name>/src` and a `package.json` named
   `@harness/surface-<name>`, with `"." : "./src/index.ts"` in `exports` and
   `@harness/surface-api` and `@harness/shared` in `dependencies`. **Never** depend on
   `@harness/approvals`, `@harness/core-tools`, `@harness/db` or another adapter; `pnpm arch`
   fails the build on any of them, tests included. Add one `PACKAGES` row and one
   `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs`, and nothing else.

2. **Declare the surface.**

   ```ts
   export const surface = defineSurface({
     name: 'teams',
     version: '0.1.0',
     secrets: ['TEAMS_APP_PASSWORD'],
     connect: async (deps) => createTeamsSession(transport(teamsConfig(deps.env)), config),
   });
   ```

   `name` is lowercase and stable: it is stored in `approvals.surface` and named in an effect
   payload. `secrets` lists the environment variables you read that are credentials, so an
   operator wiring a client's Compose environment knows which ones to keep off any container
   that does not need this adapter.

3. **Read configuration from `deps.env`, never from `process.env`.** Use `@harness/shared`'s env
   helpers with `deps.env` as their last argument, so your variables are validated and worded like
   everyone else's — and so a test suite cannot open a real connection because the machine running
   it has a filled-in `.env`. Document every name in `.env.example` in the same commit:
   `surface.test.ts` walks `surfaces/` and fails on one you did not. It finds names read through
   those helpers, so a value taken straight off `deps.env` — as `surfaces/memory` does, because
   unset and empty have to mean different things there — is invisible to the scan and has to be
   documented by hand.

4. **Implement `SurfaceSession`.** Post and update a card, post text with an optional reply
   target, send a private note, upload a file, open a form, deliver actions and submissions,
   start and stop — and deliver an inbound human message. `onMessage` registers the one handler
   for a `MessageEvent`, whose `mentioned` flag is your adapter's answer to the group-chat rule:
   true for a direct message and for a channel message that addresses the bot by name, false for
   every other channel message — the host's whole rule is to return without running when it is
   false. `surfaces/slack`'s `classifyMessage` (`src/transport/classify.ts`) is the worked example: it
   takes Slack's `message` and `app_mention` events, drops the one that double-reports a mention
   the bot already saw as `app_mention`, and sets `mentioned` true for a direct message.

   `startStream` begins a streamed reply and throws `SurfaceError` when `capabilities.streaming`
   is false, so a transport with no streaming API declares `streaming: false` and implements
   `startStream` as exactly that throw; `typing`, where the transport has one, shows that a reply
   is coming and is optional. `surfaces/slack`'s `createEditStream` (`src/stream.ts`) is the
   worked example for a transport with no native streaming call: it posts the first delta as a
   message, folds every later delta into an edit of that message no sooner than
   `STREAM_EDIT_INTERVAL_MS` apart, and edits once more with the whole text when the run ends.

   A surface that is reached by a request rather than by a connection it opens returns
   `http: { path, handle }` from `connect`, and the host mounts it at
   `/tenants/<clientId>/<path>`. Verify whatever your transport signs with, in the adapter: the
   host will not, because it would have to know your transport to try. Answer
   `{ status, refusal: { reason } }` for anything you turn away and the host writes the single
   audit row; `reason` is a short token, never a sentence, because it goes in a column somebody
   groups by.

   Declare honestly what you cannot do:

   | Surface            | forms                  | privateReply                    | update | streaming | inlineConfirm |
   | ------------------ | ---------------------- | ------------------------------- | ------ | --------- | ------------- |
   | `slack`            | yes (a modal)          | yes (ephemeral)                 | yes    | yes       | no            |
   | `memory`           | yes                    | yes                             | yes    | yes       | no            |
   | Teams (planned)    | yes (a task module)    | no — post in the thread instead | yes    | yes       | no            |
   | Telegram (planned) | no — there is no modal | no                              | yes    | no        | no            |

   The host reads those flags rather than trying and catching: a surface without `forms` gets an
   approval card with no Edit button, and one without `streaming` gets the whole reply posted
   once at `done` instead of appended as it arrives — both honest, and both needing no fallback
   protocol.

5. **Render the neutral models.** A `Card` has a title, an optional subtitle, body lines and
   actions; a `CardLine` is plain text, a labelled value, a preformatted block or a `note` of rich
   parts; a `NotePart` is text, a code span, a timestamp, a mention or an outcome icon. Turn each
   into whatever your surface draws. `Card.notice` is the one line to show where the card itself
   cannot go — a notification preview, a surface with no rich content.

6. **Throw `SurfaceError`, and watch what is in the message.** A bad conversation id, a missing
   capability, a transport that refused. The host writes that message into
   `tool_effects.last_error`, which is plaintext and which an operator pastes into a ticket, so
   name the surface and the operation and never a path, a token or a payload value — not even the
   conversation id you are rejecting, which is agent-chosen and validated only as a shape. Say
   its length instead.

   One rejection is not a failure: when your transport **accepts** a card and answers with nothing
   to address it by, throw `SurfaceAcceptedError`, the `SurfaceError` subclass that says so. A
   card is live and a human can press its buttons, and the host reads that to keep its claim on
   the row rather than post a second card on the next tick.

7. **Test it against fakes.** Split the transport out behind an interface of your own, the way
   `surfaces/slack/src/transport/` does, and export a wired-to-fakes session from a `./testing`
   subpath. No test makes a real network call.

8. **Load it.** Add the package to `@harness/host`'s dependencies, add its key to `SURFACE_ORDER`
   and `SurfacesShape` in `@harness/config-api` (the one place the schema fixes which surfaces a
   document may declare and in what order), and name it under a client document's `surfaces`
   section. Nothing in the host's own code changes: it still reaches every surface by name,
   through `surfaceSpecifier`.

A surface that is reached by a request returns `http: { path, handle }`, and the host mounts it at
`/tenants/<clientId>/<path>`. Answer with a string for a whole body, or with an async iterable of
strings for a stream; the host writes the head, pipes each chunk as it is yielded and ends when
the iterable ends. Read `request.signal` if you stream — it is aborted when the caller goes away —
and `request.clientId` if you have to report which tenant an event belongs to.

Your adapter's credentials arrive **resolved**, on `deps.secretValues`, keyed by the field name
its section of the document uses. Do not read an environment variable for a per-tenant credential:
a pooled host serves several tenants in one process and has nowhere to put one. `surfaces/web` is
the example — it reads no environment variable at all.

## Adding an identity provider

An identity provider — the contract calls it `IdentityProvider`; the kernel, whose vocabulary
test forbids the word, says "identity plug-in" — answers which principal is behind a surface
user id. `identities/static` is the smallest complete one; read it alongside this.

1. **Create the package.** `mkdir -p identities/<name>/src` and a `package.json` named
   `@harness/identity-<name>`, with `"." : "./src/index.ts"` in `exports` and
   `@harness/identity-api` and `@harness/shared` in `dependencies`. **Never** depend on
   `@harness/core-tools`, `@harness/db`, a pack, a surface or another plug-in; `pnpm arch` fails
   the build on any of them, tests included. Add one `PACKAGES` row and one `WORKSPACE_DIRS`
   entry in `.dependency-cruiser.cjs`, and nothing else.

2. **Declare it, and export it as `identity`.**

   ```ts
   export const identity = defineIdentityProvider({
     name: 'entra',
     version: '0.1.0',
     secrets: ['ENTRA_CLIENT_SECRET'],
     connect: async (deps) => createEntraSession(entraConfig(deps.env), deps.log),
   });
   ```

   `name` is lowercase and stable. `secrets` lists the environment variables you read that are
   credentials.

3. **Read configuration from `deps.env`, never `process.env`,** through `@harness/shared`'s env
   helpers with `deps.env` as their last argument, and document every name in `.env.example` in
   the same commit — the env scan walks `identities/`. `deps.identity` is the client document's
   own identity section, already validated — the declared principals and the level each surface
   gives everyone else — `deps.settings` is whatever the document's `identityPlugin.settings`
   held, and `deps.directories` is the `SurfaceDirectory` (`groupsOf`, `displayNameOf`) each
   loaded surface offers, keyed by surface name, for a plug-in that resolves levels from a
   workspace's own groups rather than from a list — `identities/slack-groups` is the worked
   example. **A plug-in is never handed a path or the whole document.**

4. **Implement `IdentitySession`.** `resolve({ surface, userId })` answers a `Principal` or
   `null`, and null means "not authorised" — never invent a guest. `get(id)`, `list()` and
   `stop()`. A principal's `id` is `u-<slug>` for a person and `svc-<slug>` for a service, its
   `level` one of the five in `@harness/shared`, and `service` only for a service: whatever your
   directory says, map it onto those, and keep the id stable across renames, because it is what
   every audit row carries.

5. **Test it against a fake directory.** No test reaches a real tenant. `StaticIdentity` from
   `@harness/identity-api/testing` is what to compare against.

6. **Load it.** Add the package to `@harness/core-tools`'s dependencies (the stdio server
   resolves its own principal from it) and to `@harness/host`'s (the host resolves every
   message's sender from it), and set a client document's `identityPlugin.kind` to `<name>`.
   Nothing in the kernel or the host's own code changes.

## Adding a runtime

A runtime is the agent loop itself — what turns a `RunRequest` into a stream of `RunEvent`s —
loaded by the host through `@harness/runtime-api` instead of imported by name.
`runtimes/deepagents` is the only one that exists; read its README for the shape a real one
takes, and read `@harness/runtime-api`'s README for the contract it implements.

1. **Create the package.** `mkdir -p runtimes/<name>/src` and a `package.json` named
   `@harness/runtime-<name>`, with `"." : "./src/index.ts"` in `exports` and
   `@harness/runtime-api` and `@harness/shared` in `dependencies`, plus whatever third-party
   packages the loop itself needs. **Never** depend on `@harness/core-tools`, `@harness/db`, a
   pack, a surface, an identity plug-in or the host; `pnpm arch` fails the build on any of them,
   tests included — the runtime reaches its tools only through the MCP client on the request,
   never through the kernel directly, and reaches no filesystem of its own (invariant 9). Add one
   `PACKAGES` row and one `WORKSPACE_DIRS` entry in `.dependency-cruiser.cjs`, and nothing else.

2. **Declare it, and export it as `runtime`.**

   ```ts
   export const runtime = defineRuntime({
     name: 'sandboxed',
     version: '0.1.0',
     secrets: ['SANDBOX_API_KEY'],
     connect: async (deps) => createSandboxedSession(deps),
   });
   ```

   `defineRuntime` checks the name is lowercase letters, digits and hyphens, that `version` is
   not empty, and that `secrets` are environment-variable-shaped and each named once — a typo
   here is a startup failure, not a silent no-op.

3. **Implement `RuntimeSession.run(request)` against the six rules of spec 4.2.** Call tools
   only through `request.tools`; never read `process.env` — a runtime's own configuration is
   `RuntimeDeps.env`, handed to `connect`, and never the ambient environment; emit exactly one
   `done` or `error`, as the last event, with a message that is always safe to post because it
   is never the framework's or a vendor's own text; stop within one model call of
   `request.signal` aborting, with a single `error: 'cancelled'`; emit `skill_activated` before
   the first tool call a skill's body causes; send `request.model.user` on every request to the
   model, because that is what the gateway attributes spend to.

4. **Run the conformance kit against your own harness.**

   ```ts
   import { runtimeConformance } from '@harness/runtime-api/testing';
   runtimeConformance('sandboxed', {
     connect: () => runtime.connect(deps),
     script: (step) => fakeGateway.setResponder(() => ({ toolCalls: [step.toolCall], content: step.finalText })),
     hang: () => fakeGateway.setResponder(() => new Promise(() => {})),
   });
   ```

   The kit owns the tool server, the `process.env` proxy and the event assertions; your harness
   only has to say how to make _this_ runtime call one tool and answer, how to make it hang, and
   — optionally — what model requests it made. `ScriptedRuntime` (`@harness/runtime-api/testing`)
   is the model-free runtime the kit's own suite and every host test run against; a model-backed
   runtime scripts the fake gateway (`startFakeGateway`, same subpath) instead of a trajectory.

5. **Load it.** Add the package to `@harness/host`'s dependencies and set a client document's
   `runtime` to `<name>`. The field is required and has no code default: naming a plug-in is a
   client's decision, the same as its `surfaces`, and a default here would be exactly the coupling
   the field exists to avoid. Nothing in the host's own code changes.

## Onboarding a tenant

You do not. A tenant is a client document in a directory or a table outside this repository, and
onboarding one changes nothing here — that is the boundary this repository is built around.

`pnpm new-client --name <slug> --display-name "<name>" [--pack <pack>] [--target <dir>]` writes
one into `--target`, or into `HARNESS_CLIENTS_DIR` when you have set it. It refuses to run with
neither, because the one place a client must not go is here.

`clients/fixture/` is the exception and the only one: the suite needs a document to read and the
scaffolder needs one to copy. A change to it is a change to the tests, and a pull request that adds
a second client to that directory is a pull request that has misread this section.

## Adding a playbook

Add an entry to the client document's own `playbooks` section (the fields are documented in
`docs/runbook.md`, "Playbooks"), naming a skill the host offers — one of a loaded pack's, or one
of the host's own in `harness/host/skills/`, which is where `knowledge-sync` lives — and a service
principal the document's `identity` section declares, then reopen the tenant (a document reload,
or a restart for a dedicated host). Test it with `playbooks_run_now` from the MCP inspector as an
`admin` principal, then read `playbook_runs`.

## Adding a migration

Edit `harness/db/src/domain/schema.ts` first, then, from `harness/db/`:

```bash
pnpm drizzle-kit generate
pnpm drizzle-kit generate   # run it twice; the second run must print "No schema changes"
```

**Plain `generate`, never `--custom`.** A custom migration is not reflected in the snapshot,
so the next generate re-emits the change and the two diverge silently.

**An extension is not a migration.** `generate` writes tables, columns and indexes and never
`CREATE EXTENSION`; do not hand-edit a generated `.sql` to add one, because a hand-edited file is
invisible to the rule that `generate` twice prints "No schema changes". Add the extension to
`EXTENSIONS` in `harness/db/src/domain/migrate.ts`, which `runMigrations` installs before the
migrator on every call. `vector`, for the knowledge tables, is the one entry today.

## Adding a secret source

`SecretSource` is two methods in `@harness/config-api`: a `name` and `resolve(clientId, ref)`. Add
the implementation in its own package, add a line to `SECRET_SOURCES` and a branch to
`loadSecretSource` in `harness/core-tools/src/domain/config/registry.ts`, and run
`secretSourceConformance` from `@harness/config-api/testing` against it — the suite is what keeps
"a source" one thing rather than two.

Two rules the contract fixes and the suite checks: `{ env: NAME }` always means the environment,
whichever source is configured, and a failure is a `ConfigError` whose message is a clause about
the _reference_ — never the value, never the row and never a statement. `resolveSecrets` puts the
client, the surface and the field in front of your clause, which is why the signature does not
carry them.

## Adding an environment variable

Read it in `app/`, or through an `@harness/shared` env helper, and never anywhere else.
Document it in `.env.example` in the same commit: `surface.test.ts` scans the source for every
name the code reads and fails on any the example file does not document. The scan walks the
kernel's seven source roots only (`SOURCE_ROOTS` in `record-surface.ts`). The platform's
directories document their own variables and are outside it on purpose.

## Adding a test

Tests live beside the code they test, named `*.test.ts`, and are never imported by shipping
code. Database tests use the real Postgres on `127.0.0.1:15432` and truncate between tests
through `useTestDb()` from `@harness/db/testing`. Fakes come from a package's `./testing`
subpath: `FakeGateway`, `MemorySurface`, `FakeCoreToolsClient`, `fakeSlackSession`,
`makeTestDeps`, `connectTools`. No test makes a real network call, a real model call, or a real
call to a messaging surface.

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

`.github/workflows/ci.yml` runs exactly these five on every pull request and every push to
`main`, against a Postgres service, and then builds every image; a red check there is the same
failure you would have seen here. The job deliberately does not set `HARNESS_STORAGE_DIR` or
`HARNESS_ENCRYPTION_KEY` in its ambient environment, because two tests assert on their absence;
every test that needs them passes them explicitly, so do not "fix" that by adding either one to
the workflow's `env:` block.

`pnpm test` and `pnpm -r typecheck` now include the platform packages (`catalog`,
`control-plane`), so a platform failure makes the repository's CI red and blocks a `v*` tag the
same as a kernel failure would. The platform's owner fixes a platform failure and a kernel
maintainer fixes a kernel one, on the same PR discipline either way.
