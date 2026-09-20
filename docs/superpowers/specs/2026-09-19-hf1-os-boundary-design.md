# hf1 OS — the platform boundary (design, Plans 11–12 and the platform on top)

**Date:** 2026-09-19
**Status:** designed in a brainstorm with the user; every decision is in section 2 for review; the kernel work lands as pull requests against `main`, the platform work starts a second repository
**Baseline:** main at `9b7a822` (Plans 7–10 merged, six demo-driven fixes, the whole-kernel simplifier pass)
**Predecessors:** `2026-09-17-kernel-design.md` (the kernel: identity, policy, host, runtime, memory, playbooks, knowledge, run API), `2026-09-16-pack-agnostic-core-design.md`, `2026-09-17-surface-agnostic-messaging-design.md`
**Inputs:** the user's diagram *hf1 os: the platform overview* (`assets/2026-09-19-hf1-os-platform-overview.jpg`); `kubernetes-sigs/agent-sandbox` v1.0 (the `Sandbox`, `SandboxTemplate`, `SandboxWarmPool` and `SandboxClaim` objects, gVisor or Kata through a RuntimeClass, the Sandbox Router, Go and Python SDKs); the Project Weave spec v1.3 (130 people, Teams, Entra, hybrid models, an owned harness); the HF1 Labs demo (`clients/hf1-labs`, PR #5, one live tenant on Slack)

## 1. Goal

