import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { hashArgs } from '@harness/shared';
import type { RunEvent, RunRequest } from '@harness/runtime-api';
import {
  fixtureRequest,
  startFakeGateway,
  toolServerFixture,
  type FakeGateway,
  type FakeReply,
  type ToolServerFixture,
} from '@harness/runtime-api/testing';
import { EventQueue } from './events.js';
import { runDeepAgent } from './run.js';

let gateway: FakeGateway;
let fixture: ToolServerFixture;
let skillsDir: string;
const log = { info() {}, warn() {}, error() {} };

beforeEach(async () => {
  gateway = await startFakeGateway();
  fixture = await toolServerFixture([
    {
      name: 'records_search',
      description: 'search',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: ({ query }) => ({ status: 'ok', result: { hits: [String(query)] } }),
    },
  ]);
  skillsDir = await mkdtemp(path.join(tmpdir(), 'harness-run-skills-'));
  await mkdir(path.join(skillsDir, 'credentialing-intake'));
  await writeFile(
    path.join(skillsDir, 'credentialing-intake', 'SKILL.md'),
    '---\nname: credentialing-intake\ndescription: Take documents into the record store.\n---\n# Intake\nCall records_search first.\n',
  );
});
afterEach(async () => {
  await gateway.close();
  await fixture.close();
  await rm(skillsDir, { recursive: true, force: true });
});

/**
 * The text of one wire message. The system message arrives as content blocks, not a string: the
 * agent's own prompt is the first block and the framework's skills and memory guidance follow it.
 */
function textOf(message: { content: unknown } | undefined): string {
  const content = message?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as { text?: unknown }[]).map((b) => (typeof b.text === 'string' ? b.text : '')).join('\n');
}

/** A responder that answers the n-th model call with the n-th reply and repeats the last one. */
function script(replies: FakeReply[]): void {
  let turn = 0;
  gateway.setResponder(() => {
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    return reply;
  });
}

function request(over: Partial<RunRequest> = {}): RunRequest {
  return fixtureRequest({
    tools: fixture.client,
    model: { baseUrl: gateway.url, apiKey: 'sk-test', route: 'chat', user: 'u-coordinator' },
    skills: [
      {
        name: 'credentialing-intake',
        version: '1.0.0',
        description: 'intake',
        dir: path.join(skillsDir, 'credentialing-intake'),
      },
    ],
    ...over,
  });
}

async function run(req: RunRequest, checkpointer = new MemorySaver()): Promise<RunEvent[]> {
  const queue = new EventQueue<RunEvent>();
  const finished = runDeepAgent(req, { checkpointer, log }, queue);
  const events: RunEvent[] = [];
  for await (const e of queue) events.push(e);
  await finished;
  return events;
}

