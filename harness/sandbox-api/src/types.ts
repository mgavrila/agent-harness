/**
 * The contract for running a command somewhere that is not this process (spec decision 14).
 *
 * Reserved, not implemented: nothing in this repository acquires a sandbox, and no action class
 * admits one — `execute` is Plan 12's, and a class added before a provider existed would appear
 * in the published tool surface as a capability nobody has. What this package exists for is the
 * shape: a later plan brings agent-sandbox, a `SandboxClaim` from a tenant's warm pool and a
 * router in front of it, and every one of those is an implementation of `SandboxProvider` rather
 * than a change to the kernel.
 *
 * The unit is a **session**, not a process and not a tenant: one run, of one principal, of one
 * client. A provider may pool, pause or reuse whatever it likes underneath, and the isolation
 * this contract promises is that what one session writes, another session cannot read.
 */

/** Who a sandbox is being acquired for. Everything an implementation may key its isolation on. */
export interface SandboxSession {
  client: string;
  runId: string;
  principalId: string;
}

/** What one command cost and what it said. */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  durationMs: number;
}

/** How one command is run. Every field is a bound, because every field is somebody's budget. */
export interface ExecOptions {
  /** Where the command runs. A provider that has one root resolves this under it. */
  cwd?: string;
  /** Extra environment for this command only. A provider never forwards its own. */
  env?: Readonly<Record<string, string>>;
  /** After this, the command is killed and the result reports it. */
  timeoutMs?: number;
}

/** One acquired sandbox. Everything here rejects with a `ToolError` once it is terminated. */
export interface Sandbox {
  exec(command: string, opts: ExecOptions): Promise<ExecResult>;
  putFile(path: string, bytes: Uint8Array): Promise<void>;
  getFile(path: string): Promise<Uint8Array>;
  /** Idempotent, and never throws: a caller unwinding twice is not an error. */
  terminate(): Promise<void>;
}

/** Where a sandbox comes from. One per deployment; the tenant is in the session. */
export interface SandboxProvider {
  readonly name: string;
  acquire(session: SandboxSession): Promise<Sandbox>;
}
