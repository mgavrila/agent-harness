import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MemorySaver } from '@langchain/langgraph';
import { afterAll, beforeAll } from 'vitest';
import type { RunEvent, RuntimeSession } from '@harness/runtime-api';
import { runtimeConformance, startFakeGateway, type FakeGateway, type FakeReply } from '@harness/runtime-api/testing';
import { EventQueue } from './domain/events.js';
import { runDeepAgent } from './domain/run.js';

let gateway: FakeGateway;
let since = 0;

// The skill is written at module scope, not in `beforeAll`: the kit reads `harness.skills` while
// it is registering its cases, which is before any hook has run.
const skillsDir = mkdtempSync(path.join(tmpdir(), 'harness-conformance-'));
mkdirSync(path.join(skillsDir, 'credentialing-roster'));
writeFileSync(
  path.join(skillsDir, 'credentialing-roster', 'SKILL.md'),
  '---\nname: credentialing-roster\ndescription: roster\n---\n# Roster\n',
);

beforeAll(async () => {
  gateway = await startFakeGateway();
});
afterAll(async () => {
  await gateway.close();
  await rm(skillsDir, { recursive: true, force: true });
});

function script(replies: FakeReply[]): void {
  since = gateway.calls.length;
  let turn = 0;
  gateway.setResponder(() => {
    const reply = replies[Math.min(turn, replies.length - 1)];
    turn += 1;
    return reply;
  });
}

/** A session over a memory checkpointer whose model is pointed at the fake gateway. */
function session(): RuntimeSession {
  const checkpointer = new MemorySaver();
  const log = { info() {}, warn() {}, error() {} };
  return {
    name: 'deepagents',
    run(request) {
      const queue = new EventQueue<RunEvent>();
      void runDeepAgent(
        { ...request, model: { ...request.model, baseUrl: gateway.url } },
        { checkpointer, log },
        queue,
      );
      return { events: queue };
    },
    stop: async () => {},
  };
}

runtimeConformance('deepagents', {
  connect: async () => session(),
  script: (s) =>
    script([
      ...(s.skill
        ? [{ toolCalls: [{ name: 'read_file', arguments: { file_path: `/skills/${s.skill.name}/SKILL.md` } }] }]
        : []),
      { toolCalls: [{ name: s.toolCall.name, arguments: s.toolCall.args }] },
      { content: s.finalText },
    ]),
  hang: () => {
    since = gateway.calls.length;
    gateway.setResponder(() => new Promise<never>(() => {}));
  },
  modelRequests: () => gateway.calls.slice(since).map((c) => ({ user: c.user })),
  skills: [
    {
      name: 'credentialing-roster',
      version: '1.0.0',
      description: 'roster',
      dir: path.join(skillsDir, 'credentialing-roster'),
    },
  ],
});
