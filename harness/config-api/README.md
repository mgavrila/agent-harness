# @harness/config-api

The contract between the kernel and whatever holds a tenant's configuration.

A **client document** is everything a client is: its persona, its principals and their default
levels, its policy, its model routing, its playbooks, its skills, where its knowledge comes from,
which surfaces it serves, which identity plug-in and runtime it loads, and which packs. One zod
schema, one version number, and two ways of reaching one — a directory (`@harness/config-files`)
or versioned rows (`@harness/config-postgres`) — behind the `ConfigSource` interface here.

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
