CREATE TABLE "operational"."invoice_lines" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"order_id" uuid,
	"fee_kind" text NOT NULL,
	"product_id" uuid,
	"amount_cents" bigint NOT NULL,
	"pharmacy_share_cents" bigint,
	"gst_treatment" text NOT NULL,
	"gst_cents" bigint NOT NULL,
	CONSTRAINT "invoice_lines_fee_kind_check" CHECK ("operational"."invoice_lines"."fee_kind" in ('consult', 'program', 'medicine', 'shipping')),
	CONSTRAINT "invoice_lines_gst_treatment_check" CHECK ("operational"."invoice_lines"."gst_treatment" in ('taxable', 'gst_free')),
	CONSTRAINT "invoice_lines_shape_check" CHECK (("operational"."invoice_lines"."fee_kind" = 'medicine') = ("operational"."invoice_lines"."order_id" is not null)
        and ("operational"."invoice_lines"."fee_kind" = 'medicine') = ("operational"."invoice_lines"."product_id" is not null)
        and ("operational"."invoice_lines"."fee_kind" = 'medicine') = ("operational"."invoice_lines"."pharmacy_share_cents" is not null)
        and "operational"."invoice_lines"."amount_cents" > 0
        and ("operational"."invoice_lines"."pharmacy_share_cents" is null or "operational"."invoice_lines"."pharmacy_share_cents" between 0 and "operational"."invoice_lines"."amount_cents")
        and "operational"."invoice_lines"."gst_cents" between 0 and "operational"."invoice_lines"."amount_cents"
        and ("operational"."invoice_lines"."gst_treatment" = 'taxable' or "operational"."invoice_lines"."gst_cents" = 0))
);
--> statement-breakpoint
CREATE TABLE "operational"."invoice_numbers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"prefix" text DEFAULT 'INV' NOT NULL,
	"last_number" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "invoice_numbers_company_key" UNIQUE("tenant_id","company_id"),
	CONSTRAINT "invoice_numbers_prefix_check" CHECK ("operational"."invoice_numbers"."prefix" ~ '^[A-Z0-9]{1,10}$'),
	CONSTRAINT "invoice_numbers_last_number_check" CHECK ("operational"."invoice_numbers"."last_number" >= 0)
);
--> statement-breakpoint
CREATE TABLE "operational"."invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"number" text NOT NULL,
	"patient_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"period_starts_on" date,
	"period_ends_on" date,
	"order_id" uuid,
	"partner_pharmacy_id" uuid,
	"status" text DEFAULT 'open' NOT NULL,
	"total_cents" bigint NOT NULL,
	"gst_cents" bigint NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "invoices_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "invoices_order_key" UNIQUE("tenant_id","id","order_id"),
	CONSTRAINT "invoices_number_key" UNIQUE("tenant_id","company_id","number"),
	CONSTRAINT "invoices_kind_check" CHECK ("operational"."invoices"."kind" in ('consult', 'period')),
	CONSTRAINT "invoices_status_check" CHECK ("operational"."invoices"."status" in ('open')),
	CONSTRAINT "invoices_number_check" CHECK ("operational"."invoices"."number" ~ '^[A-Z0-9]{1,10}-[0-9]{6,}$'),
	CONSTRAINT "invoices_shape_check" CHECK (("operational"."invoices"."kind" = 'period') = ("operational"."invoices"."period_starts_on" is not null and "operational"."invoices"."period_ends_on" is not null)
        and ("operational"."invoices"."period_ends_on" > "operational"."invoices"."period_starts_on") is not false
        and ("operational"."invoices"."order_id" is null) = ("operational"."invoices"."partner_pharmacy_id" is null)
        and ("operational"."invoices"."kind" = 'period' or "operational"."invoices"."order_id" is null)
        and "operational"."invoices"."total_cents" > 0 and "operational"."invoices"."gst_cents" between 0 and "operational"."invoices"."total_cents")
);
--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD COLUMN "renewal_held_reason" text;--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD COLUMN "renewal_checked_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational"."invoice_lines" ADD CONSTRAINT "invoice_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoice_lines" ADD CONSTRAINT "invoice_lines_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id") REFERENCES "operational"."invoices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoice_lines" ADD CONSTRAINT "invoice_lines_order_fk" FOREIGN KEY ("tenant_id","invoice_id","order_id") REFERENCES "operational"."invoices"("tenant_id","id","order_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoice_numbers" ADD CONSTRAINT "invoice_numbers_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_subscription_fk" FOREIGN KEY ("tenant_id","subscription_id") REFERENCES "operational"."subscriptions"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_price_fk" FOREIGN KEY ("tenant_id","price_id") REFERENCES "operational"."prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_payment_account_fk" FOREIGN KEY ("tenant_id","payment_account_id") REFERENCES "operational"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "invoice_lines_invoice_idx" ON "operational"."invoice_lines" USING btree ("tenant_id","invoice_id","order_id");--> statement-breakpoint
CREATE INDEX "invoices_subscription_idx" ON "operational"."invoices" USING btree ("tenant_id","subscription_id");--> statement-breakpoint
CREATE INDEX "invoices_price_idx" ON "operational"."invoices" USING btree ("tenant_id","price_id");--> statement-breakpoint
CREATE INDEX "invoices_payment_account_idx" ON "operational"."invoices" USING btree ("tenant_id","payment_account_id");--> statement-breakpoint
CREATE INDEX "invoices_patient_idx" ON "operational"."invoices" USING btree ("tenant_id","patient_id","issued_at");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_period_key" ON "operational"."invoices" USING btree ("tenant_id","subscription_id","period_starts_on") WHERE "operational"."invoices"."kind" = 'period';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_consult_key" ON "operational"."invoices" USING btree ("tenant_id","subscription_id") WHERE "operational"."invoices"."kind" = 'consult';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_order_key" ON "operational"."invoices" USING btree ("tenant_id","order_id") WHERE "operational"."invoices"."order_id" is not null;--> statement-breakpoint
CREATE INDEX "subscriptions_due_idx" ON "operational"."subscriptions" USING btree ("tenant_id","next_period_starts_on");--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_renewal_held_reason_check" CHECK ("operational"."subscriptions"."renewal_held_reason" is null or "operational"."subscriptions"."renewal_held_reason" in ('awaiting_clinician', 'no_order', 'no_current_script', 'awaiting_pharmacist', 'cannot_dispense', 'no_medicine_fee', 'other'));--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_renewal_held_check" CHECK (("operational"."subscriptions"."renewal_held_reason" is null or ("operational"."subscriptions"."renewal_checked_at" is not null and "operational"."subscriptions"."status" <> 'cancelled')));--> statement-breakpoint

-- Hand-written below: grants and row-level security (ADR 0006). An issued
-- invoice and its lines are never changed or deleted: a correction is a new
-- ledger entry and, later, an adjustment note.
GRANT SELECT, INSERT ON operational.invoices TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.invoice_lines TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.invoice_numbers TO medora_app;
--> statement-breakpoint
GRANT UPDATE (last_number) ON operational.invoice_numbers TO medora_app;
--> statement-breakpoint
GRANT UPDATE (renewal_held_reason, renewal_checked_at) ON operational.subscriptions TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.invoices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.invoices
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.invoice_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.invoice_lines
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.invoice_numbers ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.invoice_numbers
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
