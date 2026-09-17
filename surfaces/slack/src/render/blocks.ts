import type { Card, CardIcon, CardLine, NotePart } from '@harness/surface-api';

/**
 * Block Kit, and the only place in the repository that knows what Block Kit is.
 *
 * Every function here takes a neutral `Card` and returns plain objects. The output is pinned
 * byte for byte against what `harness/approvals`' `domain/render/blocks.ts` produced before
 * Plan 6, because the demo deployment's card must not change: same blocks, same order, same
 * mrkdwn, same action ids.
 */

/** Slack's own date token, which renders in each reader's timezone. */
function slackDate(at: Date): string {
  const epoch = Math.floor(at.getTime() / 1000);
  return `<!date^${epoch}^{date_short_pretty} {time}|${at.toISOString()}>`;
}

const ICONS: Record<CardIcon, string> = {
  approved: ':white_check_mark:',
  declined: ':no_entry:',
};

function renderPart(part: NotePart): string {
  if ('text' in part) return part.text;
  if ('code' in part) return `\`${part.code}\``;
  if ('at' in part) return slackDate(part.at);
  if ('user' in part) return `<@${part.user}>`;
  return ICONS[part.icon];
}

function mrkdwnSection(text: string): unknown {
  return { type: 'section', text: { type: 'mrkdwn', text } };
}

function contextBlock(text: string): unknown {
  return { type: 'context', elements: [{ type: 'mrkdwn', text }] };
}

function renderLine(line: CardLine): unknown {
  if ('note' in line) return contextBlock(line.note.map(renderPart).join(''));
  if ('code' in line) return mrkdwnSection(`\`\`\`\n${line.code}\n\`\`\``);
  if ('label' in line) return mrkdwnSection(`*${line.label}*: ${line.value}`);
  return mrkdwnSection(line.text);
}

function button(action: Card['actions'][number]): unknown {
  return {
    type: 'button',
    action_id: action.id,
    text: { type: 'plain_text', text: action.label },
    value: action.value,
    // `default` is the absence of a style in Block Kit, not a value it accepts.
    ...(action.style === 'default' ? {} : { style: action.style }),
  };
}

export function cardBlocks(card: Card): unknown[] {
  const head = card.subtitle === undefined ? `*${card.title}*` : `*${card.title}*\n${card.subtitle}`;
  const blocks: unknown[] = [mrkdwnSection(head)];
  for (const line of card.body) blocks.push(renderLine(line));
  if (card.actions.length > 0) {
    blocks.push({
      type: 'actions',
      // Derived from the card's own id rather than hard-coded, so this module never learns what
      // kind of card it is rendering. For `harness_approval` it is the block id the demo
      // deployment's interaction payloads already carry. It follows `type` because that is the
      // order today's `blocks.ts` emits, and the render test compares serialised bytes.
      block_id: `${card.id}_actions`,
      elements: card.actions.map(button),
    });
  }
  if (card.footer) blocks.push(contextBlock(card.footer.map(renderPart).join('')));
  return blocks;
}
