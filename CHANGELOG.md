# Changelog

What changed in the agent-harness kernel, written for the team that consumes it. Versions are
semantic and every package in a release carries the same one. A release attaches the package
tarballs and the two architecture snapshots; the host and files images are pushed to
`ghcr.io/mgavrila` under the same tag.

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
