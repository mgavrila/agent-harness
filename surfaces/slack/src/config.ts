import { requiredEnv, type EnvSource } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  /** What every inbound request is verified against: the app's signing secret. */
  signingSecret: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/**
 * Read this adapter's configuration out of what the host handed over.
 *
 * `secrets` is what this client's document named, resolved to values by the host's secret source.
 * A deployment that uses the conventional variables — every single-tenant one — declares nothing
 * and gets them from `deps.env`; one running two workspaces in one process resolves two pairs,
 * and each tenant's adapter reads its own.
 */
export function slackConfig(env: EnvSource, secrets: Readonly<Record<string, string>> = {}): SlackConfig {
  return {
    botToken:
      secrets.botToken ??
      requiredEnv('SLACK_BOT_TOKEN', ' (the Slack app the host posts as; see docs/runbook.md)', env),
    signingSecret:
      secrets.signingSecret ??
      requiredEnv(
        'SLACK_SIGNING_SECRET',
        ' (the Slack app signing secret, which every inbound request is verified against; see docs/runbook.md)',
        env,
      ),
    defaultConversation: requiredEnv('SLACK_APPROVALS_CHANNEL', '', env),
  };
}
