import { createLogger } from '@harness/shared';
import { decideApproval, type DecisionDeps } from '../decisions.js';
import { editModalView, parseEditModalMetadata } from '../render/modal.js';
import { APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID, EDIT_MODAL_CALLBACK_ID } from '../render/types.js';

const log = createLogger('approvals');

/**
 * What a button press reduces to. Bolt's own payload types are large and
 * change between majors; `main.ts` narrows them onto these fields once, so
 * the handlers and their tests never touch a Bolt type. `channel` is the
 * interaction's channel (`body.channel.id` in Bolt), used only to address an
 * ephemeral refusal notice back to the user who clicked.
 */
export interface ActionArgs {
  ack: () => Promise<void>;
  userId: string;
  channel: string;
  /** The button's `value`: the approval id. */
  value: string;
  triggerId?: string;
}

export interface ViewArgs {
  ack: () => Promise<void>;
  userId: string;
  /**
   * The interaction's channel, when Bolt happens to supply one. The view
   * submission handler does not trust this: it decodes the channel the Edit
   * button was actually pressed from out of `privateMetadata` instead, since
   * Slack's `view_submission` payload does not otherwise carry a channel.
   * Kept on the interface for symmetry with `ActionArgs` and so a caller that
   * cannot parse the metadata still has a channel to report an error to.
   */
  channel: string;
  /** The modal's `private_metadata`: JSON carrying the approval id and the channel (`editModalView`/`parseEditModalMetadata`). */
  privateMetadata: string;
  note: string;
}

export interface HandlerRegistry {
  action(actionId: string, handler: (args: ActionArgs) => Promise<void>): void;
  view(callbackId: string, handler: (args: ViewArgs) => Promise<void>): void;
}

/**
 * `registerApprovalHandlers`'s dependencies: everything `decideApproval`
 * needs, plus who is allowed to decide anything at all. `allowedUsers` is
 * Slack user ids; an empty set is a misconfiguration, not "allow everyone",
 * so it fails closed and refuses every decision.
 */
export interface AppDeps extends DecisionDeps {
  allowedUsers: ReadonlySet<string>;
}

const UNAUTHORIZED_TEXT = 'You are not an approver for this workspace.';
const NOT_FOUND_TEXT = 'That approval no longer exists.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Parse `SLACK_ALLOWED_USERS`: comma-separated Slack user ids, trimmed, empty
 * entries dropped. Task 7's entrypoint reads the env var and calls this; it
 * is not wired to anything here.
 */
export function parseAllowedUsers(env: string | undefined): ReadonlySet<string> {
  const ids = (env ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter((id) => id !== '');
  return new Set(ids);
}

/** Slack drops an interaction that is not acknowledged within three seconds. */
async function ackFirst(ack: () => Promise<void>): Promise<void> {
  try {
    await ack();
  } catch (err) {
    log.error('ack failed', err);
  }
}

/** Best-effort notice to the one user who clicked; a failure here is only logged. */
async function tellUser(deps: AppDeps, channel: string, userId: string, text: string): Promise<void> {
  try {
    await deps.api.chat.postEphemeral({ channel, user: userId, text });
  } catch (err) {
    log.error(`could not post an ephemeral notice to ${userId}`, err);
  }
}

/**
 * True when the caller may act on approvals at all. Checked before every
 * decision-affecting action and the modal submission, and before the id is
 * even looked at, so an unauthorized user learns nothing about whether the
 * approval exists. Nothing about the approval's contents is logged.
 */
async function authorize(deps: AppDeps, channel: string, userId: string, approvalId: string): Promise<boolean> {
  if (deps.allowedUsers.has(userId)) return true;
  log.warn(`user ${userId} is not an approver; refused action on ${approvalId}`);
  await tellUser(deps, channel, userId, UNAUTHORIZED_TEXT);
  return false;
}

/** A button value or private_metadata that is not a well-formed uuid can never name a row. */
async function validId(deps: AppDeps, channel: string, userId: string, id: string): Promise<boolean> {
  if (UUID_RE.test(id)) return true;
  log.warn(`rejected a malformed approval id from ${userId}`);
  await tellUser(deps, channel, userId, NOT_FOUND_TEXT);
  return false;
}

function report(approvalId: string, result: Awaited<ReturnType<typeof decideApproval>>): void {
  if (result.outcome === 'not_actionable') {
    log.info(`${approvalId} was not actionable (already decided, expired, or another client's)`);
  }
}

/**
 * Approve and Decline differ only in the decision they record, so they are
 * registered from one definition: the authorization check, the id check and the
 * swallow-and-log are the part that must not drift between the two buttons.
 */
function registerDecisionButton(
  registry: HandlerRegistry,
  deps: AppDeps,
  actionId: string,
  decision: 'approved' | 'declined',
  label: string,
): void {
  registry.action(actionId, async ({ ack, userId, channel, value }) => {
    await ackFirst(ack);
    try {
      if (!(await authorize(deps, channel, userId, value))) return;
      if (!(await validId(deps, channel, userId, value))) return;
      report(value, await decideApproval(deps, { approvalId: value, decision, decidedBy: userId }));
    } catch (err) {
      log.error(`${label} handler failed`, err);
    }
  });
}

export function registerApprovalHandlers(registry: HandlerRegistry, deps: AppDeps): void {
  if (deps.allowedUsers.size === 0) {
    log.warn('SLACK_ALLOWED_USERS is empty; all decisions are refused');
  }

  registerDecisionButton(registry, deps, APPROVE_ACTION_ID, 'approved', 'Approve');
  registerDecisionButton(registry, deps, DECLINE_ACTION_ID, 'declined', 'Decline');

  // Edit never releases anything: it opens a note box, and submitting it
  // declines with that note so the agent redoes the action and asks again.
  registry.action(EDIT_ACTION_ID, async ({ ack, userId, channel, value, triggerId }) => {
    await ackFirst(ack);
    try {
      if (!(await authorize(deps, channel, userId, value))) return;
      if (!(await validId(deps, channel, userId, value))) return;
      if (!triggerId) {
        log.warn(`Edit on ${value} arrived without a trigger id; cannot open the modal`);
        return;
      }
      await deps.api.views.open({ trigger_id: triggerId, view: editModalView(value, channel) });
    } catch (err) {
      log.error('could not open the note modal', err);
    }
  });

  registry.view(EDIT_MODAL_CALLBACK_ID, async ({ ack, userId, channel, privateMetadata, note }) => {
    await ackFirst(ack);
    try {
      const metadata = parseEditModalMetadata(privateMetadata);
      if (!metadata) {
        // No parsed channel to address an ephemeral to; fall back to whatever
        // Bolt gave us, and only log if even that is unavailable.
        log.warn('modal submission arrived with unreadable private metadata');
        if (channel) await tellUser(deps, channel, userId, NOT_FOUND_TEXT);
        return;
      }
      const { approvalId, channel: modalChannel } = metadata;
      if (!(await authorize(deps, modalChannel, userId, approvalId))) return;
      if (!(await validId(deps, modalChannel, userId, approvalId))) return;
      const trimmed = note.trim();
      report(
        approvalId,
        await decideApproval(deps, {
          approvalId,
          decision: 'declined',
          decidedBy: userId,
          note: trimmed === '' ? undefined : trimmed,
        }),
      );
    } catch (err) {
      log.error('modal submission handler failed', err);
    }
  });
}
