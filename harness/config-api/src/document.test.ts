import { describe, expect, it } from 'vitest';
import { ConfigError } from '@harness/shared';
import {
  CLIENT_DOCUMENT_VERSION,
  SecretRefShape,
  migrate,
  parseClientDocument,
  surfaceConversationsOf,
  surfaceNamesOf,
  surfaceSecretsOf,
  tenantKeysOf,
} from './document.js';
import { fixtureDocument } from './testing.js';

describe('SecretRefShape', () => {
  it('accepts an environment variable reference and a secret store reference', () => {
    expect(SecretRefShape.safeParse({ env: 'SLACK_BOT_TOKEN' }).success).toBe(true);
    expect(SecretRefShape.safeParse({ ref: 'web-token' }).success).toBe(true);
  });

  it('refuses neither key, both keys, an upper-case ref and a lower-case env', () => {
    expect(SecretRefShape.safeParse({}).success).toBe(false);
    expect(SecretRefShape.safeParse({ env: 'SLACK_BOT_TOKEN', ref: 'web-token' }).success).toBe(false);
    expect(SecretRefShape.safeParse({ ref: 'Web-Token' }).success).toBe(false);
    expect(SecretRefShape.safeParse({ env: 'slack_bot_token' }).success).toBe(false);
  });
});

