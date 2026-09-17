import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { ConfigError, envOrDefault } from '@harness/shared';
import { clientDirFor, formsDirFrom, parserFromEnv, resolvePrincipal } from './server.js';

/**
 * The two variables `buildDepsFromEnv` reads with a default. Each one used to go through
 * `optionalEnv`, which reads an empty string as absent, so a half-filled `.env` changed the
 * client or the audited caller without saying so. The healthcare pack calls the same helper for
 * `NPPES_BASE_URL`, which it reads itself now; `packs/healthcare/src/config.test.ts` is where
 * that variable's version of this assertion lives.
 */
describe('envOrDefault', () => {
  it('refuses an empty HARNESS_CLIENT rather than serving the default client', () => {
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '' })).toThrow(ConfigError);
    expect(() => envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: '  ' })).toThrow(/HARNESS_CLIENT/);
    expect(envOrDefault('HARNESS_CLIENT', 'default', {})).toBe('default');
    expect(envOrDefault('HARNESS_CLIENT', 'default', { HARNESS_CLIENT: 'demo-practice' })).toBe('demo-practice');
  });

  it('refuses an empty HARNESS_PRINCIPAL rather than acting as the local service', () => {
    expect(() => envOrDefault('HARNESS_PRINCIPAL', 'svc-local', { HARNESS_PRINCIPAL: '' })).toThrow(
      /HARNESS_PRINCIPAL/,
    );
    expect(envOrDefault('HARNESS_PRINCIPAL', 'svc-local', {})).toBe('svc-local');
  });
});

describe('clientDirFor', () => {
  it('is the client folder under the repository root', () => {
    expect(clientDirFor('river-clinic', '/srv/agent-harness')).toBe('/srv/agent-harness/clients/river-clinic');
  });
});

/**
 * The principal is resolved through the identity plug-in and refused when the id is not
 * declared: a server that started as "somebody" would audit every call as somebody.
 */
describe('resolvePrincipal', () => {
  let dir: string;
  const saved = { ...process.env };
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'harness-server-identity-'));
    writeFileSync(
      path.join(dir, 'identity.yaml'),
      'principals:\n  - id: u-coordinator\n    kind: user\n    level: lead\n    displayName: Coordinator\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
    process.env.HARNESS_IDENTITY_FILE = path.join(dir, 'identity.yaml');
    delete process.env.HARNESS_IDENTITY;
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
  });

  it('resolves HARNESS_PRINCIPAL through the plug-in, defaulting to the local service', async () => {
    delete process.env.HARNESS_PRINCIPAL;
    expect((await resolvePrincipal({ client: 'smoke', env: process.env })).id).toBe('svc-local');
    process.env.HARNESS_PRINCIPAL = 'u-coordinator';
    expect((await resolvePrincipal({ client: 'smoke', env: process.env })).level).toBe('lead');
  });

  it('refuses an id the plug-in does not declare, naming it', async () => {
    process.env.HARNESS_PRINCIPAL = 'u-nobody';
    await expect(resolvePrincipal({ client: 'smoke', env: process.env })).rejects.toThrow(
      /HARNESS_PRINCIPAL names "u-nobody", which the identity plug-in "static" does not declare/,
    );
  });
});

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
