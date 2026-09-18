/**
 * Turn the model's Markdown into Slack's `mrkdwn`. Slack does not parse `**bold**`, `# heading`,
 * or `[text](url)` — it shows the literal characters — so every outgoing message is passed
 * through this before it is posted or streamed.
 *
 * Fenced and inline code are pulled out first and put back untouched at the end, so a token that
 * only looks like a heading or a link inside a code span is never rewritten. A GFM table has no
 * `mrkdwn` equivalent, so it is rendered as a fenced code block instead of being torn apart; that
 * new fence is protected the same way, so a later pass cannot re-read its pipes as another table.
 *
 * The one real ambiguity is a single asterisk: Markdown's `*x*` is italic, but Slack's `*x*` is
 * bold — the same two characters mean opposite things on either side of this function. `**x**`
 * and `__x__` are resolved in the same regex pass that looks for a lone `*x*`, so within one call
 * a bold phrase is never re-read as italic. That does not make the function idempotent for a
 * single word wrapped in one asterisk: `*ok*` produced by this function (originally `**ok**`) is
 * four characters identical to a lone Markdown `*ok*`, so calling it again turns that one case
 * into `_ok_`. Anything with a space inside the asterisks — the common case for real prose and
 * for headings — has no such twin and round-trips cleanly, which is what the tests below check.
 */

const FENCE_RE = /```[\s\S]*?```/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;

const TABLE_SEPARATOR_RE = /^[ \t]*\|?(?:[ \t]*:?-{2,}:?[ \t]*\|)+[ \t]*:?-{2,}:?[ \t]*\|?[ \t]*$/;

const LINK_RE = /\[([^\]]+)\]\(([^)\s]+)\)/g;

// Alternation order matters: `**`/`__` are tried before the lone-`*` branch, and the whole thing
// runs as one pass over the original text, so a bold span is consumed whole and never seen again
// by the italic branch within this call. The italic branch captures its own leading boundary
// (rather than a lookbehind) and requires no whitespace right inside either asterisk, so a bullet
// marker like `* item` (a space right after the star) never matches.
const EMPHASIS_RE = /\*\*([^*]+?)\*\*|__([^_]+?)__|(^|[\s([{"'])\*(?!\s)([^\s*]+?)\*(?=[\s)\]}"'.,!?;:]|$)/gm;

const HEADING_RE = /^#{1,6}[ \t]+(.+)$/gm;

/** A one-off placeholder vault: swap text out for a token now, put it back verbatim later. */
function createVault() {
  const stored: string[] = [];
  const hold = (text: string): string => {
    stored.push(text);
    return `\uE000${stored.length - 1}\uE000`;
  };
  const release = (text: string): string => text.replace(/\uE000(\d+)\uE000/g, (_, i) => stored[Number(i)]);
  return { hold, release };
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

function convertLinks(text: string): string {
  return text.replace(LINK_RE, (_, label: string, url: string) => `<${url}|${label}>`);
}

function convertEmphasis(text: string): string {
  return text.replace(
    EMPHASIS_RE,
    (
      _match,
      bold: string | undefined,
      boldUnderscore: string | undefined,
      lead: string | undefined,
      italic: string | undefined,
    ) => {
      if (bold !== undefined) return `*${bold}*`;
      if (boldUnderscore !== undefined) return `*${boldUnderscore}*`;
      return `${lead}_${italic}_`;
    },
  );
}

// A heading's own bold wrapping is added after `convertEmphasis` has already run, using a
// sentinel rather than a literal `*`, so it can never be mistaken for a lone-italic candidate
// within this same call — including a one-word heading like `# Intro`, which would otherwise
// look exactly like the ambiguous case described above.
function convertHeadings(text: string): string {
  return text.replace(HEADING_RE, (_, content: string) => `\uE001${content}\uE001`);
}

export function toMrkdwn(text: string): string {
  const { hold, release } = createVault();
  let out = extractCode(text, hold);
  out = tableToCodeBlocks(out, hold);
  out = convertLinks(out);
  out = convertEmphasis(out);
  out = convertHeadings(out);
  out = out.replace(/\uE001/g, '*');
  return release(out);
}
