import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  real,
  integer,
  bigint,
  jsonb,
  date,
  customType,
  uniqueIndex,
  index,
  pgView,
  vector,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

/**
 * One thing a pack stores: a provider, an epic, whatever a pack declares. `pack` and `kind`
 * together say which `RecordKindSpec` this row was written against; the kernel validates a
 * `kind` against the loaded packs before it writes, and never hard-codes one.
 */
export const records = pgTable(
  'records',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    /** The pack that owns this kind, e.g. `healthcare`. */
    pack: text('pack').notNull(),
    kind: text('kind').notNull(),
    /** Display name, joined from the kind's `nameFields`. Plaintext, and never restricted. */
    name: text('name').notNull(),
    /** The kind's stable outside identifier — an NPI, a ticket key. Plaintext, and never restricted. */
    externalId: text('external_id'),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('records_client_kind_name_idx').on(t.client, t.kind, t.name),
    // Scoped by the kind name as well as the client, so two kinds may both key on a ten-digit
    // number and mean different things. The pack registry refuses two loaded packs that declare
    // the same kind name, which is what keeps (client, kind, external_id) unambiguous without
    // `pack` in the key. With one kind loaded this is exactly the old providers_client_npi_uq.
    uniqueIndex('records_client_kind_external_id_uq').on(t.client, t.kind, t.externalId),
  ],
);

