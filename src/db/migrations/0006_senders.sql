ALTER TABLE "clinical"."messages" ADD COLUMN "brand_id" uuid;
--> statement-breakpoint
CREATE TABLE "operational"."senders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"purpose" text NOT NULL,
	"address" text NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "senders_channel_check" CHECK ("operational"."senders"."channel" in ('email', 'sms')),
	CONSTRAINT "senders_purpose_check" CHECK ("operational"."senders"."purpose" in ('service', 'marketing'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "senders_brand_channel_purpose_key" ON "operational"."senders" USING btree ("tenant_id","brand_id","channel","purpose");
--> statement-breakpoint
CREATE UNIQUE INDEX "senders_address_key" ON "operational"."senders" USING btree ("tenant_id","channel","address");
--> statement-breakpoint
CREATE INDEX "senders_updated_by_idx" ON "operational"."senders" USING btree ("updated_by_user_id");
--> statement-breakpoint
CREATE INDEX "messages_brand_idx" ON "clinical"."messages" USING btree ("tenant_id","brand_id");
--> statement-breakpoint
ALTER TABLE "operational"."senders" ADD CONSTRAINT "senders_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."senders" ADD CONSTRAINT "senders_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."senders" ADD CONSTRAINT "senders_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clinical"."messages" ADD CONSTRAINT "messages_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- A brand's addresses (docs/decisions/messaging.md CRM5). The table is the
-- tenant's alone (ADR 0006), and the composite key on (tenant_id, brand_id)
-- means a sender or a message can't point at another tenant's brand. A
-- brand's addresses are settings, so a removed one is deleted.
GRANT SELECT, INSERT, UPDATE, DELETE ON operational.senders TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.senders ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.senders
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
