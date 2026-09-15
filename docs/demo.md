# Five-minute demo

What this shows: documents in Slack become a provider record with a renewal
calendar; low-confidence fields are questions, not guesses; a roster leaves the
harness only through a human decision; and every step is in the audit log.

Everything below runs on synthetic data. The NPIs are invented and will not
resolve against NPPES — that mismatch is part of the demo.

## Before you start

```bash
cp clients/demo-practice/.env.example .env        # fill in the blanks
pnpm install
pnpm db:up && pnpm db:migrate
pnpm demo:up
pnpm demo:playbooks                               # installs the three cron jobs
```

Then in Slack, invite the bot to the channel named by `SLACK_APPROVALS_CHANNEL`
and `SLACK_HOME_CHANNEL`. Generate the synthetic provider files with the
generator from the document-pipeline plan (`packs/healthcare/synthetic/`) and
keep three of them — a state licence, a malpractice certificate and a W-9 for
one doctor — open in a folder.

Run the smoke checklist at the bottom once before you demo. It takes two
minutes and catches every failure that is embarrassing in front of a room.

## The script

### 1. Drop three PDFs (60 seconds)

Drag the licence, the malpractice certificate and the W-9 into the channel and
say:

> New doctor joining us, Dr. Ada Reyes. Please file these.

Hermes loads `credentialing-intake`, ingests each file, classifies it, extracts
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
deterministic. Mention that the same skill runs nightly at 07:00 and says
nothing at all on a night when nothing is due.

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
`auto` against the approval id. Point at the `skill` and `skill_version`
columns — the trail says which skill caused each call — and at `derived_from`
on the nightly digest, which points back at the query it was built from.

### 6. Swap the model provider (30 seconds)

Edit `clients/demo-practice/routing.yaml` to point the `chat` route at a
different provider, restart the gateway, and ask the same expirations question.

```bash
docker compose -f harness/compose/docker-compose.yml restart gateway
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
- [ ] `docker compose -f harness/compose/docker-compose.yml --profile demo ps` shows `postgres`, `hermes` and `approvals` up, and `hermes-init` exited 0.
- [ ] `curl -s localhost:${APPROVALS_HEALTH_HOST_PORT:-8787}/healthz | python3 -m json.tool` returns `"ok": true`.
- [ ] `docker compose -f harness/compose/docker-compose.yml exec hermes hermes config get skills.write_approval` prints `true`.
- [ ] `docker compose -f harness/compose/docker-compose.yml exec hermes hermes cron list` shows all three jobs.
- [ ] In Slack, `/credentialing-intake` autocompletes: the pack skills were discovered through `skills.external_dirs`.
- [ ] Asking the bot "what tools do you have?" lists `mcp_core_tools_*` names and **no** terminal or file tools.
- [ ] A test release round-trips: ask for a roster of one provider, approve the card, and confirm the file arrives.
- [ ] `psql "$DATABASE_URL" -c "select tool, decision from audit_log order by created_at desc limit 5"` shows that round-trip.
- [ ] `psql "$DATABASE_URL" -c "select status, count(*) from tool_effects group by status"` shows no `failed` and no `needs_review`.
