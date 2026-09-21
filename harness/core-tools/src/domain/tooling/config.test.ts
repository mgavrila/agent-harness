import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { pack as healthcarePack } from '@harness/pack-healthcare';
import { pack as storiesPack } from '@harness/pack-stories';
import { registryOf } from '../packs/registry.js';
import { buildKernelConfig, formsDirFrom, parserFromEnv } from './config.js';

const env = {
  HARNESS_STORAGE_DIR: '/tmp/harness-config-test',
  HARNESS_ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'),
  LITELLM_MASTER_KEY: 'sk-test',
};

describe('buildKernelConfig', () => {
  it('takes the client id, the policy, the packs and the knowledge directory from the document', async () => {
    const document = parseClientDocument(
      fixtureDocument({
        id: 'alpha',
        displayName: 'Alpha',
        policy: { classes: { external: 'blocked' }, tools: { hide: ['documents_read'] } },
        knowledge: { source: 'dir', path: '/srv/tenants/alpha/knowledge' },
      }),
    );
    const config = await buildKernelConfig(document, env, { surfaces: {} });
    expect(config.client).toBe('alpha');
    expect(config.policy.classes.external).toBe('blocked');
    // Merged over the kernel's own matrix, not replacing it.
    expect(config.policy.classes.read).toBe('auto');
    expect(config.hiddenTools).toEqual(['documents_read']);
    expect(config.knowledgeDir).toBe('/srv/tenants/alpha/knowledge');
    expect(config.packs.all.map((pack) => pack.name)).toEqual(['healthcare']);
  });

  it('serves no pack for a document that names none, which used to need an empty variable', async () => {
    const config = await buildKernelConfig(parseClientDocument(fixtureDocument({ packs: [] })), env, { surfaces: {} });
    expect(config.packs.all).toEqual([]);
    expect(config.hiddenTools).toEqual([]);
  });

  it('has no knowledge directory for a document whose knowledge lives in the store', async () => {
    const config = await buildKernelConfig(parseClientDocument(fixtureDocument()), env, { surfaces: {} });
    expect(config.knowledgeDir).toBeNull();
  });

  it('reads the storage root, the key and the gateway from the map it was given, not the ambient one', async () => {
    const config = await buildKernelConfig(
      parseClientDocument(fixtureDocument()),
      {
        ...env,
        HARNESS_STORAGE_DIR: '/tmp/harness-somewhere-else',
        HARNESS_GATEWAY_URL: 'http://127.0.0.1:9999',
      },
      { surfaces: {} },
    );
    expect(config.storageDir).toBe('/tmp/harness-somewhere-else');
    expect(config.gateway.baseUrl).toBe('http://127.0.0.1:9999');
    expect(config.encryptionKey).toHaveLength(32);
  });

  it('fails on a map with no storage root and on one with no gateway key, naming each', async () => {
    const { HARNESS_STORAGE_DIR: _dir, ...noStorage } = env;
    await expect(
      buildKernelConfig(parseClientDocument(fixtureDocument()), noStorage, { surfaces: {} }),
    ).rejects.toThrow(/HARNESS_STORAGE_DIR/);
    const { LITELLM_MASTER_KEY: _key, ...noGateway } = env;
    await expect(
      buildKernelConfig(parseClientDocument(fixtureDocument()), noGateway, { surfaces: {} }),
    ).rejects.toThrow(ConfigError);
  });

  it("sends this tenant's own gateway key when its document named one, and the process key when it did not", async () => {
    const document = parseClientDocument(fixtureDocument());
    expect((await buildKernelConfig(document, env, { surfaces: {} })).gateway.apiKey).toBe(env.LITELLM_MASTER_KEY);
    const own = await buildKernelConfig(document, env, { surfaces: {}, gatewayKey: 'sk-tenant-alpha' });
    expect(own.gateway.apiKey).toBe('sk-tenant-alpha');
    // And nothing else about the gateway moves: the URL, the timeout and the per-run breaker are
    // the deployment's, whoever the tenant is.
    expect(own.gateway.baseUrl).toBe((await buildKernelConfig(document, env, { surfaces: {} })).gateway.baseUrl);
    expect(own.gateway.maxCallsPerRun).toBe(
      (await buildKernelConfig(document, env, { surfaces: {} })).gateway.maxCallsPerRun,
    );
  });
});

/**
 * The forms directory belongs to the pack. `HARNESS_FORMS_DIR` is an override a deployment
 * opts into, not a value it has to set, so a client whose document swaps its `packs` list gets
 * the new pack's templates without editing a variable.
 */
describe('formsDirFrom', () => {
  const healthcare = registryOf([healthcarePack]);

  it('takes the primary pack’s templates directory when HARNESS_FORMS_DIR is unset, and the override when it is set', () => {
    expect(formsDirFrom(healthcare, undefined, '/srv/storage')).toBe(healthcarePack.formsDir);
    expect(formsDirFrom(healthcare, '/srv/elsewhere/forms', '/srv/storage')).toBe('/srv/elsewhere/forms');
    expect(formsDirFrom(healthcare, './forms', '/srv/storage')).toBe(path.resolve('./forms'));
  });

  it('stands the storage directory in when the primary pack ships no templates, and when there is no pack', () => {
    // `formsDir` is optional on the pack contract and the stories pack declares none, which used
    // to fail startup for a document naming that pack alone. Nothing reads the value in either
    // deployment: the forms tools belong to a pack that ships templates.
    expect(storiesPack.formsDir).toBeUndefined();
    expect(formsDirFrom(registryOf([storiesPack]), undefined, '/srv/storage')).toBe('/srv/storage');
    expect(formsDirFrom(registryOf([]), undefined, '/srv/storage')).toBe('/srv/storage');
    expect(formsDirFrom(registryOf([]), '/srv/elsewhere/forms', '/srv/storage')).toBe('/srv/elsewhere/forms');
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
