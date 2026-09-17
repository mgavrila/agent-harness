import type { approvals } from '@harness/db';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import type { Card, CardLine, Form, NotePart } from '@harness/surface-api';

/**
 * What an approval looks like to a human, in the contract's own words.
 *
 * Every string a reader sees is built here and nothing here knows how it will be drawn: no
 * markup, no emoji, no date format, no mention syntax. An adapter turns a `Card` into whatever
 * its own surface draws — a rich layout, an Adaptive Card, a plain message — and the host
 * stays the same either way.
 */

export type ApprovalRow = typeof approvals.$inferSelect;

/** The kind of card this is. An adapter may derive its own ids from it; nothing else uses it. */
export const CARD_ID = 'harness_approval';
export const APPROVE_ACTION_ID = `${CARD_ID}_approve`;
export const EDIT_ACTION_ID = `${CARD_ID}_edit`;
export const DECLINE_ACTION_ID = `${CARD_ID}_decline`;
export const EDIT_FORM_ID = `${CARD_ID}_edit_modal`;
export const EDIT_NOTE_FIELD_ID = `${CARD_ID}_note`;

/** What `editForm` encodes into a form's metadata and `parseApprovalMetadata` decodes back. */
export interface ApprovalMetadata {
  approvalId: string;
  conversation: string;
}

export function payloadPreview(payload: unknown, limit = 2000): string {
  let text: string;
  try {
    text = JSON.stringify(payload, null, 2) ?? 'null';
  } catch {
    return 'payload could not be rendered';
  }
  if (containsRestrictedPattern(text)) return 'payload withheld: it did not pass the redaction check';
  return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/**
 * Free text a human wrote, or `withheld` when it does not pass the same check a payload does.
 *
 * Shared with the thread reply in `decisions.ts`, which asks the same question of the same note
 * and answers it in its own wording: the guard is one rule, the replacement is per reader.
 */
export function orWithheld(text: string | null, withheld: string): string | null {
  if (!text) return null;
  return containsRestrictedPattern(text) ? withheld : text;
}

const EXECUTION_FAILURE_FALLBACK = 'Execution failed; see the audit log. Nothing was sent.';
const MAX_EXECUTION_ERROR_LENGTH = 300;

/**
 * A tool's error message is free text from the outside world (a remote API's response, a stack
 * frame), so it gets the same redaction check as a payload or a decision note before it can
 * appear on a card. The check runs on the untruncated string, so a restricted value split across
 * the 300-character cutoff cannot leak its first half.
 */
function executionFailureLine(error: string | undefined): string {
  if (!error || containsRestrictedPattern(error)) return EXECUTION_FAILURE_FALLBACK;
  const capped = error.length > MAX_EXECUTION_ERROR_LENGTH ? `${error.slice(0, MAX_EXECUTION_ERROR_LENGTH)}…` : error;
  return `Execution failed: ${capped}. Nothing was sent.`;
}

/** The two lines both cards open with: what was asked, and the arguments it was asked with. */
function headerLines(row: ApprovalRow): CardLine[] {
  return [
    {
      note: [
        { code: row.action },
        { text: ' · requested by ' },
        { code: row.requestedBy },
        { text: ' · expires ' },
        { at: row.expiresAt },
      ],
    },
    { code: payloadPreview(row.payload) },
  ];
}

function footer(row: ApprovalRow): NotePart[] {
  return [{ text: 'Approval ' }, { code: row.id }];
}

/**
 * The card a pending approval is posted as.
 *
 * Edit is offered only where a form can be opened. A surface without that capability gets two
 * buttons instead of three, which is honest and needs no fallback protocol — a button that
 * always failed would be worse than no button.
 */
export function approvalCard(row: ApprovalRow, capabilities: { forms: boolean }): Card {
  return {
    id: CARD_ID,
    title: 'Approval needed',
    subtitle: row.summary,
    notice: `Approval needed: ${row.summary}`,
    body: headerLines(row),
    actions: [
      { id: APPROVE_ACTION_ID, label: 'Approve', style: 'primary', value: row.id },
      ...(capabilities.forms ? [{ id: EDIT_ACTION_ID, label: 'Edit', style: 'default' as const, value: row.id }] : []),
      { id: DECLINE_ACTION_ID, label: 'Decline', style: 'danger', value: row.id },
    ],
    footer: footer(row),
  };
}

/** The same card after a human answered it: no buttons, and what happened underneath. */
export function decidedCard(row: ApprovalRow, outcome: { executed: boolean; tool?: string; error?: string }): Card {
  const who: NotePart = row.decidedBy ? { user: row.decidedBy } : { text: 'someone' };
  const when: NotePart[] = row.decidedAt ? [{ text: ' at ' }, { at: row.decidedAt }] : [];
  const parts: NotePart[] = [];
  if (row.status === 'approved') {
    parts.push({ icon: 'approved' }, { text: ' Approved by ' }, who, ...when, { text: '.' });
    if (outcome.executed) {
      parts.push(
        { text: '\nExecuted ' },
        { code: outcome.tool ?? row.action },
        { text: '. Delivery is queued in the effects outbox.' },
      );
    } else {
      parts.push({ text: `\n${executionFailureLine(outcome.error)}` });
    }
  } else {
    parts.push({ icon: 'declined' }, { text: ' Declined by ' }, who, ...when, { text: '. Nothing was sent.' });
    const note = orWithheld(row.decisionNote, 'note withheld: it did not pass the redaction check');
    if (note) parts.push({ text: `\nNote: ${note}` });
  }
  return {
    id: CARD_ID,
    title: 'Approval needed',
    subtitle: row.summary,
    notice: `Approval ${row.id} ${row.status}`,
    body: [...headerLines(row), { note: parts }],
    actions: [],
    footer: footer(row),
  };
}

/**
 * The note box Edit opens.
 *
 * The conversation travels in the metadata because a surface need not tell us where a form was
 * submitted from — some surfaces report none at all for a form opened from a button — and the
 * reply to the submission has to go somewhere.
 */
export function editForm(approvalId: string, conversation: string): Form {
  return {
    id: EDIT_FORM_ID,
    title: 'Send it back',
    submitLabel: 'Decline with note',
    cancelLabel: 'Cancel',
    intro:
      'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
    fields: [
      {
        id: EDIT_NOTE_FIELD_ID,
        label: 'What should change?',
        multiline: true,
        optional: false,
        maxLength: 1000,
        placeholder: 'Do not include patient or provider identifiers here.',
      },
    ],
    metadata: JSON.stringify({ approval_id: approvalId, conversation }),
  };
}

/**
 * Decode a form's metadata. Anything that fails to parse as this shape — a stale format, a
 * tampered value — yields `null` so the caller fails closed rather than guessing.
 *
 * `channel` is read as well as `conversation` for exactly one case: a note box opened before this
 * deployment upgraded and submitted after it. Three lines, and nobody loses a decision to a
 * restart.
 */
export function parseApprovalMetadata(raw: string): ApprovalMetadata | null {
  try {
    const parsed = JSON.parse(raw) as { approval_id?: unknown; conversation?: unknown; channel?: unknown };
    const where = [parsed.conversation, parsed.channel].find((v) => typeof v === 'string' && v !== '');
    if (typeof parsed.approval_id !== 'string' || parsed.approval_id === '') return null;
    if (typeof where !== 'string') return null;
    return { approvalId: parsed.approval_id, conversation: where };
  } catch {
    return null;
  }
}
