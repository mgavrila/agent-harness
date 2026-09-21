import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { scratchDatabase } from '../../testing/db.js';
import { usersService } from './service.js';

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;

beforeAll(async () => {
  scratch = await scratchDatabase();
});
afterAll(() => scratch.close());

describe('usersService', () => {
  it('creates a user from a Google identity, lower-casing the e-mail and trimming the name', async () => {
    const service = usersService(scratch.db, []);
    const user = await service.upsertFromGoogle({ sub: 'g-1', email: 'Jane@Example.com', name: '  Jane  ' });
    expect(user.email).toBe('jane@example.com');
    expect(user.name).toBe('Jane');
    expect(user.superadmin).toBe(false);
    expect(await service.byId(user.id)).toMatchObject({ id: user.id, email: 'jane@example.com' });
  });

  it('the same sub upserts to the same user; a configured superadmin e-mail gets the flag', async () => {
    const service = usersService(scratch.db, ['root@example.com']);
    const a = await service.upsertFromGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root' });
    const b = await service.upsertFromGoogle({ sub: 'g-2', email: 'root@example.com', name: 'Root R.' });
    expect(b.id).toBe(a.id);
    expect(b.superadmin).toBe(true);
    expect(b.name).toBe('Root R.');
  });

  it('byId answers null for an unknown id', async () => {
    const service = usersService(scratch.db, []);
    expect(await service.byId('00000000-0000-0000-0000-000000000000')).toBeNull();
  });
});