After Plans 7–10 the kernel runs any client and knows none of them: a client is a folder of
data, capabilities are plug-ins loaded by name, governance is generic. Two things still pull a
client into this repository. The client folder is resolved under the repository root, so a new
client is a pull request here (PR #5 is AMA for exactly that reason). And deployment is this
repository's Compose file run from a checkout. At ten clients that is a habit; at fifty it is a
merge queue; at a thousand it is impossible.

The user's rule, adopted here as the boundary: **adding a client changes nothing in this
repository.** This repository is the OS. Everything that names a tenant — its configuration,
its deployment, its blueprint, the console that edits it, the people who are billed for it —
is built **on top** of the OS, in a second repository, through contracts the OS publishes.

The user's diagram says what "on top" is. Read against the kernel, it has three bands:

- **Design & Control**: lifecycle workers (Discover, Design, Build, Optimize) that customise
  agents; skills, organizational memory and plug-ins as the material they work with; and the
  four product surfaces of hf1 OS — Modeler + Forms, Catalog, Control plane, Dashboards.
- **Orchestration runtime**: BPMN + DMN engines, Operations, Human tasks — receiving an
  *approved release* from the band above and returning *events / metrics* to it, and issuing
  *work / commands* to business systems, external agents, people, APIs and data.
- **hf1 AI Gateway**: provider access, data controls, model routing, AI budgets, evaluation
  records — with **Jev**, the typesafe AI layer, between the gateway and the generative models.

Section 3.1 maps every box to something that exists, something in Plan 11 or 12, or something
the platform repository builds. The kernel's share is two plans. The platform's share is a
product, sized in section 10 and deliberately built in the order that serves a paying client
first.

After Plans 11–12:

- A host loads its client through a `ConfigSource` — a directory outside the repository, or
  versioned rows — and can serve **one client per run** instead of one per process.
- A client document is a **blueprint plus an overlay** under a **lock set**, so a finished
  agent and a customisable agent are the same object with different locks.
- Slack is reachable over **HTTPS events** only, so an ingress outside the
  repository can feed a pool of hosts, and a paused host costs nothing.
- The kernel **publishes** versioned packages and a host image; the platform pins them.
- The kernel exposes the seams the diagram needs and does not implement what belongs above it:
  a **usage export**, **typed model access** (Jev), an **orchestration seam** for an external
  process engine, **declared plug-ins** (MCP and A2A endpoints registered per tenant), and a
  reserved **sandbox** contract.
- `clients/` holds one fixture for tests. AMA leaves this repository; PR #5 closes unmerged and
  becomes the platform's first tenant.

## 2. Decisions taken (for review)

| #  | Question | Decision | Why |
| -- | -------- | -------- | --- |
| 1  | Where the boundary is | **This repository is the OS: kernel packages, the four existing contracts plus the ones in §4, reference plug-ins, one test fixture client, a published image.** Everything that names a tenant lives in a second repository (working name `hf1-platform`). A client onboarding touches this repository zero times; a capability touches it once, behind a contract. | The user's rule. It is also the only way the kernel's merge rate stays low enough to be maintained by a small core group. |
| 1b | How many repositories | **Four boundaries, two repositories now.** The four bands of the diagram are four units with one-way dependencies, `gateway ◄ os ◄ agents ◄ platform`: the gateway knows no tenant and no agent; the OS knows no client; the catalogue (`agents`: blueprints, packs, skills, lifecycle workers) implements OS contracts and knows no tenant or infrastructure; the platform names customers and consumes the other three. Physically: the gateway stays a directory of the OS repo (`harness/gateway`) until Jev is a package with an owner; the catalogue starts as `catalog/` inside `hf1-platform` under a lint rule that lets it import OS contracts only. A directory becomes a repository when it gains its own owner or release cadence; the move is mechanical because the boundary was enforced from day one. | Four repositories from the start cost a small team its week in version coordination; two repositories with four enforced boundaries cost nothing later. The user asked for simplicity and agreed on 2026-09-19. |
| 2  | Client configuration | A **client document**: one versioned schema (`@harness/config-api`) holding what today is spread over `SOUL.md`, `identity.yaml`, `policy.yaml`, `routing.yaml`, `playbooks.yaml`, `skills/` and the knowledge source. Loaded through a **`ConfigSource`** contract with two implementations, `files` (a directory named by `HARNESS_CLIENTS_DIR` holding documents in the new format, never the repository root) and `postgres` (versioned rows). **The old folder layout is not read by anything**; the scaffolder writes the document format. | The folder was already data; only its location and its shape as six loose files were wrong. One schema makes the admin UI, the scaffolder and the export three views of one thing. |
| 2b | Backwards compatibility | **None.** Every legacy path is deleted in the plan that replaces it: `clientDirFor` and the repository-root client lookup, `HARNESS_IDENTITY_FILE`, the six-file folder, Slack socket mode, the `HARNESS_PACKS`/`HARNESS_SURFACES`/`HARNESS_IDENTITY` process variables (they move into the document), the built-from-checkout Compose flow. No shims, no dual code paths, no "still works" clauses. | The user's instruction: "we are building a complete system". Two ways to do one thing is how a kernel rots; the live demo is one tenant and is re-onboarded, not carried. |
| 3  | Blueprints and overlays | A resolved client document = **blueprint** (complete, with placeholders) + **overlay** (the tenant's edits) under a **lock set** the blueprint declares. The OS enforces the lock at load: a locked path in the overlay is refused with a `ConfigError`. Finished agents lock persona and policy; customisable ones unlock everything; subscription tiers are lock sets. | The user wants both finished agents and "customize as much as possible". Same object, different locks; a blueprint update ships to every tenant without overwriting their overlay. |
| 4  | Tenancy in the host | The host resolves the **client per run** from the inbound event (Slack team id, HTTP header or path), builds that run's deps from the client's resolved document cached by version, and keeps no per-client state at process level. `HARNESS_CLIENT` set = **dedicated** host (one client, refuse others); unset = **pooled** host. | Both deployment shapes with one image. Every table already carries a client id; what remains is wiring and a test that two clients in one host cannot see each other. |
| 5  | Deployments | **Different deployments per client.** First dedicated deployments run the published image on Compose. Kubernetes arrives with the platform repository, where a dedicated tenant host is a `Sandbox` created from a `SandboxTemplate` (agent-sandbox), gVisor between tenants, paused when idle, resumed on its first event; pooled hosts are an ordinary Deployment behind the ingress. | Weave wants an owned harness in its own tenancy; the practice is fine pooled or on Compose. A `Sandbox` is precisely "a stateful singleton pod with stable identity, storage, pause and resume", which is what a dedicated host is. Reverses kernel decision 22 for the tenant-host role only. |
| 6  | Identity at scale | Levels come from **groups, never lists**: a directory-backed identity provider maps group membership to a level, cached and synced on a schedule, with `defaults` for everyone else and named exceptions on top. First provider: **Slack user groups** (`identities/slack-groups`); Entra groups follow for Weave. One provider per tenant. | 300 members are six lines of config. A new hire joins a group and exists; a leaver falls to the default or to refusal. |
| 7  | Hiding one tool | `policy.tools.hide: [names]` withholds named tools for a client without blinding their action class. Applied where pack gating already withholds tools. | Recorded follow-up from PR #11 (`documents_read`); policy is being touched anyway. |
| 8  | Usage | A **usage export**: a kernel view `usage_runs` (tenant, principal, period, runs, tokens, cost, duration, outcome counts, sandbox seconds reserved) and `GET /v1/usage` on the run API. No content, no prompts. Billing, plans and entitlements live in the platform; the kernel never knows a customer paid. | "Events / metrics" upward in the diagram; subscriptions without kernel work. |
| 9  | Slack over HTTPS | The Slack surface's transport becomes the **Events API over HTTPS**, with request signature verification and the same inbound pipeline; **socket mode is removed**. Local development uses a tunnel (documented in the runbook). Teams later is webhook-only and takes the same shape. | A paused host cannot hold a socket; a shared ingress cannot be a socket; two transports is a compatibility path (decision 2b). The live demo needs a public URL or a tunnel after Plan 11b. |
| 10 | Publishing | Tagged releases publish the kernel packages to a registry and the host image to a container registry, with `tool-surface.json` and `compose-surface.yaml` as release artefacts. Semantic versions; a changelog written for the platform team. | The platform pins versions; the OS stops being a checkout. |
| 11 | Typed model access | **Jev** ("the typesafe AI") sits behind the existing model-gateway seam in core-tools: every route the kernel calls (extract, judge, embed, and the runtime's chat/reason through the same seam where possible) returns a schema-validated, typed result, with retry on invalid output. Assumed a library; if it is a service it sits between host and LiteLLM exactly as drawn and the seam points at it. | The kernel already types every model answer with zod, in three places. One seam, one implementation, no contract change. |
| 12 | Orchestration | The kernel does **not** contain a process engine. It exposes an **orchestration seam**: an external BPMN/DMN engine starts runs through the run API as process tasks, correlates them by a `correlation` field, and receives their outcomes and human-task events through a per-tenant **event feed** (`GET /v1/events` SSE and a webhook sink). Integrate an existing engine in the platform repository, last and only when a client's workflow needs it. Credentialing is the first candidate. | A process engine is a second execution model. Beside the host it is one plan; inside the kernel it is a rewrite neither client asked for. The diagram reads correctly with the engine beside the host. |
| 13 | Declared plug-ins | A tenant registers **declared tools** in its document — an MCP server or an A2A agent endpoint — each with an admin-assigned action class, so the policy matrix, approvals and audit apply unchanged. The kernel bridges them as tools named `<prefix>_<tool>`; secrets are references into the tenant's secret store, never values in the document. Packs remain the code path. | "Connectors, MCP, A2A" in the diagram, and the biggest single unlock for customisation without code. |
| 14 | Sandboxes for execution | `@harness/sandbox-api` is **reserved as an interface** (acquire for a session, exec, put and get files, terminate) with a new action class `execute`, no implementation in Plans 11–12. The agent-sandbox implementation (`SandboxClaim` from the tenant's warm pool, through the Sandbox Router) is its own later plan. | Nobody asked for code execution yet; reserving the seam costs a file and keeps §4 honest. |
| 15 | Lifecycle workers | Discover, Design, Build and Optimize are **agents on the kernel** whose tools are the platform's control-plane API: they read evals and usage, edit blueprints and overlays, and propose releases. They customise agents by writing config, never code. Built in the platform repository after the control plane exists. | The diagram's top row, and the proof that the OS can host its own tooling. |
| 16 | What is deliberately not built here | The control plane, catalogue UI, modeler, dashboards, billing, the process engine, Kubernetes manifests, the Entra provider, the Teams surface, the sandbox implementation. Each is reachable through §4 and sized in §10. | The kernel's share of the diagram is two plans; the rest is a product and belongs above the line. |

## 3. Architecture

### 3.1 The diagram, box by box

| Diagram box | What it is in our terms | Where |
| --- | --- | --- |
| hf1 AI Gateway: provider access, model routing, AI budgets | LiteLLM gateway rendered per client from `routing`; virtual keys with budgets per tenant | exists; budgets wired by the platform |
| hf1 AI Gateway: data controls | restricted-identifier redaction on every host-side write; files worker boundary | exists |
| hf1 AI Gateway: evaluation records | `@harness/evals` runner and baselines; audit tables | exists; surfaced by Dashboards |
| Jev, the typesafe AI | typed model access behind the gateway seam | Plan 12 |
| Generative models | providers behind LiteLLM, including a tenant's own endpoints | exists |
| Organizational memory | memory entries (own and client scope) + knowledge with ACLs | exists |
| Skills | client skills directory + kernel skills + tools | exists |
| Plugins: connectors, workers | packs, surfaces, identities, runtimes, the files worker | exists |
| Plugins: MCP, A2A | declared plug-ins per tenant | Plan 12 |
| Human tasks | approvals with replay on the approver's principal | exists |
| Operations | host, scheduler, playbooks, effects outbox | exists |
| BPMN + DMN engines | external engine on the orchestration seam | seam in Plan 12; engine in platform, last |
| Approved release ↓ | a config version promoted to a tenant through `ConfigSource` | Plan 11 |
| Events / metrics ↑ | usage export + event feed | Plans 11 and 12 |
| Work / commands, Results / events | tool calls through packs and declared plug-ins; effects outbox; run outcomes | exists / Plan 12 |
| Catalog | blueprints + published packs and plug-ins, versioned | format in Plan 11; catalogue in platform |
| Control plane | tenants, config versions, provisioning, secrets, budgets | platform |
| Modeler + Forms | admin UI generated from the config schemas; pack forms | platform |
| Dashboards | operations page over usage, audit, health, evals | platform |
| Lifecycle workers | agents on the kernel with control-plane tools | platform |

### 3.2 Four boundaries, two repositories (decision 1b)

```
gateway  ◄──  os  ◄──  agents  ◄──  platform        (dependencies point left, never right)

agent-harness (this repository — "hf1 OS")
  harness/gateway   the AI Gateway band: LiteLLM config renderer, virtual keys, budgets,
                    Jev when it exists — a directory with its own contract until it has an owner
  harness/*         kernel packages, published
  contracts         pack-api, surface-api, identity-api, runtime-api,
                    + config-api, orchestration events, sandbox-api (reserved)
  reference plug-ins: surfaces/slack, surfaces/http, identities/static,
                    identities/slack-groups, runtimes/deepagents, packs/healthcare, packs/stories
  clients/fixture   one client used only by tests
  host image        published on tags

hf1-platform (new repository)
  catalog/          the "agents" band: blueprints (internal-team-assistant,
                    credentialing-assistant, alliance-assistant), tenant packs, skills,
                    knowledge seeds, lifecycle workers — imports OS contracts only (lint rule)
  tenants/          client documents (files source) or the config store's migrations
  control-plane/    tenants, versions, provisioning, secrets, budgets, billing, catalogue API
  ingress/          Slack events, Teams webhooks → tenant lookup → host
  deploy/           compose profiles for dedicated tenants; Helm chart; SandboxTemplates
  modeler/, dashboards/   the hf1 OS product surfaces of the Design & Control band
  orchestration/    the process engine integration, last
```

### 3.3 One tenant, dedicated

1. The platform creates the tenant from a blueprint, writes the overlay (identities, workspace,
   channels), stores secrets, and allocates a gateway virtual key with a budget.
2. Deployment: the published image with `HARNESS_CLIENT=<tenant>`, `HARNESS_CONFIG_SOURCE=files`
   and `HARNESS_CLIENTS_DIR=/srv/tenants` (Compose), or a `Sandbox` from the tenant's
   `SandboxTemplate` with the same environment and a mounted config volume (Kubernetes).
3. The host loads the resolved document once, validates the lock set, mounts its surfaces'
   HTTPS handlers, and runs as today.
4. The platform reads `GET /v1/usage` and `GET /v1/events` for dashboards and billing.

### 3.4 One tenant, pooled

1. Same onboarding; no deployment. The tenant's document lives in the config store.
2. Slack sends an event to the platform's ingress over HTTPS; the ingress verifies the
   signature, looks the tenant up by Slack team id, and forwards the event to a host in the
   pool with the tenant id in a header.
3. The host resolves the tenant, loads the resolved document from the `postgres` source (cached
   by version), builds the run's deps, and runs the turn. Replies go out with the tenant's bot
   token from the secret store. Nothing about the tenant survives the run in process memory
   except the version cache.
4. A second tenant's event in the same host builds its own deps; the isolation test in §8
   proves no read crosses.

### 3.5 A client document, from blueprint to host

```
blueprint (catalogue, versioned)     overlay (tenant, versioned)
  persona                              identities, defaults
  policy (locked or open)              playbook schedules on/off
  routing                              knowledge source
  playbooks                            declared plug-ins
  skills                               hidden tools
  lockset: [persona, policy.classes]   ...
          └──────────── resolve(blueprint, overlay) ────────────┘
                                   │  refuse any overlay path in the lock set
                                   ▼
                     resolved ClientDocument (schema-validated, versioned)
                                   │  ConfigSource.load(clientId) → { document, version }
                                   ▼
                     host: depsForRun(config, …) exactly as today
```

## 4. Contracts

### 4.1 `@harness/config-api`

```ts
export const CLIENT_DOCUMENT_VERSION = 1;

export interface ClientDocument {
  schemaVersion: number;                 // config migrations bump it
  id: string;                            // tenant id, [a-z0-9-]
  displayName: string;
  persona: string;                       // today's SOUL.md body
  identity: IdentityFile;                // today's identity.yaml (identity-api schema)
  policy: PolicyFile & { tools?: { hide?: string[] } };
  routing: RoutingFile;                  // today's routing.yaml (gateway schema)
  playbooks: PlaybookFile;               // today's playbooks.yaml (host schema)
  skills: Record<string, string>;        // name → markdown, today's skills/ dir
  knowledge: { source: 'dir'; path: string } | { source: 'store' };
  surfaces: { slack?: { teamId: string; signingSecret: SecretRef; botToken: SecretRef }; http?: {} };
  identityPlugin: { kind: 'static' | 'slack-groups'; /* plug-in settings */ }; // "plug-in", never "provider": the kernel-vocabulary scan forbids the word
  runtime: 'deepagents';
  plugins?: DeclaredPlugin[];            // §4.8, Plan 12
  packs: string[];                       // package names; replaces HARNESS_PACKS
}

export interface Blueprint { document: Omit<ClientDocument, 'id' | 'displayName'>; lockset: string[] /* JSON pointers */; version: string }
export interface Overlay { patch: JsonPatch; version: string }

export interface ConfigSource {
  load(clientId: string): Promise<{ document: ClientDocument; version: string } | null>;
  watch?(clientId: string, onChange: (version: string) => void): () => void;
  list?(): Promise<string[]>;            // pooled hosts only need load; the platform lists
}

export function resolve(blueprint: Blueprint, overlay: Overlay): ClientDocument; // throws ConfigError on a locked path
export function migrate(raw: unknown): ClientDocument;                          // schemaVersion n → current, forward only
```

`files` source: `HARNESS_CLIENTS_DIR/<id>/client.yaml` (the document; `persona` and skills may
be `!include`d from sibling markdown files for readability) plus optional `blueprint.yaml` and
`overlay.yaml`, resolved on load. `postgres` source: tables in §6, resolved on write by the
platform and validated again on load. The host never reads the repository root, and nothing
reads the six-file folder of Plans 7–10 (decision 2b). Secrets are `SecretRef`s resolved by the
host from its secret store (`env` for Compose, a mounted secret or the platform's store on
Kubernetes); a document never contains a secret value.

### 4.2 Host tenancy

```ts
interface ClientResolver { resolve(event: InboundEvent): string | null }   // team id, header, path → client id
```

`HARNESS_CLIENT` set: the resolver answers that id or `null` (refused, audited). Unset: the
surface supplies the id (Slack team id from the event; `x-harness-client` on the run API and
the events transport). `depsForRun(config, run)` in `core-tools/src/domain/tooling/deps.ts` is
unchanged; the `KernelConfig` it clones is now looked up per run from a
`Map<clientId, {version, config}>` filled from the `ConfigSource`, invalidated on `watch`.

What has to change for that to be true, from the code as it is:

- `harness/host/src/app/main.ts` is a top-level-await script holding one client, persona,
  identity session, surface set, runtime, budget, skills catalogue, playbook sync and approvals
  runner per process. Plan 11a extracts `createHost(deps)` and a per-client `Tenant` object
  holding those, built from a resolved document and cached by version.
- `buildKernelConfig(env)` ignores its `env` for `storageRoot()`, `loadPolicy()`, `loadKey()`
  and `gatewayFromEnv()`, which read ambient `process.env`; and `policy.yaml` is addressed by
  `HARNESS_POLICY_FILE` (unset → `DEFAULT_POLICY`, silently). All four take the resolved
  document explicitly; `HARNESS_POLICY_FILE` is deleted.
- `repoRoot` is computed at import time from `import.meta.url` in `tooling/config.ts`, the
  host's `main.ts`, `host/src/domain/skills.ts`, the gateway renderer and the scaffolder. Every
  one goes; the kernel's own `skills/` directory is the only path still resolved from a package.
- `closeRun` and the startup `reconcile` in `session/repository.ts` are unscoped; both take a
  client. The first entry of a client's `surfaces` is its primary (where cards go); a pooled
  host keeps one primary per client.
- The runtime checkpointer is one pool per process keyed by `thread_id` (a uuid, so rows never
  collide); it stays shared, and the isolation test covers it.
- `HARNESS_HOST_TOKEN` is one bearer for the process; pooled hosts are reached only through the
  platform's ingress, which authenticates tenants, so the token stays per process.

`clientDirFor(client, root)` in `tooling/config.ts` is deleted with the `files` source's
arrival; `HARNESS_CLIENT` is read today in the host's `main.ts`, `tooling/config.ts`, the
gateway renderer, the scaffolder CLI and Compose, and those are the places Plan 11a touches. Playbooks and the scheduler are per client and load lazily on first use in a pooled
host; a dedicated host loads them at start as today.

### 4.3 Identity: directory providers

On `main` today every principal is declared literally in `identity.yaml`; an unknown surface
user is refused (`conversation.ts` `handleMessage`), and the surface passes no display name.
The `defaults: { slack: member }` rule and the synthesised principal id
(`u-<surface>-<slug>-<8 hex of sha256>`, collision refusal cached, reconstructable after a
restart) exist only on PR #5's branch. Plan 11a **re-authors them into the kernel** as part of
`@harness/identity-api` (`IdentityFile.defaults`, `principalFromDerivedId`) with their tests;
PR #5 itself is never merged.

`identities/slack-groups`: `IdentitySession.resolve({ surface, userId })` looks up the user's
Slack user groups through two new `SlackApi` methods (`usergroups.list`,
`usergroups.users.list`; the surface exposes them, the provider receives a narrow lookup
function through `IdentityDeps` so it never imports the surface — the arch gate forbids it),
cached with `sync.everySeconds`, maps the first matching entry of `groups: [{ id, level }]` to
a level, then `exceptions: [{ userId, level | 'refuse' }]`, then `defaults`. The display name
comes from `users.info` at first sight and is stored on the derived principal under
`PrincipalShape` (single line, ≤ 80, no control or format characters, since it is rendered
into the runtime's rules block). Entra follows the same shape.

### 4.4 Policy

`tools.hide` is applied in `publishedTools(deps, kernel)` (`core-tools/src/tools/catalog.ts`)
beside pack gating. A hidden tool is absent from the
surface the model sees and refused with the same message as an unknown tool if called.

### 4.5 Usage export

Today `model_calls` is written only by the kernel's own `callModel` and `embedTexts`; the
runtime's `usage` events (`{ type: 'usage', inputTokens, outputTokens, costUsd }`) only feed the
per-turn cost cap and are dropped, and `audit_log`'s token columns are never written. So the
export is a schema and host change first: the host **persists every runtime `usage` event as a
`model_calls` row** (`run_id`, `client`, `route: 'chat' | 'reason'`, model, tokens, cost), and
`runs` gains `input_tokens`, `output_tokens`, `cost_usd` totals closed with the run. The
`audit_log` token columns are dropped (never written; decision 2b).

View `usage_runs` over `runs` (status, totals, started_at, ended_at), `model_calls` per route
and `approvals`, grouped by client, principal and day: runs, input and output tokens, cost,
duration, outcomes, approvals requested and decided, `sandbox_seconds` (0 until a sandbox
provider exists). `GET /v1/usage?from&to` returns it for the host's
client(s), bearer-authenticated like the rest of the run API. No message content, ever.

### 4.6 Slack events transport

`surfaces/slack/src/transport/events.ts` replaces `bolt.ts` as the one `SlackTransport`
(`{ api: SlackApi; events: SlackEvents; notePostedIn }`, `transport/types.ts`): a request
handler that verifies `X-Slack-Signature` (HMAC over the timestamp and raw body with the
tenant's signing secret, five-minute window; nothing of the kind exists today), answers
`url_verification`, acknowledges within 3 seconds and hands the normalised event to the same
inbound pipeline. `stream.ts` and `files.ts` are unchanged. The host must not name Slack (the
kernel-vocabulary test forbids `slack|bolt|blocks|thread_ts` in `harness/host/src` with an
empty allowlist), so the surface contract gains an optional `http: { path, handler }` a surface
returns and the host mounts on its own server beside the run API. Bolt's middleware supplied
the bot identity; `SlackApi` gains `auth.test` so the thread rule (`classifyInbound`) keeps its
comparison. The surface's `secrets` become `SLACK_BOT_TOKEN` and `SLACK_SIGNING_SECRET`
(`SLACK_APP_TOKEN` goes with socket mode). Bolt is removed with its dependency; the fake
transport stays for tests.

### 4.7 Publishing

Every kernel package is `"private": true` today. Plan 11b drops that on the packages the
platform consumes (the contracts, `@harness/shared`, `@harness/config-api`, the testing kits)
and adds `publishConfig`; `release.yml` on a tag runs `pnpm -r publish`, pushes the host image
to the registry, and attaches the two snapshots to the release. The platform's lockfile pins
them.

### 4.8 Plan 12 seams

**Typed model access.** The gateway seam in core-tools (`domain/models/gateway.ts`) becomes
`TypedModel { call<T>(route, schema: ZodType<T>, input): Promise<T> }` with Jev as the
implementation; the extraction pipeline, judge and embed call it. The runtime keeps LangChain's
client for the loop but reads tool results through the same typing.

**Orchestration seam.** `POST /v1/runs` accepts `correlation: { processId, taskId }`; every
run outcome, approval request and decision for the tenant is emitted on `GET /v1/events` (SSE,
resumable by cursor) and to an optional webhook sink with signed payloads. An external engine
is a client of these two; the kernel has no notion of a process.

**Declared plug-ins.**

```ts
type DeclaredPlugin =
  | { kind: 'mcp'; prefix: string; url: string; auth: SecretRef; actionClass: ActionClass; tools?: string[] }
  | { kind: 'a2a'; prefix: string; agentCard: string; auth: SecretRef; actionClass: ActionClass };
```

Bridged at run start into the tenant's tool catalogue as `<prefix>_<tool>` with the assigned
class; only a principal of level `lead` or above may add or change one (the overlay path is
under `write.assign`); the secret store resolves `SecretRef`s in the host, never the model.

**Sandboxes (reserved).** `@harness/sandbox-api`: `SandboxProvider { acquire(session): Sandbox }`,
`Sandbox { exec, putFile, getFile, terminate }`, action class `execute` in the matrix
(`blocked` below `practitioner` by default). No implementation in Plans 11–12.

## 5. Kernel modules per plan

### 5.1 Plan 11a — configuration and tenancy
`harness/config-api` (document schema, `resolve`, `migrate`); `harness/config-files`,
`harness/config-postgres`; host `ClientResolver`, per-run config cache, dedicated/pooled modes;
`identities/slack-groups`; `policy.tools.hide`; `usage_runs` + `GET /v1/usage`; `clients/` →
one fixture in the document format; the scaffolder writes the document format; `clientDirFor`,
`HARNESS_IDENTITY_FILE`, `HARNESS_PACKS`, `HARNESS_SURFACES` and `HARNESS_IDENTITY` deleted;
docs. AMA: PR #5 closed unmerged; its content re-authored as the platform repository's first
tenant document.

### 5.2 Plan 11b — transport and publishing
Slack events transport with signature verification, Bolt and socket mode removed; Compose
pulls the published image instead of building from the checkout; `release.yml`;
`publishConfig` on the consumed packages; `@harness/sandbox-api` as an interface with a
conformance stub; runbook (tunnel for local development).

### 5.3 Plan 12 — the seams
Typed model access (Jev) behind the gateway seam; `correlation` on runs and the event feed;
declared plug-ins (MCP first, A2A second) with the bridge and the `write.assign` gate; the
`execute` action class in the matrix (unused until a provider exists).

## 6. Data model changes (all by plain `drizzle-kit generate`)

- `client_documents (client_id pk, schema_version, document jsonb, version text, blueprint_ref, overlay jsonb, updated_at)`
  and `client_document_versions (client_id, version, document jsonb, created_at, created_by)`
  for the `postgres` source.
- `runs.input_tokens`, `runs.output_tokens`, `runs.cost_usd`; `audit_log` loses its three
  never-written token columns; `usage_runs` view (§4.5).
- `runs.correlation jsonb null` (Plan 12).
- `declared_plugins` is not a table: it is part of the document.
- Tenant partitioning completed: `records`, `documents`, `approvals`, `threads`, `runs`,
  `tool_effects`, `model_calls`, `audit_log`, `memory_entries`, `playbooks`,
  `knowledge_sources`, `knowledge_documents`, `knowledge_chunks` already carry `client`;
  **`attachments`, `fields`, `deadlines`, `messages` and `playbook_runs` do not** and gain it,
  and the two global unique indexes on `approvals.idempotency_key` and
  `tool_effects.idempotency_key` become `(client, idempotency_key)`. §9's isolation test proves
  every repository filters on it.

## 7. Deployment

- **Dedicated on Compose** (first): `harness/compose/docker-compose.yml` gains
  `HARNESS_CONFIG_SOURCE` and a `HARNESS_CLIENTS_DIR` volume; the image is pulled, not built.
- **Platform on Kubernetes** (second, in the platform repository): a Helm chart with Postgres,
  LiteLLM, the files worker, an ingress, a host `Deployment` for the pool, and per dedicated
  tenant a `SandboxTemplate` (host image, config volume, RuntimeClass gVisor) instantiated as a
  `Sandbox`; a `SandboxWarmPool` for fast onboarding; pause after `idle.minutes`, resume on the
  first ingress event. The Sandbox Router fronts dedicated hosts for the control plane.
- **Weave**: the same chart in their cluster with the `postgres` source pointed at their
  database and routing at their models; no platform control plane required.

## 8. Security invariants (each has a test; numbering continues the kernel spec's)

13. A pooled host serving two clients returns no record, memory entry, knowledge chunk,
    approval, thread or playbook of one client to a run of the other, on every kernel tool.
14. An overlay that touches a locked path is refused at load with a `ConfigError` naming the
    path; the blueprint's lock set cannot be changed by the overlay.
15. A Slack event with an invalid or stale signature is dropped before parsing and audited once.
16. The usage export contains no message content, tool arguments or document text.
17. A declared plug-in runs under the action class its tenant admin assigned; the class in the
    document can be changed only by a principal of level `lead` or above; its secret is never
    present in a `RunEvent`, a message or an audit row.
18. The host never reads a client from the repository root: `HARNESS_CLIENTS_DIR` unset and no
    `postgres` source is a startup `ConfigError`.
19. A dedicated host (`HARNESS_CLIENT` set) refuses an event for any other client and audits it.

## 9. Testing

- `@harness/config-api/testing`: a `MemoryConfigSource`, blueprint and overlay fixtures, a
  `configSourceConformance(source)` suite every source runs.
- Host tests boot two clients in one pooled host with the memory surface and the scripted
  runtime and assert invariant 13 tool by tool.
- The Slack events transport is tested with signed, unsigned and stale synthetic requests; the
  socket-mode tests go with the code.
- The tool-surface snapshot grows by nothing in Plan 11 (declared plug-ins are per tenant and
  never in the snapshot); the compose snapshot changes once for the new variables.
- The existing kernel-vocabulary test widens: no `blueprint` name, no tenant name, no `jev`
  outside the typed-model implementation package.

## 10. Sub-projects and order

| Plan | Repository | Delivers | Exit criterion |
| ---- | ---------- | -------- | -------------- |
| 11a | agent-harness | config-api, files and postgres sources, blueprint+overlay+lockset, client per run, slack-groups identity, tools.hide, usage export, clients/ → fixture, AMA out | AMA runs from a directory outside the repository with the published image; two clients in one host pass invariant 13 |
| 11b | agent-harness | Slack events transport, publishing, sandbox-api reserved | a Slack event delivered over HTTPS to a host with no socket runs a turn; a tag publishes packages and image |
| 12 | agent-harness | Jev typed model access, correlation + event feed, declared MCP/A2A plug-ins, execute class | an extraction validated through the typed seam; an external script drives a run with a correlation id and receives its outcome on the feed; a tenant-declared MCP tool runs under its assigned class |
| P1 | hf1-platform | tenants directory, blueprints (internal-team-assistant, credentialing-assistant), onboarding command, compose profile for dedicated tenants | the medical client onboarded from a blueprint in under an hour with no engineer step |
| P2 | hf1-platform | control plane API + config store, secrets, gateway virtual keys, ingress for Slack events, host pool | a pooled tenant answers in Slack with no dedicated process |
| P3 | hf1-platform | Helm chart, SandboxTemplate + Sandbox per dedicated tenant, warm pool, pause/resume | a dedicated tenant paused for an hour answers its next message |
| P4 | hf1-platform | Dashboards over usage, audit, health, evals | one page per tenant |
| P5 | hf1-platform | Modeler + Forms: admin UI from the config schemas, pack forms, releases | a tenant admin edits an unlocked path and the change is live without a deploy |
| P6 | hf1-platform | billing: plans as lock sets and budgets, Stripe, lifecycle states | past-due → read-only tools; cancelled → paused with retention |
| P7 | hf1-platform | lifecycle workers (Discover, Design, Build, Optimize) as agents on the kernel | a worker proposes a blueprint change from an eval regression, and a human approves the release |
| P8 | hf1-platform | process engine integration on the orchestration seam | a credentialing process with human tasks drives runs and completes |
| — | agent-harness | Teams surface + Entra provider (own spec), sandbox execution (own plan) | when Weave's or a client's calendar needs them |

Plans 11a and 11b are one pull request each against `main`, in that order. Plan 12 follows
11b. P1 starts after 11a and needs nothing later; P2 needs 11b; P8 needs 12.

## 11. What the platform repository owns (out of scope here, listed so §4 is checked against it)

Tenants and their documents; blueprints and the catalogue; the control plane and its API;
secrets; gateway keys and budgets; the ingress; the host pool and the Sandbox templates; the
modeler, forms and dashboards; billing; the lifecycle workers; the process engine. None of them
needs a kernel change if §4 holds, and that is the test of §4.

## 12. Constraints the plans inherit from the code (from the grounding pass, 2026-09-19)

Recorded so the plan writer does not rediscover them. The full map is in the worktree's
ledger directory (`.superpowers/sdd/os-boundary/grounding.md`, gitignored).

1. Every new environment variable must appear in the root `.env.example` or the env-var scan
   fails; ESLint bans `process.env` outside `app/`, `shared/env.ts` and tests, so plug-ins read
   `deps.env` only.
2. The tool-surface and compose-surface snapshots are byte-exact; `tools.hide` must not change
   the default catalogue, and the new Compose variables and the pulled image re-record the
   compose snapshot once. `surfaceDeps()` in `record-surface.ts` pins the healthcare pack.
3. The kernel-vocabulary test forbids Slack words in the host, core-tools, packs, the runtime
   and the HTTP surface; `demo-practice` and `hermes` are forbidden everywhere in those trees.
4. `pnpm arch`: the host may not statically import a surface, identity, runtime or pack; a
   surface, identity or runtime may import only its own `*-api` package and `@harness/shared`.
   The Slack-groups provider therefore receives a lookup function, never the surface.
5. Plug-ins resolve through `node_modules` by specifier. A tenant pack from outside the repo
   needs a real install step: the platform builds a tenant image `FROM` the host image with
   its packs installed, or the pooled image ships the catalogue's packs. Not a kernel change.
6. `HARNESS_PACKS` distinguishes unset from empty; the document's `packs: []` keeps that
   meaning explicit and the variable goes.
7. Two host tests read `clients/demo-practice` from the repository root
   (`preflight.test.ts`, `scheduler.test.ts`); they move to the fixture in the document format.
8. `readSkillCatalogue` requires `name`, `description`, `version` and a directory name equal to
   the frontmatter name; documents carry skills as `name → markdown` and are validated the same
   way on load.
9. `assertEmbedDims` runs before anything serves; `knowledge_chunks.embedding` is a fixed
   `vector(1024)`. A tenant's `routing.embed` must produce 1024 dimensions or fail at load.
10. `Principal.displayName` is rendered into the model's rules block; every identity source
    applies `PrincipalShape`.

## 13. Open questions (answer before Plan 12's plan is written; none block Plan 11)

1. Jev: library or service? Decides whether the typed seam imports it or calls it.
2. Which process engine, when P8 comes. Open-source, embeddable, with a REST task API.
3. A2A: which version of the protocol the kernel bridges; MCP goes first regardless.
4. Secret store for tenant plug-in credentials in the platform: decides the `SecretRef` shape.
