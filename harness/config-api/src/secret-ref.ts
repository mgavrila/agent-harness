import * as z from 'zod/v4';

/** An environment variable name, which is what a `SecretRef`'s `env` member names. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A secret store name, which is what a `SecretRef`'s `ref` member names. */
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A reference to a secret, never the secret.
 *
 * `{ env }` names an environment variable the host resolves from its own process environment.
 * `{ ref }` names a secret in the deployment's secret store, resolved by that store when the
 * tenant opens — and refused there, naming the client and the secret, by a deployment whose
 * secret source is the environment. Exactly one of the two, never both and never neither: a
 * document that carried a literal value would be a document that got copied into a ticket, so
 * the schema admits no such shape at all.
 */
export const SecretRefShape = z.union([
  z
    .object({ env: z.string().regex(ENV_NAME, 'a secret reference names an environment variable (A-Z, digits, _)') })
    .strict(),
  z
    .object({
      ref: z
        .string()
        .regex(SECRET_NAME, "a secret reference names a secret in the deployment's secret store (a-z, digits, -)"),
    })
    .strict(),
]);

export type SecretRef = z.infer<typeof SecretRefShape>;
