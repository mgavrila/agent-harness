import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { identitySpecifier, runtimeSpecifier, surfaceSpecifier } from './specifiers.js';

describe('plug-in specifiers', () => {
  it('derives a package name from the name the document gave', () => {
    expect(surfaceSpecifier('memory')).toBe('@harness/surface-memory');
    expect(identitySpecifier('static')).toBe('@harness/identity-static');
    expect(runtimeSpecifier('scripted')).toBe('@harness/runtime-scripted');
  });

  it('refuses a name that is not one, rather than building a specifier out of it', () => {
    for (const bad of ['../evil', 'Memory', '', '@harness/surface-memory', 'a/b']) {
      expect(() => surfaceSpecifier(bad), bad).toThrow(ConfigError);
    }
  });
});
