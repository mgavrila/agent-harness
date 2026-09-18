/**
 * Turn the model's Markdown into Slack's `mrkdwn`. Slack does not parse `**bold**`, `# heading`,
 * or `[text](url)` — it shows the literal characters — so every outgoing message is passed
 * through this before it is posted or streamed.
 *
 * Escaping comes first: `&`, `<` and `>` become `&amp;`, `&lt;` and `&gt;`, which is what Slack's
 * `mrkdwn` contract asks of a caller, because `<…>` is Slack's own syntax. The syntax already in
 * the text — a `<@U…>` mention, a `<#C…|…>` channel ref, `<!here>`, an `<url|label>` link — is
 * held aside before that pass and put back verbatim, and a line-leading `>` stays a blockquote.
 * Everything this function itself emits is emitted afterwards, so the cure never corrupts it.
 * Escaping is the one step that does not survive being applied twice: `&amp;` would become
 * `&amp;amp;`. Both call sites call this once, on the model's own Markdown.
 *
 * Fenced and inline code are pulled out next and put back untouched at the end, so a token that
 * only looks like a heading or a link inside a code span is never rewritten — its `<` and `&` are
 * still escaped, and Slack renders `&lt;` inside a code span back as `<`. A GFM table has no
 * `mrkdwn` equivalent, so it is rendered as a fenced code block instead of being torn apart; that
 * new fence is protected the same way, so a later pass cannot re-read its pipes as another table.
 * A link's URL — and a bare `http(s)://…` URL — is held aside as well, before any emphasis runs,
 * so an `_` or a `*` inside a URL is never read as a marker and a destination is never rewritten.
 *
 * Emphasis is one left-to-right scan rather than one regex, so a bold span can hold an italic one
 * (`**bold *and emphatic*, too**` -> `*bold _and emphatic_, too*`) and what the scan has already
 * converted is never re-read as another marker. The one real ambiguity is a single asterisk:
 * Markdown's `*x*` is italic, but Slack's `*x*` is bold — the same two characters mean opposite
 * things on either side of this function. A lone `*…*` is read as Markdown italic when it wraps a
 * single word, or when it sits inside a `**…**` span that has already proved the text is Markdown;
 * `*two words*` at the top level is left alone, because that is exactly what this function
 * produces for `**two words**` and re-reading it would flip a bold phrase to italic on a second
 * call. `__…__` is bold only when non-word characters flank it and it wraps more than one word, so
 * `__init__`, `__main__` and `MY__VAR__NAME` — identifiers a model writes about code outside a
 * code span — keep their underscores.
 *
 * What is left is idempotent apart from escaping: a heading, a link, a table, a bold phrase and a
 * nested span all round-trip. The one exception is a single word wrapped in one asterisk: `*ok*`
 * produced here (originally `**ok**`) is four characters identical to a lone Markdown `*ok*`, so
 * calling this again turns that one case into `_ok_`, which the tests below pin.
 */

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

const TABLE_SEPARATOR_RE = /^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/;

