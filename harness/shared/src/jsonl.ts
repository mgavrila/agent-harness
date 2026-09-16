import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** A parsed row with the 1-based file line it came from. */
export interface JsonlRow<T> {
  value: T;
  line: number;
}

/**
 * Read a JSONL file, carrying the true file line on every row.
 *
 * The line number is why this exists as a helper rather than a `split('\n').map(JSON.parse)`
 * one-liner at three call sites: a validation error and a JSON error in the same file have to
 * point a person at the same line, and a count of non-blank rows does not.
 *
 * `label` names the kind of file in the unreadable-file message, so the eval runner can say
 * "cannot read case file …" exactly as it does today.
 */
export async function readJsonl<T>(file: string, label = 'file'): Promise<JsonlRow<T>[]> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new Error(`cannot read ${label} ${file}`);
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

/** Write one JSON document per line, with a trailing newline, so the file appends cleanly. */
export async function writeJsonl(file: string, rows: readonly unknown[]): Promise<void> {
  await writeFile(file, `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`, 'utf8');
}
