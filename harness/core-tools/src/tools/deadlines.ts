import * as z from 'zod/v4';
import { and, asc, eq, lte } from 'drizzle-orm';
import { credentials, deadlines, providers } from '@harness/db';
import { defineTool, type AnyToolDef } from '../registry.js';
import { computeDeadlines, daysUntil, addDays } from '../deadlines/compute.js';
import { requireProvider } from './providers.js';

const deadlinesCompute = defineTool({
  name: 'deadlines_compute',
  description: 'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
  actionClass: 'write.internal',
  input: z.object({ provider_id: z.string().uuid() }),
  output: z.object({
    deadlines: z.array(z.object({ credential_id: z.string(), kind: z.string(), due_at: z.string() })),
  }),
  handler: async ({ provider_id }, deps) => {
    await requireProvider(deps, provider_id);
    const creds = await deps.db.select().from(credentials).where(eq(credentials.providerId, provider_id));
    const computed = computeDeadlines(creds.map((c) => ({ id: c.id, kind: c.kind, expiresAt: c.expiresAt })));
    for (const d of computed) {
      await deps.db
        .insert(deadlines)
        .values({ providerId: provider_id, credentialId: d.credentialId, kind: d.kind, dueAt: d.dueAt })
        .onConflictDoUpdate({ target: [deadlines.credentialId, deadlines.kind], set: { dueAt: d.dueAt } });
    }
    return { deadlines: computed.map((d) => ({ credential_id: d.credentialId, kind: d.kind, due_at: d.dueAt })) };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const deadlinesUpcoming = defineTool({
  name: 'deadlines_upcoming',
  description: 'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date.',
  actionClass: 'read',
  input: z.object({
    window_days: z.number().int().min(1).max(730).default(90),
    today: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
  output: z.object({
    items: z.array(
      z.object({
        provider_id: z.string(),
        provider_name: z.string(),
        credential_id: z.string(),
        credential_kind: z.string(),
        kind: z.string(),
        due_at: z.string(),
        days_left: z.number(),
        overdue: z.boolean(),
      }),
    ),
  }),
  handler: async ({ window_days, today }, deps) => {
    const todayDate = today ? new Date(`${today}T00:00:00Z`) : deps.now();
    const todayStr = todayDate.toISOString().slice(0, 10);
    const horizon = addDays(todayStr, window_days);
    const rows = await deps.db
      .select({
        providerId: deadlines.providerId,
        providerName: providers.name,
        credentialId: deadlines.credentialId,
        credentialKind: credentials.kind,
        kind: deadlines.kind,
        dueAt: deadlines.dueAt,
      })
      .from(deadlines)
      .innerJoin(credentials, eq(deadlines.credentialId, credentials.id))
      .innerJoin(providers, eq(deadlines.providerId, providers.id))
      .where(and(eq(providers.client, deps.client), lte(deadlines.dueAt, horizon)))
      .orderBy(asc(deadlines.dueAt));
    return {
      items: rows.map((r) => {
        const daysLeft = daysUntil(r.dueAt, todayDate);
        return {
          provider_id: r.providerId,
          provider_name: r.providerName,
          credential_id: r.credentialId,
          credential_kind: r.credentialKind,
          kind: r.kind,
          due_at: r.dueAt,
          days_left: daysLeft,
          overdue: daysLeft < 0,
        };
      }),
    };
  },
});

export const deadlineTools: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
