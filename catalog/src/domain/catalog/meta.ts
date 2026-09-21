import * as z from 'zod/v4';

const POINTER = /^\/[^\s]*$/;

export const BlueprintInputShape = z
  .object({
    pointer: z.string().regex(POINTER, 'an input pointer is a JSON pointer'),
    label: z.string().min(1).max(80),
    hint: z.string().max(200).optional(),
    example: z.unknown(),
  })
  .strict();

export const CatalogMetaShape = z
  .object({
    displayName: z.string().min(1).max(80),
    description: z.string().min(1).max(400),
    kernel: z.string().regex(/^\d+\.\d+\.\d+$/, 'the kernel version is semver'),
    surfaces: z
      .array(z.enum(['web', 'slack']))
      .min(1)
      .refine((s) => s[0] === 'web', 'web is always first'),
    inputs: z.array(BlueprintInputShape).default([]),
    pack: z.string().min(1).nullable().default(null),
  })
  .strict();
