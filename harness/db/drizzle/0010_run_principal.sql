ALTER TABLE "runs" ADD COLUMN "principal_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "thread_id" uuid;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "surface" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "conversation" text;--> statement-breakpoint
-- harness:data-section:begin
-- Hand written. Every run so far was opened by a process whose CORE_TOOLS_CALLER was written
-- into `caller`; from Plan 7 on that string is the principal id, so the old rows take it as
-- theirs. `caller` stays until nothing reads it.
UPDATE "runs" SET "principal_id" = "caller" WHERE "principal_id" IS NULL;--> statement-breakpoint
-- harness:data-section:end
ALTER TABLE "runs" ALTER COLUMN "principal_id" SET NOT NULL;
