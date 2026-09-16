import type * as z from 'zod/v4';
import type { Db } from '@harness/db';
import type { SinkRegistry } from '../../effects.js'; // until Task 7 moves it to ../effects/types.js
import type { GatewayConfig } from '../models/types.js';
import type { VerifyConfig } from '../../tools/verify.js'; // until Task 7 moves it to ../verify/types.js
import type { ActionClass, Policy } from './policy.js';
import type { AuditEntry } from './audit.js';

/**
 * What a session has told us about itself, stamped onto every audit row it produces. One
 * object per process, mutated in place by `harness_set_context` and rewound by
 * `preservingContext` when a transaction rolls back.
 */
export interface SessionContext {
  runId?: string;
  skill?: string;
  skillVersion?: string;
  /** Name of the tool currently executing; set by the registry before calling a handler. */
  tool?: string;
}

/**
 * Extraction confidence at or above which a field is `extracted` rather than
 * `pending` a human. The shipped default, overridable per process by
 * `CONFIDENCE_THRESHOLD`. Exported because the eval suite asserts on the same
 * boundary the tools apply, and two copies of the number would drift: a change
 * to the default would silently move the eval's goalposts with it.
 */
export const DEFAULT_CONFIDENCE_THRESHOLD = 0.85;

/**
 * Everything a tool handler is given. This is the package's dependency contract: a handler
 * reaches for nothing outside it, which is what makes every tool testable against
 * `makeTestDeps` and what keeps `process.env` out of the domain.
 *
 * Note what this carries and what it does not. `gateway`, `storageDir` and `verify` are
 * *configuration*, not constructed objects: the domain builds its adapter from them
 * (`httpGateway`, `fileStorage`, `nppesRegistry`), so a test overrides a URL rather than
 * assembling an interface. See ARCHITECTURE.md for why.
 */
export interface ToolDeps {
  /** Drizzle database handle; every handler runs inside a transaction opened on it. */
  db: Db;
  /** The client this process serves. Every query is scoped by it; nothing crosses clients. */
  client: string;
  /** Who is calling (the agent identity recorded on every audit row). */
  caller: string;
  /** Action-class → behaviour table that decides auto / approval / blocked for each tool. */
  policy: Policy;
  /** 32-byte AES-256-GCM key for restricted values and approval payloads. Never logged. */
  encryptionKey: Buffer;
  /** Clock, injectable so tests can freeze time. */
  now: () => Date;
  /** How long a parked approval stays pending before reconciliation expires it. */
  approvalTtlHours: number;
  /** Extracted fields below this confidence stay `pending` for a human. Default `DEFAULT_CONFIDENCE_THRESHOLD`. */
  confidenceThreshold: number;
  /** How to reach the model gateway. Every model call goes through it. */
  gateway: GatewayConfig;
  /**
   * Absolute root of the file store, from `storageRoot()`: required, with no
   * default, so a deployment that has not said where files live fails at
   * startup instead of scattering provider documents into the working
   * directory. One root serves both halves and they do not collide: ingested
   * documents sit where the caller puts them under it (`incoming/`, and their
   * `.redacted.txt` sidecars beside them), and everything a tool generates for
   * a human goes under `<storageDir>/out`. Nothing outside the root is
   * readable: `resolveStoragePath` and `resolveOutFile` both check the lexical
   * path and the symlink-resolved path against it.
   */
  storageDir: string;
  /** Directory holding the active pack's `templates.json` and its PDFs. */
  formsDir: string;
  /**
   * Whether restricted identifiers (SSN, EIN, DEA) may be sent to a model.
   * False for every client by default. Turning it on is a documented decision
   * that requires a BAA with the model provider (spec section 4.4).
   */
  restrictedToModel: boolean;
  /** External registry lookups: which are enabled, and where they live. */
  verify: VerifyConfig;
  /** External-effect senders keyed by sink name (e.g. 'slack'). Empty in Plan 1.1; Plan 3 registers real ones. */
  sinks: SinkRegistry;
  /** Per-process session context (run, skill, tool) stamped on audit rows; see `context.ts`. */
  context: SessionContext;
  /** Every registered tool, keyed by name, so a parked action can be replayed by name. Filled by `registerTools`. */
  tools: Map<string, AnyToolDef>;
}

export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject> {
  name: string;
  description: string;
  actionClass: ActionClass;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: ToolDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
  /**
   * Strip restricted values from the arguments before they are written to the
   * approvals table in plaintext jsonb. The full arguments are still stored,
   * encrypted, in `payload_encrypted`. Omit only for tools whose arguments can
   * never carry a restricted value.
   */
  redact?: (args: z.infer<I>) => unknown;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyToolDef = ToolDef<any, any>;

export type AuditBase = Pick<
  AuditEntry,
  'client' | 'caller' | 'tool' | 'actionClass' | 'argsHash' | 'runId' | 'skill' | 'skillVersion' | 'derivedFrom'
>;

/** A call either produced a result or was parked for a human decision. */
export type Envelope = { status: 'ok'; result: unknown } | { status: 'pending'; approval_id: string };

/**
 * What a tool call resolves to. A type alias rather than an interface, so that
 * it keeps the implicit index signature the MCP callback signature expects.
 */
export type ToolCallResult = {
  content: { type: 'text'; text: string }[];
  isError: boolean;
  structuredContent?: Envelope;
};
