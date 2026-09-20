import { describe, it, expect } from 'vitest';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { ConfigError, createLogger, envOrDefault } from '@harness/shared';
import { loadClientDocument } from '../domain/config/registry.js';
import { resolvePrincipal } from './server.js';

const log = createLogger('server-test');
/** Never reached: every case below fails before a source is built. */
const db = null as never;

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

/**
 * There is no default client. A server that started as "default" would open runs, write audit
 * rows and answer tools under a client id nobody configured, and the rows would be indexed under
 * it forever.
 */
describe('loadClientDocument', () => {
  it('refuses a HARNESS_CLIENT that is unset, and one that is set but empty', async () => {
    await expect(loadClientDocument({ env: {}, log, db })).rejects.toThrow(/HARNESS_CLIENT/);
    await expect(loadClientDocument({ env: { HARNESS_CLIENT: '' }, log, db })).rejects.toThrow(ConfigError);
    await expect(loadClientDocument({ env: { HARNESS_CLIENT: '  ' }, log, db })).rejects.toThrow(/HARNESS_CLIENT/);
  });

  it('refuses a client before it builds a source, so an unnamed client never opens a connection', async () => {
    // `HARNESS_CONFIG_SOURCE` is unset in all three cases above and in this one, and the failure
    // still names the client: the id is checked first, deliberately.
    await expect(loadClientDocument({ env: { HARNESS_CONFIG_SOURCE: 'postgres' }, log, db })).rejects.toThrow(
      /HARNESS_CLIENT/,
    );
  });
});

/**
 * The principal is resolved through the identity plug-in the document names, and refused when
 * the id is not declared: a server that started as "somebody" would audit every call as somebody.
 */
describe('resolvePrincipal', () => {
  // The document's own `identity` section, handed to the plug-in already parsed. Nothing here
  // reads a file, and nothing derives a path from where this code lives.
  const document = parseClientDocument(fixtureDocument());

  it('resolves HARNESS_PRINCIPAL through the plug-in', async () => {
    expect((await resolvePrincipal(document, { HARNESS_PRINCIPAL: 'svc-host' })).id).toBe('svc-host');
    expect((await resolvePrincipal(document, { HARNESS_PRINCIPAL: 'u-coordinator' })).level).toBe('lead');
  });

  it('refuses an id the plug-in does not declare, naming it', async () => {
    await expect(resolvePrincipal(document, { HARNESS_PRINCIPAL: 'u-nobody' })).rejects.toThrow(
      /HARNESS_PRINCIPAL names "u-nobody", which the identity plug-in "static" does not declare/,
    );
  });

  it('falls back to svc-local, which a document has to declare like any other principal', async () => {
    // The default is an id, not a licence: a document that does not declare `svc-local` refuses
    // the same way an undeclared `HARNESS_PRINCIPAL` does.
    await expect(resolvePrincipal(document, {})).rejects.toThrow(/svc-local/);
    const withLocal = parseClientDocument(
      fixtureDocument({
        identity: {
          principals: [{ id: 'svc-local', kind: 'service', level: 'service', displayName: 'Local' }],
        },
      }),
    );
    expect((await resolvePrincipal(withLocal, {})).id).toBe('svc-local');
  });

  it('loads the plug-in the document names, deriving the specifier from its kind', async () => {
    // `identityPlugin.kind` is a name, never a package specifier: no kernel source writes one out.
    const missing = parseClientDocument(fixtureDocument({ identityPlugin: { kind: 'nowhere' } }));
    await expect(resolvePrincipal(missing, {})).rejects.toThrow(/@harness\/identity-nowhere/);
  });
});
