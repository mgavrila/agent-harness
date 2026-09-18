import { describe, it, expect, beforeEach } from 'vitest';
import { eq } from 'drizzle-orm';
import { auditLog, runs, toolEffects } from '@harness/db';
import { type ToolDeps } from '../domain/tooling/types.js';
import { openRun } from '../domain/session/repository.js';
import { TEST_PRINCIPAL, connectTestClient, makeTestDeps, resultOf, useTestDb } from '../testing.js';
import { createCoreToolsServer } from './catalog.js';

const db = useTestDb();
let deps: ToolDeps;

// Fresh deps per test: these tests assert on the session context these tools mutate.
beforeEach(() => {
  deps = makeTestDeps(db);
});

const connectServer = () => connectTestClient(() => createCoreToolsServer(deps));

/**
 * Every argument name a JSON Schema declares, at any depth.
 *
 * Names only, which is what invariant 1 is about: an enum *value* or a description that says
 * "principal" sets nothing, and since Plan 9 `memory_add` takes a `scope` whose two values are
 * exactly `principal` and `client`. An enum value is an array *element*, never an object key, so
 * collecting keys is what draws the line.
 *
 * Every other value is walked blindly rather than by a list of the keywords that may hold a
 * subschema. `anyOf` (what zod emits for `.nullable()` and `.union()`), `additionalProperties`
 * (`z.record()`), `prefixItems`, `$defs`, `allOf` and the rest are then covered without this
 * helper having to know their names — a walker that descended only `properties` and `items`
 * would let the first tool taking a union declare `principal_id` inside it and stay green.
 */
function argumentNames(schema: unknown): string[] {
  const names: string[] = [];
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node === null || typeof node !== 'object') return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if ((key === 'properties' || key === 'patternProperties') && value !== null && typeof value === 'object') {
        for (const [name, child] of Object.entries(value as Record<string, unknown>)) {
          names.push(name);
          walk(child);
        }
      } else walk(value);
    }
  };
  walk(schema);
  return names;
}