// Slack syntax that is already valid in an outgoing message: mentions, channel refs, the `<!…>`
// specials, and links. Held out of the escape pass rather than escaped into visible junk.
const SLACK_TOKEN_RE = /<(?:[@#!][^<>|\s]+|(?:https?|mailto):[^<>|\s]+)(?:\|[^<>]*)?>/g;

const ESCAPED: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;' };
const ESCAPE_RE = /[&<>]/g;
// A line-leading `>` is Slack's own blockquote marker, so it is given back after the escape pass.
const QUOTE_RE = /^([ \t]*)((?:&gt;)+)/gm;

// A bare URL, held aside so that an `_` or a `*` inside it is never read as emphasis.
const BARE_URL_RE = /\bhttps?:\/\/[^\s<>]+/g;

const HEADING_RE = /^#{1,6}[ \t]+(.+)$/gm;

// What may sit immediately outside a lone `*…*`: the same boundaries the old regex enforced, so a
// bullet marker (`* item`), a product (`a*b`, `3 * 4`) and a stray asterisk stay literal.
const ITALIC_OPEN = /[\s([{"']/;
const ITALIC_CLOSE = /[\s)\]}"'.,!?;:]/;
const WORD = /[A-Za-z0-9_]/;

/** A one-off placeholder vault: swap text out for a token now, put it back verbatim later. */
function createVault() {
  const stored: string[] = [];
  const hold = (text: string): string => {
    stored.push(text);
    return `${stored.length - 1}`;
  };
  // Held text can itself hold a placeholder — a mention inside a code span, an inline code span
  // inside a table — so this puts things back until nothing is left to put back. Each placeholder
  // refers to something held earlier, so the number of holds bounds the nesting and the loop.
  const release = (text: string): string => {
    let out = text;
    for (let pass = 0; pass <= stored.length && out.includes(''); pass += 1) {
      out = out.replace(/(\d+)/g, (_, i) => stored[Number(i)]);
    }
    return out;
  };
  return { hold, release };
}

/**
 * Slack's `mrkdwn` contract: the caller escapes `&`, `<` and `>` in body text. Slack's own syntax
 * in the text is held first so it survives, and a line-leading `>` is put back as a blockquote.
 */
function escapeForSlack(text: string, hold: (s: string) => string): string {
  return text
    .replace(SLACK_TOKEN_RE, hold)
    .replace(ESCAPE_RE, (c) => ESCAPED[c])
    .replace(QUOTE_RE, (_, indent: string, quotes: string) => indent + '>'.repeat(quotes.length / '&gt;'.length));
}

/** Fenced and inline code, held out of every later pass so nothing inside is ever rewritten. */
function extractCode(text: string, hold: (s: string) => string): string {
  return text.replace(FENCE_RE, hold).replace(INLINE_CODE_RE, hold);
}

/**
 * A GFM table — a header row, a `---`/`:-:` separator row, and the rows that follow it — has
 * nothing in `mrkdwn` to become, so the whole block is held as a fenced code block instead.
 */
function tableToCodeBlocks(text: string, hold: (s: string) => string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const header = lines[i];
    const separator = lines[i + 1];
    if (header.includes('|') && separator !== undefined && TABLE_SEPARATOR_RE.test(separator)) {
      const block = [header, separator];
      let j = i + 2;
      while (j < lines.length && lines[j].includes('|') && lines[j].trim() !== '') {
        block.push(lines[j]);
        j++;
      }
      out.push(hold('```\n' + block.join('\n') + '\n```'));
      i = j;
      continue;
    }
    out.push(header);
    i++;
  }
  return out.join('\n');
}

/** The URL of a `[label](url)`, or nothing if what follows the `](` is not one. */
function readUrl(text: string, start: number): string | undefined {
  const end = text.indexOf(')', start);
  if (end === -1 || end === start) return undefined;
  const url = text.slice(start, end);
  return /\s/.test(url) ? undefined : url;
}

/**
 * `[label](url)` -> `<url|label>`, as one left-to-right scan: a `[` that starts no link costs the
 * single `indexOf` that proved it, never a walk back over the rest of the message, so a long run
 * of unmatched brackets is linear rather than quadratic. The URL is held as it is read, so the
 * emphasis pass that follows can never rewrite a destination.
 */
function convertLinks(text: string, hold: (s: string) => string): string {
  let out = '';
  let i = 0;
  for (;;) {
    const open = text.indexOf('[', i);
    if (open === -1) return out + text.slice(i);
    const close = text.indexOf(']', open + 1);
    if (close === -1) return out + text.slice(i);
    const url = text[close + 1] === '(' ? readUrl(text, close + 2) : undefined;
    if (url === undefined || close === open + 1) {
      // Every `[` between here and that `]` would find the same `]` and fail the same way.
      out += text.slice(i, close + 1);
      i = close + 1;
      continue;
    }
    out += text.slice(i, open) + `<${hold(url)}|${text.slice(open + 1, close)}>`;
    i = close + 2 + url.length + 1;
  }
}

/**
 * The closing `**`/`__` of a strong span that opens at `open`, or -1. The nearest closer wins, no
 * span crosses a blank line, and `__` additionally has to be flanked by non-word characters and to
 * wrap more than one word, which is what keeps `__init__` and `MY__VAR__NAME` verbatim.
 */
function findStrong(text: string, open: number, to: number, marker: string): number {
  if (text[open + 1] !== marker) return -1;
  let close = -1;
  for (let j = open + 2; j + 1 < to; j += 1) {
    if (text[j] === '\n' && text[j + 1] === '\n') return -1;
    if (text[j] === marker && text[j + 1] === marker) {
      close = j;
      break;
    }
  }
  if (close === -1) return -1;
  const body = text.slice(open + 2, close);
  if (body === '' || /^\s|\s$/.test(body)) return -1;
  if (marker === '*') return close;
  const before = open === 0 ? undefined : text[open - 1];
  const after = text[close + 2];
  const flanked = (before === undefined || !WORD.test(before)) && (after === undefined || !WORD.test(after));
  return flanked && /\s/.test(body) ? close : -1;
}

/**
 * The closing `*` of an italic span that opens at `open`, or -1. Outside a bold span the content
 * has to be a single word — a multi-word `*…*` is what this function emits for `**…**`, and
 * re-reading it would flip a bold phrase to italic.
 */
function findItalic(text: string, open: number, to: number, nested: boolean): number {
  const before = open === 0 ? undefined : text[open - 1];
  if (before !== undefined && !ITALIC_OPEN.test(before)) return -1;
  const start = open + 1;
  if (start >= to || /\s/.test(text[start])) return -1;
  for (let j = start + 1; j < to; j += 1) {
    if (text[j] !== '*') {
      if (/\s/.test(text[j]) && (!nested || (text[j] === '\n' && text[j + 1] === '\n'))) return -1;
      continue;
    }
    if (/\s/.test(text[j - 1])) return -1;
    const after = j + 1 >= to ? undefined : text[j + 1];
    return after === undefined || ITALIC_CLOSE.test(after) ? j : -1;
  }
  return -1;
}

/**
 * One pass over `text[from, to)`. What the scan converts is written to the output and never looked
 * at again, so a bold span's own `*` is never re-read as italic within this call and a span can
 * hold another. `nested` is true inside a strong span, where the enclosing `**`/`__` has already
 * settled that this is Markdown and a multi-word `*…*` is unambiguously italic.
 */
function scanEmphasis(text: string, from: number, to: number, nested: boolean): string {
  let out = '';
  let i = from;
  while (i < to) {
    const ch = text[i];
    const strong = ch === '*' || ch === '_' ? findStrong(text, i, to, ch) : -1;
    if (strong !== -1) {
      out += `*${scanEmphasis(text, i + 2, strong, true)}*`;
      i = strong + 2;
      continue;
    }
    if (ch === '*') {
      const italic = findItalic(text, i, to, nested);
      if (italic !== -1) {
        out += `_${scanEmphasis(text, i + 1, italic, nested)}_`;
        i = italic + 1;
        continue;
      }
    }
    out += ch;
    i += 1;
  }
  return out;
}

function convertEmphasis(text: string): string {
  return scanEmphasis(text, 0, text.length, false);
}

// A heading's own bold wrapping is added after `convertEmphasis` has already run, using a
// sentinel rather than a literal `*`, so it can never be mistaken for a lone-italic candidate
// within this same call — including a one-word heading like `# Intro`, which would otherwise
// look exactly like the ambiguous case described above.
function convertHeadings(text: string): string {
  return text.replace(HEADING_RE, (_, content: string) => `${content}`);
}

export function toMrkdwn(text: string): string {
  const { hold, release } = createVault();
  let out = escapeForSlack(text, hold);
  out = extractCode(out, hold);
  out = tableToCodeBlocks(out, hold);
  out = convertLinks(out, hold);
  out = out.replace(BARE_URL_RE, hold);
  out = convertEmphasis(out);
  out = convertHeadings(out);
  out = out.replace(//g, '*');
  return release(out);
}
