import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, type Db } from '../domain/db/connect.js';
import { runMigrations } from '../domain/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.CONTROL_PLANE_TEST_DATABASE_URL ?? 'postgres://hf1:hf1@localhost:15432/hf1_platform_test';

const DEFAULT_DDL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'kernel-ddl.sql');

// Concurrent `CREATE DATABASE` calls (vitest runs this package's test files in parallel) can hit
// Postgres SQLSTATE 55006, "source database ... is being accessed by other users": every scratch
// database is cloned from template1, and two clones racing the same template collide. Retry only
// that error; anything else is a real failure and rethrows immediately.
const TEMPLATE_IN_USE = '55006';
const CREATE_DATABASE_MAX_ATTEMPTS = 8;

async function createDatabase(admin: pg.Client, name: string): Promise<void> {
  for (let attempt = 1; attempt <= CREATE_DATABASE_MAX_ATTEMPTS; attempt++) {
    try {
      await admin.query(`CREATE DATABASE ${name}`);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code !== TEMPLATE_IN_USE || attempt === CREATE_DATABASE_MAX_ATTEMPTS) throw err;
      await new Promise((resolve) => setTimeout(resolve, 50 * attempt));
    }
  }
}

async function dropDatabase(name: string): Promise<void> {
  const drop = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await drop.connect();
  await drop.query(`DROP DATABASE ${name}`);
  await drop.end();
}

/**
 * A fresh database per suite: migrations plus the kernel's three contract tables. Dropped on
 * close, and dropped immediately (closing the pool first, if one was opened) if setup fails
 * partway through — otherwise a failed `runMigrations` or a bad DDL file would leak both.
 */
export async function scratchDatabase(
  opts: { ddlFile?: string } = {},
): Promise<{ db: Db; url: string; close: () => Promise<void> }> {
  const admin = new pg.Client({ connectionString: TEST_DATABASE_URL });
  await admin.connect();
  const name = `hf1_scratch_${randomBytes(4).toString('hex')}`;
  try {
    await createDatabase(admin, name);
  } finally {
    await admin.end();
  }
  const url = new URL(TEST_DATABASE_URL);
  url.pathname = `/${name}`;

  let close: (() => Promise<void>) | undefined;
  try {
    await runMigrations(url.href);
    const connected = await connect(url.href);
    close = connected.close;
    const ddl = await readFile(opts.ddlFile ?? DEFAULT_DDL_FILE, 'utf8');
    await connected.db.execute(ddl);
    return {
      db: connected.db,
      url: url.href,
      close: async () => {
        await connected.close();
        await dropDatabase(name);
      },
    };
  } catch (err) {
    if (close) await close();
    await dropDatabase(name);
    throw err;
  }
}
