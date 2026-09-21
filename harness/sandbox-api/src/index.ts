/**
 * The public API of @harness/sandbox-api.
 *
 * Types only: this package reserves a seam (spec decision 14) and implements nothing. The
 * in-memory provider and the conformance suite are under the `./testing` subpath, where every
 * contract package in this workspace keeps its kit.
 *
 * Imported and then re-exported, rather than `export type { … } from './types.js'` in one
 * statement: nothing in this repository imports this barrel yet — the seam is reserved — so a
 * module with no dependency of its own either would be an orphan, and `pnpm arch`'s `no-orphans`
 * is an error. The one-statement form does not count as a dependency. Fold the two back together
 * once a provider imports this.
 */
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';
export type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession };
