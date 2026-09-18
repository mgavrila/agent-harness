import { describe, expect, it } from 'vitest';
import { toMrkdwn } from './format.js';

// Same literal value as `WITHHELD` in `harness/host/src/domain/threads/repository.ts`, kept
// inline here so this test does not need a dependency on that package.
const WITHHELD = '(withheld: it did not pass the redaction check)';

describe('toMrkdwn', () => {
  it('turns **bold** into Slack bold', () => {
    expect(toMrkdwn('this is **bold** text')).toBe('this is *bold* text');
  });

  it('turns a multi-word __bold phrase__ into Slack bold', () => {
    expect(toMrkdwn('this is __really bold__ text')).toBe('this is *really bold* text');
  });

  it('leaves a one-word __bold__ alone, because that is the shape an identifier has', () => {
    expect(toMrkdwn('this is __bold__ text')).toBe('this is __bold__ text');
  });

  it('leaves dunder and SCREAMING__SNAKE identifiers in prose verbatim', () => {
    expect(toMrkdwn('call __init__ before __main__ runs')).toBe('call __init__ before __main__ runs');
    expect(toMrkdwn('the env var MY__VAR__NAME is set')).toBe('the env var MY__VAR__NAME is set');
    expect(toMrkdwn('__main__ at the start of a line')).toBe('__main__ at the start of a line');
  });

  it('keeps a URL out of the emphasis pass, in a link and bare', () => {
    expect(toMrkdwn('see [wiki](https://example.com/foo__bar__baz) for it')).toBe(
      'see <https://example.com/foo__bar__baz|wiki> for it',
    );
    expect(toMrkdwn('see [wiki](https://example.com/a*b*c) for it')).toBe(
      'see <https://example.com/a*b*c|wiki> for it',
    );
    expect(toMrkdwn('read https://example.com/a__b__c now')).toBe('read https://example.com/a__b__c now');
    expect(toMrkdwn('read https://example.com/a*b*c now')).toBe('read https://example.com/a*b*c now');
  });

  it('converts a bold span that holds an italic one', () => {
    expect(toMrkdwn('**bold *and emphatic*, too**')).toBe('*bold _and emphatic_, too*');
    expect(toMrkdwn('a **b *c* d** e')).toBe('a *b _c_ d* e');
  });

  it('converts adjacent emphasis spans', () => {
    expect(toMrkdwn('**one** and **two** and *three*')).toBe('*one* and *two* and _three_');
    expect(toMrkdwn('**one**, __two words__ and *three*.')).toBe('*one*, *two words* and _three_.');
  });

  it('leaves an asterisk used as multiplication alone', () => {
    expect(toMrkdwn('3 * 4 is 12, a*b is a product, 5*3=15')).toBe('3 * 4 is 12, a*b is a product, 5*3=15');
  });

  it('escapes the three characters Slack reserves', () => {
    expect(toMrkdwn('a < b && c > d')).toBe('a &lt; b &amp;&amp; c &gt; d');
    expect(toMrkdwn('an Array<string> & a Map<K, V>')).toBe('an Array&lt;string&gt; &amp; a Map&lt;K, V&gt;');
  });

  it('leaves Slack syntax already in the text unescaped', () => {
    const text = 'hi <@U123>, see <#C456|general>, <!here> and <https://example.com|the docs>';
    expect(toMrkdwn(text)).toBe(text);
  });

  it('escapes a converted link without touching the link syntax it emits', () => {
    expect(toMrkdwn('see [a & b](https://example.com/q?x=1&y=2) now')).toBe(
      'see <https://example.com/q?x=1&amp;y=2|a &amp; b> now',
    );
  });

  it('escapes inside a code span, whose content Slack renders back', () => {
    expect(toMrkdwn('run `cmp a < b && c > d` now')).toBe('run `cmp a &lt; b &amp;&amp; c &gt; d` now');
    expect(toMrkdwn('```\nif (a < b) { x = a & b; }\n```')).toBe('```\nif (a &lt; b) { x = a &amp; b; }\n```');
  });

  it('leaves a line-leading > as a Slack blockquote', () => {
    expect(toMrkdwn('> quoted\n>> deeper\nplain a > b')).toBe('> quoted\n>> deeper\nplain a &gt; b');
  });

  it('converts a long adversarial run of unmatched brackets quickly', () => {
    const text = '[a'.repeat(40_000);
    expect(text.length).toBe(80_000);
    const started = performance.now();
    const out = toMrkdwn(text);
    const elapsed = performance.now() - started;
    expect(out).toBe(text);
    expect(elapsed).toBeLessThan(100);
  });

  it('is not idempotent for the one documented case, a single word in one asterisk', () => {
    const once = toMrkdwn('**ok**');
    expect(once).toBe('*ok*');
    expect(toMrkdwn(once)).toBe('_ok_');
  });

  it('is idempotent on a nested span, a link, a mention and a quote', () => {
    const text = '> **bold *and emphatic*, too** <@U123>\nsee [wiki](https://example.com/a__b__c)';
    const once = toMrkdwn(text);
    expect(toMrkdwn(once)).toBe(once);
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

  it('puts back a code span held inside another held span', () => {
    const table = '| a | `b` |\n|---|---|\n| c | d |';
    expect(toMrkdwn(table)).toBe('```\n' + table + '\n```');
    expect(toMrkdwn('a mention `<@U123>` inside code')).toBe('a mention `<@U123>` inside code');
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
