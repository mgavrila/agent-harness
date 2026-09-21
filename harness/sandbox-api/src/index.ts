/**
 * The public API of @harness/sandbox-api.
 *
 * Types only: this package reserves a seam (spec decision 14) and implements nothing. The
 * in-memory provider and the conformance suite are under the `./testing` subpath, where every
 * contract package in this workspace keeps its kit.
 */
import type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession } from './types.js';
export type { ExecOptions, ExecResult, Sandbox, SandboxProvider, SandboxSession };
