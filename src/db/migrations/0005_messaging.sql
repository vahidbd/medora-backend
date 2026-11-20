CREATE TABLE "clinical"."messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid,
	"patient_id" uuid,
	"direction" text NOT NULL,
	"channel" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"from_address" text,
	"to_address" text,
	"subject" text,
	"body" text NOT NULL,
	"template_key" text,
	"automated" boolean DEFAULT false NOT NULL,
	"author_type" text NOT NULL,
	"author_id" uuid,
	"attachment_count" integer DEFAULT 0 NOT NULL,
	"provider_message_id" text,
	"failure_code" text,
	"idempotency_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sending_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"delivered_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	CONSTRAINT "messages_direction_check" CHECK ("clinical"."messages"."direction" in ('inbound', 'outbound')),
	CONSTRAINT "messages_channel_check" CHECK ("clinical"."messages"."channel" in ('email', 'sms', 'chat', 'voice')),
	CONSTRAINT "messages_kind_check" CHECK ("clinical"."messages"."kind" in ('support', 'transactional')),
	CONSTRAINT "messages_status_check" CHECK ("clinical"."messages"."status" in ('queued', 'sending', 'sent', 'delivered', 'failed', 'received', 'logged')),
	CONSTRAINT "messages_author_type_check" CHECK ("clinical"."messages"."author_type" in ('person', 'patient', 'agent', 'system')),
	CONSTRAINT "messages_author_check" CHECK (("clinical"."messages"."author_type" = 'system') = ("clinical"."messages"."author_id" is null)),
	CONSTRAINT "messages_status_direction_check" CHECK (("clinical"."messages"."direction" = 'inbound' and "clinical"."messages"."status" in ('received', 'logged')) or ("clinical"."messages"."direction" = 'outbound' and "clinical"."messages"."status" in ('queued', 'sending', 'sent', 'delivered', 'failed', 'logged'))),
	CONSTRAINT "messages_address_check" CHECK (("clinical"."messages"."channel" <> 'email' and "clinical"."messages"."channel" <> 'sms') or ("clinical"."messages"."from_address" is not null and "clinical"."messages"."to_address" is not null))
);
--> statement-breakpoint
CREATE INDEX "messages_ticket_idx" ON "clinical"."messages" USING btree ("tenant_id","ticket_id","created_at");
--> statement-breakpoint
CREATE INDEX "messages_patient_idx" ON "clinical"."messages" USING btree ("tenant_id","patient_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_idempotency_key" ON "clinical"."messages" USING btree ("tenant_id","idempotency_key");
--> statement-breakpoint
CREATE UNIQUE INDEX "messages_provider_key" ON "clinical"."messages" USING btree ("tenant_id","channel","provider_message_id");
--> statement-breakpoint
ALTER TABLE "clinical"."messages" ADD CONSTRAINT "messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clinical"."messages" ADD CONSTRAINT "messages_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Messages (docs/decisions/messaging.md). A message's text and addresses
-- are never changed after it is written (ADR 0028); delivery moves only its
-- status, times, provider id and failure code. No DELETE.
GRANT SELECT, INSERT ON clinical.messages TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, provider_message_id, failure_code, sending_at, sent_at, delivered_at, failed_at) ON clinical.messages TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.messages
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
