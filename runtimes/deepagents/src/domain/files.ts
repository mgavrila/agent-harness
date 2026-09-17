import { readFile } from 'node:fs/promises';
import path from 'node:path';
import type { RunRequest } from '@harness/runtime-api';

/** Deep Agents' v1 file record: content as lines. */
export interface FileDataV1 {
  content: string[];
  created_at: string;
  modified_at: string;
}

function fileOf(text: string, at: string): FileDataV1 {
  return { content: text.replace(/\n$/, '').split('\n'), created_at: at, modified_at: at };
}

/**
 * The files the model may read, seeded into agent state on every turn: each skill's SKILL.md
 * under `/skills/<name>/`, and the memory snapshot under `/memories/MEMORY.md`. Seeding rather
 * than mounting is what keeps the runtime off the host filesystem: the model sees these lines and
 * nothing else on disk, and an edited skill is current on the next turn because it is re-read.
 */
export async function seedFiles(request: RunRequest): Promise<Record<string, FileDataV1>> {
  const at = new Date().toISOString();
  const files: Record<string, FileDataV1> = {};
  for (const skill of request.skills) {
    files[`/skills/${skill.name}/SKILL.md`] = fileOf(await readFile(path.join(skill.dir, 'SKILL.md'), 'utf8'), at);
  }
  files['/memories/MEMORY.md'] = fileOf(request.memory.trim() === '' ? '(no memories yet)' : request.memory, at);
  return files;
}

/** The human's text, plus the attachments as the storage-relative paths `documents_ingest` takes. */
export function inputText(request: RunRequest): string {
  if (request.input.attachments.length === 0) return request.input.text;
  const lines = request.input.attachments.map((a) => `- incoming/${a.path} (${a.name})`);
  return `${request.input.text}\n\nAttachments (pass the path to documents_ingest):\n${lines.join('\n')}`;
}
