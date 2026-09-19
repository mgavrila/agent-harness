import * as z from 'zod/v4';
import { ConfigError, SURFACE_NAME_PATTERN, USER_LEVELS } from '@harness/shared';

/**
 * What the client document's `identityPlugin.settings` holds for this plug-in.
 *
 * `groups` is ordered and the first match wins, so a workspace where somebody is both a lead and
 * a member of staff has one answer rather than whichever one the directory happened to list
 * first. `exceptions` are checked before `groups`, because they are how a deployment says "this
 * one person, whatever the directory thinks". `refuse` is a level for the purposes of this list
 * and nowhere else: it means the person is not a principal at all.
 */
export const SlackGroupsSettingsShape = z
  .object({
    surface: z.string().regex(SURFACE_NAME_PATTERN).default('slack'),
    groups: z
      .array(z.object({ id: z.string().min(1), level: z.enum(USER_LEVELS) }).strict())
      .min(1, 'a directory-backed provider needs at least one group to map'),
    exceptions: z
      .array(
        z.object({ userId: z.string().min(1), level: z.union([z.enum(USER_LEVELS), z.literal('refuse')]) }).strict(),
      )
      .default([]),
    sync: z
      .object({ everySeconds: z.number().int().min(30).max(86_400).default(300) })
      .strict()
      .default({ everySeconds: 300 }),
  })
  .strict();

export type SlackGroupsSettings = z.infer<typeof SlackGroupsSettingsShape>;

export function parseSlackGroupsSettings(raw: unknown): SlackGroupsSettings {
  const parsed = SlackGroupsSettingsShape.safeParse(raw ?? {});
  if (!parsed.success) {
    throw new ConfigError(`identityPlugin.settings are invalid: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}
