# The kernel — design (Plans 7–10)

**Date:** 2026-09-17
**Status:** designed under the "full kernel, delivered by agents" mandate; every decision is in section 2 for review, and each sub-project lands as its own pull request
**Baseline:** main at `51f2859` (Plan 6 merged: packs via `HARNESS_PACKS`, surfaces via `HARNESS_SURFACES`, Hermes as the agent runtime)
**Predecessors:** `2026-09-16-pack-agnostic-core-design.md` (the kernel as an MCP tool server), `2026-09-17-surface-agnostic-messaging-design.md` (the surface contract)
**Inputs compared:** the Kai-on-agent-sandbox plan (`deep-agents-on-agent-sandbox-plan.md`, Deep Agents + Kubernetes sandboxes for a hosted multi-tenant analytics platform) and the Project Weave spec v1.3 (an owned harness on Teams and Entra ID for ~130 employees)

## 1. Goal

Today the harness is an MCP tool server with policy, approvals, effects and audit, and
**Hermes owns the agent**: the loop, memory, skills loading, cron, context management and the
conversational Slack channel are all Hermes, configured by one YAML file. That is the ceiling.
Every capability the next clients need — a principal bound to a run that the model cannot
choose, Teams as a conversation surface, a run that pauses on an approval and resumes when a
human decides, memory and knowledge that respect who is asking, scheduled work with a service
identity — needs the loop, and the loop is not ours.

After Plans 7–10 the kernel is **the control plane every client runs**, and it knows nothing
about any of them:

| Kernel module          | What it is                                                                                              | Status after this series |
| ---------------------- | ------------------------------------------------------------------------------------------------------- | ------------------------ |
| Identity and policy    | a `Principal` resolved by the host, a level × action-class policy matrix, a run context bound before the model sees anything | new (Plan 7)              |
| Tool gateway           | the kernel tools plus registered MCP integrations, every call through policy, audit and the effects outbox | exists; per-principal (Plan 7) |
| Approvals and effects  | parked actions, cards on a surface, exactly-once delivery with replay, and the run resumes on a decision  | exists; resume (Plan 8)  |
| Audit                  | append-only, principal and run on every row                                                             | exists; principal (Plan 7) |
| Records                | the generic record, field, attachment, deadline and document tables                                     | exists                   |
| Files worker           | untrusted document parsing in a process with no network and no secrets                                  | new (Plan 7)             |
| Runtime host           | the one long-running process per client: loads the runtime, surfaces and identity provider; threads, runs, streaming, cancel | new (Plan 8)  |
| Memory                 | capped curated memory per principal plus episodic search over the principal's own threads              | new (Plan 9)             |
| Scheduler              | playbooks with a service principal, preflight, replay and silent delivery                               | new (Plan 9)             |
| Knowledge              | an ACL-filtered vector + keyword index in the same Postgres                                             | new (Plan 10)            |
| Run API                | the host's own HTTP interface for surfaces that live in another process (voice, a web UI)               | new (Plan 10)            |

Everything client-specific is a **plug-in loaded by name**, exactly as packs and surfaces are today:

| Extension point   | Contract package            | Loaded from        | First implementation                 | Weave adds later           |
| ----------------- | --------------------------- | ------------------ | ------------------------------------ | -------------------------- |
| Pack              | `@harness/pack-api`         | `HARNESS_PACKS`    | `packs/healthcare`, `packs/stories`  | an `alliance` pack         |
| Surface           | `@harness/surface-api`      | `HARNESS_SURFACES` | `surfaces/slack`, `surfaces/memory`  | `surfaces/teams`           |
| Identity provider | `@harness/identity-api`     | `HARNESS_IDENTITY` | `identities/static`                  | `identities/entra`         |
| Runtime           | `@harness/runtime-api`      | `HARNESS_RUNTIME`  | `runtimes/deepagents`                | (same)                     |
| Integration       | any MCP server              | `clients/<name>/integrations.yaml` (Plan 10) | none in this series | HubSpot, Graph, ClickUp |

Model choice stays where it is: named routes in `clients/<name>/routing.yaml`, rendered into LiteLLM.

**Non-goals of this series.** The Teams surface, the Entra provider and the Alliance pack (Weave
extensions, each a bounded task once the kernel exists). Sandboxed code execution and browser
use (no client has asked; the runtime contract leaves room for a `runtimes/sandboxed` later).
Multi-tenant hosting: one deployment per client, one database, one key, and the code never
carries a `tenant_id`. A web admin console. Fine-tuning. Replacing LiteLLM.

## 2. Decisions taken (for review)

