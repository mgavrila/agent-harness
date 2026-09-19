import { requiredEnv, type EnvSource } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  appToken: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/**
 * Read this adapter's configuration out of the environment the host handed over.
 *
 * `deps.env` only, never the ambient environment: whoever builds the bag decides what an adapter
 * can see, which is what stops a suite from opening a real socket because the machine running it
 * has a filled-in `.env`. One app: chat and approvals share it, so there is one bot token and one
 * app-level token.
 */
export function slackConfig(env: EnvSource): SlackConfig {
  return {
    botToken: requiredEnv('SLACK_BOT_TOKEN', ' (the Slack app the host connects as; see docs/runbook.md)', env),
    appToken: requiredEnv('SLACK_APP_TOKEN', ' (Socket Mode app-level token; see docs/runbook.md)', env),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
