import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigError, describeError } from '@harness/shared';
import { isInside } from './confine.js';

/** The tag a client file uses to pull a long string out into a file beside it: `!include persona.md`. */
export const INCLUDE_TAG = 'include';

/** What the custom tag leaves in the parsed tree, for the walk below to replace. */
interface IncludeMarker {
  $include: string;
}

function isMarker(value: unknown): value is IncludeMarker {
  return typeof value === 'object' && value !== null && typeof (value as IncludeMarker).$include === 'string';
}

/** What a refused or unreadable include says, whatever went wrong. Never an absolute path. */
const UNREADABLE = 'cannot be read; it is missing, or the host may not read it';

/**
 * `<client-id>/<file>` — enough for an operator to find the file, never the host's absolute path.
 * Applies to the client document itself, not just its includes: a YAML syntax error is the single
 * most tenant-provokable failure in this package.
 */
function relativeName(file: string): string {
  return path.join(path.basename(path.dirname(file)), path.basename(file));
}

/**
 * Read one relative path, refusing anything that leaves the client's own directory.
 *
 * A client document is written by a tenant, and a tenant is not trusted to name a file: an
 * `!include /etc/passwd` or an `!include ../../other-tenant/client.yaml` would make the persona
 * of one client whatever it could reach on the host's filesystem.
 *
 * The check is on the **real** path of both sides, not on the resolved strings. A string check
 * catches `../b` and `a/../../b`, and misses the one that matters: a symlink sitting inside the
 * client's own directory and pointing out of it resolves to a string under the root while naming
 * a file anywhere the host can read. `realpath` collapses the link before the comparison, so the
 * two are the same question. The root is resolved for a second reason as well — a temporary
 * directory is itself a symlink on macOS, and comparing a real target against an unreal root
 * would refuse every legitimate include under one.
 *
 * A failure names the path the *document* wrote and never the one the host resolved: an error a
 * tenant can provoke is not a place to publish the host's filesystem layout.
 */
async function readIncluded(relative: string, realRoot: string): Promise<string> {
  const outside = new ConfigError(`!include "${relative}" is outside the client directory`);
  // Twice, on two different things, because neither check subsumes the other. This one is on the
  // literal path and answers even when nothing is there, so `!include ../../../etc/passwd` is
  // refused as an escape rather than reported as a missing file.
  const target = path.resolve(realRoot, relative);
  if (!isInside(target, realRoot)) throw outside;
  let real: string;
  try {
    real = await realpath(target);
  } catch {
    // Missing, unreadable, or a symlink loop — one answer for all three, because telling a tenant
    // which is which is telling them what is on the host.
    throw new ConfigError(`!include "${relative}" ${UNREADABLE}`);
  }
  // And this one is on the real path, which is the only one that sees through a link.
  if (!isInside(real, realRoot)) throw outside;
  try {
    // A tenant who can write into their own directory while this read is in flight can still
    // replace `real` with a symlink between the check above and this read, so this window is
    // real, not merely theoretical. Left open rather than closed: the clients directory is
    // operator-provisioned infrastructure, and closing it fully needs a per-component `openat`,
    // which Node does not expose — an `O_NOFOLLOW` open would close the easy version of it, if
    // this residual ever needs to go.
    return await readFile(real, 'utf8');
  } catch {
    throw new ConfigError(`!include "${relative}" ${UNREADABLE}`);
  }
}

async function expand(node: unknown, realRoot: string): Promise<unknown> {
  if (isMarker(node)) return readIncluded(node.$include, realRoot);
  if (Array.isArray(node)) return Promise.all(node.map((entry) => expand(entry, realRoot)));
  if (typeof node === 'object' && node !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(node)) out[key] = await expand(value, realRoot);
    return out;
  }
  return node;
}

/**
 * The tag, in the three node kinds a document can spell it as.
 *
 * `yaml` picks a custom tag by the node's kind, so a scalar `!include persona.md` and a
 * `!include [a, b]` are two different entries. The two collection forms exist only to refuse:
 * `!include` takes one path, and a person who wrote a list or a map after it means something the
 * format does not offer, which is better said here than silently parsed as a list.
 */
const INCLUDE_TAGS = [
  {
    tag: `!${INCLUDE_TAG}`,
    identify: () => false,
    resolve: (value: unknown) => {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(`!${INCLUDE_TAG} takes one path, as a plain string`);
      }
      return { $include: value.trim() } satisfies IncludeMarker;
    },
  },
  ...(['seq', 'map'] as const).map((collection) => ({
    tag: `!${INCLUDE_TAG}`,
    collection,
    resolve: () => {
      throw new ConfigError(`!${INCLUDE_TAG} takes one path, as a plain string`);
    },
  })),
];

/**
 * Parse a YAML file, then replace every `!include <path>` with the contents of that file.
 *
 * Two passes rather than one, because the `yaml` package's custom tags are synchronous and a
 * file read is not. The tag's `resolve` therefore leaves a marker and this walks the tree.
 *
 * The parse is bracketed because `yaml` re-wraps anything a `resolve` throws in a
 * `YAMLParseError` of its own, so the `ConfigError` above would not survive the call. Wrapping
 * it back is what makes every failure of this function one kind of error — which is what it
 * should be, since every one of them is something a tenant wrote.
 */
export async function parseWithIncludes(file: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch {
    // Not `describeError(err)`: Node's own ENOENT/EACCES message embeds the absolute path it
    // tried, which is exactly what an error a tenant can provoke must not publish.
    throw new ConfigError(`cannot read ${relativeName(file)}: ${UNREADABLE}`);
  }
  // Once, here, rather than once per include: the directory is the same for every one of them,
  // and this is the side of the comparison the host owns rather than the tenant. Guarded even
  // though `readFile` above fails first in practice for a missing or unreadable directory — this
  // way every failure of this function is genuinely one kind of error, not just usually one.
  let realRoot: string;
  try {
    realRoot = await realpath(path.dirname(file));
  } catch {
    throw new ConfigError(`cannot resolve the directory for ${relativeName(file)}: ${UNREADABLE}`);
  }
  let raw: unknown;
  try {
    raw = parseYaml(text, { customTags: INCLUDE_TAGS });
  } catch (err) {
    throw new ConfigError(`${relativeName(file)} is not a valid client file: ${describeError(err)}`);
  }
  return expand(raw, realRoot);
}
