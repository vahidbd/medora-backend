CREATE TABLE "operational"."subscriptions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"time_zone" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"anchor_day" smallint,
	"current_period_starts_on" date,
	"current_period_ends_on" date,
	"next_period_starts_on" date,
	"cancels_at_period_end" boolean DEFAULT false NOT NULL,
	"cancel_reason" text,
	"ended_on" date,
	"activated_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "subscriptions_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "subscriptions_status_check" CHECK ("operational"."subscriptions"."status" in ('pending', 'active', 'paused', 'cancelled')),
	CONSTRAINT "subscriptions_cancel_reason_check" CHECK ("operational"."subscriptions"."cancel_reason" is null or "operational"."subscriptions"."cancel_reason" in ('patient_request', 'clinician_declined', 'staff_decision', 'other')),
	CONSTRAINT "subscriptions_anchor_day_check" CHECK ("operational"."subscriptions"."anchor_day" between 1 and 31),
	CONSTRAINT "subscriptions_lifecycle_check" CHECK (("operational"."subscriptions"."status" = 'pending') = ("operational"."subscriptions"."activated_at" is null and "operational"."subscriptions"."status" <> 'cancelled')
        and ("operational"."subscriptions"."status" not in ('active', 'paused')
          or ("operational"."subscriptions"."current_period_starts_on" is not null and "operational"."subscriptions"."current_period_ends_on" is not null and "operational"."subscriptions"."next_period_starts_on" is not null))
        and ("operational"."subscriptions"."status" = 'cancelled') = ("operational"."subscriptions"."cancelled_at" is not null)
        and ("operational"."subscriptions"."status" = 'cancelled' or "operational"."subscriptions"."cancels_at_period_end") = ("operational"."subscriptions"."cancel_reason" is not null)
        and (not "operational"."subscriptions"."cancels_at_period_end" or "operational"."subscriptions"."status" in ('active', 'paused'))
        and ("operational"."subscriptions"."status" = 'cancelled') = ("operational"."subscriptions"."ended_on" is not null)
        and ("operational"."subscriptions"."current_period_ends_on" > "operational"."subscriptions"."current_period_starts_on") is not false
        and ("operational"."subscriptions"."next_period_starts_on" >= "operational"."subscriptions"."current_period_ends_on") is not false
        and ("operational"."subscriptions"."next_period_starts_on" <= "operational"."subscriptions"."current_period_ends_on" + interval '3 months') is not false)
);
--> statement-breakpoint
ALTER TABLE "operational"."prices" ADD CONSTRAINT "prices_program_key" UNIQUE("tenant_id","id","program_id");--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_price_fk" FOREIGN KEY ("tenant_id","price_id","program_id") REFERENCES "operational"."prices"("tenant_id","id","program_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_payment_account_fk" FOREIGN KEY ("tenant_id","payment_account_id") REFERENCES "operational"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "subscriptions_live_key" ON "operational"."subscriptions" USING btree ("tenant_id","patient_id","program_id") WHERE "operational"."subscriptions"."status" <> 'cancelled';--> statement-breakpoint
CREATE INDEX "subscriptions_patient_idx" ON "operational"."subscriptions" USING btree ("tenant_id","patient_id");--> statement-breakpoint
CREATE INDEX "subscriptions_price_idx" ON "operational"."subscriptions" USING btree ("tenant_id","price_id","program_id");--> statement-breakpoint
CREATE INDEX "subscriptions_payment_account_idx" ON "operational"."subscriptions" USING btree ("tenant_id","payment_account_id");--> statement-breakpoint

-- Hand-written below: grants and row-level security (ADR 0006). Subscriptions
-- end by being cancelled and are never deleted: invoices point at them.
GRANT SELECT, INSERT ON operational.subscriptions TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, anchor_day, current_period_starts_on, current_period_ends_on, next_period_starts_on,
  cancels_at_period_end, cancel_reason, ended_on, activated_at, cancelled_at, updated_at)
  ON operational.subscriptions TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.subscriptions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.subscriptions
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
