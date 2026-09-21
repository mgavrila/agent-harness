import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { DeploymentCatalogue } from '../domain/routing/catalogue.js';
import { renderLiteLlmConfig } from '../domain/routing/render.js';

// harness/gateway/src/app -> harness/gateway. Both files stay at the package root because
// docker-compose.yml bind-mounts `../gateway/litellm.config.yaml`: that path is part of the
// deployment, not of the source layout. Nothing here resolves a *client* from a package path,
// and nothing here reads a client at all — the catalogue is the deployment's, not a tenant's.
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** Render the deployment catalogue into the LiteLLM config the Compose service mounts. */
export async function renderCatalogueConfig(): Promise<string> {
  const source = path.join(packageRoot, 'catalogue.yaml');
  const catalogue = DeploymentCatalogue.parse(parseYaml(await readFile(source, 'utf8')));
  const target = path.join(packageRoot, 'litellm.config.yaml');
  await writeFile(target, renderLiteLlmConfig(catalogue), 'utf8');
  return target;
}

/**
 * `pnpm gateway:config`.
 *
 * No client, no config source and no database: the deployments a gateway serves are the
 * deployment's own configuration, and every tenant on this host names them from its document.
 */
async function main(): Promise<void> {
  const target = await renderCatalogueConfig();
  console.log(`rendered the deployment catalogue to ${target}`);
}

main().catch((err: unknown) => {
  // The schema exists to turn an invalid catalogue into a readable listing; without this the
  // rejection went unhandled and the operator got a stack trace with the listing buried.
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
