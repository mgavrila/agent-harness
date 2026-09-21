import { requiredEnv, type EnvSource } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  /** What every inbound request is verified against: the app's signing secret. */
  signingSecret: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/**
 * Read this adapter's configuration out of the environment the host handed over.
 *
 * `deps.env` only, never the ambient environment: whoever builds the bag decides what an adapter
 * can see, which is what stops a suite from reaching a real workspace because the machine running
 * it has a filled-in `.env`. One app: chat and approvals share it, so there is one bot token — and
 * one signing secret, because there is one URL Slack delivers to.
 *
 * `secrets` is what this client's document named, field by field. A deployment that uses the
 * conventional variables — every deployment today — declares nothing and gets them; one running
 * two workspaces in one process names two pairs, and each tenant's adapter reads its own.
 */
export function slackConfig(env: EnvSource, secrets: Readonly<Record<string, string>> = {}): SlackConfig {
  return {
    botToken: requiredEnv(
      secrets.botToken ?? 'SLACK_BOT_TOKEN',
      ' (the Slack app the host posts as; see docs/runbook.md)',
      env,
    ),
    signingSecret: requiredEnv(
      secrets.signingSecret ?? 'SLACK_SIGNING_SECRET',
      ' (the Slack app signing secret, which every inbound request is verified against; see docs/runbook.md)',
      env,
    ),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
