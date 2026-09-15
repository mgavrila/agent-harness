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
