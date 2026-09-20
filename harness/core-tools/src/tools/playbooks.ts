import * as z from 'zod/v4';
import { PLAYBOOK_NAME_PATTERN, ToolError } from '@harness/shared';
import { defineTool } from '../domain/tooling/registry.js';
import type { AnyToolDef } from '../domain/tooling/types.js';
import { findPlaybook, listPlaybooks, requestPlaybookRun, summarisePlaybook } from '../domain/playbooks/repository.js';

const SummaryShape = z.object({
  name: z.string(),
  schedule: z.string(),
  timezone: z.string(),
  skill: z.string(),
  principal_id: z.string(),
  surface: z.string().nullable(),
  conversation: z.string().nullable(),
  deliver: z.string(),
  cost_cap_usd: z.number(),
  timeout_s: z.number(),
  enabled: z.boolean(),
  next_run_at: z.string().nullable(),
  last_run_at: z.string().nullable(),
  last_status: z.string().nullable(),
});

const playbooksList = defineTool({
  name: 'playbooks_list',
  description:
    'The scheduled playbooks of this deployment, by name: schedule and timezone, the skill and the service principal each runs as, ' +
    'how its reply is delivered, whether it is enabled, and when it last ran and next runs.',
  actionClass: 'read',
  input: z.object({}),
  output: z.object({ playbooks: z.array(SummaryShape) }),
  handler: async (_args, deps) => ({ playbooks: (await listPlaybooks(deps.db, deps.client)).map(summarisePlaybook) }),
});

const playbooksRunNow = defineTool({
  name: 'playbooks_run_now',
  description:
    'Ask the scheduler to run one playbook at its next tick — within thirty seconds, ahead of its schedule. ' +
    'Returns the id of the requested firing; the run itself opens later, as the playbook’s own service principal.',
  actionClass: 'admin',
  input: z.object({ name: z.string().regex(PLAYBOOK_NAME_PATTERN, 'a playbook name is a lowercase slug') }),
  output: z.object({ playbook_run_id: z.string(), status: z.literal('requested') }),
  handler: async ({ name }, deps) => {
    const playbook = await findPlaybook(deps.db, deps.client, name);
    if (!playbook) throw new ToolError(`no playbook named "${name}"`);
    if (!playbook.enabled)
      throw new ToolError(
        `playbook "${name}" is disabled; enable it in the client document's playbooks section, and the tenant reopens on the next version`,
      );
    const run = await requestPlaybookRun(deps.db, {
      client: deps.client,
      playbookId: playbook.id,
      now: deps.now(),
      requestedBy: deps.principal.id,
    });
    return { playbook_run_id: run.id, status: 'requested' as const };
  },
});

export const playbookTools: AnyToolDef[] = [playbooksList, playbooksRunNow];
