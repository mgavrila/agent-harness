import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseExtractionManifest, targetFor } from './extraction.js';

const manifest = {
  version: '1.0.0',
  document_kinds: ['meeting_notes', 'other'],
  role: 'You read meeting notes and return structured data.',
  targets: [
    {
      document_kinds: ['*'],
      record_kind: 'epic',
      schema_name: 'epic_extraction',
      attachments_key: 'links',
      instruction: 'Extract the epic this document describes.',
    },
  ],
};

describe('parseExtractionManifest', () => {
  it('takes any non-empty document kind, because the pack is what defines the list', () => {
    expect(parseExtractionManifest(manifest).document_kinds).toEqual(['meeting_notes', 'other']);
    expect(() => parseExtractionManifest({ ...manifest, document_kinds: [] })).toThrow(/document_kinds/);
  });

  it('refuses a manifest with no target, because an extraction would have nowhere to write', () => {
    expect(() => parseExtractionManifest({ ...manifest, targets: [] })).toThrow(/declares no extraction targets/);
  });

  it('refuses two targets claiming the same document kind', () => {
    const clash = {
      ...manifest,
      targets: [
        { ...manifest.targets[0], document_kinds: ['meeting_notes'] },
        { ...manifest.targets[0], document_kinds: ['meeting_notes'], record_kind: 'story' },
      ],
    };
    expect(() => parseExtractionManifest(clash)).toThrow(/two extraction targets both claim "meeting_notes"/);
  });
});

describe('targetFor', () => {
  const parsed = parseExtractionManifest(manifest);

  it('answers with the catch-all target for a kind no target names, and for no kind at all', () => {
    expect(targetFor(parsed, 'meeting_notes')?.record_kind).toBe('epic');
    expect(targetFor(parsed, undefined)?.record_kind).toBe('epic');
  });

  it('prefers an exact match over the catch-all', () => {
    const two = parseExtractionManifest({
      ...manifest,
      targets: [
        manifest.targets[0],
        {
          document_kinds: ['w9'],
          record_kind: 'tax_form',
          schema_name: 'w9_extraction',
          attachments_key: 'attachments',
          instruction: 'Read the W-9.',
        },
      ],
    });
    expect(targetFor(two, 'w9')?.record_kind).toBe('tax_form');
    expect(targetFor(two, 'meeting_notes')?.record_kind).toBe('epic');
  });

  it('answers undefined when there is no catch-all and no target names the kind', () => {
    const exact = parseExtractionManifest({
      ...manifest,
      targets: [{ ...manifest.targets[0], document_kinds: ['meeting_notes'] }],
    });
    expect(targetFor(exact, 'other')).toBeUndefined();
    expect(() =>
      parseExtractionManifest({ ...manifest, targets: [{ ...manifest.targets[0], record_kind: '' }] }),
    ).toThrow(ConfigError);
  });
});
