# Five-minute demo

What this shows: documents in Slack become a provider record with a renewal
calendar; low-confidence fields are questions, not guesses; a roster leaves the
harness only through a human decision; and every step is in the audit log.

Everything below runs on synthetic data. The NPIs are invented and will not
resolve against NPPES — that mismatch is part of the demo.

## Before you start

```bash
pnpm install
pnpm db:up && pnpm db:migrate
pnpm new-client --name demo-practice --pack healthcare --target ../harness-tenants
cp .env.example .env
# then, in .env: HARNESS_CLIENTS_DIR=../harness-tenants, HARNESS_CLIENT=demo-practice,
# and fill in the blanks pnpm new-client printed
pnpm demo:up
```

`pnpm new-client` writes one client document, `../harness-tenants/demo-practice/client.yaml`, and
a `persona.md` beside it — never into this repository. Add a `surfaces.slack` section to that
document (`teamId`, and `signingSecret` and `botToken` as `{ env: <NAME> }` references naming the
environment variables below) before creating the Slack app. `teamId` is the id of the workspace
the app is installed in — the `T…` segment of any workspace URL — and the host refuses an event
from any other.

Create one Slack app before filling in `.env`, with Socket Mode and Interactivity both on. Its
bot scopes are `chat:write`, `app_mentions:read`, `channels:history`, `groups:history`,
`im:history`, `im:read`, `im:write`, `mpim:history`, `users:read`, `files:read`, `files:write`.
Paste `SLACK_BOT_TOKEN` and `SLACK_APP_TOKEN` into `.env`, along with `SLACK_APPROVALS_CHANNEL`.
One app now carries both chat and approvals, because the host is the only process that holds a
Socket Mode connection.

The host posts on whichever surface is first in the client document's `surfaces` section, by the
schema's own fixed order (`slack`, `memory`, `http`). The demo's document declares `slack`, which
is why Slack is what you see here.

Then in Slack, invite the bot to `SLACK_APPROVALS_CHANNEL` and to every other channel it should
answer in. Generate the synthetic provider files with the generator from the document-pipeline
plan (`packs/healthcare/synthetic/`) and keep three of them — a state licence, a malpractice
certificate and a W-9 for one doctor — open in a folder.

Run the smoke checklist at the bottom once before you demo. It takes two
minutes and catches every failure that is embarrassing in front of a room.

## The script

### 1. Drop three PDFs (60 seconds)

Drag the licence, the malpractice certificate and the W-9 into the channel and
say:

> New doctor joining us, Dr. Ada Reyes. Please file these.

The host loads `credentialing-intake`, ingests each file, classifies it, extracts
it, and writes the record. Point out while it works: the W-9's tax identifier
goes straight into an encrypted column and is never sent to the model.

### 2. Read the summary and answer one question (60 seconds)

The reply gives the provider, the documents recognised, the credentials with
their expiry dates, and a numbered list of fields that need confirmation — one
question each, with the page they came from. Answer one:

> 2. It's 2027-03-31.

`providers_confirm_field` marks it verified. Point out what just happened: the
low-confidence field was a question rather than a guess, and the confirmation
is attributed to the person who answered.

### 3. Ask about expirations (45 seconds)

> Who expires in the next 90 days?

