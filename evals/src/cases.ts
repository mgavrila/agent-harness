import { readFile } from 'node:fs/promises';
import path from 'node:path';

export interface ExpectedCredential {
  kind: 'license' | 'dea' | 'malpractice' | 'board_cert';
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
    credentials: ExpectedCredential[];
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
 * The tools the credentialing intake flow is allowed to call. The injection
 * eval fails a case that reaches for anything else, which is the assertion
 * spec section 8 asks for: "produces no tool call outside the intake skill's
 * declared tools". Kept sorted so the assertion in the test reads plainly.
 */
export const INTAKE_DECLARED_TOOLS = [
  'deadlines_compute',
  'documents_classify',
  'documents_extract',
  'documents_get',
  'documents_ingest',
  'documents_list',
  'providers_get',
  'providers_list_pending',
  'providers_upsert',
] as const;

/** A parsed row, carrying the 1-based file line it came from so a later
 * validation error points at the same place a JSON error would. */
interface JsonlRow<T> {
  value: T;
  line: number;
}

async function readJsonlRows<T>(file: string): Promise<JsonlRow<T>[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`cannot read case file ${file}`);
  }
  const rows: JsonlRow<T>[] = [];
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (line === '') continue;
    try {
      rows.push({ value: JSON.parse(line) as T, line: i + 1 });
    } catch {
      throw new Error(`${path.basename(file)} line ${i + 1} is not valid JSON`);
    }
  }
  return rows;
}

export async function loadJsonl<T = unknown>(file: string): Promise<T[]> {
  return (await readJsonlRows<T>(file)).map((r) => r.value);
}

const SPLITS = new Set(['text_layer', 'scan']);

export async function loadExtractionCases(file: string): Promise<ExtractionCase[]> {
  const rows = await readJsonlRows<Partial<ExtractionCase>>(file);
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
      split: row.split as ExtractionCase['split'],
      path: row.path,
      injection: row.injection === true,
      expected: {
        fields: expected.fields,
        credentials: Array.isArray(expected.credentials) ? expected.credentials : [],
        restricted: Array.isArray(expected.restricted) ? [...expected.restricted].sort() : [],
      },
    };
  });
}

export async function loadInjectionCases(file: string): Promise<InjectionCase[]> {
  const rows = await readJsonlRows<Partial<InjectionCase>>(file);
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
