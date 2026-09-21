import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import pg from 'pg';
import { connect, type Db } from '../domain/db/connect.js';
import { runMigrations } from '../domain/db/migrate.js';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://hf1:hf1@localhost:15432/hf1_platform_test';

const DEFAULT_DDL_FILE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'kernel-ddl.sql');

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
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
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
