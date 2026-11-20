CREATE TABLE "operational"."payment_methods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"patient_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"processor_customer_id" text NOT NULL,
	"processor_method_id" text NOT NULL,
	"brand" text NOT NULL,
	"last4" text NOT NULL,
	"exp_month" integer NOT NULL,
	"exp_year" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"consented_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_methods_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_methods_account_key" UNIQUE("tenant_id","id","payment_account_id"),
	CONSTRAINT "payment_methods_processor_key" UNIQUE("tenant_id","payment_account_id","processor_method_id"),
	CONSTRAINT "payment_methods_card_check" CHECK ("operational"."payment_methods"."last4" ~ '^[0-9]{4}$' and length("operational"."payment_methods"."brand") between 1 and 20
        and "operational"."payment_methods"."exp_month" between 1 and 12 and "operational"."payment_methods"."exp_year" between 2000 and 2100
        and length("operational"."payment_methods"."processor_customer_id") between 1 and 255 and length("operational"."payment_methods"."processor_method_id") between 1 and 255)
);
--> statement-breakpoint
CREATE TABLE "operational"."payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"payment_account_id" uuid NOT NULL,
	"payment_method_id" uuid NOT NULL,
	"attempt" integer NOT NULL,
	"amount_cents" bigint NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"processor_payment_id" text,
	"failure_code" text,
	"processor_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"settled_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "payments_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payments_attempt_key" UNIQUE("tenant_id","invoice_id","attempt"),
	CONSTRAINT "payments_status_check" CHECK ("operational"."payments"."status" in ('pending', 'succeeded', 'failed', 'refunding', 'refunded')),
	CONSTRAINT "payments_shape_check" CHECK ("operational"."payments"."attempt" >= 1 and "operational"."payments"."amount_cents" > 0
        and ("operational"."payments"."status" = 'pending') = ("operational"."payments"."settled_at" is null)
        and ("operational"."payments"."status" = 'failed') = ("operational"."payments"."failure_code" is not null)
        and ("operational"."payments"."status" not in ('succeeded', 'refunding', 'refunded') or "operational"."payments"."processor_payment_id" is not null)
        and ("operational"."payments"."status" = 'refunded') = ("operational"."payments"."refunded_at" is not null)
        and ("operational"."payments"."status" = 'refunded') = ("operational"."payments"."processor_refund_id" is not null))
);
--> statement-breakpoint
ALTER TABLE "operational"."invoices" DROP CONSTRAINT "invoices_status_check";--> statement-breakpoint
DROP INDEX "operational"."invoices_period_key";--> statement-breakpoint
DROP INDEX "operational"."invoices_one_per_order_key";--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD COLUMN "paid_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD COLUMN "voided_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_payment_key" UNIQUE("tenant_id","id","payment_account_id","total_cents");--> statement-breakpoint
ALTER TABLE "operational"."payment_methods" ADD CONSTRAINT "payment_methods_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."payment_methods" ADD CONSTRAINT "payment_methods_payment_account_fk" FOREIGN KEY ("tenant_id","payment_account_id") REFERENCES "operational"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."payments" ADD CONSTRAINT "payments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."payments" ADD CONSTRAINT "payments_invoice_fk" FOREIGN KEY ("tenant_id","invoice_id","payment_account_id","amount_cents") REFERENCES "operational"."invoices"("tenant_id","id","payment_account_id","total_cents") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."payments" ADD CONSTRAINT "payments_payment_method_fk" FOREIGN KEY ("tenant_id","payment_method_id","payment_account_id") REFERENCES "operational"."payment_methods"("tenant_id","id","payment_account_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_methods_default_key" ON "operational"."payment_methods" USING btree ("tenant_id","patient_id","payment_account_id") WHERE "operational"."payment_methods"."is_default";--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "operational"."payments" USING btree ("tenant_id","invoice_id","payment_account_id","amount_cents");--> statement-breakpoint
CREATE INDEX "payments_payment_method_idx" ON "operational"."payments" USING btree ("tenant_id","payment_method_id","payment_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_in_flight_key" ON "operational"."payments" USING btree ("tenant_id","invoice_id") WHERE "operational"."payments"."status" = 'pending';--> statement-breakpoint
CREATE UNIQUE INDEX "payments_taken_key" ON "operational"."payments" USING btree ("tenant_id","invoice_id") WHERE "operational"."payments"."status" in ('succeeded', 'refunding', 'refunded');--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_period_key" ON "operational"."invoices" USING btree ("tenant_id","subscription_id","period_starts_on") WHERE "operational"."invoices"."kind" = 'period' and "operational"."invoices"."status" <> 'void';--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_one_per_order_key" ON "operational"."invoices" USING btree ("tenant_id","order_id") WHERE "operational"."invoices"."order_id" is not null and "operational"."invoices"."status" <> 'void';--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_settled_check" CHECK (("operational"."invoices"."status" = 'paid') = ("operational"."invoices"."paid_at" is not null) and ("operational"."invoices"."status" = 'void') = ("operational"."invoices"."voided_at" is not null));--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_status_check" CHECK ("operational"."invoices"."status" in ('open', 'paid', 'past_due', 'void'));--> statement-breakpoint

-- Hand-written below: grants and row-level security (ADR 0006). A payment
-- method keeps its tokens; only which card is the default moves. A payment
-- is written before the processor is asked and then only its outcome moves.
-- An invoice changes only its status. Nothing here is deleted.
GRANT SELECT, INSERT ON operational.payment_methods TO medora_app;
--> statement-breakpoint
GRANT UPDATE (is_default) ON operational.payment_methods TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.payments TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, processor_payment_id, failure_code, settled_at, processor_refund_id, refunded_at) ON operational.payments TO medora_app;
--> statement-breakpoint
GRANT UPDATE (status, paid_at, voided_at) ON operational.invoices TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.payment_methods ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.payment_methods
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.payments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.payments
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
