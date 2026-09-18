import { ToolError } from '@harness/shared';

/**
 * What a memory write is refused for (spec invariant 8). `instruction` is text shaped like a
 * direction to the model rather than a fact about the world; `invisible-unicode` is a character
 * a human cannot see and a model can read.
 */
export type InjectionCategory = 'instruction' | 'invisible-unicode';

/**
 * Directions to a model, as they are usually phrased. A guard, not a classifier: it is meant to
 * catch the shapes a smuggled instruction takes, and a false positive costs the model one
 * rephrase of a fact that happened to read like an order. The sentences these are tested against
 * live in `injection.test.ts`, so this module spells none of them.
 */
const INSTRUCTION_PATTERNS: readonly RegExp[] = [
  /\b(ignore|disregard|forget|override)\b[^.\n]{0,40}\b(instructions?|rules?|guidelines?|prompts?|polic(?:y|ies)|restrictions?)\b/i,
  /\bfrom\s+now\s+on\b/i,
  /\byou\s+are\s+now\b/i,
  /\b(system|developer)\s+(prompt|message|instructions?)\b/i,
  /\bact\s+as\s+(a|an|the|if)\b/i,
  /\bnew\s+(instructions?|rules?)\s*:/i,
  /\b(do\s+not|don'?t|never)\s+(tell|reveal|mention|disclose)\b/i,
  /\bpretend\s+(to|you)\b/i,
  /<\/?\s*(system|instructions?|assistant|user)\s*>/i,
];

/**
 * Zero-width and bidirectional controls, the byte-order mark, the soft hyphen, and the two
 * format characters that behave like them: every one is invisible in a rendered snapshot and
 * present to a tokenizer. Written as escapes rather than literal characters so the source file
 * carries no actual invisible byte.
 */
const INVISIBLE_UNICODE = /[\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/;

/** The first category `text` trips, or null. Invisible characters are checked first: they are the more certain finding. */
export function findInjection(text: string): InjectionCategory | null {
  if (INVISIBLE_UNICODE.test(text)) return 'invisible-unicode';
  if (INSTRUCTION_PATTERNS.some((pattern) => pattern.test(text))) return 'instruction';
  return null;
}

const REFUSALS: Record<InjectionCategory, string> = {
  instruction: 'it contains an instruction-shaped phrase; memory holds facts, not directions',
  'invisible-unicode': 'it contains invisible Unicode characters',
};

/**
 * Refuse a memory write that trips the scan, naming the category and never echoing the text —
 * the refusal reaches the model, and repeating the phrase back would put the instruction in front
 * of it a second time. `what` names the argument as the model knows it.
 */
export function assertNoInjection(text: string, what: string): void {
  const category = findInjection(text);
  if (category) throw new ToolError(`${what} refused: ${REFUSALS[category]}`);
}
