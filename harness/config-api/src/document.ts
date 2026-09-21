import * as z from 'zod/v4';
import { IdentityFileShape, parseIdentityFileWithDefaults } from '@harness/identity-api';
import { ConfigError } from '@harness/shared';
import { PlaybooksFileShape, parsePlaybooksFile } from './playbooks.js';
import { ClientPolicyShape } from './policy.js';
import { RoutingFile } from './routing.js';

/** Bumped when a document's shape changes in a way `migrate` has to answer for. */
export const CLIENT_DOCUMENT_VERSION = 1;

/**
 * A client id: lowercase letters, digits and hyphens, 2 to 64 characters.
 *
 * A safe path segment, a safe Postgres `client` value and a safe URL segment, which is what the
 * shape is for.
 *
 * Exported because more than one caller has to agree on it and a second copy is a second answer.
 * The schema below validates what a document declares itself to be; `@harness/config-files` turns
 * one into a path segment and refuses a string it cannot spell; and the host checks the segment a
 * *request* puts in `/tenants/<clientId>/…` before it hands it to either, because that route has
 * no bearer in front of it and a source is entitled to throw on a string that is not an id.
 */
export const CLIENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** A plug-in name: the same rule `defineSurface`, the identity plug-in definer and `definePack` apply. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** A skill's directory name, which `readSkillCatalogue` requires the frontmatter `name` to match. */
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

/** An environment variable name, which is what a `SecretRef`'s `env` member names. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A secret store name, which is what a `SecretRef`'s `ref` member names. */
const SECRET_NAME = /^[a-z][a-z0-9-]*$/;

/**
 * A reference to a secret, never the secret.
 *
 * `{ env }` names an environment variable the host resolves from its own process environment.
 * `{ ref }` names a secret in the deployment's secret store; until a deployment has one, a
 * document that carries a `{ ref }` parses but is refused when a tenant opens (see
 * `assertSecretsPresent` in the host). Exactly one of the two, never both and never neither: a
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

/**
 * The surfaces a client may declare, in the order the host loads them.
 *
 * **The order is the schema's, not the file's.** The first loaded surface is the primary — where
 * approval cards go — and a file's key order is not something a YAML writer or a JSON column
 * should be able to change by accident. `web` is first because it is the surface the platform's
 * own workspace talks to; `http` is last because it cannot post a card, which is a rule the
 * schema states by ordering rather than one a deployment has to remember.
 */
export const SURFACE_ORDER = ['web', 'slack', 'memory', 'http'] as const;

/** The one surface that may never be a client's primary. */
const CANNOT_BE_PRIMARY = 'http';

