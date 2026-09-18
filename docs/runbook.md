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
  records, documents, fields, attachments, deadlines,
  approvals, runs, model_calls, tool_effects,
  memory_entries, playbooks, playbook_runs, threads, messages
TO harness_app;

-- `deadlines_compute` retires deadlines whose attachment lost its expiry date,
-- and `memory_remove` forgets an entry, so these two tables also need DELETE.
GRANT DELETE ON TABLE deadlines, memory_entries TO harness_app;
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
message can contain record identifiers, record names or values copied out of a
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

`caller` is the principal id since Plan 7 — `u-…` for a person, `svc-…` for a service — so a
row's `caller` and its run's `principal_id` always agree. A row written before migration 0010
keeps its old caller string — a bare service name rather than a principal id, e.g.
`approvals-app` or `eval-runner` — and that migration's backfill copied that same string into
the run's `principal_id` verbatim, so the two still agree on old rows too.

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

External side effects (messages on a surface, file uploads) are never sent from
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
process died. Always check the sink itself (did the message arrive on the
surface? does the remote file exist?) before resolving the row, and never assume a re-send is
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

The host drains the outbox. `startRunner`
(`harness/approvals/src/domain/runner.ts`) runs a `dispatch` loop every
`EFFECTS_DISPATCH_SECONDS` seconds (default 5) that calls
`dispatchStagedEffects` over the `surface_message` and `surface_file` sinks
`@harness/host`'s `main.ts` registers. Each tick is guarded against overlapping itself, and a
failure is logged and swallowed, so an outage on one surface never crashes the loop: the
next tick retries each effect until `maxAttempts` (default 3) is reached, after
which the effect is marked `failed` and waits for a human, as described above.
A backlog of `staged` rows between ticks is normal and does not fail `/healthz`.

A dispatch that never reported back is caught by the host's third loop, which
runs every `RECONCILE_SECONDS` seconds (default 300) and calls
`harness_reconcile` through the MCP server, parking a dispatch older than ten
minutes as `needs_review`. So staged rows accumulating is *not* expected
behaviour: if they do, the host is not running, its dispatch loop is
erroring (check `/healthz` and the log), or the rows belong to a different
`client` than the host serves.

## Reconciliation

`harness_reconcile` expires approvals past their TTL and parks stuck dispatches.
It never re-sends anything. A scheduled watch beyond that loop can be a
playbook (see "Playbooks"); none ships.

**The deployed stack reconciles in one place only: the host's loop, every
`RECONCILE_SECONDS` (default 300).** The MCP tool repairs **only the calling
client's rows**, so an agent acting for one practice can never retire another
practice's approvals, and the host calls it as its own service principal for the
client it serves. When it repairs something it writes one `audit_log` row with
`caller` set to that principal (`svc-host` in the shipped configs) and
`tool = 'harness_reconcile'`.

There is a second, **unscoped** pass — an operator-level sweep across every
tenant — but it runs at the start of the stdio core-tools server, which Compose
no longer starts. It reaches a developer running that server by hand and nothing
else, so do not expect another client's stale rows to be repaired by the running
stack.

Nothing reconciles `runs`. A row left `running` is a process that died mid-turn:
the host's own shutdown drains the turns in flight and closes their rows, so a
`running` row with an old `started_at` means the process was killed rather than
stopped.

## Runs and principals

The stdio server (the MCP inspector, the eval runner) acts as exactly one principal —
`HARNESS_PRINCIPAL`, an id declared in `clients/<name>/identity.yaml` — and opens exactly one
`runs` row for its whole life. `@harness/host` is different: it opens one `runs` row per
conversation turn, as whichever principal the identity plug-in resolved for that message's
sender, and one more for every approval it executes or reconciles, as the approver's or the
host's own service principal. Every `audit_log`, `tool_effects`, `model_calls`, `threads` and
`messages` row a run touches points at its `runs.id`. `runs.status` (`running` → `done` | `error`
| `cancelled`) records how a run ended; `runs.caller` is gone — `runs.principal_id` is the only
column that says who a run acted as, and it always agrees with `audit_log.caller` on that run's
rows. A run whose principal the identity file does not declare never opens.

Who is who in the demo: `svc-host` is the host's own identity (`HARNESS_HOST_PRINCIPAL`,
default `svc-host`): reconciliation runs as it. `svc-playbooks` is the identity the scheduled
playbooks run as — each entry of `playbooks.yaml` names its own service principal, and the
demo's names this one. `svc-local` is the stdio server on an operator's machine (the default). The two humans are
`u-practice-manager` (`admin`) and `u-coordinator` (`lead`). On the host's own surfaces — the
ones `HARNESS_SURFACES` names — every message from a person runs as that person's own
principal: the identity plug-in resolves the surface user id before the turn starts, and an
unresolved sender gets one refusal and no run at all.

A multi-run host builds one `KernelConfig` and calls `openRun` and `depsForRun` per run; it
must never reuse one `ToolDeps` across runs, or one run's id would be stamped on another's rows.

A parked approval's policy re-check at replay time uses the level the action was parked under,
not the replaying principal's own level, with one exception: a row parked before that level was
recorded falls back to the replaying principal's level. Since Plan 8 the replaying principal is
the approver — `createInProcessCoreToolsClient` opens the execution as whoever decided the
approval, always at least `lead` — so that fallback never wrongly blocks or permits an action on
a level the original requester never held; a policy tightened after the row was parked still
applies, because the check reads the *current* policy at the parked (or fallback) level, not
whatever the policy said when the row was created.

To see what a run did:

```sql
select r.id, r.principal_id, r.surface, r.conversation, r.started_at,
       count(a.id) as calls, count(a.id) filter (where a.decision = 'blocked') as blocked
from runs r left join audit_log a on a.run_id = r.id
where r.started_at > now() - interval '1 day'
group by r.id order by r.started_at desc;
```

## Threads and messages

`threads` is one row per `(client, surface, conversation, principal)` — two people in one
channel get two threads — and `messages` is every turn on one, `role` `user` | `assistant` |
`host` (the last is the resume notice a decided approval writes). Both are the kernel's own
record, independent of whatever a runtime checkpoints for itself in schema `langgraph`.

```sql
select role, principal_id, content, created_at
from messages
where thread_id = '<id>'
order by created_at desc
limit 10;
```

`content` is plaintext, so `appendMessage` runs the same restricted-pattern guard the rest of the
harness does before every insert: a value that trips it is stored as
`(withheld: it did not pass the redaction check)` rather than the value itself, and the host
posts the same marker to the surface instead of the model's own text when that text trips it
(invariant 10). A row carrying that marker is not a bug to route around — it means something
wrote a restricted-looking value where it should not have; read the audit row.

`messages.seq` numbers every row in insertion order; `created_at` is the statement clock and two
rows one transaction writes share it, so `seq` is the tiebreak the host and `session_search`
order by. Playbook threads are `kind = 'playbook'`, one per playbook, conversation
`playbook:<name>`, owned by the playbook's service principal.

## Writing migrations

Edit `harness/db/src/domain/schema.ts` first, then run plain `pnpm drizzle-kit
generate` from `harness/db/` so drizzle-kit writes both the SQL migration and
the snapshot together. Hand-edit the generated SQL only for things drizzle-kit
cannot express (triggers, partial indexes), then run `generate` again and
confirm it reports "No schema changes" before committing.

Do not use `generate --custom` for a schema change: it writes an empty
migration file without advancing the snapshot, so drizzle-kit does not know
the schema changed. Migration `0003` needed its snapshot patched by hand
because of exactly this mistake. `--custom` is only for a migration with no
corresponding `schema.ts` change (e.g. a one-off data backfill).

### Migration 0008 and the record model

`0008_generic_records` replaced `providers` and `credentials` with `records` and `attachments`,
re-keyed `fields`, `documents` and `deadlines` onto them, and copied the healthcare rows across
inside the same file. It is the one migration in the tree with a hand-written data section,
bracketed by `-- harness:data-section:begin` and `-- harness:data-section:end`.
`harness/db/src/domain/migration-0008.test.ts` replays the shipped file, statement by statement,
over a fixture of the pre-0008 schema and asserts the row counts and two decrypted values. It
does that in a scratch database of its own, `harness_test_migration_<pid>`, created and dropped
around the run, so it never touches `harness_test`.

**Primary keys were preserved on purpose.** `deadlines_upcoming` returns a `digest_key` that is
a hash over `<attachment id>:<deadline kind>:<bucket>` triples, and a playbook passes it
straight through as `harness_notify`'s idempotency key. A new id would have changed every key,
and every nightly digest would have been sent a second time on the first run after the
migration.

**There is no down migration and there will not be one.** The two tables are dropped after the
copy, so a reverse would have to invent the `pack`/`kind` split back out of `records` and would
lose any row a second pack wrote in the meantime. If `0008` has to be undone, restore the
database from a backup taken before it ran, as the migration role described under "Database
roles".

### Migration 0009 and surface addressing

