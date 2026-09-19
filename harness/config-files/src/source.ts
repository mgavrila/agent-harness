import { createHash } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import path from 'node:path';
import {
  migrate,
  resolve as resolveOverlay,
  type Blueprint,
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
      document = resolveOverlay(blueprint, overlay);
      sourceFile = overlayFile;
    } else {
      const file = path.join(dir, 'client.yaml');
      if (!(await exists(file))) return null;
      document = migrate(await parseWithIncludes(file));
      sourceFile = file;
    }
    if (document.id !== clientId) {
      // Relative to the client's own directory, never the host's absolute path: this is an error
      // a tenant's own overlay or client.yaml can provoke.
      const relativeSourceFile = path.join(clientId, path.basename(sourceFile));
      throw new ConfigError(`${relativeSourceFile} declares id "${document.id}" but lives in the directory "${clientId}"`);
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
