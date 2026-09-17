# Plan 6: Surface-agnostic messaging — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the approvals app into a surface-agnostic host — a `Surface` contract in `@harness/surface-api`, adapters loaded by name from `HARNESS_SURFACES`, neutral `surface_message` / `surface_file` effects and neutral `approvals` addressing columns — with Slack reduced to one adapter (`@harness/surface-slack`) whose rendered Block Kit is byte-for-byte what it is today, proven by a second adapter (`@harness/surface-memory`) the suite loads beside it.

**Architecture:** Five moves. (1) **The contract.** A new leaf package `@harness/surface-api` declares what a messaging surface can do — post and update a card, post text in a thread, send a private note, upload a file, optionally open a form, and deliver a human's actions back — in neutral models (`Card`, `Form`, `Conversation`, `MessageRef`) with no Block Kit, Bolt or Slack id shape in sight, plus `MemorySurface` under a `testing` subpath. (2) **The record model.** Migration `0009_surface_addressing` replaces `approvals.slack_channel` / `slack_ts` with `surface`, `conversation_id` and `message_ref`, copies today's rows across with `surface = 'slack'`, and renames the two in-flight sink names on `tool_effects`. (3) **Two adapters.** `surfaces/slack` is today's render, transport and Web-API code moved behind the contract, with its Block Kit pinned byte-for-byte; `surfaces/memory` is an in-process surface with no transport. (4) **The host.** `@harness/approvals` keeps its name and loses every Slack import: its poller, decisions, handlers, sinks and runner are written against `SurfaceSession`, and `loadSurfaces` reads `HARNESS_SURFACES` exactly as the kernel reads `HARNESS_PACKS`. (5) **The kernel stops naming Slack.** `harness_notify` and `forms_release` keep the `channel` argument name but validate a neutral conversation id and gain an optional `surface`; the sinks become `surface_message` and `surface_file`; a vocabulary test keeps the messaging words out of the kernel, the packs and the host.

**Tech Stack:** unchanged. Node `>=22`, pnpm `11.4.0`, TypeScript `7.0.2` strict ESM (with `typescript@6.0.3` at the workspace root for typescript-eslint only), zod v4 as `import * as z from 'zod/v4'`, drizzle-orm `0.45` + drizzle-kit, `@modelcontextprotocol/server`/`client` v2, vitest 5, Postgres 16, ESLint `9.39.5`, Prettier `3.9.7`, dependency-cruiser `16.10.4`. No new third-party dependency: `@slack/bolt` and `@slack/web-api` move from `@harness/approvals` to `surfaces/slack` and nothing else is added.

**Spec:** `docs/superpowers/specs/2026-09-17-surface-agnostic-messaging-design.md`

## Global Constraints

Every task's requirements implicitly include this section.

- Node `>=22`; pnpm `11.4.0`; TypeScript strict ESM everywhere; zod is always imported as `import * as z from 'zod/v4'`.
- **The four layers hold.** `shared → domain → tools → app`, imports only downward, other packages reached only through `index.ts` or a declared subpath export. Every gate is at **0 errors after every task**: `pnpm -r typecheck`, `pnpm lint`, `pnpm arch`, `pnpm format:check`, `pnpm surface:record` leaves the working tree clean, and the full suite (`pnpm -r test`) is green.
- **Environment variable names are unchanged.** Nothing is renamed and nothing is removed. Two names are added, each documented in `.env.example` by the task that first reads it, because `harness/core-tools/src/app/surface.test.ts` scans the source and fails on an undocumented name: `HARNESS_SURFACES` (Task 4) and `MEMORY_ALLOWED_USERS` (Task 3, and see decision 18 — the spec's section 6 asks for it and it changes nothing for the demo deployment, which loads no memory surface).
- **The Slack adapter's rendered Block Kit is byte-identical to today's** for the three fixture cases — the pending card, the decided card and the edit modal. Task 3 pins each one as a whole-object `toEqual` against the literal today's code produces, and no later task edits those expectations.
- **`docs/architecture/tool-surface.json` changes in exactly four places, in Task 5, and nowhere else.** The two `channel` patterns become the neutral conversation-id pattern, and `forms_release` and `harness_notify` each gain one optional `surface` property. Tasks 1, 2, 3, 4 and 6 leave the file byte-identical; if it moves in one of them, something is wrong. Task 5 re-records it with `pnpm surface:record` and commits the diff.
- **`packs/*/skills/*/SKILL.md` is not edited by any task in this plan.** A skill is a prompt; editing one changes agent behaviour, which this plan is not for.
- **Restricted values never appear in plaintext.** `approvals.surface`, `approvals.conversation_id`, `approvals.message_ref`, `tool_effects.summary`, `tool_effects.last_error` and `tool_effects.result` are plaintext columns: an adapter's error message, a sink's result and a card's notice line must carry identifiers only, never payload content and never a filesystem path.
- **Only a `ToolError` reaches an agent.** A `SurfaceError` is host-facing: the host records its message on the effect row or replies with it in the thread, never a stack.
- **Commit messages: conventional prefix, imperative subject, and NO trailer of any kind.** No `Co-Authored-By`, no `Generated with`, nothing. This overrides any trailer guidance from the environment.
- **Never run `docker compose up`, `docker compose down` or `pnpm db:up`/`pnpm db:down`.** `docker compose ... config` is read-only and is what the surface recorder uses; that one is fine.
- **Never source `.env` into the shell before running tests.** A crypto test asserts the behaviour of an unset `HARNESS_ENCRYPTION_KEY`.
- Test database: `postgres://harness:harness@localhost:15432/harness_test`. It exists; do not create or drop it. **One exception:** Task 2's migration test creates and drops a database of its own, `harness_test_migration_0009_<pid>`, over the `harness_test` connection, for the same reason `migration-0008.test.ts` does — a migration whose SQL is schema-qualified to `"public"` cannot be replayed inside a scratch schema.
- Do not push from a task.

---

## Facts verified for this plan

Everything below was read out of the Plan 5 branch checked out at `.claude/worktrees/plan-5-pack-agnostic` on 2026-09-17, which is what main will be when this plan runs. Quote the file, not memory.

| Fact | Value | Where |
|---|---|---|
| Bolt is constructed in exactly one file | `new App({ token: required('APPROVALS_SLACK_BOT_TOKEN'), appToken: required('APPROVALS_SLACK_APP_TOKEN'), socketMode: true, logLevel: LogLevel.INFO })` | `harness/approvals/src/app/main.ts:69-74`; the only `@slack/bolt` import in the repository is `main.ts:4` |
| `WebClient` is reached only through Bolt's own `.client` | `webClientApi(bolt.client)` | `main.ts:124`, `domain/slack/web-client.ts:1` |
| The app's Slack slice is already an interface of its own | `SlackApi { chat.postMessage/update/postEphemeral, files.uploadV2, views.open }` | `harness/approvals/src/domain/slack/types.ts:45-57` |
| The inbound seam is already transport-free in its signature | `HandlerRegistry { action(actionId, handler); view(callbackId, handler) }` | `harness/approvals/src/domain/slack/handlers.ts:41-44` |
| The pending card is five blocks | section `*Approval needed*\n<summary>`, context (action · requested by · expires `<!date^…>`), section with a fenced payload preview, actions with `block_id: 'harness_approval_actions'`, context `` Approval `<id>` `` | `domain/render/blocks.ts:25-57` |
| The decided card is the same three header blocks plus two contexts | `[...headerBlocks(row), contextBlock(lines.join('\n')), contextBlock(...)]`, with `:white_check_mark:` / `:no_entry:` and `<@user>` inside the first | `domain/render/blocks.ts:86-104` |
| The post's fallback text and the update's text are **different strings** | post: `Approval needed: ${row.summary}`; update: `Approval ${row.id} ${row.status}` | `blocks.ts:60-62`, `domain/decisions.ts:70` |
| The thread reply carries a Slack mention in plain text | `` const who = `<@${row.decidedBy ?? 'unknown'}>` `` | `domain/decisions.ts:42` |
| The modal's ids are three constants and its `private_metadata` is JSON | `callback_id 'harness_approval_edit_modal'`, `block_id 'harness_approval_note'`, `action_id 'harness_approval_note_input'`, `{ approval_id, channel }` | `domain/render/modal.ts:22-51`, `domain/render/types.ts:5-10` |
| The card's action ids are the ones the demo's interaction payloads already carry | `harness_approval_approve`, `harness_approval_edit`, `harness_approval_decline` | `domain/render/types.ts:5-7` |
| The poller's claim marker is a Slack-named column | claims with `.set({ slackChannel: deps.channel, claimedAt: now })` guarded on `isNull(approvals.slackChannel)`; releases on a failed post; keeps the claim when only the `slackTs` write fails | `domain/poller.ts:59-137`, `STALE_CLAIM_MS = 2 * 60 * 1000` at `poller.ts:31` |
| `approvals` carries the two Slack columns and `claimed_at` | `slackChannel: text('slack_channel')`, `slackTs: text('slack_ts')`, `claimedAt: timestamp('claimed_at', …)` | `harness/db/src/domain/schema.ts:163-166` |
| The last migration is 0008 and the journal has nine entries | `drizzle/0008_generic_records.sql`, `meta/_journal.json` idx 8 | `harness/db/drizzle/` |
| 0008 is the template for a hand-written data section | generated statements, then `-- harness:data-section:begin … end`, then the destructive statements | `harness/db/drizzle/0008_generic_records.sql:36-51` |
| …and `migration-0008.test.ts` is the template for its test | reads the shipped file, splits on `--> statement-breakpoint`, strips comment lines, replays it inside one transaction over a scratch database, rolls back | `harness/db/src/domain/migration-0008.test.ts:30-41,73-113` |
| The scratch database is created and dropped by a helper, named by pid | `MIGRATION_DATABASE = \`harness_test_migration_${process.pid}\`` | `harness/db/src/domain/legacy-0007.test-helpers.ts:81` |
| `harness/db`'s suite runs one file at a time | `fileParallelism: false` | `harness/db/vitest.config.ts` |
| `tool_effects.payload_encrypted` is encrypted, so **SQL cannot rewrite a payload** | `payloadEncrypted: encrypt(JSON.stringify(input.payload ?? null), deps.encryptionKey)` | `harness/core-tools/src/domain/effects/outbox.ts:36` |
| Only `staged` rows are ever dispatched | `.where(eq(toolEffects.status, 'staged'))` | `outbox.ts:148` |
| Sink dispatch is already neutral: a string key into a plain map | `const handler = sinks[candidate.sink]` | `outbox.ts:155` |
| The two sink names are staged at two call sites | `sink: 'slack_message'` and `sink: 'slack_file'` | `harness/core-tools/src/domain/session/repository.ts:83`, `harness/core-tools/src/domain/files/release.ts:66` |
| The Slack channel-id regex is duplicated in a kernel tool and a pack tool | `/^[CGD][A-Z0-9]{2,}$/` with message `channel must be a Slack channel id` | `harness/core-tools/src/tools/harness.ts:49`, `packs/healthcare/src/tools/forms.ts:147` |
| …and it is the only Slack shape in the recorded surface | two `"pattern": "^[CGD][A-Z0-9]{2,}$"` occurrences, no literal `slack` anywhere in the file | `docs/architecture/tool-surface.json:1090-1092` (`forms_release`), `:1261-1263` (`harness_notify`) |
| The child-env allowlist hard-codes the Slack token names | `NEVER_FORWARDED = ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY']` | `harness/approvals/src/app/child-env.ts:41-49` |
| The env scan does **not** walk a `surfaces/` directory today | `SOURCE_ROOTS = ['harness', 'packs', 'evals', 'scripts']` | `harness/core-tools/src/app/record-surface.ts:156` |
| …and one of its anchors is a variable this plan moves into an adapter | `SCAN_ANCHORS` contains `'SLACK_APPROVALS_CHANNEL'`, read today at `main.ts:52` | `harness/core-tools/src/app/surface.test.ts:24-31` |
| The env scan recognises a helper call with the name first | `\b(?:numberFromEnv|booleanFromEnv|requiredEnv|optionalEnv|envOrDefault|required|seconds|port)\(\s*(?:env,\s*)?'([A-Z][A-Z0-9_]*)'` | `record-surface.ts:159-162` |
| The kernel vocabulary test is a grep over two source roots with an empty allowlist | `SCANNED = [{ root: 'harness/core-tools/src', skip: [/\.test\.ts$/, /\/shared\/redaction\//] }, { root: 'evals/src', … }]` | `harness/core-tools/src/kernel-vocabulary.test.ts:38-50` |
| A bare `blocks` cannot join that regex as written | `evals/src/domain/report/render.ts:116` and `build.ts:76` both say "blocks promotion" | those files |
| Five comments and three strings in core-tools name Slack today | `tools/harness.ts:39,49`, `domain/session/repository.ts:70,77,83,86`, `domain/files/release.ts:8,66,69`, `domain/storage/file-store.ts:32`, `domain/tooling/types.ts:86`, `shared/redaction/index.ts:7`, `shared/redaction/patterns.ts:7,18` | grep, non-test sources |
| The packs name Slack in three places, none of them a skill | `packs/healthcare/src/tools/forms.ts:140,147`, `packs/healthcare/src/domain/forms/types.ts:6` | those files |
| A pack is loaded by name through one dynamic import with three named failure modes | `loadPacks(names)`: `ERR_MODULE_NOT_FOUND`/`ERR_PACKAGE_PATH_NOT_EXPORTED` → one message; a `ConfigError` re-raised with the pack's name; anything else logged and replaced | `harness/core-tools/src/domain/packs/registry.ts:184-208` |
| …and the list comes from a comma-separated variable with a default | `(optionalEnv('HARNESS_PACKS') ?? '@harness/pack-healthcare').split(',').map(trim).filter(≠'')` | `harness/core-tools/src/app/server.ts:48-53` |
| The contract package's cycle-free shape is `types.ts` + re-exporting modules | "`types.ts` … holds every declaration on that cycle … `pack.ts`, `kernel.ts` and `tool.ts` re-export the pieces" | `harness/pack-api/src/types.ts:9-19` |
| `definePack` is plain runtime validation, not zod | name pattern `/^[a-z][a-z0-9-]*$/`, non-empty version, absolute paths, cross-checks, `ConfigError` each time | `harness/pack-api/src/pack.ts:8-87` |
| Adding a package to the architecture rules is two lines | one `PACKAGES` row and one `WORKSPACE_DIRS` entry | `.dependency-cruiser.cjs:19-23,33-44,92-103` |
| A pack may not import core-tools, and the rule is written as a to-path regex | `from: { path: '^packs/', pathNot: ['\\.test\\.ts$', '\\.test-helpers\\.ts$'] }, to: { path: '^(harness\|evals\|scripts)/', pathNot: ['^harness/pack-api/src/', '^harness/shared/src/'] }` | `.dependency-cruiser.cjs:205-211` |
| …and core-tools may not statically import a pack, with two exemptions | `pathNot: ['\\.test\\.ts$', '^harness/core-tools/src/testing\\.ts$']`, `to: { path: '^packs/[^/]+/', dependencyTypesNot: ['dynamic-import'] }` | `.dependency-cruiser.cjs:150-159` |
| `pnpm arch` cruises an explicit glob list that has no `surfaces/` entry | `depcruise 'harness/*/src/**/*.ts' 'evals/src/**/*.ts' 'packs/*/*.ts' …` | root `package.json` `scripts.arch` |
| The workspace globs are `harness/*`, `packs/*`, `evals`, `scripts` | no `surfaces/*` | `pnpm-workspace.yaml` |
| ESLint bans `process.env` outside `shared/env.ts`, `**/src/app/**` and tests | `PROCESS_ENV_IS_FINE`, and "No pack is on this list, on purpose" | `eslint.config.js:101-108` |
| …and turns `require-await` off in `**/fake.ts` and `**/testing.ts` | the fake-implements-an-interface case | `eslint.config.js:209-212` |
| The approvals image copies four directories and no more | `COPY harness ./harness`, `COPY packs ./packs`, `COPY clients ./clients`, `COPY scripts ./scripts` | `harness/compose/node.Dockerfile:13-16` |
| The approvals service has no `env_file`, only an explicit allowlist | `APPROVALS_SLACK_BOT_TOKEN`, `APPROVALS_SLACK_APP_TOKEN`, `SLACK_APPROVALS_CHANNEL`, `SLACK_ALLOWED_USERS`, plus `HARNESS_PACKS` | `harness/compose/docker-compose.yml:216-244` |
| Nothing in the workspace imports `@harness/approvals` | the only mentions are the root `approvals` script and three comments | grep over `*.ts`/`*.json` |
| `@harness/shared` has no id module today | eight exports across seven modules: errors, env, paths, log, subprocess, jsonl, csv | `harness/shared/src/index.ts` |

---

## Decisions where the spec and no-behaviour-change pull apart

The spec fixes the shape of `Card`, `Form` and the migration in its section 2 table, and its decision 17 requires the Slack adapter's rendered Block Kit to be byte-for-byte what it is today. Those two cannot both be honoured literally: today's card carries a Slack date token, two emoji shortcodes, a user mention and two *different* plain-text fallbacks, none of which a `Card { title, body: CardLine[], actions, footer? }` can express. Each ruling below is the smallest change to the spec's model that keeps the bytes, and each is recorded in `ARCHITECTURE.md` by Task 6.

1. **`CardLine` gains `{ code }` and `{ note: NotePart[] }`, and a note part may be a timestamp, a mention or an icon.** The spec's `{ label, value } | { text }` cannot produce `` `forms_release` · requested by `hermes` · expires <!date^1789…^{date_short_pretty} {time}|…> ``, nor `:white_check_mark: Approved by <@U012> at <!date…>.`. `NotePart = { text } | { code } | { at: Date } | { user } | { icon }` is the vocabulary those two lines actually need, and every part of it is neutral: a Telegram adapter renders `{ at }` with its own formatter and `{ user }` as `@name`, a Teams adapter as an Adaptive Card `TextBlock`. **Why not push the rendered string down from the host:** a host that formats a date is a host that has picked a surface, which is the coupling this plan removes.

2. **`Card` gains `id`, `subtitle` and `notice`; `footer` is `NotePart[]`, not a string.**
   - `notice` is the one line a surface shows where it cannot render the card. It exists because today the post and the update carry *different* text: `Approval needed: <summary>` on `chat.postMessage` (`blocks.ts:60`) and `Approval <id> <status>` on `chat.update` (`decisions.ts:70`). Deriving it from the card would change one of them.
   - `subtitle` is the second line of the first block. Today block 1 is `*Approval needed*\n<summary>` — one block, two lines — and any rule that splits `title` from the first body line is a rule a second adapter has to guess at.
   - `id` is a stable identifier for the kind of card. The Slack adapter uses `` `${card.id}_actions` `` as the actions block id, which for `id: 'harness_approval'` reproduces today's `harness_approval_actions` exactly. **Why not hard-code it in the adapter:** `harness_approval` is the host's word, and an adapter that knows it knows about approvals.
   - `footer` is `NotePart[]` because today's footer is `` Approval `<id>` `` — mrkdwn backticks, which a plain string would force the host to write.

3. **`Form` gains `cancelLabel` and `intro`, and `FormField` gains `maxLength` and `placeholder`.** Today's modal has a Cancel button, an explanatory section above the input, a 1000-character cap and a placeholder (`modal.ts:27-48`). Without these four the rendered view is not the same view.

4. **`SurfaceSession` gains `mention(userId): string`.** The thread reply Hermes reads is plain text containing `<@U012>` (`decisions.ts:42`). `postText` takes a string, so either the host spells the mention — Slack syntax in the host — or the surface is asked how it spells one. The second is one method and no coupling. Memory answers `@U012`.

5. **The conversation-id pattern lives in `@harness/shared`, and `@harness/pack-api` re-exports it as `CONVERSATION_ID_PATTERN`.** Spec section 7 wants the pack to import it from `@harness/pack-api` and the adapters need the same string; `pack-api-imports-only-shared` forbids `@harness/pack-api` from importing `@harness/surface-api`, and two leaf packages cannot share a constant without a third. `@harness/shared` is that third, it is below both, and a string-shape regex carries no domain knowledge. The pack's import line is exactly what the spec asks for.

6. **The migration renames the two sink names and does not touch any payload.** Spec decision 8 says pending `tool_effects` rows have their "payload gains `surface: 'slack'`". They cannot: `payload_encrypted` is a `bytea` written by `encrypt(JSON.stringify(payload), key)` (`outbox.ts:36`) and SQL has no key. The intent — an in-flight row still delivers after the upgrade — is met instead by the sink: a payload with no `surface` resolves to the **primary** surface, and the host's surface sinks accept the pre-0009 `channel` key as an alias for `conversation`. For the demo deployment the primary is Slack, so an in-flight row delivers to exactly where it would have. Task 4's sink test stages a legacy-shaped payload and proves it.

7. **The migration renames the sink only on rows that can still be sent** — `status IN ('staged', 'dispatching', 'needs_review')`. A `dispatched` row is history and a rename would rewrite what happened; a `failed` row is terminal too. The migration test asserts a dispatched `slack_message` row keeps its name.

8. **`.env.example` gains `HARNESS_SURFACES` in Task 4, not Task 6.** Spec section 8 groups every configuration file into the last task, but `surface.test.ts` scans the source for every variable the code reads and fails on any the example file does not document — so the task that reads it must document it. Task 6 still owns the prose: the "Messaging surfaces" heading, the "Slack adapter" sub-heading, the client example, and Compose.

9. **`'surfaces'` joins `SOURCE_ROOTS` in `record-surface.ts` in Task 3.** `SCAN_ANCHORS` in `surface.test.ts` requires the scan to find `SLACK_APPROVALS_CHANNEL`, and after Task 4 that variable is read in `surfaces/slack`. Adding the root in Task 3, when the directory first exists, keeps every gate green at every commit. It changes no snapshot: the env scan and the tool surface are different functions.

10. **The architecture rules land with the packages they constrain, not all in Task 4.** Spec section 10 lists `surfaces-import-only-api-and-shared` and `host-never-imports-a-surface` in task 4. A rule over a directory that does not exist yet is a rule nobody has tested, so: Task 1 adds the `surface-api` package row and `surface-api-imports-only-shared`; Task 3 adds the two adapter package rows and `a-surface-imports-only-api-and-shared`; Task 4 adds `the-host-never-statically-imports-a-surface`, which is the rule that has something to catch only once the host loads them dynamically.

11. **"Only the four places" is proved by four structural assertions, not by a second committed copy of the snapshot.** Spec section 9 asks for "a test that diffs the snapshot against a committed expectation". A committed expectation is a second copy of a 2200-line file that has to be updated twice forever, and the first time someone updates only one of them the test becomes decoration. Task 5's test asserts instead, against the recorded file: the 23 tool names are unchanged; the Slack channel pattern appears zero times; exactly two input schemas declare a `surface` property and they are `forms_release` and `harness_notify`; and neither lists it as required. Those are the four places, stated as properties rather than as bytes.

12. **`private_metadata`'s JSON key changes from `channel` to `conversation`, and the host's parser accepts both.** It is the one byte in the Slack interaction payloads this plan moves. It is round-tripped by the host inside a single interaction and never stored, so the only exposure is a modal already open across a deploy; accepting the legacy key costs three lines and removes even that. The modal *view* itself is still pinned byte-for-byte, with the metadata passed in as an opaque string.

13. **The vocabulary rule is two regexes over two different root lists.** The existing credentialing regex keeps its roots (`harness/core-tools/src`, `evals/src`). The new messaging regex — `slack`, `bolt`, `block kit`, `thread_ts`, `blocks` — runs over `harness/core-tools/src`, `packs/healthcare/src` and `packs/stories/src`, and **not** over `evals/src`, where two non-test lines legitimately say "blocks promotion" (`report/render.ts:116`, `report/build.ts:76`). Rewording eval prose to satisfy a messaging rule that has nothing to do with the eval runner would be the tail wagging the dog. The host gets its own file, `harness/approvals/src/host-vocabulary.test.ts`, because a test in core-tools that scanned another package's source would fail in whichever suite ran it.

14. **The messaging scan has no `shared/redaction/` exemption, so Task 5 rewords those two comments.** The credentialing regex exempts that folder because `RESTRICTED_NAME_KEYS` is a deliberate list of identifier stems. Nothing in redaction needs the word Slack: `patterns.ts:7,18` and `index.ts:7` mean "a human channel", and saying so is an improvement rather than a concession.

15. **`@harness/surface-slack` is a dependency of the host and `@harness/surface-memory` is a devDependency**, mirroring `@harness/pack-healthcare` and `@harness/pack-stories` on `@harness/core-tools`. The shipped image serves Slack; memory is for the suite and for a developer's local run, both of which install devDependencies.

16. **`allowedUsers` may hold the single member `*`, which means every user, and an empty set still fails closed.** Spec decision 13 wants a per-surface allowlist that fails closed, and spec section 6 wants the memory surface to default to everyone. A `ReadonlySet<string>` cannot express "everyone" through `.has`, so the contract exports `ANY_USER = '*'` and `allowsUser(set, id)`, and documents that only a surface with no transport may use it. The host calls `allowsUser`, never `.has`, so the rule is in one place.

17. **`parseAllowedUsers` moves out of the host into `@harness/surface-api`.** Two adapters parse a comma-separated allowlist out of their own variable; the host parses none. Its five-line body and its tests move with it.

18. **`MEMORY_ALLOWED_USERS` is a second environment addition, and the brief asked for exactly one.** Spec section 6 gives the memory adapter an allowlist variable defaulting to the wildcard, and an adapter that read no variable would be the one surface whose authorisation could not be narrowed. It is optional, it is commented out in `.env.example` so its default stays "everyone", and the demo deployment never loads the adapter that reads it — so the constraint's purpose, an unchanged deployment, holds. The controller rules on this one; if the answer is no, delete the `optionalEnv` call from `surfaces/memory/src/index.ts`, hard-code `ANY_USER`, drop the `.env.example` block from Task 3 Step 13, and drop the third test of `surfaces/memory/src/index.test.ts`.

19. **The health endpoint does not grow a `surfaces` block, and the memory adapter's README says what to read instead.** Spec section 6 suggests reading the memory surface's posted cards from the health endpoint's `surfaces.memory` snapshot. `/healthz` is unauthenticated and outside the audit trail, and `domain/health.ts` says in as many words that it "exposes counts and timestamps only — never an approval summary, a payload, or a file name". A card carries the approval's summary and its redacted payload preview, so putting one there would break that invariant to make a developer's local run more convenient. The README points at the `approvals` and `tool_effects` rows and the process's own log instead, which show the same thing and are inside the audit trail.

**One place the spec describes a file that does not exist, and the plan follows the code.** Spec section 9 and the brief both mention `harness/core-tools/src/app/record-surface.test.ts`. There is no such file: the recorder is `app/record-surface.ts` and the test that reads it is `app/surface.test.ts`. Task 5 adds its assertions there.

---

## File structure

Paths are relative to the repository root. The workspace grows from ten packages to thirteen, and gains one top-level directory, `surfaces/`.

### `@harness/shared` — the two shared primitives (Task 1)

| Old | New |
|---|---|
| `harness/shared/src/errors.ts` | same path; `SurfaceError` beside `ToolError` |
| — | `harness/shared/src/ids.ts` (`CONVERSATION_ID_PATTERN`, `SURFACE_NAME_PATTERN`) + `ids.test.ts` |
| `harness/shared/src/index.ts` | same path; both new exports |

### `@harness/surface-api` — the contract (Task 1)

| New file | Responsibility |
|---|---|
| `harness/surface-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md` | the package |
| `harness/surface-api/src/types.ts` | the leaf: `Conversation`, `MessageRef`, `Card`, `CardLine`, `NotePart`, `CardAction`, `Form`, `FormField`, `ActionEvent`, `FormEvent`, `SurfaceCapabilities`, `SurfaceSession`, `SurfaceDeps`, `Surface` |
| `harness/surface-api/src/surface.ts` | `defineSurface`, `allowsUser`, `parseAllowedUsers`, `ANY_USER` |
| `harness/surface-api/src/models.ts` | the zod payload shapes the outbox crosses, and the two patterns re-exported |
| `harness/surface-api/src/testing.ts` | `MemorySurface` — the `./testing` subpath |
| `harness/surface-api/src/index.ts` | the public API |
| `harness/surface-api/src/surface.test.ts`, `models.test.ts`, `memory.test.ts` | the tests |

### `@harness/db` — neutral addressing (Task 2)

| Old | New |
|---|---|
| `harness/db/src/domain/schema.ts` (`slackChannel`, `slackTs`) | same path; `surface`, `conversationId`, `messageRef` |
| — | `harness/db/drizzle/0009_surface_addressing.sql` (generated, then hand-edited) |
| — | `harness/db/drizzle/meta/0009_snapshot.json`, `meta/_journal.json` (generated) |
| — | `harness/db/src/domain/legacy-0008.test-helpers.ts`, `migration-0009.test.ts` |
| `harness/approvals/src/{domain/poller.ts, domain/decisions.ts, testing.ts}` + their tests | same paths; the three new columns, still Slack-only in behaviour |

### `surfaces/slack` and `surfaces/memory` — the adapters (Task 3)

| Old | New |
|---|---|
| `harness/approvals/src/domain/render/blocks.ts` | **split** → `surfaces/slack/src/render/blocks.ts` (Block Kit from a `Card`) + the plain-text half stays behind for Task 4's `harness/approvals/src/domain/cards.ts` |
| `harness/approvals/src/domain/render/modal.ts` | `surfaces/slack/src/render/modal.ts` (a Slack view from a `Form`) |
| `harness/approvals/src/domain/slack/types.ts` | `surfaces/slack/src/transport/types.ts` |
| `harness/approvals/src/domain/slack/web-client.ts` | `surfaces/slack/src/transport/web-client.ts` |
| `harness/approvals/src/domain/slack/fake.ts` | `surfaces/slack/src/transport/fake.ts` |
| — | `surfaces/slack/src/transport/bolt.ts` (today's `main.ts:69-121`) |
| — | `surfaces/slack/src/session.ts`, `src/config.ts`, `src/index.ts`, `src/testing.ts` |
| — | `surfaces/memory/src/index.ts` and its package files |
| `harness/core-tools/src/app/record-surface.ts` | same path; `SOURCE_ROOTS` gains `'surfaces'` |

### `@harness/approvals` — the host (Task 4)

| Old | New |
|---|---|
| `harness/approvals/src/domain/render/*` | **deleted**; the plain-text renderers land in `harness/approvals/src/domain/cards.ts` |
| `harness/approvals/src/domain/slack/*` | **deleted** |
| — | `harness/approvals/src/domain/surfaces/registry.ts` (`loadSurfaces`) |
| — | `harness/approvals/src/domain/handlers.ts` (was `domain/slack/handlers.ts`, minus `parseAllowedUsers`) |
| `harness/approvals/src/domain/{poller,decisions,sinks,runner}.ts` | same paths, typed on `SurfaceSession` |
| `harness/approvals/src/app/{main,child-env}.ts` | same paths |
| — | `harness/approvals/src/host-vocabulary.test.ts`, `src/domain/surfaces/dual-surface.test.ts` |
| `harness/approvals/src/{index,testing}.ts` | same paths, rewritten |

### Kernel and packs (Task 5)

| Old | New |
|---|---|
| `harness/core-tools/src/domain/session/repository.ts` | same path; `surface_message`, neutral payload and summary |
| `harness/core-tools/src/domain/files/release.ts` | same path; `surface_file`, neutral payload, `surface` argument |
| `harness/core-tools/src/tools/harness.ts` | same path; neutral description, `CONVERSATION_ID_PATTERN`, `surface` |
| `packs/healthcare/src/tools/forms.ts` | same path; the same three changes |
| `harness/pack-api/src/{models or index}.ts` | `CONVERSATION_ID_PATTERN`, `SURFACE_NAME_PATTERN` re-exported |
| `harness/core-tools/src/kernel-vocabulary.test.ts` | same path; the messaging regex and its roots |
| `harness/core-tools/src/app/surface.test.ts` | same path; the four-places assertions |
| `docs/architecture/tool-surface.json` | re-recorded |

### Configuration and documentation (Task 6)

`.env.example`, `clients/demo-practice/.env.example`, `harness/compose/docker-compose.yml`, `harness/compose/node.Dockerfile`, `docs/architecture/compose-surface.yaml`, `docs/architecture/graph.svg`, `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`, `harness/approvals/README.md`, `harness/surface-api/README.md`, `surfaces/slack/README.md`, `surfaces/memory/README.md`.

---

## Task dependency

Strictly sequential. Nothing can be reordered:

- **Task 1** (contract) first: Tasks 3 and 4 compile against `SurfaceSession`, `Card` and `MemorySurface`, and Task 2 needs nothing from it but must not run after code that depends on both.
- **Task 2** (migration) before Task 3: the adapters are written against a host whose rows already carry `surface` / `conversation_id` / `message_ref`, and a migration landing after the host rewrite would leave one commit where the poller writes a column that does not exist.
- **Task 3** (adapters) before Task 4: the host loads `@harness/surface-slack` by name and its tests drive `@harness/surface-memory`.
- **Task 4** (host) before Task 5: the generic sinks have to exist before the kernel stages effects addressed to them.
- **Task 5** (kernel and packs) before Task 6: the documents describe the finished vocabulary, and the tool surface has to be settled before the runbook quotes it.

Tasks 1, 2, 3 and 4 leave `docs/architecture/tool-surface.json` byte-identical. **Task 2 keeps the host green by renaming its three column references in place** — `slackChannel` → `conversationId`, `slackTs` → `messageRef`, plus `surface: 'slack'` on the claim — and nothing else about the host moves until Task 4. **Task 4 keeps the kernel green by having the host register its generic sinks under both the new names and the two old ones**, so a `slack_message` staged by the not-yet-changed kernel still dispatches; Task 5 deletes the two aliases in the same commit that stops staging them. No gate is ever parked and no task ends red.

---
## Tasks

### Task 1: `@harness/surface-api` — the contract, `SurfaceError`, and the memory surface

Nothing can move until there is a word for what a messaging surface is. This task adds two
primitives to `@harness/shared` (`SurfaceError`, and the two id patterns both contracts need),
then a new leaf package that declares the whole contract: the neutral card and form models, the
session interface an adapter implements, `defineSurface`, and `MemorySurface` — the in-process
session that `@harness/surface-memory` wraps in Task 3 and that every host test in Task 4 runs
against.

Nothing outside these two packages changes. `docs/architecture/tool-surface.json` is untouched.

**Files:**
- Modify: `harness/shared/src/errors.ts`, `harness/shared/src/errors.test.ts`, `harness/shared/src/index.ts`
- Create: `harness/shared/src/ids.ts`, `harness/shared/src/ids.test.ts`
- Create: `harness/surface-api/package.json`, `tsconfig.json`, `vitest.config.ts`, `README.md`
- Create: `harness/surface-api/src/types.ts`, `surface.ts`, `models.ts`, `testing.ts`, `index.ts`
- Create: `harness/surface-api/src/surface.test.ts`, `models.test.ts`, `memory.test.ts`
- Modify: `.dependency-cruiser.cjs` (one `PACKAGES` row, one `WORKSPACE_DIRS` entry, one global rule)

**Interfaces:**
- Consumes: `ConfigError` and the `EnvSource` / `Logger` types from `@harness/shared`; zod v4.
- Produces:

  ```ts
  // @harness/shared — errors.ts
  class SurfaceError extends Error {}

  // @harness/shared — ids.ts
  const CONVERSATION_ID_PATTERN: RegExp   // /^[A-Za-z0-9][A-Za-z0-9:_@.\-]{0,127}$/
  const SURFACE_NAME_PATTERN: RegExp      // /^[a-z][a-z0-9-]*$/

  // @harness/surface-api — types.ts
  interface Conversation { surface: string; id: string }
  interface MessageRef { surface: string; conversation: string; id: string }
  type CardIcon = 'approved' | 'declined'
  type NotePart = { text: string } | { code: string } | { at: Date } | { user: string } | { icon: CardIcon }
  type CardLine = { text: string } | { label: string; value: string } | { code: string } | { note: readonly NotePart[] }
  interface CardAction { id: string; label: string; style: 'primary' | 'danger' | 'default'; value: string }
  interface Card {
    id: string; title: string; subtitle?: string; notice: string;
    body: readonly CardLine[]; actions: readonly CardAction[]; footer?: readonly NotePart[];
  }
  interface FormField { id: string; label: string; multiline: boolean; optional: boolean; maxLength?: number; placeholder?: string }
  interface Form { id: string; title: string; submitLabel: string; cancelLabel: string; intro?: string; fields: readonly FormField[]; metadata: string }
  interface ActionEvent { surface: string; userId: string; conversation: string; message: MessageRef | null; actionId: string; value: string; trigger: string | null }
  interface FormEvent { surface: string; userId: string; conversation: string; formId: string; metadata: string; values: Record<string, string> }
  interface SurfaceCapabilities { forms: boolean; privateReply: boolean; update: boolean }
  interface UploadRequest { path: string; filename: string; comment?: string; replyTo?: MessageRef }
  interface SurfaceSession {
    readonly name: string;
    readonly capabilities: SurfaceCapabilities;
    readonly allowedUsers: ReadonlySet<string>;
    readonly defaultConversation: string;
    mention(userId: string): string;
    postCard(conversation: string, card: Card): Promise<MessageRef>;
    updateCard(ref: MessageRef, card: Card): Promise<void>;
    postText(conversation: string, text: string, opts?: { replyTo?: MessageRef }): Promise<MessageRef>;
    postPrivate(conversation: string, userId: string, text: string): Promise<void>;
    uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }>;
    openForm(trigger: string, form: Form): Promise<void>;
    onAction(handler: (event: ActionEvent) => Promise<void>): void;
    onFormSubmit(handler: (event: FormEvent) => Promise<void>): void;
    start(): Promise<void>;
    stop(): Promise<void>;
  }
  interface SurfaceDeps { env: EnvSource; log: Logger; storageDir: string }
  interface Surface { name: string; version: string; secrets: readonly string[]; connect(deps: SurfaceDeps): Promise<SurfaceSession> }

  // @harness/surface-api — surface.ts
  const ANY_USER = '*'
  function defineSurface(surface: Surface): Surface
  function allowsUser(allowedUsers: ReadonlySet<string>, userId: string): boolean
  function parseAllowedUsers(raw: string | undefined): ReadonlySet<string>

  // @harness/surface-api — models.ts
  const SurfaceMessagePayloadShape: z.ZodObject   // { surface?, conversation?, channel?, text, reply_to? }
  const SurfaceFilePayloadShape: z.ZodObject      // { surface?, conversation?, channel?, path, filename, reply_to?, file_id? }
  type SurfaceMessagePayload, SurfaceFilePayload

  // @harness/surface-api/testing — testing.ts
  class MemorySurface implements SurfaceSession {
    readonly cards: { ref: MessageRef; card: Card }[]
    readonly texts: { conversation: string; text: string; replyTo: MessageRef | null }[]
    readonly privates: { conversation: string; userId: string; text: string }[]
    readonly uploads: { conversation: string; filename: string; path: string; comment: string | null }[]
    readonly forms: { trigger: string; form: Form }[]
    started: boolean; stopped: boolean; failWith?: string;
    constructor(opts?: MemorySurfaceOptions)
    press(actionId: string, value: string, userId: string, over?: Partial<ActionEvent>): Promise<void>
    submit(formId: string, values: Record<string, string>, userId: string, over?: Partial<FormEvent>): Promise<void>
  }
  interface MemorySurfaceOptions { name?: string; conversation?: string; allowedUsers?: ReadonlySet<string>; capabilities?: Partial<SurfaceCapabilities> }
  ```

**What does not change.** Every tool name, every JSON Schema, every environment variable, every
migration, every other package.

---

- [ ] **Step 1: Write the failing tests for the two shared primitives**

Append to `harness/shared/src/errors.test.ts`:

```ts
describe('SurfaceError', () => {
  it('is its own name, so a catch can tell it from a ToolError', () => {
    const err = new SurfaceError('slack: "nope" is not a conversation id');
    expect(err.name).toBe('SurfaceError');
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(ToolError);
  });
});
```

Add `SurfaceError` to that file's existing import from `./errors.js`.

Create `harness/shared/src/ids.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from './ids.js';

describe('CONVERSATION_ID_PATTERN', () => {
  it('accepts a conversation id from each surface the harness expects to meet', () => {
    for (const id of [
      'C0DEMO', // Slack channel
      'D01AB2CD3EF', // Slack direct message
      '19:meeting_NzJhMjkx@thread.v2', // Microsoft Teams
      '1001234567890', // Telegram, presented without its sign
      'memory', // the in-process surface
      'team.support-1',
    ]) {
      expect(CONVERSATION_ID_PATTERN.test(id), id).toBe(true);
    }
  });

  it('refuses anything that is not a bare identifier', () => {
    for (const id of ['', ' ', '-1001234567890', '#general', 'a b', 'a/b', `x${'y'.repeat(128)}`]) {
      expect(CONVERSATION_ID_PATTERN.test(id), id).toBe(false);
    }
  });
});

describe('SURFACE_NAME_PATTERN', () => {
  it('accepts a lowercase adapter name and refuses anything else', () => {
    expect(SURFACE_NAME_PATTERN.test('slack')).toBe(true);
    expect(SURFACE_NAME_PATTERN.test('ms-teams')).toBe(true);
    expect(SURFACE_NAME_PATTERN.test('Slack')).toBe(false);
    expect(SURFACE_NAME_PATTERN.test('1slack')).toBe(false);
    expect(SURFACE_NAME_PATTERN.test('slack_app')).toBe(false);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @harness/shared test`
Expected: FAIL — `Cannot find module './ids.js'`, and `SurfaceError is not exported`.

- [ ] **Step 3: Write the two shared primitives**

Append to `harness/shared/src/errors.ts`:

```ts
/**
 * A messaging surface could not do what was asked: a conversation id that is not that surface's
 * shape, a capability it does not have, or a transport that refused.
 *
 * Deliberately **not** a `ToolError`. It is raised below the tool layer, by an adapter, and it
 * never reaches an agent by itself — the host decides what to do with it, which is to record it
 * on the effect row or to say it in the thread. Both of those are plaintext, so the message
 * names the surface and the operation and never a path, a token or a payload value.
 */
export class SurfaceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SurfaceError';
  }
}
```

Create `harness/shared/src/ids.ts`:

```ts
/**
 * The two identifier shapes both contracts need, in the one package below both of them.
 *
 * `@harness/pack-api` re-exports `CONVERSATION_ID_PATTERN` so a pack's tool schema can validate
 * a `channel` argument, and `@harness/surface-api` re-exports both so an adapter and the host
 * validate the same strings. Neither contract may import the other — `pack-api-imports-only-shared`
 * in `.dependency-cruiser.cjs` says so — and a regular expression describing the shape of a
 * string is not domain knowledge, so this is the one place it can live without being copied.
 */

/**
 * A conversation id, whatever surface it belongs to: a Slack channel (`C0DEMO`), a Teams thread
 * (`19:…@thread.v2`), a Telegram chat id, the memory surface's `memory`.
 *
 * Deliberately a *shape*, not a *validation*: the kernel cannot know a surface's id format, so
 * this only keeps a control character, a space or a 200-character blob out of a plaintext
 * column, and the adapter rejects an id that is not its own with a `SurfaceError` at dispatch.
 * An adapter whose native ids do not fit — Telegram's group ids are negative — presents them in
 * a shape that does and converts on the way out; that conversion is the adapter's business.
 */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_@.\-]{0,127}$/;

/** An adapter's name: lowercase, the same rule a pack's name follows. Stored in `approvals.surface`. */
export const SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
```

In `harness/shared/src/index.ts`, add `SurfaceError` to the `./errors.js` export list (alphabetical:
`ConfigError, ModelOutputError, SurfaceError, ToolError, describeError`), add a line
`export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from './ids.js';` after the errors
line, and change "Seven modules of pure helpers" in the file's doc comment to "Eight modules of
pure helpers".

- [ ] **Step 4: Run them and watch them pass**

Run: `pnpm --filter @harness/shared test`
Expected: PASS, every file.

- [ ] **Step 5: Create the contract package**

Create `harness/surface-api/package.json`:

```json
{
  "name": "@harness/surface-api",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*",
    "zod": "^4.6.5"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `harness/surface-api/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.base.json",
  "include": ["src", "vitest.config.ts"]
}
```

Create `harness/surface-api/vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({});
```

Create `harness/surface-api/README.md`:

```markdown
# @harness/surface-api

The contract between the approvals host and a messaging surface. A surface is Slack today,
Telegram or Microsoft Teams tomorrow; the host is written against this package and never
against one of them.

It depends on `@harness/shared` and zod and on nothing else in the workspace, which is what lets
the host load an adapter by name at runtime instead of importing it at build time.

| Module | Holds |
| --- | --- |
| `src/types.ts` | every declaration: `Card`, `Form`, `MessageRef`, `SurfaceSession`, `Surface` |
| `src/surface.ts` | `defineSurface`, `allowsUser`, `parseAllowedUsers` |
| `src/models.ts` | the zod shapes of the two outbox payloads, and the two id patterns |
| `src/testing.ts` | `MemorySurface`, reached as `@harness/surface-api/testing` |

`CONTRIBUTING.md`, "Adding a surface", is the worked how-to.
```

Run: `pnpm install`
Expected: `+1` workspace project, `pnpm-lock.yaml` updated.

- [ ] **Step 6: Write the contract's declarations**

Create `harness/surface-api/src/types.ts`:

```ts
import type { EnvSource, Logger } from '@harness/shared';

/**
 * Every declaration of the surface contract, in one leaf module.
 *
 * The same arrangement `@harness/pack-api` uses, and for the same reason: `surface.ts`,
 * `models.ts` and `testing.ts` re-export from here and keep their own runtime functions, so no
 * two modules of this package can end up importing each other. It imports types from
 * `@harness/shared` and nothing else.
 */

/** Where a message can go on a named surface. What a row or an outbox payload stores. */
export interface Conversation {
  surface: string;
  /** The conversation's id in that surface's own shape. */
  id: string;
}

/** One message, addressable again later: to edit it, or to reply under it. */
export interface MessageRef {
  surface: string;
  conversation: string;
  /** The surface's own id for the message: a Slack `ts`, a Teams activity id, a Telegram message id. */
  id: string;
}

/** The two outcomes a card reports. An adapter picks its own glyph. */
export type CardIcon = 'approved' | 'declined';

/**
 * One piece of a rich line.
 *
 * Small on purpose: every surface can render all five. Slack turns `{ at }` into a `<!date>`
 * token that reads in the viewer's own timezone and `{ user }` into a mention; a surface with
 * neither prints an ISO timestamp and an `@id`. A host never formats a date or spells a
 * mention itself, because a host that did would have picked a surface.
 */
export type NotePart =
  | { text: string }
  | { code: string }
  | { at: Date }
  | { user: string }
  | { icon: CardIcon };

/**
 * One line of a card's body. Each renders as its own block.
 *
 * `{ note }` is the dimmer line a surface renders smaller — Slack's `context` block — and is the
 * only line that carries rich parts. A note that has to span several visual lines carries
 * `{ text: '\n' }` parts between them; the host builds those, so the adapter joins nothing.
 */
export type CardLine =
  | { text: string }
  | { label: string; value: string }
  | { code: string }
  | { note: readonly NotePart[] };

/** One button. `id` is what comes back on the `ActionEvent`; `value` is what it carries. */
export interface CardAction {
  id: string;
  label: string;
  style: 'primary' | 'danger' | 'default';
  value: string;
}

/**
 * A message a human acts on.
 *
 * Neutral by construction: no Block Kit, no Adaptive Card, no inline keyboard. An adapter
 * renders it; the host never sees a rendered shape.
 */
export interface Card {
  /**
   * A stable identifier for this *kind* of card, not for one instance of it. An adapter that
   * needs to name the card's parts derives the names from it — the Slack adapter's actions
   * block is `` `${card.id}_actions` `` — so two cards of different kinds never collide.
   */
  id: string;
  title: string;
  /** One line of plain text under the title, in the same block. */
  subtitle?: string;
  /**
   * One line of plain text for wherever the card itself cannot go: a notification preview, a
   * surface that renders no rich content. Required, because it is the only thing some readers
   * ever see — and because a posted card and its edited replacement usually want to say
   * different things.
   */
  notice: string;
  body: readonly CardLine[];
  /** Empty for a card that has been acted on already. */
  actions: readonly CardAction[];
  footer?: readonly NotePart[];
}

export interface FormField {
  /** Stable; it is the key this field's answer comes back under on the `FormEvent`. */
  id: string;
  label: string;
  multiline: boolean;
  optional: boolean;
  maxLength?: number;
  placeholder?: string;
}

/** A short dialogue a surface may be able to open. `metadata` is opaque to the adapter. */
export interface Form {
  /** Stable; it is what comes back as `FormEvent.formId`. */
  id: string;
  title: string;
  submitLabel: string;
  cancelLabel: string;
  /** A sentence above the fields, saying what submitting does. */
  intro?: string;
  fields: readonly FormField[];
  /**
   * The host's own string, carried out with the form and handed back on submission untouched.
   * A surface stores it wherever it can (Slack: `private_metadata`) and never reads it.
   */
  metadata: string;
}

/** A human pressed a button. */
export interface ActionEvent {
  surface: string;
  userId: string;
  conversation: string;
  /** The message the button was on, when the surface says which. */
  message: MessageRef | null;
  actionId: string;
  value: string;
  /** An opaque handle this surface will accept back in `openForm`, for as long as it lasts. */
  trigger: string | null;
}

/** A human submitted a form. `values` is keyed by `FormField.id`. */
export interface FormEvent {
  surface: string;
  userId: string;
  conversation: string;
  formId: string;
  metadata: string;
  values: Record<string, string>;
}

/**
 * What this surface can do beyond posting.
 *
 * The host reads these rather than trying and catching: a card offered on a surface with no
 * `forms` simply has no Edit button, which is honest, and needs no fallback protocol.
 */
export interface SurfaceCapabilities {
  forms: boolean;
  privateReply: boolean;
  update: boolean;
}

export interface UploadRequest {
  /** An absolute path the host has already checked. The adapter reads it and sends the bytes. */
  path: string;
  filename: string;
  comment?: string;
  replyTo?: MessageRef;
}

/**
 * A connected surface.
 *
 * Every method that talks to the outside world rejects with a `SurfaceError` whose message is
 * safe to write into a plaintext column: it names the surface and what failed, never a path, a
 * token or a payload value.
 */
export interface SurfaceSession {
  /** This adapter's name, as `HARNESS_SURFACES` named it and as `approvals.surface` stores it. */
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  /**
   * Who may decide anything here, in this surface's own user ids. **Empty means nobody**, which
   * is the fail-closed rule, not "everybody". The single member `ANY_USER` means everybody and
   * is for a surface with no transport only. Read it through `allowsUser`, never `.has`.
   */
  readonly allowedUsers: ReadonlySet<string>;
  /** Where this surface posts when nobody names a conversation. */
  readonly defaultConversation: string;
  /** How this surface spells a mention of a user inside plain text. */
  mention(userId: string): string;
  postCard(conversation: string, card: Card): Promise<MessageRef>;
  updateCard(ref: MessageRef, card: Card): Promise<void>;
  postText(conversation: string, text: string, opts?: { replyTo?: MessageRef }): Promise<MessageRef>;
  postPrivate(conversation: string, userId: string, text: string): Promise<void>;
  uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }>;
  /** Rejects with a `SurfaceError` when `capabilities.forms` is false. */
  openForm(trigger: string, form: Form): Promise<void>;
  /** One handler for every button on this surface. Replaces any previous one. */
  onAction(handler: (event: ActionEvent) => Promise<void>): void;
  /** One handler for every form submitted on this surface. Replaces any previous one. */
  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * What an adapter is handed when it connects.
 *
 * `env` is the only environment an adapter may read — never the ambient one — for the same
 * reason a pack reads `deps.env`: whoever builds the bag decides what the adapter can see, so a
 * test suite cannot open a real socket because the machine running it has a filled-in `.env`.
 */
export interface SurfaceDeps {
  env: EnvSource;
  log: Logger;
  /** The root of the file store. An adapter that stages nothing may ignore it. */
  storageDir: string;
}

/** What a `@harness/surface-*` package exports as `surface`. */
export interface Surface {
  /** Lowercase, stable. `HARNESS_SURFACES` orders these and the first one is the primary. */
  name: string;
  version: string;
  /**
   * The environment variable names this adapter reads that are credentials. The host strips the
   * union of every loaded surface's list from the environment of the core-tools child it
   * spawns, so the allowlist there names no surface.
   */
  secrets: readonly string[];
  connect(deps: SurfaceDeps): Promise<SurfaceSession>;
}
```

- [ ] **Step 7: Write the failing `defineSurface` test**

Create `harness/surface-api/src/surface.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { ANY_USER, allowsUser, defineSurface, parseAllowedUsers } from './surface.js';
import type { Surface } from './types.js';

const stub: Surface = {
  name: 'demo',
  version: '0.1.0',
  secrets: ['DEMO_TOKEN'],
  connect: () => Promise.reject(new Error('not connected in this test')),
};

describe('defineSurface', () => {
  it('returns the surface unchanged when it is well formed', () => {
    expect(defineSurface(stub)).toBe(stub);
  });

  it('refuses a name that is not a lowercase identifier, because it is a column value', () => {
    expect(() => defineSurface({ ...stub, name: 'Slack' })).toThrow(ConfigError);
    expect(() => defineSurface({ ...stub, name: 'Slack' })).toThrow(/surface name "Slack"/);
  });

  it('refuses a surface with no version', () => {
    expect(() => defineSurface({ ...stub, version: '  ' })).toThrow(/has no version/);
  });

  it('refuses a secret that is not an environment variable name, and a repeated one', () => {
    expect(() => defineSurface({ ...stub, secrets: ['demo_token'] })).toThrow(/"demo_token"/);
    expect(() => defineSurface({ ...stub, secrets: ['A_TOKEN', 'A_TOKEN'] })).toThrow(/twice/);
  });
});

describe('parseAllowedUsers', () => {
  it('splits, trims and drops the empties', () => {
    expect([...parseAllowedUsers(' U012, U345 ,,U678 ')]).toEqual(['U012', 'U345', 'U678']);
  });

  it('turns nothing into the empty set, which is the fail-closed one', () => {
    expect(parseAllowedUsers(undefined).size).toBe(0);
    expect(parseAllowedUsers('').size).toBe(0);
    expect(parseAllowedUsers('  ,  ').size).toBe(0);
  });
});

describe('allowsUser', () => {
  it('fails closed on an empty allowlist, even for a wildcard that is not there', () => {
    expect(allowsUser(new Set(), 'U012')).toBe(false);
  });

  it('allows a listed user and refuses everyone else', () => {
    const allowed = parseAllowedUsers('U012,U345');
    expect(allowsUser(allowed, 'U012')).toBe(true);
    expect(allowsUser(allowed, 'U999')).toBe(false);
  });

  it('allows everyone when the allowlist is the wildcard', () => {
    expect(allowsUser(parseAllowedUsers(ANY_USER), 'anyone-at-all')).toBe(true);
  });
});
```

- [ ] **Step 8: Run it and watch it fail**

Run: `pnpm --filter @harness/surface-api test`
Expected: FAIL — `Failed to resolve import "./surface.js"`.

- [ ] **Step 9: Write `surface.ts`**

Create `harness/surface-api/src/surface.ts`:

```ts
import { ConfigError, SURFACE_NAME_PATTERN } from '@harness/shared';
import type { Surface } from './types.js';

export type { Surface, SurfaceDeps, SurfaceSession } from './types.js';

/** An environment variable name, which is what every entry of `Surface.secrets` has to be. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/**
 * The one allowlist member that means "everybody".
 *
 * Only a surface with no transport may use it — the memory adapter does, so a developer running
 * the host locally is not asked to invent a user id. On a real surface an allowlist is the whole
 * authorisation story and a wildcard there would be a deployment anyone in the workspace can
 * approve from.
 */
export const ANY_USER = '*';

/**
 * Declare a messaging surface. Identity at runtime, plus the checks that turn a typo into a
 * startup failure naming the adapter rather than an approval card nobody can answer.
 */
export function defineSurface(surface: Surface): Surface {
  if (!SURFACE_NAME_PATTERN.test(surface.name)) {
    throw new ConfigError(`surface name "${surface.name}" must be lowercase letters, digits and hyphens`);
  }
  if (surface.version.trim() === '') throw new ConfigError(`surface "${surface.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of surface.secrets) {
    // Every entry is subtracted from the environment of a child process, by name. A lowercase
    // or misspelled entry subtracts nothing and the credential travels, which is the failure
    // this check exists to make loud.
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `surface "${surface.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`surface "${surface.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return surface;
}

/**
 * Parse an allowlist variable: comma-separated user ids, trimmed, empties dropped.
 *
 * An adapter reads its own variable — `SLACK_ALLOWED_USERS`, `MEMORY_ALLOWED_USERS` — and passes
 * the string here, so the parsing and the fail-closed meaning of an empty result are written
 * once and every adapter behaves the same way.
 */
export function parseAllowedUsers(raw: string | undefined): ReadonlySet<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id !== ''),
  );
}

