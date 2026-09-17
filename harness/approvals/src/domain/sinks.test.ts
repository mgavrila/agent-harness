import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { encrypt, toolEffects } from '@harness/db';
import { dispatchStagedEffects } from '@harness/core-tools/effects';
import { MemorySurface } from '@harness/surface-api/testing';
import { fakeSlackSession } from '@harness/surface-slack/testing';
import { useTestDb } from '../testing.js';
import { surfaceSinks } from './sinks.js';
import { surfacesOf } from './surfaces/registry.js';

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

/** The primary surface is memory; a second, `other`, is loaded beside it. */
function wire(opts: { outDir?: string } = {}) {
  const primary = new MemorySurface();
  const other = new MemorySurface({ name: 'other', conversation: 'other-default' });
  return { primary, other, sinks: surfaceSinks(surfacesOf([primary, other]), opts) };
}

describe('surface sinks', () => {
  it('posts a staged message on the primary surface and records only identifiers', async () => {
    await stage('surface_message', { text: '3 credentials expire within 90 days.' }, 'expirations digest', 'k1');
    const { primary, sinks } = wire();
    const out = await dispatchStagedEffects(db, sinks, { key });
    expect(out).toMatchObject({ dispatched: 1, failed: 0, skipped: 0 });
    expect(primary.texts[0]).toMatchObject({ conversation: 'memory', text: '3 credentials expire within 90 days.' });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('dispatched');
    expect(row.result).toEqual({ surface: 'memory', conversation: 'memory', message_id: 'm1' });
  });

  it('honours a conversation carried on the payload', async () => {
    await stage('surface_message', { text: 'hello', conversation: 'elsewhere' }, 'note', 'k2');
    const { primary, sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    expect(primary.texts[0].conversation).toBe('elsewhere');
  });

  it('sends to the surface the payload names, not to the primary', async () => {
    await stage('surface_message', { text: 'hello', surface: 'other' }, 'note', 'k3');
    const { primary, other, sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    expect(primary.texts).toHaveLength(0);
    expect(other.texts[0]).toMatchObject({ conversation: 'other-default', text: 'hello' });
  });

  it('reads a row staged before migration 0009, which addressed itself with `channel`', async () => {
    await stage('surface_message', { text: 'hello', channel: 'C0OLD' }, 'note', 'k4');
    const { primary, sinks } = wire();
    const out = await dispatchStagedEffects(db, sinks, { key });
    expect(out.dispatched).toBe(1);
    expect(primary.texts[0].conversation).toBe('C0OLD');
  });

  it('fails the row when the payload names a surface this host has not loaded', async () => {
    await stage('surface_message', { text: 'hello', surface: 'teams' }, 'note', 'k6');
    const { sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe(`surface_message: no surface named "teams" is loaded (effect ${row.id})`);
  });

  it('uploads a staged file with the effect summary as the comment', async () => {
    const file = path.join(dir, 'aetna-roster.csv');
    await writeFile(file, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
    await stage(
      'surface_file',
      { path: file, filename: 'aetna-roster.csv', file_id: 'roster/aetna-abc.csv' },
      'Release aetna-roster.csv',
      'k7',
    );
    const { primary, sinks } = wire();
    expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ dispatched: 1 });
    expect(primary.uploads[0]).toMatchObject({
      conversation: 'memory',
      filename: 'aetna-roster.csv',
      comment: 'Release aetna-roster.csv',
    });
    const [row] = await db.select().from(toolEffects);
    expect(row.result).toEqual({ surface: 'memory', conversation: 'memory', filename: 'aetna-roster.csv' });
  });

  it('leaves the row staged and records a short error when the surface fails', async () => {
    await stage('surface_message', { text: 'hello' }, 'note', 'k8');
    const { primary, sinks } = wire();
    primary.failWith = 'conversation_not_found';
    const out = await dispatchStagedEffects(db, sinks, { key, maxAttempts: 3 });
    expect(out).toMatchObject({ retried: 1, dispatched: 0 });
    const [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ status: 'staged', attempts: 1 });
    expect(row.lastError).toContain('conversation_not_found');
  });

  it('never repeats payload content in a validation error', async () => {
    await stage('surface_message', { text: 123, secret: '123-45-6789' }, 'bad payload', 'k9');
    const { sinks } = wire();
    await dispatchStagedEffects(db, sinks, { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe('surface_message payload failed validation');
    expect(row.lastError).not.toContain('123-45-6789');
  });

  it('skips a sink it does not register', async () => {
    await stage('email', { to: 'x' }, 'email', 'k10');
    const { sinks } = wire();
    expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ skipped: 1, dispatched: 0 });
  });

  it('never leaks a filesystem path when the staged file is missing', async () => {
    const missing = path.join(dir, 'missing.csv');
    // The Slack adapter is the one that reads the bytes, so it is the surface that can fail that
    // way; the memory surface records a path and never opens it.
    await stage(
      'surface_file',
      { path: missing, filename: 'missing.csv', conversation: 'C0DEMO' },
      'missing file',
      'k11',
    );
    const { session, api } = fakeSlackSession();
    await dispatchStagedEffects(db, surfaceSinks(surfacesOf([session])), { key });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.lastError).toBe(`surface_file: slack: the staged file could not be read (effect ${row.id})`);
    expect(row.lastError).not.toContain(missing);
    expect(api.uploads).toHaveLength(0);
  });

  it('refuses a staged path outside the configured storage root before reading it', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      // Deliberately does not exist: if the sink read it before checking the root, the error
      // would say "staged file unavailable" instead, so this message proves the check ran first.
      const outside = path.join(dir, 'not-in-root.csv');
      await stage('surface_file', { path: outside, filename: 'not-in-root.csv' }, 'outside root', 'k13');
      const { primary, sinks } = wire({ outDir: root });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a file elsewhere in the store when the sink is scoped to the out tree', async () => {
    const store = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      const ingested = path.join(store, 'documents');
      await mkdir(ingested, { recursive: true });
      const doc = path.join(ingested, 'w9.pdf');
      await writeFile(doc, 'a scanned W-9');
      await mkdir(path.join(store, 'out'), { recursive: true });
      await stage('surface_file', { path: doc, filename: 'w9.pdf' }, 'Release w9.pdf', 'k14');
      const { primary, sinks } = wire({ outDir: path.join(store, 'out') });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(store, { recursive: true, force: true });
    }
  });

  it('refuses a staged path that reaches outside the storage root through a symlink', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      // The file exists and the path is lexically inside the root, so a `path.relative` check
      // would pass it and the read would follow the link.
      const secret = path.join(dir, 'restricted.csv');
      await writeFile(secret, 'ssn,123-45-6789\n');
      await mkdir(path.join(root, 'out'), { recursive: true });
      await symlink(secret, path.join(root, 'out', 'aetna-roster.csv'));
      await stage(
        'surface_file',
        { path: path.join(root, 'out', 'aetna-roster.csv'), filename: 'aetna-roster.csv' },
        'Release aetna-roster.csv',
        'k15',
      );
      const { primary, sinks } = wire({ outDir: root });
      await dispatchStagedEffects(db, sinks, { key });
      const [row] = await db.select().from(toolEffects);
      expect(row.lastError).toBe(`surface_file: path outside the release directory (effect ${row.id})`);
      expect(primary.uploads).toHaveLength(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('uploads a staged file whose path resolves inside the storage root', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'harness-root-'));
    try {
      const sub = path.join(root, 'out', 'roster');
      await mkdir(sub, { recursive: true });
      const file = path.join(sub, 'aetna-roster.csv');
      await writeFile(file, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');
      await stage('surface_file', { path: file, filename: 'aetna-roster.csv' }, 'Release aetna-roster.csv', 'k16');
      const { primary, sinks } = wire({ outDir: root });
      expect(await dispatchStagedEffects(db, sinks, { key })).toMatchObject({ dispatched: 1 });
      expect(primary.uploads[0]).toMatchObject({ filename: 'aetna-roster.csv' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
