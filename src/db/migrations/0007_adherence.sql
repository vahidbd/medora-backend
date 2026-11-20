CREATE TABLE "clinical"."adherence_activity" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"opened_on" date,
	"source_table" text,
	"source_id" uuid,
	CONSTRAINT "adherence_activity_kind_check" CHECK ("clinical"."adherence_activity"."kind" in ('app_opened', 'measurement_recorded', 'side_effect_reported', 'check_in_submitted', 'message_sent', 'order_placed')),
	CONSTRAINT "adherence_activity_opened_on_check" CHECK (("clinical"."adherence_activity"."kind" = 'app_opened') = ("clinical"."adherence_activity"."opened_on" is not null)),
	CONSTRAINT "adherence_activity_source_check" CHECK (("clinical"."adherence_activity"."source_table" is null) = ("clinical"."adherence_activity"."source_id" is null))
);
--> statement-breakpoint
CREATE TABLE "clinical"."adherence_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"urgency" text NOT NULL,
	"side_effect_id" uuid,
	"reopened_from_id" uuid,
	"raised_at" timestamp with time zone DEFAULT now() NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"resolved_at" timestamp with time zone,
	"resolved_by" uuid,
	"outcome" text,
	"note" text,
	CONSTRAINT "adherence_flags_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "adherence_flags_kind_check" CHECK ("clinical"."adherence_flags"."kind" in ('side_effect_reported')),
	CONSTRAINT "adherence_flags_urgency_check" CHECK ("clinical"."adherence_flags"."urgency" in ('urgent', 'soon', 'routine')),
	CONSTRAINT "adherence_flags_status_check" CHECK ("clinical"."adherence_flags"."status" in ('open', 'resolved')),
	CONSTRAINT "adherence_flags_outcome_check" CHECK ("clinical"."adherence_flags"."outcome" in ('contacted_patient', 'booked_review', 'referred_to_prescriber', 'no_action_needed')),
	CONSTRAINT "adherence_flags_source_check" CHECK (("clinical"."adherence_flags"."kind" = 'side_effect_reported') = ("clinical"."adherence_flags"."side_effect_id" is not null)),
	CONSTRAINT "adherence_flags_resolution_check" CHECK (("clinical"."adherence_flags"."status" = 'resolved') = ("clinical"."adherence_flags"."resolved_at" is not null) and ("clinical"."adherence_flags"."resolved_at" is null) = ("clinical"."adherence_flags"."resolved_by" is null) and ("clinical"."adherence_flags"."resolved_at" is null) = ("clinical"."adherence_flags"."outcome" is null) and ("clinical"."adherence_flags"."status" = 'resolved' or "clinical"."adherence_flags"."note" is null)),
	CONSTRAINT "adherence_flags_note_check" CHECK ("clinical"."adherence_flags"."note" is null or length(trim("clinical"."adherence_flags"."note")) between 1 and 1000)
);
--> statement-breakpoint
ALTER TABLE "clinical"."adherence_activity" ADD CONSTRAINT "adherence_activity_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."adherence_flags" ADD CONSTRAINT "adherence_flags_resolved_by_users_id_fk" FOREIGN KEY ("resolved_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."adherence_flags" ADD CONSTRAINT "adherence_flags_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."adherence_flags" ADD CONSTRAINT "adherence_flags_side_effect_fk" FOREIGN KEY ("tenant_id","side_effect_id") REFERENCES "clinical"."side_effects"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "clinical"."adherence_flags" ADD CONSTRAINT "adherence_flags_reopened_from_fk" FOREIGN KEY ("tenant_id","reopened_from_id") REFERENCES "clinical"."adherence_flags"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "adherence_activity_patient_idx" ON "clinical"."adherence_activity" USING btree ("tenant_id","patient_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "adherence_activity_opened_on_key" ON "clinical"."adherence_activity" USING btree ("tenant_id","patient_id","opened_on") WHERE "clinical"."adherence_activity"."kind" = 'app_opened';--> statement-breakpoint
CREATE UNIQUE INDEX "adherence_flags_side_effect_key" ON "clinical"."adherence_flags" USING btree ("tenant_id","side_effect_id") WHERE "clinical"."adherence_flags"."reopened_from_id" is null;--> statement-breakpoint
CREATE UNIQUE INDEX "adherence_flags_reopened_from_key" ON "clinical"."adherence_flags" USING btree ("tenant_id","reopened_from_id");--> statement-breakpoint
CREATE INDEX "adherence_flags_side_effect_idx" ON "clinical"."adherence_flags" USING btree ("tenant_id","side_effect_id");--> statement-breakpoint
CREATE INDEX "adherence_flags_status_idx" ON "clinical"."adherence_flags" USING btree ("tenant_id","status","raised_at");--> statement-breakpoint
CREATE INDEX "adherence_flags_patient_idx" ON "clinical"."adherence_flags" USING btree ("tenant_id","patient_id","status");--> statement-breakpoint
CREATE INDEX "adherence_flags_resolved_by_idx" ON "clinical"."adherence_flags" USING btree ("resolved_by");--> statement-breakpoint