/**
 * Whether this user may act on this surface. The host calls this and never `allowedUsers.has`,
 * so the empty-means-nobody rule and the wildcard live in one place.
 */
export function allowsUser(allowedUsers: ReadonlySet<string>, userId: string): boolean {
  if (allowedUsers.size === 0) return false;
  return allowedUsers.has(ANY_USER) || allowedUsers.has(userId);
}
```

- [ ] **Step 10: Run it and watch it pass**

Run: `pnpm --filter @harness/surface-api test`
Expected: PASS, 9 tests.

- [ ] **Step 11: Write the outbox payload shapes and their test**

Create `harness/surface-api/src/models.ts`:

```ts
import * as z from 'zod/v4';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';

export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';

/**
 * The two payload shapes that cross an untyped boundary.
 *
 * Everything else in this contract is checked by the compiler: the host builds a `Card` and
 * hands it to an adapter in the same process. These two are different — they come out of
 * `tool_effects.payload_encrypted`, written by a kernel that may be a version behind — so they
 * are parsed, and they are parsed here rather than in the host because the addressing they carry
 * is this contract's, not the host's.
 *
 * `surface` and `conversation` are nullable as well as optional: a staging tool writes an
 * explicit null when the caller named neither, and that means "the default", not "invalid".
 * `channel` is the same field under its pre-0009 name — rows staged before the upgrade are still
 * in the outbox and still have to deliver.
 */
const surfaceName = z
  .string()
  .regex(SURFACE_NAME_PATTERN, 'surface must be a loaded surface name')
  .nullable()
  .optional();

const conversation = z
  .string()
  .regex(CONVERSATION_ID_PATTERN, 'conversation must be a conversation id')
  .nullable()
  .optional();

export const SurfaceMessagePayloadShape = z.object({
  surface: surfaceName,
  conversation,
  /** Pre-0009 rows carry the conversation here. */
  channel: conversation,
  text: z.string().min(1).max(3000),
  /** A message id on the same surface, to reply under rather than beside. */
  reply_to: z.string().min(1).optional(),
});

export const SurfaceFilePayloadShape = z.object({
  surface: surfaceName,
  conversation,
  channel: conversation,
  path: z.string().min(1),
  filename: z.string().min(1),
  reply_to: z.string().min(1).optional(),
  file_id: z.string().optional(),
});

export type SurfaceMessagePayload = z.infer<typeof SurfaceMessagePayloadShape>;
export type SurfaceFilePayload = z.infer<typeof SurfaceFilePayloadShape>;
```

Create `harness/surface-api/src/models.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SurfaceFilePayloadShape, SurfaceMessagePayloadShape } from './models.js';

describe('SurfaceMessagePayloadShape', () => {
  it('accepts what the kernel stages today', () => {
    const parsed = SurfaceMessagePayloadShape.parse({ text: 'two expire soon', conversation: 'C0DEMO', surface: 'slack' });
    expect(parsed).toMatchObject({ text: 'two expire soon', conversation: 'C0DEMO', surface: 'slack' });
  });

  it('accepts an explicit null for both addressing fields, which means "the default"', () => {
    expect(SurfaceMessagePayloadShape.parse({ text: 'hello', conversation: null, surface: null }).conversation).toBeNull();
  });

  it('accepts a row staged before migration 0009, which carries the conversation as `channel`', () => {
    expect(SurfaceMessagePayloadShape.parse({ text: 'hello', channel: 'C0OLD' }).channel).toBe('C0OLD');
  });

  it('refuses a conversation id that is not a bare identifier, and text over the cap', () => {
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'hi', conversation: 'no spaces here' }).success).toBe(false);
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'x'.repeat(3001) }).success).toBe(false);
  });

  it('refuses a surface name that is not a lowercase identifier', () => {
    expect(SurfaceMessagePayloadShape.safeParse({ text: 'hi', surface: 'Slack' }).success).toBe(false);
  });
});

describe('SurfaceFilePayloadShape', () => {
  it('accepts a staged release', () => {
    const parsed = SurfaceFilePayloadShape.parse({
      path: '/srv/harness-storage/out/roster/a.csv',
      filename: 'a.csv',
      file_id: 'roster/a.csv',
      surface: 'slack',
    });
    expect(parsed.filename).toBe('a.csv');
  });

  it('refuses a payload with no path', () => {
    expect(SurfaceFilePayloadShape.safeParse({ filename: 'a.csv' }).success).toBe(false);
  });
});
```

- [ ] **Step 12: Write the failing memory-surface test**

Create `harness/surface-api/src/memory.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import { MemorySurface } from './testing.js';
import type { ActionEvent, Card, Form, FormEvent } from './types.js';

const card = (over: Partial<Card> = {}): Card => ({
  id: 'demo_card',
  title: 'Approval needed',
  subtitle: 'forms_release (external) requested by hermes',
  notice: 'Approval needed: forms_release (external) requested by hermes',
  body: [{ code: '{ "a": 1 }' }],
  actions: [{ id: 'demo_approve', label: 'Approve', style: 'primary', value: 'a1' }],
  footer: [{ text: 'Approval ' }, { code: 'a1' }],
  ...over,
});

const form: Form = {
  id: 'demo_form',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  fields: [{ id: 'note', label: 'What should change?', multiline: true, optional: false }],
  metadata: '{"approval_id":"a1"}',
};

describe('MemorySurface', () => {
  it('records a posted card and hands back a reference that names itself', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
    expect(surface.cards).toHaveLength(1);
    expect(surface.cards[0].card.title).toBe('Approval needed');
  });

  it('replaces the card an update names, and refuses one it has never posted', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    await surface.updateCard(ref, card({ actions: [], notice: 'Approval a1 approved' }));
    expect(surface.cards).toHaveLength(1);
    expect(surface.cards[0].card.actions).toEqual([]);
    await expect(surface.updateCard({ ...ref, id: 'm99' }, card())).rejects.toThrow(SurfaceError);
  });

  it('records a reply under the message it replies to', async () => {
    const surface = new MemorySurface();
    const ref = await surface.postCard('memory', card());
    await surface.postText('memory', 'Approval a1 approved by @U012.', { replyTo: ref });
    expect(surface.texts[0]).toMatchObject({ text: 'Approval a1 approved by @U012.', replyTo: ref });
  });

  it('delivers a button press to the registered handler as an ActionEvent', async () => {
    const surface = new MemorySurface();
    const seen: ActionEvent[] = [];
    surface.onAction(async (event) => {
      seen.push(event);
    });
    await surface.postCard('memory', card());
    await surface.press('demo_approve', 'a1', 'U012');
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ surface: 'memory', actionId: 'demo_approve', value: 'a1', userId: 'U012' });
    expect(seen[0].message).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });

  it('delivers a form submission with its metadata and values', async () => {
    const surface = new MemorySurface();
    const seen: FormEvent[] = [];
    surface.onFormSubmit(async (event) => {
      seen.push(event);
    });
    await surface.openForm('t1', form);
    await surface.submit('demo_form', { note: 'Use the Q4 roster.' }, 'U012');
    expect(surface.forms[0]).toMatchObject({ trigger: 't1' });
    expect(seen[0]).toMatchObject({ formId: 'demo_form', metadata: '{"approval_id":"a1"}', values: { note: 'Use the Q4 roster.' } });
  });

  it('refuses to open a form when it was built without the capability', async () => {
    const surface = new MemorySurface({ capabilities: { forms: false } });
    await expect(surface.openForm('t1', form)).rejects.toThrow(/cannot open a form/);
  });

  it('fails every call while failWith is set, the way an unreachable transport does', async () => {
    const surface = new MemorySurface();
    surface.failWith = 'conversation_not_found';
    await expect(surface.postCard('memory', card())).rejects.toThrow('conversation_not_found');
  });

  it('spells a mention the way a surface with no mention syntax can', () => {
    expect(new MemorySurface().mention('U012')).toBe('@U012');
  });
});
```

- [ ] **Step 13: Run it and watch it fail**

Run: `pnpm --filter @harness/surface-api test`
Expected: FAIL — `Failed to resolve import "./testing.js"`.

- [ ] **Step 14: Write `MemorySurface`**

Create `harness/surface-api/src/testing.ts`:

```ts
import { SurfaceError } from '@harness/shared';
import { ANY_USER, parseAllowedUsers } from './surface.js';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageRef,
  SurfaceCapabilities,
  SurfaceSession,
  UploadRequest,
} from './types.js';

export interface MemorySurfaceOptions {
  name?: string;
  conversation?: string;
  allowedUsers?: ReadonlySet<string>;
  capabilities?: Partial<SurfaceCapabilities>;
}

/**
 * A surface that records instead of sending.
 *
 * It is two things at once and deliberately so: the whole of `@harness/surface-memory`, the
 * adapter a developer runs the host with when they have no Slack workspace, and the fake every
 * host test drives. One implementation means the thing the suite proves the host against is the
 * thing that runs. It lives under the `testing` subpath because that is where a package's fakes
 * live in this repository, and `@harness/surface-memory` is a thin wrapper that gives it a name,
 * an allowlist and a `defineSurface` declaration.
 *
 * Message ids count up from `m1`, so an assertion can rely on ordering without a clock.
 */
export class MemorySurface implements SurfaceSession {
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  readonly allowedUsers: ReadonlySet<string>;
  readonly defaultConversation: string;

  readonly cards: { ref: MessageRef; card: Card }[] = [];
  readonly texts: { conversation: string; text: string; replyTo: MessageRef | null }[] = [];
  readonly privates: { conversation: string; userId: string; text: string }[] = [];
  readonly uploads: { conversation: string; filename: string; path: string; comment: string | null }[] = [];
  readonly forms: { trigger: string; form: Form }[] = [];
  started = false;
  stopped = false;
  /** When set, every outbound call rejects with this message, the way an unreachable transport does. */
  failWith?: string;

  private seq = 0;
  private actionHandler: ((event: ActionEvent) => Promise<void>) | null = null;
  private formHandler: ((event: FormEvent) => Promise<void>) | null = null;

  constructor(opts: MemorySurfaceOptions = {}) {
    this.name = opts.name ?? 'memory';
    this.defaultConversation = opts.conversation ?? 'memory';
    this.allowedUsers = opts.allowedUsers ?? parseAllowedUsers(ANY_USER);
    this.capabilities = { forms: true, privateReply: true, update: true, ...opts.capabilities };
  }

  private guard(): void {
    if (this.failWith) throw new SurfaceError(this.failWith);
  }

  private ref(conversation: string): MessageRef {
    this.seq += 1;
    return { surface: this.name, conversation, id: `m${this.seq}` };
  }

  mention(userId: string): string {
    return `@${userId}`;
  }

  async postCard(conversation: string, card: Card): Promise<MessageRef> {
    this.guard();
    const ref = this.ref(conversation);
    this.cards.push({ ref, card });
    return ref;
  }

