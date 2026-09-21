# agent-harness

Self-hosted, model-agnostic agent harness built to be deployed for many
clients by adding content and configuration, not code.

- **Runtime**: Deep Agents JS behind `@harness/runtime-api`, hosted by `@harness/host`.
- **Models**: any provider behind one model gateway. Hosted keys today,
  local vLLM later.
- **Core**: tool policy and audit, approval engine, record store, playbook
  conventions, evals.
- **Packs**: reusable industry content (record kinds, skills, forms, eval
  sets) plus any tools that area needs, behind one contract.
- **Clients**: one document each — persona, principals, policy, routing,
  playbooks, skills and where its knowledge comes from — held in a directory
  or a table outside this repository and read through a `ConfigSource`.

First pack: healthcare credentialing. First client: a demo medical practice
on Slack.

Design spec: `docs/superpowers/specs/2026-09-15-agent-harness-credentialing-design.md`

## Layout

```
harness/shared/      env, errors, paths, logging, subprocess, JSONL, CSV. No dependencies.
harness/pack-api/    the Pack contract every pack implements and core loads
harness/config-api/  the ClientDocument contract: the schema, blueprint + overlay + lock set,
                     resolve(), and the ConfigSource interface a source implements
harness/config-files/ a ConfigSource reading HARNESS_CLIENTS_DIR/<id>/client.yaml
harness/config-postgres/ a ConfigSource over versioned rows in client_documents
harness/surface-api/ the Surface contract a messaging adapter implements
harness/identity-api/ the Identity contract a principal resolver implements
harness/db/          schema, migrations, the pool, encryption
harness/gateway/     the routing schema and the LiteLLM config renderer
harness/core-tools/  the pack-agnostic kernel and MCP server: shared/, domain/, tools/, app/
harness/runtime-api/ the Runtime contract, ScriptedRuntime, the fake gateway and the conformance kit
harness/sandbox-api/ the Sandbox contract, reserved: acquire, exec, put, get, terminate. Nothing
                     implements it yet
harness/approvals/   the approvals library the host composes: cards, decisions, the effects dispatcher
harness/host/        a pool of tenants: the runtime, the surfaces, the identity plug-in, each
                     loaded per client from its own document
harness/files/       the parsing worker: untrusted documents, no key, no database, no route out
harness/compose/     the Docker stack
surfaces/            the messaging adapters: web, slack, memory, http (the run API's caller)
identities/          the identity plug-ins: static (a document's own principals), slack-groups
                     (a Slack workspace's own user groups)
runtimes/            the agent runtimes behind the Runtime contract: deepagents, scripted (tests)
packs/healthcare/    the credentialing pack: record and attachment kinds, forms, skills, eval sets, corpus, eighteen tools
packs/stories/       the proof pack: one record kind, one document kind, no tools
clients/fixture/     the one client document in this repository, for the suite to read and the
                     scaffolder to copy; a real client is never here
evals/               the runner, scorers, judge and report
scripts/             the client scaffolder: `pnpm new-client` writes a document
docs/                specs, runbook, demo, promotion gate, architecture
catalog/             the hf1 Agents band: loads and validates blueprints, knows no tenant,
                     database or HTTP. The platform; no kernel package imports it.
control-plane/       tenants, identity and storage; the one HTTP surface the workspace talks to.
                     The platform; no kernel package imports it.
deploy/              compose profiles, the Helm chart and the SandboxTemplates. The platform; no
                     kernel package imports it.
```

