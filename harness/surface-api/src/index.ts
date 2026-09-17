/**
 * The contract between the approvals host and a messaging surface.
 *
 * Everything here is either a type an adapter implements, a function it calls, or the shape of
 * something the host hands it. It depends on `@harness/shared` and zod, and on nothing else in
 * the workspace, so an adapter that implements it never has to depend on `@harness/approvals` —
 * which is what lets the host load an adapter by name at runtime instead of importing it at
 * build time. See ARCHITECTURE.md, "Surfaces".
 */
export { ANY_USER, allowsUser, defineSurface, parseAllowedUsers } from './surface.js';
export {
  CONVERSATION_ID_PATTERN,
  SURFACE_NAME_PATTERN,
  SurfaceFilePayloadShape,
  SurfaceMessagePayloadShape,
  type SurfaceFilePayload,
  type SurfaceMessagePayload,
} from './models.js';
export type {
  ActionEvent,
  Card,
  CardAction,
  CardIcon,
  CardLine,
  Conversation,
  Form,
  FormEvent,
  FormField,
  MessageRef,
  NotePart,
  Surface,
  SurfaceCapabilities,
  SurfaceDeps,
  SurfaceSession,
  UploadRequest,
} from './types.js';
