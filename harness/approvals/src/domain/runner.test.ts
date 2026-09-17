import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { approvals, encrypt, toolEffects } from '@harness/db';
import type { SurfaceSession } from '@harness/surface-api';
import { fakeSlackSession } from '@harness/surface-slack/testing';
import { FakeCoreToolsClient, MemorySurface, pendingApproval, useTestDb } from '../testing.js';
import {
  runPollTick,
  runDispatchTick,
  runReconcileTick,
  collectHealth,
  startRunner,
  type RunnerDeps,
} from './runner.js';
import { surfaceSinks } from './sinks.js';
import { surfacesOf } from './surfaces/registry.js';

const db = useTestDb();
const key = randomBytes(32);
const now = () => new Date('2026-09-15T12:00:00Z');

function makeDeps(surface: SurfaceSession, core: FakeCoreToolsClient): RunnerDeps {
  const surfaces = surfacesOf([surface]);
  return { db, surfaces, core, sinks: surfaceSinks(surfaces), client: 'demo-practice', encryptionKey: key, now };
}

describe('runner ticks', () => {
  it('posts a card, then drains a staged message, then reports both in health', async () => {
    await db.insert(approvals).values(pendingApproval());
    await db.insert(toolEffects).values({
      client: 'demo-practice',
      tool: 'credentialing_expirations',
      sink: 'surface_message',
      idempotencyKey: 'demo-practice:expirations:2026-09-15',
      payloadEncrypted: encrypt(JSON.stringify({ text: '2 credentials expire within 90 days.' }), key),
      summary: 'expirations digest',
    });

    const surface = new MemorySurface();
    const core = new FakeCoreToolsClient();
    const deps = makeDeps(surface, core);

    expect(await runPollTick(deps)).toMatchObject({ posted: 1 });
    expect(await runDispatchTick(deps)).toMatchObject({ dispatched: 1 });
    expect(surface.texts.map((t) => t.text)).toContain('2 credentials expire within 90 days.');

    const handle = startRunner(deps, {
      pollMs: 3_600_000,
      dispatchMs: 3_600_000,
      reconcileMs: 3_600_000,
      staleAfterMinutes: 10,
    });
    try {
      const health = await collectHealth(db, 'demo-practice', handle, now);
      expect(health.ok).toBe(true);
      expect(health.effects).toMatchObject({ staged: 0, failed: 0, needs_review: 0 });
      expect(health.approvals.pending).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  it('calls harness_reconcile through core-tools rather than touching the rows itself', async () => {
    const surface = new MemorySurface();
    const core = new FakeCoreToolsClient();
    const out = await runReconcileTick(makeDeps(surface, core), 10);
    expect(out).toEqual({ approvals_expired: 0, dispatches_parked: 0 });
    expect(core.reconciled).toEqual([10]);
  });

  it('reports a file effect that cannot be read as failed, without throwing', async () => {
    await db.insert(toolEffects).values({
      client: 'demo-practice',
      tool: 'forms_release',
      sink: 'surface_file',
      idempotencyKey: 'demo-practice:forms_release:gone',
      payloadEncrypted: encrypt(
        JSON.stringify({ path: '/nope/gone.csv', filename: 'gone.csv', conversation: 'C0DEMO' }),
        key,
      ),
      summary: 'Release gone.csv',
    });
    // The adapter that reads the bytes is the one that can fail that way; the memory surface
    // records a path and never opens it.
    const deps = makeDeps(fakeSlackSession().session, new FakeCoreToolsClient());
    const out = await runDispatchTick(deps);
    expect(out).toMatchObject({ dispatched: 0, retried: 1 });
    const [row] = await db.select().from(toolEffects);
    expect(row.status).toBe('staged');
    expect(row.attempts).toBe(1);
  });

  it('marks health not ok when effects need review', async () => {
    await db.insert(toolEffects).values({
      client: 'demo-practice',
      tool: 'forms_release',
      sink: 'surface_file',
      idempotencyKey: 'demo-practice:forms_release:stuck',
      payloadEncrypted: encrypt(JSON.stringify({ path: '/x', filename: 'x' }), key),
      summary: 'Release x',
      status: 'needs_review',
    });
    const handle = startRunner(makeDeps(new MemorySurface(), new FakeCoreToolsClient()), {
      pollMs: 3_600_000,
      dispatchMs: 3_600_000,
      reconcileMs: 3_600_000,
      staleAfterMinutes: 10,
    });
    try {
      const health = await collectHealth(db, 'demo-practice', handle, now);
      expect(health.ok).toBe(false);
      expect(health.effects.needs_review).toBe(1);
    } finally {
      await handle.stop();
    }
  });

  it('stops cleanly and runs nothing afterwards', async () => {
    const surface = new MemorySurface();
    const handle = startRunner(makeDeps(surface, new FakeCoreToolsClient()), {
      pollMs: 5,
      dispatchMs: 5,
      reconcileMs: 5,
      staleAfterMinutes: 10,
    });
    await new Promise((resolve) => setTimeout(resolve, 40));
    await handle.stop();
    const before = handle.status();
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(handle.status()).toEqual(before);
  });

  it('marks a loop unhealthy on a failed tick, and healthy again once it recovers', async () => {
    const surface = new MemorySurface();
    const core = new FakeCoreToolsClient();
    core.failReconcileWith = 'boom';
    const deps = makeDeps(surface, core);
    const handle = startRunner(deps, {
      pollMs: 3_600_000,
      dispatchMs: 3_600_000,
      reconcileMs: 10,
      staleAfterMinutes: 10,
    });
    try {
      await new Promise((resolve) => setTimeout(resolve, 40));
      const unhealthy = await collectHealth(db, 'demo-practice', handle, now);
      expect(unhealthy.ok).toBe(false);
      expect(unhealthy.runner.loops.reconcile.lastError).toContain('boom');

      core.failReconcileWith = undefined;
      await new Promise((resolve) => setTimeout(resolve, 40));
      const healthy = await collectHealth(db, 'demo-practice', handle, now);
      expect(healthy.ok).toBe(true);
      expect(healthy.runner.loops.reconcile.lastError).toBeNull();
    } finally {
      await handle.stop();
    }
  });

  it('writes an out-file effect to the surface when the file exists', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'harness-runner-'));
    const file = path.join(dir, 'out', 'roster', 'aetna-abc123def456.csv');
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'payer_id\naetna\n');
    await db.insert(toolEffects).values({
      client: 'demo-practice',
      tool: 'forms_release',
      sink: 'surface_file',
      idempotencyKey: 'demo-practice:forms_release:ok',
      payloadEncrypted: encrypt(JSON.stringify({ path: file, filename: 'aetna-roster.csv' }), key),
      summary: 'Release aetna-roster.csv',
    });
    const surface = new MemorySurface();
    const out = await runDispatchTick(makeDeps(surface, new FakeCoreToolsClient()));
    expect(out.dispatched).toBe(1);
    expect(surface.uploads[0].filename).toBe('aetna-roster.csv');
    await rm(dir, { recursive: true, force: true });
  });
});
