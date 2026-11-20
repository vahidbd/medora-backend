CREATE TABLE "platform"."webhook_inbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform"."webhook_inbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_event_id" text NOT NULL,
	"kind" text NOT NULL,
	"body" jsonb NOT NULL,
	"request_id" text,
	"status" text DEFAULT 'received' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"last_error" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	CONSTRAINT "webhook_inbox_provider_check" CHECK ("platform"."webhook_inbox"."provider" in ('twilio', 'video', 'parchment', 'stripe', 'eway', 'email')),
	CONSTRAINT "webhook_inbox_status_check" CHECK ("platform"."webhook_inbox"."status" in ('received', 'processed', 'failed')),
	CONSTRAINT "webhook_inbox_processed_check" CHECK (("platform"."webhook_inbox"."status" = 'processed') = ("platform"."webhook_inbox"."processed_at" is not null))
);
--> statement-breakpoint
ALTER TABLE "platform"."webhook_inbox" ADD CONSTRAINT "webhook_inbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_inbox_delivery_key" ON "platform"."webhook_inbox" USING btree ("tenant_id","provider","provider_event_id");--> statement-breakpoint
CREATE INDEX "webhook_inbox_pending_idx" ON "platform"."webhook_inbox" USING btree ("tenant_id","status","id");--> statement-breakpoint

-- The webhook inbox (ADR 0029, docs/decisions/webhooks.md): tenant-isolated
-- like every tenant table (ADR 0006). The API stores and processes; it never
-- deletes a delivery.
GRANT SELECT, INSERT ON platform.webhook_inbox TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, attempts, last_error, processed_at) ON platform.webhook_inbox TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.webhook_inbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.webhook_inbox
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
