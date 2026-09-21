import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCatalog } from '@hf1/catalog';
import { fixtureBlueprintDir } from '@hf1/catalog/testing';
import { Hono } from 'hono';
import { setSignedCookie } from 'hono/cookie';
import { createOidcClient } from '../app/auth/oidc.js';
import { SESSION_TTL_MS } from '../app/middleware/session.js';
import { createApp, type AppType } from '../app/server.js';
import { organisationsService } from '../domain/organisations/service.js';
import { createSession } from '../domain/users/repository.js';
import { usersService } from '../domain/users/service.js';
import type { User } from '../domain/users/types.js';
import { loadEnv } from '../shared/env.js';
import { scratchDatabase } from './db.js';
import { startFakeIssuer, type FakeIssuer } from './fake-issuer.js';

export interface TestApp {
  app: AppType;
  db: Awaited<ReturnType<typeof scratchDatabase>>['db'];
  issuer: FakeIssuer;
  sessionFor(user: { sub: string; email: string; name: string; superadmin?: boolean }): Promise<{
    user: User;
    cookie: string;
  }>;
  close(): Promise<void>;
}

export async function testApp(): Promise<TestApp> {
  const scratch = await scratchDatabase();
  const issuer = await startFakeIssuer();
  const knowledgeDir = await mkdtemp(path.join(tmpdir(), 'hf1-knowledge-'));
  const env = loadEnv({
    DATABASE_URL: scratch.url,
    KERNEL_DATABASE_URL: scratch.url,
    HOST_URL: 'http://127.0.0.1:1',
    HARNESS_HOST_TOKEN: 'host-token',
    HARNESS_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    GOOGLE_CLIENT_ID: issuer.clientId,
    GOOGLE_CLIENT_SECRET: issuer.clientSecret,
    OIDC_ISSUER: issuer.url,
    SESSION_SECRET: 's'.repeat(40),
    PLATFORM_URL: 'http://platform.test',
    PLATFORM_SUPERADMINS: 'root@example.com',
    KNOWLEDGE_DIR: knowledgeDir,
    KNOWLEDGE_MOUNT: '/srv/knowledge',
  });
  const catalog = await loadCatalog(await fixtureBlueprintDir('fixture-agent'));
  const users = usersService(scratch.db, env.PLATFORM_SUPERADMINS);
  const now = () => new Date();
  const orgs = organisationsService(scratch.db, now);
  const app = createApp({
    env,
    db: scratch.db,
    kernelDb: scratch.db,
    catalog,
    log: { info() {}, error() {} },
    now,
    oidc: await createOidcClient(env),
    users,
    orgs,
  });
  return {
    app,
    db: scratch.db,
    issuer,
    async sessionFor(u) {
      const user = await users.upsertFromGoogle(u);
      const session = await createSession(scratch.db, user.id, SESSION_TTL_MS, now());
      // Sign the cookie the way hono's setSignedCookie does, through a throwaway response.
      const probe = new Hono().get('/', async (c) => {
        await setSignedCookie(c, 'hf1_session', session.id, env.SESSION_SECRET, { path: '/' });
        return c.text('ok');
      });
      const res = await probe.request('/');
      return { user, cookie: res.headers.get('set-cookie')!.split(';')[0] };
    },
    close: async () => {
      await issuer.close();
      await scratch.close();
    },
  };
}
