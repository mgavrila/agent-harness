# @harness/config-postgres

A `ConfigSource` over versioned rows: every document written here is recorded as a version, so a
change is reviewable and a rollback is a write rather than an edit. `client_documents` holds one
live row per client — what a host loads — and `client_document_versions` is where the history
piles up. `watch` polls the version column rather than listening on a Postgres notification,
because a host cannot hold a notification across a restart and a poll that missed nothing is
cheaper than a tenant served a document nobody can name.

**A rewritten version is refused.** Writing `(client_id, version)` again with content that differs
from what is already stored raises a `ConfigError` naming the client and the version; writing the
same content again is a no-op. A version string identifies one document, so a rewrite with
different content would move the live row and leave the history saying something else happened —
write a new version instead, ideally a content hash, and the case cannot arise.

A `SecretSource` lives here too: `postgresSecretSource` resolves a document's `{ ref: name }`
against `client_secrets` — `(client_id, name)`, encrypted with `HARNESS_ENCRYPTION_KEY` — and still
answers `{ env: NAME }` from the process environment, because an `{ env }` reference means the
environment under every source. `writeClientSecret(db, { clientId, name, value }, key)` is the
writer: an insert, or an update in place when the row already exists, which is what a rotation is.
See `docs/runbook.md`, "The client store as a write contract" and "Secrets from a store", for the
column contract and the envelope every writer — including this one — keeps to.
