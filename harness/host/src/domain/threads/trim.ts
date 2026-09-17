import type { RunHistoryTurn } from '@harness/runtime-api';

export const HISTORY_MAX_CHARS = 24_000;

/** The newest turns that fit both budgets, oldest first. A turn that alone exceeds the character budget is dropped. */
export function trimHistory(
  turns: readonly RunHistoryTurn[],
  budget: { maxMessages: number; maxChars: number },
): RunHistoryTurn[] {
  const kept: RunHistoryTurn[] = [];
  let chars = 0;
  for (let i = turns.length - 1; i >= 0 && kept.length < budget.maxMessages; i -= 1) {
    if (chars + turns[i].content.length > budget.maxChars) break;
    chars += turns[i].content.length;
    kept.unshift(turns[i]);
  }
  return kept;
}
