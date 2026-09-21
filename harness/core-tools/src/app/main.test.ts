import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { afterAll, beforeAll, describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { fixtureDocument } from '@harness/config-api/testing';
import { TEST_DATABASE_URL } from '@harness/db/testing';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * One clients directory outside this repository, with one sub-directory per case.
 *
 * The entrypoint resolves its client through `HARNESS_CONFIG_SOURCE`, so these spawns configure
 * the `files` source over a temporary root rather than writing a folder into the checkout. That
 * is the property this whole plan is for: nothing the server reads is derived from where its code
 * happens to sit.
 */
let clientsDir: string;

/** The one principal every document below declares, and the one `HARNESS_PRINCIPAL` names. */
const LOCAL_SERVICE = { id: 'svc-local', kind: 'service', level: 'service', displayName: 'Local' };

function writeClient(id: string, overrides: Record<string, unknown>): void {
  const dir = path.join(clientsDir, id);
  mkdirSync(dir, { recursive: true });
  const document = fixtureDocument({
    id,
    displayName: id,
    identity: { principals: [LOCAL_SERVICE] },
    ...overrides,
  });
  // YAML is a superset of JSON, so the document goes down as JSON rather than as hand-written
  // YAML that could drift from the schema the fixture already satisfies.
  writeFileSync(path.join(dir, 'client.yaml'), JSON.stringify(document, null, 2), 'utf8');
}

beforeAll(() => {
  clientsDir = mkdtempSync(path.join(tmpdir(), 'harness-smoke-clients-'));
  writeClient('smoke', {});
  writeClient('nopack', { packs: [] });
  writeClient('stories', { packs: ['@harness/pack-stories'] });
  writeClient('hides', { policy: { tools: { hide: ['knowledge_search'] } } });
});

afterAll(() => {
  rmSync(clientsDir, { recursive: true, force: true });
});

/** A connected client against the entrypoint, serving `client` from the temporary clients root. */
async function connect(client: string, principal = 'svc-local'): Promise<Client> {
  const mcp = new Client({ name: 'smoke', version: '0.0.0' });
  const transport = new StdioClientTransport({
    command: 'pnpm',
    args: ['exec', 'tsx', path.join(here, 'main.ts')],
    cwd: path.resolve(here, '../..'),
    env: {
      ...process.env,
      DATABASE_URL: TEST_DATABASE_URL,
      HARNESS_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
      HARNESS_CONFIG_SOURCE: 'files',
      // Required, with no default. These documents name their secrets as environment variables,
      // which is what `env` resolves.
      HARNESS_SECRET_SOURCE: 'env',
      HARNESS_CLIENTS_DIR: clientsDir,
      HARNESS_CLIENT: client,
      HARNESS_PRINCIPAL: principal,
      HARNESS_STORAGE_DIR: mkdtempSync(path.join(tmpdir(), 'harness-smoke-storage-')),
    },
  });
  await mcp.connect(transport);
  return mcp;
}

describe('stdio entrypoint', () => {
  it('spawns and lists tools', async () => {
    const client = await connect('smoke');
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain('providers_upsert');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('spawns for a document that names no pack and serves the kernel’s tools alone', async () => {
    // The same spawn as above with one document field changed, which is the whole claim: a client
    // with no pack is a configuration, so the entrypoint comes up and serves rather than dying on
    // the primary pack.
    const client = await connect('nopack');
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

  it('spawns with a pack that ships no forms directory, which used to kill it at startup', async () => {
    // `@harness/pack-stories` declares a skills directory and no forms directory, which the
    // contract allows. Before the forms fallback, resolving the templates directory at startup
    // threw `pack "stories" ships no forms directory` and the server never served.
    const client = await connect('stories');
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      // The pack's own kinds are loaded, so the two document tools a pack serves are published.
      expect(names).toContain('documents_extract');
      expect(names).toContain('records_upsert');
      expect(names).not.toContain('forms_fill');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('withholds the tools the document’s policy.tools.hide names, and only those', async () => {
    // The end of the path the unit tests cover a piece each of: a document's `tools.hide`, through
    // `buildKernelConfig` and `depsForRun`, to what an MCP client is actually offered.
    const client = await connect('hides');
    try {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain('knowledge_search');
      expect(names).toContain('knowledge_sync');
      expect(names).toContain('providers_upsert');
    } finally {
      await client.close();
    }
  }, 30_000);

  it('refuses to start as a principal the document does not declare', async () => {
    // Same spawn with HARNESS_PRINCIPAL=u-ghost: the child exits with a ConfigError before it
    // serves, so the client's connect rejects. What matters is that no server ever came up as
    // "u-ghost".
    await expect(connect('smoke', 'u-ghost')).rejects.toThrow();
  }, 30_000);

  it('refuses to start for a client the configured source does not hold, naming both', async () => {
    // A server that started anyway would open runs and write audit rows under a client id nobody
    // configured.
    await expect(connect('nosuchclient')).rejects.toThrow();
  }, 30_000);
});
