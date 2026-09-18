import type { PlaybookRow } from '@harness/core-tools';
import type { Principal } from '@harness/identity-api';
import type { RunSkill } from '@harness/runtime-api';
import type { SurfaceSession } from '@harness/surface-api';
import type { Host } from '../host.js';

export type PreflightResult =
  { ok: true; skill: RunSkill; principal: Principal; surface: SurfaceSession } | { ok: false; reason: string };

/**
 * Spec 3.3 step 2, in that order: the skill exists in a loaded pack, the principal exists and is
 * a service, the surface the playbook names is loaded, the cost cap is a number. The first
 * failure wins. Every reason is a fixed sentence naming a skill, principal or surface *name* —
 * it goes into `playbook_runs.error` and into a notice on a surface, both plaintext. A plug-in
 * that fails to answer is a failed preflight, not a thrown tick: nothing runs as a principal
 * nobody vouched for.
 */
export async function preflightPlaybook(
  host: Pick<Host, 'skills' | 'identity' | 'surfaces' | 'log'>,
  playbook: PlaybookRow,
): Promise<PreflightResult> {
  const skill = host.skills.find((s) => s.name === playbook.skill);
  if (!skill) return { ok: false, reason: `skill "${playbook.skill}" is not in any loaded pack` };
  let principal: Principal | null;
  try {
    principal = await host.identity.get(playbook.principalId);
  } catch (err) {
    host.log.error(
      `the identity plug-in failed resolving "${playbook.principalId}" for playbook "${playbook.name}"`,
      err,
    );
    return { ok: false, reason: `the identity plug-in could not answer for principal "${playbook.principalId}"` };
  }
  if (!principal)
    return { ok: false, reason: `principal "${playbook.principalId}" is not declared by the identity plug-in` };
  if (principal.kind !== 'service')
    return { ok: false, reason: `principal "${playbook.principalId}" is not a service` };
  const surface = playbook.surface === null ? host.surfaces.primary : host.surfaces.find(playbook.surface);
  if (!surface) return { ok: false, reason: `surface "${playbook.surface}" is not loaded` };
  if (!Number.isFinite(playbook.costCapUsd) || playbook.costCapUsd <= 0) {
    return { ok: false, reason: 'cost_cap_usd is not a positive number' };
  }
  return { ok: true, skill, principal, surface };
}
