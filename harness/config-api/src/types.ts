import type { ClientDocument, SecretRef } from './document.js';

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

/**
 * Where a secret comes from.
 *
 * Two methods and no `list`, deliberately: a host resolves what a document names and never
 * enumerates, and the platform's control plane owns the store and lists it with its own SQL (spec
 * section 13.7). `name` is what `HARNESS_SECRET_SOURCE` calls this implementation.
 *
 * `resolve` answers the secret's **value**. It raises a `ConfigError` whose message is a clause
 * about the *reference* — "this deployment does not set it", "this deployment's secret store
 * holds no such secret for that client" — and never the value, never the row and never a
 * statement: `resolveSecrets` puts the client, the surface and the field in front of that clause,
 * because the signature here deliberately does not carry them. Anything that is not a
 * `ConfigError` is treated as a source that broke rather than a secret that is missing.
 *
 * **An implementation must never place a secret value in any error it throws.** A `ConfigError`'s
 * message is shown to an operator and can be stored; anything else has its *kind* — the
 * constructor name and a `code` — written to the log, and its message deliberately dropped,
 * because a driver's message is where a connection string or a statement fragment turns up
 * (invariant 21). A source therefore never needs to redact one, and must never rely on the caller
 * to.
 *
 * `resolve` does **not** have to reject a value that is blank: `resolveSecrets` refuses one for
 * every source, with the clause an unset variable gets, so no adapter is handed an empty string.
 *
 * Every implementation runs `secretSourceConformance` from `@harness/config-api/testing`, which
 * is what keeps "a source" one thing rather than two.
 */
export interface SecretSource {
  /** Lowercase, stable: `env`, `postgres`. What `HARNESS_SECRET_SOURCE` names. */
  readonly name: string;
  resolve(clientId: string, ref: SecretRef): Promise<string>;
  close?(): Promise<void>;
}

/**
 * Every secret one client's document names, resolved to its value.
 *
 * Keyed by surface, then by the document's own field name — `{ slack: { botToken: 'xoxb-…' } }` —
 * which is the shape `SurfaceDeps.secretValues` carries and the reason the host can hand an
 * adapter its secrets without knowing what any of them are called.
 *
 * **Values, not names.** The bag `Plan 11b` shipped carried environment variable names, and a
 * `{ ref }` has no variable name to carry; the rename from `secrets` to `secretValues` on every
 * site is what stops a reader from looking a value up as though it were a name.
 */
export interface ResolvedSecrets {
  readonly surfaces: Readonly<Record<string, Readonly<Record<string, string>>>>;
}
