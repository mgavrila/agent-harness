# @harness/surface-memory

A messaging surface with no transport. It records what it was asked to post.

```yaml
# in a client document
surfaces:
  memory: {}
```

That is what a developer running the host with no Slack workspace declares — `clients/fixture/`
does, and every host test does. Cards, replies and uploads are held in memory, so what you can see
from outside the process is the health endpoint and the `approvals` and `tool_effects` rows: a
poll tick fills in `surface = 'memory'`, `conversation_id = 'memory'` and a `message_ref`, and a
dispatch tick moves an effect to `dispatched` with `result = { surface, conversation, message_id }`.

`surfaces.memory.workspace` is an optional tenant hint, with exactly `teamId`'s role for Slack: a
pooled host matches an inbound event's workspace against it to pick the tenant. It exists because
a pooled host cannot yet serve two live Slack tenants (Plan 11a); this surface is what proves
pooled routing end to end instead.

There is no allowlist here any more. Who may decide an approval is the identity plug-in's answer,
resolved from the surface user id on whichever surface the card was posted on — the same rule on
this surface as on every other one.

The session itself is `MemorySurface`, from `@harness/surface-api/testing`: the same class every
host test drives, so the adapter a developer runs and the fake the suite proves the host against
are one implementation. It also has an inbound half: `say(userId, text, over?)` drives whatever
handler `onMessage` registered, the way a real message would, so a host test can start a turn
with no transport at all.
