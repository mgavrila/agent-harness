import type { CoreToolsClient, DecidedOutcome, DecisionDeps } from '@harness/approvals';
import { containsRestrictedPattern } from '@harness/core-tools/redaction';
import { eq } from 'drizzle-orm';
import { threads } from '@harness/db';
import { runTurn, serialize } from './conversation.js';
import type { Host } from './host.js';
import { WITHHELD } from './threads/repository.js';

/**
 * The one host-authored message a decision puts on the thread (decision 15). It reports what
 * already happened — the execution ran before this is called — so the agent never has to guess
 * and never says an action succeeded while it is pending. A note or an error is free text from
 * the outside and gets the redaction check every other plaintext write gets.
 */
export function resumeText({ row, decidedBy, execution }: DecidedOutcome): string {
  const head = `Approval ${row.id} for ${row.action}`;
  const who = decidedBy.displayName;
  if (row.status !== 'declined') {
    if (execution?.status === 'executed') {
      return `${head} was approved by ${who} and executed: delivery is queued in the effects outbox. Continue the workflow from here.`;
    }
    const reason =
      execution?.status === 'failed' && !containsRestrictedPattern(execution.error)
        ? execution.error
        : 'see the audit log';
    return `${head} was approved by ${who} but execution failed: ${reason}. Nothing was sent.`;
  }
  const note = row.decisionNote
    ? ` Note: ${containsRestrictedPattern(row.decisionNote) ? WITHHELD : row.decisionNote}`
    : '';
  return `${head} was declined by ${who}. Nothing was sent.${note}`;
}

/**
 * The `onDecided` hook: find the thread the action was parked from and run one more turn on it,
 * as the thread's own principal, with the outcome as the input. An approval parked outside a
 * thread (the stdio server, the eval runner) has nothing to resume.
 */
export function resumeOnDecision(host: Host): (outcome: DecidedOutcome) => Promise<void> {
  return async (outcome) => {
    if (!outcome.row.threadId) return;
    const thread = await host.db.query.threads.findFirst({ where: eq(threads.id, outcome.row.threadId) });
    if (!thread) return;
    const principal = await host.identity.get(thread.principalId);
    if (!principal) {
      host.log.warn(
        `thread ${thread.id} belongs to principal "${thread.principalId}", which the identity plug-in no longer knows; not resumed`,
      );
      return;
    }
    // Through the thread's own chain: a decision can land while the thread is still mid-turn, and
    // the resume is a turn like any other.
    await serialize(host, thread.id, () =>
      runTurn(host, { thread, principal, role: 'host', text: resumeText(outcome), attachments: [], replyTo: null }),
    );
  };
}

/** The approvals package's dependency bag, from the host's. */
export function decisionDeps(host: Host, core: CoreToolsClient): DecisionDeps {
  return {
    db: host.db,
    surfaces: host.surfaces,
    core,
    identity: host.identity,
    client: host.client,
    now: host.now,
    onDecided: resumeOnDecision(host),
  };
}
