import type * as z from 'zod/v4';
import type { Db } from '@harness/db';
import type { Principal } from '@harness/identity-api';
import type { AnyToolDef as PackAnyToolDef, PackKernel, ToolDef as PackToolDef } from '@harness/pack-api';
import type { EnvSource } from '@harness/shared';
import type { DocumentParser } from '../documents/types.js';
import type { SinkRegistry } from '../effects/types.js';
import type { GatewayConfig } from '../models/types.js';
import type { PackRegistry } from '../packs/types.js';
import type { Policy } from './policy.js';
import type { AuditEntry } from './audit.js';

/**
 * What one run knows about itself, stamped onto every audit row, effect and model call it
 * produces. Built once per run — by `openRun` for the stdio server and the eval pipeline, by the
 * host per turn — and never shared between runs: one `ToolDeps` per run, never a process-wide
 * mutable object.
 */
export interface RunContext {
  /**
   * The `runs` row this run's rows point at. Null only where no run was opened: the surface
   * recorder, which has no database, and a unit test that opened none. Every shipping entry
   * point opens one.
   */
  runId: string | null;
  /** The conversation thread this run belongs to: a `threads` row. Null where no host opened one. */
  threadId: string | null;
  /** The surface and conversation the run was started from. Null for the stdio server. */
  surface: string | null;
  conversation: string | null;
  /** The skill the runtime activated, when it said so. Absent when it named none. */
  skill?: string;
  skillVersion?: string;
  /** The tool currently executing; set by `withCurrentTool`, read by `stageEffect`. */
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
 * Note what this carries and what it does not. `gateway` and `storageDir` are *configuration*,
 * not constructed objects: a test overrides a URL or a directory rather than assembling an
 * interface. See ARCHITECTURE.md for why.
 *
 * One adapter is built by the domain from that configuration and is on the live path:
 * `httpGateway(deps.gateway)` inside `callModel`. The other, `fileStorage(root)`, is a declared
 * seam with no caller: every storage call still goes through the free functions with
 * `deps.storageDir` threaded in.
 */
export interface ToolDeps {
  /** Drizzle database handle; every handler runs inside a transaction opened on it. */
  db: Db;
  /** The client this process serves. Every query is scoped by it; nothing crosses clients. */
  client: string;
  /**
   * Who this run acts as. Bound by whoever built the bag — the stdio server from
   * `HARNESS_PRINCIPAL`, a host per run — and never by a tool: nothing a model sends can set it.
   * `principal.id` is what every audit row, approval and run row carries, and `principal.level`
   * is what policy decides with.
   */
  principal: Principal;
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
   * startup instead of scattering ingested documents into the working
   * directory. One root serves both halves and they do not collide: ingested
   * documents sit where the caller puts them under it (`incoming/`, and their
   * `.redacted.txt` sidecars beside them), and everything a tool generates for
   * a human goes under `<storageDir>/out`. Nothing outside the root is
   * readable: `resolveStoragePath` and `resolveOutFile` both check the lexical
   * path and the symlink-resolved path against it.
   */
  storageDir: string;
  /**
   * The client's own folder: `clients/<HARNESS_CLIENT>/`, where its persona, policy, identity,
   * playbooks and `knowledge/` live. Derived, never configured — spec section 7 fixes the layout
   * — and resolved from the repository root, which is the image's working directory too.
   */
  clientDir: string;
  /**
   * How wide an embedding vector this deployment stores, from `HARNESS_EMBED_DIMS`. It does not
   * *decide* the width: `knowledge_chunks.embedding` was created at a fixed width by migration
   * 0013, and `assertEmbedDims` refuses to start when the two disagree. It is here so that
   * `embedTexts` asks the gateway for that width and refuses anything else.
   */
  embedDims: number;
  /**
   * What turns a document under `storageDir` into text. `localParser(storageDir)` in tests and on
   * bare metal; `remoteParser(HARNESS_FILES_URL, storageDir)` in Compose, where the parsing
   * happens in a process that holds no key. Constructed, not configuration — the one member
   * of this bag that is, because the choice between the two is the deployment's and the domain
   * cannot make it from a URL alone.
   */
  parser: DocumentParser;
  /**
   * Directory holding the active pack's `templates.json` and its PDFs. With no pack loaded it is
   * `HARNESS_FORMS_DIR`, or the storage directory standing in for it: the forms tools belong to a
   * pack, so a client with none has no reader for this.
   */
  formsDir: string;
  /**
   * Whether restricted identifiers (SSN, EIN, DEA) may be sent to a model.
   * False for every client by default. Turning it on is a documented decision
   * that requires a BAA with the model vendor (spec section 4.4).
   */
  restrictedToModel: boolean;
  /**
   * External-effect senders keyed by sink name (e.g. 'surface_message'). Empty unless the
   * composition root fills it; the host registers `surfaceSinks` from `@harness/approvals`.
   */
  sinks: SinkRegistry;
  /** This run's context, stamped on audit rows; see `context.ts`. One per run. */
  context: RunContext;
  /** Every registered tool, keyed by name, so a parked action can be replayed by name. Filled by `registerTools`. */
  tools: Map<string, AnyToolDef>;
  /**
   * Every **kernel** tool, keyed by its kernel name, filled by `createCoreToolsServer` before any
   * pack's replacement is applied. This is what a pack's wrapper calls: `deps.tools` is the
   * published catalogue and after a replacement holds the pack's own tool under the kernel's
   * name, so a wrapper that looked itself up there would recurse until the stack ran out.
   */
  kernelTools: Map<string, AnyToolDef>;
  /** The kernel operations a pack may call that are not tools. Always `PACK_KERNEL`. */
  kernel: PackKernel;
  /**
   * The packs this process loaded, from `HARNESS_PACKS`. Document kinds, the extraction
   * manifest and the forms directory all come from here rather than from an import, which is
   * what lets one build serve one area of the product today and a different one tomorrow.
   */
  packs: PackRegistry;
  /**
   * The environment a pack's `tools(deps)` reads its own configuration from, and the one member
   * here that exists for the packs rather than for the kernel: core's own configuration is read
   * in `app/` and arrives on this bag already parsed.
   *
   * Whoever builds the bag decides what a pack can see. `buildDepsFromEnv` hands over
   * `process.env`, which is the deployment's answer. `makeTestDeps`, `surfaceDeps` and the eval
   * pipeline hand over a small pinned map instead, so no suite can reach a live registry
   * because the machine running it has a filled-in `.env`.
   */
  env: EnvSource;
}

/** A core-tools tool: the contract's `ToolDef` with this package's dependency bag filled in. */
export type ToolDef<I extends z.ZodObject, O extends z.ZodObject> = PackToolDef<I, O, ToolDeps>;
export type AnyToolDef = PackAnyToolDef<ToolDeps>;

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
