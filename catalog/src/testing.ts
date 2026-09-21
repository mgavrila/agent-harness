import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { stringify } from 'yaml';

/** A minimal blueprint document that resolves under the v0.3.0 schema once a tenant supplies id and displayName. */
export function fixtureDocument(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    persona: 'You are the fixture assistant.\n',
    identity: {
      defaults: { web: 'member' },
      principals: [
        { id: 'svc-host', kind: 'service', level: 'service', displayName: 'Harness host' },
        { id: 'svc-playbooks', kind: 'service', level: 'service', displayName: 'Scheduled playbooks' },
        {
          id: 'svc-platform',
          kind: 'service',
          level: 'service',
          displayName: 'hf1 platform',
          surfaces: { http: 'platform' },
        },
      ],
    },
    policy: {
      classes: {
        read: 'auto',
        'write.internal': 'auto',
        external: 'approval',
        financial: 'blocked',
        destructive: 'approval',
      },
      tools: { hide: [] },
    },
    routing: {
      routes: {
        chat: { model: 'gemini/gemini-3-flash-preview' },
        extract: { model: 'gemini/gemini-3-flash-preview' },
        reason: { model: 'gemini/gemini-3-flash-preview' },
        judge: { model: 'groq/openai/gpt-oss-120b' },
        embed: { model: 'gemini/gemini-embedding-001' },
      },
    },
    playbooks: {
      playbooks: [
        {
          name: 'knowledge-sync',
          schedule: '0 7 * * *',
          timezone: 'UTC',
          skill: 'knowledge-sync',
          prompt: 'Refresh the knowledge base for today. Follow the skill exactly, including its silence rule.',
          principal: 'svc-playbooks',
          deliver: 'none',
          cost_cap_usd: 0.5,
          timeout_s: 300,
        },
      ],
    },
    skills: {},
    knowledge: { source: 'store' },
    surfaces: { web: { token: { ref: 'web-token' } }, http: {} },
    identityPlugin: { kind: 'static', settings: {} },
    runtime: 'deepagents',
    packs: [],
  };
}

export interface FixtureOptions {
  blueprintYaml?: string;
  lockset?: string[];
  version?: string;
}

/** Write `<tmp>/<name>/` as a blueprint directory and return `<tmp>`. */
export async function fixtureBlueprintDir(name: string, opts: FixtureOptions = {}): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'hf1-blueprints-'));
  const dir = path.join(root, name);
  await mkdir(path.join(dir, 'knowledge'), { recursive: true });
  const { persona, ...rest } = fixtureDocument();
  await writeFile(path.join(dir, 'persona.md'), persona as string);
  await writeFile(
    path.join(dir, 'blueprint.yaml'),
    opts.blueprintYaml ??
      [
        stringify(
          { version: opts.version ?? '1.0.0', lockset: opts.lockset ?? ['/routing'], document: rest },
          { lineWidth: 0 },
        ).trimEnd(),
        '  persona: !include persona.md',
        '',
      ].join('\n'),
  );
  await writeFile(
    path.join(dir, 'catalog.yaml'),
    stringify({
      displayName: 'Fixture',
      description: 'A fixture blueprint.',
      kernel: '0.3.0',
      surfaces: ['web'],
      inputs: [{ pointer: '/playbooks/playbooks/0/timezone', label: 'Timezone', example: 'Europe/Bucharest' }],
      pack: null,
    }),
  );
  await writeFile(path.join(dir, 'CHANGELOG.md'), `# ${name}\n\n## ${opts.version ?? '1.0.0'}\n\n- First version.\n`);
  await writeFile(path.join(dir, 'knowledge', 'welcome.md'), '# Welcome\n');
  return root;
}
