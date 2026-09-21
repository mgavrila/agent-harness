import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { readChangelogSection } from './changelog.js';

const CHANGELOG = `# Changelog

All notable changes to this repository, written for the team that consumes it.

## 0.2.0 — 2026-09-21

### Added

- Slack over HTTPS.

## 0.1.0 — 2026-09-19

The first tagged release.
`;

describe('readChangelogSection', () => {
  it('returns one version s section, without its own heading and without the next one', () => {
    const section = readChangelogSection(CHANGELOG, '0.2.0');
    expect(section).toContain('Slack over HTTPS.');
    expect(section).not.toContain('0.1.0');
    expect(section).not.toContain('## 0.2.0');
    expect(section.startsWith('### Added')).toBe(true);
  });

  it('returns the last section, which has no section after it to stop at', () => {
    expect(readChangelogSection(CHANGELOG, '0.1.0')).toBe('The first tagged release.');
  });

  it('refuses a version the changelog does not describe, naming it', () => {
    expect(() => readChangelogSection(CHANGELOG, '0.3.0')).toThrow(ConfigError);
    expect(() => readChangelogSection(CHANGELOG, '0.3.0')).toThrow(/0\.3\.0/);
  });

  it('matches the version rather than a prefix of one', () => {
    // `0.2` must not match the `0.2.0` heading: a release whose notes were another release's is
    // worse than a release with none.
    expect(() => readChangelogSection(CHANGELOG, '0.2')).toThrow(ConfigError);
  });
});
