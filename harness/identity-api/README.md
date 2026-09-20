# @harness/identity-api

The contract between the kernel and an identity plug-in. A plug-in answers one question — which
principal is behind a surface user id — and the kernel binds the answer to a run before the model
sees anything. Nothing a model sends can set it.

It depends on `@harness/shared` and zod and on nothing else in the workspace, which is what lets
the kernel load a plug-in by name at runtime (a client document's own `identityPlugin.kind`)
instead of importing it at build time.

| Module              | Holds                                                                                                                                    |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `src/types.ts`      | every declaration: `Principal`, `IdentitySession`, `IdentityDeps`, `IdentityProvider`                                                    |
| `src/identity.ts`   | `defineIdentityProvider`, `levelAtLeast`                                                                                                 |
| `src/principals.ts` | `IdentityFileShape` (a document's `identity` section), `parseIdentityFileWithDefaults`, `principalFromDefault`, `principalFromDerivedId` |
| `src/testing.ts`    | `StaticIdentity`, reached as `@harness/identity-api/testing`                                                                             |

The five levels — `member`, `practitioner`, `lead`, `admin`, `service` — are declared in
`@harness/shared` and re-exported here, because `@harness/pack-api`'s policy matrix is keyed by
them and the two contracts may not import each other. `service` is never "at least" a user level.

`StaticIdentity` is both the fake every kernel test drives and the whole of
`@harness/identity-static`, so the thing the suite proves the kernel against is the thing that runs.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to.
