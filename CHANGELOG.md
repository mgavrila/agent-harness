# Changelog

What changed in the agent-harness kernel, written for the team that consumes it. Versions are
semantic and every package in a release carries the same one. A release attaches the package
tarballs and the two architecture snapshots; the host and files images are pushed to
`ghcr.io/mgavrila` under the same tag.

## 0.3.0 — unreleased

The release the platform pins: a tenant with no Slack, secrets that are not environment variables,
a document that names its own deployments, and two lists a dashboard can hold.

### Added

- **A web surface.** `surfaces.web: { token: SecretRef; inbox?: string }` declares it, and it is
  first in the surface order, so a tenant that has one has it as its primary surface and its
  approval cards go to its inbox. Four routes under `/tenants/<clientId>/web/`: post a message,
  open a conversation's Server-Sent Events stream, post an action, post a form. Every request
  carries that tenant's own bearer. See "The web surface" in `docs/runbook.md`.
- **Secrets from a store.** `SecretSource` beside `ConfigSource`, with `env` and `postgres`
  implementations and a conformance kit at `@harness/config-api/testing`.
  `HARNESS_SECRET_SOURCE=env|postgres`, **required, no default**, and required by the stdio
  server as well as the host. A document's `{ ref: name }` resolves from `client_secrets` —
  migration 0015 — through the AES-256-GCM envelope `@harness/db` already ships, whose test
  vector is now asserted in both directions. A tenant added by writing rows answers on a pooled
  host with no restart.
- **A per-tenant gateway key.** `routing.gateway.key` is a `SecretRef`, resolved at tenant open
  and sent as the bearer for that tenant's model calls. Absent, the process key stands.
- **`surfaces.slack.approvalsChannel`**, required when a document declares a Slack surface: the
  channel that tenant's approval cards go to, carried to the adapter the way a web inbox is.
- **`GET /v1/approvals` and `GET /v1/memory`**, cursor-paged, tenant-scoped, authenticated exactly
  like `/v1/usage`. The column lists are in the runbook and are the whole of the guarantee: no
  approval payload, encrypted or not.
- **Per-surface health on `GET /v1/status`.** `surfaces` is now `[{ name, live, detail? }]`, fed
  by an optional `SurfaceSession.health()`. A surface that offers none is live; `detail` is a
  fixed sentence its adapter owns. The route makes no outbound call: Slack reports the identity
  it has already fetched.
- **A streaming seam.** `SurfaceHttpResponse.body` is now `string | AsyncIterable<string>`, and
  `SurfaceHttpRequest` carries `clientId` and `signal`. The host writes the head, pipes each chunk
  as it is yielded and aborts the signal when the caller hangs up. `MemorySurface` in
  `@harness/surface-api/testing` grows the matching door, a `health()` and `bodyText`.
- **`SurfaceDeps.defaultConversation` and `SurfaceSettings.defaultConversation`**: where a surface
  posts when nobody names a conversation, as that tenant's document names it. `surfaceConversationsOf`
  in `@harness/config-api` is what reads it out of the typed sections.
- **A deployment catalogue.** `harness/gateway/catalogue.yaml` lists the deployments a dedicated
  host serves — upstream model, endpoint, budget, fallbacks — and `pnpm gateway:config` renders it
  with no client, no config source and no database.
- **The client store as a stable write contract**: `client_documents`, `client_document_versions`
  and `client_secrets`, at the columns they have today, with the envelope and a test vector.

### Changed

- **A route names a deployment, and the kernel sends that name.** `routing.routes.<route>.model`
  is the name of a deployment the gateway serves, and it is what travels as `model:` on every call
  path and what `model_calls.model` records. `RouteSpec` is `{ model }` and nothing else:
  `fallbacks`, `api_base`, `daily_budget_usd` and the whole `routing.defaults` object are removed,
  and a document that still carries one is **refused at load**. What a deployment is belongs to the
  gateway — to `harness/gateway/catalogue.yaml` on a dedicated host, and to the platform's
  registrations (`<clientId>/<vendor>/<model>`) on a pooled one, where a route name on the wire
  would have made every tenant's `chat` the same deployment.
