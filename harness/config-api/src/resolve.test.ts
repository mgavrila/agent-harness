import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { pointerSegments, readPointer, resolve } from './resolve.js';
import { fixtureDocument } from './testing.js';
import type { Blueprint, Overlay } from './types.js';

function blueprint(lockset: string[]): Blueprint {
  const { id: _id, displayName: _displayName, ...document } = fixtureDocument();
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
    const document = resolve(blueprint(['/persona']), {
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
    // The blueprint is untouched: `resolve` clones before it writes.
    expect(readPointer(blueprint([]).document, '/policy/classes')).toBeUndefined();
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
});
