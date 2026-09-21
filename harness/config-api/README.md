# @harness/config-api

The contract between the kernel and whatever holds a tenant's configuration.

A **client document** is everything a client is: its persona, its principals and their default
levels, its policy, its model routing, its playbooks, its skills, where its knowledge comes from,
which surfaces it serves, which identity plug-in and runtime it loads, and which packs. One zod
schema, one version number, and two ways of reaching one — a directory (`@harness/config-files`)
or versioned rows (`@harness/config-postgres`) — behind the `ConfigSource` interface here.

**Surfaces.** `SURFACE_ORDER` fixes both which surfaces a document may declare and the order the
host loads them in: the first one present is the primary, where an approval card goes.

| surface  | fields                                                                          | tenant key                            |
| -------- | ------------------------------------------------------------------------------- | ------------------------------------- |
| `web`    | `token: SecretRef`                                                              | none; the path names the tenant       |
| `slack`  | `teamId`, `signingSecret: SecretRef`, `botToken: SecretRef`, `approvalsChannel` | `teamId`                              |
| `memory` | `workspace?`                                                                    | `workspace`, when set                 |
| `http`   | none                                                                            | none; and it may never be the primary |

Two of those fields are not secrets and travel to the adapter as plain settings: `web.inbox` and
`slack.approvalsChannel`, the conversation each surface posts to when nobody names one.
`surfaceConversationsOf` reads them out of the typed sections so the host can copy them opaquely,
the way it copies a tenant key — it never learns that one is an inbox and the other a channel.

**Routing.** `routing.routes.<route>.model` is the name of a deployment the gateway serves, and
that string is what the kernel sends as `model:` on every call. It is the whole of a route: what
the deployment _is_ — its upstream model, its endpoint, its budget, its fallbacks — belongs to the
gateway, to `harness/gateway/catalogue.yaml` on a dedicated host and to the platform's
registrations on a pooled one. The schema is strict, so a document that still carries `fallbacks`,
`api_base`, `daily_budget_usd` or `defaults` is refused at load rather than parsed into a field
nothing renders.

A **SecretRef** is `{ env: string }` or `{ ref: string }`, never both keys and never neither. An
`env` names an environment variable, resolved from the process environment under every source. A
`ref` names an entry in a deployment's secret store. A literal secret value never belongs in the
document, which is the whole reason `SecretRef` exists rather than a plain string.

A **SecretSource** is where those references are resolved from: `name`, `resolve(clientId, ref)`
and an optional `close`, chosen by `HARNESS_SECRET_SOURCE`. `envSecretSource` ships here and
refuses every `{ ref }`, because a deployment with no store cannot serve a document that names an
entry in one; `postgresSecretSource` in `@harness/config-postgres` reads `client_secrets`.
`resolveSecrets(document, { source, log })` turns every reference a document's surfaces name into
its **value**, keyed by surface and by the document's own field name, which is what the host hands
each adapter. It runs **once, when a tenant opens**, before anything else about that tenant is
built, which is what makes "add a tenant with no restart" true on a pooled host and why rotating a
stored secret needs one more write — a document version bump — to reach an already-open tenant.
Every implementation runs `secretSourceConformance` from `@harness/config-api/testing`.

A **blueprint** is a complete document with placeholders and a **lock set** of JSON pointers. An
**overlay** is a tenant's edits as a small JSON Patch. `resolve(blueprint, overlay)` applies the
patch and refuses, with a `ConfigError` naming the path, any operation that touches a locked
pointer. A finished agent and a customisable one are the same object with different locks.

This package imports `@harness/identity-api`, `@harness/pack-api` and `@harness/shared` and
nothing else in the workspace: it is a contract, and a contract that pulled in the kernel would
defeat the point of having one. **An identity plug-in does not import it** — it receives its own
section of the document through `IdentityDeps`.

`@harness/config-api/testing` ships `fixtureDocument`, an in-memory source, and
`configSourceConformance`, the suite every source implementation runs.
