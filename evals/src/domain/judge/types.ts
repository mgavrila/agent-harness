/**
 * Fields where a string comparison is the wrong instrument. "Riverside Family Medicine" and
 * "Riverside Family Medicine, PC" are the same practice; "$1,000,000 / $3,000,000" and "1M/3M"
 * are the same coverage. Everything else — names, numbers, dates — is scored exactly, because
 * for those a near miss is a miss.
 *
 * The list is the pack's: `Pack.evals.judgedFields`. No restricted field may be in it, because a
 * restricted value never leaves the database in plaintext, so there is nothing to compare, and a
 * judge prompt carrying one would ship it to a third-party model. Task 6's dual-pack test
 * asserts that for every loaded pack.
 */
export interface JudgeItem {
  field: string;
  expected: string;
  actual: string;
  /**
   * Which split the miss came from. Never sent to the model — it is carried so
   * the runner can give each split credit for its own agreed items instead of
   * pooling them, which would move credit from one split to the other.
   */
  split: string;
}

export interface JudgeVerdict {
  field: string;
  split: string;
  same: boolean;
  why: string;
}

export interface JudgeResult {
  scored: number;
  agreed: number;
  agreementRate: number;
  verdicts: JudgeVerdict[];
}