describe('run context and lineage', () => {
  it('stamps the run every audit row belongs to, from the context the run was opened with', async () => {
    const context = await openRun(db, { client: 'test', principal: TEST_PRINCIPAL });
    const withRun = makeTestDeps(db, { context });
    const client = await connectTestClient(() => createCoreToolsServer(withRun));
    await client.callTool({ name: 'providers_search', arguments: { query: 'nobody' } });
    const search = (await db.select().from(auditLog)).find((r) => r.tool === 'providers_search')!;
    expect(search.runId).toBe(context.runId);
    expect(search.caller).toBe('u-test');
    const [run] = await db.select().from(runs);
    expect(run).toMatchObject({ id: context.runId, principalId: 'u-test' });
  });

  it('publishes no tool that could set the run, the skill or the principal', async () => {
    const client = await connectServer();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).not.toContain('harness_set_context');
    // Invariant 1: identity comes only from whoever opened the run, never from an argument.
    for (const tool of tools) {
      for (const name of argumentNames(tool.inputSchema)) {
        expect(name, `${tool.name}.${name}`).not.toMatch(/principal|run_id/);
      }
    }
  });

  it('finds an argument name the schema hides inside a union, and ignores an enum value', () => {
    // The check above is only as good as the walker under it, and it passes today partly because
    // no published schema has a union in it yet. These two synthetic schemas pin both halves:
    // a name buried where zod puts a nullable object must be found, and `memory_add`'s `scope`
    // enum — whose value really is the word — must not be.
    const hidden = {
      type: 'object',
      properties: {
        target: {
          anyOf: [{ type: 'null' }, { type: 'object', properties: { principal_id: { type: 'string' } } }],
        },
      },
    };
    expect(argumentNames(hidden)).toContain('principal_id');
    const enumOnly = { type: 'object', properties: { scope: { type: 'string', enum: ['principal', 'client'] } } };
    for (const name of argumentNames(enumOnly)) expect(name).not.toMatch(/principal|run_id/);
  });

  it('stores derived_from on the audit row and strips it from handler args', async () => {
    const client = await connectServer();
    const first = await client.callTool({ name: 'providers_search', arguments: { query: 'a' } });
    expect(first.isError).toBeFalsy();
    const [firstAudit] = await db.select().from(auditLog);
    const second = await client.callTool({
      name: 'providers_search',
      arguments: { query: 'b', derived_from: [firstAudit.id] },
    });
    expect(second.isError).toBeFalsy();
    const rows = await db.select().from(auditLog);
    const secondAudit = rows.find((r) => r.id !== firstAudit.id)!;
    expect(secondAudit.derivedFrom).toEqual([firstAudit.id]);
    const q = await client.callTool({ name: 'audit_query', arguments: { tool: 'providers_search' } });
    const { entries } = resultOf<{ entries: { id: string; derived_from: string[] }[] }>(q);
    expect(entries.find((e) => e.id === secondAudit.id)!.derived_from).toEqual([firstAudit.id]);
  });

  it('stages a surface_message effect instead of sending', async () => {
    const client = await connectServer();
    const out = resultOf<{ effect_id: string; staged: boolean }>(
      await client.callTool({
        name: 'harness_notify',
        arguments: { text: '2 credentials expire within 90 days.', idempotency_key: 'expirations:2026-09-15' },
      }),
    );
    expect(out.staged).toBe(true);
    const [row] = await db.select().from(toolEffects);
    expect(row).toMatchObject({ sink: 'surface_message', tool: 'harness_notify', status: 'staged', client: 'test' });
    expect(row.idempotencyKey).toBe('test:expirations:2026-09-15');
    // The text is the payload, which is encrypted; the summary is a label.
    expect(row.payloadEncrypted.toString('utf8')).not.toContain('expire within 90 days');
    expect(row.summary).not.toContain('expire within 90 days');
  });

  it('addresses the effect to a named surface and conversation when the caller gives them', async () => {
    const client = await connectServer();
    await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-addressed', channel: 'memory', surface: 'memory' },
    });
    const [row] = await db.select().from(toolEffects);
    expect(row.sink).toBe('surface_message');
    // The payload is encrypted; what an operator can read is the sink and the summary.
    expect(row.summary).toBe('Message (8 characters)');
  });

  it('refuses a conversation id that is not a bare identifier', async () => {
    const client = await connectServer();
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-bad', channel: 'not a channel' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('stages the same digest once', async () => {
    const client = await connectServer();
    const args = { text: 'one item', idempotency_key: 'expirations:2026-09-15' };
    await client.callTool({ name: 'harness_notify', arguments: args });
    const second = resultOf<{ staged: boolean }>(await client.callTool({ name: 'harness_notify', arguments: args }));
    expect(second.staged).toBe(false);
    expect(await db.select().from(toolEffects)).toHaveLength(1);
  });

  it('refuses a message that looks like it carries a restricted identifier', async () => {
    const client = await connectServer();
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'Dr. Reyes SSN 123-45-6789 is on file', idempotency_key: 'x' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('refuses a conversation id that looks like a restricted identifier', async () => {
    const client = await connectServer();
    // `CONVERSATION_ID_PATTERN` admits this, because the kernel cannot know a surface's id
    // format. Nothing downstream would catch it: the id is stored in plaintext, and the adapter
    // that rejects it writes its complaint into the plaintext `tool_effects.last_error`.
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-ssn-channel', channel: '123-45-6789' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('refuses a surface name that looks like a restricted identifier', async () => {
    const client = await connectServer();
    // A DEA registration is two letters and seven digits, which `SURFACE_NAME_PATTERN` accepts.
    const res = await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k-dea-surface', surface: 'ab1234567' },
    });
    expect(res.isError).toBe(true);
    expect(await db.select().from(toolEffects)).toHaveLength(0);
  });

  it('records the lineage the caller declares', async () => {
    const client = await connectServer();
    const [earlier] = await db
      .insert(auditLog)
      .values({
        client: 'test',
        caller: 'test-caller',
        tool: 'deadlines_upcoming',
        actionClass: 'read',
        argsHash: 'h',
        decision: 'auto',
      })
      .returning();
    await client.callTool({
      name: 'harness_notify',
      arguments: { text: 'one item', idempotency_key: 'k', derived_from: [earlier.id] },
    });
    const rows = await db.select().from(auditLog).where(eq(auditLog.tool, 'harness_notify'));
    expect(rows[0].derivedFrom).toEqual([earlier.id]);
  });
});
