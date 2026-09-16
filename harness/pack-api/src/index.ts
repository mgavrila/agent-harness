/**
 * The contract between core and a pack.
 *
 * Everything here is either a type a pack declares or the one function it calls. It depends on
 * `@harness/shared` and zod, and on nothing else in the workspace, so a pack that implements it
 * never has to depend on `@harness/core-tools` — which is what lets core load a pack by name at
 * runtime instead of importing it at build time. See ARCHITECTURE.md, "Adding a pack".
 */
export { CREDENTIAL_KINDS, type CredentialKind } from './credentials.js';
export { ACTION_CLASSES, BEHAVIORS, type ActionClass, type Behavior, type Policy } from './policy.js';
export { type AnyToolDef, type ToolDef } from './tool.js';
export {
  parseManifest,
  type ManifestChecks,
  type ManifestCredential,
  type ManifestField,
  type ProviderManifest,
} from './manifest.js';
export { definePack, type Pack } from './pack.js';
