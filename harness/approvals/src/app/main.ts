import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as loadEnv } from 'dotenv';
import { App, LogLevel } from '@slack/bolt';
import { createDb, loadKey } from '@harness/db';
import { outRoot } from '@harness/core-tools';
import { createLogger, numberFromEnv, requiredEnv } from '@harness/shared';
import { slackSinks } from '../domain/sinks.js';
import { webClientApi } from '../domain/slack/web-client.js';
import { createMcpCoreToolsClient } from '../domain/execute/mcp-client.js';
import {
  registerApprovalHandlers,
  parseAllowedUsers,
  type ActionArgs,
  type HandlerRegistry,
  type ViewArgs,
} from '../domain/slack/handlers.js';
import { parseEditModalMetadata } from '../domain/render/modal.js';
import {
  EDIT_MODAL_CALLBACK_ID,
  EDIT_NOTE_ACTION_ID,
  EDIT_NOTE_BLOCK_ID,
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
} from '../domain/render/types.js';
import { collectHealth, startRunner } from '../domain/runner.js';
import { DEFAULT_HEALTH_BIND, startHealthServer } from '../domain/health.js';
import { coreToolsChildEnv } from './child-env.js';

const log = createLogger('approvals');

// One level deeper than the package's `src/`, so four segments up is the
// repository root: src/app -> src -> approvals -> harness -> <repo>.
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..');
loadEnv({ path: path.join(repoRoot, '.env'), quiet: true });

function required(name: string): string {
  const hint = name.startsWith('APPROVALS_SLACK_')
    ? ' (the approvals app needs its own Slack app; see docs/runbook.md)'
    : '';
  return requiredEnv(name, hint);
}

const seconds = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 86_400, unit: 'seconds' });

const port = (name: string, fallback: number): number =>
  numberFromEnv(name, fallback, { min: 1, max: 65_535, integer: true });

const client = process.env.HARNESS_CLIENT ?? 'default';
const channel = required('SLACK_APPROVALS_CHANNEL');
const allowedUsers = parseAllowedUsers(process.env.SLACK_ALLOWED_USERS);
const storageRoot = required('HARNESS_STORAGE_DIR');

/**
 * The approvals app needs its own Slack app, not Hermes's.
 *
 * Slack routes each Socket Mode event to exactly one of an app's open
 * connections. With Hermes's gateway and this process both connected on one
 * `SLACK_APP_TOKEN`, roughly half of every button click and modal submission
 * went to Hermes, which has no handler for them, and the approval silently
 * stayed pending. Two app tokens means two independent event streams.
 *
 * These are deliberately not falling back to `SLACK_BOT_TOKEN` /
 * `SLACK_APP_TOKEN`: a fallback would make the broken configuration the
 * default again and fail intermittently rather than at startup.
 */
const bolt = new App({
  token: required('APPROVALS_SLACK_BOT_TOKEN'),
  appToken: required('APPROVALS_SLACK_APP_TOKEN'),
  socketMode: true,
  logLevel: LogLevel.INFO,
});

/**
 * Narrow Bolt's payloads onto the fields the handlers need. Everything
 * Bolt-specific lives here, so the handlers and their tests stay free of Bolt types.
 *
 * `channel` for a block action comes from `body.channel.id`, the channel the
 * interactive message lives in. A view submission carries no channel of its
 * own in Slack's payload — Bolt's `view.channel` is not populated for a modal
 * opened by `trigger_id` from a button click, which is this app's only path
 * to one — so `channel` here is decoded from `private_metadata` instead
 * (`editModalView` encoded it there when the modal was opened). The domain's
 * own view handler decodes the same metadata and does not trust this value either;
 * it is passed through only so a metadata parse failure still has a channel to
 * report the failure to.
 */
const registry: HandlerRegistry = {
  action(actionId, handler) {
    bolt.action(actionId, async ({ ack, body, action }) => {
      const args: ActionArgs = {
        ack: async () => {
          await ack();
        },
        userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
        channel: (body as { channel?: { id?: string } }).channel?.id ?? '',
        value: (action as { value?: string }).value ?? '',
        triggerId: (body as { trigger_id?: string }).trigger_id,
      };
      await handler(args);
    });
  },
  view(callbackId, handler) {
    bolt.view(callbackId, async ({ ack, body, view }) => {
      const state = view.state as { values?: Record<string, Record<string, { value?: string | null }>> };
      const privateMetadata = view.private_metadata ?? '';
      const args: ViewArgs = {
        ack: async () => {
          await ack();
        },
        userId: (body as { user?: { id?: string } }).user?.id ?? 'unknown',
        channel: parseEditModalMetadata(privateMetadata)?.channel ?? '',
        privateMetadata,
        note: state.values?.[EDIT_NOTE_BLOCK_ID]?.[EDIT_NOTE_ACTION_ID]?.value ?? '',
      };
      await handler(args);
    });
  },
};

const { db, close: closeDb } = createDb();
const api = webClientApi(bolt.client);
const core = createMcpCoreToolsClient({
  command: 'pnpm',
  args: ['--dir', repoRoot, '--filter', '@harness/core-tools', 'start'],
  // The child needs the harness variables; it must not inherit the Slack tokens.
  env: coreToolsChildEnv({ env: process.env, client, storageRoot }),
});

const deps = {
  db,
  api,
  core,
  // The out tree, not the whole store. `forms_release` already narrows to
  // `<root>/out`, and a backstop that accepts more than the thing it backs up
  // is not a backstop: the rest of the store holds ingested documents, which
  // must never be uploadable.
  sinks: slackSinks(api, { defaultChannel: channel, outDir: outRoot(storageRoot) }),
  client,
  channel,
  encryptionKey: loadKey(),
  now: () => new Date(),
  allowedUsers,
};

registerApprovalHandlers(registry, deps);

const runner = startRunner(deps, {
  pollMs: seconds('APPROVALS_POLL_SECONDS', 5) * 1000,
  dispatchMs: seconds('EFFECTS_DISPATCH_SECONDS', 5) * 1000,
  reconcileMs: seconds('RECONCILE_SECONDS', 300) * 1000,
  staleAfterMinutes: 10,
});

const health = startHealthServer({
  port: port('APPROVALS_HEALTH_PORT', 8787),
  // Every interface by default. In Compose nothing can reach a listener on the
  // container's own loopback — not the published host port, not
  // `http://approvals:8787` from Hermes — and the exposure boundary is the port
  // mapping, which is pinned to 127.0.0.1 on the host. Override for a
  // bare-metal run where the process itself is the boundary.
  bind: process.env.APPROVALS_HEALTH_BIND?.trim() || DEFAULT_HEALTH_BIND,
  snapshot: () => collectHealth(db, client, runner, deps.now),
});

await bolt.start();
log.info(
  `listening (client=${client}, channel=${channel}, buttons=${[APPROVE_ACTION_ID, EDIT_ACTION_ID, DECLINE_ACTION_ID].join(',')}, modal=${EDIT_MODAL_CALLBACK_ID})`,
);

async function shutdown(signal: string): Promise<void> {
  log.info(`${signal} received, stopping`);
  try {
    await runner.stop();
    await health.close();
    await bolt.stop();
    await core.close();
    await closeDb();
    process.exit(0);
  } catch (err) {
    log.error('shutdown failed', err);
    process.exit(1);
  }
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
