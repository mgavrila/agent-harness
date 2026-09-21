import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { parseClientDocument } from '@harness/config-api';
import { fixtureDocument } from '@harness/config-api/testing';
import { describeError } from '@harness/shared';
import { localParser } from '../domain/documents/parser.js';
import { connectInProcess } from '../domain/tooling/in-process.js';
import { DEFAULT_POLICY } from '../domain/tooling/policy.js';
import { DEFAULT_CONFIDENCE_THRESHOLD, type ToolDeps } from '../domain/tooling/types.js';
import { PACK_KERNEL } from '../domain/packs/kernel.js';
import { loadPacks } from '../domain/packs/registry.js';
import { createCoreToolsServer } from '../tools/catalog.js';

const run = promisify(execFile);

/** Where both snapshots live, relative to the repository root. */
export const ARCHITECTURE_DIR = 'docs/architecture';

export interface ToolSurfaceEntry {
  name: string;
  inputSchema: unknown;
  outputSchema: unknown;
}

/**
 * Dependencies good enough to *register* every tool and no further. `registerTools` writes
 * each definition into `deps.tools` and reads its schemas; it never calls a handler, so
 * nothing below is ever used. The database handle is a null cast on purpose: recording the
 * public surface must not need Postgres, or the snapshot could not be regenerated offline.
 */
export async function surfaceDeps(): Promise<ToolDeps> {
  // A fixture document rather than an environment, deliberately: the committed snapshot has to
  // describe the shipped default, not whatever the machine recording it happens to have
  // configured. Its `packs` names the one shipped pack and its `policy.tools.hide` is empty, so
  // the recorded catalogue is the whole catalogue — which is also why `tools.hide` can never
  // move this file.
  const document = parseClientDocument(fixtureDocument({ id: 'surface', displayName: 'Surface recorder' }));
  const packs = await loadPacks(document.packs);
  return {
    db: null as unknown as ToolDeps['db'],
    client: document.id,
    principal: {
      id: 'svc-surface',
      kind: 'service',
      level: 'service',
      displayName: 'Surface recorder',
      surfaces: {},
      attributes: {},
    },
    policy: { ...DEFAULT_POLICY },
    hiddenTools: document.policy.tools.hide,
    encryptionKey: Buffer.alloc(32),
    now: () => new Date('2026-01-01T00:00:00Z'),
    approvalTtlHours: 24,
    confidenceThreshold: DEFAULT_CONFIDENCE_THRESHOLD,
    gateway: { baseUrl: 'http://127.0.0.1:1', apiKey: 'unused', timeoutMs: 1_000, maxCallsPerRun: 1 },
    storageDir: '/nonexistent/surface',
    knowledgeDir: null,
    embedDims: 1_024,
    parser: localParser('/nonexistent/surface'),
    formsDir: '/nonexistent/surface',
    restrictedToModel: false,
    sinks: {},
    context: { runId: null, threadId: null, surface: null, conversation: null },
    tools: new Map(),
    kernelTools: new Map(),
    kernel: PACK_KERNEL,
    packs,
    // Empty for the same reason the pack list above is a literal: the snapshot has to describe
    // the shipped default, not the machine recording it. A pack builds its catalogue from this
    // map, so an empty one is "nothing configured" — every flag a pack reads falls to its own
    // default, and every one of those defaults to off. Recording calls no handler, so nothing
    // here could reach a network in any case.
    env: {},
  };
}

/**
 * Every MCP tool this server publishes, with the JSON Schema a client actually receives —
 * not the zod object, the resolved schema, because that is what an agent reads and what a
 * rename or a widened field would change.
 */
