/* eslint-disable @typescript-eslint/no-explicit-any */
import type * as z from 'zod/v4';
import type { EnvSource, Level } from '@harness/shared';
import type { PackEvals } from './evals.js';
import type { ExtractionManifest } from './extraction.js';
import type { ActionClass, PolicyOverrides } from './policy.js';
import type { AttachmentKindSpec, RawAttachmentKind, RawRecordKind, RecordKindSpec } from './records.js';

/**
 * The mutually-referencing declarations of the pack contract.
 *
 * `Pack` declares tools that are handed a `PackToolDeps`, and a `PackToolDeps` reaches a `Pack`
 * back through `PackRegistryView.byName`, so the two refer to each other and no arrangement of
 * separate `pack.ts` / `kernel.ts` / `tool.ts` modules breaks that cycle. This leaf module holds
 * every declaration on that cycle instead, and imports only from `extraction`, `evals`,
 * `policy`, `records` and zod — never from `pack.ts`, `kernel.ts` or `tool.ts` — so it cannot
 * itself be part of a cycle. `pack.ts`, `kernel.ts` and `tool.ts` re-export the pieces they used
 * to declare and keep the runtime functions that belong to them.
 */

/**
 * A kernel tool as a pack sees it.
 *
 * `any` on both parameters is load-bearing and is the same concession `AnyToolDef` already
 * makes. core-tools' own definition types the handler `(args: any, deps: ToolDeps)`, and a
 * contract that typed `deps` as this view instead would not accept it: a function parameter is
 * checked contravariantly, and `PackToolDeps` is a *subset* of `ToolDeps`, not a supertype. The
 * alternative is `never`, which is assignable but uncallable. The pack always passes the deps
 * it was handed, which is the `ToolDeps` the handler expects.
 */
export interface CoreToolView {
  readonly name: string;
  handler: (args: any, deps: any) => Promise<any>;
}

/** The loaded packs, as a pack sees them. core-tools' `PackRegistry` satisfies it. */
export interface PackRegistryView {
  byName(name: string): Pack;
  documentKinds(): string[];
  recordKinds(): RecordKindSpec[];
  attachmentKinds(): AttachmentKindSpec[];
}

export interface WriteOutFileInput {
  /** Subdirectory of the client's out tree, e.g. `forms` or `roster`. */
  dir: string;
  name: string;
  ext: string;
  bytes: Uint8Array;
}

export interface WrittenFile {
  /** Content-addressed, and the only thing a caller may pass back to a release. */
  file_id: string;
  path: string;
  bytes: number;
}

export interface StagedRelease {
  effect_id: string;
  staged: boolean;
  file_id: string;
  filename: string;
  bytes: number;
}

/**
 * Kernel operations a pack's tools may call that are not themselves tools.
 *
 * Three things do not belong in an MCP catalogue: a write that takes raw bytes, a predicate,
 * and a sentinel string. A pack cannot import them either — `pnpm arch` forbids a pack any
 * workspace import but this package and `@harness/shared`. So the kernel hands them over on
 * `deps.kernel`, and core-tools' `domain/packs/kernel.ts` is the one implementation.
 */
export interface PackKernel {
  /** The sentinel a read puts in place of a restricted value. Never the value itself. */
  readonly MASKED: string;
  /**
   * Whether the kernel will always encrypt a field of this name, whatever a caller says. A
   * pack's `redact` uses it to mask the arguments a parked approval stores in plaintext jsonb.
   *
   * `this: void` is part of the contract, not decoration: a `redact` has no `deps` of its own,
   * so every caller pulls this off the bag and closes over it or passes it as a value. Declaring
   * that it never reads `this` is what makes doing so correct — and it is why the implementation
   * in `domain/packs/kernel.ts` is a plain module function rather than a method.
   */
  isRestrictedName(this: void, name: string): boolean;
  /** Write bytes into this client's out tree under a content-addressed id. */
  writeOutFile(deps: PackToolDeps, input: WriteOutFileInput): Promise<WrittenFile>;
  /**
   * Stage one generated file for delivery through the effects outbox, on the named surface or
   * the primary one. Sends nothing.
   */
  stageRelease(
    deps: PackToolDeps,
    args: { file_id: string; channel?: string; surface?: string },
  ): Promise<StagedRelease>;
}

/**
 * Who is calling, as a pack sees it: the four members a pack tool may need to name a person
 * or gate on a level. The kernel's `Principal` (from `@harness/identity-api`) is assignable to
 * it; a pack never imports that contract.
 */
export interface PrincipalView {
  readonly id: string;
  readonly kind: 'user' | 'service';
  readonly level: Level;
  readonly displayName: string;
}

/**
 * What a pack's tool handler is given.
 *
 * This is a **structural view** of core-tools' `ToolDeps`: every member below is a member of
 * `ToolDeps` with the same name and a compatible type, so core hands its real dependency bag
 * straight through and no cast happens at the call site. It deliberately does not carry `db`,
 * `policy` or `encryptionKey` — a pack reads and writes through kernel tools, which is what
 * keeps client scoping, the confidence threshold, the verified-field rule and the encryption
 * decision in one place.
 */
