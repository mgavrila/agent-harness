import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { ConfigError, createLogger } from '@harness/shared';
import { identity } from './index.js';

const log = createLogger('test');
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const FILE = `principals:
  - id: u-coordinator
    kind: user
    level: lead
    displayName: Credentialing coordinator
    surfaces:
      memory: U0456EFGH
  - id: svc-local
    kind: service
    level: service
    displayName: Local operator
`;

/** The same file, with the key that says what someone nobody declared gets. */
const WITH_DEFAULTS = `defaults:\n  memory: member\n${FILE}`;

let dir: string;
afterEach(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function clientDir(contents: string | null): string {
  dir = mkdtempSync(path.join(tmpdir(), 'harness-identity-'));
  if (contents !== null) writeFileSync(path.join(dir, 'identity.yaml'), contents);
  return dir;
}

describe('@harness/identity-static', () => {
  it('declares itself static with no secrets', () => {
    expect(identity.name).toBe('static');
    expect(identity.secrets).toEqual([]);
  });

  it('reads identity.yaml out of the client folder and resolves through it', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: clientDir(FILE) });
    expect(session.name).toBe('static');
    expect((await session.get('u-coordinator'))?.level).toBe('lead');
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('takes HARNESS_IDENTITY_FILE over the client folder when it is set', async () => {
    const elsewhere = path.join(clientDir(null), 'elsewhere.yaml');
    writeFileSync(elsewhere, FILE);
    const session = await identity.connect({
      env: { HARNESS_IDENTITY_FILE: elsewhere },
      log,
      clientDir: '/nonexistent',
    });
    expect((await session.get('svc-local'))?.kind).toBe('service');
  });

  it('is a startup error when the file is missing or invalid', async () => {
    await expect(identity.connect({ env: {}, log, clientDir: clientDir(null) })).rejects.toThrow(ConfigError);
    await expect(identity.connect({ env: {}, log, clientDir: dir })).rejects.toThrow(/identity\.yaml/);
    const bad = clientDir('principals:\n  - id: nobody\n    kind: user\n    level: lead\n    displayName: x\n');
    await expect(identity.connect({ env: {}, log, clientDir: bad })).rejects.toThrow(/identity file is invalid/);
  });

  it('gives an undeclared user the level its surface defaults to, under an id derived from theirs', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: clientDir(WITH_DEFAULTS) });
    const minted = await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' });
    expect(minted).toEqual({
      id: 'u-memory-u0c0keb8w3x-6774a381',
      kind: 'user',
      level: 'member',
      displayName: 'U0C0KEB8W3X',
      surfaces: { memory: 'U0C0KEB8W3X' },
      attributes: {},
    });
    // The same person is the same principal on the next turn, and on the next process.
    expect(await session.resolve({ surface: 'memory', userId: 'U0C0KEB8W3X' })).toEqual(minted);
    expect(await session.get('u-memory-u0c0keb8w3x-6774a381')).toEqual(minted);
  });

  it('leaves a declared principal alone, and names only the newly minted ones in the log', async () => {
    const lines: string[] = [];
    const recording = { ...log, info: (message: string) => lines.push(message) };
    const session = await identity.connect({ env: {}, log: recording, clientDir: clientDir(WITH_DEFAULTS) });
    expect((await session.resolve({ surface: 'memory', userId: 'U0456EFGH' }))?.id).toBe('u-coordinator');
    await session.resolve({ surface: 'memory', userId: 'U9' });
    await session.resolve({ surface: 'memory', userId: 'U9' });
    expect(lines.filter((line) => line.includes('u-memory-u9-c5f6f2a2'))).toHaveLength(1);
    // `list()` stays the file's own answer: what was declared, in the order it was declared.
    expect((await session.list()).map((p) => p.id)).toEqual(['u-coordinator', 'svc-local']);
  });

  it('still refuses an undeclared user when the file names no default at all', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: clientDir(FILE) });
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
  });

  it('still refuses an undeclared user on a surface the defaults leave out', async () => {
    const session = await identity.connect({ env: {}, log, clientDir: clientDir(WITH_DEFAULTS) });
    expect(await session.resolve({ surface: 'http', userId: 'nobody' })).toBeNull();
  });

  it('refuses a caller whose derived id is already declared, and says so once', async () => {
    // `U9` on `memory` derives `u-memory-u9-c5f6f2a2`. Declaring that id outright would otherwise
    // hand whoever holds it the declared principal's memory, approvals and audit trail.
    const warnings: string[] = [];
    const recording = { ...log, warn: (message: string) => warnings.push(message) };
    const collides = `defaults:\n  memory: member\n${FILE}  - id: u-memory-u9-c5f6f2a2\n    kind: user\n    level: admin\n    displayName: Someone else\n`;
    const session = await identity.connect({ env: {}, log: recording, clientDir: clientDir(collides) });

    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(await session.resolve({ surface: 'memory', userId: 'U9' })).toBeNull();
    expect(warnings).toEqual([
      'static identity: derived id "u-memory-u9-c5f6f2a2" is already declared; refusing the caller',
    ]);
    // The declared principal is untouched, and everyone else on the surface still gets a default.
    expect((await session.get('u-memory-u9-c5f6f2a2'))?.level).toBe('admin');
    expect((await session.resolve({ surface: 'memory', userId: 'U8' }))?.level).toBe('member');
  });

  it('refuses a file that defaults the run API surface, whatever level it names', async () => {
    const bad = clientDir(`defaults:\n  http: member\n${FILE}`);
    await expect(identity.connect({ env: {}, log, clientDir: bad })).rejects.toThrow(ConfigError);
    await expect(identity.connect({ env: {}, log, clientDir: dir })).rejects.toThrow(/"http" may not have a default/);
  });

  it('refuses a file that defaults a surface to the service level', async () => {
    const bad = clientDir(`defaults:\n  memory: service\n${FILE}`);
    await expect(identity.connect({ env: {}, log, clientDir: bad })).rejects.toThrow(ConfigError);
  });

  it('parses the demo client file, which names the five principals Compose and the configs use', async () => {
    const session = await identity.connect({
      env: {},
      log,
      clientDir: path.join(repoRoot, 'clients', 'demo-practice'),
    });
    expect((await session.list()).map((p) => `${p.id}:${p.level}`)).toEqual([
      'u-practice-manager:admin',
      'u-coordinator:lead',
      'svc-host:service',
      'svc-playbooks:service',
      'svc-local:service',
    ]);
  });
});
