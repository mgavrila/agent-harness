import { ConfigError } from '@harness/shared';
import { Hono } from 'hono';
import { detail, summary } from '../../domain/catalog/service.js';
import { notFound } from '../../shared/errors.js';
import { requireUser, type UserVars } from '../middleware/session.js';

export const blueprintsRoutes = new Hono<UserVars>()
  .get('/blueprints', requireUser, (c) => {
    const deps = c.get('deps');
    return c.json(deps.catalog.list().map(summary));
  })
  .get('/blueprints/:name', requireUser, (c) => {
    const deps = c.get('deps');
    try {
      return c.json(detail(deps.catalog.get(c.req.param('name'))));
    } catch (err) {
      if (err instanceof ConfigError && err.message.includes('no blueprint named')) throw notFound('blueprint');
      throw err;
    }
  });
