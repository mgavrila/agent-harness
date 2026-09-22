# hf1 OS — the platform boundary (design, Plans 11–12 and the platform on top)

**Date:** 2026-09-19
**Status:** designed in a brainstorm with the user; every decision is in section 2 for review; the kernel work lands as pull requests against `main`. **Amended 2026-09-21 by the Plan 11c addendum (sections 14–25)**, which adds the platform seams — the web surface and its streaming response, a `SecretSource`, a per-tenant gateway key, two run API read routes and the stable write contract — and by the monorepo amendment of decision 1b: the platform does **not** start a second repository but lands in this one as `catalog/`, `control-plane/`, `apps/workspace/` and `deploy/`, behind directory boundaries enforced by dependency-cruiser. Read decision 1b's amended row, and sections 14–25, as current wherever they and the original text disagree
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
| 1b **(amended 2026-09-21)** | How many repositories | **One repository, four enforced boundaries.** The platform lands in *this* repository as top-level `catalog/`, `control-plane/`, `apps/workspace/` and `deploy/`, beside `harness/`. The boundary is directories plus dependency-cruiser rules rather than two remotes: no kernel package may import any of the four, and `catalog/` may import kernel *contracts* only. The kernel-vocabulary scans keep their explicit kernel roots and never widen. One `v*` tag releases four images — host, files, control-plane and workspace — and the platform pins the kernel with `workspace:*` instead of the tarball URLs section 4.7's amendment describes. Section 16 holds the amended layout; sections 21 and 22 hold the consequences for the order table and the ownership list. | The user decided this on 2026-09-21, during Plan 11b's CI. Two remotes cost a one-person team a version-coordination step on every change that crosses the line, and the line is enforced by the same `pnpm arch` run either way. The move to a second repository stays mechanical precisely because the boundary is a lint rule from the first day. |
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
| hf1 AI Gateway: provider access, model routing, AI budgets | LiteLLM deployments come from the deployment catalogue on a dedicated host and from the platform's registrations on a pooled one; a document names one per route; virtual keys with budgets per tenant | exists; budgets wired by the platform |
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
  routing: RoutingFile;                  // the config-api routing section: one deployment name per route
  playbooks: PlaybookFile;               // today's playbooks.yaml (host schema)
  skills: Record<string, string>;        // name → markdown, today's skills/ dir
  knowledge: { source: 'dir'; path: string } | { source: 'store' };
  surfaces: { slack?: { teamId: string; signingSecret: SecretRef; botToken: SecretRef; approvalsChannel: string }; http?: {} };
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

> **Amended by Plan 11b.** The packages are attached to the GitHub Release as `pnpm pack` tarballs
> rather than pushed with `pnpm -r publish`: GitHub Packages resolves an npm scope to the
> repository owner, and `@harness/*` cannot be published there without renaming every package and
> every import. A consumer pins tarball URLs and a `pnpm.overrides` block. Moving to a registry is
> a change to two steps of `release.yml` and to nothing else.

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

## 14. Plan 11c — the platform seams (addendum, 2026-09-21)

Plan 11c is one pull request, tagged `v0.3.0`, between Plan 11b and Plan 12. It exists because the
platform's P1 — a workspace with Google sign-in, a control plane, the `postgres` config source and one
pooled host — met four seams the kernel does not have. None of them is a client in this repository, and
none of them is a feature of the platform leaking down: each is a contract the OS owes anything built on
top of it.

Every decision below was taken by the kernel session on 2026-09-21 and is recorded verbatim in the Plan
11b ledger (15:30, 15:40, 16:05, 16:20, 21:05), with four further rulings taken on this addendum's first
review and marked **(review ruling)**, and four taken on the branch's final review and marked
**(fix-wave ruling)**. The baseline is main at `4a1f969` (Plans 11a and 11b merged) plus
`486c0a4`, the `@harness/config-api` schema commit of Plan 11c Task 1, which landed first so the platform
could link the package. The platform session's `kernel-followups-from-platform.md` items 1–7 are the
**request** behind it; this spec remains the authority, and every place the two disagree is ruled below.

## 15. Decisions taken in Plan 11c (extends section 2's table)

Decision 1b's amended row sits in section 2's own table, directly below the original, so the two
read together. Rows 17–23 continue that table's numbering and are repeated here for the reader who
arrives at the addendum first.

