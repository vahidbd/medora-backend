CREATE TABLE "clinical"."check_ins" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"missed_doses" text NOT NULL,
	"feeling" smallint NOT NULL,
	"submitted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "check_ins_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "check_ins_missed_doses_check" CHECK ("clinical"."check_ins"."missed_doses" in ('none', 'some', 'most')),
	CONSTRAINT "check_ins_feeling_check" CHECK ("clinical"."check_ins"."feeling" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "clinical"."measurements" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"value" numeric(6, 1) NOT NULL,
	"measured_at" timestamp with time zone NOT NULL,
	"recorded_by_type" text NOT NULL,
	"recorded_by_id" uuid NOT NULL,
	"check_in_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "measurements_kind_check" CHECK ("clinical"."measurements"."kind" in ('weight', 'waist', 'height', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'heart_rate')),
	CONSTRAINT "measurements_recorded_by_type_check" CHECK ("clinical"."measurements"."recorded_by_type" in ('patient', 'person')),
	CONSTRAINT "measurements_value_check" CHECK ("clinical"."measurements"."value" > 0)
);
--> statement-breakpoint
CREATE TABLE "clinical"."side_effects" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"severity" text NOT NULL,
	"description" text NOT NULL,
	"started_on" date,
	"reported_by_type" text NOT NULL,
	"reported_by_id" uuid NOT NULL,
	"check_in_id" uuid,
	"reported_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "side_effects_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "side_effects_severity_check" CHECK ("clinical"."side_effects"."severity" in ('mild', 'moderate', 'severe')),
	CONSTRAINT "side_effects_reported_by_type_check" CHECK ("clinical"."side_effects"."reported_by_type" in ('patient', 'person')),
	CONSTRAINT "side_effects_description_check" CHECK (length(trim("clinical"."side_effects"."description")) between 1 and 2000)
);
--> statement-breakpoint
CREATE TABLE "operational"."notification_preferences" (
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"sms" boolean DEFAULT true NOT NULL,
	"reminders" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pkey" PRIMARY KEY("tenant_id","patient_id")
);
--> statement-breakpoint
ALTER TABLE "clinical"."check_ins" ADD CONSTRAINT "check_ins_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."measurements" ADD CONSTRAINT "measurements_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."measurements" ADD CONSTRAINT "measurements_check_in_fk" FOREIGN KEY ("tenant_id","check_in_id") REFERENCES "clinical"."check_ins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."side_effects" ADD CONSTRAINT "side_effects_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."side_effects" ADD CONSTRAINT "side_effects_check_in_fk" FOREIGN KEY ("tenant_id","check_in_id") REFERENCES "clinical"."check_ins"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."notification_preferences" ADD CONSTRAINT "notification_preferences_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "check_ins_patient_idx" ON "clinical"."check_ins" USING btree ("tenant_id","patient_id","submitted_at");--> statement-breakpoint
CREATE INDEX "measurements_patient_kind_idx" ON "clinical"."measurements" USING btree ("tenant_id","patient_id","kind","measured_at");--> statement-breakpoint
CREATE INDEX "measurements_check_in_idx" ON "clinical"."measurements" USING btree ("tenant_id","check_in_id");--> statement-breakpoint
CREATE INDEX "side_effects_patient_idx" ON "clinical"."side_effects" USING btree ("tenant_id","patient_id","reported_at");--> statement-breakpoint
CREATE INDEX "side_effects_check_in_idx" ON "clinical"."side_effects" USING btree ("tenant_id","check_in_id");--> statement-breakpoint
-- Measurements, side effects and check-ins (docs/decisions/tracking.md).
-- Each table is the tenant's alone (ADR 0006), and its composite keys keep a
-- row on one tenant's patient. Clinical records are never changed or
-- deleted (ADR 0028), so the API may only read and add.
GRANT SELECT, INSERT ON clinical.check_ins, clinical.measurements, clinical.side_effects TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.check_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.check_ins
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.measurements ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.measurements
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.side_effects ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.side_effects
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
-- How a patient wants to hear from their care (docs/decisions/notifications.md).
-- The tenant's alone (ADR 0006). The patient changes their own choices, so
-- the API may read, add and change the two choices, and never delete a row.
GRANT SELECT, INSERT ON operational.notification_preferences TO medora_app;
--> statement-breakpoint
GRANT UPDATE (sms, reminders, updated_at) ON operational.notification_preferences TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.notification_preferences ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.notification_preferences
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
