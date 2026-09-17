import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import type { RunEvent } from '@harness/runtime-api';
import { toolServerFixture, type ToolServerFixture } from '@harness/runtime-api/testing';
import { bridgeTools, textOf } from './bridge.js';

let fixture: ToolServerFixture;
beforeEach(async () => {
  fixture = await toolServerFixture([
    {
      name: 'records_search',
      description: 'Search records',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
    },
    {
      name: 'forms_release',
      description: 'Release',
      inputSchema: { type: 'object', properties: { file_id: { type: 'string' } } },
      handler: () => ({ status: 'pending', approval_id: '11111111-1111-4111-8111-111111111111' }),
    },
    {
      name: 'explode',
      description: 'Fails',
      inputSchema: { type: 'object', properties: {} },
      handler: () => {
        throw new Error('Tool explode failed: boom');
      },
    },
  ]);
});
afterEach(() => fixture.close());

function sink(max = 10, signal: AbortSignal = new AbortController().signal) {
  const events: RunEvent[] = [];
  let exceeded = 0;
  return {
    events,
    exceeded: () => exceeded,
    sink: {
      emit: (e: RunEvent) => events.push(e),
      maxToolCalls: max,
      onBudgetExceeded: () => (exceeded += 1),
      signal,
    },
  };
}

describe('bridgeTools', () => {
  it('lists every kernel tool as a LangChain tool with its name, description and schema', async () => {
    const tools = await bridgeTools(fixture.client, sink().sink);
    expect(tools.map((t) => t.name).sort()).toEqual(['explode', 'forms_release', 'records_search']);
    expect(tools.find((t) => t.name === 'records_search')?.description).toBe('Search records');
  });

  it('invokes through the client, returns the envelope text to the model, and emits call and result', async () => {
    const { events, sink: s } = sink();
    const tools = await bridgeTools(fixture.client, s);
    const search = tools.find((t) => t.name === 'records_search')!;
    const out: unknown = await search.invoke({ query: 'ada' });
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    expect(JSON.parse(String(out))).toEqual({ status: 'ok', result: { hits: ['ada'] } });
    expect(events).toEqual([
      { type: 'tool_call', name: 'records_search', argsHash: hashArgs({ query: 'ada' }) },
      { type: 'tool_result', name: 'records_search', status: 'ok' },
    ]);
  });

  it('reports a parked call as pending and a failed call as error, both as plain text for the model', async () => {
    const { events, sink: s } = sink();
    const tools = await bridgeTools(fixture.client, s);
    const pending = String(await tools.find((t) => t.name === 'forms_release')!.invoke({ file_id: 'x' }));
    expect(JSON.parse(pending)).toMatchObject({ status: 'pending' });
    const failed = String(await tools.find((t) => t.name === 'explode')!.invoke({}));
    expect(failed).toBe('Tool explode failed: boom');
    expect(events.filter((e) => e.type === 'tool_result')).toEqual([
      { type: 'tool_result', name: 'forms_release', status: 'pending' },
      { type: 'tool_result', name: 'explode', status: 'error' },
    ]);
  });

  it('passes the run signal to the client, so an abort ends the call rather than waiting it out', async () => {
    const slow = await toolServerFixture([
      {
        name: 'slow_search',
        description: 'Takes its time',
        inputSchema: { type: 'object', properties: {} },
        handler: () => new Promise((resolve) => setTimeout(() => resolve({ status: 'ok' }), 5_000)),
      },
    ]);
    try {
      const controller = new AbortController();
      const { events, sink: s } = sink(10, controller.signal);
      const tools = await bridgeTools(slow.client, s);
      const started = Date.now();
      const call = tools.find((t) => t.name === 'slow_search')!.invoke({});
      setTimeout(() => controller.abort(), 50);
      await expect(call).rejects.toThrow();
      expect(Date.now() - started).toBeLessThan(2_000);
      // An abort is the run ending, not the tool reporting: the call was announced, and nothing
      // claims a result for it.
      expect(events).toEqual([{ type: 'tool_call', name: 'slow_search', argsHash: hashArgs({}) }]);
    } finally {
      await slow.close();
    }
  });

  it('stops calling the kernel once the tool budget is spent', async () => {
    const { events, exceeded, sink: s } = sink(1);
    const tools = await bridgeTools(fixture.client, s);
    const search = tools.find((t) => t.name === 'records_search')!;
    await search.invoke({ query: 'one' });
    const refused = String(await search.invoke({ query: 'two' }));
    expect(fixture.calls).toHaveLength(1);
    expect(refused).toContain('budget');
    expect(exceeded()).toBe(1);
    expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
  });
});

describe('textOf', () => {
  it('joins every text block', () => {
    expect(
      textOf({
        content: [
          { type: 'text', text: 'a' },
          { type: 'text', text: 'b' },
        ],
      }),
    ).toBe('a\nb');
    expect(textOf({})).toBe('');
  });
});
