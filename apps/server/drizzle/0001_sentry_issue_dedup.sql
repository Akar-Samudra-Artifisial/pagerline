ALTER TABLE "alerts" ADD COLUMN "dedup_key" text;--> statement-breakpoint
CREATE UNIQUE INDEX "alerts_source_dedup_uq" ON "alerts" USING btree ("source","dedup_key");