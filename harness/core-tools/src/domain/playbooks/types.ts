import type { playbookRuns, playbooks } from '@harness/db';

/**
 * Scheduled work (spec 5.6). The rows are the host's to write — it upserts the file at startup
 * and its scheduler claims and closes runs — and this package's to read and to request from: the
 * two `playbooks_*` tools and the types both sides share live here.
 */
export type PlaybookRow = typeof playbooks.$inferSelect;
export type PlaybookRunRow = typeof playbookRuns.$inferSelect;

/**
 * `requested`: asked for by `playbooks_run_now`, waiting for the scheduler's next tick.
 * `running`: claimed. Then one of `done`, `failed` (after the retry) or `preflight_failed`
 * (no model call was made).
 */
export const PLAYBOOK_RUN_STATUSES = ['requested', 'running', 'done', 'failed', 'preflight_failed'] as const;
export type PlaybookRunStatus = (typeof PLAYBOOK_RUN_STATUSES)[number];

/** A playbook as the model sees it: everything but the prompt, which can be long and is the file's business. */
export interface PlaybookSummary {
  name: string;
  schedule: string;
  timezone: string;
  skill: string;
  principal_id: string;
  surface: string | null;
  conversation: string | null;
  deliver: string;
  cost_cap_usd: number;
  timeout_s: number;
  enabled: boolean;
  next_run_at: string | null;
  last_run_at: string | null;
  last_status: string | null;
}
