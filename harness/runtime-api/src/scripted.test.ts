import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import { ScriptedRuntime, parseTrajectory, readTrajectory, scriptedRuntime, type TrajectoryStep } from './scripted.js';
import { RECORDS_SEARCH, fixtureRequest, toolServerFixture, type ToolServerFixture } from './tool-server.js';
import { collectRunEvents, runtimeConformance } from './conformance.js';

let fixture: ToolServerFixture;
beforeEach(async () => {
  fixture = await toolServerFixture([
    RECORDS_SEARCH,
    {
      name: 'forms_release',
      description: 'release',
      inputSchema: { type: 'object', properties: { file_id: { type: 'string' } } },
      handler: () => ({ status: 'pending', approval_id: '11111111-1111-4111-8111-111111111111' }),
    },
    {
      name: 'slow_search',
      description: 'a tool call slow enough to abort mid-flight',
      inputSchema: { type: 'object', properties: {} },
      handler: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok' }), 10_000)),
    },
  ]);
});
afterEach(() => fixture.close());

describe('ScriptedRuntime', () => {
  it('replays tool steps through request.tools and says the final text', async () => {
    const runtime = new ScriptedRuntime([{ tool: 'records_search', args: { query: 'ada' } }, { say: 'Found one.' }]);
    const events = await collectRunEvents(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    expect(events).toEqual([
      { type: 'tool_call', name: 'records_search', argsHash: hashArgs({ query: 'ada' }) },
      { type: 'tool_result', name: 'records_search', status: 'ok' },
      { type: 'text', delta: 'Found one.' },
      { type: 'done', text: 'Found one.' },
    ]);
    expect(runtime.requests).toHaveLength(1);
  });

  it('reports a parked tool as pending and a skill activation before the tool it causes', async () => {
    const runtime = new ScriptedRuntime([
      { skill: 'credentialing-roster', version: '1.0.0' },
      { tool: 'forms_release', args: { file_id: 'roster/x.csv' } },
      { say: 'Waiting for approval.' },
    ]);
    const events = await collectRunEvents(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(events.map((e) => e.type)).toEqual(['skill_activated', 'tool_call', 'tool_result', 'text', 'done']);
    expect(events[2]).toEqual({ type: 'tool_result', name: 'forms_release', status: 'pending' });
  });

  it('reports a tool the server does not have as an error result and keeps going', async () => {
    const runtime = new ScriptedRuntime([{ tool: 'no_such_tool', args: {} }, { say: 'x' }]);
    const events = await collectRunEvents(runtime.run(fixtureRequest({ tools: fixture.client })).events);
    expect(events[1]).toEqual({ type: 'tool_result', name: 'no_such_tool', status: 'error' });
    expect(events.at(-1)).toEqual({ type: 'done', text: 'x' });
  });

  it('ends with error "cancelled" when the signal aborts during a sleep, and says nothing more', async () => {
    const runtime = new ScriptedRuntime([{ sleep: 10_000 }, { say: 'never' }]);
    const controller = new AbortController();
    const handle = runtime.run(fixtureRequest({ tools: fixture.client, signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    expect(await collectRunEvents(handle.events)).toEqual([{ type: 'error', message: 'cancelled' }]);
  });

  it('ends with error "cancelled" when the signal aborts during a tool call, with no tool_result', async () => {
    const runtime = new ScriptedRuntime([{ tool: 'slow_search', args: {} }, { say: 'never' }]);
    const controller = new AbortController();
    const handle = runtime.run(fixtureRequest({ tools: fixture.client, signal: controller.signal }));
    setTimeout(() => controller.abort(), 10);
    const events = await collectRunEvents(handle.events);
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([]);
    const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toEqual([{ type: 'error', message: 'cancelled' }]);
    expect(events.at(-1)).toBe(terminal[0]);
  });

  it('takes a trajectory chosen per request', async () => {
    const runtime = new ScriptedRuntime((request) => [{ say: `echo: ${request.input.text}` }]);
    const events = await collectRunEvents(
      runtime.run(fixtureRequest({ tools: fixture.client, input: { text: 'hi', attachments: [] } })).events,
    );
    expect(events.at(-1)).toEqual({ type: 'done', text: 'echo: hi' });
  });
});

describe('trajectory files', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'harness-trajectory-'));
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('parses the four step shapes and refuses anything else', async () => {
    const file = path.join(dir, 't.json');
    await writeFile(
      file,
      JSON.stringify([{ tool: 'a', args: {} }, { say: 'b' }, { skill: 'c', version: '1' }, { sleep: 5 }]),
    );
    expect(await readTrajectory(file)).toHaveLength(4);
    expect(() => parseTrajectory([{ shout: 'x' }])).toThrow(/trajectory/);
  });

  it('is a Runtime the host can load and connect', async () => {
    const runtime = scriptedRuntime([{ say: 'hello' }]);
    expect(runtime.name).toBe('scripted');
    const session = await runtime.connect({
      env: {},
      log: { info() {}, warn() {}, error() {} },
      databaseUrl: '',
      storageDir: dir,
    });
    expect(session).toBeInstanceOf(ScriptedRuntime);
  });
});

let steps: TrajectoryStep[] = [];

runtimeConformance('scripted', {
  connect: async () => new ScriptedRuntime(() => steps),
  script: (s) => {
    steps = [
      ...(s.skill ? [{ skill: s.skill.name, version: s.skill.version } as const] : []),
      { tool: s.toolCall.name, args: s.toolCall.args },
      { say: s.finalText },
    ];
  },
  hang: () => {
    steps = [{ sleep: 60_000 }, { say: 'never' }];
  },
  skills: [{ name: 'credentialing-roster', version: '1.0.0', description: 'roster', dir: '/nonexistent' }],
});
