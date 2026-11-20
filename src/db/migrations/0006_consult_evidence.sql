CREATE TABLE "clinical"."consult_evidence" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "clinical"."consult_evidence_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"consult_id" uuid NOT NULL,
	"party" text NOT NULL,
	"clinician_user_id" uuid,
	"event" text NOT NULL,
	"channel" text NOT NULL,
	"at" timestamp with time zone NOT NULL,
	"delivery_id" bigint NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consult_evidence_party_check" CHECK ("clinical"."consult_evidence"."party" in ('patient', 'clinician')),
	CONSTRAINT "consult_evidence_event_check" CHECK ("clinical"."consult_evidence"."event" in ('connected', 'disconnected')),
	CONSTRAINT "consult_evidence_channel_check" CHECK ("clinical"."consult_evidence"."channel" in ('phone', 'video')),
	CONSTRAINT "consult_evidence_clinician_check" CHECK (("clinical"."consult_evidence"."party" = 'clinician') = ("clinical"."consult_evidence"."clinician_user_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "clinical"."consults" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"clinician_user_id" uuid NOT NULL,
	"mode" text NOT NULL,
	"status" text DEFAULT 'scheduled' NOT NULL,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consults_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consults_mode_check" CHECK ("clinical"."consults"."mode" in ('phone', 'video')),
	CONSTRAINT "consults_status_check" CHECK ("clinical"."consults"."status" in ('scheduled', 'in_progress', 'completed', 'cancelled', 'no_show')),
	CONSTRAINT "consults_started_check" CHECK ("clinical"."consults"."status" not in ('in_progress', 'completed') or "clinical"."consults"."started_at" is not null),
	CONSTRAINT "consults_ended_check" CHECK (("clinical"."consults"."status" = 'completed') = ("clinical"."consults"."ended_at" is not null)),
	CONSTRAINT "consults_times_check" CHECK ("clinical"."consults"."ended_at" is null or "clinical"."consults"."ended_at" >= "clinical"."consults"."started_at")
);
--> statement-breakpoint
ALTER TABLE "platform"."webhook_inbox" ADD CONSTRAINT "webhook_inbox_tenant_id_key" UNIQUE("tenant_id","id");--> statement-breakpoint
ALTER TABLE "clinical"."consult_evidence" ADD CONSTRAINT "consult_evidence_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consult_evidence" ADD CONSTRAINT "consult_evidence_consult_fk" FOREIGN KEY ("tenant_id","consult_id") REFERENCES "clinical"."consults"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consult_evidence" ADD CONSTRAINT "consult_evidence_delivery_fk" FOREIGN KEY ("tenant_id","delivery_id") REFERENCES "platform"."webhook_inbox"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consult_evidence" ADD CONSTRAINT "consult_evidence_clinician_fk" FOREIGN KEY ("tenant_id","clinician_user_id") REFERENCES "platform"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_clinician_fk" FOREIGN KEY ("tenant_id","clinician_user_id") REFERENCES "platform"."memberships"("tenant_id","user_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "consult_evidence_consult_idx" ON "clinical"."consult_evidence" USING btree ("tenant_id","consult_id","at");--> statement-breakpoint
CREATE UNIQUE INDEX "consult_evidence_delivery_key" ON "clinical"."consult_evidence" USING btree ("tenant_id","delivery_id","party");--> statement-breakpoint
CREATE INDEX "consult_evidence_clinician_idx" ON "clinical"."consult_evidence" USING btree ("tenant_id","clinician_user_id");--> statement-breakpoint
CREATE INDEX "consults_patient_idx" ON "clinical"."consults" USING btree ("tenant_id","patient_id","clinician_user_id");--> statement-breakpoint
CREATE INDEX "consults_clinician_idx" ON "clinical"."consults" USING btree ("tenant_id","clinician_user_id");--> statement-breakpoint

-- Consults and their evidence (docs/decisions/consults.md). Each table is the
-- tenant's alone (ADR 0006), and the composite keys keep every reference inside
-- the tenant. Evidence is insert-only and comes only from verified webhook
-- deliveries (CNS2): the API gets SELECT and INSERT, the trigger refuses a
-- change from any role, and the key to the inbox keeps a delivery that backs
-- evidence from being removed. Clinical records are never deleted (ADR 0028).
GRANT SELECT, INSERT ON clinical.consults TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, started_at, ended_at, updated_at) ON clinical.consults TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.consult_evidence TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.consults ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.consults
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.consult_evidence ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.consult_evidence
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE TRIGGER consult_evidence_keep BEFORE UPDATE OR DELETE ON clinical.consult_evidence
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER consult_evidence_no_truncate BEFORE TRUNCATE ON clinical.consult_evidence
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