describe('parseClientDocument', () => {
  it('accepts the fixture document and returns it parsed', () => {
    const document = parseClientDocument(fixtureDocument());
    expect(document.schemaVersion).toBe(CLIENT_DOCUMENT_VERSION);
    expect(document.id).toBe('fixture');
    expect(document.packs).toEqual(['@harness/pack-healthcare']);
    expect(document.runtime).toBe('scripted');
    // `identity` is today's `IdentityFileShape`: `{ principals }` and nothing else. Task 2 adds
    // `defaults` to that shape and asserts on it there, in the task that makes the field exist.
    expect(document.identity.principals).toHaveLength(4);
    // `defaults` arrives with this task: an absent `defaults:` is the empty table, which means
    // nobody the file does not declare gets a level, which is what today's behaviour is.
    expect(document.identity.defaults).toEqual({});
    expect(document.plugins).toEqual([]);
  });

  it('orders surfaces so the primary is never the run API', () => {
    const document = parseClientDocument(fixtureDocument());
    expect(surfaceNamesOf(document)).toEqual(['memory', 'http']);
    const withSlack = parseClientDocument(
      fixtureDocument({
        surfaces: {
          http: {},
          slack: {
            teamId: 'T001',
            signingSecret: { env: 'SLACK_SIGNING_SECRET' },
            botToken: { env: 'SLACK_BOT_TOKEN' },
            approvalsChannel: 'C0TEST',
          },
        },
      }),
    );
    // Declaration order in the file does not decide it; SURFACE_ORDER does.
    expect(surfaceNamesOf(withSlack)).toEqual(['slack', 'http']);
  });

  it('declares a web surface, primary by SURFACE_ORDER when present, with a store-backed token', () => {
    const withWeb = parseClientDocument(
      fixtureDocument({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {}, http: {} } }),
    );
    expect(surfaceNamesOf(withWeb)).toEqual(['web', 'memory', 'http']);
  });

  it('refuses a web surface with no token', () => {
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { web: {}, memory: {} } }))).toThrow(ConfigError);
  });

  it('refuses a document whose only surface is the run API, which cannot post an approval card', () => {
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { http: {} } }))).toThrow(ConfigError);
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { http: {} } }))).toThrow(
      /"http" cannot be a client's primary surface/,
    );
  });

  it('refuses a secret value where a SecretRef is expected', () => {
    const raw = fixtureDocument({
      surfaces: {
        memory: {},
        slack: {
          teamId: 'T001',
          signingSecret: 'xoxb-not-a-reference',
          botToken: { env: 'SLACK_BOT_TOKEN' },
          approvalsChannel: 'C0TEST',
        },
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(ConfigError);
    expect(() => parseClientDocument(raw)).toThrow(/signingSecret/);
  });

  it('refuses a SecretRef naming something that is not an environment variable', () => {
    const raw = fixtureDocument({
      surfaces: {
        memory: {},
        slack: {
          teamId: 'T001',
          signingSecret: { env: 'slack signing secret' },
          botToken: { env: 'SLACK_BOT_TOKEN' },
          approvalsChannel: 'C0TEST',
        },
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(/env/);
  });

  it('refuses a client id that is not a safe path segment and a safe Postgres value', () => {
    expect(() => parseClientDocument(fixtureDocument({ id: '../escape' }))).toThrow(ConfigError);
    expect(() => parseClientDocument(fixtureDocument({ id: 'Fixture' }))).toThrow(ConfigError);
  });

  it('applies the identity rules zod cannot say', () => {
    const raw = fixtureDocument({
      identity: {
        principals: [
          { id: 'u-one', kind: 'user', level: 'lead', displayName: 'One', surfaces: { memory: 'U1' } },
          { id: 'u-two', kind: 'user', level: 'lead', displayName: 'Two', surfaces: { memory: 'U1' } },
        ],
      },
    });
    expect(() => parseClientDocument(raw)).toThrow(/both claim user "U1" on surface "memory"/);
  });

  it('reserves plugins: an entry is refused until Plan 12 defines one', () => {
    expect(() => parseClientDocument(fixtureDocument({ plugins: [{ kind: 'mcp' }] }))).toThrow(ConfigError);
  });

  it('names the tenant keys a resolver matches, without the caller knowing a vendor field', () => {
    const withSlack = parseClientDocument(
      fixtureDocument({
        surfaces: {
          slack: {
            teamId: 'T0ABCDEF',
            signingSecret: { env: 'SLACK_SIGNING_SECRET' },
            botToken: { env: 'SLACK_BOT_TOKEN' },
            approvalsChannel: 'C0TEST',
          },
        },
      }),
    );
    expect(tenantKeysOf(withSlack)).toEqual([{ surface: 'slack', key: 'T0ABCDEF' }]);
    // A surface with nothing that identifies a workspace contributes no key.
    expect(tenantKeysOf(parseClientDocument(fixtureDocument()))).toEqual([]);
  });

  it('names the environment variables a surface refers to, so the host can check them by name', () => {
    const withSlack = parseClientDocument(
      fixtureDocument({
        surfaces: {
          memory: {},
          slack: {
            teamId: 'T0ABCDEF',
            signingSecret: { env: 'SLACK_SIGNING_SECRET' },
            botToken: { env: 'SLACK_BOT_TOKEN' },
            approvalsChannel: 'C0TEST',
          },
        },
      }),
    );
    expect(surfaceSecretsOf(withSlack)).toEqual([
      { surface: 'slack', field: 'signingSecret', env: 'SLACK_SIGNING_SECRET' },
      { surface: 'slack', field: 'botToken', env: 'SLACK_BOT_TOKEN' },
    ]);
    // A surface with no transport refers to no secret, so a document of them needs none set.
    expect(surfaceSecretsOf(parseClientDocument(fixtureDocument()))).toEqual([]);
  });

  it("names a web surface's token, as a store reference distinguishable from an environment one", () => {
    const withWeb = parseClientDocument(
      fixtureDocument({ surfaces: { web: { token: { ref: 'web-token' } }, memory: {}, http: {} } }),
    );
    expect(surfaceSecretsOf(withWeb)).toEqual([{ surface: 'web', field: 'token', ref: 'web-token' }]);
    // Its own id is its tenant key: a web tenant's workspace is itself, and the host routes a
    // request to it by the client id in the mount path.
    expect(tenantKeysOf(withWeb)).toEqual([{ surface: 'web', key: 'fixture' }]);
    // The inbox the schema defaults, and the one a document names instead. It travels to the
    // adapter the way the tenant key does: opaquely, through the host.
    expect(surfaceConversationsOf(withWeb)).toEqual([{ surface: 'web', conversation: 'inbox' }]);
    const named = parseClientDocument(
      fixtureDocument({ surfaces: { web: { token: { ref: 'web-token' }, inbox: 'reception' }, http: {} } }),
    );
    expect(surfaceConversationsOf(named)).toEqual([{ surface: 'web', conversation: 'reception' }]);
    // A document that declares no web surface names no conversation at all.
    expect(surfaceConversationsOf(parseClientDocument(fixtureDocument()))).toEqual([]);
  });

  it("names a slack surface's approvals channel, which used to be one variable for the whole deployment", () => {
    const slack = {
      teamId: 'T0ABCDEF',
      signingSecret: { env: 'SLACK_SIGNING_SECRET' },
      botToken: { env: 'SLACK_BOT_TOKEN' },
    };
    const withSlack = parseClientDocument(
      fixtureDocument({ surfaces: { slack: { ...slack, approvalsChannel: 'C0ALPHA' }, http: {} } }),
    );
    // Per client, so two tenants in one process send their cards to two workspaces. The host
    // copies it opaquely and never learns it is a channel.
    expect(surfaceConversationsOf(withSlack)).toEqual([{ surface: 'slack', conversation: 'C0ALPHA' }]);
    // Required when the section is declared: a tenant with no channel has nowhere to post, and a
    // deployment-wide fallback would be another tenant's workspace.
    expect(() => parseClientDocument(fixtureDocument({ surfaces: { slack, http: {} } }))).toThrow(ConfigError);
  });

  it("names a memory surface's workspace as a tenant key too, which is what a pooled test routes on", () => {
    const pooled = parseClientDocument(fixtureDocument({ surfaces: { memory: { workspace: 'W-ALPHA' }, http: {} } }));
    expect(tenantKeysOf(pooled)).toEqual([{ surface: 'memory', key: 'W-ALPHA' }]);
  });

  it('carries the identity defaults through, and refuses a level for the surface that cannot have one', () => {
    const principals = [
      { id: 'u-coordinator', kind: 'user', level: 'lead', displayName: 'Coordinator', surfaces: { memory: 'U012' } },
      { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Host' },
    ];
    const withDefaults = parseClientDocument(
      fixtureDocument({ identity: { principals, defaults: { memory: 'member' } } }),
    );
    expect(withDefaults.identity.defaults).toEqual({ memory: 'member' });
    // `http` is the run API: a caller there is a bearer token, not a person, so there is nobody
    // for a default level to be about.
    expect(() =>
      parseClientDocument(fixtureDocument({ identity: { principals, defaults: { http: 'member' } } })),
    ).toThrow(ConfigError);
  });
});

describe('migrate', () => {
  it('accepts schemaVersion 1, which is the only one there is', () => {
    expect(migrate(fixtureDocument()).id).toBe('fixture');
  });

  it('rejects schemaVersion 2 by name, because forward-only means there is nowhere to go', () => {
    expect(() => migrate(fixtureDocument({ schemaVersion: 2 }))).toThrow(ConfigError);
    expect(() => migrate(fixtureDocument({ schemaVersion: 2 }))).toThrow(
      /client document schemaVersion 2 is newer than this build, which knows 1/,
    );
  });

  it('rejects a document with no schemaVersion at all', () => {
    const raw = fixtureDocument();
    delete raw.schemaVersion;
    expect(() => migrate(raw)).toThrow(/schemaVersion/);
  });
});
