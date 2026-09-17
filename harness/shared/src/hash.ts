import { createHash } from 'node:crypto';

/** Recursively sort object keys so a hash does not depend on key order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== 'object') return value;
  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) sorted[key] = canonicalize(source[key]);
  return sorted;
}

/**
 * Stable fingerprint of a tool's arguments: the sha256 hex of the canonical JSON.
 *
 * Here rather than in core-tools because three writers stamp it — the kernel on every audit row,
 * and both runtimes on every `tool_call` event — and neither runtime may import the kernel. The
 * bytes are exactly what `domain/tooling/audit.ts` produced before the move, so an approval's
 * idempotency key and every existing `args_hash` still match.
 */
export function hashArgs(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize(args ?? null)))
    .digest('hex');
}
