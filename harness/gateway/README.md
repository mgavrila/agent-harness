# @harness/gateway

The model routing table and the LiteLLM config renderer. Every model call in the harness names
a _job_ — `chat`, `extract`, `reason`, `judge` — never a provider, so switching providers is a
change to `clients/<name>/routing.yaml` and nothing else.

## Layout

```
src/domain/routing/types.ts   ROUTES, Route, RouteSpec, RoutingFile — the zod schema
src/domain/routing/parse.ts   parseRouting: routing.yaml -> RoutingFile, with a readable error
src/domain/routing/render.ts  apiKeyEnvFor, renderLiteLlmConfig: RoutingFile -> LiteLLM YAML
src/app/render-config.ts      the `pnpm gateway:config` entrypoint
src/index.ts                  the public API
litellm.config.yaml           GENERATED. Compose bind-mounts this exact path; do not move it.
```

## Public API

`@harness/gateway` exports `ROUTES`, `type Route`, `RouteSpec`, `RoutingFile`, `parseRouting`,
`apiKeyEnvFor` and `renderLiteLlmConfig`. `@harness/gateway/routing` is the routing types on
their own; `@harness/core-tools` imports `ROUTES` from there so that the harness and the proxy
can never disagree about which routes exist.

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
