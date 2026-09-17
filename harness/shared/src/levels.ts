/**
 * The access levels every principal has exactly one of.
 *
 * Declared here rather than in `@harness/identity-api` because two leaf contracts need them and
 * may not import each other: the identity contract types `Principal.level` with them, and the
 * pack contract's `Policy` is a matrix keyed by them. The same reason `CONVERSATION_ID_PATTERN`
 * lives here. The four user levels are cumulative, lowest first; `service` is the level of a
 * scheduled job's identity and is never "at least" a user level — see `levelAtLeast` in
 * `@harness/identity-api`.
 */
export const LEVELS = ['member', 'practitioner', 'lead', 'admin', 'service'] as const;
export type Level = (typeof LEVELS)[number];

/** The four user levels in ascending order. `service` is outside the ladder. */
export const USER_LEVELS = ['member', 'practitioner', 'lead', 'admin'] as const;
