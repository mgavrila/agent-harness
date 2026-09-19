# @harness/config-postgres

A `ConfigSource` over versioned rows: every document written here is recorded as a version, so a
change is reviewable and a rollback is a write rather than an edit. `client_documents` holds one
live row per client — what a host loads — and `client_document_versions` is where the history
piles up. `watch` polls the version column rather than listening on a Postgres notification,
because a host cannot hold a notification across a restart and a poll that missed nothing is
cheaper than a tenant served a document nobody can name.
