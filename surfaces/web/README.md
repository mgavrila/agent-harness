# @harness/surface-web

The surface a workspace talks to: chat, approval cards and forms over HTTP, for a tenant with no
Slack.

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

Every request carries `Authorization: Bearer <the tenant's token>`, compared in constant time. A
missing, malformed or wrong bearer is `401 {"error":"unauthorised"}` with a refusal the host audits
exactly once, decided before the body is parsed.

## The stream

Server-Sent Events, framed by this adapter and written by the host as opaque chunks:

```
id: <n>\nevent: <name>\ndata: <one JSON line>\n\n
```

`id` counts from 1 per conversation. Five events, two of which carry more than one payload — a
client discriminates on a key, not on the name:

| Event         | Payload                                                                     | Sent when                                                |
| ------------- | --------------------------------------------------------------------------- | -------------------------------------------------------- |
| `delta`       | `{ message, delta }`                                                        | a reply is being written                                 |
| `message`     | `{ message, text, replyTo }`, plus `file: { filename }` for a released file | a reply is complete                                      |
| `card`        | `{ message, card }`                                                         | an approval card is posted                               |
| `card`        | `{ form }`                                                                  | a dialogue is opened from a card's button                |
| `card_update` | `{ message, card }`                                                         | a posted card is edited in place                         |
| `notice`      | `{ message, text, replyTo }`                                                | the host said something _about_ a message                |
| `notice`      | `{ text, userId }`                                                          | a private note, for the workspace to route to one person |
| `notice`      | `{ text, dropped: true }`                                                   | a resume fell past the window                            |

Reconnect with `Last-Event-ID` and the stream resumes after that id; a resume past the window
opens with the `dropped` notice, which carries **no id**, so a client's resume point does not move
to an apology.

## What it does not do

It serves no file bytes, creates no conversation (writing to one creates it), lists none, and
reads no environment variable at all — its one credential is its tenant's, resolved by the host
through the deployment's secret source. `mention(userId)` is `@<userId>`: a display name is the
identity plug-in's answer, on every surface.
