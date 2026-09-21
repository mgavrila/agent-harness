import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '@harness/shared';

interface Marker {
  $include: string;
}

const isMarker = (v: unknown): v is Marker =>
  typeof v === 'object' && v !== null && typeof (v as Marker).$include === 'string';

function isInside(target: string, root: string): boolean {
  const rel = path.relative(root, target);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

async function readIncluded(relative: string, realRoot: string): Promise<string> {
  const outside = new ConfigError(`!include "${relative}" is outside the blueprint directory`);
  const target = path.resolve(realRoot, relative);
  if (!isInside(target, realRoot)) throw outside;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    throw new ConfigError(`!include "${relative}" cannot be read`);
  }
  if (!isInside(real, realRoot)) throw outside;
  try {
    return await readFile(real, 'utf8');
  } catch {
    throw new ConfigError(`!include "${relative}" cannot be read`);
  }
}

async function expand(node: unknown, realRoot: string): Promise<unknown> {
  if (isMarker(node)) return readIncluded(node.$include, realRoot);
  if (Array.isArray(node)) return Promise.all(node.map((n) => expand(n, realRoot)));
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node)) out[k] = await expand(v, realRoot);
    return out;
  }
  return node;
}

const TAGS = [
  {
    tag: '!include',
    identify: () => false,
    resolve: (value: unknown) => {
      if (typeof value !== 'string' || value.trim() === '')
        throw new ConfigError('!include takes one path, as a plain string');
      return { $include: value.trim() } satisfies Marker;
    },
  },
  ...(['seq', 'map'] as const).map((collection) => ({
    tag: '!include',
    collection,
    resolve: () => {
      throw new ConfigError('!include takes one path, as a plain string');
    },
  })),
];

/** Parse a YAML file, expanding every `!include <path>` from the file's own directory. */
export async function parseWithIncludes(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    throw new ConfigError(`cannot read ${path.basename(file)}`);
  }
  const realRoot = await realpath(path.dirname(file));
  const parsed: unknown = parseYaml(text, { customTags: TAGS });
  return expand(parsed, realRoot);
}
