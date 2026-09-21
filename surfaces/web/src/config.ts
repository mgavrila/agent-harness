import { ConfigError, type SurfaceDeps } from './deps.js';

/** What this adapter needs to serve one tenant. Everything in it comes from the document. */
export interface WebConfig {
  /** The bearer every request carries, resolved by the host from `surfaces.web.token`. */
  token: string;
  /** Where approval cards and notices go: `surfaces.web.inbox`, or the schema's own default. */
  inbox: string;
  /** The root an attachment path is checked against. */
  storageDir: string;
}

/**
 * Read this adapter's configuration out of what the host handed over.
 *
 * **No environment variable, at all.** This surface's one credential is its tenant's, and a
 * per-tenant credential cannot live in a process's environment on a pooled host — which is the
 * whole reason the secret source exists. It arrives resolved on `deps.secretValues`, keyed by the
 * document's own field name, and the conversation cards go to arrives on
 * `deps.defaultConversation`, because both are per tenant and neither is this process's.
 */
export function webConfig(deps: SurfaceDeps): WebConfig {
  const token = deps.secretValues?.token ?? '';
  if (token.trim() === '') {
    throw new ConfigError(
      'surface "web": this client\'s document declares no token for the web surface, or it resolved to an empty value',
    );
  }
  return {
    token,
    // The schema defaults `inbox` and the host passes it through, so this fallback is for a caller
    // that built a session by hand rather than for a document that left it out.
    inbox: deps.defaultConversation ?? 'inbox',
    storageDir: deps.storageDir,
  };
}
