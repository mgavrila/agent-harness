import { describe, expect, it } from 'vitest';
import { registryOf } from '../domain/packs/registry.js';
import { GENERIC_RECORD_TOOLS } from '../tools/records.js';
import { PACK_DEADLINE_TOOLS } from '../tools/deadlines.js';
import { PACK_DOCUMENT_TOOLS } from '../tools/documents.js';
import { createCoreToolsServer, kernelTools, publishedTools } from '../tools/catalog.js';
import { connectTestClient, makeTestDeps, resultOf, useTestDb } from '../testing.js';

const db = useTestDb();
const packs = registryOf([]);

/**
 * A client with no pack at all — an internal team that wants memory, playbooks, knowledge,
 * approvals and files and no product area. Seventeen tools today: the kernel's twenty-five, less
 * the five generic `records_*` tools no record kind wants, the two `documents_*` tools that need
 * a pack to reach, and `deadlines_compute`, which needs a record kind to schedule against. The
 * counts are derived from the catalogue rather than written out: a
 * number copied into a test is a number that goes stale the next time the kernel gains a tool,
 * and what this file is about is that the *pack's* half of the catalogue is empty, not how big
 * the kernel's half happens to be.
 */
describe('a deployment with no pack', () => {
  it('publishes the kernel’s own tools, less the two kinds nothing loaded can serve', () => {
    const deps = makeTestDeps(db, { packs });
    const kernel = kernelTools(packs).map((t) => t.name);
    const withheld: readonly string[] = [...GENERIC_RECORD_TOOLS, ...PACK_DOCUMENT_TOOLS, ...PACK_DEADLINE_TOOLS];
    const published = publishedTools(deps).map((t) => t.name);

    expect(published).toEqual(kernel.filter((name) => !withheld.includes(name)));
    expect(published).toHaveLength(kernel.length - withheld.length);
    // The kernel's own areas are all there, and nothing a pack would have added is.
    for (const name of ['memory_add', 'playbooks_list', 'knowledge_search', 'approvals_execute', 'documents_ingest']) {
      expect(published).toContain(name);
    }
    for (const name of ['providers_upsert', 'forms_fill', 'verify_nppes']) expect(published).not.toContain(name);
  });

  it('withholds the two document tools that would have no pack to reach, and keeps the other three', async () => {
    // A tool in the catalogue is a claim to the model that it can be called. Classifying asks
    // which of the loaded packs' kinds a document is and extracting writes a pack's record, so
    // with no pack both can only fail — and classifying would read the whole document first.
    // Registering, getting and listing a file are the kernel's own business and stay.
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of PACK_DOCUMENT_TOOLS) expect(names).not.toContain(name);
    for (const name of ['documents_ingest', 'documents_get', 'documents_list', 'documents_read']) {
      expect(names).toContain(name);
    }
  });

  it('withholds deadlines_compute, which has nothing to recompute against, and keeps deadlines_upcoming', async () => {
    // `deadlines_compute` reads a record's attachments and schedules against the lead days its
    // kind declares, so with nothing loaded it has no kind to be handed and can only fail — the
    // same reason `documents_classify` and `documents_extract` are withheld beside it.
    // `deadlines_upcoming` lists what is already scheduled and answers an empty list, which is a
    // true answer here rather than a failure.
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of PACK_DEADLINE_TOOLS) expect(names).not.toContain(name);
    expect(names).toContain('deadlines_upcoming');
  });

  it('publishes documents_read, which is the only way this client can see inside a file at all', async () => {
    // `documents_get` never returns text and the two tools above are withheld here, so without
    // this one an assistant with no pack could register an attachment and then say nothing
    // about it.
    const deps = makeTestDeps(db, { packs });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    const read = (await client.listTools()).tools.find((t) => t.name === 'documents_read');
    expect(read?.inputSchema.properties).toHaveProperty('page_from');
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
});
