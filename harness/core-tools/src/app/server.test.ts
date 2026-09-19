import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, it, expect } from 'vitest';
import { ConfigError, envOrDefault } from '@harness/shared';
import { clientDirFor, resolvePrincipal } from './server.js';

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
  // Task 4 replaces this file read with the resolved client document's `identity` section; until
  // then `resolvePrincipal` reads `clients/<client>/identity.yaml` off disk, so this test writes
  // one into a scratch client folder rather than pointing a deleted `HARNESS_IDENTITY_FILE` at it.
  // `main.test.ts` writes the same `clients/smoke/` path for its own spawn tests; the two never
  // collide because `fileParallelism: false` (vitest.config.ts) runs test files one at a time.
  const dir = clientDirFor('smoke');
  const saved = { ...process.env };
  beforeEach(() => {
    // Never delete something this test did not create: refuse rather than overwrite a real folder.
    if (existsSync(dir)) throw new Error(`${dir} already exists; refusing to overwrite a real clients/smoke folder`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'identity.yaml'),
      'principals:\n  - id: u-coordinator\n    kind: user\n    level: lead\n    displayName: Coordinator\n  - id: svc-local\n    kind: service\n    level: service\n    displayName: Local\n',
    );
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
