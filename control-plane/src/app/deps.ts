import type { Catalog } from '@hf1/catalog';
import type { Db } from '../domain/db/connect.js';
import type { organisationsService } from '../domain/organisations/service.js';
import type { usersService } from '../domain/users/service.js';
import type { Env } from '../shared/env.js';
import type { OidcClient } from './auth/oidc.js';

export interface Logger {
  info(msg: string, meta?: unknown): void;
  error(msg: string, err?: unknown): void;
}

/** Everything the app needs, built once in main.ts and once per test in testing/app.ts. Grows per task. */
export interface Deps {
  env: Env;
  db: Db;
  kernelDb: Db;
  catalog: Catalog;
  log: Logger;
  now(): Date;
  oidc: OidcClient;
  users: ReturnType<typeof usersService>;
  orgs: ReturnType<typeof organisationsService>;
}
