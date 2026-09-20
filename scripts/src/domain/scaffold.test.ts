import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it, expect, afterEach } from 'vitest';
import { filesConfigSource } from '@harness/config-files';
import { newClient, titleCase } from './scaffold.js';

const log = { info() {}, warn() {}, error() {} };
const targets: string[] = [];

/** A directory that is not this repository, which is the only place a client may be written. */
async function newTarget(): Promise<string> {
  const target = await mkdtemp(path.join(tmpdir(), 'harness-tenants-'));
  targets.push(target);
  return target;
}

afterEach(async () => {
  for (const target of targets.splice(0)) await rm(target, { recursive: true, force: true });
});

describe('titleCase', () => {
  it('turns a slug into a display name', () => {
    expect(titleCase('river-clinic')).toBe('River Clinic');
    expect(titleCase('bcbs-tx-group')).toBe('Bcbs Tx Group');
  });
});

describe('newClient', () => {
  it('writes a client document and its persona into the directory it was given', async () => {
    const target = await newTarget();
    const result = await newClient({ name: 'river-clinic', displayName: 'River Clinic', pack: 'healthcare', target });
    expect(result.dir).toBe(path.join(target, 'river-clinic'));
    expect(result.files.sort()).toEqual(['client.yaml', 'persona.md']);

    const loaded = await filesConfigSource({ root: target, log }).load('river-clinic');
    expect(loaded?.document.id).toBe('river-clinic');
    expect(loaded?.document.displayName).toBe('River Clinic');
    expect(loaded?.document.packs).toEqual(['@harness/pack-healthcare']);
    expect(loaded?.document.persona).toContain('River Clinic');
  });

  it('writes a client with no pack, which used to need an empty variable', async () => {
    const target = await newTarget();
    await newClient({ name: 'internal-team', target });
    const loaded = await filesConfigSource({ root: target, log }).load('internal-team');
    expect(loaded?.document.packs).toEqual([]);
  });

  it('schedules nothing, because a new client runs what somebody asked it to and no more', async () => {
    const target = await newTarget();
    await newClient({ name: 'river-clinic', target });
    const loaded = await filesConfigSource({ root: target, log }).load('river-clinic');
    expect(loaded?.document.playbooks.playbooks).toEqual([]);
  });

  it("takes a runtime when the deployment runs one, and the fixture's otherwise", async () => {
    const target = await newTarget();
    await newClient({ name: 'river-clinic', target });
    await newClient({ name: 'internal-team', runtime: 'scripted', target });
    const source = filesConfigSource({ root: target, log });
    expect((await source.load('river-clinic'))?.document.runtime).toBe('deepagents');
    expect((await source.load('internal-team'))?.document.runtime).toBe('scripted');
  });

  it('creates the knowledge directory its own document declares, so the client loads at all', async () => {
    const target = await newTarget();
    const result = await newClient({ name: 'river-clinic', target });
    await expect(readdir(path.join(result.dir, 'knowledge'))).resolves.toEqual([]);
  });

  it('never writes inside this repository unless it was pointed at it', async () => {
    const target = await newTarget();
    const result = await newClient({ name: 'river-clinic', target });
    expect(result.dir.startsWith(target)).toBe(true);
    expect(result.dir).not.toContain(`${path.sep}clients${path.sep}`);
  });

  it('refuses to write anywhere at all when neither --target nor HARNESS_CLIENTS_DIR says where', async () => {
    const previous = process.env.HARNESS_CLIENTS_DIR;
    delete process.env.HARNESS_CLIENTS_DIR;
    try {
      await expect(newClient({ name: 'river-clinic' })).rejects.toThrow(/nowhere to write/);
    } finally {
      if (previous !== undefined) process.env.HARNESS_CLIENTS_DIR = previous;
    }
  });

  it('falls back to HARNESS_CLIENTS_DIR when no target is passed', async () => {
    const target = await newTarget();
    const previous = process.env.HARNESS_CLIENTS_DIR;
    process.env.HARNESS_CLIENTS_DIR = target;
    try {
      const result = await newClient({ name: 'river-clinic' });
      expect(result.dir).toBe(path.join(target, 'river-clinic'));
    } finally {
      if (previous === undefined) delete process.env.HARNESS_CLIENTS_DIR;
      else process.env.HARNESS_CLIENTS_DIR = previous;
    }
  });

  it('refuses to overwrite a client that is already there', async () => {
    const target = await newTarget();
    await newClient({ name: 'river-clinic', target });
    await expect(newClient({ name: 'river-clinic', target })).rejects.toThrow(/already exists/);
  });

  it('refuses a pack this build does not ship, before it writes anything', async () => {
    const target = await newTarget();
    await expect(newClient({ name: 'river-clinic', pack: 'nope', target })).rejects.toThrow(/no pack named "nope"/);
    await expect(readdir(target)).resolves.toEqual([]);
  });

  it('refuses a slug that is not a safe directory name', async () => {
    const target = await newTarget();
    for (const bad of ['River Clinic', '../escape', 'x', 'UPPER', 'trailing-', '9lives']) {
      await expect(newClient({ pack: 'healthcare', name: bad, target })).rejects.toThrow(/name must be/);
    }
  });
});
