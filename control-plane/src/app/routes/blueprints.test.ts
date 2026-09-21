import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testApp, type TestApp } from '../../testing/app.js';

let t: TestApp;
beforeAll(async () => {
  t = await testApp();
});
afterAll(() => t.close());

describe('blueprints', () => {
  it('lists the catalogue and describes one blueprint with its schema and lock set', async () => {
    const { cookie } = await t.sessionFor({ sub: 'u', email: 'u@example.com', name: 'U' });
    const list = (await (await t.app.request('/api/v1/blueprints', { headers: { cookie } })).json()) as {
      name: string;
    }[];
    expect(list.map((b) => b.name)).toEqual(['fixture-agent']);
    const one = (await (await t.app.request('/api/v1/blueprints/fixture-agent', { headers: { cookie } })).json()) as {
      lockset: string[];
      schema: { properties: object };
      inputs: { pointer: string }[];
    };
    expect(one.lockset).toEqual(['/routing']);
    expect(Object.keys(one.schema.properties)).toContain('policy');
    expect(one.inputs[0]?.pointer).toBe('/playbooks/playbooks/0/timezone');
    expect((await t.app.request('/api/v1/blueprints/nope', { headers: { cookie } })).status).toBe(404);
    expect((await t.app.request('/api/v1/blueprints')).status).toBe(401);
  });
});
