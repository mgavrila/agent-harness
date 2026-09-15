# Operations runbook

Operational notes for running the agent harness against a real database. Everything
here is about the deployed system; local development uses the docker-compose
Postgres in `harness/compose/` and the single `harness` superuser-ish role.

## Database roles

Migrations run as the **table owner**. In development that is the `harness` role
created by docker-compose; in production it is a dedicated migration role that
owns every table in the harness schema.

The **application role** that the MCP server connects as must be a *different*
role with no ownership of any table. Ownership is what lets a role run
`ALTER TABLE ... DISABLE TRIGGER`, `DROP TRIGGER` or `DROP TABLE`, and the
append-only guarantee on `audit_log` rests on triggers the application must not
be able to remove. A role that merely holds `INSERT` and `SELECT` cannot disable
a trigger no matter what SQL it sends.

`audit_log` is append-only: the application inserts and reads, never updates or
deletes. Two triggers enforce this at the database level even for the owner —
`audit_log_no_update` (BEFORE UPDATE OR DELETE, per row) and
`audit_log_no_truncate` (BEFORE TRUNCATE, per statement). TRUNCATE needs its own
statement-level trigger because it does not fire row-level triggers.

```sql
-- Run once, as the migration/owner role, after migrations.
CREATE ROLE harness_app LOGIN PASSWORD 'change-me';

GRANT CONNECT ON DATABASE harness TO harness_app;
GRANT USAGE ON SCHEMA public TO harness_app;

-- Append-only: no UPDATE, no DELETE, no TRUNCATE, no ownership.
GRANT INSERT, SELECT ON TABLE audit_log TO harness_app;

-- Everything else is read/write but never destructive.
GRANT SELECT, INSERT, UPDATE ON TABLE
  providers, documents, fields, credentials, deadlines,
  approvals, runs, model_calls
TO harness_app;

-- `deadlines_compute` retires deadlines whose credential lost its expiry date,
-- so this one table also needs DELETE.
GRANT DELETE ON TABLE deadlines TO harness_app;
```

Do not add `GRANT ALL`, do not make `harness_app` the owner of any table, and do
not grant it `SUPERUSER` or `BYPASSRLS`. Verify after a deploy:

```sql
select grantee, privilege_type
from information_schema.role_table_grants
where table_name = 'audit_log' and grantee = 'harness_app';
-- expect exactly INSERT and SELECT
```

The test helper `resetDatabase` in `harness/db/src/testing.ts` does disable the
`audit_log` triggers in order to truncate between tests. That works only because
the test role owns the tables, and it is why the production application role
must not.

## Reading audit errors

The MCP `audit_query` tool deliberately never returns error text. A failure
message can contain record identifiers, provider names or values copied out of a
restricted field, and `audit_query` is callable by the agent. The tool reports
only `has_error: true`.

Operators read the messages directly with `psql`:

```sql
select tool, decision, error, created_at
from audit_log
where error is not null
order by created_at desc
limit 50;
```

Narrow to one client or tool when triaging:

```sql
select caller, tool, args_hash, error, created_at
from audit_log
where error is not null
  and client = 'demo-practice'
  and created_at > now() - interval '1 day'
order by created_at desc;
```

`args_hash` is a stable SHA-256 of the canonicalized arguments, so the same
logical call has the same hash across retries. Use it to group repeated
failures. The raw arguments are not stored in the audit log.

## What is not audited

The audit log covers calls that reach the policy wrapper. A call whose arguments
fail the tool's input schema is rejected by the MCP SDK *before* the tool
callback runs, so it never reaches the wrapper and leaves **no `audit_log` row**
at all — not even a `decision = 'error'` one. The caller still gets an error
result.

This matters when reconciling counts: a client that reports more attempted tool
calls than the audit log shows is most likely sending malformed arguments, not
losing audit writes. Malformed calls are visible only in the agent runtime's own
logs. Everything that gets past validation is audited, including calls that are
blocked by policy, parked for approval, or fail inside the handler.

