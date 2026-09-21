import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys((value as Record<string, unknown>)[k])]),
    );
  }
  return value;
}

export const canonicalJson = (value: unknown): string => JSON.stringify(sortKeys(value));

/** A release version: the same rule the kernel's files source uses, over canonical JSON. */
export const contentVersion = (document: unknown): string =>
  createHash('sha256').update(canonicalJson(document), 'utf8').digest('hex').slice(0, 16);