`0009_surface_addressing` replaces `approvals.slack_channel` and `slack_ts` with `surface`,
`conversation_id` and `message_ref`, and copies the existing addressing across with
`surface = 'slack'` wherever a card had been posted. A row that was claimed but never posted keeps
its `claimed_at` and lands with `conversation_id` set and `message_ref` null, which is exactly the
state the poller's stale sweep recovers — so a claim taken before the upgrade is still recovered
after it.

It also renames the sink on `tool_effects` rows that can still be sent — `staged`, `dispatching`
and `needs_review` — from `slack_message`/`slack_file` to `surface_message`/`surface_file`. Rows
that already dispatched or failed keep the name they were sent under, because that is the record
of what happened.

Their **payloads are not rewritten**, because they cannot be: `payload_encrypted` is ciphertext
and a migration has no key. An in-flight row therefore carries no `surface` and spells its
conversation `channel`; the host's sinks read both — no `surface` means the primary one — so the
row delivers exactly where it would have.

There is no down migration. Recovery from a bad 0009 is a database restore, as for 0008.

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
  with a null run id.

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
it, prompt the `extract` route, upsert the record the document's kind routes to, and write
the redacted text
beside the document. If any step throws, none of them happened — including the
`documents.text_path` update, so a document with `text_path = null` has never
been successfully extracted.

Only redacted text is ever written to disk, whatever `HARNESS_RESTRICTED_TO_MODEL`
says. That flag governs the prompt, not the file.

`ocr_used = true` means the PDF had no usable text layer and every page went
through `pdftoppm` and `tesseract`. Expect lower field accuracy; the eval suite
scores that split separately for exactly this reason.

**Where the parsing happens.** Under Compose, in the `files` service: core-tools sends the
document's path (relative to the storage root, checked against it on both sides) to
`HARNESS_FILES_URL` and gets pages back; the worker holds no key, no database URL and no
provider credential, and its network is `internal: true`, so it reaches nothing. Redaction
runs in core-tools on what comes back. `docker compose --env-file .env -f
harness/compose/docker-compose.yml --profile demo logs files` is where a parse failure is
explained in full; the message core-tools puts in `audit_log.error` names a basename at most.
A document reporting more than `MAX_PAGES` (500) pages is refused with `422` before `pdftotext`
or `pdftoppm` ever runs on it, so one upload cannot buy an unbounded render-and-OCR run. On bare
metal, with `HARNESS_FILES_URL` unset, core-tools runs the same binaries itself:

```bash
brew install tesseract poppler                      # macOS
apt-get install -y tesseract-ocr poppler-utils      # Debian
```

A document that fails with `unsupported document type` is neither a PDF nor a recognised
image, whichever side parsed it. `document parser is unreachable` means the `files` service is
down or the calling container is not on the `files` network.

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
free-text field exactly, reports `judge: null`, and omits `judge.agreement_rate`
from the metric map rather than recording a rate nobody measured. A metric
present on only one side of a comparison is listed as not comparable and cannot
open the promotion gate. The judge needs a second database handle and a session
the CLI does not have; that wiring is still future work.
`evals/src/domain/orchestrate.test.ts` exercises the judge end to end against the fake gateway,
including the route being down.

### Which model a `model_calls` row names

`model_calls.model` records the **route alias** LiteLLM echoes back — `extract`,
`judge` — not the underlying deployment that served the call. Per-provider cost
attribution needs the deployment, which LiteLLM returns in the
`x-litellm-model-id` response header; recording that header is a later change,
and until then the deployment behind a route is whatever
`clients/<name>/routing.yaml` said at the time of the run.
## Storage

`HARNESS_STORAGE_DIR` is the root of the file store, and there is exactly one
root. It is **required and has no default**: `storageRoot()` throws at startup
rather than let a deployment that has not said where files live scatter
ingested documents into whatever directory happened to be the working
directory. Give it an absolute path; a relative one is resolved against the
process working directory, which is rarely what was meant.

Two things live under that root and do not collide:

- **Ingested documents**, wherever the caller puts them — `incoming/` by
  convention — each with its redacted text beside it as
  `<name>.<ext>.redacted.txt`. The suffix is appended to the whole file name,
  not swapped for the extension, so `a.pdf` and `a.png` keep separate sidecars.
- **Generated output** — filled forms and rosters — under `<dir>/out`, and
  nothing else writes there. File ids are relative paths inside that tree and
  are content-addressed: the same bytes always produce the same id, which is
  what makes `forms_release` idempotent.

Both halves are contained by the same pair of checks, `resolveStoragePath` for
ingest and `resolveOutFile` for output. Each compares the lexical path *and*
the symlink-resolved path against its root, so neither an absolute path, nor a
`..` segment, nor a symlink planted inside the tree can name a file outside it.
`realOrNearestAncestor` is the shared primitive behind both; it lives in
`@harness/shared` and `domain/storage/file-store.ts` reaches it through
`assertInsideRoot`, so there is one implementation to keep right.

