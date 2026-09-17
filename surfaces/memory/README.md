# @harness/surface-memory

A messaging surface with no transport. It records what it was asked to post.

```bash
HARNESS_SURFACES=@harness/surface-memory pnpm approvals
```

That runs the whole approvals host — poller, decisions, dispatcher, health endpoint — against a
real database with no Slack workspace anywhere. Cards, replies and uploads are held in memory, so
what you can see from outside the process is the health endpoint and the `approvals` and
`tool_effects` rows: a poll tick fills in `surface = 'memory'`, `conversation_id = 'memory'` and a
`message_ref`, and a dispatch tick moves an effect to `dispatched` with
`result = { surface, conversation, message_id }`.

`MEMORY_ALLOWED_USERS` is a comma-separated list of user ids allowed to decide. Unset means
everyone — this is the only surface that may be open, and only because nothing it posts leaves the
process. An empty value means nobody, as on every other surface.

The session itself is `MemorySurface`, from `@harness/surface-api/testing`: the same class every
host test drives, so the adapter a developer runs and the fake the suite proves the host against
are one implementation.
