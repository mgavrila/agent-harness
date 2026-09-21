# hf1 platform — P1: the workspace, the control plane and the catalogue (design)

**Date:** 2026-09-21
**Status:** designed in a brainstorm with the user; every decision is in section 2 for review; the work lands as one pull request against `main` of this repository
**Baseline:** an empty repository. Kernel: `agent-harness` `main` at `1f7ef57` (Plan 11a merged), Plan 11b executing (tag `v0.2.0` expected within a day), Plan 11c "platform seams" ruled by the kernel session on 2026-09-21 (tag `v0.3.0`, before Plan 12)
**Predecessors:** `agent-harness/docs/superpowers/specs/2026-09-19-hf1-os-boundary-design.md` (the boundary: §2 decisions 1, 1b, 2, 3, 4, 5, 6, 8, 10, 12, 13, 15, 16; §3.2 the two repositories; §3.5 blueprint → overlay → host; §4.1 the client document; §4.5 usage; §10 the sub-project table; §11 what the platform owns), `2026-09-17-kernel-design.md` (what the kernel is)
**Inputs:** the deck *hf1 Platform Architecture* (27 slides, target state; slides 3, 5, 6, 9, 16, 19, 20, 26 in particular); the kernel's Plan 11a pull request (#13) and Plan 11b plan; PR #5 of the kernel (AMA, never merged) and the deleted `clients/demo-practice` as source material for the two blueprints; `~/Downloads/hf1/kernel-followups-from-platform.md` (the follow-ups this design raised and the kernel session's rulings)

## 1. Goal

The kernel runs any tenant and knows none of them. Everything that names a customer lives here.
The user's product goal, stated in the brainstorm: **one web workspace from which everything is
configured** — the agent, its people, policy, knowledge, playbooks, connections and releases — with
Slack as one optional connection among others, never a requirement. That is the deck's hf1 OS
workspace (Modeler + forms, Catalog, Control plane, Dashboards) with the Catalog and the Control
plane built first.

P1 as the boundary spec sized it (tenants directory, blueprints, an onboarding command, a Compose
profile per tenant) would have been a first onboarding path that the workspace then replaces. This
repository forbids dual paths, so P1 is re-scoped to the vertical slice the workspace needs and
nothing that will be thrown away:

- **the catalogue** (hf1 Agents): two blueprints, versioned, with lock sets and changelogs;
- **the control plane** (hf1 OS): Google sign-in for any Google account, organisations and roles,
  agents created from blueprints, drafts, releases into the kernel's document store, secrets,
  knowledge, connections, and proxies to the kernel's run API and web surface;
- **the workspace** (hf1 OS): a Next.js application that is a client of the control plane;
- **the platform stack** on one hf1-operated server: the kernel's pooled host reading the document
  store, so a released agent is live with no container started and no command run.

