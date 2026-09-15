# Model gateway

One LiteLLM proxy in front of every model the harness uses. Callers ask for a
**route** (`chat`, `extract`, `reason`, `judge`), never a provider.

## Swapping a provider

1. Edit `clients/<name>/routing.yaml`.
2. `pnpm gateway:config` — re-renders `harness/gateway/litellm.config.yaml`.
3. `pnpm gateway:up` — restarts the proxy with the new config.

No TypeScript changes. `harness/gateway/litellm.config.yaml` is generated; edit
`routing.yaml` instead.

## What the generator does

- One LiteLLM deployment per route, named after the route.
- One extra deployment per fallback, named `<route>-fallback-N`, wired into
  `router_settings.fallbacks`.
- `max_budget` + `budget_duration: 1d` on every deployment. **Budgets are only
  enforced when the proxy has a database**, which is why the service sets
  `DATABASE_URL` to the `litellm` database in the Compose Postgres.
- `api_key: os.environ/<PROVIDER>_API_KEY` — never a literal key, so the
  rendered file is safe to commit.

## Ports and secrets

The proxy listens on `127.0.0.1:4000` only. It holds every provider key, so it
must never be published on a routable interface. `core-tools` authenticates with
`LITELLM_MASTER_KEY`.

## Spend

LiteLLM's own spend tables are the authority for budget enforcement. The
harness separately records each call in Postgres `model_calls` for per-run
attribution; see "Model calls" in `docs/runbook.md` for why the two can differ.