Every package has the same four layers — `shared` → `domain` → `tools` → `app` — with one
public entry point. A **pack** is an area of the product core loads at runtime rather than
imports: name it in a client document's `packs`. The kernel knows about records, attachments,
documents and deadlines, and nothing about medicine — a grep test fails the build on the word
`provider` in `harness/core-tools/src`. A **surface** is loaded the same way: name it under the
document's `surfaces` section to choose where a human is talked to, and the host holds no
transport of its own. An **identity plug-in** is loaded the same way: the document's
`identityPlugin.kind` chooses who resolves a person to a principal, and the host binds that
principal to every run before the model sees anything. A **runtime** is loaded the same way too:
the document's `runtime` chooses which agent loop drives a conversation turn — required, with no
default, because a default here would be one runtime plug-in's package name written into the
host's own source. A client is one such document, read through a `ConfigSource`
(`HARNESS_CONFIG_SOURCE`: `files`, from `HARNESS_CLIENTS_DIR`, or `postgres`, from versioned
rows) — never a folder in this repository.
**[ARCHITECTURE.md](ARCHITECTURE.md)** explains the layers, the packs, the surfaces, the client
document, the path of one tool call and the three invariants; **[CONTRIBUTING.md](CONTRIBUTING.md)**
is how to add a tool, a domain, a pack, a surface, a migration or a test.

## Documents

|                                                  |                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [ARCHITECTURE.md](ARCHITECTURE.md)               | the layers, the package map, the path of a tool call, the three invariants                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| [CONTRIBUTING.md](CONTRIBUTING.md)               | how to add a tool, a domain, a pack, a surface, a client, a migration, a test                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| [docs/runbook.md](docs/runbook.md)               | operating it: audit, effects, reconciliation, storage, the host and its surfaces, onboarding                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| [docs/demo.md](docs/demo.md)                     | the five-minute demo script                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| [docs/promotion-gate.md](docs/promotion-gate.md) | what an eval run has to clear                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| package READMEs                                  | [shared](harness/shared/README.md), [pack-api](harness/pack-api/README.md), [config-api](harness/config-api/README.md), [config-files](harness/config-files/README.md), [config-postgres](harness/config-postgres/README.md), [surface-api](harness/surface-api/README.md), [identity-api](harness/identity-api/README.md), [runtime-api](harness/runtime-api/README.md), [sandbox-api](harness/sandbox-api/README.md), [db](harness/db/README.md), [gateway](harness/gateway/README.md), [core-tools](harness/core-tools/README.md), [approvals](harness/approvals/README.md), [host](harness/host/README.md), [files](harness/files/README.md), [surface-web](surfaces/web/README.md), [surface-slack](surfaces/slack/README.md), [surface-memory](surfaces/memory/README.md), [surface-http](surfaces/http/README.md), [identity-static](identities/static/README.md), [identity-slack-groups](identities/slack-groups/README.md), [runtime-deepagents](runtimes/deepagents/README.md), [runtime-scripted](runtimes/scripted/README.md), [evals](evals/README.md), [pack-healthcare](packs/healthcare/README.md), [pack-stories](packs/stories/README.md), [scripts](scripts/README.md) |

## Run locally

```bash
pnpm install
cp .env.example .env            # then set HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)
# HARNESS_SECRET_SOURCE=env — where a document's secret references resolve; required, no default.
pnpm db:up                      # Postgres 16 with pgvector, databases harness and harness_test
pnpm db:migrate
pnpm gateway:config             # render HARNESS_CLIENT's routing (the fixture, by default) -> LiteLLM config
pnpm gateway:up                 # LiteLLM proxy on 127.0.0.1:4000
pnpm test
pnpm --filter @harness/core-tools start   # core-tools MCP server on stdio
```

What you set in `.env` is a deployment's — keys, URLs, ports. A tenant's credentials are rows in
`client_secrets`, named by that tenant's document; see "Secrets from a store" in the runbook.

Every Compose command goes through a `pnpm` script so that it carries `--env-file .env`.
Running `docker compose` by hand without it reads the wrong environment. Never source `.env`
into your shell before running tests: one crypto test asserts what happens when
`HARNESS_ENCRYPTION_KEY` is unset.

The four gates. Run all of them before you push; `pnpm test` runs the first and the last:

```bash
pnpm lint            # eslint: layers, imports, the three project rules
pnpm format:check    # prettier
pnpm arch            # dependency-cruiser: the layer graph
pnpm test            # lint, then every package's suite
```