**Exit criterion** (replaces the boundary spec's row P1): *any person signs in with a Google
account, creates an organisation, creates the credentialing assistant from its blueprint, edits
what the blueprint leaves open, releases it, and talks to it in the workspace — in under an hour,
with no engineer and no deploy step. Connecting Slack is optional and takes the same path.*
Measured against kernel **v0.3.0**, which carries the two seams this design needs (§4.3).

## 2. Decisions taken (for review)

**Amendment 2026-09-21: one monorepo.** The user decided, after this spec was written, that the
kernel (`agent-harness`) and the platform built on it (catalogue, control plane, workspace) live
in one repository, hosted by `agent-harness`, rather than two repositories joined by a version
pin. Task T ("transplant") moved `catalog/` and `control-plane/` into a worktree of
`agent-harness` as one pull request against its `main`, replacing every kernel dependency's
`link:` with `workspace:*` and re-cutting decisions 1, 17 and 18 below: decision 1's "one pull
request against `main`" now names the kernel's `main`, not a new empty repository; decision 17's
`kernel.lock` and `pnpm kernel:check` are gone — a kernel contract package is a workspace sibling,
resolved by pnpm at install time, and the four one-way import rules in the kernel's
`.dependency-cruiser.cjs` (kernel-never-imports-the-platform, and the catalogue, control plane and
workspace each restricted to the kernel's five published contracts or the layer below them) are
what decision 17's version pin used to buy; decision 18's Compose stack still builds the
control-plane and workspace images from "this repository" — it is now the monorepo root, and the
kernel's own images build from the same tag. §3.1 below shows the resulting tree.

| #  | Question | Decision | Why |
| -- | -------- | -------- | --- |
| 1  | What P1 delivers | **The vertical slice: catalogue + control plane + document store + pooled host + workspace with the onboarding, editing, release and chat flows.** The boundary spec's P1 (CLI, tenants directory, Compose profile per tenant) and P2 (control plane, store, pooled host) merge; dedicated hosts drop out of P1. | The user's goal is "everything from the UI". A CLI-and-bundle path first would be a dual path by construction (kernel decision 2b applies here too). |
| 2  | Who signs in | **Any Google account**, through OpenID Connect. A first sign-in creates a user with no organisation; the person creates one or accepts an invitation. hf1 staff are a `superadmin` flag from an e-mail allowlist in the environment. | The user's instruction on 2026-09-21. Self-serve from the first day; identity is not a password store the platform has to run. |
| 3  | The platform's own top-level entity | **Organisations** own agents, members (owner, admin, member) and invitations. The kernel's principals stay a per-tenant concept inside a document; the platform maps its users onto them (decision 12). | Any Google account can sign in, so the platform needs its own tenancy above the kernel's. |
| 4  | Where tenants run | **One pooled kernel host** on one hf1-operated server (Compose), `HARNESS_CONFIG_SOURCE=postgres`, `HARNESS_SECRET_SOURCE=postgres`. A release is a row; the host's watch reopens the tenant. No dedicated host, no per-tenant container, no Docker socket anywhere. | "No deploy step" is only true when adding a tenant touches no process. Kubernetes and dedicated hosts are P3 (Weave-shaped). |
| 5  | The always-on surface | **The kernel's web surface** (Plan 11c, `surfaces.web: { token: SecretRef }`, primary-capable) is on for every agent; the workspace's Chat and Inbox pages are its client through the control plane. **Slack is an optional connection.** | A tenant may have no Slack; the kernel's `http` surface cannot carry approval cards and `memory` posts nowhere. Filed and accepted as follow-up 1. |
| 6  | Secrets | **The kernel's secret store** (Plan 11c): the control plane writes `client_secrets` under the kernel's AES-GCM envelope with the shared `HARNESS_ENCRYPTION_KEY`; documents name `{ ref }` only. No `{ env }` anywhere in platform code. | `{ env }` on a pooled host means a restart per onboarding, which drains every tenant. Filed and accepted as follow-up 2. |
| 7  | The document store | **The control plane writes `client_documents`, `client_document_versions` and `client_secrets` itself**, against the stable write contract the kernel documents in its boundary spec §6 (columns at `1f7ef57`, ruled 2026-09-21). `@harness/config-postgres` stays unpublished. | The writer lives in an unpublished package that drags the whole kernel schema; three tables as a contract is smaller than a package. |
| 8  | Blueprints and locks | A blueprint directory is what the kernel's files source reads (`blueprint.yaml` with `document`, `lockset`, `version`; `persona.md`, `skills/`, `knowledge/` seeds) plus `catalog.yaml` (platform metadata and the overlay inputs the onboarding form asks for) and `CHANGELOG.md`. Semantic versions; an agent **pins** a blueprint version; upgrading is a release. `internal-team-assistant` locks `/routing` only; `credentialing-assistant` locks `/persona`, `/policy` and `/routing`. | Kernel decision 3 (a finished and a customisable agent are one object with different locks). The credentialing persona carries the hard rules and is written tenant-neutral, so locking it is safe and renaming happens through `displayName`. |
| 9  | Routing in P1 | **`/routing` is locked in every blueprint to hf1's platform routing table**, rendered once into the one LiteLLM; the Models tab is read-only. Per-tenant routing, virtual keys and budgets are P2, on the seam the kernel ruled for 11c (`routing.gateway.key`). | The kernel calls the gateway by route name and one LiteLLM maps each route to one model, so a pooled host cannot route per tenant today (follow-up 7). |
| 10 | How a draft becomes an overlay | The workspace **edits the resolved document**; the control plane derives the overlay as the RFC 6902 diff (add, replace, remove) against the pinned blueprint document, refuses any operation on a locked pointer, then calls the kernel's `resolve` and `parseClientDocument`. The patch is what is stored and released. | People edit a document, not a patch. The kernel's lock rule is enforced twice (here for the message, in the kernel for the guarantee) and the kernel's is the one that counts. |
| 11 | Versions | A release's version is the **first sixteen hex characters of SHA-256 of the canonical JSON** of the resolved document, the rule the kernel's files source uses. The kernel refuses a same-version-different-content write from 11c on; a content hash never hits it. | Content-addressed: an edit that changes nothing is not a release; two hosts agree on what they serve. |
| 12 | Platform users → tenant principals | On creation the creating user becomes the agent's first admin principal (`u-<slug>`, `surfaces.web: <user id>`), and the document sets `identity.defaults.web: member`, so every member of the organisation can chat as a member. The People tab edits principals; the identity plug-in stays `static` unless the blueprint says `slack-groups`. | The kernel needs principals; the platform knows the people. Defaults keep an organisation of thirty from being thirty lines. |
| 13 | Knowledge | Uploads are files under `/srv/knowledge/<clientId>/` on a volume the host mounts read-only; the document says `knowledge: { source: 'dir', path: '/srv/knowledge/<clientId>' }`; the blueprint's `knowledge/` seeds are copied there at the first release; "Sync now" opens a run over `POST /v1/runs` as the agent's platform service principal asking for the kernel's `knowledge-sync` skill, beside the blueprint's scheduled playbook. | No kernel change: the kernel already reads a directory and already has a sync skill. |
| 14 | Slack connection | The control plane **generates the app manifest** (scopes, event subscriptions, the tenant's request URL `https://<platform>/tenants/<clientId>/slack/events`); the client's Slack admin creates the app from it and installs it; the person pastes the bot token and signing secret into the Connections tab, which stores them in `client_secrets` and releases. One app per tenant. | Five minutes, no Slack API tokens held by the platform, and the client's Slack admin must consent to the install anyway. A shared multi-workspace app needs P2's ingress. |
| 15 | Frontend | **Next.js (App Router)** in `apps/workspace`, server components reading the control plane with the session cookie, client islands only for editors, chat and inbox. It imports one thing from the workspace: the control plane's typed client entry. The modeler and forms (P5) will be client-only islands in the same shell. | The user asked for SSR; the deck's workspace is an authenticated app with server-side reads. The import rule keeps `gateway ◄ os ◄ agents ◄ platform` true for the UI too. |
| 16 | Control-plane server | **Hono** on Node with zod-validated routes, drizzle 0.45 with plain `drizzle-kit generate`, `openid-client` for Google, signed httpOnly session cookie, one hostname behind Caddy. | Small, typed, no framework opinion about the domain; the same tooling rules as the kernel. |
| 17 | Kernel pins | `kernel.lock` names the kernel tag and commit; `pnpm kernel:check` asserts the linked or installed packages match. Links to `../agent-harness/harness/<pkg>` until `v0.2.0`; release tarballs and `ghcr.io/mgavrila/agent-harness-host:<tag>` after. **Only the v0.3.0 contract is coded**; the tasks that need it sit behind an explicit checkpoint in the plan. | Boundary spec decision 10 (the platform pins versions). Coding a `{ env }` or memory-surface fallback for the interim would be the dual path this repository forbids. |
| 18 | Deployment in P1 | One Compose file: `postgres` (two databases), `litellm`, `files`, `host` (kernel image by tag, pooled), `control-plane`, `workspace`, `caddy` (automatic TLS on `PLATFORM_DOMAIN`; `/tenants/*` → host, `/api/*` → control plane, else → workspace). The kernel image is used unchanged. | Boundary spec §7, first bullet, adapted to the pooled shape. Caddy is the smallest thing that gives Slack a public HTTPS URL; the real ingress is P2. |
| 19 | What is deliberately not built | Dedicated hosts, Kubernetes, dashboards beyond usage, the memory page, modeler and forms, billing, lifecycle workers, the process engine, Teams and Entra, per-tenant routing and keys, pausing an agent, a shared Slack app. Each is in §11 with its sub-project. | P1 is the slice the exit criterion needs. |

## 3. Architecture

### 3.1 The repository

Per the amendment above, this is a tree inside `agent-harness`, beside `harness/`, `packs/`,
`surfaces/`, `identities/`, `runtimes/`, `evals/` and `scripts/` — not a separate repository:

```
agent-harness/
  harness/  packs/  surfaces/  identities/  runtimes/  evals/  scripts/    the kernel (unchanged)
  catalog/                       hf1 Agents — the catalogue          (@hf1/catalog)
    blueprints/<name>/           blueprint.yaml, catalog.yaml, persona.md, skills/, knowledge/, CHANGELOG.md
    src/                         load + validate blueprints, JSON Schema from the kernel's zod shapes,
                                 lock-set and input helpers
  control-plane/                 hf1 OS control plane                (@hf1/control-plane)
    src/shared/                  pure helpers
    src/domain/                  users, organisations, catalog, agents, releases, secrets, knowledge,
                                 connections, kernel (the document-store writer, the run API and
                                 web-surface clients)
    src/app/                     the Hono server, routes, OIDC, the composition root, migrations entry
    drizzle/                     generated migrations for hf1_platform
  apps/workspace/                hf1 OS workspace — Next.js          (@hf1/workspace)
  deploy/compose/                docker-compose.yml, Caddyfile, postgres/init.sql, litellm config,
                                 .env.example
  docs/superpowers/specs/        this spec (transplanted); plans in ../plans
```

`catalog` and `control-plane` are `workspace:*` dependents of the kernel's published contract
packages (`pnpm-workspace.yaml`'s `packages` list), not `link:` targets pinned by a `kernel.lock`
this repository no longer has.

Dependencies point one way, enforced by dependency-cruiser at error severity from the first
commit, with the kernel's layer rules inside each package (`shared → domain → app`, only `index.ts`
and declared subpath exports reachable from outside):

```
gateway ◄── os ◄── agents ◄── platform

@hf1/catalog        imports @harness/config-api, identity-api, pack-api, surface-api, shared only
@hf1/control-plane  imports @hf1/catalog, the same kernel contracts, drizzle, hono, openid-client
@hf1/workspace      imports @hf1/control-plane/client only (types + the hc factory), nothing else
                    from this workspace; never a kernel package
```

Conventions, the kernel's: Node ≥ 22, pnpm 11.4.0, TypeScript 7 per package with `typescript@6.0.3`
root-only for typescript-eslint, ESM, zod v4 (`import * as z from 'zod/v4'`), vitest 5, drizzle-orm
0.45 with plain `drizzle-kit generate`, ESLint 9 + Prettier + dependency-cruiser, four gates and the
suite green at the end of every task. Conventional commits, imperative, no AI trailer; repo-local
`user.email andrei.gavrila94@gmail.com`, SSH-signed.

### 3.2 What runs

```
                 https://<PLATFORM_DOMAIN>
                          │ caddy (TLS)
        ┌─────────────────┼──────────────────────┐
        │ /                │ /api/*               │ /tenants/*
        ▼                  ▼                      ▼
   workspace ────HTTP───▶ control-plane ──run API + web surface──▶ host (kernel image, pooled)
   (Next.js)              │  hf1_platform DB       ▲                  │ HARNESS_CONFIG_SOURCE=postgres
                          │  writes the kernel's   │ Slack events      │ HARNESS_SECRET_SOURCE=postgres
                          │  client_documents,     │ arrive here       │
                          │  client_document_      │                   ▼
                          │  versions,             │            postgres (harness DB)   litellm   files
                          │  client_secrets ───────┴──────────────▶ read at tenant open
                          └── /srv/knowledge/<clientId>/ ──(volume, ro)──▶ host
```

Nothing per tenant lives in any process's environment. The host learns about a tenant from the
rows and the volume; the platform learns what the host is doing from `GET /v1/status`,
`GET /v1/usage` and the web surface's stream, always with `HARNESS_HOST_TOKEN` as bearer and
`x-harness-client` naming the tenant.

### 3.3 One agent, from blueprint to a running tenant

1. A person signs in with Google. The control plane finds or creates the user; the person creates
   an organisation (slug, name) and is its owner, or accepts an invitation.
2. **New agent**: the person picks a blueprint, gives it a name, and answers the blueprint's
   `inputs` (the unlocked pointers the onboarding form asks for, e.g. the playbook timezone). The
   control plane allocates `clientId = <org-slug>-<agent-slug>` (matching the kernel's
   `CLIENT_ID_PATTERN`, ≤ 64 characters), builds the initial draft = blueprint document + inputs +
   the platform's own additions (decision 12: the creator as admin principal, `defaults.web`,
   the web surface with a fresh token ref, the `http` surface with the platform service principal,
   the knowledge path), and stores it.
3. **Edit**: the tabs edit the draft. Every section is validated with that section's zod shape
   from `@harness/config-api`; a locked pointer renders read-only with the reason. Saving a tab
   stores the draft; nothing reaches the kernel.
4. **Release**: the control plane diffs draft against the pinned blueprint document (RFC 6902:
   add, replace, remove), refuses an operation on a locked pointer, calls the kernel's
   `resolve(blueprint, overlay)` and `parseClientDocument`, computes the version (decision 11),
   writes `agent_releases` (pending), then in one transaction on the kernel database writes the
   agent's secrets and the two document tables, then marks the release confirmed. The host's watch
   sees `client_documents.version` change and drains, quiesces and reopens the tenant.
5. **Live**: the agent page polls `GET /v1/status` for the tenant and shows the version the host
   serves. Chat and Inbox talk to the web surface through the control plane. Usage comes from
   `GET /v1/usage`.
6. **Connections**: the web surface is always on. Slack: download the manifest, create the app,
   paste two tokens, release. The document now names `surfaces.slack` with `{ ref }` secrets and
   the same tenant answers in both places.
7. **Upgrade**: when the catalogue ships a newer blueprint version, the Releases tab offers it; a
   release with the new pin re-validates the overlay and refuses if the new lock set covers an
   overlay operation, naming the pointer.

### 3.4 Blueprint → overlay → resolved document (what is where)

```
catalog/blueprints/<name>/            hf1_platform.agents                    harness.client_documents
  blueprint.yaml  (document, lockset, ──▶ blueprint_name, blueprint_version     document = resolved
                   version)               draft (resolved doc, unlocked edits)  version = sha256[:16]
  catalog.yaml    (inputs, surfaces,      overlay = rfc6902(blueprint, draft)   blueprint_ref = name@version
                   kernel, description)   client_id                             overlay = the patch
  persona.md, skills/, knowledge/     hf1_platform.agent_releases            harness.client_document_versions
  CHANGELOG.md                            one row per release, pending → confirmed   one row per version
                                      hf1_platform.secrets (names only)      harness.client_secrets
                                                                                   ciphertext, kernel envelope
```

The platform never stores a resolved document as the truth: the kernel's tables are the truth of
what is live, `agents.draft` is the truth of what is being edited, and a release is the join.

## 4. Contracts consumed (exact, as shipped or as ruled)

### 4.1 From `@harness/config-api` (v0.2.0)

`ClientDocumentShape`, `parseClientDocument`, `migrate`, `CLIENT_DOCUMENT_VERSION`,
`CLIENT_ID_PATTERN`, `SURFACE_ORDER`, `resolve(blueprint, overlay)` (throws `ConfigError` on a
locked pointer or a prototype segment), `Blueprint`, `Overlay`, `PatchOp`, `SecretRefShape`,
`tenantKeysOf`, `surfaceSecretsOf`. The section shapes are reached as `ClientDocumentShape.shape.<section>`
for per-tab validation; the JSON Schema for the editors is `z.toJSONSchema(ClientDocumentShape)`
at build time, never hand-written. `identityPlugin.kind` is `static` or `slack-groups`
(`@harness/identity-api` for `IdentityFileShape`). Playbook entries as `PlaybooksFileShape`.

### 4.2 From the kernel's run API (v0.2.0)

`GET /v1/status`, `GET /v1/usage?from&to`, `POST /v1/runs`, `POST /v1/runs/:id/cancel`,
`GET /v1/threads/:id` — bearer `HARNESS_HOST_TOKEN`, tenant by `x-harness-client` on a pooled host.
A run is opened as `(surface: 'http', userId)` where `userId` is the `http` id of a principal the
document declares; the platform's service principal is `svc-platform` with `http: platform`.
Every tenant's surface handler is mounted at `https://<host>/tenants/<clientId>/<path>`
(Slack: `slack/events`, one URL for events and interactivity).

### 4.3 From Plan 11c (v0.3.0, ruled 2026-09-21; the platform codes against these and nothing else)

- **Web surface**: `surfaces.web: { token: SecretRef }` in `SurfacesShape`, ordered before `http`
  so it can be primary; mounted at `/tenants/<clientId>/web/...`: POST message
  (`userId`, `conversation`, `text`, attachment paths) runs a turn; SSE per conversation carries
  reply deltas, cards, card updates and notices as JSON; POST action (`actionId`, `value`,
  `messageRef`) and form submit; every request bears the tenant's token; capabilities streaming,
  update, forms, privateReply true, inlineConfirm false.
- **Secret source**: `HARNESS_SECRET_SOURCE=env|postgres` (no default); `client_secrets
  (client_id text NOT NULL, name text NOT NULL, ciphertext bytea NOT NULL, updated_at timestamptz
  NOT NULL DEFAULT now(), PRIMARY KEY (client_id, name))`; `name` is what a document's
  `{ ref: '<name>' }` names, matched exactly, resolved at tenant open. **Envelope** (the kernel's
  `harness/db/src/shared/crypto.ts`, ruled 2026-09-21): AES-256-GCM; key = `HARNESS_ENCRYPTION_KEY`
  base64-decoded, exactly 32 bytes, used raw (no KDF, no salt); IV 12 random bytes per
  encryption; tag 16 bytes; blob = `iv(12) || tag(16) || ciphertext(n)` (tag before ciphertext);
  no AAD; plaintext UTF-8; the column holds the raw blob bytes, never base64 text. Test vector
  (fixed IV for the test only): key `BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc=`, IV
  `030303030303030303030303`, plaintext `xoxb-test-secret`, blob
  `03030303030303030303030338da626a160e623fe0c27fbca31a81945d91db61775c3b310e6d303988259a78`.
  The platform's compatibility test decrypts that blob to the plaintext and encrypts the
  plaintext with that key and IV to that blob, byte for byte.
- **Document-store write contract** (columns at `1f7ef57`): `client_documents (client_id text PK,
  schema_version integer NOT NULL, document jsonb NOT NULL, version text NOT NULL, blueprint_ref
  text NULL, overlay jsonb NULL, updated_at timestamptz NOT NULL DEFAULT now())`;
  `client_document_versions (id uuid PK DEFAULT gen_random_uuid(), client_id text NOT NULL,
  version text NOT NULL, document jsonb NOT NULL, created_by text NULL, created_at timestamptz NOT
  NULL DEFAULT now(), UNIQUE (client_id, version))`. Both written in one transaction; the host's
  watch follows `client_documents.version`; a same-version-different-content write is refused.
- **Later reads** (accepted for 11c, consumed by P4, not P1): `GET /v1/approvals?status=`,
  `GET /v1/memory`.
- **Ruled for P2, not consumed in P1**: `routing.gateway: { key: SecretRef }` — the per-tenant
  LiteLLM virtual key.

### 4.4 The control plane's own API (what the workspace consumes)

All under `/api/v1`, JSON, session cookie; every response body validated by a zod shape the
client entry exports. Errors are `{ error: { code, message, pointer? } }`; a kernel `ConfigError`
is passed through with its text and the pointer it names. Cross-organisation access is a 404.

| Area | Routes |
| --- | --- |
| auth | `GET /auth/login`, `GET /auth/callback`, `POST /auth/logout`, `GET /me` |
| organisations | `POST /orgs`, `GET /orgs`, `GET /orgs/:org`, `GET/POST/DELETE /orgs/:org/members`, `POST /orgs/:org/invitations`, `POST /invitations/:token/accept` |
| blueprints | `GET /blueprints`, `GET /blueprints/:name` (document, lockset, inputs, schema, changelog, versions) |
| agents | `POST /orgs/:org/agents`, `GET /orgs/:org/agents`, `GET /orgs/:org/agents/:agent`, `PUT .../draft` (one section or the whole document), `POST .../validate`, `POST .../release`, `GET .../releases`, `POST .../releases/:id/rollback`, `POST .../upgrade` (new blueprint pin), `GET .../status`, `GET .../usage` |
| knowledge | `GET/POST/DELETE .../knowledge/files`, `POST .../knowledge/sync` |
| connections | `GET .../connections`, `GET .../connections/slack/manifest`, `PUT .../connections/slack` (tokens), `DELETE .../connections/slack` |
| chat | `GET .../chat/conversations`, `POST .../chat/messages`, `GET .../chat/stream` (SSE), `POST .../chat/actions`, `POST .../chat/forms` |
| admin | `GET /admin/orgs`, `GET /admin/agents` (superadmin only) |

Roles: a **member** reads the agent and chats; an **admin** edits drafts, releases, manages
knowledge and connections; an **owner** also manages members and invitations and can delete the
agent. A superadmin sees everything and edits nothing on behalf of an organisation without being a
member (read-only, audited).

## 5. Components

### 5.1 `@hf1/catalog`

- `loadCatalog(dir)`: reads every `catalog/blueprints/<name>/`, parses `blueprint.yaml` with the
  same `!include` semantics the kernel's files source uses (implemented here over the `yaml`
  package: `!include <relative path>` confined to the blueprint's directory), parses `catalog.yaml`,
  reads `CHANGELOG.md`, and validates: `version` is semver and equals the changelog's top entry;
  every `lockset` pointer and every `inputs[].pointer` exists in `document`; the two sets are
  disjoint; the blueprint resolves with an empty overlay plus each input's example through the
  kernel's `resolve` and passes `parseClientDocument` once the platform additions are applied.
- `catalog.yaml`: `displayName`, `description`, `kernel` (the kernel version the blueprint was
  validated on), `surfaces` (which connections it supports: `web` always, `slack` optional),
  `inputs: [{ pointer, label, hint, example }]`, `pack` (`null` or a package name the kernel image
  ships).
- `documentSchema()`: `z.toJSONSchema(ClientDocumentShape)`, with the section shapes reachable by
  name, for the editors and the API's OpenAPI description.
- `platformAdditions(document, ctx)`: the pure function that adds what the platform owns
  (decision 12: principals, defaults, web + http surfaces, knowledge path) so a blueprint never
  has to know a user id.
- The two blueprints:
  - **`internal-team-assistant`** (from PR #5): the AMA persona and voice as the default persona,
    followed by the house rules every agent carries; no pack; `knowledge-sync` playbook at 07:00
    in the input timezone; `policy` the kernel matrix with a member's shared writes parked for an
    admin; `lockset: ['/routing']`; inputs: timezone. The name AMA lives in the persona text and the
    default display name; a tenant renames freely.
  - **`credentialing-assistant`** (from `demo-practice` and `packs/healthcare`): the persona
    written for "this practice" with the ten hard rules and the silence doctrine;
    `packs: ['@harness/pack-healthcare']`; playbooks `credentialing-expirations` and
    `knowledge-sync`; `lockset: ['/persona', '/policy', '/routing']`; inputs: timezone. Knowledge
    seeds: the two `demo-practice` documents rewritten as templates.
  - Both: `identityPlugin: { kind: 'static' }`, `runtime: 'deepagents'`, routing = hf1's platform
    table (`gemini/gemini-3-flash-preview` with `groq/openai/gpt-oss-120b` fallbacks;
    `gemini/gemini-embedding-001` for `embed`), `schemaVersion: 1`, `skills` as the source
    material carries them.
  - `alliance-assistant` waits for Weave (not in P1).

### 5.2 `@hf1/control-plane`

Domains, one folder each, `types.ts` first, then `repository.ts`, then the service:

- **users / sessions**: Google OIDC (authorization code + PKCE, `openid-client`), `users`
  keyed by the Google `sub`; sessions in a table, cookie `hf1_session` (httpOnly, Secure,
  SameSite=Lax, signed with `SESSION_SECRET`); `superadmin` from `PLATFORM_SUPERADMINS` (e-mails).
- **organisations**: slug (`[a-z0-9-]`, 2–32), name, memberships with a role, invitations by
  e-mail with a single-use token, accepted on the invitee's next sign-in.
- **catalog**: the loaded catalogue, served read-only.
- **agents**: `create` (allocates the client id, builds the draft), `saveDraft` (a whole document
  or one section, validated with the section shape and checked against the lock set so the UI
  gets the pointer), `validate` (diff + kernel `resolve`, returns the resolved document or the
  error), `release` (§3.3 step 4), `rollback`, `upgrade`, `status` and `usage` (proxied).
- **secrets**: `put(agent, name, value)` writes the kernel envelope into `client_secrets`
  and a name-only row into `secrets`; `names(agent)`; never a `get` that returns plaintext.
- **knowledge**: file store under `KNOWLEDGE_DIR/<clientId>/` with realpath confinement,
  size and count limits, seeds copied at the first release, `sync` opening a run.
- **connections**: `web` (token minted at create, rotated on demand), `slack` (manifest
  rendering; tokens to secrets; the document's `surfaces.slack` section written from the pasted
  team id).
- **kernel**: the document-store writer (drizzle table definitions of the three contract tables,
  in a schema file that cites §4.3 line by line), the run API client, the web-surface client
  (server-side SSE fan-out to the browser).
- **audit**: every mutating route records user, organisation, agent, action and a summary; a
  secret is named, never quoted.

### 5.3 `@hf1/workspace`

Next.js App Router, TypeScript, Tailwind, an owned component set (no UI kit). Pages in §3.3 and:

```
/login                          /orgs/new
/o/<org>                        agents list           /o/<org>/settings   members, invitations
/o/<org>/agents/new             blueprint → inputs
/o/<org>/agents/<agent>         overview + tabs: persona, people, policy, models (read-only),
                                playbooks, skills, knowledge, connections, releases, chat, inbox, usage
/admin                          superadmin: organisations, agents
```

Server components fetch with the cookie forwarded; editors, chat and inbox are client islands.
Each editor validates with its section's zod shape and renders locked pointers read-only with the
lock's reason. The Releases tab shows a diff between releases (document-level, pointer by
pointer). Chat streams over SSE from the control plane; Inbox renders card JSON and posts actions.

## 6. Data model (`hf1_platform`, drizzle, plain `drizzle-kit generate`)

| Table | Columns (abridged) |
| --- | --- |
| `users` | `id uuid PK`, `google_sub text UNIQUE`, `email text`, `name text`, `superadmin boolean`, `created_at` |
| `sessions` | `id text PK`, `user_id`, `expires_at`, `created_at` |
| `organisations` | `id uuid PK`, `slug text UNIQUE`, `name text`, `created_by`, `created_at` |
| `memberships` | `organisation_id`, `user_id`, `role ('owner','admin','member')`, PK (org, user) |
| `invitations` | `id uuid PK`, `organisation_id`, `email`, `role`, `token text UNIQUE`, `expires_at`, `accepted_at NULL` |
| `agents` | `id uuid PK`, `organisation_id`, `slug`, `client_id text UNIQUE`, `display_name`, `blueprint_name`, `blueprint_version`, `draft jsonb`, `created_by`, `created_at`, `updated_at`, UNIQUE (org, slug) |
| `agent_releases` | `id uuid PK`, `agent_id`, `version text`, `blueprint_version`, `kernel_version`, `overlay jsonb`, `document_hash`, `status ('pending','confirmed','failed')`, `error text NULL`, `released_by`, `created_at`, `confirmed_at NULL`, UNIQUE (agent, version) |
| `secrets` | `agent_id`, `name`, `updated_by`, `updated_at`, PK (agent, name) — names only; values live in the kernel's `client_secrets` |
| `knowledge_files` | `id uuid PK`, `agent_id`, `filename`, `bytes`, `sha256`, `uploaded_by`, `uploaded_at`, UNIQUE (agent, filename) |
| `audit` | `id uuid PK`, `user_id`, `organisation_id NULL`, `agent_id NULL`, `action`, `summary`, `at` |

Kernel data (runs, threads, approvals, memory, usage) is never copied here.

## 7. Deployment (`deploy/compose`)

- `docker-compose.yml`, project name `hf1-platform`: `postgres` (`pgvector/pgvector:0.8.1-pg16`,
  `init.sql` creates `harness`, `harness_test` and `hf1_platform`), `litellm` (config rendered from
  the platform routing table, provider keys from `.env`), `files` (kernel image), `host` (kernel
  image, `HARNESS_CLIENT` empty, `HARNESS_CONFIG_SOURCE=postgres`, `HARNESS_SECRET_SOURCE=postgres`,
  `HARNESS_HOST_TOKEN`, `HARNESS_STORAGE_DIR` volume, `KNOWLEDGE_DIR` bind-mounted read-only at
  `/srv/knowledge`, the kernel's limit rule `HARNESS_RUN_MAX_MODEL_CALLS` <
  `HARNESS_GATEWAY_MAX_CALLS_PER_RUN`), `control-plane` (`DATABASE_URL`, `KERNEL_DATABASE_URL`,
  `HOST_URL=http://host:8788`, `HARNESS_HOST_TOKEN`, `HARNESS_ENCRYPTION_KEY` shared with the host,
  `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `SESSION_SECRET`, `PLATFORM_DOMAIN`,
  `PLATFORM_SUPERADMINS`, `KNOWLEDGE_DIR` read-write), `workspace` (`CONTROL_PLANE_URL` internal),
  `caddy` (`PLATFORM_DOMAIN`, automatic TLS, routes of decision 18). No service mounts the Docker
  socket. Images for control-plane and workspace are built from this repository by CI and pulled
  by tag (`HF1_IMAGE_TAG`); the kernel images by `HARNESS_IMAGE_TAG`.
- `.env.example` lists every variable with a sentence each; a missing required one fails the
  service at start, never a default that serves nobody.
- `pnpm platform:up | down | logs` wrap Compose with `--env-file .env`.

## 8. Platform invariants (each has a test; numbered P-1.., beside the kernel's 1–19)

- **P-1** A member of an organisation reaches only that organisation's agents on every route; a
  request for another organisation's agent is a 404 that does not distinguish "no such agent".
- **P-2** No operation on a locked pointer reaches the kernel: `saveDraft`, `validate` and
  `release` each refuse it, naming the pointer, before `resolve` is called.
- **P-3** A secret value leaves the control plane only as the kernel's ciphertext: no API
  response, log line or audit row carries one; `secrets` holds names only.
- **P-4** A knowledge path is confined to the tenant's directory with realpath; a filename with a
  separator, `..` or a symlink target outside is refused.
- **P-5** A tenant's web token, `HARNESS_HOST_TOKEN` and `HARNESS_ENCRYPTION_KEY` never reach a
  browser: the chat proxy adds the bearer server-side, and the workspace has no environment
  variable holding any of them.
- **P-6** A release is confirmed only after the kernel rows exist; a failed kernel write leaves
  the release `failed` with the error and the live rows untouched.
- **P-7** A session cookie is httpOnly, Secure and signed; the OIDC callback checks `state` and
  the PKCE verifier; a Google `sub` maps to exactly one user.

## 9. Testing

- Gates: `pnpm typecheck`, `pnpm lint` (0 errors), `pnpm arch` (0 violations), `pnpm format:check`;
  `pnpm test` runs lint then every package's vitest suite. Postgres for tests via
  `TEST_DATABASE_URL` against the Compose `postgres`, as the kernel does; one schema reset per suite.
- **catalog**: §5.1's validations as tests for both blueprints; the JSON Schema is a snapshot;
  `platformAdditions` produces a document `parseClientDocument` accepts for every blueprint.
- **control-plane**: the authorization matrix (owner / admin / member / non-member / superadmin ×
  every route); OIDC against a fake issuer (local, in-process); draft → overlay produces only
  add/replace/remove and refuses a locked pointer with the kernel's own error text; release writes
  both kernel tables in one transaction and confirms, a forced kernel failure leaves `failed` and
  a retry confirms; version equals the content hash and an unchanged draft is "nothing to release";
  the envelope round-trips against the kernel's test vector; the manifest is a snapshot; the chat
  proxy forwards no token; knowledge confinement; every invariant P-1..P-7.
- **workspace**: one Playwright flow in CI against the fake issuer and a running control plane:
  sign in, create an organisation, create an agent from `internal-team-assistant`, edit the
  persona, release, see "live at <version>".
- **deploy**: a CI job boots `postgres`, `host` (pinned kernel image) and `control-plane`, creates
  an organisation and an agent through the API, releases, and asserts `GET /v1/status` reports
  the tenant at that version. Before `v0.3.0` exists this job runs against `v0.2.0` with the
  connection tasks not yet merged, and is the gate that flips the exit criterion when the pin moves.
- The kernel-vocabulary rule the kernel enforces on itself is mirrored here in reverse: a test
  asserts no file under `catalog/` or `control-plane/src/domain` names a tenant, an organisation
  or a person; tenant names appear only in data written at runtime.

## 10. Sequencing inside P1 and the checkpoint

One plan, one pull request, one implementer at a time in one worktree. Order: repository
scaffold and gates → `kernel.lock` and links → catalogue and the two blueprints → control-plane
schema, auth, organisations → agents, drafts, overlay diff, releases into the document store →
knowledge → workspace shell, sign-in, organisations, agent creation and editors → releases tab →
deployment and the Compose smoke job → **checkpoint "kernel 11c linkable"** → secrets and the
envelope → web connection, chat and inbox → Slack connection → Playwright flow → simplifier pass →
final review → merge. The checkpoint waits for the kernel's 11c branch; everything before it is
complete and green on v0.2.0.

## 11. Out of P1 (and where it goes)

Dedicated hosts and per-tenant Compose profiles; Helm, sandboxes, pause and resume (P3);
dashboards beyond the usage tab, the memory page, the approvals list (P4, on 11c's reads); the
modeler, forms and BPMN (P5); billing, plans as lock sets (P6); lifecycle workers (P7); the
process engine (P8); Teams and Entra (own spec); per-tenant routing, virtual keys and budgets,
the ingress proper, a shared multi-workspace Slack app (P2); the Alliance blueprint (Weave).

## 12. Constraints inherited (recorded so the plan writer does not rediscover them)

1. The kernel's files source confines includes and the knowledge path with realpath and requires
   the document id to equal its directory; the postgres source requires an absolute knowledge
   path. The catalogue's own `!include` reader confines the same way.
2. `SurfacesShape` is strict and `SURFACE_ORDER` fixed; `http` can never be primary. A document
   with no messaging surface is refused. Every document this platform writes declares `web`
   first and `http` beside it.
3. The kernel's overlay accepts `add`, `replace`, `remove` only, with RFC 6902 array semantics;
   `/id` and `/displayName` cannot be locked and are supplied by the platform.
4. A run over `POST /v1/runs` names `(surface, userId)`; the caller's principal must have an
   `http` entry in the document. `svc-platform` is that principal.
5. `HARNESS_RUN_MAX_MODEL_CALLS` < `HARNESS_GATEWAY_MAX_CALLS_PER_RUN` or the tenant refuses to
   open; `HARNESS_EMBED_DIMS` is the column width and the `embed` route must produce it.
6. A pack a document names must be installed in the host image; P1 uses the kernel image, which
   ships `@harness/pack-healthcare`; a platform pack would need a platform host image.
7. The kernel's tenant-scoped storage on a pooled host is a kernel follow-up (per-tenant
   sub-root); knowledge here is read-only per tenant on its own directory.
8. The main checkout of `agent-harness` is what the links point at and must sit at the pinned
   commit; `pnpm kernel:check` says so when it does not.

## 13. Open questions (answered before the task that needs them; none block the plan)

1. Whether 11c's web surface conversation ids are platform-chosen strings (one per user per agent
   in P1) or surface-minted; the chat proxy is written for platform-chosen and adapts if not.
2. Whether the Compose smoke job can pull `ghcr.io/mgavrila/agent-harness-host` anonymously; if
   the package is private, CI needs a read token as a secret.
