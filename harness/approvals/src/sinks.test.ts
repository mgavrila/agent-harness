import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { slackSinks } from './sinks.js';
import { FakeSlack, useTestDb } from './testing.js';

const db = useTestDb();
const key = randomBytes(32);
let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), 'harness-sink-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function stage(sink: string, payload: unknown, summary: string, idempotencyKey: string): Promise<void> {
  await db.insert(toolEffects).values({
    client: 'test',
    tool: 'test_tool',
    sink,
    idempotencyKey,
    payloadEncrypted: encrypt(JSON.stringify(payload), key),
    summary,
  });
}

describe('slack sinks', () => {
  it('posts a staged message and records only the timestamp on the row', async () => {
    await stage('slack_message', { text: '3 credentials expire within 90 days.' }, 'expirations digest', 'k1');
    const slack = new FakeSlack();
    const out = await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key });
    expect(out).toMatchObject({ dispatched: 1, failed: 0, skipped: 0 });
    expect(slack.posts).toHaveLength(1);
    expect(slack.posts[0]).toMatchObject({ channel: 'C0DEFAULT', text: '3 credentials expire within 90 days.' });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('dispatched');
    expect(row.result).toMatchObject({ slack_channel: 'C0DEFAULT' });
    expect(String((row.result as { slack_ts?: string }).slack_ts)).toMatch(/^\d+\.\d+$/);
  });

  it('honours a channel carried on the payload', async () => {
    await stage('slack_message', { text: 'hello', channel: 'C0OTHER' }, 'note', 'k2');
    const slack = new FakeSlack();
    await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key });
    expect(slack.posts[0].channel).toBe('C0OTHER');
  });

  it('uploads a staged file with the effect summary as the comment', async () => {
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
    await stage('slack_file', { path: file, filename: 'aetna-roster.csv', file_id: 'roster/aetna-abc.csv' }, 'Release aetna-roster.csv to Slack', 'k3');
    const slack = new FakeSlack();
    const out = await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key });
    expect(out.dispatched).toBe(1);
    expect(slack.uploads).toHaveLength(1);
    expect(slack.uploads[0]).toMatchObject({
      channel_id: 'C0DEFAULT',
      filename: 'aetna-roster.csv',
      initial_comment: 'Release aetna-roster.csv to Slack',
    });
    expect(slack.uploads[0].file.toString()).toContain('Dr. Ada Reyes');
  });

  it('leaves the row staged and records a short error when Slack fails', async () => {
    await stage('slack_message', { text: 'hello' }, 'note', 'k4');
    const slack = new FakeSlack();
    slack.failWith = 'channel_not_found';
    const out = await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key, maxAttempts: 3 });
    expect(out).toMatchObject({ retried: 1, dispatched: 0 });
    const [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ status: 'staged', attempts: 1 });
    expect(row.lastError).toContain('channel_not_found');
  });

  it('never repeats payload content in a validation error', async () => {
    await stage('slack_message', { text: 123, secret: '123-45-6789' }, 'bad payload', 'k5');
    const slack = new FakeSlack();
    await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe('slack_message payload failed validation');
    expect(row.lastError).not.toContain('123-45-6789');
  });

  it('skips a sink it does not register', async () => {
    await stage('email', { to: 'x' }, 'email', 'k6');
    const slack = new FakeSlack();
    const out = await dispatchStagedEffects(db, slackSinks(slack, { defaultChannel: 'C0DEFAULT' }), { key });
    expect(out).toMatchObject({ skipped: 1, dispatched: 0 });
  });
});
