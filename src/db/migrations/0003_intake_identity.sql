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
	CONSTRAINT "patient_addresses_state_check" CHECK ("clinical"."patient_addresses"."state" in ('ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA')),
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
	"medicare" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "patients_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "patients_sex_check" CHECK ("clinical"."patients"."sex" in ('female', 'male', 'intersex', 'not_stated')),
	CONSTRAINT "patients_identity_status_check" CHECK ("clinical"."patients"."identity_status" in ('unverified', 'verified', 'failed')),
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
GRANT UPDATE (given_name, family_name, preferred_name, date_of_birth, sex, time_zone, identity_status, medicare, updated_at) ON clinical.patients TO medora_app;
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
