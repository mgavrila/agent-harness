import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as z from 'zod/v4';
import { eq } from 'drizzle-orm';
import { modelCalls, runs } from '@harness/db';
import { ModelOutputError, ToolError } from '@harness/shared';
import { makeTestDeps, useTestDb, startFakeGateway, type FakeGateway, type TestDepsOverrides } from '../../testing.js';
import type { ToolDeps } from '../tooling/types.js';
import { callModel, callModelJson, gatewayFromEnv } from './gateway.js';

const db = useTestDb();
let gateway: FakeGateway;

beforeAll(async () => {
  gateway = await startFakeGateway();
});
afterAll(async () => {
  await gateway.close();
});

function deps(overrides: TestDepsOverrides = {}): ToolDeps {
  return makeTestDeps(db, {
    gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 5_000, maxCallsPerRun: 100 },
    ...overrides,
  });
}

describe('callModel', () => {
  it('posts to the route deployment with the master key and returns the text', async () => {
    gateway.calls.length = 0;
    gateway.setResponder(() => ({ content: 'hello there', inputTokens: 40, outputTokens: 9, costHeader: '0.000123' }));
    const out = await callModel(deps(), { route: 'chat', messages: [{ role: 'user', content: 'hi' }] });
    expect(out.text).toBe('hello there');
    expect(out.inputTokens).toBe(40);
    expect(out.outputTokens).toBe(9);
    expect(out.costUsd).toBeCloseTo(0.000123, 9);
    const call = gateway.calls.at(-1)!;
    expect(call.model).toBe('chat');
    expect(call.authorization).toBe('Bearer sk-test-key');
  });

  it('records one model_calls row per call, with the run id from the session context', async () => {
    const [run] = await db.insert(runs).values({ client: 'test', principalId: 'test-caller' }).returning();
    const d = deps({ context: { runId: run.id } });
    gateway.setResponder(() => ({
      content: 'x',
      inputTokens: 5,
      outputTokens: 2,
      costHeader: '0.5',
      modelName: 'gemini/gemini-3-flash-preview',
    }));
    await callModel(d, { route: 'extract', messages: [{ role: 'user', content: 'go' }] });
    const rows = await db.select().from(modelCalls).where(eq(modelCalls.runId, run.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      client: 'test',
      route: 'extract',
      model: 'gemini/gemini-3-flash-preview',
      inputTokens: 5,
      outputTokens: 2,
    });
    expect(rows[0].costUsd).toBeCloseTo(0.5, 6);
  });

  it('records a row with a null run id when no run is set', async () => {
    gateway.setResponder(() => ({ content: 'x' }));
    await callModel(deps(), { route: 'chat', messages: [{ role: 'user', content: 'go' }] });
    const rows = await db.select().from(modelCalls);
    expect(rows.at(-1)!.runId).toBeNull();
  });

  it('falls back to zero cost when the gateway sends no cost header', async () => {
    gateway.setResponder(() => ({ content: 'x' }));
    const out = await callModel(deps(), { route: 'chat', messages: [{ role: 'user', content: 'go' }] });
    expect(out.costUsd).toBe(0);
  });

  it('throws a ToolError naming the route and status, never echoing the prompt', async () => {
    gateway.setResponder(() => ({
      status: 500,
      errorBody: { error: { message: 'upstream said: SECRET PROMPT TEXT', type: 'api_error' } },
    }));
    await expect(
      callModel(deps(), { route: 'judge', messages: [{ role: 'user', content: 'SECRET PROMPT TEXT' }] }),
    ).rejects.toThrow(ToolError);
    await expect(
      callModel(deps(), { route: 'judge', messages: [{ role: 'user', content: 'SECRET PROMPT TEXT' }] }),
    ).rejects.toThrow(/judge.*500/);
    const err = (await callModel(deps(), { route: 'judge', messages: [{ role: 'user', content: 'SECRET' }] }).catch(
      (e: Error) => e,
    )) as Error;
    expect(err.message).not.toContain('SECRET');
  });

  it('reports a budget refusal in plain words', async () => {
    gateway.setResponder(() => ({
      status: 400,
      errorBody: {
        error: { message: 'Budget has been exceeded! Current cost: 5.1, Max budget: 5.0', type: 'budget_exceeded' },
      },
    }));
    await expect(callModel(deps(), { route: 'extract', messages: [{ role: 'user', content: 'go' }] })).rejects.toThrow(
      /daily budget/,
    );
  });

  it('does not record a model_calls row when the gateway refuses', async () => {
    const before = (await db.select().from(modelCalls)).length;
    gateway.setResponder(() => ({ status: 503, errorBody: {} }));
    await callModel(deps(), { route: 'chat', messages: [{ role: 'user', content: 'go' }] }).catch(() => undefined);
    expect(await db.select().from(modelCalls)).toHaveLength(before);
  });

  it('trips the per-run breaker once a run has made its limit of calls', async () => {
    const [run] = await db.insert(runs).values({ client: 'test', principalId: 'test-caller' }).returning();
    const d = deps({
      context: { runId: run.id },
      gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 5_000, maxCallsPerRun: 2 },
    });
    gateway.setResponder(() => ({ content: 'x' }));
    await callModel(d, { route: 'chat', messages: [{ role: 'user', content: '1' }] });
    await callModel(d, { route: 'chat', messages: [{ role: 'user', content: '2' }] });
    await expect(callModel(d, { route: 'chat', messages: [{ role: 'user', content: '3' }] })).rejects.toThrow(
      /already made 2 model calls/,
    );
    expect(await db.select().from(modelCalls).where(eq(modelCalls.runId, run.id))).toHaveLength(2);
  });

  it("counts only this client's calls against the breaker", async () => {
    // Every query carries the client. Run ids are uuids so a collision is not
    // the worry; the rule is that no client's counter can be moved by another
    // client's rows, and this was the one new query that omitted the column.
    const [run] = await db.insert(runs).values({ client: 'test', principalId: 'test-caller' }).returning();
    gateway.setResponder(() => ({ content: 'x' }));

    const other = deps({
      client: 'other-client',
      context: { runId: run.id },
      gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 5_000, maxCallsPerRun: 2 },
    });
    await callModel(other, { route: 'chat', messages: [{ role: 'user', content: '1' }] });
    await callModel(other, { route: 'chat', messages: [{ role: 'user', content: '2' }] });

    // The other client has now spent the whole allowance on this run id.
    await expect(callModel(other, { route: 'chat', messages: [{ role: 'user', content: '3' }] })).rejects.toThrow(
      /already made 2 model calls/,
    );
    const mine = deps({
      client: 'test',
      context: { runId: run.id },
      gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 5_000, maxCallsPerRun: 2 },
    });
    await expect(callModel(mine, { route: 'chat', messages: [{ role: 'user', content: '1' }] })).resolves.toBeTruthy();
  });

  it('does not count calls made with no run against the breaker', async () => {
    gateway.setResponder(() => ({ content: 'x' }));
    const d = deps({ gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 5_000, maxCallsPerRun: 1 } });
    await callModel(d, { route: 'chat', messages: [{ role: 'user', content: '1' }] });
    await expect(callModel(d, { route: 'chat', messages: [{ role: 'user', content: '2' }] })).resolves.toBeTruthy();
  });

  it('times out rather than hanging', async () => {
    gateway.setResponder(async () => {
      await new Promise((r) => setTimeout(r, 200));
      return { content: 'late' };
    });
    await expect(
      callModel(
        deps({ gateway: { baseUrl: gateway.url, apiKey: 'sk-test-key', timeoutMs: 30, maxCallsPerRun: 100 } }),
        {
          route: 'chat',
          messages: [{ role: 'user', content: 'go' }],
        },
      ),
    ).rejects.toThrow(/timed out/);
  });
});