In Compose, `host` and `files` share the same named volume, mounted at
`/srv/harness-storage`: `host` is where core-tools, hosted in-process, writes the file and
where the `surface_file` sink reads it back — one process now — and `files` mounts it too, to
parse a document core-tools sends it. If a file upload fails with ENOENT, check both services'
`volumes:` entries before anything else.

Storage isolation is per process, not per request: a core-tools process is
started with one `HARNESS_STORAGE_DIR` and one `HARNESS_CLIENT`, and that scopes
every file it reads or writes for as long as it runs. One core-tools process
never serves two clients, so there is no per-call tenant check on file paths —
the isolation comes entirely from which process, and which storage root, a
given client's traffic is routed to.

## The host and its surfaces

`@harness/host` is the process; `@harness/approvals` is the only writer of approval decisions and
the only caller of `approvals_execute`, a library the host composes rather than a process of its
own. It holds no transport of its own: it loads messaging adapters by name from
`HARNESS_SURFACES`, and the **first one is primary** — the surface approval cards are posted on.
The variable is required and the host has no default for it: where a card is posted is a
deployment's decision, so Compose supplies the demo's `@harness/surface-slack`. It runs three
loops:

| Loop | Default | What it does |
|---|---|---|
| poll | 5s | posts a card on the primary surface for every `pending` approval with no `message_ref` |
| dispatch | 5s | drains `tool_effects` through the `surface_message` and `surface_file` sinks |
| reconcile | 300s | calls `harness_reconcile` through an in-process core-tools MCP client |

Reconciliation goes through MCP rather than calling the helper directly, so the repair is scoped
to the client and lands in `audit_log` like any other call — the in-process
`CoreToolsClient` opens a run for the call, as the host's own service principal, and connects an
MCP client to a server built on that run's `ToolDeps`, the same shape an approval's execution
uses. The host has no privileged route into the data.

**Run one host per client.** The poller claims each row before it posts, by setting
`conversation_id` under a guard on the row still being `pending` with `conversation_id IS NULL`.
Only one claim can win that guard, so two pollers never both post a card for the same approval;
the loser's update affects zero rows and it logs the row as `orphaned`.

A claim can outlive the process that took it, so a claim older than two minutes that never got a
`message_ref` is released at the top of the next run and the row is posted again. The window runs
from `claimed_at` (migration 0007), not from `created_at`, so an old row claimed just now is not
released on the next tick.

Two failure points sit either side of the post and are handled differently. A post that fails
releases the claim, so the next run retries immediately. A post that succeeds but whose
`message_ref` write fails keeps the claim, because the card is already posted and releasing it
would put a second one beside it; that row waits for the two-minute sweep. A line in the log
reading "posted the card … but could not record its message reference" is that case.

**A decision is accepted only on the surface that posted the card.** `approvals.surface` records
which one that was. A press arriving from any other loaded surface is refused with the same
message an unknown approval gets, because from where the person is standing that is what it is.

**Who may decide is the identity plug-in's answer, not a surface setting.** A decision is
accepted only from a principal of `kind: 'user'` at level `lead` or above, resolved from the
surface user id that pressed the button, on the surface the card was posted on; a service
principal is refused regardless of its level. An unauthorised presser — an unknown user, a
service principal, a user under `lead` — always gets the same message, "You are not an approver
for this workspace.", before the approval is even looked up, so an outsider learns nothing about
whether it exists. An authorised presser may instead see "That approval no longer exists.": for a
malformed approval id, or a decision on the wrong surface. There is no allowlist and no bypass.

**Effects are addressed, not assumed.** A staged effect's payload may name a `surface` and a
`conversation`; with neither, it goes to the primary surface's default conversation. A payload
naming a surface this host has not loaded fails that one effect, and only that one, with
`surface_message: no surface named "…" is loaded (effect …)` in `tool_effects.last_error`. The
row is retried until `maxAttempts` (default 3) and then marked `failed` for a human, as under
"Effects outbox".

### Inbound messages

A surface delivers a `MessageEvent` with `mentioned` set: true for a direct message and for a
channel message that mentions the bot, false for every other channel message. The host's whole
rule is to return without running when `mentioned` is false — a channel message is answered only
when the bot is mentioned; a direct message always runs. Each turn still runs as the principal of
whoever wrote it, never the principal who started the thread.

