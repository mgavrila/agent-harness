# agent-harness

Self-hosted, model-agnostic agent harness built to be deployed for many
clients by adding content and configuration, not code.

- **Runtime**: Hermes Agent, self-hosted, Docker.
- **Models**: any provider behind one model gateway. Hosted keys today,
  local vLLM later.
- **Core**: tool policy and audit, approval engine, record store, playbook
  conventions, evals.
- **Packs**: reusable industry content (record kinds, skills, forms, eval
  sets) plus any tools that area needs, behind one contract.
- **Clients**: one folder per deployment (SOUL, routing, policy, env).

First pack: healthcare credentialing. First client: a demo medical practice
on Slack.

Design spec: `docs/superpowers/specs/2026-09-15-agent-harness-credentialing-design.md`

## Layout

```
harness/shared/      env, errors, paths, logging, subprocess, JSONL, CSV. No dependencies.
harness/pack-api/    the Pack contract every pack implements and core loads
harness/db/          schema, migrations, the pool, encryption
harness/gateway/     the routing table and the LiteLLM config renderer
harness/core-tools/  the pack-agnostic kernel and MCP server: shared/, domain/, tools/, app/
harness/approvals/   the Slack approval app and the effects dispatcher
harness/compose/     the Docker stack
packs/healthcare/    the credentialing pack: record and attachment kinds, forms, skills, eval sets, corpus, eighteen tools
packs/stories/       the proof pack: one record kind, one document kind, no tools
clients/             one folder per deployment: SOUL, routing, policy, env
evals/               the runner, scorers, judge and report
scripts/             the client scaffolder
docs/                specs, runbook, demo, promotion gate, architecture
```

Every package has the same four layers — `shared` → `domain` → `tools` → `app` — with one
public entry point. A **pack** is an area of the product core loads at runtime rather than
imports: set `HARNESS_PACKS` to choose. The kernel knows about records, attachments, documents
and deadlines, and nothing about medicine — a grep test fails the build on the word `provider`
in `harness/core-tools/src`. **[ARCHITECTURE.md](ARCHITECTURE.md)** explains the
layers, the packs, the path of one tool call and the three invariants;
**[CONTRIBUTING.md](CONTRIBUTING.md)** is how to add a tool, a domain, a pack, a client, a
migration or a test.

## Documents

|                                                  |                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [ARCHITECTURE.md](ARCHITECTURE.md)               | the layers, the package map, the path of a tool call, the three invariants                                                                                                                                                                                                                                                                                                         |
| [CONTRIBUTING.md](CONTRIBUTING.md)               | how to add a tool, a domain, a pack, a client, a migration, a test                                                                                                                                                                                                                                                                                                                 |
| [docs/runbook.md](docs/runbook.md)               | operating it: audit, effects, reconciliation, storage, the Slack app, onboarding                                                                                                                                                                                                                                                                                                   |
| [docs/demo.md](docs/demo.md)                     | the five-minute demo script                                                                                                                                                                                                                                                                                                                                                        |
| [docs/promotion-gate.md](docs/promotion-gate.md) | what an eval run has to clear                                                                                                                                                                                                                                                                                                                                                      |
| package READMEs                                  | [shared](harness/shared/README.md), [pack-api](harness/pack-api/README.md), [db](harness/db/README.md), [gateway](harness/gateway/README.md), [core-tools](harness/core-tools/README.md), [approvals](harness/approvals/README.md), [evals](evals/README.md), [pack-healthcare](packs/healthcare/README.md), [pack-stories](packs/stories/README.md), [scripts](scripts/README.md) |

## Run locally

```bash
pnpm install
cp .env.example .env            # then set HARNESS_ENCRYPTION_KEY=$(openssl rand -base64 32)
pnpm db:up                      # Postgres 16 with databases harness and harness_test
pnpm db:migrate
pnpm gateway:config             # render clients/demo-practice/routing.yaml -> LiteLLM config
pnpm gateway:up                 # LiteLLM proxy on 127.0.0.1:4000
pnpm test
pnpm --filter @harness/core-tools start   # core-tools MCP server on stdio
```

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

The Compose image for `core-tools` installs both; see
`harness/compose/core-tools.Dockerfile`.

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
cp clients/demo-practice/.env.example .env     # then fill in the blanks
pnpm install
pnpm db:up && pnpm db:migrate
pnpm demo:up
```

`docs/demo.md` is the five-minute script. `docs/runbook.md` covers the
operational side: effects outbox, approvals app, playbooks, and storage.