const SurfacesShape = z
  .object({
    web: z
      .object({
        /** The bearer every request to this surface carries; only the platform's control plane holds it. */
        token: SecretRefShape,
      })
      .strict()
      .optional(),
    slack: z
      .object({
        /** The workspace this client is; the host matches an inbound event's tenant hint against it. */
        teamId: z.string().min(1).max(64),
        signingSecret: SecretRefShape,
        botToken: SecretRefShape,
      })
      .strict()
      .optional(),
    memory: z
      .object({
        /**
         * An optional workspace name for the memory surface, with exactly the role `teamId` has
         * for Slack: it is what an inbound event's tenant hint is matched against. It exists so
         * spec §9's pooled-tenant isolation work, which the memory surface proves because it
         * needs no network to run in a suite, has a hint to match tenants against.
         */
        workspace: z.string().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
    http: z.object({}).strict().optional(),
  })
  .strict();

export const ClientDocumentShape = z
  .object({
    schemaVersion: z.number().int().min(1),
    id: z.string().regex(CLIENT_ID_PATTERN, 'a client id is lowercase letters, digits and hyphens, 2 to 64 characters'),
    displayName: z.string().trim().min(1).max(120),
    /** The persona, verbatim: what a runtime puts at the top of what the model reads. */
    persona: z.string().min(1),
    /** The declared principals, and the level everyone else gets. */
    identity: IdentityFileShape,
    /** The action-class overrides, plus the tools this client withholds. */
    policy: ClientPolicyShape,
    /** The five named routes, and what this client's deployments are for each. */
    routing: RoutingFile,
    /** The scheduled work this client runs. */
    playbooks: PlaybooksFileShape,
    /** Today's skills/ directory: name → the whole SKILL.md, frontmatter included. */
    skills: z.record(z.string().regex(SKILL_NAME), z.string().min(1)).default({}),
    knowledge: z
      .discriminatedUnion('source', [
        z.object({ source: z.literal('dir'), path: z.string().min(1) }).strict(),
        z.object({ source: z.literal('store') }).strict(),
      ])
      .default({ source: 'store' }),
    surfaces: SurfacesShape,
    identityPlugin: z
      .object({
        kind: z.string().regex(PLUGIN_NAME, 'an identity plug-in kind is a plug-in name'),
        /** Plug-in-specific settings; the plug-in validates them with its own schema. */
        settings: z.record(z.string(), z.unknown()).default({}),
      })
      .strict(),
    runtime: z.string().regex(PLUGIN_NAME, 'a runtime is a plug-in name'),
    /**
     * Declared plug-ins (MCP and A2A endpoints). Reserved: Plan 12 defines the entry shape, and
     * until it does a document that carries one would be a document whose plug-ins nothing runs.
     */
    plugins: z.array(z.unknown()).max(0, 'declared plug-ins arrive in Plan 12').default([]),
    /** Package names of the packs this client serves. An empty list is a client with no pack. */
    packs: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ClientDocument = z.infer<typeof ClientDocumentShape>;

/** The surfaces this document declares, in load order; the first is the primary. */
export function surfaceNamesOf(document: ClientDocument): string[] {
  return SURFACE_ORDER.filter((name) => document.surfaces[name] !== undefined);
}

/**
 * The opaque keys an inbound event's tenant hint is matched against, one per surface that has a
 * way of naming the workspace it belongs to.
 *
 * This function is where the typed surface sections are read, so the host never is: it builds its
 * `surface:key → client id` map from these pairs and stays free of any vendor's field name, which
 * `kernel-vocabulary.test.ts` requires of `harness/host/src`.
 */
export function tenantKeysOf(document: ClientDocument): { surface: string; key: string }[] {
  const keys: { surface: string; key: string }[] = [];
  // A web tenant has no workspace but itself: the requests that reach it are addressed to its own
  // mount, so its own id is the key an inbound event's hint is matched against. Without this a
  // pooled host would refuse every web message for a null hint (`pooledResolver`) while a
  // dedicated one answered — the worst shape a bug can have, because a single-tenant suite would
  // stay green.
  if (document.surfaces.web) keys.push({ surface: 'web', key: document.id });
  if (document.surfaces.slack) keys.push({ surface: 'slack', key: document.surfaces.slack.teamId });
  if (document.surfaces.memory?.workspace) {
    keys.push({ surface: 'memory', key: document.surfaces.memory.workspace });
  }
  return keys;
}

/** One `SecretRef` a document's surfaces named, with the surface and field it was named under. */
export type SurfaceSecretRef = { surface: string; field: string } & SecretRef;

/**
 * Every `SecretRef` this document's surfaces refer to, with the surface that named it and the
 * field it was named under.
 *
 * The same reason `tenantKeysOf` exists: the typed surface sections are read here, so the host
 * never is. A host that checked a `signingSecret` by name would have a vendor's field in the one
 * process every client runs, which `kernel-vocabulary.test.ts` forbids `harness/host/src`. `field`
 * travels as an opaque string: the host copies it into the bag the adapter is handed, and the
 * adapter — which is allowed to know what its own fields are called — looks its variable up. The
 * value itself never appears: a `SecretRef` names an environment variable or a secret store entry
 * and never the secret itself. An entry named by `{ ref }` rather than `{ env }` travels the same
 * way; it is `assertSecretsPresent`'s job, not this one's, to refuse it while no deployment has a
 * secret store.
 */
export function surfaceSecretsOf(document: ClientDocument): SurfaceSecretRef[] {
  const secrets: SurfaceSecretRef[] = [];
  const secret = (surface: string, field: string, ref: SecretRef): void => {
    secrets.push({ surface, field, ...ref });
  };
  const web = document.surfaces.web;
  if (web) secret('web', 'token', web.token);
  const slack = document.surfaces.slack;
  if (slack) {
    secret('slack', 'signingSecret', slack.signingSecret);
    secret('slack', 'botToken', slack.botToken);
  }
  return secrets;
}

/**
 * Validate a raw document, then apply the rules zod cannot say: the identity section's four
 * cross-principal rules, the playbooks' two, and the primary-surface rule.
 *
 * Every failure is a `ConfigError`, because every one of them is something a person wrote.
 */
export function parseClientDocument(raw: unknown): ClientDocument {
  const parsed = ClientDocumentShape.safeParse(raw);
  if (!parsed.success) throw new ConfigError(`client document is invalid: ${z.prettifyError(parsed.error)}`);
  const document = parsed.data;
  // Delegated to the contracts that own each section, so one implementation of each rule exists.
  parseIdentityFileWithDefaults(document.identity);
  parsePlaybooksFile(document.playbooks);
  const surfaces = surfaceNamesOf(document);
  if (surfaces.length === 0)
    throw new ConfigError(`client "${document.id}" declares no surface; at least one is required`);
  if (surfaces[0] === CANNOT_BE_PRIMARY) {
    throw new ConfigError(
      `client "${document.id}": "${CANNOT_BE_PRIMARY}" cannot be a client's primary surface, because an approval card has nowhere to go; declare a messaging surface beside it`,
    );
  }
  return document;
}

/**
 * A raw document at whatever `schemaVersion` it carries, brought to this build's.
 *
 * Forward only, and there is exactly one version, so today this is a version check and a parse.
 * It exists now rather than when the second version arrives because the alternative is a store
 * full of documents nobody can tell apart.
 */
export function migrate(raw: unknown): ClientDocument {
  const version = (raw as { schemaVersion?: unknown } | null)?.schemaVersion;
  if (typeof version !== 'number') {
    throw new ConfigError('client document has no numeric schemaVersion; every document declares one');
  }
  if (version > CLIENT_DOCUMENT_VERSION) {
    throw new ConfigError(
      `client document schemaVersion ${version} is newer than this build, which knows ${CLIENT_DOCUMENT_VERSION}; upgrade the host`,
    );
  }
  return parseClientDocument(raw);
}
