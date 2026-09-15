import { readFile } from 'node:fs/promises';
import path from 'node:path';
import * as z from 'zod/v4';
import type { SinkHandler, SinkRegistry } from '@harness/core-tools/effects';
import { realOrNearestAncestor } from '@harness/core-tools/storage';
import type { SlackApi } from './slack.js';

// `channel` is nullable as well as optional: a staging tool writes an explicit
// null when the caller did not pick one, and that must mean "use the default",
// not "invalid payload".
const MessagePayload = z.object({
  channel: z.string().min(1).nullable().optional(),
  text: z.string().min(1).max(3000),
  thread_ts: z.string().optional(),
});

const FilePayload = z.object({
  channel: z.string().min(1).nullable().optional(),
  path: z.string().min(1),
  filename: z.string().min(1),
  thread_ts: z.string().optional(),
  file_id: z.string().optional(),
});

/**
 * Validate an outbox payload without ever repeating it. A zod message can name
 * a key and a type, and `tool_effects.last_error` is stored in plaintext, so
 * the sink reports only that validation failed and leaves the detail to the
 * staging tool, which knows what it wrote.
 */
function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, sink: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`${sink} payload failed validation`);
  return parsed.data;
}

/**
 * Reject a staged path that does not resolve inside `root`. `forms_release`
 * already confines the path it stages to the out tree via `resolveOutFile`,
 * so this is defence in depth against a corrupted or otherwise-produced row,
 * not the primary guarantee.
 *
 * Lexical resolution alone is not enough, because `readFile` below follows
 * symlinks: a link planted under the out tree passes `path.relative` and then
 * uploads whatever it points at. Both sides are compared as real paths too.
 */
async function assertUnderRoot(candidate: string, root: string, effectId: string): Promise<void> {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(candidate);
  const rel = path.relative(resolvedRoot, resolved);
  if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) {
    throw new Error(`slack_file: path outside the release directory (effect ${effectId})`);
  }
  let realRoot: string;
  let realCandidate: string;
  try {
    realRoot = await realOrNearestAncestor(resolvedRoot);
    realCandidate = await realOrNearestAncestor(resolved);
  } catch {
    // realpath errors (ELOOP, EACCES, ENOTDIR) carry the absolute path in
    // their message; keep it out of the plaintext `tool_effects.last_error`.
    throw new Error(`slack_file: staged file unavailable (effect ${effectId})`);
  }
  // The separator matters: `${realRoot}-evil` starts with `realRoot` but is
  // not inside it.
  if (realCandidate !== realRoot && !realCandidate.startsWith(realRoot + path.sep)) {
    throw new Error(`slack_file: path outside the release directory (effect ${effectId})`);
  }
}

/**
 * Slack senders for the effects outbox. Each returns only identifiers: the
 * dispatcher stores the return value in `tool_effects.result` as plaintext
 * jsonb, so nothing from the payload may come back out.
 */
export function slackSinks(api: SlackApi, opts: { defaultChannel: string; outDir?: string }): SinkRegistry {
  const messageSink: SinkHandler = async (payload) => {
    const p = parsePayload(MessagePayload, payload, 'slack_message');
    const channel = p.channel ?? opts.defaultChannel;
    const res = await api.chat.postMessage({ channel, text: p.text, thread_ts: p.thread_ts });
    return { slack_ts: res.ts ?? null, slack_channel: res.channel ?? channel };
  };

  const fileSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(FilePayload, payload, 'slack_file');
    const channel = p.channel ?? opts.defaultChannel;
    // `outDir` is the fill output tree (`<HARNESS_STORAGE_DIR>/out`), not the
    // whole store: the rest of it holds ingested documents, which must never
    // be uploadable. Optional so today's tests, which stage paths under an
    // arbitrary tmpdir, are unaffected; main.ts always passes it.
    if (opts.outDir) await assertUnderRoot(p.path, opts.outDir, effect.id);
    let bytes: Buffer;
    try {
      bytes = await readFile(p.path);
    } catch {
      // Node's fs error message includes the absolute path; never let that
      // reach the plaintext `tool_effects.last_error` column.
      throw new Error(`slack_file: staged file unavailable (effect ${effect.id})`);
    }
    await api.files.uploadV2({
      channel_id: channel,
      file: bytes,
      filename: p.filename,
      // The staging tool already wrote a restricted-free label; reuse it rather
      // than composing a new comment out of payload values.
      initial_comment: effect.summary,
      thread_ts: p.thread_ts,
    });
    return { slack_channel: channel, filename: p.filename };
  };

  return { slack_message: messageSink, slack_file: fileSink };
}
