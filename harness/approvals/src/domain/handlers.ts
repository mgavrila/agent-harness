import { createLogger } from '@harness/shared';
import { allowsUser, type ActionEvent, type FormEvent, type SurfaceSession } from '@harness/surface-api';
import { decideApproval, type DecisionDeps, type DecisionResult } from './decisions.js';
import {
  APPROVE_ACTION_ID,
  DECLINE_ACTION_ID,
  EDIT_ACTION_ID,
  EDIT_FORM_ID,
  EDIT_NOTE_FIELD_ID,
  editForm,
  parseApprovalMetadata,
} from './cards.js';

const log = createLogger('approvals');

const UNAUTHORIZED_TEXT = 'You are not an approver for this workspace.';
const NOT_FOUND_TEXT = 'That approval no longer exists.';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Best-effort notice to the one person who acted; a failure here is only logged. */
async function tellUser(session: SurfaceSession, conversation: string, userId: string, text: string): Promise<void> {
  if (!session.capabilities.privateReply) {
    // Saying it out loud instead would tell the whole conversation that someone tried.
    log.warn(`surface "${session.name}" cannot send a private note; ${userId} was refused silently`);
    return;
  }
  try {
    await session.postPrivate(conversation, userId, text);
  } catch (err) {
    log.error(`could not send a private notice to ${userId}`, err);
  }
}

/**
 * True when this person may act on approvals *on this surface at all*. Checked before every
 * decision and before the id is even looked at, so someone unauthorised learns nothing about
 * whether the approval exists. Allowlists are per surface: an identity on one surface and an
 * identity on another are different people until something says otherwise.
 */
async function authorize(
  session: SurfaceSession,
  conversation: string,
  userId: string,
  approvalId: string,
): Promise<boolean> {
  if (allowsUser(session.allowedUsers, userId)) return true;
  log.warn(`user ${userId} is not an approver on surface "${session.name}"; refused action on ${approvalId}`);
  await tellUser(session, conversation, userId, UNAUTHORIZED_TEXT);
  return false;
}

/** A value that is not a well-formed uuid can never name a row. */
async function validId(session: SurfaceSession, conversation: string, userId: string, id: string): Promise<boolean> {
  if (UUID_RE.test(id)) return true;
  log.warn(`rejected a malformed approval id from ${userId}`);
  await tellUser(session, conversation, userId, NOT_FOUND_TEXT);
  return false;
}

function report(approvalId: string, result: DecisionResult): void {
  if (result.outcome === 'not_actionable') {
    log.info(`${approvalId} was not actionable (already decided, expired, or another client's)`);
  }
}

/**
 * Authorise, check the id, decide, and answer.
 *
 * A decision arriving on a surface the card was not posted to gets the same answer as an
 * approval that does not exist, and for the same reason: from where the person is standing, it
 * does not. One approval has one card in one place.
 */
async function decide(
  session: SurfaceSession,
  deps: DecisionDeps,
  event: { conversation: string; userId: string; value: string },
  decision: 'approved' | 'declined',
  note?: string,
): Promise<void> {
  if (!(await authorize(session, event.conversation, event.userId, event.value))) return;
  if (!(await validId(session, event.conversation, event.userId, event.value))) return;
  const result = await decideApproval(deps, {
    approvalId: event.value,
    decision,
    decidedBy: event.userId,
    surface: session.name,
    note,
  });
  if (result.outcome === 'wrong_surface') {
    log.warn(`${event.value} was answered on surface "${session.name}", which is not where its card is`);
    await tellUser(session, event.conversation, event.userId, NOT_FOUND_TEXT);
    return;
  }
  report(event.value, result);
}

/** Edit never releases anything: it opens a note box, and submitting it declines with that note. */
async function openEdit(session: SurfaceSession, event: ActionEvent): Promise<void> {
  if (!(await authorize(session, event.conversation, event.userId, event.value))) return;
  if (!(await validId(session, event.conversation, event.userId, event.value))) return;
  if (!event.trigger) {
    log.warn(`Edit on ${event.value} arrived with no trigger; cannot open the form`);
    return;
  }
  try {
    await session.openForm(event.trigger, editForm(event.value, event.conversation));
  } catch (err) {
    log.error('could not open the note form', err);
  }
}

/**
 * Wire one surface's buttons and forms to the decision path.
 *
 * Called once per loaded surface. A decision is accepted from whichever surface posted the card,
 * so every loaded surface is wired, not only the primary one.
 */
export function registerApprovalHandlers(session: SurfaceSession, deps: DecisionDeps): void {
  if (session.allowedUsers.size === 0) {
    log.warn(`surface "${session.name}" has an empty allowlist; every decision there is refused`);
  }

  session.onAction(async (event: ActionEvent) => {
    try {
      if (event.actionId === APPROVE_ACTION_ID) await decide(session, deps, event, 'approved');
      else if (event.actionId === DECLINE_ACTION_ID) await decide(session, deps, event, 'declined');
      else if (event.actionId === EDIT_ACTION_ID) await openEdit(session, event);
      // Anything else belongs to a card this host did not post.
    } catch (err) {
      log.error(`the ${event.actionId} handler failed`, err);
    }
  });

  session.onFormSubmit(async (event: FormEvent) => {
    if (event.formId !== EDIT_FORM_ID) return;
    try {
      const metadata = parseApprovalMetadata(event.metadata);
      if (!metadata) {
        // No conversation to address a private notice to; fall back to whatever the surface
        // reported, and only log if even that is unavailable.
        log.warn('a form submission arrived with unreadable metadata');
        const conversation = event.conversation || session.defaultConversation;
        await tellUser(session, conversation, event.userId, NOT_FOUND_TEXT);
        return;
      }
      const note = (event.values[EDIT_NOTE_FIELD_ID] ?? '').trim();
      await decide(
        session,
        deps,
        { conversation: metadata.conversation, userId: event.userId, value: metadata.approvalId },
        'declined',
        note === '' ? undefined : note,
      );
    } catch (err) {
      log.error('the form submission handler failed', err);
    }
  });
}