describe('callModelJson', () => {
  const schema = {
    type: 'object',
    additionalProperties: false,
    required: ['answer'],
    properties: { answer: { type: 'string' } },
  };
  const validate = z.object({ answer: z.string() });

  it('sends response_format and parses the reply', async () => {
    gateway.setResponder(() => ({ content: '{"answer":"42"}' }));
    const out = await callModelJson(deps(), {
      route: 'extract',
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: { name: 'answer_only', schema },
      validate,
    });
    expect(out.json).toEqual({ answer: '42' });
    expect(gateway.calls.at(-1)!.responseFormat).toEqual({
      type: 'json_schema',
      json_schema: { name: 'answer_only', strict: true, schema },
    });
  });

  it('strips a markdown code fence some providers wrap JSON in', async () => {
    gateway.setResponder(() => ({ content: '```json\n{"answer":"42"}\n```' }));
    const out = await callModelJson(deps(), {
      route: 'extract',
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: { name: 'answer_only', schema },
      validate,
    });
    expect(out.json).toEqual({ answer: '42' });
  });

  it('throws a ModelOutputError on unparseable JSON without echoing the body', async () => {
    gateway.setResponder(() => ({ content: 'I am sorry, SECRET, I cannot' }));
    const err = (await callModelJson(deps(), {
      route: 'extract',
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: { name: 'answer_only', schema },
      validate,
    }).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(ModelOutputError);
    expect(err.message).toMatch(/not valid JSON/);
    expect(err.message).not.toContain('SECRET');
  });

  it('throws a ModelOutputError naming the field path when a required field is missing, without echoing the reply', async () => {
    gateway.setResponder(() => ({ content: '{"unexpected":"SECRET_REPLY_VALUE"}' }));
    const err = (await callModelJson(deps(), {
      route: 'extract',
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: { name: 'answer_only', schema },
      validate,
    }).catch((e: Error) => e)) as Error;
    expect(err).toBeInstanceOf(ModelOutputError);
    expect(err).toBeInstanceOf(ToolError);
    expect(err.message).toContain('answer');
    expect(err.message).not.toContain('SECRET_REPLY_VALUE');
  });

  it('still records a model_calls row when the reply parses as JSON but fails schema validation', async () => {
    const before = (await db.select().from(modelCalls)).length;
    gateway.setResponder(() => ({ content: '{"unexpected":"x"}' }));
    await callModelJson(deps(), {
      route: 'extract',
      messages: [{ role: 'user', content: 'go' }],
      jsonSchema: { name: 'answer_only', schema },
      validate,
    }).catch(() => undefined);
    // callModel already wrote its row before callModelJson parses or
    // validates the text, since a valid HTTP response was received; a later
    // validation failure does not roll it back. Pinning that here, not just
    // asserting it does not throw, is the point of this test.
    expect(await db.select().from(modelCalls)).toHaveLength(before + 1);
  });
});

describe('gatewayFromEnv', () => {
  it('requires a master key', () => {
    const saved = process.env.LITELLM_MASTER_KEY;
    delete process.env.LITELLM_MASTER_KEY;
    expect(() => gatewayFromEnv()).toThrow(/LITELLM_MASTER_KEY/);
    if (saved !== undefined) process.env.LITELLM_MASTER_KEY = saved;
  });

  it('defaults to loopback port 4000', () => {
    const savedKey = process.env.LITELLM_MASTER_KEY;
    const savedUrl = process.env.HARNESS_GATEWAY_URL;
    process.env.LITELLM_MASTER_KEY = 'sk-x';
    delete process.env.HARNESS_GATEWAY_URL;
    expect(gatewayFromEnv().baseUrl).toBe('http://127.0.0.1:4000');
    if (savedKey === undefined) delete process.env.LITELLM_MASTER_KEY;
    else process.env.LITELLM_MASTER_KEY = savedKey;
    if (savedUrl !== undefined) process.env.HARNESS_GATEWAY_URL = savedUrl;
  });
});
