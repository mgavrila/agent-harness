import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunEvent, RunRequest, RunSkill, RuntimeSession } from './types.js';
import { RECORDS_SEARCH, fixtureRequest, toolServerFixture, type ToolServerFixture } from './tool-server.js';

export interface ConformanceScript {
  toolCall: { name: string; args: Record<string, unknown> };
  finalText: string;
  /** When set, the run activates this skill before its tool call; `harness.skills` must list it. */
  skill?: { name: string; version: string };
}

/**
 * What a runtime package tells the kit about itself. The kit knows the contract; the harness knows
 * how to make this runtime do one thing — a scripted runtime by its trajectory, a model-backed one
 * by scripting the fake gateway.
 */
export interface ConformanceHarness {
  connect(): Promise<RuntimeSession>;
  script(script: ConformanceScript): Promise<void> | void;
  hang(): Promise<void> | void;
  modelRequests?(): { user: string | undefined }[];
  skills?: readonly RunSkill[];
}

/** Every event of a run, in order, once it has ended: what a suite asserting on a whole run reads. */
export async function collectRunEvents(events: AsyncIterable<RunEvent>): Promise<RunEvent[]> {
  const out: RunEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

/**
 * The six rules of spec 4.2, as tests every runtime package registers with its own harness:
 * tools only through `request.tools`; no `process.env`; exactly one `done` or `error`; stops
 * within one model call of the signal aborting; `skill_activated` before the first tool call a
 * skill causes; `request.model.user` on every model request.
 */
export function runtimeConformance(name: string, harness: ConformanceHarness): void {
  describe(`runtime conformance: ${name}`, () => {
    let fixture: ToolServerFixture;
    let session: RuntimeSession;
    beforeEach(async () => {
      fixture = await toolServerFixture([RECORDS_SEARCH]);
      session = await harness.connect();
    });
    afterEach(async () => {
      await session.stop();
      await fixture.close();
    });

    const request = (over: Partial<RunRequest> = {}): RunRequest =>
      fixtureRequest({ tools: fixture.client, skills: harness.skills ?? [], ...over });

    it('calls tools only through request.tools, and reports each call once', async () => {
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'ada' } }, finalText: 'done' });
      const events = await collectRunEvents(session.run(request()).events);
      expect(fixture.calls).toEqual([{ name: 'records_search', args: { query: 'ada' } }]);
      expect(events.filter((e) => e.type === 'tool_call')).toHaveLength(1);
      expect(events.filter((e) => e.type === 'tool_result')).toEqual([
        { type: 'tool_result', name: 'records_search', status: 'ok' },
      ]);
    });

    it('reads none of the harness variables off process.env during a run', async () => {
      // The model SDKs read their own defaults (OPENAI_BASE_URL, tracing switches) off the
      // environment; the rule is about the runtime's *configuration*, which arrives on the
      // request and on `RuntimeDeps.env`, never off the ambient environment.
      const OURS = /^(HARNESS_|LITELLM_|DATABASE_URL$|APPROVALS_|SLACK_)/;
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'done' });
      // This is the rule's own assertion, not application code reading configuration: it wraps
      // the ambient environment to catch a runtime doing what the rule forbids, so the ban on
      // `process.env` syntax is the wrong shape for it and is suppressed for these three lines.
      /* eslint-disable no-restricted-syntax */
      const real = process.env;
      const reads: string[] = [];
      process.env = new Proxy(real, {
        get(target, key) {
          if (typeof key === 'string' && OURS.test(key)) reads.push(key);
          return Reflect.get(target, key) as string | undefined;
        },
      });
      try {
        await collectRunEvents(session.run(request()).events);
      } finally {
        process.env = real;
      }
      /* eslint-enable no-restricted-syntax */
      expect(reads).toEqual([]);
    });

    it('emits exactly one done or error, and done carries the final text', async () => {
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'All done.' });
      const events = await collectRunEvents(session.run(request()).events);
      const terminal = events.filter((e) => e.type === 'done' || e.type === 'error');
      expect(terminal).toEqual([{ type: 'done', text: expect.stringContaining('All done.') as string }]);
      expect(events.at(-1)).toBe(terminal[0]);
    });

    it('stops within one model call of the signal aborting, with a single error event', async () => {
      await harness.hang();
      const controller = new AbortController();
      const handle = session.run(request({ signal: controller.signal }));
      const iterator = handle.events[Symbol.asyncIterator]();
      const first = iterator.next();
      setTimeout(() => controller.abort(), 50);
      const events: RunEvent[] = [];
      let result = await first;
      while (!result.done) {
        events.push(result.value);
        result = await iterator.next();
      }
      expect(events.filter((e) => e.type === 'error')).toEqual([{ type: 'error', message: 'cancelled' }]);
      expect(events.some((e) => e.type === 'done')).toBe(false);
      if (harness.modelRequests) expect(harness.modelRequests().length).toBeLessThanOrEqual(1);
    });

    it('announces a skill before the first tool call its body causes', async () => {
      if (!harness.skills?.length) return;
      const skill = harness.skills[0];
      await harness.script({
        toolCall: { name: 'records_search', args: { query: 'x' } },
        finalText: 'done',
        skill: { name: skill.name, version: skill.version },
      });
      const events = await collectRunEvents(session.run(request()).events);
      const activated = events.findIndex((e) => e.type === 'skill_activated');
      const firstCall = events.findIndex((e) => e.type === 'tool_call');
      expect(activated).toBeGreaterThanOrEqual(0);
      expect(activated).toBeLessThan(firstCall);
      expect(events[activated]).toEqual({ type: 'skill_activated', name: skill.name, version: skill.version });
    });

    it('sends request.model.user on every model request', async () => {
      if (!harness.modelRequests) return;
      await harness.script({ toolCall: { name: 'records_search', args: { query: 'x' } }, finalText: 'done' });
      await collectRunEvents(
        session.run(request({ model: { baseUrl: 'unused', apiKey: 'sk', route: 'chat', user: 'u-conformance' } }))
          .events,
      );
      const requests = harness.modelRequests();
      expect(requests.length).toBeGreaterThan(0);
      for (const r of requests) expect(r.user).toBe('u-conformance');
    });
  });
}
