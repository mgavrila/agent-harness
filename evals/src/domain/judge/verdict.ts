import { assertRedacted, callModelJson, isRestrictedName, type ToolDeps } from '@harness/core-tools';
import { describeError } from '@harness/shared';
import { JUDGE_SCHEMA, JUDGE_SYSTEM_PROMPT, JudgeReply } from './prompts.js';
import type { JudgeItem, JudgeResult, JudgeVerdict } from './types.js';

const NOTHING_TO_JUDGE: JudgeResult = { scored: 0, agreed: 0, agreementRate: 1, verdicts: [] };

/**
 * One call for the whole batch. The judge route is deliberately a different
 * model family from `extract`, so the grader is not marking its own homework.
 *
 * Returns `null` when the judge could not run at all — the route was down, the
 * reply did not parse. That is not the same as a judge that ran and agreed with
 * everything, and it must not be scored as one: `null` travels up to
 * `report.judge`, which drops `judge.agreement_rate` from the metric map
 * entirely rather than writing a number nobody measured. A broken judge still
 * must not take an eval run down, so it does not throw; it just declines to
 * award any split credit.
 *
 * A run with nothing to judge is different again, and returns a real result
 * with `scored: 0`.
 *
 * Only the field name and the two strings go into the prompt. Nothing else
 * from the document does, and a restricted field is dropped outright rather
 * than judged.
 */
export async function judgeFreeText(deps: ToolDeps, items: JudgeItem[]): Promise<JudgeResult | null> {
  const safe = items.filter((it) => !isRestrictedName(it.field));
  if (safe.length === 0) return NOTHING_TO_JUDGE;

  const listing = safe
    .map(
      (it, i) =>
        `${i}. field=${it.field}\n   expected: ${JSON.stringify(it.expected)}\n   actual:   ${JSON.stringify(it.actual)}`,
    )
    .join('\n');

  const messages = [
    { role: 'system' as const, content: JUDGE_SYSTEM_PROMPT },
    { role: 'user' as const, content: `Judge these ${safe.length} pairs.\n\n${listing}` },
  ];
  // The same last gate every other prompt builder on the branch runs, over the
  // exact messages about to go out. Nothing here is expected to trip it — the
  // pack's judged list holds no restricted name, a masked value arrives as null,
  // and isRestrictedName filtered the batch above — but the invariant is
  // stated unconditionally, so it is checked rather than reasoned about. It
  // throws a plain Error, not a ToolError: a hole in redaction is not
  // something to report to a model.
  for (const m of messages) assertRedacted(m.content);

  let raw: { index: number; same: boolean; why: string }[];
  try {
    const { json } = await callModelJson(deps, {
      route: 'judge',
      temperature: 0,
      messages,
      jsonSchema: { name: 'extraction_verdicts', schema: JUDGE_SCHEMA },
      validate: JudgeReply,
    });
    raw = json.verdicts ?? [];
  } catch (err) {
    // The gateway's error messages carry a route and an HTTP status and never
    // a prompt, so this is safe to print.
    process.stderr.write(`judge unavailable, reporting no agreement rate: ${describeError(err)}\n`);
    return null;
  }

  const verdicts: JudgeVerdict[] = safe.map((it, i) => {
    const hit = raw.find((v) => v.index === i);
    return { field: it.field, split: it.split, same: hit?.same === true, why: hit?.why ?? 'no verdict returned' };
  });
  const agreed = verdicts.filter((v) => v.same).length;
  return {
    scored: verdicts.length,
    agreed,
    agreementRate: verdicts.length === 0 ? 1 : agreed / verdicts.length,
    verdicts,
  };
}
