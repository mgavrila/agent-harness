import { sql } from 'drizzle-orm';
import { createDb, type Db } from './client.js';

/**
 * A database of its own for one migration test, built from a fixture and dropped afterwards.
 *
 * One copy, shared by the 0008 and 0009 tests, because not one step here is a property of either
 * migration: `CREATE DATABASE` has to be issued from a connection to some *other* database, the
 * drop-first is for the run after a crashed one, `WITH (FORCE)` closes any connection a dead
 * worker left behind, and neither statement may run inside a transaction — which is why they go
 * straight at the pool rather than through `db.transaction`. A second copy would be a second
 * thing to fix the day one of those stops being true.
 *
 * The fixture's tables land in the new database's own `public` schema. That is the whole point: a
 * migration's generated SQL is either schema-qualified to `"public"` or unqualified, and either
 * way it replays byte for byte, with no rewriting and no `search_path` to get wrong.
 *
 * Each test names its own database, suffixed with the process id. Two scratch databases with one
 * name is a test that passes alone and fails beside its neighbour, whatever `fileParallelism`
 * happens to be set to today, and the pid suffix stops two concurrent runs of this package from
 * dropping each other's database mid-test.
 *
 * A `*.test-helpers.ts` file, not a `*.test.ts` one: it declares no test, and the "no test
 * imported by production" architecture rule matches on the name.
 */
export interface ScratchDatabase {
  /**
   * Build the database, apply `ddl`, and hand back a handle on it.
   *
   * `maintenanceUrl` is `TEST_DATABASE_URL`, the database that is always there; the scratch one
   * is that URL with its path swapped.
   */
  create(maintenanceUrl: string, ddl: string): Promise<{ db: Db; close: () => Promise<void> }>;
  /**
   * Drop it. Safe to call when it was never created, and safe to call twice. The caller closes
   * its own pool on the scratch database *first*, or the drop blocks behind it — `WITH (FORCE)`
   * covers the case where it forgot.
   */
  drop(maintenanceUrl: string): Promise<void>;
}

export function scratchDatabase(name: string): ScratchDatabase {
  const url = (maintenanceUrl: string): string => {
    const parsed = new URL(maintenanceUrl);
    parsed.pathname = `/${name}`;
    return parsed.toString();
  };

  const drop = async (maintenanceUrl: string): Promise<void> => {
    const maintenance = createDb(maintenanceUrl);
    try {
      await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
    } finally {
      await maintenance.close();
    }
  };

  return {
    drop,
    async create(maintenanceUrl, ddl) {
      const maintenance = createDb(maintenanceUrl);
      try {
        await maintenance.db.execute(sql.raw(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`));
        await maintenance.db.execute(sql.raw(`CREATE DATABASE "${name}"`));
      } finally {
        await maintenance.close();
      }

      const scratch = createDb(url(maintenanceUrl));
      try {
        await scratch.db.execute(sql.raw(ddl));
      } catch (err) {
        await scratch.close();
        throw err;
      }
      return { db: scratch.db, close: scratch.close };
    },
  };
}
