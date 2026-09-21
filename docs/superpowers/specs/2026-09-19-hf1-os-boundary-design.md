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
review and marked **(review ruling)**. The baseline is main at `4a1f969` (Plans 11a and 11b merged) plus
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
| 19 | Per-tenant model budgets | **`routing.gateway: { key: SecretRef }`**, optional, resolved through the secret source at tenant open and sent as the bearer for that tenant's model calls in place of `LITELLM_MASTER_KEY`. Route names are unchanged; absent, the process key is used, exactly as today. | The platform asked for the model name to carry the tenant (`<clientId>--chat`). The key is the cheaper half of the same thing: LiteLLM's virtual keys already carry `aliases`, a `models` allow-list and `max_budget`, so the tenant travels in the credential and the kernel keeps `model: <route>`. Registering deployments and minting keys is the platform's P2. |
| 20 | What the workspace reads | **`GET /v1/approvals` and `GET /v1/memory`** on the run API, cursor-paged, authenticated and tenant-resolved exactly as `/v1/usage`. | A dashboard and a memory page need a durable list. Today the only way to see a pending approval is the card stream of whichever surface it was posted to, which is not a list and is not queryable. |
| 21 | Who writes the store | **`@harness/config-postgres` stays unpublished**, and §6 states `client_documents`, `client_document_versions` and `client_secrets` as a **stable write contract** at the columns they have today. The platform's control plane writes them itself, in one transaction, and the host's watch follows `client_documents.version`. | The platform must neither copy kernel code nor depend on an unpublished package. A table contract is the smaller promise: it names columns rather than a function signature, and it is what the host already reads. |
| 22 | A rewritten version | A version string written a second time with **different** content is **refused** by the kernel's own writer, and is forbidden to the platform's by the §6 contract. | `writeClientDocument` upserts the live row and `onConflictDoNothing`s the history row, so rewriting a version silently keeps the old history and moves the live document — the one case where the history lies. The platform writes content-hash versions and will never hit it; the kernel refuses it anyway, because a store whose history can be wrong is a store nobody can audit. |
| 23 **(review ruling)** | A door that answers with a stream | **`SurfaceHttpResponse.body` becomes `string \| AsyncIterable<string>`**, and `SurfaceHttpRequest` gains `clientId` and `signal: AbortSignal`. The host writes the head, pipes each chunk with `res.write`, and ends the response when the iterable ends; it aborts the signal when the client disconnects. | The seam Plan 11b shipped is buffered in both directions — `send()` does one `writeHead` then `res.end(body ?? '')` — so an SSE stream is not implementable on it. An async iterable of strings is the smallest shape that fixes it: the adapter keeps every byte of its own framing, the host keeps the body cap, the refusal rule and the mount, and nothing in `harness/host/src` learns an event name. |

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
| `actionId` or `formId` the host does not know | `202`; the handlers ignore an unknown id, because a card this host did not post is not an error |
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
`mention(userId)` returns `@<displayName>` where the principal has one and `@<userId>` where it does not;
a display name is rendered into the runtime's rules block, so `PrincipalShape` applies as everywhere else.

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
- `surfaces/slack/src/index.ts` and `surfaces/slack/src/config.ts` — `slackConfig(deps.env, deps.secretValues ?? {})`,
  and each field becomes `secrets.botToken ?? requiredEnv('SLACK_BOT_TOKEN', …, env)`.

The conventional-name fallback survives, but **its expression does not**: it moves from inside
`requiredEnv`'s first argument to a `??` around the whole call, which is what keeps the literal
`SLACK_BOT_TOKEN` in the adapter's own source where the env-read scan can find it.

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
  routes: { … }
  defaults: { … }
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

Nothing else moves. `callModel` keeps `model: opts.route`, so the five route names are unchanged and the
`embed` route still goes to `POST /v1/embeddings`. `model_calls` rows keep their `client` column, so
budgets and evaluation records attribute per tenant whether or not the tenant has a key. The platform,
on release, registers the tenant's deployments (`<clientId>-chat`, …) and mints one virtual key with
`aliases`, a `models` allow-list and `max_budget`/`budget_duration`; that is P2 and is not kernel work.

Two sentences in `gatewayError` name the wrong thing once a tenant has its own key, and both are
rewritten in the same task. A 401 or 403 says "check `LITELLM_MASTER_KEY`", which for such a tenant is
not the credential that was rejected; it becomes a sentence naming neither — "model route `<route>` was
rejected by the gateway (HTTP `<status>`)". A budget refusal says "raise it in the client document's
routing section", which is right for a route's `daily_budget_usd` and wrong for a virtual key's
`max_budget`, which lives in LiteLLM; it becomes "model route `<route>` is over its budget". Both
messages reach `audit_log.error` and the agent, so neither should teach which credential a deployment
uses.

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

**One new table, one migration in Plan 11c**, by plain `drizzle-kit generate`. Nothing else in 11c is DDL.

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
    surface refusal, a run API response or a `RunEvent`; and a tenant's `{ ref }` resolves only rows whose
    `client_id` is that tenant's.
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