export async function readToolSurface(): Promise<ToolSurfaceEntry[]> {
  const deps = await surfaceDeps();
  const { client, close } = await connectInProcess(() => createCoreToolsServer(deps));
  try {
    const { tools } = await client.listTools();
    return (tools as { name: string; inputSchema: unknown; outputSchema?: unknown }[])
      .map((tool) => ({
        name: tool.name,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema ?? null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name));
  } finally {
    await close();
  }
}

/**
 * The rendered Compose config.
 *
 * `--no-interpolate --no-path-resolution` is what makes this snapshot-able at all, and both
 * flags are load-bearing:
 *
 *   - Without `--no-interpolate`, Compose refuses to render (`required variable
 *     LITELLM_MASTER_KEY is missing a value`) unless a filled-in `.env` exists — and when one
 *     does, the agent runtime service's `env_file: ../../.env` copies the developer's real API
 *     keys straight into the output. Nothing like that can be committed.
 *   - Without `--no-path-resolution`, every bind mount is rewritten to an absolute host path,
 *     so the snapshot differs on every machine.
 *
 * The `demo` profile is needed because `config` omits services whose profile is not enabled, and
 * every service but `postgres` and `litellm` has one.
 */
export async function readComposeSurface(repoRoot: string): Promise<string> {
  try {
    const { stdout } = await run(
      'docker',
      [
        'compose',
        '-f',
        'harness/compose/docker-compose.yml',
        '--profile',
        'demo',
        'config',
        '--no-interpolate',
        '--no-path-resolution',
      ],
      { cwd: repoRoot, timeout: 60_000, maxBuffer: 8 * 1024 * 1024 },
    );
    return stdout;
  } catch (err) {
    throw new Error(
      `could not render the Compose config. The docker CLI has to be on PATH; the stack does not have to be running. ${describeError(err)}`,
    );
  }
}

/**
 * Helpers whose first argument is the name of an environment variable. The scan below reads
 * their call sites as well as direct member reads off `process.env`, because after the shared
 * env module lands most reads go through one of these and a scan that only looked for the
 * direct form would see almost nothing. Add a wrapper here when you add one to the code.
 *
 * Note for whoever edits the prose in this file: the scan regexes are applied to every
 * non-test source file, this one included, so a comment that spells out a direct
 * `process.env` member read would be picked up as a variable of that name and reported as
 * undocumented. Describe the pattern instead of writing it out.
 */
export const ENV_READING_HELPERS = [
  'numberFromEnv',
  'booleanFromEnv',
  'requiredEnv',
  'optionalEnv',
  'envOrDefault',
  'required',
  'seconds',
  'port',
] as const;

/**
 * The directories the environment scan walks. This is every place shipping kernel TypeScript
 * lives today. `clients/` and the repository root are absent because neither holds a `.ts` file —
 * `clients/` is the one fixture client document and what it includes, and the root holds only
 * config. Add the directory here if you put source in
 * either, or the variables it reads will go unrecorded and the `.env.example` check will pass
 * while missing them. `surfaces/` is there for the same reason `packs/` is: an adapter reads its
 * own variables, and a scan that did not walk it would let them go undocumented — including the
 * primary adapter's conversation variable, which `surface.test.ts` anchors on. `identities/` is
 * there for the same reason `surfaces/` is: a directory-backed identity plug-in reads its own
 * secret off `deps.env` through the shared helpers, the way `identities/static` no longer needs
 * to now that its section arrives through `IdentityDeps.identity`. `runtimes/` is there for the
 * same reason again: a runtime plug-in reads its configuration off `RuntimeDeps.env` rather than
 * the ambient environment, and the scan walks it so that a variable it reads is documented like
 * every other one.
 *
 * **The platform's directories are outside this list and stay outside it** (spec section 12,
 * constraint 16): `catalog/`, `control-plane/`, `apps/` and `deploy/` document their own
 * variables, and pulling them in here would put a product's configuration into the OS's
 * contract. Exported so `surface.test.ts` can assert the list rather than trust it.
 */
export const SOURCE_ROOTS = ['harness', 'packs', 'surfaces', 'identities', 'runtimes', 'evals', 'scripts'];
const DIRECT_ENV = /process\.env\.([A-Z][A-Z0-9_]*)/g;
const INDEXED_ENV = /process\.env\[\s*'([A-Z][A-Z0-9_]*)'\s*\]/g;
const HELPER_ENV = new RegExp(
  String.raw`\b(?:${ENV_READING_HELPERS.join('|')})\(\s*(?:env,\s*)?'([A-Z][A-Z0-9_]*)'`,
  'g',
);

async function sourceFiles(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await sourceFiles(full)));
    else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) found.push(full);
  }
  return found;
}

/** Every environment variable name the shipping code reads, sorted and deduplicated. */
export async function readEnvNames(repoRoot: string): Promise<string[]> {
  const names = new Set<string>();
  for (const root of SOURCE_ROOTS) {
    for (const file of await sourceFiles(path.join(repoRoot, root))) {
      const text = await readFile(file, 'utf8');
      for (const pattern of [DIRECT_ENV, INDEXED_ENV, HELPER_ENV]) {
        for (const match of text.matchAll(pattern)) names.add(match[1]);
      }
    }
  }
  return [...names].sort();
}

/** Every name `.env.example` documents, commented-out lines included. */
export async function envNamesFromExample(file: string): Promise<string[]> {
  const text = await readFile(file, 'utf8');
  const names = new Set<string>();
  for (const line of text.split('\n')) {
    const match = /^#?\s*([A-Z][A-Z0-9_]*)=/.exec(line.trim());
    if (match) names.add(match[1]);
  }
  return [...names].sort();
}

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../../../..');

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const outDir = path.join(repoRoot, ARCHITECTURE_DIR);
  await mkdir(outDir, { recursive: true });
  const tools = await readToolSurface();
  await writeFile(path.join(outDir, 'tool-surface.json'), `${JSON.stringify(tools, null, 2)}\n`, 'utf8');
  await writeFile(path.join(outDir, 'compose-surface.yaml'), await readComposeSurface(repoRoot), 'utf8');
  console.error(`recorded ${tools.length} tools and the compose config into ${ARCHITECTURE_DIR}/`);
}
