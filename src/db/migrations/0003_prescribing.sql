CREATE TABLE "clinical"."parchment_patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"parchment_patient_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "operational"."parchment_prescribers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"parchment_user_id" text NOT NULL,
	"linked_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical"."prescribing_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"prescriber_user_id" uuid NOT NULL,
	"parchment_user_id" text NOT NULL,
	"consult_id" uuid NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "clinical"."parchment_patients" ADD CONSTRAINT "parchment_patients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."parchment_prescribers" ADD CONSTRAINT "parchment_prescribers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."parchment_prescribers" ADD CONSTRAINT "parchment_prescribers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."prescribing_sessions" ADD CONSTRAINT "prescribing_sessions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."prescribing_sessions" ADD CONSTRAINT "prescribing_sessions_prescriber_user_id_users_id_fk" FOREIGN KEY ("prescriber_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "parchment_patients_patient_key" ON "clinical"."parchment_patients" USING btree ("patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parchment_patients_parchment_key" ON "clinical"."parchment_patients" USING btree ("tenant_id","parchment_patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parchment_prescribers_parchment_key" ON "operational"."parchment_prescribers" USING btree ("tenant_id","parchment_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "parchment_prescribers_user_key" ON "operational"."parchment_prescribers" USING btree ("user_id","tenant_id");--> statement-breakpoint
CREATE INDEX "prescribing_sessions_tenant_idx" ON "clinical"."prescribing_sessions" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "prescribing_sessions_patient_idx" ON "clinical"."prescribing_sessions" USING btree ("patient_id","opened_at");--> statement-breakpoint
CREATE INDEX "prescribing_sessions_prescriber_idx" ON "clinical"."prescribing_sessions" USING btree ("prescriber_user_id");--> statement-breakpoint
CREATE INDEX "prescribing_sessions_consult_idx" ON "clinical"."prescribing_sessions" USING btree ("consult_id");--> statement-breakpoint

-- Row-level security and grants for prescribing (ADRs 0006, 0007, 0013).
-- Prescribing sessions are written once. No role deletes from any of these.
ALTER TABLE clinical.parchment_patients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.parchment_patients
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.parchment_prescribers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.parchment_prescribers
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.prescribing_sessions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.prescribing_sessions
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.parchment_patients TO medora_app;
--> statement-breakpoint
GRANT UPDATE (synced_at) ON clinical.parchment_patients TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.parchment_prescribers TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.prescribing_sessions TO medora_app;
