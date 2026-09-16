import { describe, it, expect } from 'vitest';
import { loadManifest, pack as healthcarePack } from '@harness/pack-healthcare';
import { isRestrictedName } from '../../shared/redaction/names.js';

/**
 * Half of this assertion is the pack's content and half is the kernel's rule, so it can live in
 * neither alone: `isRestrictedName` decides what gets encrypted and is core-tools', and a pack
 * may not import it. The rest of `templates.test.ts` moved into the pack with the templates
 * loader; this one `it` stayed here, unchanged, where both halves are reachable.
 */
describe('form template manifest', () => {
  it('never maps a restricted identifier', async () => {
    const manifest = await loadManifest(healthcarePack.formsDir!);
    for (const template of manifest.templates) {
      for (const mapping of template.mappings) {
        if (mapping.source === 'field') expect(isRestrictedName(mapping.name)).toBe(false);
        if (mapping.source === 'credential') expect(mapping.property).not.toBe('number');
      }
    }
  });
});
