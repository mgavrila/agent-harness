import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigError, ToolError } from '@harness/shared';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { loadPacks, registryOf } from './registry.js';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('loadPacks', () => {
  it('loads the healthcare pack by package name', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.all.map((p) => p.name)).toEqual(['healthcare']);
    expect(packs.byName('healthcare')).toBe(healthcarePack);
  });

  it('exposes the five document kinds in the manifest order, which the tool schema depends on', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.documentKinds()).toEqual([
      'state_license',
      'dea_certificate',
      'malpractice_certificate',
      'w9',
      'other',
    ]);
  });

  it('answers for the first pack on manifest, formsDir and skillsDirs', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.manifest().version).toBe('1.0.0');
    expect(packs.formsDir().endsWith('packs/healthcare/forms')).toBe(true);
    expect(packs.skillsDirs().map((d) => d.endsWith('packs/healthcare/skills'))).toEqual([true]);
  });

  it('names only the module when it cannot be resolved, never the resolver error', async () => {
    await expect(loadPacks(['@harness/pack-nope'])).rejects.toThrow(ConfigError);
    await expect(loadPacks(['@harness/pack-nope'])).rejects.toThrow('cannot load pack "@harness/pack-nope"');
    await expect(loadPacks(['@harness/pack-nope'])).rejects.not.toThrow(/node_modules|ERR_MODULE/);
  });

  it('refuses a module that resolves but exports no pack', async () => {
    await expect(loadPacks(['@harness/shared'])).rejects.toThrow('module "@harness/shared" exports no `pack`');
  });

  it('loads no pack at all when HARNESS_PACKS is the empty string', async () => {
    const packs = await loadPacks([]);
    expect(packs.all).toEqual([]);
    expect(packs.documentKinds()).toEqual([]);
  });
});

/**
 * A second pack built from the shipped one: same content, another name, and — unless the test
 * is about that collision — its own record kind, so only the claim under test collides.
 */
function twin(name: string, documentKinds?: readonly string[]) {
  const kind = `${name}_record`;
  return {
    ...healthcarePack,
    name,
    records: healthcarePack.records.map((r) => ({ ...r, kind })),
    extraction: {
      ...healthcarePack.extraction,
      targets: healthcarePack.extraction.targets.map((t) => ({
        ...t,
        record_kind: kind,
        ...(documentKinds ? { document_kinds: documentKinds } : {}),
      })),
    },
  };
}

describe('record kinds, attachment kinds and extraction targets', () => {
  it('lists the record and attachment kinds the pack declares, parsed', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.recordKinds().map((r) => r.kind)).toEqual(['provider']);
    expect(packs.attachmentKinds().map((a) => a.kind)).toEqual(['license', 'dea', 'malpractice', 'board_cert']);
    expect(packs.attachmentKind('license')?.leadDays).toBe(90);
    expect(packs.attachmentKind('epic_link')).toBeUndefined();
  });

  it('resolves every declared document kind to the provider target, and an unclassified one to the first pack', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    for (const kind of packs.documentKinds()) {
      expect(packs.targetFor(kind).recordKind.kind).toBe('provider');
    }
    // No kind on file is not the same question as an unclaimed kind: nobody has said what the
    // document is, so the answer is the deployment's own default — the first loaded pack's first
    // target. That is what an unclassified document reached through a '*' target before packs
    // began claiming their kinds by name.
    expect(packs.targetFor(undefined).target.schema_name).toBe('provider_extraction');
  });

  it('resolves a record kind to the target that writes it, which is a different question', async () => {
    const packs = await loadPacks(['@harness/pack-healthcare']);
    expect(packs.targetForRecordKind('provider').target.schema_name).toBe('provider_extraction');
    expect(() => packs.targetForRecordKind('epic')).toThrow('no loaded pack extracts documents into a "epic" record');
  });

  it('throws a ToolError naming the kind when nothing declares it', () => {
    const noCatchAll = registryOf([
      {
        ...healthcarePack,
        extraction: {
          ...healthcarePack.extraction,
          targets: [{ ...healthcarePack.extraction.targets[0], document_kinds: ['w9'] }],
        },
      },
    ]);
    expect(() => noCatchAll.targetFor('other')).toThrow('no loaded pack extracts a document of kind "other"');
  });

  it('refuses two packs that claim the same document kind, so routing never depends on load order', () => {
    // Healthcare claims its five kinds by name, so a straight copy of it collides on the first.
    expect(() => registryOf([healthcarePack, twin('twin')])).toThrow(ConfigError);
    expect(() => registryOf([healthcarePack, twin('twin')])).toThrow(
      'packs "healthcare" and "twin" both claim document kind "state_license"',
    );

    // Two catch-alls are the collision the stories pack was shaped to avoid, and '*' is a kind
    // for this purpose: whichever pack loaded first would take every document.
    expect(() => registryOf([twin('twin', ['*']), twin('triplet', ['*'])])).toThrow(
      'packs "twin" and "triplet" both claim document kind "*"',
    );

    // An exact claim beside a catch-all is not a collision: the catch-all claims only the kinds
    // no one named, which is exactly the arrangement a second pack uses.
    expect(() => registryOf([twin('twin', ['*']), twin('triplet', ['w9'])])).not.toThrow();

    // Two exact claims on one kind collide the same way.
    expect(() => registryOf([twin('twin', ['w9']), twin('triplet', ['w9'])])).toThrow('both claim document kind "w9"');
  });

  it('refuses two packs that declare the same record kind, because the kind names one pack’s records', () => {
    // Its own document claim, so the only collision left is the shared record kind.
    const sharesProvider = {
      ...healthcarePack,
      name: 'twin',
      extraction: {
        ...healthcarePack.extraction,
        targets: [{ ...healthcarePack.extraction.targets[0], document_kinds: ['twin_notes'] }],
      },
    };
    expect(() => registryOf([healthcarePack, sharesProvider])).toThrow(ConfigError);
    expect(() => registryOf([healthcarePack, sharesProvider])).toThrow(
      'packs "healthcare" and "twin" both declare record kind "provider"',
    );
  });
});

