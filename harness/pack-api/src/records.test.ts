import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { defineAttachmentKind, defineRecordKind, parseAttachmentKind, parseRecordKind } from './records.js';
import type { ManifestField } from './manifest.js';

const field = (name: string, extra: Partial<ManifestField> = {}): ManifestField => ({
  name,
  type: 'string',
  description: `the ${name}`,
  restricted: false,
  source: 'model',
  ...extra,
});

const epic = {
  kind: 'epic',
  label: 'Epic',
  fields: [field('title'), field('summary')],
  nameFields: ['title'],
};

describe('defineRecordKind', () => {
  it('returns the spec unchanged when it is well formed', () => {
    expect(defineRecordKind(epic)).toBe(epic);
  });

  it('refuses a kind that is not a lowercase identifier, because it is a column value and a tool enum member', () => {
    expect(() => defineRecordKind({ ...epic, kind: 'Epic' })).toThrow(ConfigError);
    expect(() => defineRecordKind({ ...epic, kind: 'Epic' })).toThrow(/record kind "Epic"/);
  });

  it('refuses a kind with no label', () => {
    expect(() => defineRecordKind({ ...epic, label: '  ' })).toThrow(/record kind "epic" has no label/);
  });

  it('refuses a kind with no fields', () => {
    expect(() => defineRecordKind({ ...epic, fields: [] })).toThrow(/record kind "epic" declares no fields/);
  });

  it('refuses nameFields that are empty or name a field the kind does not declare', () => {
    expect(() => defineRecordKind({ ...epic, nameFields: [] })).toThrow(/declares no nameFields/);
    expect(() => defineRecordKind({ ...epic, nameFields: ['headline'] })).toThrow(
      /nameFields names "headline", which is not one of its fields/,
    );
  });

  it('refuses an externalId that names a field the kind does not declare', () => {
    expect(() => defineRecordKind({ ...epic, externalId: { field: 'npi', digitsOnly: true } })).toThrow(
      /externalId names "npi", which is not one of its fields/,
    );
  });

  it('refuses a restricted field as the name or the external id, because both are stored in plaintext', () => {
    const withSecret = { ...epic, fields: [...epic.fields, field('ssn', { restricted: true, source: 'redaction' })] };
    expect(() => defineRecordKind({ ...withSecret, nameFields: ['ssn'] })).toThrow(
      /nameFields names the restricted field "ssn"/,
    );
    expect(() => defineRecordKind({ ...withSecret, externalId: { field: 'ssn', digitsOnly: false } })).toThrow(
      /externalId names the restricted field "ssn"/,
    );
  });
});

describe('defineAttachmentKind', () => {
  const link = { kind: 'source_link', label: 'Source link', leadDays: 0, numberRestricted: false, properties: [] };

  it('returns the spec unchanged when it is well formed', () => {
    expect(defineAttachmentKind(link)).toBe(link);
  });

  it('refuses a kind that is not a lowercase identifier, because it is a column value', () => {
    expect(() => defineAttachmentKind({ ...link, kind: 'Source-Link' })).toThrow(/attachment kind "Source-Link"/);
  });

  it('refuses a kind with no label', () => {
    expect(() => defineAttachmentKind({ ...link, label: '  ' })).toThrow(/attachment kind "source_link" has no label/);
  });

  it('refuses a negative lead time; zero means "no renewal deadline"', () => {
    expect(defineAttachmentKind({ ...link, leadDays: 0 }).leadDays).toBe(0);
    expect(() => defineAttachmentKind({ ...link, leadDays: -1 })).toThrow(/leadDays must be zero or more/);
  });

  it('refuses a property outside the four the record model stores', () => {
    expect(() => defineAttachmentKind({ ...link, properties: ['colour'] as never })).toThrow(/unknown property/);
  });
});

describe('parseRecordKind and parseAttachmentKind', () => {
  const never = { isRestrictedName: () => false };

  it('fills the manifest field defaults so a pack may ship bare JSON', () => {
    const parsed = parseRecordKind(
      {
        kind: 'epic',
        label: 'Epic',
        nameFields: ['title'],
        fields: [{ name: 'title', type: 'string', description: 'x' }],
      },
      never,
    );
    expect(parsed.fields[0]).toEqual({
      name: 'title',
      type: 'string',
      description: 'x',
      restricted: false,
      source: 'model',
    });
    expect(parsed.genericTools).toBe(true);
  });

  it('applies the caller restricted-name check to a kind read from JSON', () => {
    const raw = {
      kind: 'provider',
      label: 'Provider',
      nameFields: ['last_name'],
      fields: [
        { name: 'last_name', type: 'string', description: 'x' },
        { name: 'zzz', type: 'string', description: 'x', restricted: true, source: 'redaction' },
      ],
    };
    expect(() => parseRecordKind(raw, never)).toThrow(/not recognised by isRestrictedName/);
  });

  it('defaults leadDays and numberRestricted so a pack may omit them', () => {
    expect(parseAttachmentKind({ kind: 'source_link', label: 'Source link', properties: [] })).toEqual({
      kind: 'source_link',
      label: 'Source link',
      leadDays: 0,
      numberRestricted: false,
      properties: [],
    });
  });
});
