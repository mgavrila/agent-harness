/**
 * The credential vocabulary, defined once for the whole workspace: the storage contract
 * (`CredentialInput.kind`), a pack's form-template manifest, a pack's extraction manifest and
 * core-tools' lead-day table all read it from here.
 *
 * It lives in the pack contract rather than in core-tools because a pack declares credentials
 * in its own JSON and must be able to name the kinds without importing core-tools. Four copies
 * of this list used to sit in four files; a kind added to the extraction schema but not to the
 * template manifest is a credential a model reports and a template can never quote.
 */
export const CREDENTIAL_KINDS = ['license', 'dea', 'malpractice', 'board_cert'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];
