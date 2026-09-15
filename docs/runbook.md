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

## Storage

`HARNESS_STORAGE_DIR` is the root of the file store. Generated output — filled
forms and rosters — lives under `<dir>/out`, and nothing else writes there.
File ids are relative paths inside that tree and are content-addressed: the
same bytes always produce the same id, which is what makes `forms_release`
idempotent.

`resolveOutFile` refuses an absolute path or any id containing `..`, so a file
id that reaches the tools from a model cannot name a file outside the tree.

In Compose, the same named volume is mounted into the `hermes` container (where
the core-tools child writes the file) and the `approvals` container (where the
Slack sink reads it). If a file upload fails with ENOENT, the two mounts have
drifted apart — check both services' `volumes:` entries before anything else.

Storage isolation is per process, not per request: a core-tools process is
started with one `HARNESS_STORAGE_DIR` and one `HARNESS_CLIENT`, and that scopes
every file it reads or writes for as long as it runs. One core-tools process
never serves two clients, so there is no per-call tenant check on file paths —
the isolation comes entirely from which process, and which storage root, a
given client's traffic is routed to.

## The Slack approvals app

`@harness/approvals` is the only writer of approval decisions and the only
caller of `approvals_execute`. It runs three loops:

| Loop | Default | What it does |
|---|---|---|
| poll | 5s | posts a Block Kit card for every `pending` approval with no `slack_ts` |
| dispatch | 5s | drains `tool_effects` through the `slack_message` and `slack_file` sinks |
| reconcile | 300s | calls `harness_reconcile` through the core-tools MCP server |

Reconciliation goes through MCP rather than calling the helper directly, so the
repair is scoped to the client and lands in `audit_log` like any other call.
The app has no privileged route into the data.

**Run one approvals app per client.** The poller claims each row before it
posts, by setting `slack_channel` under a guard on the row still being
`pending` with `slack_channel IS NULL`. Only one claim can win that guard, so
two pollers never both post a card for the same approval; the loser's update
affects zero rows and it logs the row as `orphaned`.

A claim can outlive the process that took it, so a claim older than two
minutes that never got a `slack_ts` is released at the top of the next run and
the row is posted again. There is no `claimed_at` column; `created_at` stands
in for it.

Two failure points sit either side of the post and are handled differently.
A post that fails releases the claim, so the next run retries immediately. A
post that succeeds but whose `slack_ts` write fails keeps the claim, because
the card is already in the channel and releasing it would put a second one
beside it; that row waits for the two-minute sweep. A line in the log reading
"posted the card … but could not record its timestamp" is that case.

`SLACK_ALLOWED_USERS` is required and fail-closed: with it unset or empty, the
app refuses every decision. There is no default allowlist and no bypass —
missing or empty means no Slack user can approve, reject, or edit anything,
not that everyone can.

**Slack credentials: two apps are required.** Not a hardening recommendation —
one app does not work. Slack delivers each Socket Mode event to exactly one of
an app's open connections, which is what makes rolling restarts possible. With
the Hermes gateway and the approvals app both connected on one
`SLACK_APP_TOKEN`, roughly half of every `block_actions` and `view_submission`
payload goes to Hermes, which has no handler for the approval buttons or the
note modal. Those clicks do nothing at all: the approval stays `pending` and
the approver has no signal other than pressing again.

| App | Variables | Bot scopes | Other settings |
|---|---|---|---|
| Hermes gateway | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `users:read`, `files:read`, `files:write` | Socket Mode on |
| Approvals app | `APPROVALS_SLACK_BOT_TOKEN`, `APPROVALS_SLACK_APP_TOKEN` | `chat:write`, `users:read`, `files:write` | Socket Mode on, Interactivity on |

The approvals app has no fallback to the Hermes variables. A fallback would
make the broken configuration the default again and fail intermittently
instead of at startup, so both `APPROVALS_SLACK_*` variables are required and
the process refuses to start without them.

Compose keeps the two sets apart. The `approvals` service has no `env_file`:
it gets an explicit `environment:` allowlist interpolated from `.env`, so
Hermes's tokens never enter that container. In the other direction the
`hermes` service blanks `APPROVALS_SLACK_*` over what `env_file` brought in,
and `hermes-init` strips those lines out of the `.env` it copies to
`$HERMES_HOME/.env`. Approval decisions are gated by `SLACK_ALLOWED_USERS`
regardless of which token is present.

