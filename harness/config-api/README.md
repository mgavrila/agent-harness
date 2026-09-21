# @harness/config-api

The contract between the kernel and whatever holds a tenant's configuration.

A **client document** is everything a client is: its persona, its principals and their default
levels, its policy, its model routing, its playbooks, its skills, where its knowledge comes from,
which surfaces it serves, which identity plug-in and runtime it loads, and which packs. One zod
schema, one version number, and two ways of reaching one — a directory (`@harness/config-files`)
or versioned rows (`@harness/config-postgres`) — behind the `ConfigSource` interface here.

**Surfaces.** `SURFACE_ORDER` fixes both which surfaces a document may declare and the order the
host loads them in: the first one present is the primary, where an approval card goes.

| surface  | fields                                                      | tenant key                            |
| -------- | ----------------------------------------------------------- | ------------------------------------- |
| `web`    | `token: SecretRef`                                          | none; the path names the tenant       |
| `slack`  | `teamId`, `signingSecret: SecretRef`, `botToken: SecretRef` | `teamId`                              |
| `memory` | `workspace?`                                                | `workspace`, when set                 |
| `http`   | none                                                        | none; and it may never be the primary |

A **SecretRef** is `{ env: string }` or `{ ref: string }`, never both keys and never neither. An
`env` names an environment variable the host resolves from its own process environment, exactly
as it does today. A `ref` names an entry in a deployment's secret store; the schema admits it so a
document can be written before a deployment has one, but `assertSecretsPresent` refuses to open a
tenant that names a `ref` until that deployment has a secret source to resolve it against — a
literal secret value never belongs in the document, which is the whole reason `SecretRef` exists
rather than a plain string.

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
