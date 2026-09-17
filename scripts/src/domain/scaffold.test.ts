import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { newClient, titleCase } from './scaffold.js';

let root: string;

/** A repository skeleton with just the parts new-client reads: the four files plus .env.example. */
async function scaffold(): Promise<void> {
  await mkdir(path.join(root, 'packs', 'healthcare'), { recursive: true });
  const template = path.join(root, 'clients', 'demo-practice');
  await mkdir(template, { recursive: true });
  await writeFile(
    path.join(template, 'SOUL.md'),
    '# Demo Practice credentialing assistant\nYou work for Demo Practice.\n',
  );
  await writeFile(path.join(template, 'policy.yaml'), 'classes:\n  external: approval\n');
  await writeFile(
    path.join(template, 'identity.yaml'),
    'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Demo Practice\n',
  );
  await writeFile(path.join(template, 'routing.yaml'), 'routes:\n  chat: demo-practice-chat\n');
  await writeFile(path.join(template, '.env.example'), 'HARNESS_CLIENT=demo-practice\n');
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'harness-newclient-'));
  await scaffold();
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('titleCase', () => {
  it('turns a slug into a display name', () => {
    expect(titleCase('river-clinic')).toBe('River Clinic');
    expect(titleCase('bcbs-tx-group')).toBe('Bcbs Tx Group');
  });
});

describe('newClient', () => {
  it('copies the template and substitutes the client name everywhere', async () => {
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    expect(out.dir).toBe(path.join(root, 'clients', 'river-clinic'));
    expect(out.files.sort()).toEqual(
      ['.env.example', 'SOUL.md', 'identity.yaml', 'policy.yaml', 'routing.yaml'].sort(),
    );
    expect(out.skipped).toEqual([]);

    const soul = await readFile(path.join(out.dir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('River Clinic');
    expect(soul).not.toContain('Demo Practice');

    const identity = await readFile(path.join(out.dir, 'identity.yaml'), 'utf8');
    expect(identity).toContain('displayName: River Clinic');
    expect(identity).not.toContain('Demo Practice');

    const env = await readFile(path.join(out.dir, '.env.example'), 'utf8');
    expect(env).toContain('HARNESS_CLIENT=river-clinic');
  });

  it('reports a template file that is missing as skipped', async () => {
    await rm(path.join(root, 'clients', 'demo-practice', 'routing.yaml'));
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    expect(out.skipped).toEqual(['routing.yaml']);
    expect(out.files.sort()).toEqual(['.env.example', 'SOUL.md', 'identity.yaml', 'policy.yaml'].sort());
  });

  it('refuses a slug that is not a safe directory name', async () => {
    for (const bad of ['River Clinic', '../escape', 'x', 'UPPER', 'trailing-', '9lives']) {
      await expect(newClient({ pack: 'healthcare', name: bad, root })).rejects.toThrow(/name must be/);
    }
  });

  it('refuses a pack that is not installed', async () => {
    await expect(newClient({ pack: 'dentistry', name: 'river-clinic', root })).rejects.toThrow(
      /no pack named "dentistry"/,
    );
  });

  it('refuses to overwrite an existing client', async () => {
    await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    await expect(newClient({ pack: 'healthcare', name: 'river-clinic', root })).rejects.toThrow(/already exists/);
  });

  // chmod 000 does not block reads for root (root bypasses file permission
  // checks), so this test would spuriously pass there: there'd be no read
  // failure to clean up after.
  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

  it.skipIf(isRoot)(
    'removes a half-written client directory when the copy fails (skipped as root: chmod 000 does not block root reads)',
    async () => {
      const { access, chmod } = await import('node:fs/promises');
      const blocked = path.join(root, 'clients', 'demo-practice', 'policy.yaml');
      await chmod(blocked, 0o000);
      try {
        await expect(newClient({ pack: 'healthcare', name: 'river-clinic', root })).rejects.toThrow();
        await expect(access(path.join(root, 'clients', 'river-clinic'))).rejects.toThrow();
      } finally {
        await chmod(blocked, 0o644);
      }

      const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
      expect(out.dir).toBe(path.join(root, 'clients', 'river-clinic'));
    },
  );
});
