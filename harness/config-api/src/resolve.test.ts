import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { pointerSegments, readPointer } from './pointer.js';
import { resolve } from './resolve.js';
import { fixtureDocument } from './testing.js';
import type { Blueprint, Overlay } from './types.js';

function blueprint(lockset: string[], overrides: Record<string, unknown> = {}): Blueprint {
  const { id: _id, displayName: _displayName, ...document } = fixtureDocument(overrides);
  return { document: document as Blueprint['document'], lockset, version: 'bp-1' };
}

const names: Overlay = {
  version: 'ov-1',
  patch: [
    { op: 'add', path: '/id', value: 'acme' },
    { op: 'add', path: '/displayName', value: 'Acme' },
  ],
};

describe('pointerSegments', () => {
  it('splits a pointer and unescapes the two escapes', () => {
    expect(pointerSegments('/policy/classes/write.self')).toEqual(['policy', 'classes', 'write.self']);
    expect(pointerSegments('/a~1b/c~0d')).toEqual(['a/b', 'c~d']);
    expect(pointerSegments('')).toEqual([]);
  });

  it('refuses something that is not a pointer, so a typo locks loudly rather than nothing', () => {
    expect(() => pointerSegments('policy')).toThrow(ConfigError);
  });
});

describe('resolve', () => {
  it('applies an overlay on an unlocked path and returns a whole, valid document', () => {
    const bp = blueprint(['/persona']);
    const before = structuredClone(bp.document);
    const document = resolve(bp, {
      version: 'ov-1',
      patch: [
        ...names.patch,
        { op: 'replace', path: '/displayName', value: 'Acme Clinic' },
        { op: 'add', path: '/policy/classes', value: { external: 'blocked' } },
      ],
    });
    expect(document.id).toBe('acme');
    expect(document.displayName).toBe('Acme Clinic');
    expect(readPointer(document, '/policy/classes/external')).toBe('blocked');
    // The blueprint passed in is untouched: `resolve` clones before it writes.
    expect(bp.document).toEqual(before);
  });

  it('refuses an operation inside a locked subtree, naming the operation and the lock', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/policy/classes/external', value: 'auto' }],
    };
    expect(() => resolve(blueprint(['/policy']), overlay)).toThrow(ConfigError);
    expect(() => resolve(blueprint(['/policy']), overlay)).toThrow(
      'overlay ov-1: replace /policy/classes/external touches "/policy", which blueprint bp-1 locks',
    );
  });

  it('refuses an operation above a locked leaf, because replacing the subtree replaces the leaf', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/policy', value: {} }],
    };
    expect(() => resolve(blueprint(['/policy/classes/external']), overlay)).toThrow(
      'overlay ov-1: replace /policy touches "/policy/classes/external", which blueprint bp-1 locks',
    );
  });

  it('does not read one pointer as a prefix of another that merely starts the same way', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [...names.patch, { op: 'replace', path: '/persona', value: 'Another persona.' }],
    };
    expect(resolve(blueprint(['/personaNotes']), overlay).persona).toBe('Another persona.');
  });

  it('names the first violation, so the same overlay always gives the same message', () => {
    const overlay: Overlay = {
      version: 'ov-1',
      patch: [
        ...names.patch,
        { op: 'replace', path: '/persona', value: 'x' },
        { op: 'replace', path: '/runtime', value: 'other' },
      ],
    };
    expect(() => resolve(blueprint(['/runtime', '/persona']), overlay)).toThrow(
      /replace \/persona touches "\/persona"/,
    );
  });

  it('refuses a blueprint that locks the two fields only an overlay can supply', () => {
    expect(() => resolve(blueprint(['/id']), names)).toThrow(/"\/id" cannot be locked/);
    expect(() => resolve(blueprint(['/displayName']), names)).toThrow(/cannot be locked/);
  });

  it('refuses a replace of something the blueprint does not have, and a remove of the same', () => {
    expect(() =>
      resolve(blueprint([]), {
        version: 'ov-1',
        patch: [...names.patch, { op: 'replace', path: '/nothing', value: 1 }],
      }),
    ).toThrow(/cannot replace \/nothing/);
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'remove', path: '/nothing' }] }),
    ).toThrow(/cannot remove \/nothing/);
  });

  it('refuses a patch that leaves the schema behind, rather than handing back a broken document', () => {
    expect(() =>
      resolve(blueprint([]), {
        version: 'ov-1',
        patch: [...names.patch, { op: 'replace', path: '/runtime', value: 7 }],
      }),
    ).toThrow(/client document is invalid/);
  });

  it('removes an unlocked key', () => {
    const document = resolve(blueprint([]), {
      version: 'ov-1',
      patch: [...names.patch, { op: 'remove', path: '/surfaces/http' }],
    });
    expect(document.surfaces.http).toBeUndefined();
  });

  it('inserts, appends, replaces and removes by array index (RFC 6902 §4.1)', () => {
    const bp = blueprint([], { policy: { tools: { hide: ['knowledge_search'] } } });
    const document = resolve(bp, {
      version: 'ov-1',
      patch: [
        ...names.patch,
        // `-` appends, so a tenant does not have to know the pack list's current length.
        { op: 'add', path: '/packs/-', value: '@harness/pack-stories' },
        // A numeric index inserts before that position.
        { op: 'add', path: '/policy/tools/hide/0', value: 'records_search' },
        { op: 'replace', path: '/routing/routes/chat/model', value: 'groq/openai/gpt-oss-20b' },
        // Removes what the insert above put at index 1.
        { op: 'remove', path: '/policy/tools/hide/1' },
      ],
    });
    expect(document.packs).toEqual(['@harness/pack-healthcare', '@harness/pack-stories']);
    expect(document.policy.tools.hide).toEqual(['records_search']);
    expect(document.routing.routes.chat.model).toBe('groq/openai/gpt-oss-20b');
  });

  it('refuses an add whose index is past the end of the array', () => {
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'add', path: '/packs/5', value: 'x' }] }),
    ).toThrow(/cannot add \/packs\/5, which is not a position in a 1-element array/);
  });
});

