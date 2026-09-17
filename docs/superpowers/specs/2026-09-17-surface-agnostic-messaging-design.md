# Surface-agnostic messaging — design (Plan 6)

**Date:** 2026-09-17
**Status:** designed with defaults under the overnight mandate; every decision is listed in section 2 for the morning review
**Baseline:** main after the Plan 5 merge (pack-agnostic kernel, `@harness/pack-api`, packs loaded via `HARNESS_PACKS`)
**Predecessors:** `2026-09-16-maintainability-revamp-design.md` (layers, plug-in packs), `2026-09-16-pack-agnostic-core-design.md` (the kernel)

## 1. Goal

The harness talks to humans through Slack today: the approvals app posts
Block Kit cards, takes button decisions and modal edits, and drains the
effects outbox through two Slack sinks; the kernel's `harness_notify` and the
healthcare pack's `forms_release` validate a Slack channel id and stage
`slack_message` / `slack_file` effects; the `approvals` table carries
`slack_channel` / `slack_ts`. The user's framing: Slack is one integration,
Telegram and Microsoft Teams (the Weave client) are others, and the backbone
must not know which one is plugged in.

After Plan 6:

- A **Surface contract** (`@harness/surface-api`) describes what a messaging
  surface can do: post and update a card, post text in a thread, send a
  private note, upload a file, optionally open a form, and deliver the
  human's actions back. Cards, forms, conversations and message references
  are neutral models; no Block Kit, Bolt or Slack id shape appears outside
  the Slack adapter.
- The approvals app becomes the **surface host**: its poller, decisions,
  sinks, runner and health loop are written against the contract and load
  adapters from `HARNESS_SURFACES`, exactly as the kernel loads packs from
  `HARNESS_PACKS`. The first entry is the **primary surface**, where
  approval cards are posted.
- **`@harness/surface-slack`** is the first adapter, built from today's code
  with no behaviour change for the demo deployment: same cards, same
  buttons, same modal, same threads, same env variable names.
- **`@harness/surface-memory`** is the proof adapter: an in-process surface
  with no transport, used by the suite as a second loaded surface and by
  developers to run the host without Slack.
- Effects are addressed to a surface by name (`surface_message`,
  `surface_file`, payload carries `surface` and `conversation`); the kernel
  and the packs never name Slack.
- A vocabulary test keeps `slack`, `bolt`, `block kit`, `thread_ts`,
  `blocks` out of the host, the kernel and the packs (outside tests and the
  Slack adapter).

Non-goals: writing the Telegram or Teams adapters (the contract and the
adapter guide make them a bounded task each); changing Hermes's own chat
platform (Hermes speaks Slack, Telegram and others natively and the client's
`hermes.config.yaml` selects that; it is the agent's chat surface, not the
approvals surface); identity beyond "allowed user ids per surface"; routing
one approval to more than one surface at once.

## 2. Decisions taken with defaults (for the morning review)