Health is on `http://127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}/healthz` on the host (container port 8787, `APPROVALS_HEALTH_PORT`). It returns counts
and loop timestamps only, never a summary or a payload, because anything
reachable over HTTP is outside the audit trail. It answers 503 when an effect
has failed or is parked, or when a loop recorded an error.

Inside the container the server binds every interface (`APPROVALS_HEALTH_BIND`,
default `0.0.0.0`). That is not the exposure boundary: the Compose port mapping
is, and it is pinned to `127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}:8787`, so
the endpoint is reachable from the operator's own machine and from the Compose
network, and from nowhere else. A container-loopback bind would answer neither —
Docker's port publish DNATs to the container's bridge address, and Hermes
reaches the same address at `http://approvals:8787/healthz`. Set
`APPROVALS_HEALTH_BIND=127.0.0.1` only for a bare-metal run, where the process
itself is the boundary. Both watchdog scripts default to
`http://approvals:8787/healthz` and read `APPROVALS_HEALTH_URL` to override it,
which is how they are pointed at `http://127.0.0.1:8787/healthz` for a manual
check outside Compose.

Restricted values are kept out of Slack in three places, on purpose:

1. Tools redact `approvals.payload` when they park a request.
2. `payloadPreview` re-checks the rendered payload against the SSN, EIN and DEA
   patterns and withholds the whole block on a match.
3. `harness_notify` refuses a message that trips the same patterns before it
   ever reaches the outbox.

A withheld payload in a card is not a bug to route around. It means something
wrote a restricted-looking value where it should not be; read the audit row.

## Onboarding a client

`pnpm new-client --pack <pack> --name <slug>` scaffolds `clients/<slug>/`. It
does not make that client runnable on its own — the Compose file still names
`demo-practice` — so finish by hand:

1. `cp clients/<slug>/.env.example .env` and fill it in, with
   `HARNESS_CLIENT=<slug>` and a storage directory this client does not share.
2. Create the two Slack apps described under **Slack credentials** above and
   paste both pairs of tokens.
3. Review `clients/<slug>/SOUL.md` and `policy.yaml` before the first run.
4. Point Compose at the client: in `harness/compose/docker-compose.yml`, the
   `hermes-init` bind mount `../../clients/demo-practice:/srv/client:ro`, and
   the `HARNESS_POLICY_FILE` value on both the `hermes` and the `approvals`
   service. Three occurrences of `demo-practice` in total.
5. Start it under its own Compose project so it does not collide with another
   client's containers and volumes:
   `COMPOSE_PROJECT_NAME=<slug> docker compose -f harness/compose/docker-compose.yml --profile demo up -d --build`.

Do **not** use `pnpm demo:up` for a new client. It runs the default Compose
project with the `demo-practice` paths above, so it starts demo-practice
whatever `HARNESS_CLIENT` says.

## Playbooks

Three jobs run in the Hermes cron fleet. Install or repair them with:

```bash
docker compose -f harness/compose/docker-compose.yml exec hermes \
  bash /opt/data/cron/playbooks.sh
```

The script is idempotent: a job whose name already exists is left alone.

| Job | Schedule | Mode | Silence |
|---|---|---|---|
| `credentialing-expirations` | `0 7 * * *` | agent, skill-backed | replies `{"wakeAgent": false}` when nothing is due |
| `harness-outbox-watchdog` | `*/15 * * * *` | `no_agent` script | empty stdout |
| `harness-reconcile-watchdog` | `17 */6 * * *` | `no_agent` script | empty stdout |

The expirations job delivers `local`: the skill stages its own message with
`harness_notify`, so the digest is audited, carries `derived_from` back to the
`deadlines_upcoming` query, and is sent exactly once per continuity key. A
digest for the same bucket and count as last night is staged again, hits the
unique index on `tool_effects.idempotency_key`, and sends nothing.

The record format of `~/.hermes/cron/jobs.json` is not documented, so jobs are
only ever created through `hermes cron create`. The init container seeds that
file when it is absent and never overwrites it, so Hermes's own writes to it
(next run times, run history) survive a redeploy.

Diagnose a fleet that has gone quiet with `hermes cron doctor` inside the
container: it flags a missing script, a job parked in the past, and a delivery
that failed after the job succeeded.
