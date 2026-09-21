import { Cron } from 'croner';
import { ConfigError } from '@harness/shared';

/** The schedule always runs in this zone (decision 16); nothing a document, a row or a caller supplies. */
const SCHEDULE_TIMEZONE = 'UTC';

/**
 * The first firing strictly after `from`, always in UTC. `where` names the playbook, and the
 * client it came from, in the error: a schedule that fires no more is an operator's typo, and the
 * cron string alone does not say which entry to go and fix.
 *
 * The schedule's *shape* is validated in `@harness/config-api`, where the client document's
 * `playbooks` section is declared; this is the one piece of playbook scheduling that needs a
 * clock rather than a schema, so it is the one piece that stayed in the host.
 */
export function nextRunAfter(schedule: string, from: Date, where?: string): Date {
  const next = new Cron(schedule, { timezone: SCHEDULE_TIMEZONE }).nextRun(from);
  if (!next) {
    const subject = where === undefined ? `schedule "${schedule}"` : `${where}: schedule "${schedule}"`;
    throw new ConfigError(`${subject} never fires after ${from.toISOString()}`);
  }
  return next;
}