  async updateCard(ref: MessageRef, card: Card): Promise<void> {
    this.guard();
    const found = this.cards.findIndex((c) => c.ref.id === ref.id && c.ref.conversation === ref.conversation);
    if (found === -1) throw new SurfaceError(`${this.name}: no message "${ref.id}" to update`);
    this.cards[found] = { ref: this.cards[found].ref, card };
  }

  async postText(conversation: string, text: string, opts: { replyTo?: MessageRef } = {}): Promise<MessageRef> {
    this.guard();
    this.texts.push({ conversation, text, replyTo: opts.replyTo ?? null });
    return this.ref(conversation);
  }

  async postPrivate(conversation: string, userId: string, text: string): Promise<void> {
    this.guard();
    if (!this.capabilities.privateReply) throw new SurfaceError(`${this.name}: cannot send a private note`);
    this.privates.push({ conversation, userId, text });
  }

  async uploadFile(conversation: string, file: UploadRequest): Promise<{ filename: string }> {
    this.guard();
    this.uploads.push({ conversation, filename: file.filename, path: file.path, comment: file.comment ?? null });
    return { filename: file.filename };
  }

  async openForm(trigger: string, form: Form): Promise<void> {
    this.guard();
    if (!this.capabilities.forms) throw new SurfaceError(`${this.name}: cannot open a form`);
    this.forms.push({ trigger, form });
  }

  onAction(handler: (event: ActionEvent) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void {
    this.formHandler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  /**
   * A human presses a button. The event names the most recently posted card, which is what a
   * test almost always means; `over` overrides any field for the case where it is not.
   */
  async press(actionId: string, value: string, userId: string, over: Partial<ActionEvent> = {}): Promise<void> {
    if (!this.actionHandler) throw new SurfaceError(`${this.name}: no action handler is registered`);
    const last = this.cards.at(-1) ?? null;
    await this.actionHandler({
      surface: this.name,
      userId,
      conversation: last?.ref.conversation ?? this.defaultConversation,
      message: last?.ref ?? null,
      actionId,
      value,
      trigger: 'memory-trigger',
      ...over,
    });
  }

  /** A human submits a form. `metadata` defaults to the most recently opened form's. */
  async submit(
    formId: string,
    values: Record<string, string>,
    userId: string,
    over: Partial<FormEvent> = {},
  ): Promise<void> {
    if (!this.formHandler) throw new SurfaceError(`${this.name}: no form handler is registered`);
    const last = this.forms.at(-1) ?? null;
    await this.formHandler({
      surface: this.name,
      userId,
      conversation: this.defaultConversation,
      formId,
      metadata: last?.form.metadata ?? '',
      values,
      ...over,
    });
  }
}
```

- [ ] **Step 15: Write the barrel**

Create `harness/surface-api/src/index.ts`:

```ts
/**
 * The contract between the approvals host and a messaging surface.
 *
 * Everything here is either a type an adapter implements, a function it calls, or the shape of
 * something the host hands it. It depends on `@harness/shared` and zod, and on nothing else in
 * the workspace, so an adapter that implements it never has to depend on `@harness/approvals` —
 * which is what lets the host load an adapter by name at runtime instead of importing it at
 * build time. See ARCHITECTURE.md, "Surfaces".
 */
export { ANY_USER, allowsUser, defineSurface, parseAllowedUsers } from './surface.js';
export {
  CONVERSATION_ID_PATTERN,
  SURFACE_NAME_PATTERN,
  SurfaceFilePayloadShape,
  SurfaceMessagePayloadShape,
  type SurfaceFilePayload,
  type SurfaceMessagePayload,
} from './models.js';
export type {
  ActionEvent,
  Card,
  CardAction,
  CardIcon,
  CardLine,
  Conversation,
  Form,
  FormEvent,
  FormField,
  MessageRef,
  NotePart,
  Surface,
  SurfaceCapabilities,
  SurfaceDeps,
  SurfaceSession,
  UploadRequest,
} from './types.js';
```

- [ ] **Step 16: Run the package's suite and watch it pass**

Run: `pnpm --filter @harness/surface-api test`
Expected: PASS, 24 tests across three files.

- [ ] **Step 17: Give the package its architecture rules**

In `.dependency-cruiser.cjs`, add to `PACKAGES` after the `pack-api` row:

```js
  { name: 'surface-api', src: 'harness/surface-api/src', severity: 'error' },
```

add to `WORKSPACE_DIRS` after `'harness/pack-api'`:

```js
  'harness/surface-api',
```

and add to `GLOBAL_RULES`, directly after `pack-api-imports-only-shared`:

```js
  {
    name: 'surface-api-imports-only-shared',
    comment:
      '@harness/surface-api is the contract an adapter implements. It may import @harness/shared and zod, and no other workspace package: a contract that pulled in @harness/approvals would defeat the point of having one, and one that pulled in @harness/pack-api would tie a messaging adapter to the pack contract. The two id patterns both contracts need live in @harness/shared for exactly that reason.',
    severity: 'error',
    from: { path: '^harness/surface-api/src/' },
    to: { path: '^(harness|packs|surfaces|evals|scripts)/', pathNot: ['^harness/surface-api/src/', '^harness/shared/src/'] },
  },
```

Also widen the three existing `to.path` regexes that enumerate the top-level directories, so a
future `surfaces/` import cannot slip past them. In `pack-api-imports-only-shared`,
`a-pack-never-imports-core-tools` and `shared-has-no-workspace-dependencies`, change
`'^(harness|packs|evals|scripts)/'` and `'^(harness|evals|scripts)/'` to include `surfaces`:
`'^(harness|packs|surfaces|evals|scripts)/'` and `'^(harness|surfaces|evals|scripts)/'`.

- [ ] **Step 18: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations
pnpm format:check     # all matched files use Prettier code style
pnpm -r test          # green
pnpm surface:record && git status --porcelain docs/architecture   # no output
```

`pnpm surface:record` needs the docker CLI on PATH; the stack does not have to be running. Its
empty output is the proof this task changed no tool schema and no Compose service.

- [ ] **Step 19: Commit**

```bash
git add harness/shared harness/surface-api .dependency-cruiser.cjs pnpm-lock.yaml
git commit -m "feat(surface-api): add the surface contract, SurfaceError and the memory surface"
```

No trailer of any kind.

---
### Task 2: `@harness/db` — migration `0009_surface_addressing`

The poller's claim protocol is *defined in terms of* `approvals.slack_channel`: a row is claimed
by writing a channel into it and released by writing null back (`poller.ts:59-137`). That is not
a rename, it is a migration, and it has to land before any code is written against a surface.

This task adds `surface`, `conversation_id` and `message_ref` to `approvals`, copies today's Slack
addressing across with `surface = 'slack'`, drops the two Slack columns, renames the two in-flight
sink names on `tool_effects`, and mechanically re-points the host at the new column names so every
gate stays green. **No behaviour changes**: the host still talks to Slack and only to Slack, and
`docs/architecture/tool-surface.json` is untouched.

**Files:**
- Modify: `harness/db/src/domain/schema.ts`
- Create: `harness/db/drizzle/0009_surface_addressing.sql` (generated, then hand-edited)
- Create (generated): `harness/db/drizzle/meta/0009_snapshot.json`; modify `harness/db/drizzle/meta/_journal.json`
- Create: `harness/db/src/domain/legacy-0008.test-helpers.ts`, `harness/db/src/domain/migration-0009.test.ts`
- Modify: `harness/approvals/src/domain/poller.ts`, `domain/decisions.ts`, `src/testing.ts`
- Modify: `harness/approvals/src/domain/poller.test.ts`, `domain/decisions.test.ts`, `domain/slack/handlers.test.ts`

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:

  ```ts
  // @harness/db — the approvals row, as every later task reads it
  approvals.surface: text | null         // 'slack' | 'memory' | …, null until the poller claims the row
  approvals.conversationId: text | null  // the claim marker, and where the card lives
  approvals.messageRef: text | null      // the surface's id for the card message
  // gone: approvals.slackChannel, approvals.slackTs

  // @harness/db — the migration test's fixture
  const LEGACY_0008_DDL: string
  const MIGRATION_DATABASE_0009: string
  function createLegacy0008Database(maintenanceUrl: string): Promise<{ db: Db; close: () => Promise<void> }>
  function dropLegacy0008Database(maintenanceUrl: string): Promise<void>
  ```

**What does not change.** `claimed_at` and its meaning; every other column of `approvals`; every
column of `tool_effects`; every tool schema; every environment variable.

---

- [ ] **Step 1: Write the new columns into `schema.ts`**

In `harness/db/src/domain/schema.ts`, replace the two Slack columns of the `approvals` table:

```ts
    slackChannel: text('slack_channel'),
    slackTs: text('slack_ts'),
```

with:

```ts
    /**
     * The loaded surface this approval's card was posted on: `slack`, `memory`, whatever
     * `HARNESS_SURFACES` names. Null until the poller claims the row, and the only thing that
     * says which adapter a decision arriving from somewhere is allowed to come from.
     */
    surface: text('surface'),
    /**
     * The conversation the card lives in, in that surface's own id shape.
     *
     * Doubles as the poller's claim marker: a poller claims a row by writing this before it
     * posts, guarded on the column still being null, so two pollers can never both post a card
     * for one approval.
     */
    conversationId: text('conversation_id'),
    /** That surface's id for the card message, so a decision can edit it and reply under it. */
    messageRef: text('message_ref'),
```

While the file is open, take Slack out of the two comments that name it for no reason: the
`toolEffects` table comment becomes "Outbox for external side effects (surface messages, file
uploads, emails)." and the `result` column's becomes "What the sink returned on a successful
dispatch (a surface's message id, a remote file id) so an operator can trace the effect to the
thing it made."

- [ ] **Step 2: Generate the migration**

```bash
cd harness/db && pnpm drizzle-kit generate --name surface_addressing
```

Expected: `harness/db/drizzle/0009_surface_addressing.sql` plus `meta/0009_snapshot.json`, and a
tenth entry in `meta/_journal.json`. **Plain `generate`, never `--custom`:** a custom migration is
not reflected in the snapshot, so the next generate re-emits the change and the two diverge.

The generated file is five statements: three `ADD COLUMN` and two `DROP COLUMN`.

- [ ] **Step 3: Rewrite the SQL with the data section**

Open `harness/db/drizzle/0009_surface_addressing.sql`. Keep the generated statements exactly as
drizzle wrote them, put the three `ADD COLUMN`s first and the two `DROP COLUMN`s last if it did
not, and edit the hand-written section in between, so the whole file reads:

```sql
ALTER TABLE "approvals" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN "message_ref" text;--> statement-breakpoint
-- harness:data-section:begin
-- Hand written. Moves today's Slack addressing onto the neutral columns and renames the two
-- sink names that are still in flight.
--
-- `surface = 'slack'` is set only where a card was actually posted: `slack_channel IS NOT NULL`
-- is what "this row reached a surface" has meant since 0000, and it is the same predicate 0007
-- used to backfill `claimed_at`. A row that was never posted keeps three nulls, which is exactly
-- what the poller looks for.
--
-- A row that was claimed but never got a `slack_ts` keeps its `claimed_at` and lands with
-- `conversation_id` set and `message_ref` null — the stale-claim state, so the sweep on the next
-- tick recovers it just as it would have before the upgrade.
UPDATE "approvals"
SET "surface" = 'slack', "conversation_id" = "slack_channel", "message_ref" = "slack_ts"
WHERE "slack_channel" IS NOT NULL;--> statement-breakpoint
-- The outbox holds rows staged by the kernel that was running a minute ago, and the dispatcher
-- looks a sink up by the exact string on the row. Renaming only the rows that can still be sent
-- is deliberate: a `dispatched` or `failed` row is history, and rewriting its sink name would
-- change the record of what actually happened.
--
-- Their payloads are NOT rewritten, because they cannot be: `payload_encrypted` is ciphertext
-- and SQL has no key. The host's surface sinks resolve a payload with no `surface` to the
-- primary surface and read the pre-0009 `channel` key as the conversation, so an in-flight row
-- delivers exactly where it would have. See the plan's decision 6.
UPDATE "tool_effects" SET "sink" = 'surface_message'
WHERE "sink" = 'slack_message' AND "status" IN ('staged', 'dispatching', 'needs_review');--> statement-breakpoint
UPDATE "tool_effects" SET "sink" = 'surface_file'
WHERE "sink" = 'slack_file' AND "status" IN ('staged', 'dispatching', 'needs_review');--> statement-breakpoint
-- harness:data-section:end
ALTER TABLE "approvals" DROP COLUMN "slack_channel";--> statement-breakpoint
ALTER TABLE "approvals" DROP COLUMN "slack_ts";
```

**No down migration.** `drizzle-kit` does not generate one and this plan does not hand-write one:
the reverse would have to invent `slack_channel` back out of rows a second surface may have
written in the meantime. Recovery from a bad 0009 is a database restore, which is what
`docs/runbook.md` already prescribes; Task 6 writes that down.

- [ ] **Step 4: Confirm the generator agrees with the hand edit**

```bash
cd harness/db && pnpm drizzle-kit generate
```

Expected: `No schema changes, nothing to migrate 😴`. If it emits a new file, the hand edit
changed the schema rather than the data: delete the new file and its journal entry and fix the
edit.

- [ ] **Step 5: Write the pre-0009 fixture**

Create `harness/db/src/domain/legacy-0008.test-helpers.ts`:

```ts
import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';

/**
 * The two tables migration 0009 touches, as they stood after 0008.
 *
 * Copied out of `schema.ts` as it was before this task rather than derived from anything, on
 * purpose: this is the *old* shape, and a fixture generated from the current schema would
 * happily agree with a migration that dropped half the data. `tool_effects.run_id` is declared
 * without its foreign key because the `runs` table is not here — 0009 does not touch it, and a
 * fixture that recreated every table would be a second copy of the schema to keep in step.
 */
export const LEGACY_0008_DDL = `
CREATE TABLE "approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"client" text NOT NULL,
	"action" text NOT NULL,
	"payload" jsonb NOT NULL,
	"payload_encrypted" bytea,
	"summary" text NOT NULL,
	"requested_by" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" text,
	"decided_at" timestamp with time zone,
	"decision_note" text,
	"executed_at" timestamp with time zone,
	"expires_at" timestamp with time zone NOT NULL,
	"idempotency_key" text NOT NULL,
	"slack_channel" text,
	"slack_ts" text,
	"claimed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "approvals_idempotency_pending_uq" ON "approvals" USING btree ("idempotency_key") WHERE status = 'pending';
CREATE TABLE "tool_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"run_id" uuid,
	"client" text NOT NULL,
	"tool" text NOT NULL,
	"sink" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"payload_encrypted" bytea NOT NULL,
	"summary" text NOT NULL,
	"status" text DEFAULT 'staged' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone
);
CREATE UNIQUE INDEX "tool_effects_idempotency_uq" ON "tool_effects" USING btree ("idempotency_key");
`;

/**
 * The database this migration test builds and drops. A name of its own, not shared with the
 * 0008 fixture: two scratch databases with one name is a test that passes alone and fails beside
 * its neighbour, whatever `fileParallelism` happens to be set to today.
 */
export const MIGRATION_DATABASE_0009 = `harness_test_migration_0009_${process.pid}`;

/** `maintenanceUrl` with its database swapped for `MIGRATION_DATABASE_0009`, everything else intact. */
export function migration0009DatabaseUrl(maintenanceUrl: string): string {
  const url = new URL(maintenanceUrl);
  url.pathname = `/${MIGRATION_DATABASE_0009}`;
  return url.toString();
}

/**
 * Build a database that looks like the world just after migration 0008, and hand back a handle.
 *
 * `maintenanceUrl` is `TEST_DATABASE_URL`: `CREATE DATABASE` has to be issued from a connection
 * to some *other* database. The drop-first is for the run after a crashed one; `WITH (FORCE)`
 * closes any connection a dead worker left behind. Neither statement may run inside a
 * transaction, which is why they go straight at the pool.
 *
 * The tables land in the new database's own `public` schema, which is the point: 0009's SQL is
 * unqualified and its `public` is this database's, so it replays byte for byte.
 */
export async function createLegacy0008Database(
  maintenanceUrl: string,
): Promise<{ db: Db; close: () => Promise<void> }> {
  const maintenance = createDb(maintenanceUrl);
  try {
    await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${MIGRATION_DATABASE_0009}" WITH (FORCE)`));
    await maintenance.db.execute(sql.raw(`CREATE DATABASE "${MIGRATION_DATABASE_0009}"`));
  } finally {
    await maintenance.close();
  }

  const scratch = createDb(migration0009DatabaseUrl(maintenanceUrl));
  try {
    await scratch.db.execute(sql.raw(LEGACY_0008_DDL));
  } catch (err) {
    await scratch.close();
    throw err;
  }
  return { db: scratch.db, close: scratch.close };
}

/**
 * Drop the scratch database. Safe when it was never created, and safe twice. The caller closes
 * its own pool first or the drop blocks behind it; `WITH (FORCE)` covers the case where it forgot.
 */
export async function dropLegacy0008Database(maintenanceUrl: string): Promise<void> {
  const maintenance = createDb(maintenanceUrl);
  try {
    await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${MIGRATION_DATABASE_0009}" WITH (FORCE)`));
  } finally {
    await maintenance.close();
  }
}
```

- [ ] **Step 6: Write the failing migration test**

Create `harness/db/src/domain/migration-0009.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sql, TransactionRollbackError } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { TEST_DATABASE_URL } from '../testing.js';
import type { Db } from './client.js';
import { createLegacy0008Database, dropLegacy0008Database } from './legacy-0008.test-helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const MIGRATION = path.resolve(here, '../../drizzle/0009_surface_addressing.sql');

let db: Db;
let close: () => Promise<void>;

/**
 * The migration, statement by statement, with drizzle's own breakpoint as the separator and its
 * comment lines stripped. Reading the shipped file rather than a copy is the point: the test
 * fails if someone edits the migration and not the expectations.
 */
function migrationStatements(): string[] {
  return readFileSync(MIGRATION, 'utf8')
    .split('--> statement-breakpoint')
    .map((chunk) =>
      chunk
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('--'))
        .join('\n')
        .trim(),
    )
    .filter((statement) => statement !== '');
}

beforeAll(async () => {
  ({ db, close } = await createLegacy0008Database(TEST_DATABASE_URL));
});

afterAll(async () => {
  await close?.();
  await dropLegacy0008Database(TEST_DATABASE_URL);
});

describe('migration 0009_surface_addressing', () => {
  it('has a hand-written data section, bracketed by the markers this test reads', () => {
    const text = readFileSync(MIGRATION, 'utf8');
    expect(text).toContain('-- harness:data-section:begin');
    expect(text).toContain('-- harness:data-section:end');
    expect(text.indexOf('UPDATE "approvals"')).toBeGreaterThan(text.indexOf('-- harness:data-section:begin'));
    expect(text.indexOf('DROP COLUMN "slack_channel"')).toBeGreaterThan(text.indexOf('-- harness:data-section:end'));
  });

  it('moves the Slack addressing onto the neutral columns and renames the in-flight sinks', async () => {
    try {
      await db.transaction(async (tx) => {
        // Four approvals: one posted and decided, one posted but not yet answered, one claimed
        // whose post never recorded a timestamp, and one nobody has picked up.
        await tx.execute(
          sql.raw(`
        INSERT INTO approvals (id, client, action, payload, summary, requested_by, status, expires_at, idempotency_key, slack_channel, slack_ts, claimed_at) VALUES
          ('11111111-1111-4111-8111-111111111111', 'demo', 'forms_release', '{}'::jsonb, 'released', 'hermes', 'approved', now() + interval '1 day', 'k1', 'C0DEMO', '1789000000.000001', now()),
          ('22222222-2222-4222-8222-222222222222', 'demo', 'forms_release', '{}'::jsonb, 'pending one', 'hermes', 'pending', now() + interval '1 day', 'k2', 'C0DEMO', '1789000000.000002', now()),
          ('33333333-3333-4333-8333-333333333333', 'demo', 'forms_release', '{}'::jsonb, 'claimed, never posted', 'hermes', 'pending', now() + interval '1 day', 'k3', 'C0DEMO', NULL, now() - interval '5 minutes'),
          ('44444444-4444-4444-8444-444444444444', 'demo', 'forms_release', '{}'::jsonb, 'never claimed', 'hermes', 'pending', now() + interval '1 day', 'k4', NULL, NULL, NULL);
        INSERT INTO tool_effects (id, client, tool, sink, idempotency_key, payload_encrypted, summary, status) VALUES
          ('aaaaaaaa-0000-4000-8000-000000000001', 'demo', 'harness_notify', 'slack_message', 'demo:n1', '\\x00'::bytea, 'digest', 'staged'),
          ('aaaaaaaa-0000-4000-8000-000000000002', 'demo', 'forms_release', 'slack_file', 'demo:f1', '\\x00'::bytea, 'release', 'needs_review'),
          ('aaaaaaaa-0000-4000-8000-000000000003', 'demo', 'harness_notify', 'slack_message', 'demo:n2', '\\x00'::bytea, 'already sent', 'dispatched'),
          ('aaaaaaaa-0000-4000-8000-000000000004', 'demo', 'other_tool', 'email', 'demo:e1', '\\x00'::bytea, 'an email', 'staged');
      `),
        );

        for (const statement of migrationStatements()) await tx.execute(sql.raw(statement));

        const one = async (query: string) => Number((await tx.execute(sql.raw(query))).rows[0].n);

        // Every posted row carries its surface, and the row nobody posted carries none.
        expect(await one(`SELECT count(*)::int AS n FROM approvals WHERE surface = 'slack'`)).toBe(3);
        expect(
          await one(`SELECT count(*)::int AS n FROM approvals WHERE surface IS NULL AND conversation_id IS NULL AND message_ref IS NULL`),
        ).toBe(1);

        const decided = (
          await tx.execute(
            sql.raw(`SELECT surface, conversation_id, message_ref FROM approvals WHERE id = '11111111-1111-4111-8111-111111111111'`),
          )
        ).rows[0];
        expect(decided).toEqual({ surface: 'slack', conversation_id: 'C0DEMO', message_ref: '1789000000.000001' });

        // The stale-claim state survives: claimed, addressed, no message yet. This is exactly
        // what the poller's sweep looks for, so a claim taken before the upgrade is still
        // recovered after it.
        const stranded = (
          await tx.execute(
            sql.raw(`SELECT conversation_id, message_ref, (claimed_at IS NOT NULL) AS claimed FROM approvals WHERE id = '33333333-3333-4333-8333-333333333333'`),
          )
        ).rows[0];
        expect(stranded).toEqual({ conversation_id: 'C0DEMO', message_ref: null, claimed: true });

        // In-flight effects are renamed; a dispatched one keeps the name it was sent under, and
        // a sink nobody renamed is untouched.
        const sinks = (
          await tx.execute(sql.raw(`SELECT id, sink FROM tool_effects ORDER BY idempotency_key`))
        ).rows.map((r) => r.sink);
        expect(sinks).toEqual(['email', 'surface_file', 'surface_message', 'slack_message']);

        // And the two columns the migration replaced are gone.
        const columns = (
          await tx.execute(
            sql.raw(`SELECT column_name FROM information_schema.columns WHERE table_name = 'approvals' AND column_name LIKE 'slack%'`),
          )
        ).rows;
        expect(columns).toEqual([]);

        tx.rollback();
      });
    } catch (err) {
      if (!(err instanceof TransactionRollbackError)) throw err;
    }
  });
});
```

The `ORDER BY idempotency_key` above sorts `demo:e1`, `demo:f1`, `demo:n1`, `demo:n2`, which is
the order the expected array is written in.

- [ ] **Step 7: Run the migration test**

Run: `pnpm --filter @harness/db test`
Expected: PASS. If `createLegacy0008Database` fails with "database does not exist", the
`harness_test` database is not up; that is an environment problem, not a code one.

- [ ] **Step 8: Re-point the host at the new column names**

Three source files, mechanically. In `harness/approvals/src/domain/poller.ts`:

- the stale release becomes `.set({ surface: null, conversationId: null, claimedAt: null })` and
  its `where` becomes `isNull(approvals.messageRef)`, `isNotNull(approvals.conversationId)`,
  `lte(approvals.claimedAt, staleBefore)`;
- the pending select's `where` becomes `isNull(approvals.messageRef)`, `isNull(approvals.conversationId)`;
- the claim becomes `.set({ surface: 'slack', conversationId: deps.channel, claimedAt: now })`
  guarded on `isNull(approvals.conversationId)`;
- the failed-post release becomes `.set({ surface: null, conversationId: null, claimedAt: null })`
  guarded on `isNull(approvals.messageRef)`;
- the success write becomes `.set({ messageRef: postResult.ts })`;
- every `slack_channel` / `slack_ts` in the comments becomes `conversation_id` / `message_ref`.

The literal `'slack'` in the claim is correct and temporary: this host talks to Slack and only to
Slack until Task 4, where it becomes `deps.surface.name`.

In `harness/approvals/src/domain/decisions.ts`, `tellSlack` becomes:

```ts
  if (!row.conversationId || !row.messageRef) {
    log.warn(`${row.id} has no card to update; the decision is recorded but not shown to a human`);
    return;
  }
```

with `channel: row.conversationId`, `ts: row.messageRef` on the update and
`channel: row.conversationId`, `thread_ts: row.messageRef` on the thread reply.

In `harness/approvals/src/testing.ts`, the `approvalRow` fixture's two lines become:

```ts
    surface: null,
    conversationId: null,
    messageRef: null,
```

- [ ] **Step 9: Re-point the three host test files**

In `harness/approvals/src/domain/poller.test.ts`: rename the helper
`dbWithFailingSlackTsWrite` to `dbWithFailingMessageRefWrite` and its guard to
`'messageRef' in values`; replace every `slackTs` with `messageRef` and every `slackChannel` with
`conversationId` in the assertions and the `pendingApproval({ … })` overrides; the stale-claim
case seeds `pendingApproval({ surface: 'slack', conversationId: 'C0STALE', claimedAt: staleClaimedAt, createdAt: staleClaimedAt })`
and the fresh-claim case `pendingApproval({ surface: 'slack', conversationId: 'C0OTHER', claimedAt: now(), createdAt: createdLongAgo })`.
Add one assertion to the first case, because the column is new and nothing else would catch a
poller that forgot it:

```ts
    expect(rows.every((r) => r.surface === 'slack')).toBe(true);
```

In `harness/approvals/src/domain/decisions.test.ts` and
`harness/approvals/src/domain/slack/handlers.test.ts`, the seed becomes:

```ts
    .values(pendingApproval({ surface: 'slack', conversationId: 'C0DEMO', messageRef: '1789000000.000001', ...over }))
```

(in `handlers.test.ts` there is no `...over`).

- [ ] **Step 10: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations
pnpm format:check
pnpm -r test          # green, including the two migration tests
pnpm surface:record && git status --porcelain docs/architecture   # no output
```

- [ ] **Step 11: Commit**

```bash
git add harness/db harness/approvals
git commit -m "feat(db): address approvals by surface, conversation and message ref"
```

No trailer of any kind.

---
### Task 3: `surfaces/slack` and `surfaces/memory` — the two adapters

Two new workspace packages under a new top-level directory. `@harness/surface-slack` is today's
rendering, transport and Web API code rewritten to take a `Card` and a `Form` instead of an
`ApprovalRow`; `@harness/surface-memory` is `MemorySurface` with a name and an allowlist. Both
are green in isolation and neither is loaded by anything yet: the host still has its own copy of
the Slack code and still uses it, and Task 4 is where the copies are deleted.

**The whole point of this task is the byte pin.** Three `toEqual` assertions — the pending card,
the decided card, the edit modal — hold the adapter's output against the literal objects today's
`blocks.ts` and `modal.ts` produce for the shared approval fixture. Deep equality on a plain
object is what "byte-identical" means for something that is about to be `JSON.stringify`d, and no
later task edits those three expectations.

**Files:**
- Create: `surfaces/slack/{package.json,tsconfig.json,vitest.config.ts,README.md}`
- Create: `surfaces/slack/src/{config.ts,session.ts,index.ts,testing.ts}`
- Create: `surfaces/slack/src/render/{blocks.ts,modal.ts}` and their tests
- Create: `surfaces/slack/src/transport/{types.ts,web-client.ts,bolt.ts,fake.ts}`
- Create: `surfaces/slack/src/session.test.ts`, `surfaces/slack/src/index.test.ts`
- Create: `surfaces/memory/{package.json,tsconfig.json,vitest.config.ts,README.md}`, `src/index.ts`, `src/index.test.ts`
- Modify: `pnpm-workspace.yaml`, root `package.json` (`arch`, `arch:graph`), `.dependency-cruiser.cjs`
- Modify: `harness/core-tools/src/app/record-surface.ts` (`SOURCE_ROOTS`), `.env.example` (`MEMORY_ALLOWED_USERS`)

**Interfaces:**
- Consumes: from `@harness/surface-api` — `defineSurface`, `parseAllowedUsers`, `ANY_USER`,
  `CONVERSATION_ID_PATTERN`, `MemorySurface` (via `@harness/surface-api/testing`), and the types
  `Card`, `CardLine`, `NotePart`, `Form`, `MessageRef`, `Surface`, `SurfaceDeps`,
  `SurfaceSession`, `UploadRequest`. From `@harness/shared` — `SurfaceError`, `requiredEnv`,
  `optionalEnv`, `createLogger`, `describeError`.
- Produces:

  ```ts
  // @harness/surface-slack
  export const surface: Surface                    // name 'slack'
  // @harness/surface-slack/testing
  class FakeSlack implements SlackApi { posts; updates; uploads; opened; ephemeral; failWith? }
  class FakeSlackEvents implements SlackEvents { emitAction(a): Promise<void>; emitView(v): Promise<void> }
  function fakeSlackSession(over?: Partial<SlackConfig>): { session: SurfaceSession; api: FakeSlack; events: FakeSlackEvents }

  // @harness/surface-memory
  export const surface: Surface                    // name 'memory'
  ```

**What does not change.** The host, the kernel, the packs, every tool schema, every migration.
`docs/architecture/tool-surface.json` is untouched.

---

- [ ] **Step 1: Make the workspace aware of `surfaces/`**

In `pnpm-workspace.yaml`, add `'surfaces/*'` to `packages`, after `'packs/*'`.

In the root `package.json`, add `'surfaces/*/src/**/*.ts'` to both the `arch` and the `arch:graph`
globs, directly after the `packs/*/forms/**/*.ts` entry. Both lines must stay identical apart
from the reporter flags, or the graph and the gate could disagree.

- [ ] **Step 2: Create the Slack adapter package**

Create `surfaces/slack/package.json`:

```json
{
  "name": "@harness/surface-slack",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./testing": "./src/testing.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*",
    "@harness/surface-api": "workspace:*",
    "@slack/bolt": "^5.1.0",
    "@slack/web-api": "^8.1.1"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

Create `surfaces/slack/tsconfig.json` and `surfaces/slack/vitest.config.ts` with the same two
contents as `harness/surface-api`'s (`{ "extends": "../../tsconfig.base.json", "include": ["src", "vitest.config.ts"] }`
and `export default defineConfig({});`).

Create `surfaces/memory/package.json`:

```json
{
  "name": "@harness/surface-memory",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts"
  },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
    "@harness/shared": "workspace:*",
    "@harness/surface-api": "workspace:*"
  },
  "devDependencies": {
    "@types/node": "^26.5.1",
    "typescript": "^7.0.2",
    "vitest": "^5.0.0"
  }
}
```

with the same `tsconfig.json` and `vitest.config.ts`.

Run: `pnpm install`
Expected: `+2` workspace projects.

- [ ] **Step 3: Write the failing render test — the three byte pins**

Create `surfaces/slack/src/render/blocks.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Card } from '@harness/surface-api';
import { cardBlocks } from './blocks.js';

/**
 * The approval the whole repository uses as its fixture, as a `Card`.
 *
 * Every string here is what `harness/approvals`' `approvalCard` produces from `approvalRow()`,
 * and the expectations below are what `domain/render/blocks.ts` produced from the same row
 * before this plan moved it. The pair is the proof that the demo deployment's card did not
 * change: the host's own test asserts the left-hand side, this file asserts the right.
 */
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const PAYLOAD_PREVIEW = '{\n  "tool": "forms_release",\n  "args": {\n    "file_id": "roster/aetna-abc123def456.csv"\n  }\n}';

const pendingCard: Card = {
  id: 'harness_approval',
  title: 'Approval needed',
  subtitle: 'forms_release (external) requested by hermes',
  notice: 'Approval needed: forms_release (external) requested by hermes',
  body: [
    {
      note: [
        { code: 'forms_release' },
        { text: ' · requested by ' },
        { code: 'hermes' },
        { text: ' · expires ' },
        { at: new Date('2026-09-16T12:00:00Z') },
      ],
    },
    { code: PAYLOAD_PREVIEW },
  ],
  actions: [
    { id: 'harness_approval_approve', label: 'Approve', style: 'primary', value: APPROVAL_ID },
    { id: 'harness_approval_edit', label: 'Edit', style: 'default', value: APPROVAL_ID },
    { id: 'harness_approval_decline', label: 'Decline', style: 'danger', value: APPROVAL_ID },
  ],
  footer: [{ text: 'Approval ' }, { code: APPROVAL_ID }],
};

const header = [
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*Approval needed*\nforms_release (external) requested by hermes' },
  },
  {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '`forms_release` · requested by `hermes` · expires <!date^1789560000^{date_short_pretty} {time}|2026-09-16T12:00:00.000Z>',
      },
    ],
  },
  { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${PAYLOAD_PREVIEW}\n\`\`\`` } },
];

const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: `Approval \`${APPROVAL_ID}\`` }] };

