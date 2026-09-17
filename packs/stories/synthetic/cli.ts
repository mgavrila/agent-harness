import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generate } from './generate.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? path.join(here, 'out');
const written = await generate({ outDir });
console.error(`wrote ${written.length} documents into ${outDir}`);
