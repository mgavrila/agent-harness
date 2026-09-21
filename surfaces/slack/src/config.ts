import { ConfigError } from '@harness/shared';

export interface SlackConfig {
  botToken: string;
  /** What every inbound request is verified against: the app's signing secret. */
  signingSecret: string;
  /** Where approval cards go: a channel id. */
  defaultConversation: string;
}

/** A value the document has to name, or a refusal saying which field names it. */
function fromDocument(value: string | undefined, field: string): string {
  if (value === undefined || value === '') {
    throw new ConfigError(`the slack surface has no ${field} for this client; surfaces.slack.${field} names it`);
  }
  return value;
}

/**
 * Read this adapter's configuration out of what the host handed over, and out of nothing else.
 *
 * All three values are this tenant's own: the two secrets its document named, resolved to values
 * by the host's secret source, and the channel its `surfaces.slack.approvalsChannel` names. There
 * is no fallback to a deployment-wide variable, and that is the point — on a pooled host, one
 * would be this tenant's cards going to another tenant's workspace, or its app posting as
 * another's. A single-tenant deployment names the same three things in its document and points
 * them at whatever `.env` entries it likes.
 */
export function slackConfig(secrets: Readonly<Record<string, string>> = {}, defaultConversation?: string): SlackConfig {
  return {
    botToken: fromDocument(secrets.botToken, 'botToken'),
    signingSecret: fromDocument(secrets.signingSecret, 'signingSecret'),
    defaultConversation: fromDocument(defaultConversation, 'approvalsChannel'),
  };
}
