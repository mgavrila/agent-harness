# @harness/gateway

The deployment catalogue and the LiteLLM config renderer. Every model call in the harness names a
_job_ — `chat`, `extract`, `reason`, `judge`, `embed` — and a client document says which deployment
serves each job, so switching providers for one tenant is a change to that document and switching
what a deployment _is_ is a change here.

`pnpm gateway:config` reads `harness/gateway/catalogue.yaml` and writes `litellm.config.yaml`. It
reads no client, no config source and no database, which is why this package depends on neither
`@harness/config-api` nor `@harness/core-tools` nor `@harness/db`: a deployment's catalogue is the
deployment's, and one rendered file serves every tenant on the host.

## Layout

```
catalogue.yaml                       the deployments this host serves. Tracked; edited by hand.
src/domain/routing/catalogue.ts      DeploymentCatalogue, CatalogueEntry, deploymentName: the schema
src/domain/routing/render.ts         apiKeyEnvFor, renderLiteLlmConfig: a catalogue -> LiteLLM YAML
src/app/render-config.ts             the `pnpm gateway:config` entrypoint: renderCatalogueConfig()
src/index.ts                         the public API
litellm.config.yaml                  GENERATED. Compose bind-mounts this exact path; do not move it.
```

`ROUTES`, `RouteSpec` and `RoutingFile` — what a _document_ may say — live in
`@harness/config-api`, not here: `routes` is a section of the client document, and a route names a
deployment by name and says nothing about what it is.

## A catalogue entry

```yaml
deployments:
  - model: gemini/gemini-3-flash-preview # provider-prefixed; the deployment name defaults to it
    daily_budget_usd: 2
    fallbacks: [groq/openai/gpt-oss-120b] # names of other deployments in this file
defaults:
  daily_budget_usd: 1
  num_retries: 2
  request_timeout_s: 120
```

`name` is optional and defaults to `model`, which is the usual case: a document then names the
deployment by its model string. Names are unique, every fallback must name another entry in the
same file, and the schema is strict — an inline `api_key:` fails the render rather than being
dropped, because the rendered config carries only `os.environ/NAME` references and is therefore
safe to commit.

On a **pooled** host the platform registers a tenant's own deployments through LiteLLM's
`POST /model/new`, under `<clientId>/<vendor>/<model>`, and this file answers the same question for
the deployments the host shares.

## Public API

`@harness/gateway` exports `renderLiteLlmConfig`, `apiKeyEnvFor`, `DeploymentCatalogue`,
`CatalogueEntry` and `deploymentName`. `apiKeyEnvFor` maps a provider prefix to the environment
variable holding that provider's key, and it applies to a catalogue entry only — never to a
document's model string, which is a deployment name the gateway resolves.

## Testing

```bash
pnpm --filter @harness/gateway test
```

No database, no network, and no fixture of its own: the suite reads the shipped `catalogue.yaml`
and asserts that `litellm.config.yaml` is a current render of it, byte for byte. A catalogue edited
without `pnpm gateway:config` therefore fails the suite rather than shipping a stale file to the
Compose bind mount. Re-render and commit both.