| #  | Question | Decision | Why |
| -- | -------- | -------- | --- |
| 1  | Who owns the loop | A `Runtime` plug-in behind a leaf contract. First implementation: **Deep Agents JS** (`deepagents` npm, LangGraph.js) in `runtimes/deepagents`. Hermes is retired in Plan 8. | Verified 2026-09-17: the JS package has `interruptOn`, memory, skills, summarisation, subagents, backends and MCP loading, and a Postgres checkpointer package exists. It is on Weave's shortlist with the Stripe precedent a CTO will accept, and it keeps one language. Behind a contract, because it releases weekly and because a voice surface will want a leaner loop. |
| 2  | One process or several | **One host process per client** (`@harness/host`) replaces the `hermes`, `hermes-init` and `approvals` services. It loads the runtime, the surfaces and the identity provider, runs the approvals loops, the scheduler and the run API, and hosts core-tools **in-process** over the MCP in-process transport. The stdio MCP server stays for the inspector and the eval runner. | Two Slack apps and two core-tools children existed only because Hermes owned chat. One process is what makes a run resumable on a decision and a principal bindable before the model runs. |
| 3  | Where the credential boundary moves | The surface-secret allowlist that kept Slack tokens out of the core-tools child is replaced by two boundaries that matter more: **the files worker** (untrusted parsing; no network, no key, no database) and **the model gateway** (provider keys never leave LiteLLM). The host holds the encryption key, the database URL and surface tokens, as the approvals host already did. | The child boundary protected the kernel from Hermes, a third-party runtime. The runtime is now ours. |
| 4  | Identity | A `Principal { id, kind: 'user' \| 'service', level, displayName, surfaces, attributes }` resolved by an **identity provider** from `(surface, userId)`. The host binds it to the run; a tool reads `deps.principal`; nothing the model sends can set it. `harness_set_context` is removed. | The Kai plan's one idea every client needs: identity the model can never choose. Attribution that depends on the model calling a tool is voluntary. |
| 5  | Levels | Four cumulative levels, generic names: `member`, `practitioner`, `lead`, `admin`, plus `service` for playbook identities. Weave's L1–L4 map onto them one to one; the practice uses `lead` for its two coordinators and `admin` for the operator. | Weave §3.2 is the only concrete multi-level requirement we have and it is generic enough to be the kernel's. |
| 6  | Policy | The flat action-class table becomes a **matrix**: `classes` (defaults for every level, today's file unchanged) plus `levels.<level>.<class>` overrides. Action classes gain `write.self`, `write.assign` and `admin`. `decide(actionClass, level, policy)` replaces `decide(actionClass, policy)`. | Weave §3.3 verbatim, and today's `policy.yaml` keeps working unchanged. |
| 7  | Run context | `RunContext { runId, threadId, principal, surface, conversation, skill?, skillVersion? }` is built by the host per run and handed to core-tools per session; one `ToolDeps` per run, never a process-wide mutable object. The runtime stamps `skill` when it activates one. | The comment in `server.ts` already says a multi-session transport must build one `deps` per session. Now there is one. |
| 8  | Approvals and the run | Policy still parks the action in `approvals` and returns `{status: 'pending', approval_id}` to the model (the source of truth, with idempotency, TTL and audit). The turn ends. When the decision executes, the host **resumes the thread** with one host-authored message carrying the outcome, so the agent continues the workflow. Deep Agents' own `interruptOn` is not used for policy. | Our approvals table is stronger than a LangGraph interrupt (idempotent, TTL, audited, replayable) and the resume is one message on the same thread. |
| 9  | Threads and messages | Kernel tables `threads` and `messages` (full-text indexed) are the record of every conversation and playbook run; the LangGraph checkpointer keeps its own tables in a `langgraph` schema for resume only. | Episodic memory and the audit trail must not depend on a framework's checkpoint format. |
| 10 | Surfaces gain inbound | The surface contract adds `onMessage`, `startStream` (optional), `capabilities.streaming` and `capabilities.inlineConfirm`, and attachments land in `<storageDir>/incoming/`. One Slack app carries chat and approvals. | Voice and Teams both need streaming and interruption; adding them later touches every adapter. |
| 11 | Document parsing | `@harness/files`: a tiny HTTP worker on an internal-only Compose network, mounting the storage volume, running `pdftoppm`, `pdftotext` and `tesseract`. core-tools calls it through a `DocumentParser` seam; a `localParser` (subprocess) remains for tests and bare-metal development. Redaction stays in core-tools. | An untrusted PDF is parsed today in the process that holds the encryption key. |
| 12 | Memory | Hermes semantics on kernel tables: **curated** entries per scope (principal or client) under a character cap, written through `memory_add` / `memory_remove` with client-scope writes behind policy; **episodic** recall through `session_search` over the principal's own threads. Every write is scanned for injection patterns and invisible Unicode. | What both the current config and the Weave spec ask for, and the model the user already knows. |
| 13 | Knowledge | pgvector in the existing Postgres (`pgvector/pgvector:pg16` image), one `knowledge_chunks` table with a `vector(1024)` column, tsvector, and ACL columns (`min_level`, `principals`). Embeddings through a new `embed` route on LiteLLM. Hybrid search fused by reciprocal rank. Sources: a directory of markdown with frontmatter under `clients/<name>/knowledge/`, synced by a playbook. | Kai's permission-aware retrieval without its per-dimension tables and tenant partitions. One database to back up. |
| 14 | Scheduler | `playbooks` table synced from `clients/<name>/playbooks.yaml` at host startup; a scheduler in the host opens a playbook thread as the named **service principal**; `deliver: none` by default; failure notices are single-send through the effects outbox keyed on `(playbook, scheduled_at)`. The shell cron scripts and watchdogs are retired. | Hermes cron semantics (preflight, silence, replay) on our own tables, with a service identity per job as Weave §3.1 requires. |
| 15 | Run API | The host exposes `POST /v1/runs` (SSE events), `POST /v1/runs/:id/cancel` and `GET /v1/threads/:id`, bearer-authenticated with `HARNESS_HOST_TOKEN`, bound to loopback by default. Surfaces in-process do not use it. | The one design choice that lets a voice pipeline or a web UI in another process drive the same runtime. |
| 16 | Streaming to the model | The runtime talks to LiteLLM's OpenAI-compatible endpoint through LangChain's `ChatOpenAI` with `configuration.baseURL`, sending the principal id as the request `user` so LiteLLM attributes spend per person. The `chat` route is the loop's model; `reason` its fallback. | Provider keys stay in the proxy; per-user attribution is a LiteLLM feature we get for free. |
| 17 | Client folder | `clients/<name>/` = `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`, `playbooks.yaml`, `knowledge/`, `.env`. Compose derives every path from `HARNESS_CLIENT`; the three hard-coded `demo-practice` references and the pinned healthcare forms path go. | Onboarding a client is a folder and a deployment, never a compose edit. |
| 18 | CI | `.github/workflows/ci.yml` with a pgvector Postgres service running the four gates and the image builds on every pull request. | There is no pipeline today; the "four gates" are a manual ritual. |
| 19 | Package layout | New leaf contracts `harness/identity-api`, `harness/runtime-api`; new kernel packages `harness/host`, `harness/files`; plug-in directories `identities/`, `runtimes/` beside `packs/` and `surfaces/`. `@harness/approvals` keeps its name and becomes a library the host composes (its `main.ts` moves to the host). | Same shape as Plan 6; dependency-cruiser gets one row per package. |
| 20 | Kernel vocabulary | The grep tests widen: no `deepagents`, `langchain`, `langgraph` outside `runtimes/deepagents`; no `entra`, `slack`, `teams` in the kernel, the host or the runtime; no client name in code. | The same test that keeps medicine out of the kernel keeps the framework out of it. |
| 21 | Evals | The eval runner keeps driving the pipeline through the in-process MCP server with a `service` principal and is unchanged in shape. A `ScriptedRuntime` in `@harness/runtime-api/testing` replays a trajectory file so host tests need no model. | Extraction quality is measured where it was; the loop is tested with a fake gateway and a scripted runtime. |
| 22 | What is deliberately not built | Sandbox controller, warm pools, gVisor, LangGraph server, per-tenant namespaces, two-pass tool loading, per-dimension chunk tables, an admin console. | Neither client asked. Every one is reachable later through the contracts above. |

## 3. Architecture

### 3.1 Packages

```
harness/shared          unchanged: env, errors, paths, log, subprocess, jsonl, csv
harness/pack-api        + action classes write.self, write.assign, admin
harness/surface-api     + MessageEvent, onMessage, startStream, capabilities.streaming / inlineConfirm
harness/identity-api    NEW leaf: Principal, Level, IdentityProvider, defineIdentityProvider, testing (StaticIdentity)
harness/runtime-api     NEW leaf: Runtime, RunRequest, RunEvent, RunHandle, defineRuntime, testing (ScriptedRuntime)
harness/db              + principal_id columns, threads, messages, memory_entries, playbooks, playbook_runs,
                          knowledge_*; pgvector extension
harness/gateway         + `embed` route
harness/core-tools      the kernel: identity/policy matrix, run context per run, DocumentParser seam,
                          memory, knowledge, playbooks and threads domains and their tools
harness/approvals       library only: cards, decisions, poller, sinks, runner loops, health; the resume hook
harness/files           NEW: the parsing worker (HTTP, no db, no key)
harness/host            NEW: the one process per client; composition root of everything above
identities/static       NEW: principals from clients/<name>/identity.yaml
runtimes/deepagents     NEW: the Deep Agents JS runtime
surfaces/slack          + inbound messages, streaming, attachments; one app
surfaces/memory         + inbound (used by every host test)
packs/*                 skills lose the `harness_set_context` step; otherwise unchanged
evals                   principal instead of caller; otherwise unchanged
scripts                 scaffolder writes the new client folder
```

Dependency rules, all at error severity, added to `.dependency-cruiser.cjs`:

- `identity-api` and `runtime-api` import only `@harness/shared` and zod.
- `identities/*` import only `@harness/identity-api` and `@harness/shared`.
- `runtimes/*` import only `@harness/runtime-api`, `@harness/shared` and third-party packages. A runtime never imports core-tools, db, a surface, a pack or the host: it receives tools as an MCP client and its dependencies on the bag.
- `harness/files` imports `@harness/shared` only.
- `harness/host` imports everything below it and is the only package that imports `@harness/approvals`' host-side modules. It never imports a plug-in statically.
- `core-tools` never imports `identity-api`'s or `runtime-api`'s implementations, only the contracts.

### 3.2 One request, end to end (interactive)

1. A human writes in Slack. `surfaces/slack` delivers a `MessageEvent { surface: 'slack', userId, conversation, text, attachments, message, mentioned }` to the host's `onMessage` handler. Attachments are already under `<storageDir>/incoming/`.
2. The host asks the identity session: `resolve({ surface: 'slack', userId })`. `null` → the host posts "you are not authorised to use this assistant" and stops; nothing runs, one audit row `decision: 'unauthorised'`.
3. The host finds or creates the `threads` row for `(client, surface, conversation, principal)`, opens a `runs` row `{ client, principal_id, thread_id, surface, conversation }`, and builds one `ToolDeps` for the run with `principal` and `context` set. It writes the inbound `messages` row.
4. The host calls `runtime.run({ thread, run, principal, input, tools, persona, skills, memory, events })` where `tools` is an MCP client connected in-process to a core-tools server built on that run's `ToolDeps`.
5. The runtime streams `RunEvent`s: `text` deltas, `tool_call`, `tool_result`, `skill_activated`, `done`, `error`. The host forwards text to the surface (streamed when `capabilities.streaming`, else one `postText` at `done`), records the assistant `messages` row, and closes the run.
6. Every tool call went through `registerTools`' policy switch with the run's principal: `auto` runs and audits, `approval` parks and audits, `blocked` refuses and audits. A parked action returns `pending` to the model, which tells the human (SOUL rule 5).
7. The approvals poller posts the card on the primary surface; a decision executes the action through the in-process `CoreToolsClient`; the host then resumes the thread with one host-authored message: `Approval <id> for <tool> was approved by <display name> and executed: <summary>` (or declined), and the runtime takes one more turn.

### 3.3 One playbook, end to end

1. The scheduler fires `playbooks` row `credentialing-expirations` at its cron time, under its `service` principal (declared in `identity.yaml`, level `service`, with the surfaces it may post to).
2. Preflight: the skill exists in a loaded pack, the principal exists, the surface named in `deliver` is loaded, the cost cap is a number. A failed preflight records a `playbook_runs` row with `status: 'preflight_failed'` and posts one failure notice; no model call is made.
3. The host opens a thread `{ kind: 'playbook' }` and a run, and calls the runtime with the playbook's prompt and skill. `deliver: none` means the run's text goes nowhere; the skill stages its own message through `harness_notify` if it has something to say (the silence doctrine).
4. On failure after the retry, one notice to the owner's conversation through the effects outbox with idempotency key `playbook:<name>:<scheduled_at>`.

## 4. Contracts

### 4.1 `@harness/identity-api`

```ts
export const LEVELS = ['member', 'practitioner', 'lead', 'admin', 'service'] as const;
export type Level = (typeof LEVELS)[number];

export interface Principal {
  /** Stable, opaque, lowercase; `u-` prefix for users, `svc-` for services. Stored on runs, threads, audit rows. */
  id: string;
  kind: 'user' | 'service';
  level: Level;
  displayName: string;
  /** This principal's user id on each surface it may speak from: `{ slack: 'U0123', teams: '29:...' }`. */
  surfaces: Readonly<Record<string, string>>;
  /** Free-form, provider-defined: department, role, groups. Never restricted values. */
  attributes: Readonly<Record<string, string>>;
}

export interface IdentitySession {
  readonly name: string;
  /** The principal behind a surface user id, or null. Null is "not authorised", never a guest. */
  resolve(ref: { surface: string; userId: string }): Promise<Principal | null>;
  get(principalId: string): Promise<Principal | null>;
  /** Every principal this provider knows; used by preflight and the scaffolder's check. */
  list(): Promise<Principal[]>;
  stop(): Promise<void>;
}

export interface IdentityDeps { env: EnvSource; log: Logger; clientDir: string }

export interface IdentityProvider {
  name: string;          // lowercase, stable
  version: string;
  secrets: readonly string[];
  connect(deps: IdentityDeps): Promise<IdentitySession>;
}
export function defineIdentityProvider(p: IdentityProvider): IdentityProvider;
export function levelAtLeast(actual: Level, required: Level): boolean;   // member < practitioner < lead < admin; service is never "at least" a user level
```

`@harness/identity-api/testing` exports `StaticIdentity`, an in-memory session built from an
array of principals, which is also what `identities/static` wraps around a parsed
`identity.yaml`:

```yaml
# clients/demo-practice/identity.yaml
principals:
  - id: u-practice-manager
    kind: user
    level: admin
    displayName: Practice manager
    surfaces: { slack: U0123ABCD }
  - id: u-coordinator
    kind: user
    level: lead
    displayName: Credentialing coordinator
    surfaces: { slack: U0456EFGH }
  - id: svc-playbooks
    kind: service
    level: service
    displayName: Nightly playbooks
    surfaces: {}
```

`SLACK_ALLOWED_USERS` and `MEMORY_ALLOWED_USERS` are retired: who may decide an approval is
"a principal of level `lead` or above resolved on the surface the card was posted on". The
memory surface, for tests, resolves every user id to a principal the test supplies.

### 4.2 `@harness/runtime-api`

```ts
export type RunEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; argsHash: string }
  | { type: 'tool_result'; name: string; status: 'ok' | 'pending' | 'error' }
  | { type: 'skill_activated'; name: string; version: string }
  | { type: 'usage'; inputTokens: number; outputTokens: number; costUsd: number }
  | { type: 'done'; text: string }
  | { type: 'error'; message: string };   // message is safe to post: never a payload value

export interface RunRequest {
  runId: string;
  threadId: string;
  principal: Principal;
  /** The human's message, or a playbook's prompt. */
  input: { text: string; attachments: readonly { name: string; path: string }[] };
  /** Prior turns of this thread, newest last, already trimmed to the runtime's budget by the host. */
  history: readonly { role: 'user' | 'assistant' | 'host'; content: string }[];
  persona: string;                                   // SOUL.md text
  skills: readonly { name: string; version: string; description: string; dir: string }[];
  memory: string;                                    // the curated snapshot, frozen for this run
  /** An MCP client already connected to a core-tools server built on this run's ToolDeps. */
  tools: Client;                                     // from @modelcontextprotocol/client
  model: { baseUrl: string; apiKey: string; route: string; fallbackRoute?: string; user: string };
  budget: { maxModelCalls: number; maxToolCalls: number; timeoutMs: number };
  signal: AbortSignal;                               // cancel
}

export interface RunHandle { events: AsyncIterable<RunEvent> }

export interface RuntimeSession {
  readonly name: string;
  run(request: RunRequest): RunHandle;
  stop(): Promise<void>;
}

export interface RuntimeDeps { env: EnvSource; log: Logger; databaseUrl: string; storageDir: string }

export interface Runtime {
  name: string; version: string; secrets: readonly string[];
  connect(deps: RuntimeDeps): Promise<RuntimeSession>;
}
export function defineRuntime(r: Runtime): Runtime;
```

Rules a runtime must keep, tested by the conformance kit in `@harness/runtime-api/testing`:
it calls tools only through `request.tools`; it never reads `process.env`; it emits exactly
one `done` or `error`; it stops within one model call of `signal` aborting; it emits
`skill_activated` before the first tool call a skill's body causes; it sends
`request.model.user` on every model request.

`@harness/runtime-api/testing` exports `ScriptedRuntime`: given a trajectory file (an array of
steps `{ tool, args }` and `{ say }`), it replays them through `request.tools`, so the host,
the approvals bridge and the scheduler are tested against a real, loaded runtime without a model.

### 4.3 `@harness/surface-api` additions

```ts
export interface MessageEvent {
  surface: string; userId: string; conversation: string;
  text: string;
  attachments: readonly { name: string; path: string }[];   // path relative to <storageDir>/incoming
  message: MessageRef | null;
  mentioned: boolean;                                        // true in a channel when the bot was addressed
}
export interface StreamHandle { append(delta: string): void; end(): Promise<MessageRef>; }

export interface SurfaceCapabilities { forms: boolean; privateReply: boolean; update: boolean;
                                       streaming: boolean; inlineConfirm: boolean }

// on SurfaceSession:
onMessage(handler: (event: MessageEvent) => Promise<void>): void;
startStream(conversation: string, opts?: { replyTo?: MessageRef }): StreamHandle;   // SurfaceError when !streaming
typing?(conversation: string): Promise<void>;
```

`allowedUsers` leaves the contract: authorisation is the identity provider's job. The Slack
adapter's `SLACK_BOT_TOKEN` / `SLACK_APP_TOKEN` become the one app; `APPROVALS_SLACK_*` are
retired; `SLACK_APPROVALS_CHANNEL` stays as the primary conversation for cards.

### 4.4 `@harness/pack-api` additions

`ACTION_CLASSES` = `read, write.self, write.internal, write.assign, external, financial,
destructive, admin`. `Policy` becomes:

```ts
export interface Policy {
  classes: Record<ActionClass, Behavior>;                       // defaults for every level
  levels: Partial<Record<Level, Partial<Record<ActionClass, Behavior>>>>;
}
```

`DEFAULT_POLICY` (the kernel's, before a pack's or a client's overrides):

| class          | member   | practitioner | lead     | admin    | service  |
| -------------- | -------- | ------------ | -------- | -------- | -------- |
| read           | auto     | auto         | auto     | auto     | auto     |
| write.self     | auto     | auto         | auto     | auto     | auto     |
| write.internal | approval | auto         | auto     | auto     | auto     |
| write.assign   | approval | auto         | auto     | auto     | approval |
| external       | approval | approval     | approval | approval | approval |
| financial      | blocked  | blocked      | approval | approval | blocked  |
| destructive    | blocked  | approval     | approval | approval | blocked  |
| admin          | blocked  | blocked      | blocked  | auto     | blocked  |

`decide(actionClass, level, policy)` reads the level's cell first: a `classes:` entry in a
client's `policy.yaml` replaces the kernel's `classes` default for that class, but a kernel or
client `levels` cell always wins over `classes` for that level, so loosening or tightening one
level's answer takes a `levels:` block of the client's own. The demo's file is unchanged and
keeps meaning what it meant, because its two coordinators are `lead` and above.

## 5. Kernel modules

### 5.1 Identity, policy and run context (core-tools, Plan 7)

- `ToolDeps` gains `principal: Principal` and its `context` becomes a `RunContext` built per run;
  `caller` is kept as an alias of `principal.id` until every reader moves, then removed.
- `registerTools` decides with `decide(tool.actionClass, deps.principal.level, deps.policy)`.
- `auditBaseFor` stamps `principal.id` as `caller`; `runs` gains `principal_id`, `thread_id`,
  `surface`, `conversation`; `approvals.requested_by` is the principal id.
- `harness_set_context` is deleted. The stdio server (inspector, evals) builds its principal
  from `HARNESS_PRINCIPAL` (an id in `identity.yaml`, default `svc-local`) and a `RunContext`
  with a fresh run per process.
- `createCoreToolsServer(deps)` is unchanged in signature; the host calls it once per run with
  that run's deps. Startup-only work (pack loading, policy parsing, key loading) moves into a
  `KernelConfig` built once by `buildKernelConfig()` and cloned into per-run deps by
  `depsForRun(config, { principal, context, db })`.

### 5.2 Files worker (`@harness/files`, Plan 7)

`POST /extract { path }` where `path` is relative to the storage root; the worker refuses `..`
and absolute paths with `assertInsideRoot`, runs `pdftotext` first and falls back to
`pdftoppm | tesseract` per page, and answers `{ pages, text, ocrUsed }`. No database, no key,
no outbound network (Compose network `files` is `internal: true`; the host reaches it, nothing
else does, and it reaches nothing). core-tools' `documents` domain calls `deps.parser.extract(relPath)`;
`remoteParser(HARNESS_FILES_URL)` in Compose, `localParser()` (today's subprocess code, moved) when
the variable is unset. Redaction and the `.redacted.txt` sidecar stay in core-tools.

### 5.3 Host (`@harness/host`, Plan 8)

Composition root, `src/app/main.ts`: load env, `createDb`, `buildKernelConfig`, load the identity
provider, the surfaces, the runtime; register `onMessage` on every surface; register approval
handlers; start the runner loops (poll, dispatch, reconcile), the scheduler (Plan 9), the run API
(Plan 10) and the health server; graceful shutdown in reverse.

Domain modules: `threads/` (find-or-create, history trimming), `conversation.ts` (the
inbound-to-run flow of §3.2), `resume.ts` (the approvals bridge of §3.2 step 7), `persona.ts`
(reads `SOUL.md`), `skills.ts` (catalogue from the loaded packs' `skillsDir`s), `tools.ts`
(the in-process MCP client per run). `@harness/approvals` exports `registerApprovalHandlers`,
`startRunner`, `collectHealth`, `startHealthServer`, `surfaceSinks` unchanged; its `execute/`
gains an in-process `CoreToolsClient` that calls `approvals_execute` on a server built on the
approver's principal.

Group conversations: the host responds only when `mentioned` or in a direct message; each turn
runs under the principal of the person who wrote it; memory written from a group thread is
tagged with the thread and never lands in a private scope.

### 5.4 Runtime (`runtimes/deepagents`, Plan 8)

`createDeepAgent` with: `model` = `ChatOpenAI({ configuration: { baseURL: model.baseUrl + '/v1' }, apiKey, model: route, user })`
with the fallback route wired as a `withFallbacks`; `tools` = the MCP client's tools through
`@langchain/mcp-adapters`; `systemPrompt` = persona + the kernel's fixed rules block;
`skills` = the request's skill directories (progressive disclosure: catalogue in the prompt, body
on `read_file`); `memory` = a `StateBackend` seeded with `/memories/MEMORY.md` from
`request.memory` (read-only inside the run; writes go through the kernel's memory tools);
`checkpointer` = `PostgresSaver` on `databaseUrl`, schema `langgraph`; built-in filesystem tools
restricted to `read_file`, `ls`, `glob`, `grep` over a `StateBackend` (no host filesystem, no
`execute`); `subagents` empty in this series; summarisation on at the runtime's default
thresholds; `interruptOn` unset. The runtime maps LangGraph stream events to `RunEvent`s, counts
model and tool calls against `request.budget`, and aborts on `signal`.

Phase 0 of Plan 8 is a spike task that pins the exact `deepagents`, `@langchain/langgraph`,
`@langchain/openai`, `@langchain/mcp-adapters` and `@langchain/langgraph-checkpoint-postgres`
versions and records the verified option names in the plan before any host code depends on them.

### 5.5 Memory (core-tools + host, Plan 9)

Tables `memory_entries (id, client, scope: 'principal' | 'client', principal_id, text, created_by, created_at)`.
Caps: 2,500 characters per principal scope, 4,000 per client scope; `memory_add` beyond the cap
is refused with the current entries and the remaining space, so the model consolidates in the
same turn. Tools: `memory_add` (`write.self` for own scope, `write.internal` for client scope),
`memory_remove`, `memory_list`, `session_search` (`read`; full-text over `messages` of threads
whose principal is the caller, plus playbook threads for `lead` and above). The host renders the
curated snapshot into `RunRequest.memory` once per run. Every write passes `assertNoInjection`
(instruction patterns, invisible Unicode) and the existing restricted-pattern check.

### 5.6 Scheduler (core-tools + host, Plan 9)

Tables `playbooks (id, client, name, schedule, timezone, skill, prompt, principal_id, surface,
conversation, deliver: 'none' | 'conversation', cost_cap_usd, timeout_s, enabled, last_run_at)`
and `playbook_runs (id, playbook_id, run_id, scheduled_at, status, started_at, ended_at, error)`.
`clients/<name>/playbooks.yaml` is upserted at host startup (name is the key; a playbook removed
from the file is disabled, not deleted). The scheduler ticks every 30 s, claims due rows with
`FOR UPDATE SKIP LOCKED`, runs preflight (§3.3), opens the run, enforces the cost cap through
`budget` and the per-run gateway breaker, retries once on a transport error, and posts one
failure notice. Tools: `playbooks_list` (`read`), `playbooks_run_now` (`admin`).

### 5.7 Knowledge (core-tools + host, Plan 10)

Tables `knowledge_sources`, `knowledge_documents (id, client, source, path, title, sha256,
min_level, principals text[], updated_at)`, `knowledge_chunks (id, document_id, client, ordinal,
text, tsv, embedding vector(N), min_level, principals text[])` where N is `HARNESS_EMBED_DIMS` (default 1024, fixed per deployment when the table is created). Route `embed` on LiteLLM
(`POST /v1/embeddings`); the chunker is `RecursiveCharacterTextSplitter`-equivalent at 1,000
characters with 200 overlap, written in `domain/knowledge/chunk.ts`. `knowledge_search(query, k)`
(`read`) runs cosine top-k and `ts_rank_cd` top-k, both with `WHERE client = $1 AND
(min_level <= $level OR principals @> ARRAY[$principal])`, fused by reciprocal rank, and returns
chunks with `path`, `title`, `updated_at` so the model cites them. `knowledge_sync` (`write.internal`; amended during Plan 10 — `admin` is blocked for the `service` principal the sync playbook runs as)
walks `clients/<name>/knowledge/**/*.md` (frontmatter `title`, `min_level`, `principals`),
upserts by `sha256`, tombstones removed files, and is scheduled as a playbook.

### 5.8 Run API (host, Plan 10)

`POST /v1/runs { surface, conversation, userId, text, attachments? }` → `202` with the run id
and an SSE stream of `RunEvent`s; `POST /v1/runs/:id/cancel`; `GET /v1/threads/:id` (messages,
newest last, for the caller's principal only). Bearer `HARNESS_HOST_TOKEN`; bind
`HARNESS_HOST_BIND` default `127.0.0.1`. The identity provider resolves `(surface, userId)`
exactly as for an adapter, so a caller cannot name a principal directly.

## 6. Data model changes (all by plain `drizzle-kit generate`)

| Migration | Tables / columns |
| --------- | ---------------- |
| 0010 (Plan 7)  | `runs.principal_id`, `runs.thread_id`, `runs.surface`, `runs.conversation`; `approvals.requested_by` semantics unchanged (now a principal id); `audit_log.caller` semantics unchanged |
| 0011 (Plan 8)  | `threads`, `messages` (with a generated `tsv` column and GIN index); `approvals.thread_id` |
| 0012 (Plan 9)  | `memory_entries`, `playbooks`, `playbook_runs` |
| 0013 (Plan 10) | `CREATE EXTENSION vector`, `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` with HNSW and GIN indexes |

The LangGraph checkpointer creates its own tables in schema `langgraph` through its `setup()`;
they are never referenced by kernel code and are dropped when a thread is deleted.

## 7. Client folder and deployment

```
clients/<name>/
  SOUL.md          persona; rules 6 and 9 rewritten (no set_context; attachments are in incoming/)
  identity.yaml    principals (§4.1)
  policy.yaml      classes + levels (§4.4)
  routing.yaml     model routes, + embed
  playbooks.yaml   scheduled work (§5.6)
  knowledge/       markdown with frontmatter (§5.7)
```

Compose after Plan 8: `postgres` (`pgvector/pgvector:pg16`), `litellm`, `files` (internal
network), `host` (profile `demo`), `core-tools` (build-only, stdio). No Docker socket anywhere.
Every client path is `/srv/agent-harness/clients/${HARNESS_CLIENT}/...`. The scaffolder writes
the whole folder. The runbook's onboarding section becomes: create the folder, fill `.env`,
`pnpm demo:up`.

CI (Plan 7): `.github/workflows/ci.yml` on pull requests and `main`: pnpm install with the
frozen lockfile, `pnpm -r typecheck`, `pnpm lint`, `pnpm arch`, `pnpm format:check`, `pnpm test`
against a `pgvector/pgvector:pg16` service, then `docker compose build` of every image.

## 8. Security invariants (each has a test)

1. Identity comes only from the host: no tool sets it, no model argument carries it, and a
   `MessageEvent` whose user resolves to no principal runs nothing.
2. Every tool call is decided by `(actionClass, principal.level)` and audited with the
   principal id; a `service` principal cannot approve.
3. A decision is accepted only from a principal of level `lead` or above resolved on the surface
   the card was posted on.
4. Every write that leaves the process goes through the effects outbox.
5. Untrusted document bytes are parsed only in the files worker; the host's parser seam refuses
   a path outside the storage root before it is sent.
6. No provider key, encryption key or database URL is present in the files worker's environment;
   no Docker socket is mounted anywhere.
7. Memory and knowledge reads are filtered by the caller's principal and level before ranking.
8. A memory write containing instruction patterns or invisible Unicode is refused.
9. The runtime reaches tools only through the MCP client it was handed and reaches no filesystem.
10. Restricted values never appear in `messages`, `memory_entries`, `knowledge_chunks` or a
    `RunEvent`: the existing restricted-pattern check runs on every host-side write.
11. Kernel, host and runtime sources carry no client, domain, surface, provider or framework
    vocabulary (the grep tests).
12. A cancelled run stops within one model call and records `status: 'cancelled'`.

## 9. Testing

- Contract kits: `@harness/identity-api/testing` (`StaticIdentity`), `@harness/runtime-api/testing`
  (`ScriptedRuntime`, and `runtimeConformance(runtime)` which every runtime package runs),
  `@harness/surface-api/testing` (`MemorySurface`, now with inbound).
- The fake gateway (`startFakeGateway`) learns scripted tool calls in the OpenAI wire shape so
  `runtimes/deepagents` is tested end to end with no provider.
- Host tests boot the real kernel against `TEST_DATABASE_URL` with the memory surface, the
  static identity and the scripted runtime, and assert the flows of §3.2 and §3.3 including the
  resume after a decision and the cancel path.
- The tool-surface snapshot, the compose snapshot and the env-var scan keep pinning what ships.
- Evals are unchanged in mechanism; recording a baseline needs a provider key and is an operator
  step in the runbook, not a task.

## 10. Sub-projects and order

| Plan | Name | Delivers | Exit criterion |
| ---- | ---- | -------- | -------------- |
| 7  | Kernel identity and hygiene | `identity-api`, `identities/static`, action classes and the policy matrix, principal on `ToolDeps`, `RunContext` per run, `harness_set_context` removed, files worker and parser seam, Docker socket removed, CI workflow, client-folder paths derived from `HARNESS_CLIENT` | `pnpm test` green in CI; the demo still runs on Hermes with a static principal; every tool call carries a principal id |
| 8  | Runtime and host | `runtime-api` (+ `ScriptedRuntime`), `runtimes/deepagents`, `@harness/host`, surface inbound + streaming, one Slack app, `threads`/`messages`, approvals resume, Hermes and `hermes-init` retired, compose and docs | a human talks to the agent in Slack through the host; an approval decided in Slack resumes the thread; the healthcare evals are unchanged |
| 9  | Memory and playbooks | memory tables and tools, injection scan, `session_search`, playbooks tables, scheduler, `playbooks.yaml`, cron scripts retired | the nightly expirations playbook runs from the scheduler under a service principal; a remembered fact survives a restart and is invisible to another principal |
| 10 | Knowledge and run API | pgvector, `embed` route, knowledge tables, sync playbook, `knowledge_search` with ACLs, the run API | a cited answer from `clients/demo-practice/knowledge/` at the caller's level; a run driven over HTTP streams and cancels |

Each plan is its own branch and pull request against `main`, opened with the suite green and
the four gates passing, and the next plan branches from the merged result.

## 11. What Weave adds on top (out of scope here, listed so the contracts are checked against it)

`surfaces/teams` (Bot Framework, Adaptive Cards, `streaming: true`, `inlineConfirm: false`);
`identities/entra` (Teams SSO token → on-behalf-of → groups → level); `packs/alliance` (skills,
department profiles, Athena YAML as records, playbook definitions); integrations as MCP servers
registered per client; a Helm chart or Container Apps template; an admin web surface over the
kernel tables. None of them needs a kernel change if §4 holds, and that is the test of §4.
