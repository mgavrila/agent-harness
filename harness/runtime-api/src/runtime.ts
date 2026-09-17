import { ConfigError } from '@harness/shared';
import type { Runtime } from './types.js';

export type {
  RunAttachment,
  RunBudget,
  RunEvent,
  RunHandle,
  RunHistoryTurn,
  RunModel,
  RunPrincipal,
  RunRequest,
  RunSkill,
  Runtime,
  RuntimeDeps,
  RuntimeModule,
  RuntimeSession,
} from './types.js';

const NAME = /^[a-z][a-z0-9-]*$/;
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** Declare a runtime plug-in: identity at runtime plus the checks that turn a typo into a startup failure. */
export function defineRuntime(runtime: Runtime): Runtime {
  if (!NAME.test(runtime.name)) {
    throw new ConfigError(`runtime plug-in name "${runtime.name}" must be lowercase letters, digits and hyphens`);
  }
  if (runtime.version.trim() === '') throw new ConfigError(`runtime plug-in "${runtime.name}" has no version`);
  const seen = new Set<string>();
  for (const secret of runtime.secrets) {
    if (!ENV_NAME.test(secret)) {
      throw new ConfigError(
        `runtime plug-in "${runtime.name}" secret "${secret}" must be an environment variable name (A-Z, digits, underscores)`,
      );
    }
    if (seen.has(secret)) throw new ConfigError(`runtime plug-in "${runtime.name}" lists secret "${secret}" twice`);
    seen.add(secret);
  }
  return runtime;
}
