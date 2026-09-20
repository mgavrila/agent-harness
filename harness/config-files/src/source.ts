import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { access, readdir, realpath } from 'node:fs/promises';
import path from 'node:path';
import {
  migrate,
  resolve as resolveOverlay,
  type Blueprint,
  type ClientDocument,
  type ConfigSource,
  type LoadedDocument,
  type Overlay,
} from '@harness/config-api';
import { ConfigError, describeError, type Logger } from '@harness/shared';
import { parseWithIncludes } from './include.js';

/** How long a burst of filesystem events is allowed to settle before the document is re-read. */
export const WATCH_DEBOUNCE_MS = 200;

/** A client id is a path segment; this is the same shape the document schema enforces. */
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

async function exists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/**
 * The version of a resolved document: the first sixteen hex characters of the SHA-256 of its
 * canonical JSON.
 *
 * Content-addressed rather than a modification time, so an edit that changes nothing does not
 * evict a tenant, an included markdown file that changes *does*, and two hosts reading the same
 * directory agree on what version they are serving.
 */
function versionOf(document: unknown): string {
  return createHash('sha256').update(JSON.stringify(document), 'utf8').digest('hex').slice(0, 16);
}

/**
 * A client's knowledge directory, as an absolute path under the client's own directory.
 *
 * The document says `knowledge: { source: 'dir', path: knowledge }` — a path *relative to the
 * client*, because a document is portable and a tenant does not know where the host mounted it.
 * The path is written by a tenant, and `../../other-tenant/knowledge` would hand one client's
 * documents to another, so it is confined to the client's own directory exactly as `readIncluded`
 * confines an `!include`: twice, on two different things, because neither check subsumes the
 * other. An absolute path is accepted only when it already lies inside that directory.
 *
 * The literal path is checked first, so `../../../etc` is refused as an escape rather than
 * reported as a missing directory. Then both sides are collapsed with `realpath` and compared
 * again, because the string check misses the one that matters: a symlink sitting inside the
 * client's own directory and pointing out of it resolves to a string under the root while naming
 * a directory anywhere the host can read, and the kernel would then index another tenant's
 * documents (invariant 13). The root is resolved for a second reason as well — a temporary
 * directory is itself a symlink on macOS, and comparing a real target against an unreal root
 * would refuse every legitimate knowledge folder under one.
 *
 * A directory that cannot be resolved gets one answer for missing, unreadable and a symlink loop,
 * for `readIncluded`'s reason: telling a tenant which of the three it is tells them what is on
 * the host. Neither failure names a host path, for the same reason the id mismatch does not.
 *
 * What is handed back is the path as the mount spells it, not the one `realpath` returned: the
 * link is what this deployment configured, reading through it lands where the check looked, and a
 * canonical path would make the document's version depend on how the host happened to mount it.
 * The residual is `readIncluded`'s residual — a tenant who can write into their own directory can
 * replace the link between this check and the read — and it is open for the same reason.
 */
async function knowledgeAbsolute(document: ClientDocument, dir: string): Promise<ClientDocument> {
  if (document.knowledge.source !== 'dir') return document;
  const written = document.knowledge.path;
  const outside = new ConfigError(
    `client "${document.id}": knowledge.path "${written}" is outside the client directory`,
  );
  const root = path.resolve(dir);
  const target = path.resolve(root, written);
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) throw outside;
  let realRoot: string;
  let real: string;
  try {
    realRoot = await realpath(root);
    real = await realpath(target);
  } catch {
    throw new ConfigError(
      `client "${document.id}": knowledge.path "${written}" cannot be read; it is missing, or the host may not read it`,
    );
  }
  if (real !== realRoot && !real.startsWith(`${realRoot}${path.sep}`)) throw outside;
  return { ...document, knowledge: { source: 'dir', path: target } };
}

export interface FilesConfigSourceOptions {
  /** `HARNESS_CLIENTS_DIR`: one directory holding one sub-directory per client. */
  root: string;
  log: Logger;
  watchDebounceMs?: number;
}

