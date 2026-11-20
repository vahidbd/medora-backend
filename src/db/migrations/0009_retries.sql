ALTER TABLE "operational"."subscriptions" DROP CONSTRAINT "subscriptions_cancel_reason_check";--> statement-breakpoint
ALTER TABLE "operational"."payments" DROP CONSTRAINT "payments_shape_check";--> statement-breakpoint
ALTER TABLE "operational"."payment_methods" ADD COLUMN "declined_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD COLUMN "past_due_on" date;--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD COLUMN "retry_due_on" date;--> statement-breakpoint
ALTER TABLE "operational"."payments" ADD COLUMN "retry" integer;--> statement-breakpoint
CREATE INDEX "invoices_retry_due_idx" ON "operational"."invoices" USING btree ("tenant_id","retry_due_on") WHERE "operational"."invoices"."retry_due_on" is not null;--> statement-breakpoint
ALTER TABLE "operational"."subscriptions" ADD CONSTRAINT "subscriptions_cancel_reason_check" CHECK ("operational"."subscriptions"."cancel_reason" is null or "operational"."subscriptions"."cancel_reason" in ('patient_request', 'clinician_declined', 'staff_decision', 'payment_failed', 'other'));--> statement-breakpoint
ALTER TABLE "operational"."invoices" ADD CONSTRAINT "invoices_retry_check" CHECK (("operational"."invoices"."status" <> 'past_due' or "operational"."invoices"."past_due_on" is not null)
        and ("operational"."invoices"."retry_due_on" is null or ("operational"."invoices"."status" = 'past_due' and "operational"."invoices"."retry_due_on" > "operational"."invoices"."past_due_on")));--> statement-breakpoint
ALTER TABLE "operational"."payments" ADD CONSTRAINT "payments_shape_check" CHECK ("operational"."payments"."attempt" >= 1 and "operational"."payments"."amount_cents" > 0 and "operational"."payments"."retry" between 1 and 4 is not false
        and ("operational"."payments"."status" = 'pending') = ("operational"."payments"."settled_at" is null)
        and ("operational"."payments"."status" = 'failed') = ("operational"."payments"."failure_code" is not null)
        and ("operational"."payments"."status" not in ('succeeded', 'refunding', 'refunded') or "operational"."payments"."processor_payment_id" is not null)
        and ("operational"."payments"."status" = 'refunded') = ("operational"."payments"."refunded_at" is not null)
        and ("operational"."payments"."status" = 'refunded') = ("operational"."payments"."processor_refund_id" is not null));--> statement-breakpoint
-- Hand-written below: grants (ADR 0006). A hard decline marks the card, and
-- saving it again clears the mark. A past-due invoice keeps the day it went
-- past due and moves its next retry day.
GRANT UPDATE (declined_at) ON operational.payment_methods TO medora_app;
--> statement-breakpoint
GRANT UPDATE (past_due_on, retry_due_on) ON operational.invoices TO medora_app;
