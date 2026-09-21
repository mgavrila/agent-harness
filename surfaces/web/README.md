# @harness/surface-web

The surface a workspace talks to: chat, approval cards and forms over HTTP, for a tenant with no
chat transport of its own.

```yaml
# in a client document
surfaces:
  web:
    token: { ref: web-token } # or { env: WEB_TOKEN }
    inbox: inbox # optional; this is the default
```

`web` is first in `SURFACE_ORDER`, so a document that declares it has it as the primary surface and
its approval cards go to `inbox`. It opens nothing: the host mounts its door at
`/tenants/<clientId>/web/...` and hands over what arrives.

## The four routes

| Method and path                       | Body                                                             | Answers                                                        |
| ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| `POST …/web/messages`                 | `{ userId, conversation, text, attachments?: [{ name, path }] }` | `202 {"message": MessageRef}`; the reply arrives on the stream |
| `GET …/web/conversations/<id>/events` | —                                                                | `202`, `text/event-stream`, an open stream                     |
| `POST …/web/actions`                  | `{ userId, actionId, value, messageRef }`                        | `202 {}`                                                       |
| `POST …/web/forms`                    | `{ userId, formId, values, messageRef }`                         | `202 {}`                                                       |

A `MessageRef` is `{ surface: "web", conversation, id }`. It is what the door answers a message
with, what every frame carries, and what a button press or a form submission names back.

## What a client must know

**The bearer authenticates the platform, not the person.** Every request carries
`Authorization: Bearer <the tenant's token>`, compared in constant time before anything else is
looked at. One token belongs to one tenant and opens every conversation of it. `userId` is taken
from the request body as given: **the workspace must authenticate the person before it calls**,
and this surface trusts what it is told. The mitigation on the other side is that a principal
minted by `identity.defaults.web` is capped at `practitioner`, so a leaked token can speak but can
decide no approval — deciding needs `lead`.

**Identity is resolved after the door has answered.** The door replies `202` and runs the turn
afterwards, so a `userId` the tenant's identity plug-in does not know is not a `4xx`: the refusal
arrives on the conversation's stream as a `notice` ("You are not authorised to use this
assistant."). The same is true of an approval decision by somebody who is not an approver, which
comes back as a private `notice` naming that user.

**A posted message is not echoed onto the stream.** The caller gets its `MessageRef` in the `202`
and nothing else; the workspace renders what it sent. What comes back on the stream is the
assistant's side of the conversation.

**A conversation is created by writing to it.** There is no route that creates one and none that
lists them. An id must match `CONVERSATION_ID_PATTERN` — a letter or digit, then up to 127 of
`A-Za-z0-9:_@.-` — on both the message route and the stream route.

**Attachments are staged by the platform, not uploaded here.** `path` is relative to this tenant's
`<storageDir>/incoming`, the directory the run API stages into; anything resolving outside it,
lexically or through a symlink, is refused, and the tenant's storage root itself is not a file.
This surface serves no file bytes back either: a released file arrives as a `message` frame naming
it, and fetching it is the platform's business.

### Caps

