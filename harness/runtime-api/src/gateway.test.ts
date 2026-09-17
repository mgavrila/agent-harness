import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { startFakeGateway, type FakeGateway } from './gateway.js';

let gateway: FakeGateway;
beforeEach(async () => {
  gateway = await startFakeGateway();
});
afterEach(async () => {
  await gateway.close();
});

const post = (body: Record<string, unknown>) =>
  fetch(`${gateway.url}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
    body: JSON.stringify({ model: 'chat', messages: [{ role: 'user', content: 'hi' }], ...body }),
  });

describe('startFakeGateway', () => {
  it('records the user field, the tool names and whether streaming was asked for', async () => {
    gateway.setResponder(() => ({ content: 'hello' }));
    const res = await post({ user: 'u-1', tools: [{ type: 'function', function: { name: 'records_search' } }] });
    expect(res.status).toBe(200);
    expect(gateway.calls[0]).toMatchObject({
      model: 'chat',
      user: 'u-1',
      stream: false,
      tools: ['records_search'],
      authorization: 'Bearer sk-test',
    });
    const body = (await res.json()) as {
      choices: { message: { content: string } }[];
      usage: { prompt_tokens: number };
    };
    expect(body.choices[0].message.content).toBe('hello');
    expect(body.usage.prompt_tokens).toBe(11);
  });

  it('answers a scripted tool call in the non-streaming shape', async () => {
    gateway.setResponder(() => ({ toolCalls: [{ name: 'records_search', arguments: { query: 'ada' } }] }));
    const body = (await (await post({})).json()) as {
      choices: {
        finish_reason: string;
        message: { tool_calls: { id: string; function: { name: string; arguments: string } }[] };
      }[];
    };
    expect(body.choices[0].finish_reason).toBe('tool_calls');
    expect(body.choices[0].message.tool_calls[0]).toMatchObject({
      id: 'call_1',
      function: { name: 'records_search', arguments: '{"query":"ada"}' },
    });
  });

  it('streams server-sent events with a unique completion id, the deltas and a final usage chunk', async () => {
    gateway.setResponder(() => ({ content: 'two words', inputTokens: 3, outputTokens: 2 }));
    const first = await post({ stream: true });
    expect(first.headers.get('content-type')).toBe('text/event-stream');
    const text = await first.text();
    const chunks = text
      .split('\n\n')
      .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
      .map(
        (line) =>
          JSON.parse(line.slice('data: '.length)) as {
            id: string;
            choices: { delta: { content?: string } }[];
            usage?: { prompt_tokens: number };
          },
      );
    expect(
      chunks
        .map((c) => c.choices[0]?.delta.content)
        .filter(Boolean)
        .join(''),
    ).toBe('two words');
    expect(chunks.at(-1)?.usage).toEqual({ prompt_tokens: 3, completion_tokens: 2, total_tokens: 5 });
    expect(text.trimEnd().endsWith('data: [DONE]')).toBe(true);
    const second = await (await post({ stream: true })).text();
    const idOf = (t: string) => (JSON.parse(t.split('\n\n')[0].slice('data: '.length)) as { id: string }).id;
    expect(idOf(second)).not.toBe(idOf(text));
  });

  it('streams a tool call as a name chunk, an arguments chunk and a tool_calls finish', async () => {
    gateway.setResponder(() => ({
      toolCalls: [{ id: 'call_9', name: 'read_file', arguments: { file_path: '/skills/x/SKILL.md' } }],
    }));
    const text = await (await post({ stream: true })).text();
    expect(text).toContain('"name":"read_file"');
    expect(text).toContain('"arguments":"{\\"file_path\\":\\"/skills/x/SKILL.md\\"}"');
    expect(text).toContain('"finish_reason":"tool_calls"');
  });

  it('answers a non-2xx status with the error body', async () => {
    gateway.setResponder(() => ({ status: 503, errorBody: { error: { message: 'down' } } }));
    const res = await post({});
    expect(res.status).toBe(503);
  });

  it('closes while a responder is still hanging', async () => {
    gateway.setResponder(() => new Promise<never>(() => {}));
    const pending = post({}).catch(() => 'closed');
    await new Promise((r) => setTimeout(r, 20));
    await gateway.close();
    expect(await pending).toBe('closed');
    gateway = await startFakeGateway();
  });
});