describe('byName', () => {
  it('throws ConfigError for a pack that is not loaded', () => {
    expect(() => registryOf([healthcarePack]).byName('scanning')).toThrow('no pack named "scanning" is loaded');
  });
});

/**
 * A client with no pack: kernel tools only, which the kernel's own principle — a client is a
 * folder, not code — makes a configuration and not a mistake. What used to be refused at
 * construction is answered here, one accessor at a time, so that everything a pack declares is
 * simply empty and the three answers that need a primary pack name what is missing.
 */
describe('registryOf([])', () => {
  it('builds a registry whose every declaration is empty', () => {
    const packs = registryOf([]);
    expect(packs.all).toEqual([]);
    expect(packs.documentKinds()).toEqual([]);
    expect(packs.recordKinds()).toEqual([]);
    expect(packs.attachmentKinds()).toEqual([]);
    expect(packs.skillsDirs()).toEqual([]);
    expect(packs.attachmentKind('license')).toBeUndefined();
  });

  it('names the missing pack rather than crashing on the three answers a primary pack gives', () => {
    const packs = registryOf([]);
    expect(() => packs.manifest()).toThrow('no pack is loaded');
    expect(() => packs.formsDir()).toThrow(ConfigError);
    expect(() => packs.formsDir()).toThrow('no pack is loaded, so no pack ships a forms directory');
    expect(() => packs.targetFor(undefined)).toThrow(ToolError);
    expect(() => packs.targetFor(undefined)).toThrow('no pack is loaded');
  });

  it('answers the per-kind lookups the same way, naming no pack', () => {
    const packs = registryOf([]);
    expect(() => packs.targetFor('state_license')).toThrow(ToolError);
    expect(() => packs.targetForRecordKind('provider')).toThrow(ToolError);
    expect(() => packs.recordKind('provider')).toThrow('no loaded pack declares record kind "provider"');
    expect(() => packs.byName('healthcare')).toThrow('no pack named "healthcare" is loaded');
  });
});

/**
 * `loadPacks` tells three kinds of `import()` failure apart. Each fixture is a throwaway module
 * written under a temp directory next to this test and loaded by its absolute `file://` URL, so
 * none of them touches a real workspace package. Every temp directory is removed after its test,
 * pass or fail.
 */
describe('loadPacks failure modes', () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function fixture(contents: string): string {
    const dir = mkdtempSync(path.join(here, '.tmp-pack-fixture-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'pack.ts');
    writeFileSync(file, contents, 'utf8');
    return pathToFileURL(file).href;
  }

  it('(a) sanitizes a resolver failure, even one under a temp dir rather than node_modules', async () => {
    const url = pathToFileURL(path.join(here, '.tmp-pack-fixture-does-not-exist', 'pack.ts')).href;
    await expect(loadPacks([url])).rejects.toThrow(ConfigError);
    await expect(loadPacks([url])).rejects.toThrow(`cannot load pack "${url}"`);
    await expect(loadPacks([url])).rejects.not.toThrow(/ERR_MODULE_NOT_FOUND|node_modules/);
  });

  it('(b) re-raises a ConfigError the pack throws while initialising, named', async () => {
    const url = fixture(`
      import { definePack } from '@harness/pack-api';
      export const pack = definePack({
        name: 'broken',
        version: '1.0.0',
        records: [
          {
            kind: 'provider',
            label: 'Provider',
            fields: [{ name: 'last_name', type: 'string', description: 'x', restricted: false, source: 'model' }],
            nameFields: ['last_name'],
          },
        ],
        documentKinds: ['other'],
        extraction: {
          version: '1.0.0',
          document_kinds: ['other'],
          role: 'You read documents.',
          targets: [
            {
              document_kinds: ['*'],
              record_kind: 'provider',
              schema_name: 'provider_extraction',
              attachments_key: 'credentials',
              instruction: 'Extract.',
            },
          ],
        },
        formsDir: 'relative/forms',
        skillsDir: '/abs/skills',
        policy: {},
      });
    `);
    await expect(loadPacks([url])).rejects.toThrow(ConfigError);
    await expect(loadPacks([url])).rejects.toThrow(
      `pack "${url}": pack "broken" formsDir must be an absolute path, got "relative/forms"`,
    );
  });

  it('(c) replaces any other error with a message naming only the pack, and logs the original', async () => {
    const secret = '/etc/only-the-log-should-see-this';
    const url = fixture(`throw new Error('could not read ${secret}');`);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(loadPacks([url])).rejects.toThrow(ConfigError);
      await expect(loadPacks([url])).rejects.toThrow(`pack "${url}" failed to initialise`);
      await expect(loadPacks([url])).rejects.not.toThrow(new RegExp(secret.replace(/\//g, '\\/')));
      expect(errorSpy.mock.calls.some((call) => call.some((arg) => String(arg).includes(secret)))).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});