| What                                                    | Limit                                                    |
| ------------------------------------------------------- | -------------------------------------------------------- |
| Request body                                            | 1 MiB (the host's, shared by every surface) → `413`      |
| `text`                                                  | 10,000 characters                                        |
| `userId`, `actionId`, `formId`, `value`, `conversation` | 200 characters                                           |
| `attachments`                                           | 10 entries; `name` 255, `path` 512 characters            |
| Frames retained per conversation                        | 200, in memory, per host, dropped when the tenant closes |

The number of conversations a tenant may open is not capped. The caller is the tenant's own
workspace, holding a bearer only the control plane has.

## Refusals

| Status | Body                                                                   | When                                                                                    |
| ------ | ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `401`  | `{"error":"unauthorised"}`                                             | a missing, malformed or wrong bearer; audited once, decided before the body is parsed   |
| `400`  | `{"error":"the request body is not JSON"}`                             | the body is not a JSON object                                                           |
| `400`  | `{"error":"userId is required"}` and the like                          | a field is missing, empty, over its cap or the wrong type                               |
| `400`  | `{"error":"attachment 2 is not a path inside the incoming directory"}` | an attachment path resolves outside `incoming`                                          |
| `400`  | `{"error":"that form is not open on this surface"}`                    | a submission names a card this session opened no such form on, or one already submitted |
| `404`  | `{"error":"no such route"}`                                            | a sub-path below the mount that no route claims                                         |
| `405`  | empty, with `Allow: GET` or `Allow: POST`                              | a known route, the wrong method                                                         |
| `413`  | `{"error":"a request body may be at most 1048576 bytes"}`              | the host's cap, before this surface sees the request                                    |

Only the `401` is audited, and it repeats nothing of the request: not the header, not the body, not
the path. No refusal body echoes anything the caller sent.

A button press on a card this host never posted is **not** an error: it is delivered, and the
handler that does not recognise it says so on the stream. A form submission is different, because
the dialogue's metadata is what names the thing being decided — an unknown one is refused rather
than delivered as a submission about nothing.

## The stream

Server-Sent Events, framed by this adapter and written by the host as opaque chunks:

```
id: <n>\nevent: <name>\ndata: <one JSON line>\n\n
```

`id` counts from 1 **per conversation**, so two pages of the workspace resume independently. A
comment line, `: keep-alive\n\n`, goes out on an idle stream every 15 seconds and is not a frame.
Five events, two of which carry more than one payload — a client discriminates on a key, not on the
name:

| Event         | Payload                                                                     | Sent when                                                |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `delta`       | `{ message, delta }`                                                        | a reply is being written                                 |
| `message`     | `{ message, text, replyTo }`, plus `file: { filename }` for a released file | a reply is complete                                      |
| `card`        | `{ message, card }`                                                         | an approval card is posted                               |
| `card`        | `{ message, form }`                                                         | a dialogue is opened from a button on that card          |
| `card_update` | `{ message, card }`                                                         | a posted card is edited in place                         |
| `notice`      | `{ message, text, replyTo }`                                                | the host said something _about_ a message                |
| `notice`      | `{ text, userId }`                                                          | a private note, for the workspace to route to one person |
| `notice`      | `{ text, dropped: true, reason }`                                           | a resume could not be honoured (below)                   |

A form's frame carries the `message` of the card it was opened from: that is what the submission
sends back as `messageRef`, and two dialogues open on two cards in one conversation are told apart
by it. A dialogue is answered once; a second submission of the same form on the same card is
refused.

### Opening, resuming, and reconnecting

**A fresh open replays the whole retained window.** `GET …/events` with no `Last-Event-ID` starts
at `id: 1` — or at the oldest frame still held — and then goes live. There is no marker between
history and live; a client that has rendered a conversation already resumes instead.

**Resuming** means sending `Last-Event-ID: <n>` (a browser's `EventSource` does it by itself), and
the stream carries on after `n`.

**A resume this host cannot honour** opens with one `notice` frame carrying `dropped: true` and a
`reason`, **and no `id:` line** — so a client's resume point never moves to an apology — followed
by the whole retained window, exactly as a fresh open. The reasons:

| `reason`  | Meaning                                                  |
| --------- | -------------------------------------------------------- |
| `window`  | the id is older than the oldest frame still held         |
| `unknown` | this host has never written to that conversation         |
| `ahead`   | the id is ahead of everything that conversation has here |

The last two are what a client sees after this host restarted, after the tenant's document was
edited (which closes every open stream and reopens the tenant), or when an ingress sent the
reconnection to a different host. The window is per host and in memory, so a workspace that needs
the whole history reads it from the run API and uses the stream for what happens next.

**A stream ends** when the client goes away, or when the tenant's session stops — a document edit,
a shutdown. The response simply ends; the client reconnects and is told, as above.

## What it does not do

It serves no file bytes, creates no conversation by request, lists none, and reads no environment
variable at all — its one credential is its tenant's, resolved by the host through the deployment's
secret source. `mention(userId)` is `@<userId>`: a display name is the identity plug-in's answer, on
every surface.
