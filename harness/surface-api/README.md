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

`MemorySurface` is both the fake every host test drives and the whole of `@harness/surface-memory`,
so the thing the suite proves the host against is the thing that runs. It is also the first
_inbound_ surface: `say(userId, text, over?)` drives whatever handler `onMessage` registered, the
way a real message would, so a host test can start a turn without a transport.

An adapter declares what it can do beyond posting, and the host reads those flags rather than
trying and catching:

| Surface            | forms                  | privateReply                    | update | streaming | inlineConfirm |
| ------------------ | ---------------------- | ------------------------------- | ------ | --------- | ------------- |
| `slack`            | yes (a modal)          | yes (ephemeral)                 | yes    | no        | no            |
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

Authorisation is not this package's business. Who may act — decide an approval, or have a
message answered — is the identity plug-in's answer (`@harness/identity-api`), resolved from a
surface user id on the surface a message or a button press arrived on. There is no allowlist
here to be empty or wildcarded.

`CONTRIBUTING.md`, "Adding a surface", is the worked how-to.
