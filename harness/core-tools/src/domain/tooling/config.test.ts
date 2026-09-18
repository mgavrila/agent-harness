import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { registryOf } from '../packs/registry.js';
import { formsDirFrom, packNames, parserFromEnv } from './config.js';

/**
 * The forms directory belongs to the pack. `HARNESS_FORMS_DIR` is an override a deployment
 * opts into, not a value it has to set, so a client that swaps `HARNESS_PACKS` gets the new
 * pack's templates without editing a second variable.
 */
describe('formsDirFrom', () => {
  const packs = { all: [healthcarePack], formsDir: () => '/packs/healthcare/forms' };

  it('takes the pack forms directory when HARNESS_FORMS_DIR is unset, and the override when it is set', () => {
    expect(formsDirFrom(packs, undefined, '/srv/storage')).toBe('/packs/healthcare/forms');
    expect(formsDirFrom(packs, '/srv/elsewhere/forms', '/srv/storage')).toBe('/srv/elsewhere/forms');
    expect(formsDirFrom(packs, './forms', '/srv/storage')).toBe(path.resolve('./forms'));
  });

  it('asks no pack for templates when none is loaded, and still honours the override', () => {
    expect(formsDirFrom(registryOf([]), undefined, '/srv/storage')).toBe('/srv/storage');
    expect(formsDirFrom(registryOf([]), '/srv/elsewhere/forms', '/srv/storage')).toBe('/srv/elsewhere/forms');
  });
});

/**
 * Unset and empty are two different answers: an existing deployment that says nothing keeps the
 * pack it has always had, and a client that says "no pack" gets none. `optionalEnv` cannot tell
 * them apart, which is why `packNames` reads the variable itself.
 */
describe('packNames', () => {
  it('keeps the default when HARNESS_PACKS is unset', () => {
    expect(packNames({})).toEqual(['@harness/pack-healthcare']);
  });

  it('reads an empty HARNESS_PACKS as a client with no pack', () => {
    expect(packNames({ HARNESS_PACKS: '' })).toEqual([]);
    expect(packNames({ HARNESS_PACKS: '  ' })).toEqual([]);
  });

  it('splits, trims and drops empty entries', () => {
    expect(packNames({ HARNESS_PACKS: ' @harness/pack-healthcare , @harness/pack-stories ,' })).toEqual([
      '@harness/pack-healthcare',
      '@harness/pack-stories',
    ]);
  });
});

describe('parserFromEnv', () => {
  it('parses in this process unless HARNESS_FILES_URL names a worker', async () => {
    // The two implementations are told apart by how they fail on a file that is not there: the
    // remote one never reaches a worker on a closed port, the local one reads the filesystem.
    await expect(parserFromEnv('/nonexistent', 'http://127.0.0.1:1').extract('a.pdf')).rejects.toThrow(/unreachable/);
    await expect(parserFromEnv('/nonexistent', undefined).extract('a.pdf')).rejects.not.toThrow(/unreachable/);
  });
});
