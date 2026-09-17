import path from 'node:path';
import type { SinkHandler, SinkRegistry } from '@harness/core-tools/effects';
import { assertInsideRoot, SurfaceError } from '@harness/shared';
import {
  SurfaceFilePayloadShape,
  SurfaceMessagePayloadShape,
  type Conversation,
  type SurfaceSession,
} from '@harness/surface-api';
import * as z from 'zod/v4';
import type { LoadedSurfaces } from './surfaces/registry.js';

/**
 * Validate an outbox payload without ever repeating it. A zod message can name a key and a type,
 * and `tool_effects.last_error` is stored in plaintext, so the sink reports only that validation
 * failed and leaves the detail to the staging tool, which knows what it wrote.
 */
function parsePayload<T>(schema: z.ZodType<T>, payload: unknown, sink: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new Error(`${sink} payload failed validation`);
  return parsed.data;
}

/**
 * Reject a staged path that does not resolve inside `root`. The staging tool already confines the
 * path it stages to the out tree, so this is defence in depth against a corrupted or
 * otherwise-produced row, not the primary guarantee.
 *
 * Lexical resolution alone is not enough, because the adapter that reads the file follows
 * symlinks: a link planted under the out tree passes `path.relative` and then uploads whatever it
 * points at. Both sides are compared as real paths too.
 */
async function assertUnderRoot(candidate: string, root: string, effectId: string): Promise<void> {
  await assertInsideRoot(
    // Resolve against the working directory first. `assertInsideRoot` resolves a relative
    // candidate *inside `root`*, which would silently loosen this check for a relative path.
    path.resolve(candidate),
    root,
    (reason) => {
      throw new Error(
        reason === 'unreadable'
          ? `surface_file: staged file unavailable (effect ${effectId})`
          : `surface_file: path outside the release directory (effect ${effectId})`,
      );
    },
    // realpath errors (ELOOP, EACCES, ENOTDIR) carry the absolute path in their message; keep it
    // out of the plaintext `tool_effects.last_error`.
    { onUnreadable: 'escape' },
  );
}

/**
 * Which surface and which conversation an effect is addressed to.
 *
 * `payload.surface` names one of the loaded surfaces; with none, it is the primary. The
 * conversation is the payload's, or that surface's default. `channel` is read after
 * `conversation` for one reason: a row staged before migration 0009 spells it that way and is
 * still in the outbox.
 */
function target(
  surfaces: LoadedSurfaces,
  payload: { surface?: string | null; conversation?: string | null; channel?: string | null },
  sink: string,
  effectId: string,
): { session: SurfaceSession; conversation: Conversation['id'] } {
  const name = payload.surface ?? null;
  const session = name === null ? surfaces.primary : surfaces.find(name);
  if (!session) throw new Error(`${sink}: no surface named "${name}" is loaded (effect ${effectId})`);
  return { session, conversation: payload.conversation ?? payload.channel ?? session.defaultConversation };
}

/**
 * An adapter's failure is expected and is recorded on the row; anything else is a bug and keeps
 * its own message. Either way the effect id goes on, because that is what an operator greps for.
 */
async function viaSurface<T>(sink: string, effectId: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    if (err instanceof SurfaceError) throw new Error(`${sink}: ${err.message} (effect ${effectId})`);
    throw err;
  }
}

/**
 * The two senders the effects outbox drains through.
 *
 * Both are generic: the dispatcher looks a sink up by the string on the row, and these two names
 * carry no transport in them. Each returns only identifiers — the dispatcher stores the return
 * value in `tool_effects.result` as plaintext jsonb, so nothing from the payload may come back out.
 */
export function surfaceSinks(surfaces: LoadedSurfaces, opts: { outDir?: string } = {}): SinkRegistry {
  const messageSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(SurfaceMessagePayloadShape, payload, 'surface_message');
    const { session, conversation } = target(surfaces, p, 'surface_message', effect.id);
    // No reply target: an outbox message is a standalone post. The only reply this host writes is
    // the decisions thread reply, which goes straight through `postText({ replyTo })`.
    const ref = await viaSurface('surface_message', effect.id, () => session.postText(conversation, p.text));
    return { surface: session.name, conversation, message_id: ref.id };
  };

  const fileSink: SinkHandler = async (payload, effect) => {
    const p = parsePayload(SurfaceFilePayloadShape, payload, 'surface_file');
    const { session, conversation } = target(surfaces, p, 'surface_file', effect.id);
    // `outDir` is the fill output tree (`<HARNESS_STORAGE_DIR>/out`), not the whole store: the
    // rest of it holds ingested documents, which must never be uploadable. Optional so a test
    // that stages a path under an arbitrary tmpdir is unaffected; main.ts always passes it.
    if (opts.outDir) await assertUnderRoot(p.path, opts.outDir, effect.id);
    await viaSurface('surface_file', effect.id, () =>
      session.uploadFile(conversation, {
        path: p.path,
        filename: p.filename,
        // The staging tool already wrote a restricted-free label; reuse it rather than composing
        // a new comment out of payload values.
        comment: effect.summary,
      }),
    );
    return { surface: session.name, conversation, filename: p.filename };
  };

  return {
    surface_message: messageSink,
    surface_file: fileSink,
    // The two names the kernel still stages under until the next task renames them. Migration
    // 0009 renamed the rows that were in flight; these cover the ones a running kernel writes
    // between this commit and that one. **Task 5 deletes both lines in the commit that stops
    // staging them** — a sink name nothing writes is a name nobody can look up — and adds
    // `host-vocabulary.test.ts` in that same commit, because these two keys are the last
    // adapter-specific word left in host source.
    slack_message: messageSink,
    slack_file: fileSink,
  };
}
