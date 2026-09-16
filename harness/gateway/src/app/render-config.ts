import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseRouting } from '../domain/routing/parse.js';
import { renderLiteLlmConfig } from '../domain/routing/render.js';

const here = path.dirname(fileURLToPath(import.meta.url));
// harness/gateway/src/app -> harness/gateway
const packageRoot = path.resolve(here, '../..');
// harness/gateway/src/app -> the repository root
const repoRoot = path.resolve(here, '../../../..');

/**
 * Render one client's routing table into the LiteLLM config the Compose service mounts.
 *
 * The target stays at the package root, not beside this file: `docker-compose.yml` bind-mounts
 * `../gateway/litellm.config.yaml` and that path is part of the deployment, not of the source
 * layout.
 */
export async function renderClientConfig(client: string): Promise<string> {
  const source = path.join(repoRoot, 'clients', client, 'routing.yaml');
  const target = path.join(packageRoot, 'litellm.config.yaml');
  const routing = parseRouting(await readFile(source, 'utf8'));
  await writeFile(target, renderLiteLlmConfig(routing), 'utf8');
  return target;
}

const client = process.env.HARNESS_CLIENT ?? 'demo-practice';
renderClientConfig(client)
  .then((target) => {
    console.log(`rendered ${client} routing to ${target}`);
  })
  .catch((err: unknown) => {
    // parseRouting exists to turn an invalid routing.yaml into a readable
    // z.prettifyError listing. Without this, the rejection went unhandled
    // and the operator got a stack trace with that listing buried in it.
    process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  });
