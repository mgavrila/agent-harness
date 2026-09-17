/**
 * The two identifier shapes both contracts need, in the one package below both of them.
 *
 * `@harness/pack-api` re-exports `CONVERSATION_ID_PATTERN` so a pack's tool schema can validate
 * a `channel` argument, and `@harness/surface-api` re-exports both so an adapter and the host
 * validate the same strings. Neither contract may import the other — `pack-api-imports-only-shared`
 * in `.dependency-cruiser.cjs` says so — and a regular expression describing the shape of a
 * string is not domain knowledge, so this is the one place it can live without being copied.
 */

/**
 * A conversation id, whatever surface it belongs to: a Slack channel (`C0DEMO`), a Teams thread
 * (`19:…@thread.v2`), a Telegram chat id, the memory surface's `memory`.
 *
 * Deliberately a *shape*, not a *validation*: the kernel cannot know a surface's id format, so
 * this only keeps a control character, a space or a 200-character blob out of a plaintext
 * column, and the adapter rejects an id that is not its own with a `SurfaceError` at dispatch.
 * An adapter whose native ids do not fit — Telegram's group ids are negative — presents them in
 * a shape that does and converts on the way out; that conversion is the adapter's business.
 */
export const CONVERSATION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_@.-]{0,127}$/;

/** An adapter's name: lowercase, the same rule a pack's name follows. Stored in `approvals.surface`. */
export const SURFACE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
