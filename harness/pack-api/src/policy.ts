/**
 * The action-class vocabulary and the shape of a policy table. A pack ships a
 * `Partial<Policy>` of defaults for the actions it introduces, so these five declarations
 * have to be reachable without importing core-tools. `DEFAULT_POLICY`, `parsePolicy`,
 * `loadPolicy` and `decide` stay in core-tools: reading a YAML file and deciding what to do
 * with a class is the kernel's job, not the contract's.
 */
export const ACTION_CLASSES = ['read', 'write.internal', 'external', 'financial', 'destructive'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const BEHAVIORS = ['auto', 'approval', 'blocked'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export type Policy = Record<ActionClass, Behavior>;
