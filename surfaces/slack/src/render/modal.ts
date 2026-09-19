import type { Form, FormField } from '@harness/surface-api';

/**
 * A Slack modal view from a neutral `Form`.
 *
 * `Form.metadata` travels in `private_metadata` and is never read here: it is the host's string
 * and comes back untouched on submission. Slack's `view_submission` payload carries no
 * conversation of its own for a modal opened from a button, which is why the host puts one in
 * there — but that is the host's business, not this module's.
 */

/** The element id Slack reports an answer under. Derived, so the host declares one id per field. */
function inputActionId(field: FormField): string {
  return `${field.id}_input`;
}

function inputBlock(field: FormField): unknown {
  return {
    type: 'input',
    block_id: field.id,
    ...(field.optional ? { optional: true } : {}),
    label: { type: 'plain_text', text: field.label },
    element: {
      type: 'plain_text_input',
      action_id: inputActionId(field),
      multiline: field.multiline,
      ...(field.maxLength === undefined ? {} : { max_length: field.maxLength }),
      ...(field.placeholder === undefined ? {} : { placeholder: { type: 'plain_text', text: field.placeholder } }),
    },
  };
}

export function formView(form: Form): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: form.id,
    private_metadata: form.metadata,
    title: { type: 'plain_text', text: form.title },
    submit: { type: 'plain_text', text: form.submitLabel },
    close: { type: 'plain_text', text: form.cancelLabel },
    blocks: [
      ...(form.intro === undefined ? [] : [{ type: 'section', text: { type: 'mrkdwn', text: form.intro } }]),
      ...form.fields.map(inputBlock),
    ],
  };
}

/**
 * Read a submitted view's state into `FormEvent.values`, keyed by block id — which is the field
 * id `inputBlock` wrote.
 *
 * Derived from the payload alone, with no `Form` in hand, so this adapter remembers nothing
 * between opening a modal and its submission: a note box opened before a restart still submits
 * afterwards. That is what today's `main.ts` does when it reads the note straight out of
 * `view.state.values` under the two ids it already knows.
 *
 * A field left blank arrives with a null value and becomes `''`, so a handler reading
 * `values[id]` never has to tell "left blank" from "Slack changed its payload shape".
 */
export function valuesOf(state: Record<string, Record<string, { value?: string | null }>>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [blockId, elements] of Object.entries(state)) {
    // One element per input block, which is the only shape `inputBlock` produces.
    values[blockId] = Object.values(elements)[0]?.value ?? '';
  }
  return values;
}
