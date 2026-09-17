---
name: credentialing-roster
description: Build a payer roster CSV for a set of providers and get a human to approve sending it.
version: 1.0.0
metadata:
  harness:
    owner: demo-practice
    parent_version: null
    eval_status: baseline
    evals:
      - roster.jsonl
    action_classes: [read, write.internal, external]
    tools:
      - providers_search
      - providers_get
      - forms_roster
      - forms_release
      - deadlines_upcoming
      - approvals_execute
---

# Credentialing roster

## When to use

Someone asks for a payer roster: "send Aetna our roster", "build the BCBS
roster for the three new doctors".

## Procedure

1. **Agree the payer.** The payer id is a lowercase slug — `aetna`, `bcbs-tx`,
   `united`. If the request names a payer you have not used before, confirm the
   slug rather than inventing one.
2. **Agree the providers.** If the request names them, `providers_search` each
   one. If it says "everyone" or "the whole group", list the providers you
   would include and ask for a yes before building anything. A roster sent with
   the wrong people on it is the expensive mistake here.
3. **Check for expiries first.** `deadlines_upcoming` with `window_days: 30`.
   A provider on the roster whose licence expires inside a month is worth
   flagging before the roster goes out, not after.
4. **Build.** `forms_roster` with the payer id and the provider ids. You get a
   `file_id`, a row count and the column list.
5. **Report before releasing.** One message: the payer, the providers by name,
   the row count, and anything a payer will query — a missing NPI, a licence
   expiring inside 30 days, a provider with no malpractice on file. Say
   plainly that credential numbers are reported as on-file yes/no and are never
   in the file.
6. **Ask whether to send it.** Wait for a yes.
7. **Release.** `forms_release` with the `file_id`. It returns
   `status: "pending"` and an `approval_id`. Say the roster is built and is
   waiting for approval, with the id. **Do not say it was sent.**
8. **Stop and wait** for the thread reply. On a decline, the note says what to
   change; rebuild, release the new file, and ask again.

## What belongs on a roster

Every provider the payer should have on file for this group, whether or not
their file is complete. A provider with gaps still goes on the roster with the
gaps visible — that is what the payer needs to see. This is the opposite of a
form, which is blocked by an incomplete field, because a form asserts a fact
and a roster reports a state.

## Pitfalls

- `forms_roster` refuses the whole roster if one provider id is unknown or
  belongs to another practice. That is deliberate. Fix the list; do not drop
  the provider silently.
- Duplicated provider ids collapse to one row. A count that comes back lower
  than the list you sent means you sent a duplicate.
- Never assemble a roster by hand in a message. The CSV is the deliverable and
  only `forms_roster` writes it.

## Verification

Before saying anything went out, you must have seen a thread reply saying the
approval was approved and the release executed.
