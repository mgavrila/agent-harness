/**
 * The `@harness/core-tools/redaction` subpath: restricted identifiers and the redaction pass.
 *
 * Deciding which field names are restricted and which SSN allocations are real is domain
 * knowledge, so these three modules stay here rather than in `@harness/shared`. They are a
 * declared subpath so that a package needing only the guard — the approvals app, which checks
 * text on its way to a human — does not have to import the whole core-tools barrel and inherit
 * the tooling kernel, the domains and the database types with it.
 *
 * `src/index.ts` re-exports all three, so an existing importer that reaches them through the
 * package root is not wrong, only broader than it needs to be.
 */
export { WITHHELD, containsRestrictedPattern, isValidDea, type RestrictedKind } from './patterns.js';
export { MASKED, isRestrictedName } from './names.js';
export {
  assertRedacted,
  fieldNameFor,
  redactPages,
  type RedactablePage,
  type RedactedText,
  type RedactionHit,
} from './text.js';