- **No Slack variable anywhere.** `slackConfig` reads its bot token, its signing secret and its
  approvals channel from what the host resolved for that tenant, with no `requiredEnv` fallback of
  any kind. `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL` are gone from
  `.env.example`, from the Compose host service and from the docs.
- **`STORE_MODEL_IN_DB: 'True'`** on the Compose `litellm` service, so the platform can register a
  tenant's deployments through `POST /model/new`.
- **Playbooks are scheduled in UTC.** `playbooks[].timezone` is removed — migration 0016 drops the
  column — and a document that still names one fails to parse. The `playbooks_list` tool's output
  loses the field with it, which is the one change to the tool surface in this release.
- **`SurfaceDeps.secrets` is now `SurfaceDeps.secretValues`, and carries resolved values rather
  than environment variable names.** A `{ ref }` has no variable name, so the bag could not carry
  one; the rename is what forces every adapter's read to be looked at.
- **`routing:` is strict.** An unknown key there used to be stripped, so a mistyped `gatway:`
  would leave a tenant on the process key in silence.
- **A rewritten version is refused.** Writing `(client_id, version)` again with different content
  raises a `ConfigError`; an identical rewrite is still a no-op. Write content-hash versions and
  you will never see it.
- **`.env.example` is a deployment's file now.** A tenant's credentials are rows in
  `client_secrets`, named by its document as `{ ref }` and written from the platform's own
  interface, or `{ env: SOME_NAME }` refs on a dedicated host, which names them itself.
- **Two `gatewayError` sentences.** A 401 or 403 no longer says "check `LITELLM_MASTER_KEY`",
  which is not the credential a tenant with its own key was rejected on, and a budget refusal no
  longer points at the client document: a budget is the virtual key's or the deployment's, and
  both live in the gateway.
- **An unknown `actionId` is answered.** The press is still delivered and still `202`, and the
  person who made it now gets a private notice, which is what the web surface's API reference has
  always said happens.
- `defaults.web` is allowed in the identity section and **may not name `lead` or `admin`**: one
  shared bearer mints every principal such a default describes, and none of them may decide an
  approval.
- `tenantKeysOf` reports a web tenant's own id as its key, so a pooled host routes its messages.

### Upgrading

1. Set `HARNESS_SECRET_SOURCE` in every deployment's `.env` — the host's and the stdio server's
   alike. `env` keeps today's behaviour exactly.
2. Run the migrations: 0015 creates `client_secrets`, 0016 drops `playbooks.timezone`. Remove
   `timezone:` from every playbook in every document first; a document that still has one will not
   parse, and its schedules are read in UTC from now on.
3. **Rewrite each document's `routing` section.** Keep `routes.<route>.model` and delete
   `fallbacks`, `api_base`, `daily_budget_usd` and `defaults` — a document carrying any of them is
   refused. Then put what they configured where it now belongs: on a dedicated host, in
   `harness/gateway/catalogue.yaml`, which is the input `pnpm gateway:config` renders (it no
   longer reads `HARNESS_CLIENT` or a config source); on a pooled host, in the deployments the
   platform registers and in that tenant's virtual key. Re-render and restart the proxy:
   `pnpm gateway:config && pnpm gateway:up`. The rendered `model_list` now names each deployment
   by its model string rather than by a route, which is what the documents' `model:` values
   resolve against.
4. **Add `approvalsChannel` to every document that declares `surfaces.slack`**, and stop setting
   `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_APPROVALS_CHANNEL`: the channel and both
   secrets come from the document now. On the platform, they are entered in its interface and
   stored as rows; on a dedicated host, the document names them as `{ env: SOME_NAME }` and the
   operator sets `SOME_NAME` in `.env` and adds it to the host service's `environment` in
   `harness/compose/docker-compose.yml`.
