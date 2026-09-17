# @harness/identity-static

The identity plug-in that reads `clients/<name>/identity.yaml`. It is the one the demo runs
(`HARNESS_IDENTITY=@harness/identity-static`, the default) and the one every kernel test loads.

```yaml
principals:
  - id: u-coordinator # u- for a person, svc- for a service; stable, never reused
    kind: user
    level: lead # member < practitioner < lead < admin; service for a service
    displayName: Credentialing coordinator
    surfaces: { slack: U0456EFGH } # this person's user id on each surface they may speak from
```

`connect` reads `HARNESS_IDENTITY_FILE` when it is set and `<clientDir>/identity.yaml` otherwise,
parses it with `parseIdentityFile` from `@harness/identity-api` — unique ids, `u-` for users and
`svc-` for services, `service` level for services only, no surface user id claimed twice — and
answers with a `StaticIdentity` from `@harness/identity-api/testing`. A missing or invalid file is
a `ConfigError` at startup: a deployment with nobody in it runs nothing.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to for the next plug-in.
