import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { formsDirFrom, parserFromEnv } from './config.js';

/**
 * The forms directory belongs to the pack. `HARNESS_FORMS_DIR` is an override a deployment
 * opts into, not a value it has to set, so a client that swaps `HARNESS_PACKS` gets the new
 * pack's templates without editing a second variable.
 */
describe('formsDirFrom', () => {
  const packs = { formsDir: () => '/packs/healthcare/forms' };

  it('takes the pack forms directory when HARNESS_FORMS_DIR is unset, and the override when it is set', () => {
    expect(formsDirFrom(packs, undefined)).toBe('/packs/healthcare/forms');
    expect(formsDirFrom(packs, '/srv/elsewhere/forms')).toBe('/srv/elsewhere/forms');
    expect(formsDirFrom(packs, './forms')).toBe(path.resolve('./forms'));
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
