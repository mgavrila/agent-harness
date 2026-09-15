import { readFile } from 'node:fs/promises';
import { parse as parseYaml } from 'yaml';
import * as z from 'zod/v4';

export const ACTION_CLASSES = ['read', 'write.internal', 'external', 'financial', 'destructive'] as const;
export type ActionClass = (typeof ACTION_CLASSES)[number];

export const BEHAVIORS = ['auto', 'approval', 'blocked'] as const;
export type Behavior = (typeof BEHAVIORS)[number];

export type Policy = Record<ActionClass, Behavior>;

export const DEFAULT_POLICY: Policy = {
  read: 'auto',
  'write.internal': 'auto',
  external: 'approval',
  financial: 'blocked',
  destructive: 'approval',
};

const PolicyFile = z.object({
  classes: z.partialRecord(z.enum(ACTION_CLASSES), z.enum(BEHAVIORS)).optional(),
});

export function parsePolicy(yamlText: string): Policy {
  const raw: unknown = parseYaml(yamlText) ?? {};
  const parsed = PolicyFile.safeParse(raw);
  if (!parsed.success) {
    const classes = (raw as { classes?: Record<string, unknown> }).classes ?? {};
    const badKey = Object.keys(classes).find((k) => !(ACTION_CLASSES as readonly string[]).includes(k));
    if (badKey) throw new Error(`policy: unknown action class "${badKey}"`);
    const badVal = Object.values(classes).find((v) => !(BEHAVIORS as readonly string[]).includes(String(v)));
    throw new Error(`policy: invalid behavior "${String(badVal)}"`);
  }
  return { ...DEFAULT_POLICY, ...(parsed.data.classes ?? {}) };
}

export async function loadPolicy(filePath: string | undefined = process.env.HARNESS_POLICY_FILE): Promise<Policy> {
  if (!filePath) return { ...DEFAULT_POLICY };
  const text = await readFile(filePath, 'utf8');
  return parsePolicy(text);
}

export function decide(actionClass: ActionClass, policy: Policy): Behavior {
  return policy[actionClass];
}
