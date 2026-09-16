/**
 * The credential vocabulary. One pack's list, not the contract's.
 *
 * Plan 4 put this in `@harness/pack-api` on the theory that two packs might share it. They do
 * not: `source_link` is not a credential, and a second pack's attachment kinds have nothing to
 * do with these four. What the contract keeps is the *shape* — `AttachmentKindSpec` — and this
 * pack keeps the list. `schema/provider.json` declares the same four kinds with their lead days;
 * these constants are what the form templates and the alias tools' zod enums are typed against.
 */
export const CREDENTIAL_KINDS = ['license', 'dea', 'malpractice', 'board_cert'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
