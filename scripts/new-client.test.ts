import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { newClient, titleCase } from './new-client.js';

let root: string;

/** A repository skeleton with just the parts new-client reads. */
async function scaffold(): Promise<void> {
  await mkdir(path.join(root, 'packs', 'healthcare'), { recursive: true });
  const template = path.join(root, 'clients', 'demo-practice');
  await mkdir(path.join(template, 'cron'), { recursive: true });
  await mkdir(path.join(template, 'scripts'), { recursive: true });
  await writeFile(path.join(template, 'SOUL.md'), '# Demo Practice credentialing assistant\nYou work for Demo Practice.\n');
  await writeFile(
    path.join(template, 'hermes.config.yaml'),
    'mcp_servers:\n  core-tools:\n    env:\n      HARNESS_CLIENT: "demo-practice"\n      HARNESS_POLICY_FILE: "/srv/agent-harness/clients/demo-practice/policy.yaml"\n',
  );
  await writeFile(path.join(template, 'policy.yaml'), 'classes:\n  external: approval\n');
  await writeFile(path.join(template, '.env.example'), 'HARNESS_CLIENT=demo-practice\n');
  await writeFile(path.join(template, 'cron', 'playbooks.sh'), '#!/usr/bin/env bash\n# demo-practice playbooks\n');
  await writeFile(path.join(template, 'scripts', 'harness-outbox-watchdog.sh'), '#!/usr/bin/env bash\nexit 0\n');
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
      ['.env.example', 'SOUL.md', 'cron/playbooks.sh', 'hermes.config.yaml', 'policy.yaml', 'scripts/harness-outbox-watchdog.sh'].sort(),
    );

    const soul = await readFile(path.join(out.dir, 'SOUL.md'), 'utf8');
    expect(soul).toContain('River Clinic');
    expect(soul).not.toContain('Demo Practice');

    const config = await readFile(path.join(out.dir, 'hermes.config.yaml'), 'utf8');
    expect(config).toContain('HARNESS_CLIENT: "river-clinic"');
    expect(config).toContain('/srv/agent-harness/clients/river-clinic/policy.yaml');
    expect(config).not.toContain('demo-practice');

    const env = await readFile(path.join(out.dir, '.env.example'), 'utf8');
    expect(env).toContain('HARNESS_CLIENT=river-clinic');
  });

  it('reports routing.yaml as skipped when the gateway plan has not landed', async () => {
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    expect(out.skipped).toContain('routing.yaml');
  });

  it('copies routing.yaml when it exists', async () => {
    await writeFile(path.join(root, 'clients', 'demo-practice', 'routing.yaml'), 'routes:\n  chat: demo-practice-chat\n');
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    expect(out.files).toContain('routing.yaml');
    expect(out.skipped).not.toContain('routing.yaml');
    const routing = await readFile(path.join(out.dir, 'routing.yaml'), 'utf8');
    expect(routing).toContain('river-clinic-chat');
  });

  it('refuses a slug that is not a safe directory name', async () => {
    for (const bad of ['River Clinic', '../escape', 'x', 'UPPER', 'trailing-', '9lives']) {
      await expect(newClient({ pack: 'healthcare', name: bad, root })).rejects.toThrow(/name must be/);
    }
  });

  it('refuses a pack that is not installed', async () => {
    await expect(newClient({ pack: 'dentistry', name: 'river-clinic', root })).rejects.toThrow(/no pack named "dentistry"/);
  });

  it('refuses to overwrite an existing client', async () => {
    await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    await expect(newClient({ pack: 'healthcare', name: 'river-clinic', root })).rejects.toThrow(/already exists/);
  });

  it('keeps the executable bit on a copied script', async () => {
    const { chmod, stat } = await import('node:fs/promises');
    await chmod(path.join(root, 'clients', 'demo-practice', 'cron', 'playbooks.sh'), 0o755);
    const out = await newClient({ pack: 'healthcare', name: 'river-clinic', root });
    const mode = (await stat(path.join(out.dir, 'cron', 'playbooks.sh'))).mode;
    expect(mode & 0o111).toBeGreaterThan(0);
  });
});