describe('cardBlocks', () => {
  it('renders the pending approval card exactly as the Slack app rendered it before Plan 6', () => {
    expect(cardBlocks(pendingCard)).toEqual([
      ...header,
      {
        type: 'actions',
        block_id: 'harness_approval_actions',
        elements: [
          {
            type: 'button',
            action_id: 'harness_approval_approve',
            text: { type: 'plain_text', text: 'Approve' },
            value: APPROVAL_ID,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: 'harness_approval_edit',
            text: { type: 'plain_text', text: 'Edit' },
            value: APPROVAL_ID,
          },
          {
            type: 'button',
            action_id: 'harness_approval_decline',
            text: { type: 'plain_text', text: 'Decline' },
            value: APPROVAL_ID,
            style: 'danger',
          },
        ],
      },
      footer,
    ]);
  });

  it('renders the decided card exactly as it did before, with no buttons left on it', () => {
    const decided: Card = {
      ...pendingCard,
      notice: `Approval ${APPROVAL_ID} approved`,
      body: [
        ...pendingCard.body,
        {
          note: [
            { icon: 'approved' },
            { text: ' Approved by ' },
            { user: 'U012' },
            { text: ' at ' },
            { at: new Date('2026-09-15T12:05:00Z') },
            { text: '.' },
            { text: '\nExecuted ' },
            { code: 'forms_release' },
            { text: '. Delivery is queued in the effects outbox.' },
          ],
        },
      ],
      actions: [],
    };
    expect(cardBlocks(decided)).toEqual([
      ...header,
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':white_check_mark: Approved by <@U012> at <!date^1789473900^{date_short_pretty} {time}|2026-09-15T12:05:00.000Z>.\nExecuted `forms_release`. Delivery is queued in the effects outbox.',
          },
        ],
      },
      footer,
    ]);
  });

  it('renders the declined icon', () => {
    const blocks = cardBlocks({ ...pendingCard, actions: [], body: [{ note: [{ icon: 'declined' }, { text: ' Declined.' }] }] });
    expect(blocks[1]).toEqual({ type: 'context', elements: [{ type: 'mrkdwn', text: ':no_entry: Declined.' }] });
  });

  it('renders a plain line and a labelled one as their own sections', () => {
    const blocks = cardBlocks({
      ...pendingCard,
      subtitle: undefined,
      footer: undefined,
      actions: [],
      body: [{ text: 'just a line' }, { label: 'Payer', value: 'Aetna' }],
    });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*Approval needed*' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'just a line' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Payer*: Aetna' } },
    ]);
  });
});
```

Create `surfaces/slack/src/render/modal.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import type { Form } from '@harness/surface-api';
import { formView, valuesOf } from './modal.js';

const form: Form = {
  id: 'harness_approval_edit_modal',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  intro:
    'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
  fields: [
    {
      id: 'harness_approval_note',
      label: 'What should change?',
      multiline: true,
      optional: false,
      maxLength: 1000,
      placeholder: 'Do not include patient or provider identifiers here.',
    },
  ],
  metadata: '{"approval_id":"11111111-1111-4111-8111-111111111111","conversation":"C0DEMO"}',
};

describe('formView', () => {
  it('renders the edit modal exactly as the Slack app rendered it before Plan 6', () => {
    expect(formView(form)).toEqual({
      type: 'modal',
      callback_id: 'harness_approval_edit_modal',
      private_metadata: '{"approval_id":"11111111-1111-4111-8111-111111111111","conversation":"C0DEMO"}',
      title: { type: 'plain_text', text: 'Send it back' },
      submit: { type: 'plain_text', text: 'Decline with note' },
      close: { type: 'plain_text', text: 'Cancel' },
      blocks: [
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: 'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
          },
        },
        {
          type: 'input',
          block_id: 'harness_approval_note',
          label: { type: 'plain_text', text: 'What should change?' },
          element: {
            type: 'plain_text_input',
            action_id: 'harness_approval_note_input',
            multiline: true,
            max_length: 1000,
            placeholder: { type: 'plain_text', text: 'Do not include patient or provider identifiers here.' },
          },
        },
      ],
    });
  });

  it('marks an optional field optional and leaves out what the field does not declare', () => {
    const view = formView({
      ...form,
      intro: undefined,
      fields: [{ id: 'why', label: 'Why?', multiline: false, optional: true }],
    }) as { blocks: { type: string; optional?: boolean; element: Record<string, unknown> }[] };
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toEqual({
      type: 'input',
      block_id: 'why',
      optional: true,
      label: { type: 'plain_text', text: 'Why?' },
      element: { type: 'plain_text_input', action_id: 'why_input', multiline: false },
    });
  });

  it("reads a submitted view's values back under the field ids", () => {
    expect(
      valuesOf({ harness_approval_note: { harness_approval_note_input: { value: 'Use the Q4 roster.' } } }, form),
    ).toEqual({ harness_approval_note: 'Use the Q4 roster.' });
  });

  it('reads an empty answer as an empty string rather than dropping the key', () => {
    expect(valuesOf({ harness_approval_note: { harness_approval_note_input: { value: null } } }, form)).toEqual({
      harness_approval_note: '',
    });
    expect(valuesOf({}, form)).toEqual({ harness_approval_note: '' });
  });
});
```

- [ ] **Step 4: Run the render tests and watch them fail**

Run: `pnpm --filter @harness/surface-slack test`
Expected: FAIL — `Failed to resolve import "./blocks.js"` and `"./modal.js"`.

- [ ] **Step 5: Write the two renderers**

Create `surfaces/slack/src/render/blocks.ts`:

```ts
import type { Card, CardIcon, CardLine, NotePart } from '@harness/surface-api';

/**
 * Block Kit, and the only place in the repository that knows what Block Kit is.
 *
 * Every function here takes a neutral `Card` and returns plain objects. The output is pinned
 * byte for byte against what `harness/approvals`' `domain/render/blocks.ts` produced before
 * Plan 6, because the demo deployment's card must not change: same blocks, same order, same
 * mrkdwn, same action ids.
 */

/** Slack's own date token, which renders in each reader's timezone. */
function slackDate(at: Date): string {
  const epoch = Math.floor(at.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

const ICONS: Record<CardIcon, string> = {
  approved: ':white_check_mark:',
  declined: ':no_entry:',
};

function renderPart(part: NotePart): string {
  if ('text' in part) return part.text;
  if ('code' in part) return `\`${part.code}\``;
  if ('at' in part) return slackDate(part.at);
  if ('user' in part) return `<@${part.user}>`;
  return ICONS[part.icon];
}

function mrkdwnSection(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function contextBlock(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function renderLine(line: CardLine): unknown {
  if ('note' in line) return contextBlock(line.note.map(renderPart).join(''));
  if ('code' in line) return mrkdwnSection(`\`\`\`\n${line.code}\n\`\`\``);
  if ('label' in line) return mrkdwnSection(`*${line.label}*: ${line.value}`);
  return mrkdwnSection(line.text);
}

function button(action: Card['actions'][number]): unknown {
  return {
    type: 'button',
    action_id: action.id,
    text: { type: 'plain_text', text: action.label },
    value: action.value,
    // `default` is the absence of a style in Block Kit, not a value it accepts.
    ...(action.style === 'default' ? {} : { style: action.style }),
  };
}

export function cardBlocks(card: Card): unknown[] {
  const head = card.subtitle === undefined ? `*${card.title}*` : `*${card.title}*\n${card.subtitle}`;
  const blocks: unknown[] = [mrkdwnSection(head)];
  for (const line of card.body) blocks.push(renderLine(line));
  if (card.actions.length > 0) {
    blocks.push({
      // Derived from the card's own id rather than hard-coded, so this module never learns what
      // kind of card it is rendering. For `harness_approval` it is the block id the demo
      // deployment's interaction payloads already carry.
      block_id: `${card.id}_actions`,
      type: 'actions',
      elements: card.actions.map(button),
    });
  }
  if (card.footer) blocks.push(contextBlock(card.footer.map(renderPart).join('')));
  return blocks;
}
```

Create `surfaces/slack/src/render/modal.ts`:

```ts
import type { Form, FormField } from '@harness/surface-api';

/**
 * A Slack modal view from a neutral `Form`.
 *
 * `Form.metadata` travels in `private_metadata` and is never read here: it is the host's string
 * and comes back untouched on submission. Slack's `view_submission` payload carries no
 * conversation of its own for a modal opened from a button, which is why the host puts one in
 * there — but that is the host's business, not this module's.
 */

/** The element id Slack reports an answer under. Derived, so the host declares one id per field. */
export function inputActionId(field: FormField): string {
  return `${field.id}_input`;
}

function inputBlock(field: FormField): unknown {
  return {
    type: 'input',
    block_id: field.id,
    ...(field.optional ? { optional: true } : {}),
    label: { type: 'plain_text', text: field.label },
    element: {
      type: 'plain_text_input',
      action_id: inputActionId(field),
      multiline: field.multiline,
      ...(field.maxLength === undefined ? {} : { max_length: field.maxLength }),
      ...(field.placeholder === undefined ? {} : { placeholder: { type: 'plain_text', text: field.placeholder } }),
    },
  };
}

export function formView(form: Form): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: form.id,
    private_metadata: form.metadata,
    title: { type: 'plain_text', text: form.title },
    submit: { type: 'plain_text', text: form.submitLabel },
    close: { type: 'plain_text', text: form.cancelLabel },
    blocks: [
      ...(form.intro === undefined ? [] : [{ type: 'section', text: { type: 'mrkdwn', text: form.intro } }]),
      ...form.fields.map(inputBlock),
    ],
  };
}

/**
 * Read a submitted view's state into `FormEvent.values`.
 *
 * Every declared field gets a key, empty string included: a handler that reads
 * `values[field.id]` must not have to tell "left blank" from "Slack changed its payload shape".
 */
export function valuesOf(state: Record<string, Record<string, { value?: string | null }>>, form: Form): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of form.fields) values[field.id] = state[field.id]?.[inputActionId(field)]?.value ?? '';
  return values;
}
```

- [ ] **Step 6: Run the render tests and watch them pass**

Run: `pnpm --filter @harness/surface-slack test`
Expected: PASS, 8 tests. **These are the byte pins; no later task edits them.**

- [ ] **Step 7: Move the transport**

Create `surfaces/slack/src/transport/types.ts` — today's
`harness/approvals/src/domain/slack/types.ts` verbatim (`SlackPostMessageArgs`, `SlackUpdateArgs`,
`SlackUploadArgs`, `SlackViewOpenArgs`, `SlackEphemeralArgs`, `SlackPostResult`, `SlackApi`), with
the inbound half added below it:

```ts
/**
 * One block action, narrowed off Bolt's payload. Everything Bolt-specific is in `bolt.ts`, so
 * the session and its tests never touch a Bolt type — the same seam the approvals app already
 * had, moved into the adapter that owns it.
 */
export interface SlackAction {
  userId: string;
  channel: string;
  actionId: string;
  value: string;
  triggerId: string | null;
  /** The timestamp of the message the button was on, when Slack sends one. */
  messageTs: string | null;
}

export interface SlackView {
  userId: string;
  callbackId: string;
  privateMetadata: string;
  /** Slack's `view.state.values`, field block id → element action id → value. */
  state: Record<string, Record<string, { value?: string | null }>>;
}

/**
 * The inbound half of a Slack connection. One handler for every action and one for every view:
 * the surface contract registers a single handler apiece and dispatches on the id itself.
 */
export interface SlackEvents {
  onAction(handler: (action: SlackAction) => Promise<void>): void;
  onView(handler: (view: SlackView) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SlackTransport {
  api: SlackApi;
  events: SlackEvents;
}
```

Create `surfaces/slack/src/transport/web-client.ts` — today's
`harness/approvals/src/domain/slack/web-client.ts` verbatim, with its import changed to
`./types.js`.

Create `surfaces/slack/src/transport/fake.ts` — today's `harness/approvals/src/domain/slack/fake.ts`
verbatim (`FakeSlack`), with `SlackAction`, `SlackEvents` and `SlackView` added to its existing
type import from `./types.js`, plus:

```ts
/** The inbound half of `FakeSlack`: a test calls `emitAction` where Slack would. */
export class FakeSlackEvents implements SlackEvents {
  started = false;
  stopped = false;
  private actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  private viewHandler: ((view: SlackView) => Promise<void>) | null = null;

  onAction(handler: (action: SlackAction) => Promise<void>): void {
    this.actionHandler = handler;
  }

  onView(handler: (view: SlackView) => Promise<void>): void {
    this.viewHandler = handler;
  }

  async start(): Promise<void> {
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async emitAction(action: SlackAction): Promise<void> {
    if (!this.actionHandler) throw new Error('no action handler is registered');
    await this.actionHandler(action);
  }

  async emitView(view: SlackView): Promise<void> {
    if (!this.viewHandler) throw new Error('no view handler is registered');
    await this.viewHandler(view);
  }
}
```

Create `surfaces/slack/src/transport/bolt.ts` — today's `main.ts:56-121` and `main.ts:168-178`,
now owned by the adapter:

```ts
import { App, LogLevel } from '@slack/bolt';
import type { Logger } from '@harness/shared';
import type { SlackConfig } from '../config.js';
import { webClientApi } from './web-client.js';
import type { SlackAction, SlackEvents, SlackTransport, SlackView } from './types.js';

/**
 * A real Slack connection, in Socket Mode.
 *
 * The approvals host needs its own Slack app, not Hermes's. Slack routes each Socket Mode event
 * to exactly one of an app's open connections, so with Hermes's gateway and this process both
 * connected on one app token, roughly half of every button click and modal submission went to
 * Hermes, which has no handler for them, and the approval silently stayed pending. Two app
 * tokens means two independent event streams. `config.ts` deliberately does not fall back to
 * `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN`: a fallback would make the broken configuration the
 * default again and fail intermittently rather than at startup.
 *
 * Both registrations are catch-alls. The contract takes one action handler and one view handler
 * and dispatches on the id itself, so there is nothing for Bolt to route.
 */
export function boltTransport(config: SlackConfig, log: Logger): SlackTransport {
  const bolt = new App({
    token: config.botToken,
    appToken: config.appToken,
    socketMode: true,
    logLevel: LogLevel.INFO,
  });

  let actionHandler: ((action: SlackAction) => Promise<void>) | null = null;
  let viewHandler: ((view: SlackView) => Promise<void>) | null = null;

  /** Slack drops an interaction that is not acknowledged within three seconds. */
  const ackFirst = async (ack: () => Promise<unknown>): Promise<void> => {
    try {
      await ack();
    } catch (err) {
      log.error('ack failed', err);
    }
  };

  bolt.action(/.*/, async ({ ack, body, action }) => {
    await ackFirst(ack);
    if (!actionHandler) {
      log.warn('a Slack action arrived before a handler was registered');
      return;
    }
    await actionHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      // The channel the interactive message lives in.
      channel: (body as { channel?: { id?: string } }).channel?.id ?? '',
      actionId: (action as { action_id?: string }).action_id ?? '',
      value: (action as { value?: string }).value ?? '',
      triggerId: (body as { trigger_id?: string }).trigger_id ?? null,
      messageTs: (body as { message?: { ts?: string } }).message?.ts ?? null,
    });
  });

  bolt.view(/.*/, async ({ ack, body, view }) => {
    await ackFirst(ack);
    if (!viewHandler) {
      log.warn('a Slack view submission arrived before a handler was registered');
      return;
    }
    await viewHandler({
      userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
      callbackId: view.callback_id,
      privateMetadata: view.private_metadata ?? '',
      state: (view.state as { values?: Record<string, Record<string, { value?: string | null }>> }).values ?? {},
    });
  });

  const events: SlackEvents = {
    onAction(handler) {
      actionHandler = handler;
    },
    onView(handler) {
      viewHandler = handler;
    },
    start: () => bolt.start().then(() => undefined),
    stop: () => bolt.stop().then(() => undefined),
  };

  return { api: webClientApi(bolt.client), events };
}
```

- [ ] **Step 8: Write the configuration reader**

Create `surfaces/slack/src/config.ts`:

```ts
import { optionalEnv, requiredEnv, type EnvSource } from '@harness/shared';
import { parseAllowedUsers } from '@harness/surface-api';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Where approval cards go when nobody names a conversation: a channel id. */
  defaultConversation: string;
  allowedUsers: ReadonlySet<string>;
}

/** Appended to the two token errors, because a missing one is almost always the same mistake. */
const TWO_APPS = ' (the approvals host needs its own Slack app; see docs/runbook.md)';

/**
 * Read this adapter's configuration out of the environment the host handed over.
 *
 * `deps.env` only, never the ambient environment: whoever builds the bag decides what an adapter
 * can see, which is what stops a suite from opening a real socket because the machine running it
 * has a filled-in `.env`. The variable names are unchanged from before Plan 6, deliberately —
 * the demo deployment's `.env` and its Compose service keep working untouched.
 */
export function slackConfig(env: EnvSource): SlackConfig {
  return {
    botToken: requiredEnv('APPROVALS_SLACK_BOT_TOKEN', TWO_APPS, env),
    appToken: requiredEnv('APPROVALS_SLACK_APP_TOKEN', TWO_APPS, env),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
    allowedUsers: parseAllowedUsers(optionalEnv('SLACK_ALLOWED_USERS', env)),
  };
}
```

- [ ] **Step 9: Write the failing session test**

Create `surfaces/slack/src/session.test.ts`:

```ts
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SurfaceError } from '@harness/shared';
import type { ActionEvent, Card, Form, FormEvent } from '@harness/surface-api';
import { fakeSlackSession } from './testing.js';

const card: Card = {
  id: 'harness_approval',
  title: 'Approval needed',
  subtitle: 'a summary',
  notice: 'Approval needed: a summary',
  body: [{ text: 'a line' }],
  actions: [{ id: 'harness_approval_approve', label: 'Approve', style: 'primary', value: 'a1' }],
};

const form: Form = {
  id: 'harness_approval_edit_modal',
  title: 'Send it back',
  submitLabel: 'Decline with note',
  cancelLabel: 'Cancel',
  fields: [{ id: 'harness_approval_note', label: 'What should change?', multiline: true, optional: false }],
  metadata: '{"approval_id":"a1"}',
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-surface-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('the Slack session', () => {
  it('names itself, and reports what Slack can do', () => {
    const { session } = fakeSlackSession();
    expect(session.name).toBe('slack');
    expect(session.capabilities).toEqual({ forms: true, privateReply: true, update: true });
    expect(session.defaultConversation).toBe('C0DEMO');
    expect(session.mention('U012')).toBe('<@U012>');
  });

  it('posts a card with the notice as its text and hands back a reference that names the surface', async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    expect(api.posts).toHaveLength(1);
    expect(api.posts[0].channel).toBe('C0DEMO');
    expect(api.posts[0].text).toBe('Approval needed: a summary');
    expect(api.posts[0].blocks).toHaveLength(3);
    expect(ref).toMatchObject({ surface: 'slack', conversation: 'C0DEMO' });
    expect(ref.id).toMatch(/^\d+\.\d+$/);
  });

  it('edits the card the reference names', async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    await session.updateCard(ref, { ...card, notice: 'Approval a1 approved', actions: [] });
    expect(api.updates).toHaveLength(1);
    expect(api.updates[0]).toMatchObject({ channel: 'C0DEMO', ts: ref.id, text: 'Approval a1 approved' });
  });

  it("replies in the card's thread when it is given a message to reply to", async () => {
    const { session, api } = fakeSlackSession();
    const ref = await session.postCard('C0DEMO', card);
    await session.postText('C0DEMO', 'decided', { replyTo: ref });
    expect(api.posts[1]).toMatchObject({ channel: 'C0DEMO', text: 'decided', thread_ts: ref.id });
  });

  it('sends a private note as an ephemeral message', async () => {
    const { session, api } = fakeSlackSession();
    await session.postPrivate('C0DEMO', 'U012', 'You are not an approver for this workspace.');
    expect(api.ephemeral[0]).toEqual({
      channel: 'C0DEMO',
      user: 'U012',
      text: 'You are not an approver for this workspace.',
    });
  });

  it('uploads the file at the path it is given, with the comment as the initial comment', async () => {
    const { session, api } = fakeSlackSession();
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id\naetna\n');
    const out = await session.uploadFile('C0DEMO', { path: file, filename: 'aetna-roster.csv', comment: 'Release aetna-roster.csv' });
    expect(out).toEqual({ filename: 'aetna-roster.csv' });
    expect(api.uploads[0]).toMatchObject({
      channel_id: 'C0DEMO',
      filename: 'aetna-roster.csv',
      initial_comment: 'Release aetna-roster.csv',
    });
    expect(api.uploads[0].file.toString()).toContain('aetna');
  });

  it('never puts a filesystem path in the error when the file cannot be read', async () => {
    const { session, api } = fakeSlackSession();
    const missing = path.join(dir, 'gone.csv');
    const err = await session
      .uploadFile('C0DEMO', { path: missing, filename: 'gone.csv' })
      .then(() => null)
      .catch((caught: unknown) => caught);
    // This message is written into `tool_effects.last_error`, which is plaintext and which an
    // operator pastes into a ticket.
    expect(err).toBeInstanceOf(SurfaceError);
    expect((err as Error).message).toBe('slack: the staged file could not be read');
    expect((err as Error).message).not.toContain(missing);
    expect(api.uploads).toHaveLength(0);
  });

  it('opens the form as a modal against the trigger it was handed', async () => {
    const { session, api } = fakeSlackSession();
    await session.openForm('T1', form);
    expect(api.opened[0].trigger_id).toBe('T1');
    expect(api.opened[0].view.callback_id).toBe('harness_approval_edit_modal');
  });

  it('refuses a conversation id that is not a Slack one, before it calls Slack', async () => {
    const { session, api } = fakeSlackSession();
    await expect(session.postCard('not-a-channel', card)).rejects.toThrow(SurfaceError);
    await expect(session.postCard('not-a-channel', card)).rejects.toThrow(/slack: "not-a-channel"/);
    expect(api.posts).toHaveLength(0);
  });

  it('turns a Slack block action into an ActionEvent', async () => {
    const { session, events } = fakeSlackSession();
    const seen: ActionEvent[] = [];
    session.onAction(async (event) => {
      seen.push(event);
    });
    await events.emitAction({
      userId: 'U012',
      channel: 'C0DEMO',
      actionId: 'harness_approval_approve',
      value: 'a1',
      triggerId: 'T1',
      messageTs: '1789000000.000001',
    });
    expect(seen[0]).toEqual({
      surface: 'slack',
      userId: 'U012',
      conversation: 'C0DEMO',
      message: { surface: 'slack', conversation: 'C0DEMO', id: '1789000000.000001' },
      actionId: 'harness_approval_approve',
      value: 'a1',
      trigger: 'T1',
    });
  });

  it('turns a view submission into a FormEvent, reading the values under their field ids', async () => {
    const { session, events } = fakeSlackSession();
    const seen: FormEvent[] = [];
    session.onFormSubmit(async (event) => {
      seen.push(event);
    });
    await session.openForm('T1', form);
    await events.emitView({
      userId: 'U012',
      callbackId: 'harness_approval_edit_modal',
      privateMetadata: '{"approval_id":"a1"}',
      state: { harness_approval_note: { harness_approval_note_input: { value: 'Use the Q4 roster.' } } },
    });
    expect(seen[0]).toMatchObject({
      surface: 'slack',
      userId: 'U012',
      formId: 'harness_approval_edit_modal',
      metadata: '{"approval_id":"a1"}',
      values: { harness_approval_note: 'Use the Q4 roster.' },
    });
  });

  it('starts and stops the transport', async () => {
    const { session, events } = fakeSlackSession();
    await session.start();
    await session.stop();
    expect(events.started).toBe(true);
    expect(events.stopped).toBe(true);
  });
});
```

- [ ] **Step 10: Write the session and the package's two entry points**

Create `surfaces/slack/src/session.ts`:

```ts
import { readFile } from 'node:fs/promises';
import { SurfaceError } from '@harness/shared';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageRef,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { cardBlocks } from './render/blocks.js';
import { formView, valuesOf } from './render/modal.js';
import type { SlackTransport } from './transport/types.js';

const NAME = 'slack';

/**
 * A Slack channel, group or direct-message id.
 *
 * The kernel validates a conversation id only as a shape, because it cannot know a surface's
 * format; this is where the real check happens, at dispatch, and a bad id fails that one effect
 * with a message an operator reads through `harness_reconcile`.
 */
const SLACK_CONVERSATION = /^[CGD][A-Z0-9]{2,}$/;

/** The one place a form's fields are remembered, so a submission can be read back by field id. */
type OpenForms = Map<string, Form>;

function assertConversation(conversation: string): void {
  if (!SLACK_CONVERSATION.test(conversation)) {
    throw new SurfaceError(`${NAME}: "${conversation}" is not a Slack conversation id`);
  }
}

export function createSlackSession(transport: SlackTransport, config: SlackConfig): SurfaceSession {
  const { api, events } = transport;
  // A form is declared by the host when it opens one and read back when it is submitted. Slack's
  // `view_submission` reports answers under the element ids this adapter derived, so the form
  // has to be in hand to map them back; keyed by callback id, which is the form's own id.
  const forms: OpenForms = new Map();

  const ref = (conversation: string, id: string): MessageRef => ({ surface: NAME, conversation, id });

  return {
    name: NAME,
    capabilities: { forms: true, privateReply: true, update: true },
    allowedUsers: config.allowedUsers,
    defaultConversation: config.defaultConversation,

    mention: (userId) => `<@${userId}>`,

    async postCard(conversation, card: Card) {
      assertConversation(conversation);
      const res = await api.chat.postMessage({
        channel: conversation,
        text: card.notice,
        blocks: cardBlocks(card),
      });
      if (!res.ts) throw new SurfaceError(`${NAME}: the message was accepted without a timestamp`);
      return ref(conversation, res.ts);
    },

    async updateCard(message, card: Card) {
      assertConversation(message.conversation);
      await api.chat.update({
        channel: message.conversation,
        ts: message.id,
        text: card.notice,
        blocks: cardBlocks(card),
      });
    },

    async postText(conversation, text, opts = {}) {
      assertConversation(conversation);
      const res = await api.chat.postMessage({ channel: conversation, text, thread_ts: opts.replyTo?.id });
      if (!res.ts) throw new SurfaceError(`${NAME}: the message was accepted without a timestamp`);
      return ref(conversation, res.ts);
    },

    async postPrivate(conversation, userId, text) {
      assertConversation(conversation);
      await api.chat.postEphemeral({ channel: conversation, user: userId, text });
    },

    async uploadFile(conversation, file: UploadRequest) {
      assertConversation(conversation);
      let bytes: Buffer;
      try {
        bytes = await readFile(file.path);
      } catch {
        // Node's fs error carries the absolute path and this message is written into
        // `tool_effects.last_error`, which is plaintext.
        throw new SurfaceError(`${NAME}: the staged file could not be read`);
      }
      await api.files.uploadV2({
        channel_id: conversation,
        file: bytes,
        filename: file.filename,
        initial_comment: file.comment,
        thread_ts: file.replyTo?.id,
      });
      return { filename: file.filename };
    },

    async openForm(trigger, form: Form) {
      forms.set(form.id, form);
      await api.views.open({ trigger_id: trigger, view: formView(form) });
    },

    onAction(handler: (event: ActionEvent) => Promise<void>) {
      events.onAction(async (action) => {
        await handler({
          surface: NAME,
          userId: action.userId,
          conversation: action.channel,
          message: action.messageTs === null ? null : ref(action.channel, action.messageTs),
          actionId: action.actionId,
          value: action.value,
          trigger: action.triggerId,
        });
      });
    },

    onFormSubmit(handler: (event: FormEvent) => Promise<void>) {
      events.onView(async (view) => {
        const form = forms.get(view.callbackId);
        await handler({
          surface: NAME,
          userId: view.userId,
          // Slack's view submission carries no conversation of its own for a modal opened from
          // a button, which is why the host travels one inside the metadata it gets back.
          conversation: '',
          formId: view.callbackId,
          metadata: view.privateMetadata,
          values: form ? valuesOf(view.state, form) : {},
        });
      });
    },

    start: () => events.start(),
    stop: () => events.stop(),
  };
}
```

Create `surfaces/slack/src/index.ts`:

```ts
import { defineSurface, type Surface } from '@harness/surface-api';
import { slackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { boltTransport } from './transport/bolt.js';

/**
 * Slack, as one messaging surface among several.
 *
 * The host loads this by name from `HARNESS_SURFACES` and holds nothing but the contract, so
 * every Slack-shaped thing — Block Kit, Bolt, Socket Mode, a `C…` channel id, a `ts` — is behind
 * this package's boundary. The rendered cards are pinned byte for byte against what the
 * approvals app produced before Plan 6.
 */
export const surface: Surface = defineSurface({
  name: 'slack',
  version: '0.1.0',
  // Stripped from the environment of the core-tools child the host spawns. `SLACK_BOT_TOKEN` and
  // `SLACK_APP_TOKEN` are Hermes's, not this adapter's, and are listed because a process holding
  // an approver's credentials must not hand any Slack credential to a child either.
  secrets: ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'],
  connect: async (deps) => {
    const config = slackConfig(deps.env);
    return createSlackSession(boltTransport(config, deps.log), config);
  },
});
```

Create `surfaces/slack/src/testing.ts`:

```ts
/** What a test of this adapter, or of the host, reaches for: the two fakes and a wired session. */
import { parseAllowedUsers, type SurfaceSession } from '@harness/surface-api';
import type { SlackConfig } from './config.js';
import { createSlackSession } from './session.js';
import { FakeSlack, FakeSlackEvents } from './transport/fake.js';

export { FakeSlack, FakeSlackEvents } from './transport/fake.js';

/**
 * A Slack session wired to the two fakes: the real `session.ts`, the real renderers, no socket.
 * The host's dual-surface test uses it to prove that what it does to a surface it loaded by name
 * arrives as Block Kit.
 */
export function fakeSlackSession(over: Partial<SlackConfig> = {}): {
  session: SurfaceSession;
  api: FakeSlack;
  events: FakeSlackEvents;
} {
  const api = new FakeSlack();
  const events = new FakeSlackEvents();
  const config: SlackConfig = {
    botToken: 'xoxb-test',
    appToken: 'xapp-test',
    defaultConversation: 'C0DEMO',
    allowedUsers: parseAllowedUsers('U012'),
    ...over,
  };
  return { session: createSlackSession({ api, events }, config), api, events };
}
```

Create `surfaces/slack/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { surface } from './index.js';

describe('the Slack surface declaration', () => {
  it('declares its name and the credentials that must never reach a child process', () => {
    expect(surface.name).toBe('slack');
    expect([...surface.secrets].sort()).toEqual([
      'APPROVALS_SLACK_APP_TOKEN',
      'APPROVALS_SLACK_BOT_TOKEN',
      'SLACK_APP_TOKEN',
      'SLACK_BOT_TOKEN',
    ]);
  });
});
```

- [ ] **Step 11: Run the Slack adapter's suite**

Run: `pnpm --filter @harness/surface-slack test`
Expected: PASS, 22 tests across four files.

- [ ] **Step 12: Write the memory adapter and its test**

Create `surfaces/memory/src/index.ts`:

```ts
import { optionalEnv } from '@harness/shared';
import { ANY_USER, defineSurface, parseAllowedUsers, type Surface } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';

/**
 * A surface with no transport.
 *
 * It exists for two reasons and does the same job for both: a developer runs the host with
 * `HARNESS_SURFACES=@harness/surface-memory` and no Slack workspace at all, and the suite loads
 * it beside the Slack adapter so every host test can drive a real, loaded surface rather than a
 * mock of one. `MemorySurface` itself lives in the contract's `testing` subpath, so the thing the
 * suite proves the host against is the thing that runs.
 *
 * `MEMORY_ALLOWED_USERS` defaults to the wildcard. This is the only surface that may be open, and
 * only because there is nothing to be open to: nothing it posts leaves the process.
 */
export const surface: Surface = defineSurface({
  name: 'memory',
  version: '0.1.0',
  secrets: [],
  connect: async (deps) =>
    new MemorySurface({
      name: 'memory',
      conversation: 'memory',
      allowedUsers: parseAllowedUsers(optionalEnv('MEMORY_ALLOWED_USERS', deps.env) ?? ANY_USER),
    }),
});
```

Create `surfaces/memory/src/index.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { allowsUser } from '@harness/surface-api';
import { createLogger } from '@harness/shared';
import { surface } from './index.js';

const deps = (env: Record<string, string> = {}) => ({ env, log: createLogger('test'), storageDir: '/nonexistent' });

describe('the memory surface', () => {
  it('declares no secrets, because it has no transport to hold one for', () => {
    expect(surface.name).toBe('memory');
    expect(surface.secrets).toEqual([]);
  });

  it('connects to a session that lets everyone in by default', async () => {
    const session = await surface.connect(deps());
    expect(session.defaultConversation).toBe('memory');
    expect(allowsUser(session.allowedUsers, 'anyone')).toBe(true);
  });

  it('honours an allowlist when the deployment sets one, and still fails closed on an empty one', async () => {
    const listed = await surface.connect(deps({ MEMORY_ALLOWED_USERS: 'U012, U345' }));
    expect(allowsUser(listed.allowedUsers, 'U012')).toBe(true);
    expect(allowsUser(listed.allowedUsers, 'U999')).toBe(false);
    const empty = await surface.connect(deps({ MEMORY_ALLOWED_USERS: '' }));
    expect(allowsUser(empty.allowedUsers, 'U012')).toBe(false);
  });

  it('records a posted card instead of sending it', async () => {
    const session = await surface.connect(deps());
    const ref = await session.postCard('memory', {
      id: 'demo',
      title: 'Approval needed',
      notice: 'Approval needed',
      body: [],
      actions: [],
    });
    expect(ref).toEqual({ surface: 'memory', conversation: 'memory', id: 'm1' });
  });
});
```

`MEMORY_ALLOWED_USERS=` set to empty in a test is a deliberate case: an operator who clears the
list gets nobody, not everybody, on this surface as on any other.

- [ ] **Step 13: Document `MEMORY_ALLOWED_USERS` and teach the env scan about `surfaces/`**

In `harness/core-tools/src/app/record-surface.ts`, add `'surfaces'` to `SOURCE_ROOTS`:

```ts
const SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'evals', 'scripts'];
```

and extend that constant's comment with one sentence: "`surfaces/` is there for the same reason
`packs/` is: an adapter reads its own variables, and a scan that did not walk it would let them
go undocumented — and would lose `SLACK_APPROVALS_CHANNEL`, which `surface.test.ts` anchors on."

In `.env.example`, under the existing `# --- Slack ---` heading and after `SLACK_ALLOWED_USERS=`,
add:

