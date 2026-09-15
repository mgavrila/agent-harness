import { readFile } from 'node:fs/promises';
import * as z from 'zod/v4';
import type { SinkHandler, SinkRegistry } from '@harness/core-tools/effects';
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
 * Slack senders for the effects outbox. Each returns only identifiers: the
 * dispatcher stores the return value in `tool_effects.result` as plaintext
 * jsonb, so nothing from the payload may come back out.
 */
export function slackSinks(api: SlackApi, opts: { defaultChannel: string }): SinkRegistry {
  const messageSink: SinkHandler = async (payload) => {
    const p = parsePayload(MessagePayload, payload, 'slack_message');
    const channel = p.channel ?? opts.defaultChannel;
    const res = await api.chat.postMessage({ channel, text: p.text, thread_ts: p.thread_ts });
    return { slack_ts: res.ts ?? null, slack_channel: res.channel ?? channel };
  };

  const fileSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(FilePayload, payload, 'slack_file');
    const channel = p.channel ?? opts.defaultChannel;
    const bytes = await readFile(p.path);
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
