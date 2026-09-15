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
      - harness_set_context
      - deadlines_upcoming
      - audit_query
      - harness_notify
---

# Credentialing expirations

## When to use

The nightly playbook runs this. A human may also ask "who expires in the next
90 days" or "what is coming up" — answer them directly in that case and skip
the notify step, because you are already in the conversation.

## First, always

Call `harness_set_context` with `skill: "credentialing-expirations"`,
`skill_version: "1.0.0"`, and a fresh UUID as `run_id`.

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
4. Put each item in exactly one urgency bucket by `days_left`:

   | Bucket | `days_left` |
   |---|---|
   | `overdue` | below 0 |
   | `14` | 0 to 14 |
   | `30` | 15 to 30 |
   | `60` | 31 to 60 |
   | `90` | 61 to 90 |

5. Build the continuity key. It is `expirations:` followed by the most urgent
   bucket present, a colon, and the count of items in that bucket — for
   example `expirations:14:2`. The same set of items in the same bucket
   produces the same key on the next run, so the message is sent once; an item
   moving into a tighter bucket changes the key, so the next run speaks again.
6. Call `harness_notify` with that `idempotency_key`, the message below as
   `text`, and `derived_from` set to `[<the audit id from step 3>]`.
7. Produce no chat output of your own. Reply with `{"wakeAgent": false}` on its
   own line; the message the practice sees is the one you staged.

## The message

One message. Most urgent first. One line per item:

```
Renewals inside 90 days

Overdue
- Dr. Ada Reyes — state licence (TX) — expired 2026-09-01, 14 days ago

Within 14 days
- Dr. Bo Lin — malpractice — due 2026-09-24, 9 days left

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
