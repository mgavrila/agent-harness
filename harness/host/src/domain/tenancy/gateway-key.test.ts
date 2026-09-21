import { describe, expect, it, onTestFinished } from 'vitest';
import { parseClientDocument, type ClientDocument } from '@harness/config-api';
import { MemorySecretSource, fixtureDocument } from '@harness/config-api/testing';
import { callModel, depsForRun, openRun } from '@harness/core-tools';
import { modelCalls } from '@harness/db';
import { startFakeGateway } from '@harness/runtime-api/testing';
import { HOST_PRINCIPAL, poolFixture, useTestDb } from '../../testing.js';

const db = useTestDb();

/**
 * A tenant whose document names its own gateway key, or leaves the process key standing.
 *
 * Its `chat` deployment is named the way the platform registers one on a pooled host —
 * `<clientId>/<vendor>/<model>` — so two tenants here name two different deployments and a call
 * that carried the route name instead would be visible.
 */
const tenant = (id: string, key?: string): ClientDocument =>
  parseClientDocument(
    fixtureDocument({
      id,
      displayName: id,
      runtime: 'scripted',
      surfaces: { memory: { workspace: id } },
      routing: {
        routes: {
          chat: { model: `${id}/gemini/gemini-3-flash-preview` },
          extract: { model: 'gemini/gemini-3-flash-preview' },
          reason: { model: 'gemini/gemini-3-flash-preview' },
          judge: { model: 'groq/openai/gpt-oss-120b' },
          embed: { model: 'gemini/gemini-embedding-001' },
        },
        ...(key === undefined ? {} : { gateway: { key: { ref: key } } }),
      },
    }),
  );

describe('a per-tenant gateway key', () => {
  it('sends each tenant its own bearer and its own deployment, never the other’s (invariant 22)', async () => {
    // The shipped fake gateway, on a real loopback socket: the real `httpGateway` reaches it over
    // a real connection and it records the `authorization` header of every call, which is what
    // makes this a test of the credential that actually went out rather than of the config that
    // was built.
    const gateway = await startFakeGateway();
    onTestFinished(() => gateway.close());
    const secrets = new MemorySecretSource();
    secrets.put('alpha', 'alpha-key', 'sk-tenant-alpha');
    secrets.put('beta', 'beta-key', 'sk-tenant-beta');
    const f = await poolFixture(db, {
      documents: [tenant('alpha', 'alpha-key'), tenant('beta', 'beta-key')],
      secrets,
      env: { HARNESS_GATEWAY_URL: gateway.url },
    });
    onTestFinished(() => f.close());

    // A turn under the scripted runtime makes no model call — that is what makes it scriptable —
    // so the call is made the way a tool makes one: on that tenant's own run deps, built from
    // that tenant's own `KernelConfig` (plan decision 12).
    for (const clientId of ['alpha', 'beta']) {
      const host = f.tenant(clientId).host;
      const context = await openRun(db, { client: clientId, principal: HOST_PRINCIPAL });
      const deps = depsForRun(host.config, { db, principal: HOST_PRINCIPAL, context });
      await callModel(deps, { route: 'chat', messages: [{ role: 'user', content: 'hello' }] });
    }

    expect(gateway.calls.map((call) => call.authorization)).toEqual([
      'Bearer sk-tenant-alpha',
      'Bearer sk-tenant-beta',
    ]);
    // And each call named that tenant's own deployment. On a pooled host this is the second half
    // of the boundary: one key, one deployment, one tenant. A route name here would have sent
    // both tenants to whatever `chat` happened to mean on the proxy.
    expect(gateway.calls.map((call) => call.model)).toEqual([
      'alpha/gemini/gemini-3-flash-preview',
      'beta/gemini/gemini-3-flash-preview',
    ]);
    // And the attribution is unchanged: one row per call, each naming its own tenant, the route
    // it asked for and the deployment it sent. The tenant is in the key *and* in the row, which
    // is what makes a budget and an evaluation record agree about whose call it was.
    const rows = await db.select().from(modelCalls);
    expect(rows.map((row) => `${row.client}:${row.route}:${row.model}`).sort()).toEqual([
      'alpha:chat:alpha/gemini/gemini-3-flash-preview',
      'beta:chat:beta/gemini/gemini-3-flash-preview',
    ]);
  });

  it('falls back to the process key for a tenant whose document names none', async () => {
    const gateway = await startFakeGateway();
    onTestFinished(() => gateway.close());
    const f = await poolFixture(db, {
      documents: [tenant('alpha')],
      env: { HARNESS_GATEWAY_URL: gateway.url, LITELLM_MASTER_KEY: 'sk-process' },
    });
    onTestFinished(() => f.close());
    const host = f.tenant('alpha').host;
    const context = await openRun(db, { client: 'alpha', principal: HOST_PRINCIPAL });
    await callModel(depsForRun(host.config, { db, principal: HOST_PRINCIPAL, context }), {
      route: 'chat',
      messages: [{ role: 'user', content: 'hello' }],
    });
    expect(gateway.calls.map((call) => call.authorization)).toEqual(['Bearer sk-process']);
  });
});
