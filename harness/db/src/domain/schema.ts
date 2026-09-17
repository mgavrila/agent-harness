import { sql } from 'drizzle-orm';
import {
  pgTable,
  uuid,
  text,
  timestamp,
  boolean,
  real,
  integer,
  jsonb,
  date,
  customType,
  uniqueIndex,
  index,
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
    /** When the poller claimed the row for posting; null until claimed and after a release. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Partial: only one live pending request per idempotency key. Decided and
    // expired rows stay as history and must not block a fresh request.
    uniqueIndex('approvals_idempotency_pending_uq')
      .on(t.idempotencyKey)
      .where(sql`status = 'pending'`),
  ],
);

/**
 * One run: a conversation turn, a scheduled job, or a stdio server's lifetime. Every audit row,
 * effect and model call points at one, and `principal_id` is who it acted as.
 */
export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  /** The principal id, again. Kept beside `principal_id` until nothing reads it; Plan 8 drops it. */
  caller: text('caller').notNull(),
  /** Who this run acts as: a `Principal.id` from the client's identity plug-in. */
  principalId: text('principal_id').notNull(),
  /** The conversation thread this run belongs to. A `threads` row once Plan 8 adds the table; no foreign key until then. */
  threadId: uuid('thread_id'),
  /** The surface the run was started from and the conversation on it. Null for the stdio server. */
  surface: text('surface'),
  conversation: text('conversation'),
  channel: text('channel'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

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
    uniqueIndex('tool_effects_idempotency_uq').on(t.idempotencyKey),
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
    inputTokens: integer('input_tokens'),
    outputTokens: integer('output_tokens'),
    costUsd: real('cost_usd'),
    derivedFrom: jsonb('derived_from').$type<string[]>().notNull().default([]),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('audit_log_tool_created_idx').on(t.tool, t.createdAt),
    index('audit_log_client_created_idx').on(t.client, t.createdAt.desc()),
  ],
);