5. If you build a surface adapter, rename `deps.secrets` to `deps.secretValues` and read values
   rather than looking names up; `health()` is optional and a surface without one is reported live.
6. If you poll `GET /v1/status`, read `surfaces` as objects rather than as names.
7. The tool surface moved once: `playbooks_list` no longer reports `timezone`. Nothing else in
   `docs/architecture/tool-surface.json` changed, and no route moved.
   `docs/architecture/compose-surface.yaml` moved twice, for `HARNESS_SECRET_SOURCE` and for this
   release's `litellm` and host-service changes.

## 0.2.0 — unreleased

The release that makes this repository something to depend on rather than something to check out.

### Added

- **Slack over HTTPS.** The Slack surface receives events and interactions as signed requests at
  one URL instead of holding a Socket Mode connection. A host with no socket can be paused,
  resumed, pooled and put behind an ingress. Point both request URLs in the app's configuration —
  Event Subscriptions and Interactivity — at
  `https://<host>/tenants/<clientId>/slack/events`.
- **An HTTP seam on the surface contract.** `SurfaceSession.http` is a mount path and a handler;
  the host mounts every tenant's at `/tenants/<clientId>/<path>` on the port the run API already
  uses. A surface verifies its own transport's signature and may refuse a request with a reason,
  which the host audits exactly once.
- **`@harness/sandbox-api`**, reserved: `SandboxProvider`, `Sandbox`, `SandboxSession` and
  `ExecResult`, with an in-memory provider and a conformance suite. Nothing implements it yet and
  no action class admits one.
- **Published packages.** `@harness/shared`, `@harness/pack-api`, `@harness/config-api`,
  `@harness/surface-api`, `@harness/identity-api`, `@harness/runtime-api` and
  `@harness/sandbox-api` ship as build output with declarations. Pin them by tarball URL:
  `https://github.com/mgavrila/agent-harness/releases/download/v0.2.0/harness-shared-0.2.0.tgz`,
  and add a `pnpm.overrides` entry for each, because the tarballs depend on one another by exact
  version. The `./testing` subpath of `@harness/config-api`, `@harness/runtime-api` and
  `@harness/sandbox-api` needs `vitest` installed, and `@harness/runtime-api/testing` also needs
  `@modelcontextprotocol/server` for its tool-server fixture; both are declared as optional peers,
  so importing only the contract costs you nothing.
- **`HARNESS_IMAGE_TAG`**, which is the release a Compose deployment runs.

### Changed

- **The host's HTTP server always starts.** `HARNESS_HOST_TOKEN` empty now closes `/v1/*` with a
  401 rather than closing the listener, because the tenant mounts have to answer whether or not a
  deployment uses the run API.
- **Compose pulls.** No service is built from a checkout any more: `host` and `files` are pulled
  from `ghcr.io/mgavrila` at `HARNESS_IMAGE_TAG`.
- `surfaceSecretsOf` reports the document field each secret was named under, and a surface is
  handed the variable names its own tenant's document declared.
- The audit log has a sixth decision, `refused`: a request a surface turned away at the door,
  where nobody was identified and so nobody was refused authorisation.

### Removed

- **Socket mode, `@slack/bolt` and `SLACK_APP_TOKEN`.** A Slack app for this kernel needs a bot
  token and a signing secret, and no app-level token. There is no compatibility path: delete the
  variable and set the request URLs.
- The `core-tools` build-only Compose service and the `build-only` profile.
- `LoadedSurfaces.secrets`, which nothing read.

### Upgrading

1. Release or pull an image tag and set `HARNESS_IMAGE_TAG` in `.env`.
2. In each tenant's Slack app: turn Socket Mode off, set both request URLs to
   `https://<host>/tenants/<clientId>/slack/events`, and remove the app-level token.
3. Delete `SLACK_APP_TOKEN` from every environment file.
4. Put something in front of the host that terminates TLS. For local development, a tunnel —
   see docs/runbook.md, "Local development with a tunnel".