A file attached to the message has already been downloaded, by the surface, into
`<HARNESS_STORAGE_DIR>/incoming/`; `MessageEvent.attachments[].path` names it relative to
`incoming/`. A reply streams as edits to one message, at a bounded rate, on a surface whose
`capabilities.streaming` is true; otherwise it posts once when the run finishes.

**One turn at a time per thread.** Two messages a moment apart in the same conversation, or a
decision resuming a thread that is still mid-turn, queue behind the turn in flight rather than
running beside it: the runtime keeps its own state per thread, and two turns writing it at once
lose one of them. Different conversations still run at the same time, so a slow turn holds up
that conversation and no other.

### Slack credentials: one app

One Slack app carries chat and approvals, because the host is the only process that holds a
Socket Mode connection now. Two apps used to be required — Slack delivers each Socket Mode event
to exactly one of an app's open connections, so a second connected process would only ever see
about half of every `block_actions` and `view_submission` payload — and that reasoning is gone
with the second process.

| App | Variables | Bot scopes | Other settings |
|---|---|---|---|
| The host's Slack app | `SLACK_BOT_TOKEN`, `SLACK_APP_TOKEN` | `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`, `im:history`, `im:read`, `im:write`, `mpim:history`, `users:read`, `files:read`, `files:write` | Socket Mode on, Interactivity on |

Subscribe the app to the `message.channels`, `message.groups`, `message.im`, `message.mpim` and
`app_mention` events, listed in `.env.example`. Invite the bot to `SLACK_APPROVALS_CHANNEL` and
to every channel it should answer messages in.

Compose's `host` service has no `env_file`: it gets an explicit `environment:` allowlist
interpolated from `.env`, so nothing outside that list reaches the container. Who may decide an
approval is gated by the identity plug-in — level `lead` or above, resolved on the surface the
card was posted on — not by which token is present; see "The host and its surfaces" above.

**Finding a Slack member id for `identity.yaml`.** Open the person's profile in Slack, click the
"More" (•••) menu, and choose "Copy member ID"; it is a string starting with `U`. Paste it into
`identity.yaml`'s `surfaces.slack` field for that principal.

### Health

Health is on `http://127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}/healthz` on the host (container port 8787, `APPROVALS_HEALTH_PORT`). It returns counts
and loop timestamps only, never a summary or a payload, because anything
reachable over HTTP is outside the audit trail. It answers 503 when an effect
has failed or is parked, or when a loop recorded an error.

Inside the container the server binds every interface (`APPROVALS_HEALTH_BIND`,
default `0.0.0.0`). That is not the exposure boundary: the Compose port mapping
is, and it is pinned to `127.0.0.1:${APPROVALS_HEALTH_HOST_PORT:-8787}:8787`, so
the endpoint is reachable from the operator's own machine and from the Compose
network, and from nowhere else. A container-loopback bind would answer neither.
Set `APPROVALS_HEALTH_BIND=127.0.0.1` only for a bare-metal run, where the
process itself is the boundary.

There are no watchdogs; the manual check is:

```bash
curl http://127.0.0.1:8787/healthz
```

The variable names — `APPROVALS_HEALTH_PORT`, `APPROVALS_HEALTH_BIND` — are
unchanged from when `@harness/approvals` hosted its own process; renaming them
would touch Compose and the snapshot for no behaviour.

### Keeping restricted values off a surface

Restricted values are kept away from a human in three places, on purpose:

1. Tools redact `approvals.payload` when they park a request.
2. `payloadPreview` re-checks the rendered payload against the SSN, EIN and DEA
   patterns and withholds the whole block on a match.
3. `harness_notify` refuses a message that trips the same patterns before it
   ever reaches the outbox.

A withheld payload in a card is not a bug to route around. It means something
wrote a restricted-looking value where it should not be; read the audit row.

## Onboarding a client

`pnpm new-client --pack <pack> --name <slug>` scaffolds `clients/<slug>/` — `SOUL.md`,
`identity.yaml`, `policy.yaml`, `routing.yaml` and an `.env.example`: a client is content and
configuration, never code. Compose derives every client path from `HARNESS_CLIENT`, so there is
nothing to edit under `harness/compose/`:

1. `cp clients/<slug>/.env.example .env` and fill it in, with `HARNESS_CLIENT=<slug>` and a
   storage directory this client does not share.
2. Declare the people and services in `clients/<slug>/identity.yaml`: `svc-host` for the
   container, `svc-local` for the operator, and one `u-…` principal per human with their level
   and their Slack member id ("Finding a Slack member id" above). A container whose principal
   is missing from the file refuses to start.
3. Create one Slack app as described under **Slack credentials** above and paste its tokens and
   the approvals channel id.
