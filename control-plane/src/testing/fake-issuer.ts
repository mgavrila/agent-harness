import { serve, type ServerType } from '@hono/node-server';
import { Hono } from 'hono';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export interface FakeUser {
  sub: string;
  email: string;
  name: string;
}

export interface FakeIssuer {
  url: string;
  clientId: string;
  clientSecret: string;
  /** The user the next authorization will sign in as. */
  nextUser(user: FakeUser): void;
  close(): Promise<void>;
}

export async function startFakeIssuer(): Promise<FakeIssuer> {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256', use: 'sig' };
  let current: FakeUser = { sub: 'nobody', email: 'nobody@example.com', name: 'Nobody' };
  const codes = new Map<string, { user: FakeUser; nonce?: string }>();
  const app = new Hono();
  let url = '';
  app.get('/.well-known/openid-configuration', (c) =>
    c.json({
      issuer: url,
      authorization_endpoint: `${url}/authorize`,
      token_endpoint: `${url}/token`,
      jwks_uri: `${url}/jwks`,
      response_types_supported: ['code'],
      subject_types_supported: ['public'],
      id_token_signing_alg_values_supported: ['RS256'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    }),
  );
  app.get('/jwks', (c) => c.json({ keys: [jwk] }));
  app.get('/authorize', (c) => {
    const q = c.req.query();
    const code = `code-${codes.size + 1}`;
    codes.set(code, { user: current, nonce: q.nonce });
    const back = new URL(q.redirect_uri);
    back.searchParams.set('code', code);
    back.searchParams.set('state', q.state);
    return c.redirect(back.href);
  });
  app.post('/token', async (c) => {
    const form = await c.req.parseBody();
    const code = typeof form.code === 'string' ? form.code : '';
    const grant = codes.get(code);
    if (!grant) return c.json({ error: 'invalid_grant' }, 400);
    codes.delete(code);
    const idToken = await new SignJWT({
      email: grant.user.email,
      name: grant.user.name,
      ...(grant.nonce ? { nonce: grant.nonce } : {}),
    })
      .setProtectedHeader({ alg: 'RS256', kid: 'test' })
      .setIssuer(url)
      .setSubject(grant.user.sub)
      .setAudience('test-client')
      .setIssuedAt()
      .setExpirationTime('5m')
      .sign(privateKey);
    return c.json({ access_token: 'at', token_type: 'Bearer', id_token: idToken, expires_in: 300 });
  });
  const server: ServerType = await new Promise((resolve) => {
    const s = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, () => resolve(s));
  });
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  return {
    url,
    clientId: 'test-client',
    clientSecret: 'test-secret',
    nextUser: (u) => {
      current = u;
    },
    close: () => new Promise((r) => server.close(() => r())),
  };
}
