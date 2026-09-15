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
scripts/     new-client.py
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
