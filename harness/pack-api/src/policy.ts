import type { Level } from '@harness/shared';

/**
 * The action-class vocabulary and the shape of a policy table. A pack ships a `PolicyOverrides`
 * of defaults for the actions it introduces, so these declarations have to be reachable without
 * importing core-tools. `DEFAULT_POLICY`, `mergePolicy`, `parsePolicy`, `loadPolicy` and
 * `decide` stay in core-tools: reading a YAML file and deciding what to do with a class is the
 * kernel's job, not the contract's.
 *
 * Eight classes since Plan 7. `write.self` is a write to the caller's own scope (their memory,
 * their preferences); `write.assign` gives work to someone else; `admin` changes who may do what.
 * None of the three is used by a shipped tool yet — they exist so the level matrix can say what
 * happens when one arrives.
 */
export const ACTION_CLASSES = [
  'read',
  'write.self',
  'write.internal',
  'write.assign',
  'external',
  'financial',
  'destructive',
  'admin',
] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const BEHAVIORS = ['auto', 'approval', 'blocked'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

/** One behaviour per class: what every level gets unless a level override says otherwise. */
export type ClassTable = Record<ActionClass, Behavior>;

/** Per level, the classes that level decides differently from the class table. */
export type LevelOverrides = Partial<Record<Level, Partial<Record<ActionClass, Behavior>>>>;

/**
 * A policy is a matrix: `classes` is the row every level starts from, `levels.<level>.<class>`
 * is where a level differs. `decide` reads `levels[level]?.[class] ?? classes[class]`.
 */
export interface Policy {
  classes: ClassTable;
  levels: LevelOverrides;
}

/**
 * What a `policy.yaml` parses to, and what `Pack.policy` carries: both halves partial, because a
 * client's file and a pack's defaults each say only what they want to change.
 */
export interface PolicyOverrides {
  classes?: Partial<ClassTable>;
  levels?: LevelOverrides;
}
