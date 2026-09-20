# @harness/gateway

The model routing table and the LiteLLM config renderer. Every model call in the harness names
a _job_ — `chat`, `extract`, `reason`, `judge` — never a provider, so switching providers is a
change to the client document's own `routing` section and nothing else.

`pnpm gateway:config` reads the client `HARNESS_CLIENT` names through whatever `ConfigSource`
`HARNESS_CONFIG_SOURCE` picks (`@harness/core-tools`'s `configSourceNameFrom`/`loadConfigSource`,
the same registry the kernel uses), not a file this package resolves on its own — which is why it
depends on `@harness/core-tools` and `@harness/db` now, and is no longer the one package with no
edge to `@harness/shared`.

## Layout

```
src/domain/routing/parse.ts   parseRouting: an inline routing table -> RoutingFile, with a
                               readable error (kept for a document embedded as raw YAML; the
                               render pipeline itself reads the field already parsed)
src/domain/routing/render.ts  apiKeyEnvFor, renderLiteLlmConfig: RoutingFile -> LiteLLM YAML
src/app/render-config.ts      the `pnpm gateway:config` entrypoint: renderClientConfig(source, clientId)
src/index.ts                  the public API
litellm.config.yaml           GENERATED. Compose bind-mounts this exact path; do not move it.
```

`ROUTES`, `RouteSpec` and `RoutingFile` — the zod schema itself — live in `@harness/config-api`,
not here: `routes` is a section of the client document, so `@harness/gateway` and
`@harness/core-tools` both import the schema from there rather than from each other.

## Public API

`@harness/gateway` exports `parseRouting`, `apiKeyEnvFor` and `renderLiteLlmConfig`. `ROUTES`,
`type Route`, `RouteSpec` and `RoutingFile` come from `@harness/config-api`, which
`@harness/core-tools` also imports, so the harness and the proxy can never disagree about which
routes exist.

The rendered config never contains a key — only `os.environ/NAME` references — which is why it
is safe to commit. `RouteSpec` is `.strict()` so that an inline `api_key:` in a routing file
fails loudly instead of being dropped.

## Testing

```bash
pnpm --filter @harness/gateway test
```

No database, no network. `pnpm gateway:config` regenerates `litellm.config.yaml`; if
`git status` is dirty afterwards, either the renderer or the client's routing table changed,
and the diff says which.
