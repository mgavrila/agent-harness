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

  it('parses the demo client file, which names the five principals Compose and the configs use', async () => {
    const session = await identity.connect({
      env: {},
      log,
      clientDir: path.join(repoRoot, 'clients', 'demo-practice'),
    });
    expect((await session.list()).map((p) => `${p.id}:${p.level}`)).toEqual([
      'u-practice-manager:admin',
      'u-coordinator:lead',
      'svc-hermes:service',
      'svc-approvals:service',
      'svc-local:service',
    ]);
  });
});
