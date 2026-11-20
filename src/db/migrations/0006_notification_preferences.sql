CREATE TABLE "operational"."notification_preferences" (
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"sms" boolean DEFAULT true NOT NULL,
	"reminders" boolean DEFAULT true NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_preferences_pkey" PRIMARY KEY("tenant_id","patient_id")
);
--> statement-breakpoint
ALTER TABLE "operational"."notification_preferences" ADD CONSTRAINT "notification_preferences_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint

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
