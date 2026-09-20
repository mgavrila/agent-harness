import { afterEach, describe, expect, it } from 'vitest';
import {
  collectRunEvents,
  fixtureRequest,
  toolServerFixture,
  type ToolServerFixture,
} from '@harness/runtime-api/testing';
import { runtime, scriptedTrajectories } from './index.js';

const deps = (clientId?: string) => ({
  env: clientId === undefined ? {} : { HARNESS_CLIENT: clientId },
  log: { info() {}, warn() {}, error() {} },
  databaseUrl: '',
  storageDir: '/nonexistent',
});

let tools: ToolServerFixture;
afterEach(async () => {
  scriptedTrajectories.clear();
  await tools.close();
});

describe('the scripted runtime plug-in', () => {
  it('plays back the trajectory filed under the client the host named', async () => {
    scriptedTrajectories.set('alpha', [{ say: 'Alpha speaking.' }]);
    scriptedTrajectories.set('beta', [{ say: 'Beta speaking.' }]);
    tools = await toolServerFixture([]);

    const session = await runtime.connect(deps('alpha'));
    const events = await collectRunEvents(session.run(fixtureRequest({ tools: tools.client })).events);

    expect(events.at(-1)).toEqual({ type: 'done', text: 'Alpha speaking.' });
    await session.stop();
  });

  it('says nothing for a client no test filed a trajectory under', async () => {
    tools = await toolServerFixture([]);

    const session = await runtime.connect(deps('nobody'));
    const events = await collectRunEvents(session.run(fixtureRequest({ tools: tools.client })).events);

    // One `done` and nothing before it: a tenant the test did not script is a tenant whose
    // runtime answers immediately with no text, not one whose runtime fails.
    expect(events).toEqual([{ type: 'done', text: '' }]);
    await session.stop();
  });
});