| # | Question | Decision | Why |
|---|---|---|---|
| 1 | Where the contract lives | New leaf package `harness/surface-api` (`@harness/surface-api`), mirroring `@harness/pack-api`: `types.ts` leaf, `defineSurface`, zod models, `testing` subpath with the memory surface's building blocks. | Adapters must not depend on the host; a leaf package is the only cycle-free home. |
| 2 | Where adapters live | `surfaces/slack` (`@harness/surface-slack`) and `surfaces/memory` (`@harness/surface-memory`), workspace packages that import only `@harness/surface-api` and `@harness/shared`. | Same shape as `packs/*`; dependency-cruiser enforces it. |
| 3 | How the host finds adapters | `HARNESS_SURFACES` (comma-separated package names; first = primary), dynamic import, `ConfigError` when empty or when two adapters share a name. Compose defaults it to `@harness/surface-slack`. | Identical to `HARNESS_PACKS`; no static import of an adapter in the host. |
| 4 | Package name of the host | `@harness/approvals` keeps its name and path; its README calls it "the approvals host". | Renaming a package touches compose, docs and scripts for no behaviour gain. |
| 5 | Neutral card model | `Card { title, body: CardLine[], actions: CardAction[], footer? }` with `CardLine = { label, value } | { text }` and `CardAction { id, label, style: 'primary' | 'danger' | 'default', value }`; `DecidedCard` is a `Card` with no actions. Adapters render it; the host never sees a rendered shape. | Small enough to render on any surface (Block Kit, Adaptive Cards, inline keyboards). |
| 6 | Forms (the Edit modal) | Optional capability `forms`. `Form { id, title, fields: FormField[], metadata }`, one multiline text field today. An adapter without `forms` never receives the Edit action: the host omits that action from the card. | Telegram has no modal; hiding the button is honest and needs no fallback protocol. |
| 7 | Addressing | `Conversation { surface, id }` and `MessageRef { surface, conversation, id }` (all strings). `thread`/`reply` semantics: `postText(conversation, text, { replyTo?: MessageRef })`; the adapter decides what a reply is (Slack: `thread_ts`; Teams: reply to activity; Telegram: `reply_to_message_id`). | One reference type covers every surface's `(channel, ts)` / `(chat, message_id)` / `(conversation, activity)` pair. |
| 8 | Database | Migration `0009_surface_addressing`: `approvals` gains `surface text`, `conversation_id text`, `message_ref text`; data copied from `slack_channel` / `slack_ts` with `surface = 'slack'` where `slack_channel IS NOT NULL`; the two Slack columns dropped; `claimed_at` unchanged. The poller's claim marker becomes `conversation_id`. Pending `tool_effects` rows are rewritten in the same migration: `sink 'slack_message' → 'surface_message'`, `'slack_file' → 'surface_file'`, payload gains `surface: 'slack'`. No down migration (restore is the recovery). | The claim protocol is defined in terms of those columns; renaming is a migration, not a refactor. |
| 9 | Effect sink names | Two generic sinks, `surface_message` and `surface_file`, registered once by the host and resolved per effect from `payload.surface ?? primary`. Results are neutral: `{ surface, conversation, message_id }` and `{ surface, conversation, filename }`. | The outbox is already neutral; only the names and the call sites named Slack. |
| 10 | Kernel and pack tool schemas | `harness_notify` and `forms_release` keep the `channel` argument name (skills and prompts use it) but its validation becomes a neutral conversation id (`^[A-Za-z0-9][A-Za-z0-9:_@.\-]{0,127}$`) and both gain an optional `surface` argument naming a loaded surface; descriptions no longer say Slack. `docs/architecture/tool-surface.json` changes **deliberately** in exactly those four places (two patterns, two new optional properties) and is re-recorded in the task that changes them. The adapter validates the id shape at dispatch; a bad id fails the effect with the adapter's message, visible through `harness_reconcile`. | The kernel cannot know a surface's id format; the outbox already models failure per effect. |
| 11 | Secrets and the child process | `defineSurface({ secrets: [...] })` declares the env names an adapter reads that must never reach the core-tools child; `coreToolsChildEnv` strips the union of every loaded surface's `secrets` plus the existing model-provider keys. The Slack adapter declares `APPROVALS_SLACK_BOT_TOKEN`, `APPROVALS_SLACK_APP_TOKEN`, `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN`. Compose's `sed '/^APPROVALS_SLACK_/d'` filter for the Hermes service stays (deployment-level, documented). | The child-env allowlist must not hard-code any surface. |
| 12 | Env variable names | Unchanged. The Slack adapter reads its four variables and `SLACK_APPROVALS_CHANNEL`, `SLACK_ALLOWED_USERS` from `deps.env`; the only addition is `HARNESS_SURFACES` (documented in `.env.example`, defaulted in compose). | Behaviour preservation for the demo deployment. |
| 13 | Allowed users | Per surface: an adapter exposes `allowedUsers: ReadonlySet<string>` parsed from its own env (`SLACK_ALLOWED_USERS` for Slack); the host authorises a decision against the set of the surface the action arrived on; an empty set fails closed, as today. | User ids are surface-scoped; a Teams AAD id and a Slack id never compare. |
| 14 | Where approvals are posted | The primary surface only. Decisions are accepted from any loaded surface that posted the card (the row's `surface`); a decision arriving on a different surface is refused with the same "not the card's surface" message the user sees for an unauthorised id. | One approval, one card, one place to answer it; multi-post is a later feature. |
| 15 | Hermes chat surface | Out of scope. `hermes.config.yaml`'s `platforms.slack` block is Hermes's own configuration and is left as is; the runbook says which knob selects Telegram or Teams for the agent's chat. | Hermes is a third-party dependency with its own adapters. |
| 16 | Skills | `packs/healthcare/skills/*/SKILL.md` untouched (the intake skill's description says "from Slack", which is true of the demo deployment's Hermes chat surface). | Skills are prompts; editing them changes agent behaviour and is not this plan's job. |
| 17 | Proof of preservation | The Slack adapter's rendered Block Kit for a fixed approval row is pinned byte-for-byte to today's output (the existing `blocks.test.ts` fixtures move with the code and keep their assertions); the poller/decision/runner tests run against the memory surface and, once, against `FakeSlack` through the adapter; `pnpm surface:record` changes only the four schema places listed in decision 10. | The demo must post the same card, thread the same reply, upload the same file. |

### 2a. Amendments taken while writing the plan

The plan (`docs/superpowers/plans/2026-09-17-plan-6-surface-agnostic-messaging.md`, section
"Decisions where the spec and no-behaviour-change pull apart") records nineteen rulings,
all accepted by the controller. The ones that change this document's wording: the card and
form models are richer than decisions 5 and 6 (`NotePart`, `Card.id/subtitle/notice`,
`Form.cancelLabel/intro`, `FormField.maxLength/placeholder`) because today's Block Kit bytes
cannot be reproduced from the smaller model; `SurfaceSession.mention(userId)` exists for the
thread reply; the migration renames sink names on sendable rows only and rewrites no payload
(payloads are encrypted; a payload without `surface` resolves to the primary surface and the
sinks accept the legacy `channel` key); the conversation-id pattern lives in `@harness/shared`
and is re-exported by `@harness/pack-api`; `MEMORY_ALLOWED_USERS` is a second, optional env
addition; the health endpoint does not expose posted cards (it never carries approval content),
so the memory adapter's README points at the database rows and the log instead.

## 3. The contract (`@harness/surface-api`)

```ts
// harness/surface-api/src/types.ts — leaf, no imports from the workspace
export interface Conversation { surface: string; id: string }
export interface MessageRef { surface: string; conversation: string; id: string }

export type CardLine = { label: string; value: string } | { text: string };
export interface CardAction { id: string; label: string; style: 'primary' | 'danger' | 'default'; value: string }
export interface Card { title: string; body: readonly CardLine[]; actions: readonly CardAction[]; footer?: string }

export interface FormField { id: string; label: string; multiline: boolean; optional: boolean }
export interface Form { id: string; title: string; submitLabel: string; fields: readonly FormField[]; metadata: string }

export interface ActionEvent {
  surface: string; userId: string; conversation: string; message: MessageRef | null;
  actionId: string; value: string; trigger: string | null;   // trigger: opaque handle for openForm
}
export interface FormEvent { surface: string; userId: string; conversation: string; formId: string; metadata: string; values: Record<string, string> }

export interface SurfaceCapabilities { forms: boolean; privateReply: boolean; update: boolean }

export interface SurfaceSession {
  readonly name: string;
  readonly capabilities: SurfaceCapabilities;
  readonly allowedUsers: ReadonlySet<string>;
  readonly defaultConversation: string;
  postCard(conversation: string, card: Card): Promise<MessageRef>;
  updateCard(ref: MessageRef, card: Card): Promise<void>;
  postText(conversation: string, text: string, opts?: { replyTo?: MessageRef }): Promise<MessageRef>;
  postPrivate(conversation: string, userId: string, text: string): Promise<void>;
  uploadFile(conversation: string, file: { path: string; filename: string; comment?: string; replyTo?: MessageRef }): Promise<{ filename: string }>;
  openForm(trigger: string, form: Form): Promise<void>;       // rejects with SurfaceError when !capabilities.forms
  onAction(handler: (event: ActionEvent) => Promise<void>): void;
  onFormSubmit(handler: (event: FormEvent) => Promise<void>): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface SurfaceDeps { env: EnvSource; log: Logger; storageDir: string }
export interface Surface {
  name: string; version: string;
  secrets: readonly string[];                                  // env names never forwarded to the core-tools child
  connect(deps: SurfaceDeps): Promise<SurfaceSession>;
}
```

`defineSurface(surface)` validates the shape (name pattern `^[a-z][a-z0-9-]*$`, unique
secrets). `SurfaceError` (in `@harness/shared` errors, alongside `ToolError`) is what an
adapter throws for a bad conversation id, a missing capability or a transport
failure; the host records its message on the effect or replies with it in the
thread, never the stack. The `testing` subpath exports `MemorySurface`, the
in-process session used by `@harness/surface-memory` and by every host test:
it stores posted cards and texts in arrays and exposes `press(actionId, value,
userId)` and `submit(formId, values, userId)` to simulate a human.

## 4. The host (`@harness/approvals`) after the move

```
harness/approvals/src/
  domain/
    cards.ts          approvalCard(row): Card, decidedCard(row, outcome): Card, editForm(approvalId, conversation): Form
                      (plain text; today's approvalFallbackText/payloadPreview/safeNote/executionFailureLine live here)
    poller.ts         postPendingApprovals(deps): claims by conversation_id, posts on the primary surface, stores message_ref
    decisions.ts      decideApproval(deps, input): unchanged logic; replies with postText({ replyTo: MessageRef })
    handlers.ts       registerApprovalHandlers(session, deps): onAction/onFormSubmit against the contract; authorises against session.allowedUsers
    sinks.ts          surfaceSinks(sessions, primary): { surface_message, surface_file } resolving payload.surface ?? primary
    surfaces/registry.ts  loadSurfaces(names, deps): dynamic import, ConfigError rules, primary = first
    runner.ts, health.ts, execute/*   unchanged in logic; typed on SurfaceSession
  app/
    main.ts           reads HARNESS_SURFACES, connects every surface, wires handlers and sinks, starts the runner
    child-env.ts      strips the union of loaded surfaces' secrets
```

Card ids (`harness_approval_approve` etc.) stay as the neutral `CardAction.id`
values; the Slack adapter uses them as Block Kit `action_id`s, so the demo
deployment's interaction payloads do not change.

## 5. The Slack adapter (`surfaces/slack`)

`src/index.ts` exports `surface = defineSurface({ name: 'slack', … })`;
`src/render/{blocks,modal}.ts` are today's files, now taking a `Card` / `Form`
and producing Block Kit; `src/transport/{bolt,web-client}.ts` are today's
`main.ts` Bolt block and `web-client.ts`; `src/session.ts` implements
`SurfaceSession` (`postCard` → `chat.postMessage` with blocks and fallback
text; `updateCard` → `chat.update`; `postText` with `replyTo` → `thread_ts`;
`postPrivate` → `chat.postEphemeral`; `uploadFile` → `files.uploadV2` with the
existing path-traversal check moved to the host's sink; `openForm` →
`views.open` with the modal; `onAction` → `bolt.action`; `onFormSubmit` →
`bolt.view`). `SlackApi` and `FakeSlack` move with it; env read through
`deps.env` only. The adapter validates a conversation id against
`^[CGD][A-Z0-9]{2,}$` and throws `SurfaceError` otherwise.

## 6. The memory adapter (`surfaces/memory`)

`defineSurface({ name: 'memory', secrets: [], connect })` returning a
`MemorySurface` whose `defaultConversation` is `'memory'` and whose
`allowedUsers` come from `MEMORY_ALLOWED_USERS` (default `*` = everyone, the
only surface that may be open, and only because it has no transport). Its
README shows running the host locally with `HARNESS_SURFACES=@harness/surface-memory`
and reading the posted cards from the health endpoint's `surfaces.memory`
snapshot.

## 7. Kernel and packs

- `harness/core-tools/src/domain/session/repository.ts` `stageNotification`
  stages `surface_message` with `payload { text, conversation: channel ?? null, surface: surface ?? null }`.
- `harness/core-tools/src/domain/files/release.ts` `stageRelease` stages
  `surface_file` with the same addressing; `MAX_RELEASE_BYTES` stays with a
  neutral comment (the smallest limit among supported surfaces).
- `tools/harness.ts` `harness_notify` and `packs/healthcare/src/tools/forms.ts`
  `forms_release`: neutral descriptions, the shared conversation-id regex
  exported from `@harness/pack-api` (`CONVERSATION_ID_PATTERN`) so the pack does
  not duplicate it, optional `surface` argument.
- The vocabulary test in core-tools gains the messaging words; the host gets
  its own (`harness/approvals/src/host-vocabulary.test.ts`).

## 8. Configuration and docs

- `.env.example` and `clients/demo-practice/.env.example`: `HARNESS_SURFACES=@harness/surface-slack`
  under a new "Messaging surfaces" heading; the Slack variables move under a
  "Slack adapter" sub-heading, names unchanged.
- `harness/compose/docker-compose.yml`: `HARNESS_SURFACES: '${HARNESS_SURFACES:-@harness/surface-slack}'`
  on the approvals service; `compose-surface.yaml` re-recorded.
- `ARCHITECTURE.md` gains "Surfaces" beside "Packs"; `CONTRIBUTING.md` gains
  "Adding a surface" with the memory adapter as the worked example and a
  capability matrix (Slack, memory, Telegram and Teams as planned);
  `docs/runbook.md`'s "The Slack approvals app" becomes "The approvals host
  and its surfaces" with the Slack section kept under it; `docs/demo.md`
  unchanged except the variable list.

## 9. Proof

- Slack adapter render tests pin today's Block Kit bytes for the pending
  card, the decided card and the edit modal.
- Host tests run against the memory surface: claim/release, posting,
  decisions in a thread, unauthorised user, edit form round trip, sink
  dispatch to a named surface and to the primary.
- A dual-surface test loads `slack` (FakeSlack transport) and `memory`,
  posts approvals on the primary, sends a `surface_message` to the other,
  refuses a decision from the wrong surface, and proves the child env strips
  the Slack secrets.
- Migration test on a snapshot: rows with `slack_channel`/`slack_ts` land in
  the new columns with `surface = 'slack'`; pending `slack_*` effects are
  renamed with `payload.surface = 'slack'`; the claim protocol still recovers
  a stale claim.
- `pnpm surface:record` differs from main only in the four schema places of
  decision 10, verified by a test that diffs the snapshot against a committed
  expectation.

## 10. Migration order (tasks)

1. `@harness/surface-api`: contract, `defineSurface`, models, `MemorySurface` under `testing`, `SurfaceError` in `@harness/shared`; tests.
2. `@harness/db`: migration `0009_surface_addressing` with the data section; migration test.
3. `surfaces/slack` built from the existing render/transport code (render bytes pinned) and `surfaces/memory`; both packages green in isolation.
4. The host rewired to the contract: cards, poller, decisions, handlers, sinks, registry, runner, main, child-env; Slack code deleted from the host; host vocabulary test; dual-surface test; arch rules (`surfaces-import-only-api-and-shared`, `host-never-imports-a-surface`).
5. Kernel and pack tools: generic sinks, neutral schemas with `surface`, `CONVERSATION_ID_PATTERN`, snapshot re-recorded with the diff test; core-tools vocabulary words.
6. Configuration and docs: env examples, compose, ARCHITECTURE, CONTRIBUTING "Adding a surface", runbook, READMEs, root README package map, graph.svg.

Process: subagent-driven development as before (worktree, ledger, task reviews,
one final review and fix wave, simplifier pass), merged to main when green.

## 11. Open items deliberately left out

- Telegram and Teams adapters (each a bounded task against the contract; Teams
  needs an Azure Bot registration and Adaptive Cards; Telegram needs a bot token
  and inline keyboards, no forms).
- Posting one approval on several surfaces, or per-approval surface routing
  from the run's originating conversation (`runs.channel` is unused today).
- Identity across surfaces (a person known on Slack and Teams); a control
  plane would own that.
