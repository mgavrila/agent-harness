/**
 * The environment the core-tools child is launched with.
 *
 * An allowlist, not the parent's environment: this process holds the
 * approver's Slack tokens, and the child has no business with them. Anything
 * core-tools reads has to be named here or the child simply does not see it —
 * which, for a variable core-tools requires, means it fails to start and every
 * approval execution fails with it.
 */
export interface ChildEnvInput {
  /** The parent environment to read from. */
  env: NodeJS.ProcessEnv;
  client: string;
  storageRoot: string;
}

/**
 * Read a variable that has no sensible default, or fail startup naming it.
 * Shared with `main.ts`, which reads its own required variables the same way:
 * an empty string has to count as unset in both, or a half-filled `.env` starts
 * a process that fails later and further from the cause.
 */
export function requiredFrom(env: NodeJS.ProcessEnv, name: string, hint = ''): string {
  const value = env[name];
  if (!value || value.trim() === '') throw new Error(`${name} is not set${hint}`);
  return value;
}

export function coreToolsChildEnv({ env, client, storageRoot }: ChildEnvInput): Record<string, string> {
  return {
    PATH: env.PATH ?? '',
    HOME: env.HOME ?? '',
    DATABASE_URL: requiredFrom(env, 'DATABASE_URL'),
    HARNESS_ENCRYPTION_KEY: requiredFrom(env, 'HARNESS_ENCRYPTION_KEY'),
    HARNESS_CLIENT: client,
    CORE_TOOLS_CALLER: 'approvals-app',
    HARNESS_STORAGE_DIR: storageRoot,
    // core-tools refuses to start without a gateway key: every model call goes
    // through the proxy, and an approved documents_extract replay makes one.
    // The provider keys stay in the proxy, so this is the only model
    // credential the child ever holds.
    LITELLM_MASTER_KEY: requiredFrom(env, 'LITELLM_MASTER_KEY'),
    ...(env.HARNESS_POLICY_FILE ? { HARNESS_POLICY_FILE: env.HARNESS_POLICY_FILE } : {}),
    ...(env.HARNESS_FORMS_DIR ? { HARNESS_FORMS_DIR: env.HARNESS_FORMS_DIR } : {}),
    ...(env.HARNESS_GATEWAY_URL ? { HARNESS_GATEWAY_URL: env.HARNESS_GATEWAY_URL } : {}),
    ...(env.HARNESS_PACKS ? { HARNESS_PACKS: env.HARNESS_PACKS } : {}),
  };
}

/** Variables this process holds that must never reach the child. */
export const NEVER_FORWARDED = [
  'APPROVALS_SLACK_BOT_TOKEN',
  'APPROVALS_SLACK_APP_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'GEMINI_API_KEY',
  'GROQ_API_KEY',
  'OPENROUTER_API_KEY',
] as const;