4. Review `clients/<slug>/SOUL.md` and `policy.yaml` before the first run.
5. Start it under its own Compose project so it does not collide with another client's
   containers and volumes:
   `COMPOSE_PROJECT_NAME=<slug> docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo up -d --build`.

`pnpm demo:up` is the same command under the default project name; with `HARNESS_CLIENT` set
in `.env` it starts that client.

`policy.yaml`'s `classes:` block sets the default for every level, but a level cell — the
kernel's own `DEFAULT_POLICY` or a `levels:` block in the client's file — always wins over
`classes` for that level, so `classes:` alone cannot loosen or tighten a level the kernel
already gives its own cell:

```yaml
levels:
  member: { destructive: approval }
```

## Upgrading from Plan 7

An existing deployment on the retired runtime's shape hits every one of these. Work through them
in order, with the stack down.

1. **Migrate the database.** `pnpm db:migrate` applies 0011: it adds `threads`, `messages`,
   `approvals.thread_id`, `runs.status` and the foreign keys, and drops `runs.caller`. It is safe
   on live data — nothing before 0011 ever wrote `runs.thread_id`, so the new key cannot fail on
   an existing row. Optionally follow it with
   `UPDATE runs SET status = 'done' WHERE ended_at IS NOT NULL`: the new column's default makes
   every historic run read as `running`, and nothing reads the column yet, so the statement only
   matters to the first query you write on it. At its first start the host also creates schema
   `langgraph` in the `harness` database through the checkpointer's own setup; the `harness` role
   can already `CREATE SCHEMA` on the stock Compose Postgres.
2. **Collapse the two Slack apps into one.** Keep the app whose tokens are `SLACK_BOT_TOKEN` and
   `SLACK_APP_TOKEN`, turn **Interactivity on** for it (it had none), and confirm its event
   subscriptions: `message.channels`, `message.groups`, `message.im`, `message.mpim` and
   `app_mention`. Delete the second app. Remove `APPROVALS_SLACK_BOT_TOKEN`,
   `APPROVALS_SLACK_APP_TOKEN`, `SLACK_HOME_CHANNEL`, `SLACK_HOME_CHANNEL_NAME`,
   `SLACK_ALLOWED_USERS` and `MEMORY_ALLOWED_USERS` from `.env`. Invite the bot to
   `SLACK_APPROVALS_CHANNEL` and to every channel it should answer in.
3. **Rewrite `identity.yaml`.** Replace the retired service principals with `svc-host`, or point
   `HARNESS_HOST_PRINCIPAL` at a service id the file already declares; the host refuses to start
   otherwise. Replace the placeholder member ids with real Slack member ids — until you do, every
   human is refused with "You are not authorised to use this assistant." and every button press
   with "You are not an approver for this workspace."
4. **Set the runtime in `.env`.** Add `HARNESS_RUNTIME=@harness/runtime-deepagents` for a
   bare-metal `pnpm host`; Compose supplies it for the container. Drop the retired runtime's
   `*_UID`/`*_GID` variables.
5. **Clean the client folder.** Delete the retired runtime's config file, `cron/` and `scripts/`
   from any client scaffolded before this release; the scaffolder no longer copies them and
   nothing reads them.
6. **Remove the old containers.** `pnpm demo:down`, then
   `docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo down --remove-orphans`
   to take away the retired runtime's containers and the separate approvals container.
   `docker volume rm` its data volume once you no longer want that state: conversation history
   does not carry over, and threads start fresh. The `storage` volume is reused as is (already
   `1000:1000`), and the old approvals image is left dangling.
