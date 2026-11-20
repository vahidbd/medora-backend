DROP INDEX "clinical"."consults_clinician_idx";--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD COLUMN "purpose" text NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD COLUMN "scheduled_start" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD COLUMN "scheduled_end" timestamp with time zone NOT NULL;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD COLUMN "cancellation_reason" text;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD COLUMN "rescheduled_from" uuid;--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_rescheduled_from_fk" FOREIGN KEY ("tenant_id","rescheduled_from") REFERENCES "clinical"."consults"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "consults_rescheduled_from_key" ON "clinical"."consults" USING btree ("tenant_id","rescheduled_from");--> statement-breakpoint
CREATE INDEX "consults_schedule_idx" ON "clinical"."consults" USING btree ("tenant_id","scheduled_start");--> statement-breakpoint
CREATE INDEX "consults_clinician_idx" ON "clinical"."consults" USING btree ("tenant_id","clinician_user_id","scheduled_start");--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_purpose_check" CHECK ("clinical"."consults"."purpose" in ('initial', 'review', 'follow_up'));--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_cancellation_reason_check" CHECK ("clinical"."consults"."cancellation_reason" in ('patient_request', 'clinician_unavailable', 'rescheduled', 'booked_in_error', 'other'));--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_cancelled_check" CHECK (("clinical"."consults"."status" = 'cancelled') = ("clinical"."consults"."cancellation_reason" is not null));--> statement-breakpoint
ALTER TABLE "clinical"."consults" ADD CONSTRAINT "consults_slot_check" CHECK ("clinical"."consults"."scheduled_end" > "clinical"."consults"."scheduled_start");--> statement-breakpoint

-- Booking (docs/decisions/consults.md CNS12): the database has the last word
-- on double bookings. No two consults that aren't cancelled may overlap for one
-- clinician, or for one patient; a no-show keeps its slot, so reinstating it
-- can never collide. btree_gist lets one constraint compare ids and time ranges.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
ALTER TABLE clinical.consults ADD CONSTRAINT consults_clinician_overlap
  EXCLUDE USING gist (tenant_id WITH =, clinician_user_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
  WHERE (status <> 'cancelled');
--> statement-breakpoint
ALTER TABLE clinical.consults ADD CONSTRAINT consults_patient_overlap
  EXCLUDE USING gist (tenant_id WITH =, patient_id WITH =, tstzrange(scheduled_start, scheduled_end) WITH &&)
  WHERE (status <> 'cancelled');
--> statement-breakpoint
-- A booked slot never moves: a move cancels the consult and books a new one (CNS15).
GRANT UPDATE (cancellation_reason) ON clinical.consults TO medora_app;
