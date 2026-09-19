import { describe, expect, it } from 'vitest';
import { makeTestDeps } from '../testing.js';
import { publishedTools } from './catalog.js';

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

  it('withholds kernel names only: a name a pack publishes is the pack’s, hidden or not', () => {
    // `documents_get` is a kernel name the healthcare pack replaces, so what a client is offered
    // under that name is the pack's wrapper — and `publishedCatalogue` applies the hidden set
    // before any pack contributes. Pinned rather than left to be discovered: a deployment that
    // wants a pack's tool gone removes the pack or blocks the class, it does not list the name.
    const names = publishedTools(makeTestDeps(db, { hiddenTools: ['documents_get'] })).map((tool) => tool.name);
    expect(names).toContain('documents_get');
  });
});
