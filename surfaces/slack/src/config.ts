import { requiredEnv, type EnvSource } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Where approval cards go when nobody names a conversation: a channel id. */
  defaultConversation: string;
}

/** Appended to the two token errors, because a missing one is almost always the same mistake. */
const TWO_APPS = ' (the approvals host needs its own Slack app; see docs/runbook.md)';

/**
 * Read this adapter's configuration out of the environment the host handed over.
 *
 * `deps.env` only, never the ambient environment: whoever builds the bag decides what an adapter
 * can see, which is what stops a suite from opening a real socket because the machine running it
 * has a filled-in `.env`. The variable names are unchanged from before Plan 6, deliberately —
 * the demo deployment's `.env` and its Compose service keep working untouched.
 */
export function slackConfig(env: EnvSource): SlackConfig {
  return {
    botToken: requiredEnv('APPROVALS_SLACK_BOT_TOKEN', TWO_APPS, env),
    appToken: requiredEnv('APPROVALS_SLACK_APP_TOKEN', TWO_APPS, env),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
