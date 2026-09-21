import * as z from 'zod/v4';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';

export { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/shared';

/**
 * The two payload shapes that cross an untyped boundary.
 *
 * Everything else in this contract is checked by the compiler: the host builds a `Card` and
 * hands it to an adapter in the same process. These two are different — they come out of
 * `tool_effects.payload_encrypted`, written by a kernel that may be a version behind — so they
 * are parsed, and they are parsed here rather than in the host because the addressing they carry
 * is this contract's, not the host's.
 *
 * `surface` and `conversation` are nullable as well as optional: a staging tool writes an
 * explicit null when the caller named neither, and that means "the default", not "invalid".
 * `channel` is the same field under its pre-0009 name — rows staged before the upgrade are still
 * in the outbox and still have to deliver. A row carrying both is read as `conversation`: the
 * newer name wins, because only a writer that knows about `conversation` can have set it.
 */
const surfaceName = z
  .string()
  .regex(SURFACE_NAME_PATTERN, 'surface must be a loaded surface name')
  .nullable()
  .optional();

const conversation = z
  .string()
  .regex(CONVERSATION_ID_PATTERN, 'conversation must be a conversation id')
  .nullable()
  .optional();

/** Where an effect is addressed, which is the same three fields whatever it carries. */
const addressing = {
  surface: surfaceName,
  conversation,
  /** Pre-0009 rows carry the conversation here. */
  channel: conversation,
};

export const SurfaceMessagePayloadShape = z.object({
  ...addressing,
  text: z.string().min(1).max(3000),
});

export const SurfaceFilePayloadShape = z.object({
  ...addressing,
  path: z.string().min(1),
  filename: z.string().min(1),
  file_id: z.string().optional(),
});

// Deliberately no `reply_to`. Nothing stages one: the only reply this host posts is the
// decisions thread reply, which goes through `postText({ replyTo })` inside the process and never
// crosses the outbox. A field no writer fills is a field the next reader trusts by mistake.

export type SurfaceMessagePayload = z.infer<typeof SurfaceMessagePayloadShape>;
export type SurfaceFilePayload = z.infer<typeof SurfaceFilePayloadShape>;

/**
 * A surface's mount path, below the tenant prefix the host puts in front of it.
 *
 * Lowercase, slash-separated, no leading and no trailing slash, and every segment starts with a
 * letter or a digit — so `..` cannot appear and a mount cannot climb out of its tenant's prefix
 * into `/v1/runs`. One spelling per mount, because two surfaces of one tenant claiming the same
 * path is a startup failure and a case-insensitive match would make it a silent one.
 */
export const SURFACE_HTTP_PATH_PATTERN = /^[a-z0-9][a-z0-9_-]*(?:\/[a-z0-9][a-z0-9_-]*)*$/;

/**
 * A refusal reason: a short lowercase token, at most 64 characters.
 *
 * It is written into `audit_log.error`, which is plaintext an operator reads and groups by, so it
 * names the *kind* of refusal — `bad_signature`, `stale_timestamp` — and can never be a sentence
 * assembled from what was refused. The host replaces anything that does not match with
 * `unspecified` rather than refusing to answer, because a badly declared reason is the surface's
 * bug and dropping the request would hide it behind a second failure.
 */
export const SURFACE_REFUSAL_REASON_PATTERN = /^[a-z][a-z0-9_]{0,63}$/;
