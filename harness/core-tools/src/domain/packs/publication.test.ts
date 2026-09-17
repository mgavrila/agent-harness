import * as z from 'zod/v4';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineTool } from '../tooling/registry.js';
import type { AnyToolDef } from '../tooling/types.js';
import { publishedCatalogue, type ToolSource } from './publication.js';

/** A tool with nothing in it but a name: this module decides on names and never calls a handler. */
function named(name: string): AnyToolDef {
  return defineTool({
    name,
    description: name,
    actionClass: 'read',
    input: z.object({}),
    output: z.object({}),
    handler: async () => ({}),
  });
}

function source(label: string, replaces: string[], tools: string[]): ToolSource {
  return { label, replaces, tools: tools.map(named) };
}

const kernel = [named('records_get'), named('records_upsert'), named('documents_ingest'), named('audit_query')];

describe('publishedCatalogue', () => {
  it('publishes every kernel tool when no source replaces or hides one', () => {
    const published = publishedCatalogue(kernel, [], new Set());
    expect(published.map((t) => t.name)).toEqual(['records_get', 'records_upsert', 'documents_ingest', 'audit_query']);
  });

  it('drops a hidden kernel tool without a source having to claim it', () => {
    // The `genericTools` gate: a deployment whose every record kind is served by a pack's own
    // tools publishes none of the generic five, and no pack has to list them in `replaces` to
    // say so. A hidden name is simply absent — it is not an error and nothing replaces it.
    const published = publishedCatalogue(kernel, [], new Set(['records_get', 'records_upsert']));
    expect(published.map((t) => t.name)).toEqual(['documents_ingest', 'audit_query']);
  });

  it('gives a replaced name to the source that replaced it, in one list with no duplicate', () => {
    const published = publishedCatalogue(
      kernel,
      [source('pack "a"', ['documents_ingest'], ['documents_ingest'])],
      new Set(),
    );
    const names = published.map((t) => t.name);
    expect(names).toEqual(['records_get', 'records_upsert', 'audit_query', 'documents_ingest']);
    expect(new Set(names).size).toBe(names.length);
    expect(published.find((t) => t.name === 'documents_ingest')).toBe(
      // The source's own definition, not the kernel's: a replacement is what an agent calls.
      published[published.length - 1],
    );
  });

  it('refuses a source that replaces a name the kernel does not define', () => {
    // A typo here would otherwise leave the generic tool published beside a half-working
    // replacement and nothing would say so.
    expect(() => publishedCatalogue(kernel, [source('pack "a"', ['documents_injest'], [])], new Set())).toThrow(
      ConfigError,
    );
    expect(() => publishedCatalogue(kernel, [source('pack "a"', ['documents_injest'], [])], new Set())).toThrow(
      'pack "a" replaces "documents_injest", which is not a kernel tool',
    );
  });

  it('refuses two sources replacing the same kernel tool, naming both', () => {
    const sources = [source('pack "a"', ['records_get'], []), source('pack "b"', ['records_get'], [])];
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow(ConfigError);
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow('pack "b" and pack "a" both replace');
  });

  it('refuses two sources publishing the same name, naming both', () => {
    const sources = [source('pack "a"', [], ['forms_fill']), source('pack "b"', [], ['forms_fill'])];
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow(ConfigError);
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow('pack "b" and pack "a" both publish');
  });

  it('refuses a source that replaces a kernel tool it does not publish, naming both', () => {
    // The inverse of the typo rule above, and the one case that was still silent: the kernel's
    // tool is dropped for the whole process and the source ships nothing under that name, so
    // the catalogue simply loses it.
    const sources = [source('pack "a"', ['documents_ingest'], ['documents_ingest_v2'])];
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow(ConfigError);
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow(
      'pack "a" replaces "documents_ingest" but publishes no tool of that name',
    );
  });

  it('refuses a source whose replacement is published by a different source', () => {
    // `replaces` is a claim to serve that name. Letting another pack satisfy it would make which
    // tool an agent reaches depend on load order rather than on either pack's declaration.
    const sources = [source('pack "a"', ['audit_query'], []), source('pack "b"', [], ['audit_query'])];
    expect(() => publishedCatalogue(kernel, sources, new Set())).toThrow(
      'pack "a" replaces "audit_query" but publishes no tool of that name',
    );
  });

  it('refuses a source publishing a kernel name it did not replace', () => {
    // Shadowing without saying so: the catalogue would carry the name twice and which one an
    // agent reached would be list order.
    expect(() => publishedCatalogue(kernel, [source('pack "a"', [], ['audit_query'])], new Set())).toThrow(
      'pack "a" and the kernel both publish "audit_query"',
    );
  });
});
