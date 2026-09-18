import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { Cron } from 'croner';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';
import { PRINCIPAL_ID_PATTERN } from '@harness/identity-api';
import {
  CONVERSATION_ID_PATTERN,
  ConfigError,
  PLAYBOOK_NAME_PATTERN,
  SURFACE_NAME_PATTERN,
  describeError,
} from '@harness/shared';

/** The name shape lives in `@harness/shared`, because `playbooks_run_now` checks the same one. */
export { PLAYBOOK_NAME_PATTERN };

/** `none`: the run's reply is recorded and posted nowhere. `conversation`: posted once to `surface`/`conversation`. */
export const DELIVERIES = ['none', 'conversation'] as const;

/**
 * Five or six whitespace-separated fields (decision 12), and a pattern that fires at least once.
 *
 * The field count is checked before croner sees the string, because croner is wider than the
 * decision: it also takes seven fields, the `@daily` family of nicknames and an ISO one-shot
 * date, none of which a playbook may use. The `nextRun()` call catches the other half — croner
 * builds an impossible calendar date such as `0 0 30 2 *` without complaint and only reports the
 * impossibility when asked for a firing, which would otherwise be a startup crash inside
 * `syncPlaybooks` rather than a parse error here. Building a job with no callback holds no timer,
 * so both halves are pure computation.
 */
function validSchedule(schedule: string): boolean {
  const fields = schedule.trim().split(/\s+/).length;
  if (fields < 5 || fields > 6) return false;
  try {
    return new Cron(schedule).nextRun() !== null;
  } catch {
    return false;
  }
}

function validTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/** One entry of `playbooks:` in `clients/<name>/playbooks.yaml` (spec 5.6). */
export const PlaybookShape = z
  .object({
    name: z.string().regex(PLAYBOOK_NAME_PATTERN, 'a playbook name is a lowercase slug of at most 64 characters'),
    schedule: z
      .string()
      .refine(validSchedule, 'schedule must be a cron expression of five or six fields that fires at least once'),
    timezone: z
      .string()
      .refine(validTimezone, 'timezone must be an IANA zone name such as UTC or America/New_York')
      .default('UTC'),
    skill: z.string().min(1),
    prompt: z.string().min(1).max(4_000),
    principal: z.string().regex(PRINCIPAL_ID_PATTERN, 'principal must be an id declared in identity.yaml'),
    surface: z.string().regex(SURFACE_NAME_PATTERN).optional(),
    conversation: z.string().regex(CONVERSATION_ID_PATTERN).optional(),
    deliver: z.enum(DELIVERIES).default('none'),
    cost_cap_usd: z.number().positive().max(1_000),
    timeout_s: z.number().int().min(10).max(3_600).default(600),
    enabled: z.boolean().default(true),
  })
  .strict();

export const PlaybooksFileShape = z.object({ playbooks: z.array(PlaybookShape).default([]) }).strict();

export type PlaybookDefinition = z.infer<typeof PlaybookShape>;

/**
 * Parse a playbooks file, then apply the two rules zod cannot say: names are unique, and a
 * playbook runs as a service — a person's principal on a schedule would act while they are not
 * there (spec 3.3, 5.6).
 */
export function parsePlaybooksFile(raw: unknown): PlaybookDefinition[] {
  const parsed = PlaybooksFileShape.safeParse(raw ?? {});
  if (!parsed.success) throw new ConfigError(`playbooks file is invalid: ${z.prettifyError(parsed.error)}`);
  const seen = new Set<string>();
  for (const p of parsed.data.playbooks) {
    if (seen.has(p.name)) throw new ConfigError(`playbooks file: "${p.name}" is declared twice`);
    seen.add(p.name);
    if (!p.principal.startsWith('svc-')) {
      throw new ConfigError(
        `playbooks file: "${p.name}" must run as a service principal (svc-…), not "${p.principal}"`,
      );
    }
  }
  return parsed.data.playbooks;
}

/** `clients/<name>/playbooks.yaml`; a client with no file has no playbooks, which is not an error. */
export async function readPlaybooksFile(
  clientDir: string,
): Promise<{ file: string; present: boolean; playbooks: PlaybookDefinition[] }> {
  const file = path.join(clientDir, 'playbooks.yaml');
  let text: string;
  try {
    text = await readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { file, present: false, playbooks: [] };
    throw new ConfigError(`cannot read ${file}: ${describeError(err)}`);
  }
  return { file, present: true, playbooks: parsePlaybooksFile(parseYaml(text)) };
}

/**
 * The first firing strictly after `from`, in `timezone`. `where` names the playbook, and the file
 * it came from, in the error: a schedule that fires no more is an operator's typo, and the cron
 * string alone does not say which entry to go and fix.
 */
export function nextRunAfter(schedule: string, timezone: string, from: Date, where?: string): Date {
  const next = new Cron(schedule, { timezone }).nextRun(from);
  if (!next) {
    const subject = where === undefined ? `schedule "${schedule}"` : `${where}: schedule "${schedule}"`;
    throw new ConfigError(`${subject} never fires after ${from.toISOString()}`);
  }
  return next;
}
