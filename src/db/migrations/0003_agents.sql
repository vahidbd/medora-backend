-- AI agents (ADRs 0012, 0240; docs/decisions/agents.md AGT3, AGT8): settings
-- and run metadata in platform, transcripts and approval cards in clinical.
-- Grants, row-level security and the one cross-tenant function, the claim,
-- follow the tables.
CREATE TABLE "platform"."agent_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"trigger" text NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"started_by" uuid,
	"agent_version" text,
	"model" text,
	"model_version" text,
	"steps" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"cache_read_tokens" integer DEFAULT 0 NOT NULL,
	"cache_write_tokens" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"end_reason" text,
	"queued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"lease_expires_at" timestamp with time zone,
	CONSTRAINT "agent_runs_agent_check" CHECK ("platform"."agent_runs"."agent" in ('intake', 'support', 'care_coordinator', 'clinical_copilot')),
	CONSTRAINT "agent_runs_trigger_check" CHECK ("platform"."agent_runs"."trigger" in ('message', 'staff', 'event', 'schedule', 'call')),
	CONSTRAINT "agent_runs_status_check" CHECK ("platform"."agent_runs"."status" in ('queued', 'running', 'completed', 'handed_off', 'stopped', 'failed')),
	CONSTRAINT "agent_runs_counts_check" CHECK (least("platform"."agent_runs"."steps", "platform"."agent_runs"."input_tokens", "platform"."agent_runs"."output_tokens", "platform"."agent_runs"."cache_read_tokens", "platform"."agent_runs"."cache_write_tokens", "platform"."agent_runs"."cost_cents") >= 0),
	CONSTRAINT "agent_runs_end_reason_check" CHECK ("platform"."agent_runs"."end_reason" is null or "platform"."agent_runs"."end_reason" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
CREATE TABLE "platform"."agent_settings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"enabled" boolean DEFAULT false NOT NULL,
	"display_name" text,
	"auto_tools" text[] DEFAULT '{}'::text[] NOT NULL,
	"monthly_spend_cap_cents" integer DEFAULT 15000 NOT NULL,
	"daily_reply_cap" integer DEFAULT 1000 NOT NULL,
	"refund_cap_cents" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid,
	CONSTRAINT "agent_settings_agent_check" CHECK ("platform"."agent_settings"."agent" in ('intake', 'support', 'care_coordinator', 'clinical_copilot')),
	CONSTRAINT "agent_settings_spend_cap_check" CHECK ("platform"."agent_settings"."monthly_spend_cap_cents" between 0 and 500000),
	CONSTRAINT "agent_settings_reply_cap_check" CHECK ("platform"."agent_settings"."daily_reply_cap" between 0 and 10000),
	CONSTRAINT "agent_settings_refund_cap_check" CHECK ("platform"."agent_settings"."refund_cap_cents" between 0 and 50000),
	CONSTRAINT "agent_settings_display_name_check" CHECK ("platform"."agent_settings"."display_name" is null or length("platform"."agent_settings"."display_name") between 1 and 40)
);
--> statement-breakpoint
CREATE TABLE "platform"."agent_tenant_settings" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"paused" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "clinical"."agent_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"channel" text NOT NULL,
	"patient_id" uuid,
	"verified" boolean DEFAULT false NOT NULL,
	"subject_table" text,
	"subject_id" text,
	"started_by" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"handoff_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_conversations_agent_check" CHECK ("clinical"."agent_conversations"."agent" in ('intake', 'support', 'care_coordinator', 'clinical_copilot')),
	CONSTRAINT "agent_conversations_channel_check" CHECK ("clinical"."agent_conversations"."channel" in ('chat', 'email', 'sms', 'voice', 'job')),
	CONSTRAINT "agent_conversations_status_check" CHECK ("clinical"."agent_conversations"."status" in ('open', 'handed_off', 'closed')),
	CONSTRAINT "agent_conversations_handoff_check" CHECK (("clinical"."agent_conversations"."status" = 'handed_off') = ("clinical"."agent_conversations"."handoff_reason" is not null)),
	CONSTRAINT "agent_conversations_verified_check" CHECK (not "clinical"."agent_conversations"."verified" or "clinical"."agent_conversations"."patient_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "clinical"."agent_messages" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clinical"."agent_messages_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"run_id" uuid,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"untrusted" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_messages_role_check" CHECK ("clinical"."agent_messages"."role" in ('patient', 'staff', 'agent', 'tool', 'notice'))
);
--> statement-breakpoint
CREATE TABLE "clinical"."agent_proposals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"agent" text NOT NULL,
	"agent_id" uuid NOT NULL,
	"run_id" uuid NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tool" text NOT NULL,
	"permission" text NOT NULL,
	"input" jsonb NOT NULL,
	"final_input" jsonb,
	"rationale" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"decided_by" uuid,
	"decided_at" timestamp with time zone,
	"decision_reason" text,
	"result_status" integer,
	"idempotency_key" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"executed_at" timestamp with time zone,
	CONSTRAINT "agent_proposals_agent_check" CHECK ("clinical"."agent_proposals"."agent" in ('intake', 'support', 'care_coordinator', 'clinical_copilot')),
	CONSTRAINT "agent_proposals_status_check" CHECK ("clinical"."agent_proposals"."status" in ('pending', 'approved', 'rejected', 'executed', 'failed', 'expired')),
	CONSTRAINT "agent_proposals_decided_check" CHECK (("clinical"."agent_proposals"."status" = 'pending' or "clinical"."agent_proposals"."status" = 'expired') = ("clinical"."agent_proposals"."decided_by" is null)),
	CONSTRAINT "agent_proposals_reason_check" CHECK ("clinical"."agent_proposals"."decision_reason" is null or "clinical"."agent_proposals"."decision_reason" ~ '^[a-z_]{1,40}$')
);
--> statement-breakpoint
ALTER TABLE "platform"."agent_runs" ADD CONSTRAINT "agent_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_runs" ADD CONSTRAINT "agent_runs_agent_id_agent_settings_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agent_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_settings" ADD CONSTRAINT "agent_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."agent_tenant_settings" ADD CONSTRAINT "agent_tenant_settings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_conversations" ADD CONSTRAINT "agent_conversations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_conversations" ADD CONSTRAINT "agent_conversations_agent_id_agent_settings_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agent_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_messages" ADD CONSTRAINT "agent_messages_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_messages" ADD CONSTRAINT "agent_messages_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "clinical"."agent_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_messages" ADD CONSTRAINT "agent_messages_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "platform"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_proposals" ADD CONSTRAINT "agent_proposals_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_proposals" ADD CONSTRAINT "agent_proposals_agent_id_agent_settings_id_fk" FOREIGN KEY ("agent_id") REFERENCES "platform"."agent_settings"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_proposals" ADD CONSTRAINT "agent_proposals_run_id_agent_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "platform"."agent_runs"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."agent_proposals" ADD CONSTRAINT "agent_proposals_conversation_id_agent_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "clinical"."agent_conversations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_runs_tenant_agent_queued_idx" ON "platform"."agent_runs" USING btree ("tenant_id","agent","queued_at");--> statement-breakpoint
CREATE INDEX "agent_runs_status_queued_idx" ON "platform"."agent_runs" USING btree ("status","queued_at");--> statement-breakpoint
CREATE INDEX "agent_runs_conversation_idx" ON "platform"."agent_runs" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "agent_runs_agent_id_idx" ON "platform"."agent_runs" USING btree ("agent_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_runs_one_running_key" ON "platform"."agent_runs" USING btree ("conversation_id") WHERE "platform"."agent_runs"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "agent_settings_tenant_agent_key" ON "platform"."agent_settings" USING btree ("tenant_id","agent");--> statement-breakpoint
CREATE INDEX "agent_conversations_tenant_agent_idx" ON "clinical"."agent_conversations" USING btree ("tenant_id","agent","created_at");--> statement-breakpoint
CREATE INDEX "agent_conversations_subject_idx" ON "clinical"."agent_conversations" USING btree ("tenant_id","subject_table","subject_id");--> statement-breakpoint
CREATE INDEX "agent_conversations_agent_id_idx" ON "clinical"."agent_conversations" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_messages_conversation_idx" ON "clinical"."agent_messages" USING btree ("conversation_id","id");--> statement-breakpoint
CREATE INDEX "agent_messages_tenant_created_idx" ON "clinical"."agent_messages" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_messages_run_idx" ON "clinical"."agent_messages" USING btree ("run_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_proposals_idempotency_key" ON "clinical"."agent_proposals" USING btree ("tenant_id","idempotency_key");--> statement-breakpoint
CREATE INDEX "agent_proposals_tenant_status_idx" ON "clinical"."agent_proposals" USING btree ("tenant_id","status","created_at");--> statement-breakpoint
CREATE INDEX "agent_proposals_agent_id_idx" ON "clinical"."agent_proposals" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_proposals_run_idx" ON "clinical"."agent_proposals" USING btree ("run_id");--> statement-breakpoint
CREATE INDEX "agent_proposals_conversation_idx" ON "clinical"."agent_proposals" USING btree ("conversation_id");
--> statement-breakpoint

-- A run belongs to one conversation.
ALTER TABLE "platform"."agent_runs" ADD CONSTRAINT "agent_runs_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "clinical"."agent_conversations"("id");
--> statement-breakpoint

-- Grants, table by table: only what the API and the agents worker do. Nothing
-- for medora_marketing: the clinical tables are never reachable from marketing (ADR 0007).
GRANT SELECT, INSERT ON platform.agent_settings TO medora_app;
--> statement-breakpoint
GRANT UPDATE (enabled, display_name, auto_tools, monthly_spend_cap_cents, daily_reply_cap, refund_cap_cents, updated_at, updated_by) ON platform.agent_settings TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.agent_tenant_settings TO medora_app;
--> statement-breakpoint
GRANT UPDATE (paused, updated_at, updated_by) ON platform.agent_tenant_settings TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.agent_runs TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, agent_version, model, model_version, steps, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_cents, end_reason, ended_at, lease_expires_at) ON platform.agent_runs TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.agent_conversations TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, handoff_reason, updated_at) ON clinical.agent_conversations TO medora_app;
--> statement-breakpoint
-- Transcripts are append-only for the API.
GRANT SELECT, INSERT ON clinical.agent_messages TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.agent_proposals TO medora_app;
--> statement-breakpoint
GRANT UPDATE (final_input, status, decided_by, decided_at, decision_reason, result_status, executed_at) ON clinical.agent_proposals TO medora_app;
--> statement-breakpoint