describe('runDeepAgent', () => {
  it('reads a skill, calls a kernel tool, streams the answer and finishes with done', async () => {
    script([
      { toolCalls: [{ name: 'read_file', arguments: { file_path: '/skills/credentialing-intake/SKILL.md' } }] },
      { toolCalls: [{ name: 'records_search', arguments: { query: 'ada' } }] },
      { content: 'All filed.', inputTokens: 20, outputTokens: 4 },
    ]);
    const events = await run(request());
    expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
    const types = events.map((e) => e.type);
    expect(types.indexOf('skill_activated')).toBeLessThan(types.indexOf('tool_call'));
    expect(events).toContainEqual({ type: 'skill_activated', name: 'credentialing-intake', version: '1.0.0' });
    expect(events).toContainEqual({
      type: 'tool_call',
      name: 'records_search',
      argsHash: hashArgs({ query: 'ada' }),
    });
    expect(events).toContainEqual({ type: 'tool_result', name: 'records_search', status: 'ok' });
    expect(
      events
        .filter((e) => e.type === 'text')
        .map((e) => (e as { delta: string }).delta)
        .join(''),
    ).toBe('All filed.');
    expect(events.filter((e) => e.type === 'usage')).toHaveLength(3);
    expect(events.at(-1)).toEqual({ type: 'done', text: 'All filed.' });
    // Every model request carried the principal and offered the kernel tool and the four read-only file tools only.
    expect(gateway.calls).toHaveLength(3);
    for (const call of gateway.calls) {
      expect(call.user).toBe('u-coordinator');
      expect(call.tools.sort()).toEqual(['glob', 'grep', 'ls', 'read_file', 'records_search']);
      expect(call.authorization).toBe('Bearer sk-test');
    }
    // The persona and the kernel rules are the system prompt.
    const system = textOf(gateway.calls[0].messages.find((m) => m.role === 'system'));
    expect(system).toContain('You are the test assistant.');
    expect(system).toContain('/skills/');
  });

  it('seeds history when the thread has no checkpoint yet, and not when it has', async () => {
    script([{ content: 'ok' }]);
    const checkpointer = new MemorySaver();
    await run(
      request({
        history: [
          { role: 'user', content: 'earlier question' },
          { role: 'assistant', content: 'earlier answer' },
          { role: 'host', content: 'Approval x was approved.' },
        ],
      }),
      checkpointer,
    );
    const first = gateway.calls[0].messages.map((m) => `${m.role}:${String(m.content)}`);
    expect(first).toContain('user:earlier question');
    expect(first).toContain('assistant:earlier answer');
    expect(first.some((m) => m.startsWith('user:') && m.includes('Approval x was approved.'))).toBe(true);
    await run(
      request({
        input: { text: 'second turn', attachments: [] },
        history: [{ role: 'user', content: 'must not appear twice' }],
      }),
      checkpointer,
    );
    const second = gateway.calls[1].messages.map((m) => String(m.content));
    expect(second.filter((c) => c === 'earlier question')).toHaveLength(1);
    expect(second).not.toContain('must not appear twice');
    expect(second).toContain('second turn');
  });

  it('ends with error "cancelled" and no done when the signal aborts mid-run', async () => {
    gateway.setResponder(() => new Promise<never>(() => {}));
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 50);
    const events = await run(request({ signal: controller.signal }));
    expect(events).toEqual([{ type: 'error', message: 'cancelled' }]);
    expect(gateway.calls).toHaveLength(1);
  });

  it('stops within one call of the model-call budget', async () => {
    script([{ toolCalls: [{ name: 'records_search', arguments: { query: 'again' } }] }]);
    const events = await run(request({ budget: { maxModelCalls: 3, maxToolCalls: 100, timeoutMs: 30_000 } }));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run exceeded its budget' });
    expect(gateway.calls.length).toBeLessThanOrEqual(4);
  });

  it('stops when the tool-call budget is spent', async () => {
    script([{ toolCalls: [{ name: 'records_search', arguments: { query: 'again' } }] }]);
    const events = await run(request({ budget: { maxModelCalls: 100, maxToolCalls: 2, timeoutMs: 30_000 } }));
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run exceeded its budget' });
    expect(fixture.calls).toHaveLength(2);
  });

  it('turns a gateway failure into the fixed error message and logs the detail', async () => {
    gateway.setResponder(() => ({ status: 503, errorBody: { error: { message: 'secret prompt text' } } }));
    const logged: string[] = [];
    const queue = new EventQueue<RunEvent>();
    const finished = runDeepAgent(
      request(),
      { checkpointer: new MemorySaver(), log: { ...log, error: (m: string) => logged.push(m) } },
      queue,
    );
    const events: RunEvent[] = [];
    for await (const e of queue) events.push(e);
    await finished;
    expect(events.at(-1)).toEqual({ type: 'error', message: 'the run failed; see the host log' });
    expect(JSON.stringify(events)).not.toContain('secret prompt text');
    expect(logged.length).toBeGreaterThan(0);
  });

  it('lists an attachment in the human message', async () => {
    script([{ content: 'ok' }]);
    await run(request({ input: { text: 'File this.', attachments: [{ name: 'w9.pdf', path: 'w9.pdf' }] } }));
    const human = gateway.calls[0].messages.find((m) => m.role === 'user');
    expect(textOf(human)).toContain('incoming/w9.pdf');
  });
});
