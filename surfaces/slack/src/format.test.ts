import { describe, expect, it } from 'vitest';
import { toMrkdwn } from './format.js';

// Same literal value as `WITHHELD` in `harness/host/src/domain/threads/repository.ts`, kept
// inline here so this test does not need a dependency on that package.
const WITHHELD = '(withheld: it did not pass the redaction check)';

describe('toMrkdwn', () => {
  it('turns **bold** into Slack bold', () => {
    expect(toMrkdwn('this is **bold** text')).toBe('this is *bold* text');
  });

  it('turns __bold__ into Slack bold', () => {
    expect(toMrkdwn('this is __bold__ text')).toBe('this is *bold* text');
  });

  it('turns a lone *italic* into Slack italic', () => {
    expect(toMrkdwn('this is *emphasized* text')).toBe('this is _emphasized_ text');
  });

  it('turns a heading line into a bold line and drops the hashes', () => {
    expect(toMrkdwn('# Heading one')).toBe('*Heading one*');
    expect(toMrkdwn('## Heading two')).toBe('*Heading two*');
    expect(toMrkdwn('### Heading three')).toBe('*Heading three*');
  });

  it('turns a Markdown link into a Slack link', () => {
    expect(toMrkdwn('see [the docs](https://example.com/docs) for more')).toBe(
      'see <https://example.com/docs|the docs> for more',
    );
  });

  it('turns a Markdown table into a fenced code block', () => {
    const table = '| Step | Owner |\n|---|---|\n| Fix | Alice |';
    expect(toMrkdwn(table)).toBe('```\n' + table + '\n```');
  });

  it('leaves fenced code untouched, markdown inside it included', () => {
    const text = 'before\n```js\nconst x = 1; // **not bold**, not a [link](url) either\n```\nafter';
    expect(toMrkdwn(text)).toBe(text);
  });

  it('leaves inline code untouched', () => {
    expect(toMrkdwn('run `git **status**` now')).toBe('run `git **status**` now');
  });

  it('leaves a numbered list unchanged', () => {
    expect(toMrkdwn('1. first\n2. second\n3. third')).toBe('1. first\n2. second\n3. third');
  });

  it('leaves a dashed list unchanged', () => {
    expect(toMrkdwn('- one\n- two\n- three')).toBe('- one\n- two\n- three');
  });

  it('leaves a starred bullet list unchanged (a bullet star has a space right after it)', () => {
    expect(toMrkdwn('* one\n* two')).toBe('* one\n* two');
  });

  it('is a no-op on plain prose with no markdown in it', () => {
    const text = 'Nothing special here, just a sentence with a colon: and a comma, too.';
    expect(toMrkdwn(text)).toBe(text);
  });

  it('is a no-op on text already written in mrkdwn', () => {
    const text = 'Already _italic_, already ~struck~, a <https://example.com|link>, and `code`.';
    expect(toMrkdwn(text)).toBe(text);
  });

  it('leaves a restricted-pattern WITHHELD marker unchanged', () => {
    expect(toMrkdwn(WITHHELD)).toBe(WITHHELD);
    expect(toMrkdwn(`Some reply.\n${WITHHELD}`)).toBe(`Some reply.\n${WITHHELD}`);
  });

  it('is idempotent on a realistic mixed message', () => {
    const text = [
      '## Next Steps',
      '',
      'Here is what we found:',
      '',
      '- **Root cause**: a race in the retry loop',
      '- See the [postmortem](https://example.com/pm) for details',
      '',
      '```js',
      'const x = 1; // **not bold**',
      '```',
      '',
      '| Step | Owner |',
      '|---|---|',
      '| Fix | Alice |',
      '',
      'Thanks for your *patience* during this.',
    ].join('\n');
    const once = toMrkdwn(text);
    expect(toMrkdwn(once)).toBe(once);
  });

  it('is idempotent on multi-word bold, headings and italics', () => {
    const text = 'This is **very important** and *quite urgent*.\n## A Longer Heading';
    const once = toMrkdwn(text);
    expect(toMrkdwn(once)).toBe(once);
  });

  it('is idempotent when there is nothing to convert', () => {
    const text = 'plain text with no markers at all';
    expect(toMrkdwn(toMrkdwn(text))).toBe(toMrkdwn(text));
  });
});
