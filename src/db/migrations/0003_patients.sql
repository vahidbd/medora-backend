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
ALTER TABLE "platform"."audit_log" DROP CONSTRAINT "audit_log_actor_type_check";--> statement-breakpoint
ALTER TABLE "clinical"."patient_addresses" ADD CONSTRAINT "patient_addresses_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_contacts" ADD CONSTRAINT "patient_contacts_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_sign_ins" ADD CONSTRAINT "patient_sign_ins_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patients" ADD CONSTRAINT "patients_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "patient_addresses_patient_kind_key" ON "clinical"."patient_addresses" USING btree ("tenant_id","patient_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_contacts_patient_kind_key" ON "clinical"."patient_contacts" USING btree ("tenant_id","patient_id","kind");--> statement-breakpoint
CREATE INDEX "patient_contacts_lookup_idx" ON "clinical"."patient_contacts" USING btree ("tenant_id","kind","value");--> statement-breakpoint
CREATE UNIQUE INDEX "patient_sign_ins_session_key" ON "clinical"."patient_sign_ins" USING btree ("tenant_id","session_id");--> statement-breakpoint
CREATE INDEX "patient_sign_ins_patient_idx" ON "clinical"."patient_sign_ins" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE UNIQUE INDEX "patients_tenant_sign_in_key" ON "clinical"."patients" USING btree ("tenant_id","clerk_user_id") WHERE "clinical"."patients"."clerk_user_id" is not null;--> statement-breakpoint
CREATE INDEX "patients_tenant_family_name_idx" ON "clinical"."patients" USING btree ("tenant_id",lower("family_name"));--> statement-breakpoint
ALTER TABLE "platform"."audit_log" ADD CONSTRAINT "audit_log_actor_type_check" CHECK ("platform"."audit_log"."actor_type" in ('person', 'patient', 'agent', 'system'));--> statement-breakpoint

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