describe('a hostile overlay', () => {
  it('refuses the three segments that name a prototype, and leaves Object.prototype untouched', () => {
    for (const path of ['/__proto__/polluted', '/constructor/prototype/polluted', '/prototype/polluted']) {
      expect(() =>
        resolve(blueprint([]), { version: 'ov-1', patch: [...names.patch, { op: 'add', path, value: 'yes' }] }),
      ).toThrow(ConfigError);
    }
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('cannot reach a key the blueprint inherits rather than owns', () => {
    expect(() =>
      resolve(blueprint([]), {
        version: 'ov-1',
        patch: [...names.patch, { op: 'replace', path: '/toString', value: 'x' }],
      }),
    ).toThrow(/cannot replace \/toString/);
  });
});

describe('resolve validates what it was handed', () => {
  it('refuses a blueprint whose document contains a cycle, rather than exhausting the stack', () => {
    // A YAML anchor that refers to its own ancestor parses into a genuinely cyclic object, and
    // `structuredClone` keeps the cycle. A tenant's file must not be able to end a request with a
    // RangeError on the very path the prototype refusal is about.
    const bp = blueprint([]);
    const document = bp.document as unknown as Record<string, unknown>;
    document.loop = document;
    expect(() => resolve(bp, names)).toThrow(ConfigError);
    expect(() => resolve(bp, names)).toThrow(/refers to itself/);
  });

  it('refuses a blueprint with no lock set, rather than failing on an iteration', () => {
    const { lockset: _lockset, ...rest } = blueprint([]);
    expect(() => resolve(rest as Blueprint, names)).toThrow(ConfigError);
    expect(() => resolve(rest as Blueprint, names)).toThrow(/blueprint is invalid/);
  });

  it('refuses an overlay operation with a non-string path or an unknown op', () => {
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [{ op: 'add', path: 7, value: 1 } as unknown as never] }),
    ).toThrow(/overlay is invalid/);
    expect(() =>
      resolve(blueprint([]), { version: 'ov-1', patch: [{ op: 'copy', path: '/persona' } as unknown as never] }),
    ).toThrow(/overlay is invalid/);
  });
});