### One call, two rows

The count can also run the other way. A successful handler writes its `auto` row
*inside* the transaction, and the wrapper writes an `error` row outside the
transaction when the call throws. A failing `COMMIT` can produce both.

Usually a failed `COMMIT` rolls the `auto` row back and only the `error` row
survives, which is correct. But when the commit succeeded on the server and only
the acknowledgement was lost (connection dropped at exactly that moment), the
`auto` row is durable *and* the driver raises, so the wrapper adds an `error` row
for the same call. `audit_log` is append-only, so neither row can be cleaned up.

Two rows with the same `client`, `tool` and `args_hash` moments apart, one `auto`
and one `error`, are therefore one call, not two. Check whether the handler's
writes actually landed before concluding the action was lost — with the commit
acknowledged or not, the `auto` row means the data is there.

## Effects outbox

External side effects (Slack messages, file uploads) are never sent from
inside a tool handler. The handler stages a row in `tool_effects` within its
transaction; a dispatcher sends staged rows after commit, keyed by
`idempotency_key`. Statuses: `staged` → `dispatching` → `dispatched`, or
`failed` after the retry limit, or `needs_review` when a dispatch never
reported completion. Rows in `needs_review` require a human to check the
sink (did the message arrive?) and then set the row to `dispatched` or
`cancelled` by hand:

```sql
select id, tool, sink, summary, attempts, last_error, result, updated_at
from tool_effects where status in ('failed','needs_review') order by updated_at;
update tool_effects set status = 'cancelled' where id = '<id>';
```

A `needs_review` row does **not** mean nothing was sent. It means the dispatcher
never reported back — the sink may well have delivered the message before the
process died. Always check the sink itself (did the Slack message arrive? does
the remote file exist?) before resolving the row, and never assume a re-send is
safe because the status is not `dispatched`.

`summary`, `last_error` and `result` are stored in **plaintext**. They must never
contain restricted values:

- `summary` is a short human label, truncated to 200 characters. Put the payer
  or the document kind in it, never a field value.
- `last_error` is the sink's error message, truncated to 500 characters. A sink
  must not include payload values in the messages it throws — an error like
  `rejected recipient 123-45-6789` would copy a restricted value into a column
  the audit tooling reads freely.
- `result` is whatever the sink returned on success (a message timestamp, a
  remote file id) so an operator can trace an effect to what it produced. A sink
  is responsible for returning identifiers only, never payload content.

Nothing drains the outbox yet. Plan 1.1 stages rows and provides
`dispatchStagedEffects`, but no sinks are registered and no scheduler calls it,
so staged rows simply accumulate until Plan 3 registers real sinks and a cron
runs the dispatcher.

## Reconciliation

`harness_reconcile` (also run once at process start) expires approvals past
their TTL and parks stuck dispatches. Run it on a schedule in production
(Plan 3 adds a cron playbook). It never re-sends anything.

The MCP tool repairs **only the calling client's rows**, so an agent acting for
one practice can never retire another practice's approvals. The startup pass in
`main.ts` runs **unscoped**, as an operator-level task across every tenant; when
it actually repairs something it writes one `audit_log` row with
`caller = 'startup'` and `tool = 'harness_reconcile'`.

## Session context

The MCP server keeps one session context (run id, skill, skill version) per
**process**, shared by every connection that process serves. That is correct for
the stdio deployment, where Hermes launches one `core-tools` process per session.

Anyone moving the server to a multi-session transport (HTTP) must build one
`deps` object per session. Reusing a single one would stamp one session's run id
and skill onto another session's audit rows.

## Writing migrations

Edit `harness/db/src/schema.ts` first, then run plain `pnpm drizzle-kit
generate` from `harness/db/` so drizzle-kit writes both the SQL migration and
the snapshot together. Hand-edit the generated SQL only for things drizzle-kit
cannot express (triggers, partial indexes), then run `generate` again and
confirm it reports "No schema changes" before committing.

