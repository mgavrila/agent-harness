---
name: credentialing-fill-form
description: Fill a payer or licensing form for one provider and get a human to approve sending it.
version: 1.0.0
metadata:
  harness:
    owner: demo-practice
    parent_version: null
    eval_status: baseline
    evals:
      - forms.jsonl
    action_classes: [read, write.internal, external]
    tools:
      - forms_list_templates
      - forms_fill
      - forms_release
      - providers_search
      - providers_get
      - providers_list_pending
      - providers_confirm_field
      - approvals_execute
---

# Credentialing fill form

## When to use

Someone asks for a form for a provider: "fill the Aetna application for Dr.
Reyes", "I need the TX renewal cover sheet".

## Procedure

1. **Identify the provider.** `providers_search`. Ambiguous: ask. Never fill a
   form for a provider you are not sure about.
2. **Identify the template.** `forms_list_templates`. If the request does not
   clearly name one, list the installed templates and ask which.
3. **Fill.** `forms_fill` with the template id and the provider id. You get a
   `file_id`, the labels you filled, and the labels left blank.
4. **If it refuses**, the error names the fields that are not ready. Do not try
   another template and do not try to fill the gaps from memory. Call
   `providers_list_pending`, ask about each pending field as a numbered list,
   confirm the answers with `providers_confirm_field`, and fill again.
5. **Report before releasing.** One message: the template, the provider, the
   fields filled, the fields left blank, and what each blank means for the
   payer. A blank optional field is often fine; say so or say it is not.
6. **Ask whether to send it.** Do not call `forms_release` until a human has
   said to send it. Filling is free; sending is not.
7. **Release.** `forms_release` with the `file_id`. It returns
   `status: "pending"` and an `approval_id`, because sending is an external
   action. Say exactly that: the file is built and is waiting for approval,
   with the approval id. **Do not say it was sent.**
8. **Stop.** The approvals app posts the card, records the decision, and runs
   the release. You will see a thread reply telling you what happened. Until
   then there is nothing more to do.
9. **On a declined approval** the thread reply carries the reviewer's note.
   Make the correction it asks for — usually a `providers_confirm_field` and a
   fresh `forms_fill` — and then release the new file and ask again. A declined
   approval released nothing, so nothing has to be undone.

## What "ready to fill" means

Only a field a human confirmed, or one the extractor was confident about, may
reach a form. A pending field blocks the form on purpose: a payer application
carrying a guessed licence number is worse than a late one. Restricted
identifiers are never printed on a form at all, so do not offer to add one.

## Pitfalls

- The `file_id` is content-addressed. Filling the same data twice gives you the
  same id and releasing it twice is one delivery. If you need a genuinely new
  file, change the data first.
- Never construct a `file_id` yourself. Use the one `forms_fill` returned.
- If `forms_release` returns `status: "pending"` you have not sent anything,
  however the message is phrased.

## Verification

Before saying anything went out, you must have seen a thread reply saying the
approval was approved and the release executed. Your own call returning
`pending` is not that.
