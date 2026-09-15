import { describe, it, expect } from 'vitest';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { TEST_DATABASE_URL } from '@harness/db/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('stdio entrypoint', () => {
  it('spawns and lists tools', async () => {
    const client = new Client({ name: 'smoke', version: '0.0.0' });
    const transport = new StdioClientTransport({
      command: 'pnpm',
      args: ['exec', 'tsx', path.join(here, 'main.ts')],
      cwd: path.resolve(here, '..'),
      env: {
        ...process.env,
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
        HARNESS_CLIENT: 'smoke',
        CORE_TOOLS_CALLER: 'smoke-test',
        HARNESS_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-')),
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
});
