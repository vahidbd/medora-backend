ALTER TABLE "clinical"."consults" ADD COLUMN "brand_id" uuid NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consults_brand_idx" ON "clinical"."consults" USING btree ("tenant_id","brand_id");
-- The brand a consult was booked through (docs/decisions/consults.md CNS24),
-- so its messages come from that brand. No consult row exists anywhere yet,
-- so the NOT NULL column needs no backfill.
