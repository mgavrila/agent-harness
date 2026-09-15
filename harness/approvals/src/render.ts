import type { approvals } from '@harness/db';

export type ApprovalRow = typeof approvals.$inferSelect;

export const APPROVE_ACTION_ID = 'harness_approval_approve';
export const EDIT_ACTION_ID = 'harness_approval_edit';
export const DECLINE_ACTION_ID = 'harness_approval_decline';
export const EDIT_MODAL_CALLBACK_ID = 'harness_approval_edit_modal';
export const EDIT_NOTE_BLOCK_ID = 'harness_approval_note';
export const EDIT_NOTE_ACTION_ID = 'harness_approval_note_input';

/**
 * Shapes a restricted identifier takes in text. This is the last line of
 * defence, not the first: the tools already redact `approvals.payload`. It
 * catches a value that reached the card by a route nobody anticipated, and a
 * false positive only costs the approver a look at the audit log.
 */
const RESTRICTED_PATTERNS: RegExp[] = [
  /\b\d{3}-\d{2}-\d{4}\b/, // US social security number
  /\b\d{2}-\d{7}\b/, // employer identification number
  /\b[A-Za-z]{2}\d{7}\b/, // DEA registration
];

export function containsRestrictedPattern(text: string): boolean {
  return RESTRICTED_PATTERNS.some((re) => re.test(text));
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

/** A Slack `<!date>` token, which renders in the reader's own timezone. */
function slackDate(at: Date): string {
  const epoch = Math.floor(at.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

function contextBlock(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function headerBlocks(row: ApprovalRow): unknown[] {
  return [
    { type: 'section', text: { type: 'mrkdwn', text: `*Approval needed*\n${row.summary}` } },
    contextBlock(`\`${row.action}\` · requested by \`${row.requestedBy}\` · expires ${slackDate(row.expiresAt)}`),
    { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${payloadPreview(row.payload)}\n\`\`\`` } },
  ];
}

function button(actionId: string, text: string, value: string, style?: 'primary' | 'danger'): unknown {
  return {
    type: 'button',
    action_id: actionId,
    text: { type: 'plain_text', text },
    value,
    ...(style ? { style } : {}),
  };
}

export function approvalBlocks(row: ApprovalRow): unknown[] {
  return [
    ...headerBlocks(row),
    {
      type: 'actions',
      block_id: 'harness_approval_actions',
      elements: [
        button(APPROVE_ACTION_ID, 'Approve', row.id, 'primary'),
        button(EDIT_ACTION_ID, 'Edit', row.id),
        button(DECLINE_ACTION_ID, 'Decline', row.id, 'danger'),
      ],
    },
    contextBlock(`Approval \`${row.id}\``),
  ];
}

/** The plain-text fallback a notification shows. Built from the summary only. */
export function approvalFallbackText(row: ApprovalRow): string {
  return `Approval needed: ${row.summary}`;
}

/** A human-written note may contain anything, so it passes the same check as a payload. */
function safeNote(note: string | null): string | null {
  if (!note) return null;
  return containsRestrictedPattern(note) ? 'note withheld: it did not pass the redaction check' : note;
}

const EXECUTION_FAILURE_FALLBACK = 'Execution failed; see the audit log. Nothing was sent.';
const MAX_EXECUTION_ERROR_LENGTH = 300;

/**
 * A tool's error message is free text from the outside world (a remote API's
 * response, a stack frame), so it gets the same redaction check as a payload
 * or a decision note before it can appear on a card. The check runs on the
 * untruncated string, so a restricted value split across the 300-character
 * cutoff cannot leak its first half.
 */
function executionFailureLine(error: string | undefined): string {
  if (!error || containsRestrictedPattern(error)) return EXECUTION_FAILURE_FALLBACK;
  const capped = error.length > MAX_EXECUTION_ERROR_LENGTH ? `${error.slice(0, MAX_EXECUTION_ERROR_LENGTH)}…` : error;
  return `Execution failed: ${capped}. Nothing was sent.`;
}

export function decidedBlocks(row: ApprovalRow, outcome: { executed: boolean; tool?: string; error?: string }): unknown[] {
  const who = row.decidedBy ? `<@${row.decidedBy}>` : 'someone';
  const when = row.decidedAt ? ` at ${slackDate(row.decidedAt)}` : '';
  const lines: string[] = [];
  if (row.status === 'approved') {
    lines.push(`:white_check_mark: Approved by ${who}${when}.`);
    if (outcome.executed) lines.push(`Executed \`${outcome.tool ?? row.action}\`. Delivery is queued in the effects outbox.`);
    else lines.push(executionFailureLine(outcome.error));
  } else {
    lines.push(`:no_entry: Declined by ${who}${when}. Nothing was sent.`);
    const note = safeNote(row.decisionNote);
    if (note) lines.push(`Note: ${note}`);
  }
  return [...headerBlocks(row), contextBlock(lines.join('\n')), contextBlock(`Approval \`${row.id}\``)];
}

export function editModalView(approvalId: string): Record<string, unknown> {
  return {
    type: 'modal',
    callback_id: EDIT_MODAL_CALLBACK_ID,
    private_metadata: approvalId,
    title: { type: 'plain_text', text: 'Send it back' },
    submit: { type: 'plain_text', text: 'Decline with note' },
    close: { type: 'plain_text', text: 'Cancel' },
    blocks: [
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: 'This declines the request and sends your note back to the agent, which will redo the action and ask again. It releases nothing.',
        },
      },
      {
        type: 'input',
        block_id: EDIT_NOTE_BLOCK_ID,
        label: { type: 'plain_text', text: 'What should change?' },
        element: {
          type: 'plain_text_input',
          action_id: EDIT_NOTE_ACTION_ID,
          multiline: true,
          max_length: 1000,
          placeholder: { type: 'plain_text', text: 'Do not include patient or provider identifiers here.' },
        },
      },
    ],
  };
}
