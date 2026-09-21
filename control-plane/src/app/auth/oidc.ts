import * as oidc from 'openid-client';
import type { Env } from '../../shared/env.js';
import { badRequest } from '../../shared/errors.js';

export interface OidcClient {
  authorizationUrl(state: string, verifier: string, redirectUri: string): Promise<URL>;
  exchange(
    currentUrl: URL,
    verifier: string,
    state: string,
    redirectUri: string,
  ): Promise<{ sub: string; email: string; name: string }>;
}

export async function createOidcClient(env: Env): Promise<OidcClient> {
  const insecure = env.OIDC_ISSUER.startsWith('http://');
  const config = await oidc.discovery(
    new URL(env.OIDC_ISSUER),
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    undefined,
    insecure ? { execute: [oidc.allowInsecureRequests] } : undefined,
  );
  return {
    async authorizationUrl(state, verifier, redirectUri) {
      const code_challenge = await oidc.calculatePKCECodeChallenge(verifier);
      return oidc.buildAuthorizationUrl(config, {
        redirect_uri: redirectUri,
        scope: 'openid email profile',
        state,
        code_challenge,
        code_challenge_method: 'S256',
      });
    },
    // openid-client's authorizationCodeGrant reads the redirect_uri from `currentUrl` itself
    // rather than from a `redirectUri` check option (no such option exists on the installed
    // v6.8.1's AuthorizationCodeGrantChecks), so `redirectUri` here is unused beyond signature
    // compatibility with the interface above.
    async exchange(currentUrl, verifier, state, _redirectUri) {
      let tokens: oidc.TokenEndpointResponse & oidc.TokenEndpointResponseHelpers;
      try {
        tokens = await oidc.authorizationCodeGrant(config, currentUrl, {
          pkceCodeVerifier: verifier,
          expectedState: state,
        });
      } catch (err) {
        throw badRequest(`sign-in failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      const claims = tokens.claims();
      if (!claims?.sub || typeof claims.email !== 'string') throw badRequest('sign-in failed: no e-mail claim');
      return {
        sub: claims.sub,
        email: claims.email,
        name: typeof claims.name === 'string' ? claims.name : claims.email,
      };
    },
  };
}

export const randomState = () => oidc.randomState();
export const randomVerifier = () => oidc.randomPKCECodeVerifier();
