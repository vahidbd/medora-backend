CREATE TABLE "operational"."clinician_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clinician_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"reference" text,
	"registering_body" text,
	"registration_type" text,
	"registration_status" text,
	"conditions" text,
	"endorsement" text,
	"insurer" text,
	"covers_telehealth_new_patients" boolean,
	"starts_on" date,
	"expires_on" date,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"conditions_reviewed_at" timestamp with time zone,
	"conditions_reviewed_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawal_reason" text,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinician_credentials_kind_check" CHECK ("operational"."clinician_credentials"."kind" in ('registration', 'endorsement', 'indemnity')),
	CONSTRAINT "clinician_credentials_registering_body_check" CHECK ("operational"."clinician_credentials"."registering_body" in ('ahpra', 'dietitians_australia')),
	CONSTRAINT "clinician_credentials_registration_type_check" CHECK ("operational"."clinician_credentials"."registration_type" in ('general', 'specialist', 'provisional', 'limited')),
	CONSTRAINT "clinician_credentials_registration_status_check" CHECK ("operational"."clinician_credentials"."registration_status" in ('practising', 'non_practising', 'suspended', 'cancelled')),
	CONSTRAINT "clinician_credentials_endorsement_check" CHECK ("operational"."clinician_credentials"."endorsement" in ('nurse_practitioner')),
	CONSTRAINT "clinician_credentials_withdrawal_reason_check" CHECK ("operational"."clinician_credentials"."withdrawal_reason" in ('entered_in_error', 'replaced', 'no_longer_held')),
	CONSTRAINT "clinician_credentials_shape_check" CHECK (case "operational"."clinician_credentials"."kind"
        when 'registration' then "operational"."clinician_credentials"."registering_body" is not null and "operational"."clinician_credentials"."registration_status" is not null and "operational"."clinician_credentials"."reference" is not null
          and "operational"."clinician_credentials"."expires_on" is not null and "operational"."clinician_credentials"."endorsement" is null and "operational"."clinician_credentials"."insurer" is null and "operational"."clinician_credentials"."covers_telehealth_new_patients" is null
        when 'endorsement' then "operational"."clinician_credentials"."endorsement" is not null and "operational"."clinician_credentials"."registering_body" is null and "operational"."clinician_credentials"."registration_status" is null
          and "operational"."clinician_credentials"."registration_type" is null and "operational"."clinician_credentials"."conditions" is null and "operational"."clinician_credentials"."insurer" is null and "operational"."clinician_credentials"."covers_telehealth_new_patients" is null
        when 'indemnity' then "operational"."clinician_credentials"."insurer" is not null and "operational"."clinician_credentials"."covers_telehealth_new_patients" is not null and "operational"."clinician_credentials"."expires_on" is not null
          and "operational"."clinician_credentials"."registering_body" is null and "operational"."clinician_credentials"."registration_status" is null and "operational"."clinician_credentials"."registration_type" is null
          and "operational"."clinician_credentials"."conditions" is null and "operational"."clinician_credentials"."endorsement" is null
        else false end),
	CONSTRAINT "clinician_credentials_dates_check" CHECK ("operational"."clinician_credentials"."starts_on" is null or "operational"."clinician_credentials"."expires_on" is null or "operational"."clinician_credentials"."starts_on" <= "operational"."clinician_credentials"."expires_on"),
	CONSTRAINT "clinician_credentials_verified_check" CHECK (("operational"."clinician_credentials"."verified_at" is null) = ("operational"."clinician_credentials"."verified_by" is null)),
	CONSTRAINT "clinician_credentials_reviewed_check" CHECK (("operational"."clinician_credentials"."conditions_reviewed_at" is null) = ("operational"."clinician_credentials"."conditions_reviewed_by" is null)),
	CONSTRAINT "clinician_credentials_withdrawn_check" CHECK (("operational"."clinician_credentials"."withdrawn_at" is null) = ("operational"."clinician_credentials"."withdrawal_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "operational"."clinician_hours" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clinician_id" uuid NOT NULL,
	"weekday" smallint NOT NULL,
	"starts_at" time NOT NULL,
	"ends_at" time NOT NULL,
	"slot_minutes" smallint DEFAULT 15 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinician_hours_weekday_check" CHECK ("operational"."clinician_hours"."weekday" between 1 and 7),
	CONSTRAINT "clinician_hours_order_check" CHECK ("operational"."clinician_hours"."starts_at" < "operational"."clinician_hours"."ends_at"),
	CONSTRAINT "clinician_hours_slot_check" CHECK ("operational"."clinician_hours"."slot_minutes" between 5 and 120)
);
--> statement-breakpoint
CREATE TABLE "operational"."clinician_time_off" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clinician_id" uuid NOT NULL,
	"starts_at" timestamp with time zone NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reason" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinician_time_off_reason_check" CHECK ("operational"."clinician_time_off"."reason" in ('leave', 'sick', 'training', 'other')),
	CONSTRAINT "clinician_time_off_order_check" CHECK ("operational"."clinician_time_off"."starts_at" < "operational"."clinician_time_off"."ends_at")
);
--> statement-breakpoint
CREATE TABLE "operational"."clinicians" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"profession" text NOT NULL,
	"time_zone" text NOT NULL,
	"suspended_at" timestamp with time zone,
	"suspension_reason" text,
	"suspended_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "clinicians_profession_check" CHECK ("operational"."clinicians"."profession" in ('medical_practitioner', 'nurse_practitioner', 'registered_nurse', 'pharmacist', 'dietitian', 'psychologist', 'health_coach')),
	CONSTRAINT "clinicians_suspension_reason_check" CHECK ("operational"."clinicians"."suspension_reason" in ('registration_concern', 'indemnity_concern', 'clinical_governance', 'leave', 'other')),
	CONSTRAINT "clinicians_suspension_check" CHECK (("operational"."clinicians"."suspended_at" is null) = ("operational"."clinicians"."suspension_reason" is null) and ("operational"."clinicians"."suspended_at" is null) = ("operational"."clinicians"."suspended_by" is null))
);
--> statement-breakpoint
ALTER TABLE "operational"."clinician_credentials" ADD CONSTRAINT "clinician_credentials_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_credentials" ADD CONSTRAINT "clinician_credentials_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "operational"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_credentials" ADD CONSTRAINT "clinician_credentials_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_credentials" ADD CONSTRAINT "clinician_credentials_conditions_reviewed_by_users_id_fk" FOREIGN KEY ("conditions_reviewed_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_credentials" ADD CONSTRAINT "clinician_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_hours" ADD CONSTRAINT "clinician_hours_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_hours" ADD CONSTRAINT "clinician_hours_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "operational"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_time_off" ADD CONSTRAINT "clinician_time_off_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_time_off" ADD CONSTRAINT "clinician_time_off_clinician_id_clinicians_id_fk" FOREIGN KEY ("clinician_id") REFERENCES "operational"."clinicians"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinician_time_off" ADD CONSTRAINT "clinician_time_off_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinicians" ADD CONSTRAINT "clinicians_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinicians" ADD CONSTRAINT "clinicians_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "platform"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."clinicians" ADD CONSTRAINT "clinicians_suspended_by_users_id_fk" FOREIGN KEY ("suspended_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "clinician_credentials_clinician_idx" ON "operational"."clinician_credentials" USING btree ("clinician_id","kind");--> statement-breakpoint
CREATE INDEX "clinician_credentials_tenant_idx" ON "operational"."clinician_credentials" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "clinician_credentials_verified_by_idx" ON "operational"."clinician_credentials" USING btree ("verified_by");--> statement-breakpoint
CREATE INDEX "clinician_credentials_conditions_reviewed_by_idx" ON "operational"."clinician_credentials" USING btree ("conditions_reviewed_by");--> statement-breakpoint
CREATE INDEX "clinician_credentials_created_by_idx" ON "operational"."clinician_credentials" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "clinician_hours_clinician_idx" ON "operational"."clinician_hours" USING btree ("clinician_id","weekday");--> statement-breakpoint
CREATE INDEX "clinician_hours_tenant_idx" ON "operational"."clinician_hours" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "clinician_time_off_clinician_idx" ON "operational"."clinician_time_off" USING btree ("clinician_id","starts_at");--> statement-breakpoint
CREATE INDEX "clinician_time_off_tenant_idx" ON "operational"."clinician_time_off" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "clinician_time_off_created_by_idx" ON "operational"."clinician_time_off" USING btree ("created_by");--> statement-breakpoint
CREATE UNIQUE INDEX "clinicians_membership_key" ON "operational"."clinicians" USING btree ("membership_id");--> statement-breakpoint
CREATE INDEX "clinicians_tenant_idx" ON "operational"."clinicians" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "clinicians_suspended_by_idx" ON "operational"."clinicians" USING btree ("suspended_by");--> statement-breakpoint

-- The workforce (docs/decisions/workforce.md): operational zone, tenant-isolated
-- (ADR 0006). Credentials are never deleted or rewritten, only withdrawn and
-- marked verified or reviewed; hours and time off may be removed.
GRANT SELECT, INSERT ON operational.clinicians TO medora_app;
--> statement-breakpoint
GRANT UPDATE (profession, time_zone, suspended_at, suspension_reason, suspended_by, updated_at) ON operational.clinicians TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.clinician_credentials TO medora_app;
--> statement-breakpoint
GRANT UPDATE (verified_at, verified_by, conditions_reviewed_at, conditions_reviewed_by, withdrawn_at, withdrawal_reason)
  ON operational.clinician_credentials TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON operational.clinician_hours TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON operational.clinician_time_off TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.clinicians ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.clinicians
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.clinician_credentials ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.clinician_credentials
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.clinician_hours ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.clinician_hours
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.clinician_time_off ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.clinician_time_off
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
