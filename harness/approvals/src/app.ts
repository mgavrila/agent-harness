import { decideApproval, type DecisionDeps } from './decisions.js';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_MODAL_CALLBACK_ID,
  editModalView,
} from './render.js';

/**
 * What a button press reduces to. Bolt's own payload types are large and
 * change between majors; `main.ts` narrows them onto these three fields once,
 * so the handlers and their tests never touch a Bolt type.
 */
export interface ActionArgs {
  ack: () => Promise<void>;
  userId: string;
  /** The button's `value`: the approval id. */
  value: string;
  triggerId?: string;
}

export interface ViewArgs {
  ack: () => Promise<void>;
  userId: string;
  /** The modal's `private_metadata`: the approval id. */
  privateMetadata: string;
  note: string;
}

export interface HandlerRegistry {
  action(actionId: string, handler: (args: ActionArgs) => Promise<void>): void;
  view(callbackId: string, handler: (args: ViewArgs) => Promise<void>): void;
}

/** Slack drops an interaction that is not acknowledged within three seconds. */
async function ackFirst(ack: () => Promise<void>): Promise<void> {
  try {
    await ack();
  } catch (err) {
    console.error(`approvals: ack failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function report(approvalId: string, result: Awaited<ReturnType<typeof decideApproval>>): void {
  if (result.outcome === 'not_actionable') {
    console.error(`approvals: ${approvalId} was not actionable (already decided, expired, or another client's)`);
  }
}

export function registerApprovalHandlers(registry: HandlerRegistry, deps: DecisionDeps): void {
  registry.action(APPROVE_ACTION_ID, async ({ ack, userId, value }) => {
    await ackFirst(ack);
    report(value, await decideApproval(deps, { approvalId: value, decision: 'approved', decidedBy: userId }));
  });

  registry.action(DECLINE_ACTION_ID, async ({ ack, userId, value }) => {
    await ackFirst(ack);
    report(value, await decideApproval(deps, { approvalId: value, decision: 'declined', decidedBy: userId }));
  });

  // Edit never releases anything: it opens a note box, and submitting it
  // declines with that note so the agent redoes the action and asks again.
  registry.action(EDIT_ACTION_ID, async ({ ack, value, triggerId }) => {
    await ackFirst(ack);
    if (!triggerId) {
      console.error(`approvals: Edit on ${value} arrived without a trigger id; cannot open the modal`);
      return;
    }
    try {
      await deps.api.views.open({ trigger_id: triggerId, view: editModalView(value) });
    } catch (err) {
      console.error(`approvals: could not open the note modal for ${value}: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  registry.view(EDIT_MODAL_CALLBACK_ID, async ({ ack, userId, privateMetadata, note }) => {
    await ackFirst(ack);
    const trimmed = note.trim();
    report(
      privateMetadata,
      await decideApproval(deps, {
        approvalId: privateMetadata,
        decision: 'declined',
        decidedBy: userId,
        note: trimmed === '' ? undefined : trimmed,
      }),
    );
  });
}
