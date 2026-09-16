import { sql } from 'drizzle-orm';
import {
  pgTable, uuid, text, timestamp, boolean, real, integer, jsonb, date,
  customType, uniqueIndex, index,
} from 'drizzle-orm/pg-core';

export const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType() {
    return 'bytea';
  },
});

export const providers = pgTable('providers', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  name: text('name').notNull(),
  npi: text('npi'),
  status: text('status').notNull().default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  index('providers_client_name_idx').on(t.client, t.name),
  uniqueIndex('providers_client_npi_uq').on(t.client, t.npi),
]);

export const documents = pgTable('documents', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * The document is scoped to this client independently of `providerId`: a
   * document that has not yet been attached to a provider must still be
   * invisible to any other client of this process.
   */
  client: text('client').notNull(),
  providerId: uuid('provider_id').references(() => providers.id),
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
}, (t) => [
  index('documents_client_ingested_idx').on(t.client, t.ingestedAt),
]);

export const fields = pgTable('fields', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
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
}, (t) => [uniqueIndex('fields_provider_name_uq').on(t.providerId, t.name)]);

export const credentials = pgTable('credentials', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  kind: text('kind').notNull(),
  issuer: text('issuer'),
  numberEncrypted: bytea('number_encrypted'),
  state: text('state'),
  issuedAt: date('issued_at', { mode: 'string' }),
  expiresAt: date('expires_at', { mode: 'string' }),
  sourceDocId: uuid('source_doc_id').references(() => documents.id),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [index('credentials_provider_idx').on(t.providerId)]);

export const deadlines = pgTable('deadlines', {
  id: uuid('id').primaryKey().defaultRandom(),
  providerId: uuid('provider_id').notNull().references(() => providers.id),
  credentialId: uuid('credential_id').notNull().references(() => credentials.id),
  kind: text('kind').notNull(),
  dueAt: date('due_at', { mode: 'string' }).notNull(),
  windowDays: integer('window_days').notNull().default(90),
  notifiedAt: timestamp('notified_at', { withTimezone: true }),
}, (t) => [uniqueIndex('deadlines_credential_kind_uq').on(t.credentialId, t.kind)]);

export const approvals = pgTable('approvals', {
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
  slackChannel: text('slack_channel'),
  slackTs: text('slack_ts'),
  /** When the poller claimed the row for posting; null until claimed and after a release. */
  claimedAt: timestamp('claimed_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [
  // Partial: only one live pending request per idempotency key. Decided and
  // expired rows stay as history and must not block a fresh request.
  uniqueIndex('approvals_idempotency_pending_uq').on(t.idempotencyKey).where(sql`status = 'pending'`),
]);

export const runs = pgTable('runs', {
  id: uuid('id').primaryKey().defaultRandom(),
  client: text('client').notNull(),
  caller: text('caller').notNull(),
  channel: text('channel'),
  startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
  endedAt: timestamp('ended_at', { withTimezone: true }),
});

/**
 * Outbox for external side effects (Slack messages, file uploads, emails).
 * A handler stages a row inside its transaction; a dispatcher sends it after
 * commit, keyed by idempotency_key so a crash never double-sends. Rows that
 * cannot be resolved automatically are parked as needs_review.
 */
export const toolEffects = pgTable('tool_effects', {
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
   * What the sink returned on a successful dispatch (a Slack message ts, a
   * remote file id) so an operator can trace the effect to the thing it made.
   * Plaintext jsonb: a sink must return only non-restricted values.
   */
  result: jsonb('result').$type<Record<string, unknown>>(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
}, (t) => [
  uniqueIndex('tool_effects_idempotency_uq').on(t.idempotencyKey),
  index('tool_effects_status_created_idx').on(t.status, t.createdAt),
]);

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

export const auditLog = pgTable('audit_log', {
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
}, (t) => [
  index('audit_log_tool_created_idx').on(t.tool, t.createdAt),
  index('audit_log_client_created_idx').on(t.client, t.createdAt.desc()),
]);
