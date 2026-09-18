import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TEST_DATABASE_URL } from '@harness/db/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('stdio entrypoint', () => {
  it('spawns and lists tools', async () => {
    const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-'));
    const identityFile = path.join(storageDir, 'identity.yaml');
    writeFileSync(
      identityFile,
      'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '../..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        HARNESS_PRINCIPAL: 'svc-local',
        HARNESS_IDENTITY_FILE: identityFile,
        HARNESS_STORAGE_DIR: storageDir,
      },
    });
    await client.connect(transport);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('providers_upsert');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('spawns with HARNESS_PACKS empty and serves the kernel’s tools alone', async () => {
    // The same spawn as above with one variable changed, which is the whole claim: a client with
    // no pack is a configuration, so the entrypoint comes up and serves rather than dying on the
    // primary pack.
    const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-'));
    const identityFile = path.join(storageDir, 'identity.yaml');
    writeFileSync(
      identityFile,
      'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '../..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        HARNESS_PRINCIPAL: 'svc-local',
        HARNESS_IDENTITY_FILE: identityFile,
        HARNESS_STORAGE_DIR: storageDir,
        HARNESS_PACKS: '',
      },
    });
    await client.connect(transport);
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).toContain('memory_list');
      expect(names).toContain('knowledge_search');
      expect(names).not.toContain('providers_upsert');
      expect(names).not.toContain('forms_fill');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('refuses to start as a principal the identity file does not declare', async () => {
    // Same spawn with HARNESS_PRINCIPAL=u-ghost: the child exits with a ConfigError before it
    // serves, so the client's connect rejects. What matters is that no server ever came up as
    // "u-ghost".
    const storageDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-'));
    const identityFile = path.join(storageDir, 'identity.yaml');
    writeFileSync(
      identityFile,
      'principals:\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '../..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        HARNESS_PRINCIPAL: 'u-ghost',
        HARNESS_IDENTITY_FILE: identityFile,
        HARNESS_STORAGE_DIR: storageDir,
      },
    });
    await expect(client.connect(transport)).rejects.toThrow();
  }, 30_000);
});
