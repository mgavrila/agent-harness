# @harness/surface-api

The contract between `@harness/host` and a messaging surface. A surface is Slack today,
Telegram or Microsoft Teams tomorrow; the host is written against this package and never
against one of them. `@harness/approvals` is a library the host composes, not a separate
loader — `loadSurfaces` lives there, but it is the host that calls it.

It depends on `@harness/shared` and zod and on nothing else in the workspace, which is what lets
the host load an adapter by name at runtime instead of importing it at build time.

| Module           | Holds                                                                                        |
| ---------------- | -------------------------------------------------------------------------------------------- |
| `src/types.ts`   | every declaration: `Card`, `Form`, `MessageEvent`, `MessageRef`, `SurfaceSession`, `Surface` |
| `src/surface.ts` | `defineSurface`                                                                              |
| `src/models.ts`  | the zod shapes of the two outbox payloads, and the two id patterns                           |
| `src/testing.ts` | `MemorySurface`, reached as `@harness/surface-api/testing`                                   |

`SurfaceDeps` is what an adapter is handed when it connects: `env`, `log`, `storageDir`, an
optional `tenantKey`, and two more optional fields the host resolves before an adapter ever sees
them and never itself reads — `secretValues`, this tenant's credentials for this surface already
resolved to their values, keyed by the document's own field name, and `defaultConversation`, the
conversation the client's document named as this surface's default when nobody names one. Both are
opaque to the host: it copies them from the document into the bag and moves on.

A session may also offer `health()`: a **synchronous, non-throwing** `{ live, detail? }` read off
what the adapter already knows, which `GET /v1/status` reports one line of per loaded surface. It
never calls the outside world — the route is a dashboard's poll — and `detail`, when there is one,
is a fixed sentence the adapter wrote. A session that offers none is reported live.

`MemorySurface` is both the fake every host test drives and the whole of `@harness/surface-memory`,
so the thing the suite proves the host against is the thing that runs. It is also the first
_inbound_ surface: `say(userId, text, over?)` drives whatever handler `onMessage` registered, the
way a real message would, so a host test can start a turn without a transport.

An adapter declares what it can do beyond posting, and the host reads those flags rather than
trying and catching:

| Surface            | forms                  | privateReply                    | update | streaming | inlineConfirm |
| ------------------ | ---------------------- | ------------------------------- | ------ | --------- | ------------- |
| `slack`            | yes (a modal)          | yes (ephemeral)                 | yes    | yes       | no            |
| `memory`           | yes                    | yes                             | yes    | yes       | no            |
| Teams (planned)    | yes (a task module)    | no — post in the thread instead | yes    | no        | no            |
| Telegram (planned) | no — there is no modal | no                              | yes    | no        | no            |

`streaming` is what makes `startStream` work; off, the host posts a whole reply in one call.
`inlineConfirm` is unused until a surface has it: a card whose buttons sit in the conversation the
question was asked in, rather than needing a separate approvals surface.

Every method rejects with a `SurfaceError` whose message is safe for a plaintext column.
`postCard` has one more: `SurfaceAcceptedError`, thrown when the transport took the card and
answered with nothing to address it by. It says a card is live, so a host holding a claim on the
row keeps it instead of posting a second one.

## Being reached by a request

A surface that does not open its own connection offers `http`: a mount path and a handler. The
host mounts it at `/tenants/<clientId>/<path>` on the server it already runs for the run API,
resolves the tenant from that path, and calls `handle` with the method, whatever is left of the
path, the lower-cased headers and the raw body — unparsed, because a signature is computed over
the bytes that arrived.

Whatever authenticates the request is the surface's own business: the host cannot check a
transport's signature without knowing the transport. What the host does do is audit. A response
carrying `refusal: { reason }` is written to `audit_log` exactly once, as `surface_request` /
`refused`, with the reason and nothing of the body. `reason` is a short token
(`SURFACE_REFUSAL_REASON_PATTERN`), never a sentence, because it is a column an operator groups
by.

`MemorySurface.mountHttp()` is the reference implementation, and it is off until it is called:
this surface authenticates nobody, so a door to it is a door to speaking as anyone.

### Answering with a stream

`SurfaceHttpResponse.body` is a string **or** an async iterable of strings. A string is sent in one
write and the response ends. An iterable is a stream: the host writes the head, writes each chunk
as it is yielded — waiting for the socket to drain, or for the client to go away — and ends the
response when the iterable ends. A chunk is opaque to the host, so an adapter keeps every byte of
its own framing: Server-Sent Events, NDJSON, anything.

Two request fields exist for it. `signal` is aborted when the caller goes away, and a producer
selects on it and returns rather than pushing frames into a dead socket. `clientId` is the tenant
the host resolved from the mount path, which is what an adapter reports as an event's
`tenantHint`: it cannot disagree with the route the request actually took.

A **refusal is decided before the first byte**. The host reads `refusal`, writes its one audit row
and then writes the head; after that the response is a stream and there is nothing left to
declare. An adapter that discovers a problem mid-stream says so in its own frames and ends. A
throw out of the iterable is logged and closes the response, with no error frame — the vocabulary
is the adapter's, not the host's.

`MemorySurface`'s door is the reference: `POST <mount>` takes a message, and
`GET <mount>/events` answers a stream with `id:` on every frame and honours `last-event-id`. It
answers `200` where a real adapter may prefer `202` — `@harness/surface-web` does, and so does the
run API's own stream, because "accepted, and what follows is the thing happening" is the truer
reading. The seam fixes neither: the status is the adapter's, like every other byte of its answer.

Authorisation is not this package's business. Who may act — decide an approval, or have a
message answered — is the identity plug-in's answer (`@harness/identity-api`), resolved from a
surface user id on the surface a message or a button press arrived on. There is no allowlist
here to be empty or wildcarded.

`CONTRIBUTING.md`, "Adding a surface", is the worked how-to.