-- Row-level security (ADR 0006).
ALTER TABLE platform.agent_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.agent_settings
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE platform.agent_tenant_settings ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.agent_tenant_settings
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE platform.agent_runs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.agent_runs
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.agent_conversations ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.agent_conversations
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.agent_messages ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.agent_messages
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.agent_proposals ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.agent_proposals
  USING (tenant_id = medora.current_tenant()) WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- The agents worker's claim (AGT8), the only cross-tenant query agents make.
-- First, runs whose worker died (lease run out) are failed, never resumed, and
-- returned as 'abandoned' so the worker hands each conversation to a person.
-- Then the oldest queued run is claimed, skipping conversations that already
-- have a run going and tenants at their limit. Everything after the claim
-- runs inside withTenant.
CREATE FUNCTION platform.claim_agent_runs(p_lease_seconds integer, p_tenant_limit integer)
  RETURNS TABLE (run_id uuid, tenant_id uuid, outcome text)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  RETURN QUERY
  UPDATE platform.agent_runs r
     SET status = 'failed', end_reason = 'worker_died', ended_at = now(), lease_expires_at = NULL
   WHERE r.status = 'running' AND r.lease_expires_at < now()
  RETURNING r.id, r.tenant_id, 'abandoned'::text;

  BEGIN
    RETURN QUERY
    WITH next AS (
      SELECT q.id
        FROM platform.agent_runs q
       WHERE q.status = 'queued'
         AND NOT EXISTS (SELECT 1 FROM platform.agent_runs b WHERE b.conversation_id = q.conversation_id AND b.status = 'running')
         AND (SELECT count(*) FROM platform.agent_runs t WHERE t.tenant_id = q.tenant_id AND t.status = 'running') < p_tenant_limit
       ORDER BY q.queued_at, q.id
       LIMIT 1
       FOR UPDATE SKIP LOCKED
    )
    UPDATE platform.agent_runs r
       SET status = 'running', started_at = now(), lease_expires_at = now() + make_interval(secs => p_lease_seconds)
      FROM next
     WHERE r.id = next.id
    RETURNING r.id, r.tenant_id, 'claimed'::text;
  EXCEPTION WHEN unique_violation THEN
    -- Another worker started a run in the same conversation a moment ago: try again on the next tick.
    RETURN;
  END;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.claim_agent_runs(integer, integer) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.claim_agent_runs(integer, integer) TO medora_app;
