import { Hono } from 'hono';
import { ConfigError } from '@harness/shared';
import * as z from 'zod/v4';
import { ApiError } from '../shared/errors.js';
import { authRoutes } from './routes/auth.js';
import { blueprintsRoutes } from './routes/blueprints.js';
import { orgsRoutes } from './routes/orgs.js';
import type { Deps } from './deps.js';
import type { UserVars } from './middleware/session.js';

export function createApp(deps: Deps) {
  const app = new Hono<UserVars>();
  app.use('*', async (c, next) => {
    c.set('deps', deps);
    await next();
  });
  app.onError((err, c) => {
    if (err instanceof ApiError)
      return c.json({ error: { code: err.code, message: err.message, pointer: err.pointer } }, err.status as 400);
    if (err instanceof ConfigError) {
      const pointer = /"(\/[^"]*)"/.exec(err.message)?.[1];
      return c.json({ error: { code: 'config_error', message: err.message, pointer } }, 400);
    }
    if (err instanceof z.ZodError) return c.json({ error: { code: 'invalid', message: z.prettifyError(err) } }, 400);
    deps.log.error('unhandled', err);
    return c.json({ error: { code: 'internal', message: 'internal error' } }, 500);
  });
  app.get('/api/v1/health', (c) => c.json({ ok: true }));
  app.route('/api/v1', authRoutes);
  app.route('/api/v1', orgsRoutes);
  app.route('/api/v1', blueprintsRoutes);
  return app;
}

export type AppType = ReturnType<typeof createApp>;
