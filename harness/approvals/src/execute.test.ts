import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import { eq } from 'drizzle-orm';
import { approvals, encrypt, toolEffects } from '@harness/db';
import { TEST_DATABASE_URL } from '@harness/db/testing';
import { createMcpCoreToolsClient } from './execute.js';
import { useTestDb } from './testing.js';

const db = useTestDb();
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

describe('core-tools MCP client', () => {
  it('executes an approved forms_release and stages the effect, audited', async () => {
    const key = randomBytes(32);
    const storageDir = await mkdtemp(path.join(tmpdir(), 'harness-exec-'));
    const fileId = 'roster/aetna-abc123def456.csv';
    const outFile = path.join(storageDir, 'out', fileId);
    await mkdir(path.dirname(outFile), { recursive: true });
    await writeFile(outFile, 'payer_id,provider_name\naetna,Dr. Ada Reyes\n');

    const [row] = await db
      .insert(approvals)
      .values({
        client: 'exec-test',
        action: 'forms_release',
        payload: { tool: 'forms_release', args: { file_id: fileId } },
        payloadEncrypted: encrypt(JSON.stringify({ tool: 'forms_release', args: { file_id: fileId } }), key),
        summary: 'forms_release (external) requested by hermes',
        requestedBy: 'hermes',
        status: 'approved',
        idempotencyKey: 'exec-test:forms_release:x',
        expiresAt: new Date(Date.now() + 3600_000),
      })
      .returning();

    const core = createMcpCoreToolsClient({
      command: 'pnpm',
      args: ['--dir', repoRoot, '--filter', '@harness/core-tools', 'start'],
      env: {
        ...(process.env as Record<string, string>),
        DATABASE_URL: TEST_DATABASE_URL,
        HARNESS_ENCRYPTION_KEY: key.toString('base64'),
        HARNESS_CLIENT: 'exec-test',
        CORE_TOOLS_CALLER: 'approvals-app',
        HARNESS_STORAGE_DIR: storageDir,
      },
    });

    try {
      const outcome = await core.execute(row.id);
      expect(outcome).toEqual({ status: 'executed', tool: 'forms_release' });
      const [after] = await db.select().from(approvals).where(eq(approvals.id, row.id));
      expect(after.status).toBe('executed');
      const effects = await db.select().from(toolEffects);
      expect(effects).toHaveLength(1);
      expect(effects[0]).toMatchObject({ sink: 'slack_file', tool: 'forms_release', status: 'staged' });

      // Exactly once: a second call finds the row no longer approved.
      const again = await core.execute(row.id);
      expect(again.status).toBe('failed');
      expect(await db.select().from(toolEffects)).toHaveLength(1);
    } finally {
      await core.close();
      await rm(storageDir, { recursive: true, force: true });
    }
  }, 60_000);
});
