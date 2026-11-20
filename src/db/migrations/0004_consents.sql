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
ALTER TABLE "clinical"."consent_documents" ADD CONSTRAINT "consent_documents_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."consent_documents" ADD CONSTRAINT "consent_documents_published_by_users_id_fk" FOREIGN KEY ("published_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_recorded_by_users_id_fk" FOREIGN KEY ("recorded_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."patient_consents" ADD CONSTRAINT "patient_consents_document_fk" FOREIGN KEY ("tenant_id","document_id","kind") REFERENCES "clinical"."consent_documents"("tenant_id","id","kind") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consent_documents_version_key" ON "clinical"."consent_documents" USING btree ("tenant_id","kind","version");--> statement-breakpoint
CREATE INDEX "consent_documents_published_by_idx" ON "clinical"."consent_documents" USING btree ("published_by");--> statement-breakpoint
CREATE INDEX "patient_consents_patient_idx" ON "clinical"."patient_consents" USING btree ("tenant_id","patient_id","kind","at");--> statement-breakpoint
CREATE INDEX "patient_consents_document_idx" ON "clinical"."patient_consents" USING btree ("tenant_id","document_id","kind");--> statement-breakpoint
CREATE INDEX "patient_consents_recorded_by_idx" ON "clinical"."patient_consents" USING btree ("recorded_by");--> statement-breakpoint

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