export interface PackToolDeps {
  /** The client this process serves. Every kernel call is scoped by it. */
  readonly client: string;
  /** The principal this run acts as. Bound before the model ran; nothing a model sends can change it. */
  readonly principal: PrincipalView;
  readonly now: () => Date;
  readonly storageDir: string;
  /** The directory holding this deployment's `templates.json` and its PDFs. */
  readonly formsDir: string;
  readonly packs: PackRegistryView;
  /**
   * Every kernel tool by its kernel name, filled before any pack replaced one.
   *
   * Not `deps.tools`: that is the *published* catalogue, and after a replacement it holds the
   * pack's own tool under the kernel's name — so a wrapper that looked itself up there would
   * call itself until the stack ran out.
   */
  readonly kernelTools: ReadonlyMap<string, CoreToolView>;
  readonly kernel: PackKernel;
  /**
   * The environment this process's configuration comes from. A pack reads **only** this — never
   * the ambient `process.env`.
   *
   * The difference is not cosmetic. A pack's own variables are read when `tools(deps)` builds
   * the catalogue, so a pack that reached for the ambient environment would pick up whatever
   * the surrounding process happened to have: an eval run on a developer's filled-in `.env`
   * would switch a registry lookup on and point it at the live endpoint, and the suite would
   * make real outbound calls nobody asked for. Whoever builds the bag decides instead —
   * `app/server.ts` hands over `process.env`, while `makeTestDeps`, the surface recorder and
   * the eval pipeline hand over a small map that pins the outbound switches off.
   *
   * Parse it with `@harness/shared`'s env helpers, passing this as their last argument, so a
   * pack's variables are validated and worded exactly like the kernel's.
   */
  readonly env: EnvSource;
}

/**
 * One agent-callable action.
 *
 * `TDeps` is the dependency bag the handler receives. A pack leaves it at `PackToolDeps`, the
 * structural view of core's `ToolDeps` declared above; core-tools narrows it to the whole
 * `ToolDeps` for its own tools. `ToolDeps` is assignable to `PackToolDeps`, so a pack's tools
 * drop straight into core-tools' catalogue and the handler is called with the real bag.
 */
export interface ToolDef<I extends z.ZodObject, O extends z.ZodObject, TDeps = PackToolDeps> {
  name: string;
  description: string;
  actionClass: ActionClass;
  /**
   * The class of one particular call, when it depends on the arguments: a memory write is
   * `write.self` in the caller's own scope and `write.internal` in the client's. Resolved before
   * policy decides, recorded on the audit row, printed in a parked approval's summary and
   * resolved again at replay. Omitted, every call is `actionClass`. May read through `deps`
   * (the entry a removal names, say); it must not write.
   */
  actionClassFor?: (args: z.infer<I>, deps: TDeps) => ActionClass | Promise<ActionClass>;
  input: I;
  output: O;
  handler: (args: z.infer<I>, deps: TDeps) => Promise<z.infer<O>>;
  recordIds?: (args: z.infer<I>, result: z.infer<O>) => string[];
  /**
   * Strip restricted values from the arguments before they are written to the approvals table
   * in plaintext jsonb. The full arguments are still stored, encrypted, in
   * `payload_encrypted`. Omit only for tools whose arguments can never carry a restricted
   * value.
   */
  redact?: (args: z.infer<I>) => unknown;
}

export type AnyToolDef<TDeps = PackToolDeps> = ToolDef<any, any, TDeps>;

/**
 * What core loads when it loads an area of the product.
 *
 * A pack is content plus a declaration: what it stores, which documents exist, what to pull out
 * of them, which forms and skills ship with them, what the default policy for its actions is, and
 * which tools it contributes and which kernel tools those replace. It depends on this package and
 * on `@harness/shared`, and on nothing else in the workspace: never on `@harness/core-tools` and
 * never on `@harness/db`, which is what lets core load it by name.
 */
export interface Pack {
  /** Short, stable, lowercase. `deps.packs.byName('healthcare')`. */
  name: string;
  version: string;
  /**
   * What this pack stores. At least one.
   *
   * Handed over unparsed — see `RawRecordKind`. The kernel's registry parses each one against
   * its own restricted-name rules, because those rules decide what gets encrypted and belong
   * to whoever does the encrypting.
   */
  records: RawRecordKind[];
  /** What hangs off a record: a licence, a link. Omit for a pack that attaches nothing. */
  attachments?: RawAttachmentKind[];
  /** What `documents_classify` may return and `documents_ingest` may be told. */
  documentKinds: readonly string[];
  /** Which document kinds feed which record kinds, and the prose the model reads. */
  extraction: ExtractionManifest;
  /** Absolute path to the directory holding `templates.json` and its PDFs. Omit for a pack with no forms. */
  formsDir?: string;
  /** Absolute path to the directory of `<skill>/SKILL.md` folders. */
  skillsDir: string;
  /** Action-class defaults this pack ships, in the shape a policy.yaml parses to. A client's file still wins. */
  policy: PolicyOverrides;
  /**
   * Kernel tool names this pack's own tools supersede. A name listed here is not published; the
   * pack's tool of that name takes its place. Two loaded packs may not replace the same name,
   * and a name that is not a kernel tool is a startup failure, not a silent no-op.
   */
  replaces?: readonly string[];
  /**
   * Tools this pack adds to the catalogue, built once per server from the live dependency bag.
   * A handler reaches a kernel handler through `deps.kernelTools` and the three non-tool kernel
   * operations through `deps.kernel`.
   */
  tools?: (deps: PackToolDeps) => AnyToolDef[];
  evals?: PackEvals;
}
