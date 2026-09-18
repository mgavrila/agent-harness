import { SurfaceError } from '@harness/shared';
import { defineSurface } from '@harness/surface-api';
import type {
  ActionEvent,
  Card,
  Form,
  FormEvent,
  MessageEvent,
  MessageRef,
  StreamHandle,
  Surface,
  SurfaceSession,
  UploadRequest,
} from '@harness/surface-api';

/**
 * The conversation a run opened over the API belongs to when the caller names none. A thread key
 * needs one, and this is a name rather than an id because there is no directory of conversations
 * here to take an id from.
 */
export const HTTP_SURFACE_CONVERSATION = 'api';

/** One sentence, safe to store in a plaintext column: it names the surface and what failed, nothing else. */
const CANNOT_POST = 'surface "http" cannot post outside a request; the run API answers on the caller’s own stream';

/**
 * The surface a headless caller speaks as.
 *
 * It opens no socket. The run API's listener lives in the host, because spec 5.8 puts it there,
 * and what this adapter supplies is the other three things a run needs to exist: a `threads.surface`
 * value so an API run has a thread of its own, a namespace for the identity plug-in to resolve
 * `(surface, userId)` in — `surfaces: { http: … }` in `identity.yaml` — and a loaded session for
 * `runTurn` to find.
 *
 * Every capability is false and every way of posting rejects, and both are honest rather than
 * unfinished. An HTTP request has no conversation that outlives it: by the time anything would be
 * posted here, the exchange that could have carried it is over. A run driven through the API is
 * delivered on the caller's own event stream instead (`deliver: 'none'` on the turn), and an
 * approval card raised during one goes where every card goes — the primary surface.
 *
 * **Do not make this the primary surface.** `HARNESS_SURFACES` makes its first entry primary and
 * that is where approval cards are posted, so list this one after a surface a human reads.
 */
function session(): SurfaceSession {
  const refuse = (): never => {
    throw new SurfaceError(CANNOT_POST);
  };
  // The six posting methods answer with a promise, so they reject rather than throw: a
  // synchronous throw escapes before the caller has a promise to await, and the contract says a
  // surface method that talks to the outside world rejects. `startStream` hands back a handle
  // rather than a promise, so it is the one that throws.
  const refuseLater = <T>(): Promise<T> => Promise.reject(new SurfaceError(CANNOT_POST));
  return {
    name: 'http',
    capabilities: { forms: false, privateReply: false, update: false, streaming: false, inlineConfirm: false },
    defaultConversation: HTTP_SURFACE_CONVERSATION,
    // No directory to look a display name up in, and no syntax to notify with: the id is the
    // honest rendering, and a caller reading it already knows what a principal id is.
    mention: (userId: string) => `@${userId}`,
    postCard: (_conversation: string, _card: Card): Promise<MessageRef> => refuseLater(),
    updateCard: (_ref: MessageRef, _card: Card): Promise<void> => refuseLater(),
    postText: (_conversation: string, _text: string): Promise<MessageRef> => refuseLater(),
    postPrivate: (_conversation: string, _userId: string, _text: string): Promise<void> => refuseLater(),
    uploadFile: (_conversation: string, _file: UploadRequest): Promise<{ filename: string }> => refuseLater(),
    openForm: (_trigger: string, _form: Form): Promise<void> => refuseLater(),
    // Accepted and never called: nothing arrives on this surface out of band. The run API resolves
    // the principal and opens the turn itself, so a message never takes the adapter's inbound path.
    onAction: (_handler: (event: ActionEvent) => Promise<void>) => {},
    onFormSubmit: (_handler: (event: FormEvent) => Promise<void>) => {},
    onMessage: (_handler: (event: MessageEvent) => Promise<void>) => {},
    startStream: (_conversation: string): StreamHandle => refuse(),
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
  };
}

export const surface: Surface = defineSurface({
  name: 'http',
  version: '0.1.0',
  secrets: [],
  // Not `async`: a surface with no transport has nothing to await on the way up. The run API's
  // own bearer secret is HARNESS_HOST_TOKEN and is read by the host, not by this adapter, which
  // is why `secrets` is empty.
  connect: () => Promise.resolve(session()),
});
