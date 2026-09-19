/**
 * What a client is, and where one comes from.
 *
 * Everything here is either a schema a tenant's configuration is validated against, a function
 * the kernel calls to turn a raw document into a resolved one, or the shape of a source. It
 * imports `@harness/identity-api`, `@harness/pack-api`, `@harness/shared`, zod and croner, and
 * nothing else in the workspace, so the two source implementations, the kernel, the host, the
 * gateway renderer and the scaffolder can all hold it without holding each other. See
 * ARCHITECTURE.md, "The client document".
 */
export {
  CLIENT_DOCUMENT_VERSION,
  ClientDocumentShape,
  SURFACE_ORDER,
  SecretRefShape,
  migrate,
  parseClientDocument,
  surfaceNamesOf,
  tenantKeysOf,
  type ClientDocument,
} from './document.js';
export { ClientPolicyShape, PolicyFileShape } from './policy.js';
export {
  DELIVERIES,
  PLAYBOOK_NAME_PATTERN,
  PlaybookShape,
  PlaybooksFileShape,
  parsePlaybooksFile,
  type PlaybookDefinition,
} from './playbooks.js';
export { ROUTES, RouteSpec, RoutingFile, type Route } from './routing.js';
export { pointerSegments, readPointer, resolve, writePointer } from './resolve.js';
export type { Blueprint, ConfigSource, JsonPatch, LoadedDocument, Overlay, PatchOp, SecretRef } from './types.js';
