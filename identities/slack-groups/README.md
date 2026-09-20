# @harness/identity-slack-groups

Levels come from the groups a workspace already keeps, never from a list of people the document
has to name one by one.

```yaml
identityPlugin:
  kind: slack-groups
  settings:
    surface: slack # the surface whose directory is read; its name in the document's `surfaces`
    groups: # ordered, and the first group the person is in wins
      - { id: S-ADMINS, level: admin }
      - { id: S-LEADS, level: lead }
      - { id: S-STAFF, level: practitioner }
    exceptions: # checked before `groups`; `refuse` is "not a principal at all"
      - { userId: U-CONTRACTOR, level: member }
      - { userId: U-BANNED, level: refuse }
    sync: { everySeconds: 300 } # how long one person's answer is reused
```

The order is `exceptions`, then `groups`, then the document's own `identity.defaults` for
everyone else, which is the order of how specific each answer is; someone in no group and on a
surface with no default is refused, because `null` is "not authorised" and never a guest. A
principal the document declares outright still wins over all three.

The plug-in never imports a surface. It receives a `SurfaceDirectory` — two methods, both taking
a surface user id — through `IdentityDeps.directories`, which is what lets one implementation
serve any transport whose workspace has a notion of a group, and what `pnpm arch` enforces.

`CONTRIBUTING.md`, "Adding an identity provider", is the worked how-to for the next plug-in.
