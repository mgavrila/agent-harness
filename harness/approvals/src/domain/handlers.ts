import { createLogger } from '@harness/shared';
import { levelAtLeast, type Principal } from '@harness/identity-api';
import type { ActionEvent, FormEvent, SurfaceSession } from '@harness/surface-api';
import { decideApproval, type DecisionDeps } from './decisions.js';
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
/** An `actionId` no card of this host's carries. Said out loud, because silence looks like a hang. */
const UNKNOWN_ACTION_TEXT = 'That button is not one this assistant posted.';
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
 * Who may act on an approval, in a fixed order: the identity plug-in has to know this surface user,
 * they have to be a person rather than a service (spec invariant 2), and their level has to clear
 * `lead` (invariant 3). Every refusal says the same thing, so an outsider learns nothing about
 * whether the approval exists; then the id itself, because a malformed uuid can name no row.
 *
 * A plug-in that itself fails to resolve — a network error to whatever backs it — is fail-closed
 * exactly like an unknown user, with the identical refusal: the presser gets an answer rather
 * than silence, and learns nothing about why.
 */
async function mayAct(
  session: SurfaceSession,
  deps: DecisionDeps,
  conversation: string,
  userId: string,
  approvalId: string,
): Promise<Principal | null> {
  let principal: Principal | null;
  try {
    principal = await deps.identity.resolve({ surface: session.name, userId });
  } catch (err) {
    log.error(`the identity plug-in failed resolving ${userId} on surface "${session.name}"`, err);
    principal = null;
  }
  if (!principal || principal.kind !== 'user' || !levelAtLeast(principal.level, 'lead')) {
    log.warn(`user ${userId} on surface "${session.name}" may not decide approvals; refused action on ${approvalId}`);
    await tellUser(session, conversation, userId, UNAUTHORIZED_TEXT);
    return null;
  }
  if (!UUID_RE.test(approvalId)) {
    log.warn(`rejected a malformed approval id from ${principal.id}`);
    await tellUser(session, conversation, userId, NOT_FOUND_TEXT);
    return null;
  }
  return principal;
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
  const principal = await mayAct(session, deps, event.conversation, event.userId, event.value);
  if (!principal) return;
  const result = await decideApproval(deps, {
    approvalId: event.value,
    decision,
    decidedBy: principal,
    surface: session.name,
    note,
  });
  if (result.outcome === 'wrong_surface') {
    log.warn(`${event.value} was answered on surface "${session.name}", which is not where its card is`);
    await tellUser(session, event.conversation, event.userId, NOT_FOUND_TEXT);
    return;
  }
  if (result.outcome === 'not_actionable') {
    log.info(`${event.value} was not actionable (already decided, expired, or another client's)`);
  }
}

/** Edit never releases anything: it opens a note box, and submitting it declines with that note. */
async function openEdit(session: SurfaceSession, deps: DecisionDeps, event: ActionEvent): Promise<void> {
  if (!(await mayAct(session, deps, event.conversation, event.userId, event.value))) return;
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
 * An action id for a log line: one of this host's own three, or the word `unknown`.
 *
 * The id on the event is whatever the caller sent — a signed request's payload, or a web
 * workspace's JSON — so writing it down verbatim puts a caller-controlled string in a
 * deployment's log, which is the shape of defect the forged read cursor was. Nothing is lost:
 * the three ids this host posts are the only ones it can act on, and the fourth case is the
 * whole of what an operator needs to know.
 */
function actionForLog(actionId: string): string {
  const known = [APPROVE_ACTION_ID, DECLINE_ACTION_ID, EDIT_ACTION_ID];
  return known.includes(actionId) ? actionId : 'unknown';
}

/**
 * Wire one surface's buttons and forms to the decision path.
 *
 * Called once per loaded surface. A decision is accepted from whichever surface posted the card,
 * so every loaded surface is wired, not only the primary one.
 */
export function registerApprovalHandlers(session: SurfaceSession, deps: DecisionDeps): void {
  session.onAction(async (event: ActionEvent) => {
    try {
      if (event.actionId === APPROVE_ACTION_ID) await decide(session, deps, event, 'approved');
      else if (event.actionId === DECLINE_ACTION_ID) await decide(session, deps, event, 'declined');
      else if (event.actionId === EDIT_ACTION_ID) await openEdit(session, deps, event);
      else {
        // A button from a card this host did not post. The press is still delivered and still
        // acknowledged — it is not a `4xx`, because the door answered before anyone looked at
        // the id — but the person who pressed it hears back, which is what the surface's own
        // API reference has always said happens. Dropping it in silence left a workspace
        // waiting for a frame that never came.
        log.warn(`an unknown action arrived on surface "${session.name}" and was answered`);
        await tellUser(session, event.conversation, event.userId, UNKNOWN_ACTION_TEXT);
      }
    } catch (err) {
      log.error(`the ${actionForLog(event.actionId)} action handler failed`, err);
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
