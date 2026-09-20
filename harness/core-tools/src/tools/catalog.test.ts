import { describe, expect, it } from 'vitest';
import { connectTestClient, makeTestDeps } from '../testing.js';
import { createCoreToolsServer, publishedTools } from './catalog.js';

const db = null as never;

describe("publishedTools and the client's hidden list", () => {
  it('publishes the whole catalogue when the client hides nothing', () => {
    const names = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    expect(names).toContain('memory_add');
    expect(names).toContain('knowledge_search');
    expect(new Set(names).size).toBe(names.length);
  });

  it('withholds exactly the names the client hides, and nothing else', () => {
    const before = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    const after = publishedTools(makeTestDeps(db, { hiddenTools: ['knowledge_search', 'memory_add'] })).map(
      (tool) => tool.name,
    );
    expect(after).not.toContain('knowledge_search');
    expect(after).not.toContain('memory_add');
    expect(after).toEqual(before.filter((name) => name !== 'knowledge_search' && name !== 'memory_add'));
  });

  it('leaves a hidden tool reachable to a pack wrapper through the kernel bag', () => {
    const deps = makeTestDeps(db, { hiddenTools: ['knowledge_search'] });
    // `createCoreToolsServer` is what fills `kernelTools`; this asserts the contract publishedTools
    // relies on — every kernel tool is there, hidden or not.
    for (const tool of publishedTools(deps)) expect(tool.name).not.toBe('knowledge_search');
    expect(publishedTools(deps).length).toBeGreaterThan(0);
  });

  it('hiding a name nothing publishes changes nothing, because a client may list a tool it never had', () => {
    const before = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    const after = publishedTools(makeTestDeps(db, { hiddenTools: ['never_existed'] })).map((tool) => tool.name);
    expect(after).toEqual(before);
  });

  it('withholds a name a pack publishes, not only a kernel one', () => {
    // `documents_get` is a kernel name the healthcare pack replaces, so what a client would be
    // offered under that name is the pack's own wrapper. A client that says it does not serve
    // `documents_get` means the tool a person sees, and which package defines it is not something
    // that client knows — so the name goes whoever published it.
    const before = publishedTools(makeTestDeps(db)).map((tool) => tool.name);
    expect(before).toContain('documents_get');
    const after = publishedTools(makeTestDeps(db, { hiddenTools: ['documents_get'] })).map((tool) => tool.name);
    expect(after).not.toContain('documents_get');
    expect(after).toEqual(before.filter((name) => name !== 'documents_get'));
  });

  it('refuses a call to a hidden name the way it refuses an unknown one', async () => {
    // The other half of hiding: a name that is not published is not callable either, so a client
    // that hides a tool cannot have it invoked by a model that learned the name elsewhere.
    const deps = makeTestDeps(db, { hiddenTools: ['knowledge_search'] });
    const client = await connectTestClient(() => createCoreToolsServer(deps));
    expect((await client.listTools()).tools.map((t) => t.name)).not.toContain('knowledge_search');
    const hidden = client.callTool({ name: 'knowledge_search', arguments: { query: 'anything' } });
    const unknown = client.callTool({ name: 'no_such_tool_at_all', arguments: {} });
    // The same refusal for both, which is the point: a hidden tool is not a tool of this server.
    await expect(hidden).rejects.toThrow(/knowledge_search/);
    await expect(unknown).rejects.toThrow(/no_such_tool_at_all/);
  });
});
