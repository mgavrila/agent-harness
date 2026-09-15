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
select id, tool, sink, summary, attempts, last_error, updated_at
from tool_effects where status in ('failed','needs_review') order by updated_at;
update tool_effects set status = 'cancelled' where id = '<id>';
```

## Reconciliation

`harness_reconcile` (also run once at process start) expires approvals past
their TTL and parks stuck dispatches. Run it on a schedule in production
(Plan 3 adds a cron playbook). It never re-sends anything.

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
