ALTER TABLE "documents" ADD COLUMN "client" text DEFAULT 'unknown' NOT NULL;--> statement-breakpoint
ALTER TABLE "documents" ALTER COLUMN "client" DROP DEFAULT;--> statement-breakpoint
CREATE INDEX "documents_client_ingested_idx" ON "documents" USING btree ("client","ingested_at");