7. **Expect these behaviour changes.** No watchdogs. An attachment is stored as `incoming/<ts>-<safe name>` rather than
   under its original name. A reply lands in a Slack thread under the message that caused it, and
   a follow-up written in that thread, in a channel, has to mention the bot again. Every chat turn
   now runs as the writer's own principal and level, so a `member` who used to act through a
   service principal at `service` level is parked for `write.internal` unless the client's
   `policy.yaml` says otherwise (the demo's says `auto`).
8. **Health is unchanged.** `/healthz` still answers on `127.0.0.1:8787`; the two watchdog
   scripts that used to poll it are gone, so point your own probe at it.

## Upgrading from Plan 8

An existing Plan 8 deployment hits all of these. Work through them in order, with the stack down,
and start the host only at the end: `playbooks.yaml` is read into the `playbooks` table once, at
startup, and a running host never re-reads it.

1. **Migrate the database.** `pnpm db:migrate` applies 0012: `memory_entries`, `playbooks`,
   `playbook_runs`, and `messages.seq` (numbered for existing rows). Safe on live data. The
   optional `runs.status` backfill from the Plan 7 upgrade still applies if you skipped it.
2. **Declare `svc-playbooks`** in `clients/<name>/identity.yaml` (or whichever service id your
   `playbooks.yaml` names) and add `clients/<name>/playbooks.yaml`; a client with no file has no
   playbooks and starts fine, with one log line saying so.
3. **Grant the application role** `SELECT, INSERT, UPDATE` on the three new tables and `DELETE`
   on `memory_entries`, as under "Database roles".
4. **Nothing new in `.env`.** This release reads no new environment variable: the scheduler's
   tick, the memory caps and the search limit are constants in the code.
5. **Retire the external cron.** The shell cron that used to fire the nightly
   `credentialing-expirations` digest is gone with the Hermes runtime; the scheduler runs that
   skill instead, as `svc-playbooks`, and the skill's silence gate is unchanged — it replies with
   the line `Nothing to report.` and stages what the practice should see through
   `harness_notify`.
6. **Start the host.** The sync and the scheduler both happen at startup, so nothing in
   `playbooks.yaml` takes effect until this step, and the grants of step 3 have to be in place
   before it: the sync writes `playbooks` and closes stranded rows in `playbook_runs`. The log
   line names how many playbooks were read and how many were disabled.
7. **Expect these behaviour changes.** The nightly digest is back, at the time and zone
   `playbooks.yaml` says. The model can now remember facts between conversations; what it
   remembers is per principal, and a write to the practice-wide scope is `write.internal` —
   parked for approval for a `member`, automatic for a practitioner and above.

## Memory

`memory_entries` is the curated memory (spec 5.5): one row per fact, in scope `principal` (one
principal's own notes, `principal_id` set) or `client` (shared, `principal_id` null). Caps are
2,500 characters and 50 entries per principal scope, 4,000 and 50 for the client scope, 500
characters per entry; `memory_add` past a cap is refused with the current entries and how much of
the scope they use, so the model consolidates with `memory_remove` in the same turn. Own-scope writes are
`write.self` (auto at every level); client-scope writes and removals are `write.internal`
(parked for a `member`, auto above). Every write runs the injection scan — instruction-shaped
phrases, invisible Unicode — and the restricted-pattern check first; a refusal names the
category and never repeats the text.

The host renders what the caller can see into `RunRequest.memory` once, before the run starts
(the runtime seeds it at `/memories/MEMORY.md`); a fact added during a turn is in the next
turn's snapshot. `session_search` is full-text recall over `messages` of the caller's own
threads, plus the playbook threads for `lead` and above, filtered by principal before ranking.

**Leave `write.self` on `auto` in `policy.yaml`.** Parking it strands the write. A replay runs on
the deciding principal's own dependencies, and a `write.self` handler files the entry under
whoever replays it, so `approvals_execute` refuses every replay whose principal is not the one
who asked —
`a write to a principal's own memory can only be approved by the principal who asked for it` —
and rolls the row back to `approved`. A decision always replays as the approver, never as the
requester, so a member's own note parked this way can be approved by nobody and stays
approved-unspent forever.

Memory written from a conversation carries its `thread_id`. The spec's second half of that rule
— a fact learned in a group conversation never lands in a private scope — is not enforced: no
surface says yet whether a conversation is a group or a direct message. Read what a principal
remembers with:

```sql
select scope, principal_id, text, created_by, created_at
from memory_entries where client = 'demo-practice' order by created_at;
```

## Playbooks

Scheduled work is `clients/<name>/playbooks.yaml`, read into the `playbooks` table when the host
starts, and a scheduler loop inside the host that ticks every 30 seconds. The demo ships one
playbook, `credentialing-expirations`, at 07:00 `America/New_York` as `svc-playbooks`.

**The file.** One entry per playbook: `name` (the key), `schedule` (cron, five or six fields),
`timezone` (IANA, default `UTC`), `skill`, `prompt`, `principal` (a `svc-…` id from
`identity.yaml`), `deliver` (`none`, the default, or `conversation`), optional `surface` and
`conversation`, `cost_cap_usd`, `timeout_s` (default 600), `enabled` (default true). The schedule
is exactly five or six whitespace-separated fields that fire at least once: the wider forms the
cron library would otherwise take — `@daily` and the rest of that family, seven fields, an ISO
one-shot date — are rejected, and so is a calendar that can never come round again, such as
`0 0 30 2 *`. The timezone is checked at parse time too. A malformed file stops the host at
startup, naming the field. Edit the file and restart: a playbook removed from it is **disabled,
not deleted**, so `playbook_runs` keeps its history, and a firing that was due while the host was
down is **not replayed** (decision 13) — `next_run_at` is recomputed from the clock at every
start.

**A firing.** The scheduler claims due rows with `FOR UPDATE SKIP LOCKED` (two hosts on one
database never both fire the same row), then for each: preflight — the skill is in a loaded
pack, the principal is declared and is a service, the named surface is loaded, the cost cap is
a positive number; a failure writes `playbook_runs.status = 'preflight_failed'` with the reason
and posts one notice, and no model call is made. Then one turn on the playbook's own thread
(`kind = 'playbook'`, conversation `playbook:<name>`), as its service principal, with the
prompt as a host message, that one skill offered, `timeout_s` as the run's budget timeout.
Under `deliver: none` the run's reply is recorded on the thread and posted nowhere; what the
practice sees is whatever the skill staged through `harness_notify`, which is the silence
doctrine in `SOUL.md`. Under `deliver: conversation` the reply is posted once to
`surface`/`conversation` (defaults: the primary surface, its default conversation).

The 30-second tick is a constant in the code, not a variable a deployment tunes. A tick that
throws is logged at error and dropped — the claim is transactional, so the row it could not take
is still due and the next tick takes it. The one way that happens in practice is a deadlock
abort: a host starting up syncs the file while a tick is claiming, and with two or more playbooks
of one client the two transactions can reach for the same rows in opposite orders. Postgres
aborts one side. If the loser is the tick, the next one retries thirty seconds later; if it is
the sync, host startup fails once and the answer is to start it again.

**Retry and notice.** A firing whose runtime or transport failed (`the run failed; see the host
log` — `RUN_FAILED_MESSAGE`, exported from `@harness/runtime-api` and emitted by the shipped
runtime, so a custom runtime that wants the retry emits that exact text — or `the runtime failed;
see the host log`, or the turn threw before the runtime answered) is retried once, as a second
`runs` row; `attempts` counts them and `run_id` is the last. A run that was cancelled, timed out,
spent its budget or passed its cost cap is not retried, and neither is a firing the host refused
because it had begun shutting down: that one is recorded `failed` with
`the host stopped before the run finished`, stages its notice like any other failure, and waits
for the schedule to come round again. A firing that ends `failed` stages exactly one notice
through the effects outbox — sink `surface_message`, idempotency key
`<client>:playbook:<name>:<scheduled_at>` — to the playbook's surface and conversation, with
one of two fixed sentences and nothing from the model. The dispatcher sends it on its next tick.

**What `cost_cap_usd` bounds today.** The host sums the `usage.costUsd` the runtime reports
and aborts the run past the cap; the shipped runtime reports `0` on every usage event (spend is
attributed by the gateway, in `model_calls`, not by the runtime), so **the dollar cap cannot
trip today**. What bounds a playbook run in practice is `timeout_s`,
`HARNESS_RUN_MAX_MODEL_CALLS` and `HARNESS_RUN_MAX_TOOL_CALLS` (the runtime ends the run with
`the run exceeded its budget`), the kernel's `HARNESS_GATEWAY_MAX_CALLS_PER_RUN` for model calls
a tool makes, and LiteLLM's `daily_budget_usd` per route. The cap becomes live the day a runtime
reads `x-litellm-response-cost` into `usage.costUsd`. Either host-side abort is a decision rather
than a request: once the reported spend passes the cap, or the host's own timer fires, the run
ends `error` with `the run exceeded its cost cap` or `the run exceeded its time budget` even if
the runtime ignores the abort and answers anyway.

**By hand.** `playbooks_list` (any level) shows every playbook with `next_run_at`, `last_run_at`
and `last_status`. `playbooks_run_now` (`admin`) writes a `requested` row that the next tick —
at most 30 seconds away — claims ahead of the schedule; it returns the `playbook_runs` id, and
the run opens then, as the playbook's principal, never the caller's. A requested row whose
playbook is disabled or dropped from the file before that tick arrives is closed
`preflight_failed`, `run_id` null and `attempts` 0: by the startup sync, as `playbook removed` or
`playbook disabled`, or by the claim itself, as `playbook disabled`. No notice is staged for it: it is visible
only through `playbooks_list` and the `playbook_runs` table.

```sql
select p.name, r.scheduled_at, r.status, r.attempts, r.error, r.run_id
from playbook_runs r join playbooks p on p.id = r.playbook_id
order by r.scheduled_at desc limit 20;
```

A row stuck in `running` is a host that died mid-firing: the next start does not resume it;
close it by hand (`update playbook_runs set status = 'failed', ended_at = now() where id = …`)
and let the schedule fire again.