`deadlines_upcoming` answers with no model call behind it: the date maths is
deterministic. The `credentialing-expirations` skill runs nightly from the
scheduler as `svc-playbooks` (the client document's own `playbooks` section);
`playbooks_run_now` fires it on demand.

### A cited answer, at the asker's level

The demo document's `knowledge` section points at a directory of two markdown files. Sync them
once, as the practice manager (an `admin`, so the sync runs rather than parking for approval):

```
@assistant refresh the knowledge base
```

Then ask, as the coordinator (a `lead`):

```
@assistant how do we escalate something urgent?
```

The answer quotes `escalation-and-billing.md` and names it. Add a `member` to the document's
`identity` section and ask the same thing as them and the assistant says it does not have that and
offers to ask a lead:
`knowledge_search` returned only `front-desk.md`, because the escalation document is
`min_level: lead`. Nothing about the second document leaks into the refusal — the member's search
never ranked it.

The nightly `knowledge-sync` playbook does the same refresh at 06:30 `America/New_York`, as
`svc-playbooks`, and says nothing unless a document was skipped.

### 4. Ask for the Aetna roster and approve it (90 seconds)

> Build the Aetna roster for Dr. Reyes and Dr. Lin.

The agent reports the payer, the providers, the row count and anything a payer
will query — and says the roster is waiting for approval, with an approval id.
It does not say it was sent.

A card appears in the approvals channel with the summary, the redacted payload
and three buttons. Press **Edit** first to show that it opens a note box and
releases nothing. Cancel, then press **Approve**.

The card rewrites itself to show who approved it, a thread reply tells the
agent what happened, and the CSV appears in the channel. Open it: the credential
columns read `yes` and `no`. The numbers are not in the file.

### 5. Show the audit log (45 seconds)

> Show me the audit log for this run.

`audit_query` returns every call in order with its action class and decision:
reads and internal writes as `auto`, the release as `approval` and then as
`auto` against the approval id. Point at the `caller` column — every call
carries the principal the harness bound to the session, never one the agent
chose — and at `derived_from`, which points back at the query an answer was
built from. `skill` and `skill_version` on the audit rows are back: the
runtime stamps the skill it activated.

### 6. Swap the model provider (30 seconds)

Edit the client document's own `routing` section to point the `chat` route at a different
provider, run `pnpm gateway:config` to re-render it, restart the gateway, and ask the same
expirations question.

```bash
docker compose --env-file .env -f harness/compose/docker-compose.yml restart litellm
```

Nothing in the harness changed. The routing table is the only thing that knows
which provider serves which route.

## What to say if something fails

The honest version is the good version. Every failure mode here is one the
design anticipated:

- **A tool errors three times in a row.** The agent stops and reports instead of
  thrashing. That is the loop breaker, and it is configuration, not luck.
- **The card shows a withheld payload.** The redaction check found something
  that looks like a restricted identifier. Nothing goes to Slack until a human
  reads the audit row.
- **An approval expires.** Nothing was released. The row is `expired` and the
  agent has to ask again.
- **The upload does not appear.** The effect is in the outbox, not lost. Check
  `pnpm demo:logs` and the `needs_review` query in the runbook.

## Smoke checklist

Run this before the demo. Each line either passes or tells you what is wrong.

- [ ] `pnpm test` passes and `pnpm typecheck` is clean.
- [ ] `docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo ps` shows `postgres`, `litellm`, `files` and `host` up.
- [ ] `curl http://127.0.0.1:8787/healthz` answers `"ok": true`.
- [ ] `psql "$DATABASE_URL" -c "select path, min_level from knowledge_documents order by path"` shows the two demo documents, if you are demonstrating the knowledge base.
- [ ] `docker compose --env-file .env -f harness/compose/docker-compose.yml --profile demo exec host printenv SLACK_APP_TOKEN` prints the one token.
- [ ] A direct message to the bot is answered.
- [ ] A mention in a channel is answered, and an unmentioned message in that channel is not.
- [ ] Asking the bot "what tools do you have?" lists the kernel's own tool names plus `read_file`, `ls`, `glob` and `grep`, and **no** terminal tool.
- [ ] A test release round-trips: ask for a roster of one provider, approve the card, and confirm the file arrives.
- [ ] `psql "$DATABASE_URL" -c "select tool, decision from audit_log order by created_at desc limit 5"` shows that round-trip.
- [ ] `psql "$DATABASE_URL" -c "select status, count(*) from tool_effects group by status"` shows no `failed` and no `needs_review`.
