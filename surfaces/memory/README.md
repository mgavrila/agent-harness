# @harness/surface-memory

A messaging surface with no transport. It records what it was asked to post.

```bash
HARNESS_SURFACES=@harness/surface-memory
```

That is the value a developer running the host (Plan 8's) with no Slack workspace sets on
`HARNESS_SURFACES`. Cards, replies and uploads are held in memory, so what you can see from
outside the process is the health endpoint and the `approvals` and `tool_effects` rows: a poll
tick fills in `surface = 'memory'`, `conversation_id = 'memory'` and a `message_ref`, and a
dispatch tick moves an effect to `dispatched` with `result = { surface, conversation, message_id }`.

There is no allowlist here any more. Who may decide an approval is the identity plug-in's answer,
resolved from the surface user id on whichever surface the card was posted on — the same rule on
this surface as on every other one.

The session itself is `MemorySurface`, from `@harness/surface-api/testing`: the same class every
host test drives, so the adapter a developer runs and the fake the suite proves the host against
are one implementation. It also has an inbound half: `say(userId, text, over?)` drives whatever
handler `onMessage` registered, the way a real message would, so a host test can start a turn
with no transport at all.
