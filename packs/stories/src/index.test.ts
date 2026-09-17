import { describe, expect, it } from 'vitest';
import { parseRecordKind, type RecordKindSpec } from '@harness/pack-api';
import { pack } from './index.js';

/**
 * The kernel parses a pack's raw kinds against its own restricted-name rules, so the defaults
 * this file asserts on — `restricted: false` above all — do not exist on `pack.records` itself.
 * Parsing here with a predicate that calls nothing restricted is enough for these assertions:
 * the point is that the pack declares no field a real rule set could object to, and
 * `records.test.ts` in `@harness/pack-api` covers the rules themselves.
 */
const kinds: RecordKindSpec[] = pack.records.map((r) => parseRecordKind(r, { isRestrictedName: () => false }));

describe('the stories pack', () => {
  it('declares one record kind with no restricted field, which is what makes it a proof pack', () => {
    expect(kinds.map((r) => r.kind)).toEqual(['epic']);
    expect(kinds[0].fields.filter((f) => f.restricted)).toEqual([]);
    expect(kinds[0].nameFields).toEqual(['title']);
  });

  it('declares an attachment kind that never expires, so no renewal deadline is ever computed', () => {
    expect(pack.attachments?.map((a) => a.kind)).toEqual(['source_link']);
    expect((pack.attachments?.[0] as { leadDays: number }).leadDays).toBe(0);
  });

  it('ships no tools, no replaced kernel tool and no forms directory', () => {
    expect(pack.tools).toBeUndefined();
    expect(pack.replaces).toBeUndefined();
    expect(pack.formsDir).toBeUndefined();
  });

  it('routes its one document kind to the epic target, by name rather than by catch-all', () => {
    expect(pack.documentKinds).toEqual(['meeting_notes']);
    expect(pack.extraction.targets).toHaveLength(1);
    expect(pack.extraction.targets[0].document_kinds).toEqual(['meeting_notes']);
    // No '*': a catch-all claims every kind in the process, including kinds another loaded pack
    // declared, and two of them would collide at load.
    expect(pack.extraction.targets[0].document_kinds).not.toContain('*');
    expect(pack.extraction.targets[0].record_kind).toBe('epic');
  });

  it('calls the model-facing attachment property something other than the kernel’s word', () => {
    // `attachments_key` is the one place a pack's noun reaches the wire. Healthcare says
    // `credentials`; this pack says `links`. Two packs disagreeing is what proves the kernel
    // owns neither word.
    expect(pack.extraction.targets[0].attachments_key).toBe('links');
    expect(pack.extraction.targets[0].attachment_instruction).not.toBe(
      pack.extraction.targets[0].attachment_schema_description,
    );
  });

  it('names an eval corpus, an intake skill and judged fields that hold nothing restricted', () => {
    expect(pack.evals?.judgedFields).toEqual(['summary']);
    expect(pack.evals?.generate).toBe('@harness/pack-stories/generate');
    for (const p of [pack.skillsDir, pack.evals!.casesFile, pack.evals!.injectionFile!, pack.evals!.corpusDir!]) {
      expect(p.startsWith('/')).toBe(true);
    }
  });
});
