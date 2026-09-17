import { beforeAll, describe, expect, it } from 'vitest';
import { parseRecordKind, type RecordKindSpec } from '@harness/pack-api';
import { readJsonl } from '@harness/shared';
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

/**
 * The two case files, parsed and checked against the declaration above them.
 *
 * Nothing read these. They are hand-written JSON lines, so a trailing comma or a renamed field
 * was a file the eval runner would reject at run time — on a machine with a database and a
 * gateway, long after the build went green — or, worse, would accept while quietly scoring every
 * case zero because the expectation named a field the record kind does not declare.
 *
 * Parsed with `readJsonl` from `@harness/shared` rather than with `loadExtractionCases`. That
 * loader lives in `@harness/evals`, and a pack that imported the eval runner would invert the one
 * relationship this pack exists to demonstrate: the runner measures whichever pack `HARNESS_PACKS`
 * names, and knows none of them. `@harness/shared` is what a pack may reach for, and the checks
 * the loader makes are re-stated below against *this* pack's own kinds, which is the stronger
 * assertion anyway — the loader can only check that `kind` is a string.
 */
interface RawCase {
  id?: unknown;
  kind?: unknown;
  split?: unknown;
  path?: unknown;
  injection?: unknown;
  expected?: { fields?: unknown; attachments?: unknown; restricted?: unknown };
}

interface RawInjection {
  id?: unknown;
  path?: unknown;
  attack?: unknown;
  must_not_appear?: unknown;
  must_hold?: unknown;
}

const isStringList = (v: unknown): v is string[] => Array.isArray(v) && v.every((x) => typeof x === 'string');

describe('the stories eval corpus', () => {
  let cases: { value: RawCase; line: number }[];
  let injections: { value: RawInjection; line: number }[];

  beforeAll(async () => {
    cases = await readJsonl<RawCase>(pack.evals!.casesFile, 'case file');
    injections = await readJsonl<RawInjection>(pack.evals!.injectionFile!, 'case file');
  });

  it('parses as JSON lines, one case per document', () => {
    expect(cases).toHaveLength(3);
    expect(injections).toHaveLength(1);
  });

  it('gives every case the members the eval runner requires', () => {
    for (const { value: row, line } of cases) {
      const where = `cases.jsonl line ${line}`;
      expect(typeof row.id, where).toBe('string');
      expect(typeof row.path, where).toBe('string');
      expect(['text_layer', 'scan'], where).toContain(row.split);
      expect(typeof row.injection, where).toBe('boolean');
      expect(typeof row.expected?.fields, where).toBe('object');
    }
    // A duplicate id silently overwrites a row's score; a duplicate path scores one document
    // twice and calls it two cases.
    expect(new Set(cases.map((c) => c.value.id)).size).toBe(cases.length);
    expect(new Set(cases.map((c) => c.value.path)).size).toBe(cases.length);
  });

  /**
   * The check no generic loader can make. An expectation naming a field the epic record kind does
   * not declare is dropped by `parseExtraction` before it is ever stored, so the case scores zero
   * against an extraction that was in fact correct — a silently wrong number rather than a
   * failure.
   */
  it('expects only kinds and fields this pack declares', () => {
    const fields = new Set(kinds[0].fields.map((f) => f.name));
    const attachmentKinds = new Set(pack.attachments?.map((a) => a.kind));
    for (const { value: row, line } of cases) {
      const where = `cases.jsonl line ${line}`;
      expect(pack.documentKinds, where).toContain(row.kind);
      for (const name of Object.keys(row.expected?.fields as Record<string, string>)) {
        expect(fields, `${where}: expected field "${name}"`).toContain(name);
      }
      const attachments = (row.expected?.attachments ?? []) as { kind?: unknown }[];
      expect(Array.isArray(attachments), where).toBe(true);
      for (const a of attachments) expect(attachmentKinds, where).toContain(a.kind);
      // This pack declares no restricted field, so no case may expect one to be found.
      expect(row.expected?.restricted ?? [], where).toEqual([]);
    }
  });

  it('scores every injection row against a document the case file names', () => {
    const paths = new Set(cases.map((c) => c.value.path));
    for (const { value: row, line } of injections) {
      const where = `injection.jsonl line ${line}`;
      expect(typeof row.id, where).toBe('string');
      expect(typeof row.attack, where).toBe('string');
      expect(isStringList(row.must_not_appear), where).toBe(true);
      expect(isStringList(row.must_hold), where).toBe(true);
      // A row whose `path` names no case is scored against nothing and passes in silence.
      expect(paths, where).toContain(row.path);
      // And the document it names must be one the case file flagged as carrying an attack.
      expect(cases.find((c) => c.value.path === row.path)!.value.injection, where).toBe(true);
    }
  });
});
