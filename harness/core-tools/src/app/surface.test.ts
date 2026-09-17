import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import { CONVERSATION_ID_PATTERN, SURFACE_NAME_PATTERN } from '@harness/pack-api';
import {
  ARCHITECTURE_DIR,
  envNamesFromExample,
  readComposeSurface,
  readEnvNames,
  readToolSurface,
  type ToolSurfaceEntry,
} from './record-surface.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
const architecture = path.join(repoRoot, ARCHITECTURE_DIR);

/**
 * Names that must appear in the environment scan. They are here to catch the scan breaking
 * silently: DATABASE_URL is a bare `process.env.X`, APPROVALS_POLL_SECONDS is only reachable
 * through the `seconds()` wrapper, and VERIFY_NPPES_ENABLED only through `booleanFromEnv`.
 * If a refactor moves a read out of reach of every pattern, this fails instead of the whole
 * check quietly passing on an empty list.
 */
const SCAN_ANCHORS = [
  'DATABASE_URL',
  'LITELLM_MASTER_KEY',
  'HARNESS_STORAGE_DIR',
  'VERIFY_NPPES_ENABLED',
  'APPROVALS_POLL_SECONDS',
  'SLACK_APPROVALS_CHANNEL',
];

describe('public surface', () => {
  it('publishes exactly the recorded MCP tools, with the recorded schemas', async () => {
    const recorded = JSON.parse(
      await readFile(path.join(architecture, 'tool-surface.json'), 'utf8'),
    ) as ToolSurfaceEntry[];
    expect(await readToolSurface()).toEqual(recorded);
  }, 30_000);

  it('reads no environment variable that .env.example does not document', async () => {
    const read = await readEnvNames(repoRoot);
    for (const anchor of SCAN_ANCHORS) expect(read).toContain(anchor);
    const documented = await envNamesFromExample(path.join(repoRoot, '.env.example'));
    expect(read.filter((name) => !documented.includes(name))).toEqual([]);
  });

  it('renders the Compose config the repository recorded, with no secret in it', async () => {
    const rendered = await readComposeSurface(repoRoot);
    // --no-interpolate leaves every ${VAR} unexpanded, so a real key can only appear here if
    // someone hard-coded one into the compose file.
    expect(rendered).not.toMatch(/AIza[0-9A-Za-z_-]{10}|sk-[0-9A-Za-z]{16}|xox[baps]-/);
    expect(rendered).toBe(await readFile(path.join(architecture, 'compose-surface.yaml'), 'utf8'));
  }, 60_000);
});

/**
 * Plan 6 changed the recorded tool surface in four places and in no others.
 *
 * Stated as four properties rather than as a diff against a second committed copy of the
 * snapshot: a copy is a file that has to be updated twice forever, and the first time someone
 * updates one of the two it stops being evidence of anything.
 *
 * Plan 7 removed one tool, `harness_set_context`, and nothing else: identity and the run are
 * bound by whoever opens the session, so there is no tool to set them.
 */
const RECORDED_TOOLS = [
  'approvals_execute',
  'audit_query',
  'deadlines_compute',
  'deadlines_upcoming',
  'documents_classify',
  'documents_extract',
  'documents_get',
  'documents_ingest',
  'documents_list',
  'forms_fill',
  'forms_list_templates',
  'forms_release',
  'forms_roster',
  'harness_notify',
  'harness_reconcile',
  'providers_confirm_field',
  'providers_get',
  'providers_list_pending',
  'providers_search',
  'providers_upsert',
  'verify_nppes',
  'verify_state_license',
];

type InputSchema = { properties: Record<string, { pattern?: string }>; required?: string[] };

describe('the four places Plan 6 moved the tool surface', () => {
  const recorded = async (): Promise<ToolSurfaceEntry[]> =>
    JSON.parse(await readFile(path.join(architecture, 'tool-surface.json'), 'utf8')) as ToolSurfaceEntry[];

  it('publishes the twenty-two tools of Plan 6 less harness_set_context, which Plan 7 deleted', async () => {
    expect((await recorded()).map((tool) => tool.name)).toEqual(RECORDED_TOOLS);
  });

  it('carries no Slack channel id shape anywhere, which is what this plan was for', async () => {
    expect(JSON.stringify(await recorded())).not.toContain('[CGD]');
  });

  it('validates both `channel` arguments as a neutral conversation id', async () => {
    const entries = await recorded();
    for (const name of ['forms_release', 'harness_notify']) {
      const schema = entries.find((tool) => tool.name === name)?.inputSchema as InputSchema;
      expect(schema.properties.channel.pattern, name).toBe(CONVERSATION_ID_PATTERN.source);
    }
  });

  it('adds one optional `surface` argument, to exactly those two tools', async () => {
    const withSurface = (await recorded()).filter((tool) => 'surface' in (tool.inputSchema as InputSchema).properties);
    expect(withSurface.map((tool) => tool.name)).toEqual(['forms_release', 'harness_notify']);
    for (const tool of withSurface) {
      const schema = tool.inputSchema as InputSchema;
      expect(schema.properties.surface.pattern).toBe(SURFACE_NAME_PATTERN.source);
      expect(schema.required ?? []).not.toContain('surface');
    }
  });
});