```
# Comma-separated user ids allowed to decide approvals on the in-process memory
# surface (@harness/surface-memory), which a developer runs the host with when
# they have no Slack workspace. Unset means everyone, which is safe only because
# nothing this surface posts leaves the process; set it to a list to narrow it,
# and an empty value means nobody, as on every other surface.
#MEMORY_ALLOWED_USERS=
```

A commented-out line is documentation as far as `envNamesFromExample` is concerned — it matches
`^#?\s*([A-Z][A-Z0-9_]*)=` — and an uncommented empty one would be read as "nobody" by the
adapter, which is not the default this variable has.

- [ ] **Step 14: Give the two adapters their architecture rules**

In `.dependency-cruiser.cjs`, add two `PACKAGES` rows after `pack-stories`:

```js
  { name: 'surface-slack', src: 'surfaces/slack/src', severity: 'error' },
  { name: 'surface-memory', src: 'surfaces/memory/src', severity: 'error' },
```

two `WORKSPACE_DIRS` entries after `'packs/stories'`:

```js
  'surfaces/slack',
  'surfaces/memory',
```

and one `GLOBAL_RULES` entry after `a-pack-never-imports-core-tools`:

```js
  {
    name: 'a-surface-imports-only-api-and-shared',
    comment:
      'A messaging adapter depends on @harness/surface-api and @harness/shared only. An edge into @harness/approvals would be a cycle — the host loads the adapter — and an edge into @harness/core-tools, @harness/db or a pack would tie one transport to one area of the product. Its own tests are not exempt: an adapter that needed the kernel to test itself would be an adapter that knows too much.',
    severity: 'error',
    from: { path: '^surfaces/' },
    to: {
      path: '^(harness|packs|evals|scripts)/',
      pathNot: ['^harness/surface-api/src/', '^harness/shared/src/'],
    },
  },
```

and extend the dot reporter's `collapsePattern` with the adapters' source trees, so the graph has
one node per adapter rather than one per file:

```js
          '^surfaces/[^/]+/src/(?!index[.]ts)',
```

- [ ] **Step 15: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations, now cruising surfaces/
pnpm format:check
pnpm -r test          # green, including the three byte pins
pnpm surface:record && git status --porcelain docs/architecture   # no output
```

`pnpm arch` printing "cruised 0 modules" for a glob means the glob is wrong, not that the code is
clean; the run must report the adapters' modules.

- [ ] **Step 16: Commit**

```bash
git add surfaces pnpm-workspace.yaml package.json pnpm-lock.yaml .dependency-cruiser.cjs .env.example harness/core-tools/src/app/record-surface.ts
git commit -m "feat(surfaces): add the Slack and memory adapters behind the surface contract"
```

No trailer of any kind.

---
### Task 4: `@harness/approvals` — the host, rewired to the contract

The package keeps its name and its path and loses every Slack import. Its poller posts on the
primary surface, its decisions edit and reply through whichever surface the row names, its
handlers are registered on every loaded surface, its sinks resolve a named surface out of the
effect payload, and `loadSurfaces` reads `HARNESS_SURFACES` the way the kernel reads
`HARNESS_PACKS`. `domain/render/` and `domain/slack/` are deleted: Task 3 already put that code,
byte-pinned, behind `@harness/surface-slack`.

**Files:**
- Create: `harness/approvals/src/domain/cards.ts` + `cards.test.ts`
- Create: `harness/approvals/src/domain/surfaces/registry.ts` + `registry.test.ts` + `dual-surface.test.ts`
- Create: `harness/approvals/src/domain/handlers.ts` + `handlers.test.ts`
- Create: `harness/approvals/src/host-vocabulary.test.ts`
- Modify: `harness/approvals/src/domain/{poller,decisions,sinks,runner}.ts` and their tests
- Modify: `harness/approvals/src/app/{main,child-env}.ts`, `child-env.test.ts`
- Modify: `harness/approvals/src/{index,testing}.ts`, `package.json`
- Delete: `harness/approvals/src/domain/render/{types,blocks,modal}.ts` and `blocks.test.ts`, `modal.test.ts`
- Delete: `harness/approvals/src/domain/slack/{types,web-client,fake,handlers}.ts` and `handlers.test.ts`
- Modify: `.dependency-cruiser.cjs`, `.env.example`

**Interfaces:**
- Consumes: from `@harness/surface-api` — `allowsUser`, the types `Card`, `CardLine`, `Form`,
  `MessageRef`, `NotePart`, `Surface`, `SurfaceDeps`, `SurfaceSession`; `SurfaceMessagePayloadShape`
  and `SurfaceFilePayloadShape` from the same package; `MemorySurface` from
  `@harness/surface-api/testing` and `fakeSlackSession` from `@harness/surface-slack/testing` in
  tests only.
- Produces:

  ```ts
  // domain/cards.ts
  type ApprovalRow = typeof approvals.$inferSelect
  const CARD_ID = 'harness_approval'
  const APPROVE_ACTION_ID = 'harness_approval_approve'
  const EDIT_ACTION_ID = 'harness_approval_edit'
  const DECLINE_ACTION_ID = 'harness_approval_decline'
  const EDIT_FORM_ID = 'harness_approval_edit_modal'
  const EDIT_NOTE_FIELD_ID = 'harness_approval_note'
  interface ApprovalMetadata { approvalId: string; conversation: string }
  function payloadPreview(payload: unknown, limit?: number): string
  function approvalCard(row: ApprovalRow, capabilities: { forms: boolean }): Card
  function decidedCard(row: ApprovalRow, outcome: { executed: boolean; tool?: string; error?: string }): Card
  function editForm(approvalId: string, conversation: string): Form
  function parseApprovalMetadata(raw: string): ApprovalMetadata | null

  // domain/surfaces/registry.ts
  interface LoadedSurfaces {
    readonly all: readonly SurfaceSession[]; readonly primary: SurfaceSession; readonly secrets: readonly string[];
    find(name: string): SurfaceSession | undefined; byName(name: string): SurfaceSession;
  }
  function surfacesOf(sessions: SurfaceSession[], secrets?: readonly string[]): LoadedSurfaces
  function loadSurfaces(names: string[], deps: SurfaceDeps): Promise<LoadedSurfaces>

  // domain/decisions.ts
  interface DecisionDeps { db: Db; surfaces: LoadedSurfaces; core: CoreToolsClient; client: string; now: () => Date }
  interface DecisionInput { approvalId: string; decision: 'approved' | 'declined'; decidedBy: string; surface: string; note?: string }
  type DecisionResult = { outcome: 'not_actionable' } | { outcome: 'wrong_surface' } | { outcome: 'decided'; status: 'approved' | 'declined'; execution?: ExecuteOutcome }
  function threadReplyText(row: ApprovalRow, mention: (userId: string) => string, execution?: ExecuteOutcome): string
  function decideApproval(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult>

  // domain/handlers.ts
  function registerApprovalHandlers(session: SurfaceSession, deps: DecisionDeps): void

  // domain/poller.ts
  interface PollDeps { db: Db; surface: SurfaceSession; client: string; now: () => Date }

  // domain/sinks.ts
  function surfaceSinks(surfaces: LoadedSurfaces, opts?: { outDir?: string }): SinkRegistry

  // domain/runner.ts
  interface RunnerDeps { db: Db; surfaces: LoadedSurfaces; core: CoreToolsClient; sinks: SinkRegistry; client: string; encryptionKey: Buffer; now: () => Date }

  // app/child-env.ts
  interface ChildEnvInput { env: NodeJS.ProcessEnv; client: string; storageRoot: string; surfaceSecrets: readonly string[] }
  const MODEL_PROVIDER_KEYS: readonly string[]
  function neverForwarded(surfaceSecrets: readonly string[]): string[]
  ```

**What does not change.** Every card the demo posts, every button id, every modal field, every
environment variable name the Slack adapter reads, and `docs/architecture/tool-surface.json`.

---

- [ ] **Step 1: Re-point the package's dependencies**

In `harness/approvals/package.json`, remove `"@slack/bolt"` and `"@slack/web-api"` from
`dependencies`, add `"@harness/surface-api": "workspace:*"` and `"@harness/surface-slack": "workspace:*"`
there, and add `"@harness/surface-memory": "workspace:*"` to `devDependencies`.

The split mirrors the kernel's: `@harness/pack-healthcare` is a dependency of
`@harness/core-tools` and `@harness/pack-stories` is a devDependency. The shipped image serves
Slack; the memory adapter is for the suite and for a developer's local run.

Run: `pnpm install`
Expected: the two Slack packages leave `harness/approvals/node_modules`, three workspace links
arrive.

- [ ] **Step 2: Write the failing card test**

Create `harness/approvals/src/domain/cards.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { approvalRow as row } from '../testing.js';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  approvalCard,
  decidedCard,
  editForm,
  parseApprovalMetadata,
  payloadPreview,
} from './cards.js';

const CAN = { forms: true };

describe('containsRestrictedPattern', () => {
  it('matches the shapes the redaction regexes protect', () => {
    expect(containsRestrictedPattern('ssn 123-45-6789 on file')).toBe(true);
    expect(containsRestrictedPattern('EIN 12-3456789')).toBe(true);
    expect(containsRestrictedPattern('DEA BR1234563')).toBe(true);
  });

  it('does not match ordinary roster content', () => {
    expect(containsRestrictedPattern('roster/aetna-abc123def456.csv')).toBe(false);
    expect(containsRestrictedPattern('license expires 2027-03-31 in TX')).toBe(false);
    expect(containsRestrictedPattern('NPI 1234567893')).toBe(false);
  });
});

describe('payloadPreview', () => {
  it('pretty-prints an ordinary payload', () => {
    expect(payloadPreview({ a: 1 })).toContain('"a": 1');
  });

  it('withholds a payload that fails the redaction check', () => {
    const preview = payloadPreview({ args: { note: 'ssn 123-45-6789' } });
    expect(preview).toBe('payload withheld: it did not pass the redaction check');
    expect(preview).not.toContain('123-45-6789');
  });

  it('truncates a long payload', () => {
    const preview = payloadPreview({ blob: 'x'.repeat(5000) }, 200);
    expect(preview.length).toBeLessThanOrEqual(220);
    expect(preview.endsWith('…')).toBe(true);
  });
});

describe('approvalCard', () => {
  /**
   * The whole card, as one object. The Slack adapter's own test holds the Block Kit this
   * renders to against what the app produced before Plan 6, so the pair of them is the proof
   * that the demo deployment's card did not move.
   */
  it('is exactly the card the Slack adapter pins its rendering against', () => {
    expect(approvalCard(row(), CAN)).toEqual({
      id: 'harness_approval',
      title: 'Approval needed',
      subtitle: 'forms_release (external) requested by hermes',
      notice: 'Approval needed: forms_release (external) requested by hermes',
      body: [
        {
          note: [
            { code: 'forms_release' },
            { text: ' · requested by ' },
            { code: 'hermes' },
            { text: ' · expires ' },
            { at: new Date('2026-09-16T12:00:00Z') },
          ],
        },
        { code: '{\n  "tool": "forms_release",\n  "args": {\n    "file_id": "roster/aetna-abc123def456.csv"\n  }\n}' },
      ],
      actions: [
        { id: APPROVE_ACTION_ID, label: 'Approve', style: 'primary', value: row().id },
        { id: EDIT_ACTION_ID, label: 'Edit', style: 'default', value: row().id },
        { id: DECLINE_ACTION_ID, label: 'Decline', style: 'danger', value: row().id },
      ],
      footer: [{ text: 'Approval ' }, { code: row().id }],
    });
  });

  it('leaves Edit off a surface that cannot open a form, rather than offering a button that fails', () => {
    expect(approvalCard(row(), { forms: false }).actions.map((a) => a.id)).toEqual([
      APPROVE_ACTION_ID,
      DECLINE_ACTION_ID,
    ]);
  });
});

describe('decidedCard', () => {
  const approved = row({ status: 'approved', decidedBy: 'U012', decidedAt: new Date('2026-09-15T12:05:00Z') });

  it('replaces the buttons with the decision and says who decided it', () => {
    const card = decidedCard(approved, { executed: true, tool: 'forms_release' });
    expect(card.actions).toEqual([]);
    expect(card.notice).toBe(`Approval ${row().id} approved`);
    expect(card.body.at(-1)).toEqual({
      note: [
        { icon: 'approved' },
        { text: ' Approved by ' },
        { user: 'U012' },
        { text: ' at ' },
        { at: new Date('2026-09-15T12:05:00Z') },
        { text: '.' },
        { text: '\nExecuted ' },
        { code: 'forms_release' },
        { text: '. Delivery is queued in the effects outbox.' },
      ],
    });
  });

  it('withholds a decline note that fails the redaction check', () => {
    const card = decidedCard(row({ status: 'declined', decidedBy: 'U012', decisionNote: 'wrong ssn 123-45-6789' }), {
      executed: false,
    });
    expect(JSON.stringify(card)).not.toContain('123-45-6789');
    expect(JSON.stringify(card)).toContain('note withheld');
  });

  it('withholds an execution error that fails the redaction check', () => {
    const card = decidedCard(approved, { executed: false, error: 'lookup failed for ssn 123-45-6789' });
    expect(JSON.stringify(card)).not.toContain('123-45-6789');
    expect(JSON.stringify(card)).toContain('Execution failed; see the audit log. Nothing was sent.');
  });

  it('shows a short safe execution error', () => {
    expect(JSON.stringify(decidedCard(approved, { executed: false, error: 'conversation_not_found' }))).toContain(
      'conversation_not_found',
    );
  });

  it('caps a long safe execution error at 300 characters', () => {
    const text = JSON.stringify(decidedCard(approved, { executed: false, error: 'x'.repeat(5000) }));
    const match = text.match(/x{50,}…/);
    expect(match).not.toBeNull();
    expect(match![0].length).toBeLessThanOrEqual(301);
  });

  it('renders the fallback when no execution error is given', () => {
    expect(JSON.stringify(decidedCard(approved, { executed: false }))).toContain(
      'Execution failed; see the audit log. Nothing was sent.',
    );
  });

  it('says someone, not a mention, when nobody is recorded as the decider', () => {
    const card = decidedCard(row({ status: 'declined' }), { executed: false });
    expect(JSON.stringify(card)).toContain('someone');
  });
});

describe('editForm', () => {
  it('carries the approval id and the conversation in its metadata', () => {
    const form = editForm(row().id, 'C0DEMO');
    expect(form.id).toBe(EDIT_FORM_ID);
    expect(form.fields.map((f) => f.id)).toEqual([EDIT_NOTE_FIELD_ID]);
    expect(JSON.parse(form.metadata)).toEqual({ approval_id: row().id, conversation: 'C0DEMO' });
  });
});

describe('parseApprovalMetadata', () => {
  it('round-trips what editForm encoded', () => {
    expect(parseApprovalMetadata(editForm(row().id, 'C0DEMO').metadata)).toEqual({
      approvalId: row().id,
      conversation: 'C0DEMO',
    });
  });

  it('still reads a form opened before Plan 6, which spelled the conversation `channel`', () => {
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id, channel: 'C0OLD' }))).toEqual({
      approvalId: row().id,
      conversation: 'C0OLD',
    });
  });

  it('returns null for anything that is not the expected shape', () => {
    expect(parseApprovalMetadata('not-json')).toBeNull();
    expect(parseApprovalMetadata(row().id)).toBeNull();
    expect(parseApprovalMetadata('{}')).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id }))).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: '', conversation: 'C0DEMO' }))).toBeNull();
    expect(parseApprovalMetadata(JSON.stringify({ approval_id: row().id, conversation: '' }))).toBeNull();
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @harness/approvals test cards`
Expected: FAIL — `Failed to resolve import "./cards.js"`.

- [ ] **Step 4: Write `domain/cards.ts`**

Create `harness/approvals/src/domain/cards.ts`:

```ts
import type { approvals } from '@harness/db';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Card, CardLine, Form, NotePart } from '@harness/surface-api';

/**
 * What an approval looks like to a human, in the contract's own words.
 *
 * Every string a reader sees is built here and nothing here knows how it will be drawn: no
 * markup, no emoji, no date format, no mention syntax. An adapter turns a `Card` into Block Kit,
 * an Adaptive Card or a plain message, and the host stays the same either way.
 */

export type ApprovalRow = typeof approvals.$inferSelect;

/** The kind of card this is. An adapter may derive its own ids from it; nothing else uses it. */
export const CARD_ID = 'harness_approval';
export const APPROVE_ACTION_ID = `${CARD_ID}_approve`;
export const EDIT_ACTION_ID = `${CARD_ID}_edit`;
export const DECLINE_ACTION_ID = `${CARD_ID}_decline`;
export const EDIT_FORM_ID = `${CARD_ID}_edit_modal`;
export const EDIT_NOTE_FIELD_ID = `${CARD_ID}_note`;

/** What `editForm` encodes into a form's metadata and `parseApprovalMetadata` decodes back. */
export interface ApprovalMetadata {
  approvalId: string;
  conversation: string;
}

export function payloadPreview(payload: unknown, limit = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? 'null';
  } catch {
    return 'payload could not be rendered';
  }
  if (containsRestrictedPattern(text)) return 'payload withheld: it did not pass the redaction check';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** A human-written note may contain anything, so it passes the same check as a payload. */
function safeNote(note: string | null): string | null {
  if (!note) return null;
  return containsRestrictedPattern(note) ? 'note withheld: it did not pass the redaction check' : note;
}

const EXECUTION_FAILURE_FALLBACK = 'Execution failed; see the audit log. Nothing was sent.';
const MAX_EXECUTION_ERROR_LENGTH = 300;

/**
 * A tool's error message is free text from the outside world (a remote API's response, a stack
 * frame), so it gets the same redaction check as a payload or a decision note before it can
 * appear on a card. The check runs on the untruncated string, so a restricted value split across
 * the 300-character cutoff cannot leak its first half.
 */
function executionFailureLine(error: string | undefined): string {
  if (!error || containsRestrictedPattern(error)) return EXECUTION_FAILURE_FALLBACK;
  const capped = error.length > MAX_EXECUTION_ERROR_LENGTH ? `${error.slice(0, MAX_EXECUTION_ERROR_LENGTH)}…` : error;
  return `Execution failed: ${capped}. Nothing was sent.`;
}

/** The two lines both cards open with: what was asked, and the arguments it was asked with. */
function headerLines(row: ApprovalRow): CardLine[] {
  return [
    {
      note: [
        { code: row.action },
        { text: ' · requested by ' },
        { code: row.requestedBy },
        { text: ' · expires ' },
        { at: row.expiresAt },
      ],
    },
    { code: payloadPreview(row.payload) },
  ];
}

function footer(row: ApprovalRow): NotePart[] {
  return [{ text: 'Approval ' }, { code: row.id }];
}

/**
 * The card a pending approval is posted as.
 *
 * Edit is offered only where a form can be opened. A surface without that capability gets two
 * buttons instead of three, which is honest and needs no fallback protocol — a button that
 * always failed would be worse than no button.
 */
export function approvalCard(row: ApprovalRow, capabilities: { forms: boolean }): Card {
  return {
    id: CARD_ID,
    title: 'Approval needed',
    subtitle: row.summary,
    notice: `Approval needed: ${row.summary}`,
    body: headerLines(row),
    actions: [
      { id: APPROVE_ACTION_ID, label: 'Approve', style: 'primary', value: row.id },
      ...(capabilities.forms
        ? [{ id: EDIT_ACTION_ID, label: 'Edit', style: 'default' as const, value: row.id }]
        : []),
      { id: DECLINE_ACTION_ID, label: 'Decline', style: 'danger', value: row.id },
    ],
    footer: footer(row),
  };
}

/** The same card after a human answered it: no buttons, and what happened underneath. */
export function decidedCard(
  row: ApprovalRow,
  outcome: { executed: boolean; tool?: string; error?: string },
): Card {
  const who: NotePart = row.decidedBy ? { user: row.decidedBy } : { text: 'someone' };
  const when: NotePart[] = row.decidedAt ? [{ text: ' at ' }, { at: row.decidedAt }] : [];
  const parts: NotePart[] = [];
  if (row.status === 'approved') {
    parts.push({ icon: 'approved' }, { text: ' Approved by ' }, who, ...when, { text: '.' });
    if (outcome.executed) {
      parts.push(
        { text: '\nExecuted ' },
        { code: outcome.tool ?? row.action },
        { text: '. Delivery is queued in the effects outbox.' },
      );
    } else {
      parts.push({ text: `\n${executionFailureLine(outcome.error)}` });
    }
  } else {
    parts.push({ icon: 'declined' }, { text: ' Declined by ' }, who, ...when, { text: '. Nothing was sent.' });
    const note = safeNote(row.decisionNote);
    if (note) parts.push({ text: `\nNote: ${note}` });
  }
  return {
    id: CARD_ID,
    title: 'Approval needed',
    subtitle: row.summary,
    notice: `Approval ${row.id} ${row.status}`,
    body: [...headerLines(row), { note: parts }],
    actions: [],
    footer: footer(row),
  };
}

/**
 * The note box Edit opens.
 *
 * The conversation travels in the metadata because a surface need not tell us where a form was
 * submitted from — Slack's view submission carries no conversation of its own for a modal opened
 * from a button — and the reply to the submission has to go somewhere.
 */
export function editForm(approvalId: string, conversation: string): Form {
  return {
    id: EDIT_FORM_ID,
    title: 'Send it back',
    submitLabel: 'Decline with note',
    cancelLabel: 'Cancel',
    intro:
      'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
    fields: [
      {
        id: EDIT_NOTE_FIELD_ID,
        label: 'What should change?',
        multiline: true,
        optional: false,
        maxLength: 1000,
        placeholder: 'Do not include patient or provider identifiers here.',
      },
    ],
    metadata: JSON.stringify({ approval_id: approvalId, conversation }),
  };
}

/**
 * Decode a form's metadata. Anything that fails to parse as this shape — a stale format, a
 * tampered value — yields `null` so the caller fails closed rather than guessing.
 *
 * `channel` is read as well as `conversation` for exactly one case: a note box opened before this
 * deployment upgraded and submitted after it. Three lines, and nobody loses a decision to a
 * restart.
 */
export function parseApprovalMetadata(raw: string): ApprovalMetadata | null {
  try {
    const parsed = JSON.parse(raw) as { approval_id?: unknown; conversation?: unknown; channel?: unknown };
    const where = [parsed.conversation, parsed.channel].find((v) => typeof v === 'string' && v !== '');
    if (typeof parsed.approval_id !== 'string' || parsed.approval_id === '') return null;
    if (typeof where !== 'string') return null;
    return { approvalId: parsed.approval_id, conversation: where };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Run it and watch it pass, then delete the render folder**

Run: `pnpm --filter @harness/approvals test cards`
Expected: PASS, 18 tests.

Then delete `harness/approvals/src/domain/render/` entirely — `types.ts`, `blocks.ts`,
`blocks.test.ts`, `modal.ts`, `modal.test.ts`. Their assertions live on in two places: the
plain-text ones in `cards.test.ts` above, and the Block Kit ones in
`surfaces/slack/src/render/blocks.test.ts` and `modal.test.ts`. The suite is red until Step 9
puts the new imports in place; that is expected inside one task and not at its end.

- [ ] **Step 6: Write the failing surface-registry test**

Create `harness/approvals/src/domain/surfaces/registry.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { MemorySurface } from '@harness/surface-api/testing';
import { loadSurfaces, surfacesOf } from './registry.js';

const deps = { env: {}, log: createLogger('test'), storageDir: '/nonexistent' };

describe('loadSurfaces', () => {
  it('loads an adapter by name and makes the first one primary', async () => {
    const surfaces = await loadSurfaces(['@harness/surface-memory'], deps);
    expect(surfaces.all).toHaveLength(1);
    expect(surfaces.primary.name).toBe('memory');
    expect(surfaces.byName('memory')).toBe(surfaces.primary);
    expect(surfaces.secrets).toEqual([]);
  });

  it('refuses an empty list rather than starting a host nobody can answer', async () => {
    await expect(loadSurfaces([], deps)).rejects.toThrow(ConfigError);
    await expect(loadSurfaces([], deps)).rejects.toThrow(/HARNESS_SURFACES/);
  });

  it('names the module, and nothing about the filesystem, when one cannot be resolved', async () => {
    const err = await loadSurfaces(['@harness/surface-nope'], deps).catch((caught: unknown) => caught);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toBe(
      'cannot load surface "@harness/surface-nope"; add it to @harness/approvals dependencies and run pnpm install',
    );
    expect((err as Error).message).not.toContain('node_modules');
  });

  it('refuses two adapters that answer to the same name', async () => {
    await expect(loadSurfaces(['@harness/surface-memory', '@harness/surface-memory'], deps)).rejects.toThrow(
      /both named "memory"/,
    );
  });
});

describe('surfacesOf', () => {
  it('answers by name and reports an unknown one as undefined, or throws when asked to insist', () => {
    const memory = new MemorySurface();
    const other = new MemorySurface({ name: 'other', conversation: 'other' });
    const surfaces = surfacesOf([memory, other], ['A_TOKEN']);
    expect(surfaces.primary).toBe(memory);
    expect(surfaces.find('other')).toBe(other);
    expect(surfaces.find('teams')).toBeUndefined();
    expect(() => surfaces.byName('teams')).toThrow(/no surface named "teams" is loaded/);
    expect(surfaces.secrets).toEqual(['A_TOKEN']);
  });

  it('refuses an empty list, because `primary` would be undefined and every caller assumes it', () => {
    expect(() => surfacesOf([])).toThrow(ConfigError);
  });
});
```

- [ ] **Step 7: Write the surface registry**

Create `harness/approvals/src/domain/surfaces/registry.ts`:

```ts
import { ConfigError, createLogger } from '@harness/shared';
import type { Surface, SurfaceDeps, SurfaceSession } from '@harness/surface-api';

const log = createLogger('approvals');

/** Shared between `loadSurfaces` and `surfacesOf`, which refuse an empty list the same way. */
const NO_SURFACES_MESSAGE = 'HARNESS_SURFACES names no surface; at least one is required';

/**
 * The surfaces this host connected to.
 *
 * **The primary surface rule.** The first entry of `HARNESS_SURFACES` is where approval cards are
 * posted. One approval, one card, one place to answer it; posting the same approval on several
 * surfaces at once is a feature, not a refactor, and waits for the deployment that needs it.
 * Every other surface is still live: a decision is accepted from whichever surface the row says
 * the card went to, and an effect addressed by name reaches any of them.
 */
export interface LoadedSurfaces {
  readonly all: readonly SurfaceSession[];
  readonly primary: SurfaceSession;
  /** The union of every loaded adapter's declared credentials, for the child-process allowlist. */
  readonly secrets: readonly string[];
  /** `undefined` when no loaded surface has that name; the caller decides whether that is an error. */
  find(name: string): SurfaceSession | undefined;
  /** Throws `ConfigError` when no loaded surface has that name. */
  byName(name: string): SurfaceSession;
}

/** A set over sessions that are already in hand. Every test uses it; `loadSurfaces` builds one. */
export function surfacesOf(sessions: SurfaceSession[], secrets: readonly string[] = []): LoadedSurfaces {
  if (sessions.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  return {
    all: sessions,
    primary: sessions[0],
    secrets,
    find: (name) => sessions.find((s) => s.name === name),
    byName(name) {
      const found = sessions.find((s) => s.name === name);
      if (!found) throw new ConfigError(`no surface named "${name}" is loaded`);
      return found;
    },
  };
}

/**
 * Load and connect the surfaces `HARNESS_SURFACES` names.
 *
 * The specifier is a variable, so this is the one place in the host that reaches an adapter at
 * all, and it reaches it the way a plug-in host does: by name, at startup, with no build-time
 * edge. `pnpm arch` forbids a static `@harness/surface-*` import anywhere else under `src/`.
 * It is deliberately the same shape as the kernel's `loadPacks`, down to the three ways a
 * dynamic import can fail, because an operator who has debugged one has debugged both:
 *
 *  - the specifier does not resolve — the resolver's own message carries absolute paths and a
 *    node_modules layout that does not belong in a container log, so it is replaced;
 *  - the module evaluates and throws a `ConfigError` — safe by construction, so it is re-raised
 *    with the adapter's name in front;
 *  - anything else — logged in full and replaced with a message naming only the adapter.
 *
 * Connecting happens here too, in order, so a surface that cannot be reached is a startup
 * failure rather than an approval nobody sees.
 */
export async function loadSurfaces(names: string[], deps: SurfaceDeps): Promise<LoadedSurfaces> {
  if (names.length === 0) throw new ConfigError(NO_SURFACES_MESSAGE);
  const declared: Surface[] = [];
  for (const name of names) {
    let module: { surface?: Surface };
    try {
      module = (await import(name)) as { surface?: Surface };
    } catch (err) {
      const code = (err as { code?: unknown } | null)?.code;
      if (code === 'ERR_MODULE_NOT_FOUND' || code === 'ERR_PACKAGE_PATH_NOT_EXPORTED') {
        throw new ConfigError(
          `cannot load surface "${name}"; add it to @harness/approvals dependencies and run pnpm install`,
        );
      }
      if (err instanceof ConfigError) throw new ConfigError(`surface "${name}": ${err.message}`);
      log.error(`surface "${name}" failed to initialise`, err);
      throw new ConfigError(`surface "${name}" failed to initialise`);
    }
    if (!module.surface) throw new ConfigError(`module "${name}" exports no \`surface\``);
    declared.push(module.surface);
  }

  // Two adapters answering to one name would make `approvals.surface` ambiguous: a decision
  // would be authorised against whichever allowlist loaded first, and a named effect would
  // reach whichever one `find` happened to return.
  const seen = new Set<string>();
  for (const surface of declared) {
    if (seen.has(surface.name)) {
      throw new ConfigError(
        `two loaded surfaces are both named "${surface.name}"; a surface name identifies one adapter`,
      );
    }
    seen.add(surface.name);
  }

  const sessions: SurfaceSession[] = [];
  for (const surface of declared) sessions.push(await surface.connect(deps));
  return surfacesOf(sessions, [...new Set(declared.flatMap((s) => [...s.secrets]))]);
}
```

- [ ] **Step 8: Run the registry test**

Run: `pnpm --filter @harness/approvals test registry`
Expected: PASS, 6 tests.

- [ ] **Step 9: Rewrite the poller, the decisions and the runner against the contract**

`harness/approvals/src/domain/poller.ts` — the claim protocol is unchanged in every respect
except what it writes:

```ts
import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { createLogger } from '@harness/shared';
import type { SurfaceSession } from '@harness/surface-api';
import { approvalCard } from './cards.js';

const log = createLogger('approvals');

export interface PollDeps {
  db: Db;
  /** Where cards are posted: the primary surface. */
  surface: SurfaceSession;
  client: string;
  now: () => Date;
}

export interface PollResult {
  posted: number;
  /** A row this run could not claim: another poller already had it. */
  orphaned: number;
}

/**
 * A claim with no `message_ref` older than this is assumed abandoned (a poller crashed, or its
 * process was killed, between claiming and posting) and is released so the row can be tried
 * again. The window is measured from `claimed_at`, so a row that was already old when first
 * claimed is not mistaken for a stale claim on the very next tick.
 */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Turn every pending approval that has no card yet into one.
 *
 * `conversation_id` doubles as the claim marker: a poller claims a row by setting it *before*
 * calling the surface, guarded on the row still being pending and unclaimed
 * (`conversation_id IS NULL`). Only one concurrent claim on the same row can win that guard, so
 * two pollers can never both post a card for it — the loser's claim affects zero rows and the row
 * is left for the winner or a later run. Posting happens only after a successful claim;
 * `message_ref` is written on success, and a failed post releases the claim so the row stays
 * postable on the next run instead of being stranded.
 *
 * Only a *failed post* releases the claim. If the post succeeds and writing `message_ref` is what
 * fails, the claim stays: the card is already in the conversation, and releasing it would post a
 * second one on the very next tick. That row is then recovered by the stale sweep below rather
 * than at once.
 */
export async function postPendingApprovals(deps: PollDeps, limit = 20): Promise<PollResult> {
  const now = deps.now();
  const staleBefore = new Date(now.getTime() - STALE_CLAIM_MS);

  await deps.db
    .update(approvals)
    .set({ surface: null, conversationId: null, claimedAt: null })
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.messageRef),
        isNotNull(approvals.conversationId),
        lte(approvals.claimedAt, staleBefore),
      ),
    );

  const pending = await deps.db
    .select()
    .from(approvals)
    .where(
      and(
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        isNull(approvals.messageRef),
        isNull(approvals.conversationId),
        gt(approvals.expiresAt, now),
      ),
    )
    .orderBy(asc(approvals.createdAt))
    .limit(limit);

  const result: PollResult = { posted: 0, orphaned: 0 };
  const conversation = deps.surface.defaultConversation;
  for (const row of pending) {
    const claimed = await deps.db
      .update(approvals)
      .set({ surface: deps.surface.name, conversationId: conversation, claimedAt: now })
      .where(and(eq(approvals.id, row.id), eq(approvals.status, 'pending'), isNull(approvals.conversationId)))
      .returning({ id: approvals.id });
    if (claimed.length === 0) {
      // Another poller claimed it between our select and our claim attempt.
      result.orphaned += 1;
      continue;
    }

    // Two separate try blocks, because the right recovery differs on each side of the post.
    // Before it, nothing was sent, so the claim is released and the next tick retries
    // immediately. After it, a card is live: releasing the claim there would put a second card
    // with a second set of working buttons next to it on the next tick.
    let ref: Awaited<ReturnType<typeof deps.surface.postCard>>;
    try {
      ref = await deps.surface.postCard(conversation, approvalCard(row, deps.surface.capabilities));
    } catch (err) {
      log.error(`could not post the card for ${row.id}`, err);
      await deps.db
        .update(approvals)
        .set({ surface: null, conversationId: null, claimedAt: null })
        .where(and(eq(approvals.id, row.id), isNull(approvals.messageRef)));
      continue;
    }

    try {
      await deps.db.update(approvals).set({ messageRef: ref.id }).where(eq(approvals.id, row.id));
      result.posted += 1;
    } catch (err) {
      // Deliberately no release. The row stays claimed with no message_ref, and the stale-claim
      // sweep above picks it up after STALE_CLAIM_MS — late enough for a transient database
      // failure to have been noticed.
      log.error(
        `posted the card for ${row.id} but could not record its message reference; ` +
          `leaving the claim in place so no duplicate is posted`,
        err,
      );
    }
  }
  return result;
}
```

The "accepted without a timestamp" check moved into the adapter, which is the layer that knows
what a timestamp is; `postCard` rejects there instead, which lands in the same `catch`.

`harness/approvals/src/domain/decisions.ts` — the logic is untouched; the addressing and the
wrong-surface refusal are new:

```ts
import { and, eq, gt, isNull, or } from 'drizzle-orm';
import { approvals, type Db } from '@harness/db';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { createLogger, describeError } from '@harness/shared';
import type { MessageRef } from '@harness/surface-api';
import type { CoreToolsClient, ExecuteOutcome } from './execute/types.js';
import { decidedCard, type ApprovalRow } from './cards.js';
import type { LoadedSurfaces } from './surfaces/registry.js';

