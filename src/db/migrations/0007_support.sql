CREATE TABLE "operational"."ticket_flags" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"flag" text NOT NULL,
	"set_by_type" text NOT NULL,
	"set_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cleared_at" timestamp with time zone,
	"cleared_by_user_id" uuid,
	CONSTRAINT "ticket_flags_flag_check" CHECK ("operational"."ticket_flags"."flag" in ('emergency', 'self_harm', 'clinical', 'possible_adverse_event', 'possible_complaint', 'legal', 'person_requested')),
	CONSTRAINT "ticket_flags_set_by_type_check" CHECK ("operational"."ticket_flags"."set_by_type" in ('person', 'patient', 'agent', 'system')),
	CONSTRAINT "ticket_flags_set_by_check" CHECK (("operational"."ticket_flags"."set_by_type" = 'system') = ("operational"."ticket_flags"."set_by_id" is null)),
	CONSTRAINT "ticket_flags_cleared_check" CHECK (("operational"."ticket_flags"."cleared_at" is null) = ("operational"."ticket_flags"."cleared_by_user_id" is null))
);
--> statement-breakpoint
CREATE TABLE "operational"."tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid,
	"patient_id" uuid,
	"patient_verified_at" timestamp with time zone,
	"patient_verified_method" text,
	"patient_verified_by_user_id" uuid,
	"channel" text NOT NULL,
	"topic" text DEFAULT 'other' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"queue" text DEFAULT 'support' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assignee_membership_id" uuid,
	"first_response_due_at" timestamp with time zone NOT NULL,
	"first_responded_at" timestamp with time zone,
	"overdue_notified_at" timestamp with time zone,
	"patient_visible" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"solved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tickets_status_check" CHECK ("operational"."tickets"."status" in ('open', 'waiting', 'solved')),
	CONSTRAINT "tickets_queue_check" CHECK ("operational"."tickets"."queue" in ('support', 'clinical')),
	CONSTRAINT "tickets_priority_check" CHECK ("operational"."tickets"."priority" in ('normal', 'urgent')),
	CONSTRAINT "tickets_channel_check" CHECK ("operational"."tickets"."channel" in ('email', 'sms', 'chat', 'voice')),
	CONSTRAINT "tickets_topic_check" CHECK ("operational"."tickets"."topic" in ('care_team', 'orders', 'billing', 'account', 'other')),
	CONSTRAINT "tickets_solved_check" CHECK (("operational"."tickets"."status" = 'solved') = ("operational"."tickets"."solved_at" is not null)),
	CONSTRAINT "tickets_patient_verified_method_check" CHECK ("operational"."tickets"."patient_verified_method" in ('date_of_birth', 'call_back', 'patient_app')),
	CONSTRAINT "tickets_verified_check" CHECK (("operational"."tickets"."patient_verified_at" is null) = ("operational"."tickets"."patient_verified_method" is null)
        and ("operational"."tickets"."patient_verified_at" is null or "operational"."tickets"."patient_id" is not null)
        and (("operational"."tickets"."patient_verified_by_user_id" is null) = ("operational"."tickets"."patient_verified_method" is null or "operational"."tickets"."patient_verified_method" = 'patient_app')))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "ticket_flags_open_key" ON "operational"."ticket_flags" USING btree ("tenant_id","ticket_id","flag") WHERE "operational"."ticket_flags"."cleared_at" is null;
--> statement-breakpoint
CREATE INDEX "ticket_flags_ticket_idx" ON "operational"."ticket_flags" USING btree ("tenant_id","ticket_id");
--> statement-breakpoint
CREATE INDEX "ticket_flags_cleared_by_idx" ON "operational"."ticket_flags" USING btree ("cleared_by_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_tenant_id_key" ON "operational"."tickets" USING btree ("tenant_id","id");
--> statement-breakpoint
CREATE INDEX "tickets_tenant_brand_idx" ON "operational"."tickets" USING btree ("tenant_id","brand_id");
--> statement-breakpoint
CREATE INDEX "tickets_tenant_patient_idx" ON "operational"."tickets" USING btree ("tenant_id","patient_id");
--> statement-breakpoint
CREATE INDEX "tickets_assignee_idx" ON "operational"."tickets" USING btree ("assignee_membership_id");
--> statement-breakpoint
CREATE INDEX "tickets_verified_by_idx" ON "operational"."tickets" USING btree ("patient_verified_by_user_id");
--> statement-breakpoint
CREATE INDEX "tickets_tenant_queue_status_idx" ON "operational"."tickets" USING btree ("tenant_id","queue","status","last_message_at");
--> statement-breakpoint
ALTER TABLE "operational"."ticket_flags" ADD CONSTRAINT "ticket_flags_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."ticket_flags" ADD CONSTRAINT "ticket_flags_cleared_by_user_id_users_id_fk" FOREIGN KEY ("cleared_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."ticket_flags" ADD CONSTRAINT "ticket_flags_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "operational"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."tickets" ADD CONSTRAINT "tickets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."tickets" ADD CONSTRAINT "tickets_patient_verified_by_user_id_users_id_fk" FOREIGN KEY ("patient_verified_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."tickets" ADD CONSTRAINT "tickets_assignee_membership_id_memberships_id_fk" FOREIGN KEY ("assignee_membership_id") REFERENCES "platform"."memberships"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."tickets" ADD CONSTRAINT "tickets_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."tickets" ADD CONSTRAINT "tickets_patient_fk" FOREIGN KEY ("tenant_id","patient_id") REFERENCES "clinical"."patients"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clinical"."messages" ADD CONSTRAINT "messages_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "operational"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- The helpdesk (docs/decisions/support.md). Every table is the tenant's
-- alone (ADR 0006), and the composite keys on (tenant_id, x_id) mean a row
-- can't point at another tenant's ticket, patient or brand. Tickets hold no
-- free text; their text is in the clinical zone (SUP13). Nothing here is
-- deleted: a ticket is solved, a flag cleared.
GRANT SELECT, INSERT ON operational.tickets TO medora_app;
--> statement-breakpoint
GRANT UPDATE (patient_id, patient_verified_at, patient_verified_method, patient_verified_by_user_id, status, queue, priority, assignee_membership_id,
  first_response_due_at, first_responded_at, overdue_notified_at, last_message_at, solved_at, updated_at) ON operational.tickets TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.tickets ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.tickets
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.ticket_flags TO medora_app;
--> statement-breakpoint
GRANT UPDATE (cleared_at, cleared_by_user_id) ON operational.ticket_flags TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.ticket_flags ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.ticket_flags
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
