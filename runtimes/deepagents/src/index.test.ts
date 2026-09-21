import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  RECORDS_SEARCH,
  collectRunEvents,
  fixtureRequest,
  startFakeGateway,
  toolServerFixture,
} from '@harness/runtime-api/testing';
import type { FakeGateway, ToolServerFixture } from '@harness/runtime-api/testing';
import { runtime } from './index.js';

const url = process.env.TEST_DATABASE_URL ?? 'postgres://harness:harness@localhost:15432/harness_test';
const log = { info() {}, warn() {}, error() {} };

let gateway: FakeGateway;
let fixture: ToolServerFixture;

beforeAll(async () => {
  gateway = await startFakeGateway();
  fixture = await toolServerFixture([RECORDS_SEARCH]);
});
afterAll(async () => {
  await gateway.close();
  await fixture.close();
});

describe('the deepagents runtime', () => {
  it('declares its name and no secrets: the gateway key arrives on every request', () => {
    expect(runtime.name).toBe('deepagents');
    expect(runtime.secrets).toEqual([]);
  });

  it('creates the checkpoint tables in schema langgraph when it connects, and stops cleanly', async () => {
    const session = await runtime.connect({ env: {}, log, databaseUrl: url, storageDir: '/nonexistent' });
    try {
      expect(session.name).toBe('deepagents');
      const pool = new pg.Pool({ connectionString: url });
      try {
        const { rows } = await pool.query(
          "select table_name from information_schema.tables where table_schema = 'langgraph' order by table_name",
        );
        expect(rows.map((r: { table_name: string }) => r.table_name)).toEqual([
          'checkpoint_blobs',
          'checkpoint_migrations',
          'checkpoint_writes',
          'checkpoints',
        ]);
      } finally {
        await pool.end();
      }
    } finally {
      // A failed assertion must still close the saver's pool, or the worker never exits.
      await session.stop();
    }
  });

  it('resumes a thread from the checkpoint it wrote, without being told the history again', async () => {
    const session = await runtime.connect({ env: {}, log, databaseUrl: url, storageDir: '/nonexistent' });
    const threadId = `44444444-4444-4444-8444-${Date.now().toString().slice(-12).padStart(12, '0')}`;
    const request = (text: string) =>
      fixtureRequest({
        tools: fixture.client,
        threadId,
        input: { text, attachments: [] },
        model: { baseUrl: gateway.url, apiKey: 'sk-test', route: 'chat', model: 'acme/gemini/flash', user: 'u-resume' },
      });
    try {
      gateway.setResponder(() => ({ content: 'first answer' }));
      const first = await collectRunEvents(session.run(request('remember the number nine')).events);
      expect(first.at(-1)).toEqual({ type: 'done', text: 'first answer' });

      gateway.setResponder(() => ({ content: 'second answer' }));
      const before = gateway.calls.length;
      const second = await collectRunEvents(session.run(request('what was the number?')).events);
      expect(second.at(-1)).toEqual({ type: 'done', text: 'second answer' });

      // The second turn carries the first turn, and the request said nothing about it: the only
      // place it can have come from is the row the first run wrote in schema `langgraph`.
      const sent = gateway.calls[before].messages.map((m) => String(m.content));
      expect(sent).toContain('remember the number nine');
      expect(sent).toContain('first answer');
      expect(sent).toContain('what was the number?');
    } finally {
      await session.stop();
    }
  });
});
