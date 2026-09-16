import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));

const arg = (name: string): string | undefined => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
};

const outDir = path.resolve(arg('out') ?? path.join(here, 'out'));
const truth = await generate({
  outDir,
  count: Number(arg('count') ?? 20),
  seed: Number(arg('seed') ?? 20260915),
  scans: arg('scans') !== 'false',
});
console.log(
  `generated ${truth.providers.length} providers and ${truth.documents.length} documents in ${outDir}\n` +
    `FABRICATED DATA. The NPIs are check-digit valid but are not registered; NPPES will not find them.`,
);