const log = createLogger('approvals');

export interface DecisionDeps {
  db: Db;
  surfaces: LoadedSurfaces;
  core: CoreToolsClient;
  client: string;
  now: () => Date;
}

export interface DecisionInput {
  approvalId: string;
  decision: 'approved' | 'declined';
  decidedBy: string;
  /** The surface the decision arrived on. It has to be the one the card was posted to. */
  surface: string;
  note?: string;
}

export type DecisionResult =
  | { outcome: 'not_actionable' }
  | { outcome: 'wrong_surface' }
  | { outcome: 'decided'; status: 'approved' | 'declined'; execution?: ExecuteOutcome };

/** A human-written note may contain anything; the same guard as the card applies. */
function safeText(text: string | null): string | null {
  if (!text) return null;
  return containsRestrictedPattern(text) ? '(withheld: it did not pass the redaction check)' : text;
}

/**
 * The reply Hermes reads as a new turn. It reports what already happened — the host executes
 * before replying — so the agent never has to guess, and never says an action succeeded while it
 * is still pending. `mention` comes from the surface it will be posted on: only that surface
 * knows how it spells one.
 */
export function threadReplyText(
  row: ApprovalRow,
  mention: (userId: string) => string,
  execution?: ExecuteOutcome,
): string {
  const who = mention(row.decidedBy ?? 'unknown');
  if (row.status === 'approved') {
    if (execution?.status === 'executed') {
      return `Approval ${row.id} approved by ${who}. Executed \`${execution.tool}\`; delivery is queued in the effects outbox.`;
    }
    const reason = safeText(execution?.status === 'failed' ? execution.error : null) ?? 'see the audit log';
    return `Approval ${row.id} approved by ${who}, but execution failed: ${reason}. Nothing was sent.`;
  }
  const note = safeText(row.decisionNote);
  const tail = note ? ` Note: ${note}` : '';
  return `Approval ${row.id} declined by ${who}. Nothing was sent. Redo the action with the correction and request approval again.${tail}`;
}

/** Telling a human is best effort: a decision that is recorded must not be lost to a failed post. */
async function tellSurface(deps: DecisionDeps, row: ApprovalRow, execution: ExecuteOutcome | undefined): Promise<void> {
  if (!row.surface || !row.conversationId || !row.messageRef) {
    log.warn(`${row.id} has no card to update; the decision is recorded but not shown to a human`);
    return;
  }
  const session = deps.surfaces.find(row.surface);
  if (!session) {
    log.warn(`${row.id} was posted on surface "${row.surface}", which this process has not loaded`);
    return;
  }
  const ref: MessageRef = { surface: row.surface, conversation: row.conversationId, id: row.messageRef };
  const outcome = {
    executed: execution?.status === 'executed',
    tool: execution?.status === 'executed' ? execution.tool : undefined,
    error: execution?.status === 'failed' ? execution.error : undefined,
  };
  if (session.capabilities.update) {
    try {
      await session.updateCard(ref, decidedCard(row, outcome));
    } catch (err) {
      log.error(`could not edit the card for ${row.id}`, err);
    }
  }
  try {
    await session.postText(row.conversationId, threadReplyText(row, (id) => session.mention(id), execution), {
      replyTo: ref,
    });
  } catch (err) {
    log.error(`could not post the reply for ${row.id}`, err);
  }
}

/**
 * Record a human decision and, when it is an approval, run the parked action.
 *
 * This function is the only writer of `approvals.status` outside the core tools themselves. The
 * transition is one guarded UPDATE, so two people clicking at once produce one decision and one
 * execution; the loser gets `not_actionable`.
 *
 * A decision may only be taken on the surface the card was posted to. The read below is what
 * tells "answered from the wrong place" apart from "already decided", so the person pressing gets
 * an answer rather than silence; the same predicate is on the UPDATE, so the check is still
 * atomic if the poller claims the row in between.
 */
export async function decideApproval(deps: DecisionDeps, input: DecisionInput): Promise<DecisionResult> {
  const now = deps.now();
  const [existing] = await deps.db
    .select({ surface: approvals.surface })
    .from(approvals)
    .where(and(eq(approvals.id, input.approvalId), eq(approvals.client, deps.client)));
  if (existing && existing.surface !== null && existing.surface !== input.surface) {
    return { outcome: 'wrong_surface' };
  }

  const [row] = await deps.db
    .update(approvals)
    .set({
      status: input.decision,
      decidedBy: input.decidedBy,
      decidedAt: now,
      decisionNote: input.note ?? null,
    })
    .where(
      and(
        eq(approvals.id, input.approvalId),
        eq(approvals.client, deps.client),
        eq(approvals.status, 'pending'),
        gt(approvals.expiresAt, now),
        or(isNull(approvals.surface), eq(approvals.surface, input.surface)),
      ),
    )
    .returning();
  if (!row) return { outcome: 'not_actionable' };

  let execution: ExecuteOutcome | undefined;
  if (input.decision === 'approved') {
    try {
      execution = await deps.core.execute(row.id);
    } catch (err) {
      execution = { status: 'failed', error: describeError(err) };
    }
  }

  await tellSurface(deps, row, execution);
  return { outcome: 'decided', status: input.decision, execution };
}
```

`harness/approvals/src/domain/runner.ts` — three edits and no logic change: `RunnerDeps` drops
`api` and `channel` and gains `surfaces: LoadedSurfaces` (import the type from
`./surfaces/registry.js`, drop the `SlackApi` import); `runPollTick` becomes

```ts
export function runPollTick(deps: RunnerDeps): Promise<PollResult> {
  return postPendingApprovals({ db: deps.db, surface: deps.surfaces.primary, client: deps.client, now: deps.now });
}
```

and the `startRunner` comment's "a Slack outage" becomes "an outage on one surface".

- [ ] **Step 10: Write the failing handler test**

Create `harness/approvals/src/domain/handlers.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals } from '@harness/db';
import { parseAllowedUsers } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';
import { FakeCoreToolsClient, pendingApproval, useTestDb } from '../testing.js';
import { APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID, EDIT_FORM_ID, EDIT_NOTE_FIELD_ID } from './cards.js';
import { registerApprovalHandlers } from './handlers.js';
import { surfacesOf } from './surfaces/registry.js';

const db = useTestDb();
const now = () => new Date('2026-09-15T12:00:00Z');

async function seed() {
  const [row] = await db
    .insert(approvals)
    .values(pendingApproval({ surface: 'memory', conversationId: 'memory', messageRef: 'm1' }))
    .returning();
  return row;
}

function wire(allowed = 'U012', capabilities: Partial<MemorySurface['capabilities']> = {}) {
  const surface = new MemorySurface({ allowedUsers: parseAllowedUsers(allowed), capabilities });
  const core = new FakeCoreToolsClient();
  registerApprovalHandlers(surface, { db, surfaces: surfacesOf([surface]), core, client: 'demo-practice', now });
  return { surface, core };
}

describe('approval handlers', () => {
  it('approves and executes when an allowed user presses Approve', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([row.id]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('approved');
  });

  it('declines with no note when Decline is pressed', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(DECLINE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: null });
  });

  it('ignores an action that belongs to some other card', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press('someone_elses_button', row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('opens the note form on Edit and changes nothing yet', async () => {
    const row = await seed();
    const { surface } = wire();
    await surface.press(EDIT_ACTION_ID, row.id, 'U012');
    expect(surface.forms).toHaveLength(1);
    expect(surface.forms[0].trigger).toBe('memory-trigger');
    expect(JSON.parse(surface.forms[0].form.metadata)).toEqual({ approval_id: row.id, conversation: 'memory' });
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('declines with the note when the form is submitted', async () => {
    const row = await seed();
    const { surface, core } = wire();
    await surface.press(EDIT_ACTION_ID, row.id, 'U012');
    await surface.submit(EDIT_FORM_ID, { [EDIT_NOTE_FIELD_ID]: 'Use the Q4 roster.' }, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after).toMatchObject({ status: 'declined', decisionNote: 'Use the Q4 roster.' });
  });

  it('trusts the conversation carried in the form metadata', async () => {
    const row = await seed();
    const { surface } = wire('');
    await surface.submit(
      EDIT_FORM_ID,
      { [EDIT_NOTE_FIELD_ID]: '' },
      'U012',
      { metadata: JSON.stringify({ approval_id: row.id, conversation: 'elsewhere' }) },
    );
    expect(surface.privates).toHaveLength(1);
    expect(surface.privates[0]).toMatchObject({ conversation: 'elsewhere', userId: 'U012' });
  });

  it('tells the user when the form metadata cannot be read', async () => {
    const { surface } = wire();
    await surface.submit(EDIT_FORM_ID, {}, 'U012', { metadata: 'not-json' });
    expect(surface.privates[0]).toMatchObject({ userId: 'U012', text: 'That approval no longer exists.' });
  });

  it('posts nothing when the button names an approval that does not exist', async () => {
    const { surface, core } = wire();
    await surface.press(APPROVE_ACTION_ID, '22222222-2222-4222-8222-222222222222', 'U012');
    expect(core.executed).toEqual([]);
    expect(surface.cards).toHaveLength(0);
  });

  it("refuses a user who is not on this surface's allowlist, and tells them so", async () => {
    const row = await seed();
    const { surface, core } = wire('U012');
    await surface.press(APPROVE_ACTION_ID, row.id, 'U999');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(surface.privates[0]).toMatchObject({ userId: 'U999', text: 'You are not an approver for this workspace.' });
  });

  it('fails closed when the allowlist is empty, refusing even a would-be approver', async () => {
    const row = await seed();
    const { surface, core } = wire('');
    await surface.press(APPROVE_ACTION_ID, row.id, 'U012');
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
    expect(surface.privates[0].text).toBe('You are not an approver for this workspace.');
  });

  it('rejects a malformed approval id without throwing', async () => {
    const { surface, core } = wire();
    await expect(surface.press(APPROVE_ACTION_ID, 'not-a-uuid', 'U012')).resolves.toBeUndefined();
    expect(core.executed).toEqual([]);
    expect(surface.privates[0]).toMatchObject({ userId: 'U012', text: 'That approval no longer exists.' });
  });

  it('logs rather than throwing when the surface cannot take a private reply', async () => {
    const row = await seed();
    const { surface, core } = wire('U012', { privateReply: false });
    await expect(surface.press(APPROVE_ACTION_ID, row.id, 'U999')).resolves.toBeUndefined();
    expect(core.executed).toEqual([]);
    expect(surface.privates).toHaveLength(0);
  });
});
```

- [ ] **Step 11: Write `domain/handlers.ts`**

Create `harness/approvals/src/domain/handlers.ts`:

```ts
import { createLogger } from '@harness/shared';
import { allowsUser, type ActionEvent, type FormEvent, type SurfaceSession } from '@harness/surface-api';
import { decideApproval, type DecisionDeps, type DecisionResult } from './decisions.js';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  editForm,
  parseApprovalMetadata,
} from './cards.js';

const log = createLogger('approvals');

const UNAUTHORIZED_TEXT = 'You are not an approver for this workspace.';
const NOT_FOUND_TEXT = 'That approval no longer exists.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort notice to the one person who acted; a failure here is only logged. */
async function tellUser(session: SurfaceSession, conversation: string, userId: string, text: string): Promise<void> {
  if (!session.capabilities.privateReply) {
    // Saying it out loud instead would tell the whole conversation that someone tried.
    log.warn(`surface "${session.name}" cannot send a private note; ${userId} was refused silently`);
    return;
  }
  try {
    await session.postPrivate(conversation, userId, text);
  } catch (err) {
    log.error(`could not send a private notice to ${userId}`, err);
  }
}

/**
 * True when this person may act on approvals *on this surface at all*. Checked before every
 * decision and before the id is even looked at, so someone unauthorised learns nothing about
 * whether the approval exists. Allowlists are per surface: a Teams identity and a Slack identity
 * are different people until something says otherwise.
 */
async function authorize(
  session: SurfaceSession,
  conversation: string,
  userId: string,
  approvalId: string,
): Promise<boolean> {
  if (allowsUser(session.allowedUsers, userId)) return true;
  log.warn(`user ${userId} is not an approver on surface "${session.name}"; refused action on ${approvalId}`);
  await tellUser(session, conversation, userId, UNAUTHORIZED_TEXT);
  return false;
}

/** A value that is not a well-formed uuid can never name a row. */
async function validId(session: SurfaceSession, conversation: string, userId: string, id: string): Promise<boolean> {
  if (UUID_RE.test(id)) return true;
  log.warn(`rejected a malformed approval id from ${userId}`);
  await tellUser(session, conversation, userId, NOT_FOUND_TEXT);
  return false;
}

function report(approvalId: string, result: DecisionResult): void {
  if (result.outcome === 'not_actionable') {
    log.info(`${approvalId} was not actionable (already decided, expired, or another client's)`);
  }
}

/**
 * Authorise, check the id, decide, and answer.
 *
 * A decision arriving on a surface the card was not posted to gets the same answer as an
 * approval that does not exist, and for the same reason: from where the person is standing, it
 * does not. One approval has one card in one place.
 */
async function decide(
  session: SurfaceSession,
  deps: DecisionDeps,
  event: { conversation: string; userId: string; value: string },
  decision: 'approved' | 'declined',
  note?: string,
): Promise<void> {
  if (!(await authorize(session, event.conversation, event.userId, event.value))) return;
  if (!(await validId(session, event.conversation, event.userId, event.value))) return;
  const result = await decideApproval(deps, {
    approvalId: event.value,
    decision,
    decidedBy: event.userId,
    surface: session.name,
    note,
  });
  if (result.outcome === 'wrong_surface') {
    log.warn(`${event.value} was answered on surface "${session.name}", which is not where its card is`);
    await tellUser(session, event.conversation, event.userId, NOT_FOUND_TEXT);
    return;
  }
  report(event.value, result);
}

/**
 * Wire one surface's buttons and forms to the decision path.
 *
 * Called once per loaded surface. A decision is accepted from whichever surface posted the card,
 * so every loaded surface is wired, not only the primary one.
 */
export function registerApprovalHandlers(session: SurfaceSession, deps: DecisionDeps): void {
  if (session.allowedUsers.size === 0) {
    log.warn(`surface "${session.name}" has an empty allowlist; every decision there is refused`);
  }

  session.onAction(async (event: ActionEvent) => {
    try {
      if (event.actionId === APPROVE_ACTION_ID) await decide(session, deps, event, 'approved');
      else if (event.actionId === DECLINE_ACTION_ID) await decide(session, deps, event, 'declined');
      else if (event.actionId === EDIT_ACTION_ID) await openEdit(session, deps, event);
      // Anything else belongs to a card this host did not post.
    } catch (err) {
      log.error(`the ${event.actionId} handler failed`, err);
    }
  });

  session.onFormSubmit(async (event: FormEvent) => {
    if (event.formId !== EDIT_FORM_ID) return;
    try {
      const metadata = parseApprovalMetadata(event.metadata);
      if (!metadata) {
        // No conversation to address a private notice to; fall back to whatever the surface
        // reported, and only log if even that is unavailable.
        log.warn('a form submission arrived with unreadable metadata');
        const conversation = event.conversation || session.defaultConversation;
        await tellUser(session, conversation, event.userId, NOT_FOUND_TEXT);
        return;
      }
      const note = (event.values[EDIT_NOTE_FIELD_ID] ?? '').trim();
      await decide(
        session,
        deps,
        { conversation: metadata.conversation, userId: event.userId, value: metadata.approvalId },
        'declined',
        note === '' ? undefined : note,
      );
    } catch (err) {
      log.error('the form submission handler failed', err);
    }
  });
}

/** Edit never releases anything: it opens a note box, and submitting it declines with that note. */
async function openEdit(session: SurfaceSession, deps: DecisionDeps, event: ActionEvent): Promise<void> {
  if (!(await authorize(session, event.conversation, event.userId, event.value))) return;
  if (!(await validId(session, event.conversation, event.userId, event.value))) return;
  if (!event.trigger) {
    log.warn(`Edit on ${event.value} arrived with no trigger; cannot open the form`);
    return;
  }
  try {
    await session.openForm(event.trigger, editForm(event.value, event.conversation));
  } catch (err) {
    log.error('could not open the note form', err);
  }
}
```

`deps` is unused by `openEdit` today but is on its signature deliberately: every other handler
takes it, and a future confirmation step reads the row before opening the box. If the linter
objects, take it off and add it back when it is needed — do not silence the rule with a disable.

- [ ] **Step 12: Rewrite the sinks**

Replace `harness/approvals/src/domain/sinks.ts` with:

```ts
import path from 'node:path';
import type { SinkHandler, SinkRegistry } from '@harness/core-tools/effects';
import { assertInsideRoot, SurfaceError } from '@harness/shared';
import {
  SurfaceFilePayloadShape,
  SurfaceMessagePayloadShape,
  type Conversation,
  type MessageRef,
  type SurfaceSession,
} from '@harness/surface-api';
import * as z from 'zod/v4';
import type { LoadedSurfaces } from './surfaces/registry.js';

/**
 * Validate an outbox payload without ever repeating it. A zod message can name a key and a type,
 * and `tool_effects.last_error` is stored in plaintext, so the sink reports only that validation
 * failed and leaves the detail to the staging tool, which knows what it wrote.
 */
function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, sink: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`${sink} payload failed validation`);
  return parsed.data;
}

/**
 * Reject a staged path that does not resolve inside `root`. The staging tool already confines the
 * path it stages to the out tree, so this is defence in depth against a corrupted or
 * otherwise-produced row, not the primary guarantee.
 *
 * Lexical resolution alone is not enough, because the adapter that reads the file follows
 * symlinks: a link planted under the out tree passes `path.relative` and then uploads whatever it
 * points at. Both sides are compared as real paths too.
 */
async function assertUnderRoot(candidate: string, root: string, effectId: string): Promise<void> {
  await assertInsideRoot(
    // Resolve against the working directory first. `assertInsideRoot` resolves a relative
    // candidate *inside `root`*, which would silently loosen this check for a relative path.
    path.resolve(candidate),
    root,
    (reason) => {
      throw new Error(
        reason === 'unreadable'
          ? `surface_file: staged file unavailable (effect ${effectId})`
          : `surface_file: path outside the release directory (effect ${effectId})`,
      );
    },
    // realpath errors (ELOOP, EACCES, ENOTDIR) carry the absolute path in their message; keep it
    // out of the plaintext `tool_effects.last_error`.
    { onUnreadable: 'escape' },
  );
}

/**
 * Which surface and which conversation an effect is addressed to.
 *
 * `payload.surface` names one of the loaded surfaces; with none, it is the primary. The
 * conversation is the payload's, or that surface's default. `channel` is read after
 * `conversation` for one reason: a row staged before migration 0009 spells it that way and is
 * still in the outbox.
 */
function target(
  surfaces: LoadedSurfaces,
  payload: { surface?: string | null; conversation?: string | null; channel?: string | null },
  sink: string,
  effectId: string,
): { session: SurfaceSession; conversation: Conversation['id'] } {
  const name = payload.surface ?? null;
  const session = name === null ? surfaces.primary : surfaces.find(name);
  if (!session) throw new Error(`${sink}: no surface named "${name}" is loaded (effect ${effectId})`);
  return { session, conversation: payload.conversation ?? payload.channel ?? session.defaultConversation };
}

/**
 * An adapter's failure is expected and is recorded on the row; anything else is a bug and keeps
 * its own message. Either way the effect id goes on, because that is what an operator greps for.
 */
async function viaSurface<T>(sink: string, effectId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SurfaceError) throw new Error(`${sink}: ${err.message} (effect ${effectId})`);
    throw err;
  }
}

const replyRef = (session: SurfaceSession, conversation: string, id: string | undefined): MessageRef | undefined =>
  id === undefined ? undefined : { surface: session.name, conversation, id };

/**
 * The two senders the effects outbox drains through.
 *
 * Both are generic: the dispatcher looks a sink up by the string on the row, and these two names
 * carry no transport in them. Each returns only identifiers — the dispatcher stores the return
 * value in `tool_effects.result` as plaintext jsonb, so nothing from the payload may come back out.
 */
export function surfaceSinks(surfaces: LoadedSurfaces, opts: { outDir?: string } = {}): SinkRegistry {
  const messageSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(SurfaceMessagePayloadShape, payload, 'surface_message');
    const { session, conversation } = target(surfaces, p, 'surface_message', effect.id);
    const ref = await viaSurface('surface_message', effect.id, () =>
      session.postText(conversation, p.text, { replyTo: replyRef(session, conversation, p.reply_to) }),
    );
    return { surface: session.name, conversation, message_id: ref.id };
  };

  const fileSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(SurfaceFilePayloadShape, payload, 'surface_file');
    const { session, conversation } = target(surfaces, p, 'surface_file', effect.id);
    // `outDir` is the fill output tree (`<HARNESS_STORAGE_DIR>/out`), not the whole store: the
    // rest of it holds ingested documents, which must never be uploadable. Optional so a test
    // that stages a path under an arbitrary tmpdir is unaffected; main.ts always passes it.
    if (opts.outDir) await assertUnderRoot(p.path, opts.outDir, effect.id);
    await viaSurface('surface_file', effect.id, () =>
      session.uploadFile(conversation, {
        path: p.path,
        filename: p.filename,
        // The staging tool already wrote a restricted-free label; reuse it rather than composing
        // a new comment out of payload values.
        comment: effect.summary,
        replyTo: replyRef(session, conversation, p.reply_to),
      }),
    );
    return { surface: session.name, conversation, filename: p.filename };
  };

  return {
    surface_message: messageSink,
    surface_file: fileSink,
    // The two names the kernel still stages under until the next task renames them. Migration
    // 0009 renamed the rows that were in flight; these cover the ones a running kernel writes
    // between this commit and that one. **Task 5 deletes both lines in the commit that stops
    // staging them** — a sink name nothing writes is a name nobody can look up.
    slack_message: messageSink,
    slack_file: fileSink,
  };
}
```

- [ ] **Step 13: Rewrite the sink test**

Replace `harness/approvals/src/domain/sinks.test.ts` with:

```ts
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { MemorySurface } from '@harness/surface-api/testing';
import { fakeSlackSession } from '@harness/surface-slack/testing';
import { useTestDb } from '../testing.js';
import { surfaceSinks } from './sinks.js';
import { surfacesOf } from './surfaces/registry.js';

const db = useTestDb();
const key = randomBytes(32);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-sink-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stage(sink: string, payload: unknown, summary: string, idempotencyKey: string): Promise<void> {
  await db.insert(toolEffects).values({
    client: 'test',
    tool: 'test_tool',
    sink,
    idempotencyKey,
    payloadEncrypted: encrypt(JSON.stringify(payload), key),
    summary,
  });
}

/** The primary surface is memory; a second, `other`, is loaded beside it. */
function wire(opts: { outDir?: string } = {}) {
  const primary = new MemorySurface();
  const other = new MemorySurface({ name: 'other', conversation: 'other-default' });
  return { primary, other, sinks: surfaceSinks(surfacesOf([primary, other]), opts) };
}