| #  | Question | Decision | Why |
| -- | -------- | -------- | --- |
| 17 | A tenant with no Slack | **A web surface**, `surfaces/web` → `@harness/surface-web`, declared as `surfaces.web: { token: SecretRef; inbox?: string }` and **first** in `SURFACE_ORDER` so it can be a client's primary. It is a `SurfaceSession` over Plan 11b's `SurfaceHttp` seam: messages in, an SSE stream out, actions and forms back. Every request carries the tenant's bearer. | P1 is UI-first, and a tenant may have no Slack at all. Without this such a tenant has no chat and nowhere to put an approval card: `http` may not be primary by schema rule, and `memory` posts nowhere. The kernel already has the card model, the forms pipeline and a mounted door; what it does not have is a way for a door to answer with a stream, which decision 23 adds. |
| 18 | Where a secret comes from | **A `SecretSource` contract** beside `ConfigSource` in `@harness/config-api`, with two implementations: `env` (today's behaviour, shipped in `@harness/config-api` itself) and `postgres` (`client_secrets`, the `@harness/db` AES-GCM envelope, shipped in `@harness/config-postgres`). `HARNESS_SECRET_SOURCE=env\|postgres`, **no default**. Resolved once when a tenant opens, so onboarding needs no restart. A document may mix `{ env }` and `{ ref }`. | On a pooled host an `{ env }` secret means a process restart per onboarding, which drains every other tenant on that host. P1's exit criterion is "no deploy step". No default because a host that guessed would come up reading the wrong secrets and say nothing. |
| 19 | Per-tenant model budgets | **`routing.gateway: { key: SecretRef }`**, optional, resolved through the secret source at tenant open and sent as the bearer for that tenant's model calls in place of `LITELLM_MASTER_KEY`. Route names are unchanged; absent, the process key is used, exactly as today. | The platform asked for the model name to carry the tenant (`<clientId>--chat`). The key is the cheaper half of the same thing: LiteLLM's virtual keys already carry `aliases`, a `models` allow-list and `max_budget`, so the tenant travels in the credential. **Amended by decision 24**: the kernel no longer keeps `model: <route>` — it sends the document's own deployment name, so the tenant travels in the key *and* in the deployment. Registering deployments and minting keys is the platform's P2. |
| 20 | What the workspace reads | **`GET /v1/approvals` and `GET /v1/memory`** on the run API, cursor-paged, authenticated and tenant-resolved exactly as `/v1/usage`. | A dashboard and a memory page need a durable list. Today the only way to see a pending approval is the card stream of whichever surface it was posted to, which is not a list and is not queryable. |
| 21 | Who writes the store | **`@harness/config-postgres` stays unpublished**, and §6 states `client_documents`, `client_document_versions` and `client_secrets` as a **stable write contract** at the columns they have today. The platform's control plane writes them itself, in one transaction, and the host's watch follows `client_documents.version`. | The platform must neither copy kernel code nor depend on an unpublished package. A table contract is the smaller promise: it names columns rather than a function signature, and it is what the host already reads. |
| 22 | A rewritten version | A version string written a second time with **different** content is **refused** by the kernel's own writer, and is forbidden to the platform's by the §6 contract. | `writeClientDocument` upserts the live row and `onConflictDoNothing`s the history row, so rewriting a version silently keeps the old history and moves the live document — the one case where the history lies. The platform writes content-hash versions and will never hit it; the kernel refuses it anyway, because a store whose history can be wrong is a store nobody can audit. |
| 23 **(review ruling)** | A door that answers with a stream | **`SurfaceHttpResponse.body` becomes `string \| AsyncIterable<string>`**, and `SurfaceHttpRequest` gains `clientId` and `signal: AbortSignal`. The host writes the head, pipes each chunk with `res.write`, and ends the response when the iterable ends; it aborts the signal when the client disconnects. | The seam Plan 11b shipped is buffered in both directions — `send()` does one `writeHead` then `res.end(body ?? '')` — so an SSE stream is not implementable on it. An async iterable of strings is the smallest shape that fixes it: the adapter keeps every byte of its own framing, the host keeps the body cap, the refusal rule and the mount, and nothing in `harness/host/src` learns an event name. |
| 24 **(fix-wave ruling)** | What a document names a model by | **A route names a deployment the gateway serves**, and the kernel sends that string as `model:` on every call path — the chat routes, the embeddings route and the runtime's conversation — and records it in `model_calls.model`. `RouteSpec` becomes `{ model }` and nothing else: `fallbacks`, `api_base`, `daily_budget_usd` and `routing.defaults` are removed, and a document still carrying one is refused at load. `harness/gateway` renders `harness/gateway/catalogue.yaml`, the deployments this host serves, with no client and no config source. | Decision 19 kept `model: <route>`, which cannot work on a pooled host: every tenant's `chat` would resolve to one deployment, and the platform now lets a project choose its models per route and bring its own key, registered as `<clientId>/<vendor>/<model>`. The cost is that the four removed fields stop being a document's business: they configured a LiteLLM deployment keyed on the route name, which no longer exists, and a document field that renders nothing is the silent-fallback class constraint 21 was written against. Per-tenant budgets are the virtual key's (decision 19), and a dedicated host's are the catalogue's. |
| 25 **(fix-wave ruling)** | Where a tenant's approval cards go | **`surfaces.slack.approvalsChannel`**, required when the section is declared and carried to the adapter by `surfaceConversationsOf` exactly as a web inbox is. `slackConfig` reads its bot token, its signing secret and its channel from what the host resolved for that tenant and has **no `requiredEnv` fallback of any kind**; `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL` leave `.env.example`, Compose and the docs. | A deployment-wide variable cannot answer a per-tenant question: on a pooled host it is one tenant's cards arriving in another tenant's workspace, and one tenant's app posting as another's. The document already named both secrets as required refs, so the fallback was dead code on a dedicated host and a cross-tenant fallback on a pooled one. A dedicated host names whatever `.env` entries it likes through `{ env }` refs. |
| 26 **(fix-wave ruling)** | Deployments the platform registers | **`STORE_MODEL_IN_DB: 'True'`** on the Compose `litellm` service, which already has its `DATABASE_URL`. | The platform registers a tenant's deployments through LiteLLM's own `POST /model/new`, which writes to the model table; without it the proxy serves only what the mounted config renders, and decision 24's pooled half has nowhere to put a tenant's models. |
| 27 **(fix-wave ruling)** | Whether a surface can be reached | **`GET /v1/status` reports `surfaces: [{ name, live, detail? }]`**, fed by an optional `SurfaceSession.health()` that is **synchronous and non-throwing**. A session that offers none is `live: true`; one whose getter throws anyway is `live: false` with nothing said; `detail` is a fixed sentence the adapter owns, never a token and never a transport's own error text (invariant 21). An adapter answers from state it already holds and **never calls the outside world**: Slack reads the `auth.test` memo `start()` filled at tenant open, and a `start()` that was refused reports `live: false` until the next delivery asks again — the retry belongs on the delivery path, never in a status route. | A dashboard needs to know that a tenant's workspace has not been reached, and the status route was names only. Two hazards, both closed by the shape: the route is a poll, so one outbound call per tenant per tick would be a rate limit the host does not control; and a synchronous getter cannot hold the route up the way an awaited one could. |

## 16. Four boundaries, one repository (amends section 3.2)

Decision 1b's tree in §3.2 is rewritten: there is no second remote, and `hf1-platform`'s directories are
top-level directories of *this* repository.

```
gateway  ◄──  os  ◄──  agents  ◄──  platform        (dependencies point left, never right)

agent-harness (this repository — "hf1 OS" and the platform on top)
  harness/gateway, harness/*      the kernel, unchanged, published on tags
  contracts                       pack-api, surface-api, identity-api, runtime-api,
                                  config-api, sandbox-api (reserved)
  reference plug-ins              surfaces/{slack,http,memory,web}, identities/{static,slack-groups},
                                  runtimes/deepagents, packs/{healthcare,stories}
  clients/fixture                 one client used only by tests
  catalog/                        the "agents" band: blueprints, tenant packs, skills, knowledge
                                  seeds, lifecycle workers — imports kernel *contracts* only
  control-plane/                  tenants, versions, provisioning, secrets, budgets, billing
  apps/workspace/                 the workspace: sign-in, chat over the web surface, dashboards
  deploy/                         compose profiles, Helm chart, SandboxTemplates
  four images                     host, files, control-plane, workspace — one `v*` tag
```

Every mention of "the second repository", "`hf1-platform`" and "the platform repository" elsewhere in
this spec now names a directory rather than a remote. In particular **§10's `Repository` column reads
`agent-harness` for every row, P1 through P8**, and §3.3's and §3.4's onboarding walkthroughs are
unchanged in substance: the platform writes rows or documents, and the host reads them.

## 17. Contracts added in Plan 11c (extends section 4)

Four new subsections of section 4, in the numbering that section already uses. Two kernel
contracts change to carry them: `@harness/surface-api` grows a streaming response, a
request-scoped client id and an abort signal (4.9), and `@harness/config-api` grows a
`SecretSource`, a `web` tenant key and two document fields (4.9–4.11).

### 4.9 The web surface

`surfaces/web`, published as `@harness/surface-web`, declared by a document as:

```yaml
surfaces:
  web:
    token: { ref: web-token }     # or { env: WEB_TOKEN }
    inbox: inbox                  # optional; this is the default
```

`web` is first in `SURFACE_ORDER` (landed in `486c0a4`), so a document that declares it and `http` has
`web` as its primary and its approval cards have somewhere to go.

**The seam grows one shape (decision 23).** A `SurfaceHttpResponse` today is a status, headers and a
`body: string`, which a stream is not: `surfaces.ts`'s `send()` does one `res.writeHead(...)` then
`res.end(response.body ?? '')`, and the response is over before `handle` has returned. Three changes,
one task of the plan, in `@harness/surface-api` and `harness/host/src/domain/api/surfaces.ts`:

- `SurfaceHttpResponse.body` becomes `string | AsyncIterable<string>`. On a string, `send()` behaves
  exactly as it does today. On an iterable, the host writes the head, then `res.write`s each chunk as
  it is yielded, and calls `res.end()` when the iterable ends or throws — a throw mid-stream is logged
  the way a throwing `handle` already is and closes the response; there is no error frame, because the
  adapter owns the frame vocabulary and can send its own before it stops.
- `SurfaceHttpRequest` gains `signal: AbortSignal`, aborted when the client disconnects (`res.on('close')`,
  which the run API's own `sseStream` already listens for). An SSE producer selects on it and returns,
  so a closed browser tab does not leave a generator pushing frames into a dead socket.
- `SurfaceHttpRequest` gains `clientId: string`, the tenant the host resolved from the path — see "the
  tenant hint" below, which is what it is for.

What does **not** change: the host still reads the whole request body before calling `handle`, so
`API_MAX_BODY_BYTES` still answers `413` before the adapter sees anything; and the refusal rule is
untouched. **A `refusal` is decided before the first byte.** The host reads `response.refusal`, writes
its one audit row and sends the head; once the head is written the response is a stream and there is no
refusal left to declare — an adapter that discovers a problem mid-stream says so in its own frames and
ends. Invariant 20 is therefore unaffected by streaming.

`MemorySurface`'s door in `@harness/surface-api/testing` gains the same shape and is the reference: its
events stream is what the host's own test drives, so the thing the suite proves the host against is the
thing that runs.

**The door.** The adapter offers `http: { path: 'web', handle }`, and the host mounts it at
`/tenants/<clientId>/web/...` through `handleSurfaceRequest` — the same mount, the same tenant
resolution, the same 404-for-every-miss rule the Slack transport already goes through. Four routes,
each addressed by the sub-path the seam hands the adapter:

| Method and path | Body | Answers |
| --- | --- | --- |
| `POST …/web/messages` | `{ userId, conversation, text, attachments?: [{ name, path }] }` | `202 {"message": MessageRef}`; the reply arrives on the stream |
| `GET …/web/conversations/<id>/events` | — | `202`, `text/event-stream`, an open stream |
| `POST …/web/actions` | `{ userId, actionId, value, messageRef }` | `202 {}` |
| `POST …/web/forms` | `{ userId, formId, values, messageRef }` | `202 {}` |

**The tenant hint (review ruling).** The mount path already named the tenant, but the `MessageEvent` the
adapter delivers is checked against the pool's resolver a *second* time: `attachMessageHandlers` calls
`pool.resolver.resolve({ from: 'surface', surface, tenantHint: event.tenantHint ?? null })` and audits
the event `unauthorised` unless the answer equals the tenant. `pooledResolver` returns `null` for a null
hint, by design. So a web surface that reported no hint would have **every message on a pooled host
refused** — and would pass a dedicated-host test, because `dedicatedResolver` answers its own client for
a null hint. Two halves:

- `tenantKeysOf` gains a `web` entry keyed on the document's own id — `{ surface: 'web', key: document.id }`.
  A web tenant has no workspace but itself, so its id is its key. `SurfacesShape` is otherwise unchanged.
- The adapter sets `tenantHint = request.clientId`, **the field on the request and not
  `deps.tenantKey`**. Both would work, and the request field is the one that cannot be misconfigured: it
  is what the host resolved from the path a moment earlier, so a document whose `web` key and `id` ever
  drifted apart could not make an adapter claim a tenant the host did not route to.

The consequence, stated so a test can assert it: **a web message is never refused for a missing hint**,
on a pooled host or a dedicated one, and on a dedicated host the foreign-client check still applies —
`dedicatedResolver` compares the hint against that tenant's own keys and refuses another's.

**Where a card goes (review ruling).** `surfaces.web.inbox` is an optional conversation name, defaulting
to the literal `inbox`, and `SurfaceSession.defaultConversation` returns it. That is what the approvals
poller posts to: `postPendingApprovals` writes every unposted card to `deps.surface.defaultConversation`
on the primary surface, and `web` is the primary. The workspace therefore opens
`GET …/web/conversations/<inbox>/events` to receive approval cards and notices, and knows the name
because it wrote the document. A conversation is created by writing to it — a `POST …/web/messages` with
a `conversation` nobody has used is a new conversation — so there is no route to create one and none to
list them. `inbox` is a one-line addition to `SurfacesShape` in 11c's web-surface task, not a second
schema pull request.

**The stream.** `GET …/web/conversations/<id>/events` is Server-Sent Events, framed by the **adapter**
and written by the host as opaque chunks:

```
id: <n>\nevent: <name>\ndata: <one JSON line>\n\n
```

`id` is a decimal counter, monotonic and per conversation, starting at 1. The event names are the
surface's own — `delta`, `card`, `card_update`, `notice` — and the adapter emits the same three
anti-buffering headers the run API uses (`text/event-stream`, `no-cache`, `x-accel-buffering: no`) and a
`: keep-alive\n\n` comment on its own unref'd timer. A client reconnects with `Last-Event-ID`, which
reaches the adapter as the **lower-cased** `last-event-id` key of `SurfaceHttpRequest.headers` — the
host lower-cases every header name — and the stream resumes after that id. A resume past the retention
window is answered with a `notice` frame saying frames were dropped, before the first live frame, rather
than with a header or a silent gap: the workspace has to be able to tell a resumed stream from a
complete one. The window itself is §13.5.

**Attachments are checked against the storage root.** `attachments: [{ name, path }]` arrives from a
caller, and `handleMessage` passes `event.attachments` into `runTurn` with **no** root check — the
adapters that exist stage their own files, so their paths were trustworthy. The run API, whose paths do
come from a caller, checks each one against `<storageDir>/incoming` with `assertInsideRoot` before a run
opens. The web surface does the same, in the adapter: `assertInsideRoot` is exported from
`@harness/shared`, which the arch rule allows an adapter to import. A path outside the incoming
directory is a `400`, and no run opens.

**Status codes and error bodies**, so a client can be coded against it:

| Condition | Answer |
| --- | --- |
| body over `API_MAX_BODY_BYTES` | `413` from the **host**, before the adapter sees it; the socket is then destroyed |
| missing, malformed or wrong bearer | `401`, `refusal: { reason: 'bad_bearer' }`, one audit row |
| body is not JSON, or fails the route's schema | `400 {"error": "<what was wrong>"}`, no refusal |
| attachment path outside the incoming directory | `400`, no refusal |
| `userId` the identity plug-in will not resolve | `202`; the refusal arrives on the conversation's stream as a `notice` frame carrying `UNAUTHORISED_TEXT`, because identity resolves in `handleMessage` *after* the door has answered and `SurfaceDeps` has no identity access at all |
| wrong method on a known path | `405` with `allow`, no refusal (the Slack door's rule) |
| sub-path no route claims | `404`, no refusal |
| `formId` the host does not know, or one already answered | `400 {"error":"that form is not open on this surface"}`; the dialogue's metadata names the thing being decided, so an unknown one is refused rather than delivered as a submission about nothing |
| `actionId` the host does not know | `202`; the press is delivered, and the handler that does not recognise it answers with a private `notice` on that conversation — a card this host did not post is not an error, but silence looks like a hang |
| `conversation` nobody has used | `202`; writing to a conversation creates it |

A body is only useful if it is typed: `surfaces.ts`'s `send` defaults to `text/plain; charset=utf-8`
unless the adapter sets `headers` itself, so every JSON answer above — including the `401` — sets
`content-type: application/json` explicitly.

**Identity.** `userId` is a principal the *tenant's* identity plug-in resolves, through
`IdentitySession.resolve({ surface: 'web', userId })` — the call `handleMessage` makes for every
surface-delivered message, which is the path a web message takes. The `defaults` rule applies per
surface, and **`defaults.web` is allowed**, unlike `http`. It needs no code change:
`parseIdentityFileWithDefaults` refuses only `UNDEFAULTABLE_SURFACE = 'http'`, and the defaults key
pattern admits any surface name. It does need one bound — see invariant 24 and §13.6.

**Capabilities.** `{ streaming: true, update: true, forms: true, privateReply: true, inlineConfirm: false }`.
`mention(userId)` returns `@<userId>`, always (plan decision 7): the surface has no directory of its
own, and a name it invented would be a name the workspace cannot address anybody by.

**The bearer.** Every request carries `Authorization: Bearer <token>`, compared against the tenant's
resolved `surfaces.web.token` in constant time. The compare is the adapter's own: `pnpm arch` forbids a
surface importing anything but `@harness/surface-api` and `@harness/shared`, so the web surface cannot
reuse the host's `bearerOk` and uses `node:crypto`'s `timingSafeEqual` behind a length check, the same
shape and for the same reason.

**What the host learns: nothing.** No route, event name, frame or field above appears in
`harness/host/src`. With decision 23 the host writes chunks it does not read, so the streaming change
makes this stronger rather than weaker: the mount path, the refusal reason and every byte of the SSE
framing are the adapter's. `kernel-vocabulary.test.ts` keeps its empty allowlist.

**Against the memory surface.** `surfaces/memory` is the reference door and already proves most of this:
a real `SurfaceSession`, loaded by name, with cards, forms, streams, `onAction`/`onFormSubmit`/`onMessage`,
a `tenantHint` taken from the document, and an `http` mount a test can drive. What the web surface adds
is the five things a browser needs and a test double does not: a real SSE transport with resumable ids,
a bearer on every request, inbound actions and forms arriving over HTTP rather than being called
directly, caller-supplied attachment paths that must be checked, and an inbox conversation for cards.

### 4.10 Secrets from a store

```ts
export interface SecretSource {
  /** Lowercase, stable: `env`, `postgres`. What HARNESS_SECRET_SOURCE names. */
  readonly name: string;
  resolve(clientId: string, ref: SecretRef): Promise<string>;
  close?(): Promise<void>;
}
```

Deliberately two methods and no `list`: a host resolves what a document names and never enumerates, and
the platform's control plane owns the store and lists it with its own SQL. See §13.7.

**Where each piece lives.** The parallel with `ConfigSource` is exact and is followed line for line:
`configSourceNameFrom` and `loadConfigSource` sit in `harness/core-tools/src/domain/config/registry.ts`
— the first validates `HARNESS_CONFIG_SOURCE` against a `SOURCES` tuple with no default, the second
dynamic-imports the implementation package — and `secretSourceNameFrom` / `loadSecretSource` are added
**beside them, in that file**. The `env` implementation ships in `@harness/config-api` itself: it reads
an `EnvSource` and imports nothing else, so it needs no package of its own and the contract package's
arch rule (contracts and `@harness/shared` only) still holds. The `postgres` implementation ships in
`@harness/config-postgres`, which already declares `@harness/db` and so already has `encrypt`,
`decrypt` and `loadKey`.

**`env`.** `{ env: NAME }` reads `NAME` off the environment the host was handed — today's behaviour,
unchanged, including the empty-string-is-unset rule. `{ ref: name }` under this source is refused when
the tenant opens, with the message Task 1 already ships:

```
client "<id>" names the secret "<name>" for <surface>.<field>, and this deployment has no secret source
```

**`postgres`.** `{ ref: name }` selects `client_secrets` by `(client_id, name)` — the tenant's own rows
and no others — and decrypts. `{ env: NAME }` still reads the environment: an `env` ref always means the
environment, whichever source is configured, because a document that mixes the two is a tenant whose bot
token is in a store and whose deployment-wide gateway URL is not, and that is the ordinary case rather
than an error. A `ref` this source cannot find is a `ConfigError` naming the client and the secret name,
never the row.

**`HARNESS_SECRET_SOURCE`** is `env` or `postgres` with **no default**, the way `HARNESS_CONFIG_SOURCE`
has none. One thing that rule needs defending in the one deployment that reads a file: Compose supplies
`HARNESS_CONFIG_SOURCE: '${HARNESS_CONFIG_SOURCE:-files}'`, which hands the host a value it did not
choose. `HARNESS_SECRET_SOURCE` is passed through **without** a `:-` default, or the no-default rule is
defeated exactly where it matters most.

**Resolution happens once, when a tenant opens, before anything is built.** `assertSecretsPresent` in
`openTenant` becomes `resolveSecrets(document, source)`: it walks `surfaceSecretsOf` plus
`routing.gateway.key`, resolves every ref through the secret source, and returns a map — failing with
the same `ConfigError` shape it raises today for a secret that is absent. It runs **before**
`buildKernelConfig`, which is a move: today `buildKernelConfig` runs first and `assertSecretsPresent`
second. The order is deliberate, because §4.11 needs the resolved gateway key *inside*
`buildKernelConfig`, and because a deployment whose secret source is broken should be told that before
it is told anything about its gateway. That is what makes "add a tenant with no restart" true: a pooled
host opens the new tenant on its first request and resolves its secrets then.

**The seam this changes, and every site that must change with it.** `SurfaceDeps.secrets` is today
field → *environment variable name*, and the adapter looks it up: `slackConfig` does
`requiredEnv(secrets.botToken ?? 'SLACK_BOT_TOKEN', …, env)`. A `{ ref }` has no variable name, so that
bag cannot carry it. **Ruling: the bag carries resolved values, and is renamed to `secretValues` so the
change is not invisible to the type checker** — both fields are `Readonly<Record<string, string>>`, so
changing only the meaning would compile clean and leave `slackConfig` looking a secret *value* up as an
environment variable name. The rename forces every site, and these are all of them:

- `harness/surface-api/src/types.ts` — `SurfaceDeps.secrets` → `secretValues`, with the doc comment
  rewritten (it currently says "the environment variable this client's document named").
- `harness/approvals/src/domain/surfaces/registry.ts` — `SurfaceSettings.secrets` → `secretValues`,
  same doc comment.
- `harness/host/src/domain/tenancy/tenant.ts` — the settings loop that builds
  `{ [ref.field]: ref.env }` now writes the resolved value, and its `if (!('env' in ref)) continue`
  guard goes with `assertSecretsPresent`.
- `surfaces/slack/src/index.ts` and `surfaces/slack/src/config.ts` —
  `slackConfig(deps.secretValues, deps.defaultConversation)`, and each field is read from that bag
  alone.

**Amended by decision 25.** This section first kept the conventional-name fallback and moved only
its expression, so that the literal `SLACK_BOT_TOKEN` stayed in the adapter's source where the
env-read scan could find it. There is no fallback now, in any expression: an adapter reads its
credentials from `secretValues` and its conversation from `defaultConversation`, and a field the
document did not name is a refusal when the tenant opens, naming `surfaces.slack.<field>`. A
dedicated host still keeps its secrets in `.env` — it names them itself, with `{ env: SOME_NAME }`
refs, which the host resolves before the adapter runs. The env-read scan keeps its `requiredEnv`
anchor on `HARNESS_SECRET_SOURCE` instead (`SCAN_ANCHORS` in
`harness/core-tools/src/app/surface.test.ts`).

**Rotation does not reopen a tenant.** `postgresConfigSource.watch` polls `client_documents.version` and
nothing else, so a `client_secrets` row changing is invisible to a running host — for a web token, a bot
token and a gateway key alike. The rule: **a secret rotation is paired with a version bump on the
tenant's document**, which is a write the control plane is already making a transaction for. Whether the
kernel should do better is §13.8.

**The envelope** is exactly `harness/db/src/shared/crypto.ts`, which Plan 11a shipped and nothing here
changes:

- AES-256-GCM.
- Key: `HARNESS_ENCRYPTION_KEY`, base64, decoded to **exactly 32 raw bytes** (`loadKey` throws otherwise).
- IV: 12 random bytes. Tag: 16 bytes. No AAD. Plaintext UTF-8.
- Blob: `iv(12) || tag(16) || ciphertext`, stored raw in `bytea`.

Test vector, fixed IV, verified through `decrypt` — it belongs in the spec because the platform encrypts
with its own code and only a vector proves the two agree:

```
key_b64    BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=
iv_hex     030303030303030303030303
plaintext  xoxb-test-secret
blob_hex   03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78
```

**A resolved secret is a value and is treated as one.** It never appears in a log line, an error message,
an `audit_log` row, a `SurfaceHttpResponse.refusal`, a run API response or a `RunEvent` (invariant 21).
The refusals above name the client, the surface, the field and the secret's *name*; never its value, and
never the row it came from.

### 4.11 Per-tenant gateway key

`routing` gains one optional field:

```yaml
routing:
  gateway:
    key: { ref: gateway-key }
  routes:
    chat: { model: gemini/gemini-3-flash-preview }   # the name of one deployment, and nothing else
    extract: { model: gemini/gemini-3-flash-preview }
    reason: { model: gemini/gemini-3-flash-preview }
    judge: { model: groq/openai/gpt-oss-120b }
    embed: { model: gemini/gemini-embedding-001 }
```

Resolved by `resolveSecrets` at tenant open (§4.10) and handed to `buildKernelConfig`, which carries it
on `GatewayConfig.apiKey` — already per-tenant config, and already the bearer `httpGateway` sends on
every call. Absent, `gatewayFromEnv`'s `LITELLM_MASTER_KEY` stands, which is today.

**This is a signature change, not a substitution.** `buildKernelConfig(document, env)` has no secret
source and no resolved map in hand, so it gains a third parameter — the map `resolveSecrets` returned —
and every caller changes with it. The callers are the host's `buildTenant` and the stdio server's own
composition root; both already have the document.

`LITELLM_MASTER_KEY` **stays required**. `gatewayFromEnv` reads it through `requiredEnv`, and a pooled
host on which every tenant has its own key still cannot start without it. That is deliberate rather than
an oversight to fix: it is the key for a tenant that declares none, for the eval runner and for the
stdio server, and a deployment that genuinely has none can set it to a value LiteLLM will reject.

The five route names are unchanged, and the `embed` route still goes to `POST /v1/embeddings` — but
what travels as `model:` is the document's own string, not the route (decision 24). `model_calls` rows
keep their `client` column and record that string, so budgets and evaluation records attribute per
tenant and per deployment whether or not the tenant has a key. The platform, on release, registers the
tenant's deployments (`<clientId>/<vendor>/<model>`) and mints one virtual key with a `models`
allow-list and `max_budget`/`budget_duration`; that is P2 and is not kernel work.

Two sentences in `gatewayError` name the wrong thing once a tenant has its own key, and both are
rewritten in the same task. A 401 or 403 says "check `LITELLM_MASTER_KEY`", which for such a tenant is
not the credential that was rejected; it becomes a sentence naming neither — "model route `<route>` was
rejected by the gateway (HTTP `<status>`)". A budget refusal says "raise it in the client document's
routing section", which is right for a route's `daily_budget_usd` and wrong for a virtual key's
`max_budget`, which lives in LiteLLM; it becomes "model route `<route>` is over its budget". Both
messages reach `audit_log.error` and the agent, so neither should teach which credential a deployment
uses. A budget refusal is now the virtual key's `max_budget` or the deployment's own, both of which
live in the gateway: a document names a deployment and sets no budget at all (decision 24).

### 4.12 Run API reads

Two routes, beside `/v1/usage`, with **identical authentication and tenant resolution**: the bearer
`HARNESS_HOST_TOKEN`, then `x-harness-client` through `pool.resolver`, then `pool.tenantFor`. A client
the host does not serve is `404 {"error":"no such client"}` — which is the body `/v1/*` already gives an
unresolved tenant, and is distinct from `{"error":"no such route"}`. (Below `/tenants` the two *are*
identical, deliberately, and that rule is untouched.)

The **envelope** is not `/v1/usage`'s. That route answers `{ client, from, to, rows }` and takes no
cursor at all. These two answer:

```json
{ "client": "<id>", "rows": [ … ], "next_cursor": "<opaque>" | null }
```

**`GET /v1/approvals?status=&cursor=&limit=`**

One row per approval of this tenant, **newest first**, from `approvals`:

```
id, action, summary, requested_by, status, decided_by, decided_at, decision_note,
executed_at, expires_at, surface, conversation_id, created_at
```

and nothing else. `payload` and `payload_encrypted` are the tool's own arguments and are **excluded** —
that is invariant 16's rule applied to an export it did not name, and invariant 23 makes it explicit.
`idempotency_key`, `message_ref`, `thread_id` and `claimed_at` are the poller's bookkeeping and are
excluded too.

`status` is **the column's own vocabulary and nothing else (review ruling)**: `pending`, `approved`,
`declined`, `expired`, comma-separated for several (`?status=approved,declined`). Those four are exactly
the values written anywhere — `pending` as the column default, `approved` and `declined` by the decision
path, `expired` by the approvals repository — and they are the values a returned `status` field can
carry, so a dashboard can render what it filtered on. There is **no `decided` alias**: a filter
vocabulary that differs from the column is a second spelling of the same fact, and a platform engineer
asking the obvious `?status=approved` must not get a `400`. An unknown value is a `400` naming the four.

**`GET /v1/memory?scope=&principal=&cursor=&limit=`**

One row per entry of this tenant, **oldest first** — the order `listMemory` already uses,
`asc(created_at, id)` — from `memory_entries`:

```
id, scope, principal_id, text, created_by, created_at
```

`text` is included, because that is the entry — a memory page with no memories is not a page — and
because `memory_list` returns exactly this to the model already, so nothing here is newly visible.
`principal_id` is included, which `memory_list`'s own entry shape omits: a tool's caller *is* the
principal, and a tenant-scoped export has no such excuse. A page showing both scopes could not otherwise
say whose a principal-scope entry is, and an id is an id rather than content, so invariant 16 does not
reach it. The filters are the tenant's own columns: `scope` is one of the two scope names, `principal`
filters `principal_id`. `thread_id` is excluded; it is a join key.

**Paging.** Both routes take an opaque `cursor` and return `next_cursor`, null at the end. The cursor
encodes the sort key of the last row returned — `(created_at, id)`, in that route's own direction — so
it is stable under insertion and carries no offset. `limit` defaults to 100 and is capped; a cursor that
does not decode is a `400`, not a silent first page.

**No principal resolution.** Unlike `/v1/runs` and `/v1/threads/<id>`, these two routes take no `surface`
and `userId` and resolve no principal: the caller is the platform's control plane acting for the tenant,
not a person acting as themselves. They are therefore tenant-scoped and nothing narrower, which is why
the column lists above are the whole of the guarantee and why invariant 23 asserts them.

> **Where the platform's request and the code disagree.** Item 4 asks for "`GET /v1/memory` (shape of
> `memory_list`)". `memory_list` is a *tool*: it returns the entries visible to one principal plus that
> principal's usage totals, through `visibleTo(client, principalId)`. A control-plane read has no
> principal, so the route returns the tenant's rows in the entry shape plus `principal_id`, and no
> `usage` block. The platform computes totals from the rows if it wants them.

## 18. Data model additions (extends section 6)

**One new table and two migrations in Plan 11c**, both by plain `drizzle-kit generate`: 0015 creates
`client_secrets` below, and 0016 drops `playbooks.timezone`, by the UTC ruling (decision 16) — a cron
expression is read in UTC, and the playbooks tool's output loses the field with the column.

```sql
client_secrets (
  client_id   text        NOT NULL,
  name        text        NOT NULL,
  ciphertext  bytea       NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (client_id, name)
)
```

`ciphertext` holds the raw envelope of §4.10 — `iv(12) || tag(16) || ct` — not base64 and not text.
`name` is a secret name, `/^[a-z][a-z0-9-]*$/`, the pattern `SecretRefShape`'s `ref` member already
enforces. The primary key is the isolation: a `{ ref }` resolved for one tenant selects on `client_id`
and can reach no other tenant's row of the same name (invariant 21).

**The stable write contract.** Three tables are written by the platform's control plane and read by the
kernel. `@harness/config-postgres` stays `"private": true`; these columns are the contract instead, and
they are the columns as they stand at `4a1f969`:

```
client_documents
  client_id      text        PRIMARY KEY
  schema_version integer     NOT NULL
  document       jsonb       NOT NULL     -- a whole resolved ClientDocument
  version        text        NOT NULL     -- what a host caches by and what watch reports
  blueprint_ref  text        NULL
  overlay        jsonb       NULL
  updated_at     timestamptz NOT NULL DEFAULT now()

client_document_versions
  id             uuid        PRIMARY KEY DEFAULT gen_random_uuid()
  client_id      text        NOT NULL
  version        text        NOT NULL
  document       jsonb       NOT NULL
  created_by     text        NULL
  created_at     timestamptz NOT NULL DEFAULT now()
  UNIQUE (client_id, version)

client_secrets   -- above
```

Rules the writer must keep, and the kernel's own writer keeps:

1. **Both document tables in one transaction.** A live row that moved without a history row is a change
   nobody can review; a history row with no live row is a version nobody is serving.
2. **The host's watch follows `client_documents.version`.** `postgresConfigSource.watch` polls that one
   column every 30 seconds and reopens the tenant when it changes. A content change that does not move
   `version` is a change the host will not notice, and there is no second signal — which is also why a
   secret rotation is paired with a version bump (§4.10).
3. **A version string is written once.** Writing `(client_id, version)` again with *different* content is
   **refused**. Today `writeClientDocument` does `onConflictDoNothing` on the history row while the live
   row upserts, so a rewrite moves the document and keeps the old history silently. Plan 11c compares the
   stored document with the one offered, **inside the same transaction as the conflicting insert**, and
   raises a `ConfigError` naming the client and the version when they differ; an identical rewrite stays
   a no-op, which the existing `configSourceConformance` suite already asserts. The comparison has to be
   inside the transaction or two concurrent writers decide against a document neither of them stores.
   **This rule binds the two writers differently and deliberately**: the kernel's own writer enforces it
   in code, and the platform's control plane — which writes the tables directly and gets no refusal from
   anything — is bound by this contract alone. It writes content-hash versions, so it cannot breach it by
   accident.
4. **The kernel validates on read regardless.** A store the platform writes to is not a store the kernel
   trusts: `migrate` + `parseClientDocument` run on every load, the row's key must equal the document's
   `id`, and `knowledge.path` must be absolute. A malformed row fails that tenant and no other.

## 19. Security invariants 20–24 (extends section 8)

20. A request to a tenant's web surface without that tenant's bearer is refused **before its body is
    parsed** and before any byte of a response is written, answers `401`, and is audited exactly once —
    one `audit_log` row whose `error` column carries the refusal reason and whose `args_hash` is the
    digest of the client id asked for, the method and the path. The method and the path are *in* that
    row and are not readable from it, which is `hashArgs`'s point and is what the test asserts.
21. A secret resolved from the store never appears in a log line, an error message, an audit row, a
    surface refusal, a status response, a run API response or a `RunEvent`; and a tenant's `{ ref }`
    resolves only rows whose `client_id` is that tenant's. A surface's `health().detail` is a fixed
    sentence the adapter wrote, and the host copies `live` and `detail` and nothing else off it
    (decision 27).
22. A per-tenant gateway key is never sent on another tenant's model call: two tenants open in one pooled
    host, each with its own key, send their own and only their own.
23. The run API's read routes return no row belonging to another tenant, and no column the lists in §4.12
    exclude — in particular no approval payload, encrypted or not.
24. **A principal derived through `defaults.web` never exceeds that default's level, and `defaults.web`
    may not name `lead` or `admin`** — a parse-time refusal in `parseIdentityFileWithDefaults`, beside
    the one that forbids `defaults.http` entirely. See §13.6 for why the web surface gets a bound rather
    than a ban.

## 20. Testing additions (extends section 9)

- **The streaming seam.** `MemorySurface`'s door answers an `AsyncIterable<string>`; a host test drives
  it and asserts the chunks arrive as they are yielded rather than at the end, that ending the iterable
  ends the response, that a mid-stream throw closes it and logs, and that aborting the request's
  `signal` on client disconnect stops the producer.
- **The web surface, through the real pool.** Driven end to end against a host pool with the scripted
  runtime and a fake identity plug-in, not a mock door: a `POST …/web/messages` runs a turn and its reply
  arrives on the conversation's stream; a stream reconnected with `last-event-id` resumes after the last
  id it saw and repeats nothing before it, and a resume past the window opens with the dropped-frames
  notice; a wrong bearer and a missing bearer each answer `401` and leave exactly **one** `audit_log` row
  (counted, not merely found); a `POST …/web/actions` carrying the approve action decides the approval
  and updates its card; a `POST …/web/forms` carrying the edit form reaches the same decision path with
  its note; an attachment path outside `<storageDir>/incoming` is a `400` and opens no run.
- **The pooled tenant hint.** Two tenants, each with a web surface, in one pooled host: a message to
  one's mount runs a turn for that one and nothing for the other, and neither is refused for a missing
  hint. On a dedicated host, a request naming the other client is refused and audited (invariant 19,
  unchanged).
- **A secret-source conformance suite**, `secretSourceConformance(makeSource)` in
  `@harness/config-api/testing`, run by **both** implementations — the same arrangement
  `configSourceConformance` has, and with the same signature shape: a factory returning a harness whose
  `close` is awaited after each case, not a bare source.
- **The envelope test vector of §4.10 as a test**: encrypt with the fixed IV injected, assert the blob
  hex exactly; decrypt the blob hex, assert the plaintext.
- **`client_secrets` isolation**: two tenants, each with a secret named `web-token`, opened in one pooled
  host; each resolves its own value and neither can reach the other's (invariant 21). A tenant whose
  `{ ref }` has no row fails to open, naming the client and the secret name and not the row.
- **The per-tenant gateway key proved on `model_calls`**: two tenants in one pool with two keys, a turn
  each against a fake gateway that records the bearer it was sent; the bearers differ and each matches
  its own tenant's (invariant 22).
- **The version-rewrite refusal**: the same version with different content raises a `ConfigError` naming
  the client and the version, and leaves both tables as they were; the same version with identical
  content is a no-op.
- **The read routes' column lists asserted whole**, the way `usage.test.ts` already asserts
  `usage_runs`'s; plus the four `status` filter values accepted and a fifth refused with a `400`.
- **`defaults.web` bounded**: a document whose `defaults.web` names `lead` is refused at parse
  (invariant 24).
- **Snapshots.** The recorder's fixture document declares `memory` and `http`, no `web` and no `{ ref }`,
  so `tool-surface.json` and `compose-surface.yaml` are byte-identical unless a task deliberately changes
  that fixture. `HARNESS_SECRET_SOURCE` is a new variable, goes in `.env.example`, and re-records the
  compose snapshot once when the Compose task adds it — without a `:-` default.

## 21. Order and exit criterion (extends section 10)

| Plan | Repository | Delivers | Exit criterion |
| ---- | ---------- | -------- | -------------- |
| 11c | agent-harness | web surface + the streaming seam, `SecretSource` (`env` + `postgres`) with `client_secrets`, §6 write contract + version-rewrite refusal, `GET /v1/approvals` and `GET /v1/memory`, `routing.gateway.key` | a tenant with no Slack talks to its agent through the web surface from the platform's workspace; a tenant added by writing rows — document plus secrets — answers on a pooled host with **no restart**; a tag releases four images |

11c sits between 11b and 12: `v0.2.0` is Plan 11b, `v0.3.0` is Plan 11c, and P1's own exit criterion pins
to `v0.3.0`. **Half of the exit criterion is the platform's**: the kernel owes the web surface, the
streaming seam, the secret source and the no-restart tenant open, and proves all four in its own suite
against a pooled host. The four images are the transplant's — the kernel's `release.yml` builds host and
files today, and control-plane and workspace are two more build steps added when those directories exist.
The kernel's share of that line is that one tag drives it and that nothing in `release.yml` needs to know
which image is whose. Every row of §10, P1 through P8, now reads `agent-harness` in its `Repository`
column (§3.2 as amended).

## 22. What the platform owns, amended (extends section 11)

Unchanged in substance: tenants, documents, blueprints, the catalogue, the control plane, secrets,
gateway keys and budgets, the ingress, the host pool, the modeler, dashboards, billing, lifecycle
workers, the process engine. What changes is the address. They live in `catalog/`, `control-plane/`,
`apps/workspace/` and `deploy/` in this repository, under the boundary of decision 1b as amended, and
**adding a client still touches nothing** under `harness/`, `packs/`, `surfaces/`, `identities/` or
`runtimes/`. That sentence is the whole of decision 1, and one repository does not weaken it: a tenant is
rows in a store or a directory of documents, and neither is a file in this tree.

## 23. Constraints the plans inherit from the code, 11–24 (extends section 12)

11. **`loadSurfaces` resolves by specifier from `@harness/approvals`, not from the host.**
    `surfaceSpecifier('web')` builds `@harness/surface-web` and `registry.ts` dynamic-imports it; its own
    refusal says "add it to @harness/approvals dependencies and run pnpm install". So `@harness/surface-web`
    must be a real workspace package under `surfaces/` and be declared in **`harness/approvals`**
    `dependencies` and in **`harness/host`** `dependencies` — which is where `@harness/surface-slack` and
    `@harness/surface-http` are, and where `@harness/surface-memory` is for the host (it is a
    *devDependency* of approvals, which is enough only because no shipped document declares it). *The
    platform's request and the Task 1 brief both say "host/core-tools"; that is the rule for an
    **identity** plug-in, because `loadIdentity` lives in core-tools. For a surface it is approvals and
    host, and core-tools is not touched.*
12. **A surface may import only its own contract and `@harness/shared`.**
    `a-surface-imports-only-api-and-shared` is an `error`-severity rule whose `to.path` alternation covers
    every workspace tree, with `pathNot` only `harness/surface-api/src`, `harness/shared/src` and the
    adapter's own directory — **and its tests are not exempt**. The web surface writes its own
    constant-time compare, its own SSE framing and its own JSON shapes; it may not reuse the host's
    `sseStream`, `bearerOk` or `json`. `assertInsideRoot` it *may* use: that one is in `@harness/shared`.
13. **`pnpm arch`'s file globs are written out in `package.json`**, one per kernel tree, and the
    cross-package rules' `to.path` alternations name those trees literally
    (`^(harness|packs|surfaces|identities|runtimes|evals|scripts)/`). A new top-level `catalog/` is
    therefore invisible to both: a kernel package importing it would not be a violation and would not even
    be cruised. The monorepo amendment must widen the globs **and** every alternation.
14. **`.dependency-cruiser.cjs` carries two hand-maintained lists**, and its own header says a new package
    is "two lines": a `PACKAGES` row (which generates that package's five layer rules) and a
    `WORKSPACE_DIRS` entry (which `crossPackageRule` maps over, so other packages reach it only through
    its declared exports). `@harness/surface-web` needs both in 11c, and each platform package needs both
    in the transplant. Decision 1b's second half — "`catalog/` may import kernel *contracts* only" — has
    **no rule shape today**; it is a new rule written like `a-surface-imports-only-api-and-shared`, and
    without it that half of 1b is prose.
15. **`pnpm-workspace.yaml`'s `packages` globs** widen with the transplant, and that widens what
    `publicPackageNames()` — in `scripts/src/domain/workspace.test-helpers.ts`, read by
    `release-workflow.test.ts` and `packaging.test.ts` — expands: a platform package that forgot
    `"private": true` joins the published set. `workspaceDirs()` throws on any glob that is neither a
    literal path nor `parent/*`, so `apps/workspace` is added as a literal or as `apps/*`, never as
    `apps/**`.
16. **The env-read scan's roots are an explicit list**, `SOURCE_ROOTS = ['harness', 'packs', 'surfaces',
    'identities', 'runtimes', 'evals', 'scripts']` in `record-surface.ts`, walked from the repository
    root. The platform's four directories are outside it by construction and must **stay** outside it:
    the platform documents its own variables, and pulling them into this repository's `.env.example`
    would put a product's configuration in the OS's contract. `HARNESS_SECRET_SOURCE` is a kernel
    variable, is read inside those roots, and does go in `.env.example`.
17. **The kernel-vocabulary scans are an explicit `SCANNED` list of kernel roots**, each with a
    `minFiles` floor. They need no change for the monorepo and must not gain the platform's directories.
    The allowlist is empty and stays empty; `harness/host/src` is still scanned, so no route name, event
    name or frame from §4.9 may appear there.
18. **`SURFACE_ORDER`'s consumers.** `surfaceNamesOf` filters it, `parseClientDocument` takes
    `surfaces[0]` as the primary and refuses `http` there, `surfaceSecretsOf` reads the typed sections,
    and `openTenant` maps the names through `surfaceSpecifier` into `loadSurfaces`. Those four handle
    `web` as of `486c0a4`. **`tenantKeysOf` does not**: it branches on `slack` and `memory.workspace`
    only, and the Task 1 report says so in its own words — "`tenantKeysOf` is untouched — `web` has no
    tenant-key field". That is the gap §4.9's tenant-hint paragraph closes, and it is not optional: on a
    pooled host it is the difference between a working surface and one whose every message is audited
    `unauthorised` and dropped.
19. **`assertSecretsPresent` currently refuses every `{ ref }`**, by design, with the message Task 1
    shipped, and runs *after* `buildKernelConfig`. Plan 11c replaces it with `resolveSecrets`, moves it
    *before* `buildKernelConfig`, and keeps the refusal verbatim when the source is `env`. The `settings`
    loop just below it — which filters to `'env' in ref` and carries a comment saying
    `assertSecretsPresent` has already thrown for the rest — is the other half of the same change.
20. **The gateway bearer has one source today**: `gatewayFromEnv(env)` reads `LITELLM_MASTER_KEY` through
    `requiredEnv`, `buildKernelConfig` calls it, and `httpGateway` sends `config.apiKey`. A per-tenant key
    is a third parameter on `buildKernelConfig` and a change at both of its call sites, not a one-line
    substitution.
21. **`RoutingFile` is not `.strict()`** (unlike `RouteSpec`, `SurfacesShape` and `ClientDocumentShape`),
    so an unknown key under `routing:` is silently **stripped** today. A mistyped `gatway:` would leave a
    tenant believing it has its own key while its calls went out on the process key — a silent
    credential fallback. Ruling: the task that adds `routing.gateway` makes `RoutingFile` strict in the
    same commit. Only `routes` and `defaults` are written anywhere in this repository, so nothing breaks;
    `@harness/gateway`'s renderer reads those two and is inert to the new field.
22. **The version-rewrite refusal lives in `writeClientDocument`** (`harness/config-postgres/src/source.ts`),
    whose history insert is `onConflictDoNothing` inside a `withTransaction`.
23. **The lint ceiling is 25 warnings** and the branch sits exactly at it, with no headroom: `pnpm lint`
    runs plain `eslint .` and `pnpm lint:strict` runs it at `--max-warnings=0`, so the ceiling is the
    plan's rule rather than a script's, and the gates script only reports the count. Task 1's own gates
    run recorded 0 errors and 25 warnings. New code that adds a warning has to remove one.
24. **`process.env` is banned outside `app/`, `shared/env.ts` and tests**; a plug-in reads `deps.env`.
    The web surface reads no environment variable at all — its one credential arrives resolved on
    `deps.secretValues` — which is the cleanest possible answer to that rule.

## 24. Open questions 5–8 (extends section 13)

Spec §13.4 — "secret store for tenant plug-in credentials in the platform: decides the `SecretRef` shape"
— is **closed** by decision 18 and by `SecretRefShape` as shipped in `486c0a4`: the shape is
`{ env } | { ref }` and the store is `client_secrets`.

5. **The SSE resume window.** How many frames per conversation are held, and for how long, before a
   `last-event-id` can no longer be honoured. In memory per host is the obvious first answer and is wrong
   the moment there are two hosts behind the platform's ingress; a table is durable and is a write per
   delta. A bound to decide before the stream is written, not after.
6. **`defaults.web`.** Ruled **yes, with a ceiling** — invariant 24. The reason `http` may never have a
   default is written into the code and reads as a description of the web surface: "a single shared
   bearer token… and the surface user id straight from the request body", which is exactly
   `POST …/web/messages`. The difference the yes relies on — that the platform authenticates the person
   before it calls — is a difference in intent, not in mechanism, so it is bounded rather than trusted: a
   leaked web token can mint principals, but none above the declared default and none at `lead` or above.
   A Slack-less tenant with no default has no way to let a new person speak, which is the whole of P1, so
   a ban is not available. Open for P2: whether the workspace's bearer should instead be scoped to the
   identity plug-in it may mint against, which would make the ceiling unnecessary.
7. **`list` on `SecretSource`.** Left off (§4.10). The platform lists its own store; a host resolves what
   a document names. One cost to watch: §9's "a `{ ref }` with no row fails to open" case, and any
   operator diagnosing a missing secret, both want to know what the store *does* hold for a tenant, and
   without `list` the only answer is the platform's SQL. That is the right trade today and stops being
   right the first time a kernel-side runbook step says "check the secret exists".
8. **Rotating a secret without reopening a tenant.** §4.10's rule — pair a rotation with a version bump —
   is a contract on the writer, not a mechanism. Three candidates if that proves too sharp an edge: the
   host re-resolves on a gateway or surface 401 (one retry, one place); a TTL on resolved secrets (a timer
   per tenant, and a rotation still takes effect late); or `watch` over `client_secrets.updated_at` (a
   second poll per tenant). Decide before P2 mints its first key.

## 25. Not in Plan 11c

**Plan 12, unchanged:** Jev and typed model access behind the gateway seam; `correlation` on runs and the
`GET /v1/events` feed with its webhook sink; declared MCP and A2A plug-ins with the `write.assign` gate;
the `execute` action class. The web surface's SSE stream is *not* the event feed — one is a conversation
on one surface, the other is every outcome of a tenant — and they stay separate contracts, though they
now share the streaming seam decision 23 adds.

**Not planned here at all:** the Teams surface and the Entra identity plug-in (Weave's, their own spec);
the sandbox implementation (`@harness/sandbox-api` stays the reserved interface Plan 11b shipped).

**The 11a and 11b follow-ups**, carried forward from PR #14's body and not folded into 11c:

- pooled-host hardening — an acknowledged, not-yet-active surface delivery is not awaited by
  `pool.drain`, so production shutdown has the gap the CI fix closed only for the suite;
- no backoff on repeated `auth.test` during a long outage of a surface's upstream;
- clock injection, carried from the 11a and 11b review lists;
- `stop()` recall, carried from the same lists;
- publishing polish — no `license` field and no LICENSE file on the seven published packages (**a user
  decision**: the kernel is licensed, never assigned); no `main`/`types` fallback in `publishConfig`; no
  `engines`; `./testing` subpaths need optional peers; the packed manifest carries devDependencies and
  scripts; package READMEs are written for the workspace rather than for a registry;
- images are amd64 only; multi-arch is a platform ask;
- `gh release edit` on a re-run overwrites a hand-edited release body.

## 26. Plan 12a — skills as folders, memory the platform can write, and what two live tests found (addendum, 2026-09-22)

Plan 12 is split into three. **12a is this one**: the skill folder shape, memory write routes on the
run API, the two web-surface follow-ups the platform filed after it built against `v0.3.0`, and the
three Slack fixes the user's own live test found on the morning of 2026-09-22 (section 4.16). 12b is
the MCP plug-in seam with an Activepieces MCP server as its reference client. 12c is the Jev typed
model seam, `correlation` and the event feed, the `execute` action class, delegation caps and the MCP
facade. The split exists because 12b and 12c each add a new outbound dependency and a new trust
boundary, and 12a adds neither: every line of it is a shape the kernel already has, made large enough
for what the platform is building on top.

The baseline is `main` at `25ac653`, which is `v0.3.0`. The branch is
`worktree-plan-12a-skills-and-memory`. Two user directions are the whole of the brief behind it:
*"configure the skill, connect from open source things"* — a skill is a folder, not a string, so a
skill can carry the templates and reference files an open-source skill ships with — and *"manipulate
and see the memory from UI"* — the workspace can already read a tenant's memory and has no way to
change it. The two web items come from the platform session's own list: it names each person's own
conversation `u-<surface user id>`, and the kernel neither protects that naming nor accepts a
percent-encoded conversation id.

Everything below is a ruling. Where a ruling costs something, the cost is written beside it.

## 27. Decisions taken in Plan 12a (extends section 15's table)

Rows 28–38 continue the numbering of sections 2 and 15.

| #  | Question | Decision | Why, and what it costs |
| -- | -------- | -------- | ---------------------- |
| 28 | What a skill is | **A folder.** `ClientDocument.skills` becomes `Record<name, SkillShape>` with `SkillShape = { markdown: string; resources: Record<path, string> }`, strict, carried in the document and versioned with it. There is **no new table**: the section 18 write contract is unchanged and the platform writes the document exactly as it does today. **No back-compat**: a document whose `skills.<name>` is a string is refused at load with a message naming the skill and the new shape. | An open-source skill is a directory — a `SKILL.md` and the templates, checklists and reference pages it tells the model to read. A string can carry only the first of those, so today a skill that needs a template has to inline it into its own prose or do without. The cost is that every document in a store has to be rewritten before this build serves it; the refusal is loud and names the skill, which is the cheapest possible migration and the only honest one under decision 2b. |
| 29 | How big a skill may be, and where the bounds live | **Five constants in `@harness/shared`**, read by the schema, by the files source, by the materialiser and by the runtime: a resource path matches `/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/` and is at most 128 characters; a file is at most 64 KiB; a skill holds at most 32 resources; a skill is at most 512 KiB in total. A path may never be `SKILL.md` in any casing. | The document is a `jsonb` column and a YAML file, and a skill with a 50 MB attachment is a tenant that cannot be opened. `@harness/shared` because four packages in three bands need the same numbers and two of them may not import each other — the reason `CONVERSATION_ID_PATTERN` already lives there. The casing rule is not pedantry: macOS and the CI runner disagree about whether `skill.md` and `SKILL.md` are one file, so allowing the lowercase spelling would make a tenant's skill load on one machine and overwrite its own manifest on another. |
| 30 | How a directory of skills reaches a document | **A second include tag, `!include-skills <dir>`**, in `@harness/config-files`. `skills: !include-skills skills` folds `skills/<name>/` beside `client.yaml` into the section: `SKILL.md` becomes `markdown`, every other file under that directory becomes a resource keyed by its path relative to it. Confined to the client's own directory by the same two checks `!include` uses, and it does not follow a symlink out. | The two alternatives were both worse. Overloading `!include` so that a path to a directory answers with a map makes one tag polymorphic in its return type, and the map it would have to answer with is skills-shaped rather than directory-shaped, so the tag would have to know about skills anyway. A convention the source applies when the `skills:` key is absent is magic on top of magic: a document would name none of its own content. A second tag costs one more thing to learn and says, in the document, where that document's skills come from. |
| 31 | What the runtime seeds | **Every file under `skill.dir`, recursively, as `/skills/<name>/<path>`**, under the same bounds. `RunSkill` is unchanged: `dir` was already the contract and a second field listing the files would be a second answer to a question the directory answers. `skill_activated` is unchanged — the first `read_file` under `/skills/<name>/`, whichever file it names. | A skill folder the model cannot see is a folder that does not exist. Keeping `RunSkill` fixed keeps the host out of it: the host materialises a directory and hands over its path, and what a runtime does with the files in it is the runtime's business. The cost is that a runtime now walks a directory per skill per turn; it is a handful of small files, and they are already re-read every turn, which is what makes an edited skill current on the next one. |
| 32 | `allowed-tools` in a skill's frontmatter | **Not in 12a.** | A field the runtime does not enforce is the silent-fallback class that section 23's constraint 21 was written against: a skill declaring `allowed-tools: [documents_read]` while every other tool stayed callable would read as a restriction and be none. Tools are governed by the policy matrix and by `policy.tools.hide`, both of which the kernel enforces. It goes in "not in 12a" rather than into the schema. |
| 33 | How the workspace changes a memory entry | **Three write routes on the run API**: `POST /v1/memory`, `PUT /v1/memory/<id>`, `DELETE /v1/memory/<id>`, authenticated and tenant-resolved exactly as `GET /v1/memory` is — the bearer, then `x-harness-client`, and no principal resolution at all. | Decision 20 gave the workspace a memory page it can only read. A page that shows a wrong fact and cannot fix it sends the operator to `psql`. The routes are on the run API rather than on the web surface because a memory entry belongs to a tenant and not to a conversation: a tenant with Slack and no web surface has the same page. |
| 34 | Who a platform memory write is made by, and what it may reach | **`created_by` is the tenant's service principal id**, and a write route reaches **every row of the tenant**, not only what one principal can see. The tool path is unchanged and still reaches what its caller can see. | The platform acts through the tenant, not as a person; its own actor is recorded in the platform's audit, which is a different log answering a different question. The reach follows `GET /v1/memory`, which already lists every entry of the tenant including one person's own notes: a page that lists a row it cannot delete is a page that lies about what it is. The cost is stated plainly — **the platform's bearer can delete any principal's private note** — and it is the same bearer that can already read every one of them. |
| 35 | Whether an edited entry says so | **`memory_entries.updated_at timestamptz null`**, migration 0017. `PUT` sets it; `GET /v1/memory` and every write route's answer carry it; **`memory_list`'s output is unchanged**, so the tool surface stays byte-identical. | A memory page that cannot tell an entry written last year from one corrected this morning is a page an operator cannot trust. It is null rather than defaulted to `created_at`, so that "never edited" is a fact the column states rather than one a reader infers from two equal timestamps. It stays off the tool's output because the model has no use for it, and every field on a tool's output schema is a line in the snapshot and a token in every prompt. |
| 36 | What a full scope answers a write route | **`409`, with a fixed sentence carrying the scope and its two caps and naming no entry**, never the tool's own refusal text. | `memory_add`'s refusal to the *model* deliberately carries every current entry with its id, so the model can consolidate in the same turn. Handing that text to an HTTP caller would put memory text in an error body and in whatever log the caller keeps, which invariant 27 forbids. The cap itself is not bypassed: the same check runs, and the difference is only what the caller is told. |
| 37 | A conversation named after a person | **`u-` is reserved.** `surfaces.web.inbox` may not start with `u-` (a parse-time refusal), and the web door refuses a message, an action or a form whose conversation is `u-<x>` unless the request's `userId` is exactly `<x>` — `400`, a fixed sentence, and **audited once**, the way the bearer refusal is. **The stream is not covered**, because nothing identifies the reader on it (section 30, invariant 29). | The platform names each person's own conversation with an agent `u-<surface user id>`, so `u-` already means "this belongs to one person" in the only client this surface has. Without the door check, a workspace bug that sent the wrong `userId` would put one person's question into another person's conversation, and the tenant's bearer is the same for both. It is audited, unlike the door's other `400`s, because this one is somebody reaching into a conversation that is not theirs, which is a boundary an operator counts. |
| 38 | A conversation id in a path | **The web surface decodes its own segment** with `decodeURIComponent` before the pattern test; a segment that does not decode is a `400`. The host stays byte-exact: it matches `/tenants/<clientId>/` on the raw path and hands the rest over untouched. | `CONVERSATION_ID_PATTERN` allows `:` and `@`, a correct client percent-encodes both, and the door tests the raw segment — so `team%3Aapprovals` is a `400` today and `team:approvals` is not, which is a difference no client can be written against. The host is left alone because a client id is `[a-z0-9-]` and never needs encoding, and a host that decoded would have to decide what `%2F` means in a tenant prefix. |
| 39 **(live-test ruling)** | Which thread a reply lands in | **The adapter decides, and the host is unchanged.** `handleMessage` already sets `replyTo` to the triggering message and `postText`, `startStream` and `uploadFile` already send `replyTo.id` as `thread_ts`, so a channel reply is already threaded. What changes is inside `surfaces/slack`: `replyTo.id` is resolved to the **thread root** the transport already remembers, and a **direct message sends no `thread_ts` at all**. | The two real defects are the opposite of the one reported. A DM is threaded today, because `replyTo` is set unconditionally and the adapter uses it blindly, so every answer in a DM opens a thread nobody asked for. And a mention *inside* an existing thread is answered against that message's own `ts` rather than the thread's root, which Slack's own documentation warns against. Both are the adapter's, which is where they belong: the host may not learn what a `D` channel prefix means, and `harness/host/src` naming a vendor is what the vocabulary scan forbids. |
| 40 **(live-test ruling)** | What an undeclared person is called | **`identities/static` reads the display name off the surface's directory**, exactly as `identities/slack-groups` already does: `deps.directories[surface]?.displayNameOf(userId)` into `principalFromDefault`'s fourth argument. The Slack name cache is split from the group cache — one hour rather than five minutes, because a name changes far less often than a membership — and **bounded**, which it is not today. | The mechanism is all there and one call site does not use it: `SurfaceDirectory.displayNameOf` is implemented over `users.info`, `IdentityDeps.directories` carries it, and `principalFromDefault` already takes a name and falls back to the user id. `identities/static` passes three arguments where there are four, so a default-level person is addressed as `U0C0HQHGY8K` — and `static` is the plug-in the fixture and the demo tenant use. The unbounded name cache is a leak per distinct user for the life of a process. `users:read` is already granted (runbook scopes table). |
| 41 **(live-test ruling)** | Showing that a reply is coming | **`SurfaceSession.typing` grows a `replyTo` and answers a disposer**: `typing?(conversation, opts?): Promise<() => Promise<void>>`. `runTurn` calls it before the runtime starts and disposes it in its `finally`, on every path out. Slack implements it as an `eyes` reaction added to the triggering message and removed when the turn ends; a failed `reactions.remove` is one fixed log line and the reaction stays. New scope **`reactions:write`**. | `typing?(conversation)` has been declared in `@harness/surface-api` since Plan 7 and **nothing has ever called it** — the silent-fallback class constraint 21 was written against, sitting in the contract. It also cannot address the triggering message, which is the whole of what an acknowledgement has to do. Widening it costs nothing, because there is no caller to break, and it gives the seam the one caller it was declared for. A disposer rather than a second method, so the adapter owns the pairing and the host cannot leak one half of it. |

## 28. Contracts added in Plan 12a (extends section 17)

Three new subsections of section 4, in the numbering that section already uses.

### 4.13 A skill is a folder

**The shared bounds.** One new module, `harness/shared/src/skills.ts`, exported from
`@harness/shared`. It holds no logic: it is the five numbers and the one pattern that four packages
have to agree on, in the one package all four may import.

```ts
/** The manifest every skill folder has, and the one name a resource may never take. */
export const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * A resource's path inside its skill folder: slash-separated segments, each starting with a
 * lowercase letter or a digit. `..` cannot be spelled, because a segment may not begin with a dot.
 */
export const SKILL_RESOURCE_PATH_PATTERN = /^[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/;
export const SKILL_RESOURCE_PATH_MAX_CHARS = 128;

/** One file — the manifest or a resource — measured in UTF-8 bytes. */
export const SKILL_FILE_MAX_BYTES = 65_536;
/** Resources beside one manifest. */
export const SKILL_MAX_RESOURCES = 32;
/** The whole folder, manifest included, in UTF-8 bytes. */
export const SKILL_MAX_BYTES = 524_288;
```

**The document section.**

```ts
export interface SkillShape {
  /** The whole SKILL.md, frontmatter included. */
  markdown: string;
  /** Every other file in the folder, by its path relative to the folder. Empty for a skill with none. */
  resources: Record<string, string>;
}

// in ClientDocumentShape
skills: z.record(z.string().regex(SKILL_NAME), SkillShape).default({});
```

Strict, at both levels. The refusals, each a `ConfigError` naming the skill and, where there is one,
the path — **and never the content**:

| What | Refusal |
| ---- | ------- |
| `skills.<name>` is a string | `skill "<name>" is a string, and a skill is a folder: write { markdown: "<the SKILL.md>", resources: { "<path>": "<text>" } }` — checked before the schema parse, so the message is this one rather than "expected object, received string" |
| an empty `markdown` | the schema's own `min(1)` at that path |
| a path that is not one | `skills.<name>.resources` key against `SKILL_RESOURCE_PATH_PATTERN` |
| a path whose last segment lower-cases to `skill.md` | `skill "<name>": the resource path "<path>" is the manifest's own name` |
| a file over `SKILL_FILE_MAX_BYTES` | at the offending path, naming the bound |
| more than `SKILL_MAX_RESOURCES` resources, or a folder over `SKILL_MAX_BYTES` | at `skills.<name>`, naming the bound |
| a NUL byte anywhere in a file | at the offending path; content is text, and a `jsonb` column cannot hold a NUL |

`SkillShape` is exported from `@harness/config-api` with its inferred type, beside `SecretRef`.

**The files source.** A second include tag, whose value is a directory relative to `client.yaml`:

```yaml
skills: !include-skills skills
```

It reads `<dir>/<name>/` for each immediate sub-directory, in name order, and answers
`Record<name, SkillShape>` with `markdown` from `SKILL.md` and one resource per other file, walked
recursively, keyed by its path relative to `<dir>/<name>/` with `/` separators and sorted. The rules:

- The directory and every file under it are confined to the client's own directory by the two checks
  `readIncluded` already makes — once on the literal path, once on the `realpath` — for the reason
  that file's comment gives. A symlink is **not followed**: the walk takes regular files only, so a
  link pointing anywhere, inside or out, contributes nothing.
- A file sitting directly in `<dir>` rather than in a skill's folder is a `ConfigError` naming it: a
  skill is a folder, and a stray `notes.md` beside the folders is somebody's mistake, not a skill.
- A folder with no `SKILL.md` is a `ConfigError` naming the folder.
- The bounds are **not** re-implemented here. The source reads and the schema refuses, so a document
  from the `postgres` source and a document from a directory are bounded by one piece of code.
- An empty `<dir>`, or a `<dir>` that is not there, is a `ConfigError`. A client with no skills omits
  the key; `skills` defaults to `{}`.

`!include` itself is untouched: it still takes one path to one file and answers that file's text.

**On disk, for the runtime.** `materialiseSkills` writes `<storageDir>/skills/<clientId>/<name>/SKILL.md`
and `<storageDir>/skills/<clientId>/<name>/<path>` for each resource, creating each parent, and it
still rebuilds the whole tree from scratch on every tenant open. `readSkillCatalogue` is unchanged: it
validates `SKILL.md`'s frontmatter and answers `RunSkill { name, version, description, dir }`. The
kernel's own skills in `harness/host/skills/` and a pack's under its `skillsDir` may carry resources
too, read by the same reader and bounded by the same constants — asserted by a test over every skill
this repository ships, so a pack that adds a 5 MB reference PDF fails the suite rather than a tenant's
turn.

**In the model's files.** `seedFiles` walks `skill.dir` recursively, regular files only, and seeds
each as `/skills/<name>/<path>` — `SKILL.md` among them, at `/skills/<name>/SKILL.md`, which is where
it is today. The bounds are checked at seed and a breach throws, naming the skill and the path. The
prompt's skills line says that a skill is a folder and that the files beside `SKILL.md` are read the
same way. `skill_activated` still fires on the first `read_file` under `/skills/<name>/`, whichever
file it names, which is what makes a skill activated by reading its checklist count as activated.

### 4.14 Memory writes on the run API

Three routes beside `GET /v1/memory`, with **identical authentication and tenant resolution**: the
bearer, then `x-harness-client` through the pool's resolver, and no principal resolution at all. The
caller is the control plane acting for the tenant.

```
POST   /v1/memory        { scope: 'client' | 'principal', principal_id?: string, text: string }  → 201 MemoryReadRow
PUT    /v1/memory/<id>   { text: string }                                                        → 200 MemoryReadRow
DELETE /v1/memory/<id>                                                                           → 204, no body
```

`principal_id` is **required** for `scope: 'principal'` and **refused** for `scope: 'client'`; a
client-scope row has a null `principal_id` and a principal-scope row is somebody's, and a body that
says otherwise is a caller who has not decided which it meant.

`MemoryReadRow` is the shape `GET /v1/memory` already answers, plus one field:

```ts
export interface MemoryReadRow {
  id: string;
  scope: string;
  principal_id: string | null;
  text: string;
  created_by: string;
  created_at: string;
  updated_at: string | null;   // new in 12a; null until the entry has been edited
}
```

The refusals, each a fixed sentence that repeats nothing the caller sent:

| Status | When |
| ------ | ---- |
| `400` | the body is not JSON, or does not parse against the shape (the shape's own prettified error, which names fields and not values) |
| `400` | `text` is not 1 to `MEMORY_ENTRY_MAX_CHARS` characters — **the constant imported from `@harness/core-tools`, never re-typed** |
| `400` | `text` trips the injection scan (an instruction-shaped phrase, an invisible Unicode character) or the restricted-pattern check; the scans' own sentences, which name the category and never echo the text |
| `400` | the `<id>` segment is not a uuid |
| `404` | no such entry **in this tenant** — indistinguishable from an entry of another tenant, because the query carries the tenant predicate rather than filtering a result |
| `409` | the scope is full: `the "<scope>" memory scope is full: at most <n> characters across at most <m> entries; remove an entry first` — the numbers, never the entries |

**Where the work lives.** The domain functions are in
`harness/core-tools/src/domain/memory/repository.ts` and are shared by the tools and the routes, so
there is no second copy of the cap arithmetic and no second `WHERE`:

```ts
/** Which rows a write may reach. */
export type MemoryReach =
  | { kind: 'tenant' }                            // every row of the tenant: the run API's reach
  | { kind: 'visible-to'; principalId: string };  // that principal's own notes and the shared scope

/** Who is writing, where they are writing from, and what they may reach. */
export interface MemoryWriter {
  db: Db;
  client: string;
  /** What lands in `created_by`. */
  actor: string;
  /** The `threads` row the write came from, or null when it came from no conversation. */
  threadId: string | null;
  reach: MemoryReach;
}

/** What a new entry is filed as. `principalId` is the entry's owner, which need not be the actor. */
export type MemoryTarget = { scope: 'client' } | { scope: 'principal'; principalId: string };

export function addMemory(w: MemoryWriter, args: { text: string; target: MemoryTarget }):
  Promise<{ id: string; scope: MemoryScope; remaining_chars: number }>;
export function editMemory(w: MemoryWriter, args: { id: string; text: string }):
  Promise<{ id: string; scope: MemoryScope }>;
export function removeMemory(w: MemoryWriter, id: string): Promise<{ removed: true; scope: MemoryScope }>;

/** A scope that cannot hold the write, with the numbers and **no entry text** on the error object. */
export class MemoryFullError extends ToolError {
  readonly scope: MemoryScope;
  readonly usage: ScopeUsage;
  readonly needed: number;
}
```

`MemoryFullError.message` is the sentence `memory_add` gives the model today, entries included and
unchanged; the route reads the fields and writes its own sentence. `editMemory` runs the same three
checks an add runs — length, injection, restricted pattern — and the same cap, measured with the
entry's **own current text discounted**, so correcting a typo in a full scope is not a refusal.

**The audit row.** Every write that reaches the table writes one `audit_log` row through the same
`writeAudit` a tool's call does:

| Column | Value |
| ------ | ----- |
| `client` | the tenant the request resolved to |
| `caller` | the tenant's service principal id — the same string as `created_by` |
| `tool` | `memory_add`, `memory_edit` or `memory_remove`. `memory_edit` is a name **no tool publishes**, which is the honest label: nothing a model can call edits an entry |
| `action_class` | `write.internal` for a client-scope write, `write.self` for a principal-scope one — the classes `memory_add`'s own `actionClassFor` assigns, so an operator grouping by class counts the same act the same way whoever made it |
| `args_hash` | `hashArgs({ scope })` for an add, `hashArgs({ id })` for an edit or a removal. **Never the text** |
| `decision` | `auto` — the bearer is the authorisation and policy does not gate this path |
| `run_id` | null: no run opened |
| `error` | null on success; on a full scope, the fixed `409` sentence the caller was given, never the entry text |

**A row is written exactly when the entry's scope is known**: on every write that reached the table,
and on a full scope, which is the one refusal that carries its scope on the exception. A body that
does not parse, a text the scans refused, a bad id and a `404` write **no** row. Two reasons, and
they agree: a caller's mistake is not a door turning somebody away — the reason the web door's other
`400`s cost nothing — and a row whose `action_class` had to be guessed because no entry was reached
is a row an operator cannot group by. A `404` is a row that is not there rather than a boundary
somebody crossed.

### 4.15 The web surface's personal conversations, and its own path segment

**`u-` is reserved for a person's own conversation.** Two rules, in two places:

1. `surfaces.web.inbox` may not start with `u-`. A parse-time refusal:
   `client "<id>": surfaces.web.inbox may not start with "u-", which names one person's own
   conversation; the inbox belongs to the tenant`.
2. `POST …/web/messages`, `POST …/web/actions` and `POST …/web/forms` refuse a conversation matching
   `/^u-(.+)$/` whose capture is not exactly the request's `userId`. `400`, the fixed sentence
   `that conversation belongs to another person`, and `refusal: { reason: 'foreign_user_conversation' }`
   — so the host audits it exactly once, before the head is written, the way it audits the bearer
   refusal. The action and form routes take the conversation from the `messageRef` they were handed,
   which is the conversation the check reads.

**The stream is not covered, and this is the residual.** `GET …/web/conversations/<id>/events` carries
no `userId`: the host strips the query string before an adapter sees a request, and the door reads
only `last-event-id` off the headers. So there is nothing on that request to compare `u-<x>` against,
and inventing a header for it would be inventing a contract in the plan that is repairing one. **The
bearer holder is the platform, and the platform enforces it**: one token opens every conversation of
its tenant, which the surface's README already says in as many words. Section 34's open question 9 is
where a per-reader credential would be decided; until then, a workspace that opens a `u-` stream for
the wrong person has made the same class of mistake as one that renders the wrong page.

**The door decodes its own segment.** `GET …/web/conversations/<id>/events` runs
`decodeURIComponent` on the captured segment before testing it against `CONVERSATION_ID_PATTERN`; a
segment that throws `URIError` is `400 {"error":"conversation is a conversation id"}`, the same
answer a segment that decodes to something that is not one gets. So `team%3Aapprovals` and
`team:approvals` are one conversation, and `a%40b` and `a@b` are one conversation. The host's own
routing is untouched: `handleSurfaceRequest` still slices `/tenants/<clientId>/` off the raw
`URL.pathname` and tests the client id against `CLIENT_ID_PATTERN`, which contains nothing that needs
encoding.

### 4.16 What the first live Slack test found

Three fixes, ruled from the user's live test on 2026-09-22 and ordered by what a person in the
workspace notices first. Each one is smaller than it was reported to be, because most of the
machinery is already there; what follows is what is actually missing, read out of the code.

**A reply belongs in the thread its question was asked in, and a direct message has no thread.**
The host is unchanged. `handleMessage` sets the turn's `replyTo` to the triggering message's ref,
`replyTarget` passes it into `startStream`, and the final post passes it into `postText` — and the
Slack session already sends `replyTo.id` as `thread_ts` on all three of `postText`, `startStream`
and `uploadFile`. So the reported symptom, a channel reply arriving flat, is not what the code
does. What the code does wrong is the other two cases:

| Case | Today | After |
| ---- | ----- | ----- |
| A mention at a channel's top level | `thread_ts` is the message's own `ts`, which is the thread root | unchanged |
| A mention **inside an existing thread** | `thread_ts` is that message's own `ts`, a *reply's* timestamp, which Slack documents as the wrong handle | the thread's root, which the transport already remembers in `ThreadMemory.roots` |
| A **direct message** | `thread_ts` is the DM's own `ts`, so every answer opens a thread inside the DM | no `thread_ts` at all; a DM stays flat |

`ThreadMemory` gains `rootOf(channel, ts): string`, answering the root it recorded in `noteInbound`
and falling back to `ts` for a message it does not know — a process that restarted mid-turn, or a
thread evicted from the bounded store. `SlackTransport` exposes it beside `notePostedIn`. The
session resolves a `replyTo` through one helper, used by `postText`, `startStream` and `uploadFile`
alike, which answers `undefined` for a conversation whose id begins `D`. That prefix is Slack's own
and it stays inside `surfaces/slack`: the host never learns it, which is what keeps
`kernel-vocabulary.test.ts` green.

**A person the document never declared has a name, and the assistant uses it.** Everything but one
call site exists: `slackDirectory` implements `displayNameOf` over `users.info`,
`IdentityDeps.directories` carries the map, `principalFromDefault(surface, userId, level,
displayName?)` takes a name, and `identities/slack-groups` passes one. `identities/static` does
not — it calls the same function with three arguments — so a default-level Slack user is minted
with `displayName` equal to their raw id, and `callerLine` in the runtime prompt then tells the
model it is speaking with `U0C0HQHGY8K`. Three changes:

1. `identities/static` takes `deps.directories` at `connect` and, when minting, reads
   `displayNameOf` off the directory for that surface. A directory that refuses or has none costs
   the caller nothing: the name falls back to the user id, exactly as `slack-groups` already rules,
   because a name is cosmetic and a level is not.
2. `slackDirectory` splits its two windows. Group membership keeps `DIRECTORY_CACHE_MS` at five
   minutes; a display name gets `DIRECTORY_NAME_CACHE_MS` of one hour, because a name changes far
   less often than a membership and every miss is a `users.info` call.
3. The name cache becomes **bounded** at `DIRECTORY_NAME_LIMIT = 500` entries, oldest out first. It
   is unbounded today, which is one entry per distinct user for the life of the process.

Nothing is logged about a profile: the directory records the name against the user id in memory and
writes neither to the log, and `mention()` stays `<@id>` on Slack, because that is what renders as a
mention there.

**A person sees that the assistant heard them, within a second.** `SurfaceSession.typing` becomes:

```ts
/**
 * Show that a reply is coming, where the surface can, and answer with the way to stop showing it.
 *
 * Optional: a surface with no such signal does not implement it. The disposer is called exactly
 * once, on every path out of the turn, including a failed or cancelled one.
 */
typing?(conversation: string, opts?: { replyTo?: MessageRef }): Promise<() => Promise<void>>;
```

`runTurn` calls it once, before the runtime starts, only when the turn delivers to the thread it
came from and only when it has a `replyTo`; the disposer is called in the same `finally` that closes
the kernel. **Neither call can fail a turn**: both are wrapped, and a throw from either is one log
line. The Slack adapter adds the `eyes` reaction to the triggering message and removes it in the
disposer; a `reactions.remove` that fails leaves the reaction and writes one fixed sentence, because
a stale reaction is a smaller wrong than a turn that failed over an emoji. The app needs
**`reactions:write`**, which is the one new scope in Plan 12a.

**First-turn latency is not a kernel fault and 12a does not change it.** The live test measured four
minutes to the first answer on a first prompt of about 22,000 tokens, and forty seconds on the
second. The kernel's contribution is fixed and small: it seeds the same files every turn — each
skill's folder and one memory snapshot — and the prompt is the tenant's own document, so its size is
the document's persona, its skills and its history window, none of which 12a changes. The rest is
the model's time to first token on a long prompt, and it belongs to whoever chooses the deployment
(`routing.routes.chat.model`, decision 24) and to prompt caching, which is a gateway concern. The
acknowledgement above is the honest answer to the symptom: the person learns in under a second that
they were heard. Nothing else here is a kernel change, and section 35 says so.

## 29. Data model additions (extends section 18)

**One migration in Plan 12a**, by plain `drizzle-kit generate`: 0017 adds one nullable column.

```sql
ALTER TABLE memory_entries ADD COLUMN updated_at timestamptz;
```

Null means never edited. Nothing backfills it, and `created_at` is not copied into it: two equal
timestamps would say "edited at the moment it was written", which is a different claim from "never
edited" and is not true. No index: the column is read, never filtered on. `resetDatabase`'s truncation
list is unchanged — this is a column on a table already on it.

The section 18 write contract gains one line under `client_documents`: `document` holds a whole
resolved `ClientDocument`, whose `skills` section is now `name → { markdown, resources }`. The columns
themselves do not change, and neither does rule 1, 2, 3 or 4.

## 30. Security invariants 25–31 (extends section 19)

25. **A skill's resource cannot name a file outside its own folder.** No document can express a path
    with a `..` segment, a leading `/`, a backslash or a NUL — `SKILL_RESOURCE_PATH_PATTERN` refuses
    each at parse — and the files source follows no symlink out of the client's directory, checking
    the literal path and the `realpath` as `!include` does. A resource named `SKILL.md`, in any
    casing, is refused, so a skill cannot overwrite its own manifest on a case-insensitive
    filesystem.
26. **A run API memory write reaches its own tenant and no other.** The tenant predicate is in the
    query, not applied to a result, on the add, the edit, the removal and the read-back; an id
    belonging to another tenant and an id belonging to nobody are the same `404`, byte for byte.
27. **No memory text leaves through an error or a log line.** A `409` for a full scope carries the
    scope and the two caps and no entry; an injection or restricted-pattern refusal names the category
    and never repeats the text; the `audit_log` row hashes `{ scope }` or `{ id }` and never the text;
    and no line the three routes write to the log carries a caller's string.
28. **A write route's audit row is written for every write that reached the table**, exactly once,
    carrying the tenant's service principal as its caller, and it is the only record of a change the
    platform made through the kernel.
29. **A `u-<x>` conversation on the web surface accepts a message, an action and a form only from
    `userId` `<x>`**; the refusal is audited exactly once, before a byte of the response is written,
    and the audit row repeats nothing of the body. **This invariant does not cover the event stream**,
    which carries no reader identity; the bearer is the bound there, and section 34's question 9 is
    open on it.
30. **An acknowledgement cannot fail a turn, and cannot outlive one.** `typing` and its disposer are
    each wrapped, a throw from either is one log line, and the disposer is called on every path out
    of `runTurn` — success, runtime failure, budget, cancellation and an uncaught throw alike.
31. **A display name read from a surface's directory is never logged and never leaves the
    principal.** It reaches `Principal.displayName`, which the runtime renders into the rules block
    and the host stamps on nothing; a directory failure is logged by category and never with the
    profile it was asking about.

## 31. Testing additions (extends section 20)

- **The skill shape.** A document with a string skill is refused, naming the skill. A resource path
  with `..`, with a leading slash, at 129 characters, or spelled `Skill.md`, `SKILL.MD` and `skill.md`
  is refused. A 64 KiB + 1 resource, a 33rd resource and a folder over 512 KiB are each refused at
  their own path. A skill with no resources parses to `resources: {}`.
- **The fold.** `!include-skills` over a fixture directory answers both skills in name order with
  their resources in path order, including one in a sub-directory. A symlink inside the directory
  pointing outside the client contributes nothing. A file directly in the directory, a folder without
  a `SKILL.md`, and a directory that is not there are each a `ConfigError`. A document whose
  `skills:` line is `!include-skills ../..` is refused as an escape, not reported as missing.
- **Round trip, end to end.** `clients/fixture` ships a skill with a resource; the files source loads
  it, `materialiseSkills` writes it, `readSkillCatalogue` reads the catalogue off it, and `seedFiles`
  seeds both files. Two clients materialised under one root see only their own.
- **Every shipped skill is within the bounds**: a test walks `harness/host/skills/` and every pack's
  `skillsDir` and asserts the file count, each file's size and the total.
- **`skill_activated` on a resource read**: a run whose first `read_file` under `/skills/<name>/` names
  a resource rather than `SKILL.md` still reports the activation once, with the host's version.
- **The memory write routes**, over a real pool and a real listener, beside the existing read-route
  tests: a `POST` at 500 characters succeeds and at 501 is a `400`; a `POST` with `scope: 'client'`
  and a `principal_id` is a `400`, and one with `scope: 'principal'` and none is a `400`; a `PUT`
  against another tenant's id and against a uuid nobody has are the same `404` body; a forged
  non-uuid id is a `400`; a text carrying a restricted pattern and one carrying an instruction-shaped
  phrase are each a `400` whose body does not contain the text; a full scope is a `409` whose body
  contains no entry; a `DELETE` is `204` and the row is gone; a `PUT` sets `updated_at` and a fresh
  `POST` leaves it null.
- **The audit rows counted, not merely found**: one row per successful write, `caller` equal to the
  tenant's service principal, `tool` the three labels, `args_hash` not equal to `hashArgs({ text })`,
  and **zero** rows for a body that did not parse and for a `404`.
- **Tenant isolation on the writes**: two tenants in one pooled host, each with one entry; each
  tenant's `PUT` and `DELETE` against the other's id answers `404` and leaves the other's row intact.
- **`u-` conversations**: a document whose `surfaces.web.inbox` is `u-alice` is refused at parse; a
  message, an action and a form on `u-alice` from `userId` `bob` are each a `400` with exactly one
  `audit_log` row, and from `userId` `alice` each is accepted; a conversation `u-` with nothing after
  it is an ordinary conversation, not a personal one.
- **The decoded segment**: `GET web/conversations/team%3Aapprovals/events` and
  `GET web/conversations/a%40b/events` each open a stream, on the same conversation their unencoded
  spellings reach; `GET web/conversations/a%ZZ/events` is a `400`.
- **The thread a reply lands in**, over `FakeSlack`: a mention at a channel's top level posts with
  `thread_ts` equal to its own `ts`; a mention inside an existing thread posts with the **root**,
  not the message's own timestamp; a direct message posts with **no** `thread_ts` at all, streamed
  and unstreamed alike, and a released file follows the same rule.
- **A name for somebody the document never declared**: `identities/static` over a fake directory
  mints a principal whose `displayName` is the name the directory gave, and falls back to the user
  id when the directory answers null or throws — the level is unaffected either way. The Slack
  directory answers `users.info` **once for two lookups of one user**, again after its own window
  but not after the group window, and drops its oldest entry past the bound.
- **The acknowledgement**, over `FakeSlack` and over a host turn: `reactions.add` is called once
  with `eyes` on the triggering message before the runtime runs, `reactions.remove` once when the
  turn ends; a turn that throws still removes it; a `reactions.remove` that fails leaves the
  reaction and writes one line; a turn with no `replyTo`, and one delivering somewhere other than
  its own thread, call neither.
- **Snapshots.** `docs/architecture/tool-surface.json` and `docs/architecture/compose-surface.yaml` are
  byte-identical in every task: no tool is added, removed or re-described — `memory_list`'s output
  keeps its five fields and gains no `updated_at` — and no environment variable and no Compose service
  changes.

## 32. Order and exit criterion (extends section 21)

| Plan | Repository | Delivers | Exit criterion |
| ---- | ---------- | -------- | -------------- |
| 12a | agent-harness | skills as folders (schema, `!include-skills`, materialiser, runtime seed), `POST`/`PUT`/`DELETE /v1/memory` with migration 0017, the `u-` conversation rules and the decoded web path segment, and section 4.16's three Slack fixes | an open-source skill folder dropped into a tenant's `skills/` directory reaches the model with its templates beside it; the workspace's memory page adds, corrects and deletes an entry of its tenant and of no other, and every change is one audit row; a workspace opening `team%3Aapprovals` and one opening `team:approvals` are on the same stream; and in the live Slack workspace a mention in a thread is answered on that thread, a direct message is answered flat, a person the document never declared is addressed by name, and they see the `eyes` reaction within a second of writing |

12a is one pull request and a `v0.4.0` tag, between `v0.3.0` (Plan 11c) and 12b. Nothing in it is a
seam 12b or 12c depends on, so the three may be reordered; they are in this order because 12a is the
one the platform is waiting on.

## 33. Constraints the plans inherit from the code, 25–33 (extends section 23)

25. **`document.skills` has exactly one reader in the kernel**: `materialiseSkills` in
    `harness/host/src/domain/tenancy/skills.ts`. Everything downstream — `readSkillCatalogue`,
    `RunSkill`, `preflightPlaybook`, the scheduler — works off a directory and a catalogue and never
    off the document, so the shape change stops at that one function.
26. **`catalog/src/testing.ts` builds a document with `skills: {}`.** An empty record is valid under
    the new shape, so the platform's own tree needs no edit — which it must not have, under the kernel
    boundary. Nothing else under `catalog/`, `control-plane/`, `apps/` or `deploy/` names `skills`.
27. **The fixture client is loaded by three suites** — `harness/config-files/src/source.test.ts`,
    `harness/host/src/domain/playbooks/preflight.test.ts` and `scheduler.test.ts` — through the real
    files source, and `pnpm new-client` reads it as the document every new client starts from. So
    `clients/fixture/client.yaml` has to be valid after **every** task, not at the end of the plan.
28. **`parseWithIncludes` is two passes**: `yaml`'s custom tags are synchronous and a file read is
    not, so a tag's `resolve` leaves a marker and `expand` walks the tree awaiting each one. A second
    tag follows the same shape, and its collection forms (`!include-skills [a, b]`) refuse, exactly as
    `!include`'s do.
29. **`addMemory` and `removeMemory` take the whole `ToolDeps` today** and use four fields of it:
    `db`, `client`, `principal.id` and `context.threadId`. The run API has no `ToolDeps` and building
    one for a memory write would mean a policy, an encryption key, a gateway and a storage root for a
    single `INSERT`. Narrowing the parameter is the change, not adding a second entry point.
30. **`visibleTo(client, principalId)` is the only predicate in the memory repository**, and every
    read and the `DELETE` go through it — which is exactly what the run API must **not** do, because
    a tenant-scoped page has to reach one principal's own notes. A second predicate beside it, chosen
    by `MemoryReach`, is the smallest change that keeps "the filter is the query" true for both.
31. **The run API answers `404` for another principal's run and thread already**, with the same body a
    missing one gets (`cancelRoute`, `threadRoute`). The memory routes copy that exactly, one level up:
    another **tenant's** id and a missing id are one answer.
32. **`SURFACE_REFUSAL_REASON_PATTERN` is `/^[a-z][a-z0-9_]{0,63}$/`** and the host replaces anything
    else with `unspecified`. A new reason is a token in that shape — `foreign_user_conversation` — and
    never a sentence.
33. **The lint ceiling is 25 warnings** and `main` at `25ac653` sits exactly at it. New code that adds
    a warning has to remove one. `pnpm lint` reports; `pnpm lint:strict` is the zero-warning run.

## 34. Open questions 9–11 (extends section 24)

9. **A per-reader credential for the web stream.** Invariant 29 stops at the stream because nothing on
   it says who is reading. The candidates: a short-lived per-conversation token the workspace fetches
   and puts in the URL; a `userId` the platform sends as a header and the door compares, which is the
   same trust the message route already extends and so buys less than it looks like; or leaving it
   with the bearer, documented. Decide before the workspace serves a tenant with more than one person
   in it — which is P2, not P1.
10. **A skill that ships a script.** A resource is text the model reads. An open-source skill that
    ships a `.py` or a `.sh` arrives as text the model can read and cannot run, which is the right
    answer today because there is no sandbox; it becomes the wrong answer the moment
    `@harness/sandbox-api` has an implementation and the `execute` class exists (12c). Decide then
    whether a resource is mounted into a sandbox, and under what class.
11. **Whether a memory edit keeps its history.** `updated_at` says an entry changed and says nothing
    about what it was. A `memory_entry_versions` table is the obvious answer and is a write per edit;
    the audit row is the cheaper one and carries only the hash of the id. Left at `updated_at`; revisit
    if a tenant ever has to answer "what did it remember last week".

## 35. Not in Plan 12a

Listed so a reviewer can see each was considered and left out on purpose.

- **`allowed-tools`, or any other frontmatter field the runtime does not enforce.** Decision 32.
- **A skill store, a skill table, or skills outside the document.** Decision 28: a skill is versioned
  with the document that declares it, because a tenant rolling back a document must roll back its
  skills with it.
- **Binary resources.** A resource is UTF-8 text with no NUL. An image a skill wants to show is a
  document in the knowledge base or a file in `incoming/`, both of which already have a home.
- **A `list` of a tenant's skills on the run API.** The document is the list, and the platform wrote it.
- **Paging, filtering or bulk writes on the memory routes.** One entry per call. The read route pages;
  a workspace that wants to delete twenty entries makes twenty calls, and each one is one audit row,
  which is the property that makes the log worth keeping.
- **A memory write from the web surface, or from any surface.** A memory entry belongs to a tenant,
  not to a conversation, and the model already has `memory_add` and `memory_remove`.
- **Editing an entry's scope or owner.** `PUT` takes `text` and nothing else. Moving a private note
  into the shared scope is a delete and an add, which is two audit rows and is what actually happened.
- **The event stream's reader identity.** Open question 9.
- **Anything about first-turn latency.** Section 4.16's last paragraph: the four minutes measured in
  the live test are the model's time to first token on a 22,000-token prompt. The kernel seeds the
  same files every turn and the prompt is the tenant's own document, so there is no kernel change to
  make. Prompt caching, a smaller persona and a different deployment are the levers, and the first
  belongs to the gateway.
- **A typing indicator on any surface but Slack.** `typing` is optional and the web surface does not
  implement it; a workspace shows its own spinner, because it made the request and is waiting for
  the stream.
- **Threading on a surface other than Slack.** `replyTo` is the neutral contract and every adapter
  already decides what to do with it; only Slack's reading of it changes.
- **Everything in 12b and 12c**: declared MCP and A2A plug-ins and the bridge, the `write.assign`
  gate, Jev and typed model access, `correlation` on runs, `GET /v1/events` and its webhook sink, the
  `execute` action class, delegation caps.
- **The 11a, 11b and 11c follow-ups**, every one of them, as section 25 lists them: the pooled-host
  drain gap, `auth.test` backoff, clock injection, `stop()` recall, the publishing polish list,
  amd64-only images, `gh release edit`. None is a seam the platform is waiting on.
