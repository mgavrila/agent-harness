---
name: credentialing-expirations
description: Nightly renewal watch. Reports credentials entering an urgency window and stays silent when there is nothing to report.
version: 1.0.0
metadata:
  hermes:
    tags: [credentialing, healthcare, playbook]
    category: healthcare
  harness:
    owner: demo-practice
    parent_version: null
    eval_status: baseline
    evals:
      - deadlines.jsonl
    action_classes: [read, write.internal]
    tools:
      - deadlines_upcoming
      - audit_query
      - harness_notify
---

# Credentialing expirations

## When to use

The nightly playbook runs this. A human may also ask "who expires in the next
90 days" or "what is coming up" — answer them directly in that case and skip
the notify step, because you are already in the conversation.

## Procedure (scheduled run)

1. Call `deadlines_upcoming` with `window_days: 90`.
2. **If it returns no items, produce no message.** Reply with exactly this and
   nothing else, on its own line:

   ```
   {"wakeAgent": false}
   ```

   That is the scheduler's silence gate. Do not write "all clear", do not
   summarise what you checked, do not greet anyone.
3. Otherwise, get the lineage: call `audit_query` with
   `tool: "deadlines_upcoming"` and `limit: 1`, and keep the `id` of the first
   entry. That is the audit row of the query you just ran.
4. Group the items by the `bucket` each one already carries — `overdue`,
   `due_7d`, `due_30d`, `due_60d`, or `due_90d`. Do not classify items
   yourself from `days_left`; the tool has already done it, and its boundaries
   are the ones that count.
5. Take `digest_key` from the same `deadlines_upcoming` response and pass it
   through, verbatim, as `harness_notify`'s `idempotency_key`. Do not build or
   guess a key of your own. The same set of items in the same buckets
   reproduces the same `digest_key` on the next run, so the message is sent
   once; an item moving into a tighter bucket changes it, so the next run
   speaks again.
6. Call `harness_notify` with that `idempotency_key`, the message below as
   `text`, and `derived_from` set to `[<the audit id from step 3>]`.
7. Produce no chat output of your own. Reply with `{"wakeAgent": false}` on its
   own line; the message the practice sees is the one you staged.

## The message

One message. Most urgent bucket first, in this order: `overdue`, `due_7d`,
`due_30d`, `due_60d`, `due_90d`. One line per item:

```
Renewals inside 90 days

Overdue
- Dr. Ada Reyes — state licence (TX) — expired 2026-09-01, 14 days ago

Within 7 days
- Dr. Bo Lin — malpractice — due 2026-09-20, 5 days left

Within 60 days
- Dr. Cai Okafor — board certification — due 2026-11-02, 48 days left
```

Omit a bucket that is empty. Never write a bucket heading with nothing under
it. No preamble, no closing sentence, no offer to help.

## Pitfalls

- An overdue item is not "0 days left". Say how many days ago it expired.
- If `deadlines_upcoming` fails, do not report "no expirations". Report the
  failure and stop: silence means nothing is due, and a broken query must never
  look like good news.
- Do not call `deadlines_compute` from this skill. Recomputing is intake's job;
  a playbook that writes records changes what it is reporting on.

## Verification

Before finishing: `harness_notify` returned `staged: true` (a `false` means
this exact digest already went out and you should stay silent), or you replied
with the silence gate. One of those two is always true.
