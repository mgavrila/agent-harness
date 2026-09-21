import * as z from 'zod/v4';

const emails = z
  .string()
  .default('')
  .transform((s) =>
    s
      .split(',')
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean),
  );

export const EnvShape = z.object({
  DATABASE_URL: z.string().min(1),
  KERNEL_DATABASE_URL: z.string().min(1),
  HOST_URL: z.string().url(),
  HARNESS_HOST_TOKEN: z.string().min(1),
  HARNESS_ENCRYPTION_KEY: z
    .string()
    .refine((s) => Buffer.from(s, 'base64').length === 32, 'HARNESS_ENCRYPTION_KEY must be 32 bytes, base64'),
  GOOGLE_CLIENT_ID: z.string().min(1),
  GOOGLE_CLIENT_SECRET: z.string().min(1),
  OIDC_ISSUER: z.string().url().default('https://accounts.google.com'),
  SESSION_SECRET: z.string().min(32, 'SESSION_SECRET must be at least 32 characters'),
  PLATFORM_URL: z.string().url(),
  PLATFORM_SUPERADMINS: emails,
  KNOWLEDGE_DIR: z.string().min(1),
  /** The knowledge root as the kernel host sees it (its bind mount), written into documents. */
  KNOWLEDGE_MOUNT: z.string().default('/srv/knowledge'),
  BLUEPRINTS_DIR: z.string().optional(),
  PORT: z.coerce.number().int().default(8790),
});

export type Env = z.infer<typeof EnvShape>;

export function loadEnv(source: Record<string, string | undefined> = process.env): Env {
  const parsed = EnvShape.safeParse(source);
  if (!parsed.success) throw new Error(`environment is invalid: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