Do not use `generate --custom` for a schema change: it writes an empty
migration file without advancing the snapshot, so drizzle-kit does not know
the schema changed. Migration `0003` needed its snapshot patched by hand
because of exactly this mistake. `--custom` is only for a migration with no
corresponding `schema.ts` change (e.g. a one-off data backfill).

## Model calls

Every gateway call inserts a `model_calls` row: run id, client, route, model,
token counts, and the USD cost LiteLLM reports in the `x-litellm-response-cost`
header. Use it to attribute spend to a run, a client or a route:

```sql
select route, model, count(*), sum(cost_usd)
from model_calls
where created_at > now() - interval '1 day'
group by 1, 2 order by 4 desc;
```

**This table is not the budget authority.** Two things make it undercount:

- The insert runs on the handle the tool handler was given, which is the
  handler's transaction. A handler that throws after a successful model call
  rolls the row back — the money was spent, the row is gone.
- A call made outside a tool handler (the eval runner's judge) writes a row
  with a null run id, and a call made by Hermes itself never reaches this
  process at all.

LiteLLM's own spend tables in the `litellm` database are what enforce
`max_budget`, and they are authoritative. When the two disagree, LiteLLM is
right. Reconcile with:

```sql
-- in the litellm database
select model, sum(spend) from "LiteLLM_SpendLogs"
where "startTime" > now() - interval '1 day' group by 1;
```

A `model route "extract" is over its daily budget` error means LiteLLM refused
the call, not that the harness declined to make it. Raise `daily_budget_usd` in
`clients/<name>/routing.yaml` and re-run `pnpm gateway:config && pnpm gateway:up`.

## Document pipeline

`documents_extract` does five things in one transaction: read the text, redact
it, prompt the `extract` route, upsert the provider, and write the redacted text
beside the document. If any step throws, none of them happened — including the
`documents.text_path` update, so a document with `text_path = null` has never
been successfully extracted.

Only redacted text is ever written to disk, whatever `HARNESS_RESTRICTED_TO_MODEL`
says. That flag governs the prompt, not the file.

`ocr_used = true` means the PDF had no usable text layer and every page went
through `pdftoppm` and `tesseract`. Expect lower field accuracy; the eval suite
scores that split separately for exactly this reason.

A document that fails with `unsupported document type` is neither a PDF nor a
recognised image. A document that fails with `tesseract is not installed` means
the host is missing the OCR binaries:

```bash
brew install tesseract poppler                      # macOS
apt-get install -y tesseract-ocr poppler-utils      # Debian
```

## Evals

`pnpm evals` runs the real toolset in-process against the `harness_evals`
database, which it **truncates between every case**. Never point
`EVALS_DATABASE_URL` at a database anyone else is using.

The run exits non-zero on a regression against `evals/baseline.json` or on an
injection case that did not hold. `docs/promotion-gate.md` is the rule; the
report names which metric moved and by how much.

`EVALS_SERVING_MODEL` is a JSON object of route to model identifier, and it is
what lands in the report's `serving_model`. Set it from the routing table the
run actually used; a score with no model behind it is not comparable to
anything.

The judge is off on the CLI path (`judgeDeps: null`), so a CLI run scores every
free-text field exactly and reports `judge: null`. The judge needs a second
database handle and a session the CLI does not have; Plan 3 wires it up when
Hermes supplies one. `evals/src/run.test.ts` exercises the judge end to end
against the fake gateway.

### Which model a `model_calls` row names

`model_calls.model` records the **route alias** LiteLLM echoes back — `extract`,
`judge` — not the underlying deployment that served the call. Per-provider cost
attribution needs the deployment, which LiteLLM returns in the
`x-litellm-model-id` response header; recording that header is a later change,
and until then the deployment behind a route is whatever
`clients/<name>/routing.yaml` said at the time of the run.