export const documents = pgTable(
  'documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The document is scoped to this client independently of `recordId`: a
     * document that has not yet been attached to a record must still be
     * invisible to any other client of this process.
     */
    client: text('client').notNull(),
    recordId: uuid('record_id').references(() => records.id),
    kind: text('kind'),
    storagePath: text('storage_path').notNull(),
    sha256: text('sha256').notNull(),
    pages: integer('pages'),
    ocrUsed: boolean('ocr_used').notNull().default(false),
    /**
     * Path of the redacted plain text extracted from this document, relative to
     * HARNESS_STORAGE_DIR. Null until `documents_extract` has run. The file holds
     * redacted text only: restricted identifiers are already replaced by tokens.
     */
    textPath: text('text_path'),
    ingestedAt: timestamp('ingested_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('documents_client_ingested_idx').on(t.client, t.ingestedAt)],
);

/**
 * Something attached to a record that may expire: a licence, a registration, a link. `kind` is
 * pack-defined and its lead time comes from the pack's `AttachmentKindSpec`, not from a table
 * in core. `properties` carries whatever else the kind declares, as plaintext jsonb — a
 * restricted value belongs in `number_encrypted` and nowhere else.
 */
export const attachments = pgTable(
  'attachments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The tenant. Derivable through `record_id` and always equal to that record's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    kind: text('kind').notNull(),
    issuer: text('issuer'),
    numberEncrypted: bytea('number_encrypted'),
    state: text('state'),
    issuedAt: date('issued_at', { mode: 'string' }),
    expiresAt: date('expires_at', { mode: 'string' }),
    properties: jsonb('properties').$type<Record<string, string>>().notNull().default({}),
    sourceDocId: uuid('source_doc_id').references(() => documents.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('attachments_record_idx').on(t.recordId)],
);

export const fields = pgTable(
  'fields',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The tenant. Derivable through `record_id` and always equal to that record's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    name: text('name').notNull(),
    value: text('value'),
    valueEncrypted: bytea('value_encrypted'),
    restricted: boolean('restricted').notNull().default(false),
    confidence: real('confidence'),
    sourceDocId: uuid('source_doc_id').references(() => documents.id),
    sourcePage: integer('source_page'),
    status: text('status').notNull().default('pending'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('fields_record_name_uq').on(t.recordId, t.name)],
);

export const deadlines = pgTable(
  'deadlines',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The tenant. Derivable through `record_id` and always equal to that record's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
    recordId: uuid('record_id')
      .notNull()
      .references(() => records.id),
    attachmentId: uuid('attachment_id')
      .notNull()
      .references(() => attachments.id),
    kind: text('kind').notNull(),
    dueAt: date('due_at', { mode: 'string' }).notNull(),
    windowDays: integer('window_days').notNull().default(90),
    notifiedAt: timestamp('notified_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('deadlines_attachment_kind_uq').on(t.attachmentId, t.kind)],
);

export const approvals = pgTable(
  'approvals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    action: text('action').notNull(),
    payload: jsonb('payload').notNull(),
    payloadEncrypted: bytea('payload_encrypted'),
    summary: text('summary').notNull(),
    requestedBy: text('requested_by').notNull(),
    status: text('status').notNull().default('pending'),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    executedAt: timestamp('executed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    /**
     * The loaded surface this approval's card was posted on: `slack`, `memory`, whatever
     * `HARNESS_SURFACES` names. Null until the poller claims the row, and the only thing that
     * says which adapter a decision arriving from somewhere is allowed to come from.
     */
    surface: text('surface'),
    /**
     * The conversation the card lives in, in that surface's own id shape.
     *
     * Doubles as the poller's claim marker: a poller claims a row by writing this before it
     * posts, guarded on the column still being null, so two pollers can never both post a card
     * for one approval.
     */
    conversationId: text('conversation_id'),
    /** That surface's id for the card message, so a decision can edit it and reply under it. */
    messageRef: text('message_ref'),
    /** The thread the parked call was made from, so a decision can resume it. Null outside a thread. */
    threadId: uuid('thread_id').references(() => threads.id),
    /** When the poller claimed the row for posting; null until claimed and after a release. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: only one live pending request per idempotency key, **per client**. Decided and
    // expired rows stay as history and must not block a fresh request; and two tenants that mint
    // the same key are two requests, not one (spec section 6).
    uniqueIndex('approvals_client_idempotency_pending_uq')
      .on(t.client, t.idempotencyKey)
      .where(sql`status = 'pending'`),
  ],
);

/**
 * One conversation: a person on a surface in one conversation, or a playbook's own thread. The
 * kernel's record of every exchange, independent of whatever a runtime checkpoints for itself
 * (spec decision 9). Keyed per principal, so two people in one channel have two threads and each
 * turn runs as the person who wrote it.
 */
export const threads = pgTable(
  'threads',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    surface: text('surface').notNull(),
    conversation: text('conversation').notNull(),
    principalId: text('principal_id').notNull(),
    /** `chat` for a conversation, `playbook` for a scheduled run. */
    kind: text('kind').notNull().default('chat'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('threads_client_surface_conversation_principal_uq').on(
      t.client,
      t.surface,
      t.conversation,
      t.principalId,
    ),
  ],
);

/**
 * One run: a conversation turn, a scheduled job, or a stdio server's lifetime. Every audit row,
 * effect and model call points at one, and `principal_id` is who it acted as.
 */
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  /** Who this run acts as: a `Principal.id` from the client's identity plug-in. */
  principalId: text('principal_id').notNull(),
  /** The conversation thread this run belongs to. Null for the stdio server and the eval runner. */
  threadId: uuid('thread_id').references(() => threads.id),
  /** The surface the run was started from and the conversation on it. Null for the stdio server. */
  surface: text('surface'),
  conversation: text('conversation'),
  channel: text('channel'),
  /** `running` until the host closes it as `done`, `error` or `cancelled` (spec invariant 12). */
  status: text('status').notNull().default('running'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
  /**
   * What this run spent, summed from its own `model_calls` rows when the host closes it.
   *
   * `model_calls` keeps the per-route detail; these three are the run's totals, so the usage
   * export reads one row per run rather than re-aggregating every call. Zero until the run is
   * closed, and zero for ever on a run that made no model call.
   */
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
});

export const tsvector = customType<{ data: string; driverData: string }>({
  dataType() {
    return 'tsvector';
  },
});

/**
 * One turn of a thread: what the human said, what the assistant answered, or what the host
 * injected (an approval outcome). `tsv` is generated by Postgres from `content`, so episodic search
 * (`session_search`) never depends on an application-side index. Plaintext, so the host runs the
 * restricted-pattern guard before every insert (spec invariant 10).
 */
export const messages = pgTable(
  'messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * Insertion order. `created_at` is `now()` at statement time, so two rows written by one
     * transaction — a resume notice and the answer to it — carry one timestamp; this is the
     * tiebreak every reader orders by. Never written by the application.
     */
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity(),
    /**
     * The tenant. Derivable through `thread_id` and always equal to that thread's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
    threadId: uuid('thread_id')
      .notNull()
      .references(() => threads.id),
    runId: uuid('run_id').references(() => runs.id),
    role: text('role').notNull(),
    principalId: text('principal_id').notNull(),
    content: text('content').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', "content")`),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('messages_tsv_idx').using('gin', t.tsv),
    index('messages_thread_created_idx').on(t.threadId, t.createdAt),
  ],
);

/**
 * Outbox for external side effects (surface messages, file uploads, emails).
 * A handler stages a row inside its transaction; a dispatcher sends it after
 * commit, keyed by idempotency_key so a crash never double-sends. Rows that
 * cannot be resolved automatically are parked as needs_review.
 */
export const toolEffects = pgTable(
  'tool_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').references(() => runs.id),
    client: text('client').notNull(),
    tool: text('tool').notNull(),
    sink: text('sink').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    payloadEncrypted: bytea('payload_encrypted').notNull(),
    summary: text('summary').notNull(),
    status: text('status').notNull().default('staged'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    /**
     * What the sink returned on a successful dispatch (a surface's message id, a
     * remote file id) so an operator can trace the effect to the thing it made.
     * Plaintext jsonb: a sink must return only non-restricted values.
     */
    result: jsonb('result').$type<Record<string, unknown>>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('tool_effects_client_idempotency_uq').on(t.client, t.idempotencyKey),
    index('tool_effects_status_created_idx').on(t.status, t.createdAt),
  ],
);

export const modelCalls = pgTable('model_calls', {
  id: uuid('id').primaryKey().defaultRandom(),
  runId: uuid('run_id').references(() => runs.id),
  client: text('client').notNull(),
  route: text('route').notNull(),
  model: text('model').notNull(),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  costUsd: real('cost_usd').notNull().default(0),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    runId: uuid('run_id').references(() => runs.id),
    client: text('client').notNull(),
    caller: text('caller').notNull(),
    tool: text('tool').notNull(),
    actionClass: text('action_class').notNull(),
    argsHash: text('args_hash').notNull(),
    recordIds: jsonb('record_ids').$type<string[]>().notNull().default([]),
    decision: text('decision').notNull(),
    approvalId: uuid('approval_id').references(() => approvals.id),
    error: text('error'),
    skill: text('skill'),
    skillVersion: text('skill_version'),
    derivedFrom: jsonb('derived_from').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tool_created_idx').on(t.tool, t.createdAt),
    index('audit_log_client_created_idx').on(t.client, t.createdAt.desc()),
  ],
);

/**
 * Curated memory (spec 5.5). One row per remembered fact, in one of two scopes: `principal`
 * (that principal's own notes, `principal_id` set) or `client` (shared by everyone in the
 * deployment, `principal_id` null). Written only through `memory_add` after the injection scan
 * and the restricted-pattern check; capped per scope in core-tools, not here. `thread_id` tags
 * the conversation an entry was written from, when there was one.
 */
export const memoryEntries = pgTable(
  'memory_entries',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    scope: text('scope').notNull(),
    principalId: text('principal_id'),
    text: text('text').notNull(),
    createdBy: text('created_by').notNull(),
    threadId: uuid('thread_id').references(() => threads.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('memory_entries_client_scope_principal_idx').on(t.client, t.scope, t.principalId)],
);

/**
 * Scheduled work (spec 5.6): one row per entry of `clients/<name>/playbooks.yaml`, upserted by
 * the host at startup and keyed by name. A playbook removed from the file is disabled, never
 * deleted, so its run history stays attached. `next_run_at` is what the scheduler claims on and
 * is recomputed from the file and the clock at every host start, so a firing missed while the
 * host was down is not replayed.
 */
export const playbooks = pgTable(
  'playbooks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    name: text('name').notNull(),
    /** A cron expression, five or six fields. */
    schedule: text('schedule').notNull(),
    timezone: text('timezone').notNull().default('UTC'),
    skill: text('skill').notNull(),
    prompt: text('prompt').notNull(),
    /** The service principal the run acts as. */
    principalId: text('principal_id').notNull(),
    /** Where a notice or a delivered reply goes; null means the primary surface's default conversation. */
    surface: text('surface'),
    conversation: text('conversation'),
    /** `none`: the reply is recorded and posted nowhere. `conversation`: posted once to `surface`/`conversation`. */
    deliver: text('deliver').notNull().default('none'),
    costCapUsd: real('cost_cap_usd').notNull(),
    timeoutS: integer('timeout_s').notNull().default(600),
    enabled: boolean('enabled').notNull().default(true),
    nextRunAt: timestamp('next_run_at', { withTimezone: true }),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    lastStatus: text('last_status'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('playbooks_client_name_uq').on(t.client, t.name),
    index('playbooks_due_idx').on(t.client, t.enabled, t.nextRunAt),
  ],
);

/**
 * One firing of a playbook: `requested` (asked for by `playbooks_run_now`, waiting for the next
 * tick), `running`, then `done`, `failed` or `preflight_failed`. `run_id` is the last `runs` row
 * the firing opened (a retry opens a second one); `attempts` counts them; `error` is a fixed,
 * safe sentence, never model or payload text.
 */
export const playbookRuns = pgTable(
  'playbook_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    /**
     * The tenant. Derivable through `playbook_id` and always equal to that playbook's, and stored
     * here anyway: a repository that has to join to find out which client a row belongs to is a
     * repository one `where` away from returning another client's row (spec invariant 13).
     */
    client: text('client').notNull(),
    playbookId: uuid('playbook_id')
      .notNull()
      .references(() => playbooks.id),
    runId: uuid('run_id').references(() => runs.id),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('requested'),
    attempts: integer('attempts').notNull().default(0),
    /** The principal who asked for an off-schedule run; null when the scheduler fired it. */
    requestedBy: text('requested_by'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    error: text('error'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('playbook_runs_playbook_scheduled_idx').on(t.playbookId, t.scheduledAt),
    index('playbook_runs_status_idx').on(t.status),
  ],
);

/**
 * Where a knowledge document came from (spec 5.7). One row per place the sync walks, keyed by
 * name within the client; today the only kind is `folder`, the client's own `knowledge/`
 * directory, and `location` is the path the sync was given, for a human reading the table.
 * A second kind — a wiki, a share — adds a row here and a walker, and nothing below changes.
 */
export const knowledgeSources = pgTable(
  'knowledge_sources',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    location: text('location').notNull(),
    lastSyncedAt: timestamp('last_synced_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('knowledge_sources_client_name_uq').on(t.client, t.name)],
);

/**
 * One markdown document of a source (spec 5.7), keyed by its path within that source. `sha256`
 * is of the file's whole text, frontmatter included, so a document is re-chunked and re-embedded
 * only when it actually changed. `min_level` is the level name the frontmatter carried and
 * `min_rank` is its position in the four user levels — the name is what a human reads, the rank
 * is what the access filter compares, because Postgres cannot order level names. `principals`
 * names individual principals who may read it whatever their level. A file that disappears from
 * the folder is tombstoned with `deleted_at`, never deleted: the row stays for an operator to
 * see while nothing can retrieve it.
 */
export const knowledgeDocuments = pgTable(
  'knowledge_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    client: text('client').notNull(),
    sourceId: uuid('source_id')
      .notNull()
      .references(() => knowledgeSources.id),
    /** Relative to the source's root, with forward slashes, e.g. `policies/front-desk.md`. */
    path: text('path').notNull(),
    title: text('title').notNull(),
    sha256: text('sha256').notNull(),
    minLevel: text('min_level').notNull(),
    minRank: integer('min_rank').notNull(),
    principals: text('principals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('knowledge_documents_source_path_uq').on(t.sourceId, t.path),
    index('knowledge_documents_client_idx').on(t.client, t.deletedAt),
  ],
);

/**
 * One retrievable piece of a document (spec 5.7). `tsv` is generated by Postgres from `text`, so
 * the lexical ranking needs no writer, and `embedding` is the vector the `embed` route produced.
 * The width is fixed at 1,024 here because a migration is static SQL: `HARNESS_EMBED_DIMS` is
 * checked against this column at startup (`assertEmbedDims`) rather than deciding it, and
 * changing it is a new deployment.
 *
 * `min_level`, `min_rank` and `principals` are copied down from the document on purpose: the
 * access filter has to be in the same WHERE clause as the ranking, and a join to the document
 * for every candidate row would put it one step too late (invariant 7).
 *
 * The three indexes are the three ways this table is read: HNSW with cosine distance for the
 * vector top-k, GIN on the tsvector for the lexical top-k, and GIN on the principals array for
 * the `@>` half of the access filter.
 */
export const knowledgeChunks = pgTable(
  'knowledge_chunks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    documentId: uuid('document_id')
      .notNull()
      .references(() => knowledgeDocuments.id, { onDelete: 'cascade' }),
    client: text('client').notNull(),
    /** Position in the document, from 0, so a citation can say where in the page it came from. */
    ordinal: integer('ordinal').notNull(),
    text: text('text').notNull(),
    tsv: tsvector('tsv').generatedAlwaysAs(sql`to_tsvector('english', "text")`),
    embedding: vector('embedding', { dimensions: 1024 }),
    minLevel: text('min_level').notNull(),
    minRank: integer('min_rank').notNull(),
    principals: text('principals')
      .array()
      .notNull()
      .default(sql`'{}'::text[]`),
  },
  (t) => [
    index('knowledge_chunks_document_ordinal_idx').on(t.documentId, t.ordinal),
    index('knowledge_chunks_embedding_idx').using('hnsw', t.embedding.op('vector_cosine_ops')),
    index('knowledge_chunks_tsv_idx').using('gin', t.tsv),
    index('knowledge_chunks_principals_idx').using('gin', t.principals),
  ],
);

/**
 * A client's resolved document, one row per client: what the host loads.
 *
 * `document` is a whole `ClientDocument` as jsonb, already resolved from its blueprint and
 * overlay by whoever wrote it and validated again on load — a store the platform writes to is
 * not a store the kernel trusts. `version` is what a host caches by and what `watch` reports;
 * `blueprint_ref` records which catalogue entry it came from, for an operator reading the table.
 */
export const clientDocuments = pgTable('client_documents', {
  clientId: text('client_id').primaryKey(),
  schemaVersion: integer('schema_version').notNull(),
  document: jsonb('document').$type<Record<string, unknown>>().notNull(),
  version: text('version').notNull(),
  blueprintRef: text('blueprint_ref'),
  overlay: jsonb('overlay').$type<Record<string, unknown>>(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** Every version a client's document has had, so a change is reviewable and a rollback is a write. */
export const clientDocumentVersions = pgTable(
  'client_document_versions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clientId: text('client_id').notNull(),
    version: text('version').notNull(),
    document: jsonb('document').$type<Record<string, unknown>>().notNull(),
    createdBy: text('created_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('client_document_versions_client_version_uq').on(t.clientId, t.version)],
);

/**
 * What a tenant used, per principal per day (spec section 4.5, invariant 16).
 *
 * Counts, tokens, cost and seconds, and **not one word anybody wrote**: no message, no tool
 * argument, no document text, no conversation id. A full join, because a day can have approvals
 * with no run of its own (an approval decided the morning after it was raised) and runs with no
 * approval, and an export that dropped either would be an invoice that disagreed with the audit
 * log. `sandbox_seconds` is a literal zero until a sandbox provider exists (spec decision 14).
 */
export const usageRuns = pgView('usage_runs', {
  client: text('client').notNull(),
  principalId: text('principal_id').notNull(),
  day: timestamp('day', { withTimezone: true }).notNull(),
  runs: integer('runs').notNull(),
  inputTokens: integer('input_tokens').notNull(),
  outputTokens: integer('output_tokens').notNull(),
  costUsd: real('cost_usd').notNull(),
  durationSeconds: integer('duration_seconds').notNull(),
  runsDone: integer('runs_done').notNull(),
  runsError: integer('runs_error').notNull(),
  runsCancelled: integer('runs_cancelled').notNull(),
  runsRunning: integer('runs_running').notNull(),
  approvalsRequested: integer('approvals_requested').notNull(),
  approvalsDecided: integer('approvals_decided').notNull(),
  sandboxSeconds: integer('sandbox_seconds').notNull(),
}).as(
  sql`with "run_totals" as (
      select "client", "principal_id", date_trunc('day', "started_at") as "day",
        count(*)::int as "runs",
        coalesce(sum("input_tokens"), 0)::int as "input_tokens",
        coalesce(sum("output_tokens"), 0)::int as "output_tokens",
        coalesce(sum("cost_usd"), 0)::real as "cost_usd",
        coalesce(sum(extract(epoch from (coalesce("ended_at", "started_at") - "started_at"))), 0)::int as "duration_seconds",
        count(*) filter (where "status" = 'done')::int as "runs_done",
        count(*) filter (where "status" = 'error')::int as "runs_error",
        count(*) filter (where "status" = 'cancelled')::int as "runs_cancelled",
        count(*) filter (where "status" = 'running')::int as "runs_running"
      from "runs" group by 1, 2, 3
    ), "approval_totals" as (
      select "client", "requested_by" as "principal_id", date_trunc('day', "created_at") as "day",
        count(*)::int as "approvals_requested",
        count(*) filter (where "decided_at" is not null)::int as "approvals_decided"
      from "approvals" group by 1, 2, 3
    )
    select
      coalesce(r."client", a."client") as "client",
      coalesce(r."principal_id", a."principal_id") as "principal_id",
      coalesce(r."day", a."day") as "day",
      coalesce(r."runs", 0) as "runs",
      coalesce(r."input_tokens", 0) as "input_tokens",
      coalesce(r."output_tokens", 0) as "output_tokens",
      coalesce(r."cost_usd", 0) as "cost_usd",
      coalesce(r."duration_seconds", 0) as "duration_seconds",
      coalesce(r."runs_done", 0) as "runs_done",
      coalesce(r."runs_error", 0) as "runs_error",
      coalesce(r."runs_cancelled", 0) as "runs_cancelled",
      coalesce(r."runs_running", 0) as "runs_running",
      coalesce(a."approvals_requested", 0) as "approvals_requested",
      coalesce(a."approvals_decided", 0) as "approvals_decided",
      0 as "sandbox_seconds"
    from "run_totals" r
    full join "approval_totals" a
      on a."client" = r."client" and a."principal_id" = r."principal_id" and a."day" = r."day"`,
);
