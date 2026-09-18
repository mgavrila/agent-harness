import { describe, expect, it } from 'vitest';
import { registryOf } from '../domain/packs/registry.js';
import { GENERIC_RECORD_TOOLS } from '../tools/records.js';
import { createCoreToolsServer, kernelTools, publishedTools } from '../tools/catalog.js';
import { connectTestClient, makeTestDeps, resultOf, textOf, useTestDb } from '../testing.js';

const db = useTestDb();
const packs = registryOf([]);

/**
 * A client with no pack at all — an internal team that wants memory, playbooks, knowledge,
 * approvals and files and no product area. The counts below are derived from the catalogue
 * rather than written out: a number copied into a test is a number that goes stale the next
 * time the kernel gains a tool, and what this file is about is that the *pack's* half of the
 * catalogue is empty, not how big the kernel's half happens to be.
 */
describe('a deployment with no pack', () => {
  it('publishes the kernel’s own tools, less the generic record tools nothing declares a kind for', () => {
    const deps = makeTestDeps(db, { packs });
    const kernel = kernelTools(packs).map((t) => t.name);
    const published = publishedTools(deps).map((t) => t.name);

    expect(published).toEqual(kernel.filter((name) => !(GENERIC_RECORD_TOOLS as readonly string[]).includes(name)));
    expect(published).toHaveLength(kernel.length - GENERIC_RECORD_TOOLS.length);
    // The kernel's own areas are all there, and nothing a pack would have added is.
    for (const name of ['memory_add', 'playbooks_list', 'knowledge_search', 'approvals_execute', 'documents_ingest']) {
      expect(published).toContain(name);
    }
    for (const name of ['providers_upsert', 'forms_fill', 'verify_nppes']) expect(published).not.toContain(name);
  });

  it('serves that catalogue over MCP, so no schema is built from a pack declaration that is not there', async () => {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(
      publishedTools(deps)
        .map((t) => t.name)
        .sort(),
    );
  });

  it('offers documents_ingest with no kind to declare, rather than an enum of nothing', async () => {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const { tools } = await client.listTools();
    const ingest = tools.find((t) => t.name === 'documents_ingest');
    expect(ingest?.inputSchema.properties).toHaveProperty('path');
    expect(ingest?.inputSchema.properties).not.toHaveProperty('kind');
  });

  it('runs a kernel tool end to end', async () => {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const res = await client.callTool({ name: 'memory_list', arguments: {} });
    expect(resultOf<{ entries: unknown[] }>(res).entries).toEqual([]);
  });

  it('tells a caller that extraction needs a pack rather than crashing on the primary pack', async () => {
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const res = await client.callTool({
      name: 'documents_extract',
      arguments: { document_id: '00000000-0000-0000-0000-000000000000' },
    });
    expect(res.isError).toBe(true);
    expect(textOf(res)).not.toMatch(/undefined|TypeError/);
  });
});