/**
 * Client documents from a directory outside this repository.
 *
 * `<root>/<id>/client.yaml` is the whole document. `<root>/<id>/blueprint.yaml` plus
 * `<root>/<id>/overlay.yaml` is a catalogue entry and a tenant's edits, resolved here under the
 * blueprint's lock set — which is the shape the platform writes, and the shape a
 * `ConfigError` names a locked path from.
 *
 * This is the source a dedicated deployment runs: a mounted volume, a tenant per directory, and
 * nothing in this repository that names any of them.
 */
export function filesConfigSource(opts: FilesConfigSourceOptions): ConfigSource {
  const root = path.resolve(opts.root);
  const debounceMs = opts.watchDebounceMs ?? WATCH_DEBOUNCE_MS;

  const dirFor = (clientId: string): string => {
    if (!CLIENT_ID.test(clientId)) throw new ConfigError(`"${clientId}" is not a client id`);
    return path.join(root, clientId);
  };

  const read = async (clientId: string): Promise<LoadedDocument | null> => {
    const dir = dirFor(clientId);
    const blueprintFile = path.join(dir, 'blueprint.yaml');
    let document: LoadedDocument['document'];
    let sourceFile: string;
    if (await exists(blueprintFile)) {
      const blueprint = (await parseWithIncludes(blueprintFile)) as Blueprint;
      const overlayFile = path.join(dir, 'overlay.yaml');
      const overlay = (await exists(overlayFile))
        ? ((await parseWithIncludes(overlayFile)) as Overlay)
        : ({ patch: [], version: 'empty' } satisfies Overlay);
      document = await knowledgeAbsolute(resolveOverlay(blueprint, overlay), dir);
      sourceFile = overlayFile;
    } else {
      const file = path.join(dir, 'client.yaml');
      if (!(await exists(file))) return null;
      document = await knowledgeAbsolute(migrate(await parseWithIncludes(file)), dir);
      sourceFile = file;
    }
    if (document.id !== clientId) {
      // Relative to the client's own directory, never the host's absolute path: this is an error
      // a tenant's own overlay or client.yaml can provoke.
      const relativeSourceFile = path.join(clientId, path.basename(sourceFile));
      throw new ConfigError(
        `${relativeSourceFile} declares id "${document.id}" but lives in the directory "${clientId}"`,
      );
    }
    return { document, version: versionOf(document) };
  };

  return {
    name: 'files',

    async load(clientId) {
      return read(clientId);
    },

    watch(clientId, onChange) {
      const dir = dirFor(clientId);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let last: string | null = null;
      let watcher: FSWatcher;
      const reload = (): void => {
        void read(clientId)
          .then((loaded) => {
            if (!loaded || loaded.version === last) return;
            last = loaded.version;
            onChange(loaded.version);
          })
          .catch((err: unknown) => {
            // A half-saved file is a normal thing to see mid-edit. The tenant in the pool keeps
            // the version it has, and the next event re-reads; a load that still fails when a
            // turn asks for it fails loudly there, where somebody is waiting for an answer.
            opts.log.warn(`config-files: ${clientId} changed but did not parse: ${describeError(err)}`);
          });
      };
      try {
        watcher = watch(dir, { recursive: true }, () => {
          if (timer) clearTimeout(timer);
          timer = setTimeout(reload, debounceMs);
          timer.unref?.();
        });
      } catch (err) {
        throw new ConfigError(`config-files: cannot watch ${dir}: ${describeError(err)}`);
      }
      // Seed the version so the first change is compared against what is on disk now rather
      // than reported as a change from nothing.
      void read(clientId)
        .then((loaded) => {
          last = loaded?.version ?? null;
        })
        .catch(() => {});
      return () => {
        if (timer) clearTimeout(timer);
        watcher.close();
      };
    },

    async list() {
      const entries = await readdir(root, { withFileTypes: true }).catch((err: unknown) => {
        throw new ConfigError(`config-files: cannot list ${root}: ${describeError(err)}`);
      });
      return entries
        .filter((entry) => entry.isDirectory() && CLIENT_ID.test(entry.name))
        .map((entry) => entry.name)
        .sort();
    },
  };
}
