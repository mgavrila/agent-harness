/**
 * The file store, as a domain sees it. Two trees under one root and they do not collide:
 * ingested documents sit where the caller put them (`incoming/…`, with their
 * `.redacted.txt` sidecars beside them) and everything generated for a human goes under
 * `<root>/out`. Nothing outside the root is reachable through either half.
 *
 * `Storage` is the seam: `fileStorage(root)` is the production adapter, and a test that wants
 * a stub implements these five methods. `ToolDeps` carries the root string rather than a
 * constructed `Storage`, so a test overrides a directory rather than assembling an object —
 * see ARCHITECTURE.md.
 */
export interface WriteFileInput {
  /** Subdirectory under `out/`, e.g. `forms` or `roster`. */
  dir: string;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export interface WrittenFile {
  file_id: string;
  path: string;
  bytes: number;
}

export interface Storage {
  /** A caller-supplied ingest path, resolved and proven to be inside the root. */
  resolveIncoming(requested: string): Promise<string>;
  /** A caller-supplied file id, resolved and proven to be inside `out/`. */
  resolveOut(fileId: string): Promise<string>;
  read(absPath: string): Promise<Uint8Array>;
  write(input: WriteFileInput): Promise<WrittenFile>;
  /** Where a document's redacted text lives: beside it, with a fixed suffix. */
  textPathFor(absPath: string): string;
}
