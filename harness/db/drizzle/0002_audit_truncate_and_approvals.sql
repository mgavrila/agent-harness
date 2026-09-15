-- TRUNCATE bypasses row-level triggers, so the append-only guarantee needs a
-- statement-level BEFORE TRUNCATE trigger of its own.
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log FOR EACH STATEMENT EXECUTE FUNCTION audit_log_readonly();
--> statement-breakpoint
-- A decided or expired approval must not block a fresh request for the same
-- action, so uniqueness applies only to live pending rows.
DROP INDEX IF EXISTS approvals_idempotency_uq;
--> statement-breakpoint
CREATE UNIQUE INDEX "approvals_idempotency_pending_uq" ON "approvals" USING btree ("idempotency_key") WHERE status = 'pending';
--> statement-breakpoint
-- Full approval payload, encrypted; the jsonb payload holds a redacted copy.
ALTER TABLE "approvals" ADD COLUMN "payload_encrypted" "bytea";
--> statement-breakpoint
CREATE INDEX "audit_log_client_created_idx" ON "audit_log" USING btree ("client","created_at" DESC NULLS LAST);
