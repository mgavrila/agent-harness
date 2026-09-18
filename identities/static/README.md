# @harness/identity-static

The identity plug-in that reads `clients/<name>/identity.yaml`. It is the one the demo runs
(`HARNESS_IDENTITY=@harness/identity-static`, the default) and the one every kernel test loads.

```yaml
defaults:
  slack: member # optional: the level anyone this file does not list gets on that surface
principals:
  - id: u-coordinator # u- for a person, svc- for a service; stable, never reused
    kind: user
    level: lead # member < practitioner < lead < admin; service for a service
    displayName: Credentialing coordinator
    surfaces: { slack: U0456EFGH } # this person's user id on each surface they may speak from
```

`connect` reads `HARNESS_IDENTITY_FILE` when it is set and `<clientDir>/identity.yaml` otherwise,
parses it with `parseIdentityFileWithDefaults` from `@harness/identity-api` — unique ids, `u-` for
users and `svc-` for services, `service` level for services only, no surface user id claimed twice
— and answers with a session over a `StaticIdentity` from `@harness/identity-api/testing`. A
missing or invalid file is a `ConfigError` at startup: a deployment with nobody in it runs nothing.

`defaults` is what makes a whole-team deployment practical. A surface listed there admits someone
the file never mentions, at that level, as `u-<surface>-<their surface user id>` — derived, never
random, so the same person is the same principal across restarts and carries their own audit
trail. It takes a user level only; `service` is a `ConfigError`, because a default is by
definition what a person who walked in gets. A surface with no default refuses an unknown user,
which is the right behaviour for a deployment whose members are all named in the file, and
`list()` still answers with the declared principals alone.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to for the next plug-in.
