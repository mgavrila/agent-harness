# @harness/identity-static

The identity plug-in that answers for the principals the client document declares. It reads no
file and no environment variable: a document selects it with `identityPlugin: { kind: static }`,
and it is the one every kernel test loads.

```yaml
identity:
  defaults:
    memory: member # anyone this file does not declare gets this level on the memory surface
  principals:
    - id: u-coordinator # u- for a person, svc- for a service; stable, never reused
      kind: user
      level: lead # member < practitioner < lead < admin; service for a service
      displayName: Credentialing coordinator
      surfaces: { slack: U0456EFGH } # this person's user id on each surface they may speak from
```

`connect` is handed this section already validated, as `IdentityDeps.identity` — `parseIdentityFileWithDefaults`
from `@harness/identity-api` applies the rules zod cannot say (unique ids, `u-` for users and
`svc-` for services, `service` level for services only, no surface user id claimed twice, and no
`defaults` entry on the run API surface) before the plug-in ever sees it. A surface named in
`defaults` admits an undeclared caller at that surface's default level, under an id
`principalFromDefault` derives from theirs, so the same person is the same principal on the next
turn and after a restart. A surface with no default still refuses an undeclared caller, exactly as
this plug-in always has: `null` is "not authorised", never a guest.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to for the next plug-in.
