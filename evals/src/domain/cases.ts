import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { readJsonl } from '@harness/shared';

/**
 * One attachment a case expects the pipeline to have stored.
 *
 * `kind` is an open string: the closed union it used to be was a copy of the healthcare pack's
 * four kinds, and this loader reads whichever pack's corpus `--packs` names.
 */
export interface ExpectedAttachment {
  kind: string;
  state?: string;
  issuer: string;
  issued_at?: string;
  expires_at: string;
}

export interface ExtractionCase {
  id: string;
  kind: string;
  /** Which quality bucket this document belongs to. The promotion gate is measured per split. */
  split: 'text_layer' | 'scan';
  /** Relative to the corpus directory the runner is pointed at. */
  path: string;
  injection: boolean;
  expected: {
    fields: Record<string, string>;
    attachments: ExpectedAttachment[];
    /** Names of the restricted fields redaction must have found. Values are never in a case file. */
    restricted: string[];
  };
}

export interface InjectionCase {
  id: string;
  /**
   * The corpus document this row's assertions were written for, relative to
   * the corpus directory, exactly as the matching `cases.jsonl` row spells it.
   * The runner scores the row against that document alone.
   *
   * Absent means the row is a general assertion and is scored against every
   * injection-flagged document in the corpus.
   */
  path?: string;
  attack: string;
  must_not_appear: string[];
  must_hold: string[];
  note?: string;
}

/**
 * The tool names a skill declares in its frontmatter, under
 * `metadata.harness.tools`.
 *
 * Read from the skill rather than copied into this file. The injection check's
 * whole claim is "no tool call outside the intake skill's declared tools", so a
 * hand-written copy is not a second source of truth, it is a way for the check
 * to quietly start asserting something the skill does not say: the copy here
 * listed nine tools while the skill declared twelve, and the two had already
 * drifted by the time anyone looked.
 *
 * Sorted, so the set and the test that checks it read plainly.
 *
 * The file comes from `Pack.evals.intakeSkill`. Before this, the path was resolved against the
 * healthcare pack from this module, which is exactly the hard-coding the contract removes.
 */
export function declaredToolsOf(skillFile: string): string[] {
  let text: string;
  try {
    text = readFileSync(skillFile, 'utf8');
  } catch {
    throw new Error(`cannot read skill file ${skillFile}`);
  }
  const match = /^---\n([\s\S]*?)\n---\n/.exec(text);
  if (!match) throw new Error(`${path.basename(skillFile)} has no frontmatter block`);
  const frontmatter = parseYaml(match[1]) as { metadata?: { harness?: { tools?: unknown } } };
  const tools = frontmatter.metadata?.harness?.tools;
  if (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string') || tools.length === 0) {
    throw new Error(`${path.basename(skillFile)}: metadata.harness.tools must be a non-empty list of names`);
  }
  return [...(tools as string[])].sort();
}

/**
 * `readJsonl`'s `label` is what makes the unreadable-file message read as
 * `cannot read case file <path>`, exactly as this module's own reader did. The
 * 1-based file line travels on every row for the same reason it always has: a
 * validation error below and a JSON error inside the reader have to point a
 * person at the same line.
 */
export async function loadJsonl<T = unknown>(file: string): Promise<T[]> {
  return (await readJsonl<T>(file, 'case file')).map((r) => r.value);
}

const SPLITS = new Set(['text_layer', 'scan']);

export async function loadExtractionCases(file: string): Promise<ExtractionCase[]> {
  const rows = await readJsonl<Partial<ExtractionCase>>(file, 'case file');
  // The true file line, not a count of non-blank rows: a validation error and
  // a JSON error in the same file must point a person at the same line.
  return rows.map(({ value: row, line }) => {
    const where = `${path.basename(file)} line ${line}`;
    if (typeof row.id !== 'string') throw new Error(`${where}: missing id`);
    if (typeof row.path !== 'string') throw new Error(`${where}: missing path`);
    if (typeof row.split !== 'string' || !SPLITS.has(row.split)) {
      throw new Error(`${where}: split must be "text_layer" or "scan", got ${String(row.split)}`);
    }
    const expected = row.expected;
    if (!expected || typeof expected.fields !== 'object') throw new Error(`${where}: missing expected.fields`);
    return {
      id: row.id,
      kind: typeof row.kind === 'string' ? row.kind : 'other',
      split: row.split,
      path: row.path,
      injection: row.injection === true,
      expected: {
        fields: expected.fields,
        attachments: Array.isArray(expected.attachments) ? expected.attachments : [],
        restricted: Array.isArray(expected.restricted) ? [...expected.restricted].sort() : [],
      },
    };
  });
}

export async function loadInjectionCases(file: string): Promise<InjectionCase[]> {
  const rows = await readJsonl<Partial<InjectionCase>>(file, 'case file');
  return rows.map(({ value: row, line }) => {
    const where = `${path.basename(file)} line ${line}`;
    if (typeof row.id !== 'string') throw new Error(`${where}: missing id`);
    if (row.path !== undefined && typeof row.path !== 'string') throw new Error(`${where}: path must be a string`);
    return {
      id: row.id,
      path: row.path,
      attack: row.attack ?? 'unspecified',
      must_not_appear: Array.isArray(row.must_not_appear) ? row.must_not_appear : [],
      must_hold: Array.isArray(row.must_hold) ? row.must_hold : [],
      note: row.note,
    };
  });
}
