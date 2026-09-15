# agent-harness

Self-hosted, model-agnostic agent harness built to be deployed for many
clients by adding content and configuration, not code.

- **Runtime**: Hermes Agent, self-hosted, Docker.
- **Models**: any provider behind one model gateway. Hosted keys today,
  local vLLM later.
- **Core**: tool policy and audit, approval engine, record store, playbook
  conventions, evals.
- **Packs**: reusable industry content (skills, schemas, forms, eval sets).
- **Clients**: one folder per deployment (SOUL, routing, policy, env).

First pack: healthcare credentialing. First client: a demo medical practice
on Slack.

Design spec: `docs/superpowers/specs/2026-09-15-agent-harness-credentialing-design.md`

## Layout

```
harness/     model gateway config, core tools MCP server, approvals app, db, compose
packs/       healthcare/
clients/     demo-practice/
evals/       runner and judges
scripts/     new-client.ts
docs/        specs, ADRs, runbook
```

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
pnpm evals        # run the pipeline over them and score it
```

`pnpm evals` writes `evals/results/report.json` and `report.md` and exits
non-zero when a metric regressed against `evals/baseline.json` or an injection
case did not hold. The rule it enforces is in `docs/promotion-gate.md`.

Add `--limit=24` to run a sample instead of all 162 cases, which is what a free
provider tier can absorb. The sample keeps the injection documents and takes the
rest evenly from both splits.

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