Inspect the tools interactively:

```bash
npx @modelcontextprotocol/inspector pnpm --filter @harness/core-tools start
```

## Document pipeline prerequisites

Text extraction and OCR shell out to two binaries:

```bash
brew install tesseract poppler   # macOS
# Debian/Ubuntu: apt-get install -y tesseract-ocr poppler-utils
```

On bare metal core-tools runs them itself. Under Compose it does not: documents are parsed by
the `files` service (`harness/compose/files.Dockerfile`), a process with no key and no database
on a network that routes nowhere, and core-tools reaches it through `HARNESS_FILES_URL`.

## Evals

```bash
pnpm synth        # 20 synthetic providers, 4 documents each, text-layer and scanned
pnpm synth:stories # 3 synthetic meeting notes
pnpm evals        # run the pipeline over them and score it
```

`pnpm evals` writes `evals/results/report.json` and `report.md` and exits
non-zero when a metric regressed against `evals/baseline.json` or an injection
case did not hold. The rule it enforces is in `docs/promotion-gate.md`.

Add `--limit=24` to run a sample instead of all 162 cases, which is what a free
provider tier can absorb. The sample keeps the injection documents and takes the
rest evenly from both splits.

Add `--pack=<name>` to measure one of several loaded packs. The corpus, the
cases, the injection file, the intake skill, the judged fields and the tools the
pipeline drives all come off that pack; `evals/README.md` has the detail.

Add `--gateway=<url>` to point a run at a gateway other than
`HARNESS_GATEWAY_URL` (a staging proxy, or a fake one for an ad hoc check). It
overrides the base URL only; the proxy key still comes from
`LITELLM_MASTER_KEY` in the environment.

No baseline is committed yet. Until one is, a run scores itself and reports "no
baseline" rather than a verdict; `docs/promotion-gate.md` says why and how to
record the first one.

## Run the demo practice

```bash
pnpm install
pnpm db:up && pnpm db:migrate
pnpm new-client --name demo-practice --pack healthcare --target ../harness-tenants
cp .env.example .env    # then set HARNESS_CLIENTS_DIR/HARNESS_CLIENT and fill in the blanks
pnpm demo:up
```

`docs/demo.md` has the full walkthrough, including the client document's `surfaces.slack` section.
One Slack app, receiving events over HTTPS at `/tenants/<clientId>/slack/events`, carries both
chat and approvals; see `docs/runbook.md`, "Slack over HTTPS", for the scopes, the request URLs
and how to reach a host on your own machine.

The host serves `/healthz` on `127.0.0.1:8787`, and the run API answers only when
`HARNESS_HOST_TOKEN` is set (`docs/runbook.md`, "The run API").

`docs/demo.md` is the five-minute script. `docs/runbook.md` covers the
operational side: effects outbox, the host and its surfaces, memory, playbooks, knowledge, the
run API, and storage.

## Platform

`catalog/`, `control-plane/` and `apps/workspace/` (not built yet) are the hf1 platform, built on
top of this kernel in the same repository:

- `catalog/` (`@hf1/catalog`) — the hf1 Agents band: loads and validates blueprints, knows no
  tenant, database or HTTP.
- `control-plane/` (`@hf1/control-plane`) — tenants, identity and storage; the one HTTP surface
  the workspace talks to.
- `apps/workspace` — the product people use to configure and watch agents work.

**Boundary rule**, enforced by `pnpm arch`: the kernel (`harness/`, `packs/`, `surfaces/`,
`identities/`, `runtimes/`, `evals/`, `scripts/`) never imports the platform; `catalog/` and
`control-plane/` reach the kernel only through its five published contracts (`config-api`,
`identity-api`, `pack-api`, `surface-api`, `shared`); the workspace reaches this repository only
through `control-plane/src/client.ts`.

```bash
pnpm platform:up      # bring up the platform's own Compose stack (deploy/compose/, Task 23)
pnpm platform:down
pnpm platform:logs
```