-- Adherence activity and adherence flags (docs/decisions/adherence.md, ADR
-- 0260). Each table is the tenant's alone (ADR 0006), and its composite keys
-- keep a row on one tenant's patient. Activity is the patient's record of
-- what they did and is never changed or removed (ADR 0028). A flag changes
-- once, from open to resolved, in its resolution columns only; a mistaken
-- resolution is undone by a new flag that reopens it, never by an edit.
GRANT SELECT, INSERT ON clinical.adherence_activity, clinical.adherence_flags TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, resolved_at, resolved_by, outcome, note) ON clinical.adherence_flags TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.adherence_activity ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.adherence_activity
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE clinical.adherence_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.adherence_flags
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE TRIGGER adherence_activity_keep BEFORE UPDATE OR DELETE ON clinical.adherence_activity
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER adherence_activity_no_truncate BEFORE TRUNCATE ON clinical.adherence_activity
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE FUNCTION clinical.adherence_flag_moves() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  earlier clinical.adherence_flags%ROWTYPE;
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW.status <> 'open' THEN
      RAISE EXCEPTION 'An adherence flag is raised open' USING ERRCODE = 'insufficient_privilege';
    END IF;
    IF NEW.reopened_from_id IS NOT NULL THEN
      SELECT * INTO earlier FROM clinical.adherence_flags WHERE tenant_id = NEW.tenant_id AND id = NEW.reopened_from_id;
      IF earlier.status IS DISTINCT FROM 'resolved' OR earlier.patient_id <> NEW.patient_id OR earlier.kind <> NEW.kind
        OR earlier.urgency <> NEW.urgency OR earlier.side_effect_id IS DISTINCT FROM NEW.side_effect_id THEN
        RAISE EXCEPTION 'Only a resolved adherence flag is reopened, as the same flag' USING ERRCODE = 'insufficient_privilege';
      END IF;
    END IF;
    RETURN NEW;
  END IF;
  IF OLD.status = 'open' AND NEW.status = 'resolved'
    AND NEW.id = OLD.id AND NEW.tenant_id = OLD.tenant_id AND NEW.patient_id = OLD.patient_id AND NEW.kind = OLD.kind
    AND NEW.urgency = OLD.urgency AND NEW.side_effect_id IS NOT DISTINCT FROM OLD.side_effect_id
    AND NEW.reopened_from_id IS NOT DISTINCT FROM OLD.reopened_from_id AND NEW.raised_at = OLD.raised_at THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'A % adherence flag can''t change that way', OLD.status USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION clinical.adherence_flag_moves() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER adherence_flags_moves BEFORE INSERT OR UPDATE ON clinical.adherence_flags
  FOR EACH ROW EXECUTE FUNCTION clinical.adherence_flag_moves();
--> statement-breakpoint
CREATE TRIGGER adherence_flags_keep BEFORE DELETE ON clinical.adherence_flags
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER adherence_flags_no_truncate BEFORE TRUNCATE ON clinical.adherence_flags
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
