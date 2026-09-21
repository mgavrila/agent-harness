/**
 * Everything this adapter's **shipping** modules import from outside themselves, in one place.
 *
 * `pnpm arch`'s `a-surface-imports-only-api-and-shared` permits exactly `@harness/surface-api`,
 * `@harness/shared` and this package's own files — and its own tests are not exempt. Re-exporting
 * here is a readability choice, not a rule: it puts the whole of this adapter's surface area
 * against the kernel on one screen. A test imports what it needs directly, including
 * `@harness/surface-api/testing`, which the same rule allows and which no shipping module has any
 * business holding.
 */
export { ConfigError, SurfaceError, assertInsideRoot, CONVERSATION_ID_PATTERN } from '@harness/shared';
export { defineSurface } from '@harness/surface-api';
export type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageEvent,
  MessageRef,
  StreamHandle,
  Surface,
  SurfaceDeps,
  SurfaceHttp,
  SurfaceHttpRequest,
  SurfaceHttpResponse,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';
