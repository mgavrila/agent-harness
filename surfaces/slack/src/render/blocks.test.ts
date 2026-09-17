import { describe, expect, it } from 'vitest';
import type { Card } from '@harness/surface-api';
import { cardBlocks } from './blocks.js';

/**
 * The approval the whole repository uses as its fixture, as a `Card`.
 *
 * Every string here is what `harness/approvals`' `approvalCard` produces from `approvalRow()`,
 * and the expectations below are what `domain/render/blocks.ts` produced from the same row
 * before this plan moved it. The pair is the proof that the demo deployment's card did not
 * change: the host's own test asserts the left-hand side, this file asserts the right.
 */
const APPROVAL_ID = '11111111-1111-4111-8111-111111111111';
const PAYLOAD_PREVIEW =
  '{\n  "tool": "forms_release",\n  "args": {\n    "file_id": "roster/aetna-abc123def456.csv"\n  }\n}';

const pendingCard: Card = {
  id: 'harness_approval',
  title: 'Approval needed',
  subtitle: 'forms_release (external) requested by hermes',
  notice: 'Approval needed: forms_release (external) requested by hermes',
  body: [
    {
      note: [
        { code: 'forms_release' },
        { text: ' · requested by ' },
        { code: 'hermes' },
        { text: ' · expires ' },
        { at: new Date('2026-09-16T12:00:00Z') },
      ],
    },
    { code: PAYLOAD_PREVIEW },
  ],
  actions: [
    { id: 'harness_approval_approve', label: 'Approve', style: 'primary', value: APPROVAL_ID },
    { id: 'harness_approval_edit', label: 'Edit', style: 'default', value: APPROVAL_ID },
    { id: 'harness_approval_decline', label: 'Decline', style: 'danger', value: APPROVAL_ID },
  ],
  footer: [{ text: 'Approval ' }, { code: APPROVAL_ID }],
};

const header = [
  {
    type: 'section',
    text: { type: 'mrkdwn', text: '*Approval needed*\nforms_release (external) requested by hermes' },
  },
  {
    type: 'context',
    elements: [
      {
        type: 'mrkdwn',
        text: '`forms_release` · requested by `hermes` · expires <!date^1789560000^{date_short_pretty} {time}|2026-09-16T12:00:00.000Z>',
      },
    ],
  },
  { type: 'section', text: { type: 'mrkdwn', text: `\`\`\`\n${PAYLOAD_PREVIEW}\n\`\`\`` } },
];

const footer = { type: 'context', elements: [{ type: 'mrkdwn', text: `Approval \`${APPROVAL_ID}\`` }] };

/**
 * The pin. `JSON.stringify` on both sides rather than `toEqual`, because what Slack receives is
 * the serialised bytes: a renderer that emitted `block_id` before `type` would satisfy deep
 * equality and change the payload. Key order in every literal in this file is today's order.
 */
function pin(actual: unknown, expected: unknown): void {
  expect(JSON.stringify(actual)).toBe(JSON.stringify(expected));
}

describe('cardBlocks', () => {
  it('renders the pending approval card exactly as the Slack app rendered it before Plan 6', () => {
    pin(cardBlocks(pendingCard), [
      ...header,
      {
        type: 'actions',
        block_id: 'harness_approval_actions',
        elements: [
          {
            type: 'button',
            action_id: 'harness_approval_approve',
            text: { type: 'plain_text', text: 'Approve' },
            value: APPROVAL_ID,
            style: 'primary',
          },
          {
            type: 'button',
            action_id: 'harness_approval_edit',
            text: { type: 'plain_text', text: 'Edit' },
            value: APPROVAL_ID,
          },
          {
            type: 'button',
            action_id: 'harness_approval_decline',
            text: { type: 'plain_text', text: 'Decline' },
            value: APPROVAL_ID,
            style: 'danger',
          },
        ],
      },
      footer,
    ]);
  });

  it('renders the approved decided card exactly as it did before, with no buttons left on it', () => {
    const decided: Card = {
      ...pendingCard,
      notice: `Approval ${APPROVAL_ID} approved`,
      body: [
        ...pendingCard.body,
        {
          note: [
            { icon: 'approved' },
            { text: ' Approved by ' },
            { user: 'U012' },
            { text: ' at ' },
            { at: new Date('2026-09-15T12:05:00Z') },
            { text: '.' },
            { text: '\nExecuted ' },
            { code: 'forms_release' },
            { text: '. Delivery is queued in the effects outbox.' },
          ],
        },
      ],
      actions: [],
    };
    pin(cardBlocks(decided), [
      ...header,
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':white_check_mark: Approved by <@U012> at <!date^1789473900^{date_short_pretty} {time}|2026-09-15T12:05:00.000Z>.\nExecuted `forms_release`. Delivery is queued in the effects outbox.',
          },
        ],
      },
      footer,
    ]);
  });

  it('renders the declined decided card exactly as it did before, note and all', () => {
    const declined: Card = {
      ...pendingCard,
      notice: `Approval ${APPROVAL_ID} declined`,
      body: [
        ...pendingCard.body,
        {
          note: [
            { icon: 'declined' },
            { text: ' Declined by ' },
            { user: 'U012' },
            { text: ' at ' },
            { at: new Date('2026-09-15T12:05:00Z') },
            { text: '. Nothing was sent.' },
            { text: '\nNote: Use the Q4 roster.' },
          ],
        },
      ],
      actions: [],
    };
    pin(cardBlocks(declined), [
      ...header,
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: ':no_entry: Declined by <@U012> at <!date^1789473900^{date_short_pretty} {time}|2026-09-15T12:05:00.000Z>. Nothing was sent.\nNote: Use the Q4 roster.',
          },
        ],
      },
      footer,
    ]);
  });

  it('renders a plain line and a labelled one as their own sections', () => {
    const blocks = cardBlocks({
      ...pendingCard,
      subtitle: undefined,
      footer: undefined,
      actions: [],
      body: [{ text: 'just a line' }, { label: 'Payer', value: 'Aetna' }],
    });
    expect(blocks).toEqual([
      { type: 'section', text: { type: 'mrkdwn', text: '*Approval needed*' } },
      { type: 'section', text: { type: 'mrkdwn', text: 'just a line' } },
      { type: 'section', text: { type: 'mrkdwn', text: '*Payer*: Aetna' } },
    ]);
  });
});
