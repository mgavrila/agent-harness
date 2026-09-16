import { stat } from 'node:fs/promises';
import path from 'node:path';
import { ToolError } from '@harness/shared';
import type { ToolDeps } from '../tooling/types.js';
import { resolveOutFile } from '../storage/file-store.js';
import { stageEffect } from '../effects/outbox.js';

/** Slack rejects very large uploads and a 25 MB roster is a bug, not a roster. */
const MAX_RELEASE_BYTES = 25 * 1024 * 1024;

export interface StagedRelease {
  effect_id: string;
  staged: boolean;
  file_id: string;
  filename: string;
  bytes: number;
}

/**
 * Stage a generated file for delivery. Resolves the id inside the out tree, refuses anything
 * that is not a readable file or is over the size limit, and stages one effect keyed on the
 * content-addressed id, so releasing the same bytes twice is one delivery.
 *
 * The `new Error('not a file')` below is a control-flow sentinel inside its own try, never
 * thrown out of this function — which is why it lives here and not in `tools/`, where the
 * project rule forbids the shape outright.
 */
export async function stageRelease(
  deps: ToolDeps,
  args: { file_id: string; channel?: string },
): Promise<StagedRelease> {
  const { file_id, channel } = args;
  const absolute = await resolveOutFile(file_id, deps.storageDir);
  let size: number;
  try {
    const info = await stat(absolute);
    if (!info.isFile()) throw new Error('not a file');
    size = info.size;
  } catch {
    // No pack tool is named here: the kernel does not know which of a pack's tools produced
    // the file. A pack that wants to say so catches this and rethrows — `forms_release` does.
    throw new ToolError(`no generated file with id "${file_id}"`);
  }
  if (size > MAX_RELEASE_BYTES) {
    throw new ToolError(`file "${file_id}" is ${size} bytes, over the ${MAX_RELEASE_BYTES} byte release limit`);
  }
  const filename = path.basename(absolute);
  // Keyed on the file id, which is content-addressed: releasing the same
  // bytes twice is one delivery, and re-filling after a correction produces
  // a new id and therefore a new delivery.
  const staged = await stageEffect(deps, {
    sink: 'slack_file',
    idempotencyKey: `forms_release:${file_id}${channel ? `:${channel}` : ''}`,
    payload: { file_id, path: absolute, filename, channel: channel ?? null },
    summary: `Release ${filename} to Slack`,
  });
  return { effect_id: staged.effect_id, staged: staged.staged, file_id, filename, bytes: size };
}
