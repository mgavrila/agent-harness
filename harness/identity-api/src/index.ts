/**
 * The contract between the kernel and an identity plug-in.
 *
 * Everything here is either a type a plug-in implements, a function it calls, or the shape of
 * something the kernel hands it. It depends on `@harness/shared` and zod, and on nothing else in
 * the workspace, so a plug-in that implements it never has to depend on `@harness/core-tools` —
 * which is what lets the kernel load a plug-in by name at runtime instead of importing it at build
 * time. See ARCHITECTURE.md, "Identity".
 */
export { LEVELS, USER_LEVELS, type Level } from '@harness/shared';
export { defineIdentityProvider, levelAtLeast } from './identity.js';
export {
  IdentityDefaultsShape,
  IdentityFileShape,
  PRINCIPAL_ID_PATTERN,
  PrincipalShape,
  UNDEFAULTABLE_SURFACE,
  parseIdentityFile,
  parseIdentityFileWithDefaults,
  principalFromDefault,
  type IdentityFile,
  type UserLevel,
} from './principals.js';
export type { IdentityDeps, IdentityModule, IdentityProvider, IdentitySession, Principal } from './types.js';
