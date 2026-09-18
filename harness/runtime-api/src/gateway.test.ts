import { afterEach, beforeEach, describe, expect, it, onTestFinished } from 'vitest';
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

  it('answers a body that is not JSON with 400 instead of failing the process', async () => {
    const res = await fetch(`${gateway.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: 'not json',
    });
    expect(res.status).toBe(400);
    await res.text();
    expect(gateway.calls).toHaveLength(0);
    // The server is still answering afterwards.
    gateway.setResponder(() => ({ content: 'still here' }));
    expect((await post({})).status).toBe(200);
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

describe('the fake gateway embeddings endpoint', () => {
  it('answers deterministic unit vectors at the width the caller asked for, and records the call', async () => {
    const fake = await startFakeGateway();
    onTestFinished(() => fake.close());

    const response = await fetch(`${fake.url}/v1/embeddings`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer sk-test' },
      body: JSON.stringify({
        model: 'embed',
        input: ['the office closes at five', 'the office closes at five'],
        dimensions: 8,
        user: 'u-1',
      }),
    });
    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      object: string;
      model: string;
      data: { object: string; index: number; embedding: number[] }[];
      usage: { prompt_tokens: number; total_tokens: number };
    };
    expect(payload.object).toBe('list');
    expect(payload.model).toBe('embed');
    expect(payload.data.map((d) => d.index)).toEqual([0, 1]);
    expect(payload.data[0].embedding).toHaveLength(8);
    // The same text always embeds the same, which is what makes a retrieval test assertable.
    expect(payload.data[0].embedding).toEqual(payload.data[1].embedding);
    // And it is a unit vector, so a cosine distance is a cosine distance.
    const norm = Math.sqrt(payload.data[0].embedding.reduce((n, x) => n + x * x, 0));
    expect(norm).toBeCloseTo(1, 10);
    expect(payload.usage.prompt_tokens).toBeGreaterThan(0);

    expect(fake.embeddings).toHaveLength(1);
    expect(fake.embeddings[0]).toMatchObject({
      model: 'embed',
      dimensions: 8,
      user: 'u-1',
      authorization: 'Bearer sk-test',
    });
    expect(fake.embeddings[0].input).toHaveLength(2);
    // Chat calls and embedding calls are recorded separately: a suite asserting on one must not
    // have to filter the other out.
    expect(fake.calls).toEqual([]);
  });

  it('gives different text different directions, and lets a responder force an error or a width', async () => {
    const fake = await startFakeGateway();
    onTestFinished(() => fake.close());
    const embed = async (input: string[]): Promise<Response> =>
      fetch(`${fake.url}/v1/embeddings`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: 'embed', input, dimensions: 16 }),
      });

    const both = (await (await embed(['alpha beta', 'gamma delta'])).json()) as {
      data: { embedding: number[] }[];
    };
    const dot = both.data[0].embedding.reduce((n, x, i) => n + x * both.data[1].embedding[i], 0);
    expect(dot).toBeCloseTo(0, 10);

    fake.setEmbeddingResponder(() => ({ dimensions: 4 }));
    const narrow = (await (await embed(['alpha'])).json()) as { data: { embedding: number[] }[] };
    expect(narrow.data[0].embedding).toHaveLength(4);

    fake.setEmbeddingResponder(() => ({ status: 429, errorBody: { error: { message: 'over budget' } } }));
    const refused = await embed(['alpha']);
    expect(refused.status).toBe(429);
    expect(await refused.text()).toContain('over budget');
  });
});
