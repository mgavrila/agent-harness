import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
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
