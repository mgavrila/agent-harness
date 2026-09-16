import type { PackKernel, PackToolDeps } from '@harness/pack-api';
import { MASKED, isRestrictedName } from '../../shared/redaction/names.js';
import { writeOutFile } from '../storage/file-store.js';
import { stageRelease } from '../files/release.js';
import type { ToolDeps } from '../tooling/types.js';

/**
 * `PackToolDeps` is a structural *view* of `ToolDeps`: every member of the view is a member of
 * the whole, which is what lets core hand a pack its real dependency bag with no cast at the
 * call site. Going the other way is not free — a function typed over the view is not assignable
 * from one typed over the whole, because parameters are checked contravariantly — so the three
 * implementations below narrow once, here, where the reason can be written down. The value is
 * always core's own `ToolDeps`: `createCoreToolsServer` is the only caller of `Pack.tools`, and
 * `registerTools` is the only thing that calls a handler.
 */
const asToolDeps = (deps: PackToolDeps): ToolDeps => deps as unknown as ToolDeps;

/**
 * The kernel operations a pack may call that are not tools: a write that takes raw bytes, a
 * stage that takes a file id, and the two redaction primitives a pack's `redact` needs. One
 * instance, shared by every deployment, because none of them closes over anything.
 */
export const PACK_KERNEL: PackKernel = {
  MASKED,
  isRestrictedName,
  writeOutFile: (deps, input) => writeOutFile(input, asToolDeps(deps).storageDir),
  stageRelease: (deps, args) => stageRelease(asToolDeps(deps), args),
};
