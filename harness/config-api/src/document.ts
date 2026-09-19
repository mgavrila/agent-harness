import * as z from 'zod/v4';
import { IdentityFileShape, parseIdentityFile } from '@harness/identity-api';
import { ConfigError } from '@harness/shared';
import { PlaybooksFileShape, parsePlaybooksFile } from './playbooks.js';
import { ClientPolicyShape } from './policy.js';
import { RoutingFile } from './routing.js';

/** Bumped when a document's shape changes in a way `migrate` has to answer for. */
export const CLIENT_DOCUMENT_VERSION = 1;

/** A client id: a safe path segment, a safe Postgres `client` value, and a safe URL segment. */
const CLIENT_ID = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** A plug-in name: the same rule `defineSurface`, the identity plug-in definer and `definePack` apply. */
const PLUGIN_NAME = /^[a-z][a-z0-9-]*$/;

/** A skill's directory name, which `readSkillCatalogue` requires the frontmatter `name` to match. */
const SKILL_NAME = /^[a-z][a-z0-9-]*$/;

/** An environment variable name, which is what a `SecretRef` names. */
const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;

export const SecretRefShape = z
  .object({ env: z.string().regex(ENV_NAME, 'a secret reference names an environment variable (A-Z, digits, _)') })
  .strict();

/**
 * The surfaces a client may declare, in the order the host loads them.
 *
 * **The order is the schema's, not the file's.** The first loaded surface is the primary — where
 * approval cards go — and a file's key order is not something a YAML writer or a JSON column
 * should be able to change by accident. `http` is last because it cannot post a card, which is
 * the rule `.env.example` used to state in prose about `HARNESS_SURFACES`.
 */
export const SURFACE_ORDER = ['slack', 'memory', 'http'] as const;

/** The one surface that may never be a client's primary. */
const CANNOT_BE_PRIMARY = 'http';

const SurfacesShape = z
  .object({
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
         * for Slack: it is what an inbound event's tenant hint is matched against. It exists
         * because a pooled host cannot serve two live Slack tenants in this plan (decision 6),
         * and pooled routing still has to be provable end to end — the memory surface is the one
         * spec §9 asks the isolation work to be proved with.
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
    id: z.string().regex(CLIENT_ID, 'a client id is lowercase letters, digits and hyphens, 2 to 64 characters'),
    displayName: z.string().trim().min(1).max(120),
    /** Today's SOUL.md body, verbatim. */
    persona: z.string().min(1),
    /** Today's identity.yaml: the declared principals, and the level everyone else gets. */
    identity: IdentityFileShape,
    /** Today's policy.yaml, plus the tools this client withholds. */
    policy: ClientPolicyShape,
    /** Today's routing.yaml. */
    routing: RoutingFile,
    /** Today's playbooks.yaml. */
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
    /** Package names, as `HARNESS_PACKS` held them. An empty list is a client with no pack. */
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
  if (document.surfaces.slack) keys.push({ surface: 'slack', key: document.surfaces.slack.teamId });
  if (document.surfaces.memory?.workspace) {
    keys.push({ surface: 'memory', key: document.surfaces.memory.workspace });
  }
  return keys;
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
  parseIdentityFile(document.identity);
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