describe('surface sinks', () => {
  it('posts a staged message on the primary surface and records only identifiers', async () => {
    await stage('surface_message', { text: '3 credentials expire within 90 days.' }, 'expirations digest', 'k1');
    const { primary, sinks } = wire();
    const out = await dispatchStagedEffects(db, sinks, { key });
    expect(out).toMatchObject({ dispatched: 1, failed: 0, skipped: 0 });
    expect(primary.texts[0]).toMatchObject({ conversation: 'memory', text: '3 credentials expire within 90 days.' });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('dispatched');
    expect(row.result).toEqual({ surface: 'memory', conversation: 'memory', message_id: 'm1' });
  });

  it('honours a conversation carried on the payload', async () => {
    await stage('surface_message', { text: 'hello', conversation: 'elsewhere' }, 'note', 'k2');
    const { primary, sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    expect(primary.texts[0].conversation).toBe('elsewhere');
  });

  it('sends to the surface the payload names, not to the primary', async () => {
    await stage('surface_message', { text: 'hello', surface: 'other' }, 'note', 'k3');
    const { primary, other, sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    expect(primary.texts).toHaveLength(0);
    expect(other.texts[0]).toMatchObject({ conversation: 'other-default', text: 'hello' });
  });

  it('reads a row staged before migration 0009, which addressed itself with `channel`', async () => {
    await stage('surface_message', { text: 'hello', channel: 'C0OLD' }, 'note', 'k4');
    const { primary, sinks } = wire();
    const out = await dispatchStagedEffects(db, sinks, { key });
    expect(out.dispatched).toBe(1);
    expect(primary.texts[0].conversation).toBe('C0OLD');
  });

  it('is still registered under the two names the kernel stages today', async () => {
    await stage('slack_message', { text: 'from the old kernel' }, 'note', 'k5');
    const { primary, sinks } = wire();
    expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ dispatched: 1 });
    expect(primary.texts[0].text).toBe('from the old kernel');
  });

  it('fails the row when the payload names a surface this host has not loaded', async () => {
    await stage('surface_message', { text: 'hello', surface: 'teams' }, 'note', 'k6');
    const { sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe(`surface_message: no surface named "teams" is loaded (effect ${row.id})`);
  });

  it('uploads a staged file with the effect summary as the comment', async () => {
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
    await stage('surface_file', { path: file, filename: 'aetna-roster.csv', file_id: 'roster/aetna-abc.csv' }, 'Release aetna-roster.csv', 'k7');
    const { primary, sinks } = wire();
    expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ dispatched: 1 });
    expect(primary.uploads[0]).toMatchObject({
      conversation: 'memory',
      filename: 'aetna-roster.csv',
      comment: 'Release aetna-roster.csv',
    });
    const [row] = await db.select().from(toolEffects);
    expect(row.result).toEqual({ surface: 'memory', conversation: 'memory', filename: 'aetna-roster.csv' });
  });

  it('leaves the row staged and records a short error when the surface fails', async () => {
    await stage('surface_message', { text: 'hello' }, 'note', 'k8');
    const { primary, sinks } = wire();
    primary.failWith = 'conversation_not_found';
    const out = await dispatchStagedEffects(db, sinks, { key, maxAttempts: 3 });
    expect(out).toMatchObject({ retried: 1, dispatched: 0 });
    const [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ status: 'staged', attempts: 1 });
    expect(row.lastError).toContain('conversation_not_found');
  });

  it('never repeats payload content in a validation error', async () => {
    await stage('surface_message', { text: 123, secret: '123-45-6789' }, 'bad payload', 'k9');
    const { sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe('surface_message payload failed validation');
    expect(row.lastError).not.toContain('123-45-6789');
  });

  it('skips a sink it does not register', async () => {
    await stage('email', { to: 'x' }, 'email', 'k10');
    const { sinks } = wire();
    expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ skipped: 1, dispatched: 0 });
  });

  it('never leaks a filesystem path when the staged file is missing', async () => {
    const missing = path.join(dir, 'missing.csv');
    // The Slack adapter is the one that reads the bytes, so it is the surface that can fail that
    // way; the memory surface records a path and never opens it.
    await stage('surface_file', { path: missing, filename: 'missing.csv', conversation: 'C0DEMO' }, 'missing file', 'k11');
    const { session, api } = fakeSlackSession();
    await dispatchStagedEffects(db, surfaceSinks(surfacesOf([session])), { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe(`surface_file: slack: the staged file could not be read (effect ${row.id})`);
    expect(row.lastError).not.toContain(missing);
    expect(api.uploads).toHaveLength(0);
  });

  it('refuses a staged path outside the configured storage root before reading it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      // Deliberately does not exist: if the sink read it before checking the root, the error
      // would say "staged file unavailable" instead, so this message proves the check ran first.
      const outside = path.join(dir, 'not-in-root.csv');
      await stage('surface_file', { path: outside, filename: 'not-in-root.csv' }, 'outside root', 'k13');
      const { primary, sinks } = wire({ outDir: root });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a file elsewhere in the store when the sink is scoped to the out tree', async () => {
    const store = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      const ingested = path.join(store, 'documents');
      await mkdir(ingested, { recursive: true });
      const doc = path.join(ingested, 'w9.pdf');
      await writeFile(doc, 'a scanned W-9');
      await mkdir(path.join(store, 'out'), { recursive: true });
      await stage('surface_file', { path: doc, filename: 'w9.pdf' }, 'Release w9.pdf', 'k14');
      const { primary, sinks } = wire({ outDir: path.join(store, 'out') });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('refuses a staged path that reaches outside the storage root through a symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      // The file exists and the path is lexically inside the root, so a `path.relative` check
      // would pass it and the read would follow the link.
      const secret = path.join(dir, 'restricted.csv');
      await writeFile(secret, 'ssn,123-45-6789\n');
      await mkdir(path.join(root, 'out'), { recursive: true });
      await symlink(secret, path.join(root, 'out', 'aetna-roster.csv'));
      await stage(
        'surface_file',
        { path: path.join(root, 'out', 'aetna-roster.csv'), filename: 'aetna-roster.csv' },
        'Release aetna-roster.csv',
        'k15',
      );
      const { primary, sinks } = wire({ outDir: root });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uploads a staged file whose path resolves inside the storage root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      const sub = path.join(root, 'out', 'roster');
      await mkdir(sub, { recursive: true });
      const file = path.join(sub, 'aetna-roster.csv');
      await writeFile(file, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
      await stage('surface_file', { path: file, filename: 'aetna-roster.csv' }, 'Release aetna-roster.csv', 'k16');
      const { primary, sinks } = wire({ outDir: root });
      expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ dispatched: 1 });
      expect(primary.uploads[0]).toMatchObject({ filename: 'aetna-roster.csv' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 14: Re-point the poller, decision and runner tests**

`harness/approvals/src/domain/poller.test.ts`: the deps literal becomes
`{ db, surface, client: 'demo-practice', now }` where `surface` is a `MemorySurface`; every
`slack.posts` assertion becomes `surface.cards`; `FakeSlack` is gone. The claim assertions read
`conversationId` and `messageRef`, the stale seed sets `surface: 'memory'` and
`conversationId: 'memory-stale'`, and the racing-poller case becomes a subclass rather than a
wrapper, because `MemorySurface`'s methods live on its prototype and a spread would drop them:

```ts
/** A surface that starts a second poll run in the middle of the first one's post. */
class RacingSurface extends MemorySurface {
  second: PollResult | undefined;
  private racing = false;

  override async postCard(conversation: string, card: Card): Promise<MessageRef> {
    if (!this.racing) {
      this.racing = true;
      // By the time this fires, the first run has already claimed the row but has not yet
      // posted, so a second poller starting here must see it as claimed and post nothing.
      this.second = await postPendingApprovals({ db, surface: this, client: 'demo-practice', now });
    }
    return super.postCard(conversation, card);
  }
}
```

with the case itself reading:

```ts
  it('produces exactly one post when a second poll run starts while the first is posting', async () => {
    await db.insert(approvals).values(pendingApproval());
    const surface = new RacingSurface();
    const out = await postPendingApprovals({ db, surface, client: 'demo-practice', now });
    expect(surface.second).toMatchObject({ posted: 0, orphaned: 0 });
    expect(out).toMatchObject({ posted: 1, orphaned: 0 });
    expect(surface.cards).toHaveLength(1);
  });
```

Two assertions change meaning and both are worth keeping explicit:

```ts
    expect(surface.cards[0].card.title).toBe('Approval needed');
    expect(rows.every((r) => r.messageRef !== null && r.conversationId === 'memory' && r.surface === 'memory')).toBe(true);
```

`harness/approvals/src/domain/decisions.test.ts`: `deps` becomes
`{ db, surfaces: surfacesOf([surface]), core, client: 'demo-practice', now }`; the seed sets
`surface: 'memory', conversationId: 'memory', messageRef: 'm1'`; `api.updates` becomes
`surface.cards` (the memory surface replaces the card in place, so assert
`surface.cards[0].card.actions` is empty) and `api.posts[0]` becomes `surface.texts[0]`; every
`decideApproval` call gains `surface: 'memory'`. Add one case, which is the new behaviour:

```ts
  it('refuses a decision that arrives on a surface the card was not posted to', async () => {
    const row = await seed();
    const elsewhere = new MemorySurface({ name: 'other', conversation: 'other' });
    const surfaces = surfacesOf([new MemorySurface(), elsewhere]);
    const core = new FakeCoreToolsClient();
    const res = await decideApproval({ db, surfaces, core, client: 'demo-practice', now }, {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: 'U012',
      surface: 'other',
    });
    expect(res).toEqual({ outcome: 'wrong_surface' });
    expect(core.executed).toEqual([]);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });
```

and change the `threadReplyText` case to pass a mention function:

```ts
    const text = threadReplyText(row, (id) => `@${id}`);
```

`harness/approvals/src/domain/runner.test.ts`: `makeDeps` becomes

```ts
function makeDeps(surface: MemorySurface, core: FakeCoreToolsClient): RunnerDeps {
  const surfaces = surfacesOf([surface]);
  return { db, surfaces, core, sinks: surfaceSinks(surfaces), client: 'demo-practice', encryptionKey: key, now };
}
```

every staged fixture's `sink` becomes `surface_message` or `surface_file`, `api.posts.map(p => p.text)`
becomes `surface.texts.map(t => t.text)`, `api.uploads[0].filename` becomes
`surface.uploads[0].filename`, and the two `summary` strings lose their "to Slack" tail.

- [ ] **Step 15: Rewrite the entrypoint and the child environment**

Replace `harness/approvals/src/app/main.ts` with:

```ts
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { createDb, loadKey } from '@harness/db';
import { outRoot } from '@harness/core-tools/storage';
import { createLogger, numberFromEnv, optionalEnv, requiredEnv } from '@harness/shared';
import { surfaceSinks } from '../domain/sinks.js';
import { loadSurfaces } from '../domain/surfaces/registry.js';
import { createMcpCoreToolsClient } from '../domain/execute/mcp-client.js';
import { registerApprovalHandlers } from '../domain/handlers.js';
import { collectHealth, startRunner } from '../domain/runner.js';
import { DEFAULT_HEALTH_BIND, startHealthServer } from '../domain/health.js';
import { coreToolsChildEnv } from './child-env.js';

const log = createLogger('approvals');

// One level deeper than the package's `src/`, so four segments up is the
// repository root: src/app -> src -> approvals -> harness -> <repo>.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });

/**
 * Which messaging surfaces this host serves, comma-separated package names, the first of them
 * primary. Defaults to the only adapter a deployment has today, so a deployment that sets nothing
 * behaves exactly as it did. Same shape as the kernel's `HARNESS_PACKS`.
 */
function surfaceNames(): string[] {
  return (optionalEnv('HARNESS_SURFACES') ?? '@harness/surface-slack')
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '');
}

const client = process.env.HARNESS_CLIENT ?? 'default';
const storageRoot = requiredEnv('HARNESS_STORAGE_DIR');

const { db, close: closeDb } = createDb();

// Connected before anything else is built: the child environment subtracts the credentials the
// loaded adapters declare, and the runner posts through them.
const surfaces = await loadSurfaces(surfaceNames(), { env: process.env, log, storageDir: storageRoot });

const core = createMcpCoreToolsClient({
  command: 'pnpm',
  args: ['--dir', repoRoot, '--filter', '@harness/core-tools', 'start'],
  env: coreToolsChildEnv({ env: process.env, client, storageRoot, surfaceSecrets: surfaces.secrets }),
});

const deps = {
  db,
  surfaces,
  core,
  // The out tree, not the whole store. A release already narrows to `<root>/out`, and a backstop
  // that accepts more than the thing it backs up is not a backstop: the rest of the store holds
  // ingested documents, which must never be uploadable.
  sinks: surfaceSinks(surfaces, { outDir: outRoot(storageRoot) }),
  client,
  encryptionKey: loadKey(),
  now: () => new Date(),
};

// Every loaded surface, not only the primary one: cards are posted in one place, but a decision
// is accepted from whichever surface posted the card.
for (const session of surfaces.all) registerApprovalHandlers(session, deps);

const runner = startRunner(deps, {
  pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
  dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
  reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
  staleAfterMinutes: 10,
});

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  // Every interface by default. In Compose nothing can reach a listener on the container's own
  // loopback — not the published host port, not `http://approvals:8787` from Hermes — and the
  // exposure boundary is the port mapping, which is pinned to 127.0.0.1 on the host. Override for
  // a bare-metal run where the process itself is the boundary.
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, client, runner, deps.now),
});

for (const session of surfaces.all) await session.start();
log.info(
  `listening (client=${client}, surfaces=${surfaces.all.map((s) => s.name).join(',')}, primary=${surfaces.primary.name} on ${surfaces.primary.defaultConversation})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    await runner.stop();
    await health.close();
    for (const session of surfaces.all) await session.stop();
    await core.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
```

`SLACK_APPROVALS_CHANNEL` and the two app tokens are gone from this file: the Slack adapter reads
them from `deps.env`, which is `process.env` here. The `required()` helper with its Slack hint
goes with them — the hint now lives in `surfaces/slack/src/config.ts`, where it is true.

In `harness/approvals/src/app/child-env.ts`, replace `NEVER_FORWARDED` and widen the input:

```ts
import { ConfigError, requiredEnv } from '@harness/shared';

export interface ChildEnvInput {
  /** The parent environment to read from. */
  env: NodeJS.ProcessEnv;
  client: string;
  storageRoot: string;
  /** Every loaded surface's declared credentials, from `LoadedSurfaces.secrets`. */
  surfaceSecrets: readonly string[];
}

/** Model credentials this process may hold. The gateway key is the only one the child gets. */
export const MODEL_PROVIDER_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'] as const;

/**
 * Variables that must never reach the child, computed rather than listed.
 *
 * The messaging half of this list used to name four Slack variables. It cannot any more and
 * should not: which credentials exist is the loaded adapters' knowledge, declared as
 * `Surface.secrets`, and a host that hard-coded them would be wrong the day a Teams adapter is
 * loaded.
 */
export function neverForwarded(surfaceSecrets: readonly string[]): string[] {
  return [...new Set([...surfaceSecrets, ...MODEL_PROVIDER_KEYS])];
}
```

and `coreToolsChildEnv` becomes — every entry of the allowlist unchanged, the check new:

```ts
export function coreToolsChildEnv({ env, client, storageRoot, surfaceSecrets }: ChildEnvInput): Record<string, string> {
  const child: Record<string, string> = {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    DATABASE_URL: requiredEnv('DATABASE_URL', '', env),
    HARNESS_ENCRYPTION_KEY: requiredEnv('HARNESS_ENCRYPTION_KEY', '', env),
    HARNESS_CLIENT: client,
    CORE_TOOLS_CALLER: 'approvals-app',
    HARNESS_STORAGE_DIR: storageRoot,
    // core-tools refuses to start without a gateway key: every model call goes through the
    // proxy, and an approved documents_extract replay makes one. The provider keys stay in the
    // proxy, so this is the only model credential the child ever holds.
    LITELLM_MASTER_KEY: requiredEnv('LITELLM_MASTER_KEY', '', env),
    ...(env.HARNESS_POLICY_FILE ? { HARNESS_POLICY_FILE: env.HARNESS_POLICY_FILE } : {}),
    ...(env.HARNESS_FORMS_DIR ? { HARNESS_FORMS_DIR: env.HARNESS_FORMS_DIR } : {}),
    ...(env.HARNESS_GATEWAY_URL ? { HARNESS_GATEWAY_URL: env.HARNESS_GATEWAY_URL } : {}),
    ...(env.HARNESS_PACKS ? { HARNESS_PACKS: env.HARNESS_PACKS } : {}),
    // HARNESS_SURFACES is deliberately absent: the child is the kernel, which stages effects and
    // never sends one. Only this process talks to a surface.
  };
  // An allowlist already makes this impossible, which is the point of checking: the day someone
  // adds a pass-through here, a credential an adapter declared has to fail at startup rather
  // than travel to a child process that has no business with it.
  for (const name of neverForwarded(surfaceSecrets)) {
    if (name in child) throw new ConfigError(`the core-tools child environment must not carry ${name}`);
  }
  return child;
}
```

Also update the function's doc comment: "this process holds the approver's Slack tokens" becomes
"this process holds whatever credentials its messaging adapters need".

In `harness/approvals/src/app/child-env.test.ts`: `input()` gains
`surfaceSecrets: ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN']`, the import becomes
`{ coreToolsChildEnv, neverForwarded }`, and the allowlist case becomes:

```ts
  it('is an allowlist: no credential an adapter declared, and no provider key, reaches the child', () => {
    const declared = ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'];
    const secrets = Object.fromEntries(neverForwarded(declared).map((name) => [name, `secret-${name}`]));
    const env = coreToolsChildEnv({ ...input(secrets), surfaceSecrets: declared });
    for (const name of neverForwarded(declared)) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain('secret-');
  });
```

- [ ] **Step 16: Rewrite the barrel and the fixtures**

`harness/approvals/src/index.ts`:

```ts
export { surfaceSinks } from './domain/sinks.js';
export { loadSurfaces, surfacesOf, type LoadedSurfaces } from './domain/surfaces/registry.js';
export { postPendingApprovals, type PollDeps, type PollResult } from './domain/poller.js';
export {
  APPROVE_ACTION_ID,
  CARD_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  approvalCard,
  decidedCard,
  editForm,
  parseApprovalMetadata,
  payloadPreview,
  type ApprovalMetadata,
  type ApprovalRow,
} from './domain/cards.js';
/** The one restricted-value guard, from the package that owns the patterns. */
export { containsRestrictedPattern } from '@harness/core-tools/redaction';
export { createMcpCoreToolsClient } from './domain/execute/mcp-client.js';
export type { CoreToolsClient, ExecuteOutcome, McpLauncher } from './domain/execute/types.js';
export {
  decideApproval,
  threadReplyText,
  type DecisionDeps,
  type DecisionInput,
  type DecisionResult,
} from './domain/decisions.js';
export { registerApprovalHandlers } from './domain/handlers.js';
export {
  collectHealth,
  runDispatchTick,
  runPollTick,
  runReconcileTick,
  startRunner,
  type HealthSnapshot,
  type RunnerDeps,
  type RunnerHandle,
  type RunnerIntervals,
  type RunnerLoopStatus,
  type RunnerStatus,
} from './domain/runner.js';
export { DEFAULT_HEALTH_BIND, startHealthServer, type HealthServer } from './domain/health.js';
```

`AppDeps`, `HandlerRegistry`, `ActionArgs`, `ViewArgs` and `parseAllowedUsers` are gone from the
public API: the first four were the shape of a Bolt payload and the contract replaces them, and
`parseAllowedUsers` is `@harness/surface-api`'s now, because two adapters parse an allowlist and
the host parses none.

`harness/approvals/src/testing.ts` — the two Slack lines go, the fixture's three columns change:

```ts
/** What a test of @harness/approvals reaches for: the fakes, the test database, and one approval. */
import type { approvals } from '@harness/db';
import type { ApprovalRow } from './domain/cards.js';

export { FakeCoreToolsClient } from './domain/execute/fake.js';
export { useTestDb } from '@harness/db/testing';
export { MemorySurface } from '@harness/surface-api/testing';

/**
 * The action every test in this package parks: one roster file released to a payer, requested by
 * the agent. Stated once because the poller, the runner, the handlers, the decision path and the
 * card renderer are five views of the same approval, and a card whose summary no longer matches
 * the row the decision test decides on is two tests that only look like a pair.
 */
const PENDING = () => ({
  client: 'demo-practice',
  action: 'forms_release',
  payload: { tool: 'forms_release', args: { file_id: 'roster/aetna-abc123def456.csv' } },
  summary: 'forms_release (external) requested by hermes',
  requestedBy: 'hermes',
  idempotencyKey: 'k1',
  // A fresh Date per call: a shared instance would be one mutable object handed to every row.
  expiresAt: new Date('2026-09-16T12:00:00Z'),
});

/** Insert values for one pending approval, with `over` applied last. */
export function pendingApproval(over: Partial<typeof approvals.$inferInsert> = {}): typeof approvals.$inferInsert {
  return { ...PENDING(), ...over };
}

/**
 * The same approval as `approvals` would select it: not yet posted anywhere, still pending, with
 * `over` applied last. This is what the card builders take.
 *
 * Cast rather than constructed field by field: drizzle's inferred row type carries generated
 * columns this fixture does not need to restate.
 */
export function approvalRow(over: Partial<ApprovalRow> = {}): ApprovalRow {
  return {
    ...PENDING(),
    id: '11111111-1111-4111-8111-111111111111',
    payloadEncrypted: null,
    status: 'pending',
    decidedBy: null,
    decidedAt: null,
    decisionNote: null,
    executedAt: null,
    idempotencyKey: 'demo-practice:forms_release:abc',
    surface: null,
    conversationId: null,
    messageRef: null,
    createdAt: new Date('2026-09-15T12:00:00Z'),
    ...over,
  } as ApprovalRow;
}
```

- [ ] **Step 17: Write the dual-surface test**

Create `harness/approvals/src/domain/surfaces/dual-surface.test.ts`:

```ts
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { parseAllowedUsers } from '@harness/surface-api';
import { MemorySurface } from '@harness/surface-api/testing';
import { fakeSlackSession } from '@harness/surface-slack/testing';
import { coreToolsChildEnv, neverForwarded } from '../../app/child-env.js';
import { FakeCoreToolsClient, pendingApproval, useTestDb } from '../../testing.js';
import { APPROVE_ACTION_ID } from '../cards.js';
import { decideApproval } from '../decisions.js';
import { registerApprovalHandlers } from '../handlers.js';
import { postPendingApprovals } from '../poller.js';
import { surfaceSinks } from '../sinks.js';
import { surfacesOf } from './registry.js';

const db = useTestDb();
const key = randomBytes(32);
const now = () => new Date('2026-09-15T12:00:00Z');

/**
 * Two surfaces at once: Slack, through the real adapter on a fake transport, and the memory
 * adapter beside it. This is the suite that proves the host is not a Slack app with an interface
 * in front of it — cards go to the primary, effects go where they are addressed, and a decision
 * can only be taken where the card is.
 */
function wire() {
  const slack = fakeSlackSession({ allowedUsers: parseAllowedUsers('U012') });
  const memory = new MemorySurface({ allowedUsers: parseAllowedUsers('U012') });
  const surfaces = surfacesOf([slack.session, memory], ['APPROVALS_SLACK_BOT_TOKEN', 'APPROVALS_SLACK_APP_TOKEN']);
  const core = new FakeCoreToolsClient();
  for (const session of surfaces.all) registerApprovalHandlers(session, { db, surfaces, core, client: 'demo-practice', now });
  return { slack, memory, surfaces, core };
}

describe('a host with two surfaces loaded', () => {
  it('posts every approval card on the primary surface only', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, memory, surfaces } = wire();
    const out = await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    expect(out).toMatchObject({ posted: 1 });
    expect(slack.api.posts).toHaveLength(1);
    expect(memory.cards).toHaveLength(0);
    const [row] = await db.select().from(approvals);
    expect(row).toMatchObject({ surface: 'slack', conversationId: 'C0DEMO' });
    expect(row.messageRef).not.toBeNull();
  });

  it("renders that card as Block Kit, which is the adapter's business and nobody else's", async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, surfaces } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const blocks = slack.api.posts[0].blocks as { type: string }[];
    expect(blocks.map((b) => b.type)).toEqual(['section', 'context', 'section', 'actions', 'context']);
    expect(slack.api.posts[0].text).toBe('Approval needed: forms_release (external) requested by hermes');
  });

  it('accepts the decision on the surface that posted the card, and edits it there', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { slack, surfaces, core } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const [row] = await db.select().from(approvals);
    await slack.events.emitAction({
      userId: 'U012',
      channel: 'C0DEMO',
      actionId: APPROVE_ACTION_ID,
      value: row.id,
      triggerId: 'T1',
      messageTs: row.messageRef,
    });
    expect(core.executed).toEqual([row.id]);
    expect(slack.api.updates).toHaveLength(1);
    // The reply goes under the card, which on Slack is a thread.
    expect(slack.api.posts[1].thread_ts).toBe(row.messageRef);
    expect(slack.api.posts[1].text).toContain('<@U012>');
  });

  it('refuses the same decision when it arrives on the other surface', async () => {
    await db.insert(approvals).values(pendingApproval());
    const { memory, surfaces, core } = wire();
    await postPendingApprovals({ db, surface: surfaces.primary, client: 'demo-practice', now });
    const [row] = await db.select().from(approvals);
    const result = await decideApproval({ db, surfaces, core, client: 'demo-practice', now }, {
      approvalId: row.id,
      decision: 'approved',
      decidedBy: 'U012',
      surface: 'memory',
    });
    expect(result).toEqual({ outcome: 'wrong_surface' });
    expect(core.executed).toEqual([]);
    expect(memory.cards).toHaveLength(0);
    const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
    expect(after.status).toBe('pending');
  });

  it('sends an effect to the surface its payload names, and to the primary when it names none', async () => {
    const { slack, memory, surfaces } = wire();
    await db.insert(toolEffects).values([
      {
        client: 'demo-practice',
        tool: 'harness_notify',
        sink: 'surface_message',
        idempotencyKey: 'demo-practice:to-memory',
        payloadEncrypted: encrypt(JSON.stringify({ text: 'for the memory surface', surface: 'memory' }), key),
        summary: 'a note',
      },
      {
        client: 'demo-practice',
        tool: 'harness_notify',
        sink: 'surface_message',
        idempotencyKey: 'demo-practice:to-primary',
        payloadEncrypted: encrypt(JSON.stringify({ text: 'for whoever is primary' }), key),
        summary: 'a note',
      },
    ]);
    const out = await dispatchStagedEffects(db, surfaceSinks(surfaces), { key });
    expect(out).toMatchObject({ dispatched: 2 });
    expect(memory.texts.map((t) => t.text)).toEqual(['for the memory surface']);
    expect(slack.api.posts.map((p) => p.text)).toEqual(['for whoever is primary']);
  });

  it('keeps every credential the loaded adapters declared out of the core-tools child', () => {
    const { surfaces } = wire();
    const env = coreToolsChildEnv({
      env: {
        PATH: '/usr/bin',
        HOME: '/home/node',
        DATABASE_URL: 'postgres://harness:harness@postgres:5432/harness',
        HARNESS_ENCRYPTION_KEY: 'a'.repeat(44),
        LITELLM_MASTER_KEY: 'sk-test',
        APPROVALS_SLACK_BOT_TOKEN: 'xoxb-secret',
        APPROVALS_SLACK_APP_TOKEN: 'xapp-secret',
      },
      client: 'demo-practice',
      storageRoot: '/srv/harness-storage',
      surfaceSecrets: surfaces.secrets,
    });
    for (const name of neverForwarded(surfaces.secrets)) expect(env).not.toHaveProperty(name);
    expect(JSON.stringify(env)).not.toContain('secret');
  });
});
```

- [ ] **Step 18: Write the host vocabulary test**

Create `harness/approvals/src/host-vocabulary.test.ts`:

```ts
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here);

/**
 * Words that belong to one messaging surface and must not appear in the host.
 *
 * The host posts a card, replies under a message and uploads a file. Which of those is a Block
 * Kit block, a Bolt listener or a `thread_ts` is the Slack adapter's business, and a word here in
 * host source is either an identifier the next reader will copy or a comment that teaches the
 * wrong model — and both end with the second adapter needing a special case.
 *
 * `*.test.ts` is excluded because a test names what it tests: the dual-surface suite drives the
 * real Slack adapter through its fake transport and says so.
 *
 * **The allowlist is empty and must stay empty.** A word that has to appear belongs in
 * `surfaces/slack`, or the comment carrying it should say what the host actually means: a
 * surface, a conversation, a message, a card.
 */
const FORBIDDEN = /slack|bolt|block ?kit|thread_ts|\bblocks\b/i;

const ALLOWLIST: { file: string; contains: string; reason: string }[] = [];

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

describe('the approvals host names no messaging surface', () => {
  it('finds no Slack vocabulary in harness/approvals/src', async () => {
    const hits: string[] = [];
    const files = await sourceFiles(root);
    // A scan that reached nothing would pass silently, which is the one way this test can lie.
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const relative = path.relative(root, file).split(path.sep).join('/');
      const text = await readFile(file, 'utf8');
      text.split('\n').forEach((line, i) => {
        const match = FORBIDDEN.exec(line);
        if (!match) return;
        const exempt = ALLOWLIST.some((a) => a.file === relative && line.includes(a.contains));
        if (!exempt) hits.push(`${relative}:${i + 1}: ${match[0]} — ${line.trim()}`);
      });
    }
    expect(hits).toEqual([]);
  });

  it('keeps the allowlist empty, because every entry is a host that still knows one transport', () => {
    expect(ALLOWLIST).toEqual([]);
  });

  it('catches the words it claims to, so an empty result means the rule ran', () => {
    for (const line of [
      "import { App } from '@slack/bolt';",
      'const blocks = approvalBlocks(row);',
      '// the Block Kit card',
      'thread_ts: row.messageRef,',
      'a Slack channel id',
    ]) {
      expect(FORBIDDEN.test(line), line).toBe(true);
    }
    // And the shapes it must not catch: the words the host is supposed to use.
    for (const line of ['await session.postCard(conversation, card);', 'const ref: MessageRef = { surface, id };']) {
      expect(FORBIDDEN.test(line), line).toBe(false);
    }
  });
});
```

- [ ] **Step 19: Add the last architecture rule and document `HARNESS_SURFACES`**

In `.dependency-cruiser.cjs`, add to `GLOBAL_RULES` after
`evals-never-statically-imports-a-pack`:

```js
  {
    name: 'the-host-never-statically-imports-a-surface',
    comment:
      'Adapters are loaded at runtime from HARNESS_SURFACES through a dynamic import in domain/surfaces/registry.ts. A static import would wire the approvals host to one messaging transport by name, which is the coupling the surface contract exists to remove. src/testing.ts and *.test.ts are exempt: they drive a real adapter on a fake transport and are not shipped.',
    severity: 'error',
    from: {
      path: '^harness/approvals/src/',
      pathNot: ['\\.test\\.ts$', '^harness/approvals/src/testing\\.ts$'],
    },
    to: { path: '^surfaces/[^/]+/', dependencyTypesNot: ['dynamic-import'] },
  },
```

In `.env.example`, add a new block above the `# --- Slack ---` heading:

```
# --- Messaging surfaces --------------------------------------------------------
# Which messaging surfaces the approvals host serves, as a comma-separated list of
# adapter package names. The FIRST one is the primary: it is where approval cards
# are posted. Decisions are accepted from whichever surface posted the card, and a
# staged effect may name any loaded one. An adapter named here must also be in
# @harness/approvals' dependencies so pnpm can resolve it.
HARNESS_SURFACES=@harness/surface-slack
```

- [ ] **Step 20: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations
pnpm format:check
pnpm -r test          # green
pnpm surface:record && git status --porcelain docs/architecture   # no output
```

The last one is the interesting gate in this task: the host now reads `HARNESS_SURFACES` and no
longer reads `SLACK_APPROVALS_CHANNEL`, which moved into `surfaces/slack` — the environment scan
must still find both, or `surface.test.ts`'s anchors fail. If it reports
`SLACK_APPROVALS_CHANNEL` missing, Task 3's `SOURCE_ROOTS` edit did not land.

- [ ] **Step 21: Commit**

```bash
git add harness/approvals .dependency-cruiser.cjs .env.example pnpm-lock.yaml
git commit -m "refactor(approvals): make the approvals app a surface-agnostic host"
```

No trailer of any kind.

---
### Task 5: the kernel and the pack tools stop naming Slack

The host is surface-agnostic; the kernel is not. `harness_notify` stages a `slack_message`,
`stageRelease` stages a `slack_file`, and both validate their `channel` argument against a Slack
channel id — which is the one Slack shape that has leaked all the way out into
`docs/architecture/tool-surface.json`, where an agent reads it.

This task renames the two sinks, makes both schemas neutral, adds the optional `surface` argument
that lets a playbook address a second surface, rewords the seven comments and three strings that
name Slack in the kernel and the healthcare pack, and extends the vocabulary test to catch the
next one. **It is the only task that re-records the tool surface**, and it changes it in exactly
the four places spec decision 10 names.

**Files:**
- Modify: `harness/pack-api/src/index.ts` (two re-exports)
- Modify: `harness/pack-api/src/types.ts` (`PackKernel.stageRelease` gains `surface`)
- Modify: `harness/core-tools/src/domain/session/repository.ts`, `domain/files/release.ts`, `tools/harness.ts`
- Modify: `harness/core-tools/src/domain/storage/file-store.ts`, `domain/tooling/types.ts`, `shared/redaction/index.ts`, `shared/redaction/patterns.ts` (comments)
- Modify: `packs/healthcare/src/tools/forms.ts`, `packs/healthcare/src/domain/forms/types.ts`
- Modify: `harness/core-tools/src/tools/harness.test.ts`, `harness/core-tools/src/app/pack-healthcare/forms.test.ts`
- Modify: `harness/core-tools/src/kernel-vocabulary.test.ts`, `harness/core-tools/src/app/surface.test.ts`
- Modify: `harness/approvals/src/domain/sinks.ts` and `sinks.test.ts` (the two legacy aliases go)
- Modify: `docs/architecture/tool-surface.json` (re-recorded)

**Interfaces:**
- Consumes: `CONVERSATION_ID_PATTERN` and `SURFACE_NAME_PATTERN` from `@harness/shared`, through
  `@harness/pack-api`'s re-export for the pack.
- Produces:

  ```ts
  // @harness/pack-api — index.ts
  export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';
  // @harness/pack-api — types.ts
  stageRelease(deps: PackToolDeps, args: { file_id: string; channel?: string; surface?: string }): Promise<StagedRelease>

  // @harness/core-tools
  function stageNotification(deps: ToolDeps, args: { text: string; idempotency_key: string; channel?: string; surface?: string }): Promise<{ effect_id: string; staged: boolean }>
  function stageRelease(deps: ToolDeps, args: { file_id: string; channel?: string; surface?: string }): Promise<StagedRelease>
  // sink names: 'surface_message', 'surface_file'
  // payloads:   { text, conversation, surface } and { file_id, path, filename, conversation, surface }
  ```

**What does not change.** Every tool name; every other schema; the `channel` argument's *name*,
because skills and prompts use it; `RELEASE_KEY_PREFIX`, which is one half of an idempotency key
rows in a live outbox already carry.

---

- [ ] **Step 1: Re-export the two patterns from the pack contract**

In `harness/pack-api/src/index.ts`, add at the top of the export list:

```ts
/**
 * Re-exported from `@harness/shared`, which is where both contracts can reach them. A pack's
 * tool schema validates a `channel` argument with `CONVERSATION_ID_PATTERN`, and so does the
 * kernel's; a surface adapter validates the same string against its own, much narrower, shape at
 * dispatch, because only the adapter knows what its ids look like.
 */
export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';
```

In `harness/pack-api/src/types.ts`, `PackKernel.stageRelease`'s argument type becomes
`{ file_id: string; channel?: string; surface?: string }`, and its doc line becomes
"Stage one generated file for delivery through the effects outbox, on the named surface or the
primary one. Sends nothing."

- [ ] **Step 2: Write the failing kernel tests**

In `harness/core-tools/src/tools/harness.test.ts`, change the staged-effect expectation and add
one case:

```ts
    expect(row).toMatchObject({ sink: 'surface_message', tool: 'harness_notify', status: 'staged', client: 'test' });
```

```ts
  it('addresses the effect to a named surface and conversation when the caller gives them', async () => {
    const client = await connectServer();
    await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-addressed', channel: 'memory', surface: 'memory' },
    });
    const [row] = await db.select().from(toolEffects);
    expect(row.sink).toBe('surface_message');
    // The payload is encrypted; what an operator can read is the sink and the summary.
    expect(row.summary).toBe('Message (8 characters)');
  });

  it('refuses a conversation id that is not a bare identifier', async () => {
    const client = await connectServer();
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-bad', channel: 'not a channel' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });
```

In `harness/core-tools/src/app/pack-healthcare/forms.test.ts`, the release case's name becomes
"stages exactly one surface_file effect when the approval is executed" and its expectation

```ts
    expect(effects[0]).toMatchObject({ sink: 'surface_file', tool: 'forms_release', status: 'staged', client: 'test' });
```

- [ ] **Step 3: Run them and watch them fail**

Run: `pnpm --filter @harness/core-tools test harness.test`
Expected: FAIL — the staged row still says `slack_message`, and `surface` is rejected as an
unrecognised argument.

- [ ] **Step 4: Rename the notification sink**

In `harness/core-tools/src/domain/session/repository.ts`, `NotifyArgs` gains `surface?: string`
and `stageNotification` becomes:

```ts
/** `harness_notify`: stage one message for the dispatcher to send after the call commits. */
export async function stageNotification(
  deps: ToolDeps,
  { text, idempotency_key, channel, surface }: NotifyArgs,
): Promise<{ effect_id: string; staged: boolean }> {
  if (containsRestrictedPattern(text)) {
    throw new ToolError(
      'message refused: it looks like it contains a restricted identifier; restricted values never leave the harness',
    );
  }
  // The text is the payload and is stored encrypted. The summary is a label only:
  // tool_effects.summary is plaintext and operators read it freely.
  return stageEffect(deps, {
    sink: 'surface_message',
    idempotencyKey: idempotency_key,
    // `conversation` and `surface` are both optional and both null when the caller named
    // neither: the host's sink resolves an unaddressed effect to the primary surface's default
    // conversation, which is what every playbook has always meant by "the client channel".
    payload: { text, conversation: channel ?? null, surface: surface ?? null },
    summary: `Message (${text.length} characters)`,
  });
}
```

- [ ] **Step 5: Rename the release sink**

In `harness/core-tools/src/domain/files/release.ts`:

- the `MAX_RELEASE_BYTES` comment becomes "The smallest upload limit among the surfaces the
  harness supports, and a 25 MB generated file is a bug rather than a delivery.";
- `stageRelease`'s argument type becomes `{ file_id: string; channel?: string; surface?: string }`
  and the destructure takes `surface` too;
- the staging call becomes:

```ts
  const staged = await stageEffect(deps, {
    sink: 'surface_file',
    // Keyed on the file id, which is content-addressed: releasing the same bytes twice is one
    // delivery, and re-filling after a correction produces a new id and therefore a new one.
    // The conversation and the surface are part of the key because the same file sent to two
    // places is two deliveries, not a duplicate.
    idempotencyKey: `${RELEASE_KEY_PREFIX}${file_id}${channel ? `:${channel}` : ''}${surface ? `@${surface}` : ''}`,
    payload: { file_id, path: absolute, filename, conversation: channel ?? null, surface: surface ?? null },
    summary: `Release ${filename}`,
  });
```

The key's shape for a caller that names neither is byte-identical to today's, which is what keeps
a release already staged in a live outbox deduplicating against a repeat after the upgrade.

- [ ] **Step 6: Make the two tool schemas neutral**

In `harness/core-tools/src/tools/harness.ts`, `harnessNotify` becomes:

```ts
const harnessNotify = defineTool({
  name: 'harness_notify',
  description:
    'Stage one message in this client conversation, sent by the dispatcher after the call commits. ' +
    'Use it from a scheduled playbook so the message is audited and sent exactly once per idempotency key: ' +
    'staging the same key twice is a no-op. Refuses text that looks like it carries a restricted identifier.',
  actionClass: 'write.internal',
  input: z.object({
    text: z.string().min(1).max(3000),
    /** Scoped to the client by stageEffect. Make it identify the content, e.g. `expirations:2026-09-15:overdue`. */
    idempotency_key: z.string().regex(/^[a-z0-9][a-z0-9:_-]{0,199}$/, 'idempotency_key must be a lowercase slug'),
    // Still called `channel`: the skills and playbooks that pass it say channel, and renaming an
    // argument an agent has been told about is a behaviour change. What it means is a
    // conversation on the target surface, and only that surface can say whether the id is real —
    // it checks at dispatch and fails that one effect, visible through harness_reconcile.
    channel: z
      .string()
      .regex(CONVERSATION_ID_PATTERN, 'channel must be a conversation id on the target surface')
      .optional(),
    surface: z
      .string()
      .regex(SURFACE_NAME_PATTERN, 'surface must be the name of a loaded messaging surface')
      .optional(),
  }),
  output: z.object({ effect_id: z.string(), staged: z.boolean() }),
  handler: async (args, deps) => stageNotification(deps, args),
});
```

with `import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';` at the top.

In `packs/healthcare/src/tools/forms.ts`, `formsRelease` becomes:

```ts
  const formsRelease = definePackTool({
    name: 'forms_release',
    description:
      'Send a file that forms_fill or forms_roster produced to the people who approve releases. External: it parks ' +
      'an approval, and only approvals_execute stages the delivery. Nothing leaves the harness until a human approves.',
    actionClass: 'external',
    input: z.object({
      file_id: z.string().min(1).max(300),
      channel: z
        .string()
        .regex(CONVERSATION_ID_PATTERN, 'channel must be a conversation id on the target surface')
        .optional(),
      surface: z
        .string()
        .regex(SURFACE_NAME_PATTERN, 'surface must be the name of a loaded messaging surface')
        .optional(),
    }),
    output: z.object({
      effect_id: z.string(),
      staged: z.boolean(),
      file_id: z.string(),
      filename: z.string(),
      bytes: z.number(),
    }),
    handler: async (args, d) => {
      try {
        return await d.kernel.stageRelease(d, args);
      } catch (err) {
        // The kernel's message names no pack tool, because the kernel knows of none. This pack
        // does, and the sentence an agent reads has told it which two tools produce a file id
        // since before the kernel was generic; a skill and a test both depend on it.
        if (err instanceof ToolError && err.message === `no generated file with id "${args.file_id}"`) {
          throw new ToolError(`no generated file with id "${args.file_id}"; run forms_fill or forms_roster first`);
        }
        throw err;
      }
    },
  });
```

with `CONVERSATION_ID_PATTERN` and `SURFACE_NAME_PATTERN` added to the file's existing
`@harness/pack-api` import. The pack imports them from the contract it already depends on, never
from `@harness/shared` directly — that is what spec section 7 asks for and what keeps one
definition in play.

- [ ] **Step 7: Reword the comments that name Slack for no reason**

Five in the kernel, one in the pack. Each says "a human channel" or "a surface" because that is
what it always meant:

| File | Was | Becomes |
|---|---|---|
| `harness/core-tools/src/domain/storage/file-store.ts:32` | "`readFile` in the Slack file sink follow symlinks" | "`readFile` in the host's file sink follows symlinks" |
| `harness/core-tools/src/domain/tooling/types.ts:86` | "External-effect senders keyed by sink name (e.g. 'slack')." | "External-effect senders keyed by sink name (e.g. 'surface_message')." |
| `harness/core-tools/src/shared/redaction/index.ts:7` | "text on its way to Slack" | "text on its way to a human" |
| `harness/core-tools/src/shared/redaction/patterns.ts:7` | "about to reach a human channel: a Slack card, a decision note, a staged message" | "about to reach a human: an approval card, a decision note, a staged message" |
| `harness/core-tools/src/shared/redaction/patterns.ts:18` | "would stop tripping the Slack guard" | "would stop tripping the human-channel guard" |
| `packs/healthcare/src/domain/forms/types.ts:6` | "a filled form is uploaded to Slack" | "a filled form is released to a human" |

- [ ] **Step 8: Take the two legacy sink names off the host**

In `harness/approvals/src/domain/sinks.ts`, delete the `slack_message` and `slack_file` entries
and the comment above them: from this commit the kernel stages neither. In
`harness/approvals/src/domain/sinks.test.ts`, delete the case named "is still registered under
the two names the kernel stages today".

This is the one pair of edits that must land in **this** commit rather than the previous one: an
alias that outlives the thing it aliases is a sink name nothing writes and nobody can find.

- [ ] **Step 9: Extend the vocabulary test**

Rewrite the head of `harness/core-tools/src/kernel-vocabulary.test.ts`. The credentialing regex
and its two roots are unchanged; a second regex and three more roots are added:

```ts
/**
 * Words that belong to one area of the product and must not appear in the kernel. (unchanged)
 */
const DOMAIN_FORBIDDEN =
  /provider|credential|licen[cs]e|(?<![A-Za-z])npi(?![A-Za-z])|nppes|malpractice|dea_number|payer|roster/i;

/**
 * Words that belong to one messaging surface and must not appear in the kernel or in a pack.
 *
 * The kernel stages an effect and a pack releases a file; which of those becomes a Block Kit
 * block, a Bolt listener or a `thread_ts` is `surfaces/slack`'s business. A word here in kernel
 * or pack source is either a schema key an agent will read, an identifier the next reader will
 * copy, or a comment that teaches the wrong model.
 *
 * `evals/src` is **not** scanned for these, deliberately: `domain/report/render.ts` and
 * `report/build.ts` both say a missing metric "blocks promotion", which is English about
 * promotion gates and has nothing to do with Block Kit. Rewording eval prose to satisfy a
 * messaging rule would be the tail wagging the dog. `harness/approvals/src` is not scanned here
 * either — it has its own copy of this rule, in `harness/approvals/src/host-vocabulary.test.ts`,
 * because a test in this package that scanned another package's source would fail in whichever
 * suite happened to run it.
 */
const MESSAGING_FORBIDDEN = /slack|bolt|block ?kit|thread_ts|\bblocks\b/i;

/**
 * What is scanned for what, and what is left out of each.
 *
 * `*.test.ts` is excluded everywhere because a test names what it tests. `shared/redaction/` is
 * excluded from the credentialing scan only, because `RESTRICTED_NAME_KEYS` is a list of
 * identifier stems the kernel keeps on purpose — it has no such exemption from the messaging
 * scan, and needs none.
 *
 * `minFiles` guards against the one way this test can lie: a scan that reached nothing passes.
 */
const SCANNED = [
  { what: 'credentialing vocabulary', root: 'harness/core-tools/src', forbidden: DOMAIN_FORBIDDEN, minFiles: 10, skip: [/\.test\.ts$/, /\/shared\/redaction\//] },
  { what: 'credentialing vocabulary', root: 'evals/src', forbidden: DOMAIN_FORBIDDEN, minFiles: 10, skip: [/\.test\.ts$/, /\.test-helpers\.ts$/] },
  { what: 'messaging vocabulary', root: 'harness/core-tools/src', forbidden: MESSAGING_FORBIDDEN, minFiles: 10, skip: [/\.test\.ts$/] },
  { what: 'messaging vocabulary', root: 'packs/healthcare/src', forbidden: MESSAGING_FORBIDDEN, minFiles: 10, skip: [/\.test\.ts$/] },
  { what: 'messaging vocabulary', root: 'packs/stories/src', forbidden: MESSAGING_FORBIDDEN, minFiles: 1, skip: [/\.test\.ts$/] },
];
```

The loop takes the new fields and its test name distinguishes the two scans of one root:

```ts
  for (const { what, root, forbidden, minFiles, skip } of SCANNED) {
    it(`finds no ${what} in ${root}`, async () => {
      const hits: string[] = [];
      const files = await sourceFiles(path.join(repoRoot, root), skip);
      expect(files.length).toBeGreaterThanOrEqual(minFiles);
      for (const file of files) {
        const relative = path.relative(repoRoot, file).split(path.sep).join('/');
        const text = await readFile(file, 'utf8');
        text.split('\n').forEach((line, i) => {
          const match = forbidden.exec(line);
          if (!match) return;
          const exempt = ALLOWLIST.some((a) => a.file === relative && line.includes(a.contains));
          if (!exempt) hits.push(`${relative}:${i + 1}: ${match[0]} — ${line.trim()}`);
        });
      }
      expect(hits).toEqual([]);
    });
  }
```

and the "catches the words it claims to" case gains the messaging half:

```ts
    for (const line of [
      "import { App } from '@slack/bolt';",
      'sink: `slack_message`,',
      '// the Block Kit card',
      'thread_ts: row.messageRef,',
      'const blocks = cardBlocks(card);',
    ]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(true);
    }
    // And the shapes it must not catch: an ordinary identifier, and the words the kernel uses.
    for (const line of ['const prompt = dataBlockSystemPrompt(role);', "sink: 'surface_message',"]) {
      expect(MESSAGING_FORBIDDEN.test(line), line).toBe(false);
    }
```

- [ ] **Step 10: Write the four-places test**

Append to `harness/core-tools/src/app/surface.test.ts`:

```ts
/**
 * Plan 6 changed the recorded tool surface in four places and in no others.
 *
 * Stated as four properties rather than as a diff against a second committed copy of the
 * snapshot: a copy is a file that has to be updated twice forever, and the first time someone
 * updates one of the two it stops being evidence of anything.
 */
const RECORDED_TOOLS = [
  'approvals_execute',
  'audit_query',
  'deadlines_compute',
  'deadlines_upcoming',
  'documents_classify',
  'documents_extract',
  'documents_get',
  'documents_ingest',
  'documents_list',
  'forms_fill',
  'forms_list_templates',
  'forms_release',
  'forms_roster',
  'harness_notify',
  'harness_reconcile',
  'harness_set_context',
  'providers_confirm_field',
  'providers_get',
  'providers_list_pending',
  'providers_search',
  'providers_upsert',
  'verify_nppes',
  'verify_state_license',
];

type InputSchema = { properties: Record<string, { pattern?: string }>; required?: string[] };

describe('the four places Plan 6 moved the tool surface', () => {
  const recorded = async (): Promise<ToolSurfaceEntry[]> =>
    JSON.parse(await readFile(path.join(architecture, 'tool-surface.json'), 'utf8')) as ToolSurfaceEntry[];

  it('publishes the same twenty-three tools it did before', async () => {
    expect((await recorded()).map((tool) => tool.name)).toEqual(RECORDED_TOOLS);
  });

  it('carries no Slack channel id shape anywhere, which is what this plan was for', async () => {
    expect(JSON.stringify(await recorded())).not.toContain('[CGD]');
  });

  it('validates both `channel` arguments as a neutral conversation id', async () => {
    const entries = await recorded();
    for (const name of ['forms_release', 'harness_notify']) {
      const schema = entries.find((tool) => tool.name === name)?.inputSchema as InputSchema;
      expect(schema.properties.channel.pattern, name).toBe(CONVERSATION_ID_PATTERN.source);
    }
  });

  it('adds one optional `surface` argument, to exactly those two tools', async () => {
    const withSurface = (await recorded()).filter((tool) => 'surface' in (tool.inputSchema as InputSchema).properties);
    expect(withSurface.map((tool) => tool.name)).toEqual(['forms_release', 'harness_notify']);
    for (const tool of withSurface) {
      const schema = tool.inputSchema as InputSchema;
      expect(schema.properties.surface.pattern).toBe(SURFACE_NAME_PATTERN.source);
      expect(schema.required ?? []).not.toContain('surface');
    }
  });
});
```

with `import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/pack-api';` added to
the file's imports.

- [ ] **Step 11: Re-record the surface and read the diff**

```bash
pnpm surface:record
git diff --stat docs/architecture
git diff docs/architecture/tool-surface.json
```

Expected: `tool-surface.json` only. The diff is exactly four hunks — two changed `pattern` lines
and two added `surface` property blocks, one in `forms_release` and one in `harness_notify`.
`compose-surface.yaml` must not appear. **If the diff has a fifth hunk, stop and find out why
before committing**: a tool schema moved that this plan did not intend to move.

- [ ] **Step 12: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations
pnpm format:check
pnpm -r test          # green, including the five vocabulary scans and the four-places test
pnpm surface:record && git status --porcelain docs/architecture   # no output, now that it is committed
```

- [ ] **Step 13: Commit**

```bash
git add harness/pack-api harness/core-tools packs/healthcare harness/approvals docs/architecture/tool-surface.json
git commit -m "feat(core-tools): address effects to a surface instead of to Slack"
```

No trailer of any kind. The commit message says the tool surface was re-recorded on purpose:
add a body line, `The two channel patterns and the two new surface arguments are the only schema
changes; docs/architecture/tool-surface.json is re-recorded for them.`

---
### Task 6: configuration and the documents

The code is surface-agnostic; the deployment and the documents still describe a Slack app. This
task makes the demo deployment name its surface explicitly, puts `surfaces/` into the image, and
rewrites the four documents a reader uses to understand or operate the harness — plus the four
package READMEs.

**Files:**
- Modify: `.env.example`, `clients/demo-practice/.env.example`
- Modify: `harness/compose/docker-compose.yml`, `harness/compose/node.Dockerfile`
- Regenerate: `docs/architecture/compose-surface.yaml`, `docs/architecture/graph.svg`
- Modify: `ARCHITECTURE.md`, `CONTRIBUTING.md`, `README.md`, `docs/runbook.md`
- Modify: `harness/approvals/README.md`, `harness/surface-api/README.md`
- Create: `surfaces/slack/README.md`, `surfaces/memory/README.md`

**Interfaces:**
- Consumes: everything Tasks 1 to 5 produced. Nothing here is imported by code.
- Produces: no code.

**What does not change.** Any source file, any tool schema, `docs/architecture/tool-surface.json`.
`compose-surface.yaml` changes, because Compose does.

---

- [ ] **Step 1: Finish the environment examples**

In `.env.example`, the `HARNESS_SURFACES` block from Task 4 is already above the Slack section.
Now rename the `# --- Slack ---` heading to `# --- Slack adapter (@harness/surface-slack) ---`,
leave every variable name and every line of its existing prose untouched, and move the
`MEMORY_ALLOWED_USERS` block Task 3 added out from under it into its own heading immediately
after, `# --- Memory adapter (@harness/surface-memory) ---`.

In `clients/demo-practice/.env.example`, add above its `# --- Slack ---` heading:

```
# --- Messaging surfaces -----------------------------------------------------
# Comma-separated adapter package names; the first is where approval cards go.
# The demo posts to Slack. Set it to @harness/surface-memory to run the host
# with no Slack workspace at all.
HARNESS_SURFACES=@harness/surface-slack
```

and rename that file's Slack heading the same way. The variable names in both files are
unchanged, which is the whole point: a deployment's `.env` keeps working.

- [ ] **Step 2: Put the surfaces in the image and name one in Compose**

In `harness/compose/node.Dockerfile`, add `COPY surfaces ./surfaces` after `COPY packs ./packs`,
and change the header comment's first line from "The Slack approvals app." to "The approvals
host and its messaging adapters."

Without that line the image has no `@harness/surface-slack` to resolve, and the container fails
at startup with `cannot load surface "@harness/surface-slack"` — which is the error working
exactly as designed, and not one anybody wants to meet in the demo.

In `harness/compose/docker-compose.yml`, in the `approvals` service's `environment:` block,
directly after the `HARNESS_PACKS` line:

```yaml
      # Which messaging surfaces this host serves, first one primary. Same shape
      # as HARNESS_PACKS: the adapter is loaded by name at startup, so switching
      # the demo to another surface is this line plus that adapter's variables.
      HARNESS_SURFACES: '${HARNESS_SURFACES:-@harness/surface-slack}'
```

Leave the `sed '/^APPROVALS_SLACK_/d'` filter in the `hermes-init` command and the two blanked
`APPROVALS_SLACK_*` variables on the `hermes` service exactly as they are. They are
deployment-level defence, they are documented in the runbook, and the adapter's `secrets`
declaration is a different mechanism protecting a different boundary — the child process, not a
sibling container.

Then re-record:

```bash
pnpm surface:record
git diff --stat docs/architecture
```

Expected: `compose-surface.yaml` only, one added line on the approvals service.
`tool-surface.json` must not appear.

- [ ] **Step 3: ARCHITECTURE.md — the packages, and a "Surfaces" section**

Three edits.

In the package map under "## The packages", change the `harness/approvals` line and add three:

```
harness/pack-api    the Pack contract and definePack(). Depends on @harness/shared and zod
                    only, so a pack never has to depend on core-tools.
harness/surface-api the Surface contract and defineSurface(): cards, forms, conversations, and
                    MemorySurface under its testing subpath. Depends on @harness/shared and zod.
harness/approvals   the approvals host: cards, decisions, the effects dispatcher, the health
                    endpoint. Loads its messaging adapters from HARNESS_SURFACES.
surfaces/slack      the Slack adapter: Block Kit, Bolt in Socket Mode, the Web API slice.
surfaces/memory     the in-process adapter: no transport, used by the suite and for local runs.
```

and in the one-line-per-layer graph below it, add two lines:

```
shared  <-  surface-api  <-  { approvals, surfaces/* }
approvals   ..>  surfaces/*     (runtime only: HARNESS_SURFACES, never a static import)
```

Add a section after "### What a pack cannot do", before "## The path of one tool call":

````markdown
## Surfaces

A **surface** is a place a human is talked to: Slack today, Microsoft Teams or Telegram next.
`@harness/approvals` is the *host* — it decides what to say and when — and it holds no transport
at all. `@harness/surface-api` is the contract between them, and it is the same shape as the pack
contract for the same reasons: a leaf package depending on `@harness/shared` and zod, so an
adapter never has to depend on the host, so the host can load it by name at runtime.

```ts
export const surface = defineSurface({
  name, // lowercase; stored in approvals.surface
  version,
  secrets, // env names that must never reach the core-tools child
  connect, // (deps: SurfaceDeps) => Promise<SurfaceSession>
});
```

A `SurfaceSession` posts and updates a card, posts text (optionally as a reply to a message),
sends a private note, uploads a file, opens a form where it can, and delivers actions and form
submissions back. Everything it takes is neutral: a `Card` is a title, a subtitle, body lines and
actions; a `NotePart` is text, a code span, a timestamp, a mention or an outcome icon. Which of
those becomes a Block Kit `context` block, an Adaptive Card `TextBlock` or a line of HTML is the
adapter's business, and `harness/approvals/src/host-vocabulary.test.ts` fails the build if the
host learns the difference.

**The primary surface** is the first entry of `HARNESS_SURFACES`. Approval cards are posted there
and only there: one approval, one card, one place to answer it. Every loaded surface is still
live — a decision is accepted from whichever surface posted the card, which `approvals.surface`
records, and a staged effect may name any loaded surface in its payload.

**Capabilities, not attempts.** `SurfaceCapabilities` says whether this surface can open a form,
send a private reply and edit a message. The host reads them: a surface without forms gets an
approval card with two buttons instead of three, rather than an Edit button that fails.

**Allowlists are per surface.** A `SurfaceSession` carries its own `allowedUsers`, parsed from its
own variable, and the host authorises a decision against the set of the surface it arrived on. A
Teams identity and a Slack identity are different people until something says otherwise. An empty
set is a misconfiguration and refuses everyone; the single member `*` means everyone and is for a
surface with no transport only.

**Addressing.** `approvals` carries `surface`, `conversation_id` and `message_ref` (migration
0009); `conversation_id` doubles as the poller's claim marker. An effect carries `surface` and
`conversation` in its payload, and the host's two generic sinks — `surface_message` and
`surface_file` — resolve them, falling back to the primary surface and its default conversation.
The kernel's `harness_notify` and the healthcare pack's `forms_release` keep their `channel`
argument name, because skills use it, but validate it only as a conversation-id *shape*
(`CONVERSATION_ID_PATTERN`, in `@harness/shared` so both contracts can reach it): the kernel
cannot know a surface's id format, so the adapter checks at dispatch and a bad id fails that one
effect, visible through `harness_reconcile`.

**Secrets.** An adapter declares the environment variables it reads that are credentials, and the
host subtracts the union of them from the environment of the core-tools child it spawns. The
allowlist in `app/child-env.ts` therefore names no surface.

`CONTRIBUTING.md`, "Adding a surface", is the worked how-to, with `surfaces/memory` as the example.
````

In "## Tooling", extend the `pnpm arch` row's list with "the host never statically imports a
surface"; in "## Proof that a refactor changed nothing", add a row to the second table:

```
| `harness/approvals/src/host-vocabulary.test.ts` | a Slack word in `harness/approvals/src`, tests aside. Its allowlist is empty too. |
```

and extend the existing `kernel-vocabulary.test.ts` row: "…and a messaging word (`slack`, `bolt`,
`block kit`, `thread_ts`, `blocks`) in the kernel or in a pack." Add one line under that table:

```
And `harness/db/src/domain/migration-0009.test.ts` replays the surface-addressing migration over
a fixture of the pre-0009 schema, the same way the 0008 test does.
```

- [ ] **Step 4: CONTRIBUTING.md — "Adding a surface"**

Add a section after "Adding a pack" and before "Adding a client":

````markdown
## Adding a surface

A surface is a place a human is talked to — Slack, Microsoft Teams, Telegram — that the approvals
host loads through a contract instead of importing by name. `surfaces/memory` is the smallest
complete one; read it alongside this, and read `surfaces/slack` for the real thing.

1. **Create the package.** `mkdir -p surfaces/<name>/src` and a `package.json` named
   `@harness/surface-<name>`, with `"." : "./src/index.ts"` in `exports` and
   `@harness/surface-api` and `@harness/shared` in `dependencies`. **Never** depend on
   `@harness/approvals`, `@harness/core-tools` or `@harness/db`; `pnpm arch` fails the build on
   any of them. Add one `PACKAGES` row and one `WORKSPACE_DIRS` entry in
   `.dependency-cruiser.cjs`, and nothing else.

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
   payload. `secrets` lists the environment variables you read that are credentials; the host
   subtracts them from the core-tools child's environment, so leaving one out is a credential
   travelling where it should not.

3. **Read configuration from `deps.env`, never from `process.env`.** Use `@harness/shared`'s env
   helpers with `deps.env` as their last argument, so your variables are validated and worded like
   everyone else's — and so a test suite cannot open a real connection because the machine running
   it has a filled-in `.env`. Document every name in `.env.example` in the same commit:
   `surface.test.ts` walks `surfaces/` and fails on one you did not.

4. **Implement `SurfaceSession`.** Post and update a card, post text with an optional reply
   target, send a private note, upload a file, open a form, deliver actions and submissions, start
   and stop. Declare honestly what you cannot do:

   | Surface | forms | privateReply | update |
   | --- | --- | --- | --- |
   | `slack` | yes (a modal) | yes (ephemeral) | yes |
   | `memory` | yes | yes | yes |
   | Teams (planned) | yes (a task module) | no — post in the thread instead | yes |
   | Telegram (planned) | no — there is no modal | no | yes |

   The host reads those flags rather than trying and catching: a surface without `forms` gets an
   approval card with no Edit button, which is honest and needs no fallback protocol.

5. **Render the neutral models.** A `Card` has a title, an optional subtitle, body lines and
   actions; a `CardLine` is plain text, a labelled value, a preformatted block or a `note` of rich
   parts; a `NotePart` is text, a code span, a timestamp, a mention or an outcome icon. Turn each
   into whatever your surface draws. `Card.notice` is the one line to show where the card itself
   cannot go — a notification preview, a surface with no rich content.

6. **Throw `SurfaceError`, and watch what is in the message.** A bad conversation id, a missing
   capability, a transport that refused. The host writes that message into
   `tool_effects.last_error`, which is plaintext and which an operator pastes into a ticket, so
   name the surface and the operation and never a path, a token or a payload value.

7. **Test it against fakes.** Split the transport out behind an interface of your own, the way
   `surfaces/slack/src/transport/` does, and export a wired-to-fakes session from a `./testing`
   subpath. No test makes a real network call.

8. **Load it.** Add the package to `@harness/approvals`' dependencies and put its name in
   `HARNESS_SURFACES`. Nothing in the host changes.
````

Also update "Adding a test": the fakes line becomes "Fakes come from a package's `./testing`
subpath: `FakeGateway`, `MemorySurface`, `FakeCoreToolsClient`, `fakeSlackSession`,
`makeTestDeps`, `connectTools`. No test makes a real network call, a real model call, or a real
call to a messaging surface."

- [ ] **Step 5: README.md and the four package READMEs**

In `README.md`, the package map line becomes
`harness/approvals/   the approvals host: cards, decisions, the effects dispatcher` and two lines
are added:

```
harness/surface-api/ the Surface contract a messaging adapter implements
surfaces/            the messaging adapters: slack, memory
```

Add `[surface-api](harness/surface-api/README.md)`, `[surface-slack](surfaces/slack/README.md)`
and `[surface-memory](surfaces/memory/README.md)` to the package-READMEs row of its table.

Rewrite `harness/approvals/README.md`'s opening and layout block:

````markdown
# @harness/approvals

The approvals host. It polls `approvals` for pending rows and posts a card on the primary
messaging surface, records the decision, calls `approvals_execute` over a stdio MCP client, and
drains the `tool_effects` outbox through the `surface_message` and `surface_file` sinks on a
timer.

It holds no transport. Adapters are loaded by name from `HARNESS_SURFACES` — `@harness/surface-slack`
by default — and everything the host says is a neutral `Card`, `Form` or line of text from
`@harness/surface-api`.

## Layout

```text
src/domain/cards.ts      approvalCard, decidedCard, editForm: what a human reads, in neutral models
src/domain/surfaces/     loadSurfaces: HARNESS_SURFACES, the primary rule, the failure messages
src/domain/handlers.ts   the button and form handlers, authorised per surface
src/domain/execute/      the CoreToolsClient interface, the stdio MCP adapter, FakeCoreToolsClient
src/domain/poller.ts     claim a pending row, post its card, record the message reference
src/domain/decisions.ts  the one writer of approvals.status outside core-tools
src/domain/sinks.ts      surface_message and surface_file senders for the outbox
src/domain/runner.ts     three independent loops: poll, dispatch, reconcile
src/domain/health.ts     GET /healthz for the cron watchdogs
src/app/main.ts          connects the surfaces, wires the handlers, starts the runner
src/app/child-env.ts     the allowlist the core-tools child process is launched with
src/index.ts             the public API
src/testing.ts           ./testing: MemorySurface, FakeCoreToolsClient, useTestDb
```
````

and replace its "Two Slack apps, not one" section with a pointer, since that detail now belongs to
the adapter: "**Slack:** see `surfaces/slack/README.md`. The short version is that the host needs
its own Slack app, not Hermes's."

`harness/surface-api/README.md` gains, under its table, the capability matrix from
`CONTRIBUTING.md` step 4 and one sentence: "`MemorySurface` is both the fake every host test
drives and the whole of `@harness/surface-memory`, so the thing the suite proves the host against
is the thing that runs."

Create `surfaces/slack/README.md`:

````markdown
# @harness/surface-slack

Slack as one messaging surface. Block Kit, Bolt in Socket Mode, and the slice of the Web API the
approvals host needs, all behind `@harness/surface-api`.

```text
src/config.ts            the four variables this adapter reads, from deps.env only
src/session.ts           SurfaceSession over the transport: post, update, reply, upload, open a form
src/render/blocks.ts     a Card as Block Kit. Byte-pinned against what the app produced before Plan 6
src/render/modal.ts      a Form as a Slack modal view, and reading a submission back
src/transport/           the SlackApi slice, the WebClient adapter, the Bolt listener, the fakes
src/testing.ts           ./testing: FakeSlack, FakeSlackEvents, fakeSlackSession
```

## Two Slack apps, not one

This adapter needs `APPROVALS_SLACK_BOT_TOKEN` and `APPROVALS_SLACK_APP_TOKEN`, which are a
_different_ Slack app from Hermes's. Slack routes each Socket Mode event to exactly one of an
app's open connections, so one shared app loses about half of every button click. There is
deliberately no fallback to `SLACK_BOT_TOKEN`. It also reads `SLACK_APPROVALS_CHANNEL` (where
cards go) and `SLACK_ALLOWED_USERS` (who may decide; empty means nobody). All four names are
unchanged from before the surface contract existed.

## Capabilities

Forms (a modal), private replies (ephemeral messages) and editing a posted card: all three.

## What is pinned

`src/render/blocks.test.ts` and `src/render/modal.test.ts` hold this adapter's output against the
literal Block Kit the approvals app produced before Plan 6, for the pending card, the decided card
and the edit modal. Those three expectations are evidence that a demo deployment saw no change;
edit them only when you mean to change what a human sees.
````

Create `surfaces/memory/README.md`:

````markdown
# @harness/surface-memory

A messaging surface with no transport. It records what it was asked to post.

```bash
HARNESS_SURFACES=@harness/surface-memory pnpm approvals
```

That runs the whole approvals host — poller, decisions, dispatcher, health endpoint — against a
real database with no Slack workspace anywhere. Cards, replies and uploads are held in memory, so
what you can see from outside the process is the health endpoint and the `approvals` and
`tool_effects` rows: a poll tick fills in `surface = 'memory'`, `conversation_id = 'memory'` and a
`message_ref`, and a dispatch tick moves an effect to `dispatched` with
`result = { surface, conversation, message_id }`.

`MEMORY_ALLOWED_USERS` is a comma-separated list of user ids allowed to decide. Unset means
everyone — this is the only surface that may be open, and only because nothing it posts leaves the
process. An empty value means nobody, as on every other surface.

The session itself is `MemorySurface`, from `@harness/surface-api/testing`: the same class every
host test drives, so the adapter a developer runs and the fake the suite proves the host against
are one implementation.
````

- [ ] **Step 6: docs/runbook.md**

Rename the section at line 349 from `## The Slack approvals app` to
`## The approvals host and its surfaces` and rewrite its first half; the Slack half stays,
demoted to a sub-heading.

The opening becomes:

```markdown
`@harness/approvals` is the only writer of approval decisions and the only caller of
`approvals_execute`. It holds no transport of its own: it loads messaging adapters by name from
`HARNESS_SURFACES` (default `@harness/surface-slack`), and the **first one is primary** — the
surface approval cards are posted on. It runs three loops:

| Loop | Default | What it does |
|---|---|---|
| poll | 5s | posts a card on the primary surface for every `pending` approval with no `message_ref` |
| dispatch | 5s | drains `tool_effects` through the `surface_message` and `surface_file` sinks |
| reconcile | 300s | calls `harness_reconcile` through the core-tools MCP server |

Reconciliation goes through MCP rather than calling the helper directly, so the repair is scoped
to the client and lands in `audit_log` like any other call. The host has no privileged route into
the data.

**Run one approvals host per client.** The poller claims each row before it posts, by setting
`conversation_id` under a guard on the row still being `pending` with `conversation_id IS NULL`.
Only one claim can win that guard, so two pollers never both post a card for the same approval;
the loser's update affects zero rows and it logs the row as `orphaned`.

A claim can outlive the process that took it, so a claim older than two minutes that never got a
`message_ref` is released at the top of the next run and the row is posted again. The window runs
from `claimed_at` (migration 0007), not from `created_at`, so an old row claimed just now is not
released on the next tick.

Two failure points sit either side of the post and are handled differently. A post that fails
releases the claim, so the next run retries immediately. A post that succeeds but whose
`message_ref` write fails keeps the claim, because the card is already posted and releasing it
would put a second one beside it; that row waits for the two-minute sweep. A line in the log
reading "posted the card … but could not record its message reference" is that case.

**A decision is accepted only on the surface that posted the card.** `approvals.surface` records
which one that was. A press arriving from any other loaded surface is refused with the same
message an unknown approval gets, because from where the person is standing that is what it is.

**Allowlists are per surface**, parsed by each adapter from its own variable, and fail closed:
with `SLACK_ALLOWED_USERS` unset or empty, the Slack surface refuses every decision. There is no
default allowlist and no bypass.

**Effects are addressed, not assumed.** A staged effect's payload may name a `surface` and a
`conversation`; with neither, it goes to the primary surface's default conversation. A payload
naming a surface this host has not loaded fails that one effect with
`surface_message: no surface named "…" is loaded`, which `harness_reconcile` parks for review.

### Slack credentials: two apps are required
```

(everything from "Not a hardening recommendation" onwards is unchanged, including the table, the
no-fallback paragraph and the Compose paragraph.)

Further down the same section, the "Restricted values are kept out of Slack in three places"
heading becomes "Restricted values are kept away from a human in three places" and its third
bullet's wording stays as it is.

Two more edits outside that section:

- the "Effects outbox" section's two sink names, `slack_message` and `slack_file`, become
  `surface_message` and `surface_file` wherever they appear (lines around 127, 144, 164, 166,
  339), and the troubleshooting line "did the Slack message arrive?" becomes "did the message
  arrive on the surface?";
- add a subsection after "### Migration 0008 and the record model":

```markdown
### Migration 0009 and surface addressing

`0009_surface_addressing` replaces `approvals.slack_channel` and `slack_ts` with `surface`,
`conversation_id` and `message_ref`, and copies the existing addressing across with
`surface = 'slack'` wherever a card had been posted. A row that was claimed but never posted keeps
its `claimed_at` and lands with `conversation_id` set and `message_ref` null, which is exactly the
state the poller's stale sweep recovers — so a claim taken before the upgrade is still recovered
after it.

It also renames the sink on `tool_effects` rows that can still be sent — `staged`, `dispatching`
and `needs_review` — from `slack_message`/`slack_file` to `surface_message`/`surface_file`. Rows
that already dispatched or failed keep the name they were sent under, because that is the record
of what happened.

Their **payloads are not rewritten**, because they cannot be: `payload_encrypted` is ciphertext
and a migration has no key. An in-flight row therefore carries no `surface` and spells its
conversation `channel`; the host's sinks read both — no `surface` means the primary one — so the
row delivers exactly where it would have.

There is no down migration. Recovery from a bad 0009 is a database restore, as for 0008.
```

Finally, add a paragraph at the end of the "Slack credentials" sub-section, because a reader who
has just learned that the approvals host is surface-agnostic will ask the obvious question:

```markdown
**Hermes's own chat surface is a separate thing.** The two apps above are the harness's: one for
the agent's gateway, one for the approvals host's Slack adapter. Which platform *Hermes* speaks
is Hermes's own configuration, not this repository's code:
`clients/<client>/hermes.config.yaml` selects it, under `platforms:` and `platform_toolsets:`,
and Hermes ships adapters for Slack, Telegram and others. Pointing the agent at Telegram and the
approvals host at Slack is a supported combination; they are two independent connections and
neither knows about the other.
```

- [ ] **Step 7: A sentence in `docs/demo.md`**

`docs/demo.md` names no variable this plan changed, so it needs no rewrite. Add one sentence
after its two-Slack-apps table, so a reader of the demo script knows why Slack is what they see:

```markdown
The approvals host posts on whichever surface `HARNESS_SURFACES` names first; it defaults to
`@harness/surface-slack`, which is what this demo uses.
```

- [ ] **Step 8: Regenerate the module graph**

```bash
pnpm arch:graph
```

Expected: `docs/architecture/graph.svg` gains `harness/surface-api` and the two `surfaces/*`
nodes. This needs Graphviz (`dot`) on PATH. If it is not installed, say so in the task's report
and leave `graph.svg` untouched rather than hand-editing it — a stale graph with a note beats a
wrong one.

- [ ] **Step 9: Run every gate**

```bash
pnpm -r typecheck     # 0 errors
pnpm lint             # 0 errors
pnpm arch             # 0 violations
pnpm format:check     # the Markdown is formatted too
pnpm -r test          # green
pnpm surface:record && git status --porcelain docs/architecture   # no output, once Step 2's compose-surface.yaml is staged
```

`pnpm format:check` covers Markdown. Run `pnpm format` first if it complains, and keep the
formatting in this commit rather than a separate one — this task is documentation, so there is no
real change for it to hide.

- [ ] **Step 10: Commit**

```bash
git add .env.example clients harness/compose docs ARCHITECTURE.md CONTRIBUTING.md README.md harness/approvals/README.md harness/surface-api/README.md surfaces
git commit -m "docs: describe the surface contract, its adapters and migration 0009"
```

No trailer of any kind.

---

## When every task is done

The plan is finished when all six commits are on the branch and, from a clean tree:

```bash
pnpm -r typecheck && pnpm lint && pnpm arch && pnpm format:check && pnpm -r test
pnpm surface:record && git status --porcelain     # no output
git log --oneline -6                              # six commits, no trailer on any of them
```

and these five statements are true, each of which a test now enforces:

1. `harness/approvals/src` contains no Slack word (`host-vocabulary.test.ts`).
2. `harness/core-tools/src`, `packs/healthcare/src` and `packs/stories/src` contain no messaging
   word (`kernel-vocabulary.test.ts`).
3. The Slack adapter renders the pending card, the decided card and the edit modal exactly as the
   approvals app rendered them before this plan (`surfaces/slack/src/render/*.test.ts`).
4. `docs/architecture/tool-surface.json` differs from main in four places and no others
   (`harness/core-tools/src/app/surface.test.ts`).
5. Two surfaces can be loaded at once, cards go to the primary, effects go where they are
   addressed, and a decision cannot be taken from the wrong one
   (`harness/approvals/src/domain/surfaces/dual-surface.test.ts`).
