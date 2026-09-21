import type { ClientDocument } from './document.js';

// `SecretRef` lives in `document.ts`, next to the `SecretRefShape` it is inferred from.

/** One operation of the JSON Patch subset an overlay may use (spec decision 3). */
export type PatchOp =
  | { op: 'replace'; path: string; value: unknown }
  | { op: 'add'; path: string; value: unknown }
  | { op: 'remove'; path: string };

export type JsonPatch = readonly PatchOp[];

/**
 * A catalogue entry: a complete document with placeholders, less the two fields that name a
 * tenant, plus the pointers a tenant may not touch.
 *
 * `lockset` is a list of JSON pointers into the document. A finished agent locks `/persona` and
 * `/policy`; a customisable one locks nothing; a subscription tier is a lock set. `/id` and
 * `/displayName` are absent from `document` and may not appear in `lockset`, because the overlay
 * is the only thing that can supply them.
 */
export interface Blueprint {
  document: Omit<ClientDocument, 'id' | 'displayName'>;
  lockset: readonly string[];
  version: string;
}

/** A tenant's edits to a blueprint. */
export interface Overlay {
  patch: JsonPatch;
  version: string;
}

/** What a source answers with: the document, and the version string that identifies it. */
export interface LoadedDocument {
  document: ClientDocument;
  version: string;
}

/**
 * Where a client document comes from.
 *
 * `load` is the whole of what a host needs. `watch` is how a host learns that a document changed
 * without restarting — the callback receives the new version, and the returned function stops
 * watching. `list` is for the platform and for a pooled host that wants to warm its map; a source
 * that cannot enumerate simply does not offer it. `close` releases whatever the source holds.
 *
 * Every implementation runs `configSourceConformance` from `@harness/config-api/testing`, which
 * is what keeps "a source" one thing rather than two.
 */
export interface ConfigSource {
  /** Lowercase, stable: `files`, `postgres`. What `HARNESS_CONFIG_SOURCE` names. */
  readonly name: string;
  load(clientId: string): Promise<LoadedDocument | null>;
  watch?(clientId: string, onChange: (version: string) => void): () => void;
  list?(): Promise<string[]>;
  close?(): Promise<void>;
}
