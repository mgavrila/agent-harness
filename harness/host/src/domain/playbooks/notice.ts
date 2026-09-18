import { depsForRun, stageEffect, type PlaybookRow } from '@harness/core-tools';
import type { Host } from '../host.js';

/** `playbook:<name>:<scheduled_at>` — one notice per firing, however many times the failure is reported (spec 3.3 step 4). */
export function playbookNoticeKey(name: string, scheduledAt: Date): string {
  return `playbook:${name}:${scheduledAt.toISOString()}`;
}

/**
 * Stage the one failure notice a firing may produce, through the effects outbox like every
 * other write that leaves the process (invariant 4). Addressed to the playbook's own surface
 * and conversation; both null means the primary surface's default conversation, which the
 * `surface_message` sink already resolves. The text is one of the scheduler's two fixed
 * sentences and carries nothing from the model. A second stage under the same key is a no-op.
 */
export async function stagePlaybookNotice(
  host: Pick<Host, 'db' | 'config' | 'identity' | 'servicePrincipal' | 'log'>,
  notice: { playbook: PlaybookRow; scheduledAt: Date; runId: string | null; threadId: string | null; text: string },
): Promise<{ effect_id: string; staged: boolean }> {
  // The row is stamped with the playbook's own principal when the identity plug-in knows it,
  // and the host's otherwise (a preflight that failed on the principal still owes a notice).
  const principal = (await host.identity.get(notice.playbook.principalId).catch(() => null)) ?? host.servicePrincipal;
  const deps = depsForRun(host.config, {
    db: host.db,
    principal,
    context: {
      runId: notice.runId,
      threadId: notice.threadId,
      surface: notice.playbook.surface,
      conversation: notice.playbook.conversation,
      tool: 'scheduler',
    },
  });
  const staged = await stageEffect(deps, {
    sink: 'surface_message',
    idempotencyKey: playbookNoticeKey(notice.playbook.name, notice.scheduledAt),
    payload: { text: notice.text, surface: notice.playbook.surface, conversation: notice.playbook.conversation },
    summary: `Playbook "${notice.playbook.name}" failure notice`,
  });
  if (staged.staged)
    host.log.warn(`playbook "${notice.playbook.name}": failure notice staged (effect ${staged.effect_id})`);
  return staged;
}
