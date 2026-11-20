CREATE TABLE "platform"."tenant_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_keys_provider_check" CHECK ("platform"."tenant_keys"."provider" in ('local'))
);
--> statement-breakpoint
CREATE TABLE "clinical"."patient_addresses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text DEFAULT 'home' NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"suburb" text NOT NULL,
	"state" text NOT NULL,
	"postcode" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_addresses_kind_check" CHECK ("clinical"."patient_addresses"."kind" in ('home')),
	CONSTRAINT "patient_addresses_state_check" CHECK ("clinical"."patient_addresses"."state" in ('NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT')),
	CONSTRAINT "patient_addresses_postcode_check" CHECK ("clinical"."patient_addresses"."postcode" ~ '^[0-9]{4}$')
);
--> statement-breakpoint
CREATE TABLE "clinical"."patient_contacts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" text NOT NULL,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_contacts_kind_check" CHECK ("clinical"."patient_contacts"."kind" in ('email', 'mobile')),
	CONSTRAINT "patient_contacts_value_check" CHECK (("clinical"."patient_contacts"."kind" = 'email' and "clinical"."patient_contacts"."value" = lower("clinical"."patient_contacts"."value") and "clinical"."patient_contacts"."value" like '%_@_%') or ("clinical"."patient_contacts"."kind" = 'mobile' and "clinical"."patient_contacts"."value" ~ '^\+614[0-9]{8}$'))
);
--> statement-breakpoint
CREATE TABLE "clinical"."patient_sign_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"session_id" text NOT NULL,
	"confirmed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "clinical"."patients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"clerk_user_id" text,
	"given_name" text NOT NULL,
	"family_name" text NOT NULL,
	"preferred_name" text,
	"date_of_birth" date NOT NULL,
	"sex" text NOT NULL,
	"time_zone" text,
	"identity_status" text DEFAULT 'unverified' NOT NULL,
	"identity_failures" smallint DEFAULT 0 NOT NULL,
	"medicare" text,
	"ihi" text,
	"ihi_status" text,
	"ihi_record_status" text,
	"ihi_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patients_sex_check" CHECK ("clinical"."patients"."sex" in ('female', 'male', 'intersex', 'not_stated')),
	CONSTRAINT "patients_identity_status_check" CHECK ("clinical"."patients"."identity_status" in ('unverified', 'verified', 'failed')),
	CONSTRAINT "patients_identity_failures_check" CHECK ("clinical"."patients"."identity_failures" between 0 and 3),
	CONSTRAINT "patients_ihi_status_check" CHECK ("clinical"."patients"."ihi_status" in ('active', 'deceased', 'retired', 'expired', 'resolved')),
	CONSTRAINT "patients_ihi_record_status_check" CHECK ("clinical"."patients"."ihi_record_status" in ('verified', 'unverified', 'provisional')),
	CONSTRAINT "patients_ihi_check" CHECK (("clinical"."patients"."ihi" is null) = ("clinical"."patients"."ihi_status" is null) and ("clinical"."patients"."ihi" is null) = ("clinical"."patients"."ihi_record_status" is null)),
	CONSTRAINT "patients_names_check" CHECK (length(trim("clinical"."patients"."given_name")) > 0 and length(trim("clinical"."patients"."family_name")) > 0)
);
--> statement-breakpoint
CREATE TABLE "clinical"."consent_documents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"published_by" uuid,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "consent_documents_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "consent_documents_kind_key" UNIQUE("tenant_id","id","kind"),
	CONSTRAINT "consent_documents_kind_check" CHECK ("clinical"."consent_documents"."kind" in ('privacy', 'telehealth_terms', 'identity_check', 'pharmacy_sharing')),
	CONSTRAINT "consent_documents_version_check" CHECK ("clinical"."consent_documents"."version" > 0),
	CONSTRAINT "consent_documents_text_check" CHECK (length(trim("clinical"."consent_documents"."title")) > 0 and length(trim("clinical"."consent_documents"."body")) > 0)
);
--> statement-breakpoint
CREATE TABLE "clinical"."patient_consents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"document_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"decision" text NOT NULL,
	"channel" text NOT NULL,
	"recorded_by" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patient_consents_kind_check" CHECK ("clinical"."patient_consents"."kind" in ('privacy', 'telehealth_terms', 'identity_check', 'pharmacy_sharing')),
	CONSTRAINT "patient_consents_decision_check" CHECK ("clinical"."patient_consents"."decision" in ('given', 'withdrawn')),
	CONSTRAINT "patient_consents_channel_check" CHECK ("clinical"."patient_consents"."channel" in ('web', 'phone', 'in_person')),
	CONSTRAINT "patient_consents_staff_reason_check" CHECK (("clinical"."patient_consents"."recorded_by" is null) or ("clinical"."patient_consents"."reason" is not null and length(trim("clinical"."patient_consents"."reason")) > 0))
);
--> statement-breakpoint
CREATE TABLE "clinical"."identity_checks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"method" text NOT NULL,
	"document_type" text NOT NULL,
	"outcome" text NOT NULL,
	"provider_reference" text,
	"checked_by" uuid,
	"reason" text,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identity_checks_method_check" CHECK ("clinical"."identity_checks"."method" in ('document', 'manual')),
	CONSTRAINT "identity_checks_document_type_check" CHECK ("clinical"."identity_checks"."document_type" in ('driver_licence', 'passport', 'medicare_card')),
	CONSTRAINT "identity_checks_outcome_check" CHECK ("clinical"."identity_checks"."outcome" in ('verified', 'not_matched', 'unavailable')),
	CONSTRAINT "identity_checks_manual_check" CHECK (("clinical"."identity_checks"."method" = 'document' and "clinical"."identity_checks"."checked_by" is null) or ("clinical"."identity_checks"."method" = 'manual' and "clinical"."identity_checks"."checked_by" is not null and "clinical"."identity_checks"."outcome" = 'verified' and length(trim(coalesce("clinical"."identity_checks"."reason", ''))) > 0))
);
--> statement-breakpoint
CREATE TABLE "clinical"."protocol_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"protocol_id" uuid NOT NULL,
	"version" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"definition" jsonb NOT NULL,
	"edited_by" uuid,
	"edited_at" timestamp with time zone DEFAULT now() NOT NULL,
	"signed_off_by" uuid,
	"signed_off_at" timestamp with time zone,
	"signer_registration" text,
	"attestation" text,
	"retired_at" timestamp with time zone,
	"withdrawn_by" uuid,
	"withdrawn_at" timestamp with time zone,
	"withdrawn_reason" text,
	CONSTRAINT "protocol_versions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "protocol_versions_status_check" CHECK ("clinical"."protocol_versions"."status" in ('draft', 'live', 'retired', 'withdrawn')),
	CONSTRAINT "protocol_versions_version_check" CHECK ("clinical"."protocol_versions"."version" > 0),
	CONSTRAINT "protocol_versions_sign_off_check" CHECK (("clinical"."protocol_versions"."status" = 'draft') = ("clinical"."protocol_versions"."signed_off_at" is null) and ("clinical"."protocol_versions"."signed_off_at" is null) = ("clinical"."protocol_versions"."signed_off_by" is null) and ("clinical"."protocol_versions"."signed_off_at" is null) = ("clinical"."protocol_versions"."signer_registration" is null) and ("clinical"."protocol_versions"."signed_off_at" is null) = ("clinical"."protocol_versions"."attestation" is null)),
	CONSTRAINT "protocol_versions_withdrawn_check" CHECK (("clinical"."protocol_versions"."status" = 'withdrawn') = ("clinical"."protocol_versions"."withdrawn_at" is not null) and ("clinical"."protocol_versions"."withdrawn_at" is null) = ("clinical"."protocol_versions"."withdrawn_reason" is null))
);
--> statement-breakpoint
CREATE TABLE "clinical"."protocols" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"condition" text NOT NULL,
	"template_key" text,
	"template_version" integer,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "protocols_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "protocols_text_check" CHECK (length(trim("clinical"."protocols"."name")) > 0 and length(trim("clinical"."protocols"."condition")) > 0),
	CONSTRAINT "protocols_template_check" CHECK (("clinical"."protocols"."template_key" is null) = ("clinical"."protocols"."template_version" is null))
);
--> statement-breakpoint
CREATE TABLE "operational"."programs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"protocol_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"measurements" text[] DEFAULT '{}'::text[] NOT NULL,
	"check_in_every_days" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "programs_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "programs_status_check" CHECK ("operational"."programs"."status" in ('draft', 'live', 'paused', 'retired')),
	CONSTRAINT "programs_measurements_check" CHECK ("operational"."programs"."measurements" <@ array['weight', 'waist', 'height', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'heart_rate']::text[]),
	CONSTRAINT "programs_name_check" CHECK (length(trim("operational"."programs"."name")) > 0),
	CONSTRAINT "programs_check_in_check" CHECK ("operational"."programs"."check_in_every_days" is null or "operational"."programs"."check_in_every_days" between 1 and 365)
);
--> statement-breakpoint
CREATE TABLE "clinical"."intakes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"protocol_version_id" uuid NOT NULL,
	"patient_id" uuid,
	"resume_token_hash" text,
	"status" text DEFAULT 'in_progress' NOT NULL,
	"ended_reason" text,
	"stopped_rule" text,
	"red_flags" text[] DEFAULT '{}'::text[] NOT NULL,
	"date_of_birth" date,
	"privacy_document_id" uuid NOT NULL,
	"privacy_agreed_at" timestamp with time zone NOT NULL,
	"answers" text,
	"steps_done" integer DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_active_at" timestamp with time zone DEFAULT now() NOT NULL,
	"submitted_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"claimed_at" timestamp with time zone,
	"cleared_at" timestamp with time zone,
	CONSTRAINT "intakes_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "intakes_status_check" CHECK ("clinical"."intakes"."status" in ('in_progress', 'completed', 'ineligible', 'ended')),
	CONSTRAINT "intakes_ended_reason_check" CHECK ("clinical"."intakes"."ended_reason" in ('under_age', 'version_withdrawn', 'expired', 'unclaimed')),
	CONSTRAINT "intakes_ended_check" CHECK (("clinical"."intakes"."status" = 'ended') = ("clinical"."intakes"."ended_reason" is not null)),
	CONSTRAINT "intakes_ineligible_check" CHECK (("clinical"."intakes"."status" = 'ineligible') = ("clinical"."intakes"."stopped_rule" is not null)),
	CONSTRAINT "intakes_submitted_check" CHECK (("clinical"."intakes"."status" = 'completed') = ("clinical"."intakes"."submitted_at" is not null)),
	CONSTRAINT "intakes_holder_check" CHECK ("clinical"."intakes"."patient_id" is not null or "clinical"."intakes"."resume_token_hash" is not null or "clinical"."intakes"."cleared_at" is not null),
	CONSTRAINT "intakes_steps_check" CHECK ("clinical"."intakes"."steps_done" >= 0)
);
--> statement-breakpoint
ALTER TABLE "platform"."audit_log" DROP CONSTRAINT "audit_log_actor_type_check";--> statement-breakpoint
ALTER TABLE "platform"."tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_addresses" ADD CONSTRAINT "patient_addresses_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_contacts" ADD CONSTRAINT "patient_contacts_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_sign_ins" ADD CONSTRAINT "patient_sign_ins_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patients" ADD CONSTRAINT "patients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consent_documents" ADD CONSTRAINT "consent_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consent_documents" ADD CONSTRAINT "consent_documents_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_document_fk" FOREIGN KEY ("tenant_id","document_id","kind") REFERENCES "clinical"."consent_documents"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."identity_checks" ADD CONSTRAINT "identity_checks_checked_by_users_id_fk" FOREIGN KEY ("checked_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."identity_checks" ADD CONSTRAINT "identity_checks_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocol_versions" ADD CONSTRAINT "protocol_versions_edited_by_users_id_fk" FOREIGN KEY ("edited_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocol_versions" ADD CONSTRAINT "protocol_versions_signed_off_by_users_id_fk" FOREIGN KEY ("signed_off_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocol_versions" ADD CONSTRAINT "protocol_versions_withdrawn_by_users_id_fk" FOREIGN KEY ("withdrawn_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocol_versions" ADD CONSTRAINT "protocol_versions_protocol_fk" FOREIGN KEY ("tenant_id","protocol_id") REFERENCES "clinical"."protocols"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocols" ADD CONSTRAINT "protocols_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."protocols" ADD CONSTRAINT "protocols_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."programs" ADD CONSTRAINT "programs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."programs" ADD CONSTRAINT "programs_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."programs" ADD CONSTRAINT "programs_protocol_fk" FOREIGN KEY ("tenant_id","protocol_id") REFERENCES "clinical"."protocols"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."intakes" ADD CONSTRAINT "intakes_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."intakes" ADD CONSTRAINT "intakes_program_fk" FOREIGN KEY ("tenant_id","program_id") REFERENCES "operational"."programs"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."intakes" ADD CONSTRAINT "intakes_protocol_version_fk" FOREIGN KEY ("tenant_id","protocol_version_id") REFERENCES "clinical"."protocol_versions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."intakes" ADD CONSTRAINT "intakes_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."intakes" ADD CONSTRAINT "intakes_privacy_document_fk" FOREIGN KEY ("tenant_id","privacy_document_id") REFERENCES "clinical"."consent_documents"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_keys_tenant_key" ON "platform"."tenant_keys" USING btree ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_addresses_patient_kind_key" ON "clinical"."patient_addresses" USING btree ("tenant_id","patient_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contacts_patient_kind_key" ON "clinical"."patient_contacts" USING btree ("tenant_id","patient_id","kind");--> statement-breakpoint
CREATE INDEX "patient_contacts_lookup_idx" ON "clinical"."patient_contacts" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_sign_ins_session_key" ON "clinical"."patient_sign_ins" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "patient_sign_ins_patient_idx" ON "clinical"."patient_sign_ins" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_tenant_sign_in_key" ON "clinical"."patients" USING btree ("tenant_id","clerk_user_id") WHERE "clinical"."patients"."clerk_user_id" is not null;--> statement-breakpoint
CREATE INDEX "patients_tenant_family_name_idx" ON "clinical"."patients" USING btree ("tenant_id",lower("family_name"));--> statement-breakpoint
CREATE UNIQUE INDEX "consent_documents_version_key" ON "clinical"."consent_documents" USING btree ("tenant_id","kind","version");--> statement-breakpoint
CREATE INDEX "consent_documents_published_by_idx" ON "clinical"."consent_documents" USING btree ("published_by");--> statement-breakpoint
CREATE INDEX "patient_consents_patient_idx" ON "clinical"."patient_consents" USING btree ("tenant_id","patient_id","kind","at");--> statement-breakpoint
CREATE INDEX "patient_consents_document_idx" ON "clinical"."patient_consents" USING btree ("tenant_id","document_id","kind");--> statement-breakpoint
CREATE INDEX "patient_consents_recorded_by_idx" ON "clinical"."patient_consents" USING btree ("recorded_by");--> statement-breakpoint
CREATE INDEX "identity_checks_patient_idx" ON "clinical"."identity_checks" USING btree ("tenant_id","patient_id","at");--> statement-breakpoint
CREATE INDEX "identity_checks_checked_by_idx" ON "clinical"."identity_checks" USING btree ("checked_by");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_version_key" ON "clinical"."protocol_versions" USING btree ("tenant_id","protocol_id","version");--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_one_live_key" ON "clinical"."protocol_versions" USING btree ("tenant_id","protocol_id") WHERE "clinical"."protocol_versions"."status" = 'live';--> statement-breakpoint
CREATE UNIQUE INDEX "protocol_versions_one_draft_key" ON "clinical"."protocol_versions" USING btree ("tenant_id","protocol_id") WHERE "clinical"."protocol_versions"."status" = 'draft';--> statement-breakpoint
CREATE INDEX "protocol_versions_edited_by_idx" ON "clinical"."protocol_versions" USING btree ("edited_by");--> statement-breakpoint
CREATE INDEX "protocol_versions_signed_off_by_idx" ON "clinical"."protocol_versions" USING btree ("signed_off_by");--> statement-breakpoint
CREATE INDEX "protocol_versions_withdrawn_by_idx" ON "clinical"."protocol_versions" USING btree ("withdrawn_by");--> statement-breakpoint
CREATE UNIQUE INDEX "protocols_tenant_name_key" ON "clinical"."protocols" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "protocols_created_by_idx" ON "clinical"."protocols" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX "programs_protocol_idx" ON "operational"."programs" USING btree ("tenant_id","protocol_id");--> statement-breakpoint
CREATE INDEX "programs_brand_idx" ON "operational"."programs" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE UNIQUE INDEX "intakes_resume_token_key" ON "clinical"."intakes" USING btree ("resume_token_hash");--> statement-breakpoint
CREATE INDEX "intakes_patient_idx" ON "clinical"."intakes" USING btree ("tenant_id","patient_id","submitted_at");--> statement-breakpoint
CREATE INDEX "intakes_program_idx" ON "clinical"."intakes" USING btree ("tenant_id","program_id");--> statement-breakpoint
CREATE INDEX "intakes_protocol_version_idx" ON "clinical"."intakes" USING btree ("tenant_id","protocol_version_id");--> statement-breakpoint
CREATE INDEX "intakes_privacy_document_idx" ON "clinical"."intakes" USING btree ("tenant_id","privacy_document_id");--> statement-breakpoint
CREATE INDEX "intakes_activity_idx" ON "clinical"."intakes" USING btree ("status","last_active_at");--> statement-breakpoint
ALTER TABLE "platform"."audit_log" ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("platform"."audit_log"."actor_type" in ('person', 'patient', 'agent', 'system'));--> statement-breakpoint

-- Field encryption keys (ADR 0010, docs/decisions/field-encryption.md).
-- The API reads its tenant's key and adds one on first use; nobody changes or
-- removes a key, because values sealed with it would become unreadable.
GRANT SELECT, INSERT ON platform.tenant_keys TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.tenant_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.tenant_keys
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE FUNCTION platform.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '%.% rows are never changed or removed: % refused', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.refuse_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tenant_keys_keep BEFORE UPDATE OR DELETE ON platform.tenant_keys
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER tenant_keys_no_truncate BEFORE TRUNCATE ON platform.tenant_keys
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint

-- Patients (docs/decisions/patients.md). Each table is the tenant's alone
-- (ADR 0006); the composite keys on (tenant_id, patient_id) mean a row can't
-- point at another tenant's patient either. Clinical records are never
-- deleted (ADR 0028), so the API gets no DELETE.
GRANT SELECT, INSERT ON clinical.patients TO medora_app;
--> statement-breakpoint
GRANT UPDATE (given_name, family_name, preferred_name, date_of_birth, sex, time_zone, identity_status, identity_failures, medicare, ihi, ihi_status, ihi_record_status, ihi_checked_at, updated_at) ON clinical.patients TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON clinical.patient_contacts, clinical.patient_addresses, clinical.patient_sign_ins TO medora_app;
--> statement-breakpoint
GRANT UPDATE (value, verified_at, updated_at) ON clinical.patient_contacts TO medora_app;
--> statement-breakpoint
GRANT UPDATE (line1, line2, suburb, state, postcode, updated_at) ON clinical.patient_addresses TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.patients ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.patients
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.patient_contacts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.patient_contacts
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.patient_addresses ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.patient_addresses
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.patient_sign_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.patient_sign_ins
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- Consents (docs/decisions/patients.md IDN12 to IDN14). Each table is the
-- tenant's alone (ADR 0006). Both are insert-only: published text never
-- changes, and a decision is never edited or removed, so a withdrawal or a
-- new version is a new row. The API gets SELECT and INSERT only, and the
-- trigger refuses a change from any role.
GRANT SELECT, INSERT ON clinical.consent_documents, clinical.patient_consents TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.consent_documents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.consent_documents
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.patient_consents ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.patient_consents
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE TRIGGER consent_documents_keep BEFORE UPDATE OR DELETE ON clinical.consent_documents
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER consent_documents_no_truncate BEFORE TRUNCATE ON clinical.consent_documents
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER patient_consents_keep BEFORE UPDATE OR DELETE ON clinical.patient_consents
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER patient_consents_no_truncate BEFORE TRUNCATE ON clinical.patient_consents
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint

-- Identity checks (docs/decisions/patients.md IDN16, IDN17). The tenant's
-- alone (ADR 0006) and insert-only, like consents: a check is evidence.
GRANT SELECT, INSERT ON clinical.identity_checks TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.identity_checks ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.identity_checks
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE TRIGGER identity_checks_keep BEFORE UPDATE OR DELETE ON clinical.identity_checks
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER identity_checks_no_truncate BEFORE TRUNCATE ON clinical.identity_checks
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint

-- Protocols and programs (docs/decisions/intake.md INT3, INT4, INT9). The
-- tenant's alone (ADR 0006), and never deleted: an intake points at the
-- version it was answered on. Only a draft's definition is ever edited; the
-- trigger holds that, and the order a version's status moves in, for every
-- role.
GRANT SELECT, INSERT ON clinical.protocols, clinical.protocol_versions, operational.programs TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, definition, edited_by, edited_at, signed_off_by, signed_off_at, signer_registration, attestation, retired_at, withdrawn_by, withdrawn_at, withdrawn_reason) ON clinical.protocol_versions TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, status, measurements, check_in_every_days, updated_at) ON operational.programs TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.protocols ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.protocols
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.protocol_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.protocol_versions
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.programs ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.programs
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE FUNCTION clinical.protocol_version_moves() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id
    OR NEW.protocol_id IS DISTINCT FROM OLD.protocol_id OR NEW.version IS DISTINCT FROM OLD.version THEN
    RAISE EXCEPTION 'A protocol version keeps its protocol and number' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.status = 'draft' AND NEW.status IN ('draft', 'live') THEN
    RETURN NEW;
  END IF;
  IF OLD.status = 'live' AND NEW.status IN ('retired', 'withdrawn')
    AND NEW.definition IS NOT DISTINCT FROM OLD.definition
    AND NEW.edited_by IS NOT DISTINCT FROM OLD.edited_by AND NEW.edited_at IS NOT DISTINCT FROM OLD.edited_at
    AND NEW.signed_off_by IS NOT DISTINCT FROM OLD.signed_off_by AND NEW.signed_off_at IS NOT DISTINCT FROM OLD.signed_off_at
    AND NEW.signer_registration IS NOT DISTINCT FROM OLD.signer_registration AND NEW.attestation IS NOT DISTINCT FROM OLD.attestation THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A % protocol version can''t change that way', OLD.status USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION clinical.protocol_version_moves() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER protocol_versions_moves BEFORE UPDATE ON clinical.protocol_versions
  FOR EACH ROW EXECUTE FUNCTION clinical.protocol_version_moves();
--> statement-breakpoint
CREATE TRIGGER protocol_versions_keep BEFORE DELETE ON clinical.protocol_versions
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER protocol_versions_no_truncate BEFORE TRUNCATE ON clinical.protocol_versions
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint

-- Intakes (docs/decisions/intake.md INT5 to INT8). The tenant's alone (ADR
-- 0006). Never deleted: the clean-up clears an unclaimed intake's answers and
-- date of birth and keeps the row (INT7), and a claimed one is the patient's
-- clinical record (ADR 0028).
GRANT SELECT, INSERT ON clinical.intakes TO medora_app;
--> statement-breakpoint
GRANT UPDATE (patient_id, resume_token_hash, status, ended_reason, stopped_rule, red_flags, date_of_birth, answers, steps_done, last_active_at, submitted_at, ended_at, claimed_at, cleared_at) ON clinical.intakes TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.intakes ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.intakes
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
