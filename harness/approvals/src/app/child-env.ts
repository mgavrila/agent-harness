import { ConfigError, requiredEnv } from '@harness/shared';

/**
 * The environment the core-tools child is launched with.
 *
 * An allowlist, not the parent's environment: this process holds whatever credentials its
 * messaging adapters need, and the child has no business with them. Anything core-tools reads has
 * to be named here or the child simply does not see it — which, for a variable core-tools
 * requires, means it fails to start and every approval execution fails with it.
 */
export interface ChildEnvInput {
  /** The parent environment to read from. */
  env: NodeJS.ProcessEnv;
  client: string;
  storageRoot: string;
  /** Every loaded surface's declared credentials, from `LoadedSurfaces.secrets`. */
  surfaceSecrets: readonly string[];
}

/** Model credentials this process may hold. The gateway key is the only one the child gets. */
export const MODEL_PROVIDER_KEYS = ['GEMINI_API_KEY', 'GROQ_API_KEY', 'OPENROUTER_API_KEY'] as const;

/**
 * Variables that must never reach the child, computed rather than listed.
 *
 * The messaging half of this list used to name four variables belonging to one adapter. It
 * cannot any more and should not: which credentials exist is the loaded adapters' knowledge,
 * declared as `Surface.secrets`, and a host that hard-coded them would be wrong the day a second
 * adapter is loaded.
 */
export function neverForwarded(surfaceSecrets: readonly string[]): string[] {
  return [...new Set([...surfaceSecrets, ...MODEL_PROVIDER_KEYS])];
}

export function coreToolsChildEnv({ env, client, storageRoot, surfaceSecrets }: ChildEnvInput): Record<string, string> {
  const child: Record<string, string> = {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    DATABASE_URL: requiredEnv('DATABASE_URL', '', env),
    HARNESS_ENCRYPTION_KEY: requiredEnv('HARNESS_ENCRYPTION_KEY', '', env),
    HARNESS_CLIENT: client,
    CORE_TOOLS_CALLER: 'approvals-app',
    HARNESS_STORAGE_DIR: storageRoot,
    // core-tools refuses to start without a gateway key: every model call goes through the
    // proxy, and an approved documents_extract replay makes one. The provider keys stay in the
    // proxy, so this is the only model credential the child ever holds.
    LITELLM_MASTER_KEY: requiredEnv('LITELLM_MASTER_KEY', '', env),
    ...(env.HARNESS_POLICY_FILE ? { HARNESS_POLICY_FILE: env.HARNESS_POLICY_FILE } : {}),
    ...(env.HARNESS_FORMS_DIR ? { HARNESS_FORMS_DIR: env.HARNESS_FORMS_DIR } : {}),
    ...(env.HARNESS_GATEWAY_URL ? { HARNESS_GATEWAY_URL: env.HARNESS_GATEWAY_URL } : {}),
    ...(env.HARNESS_PACKS ? { HARNESS_PACKS: env.HARNESS_PACKS } : {}),
    // HARNESS_SURFACES is deliberately absent: the child is the kernel, which stages effects and
    // never sends one. Only this process talks to a surface.
  };
  // An allowlist already makes this impossible, which is the point of checking: the day someone
  // adds a pass-through here, a credential an adapter declared has to fail at startup rather
  // than travel to a child process that has no business with it.
  for (const name of neverForwarded(surfaceSecrets)) {
    if (name in child) throw new ConfigError(`the core-tools child environment must not carry ${name}`);
  }
  return child;
}
