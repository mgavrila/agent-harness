import { describe, expect, it } from 'vitest';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { ConfigError } from '@harness/shared';
import { poolFixture, useTestDb } from '../../testing.js';

const db = useTestDb();

/** The memory surface and nothing else, for the reason given at the top of `pool.test.ts`. */
const doc = (id: string) =>
  parseClientDocument(fixtureDocument({ id, displayName: id, runtime: 'scripted', surfaces: { memory: {} } }));

describe('the two per-run model-call limits', () => {
  it('refuses to open a tenant whose runtime budget reaches the gateway breaker', async () => {
    // Every call the conversation makes is a `model_calls` row on the run, and the breaker in
    // `callModel` counts every row. An operator who raises the budget past the breaker gets the
    // kernel's tools refused partway through a turn, told only that the run is at its limit —
    // so the two limits are checked against each other once, where both are known, at startup.
    await expect(
      poolFixture(db, { documents: [doc('alpha')], env: { HARNESS_RUN_MAX_MODEL_CALLS: '200' } }),
    ).rejects.toThrow(ConfigError);
    await expect(
      poolFixture(db, { documents: [doc('alpha')], env: { HARNESS_RUN_MAX_MODEL_CALLS: '200' } }),
    ).rejects.toThrow(
      'client "alpha": HARNESS_RUN_MAX_MODEL_CALLS (200) must be less than HARNESS_GATEWAY_MAX_CALLS_PER_RUN (100)',
    );
  });

  it('refuses them equal too, because the last budgeted call is the one the breaker refuses', async () => {
    await expect(
      poolFixture(db, {
        documents: [doc('alpha')],
        env: { HARNESS_RUN_MAX_MODEL_CALLS: '40', HARNESS_GATEWAY_MAX_CALLS_PER_RUN: '40' },
      }),
    ).rejects.toThrow('HARNESS_RUN_MAX_MODEL_CALLS (40) must be less than HARNESS_GATEWAY_MAX_CALLS_PER_RUN (40)');
  });

  it('opens on the shipped defaults, and on a raised pair that keeps the ordering', async () => {
    const defaults = await poolFixture(db, { documents: [doc('alpha')] });
    expect(defaults.tenant('alpha').host.budget.maxModelCalls).toBe(30);
    await defaults.close();

    const raised = await poolFixture(db, {
      documents: [doc('alpha')],
      env: { HARNESS_RUN_MAX_MODEL_CALLS: '200', HARNESS_GATEWAY_MAX_CALLS_PER_RUN: '500' },
    });
    expect(raised.tenant('alpha').host.budget.maxModelCalls).toBe(200);
    await raised.close();
  });
});

describe('resolving a tenant’s secrets', () => {
  it('refuses a client whose document names a secret this deployment has no secret source for', async () => {
    const withRef = parseClientDocument(
      fixtureDocument({
        id: 'alpha',
        displayName: 'alpha',
        runtime: 'scripted',
        surfaces: {
          slack: { teamId: 'T001', signingSecret: { ref: 'slack-signing' }, botToken: { env: 'SLACK_BOT_TOKEN' } },
        },
      }),
    );
    // No other document to open, so the pool's own start-up failure wraps this one, and carries
    // it in full: the assertion below reads it out of that wrapper.
    await expect(poolFixture(db, { documents: [withRef] })).rejects.toThrow(
      'client "alpha" names the secret "slack-signing" for slack.signingSecret, and this deployment has no secret source',
    );
  });
});
