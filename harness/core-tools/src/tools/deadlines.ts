import * as z from 'zod/v4';
import { and, asc, eq, inArray, lte, sql } from 'drizzle-orm';
import { credentials, deadlines, providers } from '@harness/db';
import { defineTool, type AnyToolDef } from '../registry.js';
import {
  computeDeadlines,
  daysUntil,
  addDays,
  bucketFor,
  digestKeyFor,
  URGENCY_BUCKETS,
} from '../deadlines/compute.js';
import { requireProvider } from './providers.js';

/** Identifies a deadline row within a provider, matching `deadlines_credential_kind_uq`. */
const deadlineKey = (d: { credentialId: string; kind: string }) => `${d.credentialId}:${d.kind}`;

const deadlinesCompute = defineTool({
  name: 'deadlines_compute',
  description:
    'Recompute expiration and renewal-start deadlines for a provider from its credentials. Deterministic, no model call.',
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
        .onConflictDoUpdate({
          target: [deadlines.credentialId, deadlines.kind],
          // A moved due date invalidates any notification already sent for the
          // old one, so clear the marker; an unchanged date keeps it, so the
          // same reminder is not sent twice.
          set: {
            dueAt: d.dueAt,
            notifiedAt: sql`CASE WHEN ${deadlines.dueAt} = ${d.dueAt} THEN ${deadlines.notifiedAt} ELSE NULL END`,
          },
        });
    }
    // A credential that lost its expiry, or was removed, leaves deadlines
    // behind that nothing recomputes. Retire whatever this run did not produce.
    const computedKeys = new Set(computed.map(deadlineKey));
    const existingRows = await deps.db
      .select({ id: deadlines.id, credentialId: deadlines.credentialId, kind: deadlines.kind })
      .from(deadlines)
      .where(eq(deadlines.providerId, provider_id));
    const staleIds = existingRows.filter((r) => !computedKeys.has(deadlineKey(r))).map((r) => r.id);
    if (staleIds.length > 0) {
      await deps.db.delete(deadlines).where(inArray(deadlines.id, staleIds));
    }
    return { deadlines: computed.map((d) => ({ credential_id: d.credentialId, kind: d.kind, due_at: d.dueAt })) };
  },
  recordIds: ({ provider_id }) => [provider_id],
});

const deadlinesUpcoming = defineTool({
  name: 'deadlines_upcoming',
  description:
    'List deadlines due within a window (default 90 days), including overdue ones, sorted by due date. ' +
    'At most `limit` rows (default 200).',
  actionClass: 'read',
  input: z.object({
    window_days: z.number().int().min(1).max(730).default(90),
    today: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    limit: z.number().int().min(1).max(1000).default(200),
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
        bucket: z.enum([...URGENCY_BUCKETS]),
      }),
    ),
    /**
     * Fingerprint of this exact set of (credential, deadline kind, bucket)
     * triples, independent of item order. A playbook passes this straight
     * through as `harness_notify`'s idempotency key: the same set of items in
     * the same buckets produces the same key, so a re-run digest is a no-op,
     * and an item moving to a tighter bucket changes the key so the next run
     * speaks again. `expirations:none` when there are no items.
     */
    digest_key: z.string(),
  }),
  handler: async ({ window_days, today, limit }, deps) => {
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
      .orderBy(asc(deadlines.dueAt))
      .limit(limit);
    const items = rows.map((r) => {
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
        bucket: bucketFor(daysLeft),
      };
    });
    const digest_key = digestKeyFor(
      items.map((i) => ({ credentialId: i.credential_id, kind: i.kind, bucket: i.bucket })),
    );
    return { items, digest_key };
  },
});

export const deadlineTools: AnyToolDef[] = [deadlinesCompute, deadlinesUpcoming];
