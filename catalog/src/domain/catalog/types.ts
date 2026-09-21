import type { Blueprint } from '@harness/config-api';

export interface BlueprintInput {
  /** A JSON pointer into the blueprint document that the onboarding form asks for. */
  pointer: string;
  label: string;
  hint?: string;
  /** A value that makes the blueprint resolve; the form's placeholder and the tests' input. */
  example: unknown;
}

export type SurfaceKind = 'web' | 'slack';

export interface CatalogMeta {
  displayName: string;
  description: string;
  /** The kernel version this blueprint was validated on, e.g. "0.3.0". */
  kernel: string;
  surfaces: SurfaceKind[];
  inputs: BlueprintInput[];
  /** A pack the kernel image ships, or null for an agent with no pack. */
  pack: string | null;
}

export interface LoadedBlueprint {
  name: string;
  version: string;
  dir: string;
  blueprint: Blueprint;
  meta: CatalogMeta;
  changelog: string;
  /** File names under `knowledge/`, copied into a tenant's knowledge directory at its first release. */
  knowledgeSeeds: string[];
}

export interface Catalog {
  list(): LoadedBlueprint[];
  get(name: string): LoadedBlueprint;
}
