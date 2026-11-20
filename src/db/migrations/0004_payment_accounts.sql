CREATE TABLE "operational"."payment_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"processor" text NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"status" text DEFAULT 'setting_up' NOT NULL,
	"processor_account_id" text,
	"charges_enabled" boolean DEFAULT false NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"activated_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payment_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "payment_accounts_processor_check" CHECK ("operational"."payment_accounts"."processor" in ('stripe', 'eway')),
	CONSTRAINT "payment_accounts_status_check" CHECK ("operational"."payment_accounts"."status" in ('setting_up', 'active', 'closed')),
	CONSTRAINT "payment_accounts_name_check" CHECK (length("operational"."payment_accounts"."name") between 1 and 80),
	CONSTRAINT "payment_accounts_lifecycle_check" CHECK (("operational"."payment_accounts"."status" = 'closed') = ("operational"."payment_accounts"."closed_at" is not null)
        and ("operational"."payment_accounts"."status" <> 'active' or "operational"."payment_accounts"."activated_at" is not null)
        and (not "operational"."payment_accounts"."is_default" or "operational"."payment_accounts"."status" = 'active'))
);
--> statement-breakpoint
ALTER TABLE "operational"."payment_accounts" ADD CONSTRAINT "payment_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_processor_account_key" ON "operational"."payment_accounts" USING btree ("processor","processor_account_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_accounts_default_key" ON "operational"."payment_accounts" USING btree ("tenant_id") WHERE "operational"."payment_accounts"."is_default";--> statement-breakpoint
ALTER TABLE "operational"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_payment_account_fk" FOREIGN KEY ("tenant_id","payment_account_id") REFERENCES "operational"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_accounts_payment_account_idx" ON "operational"."ledger_accounts" USING btree ("tenant_id","payment_account_id");
--> statement-breakpoint

-- Hand-written below: grants, row-level security and the database's own rules (ADRs 0006, 0028).
-- No DELETE: a payment account is closed, never removed, because invoices and the ledger point at it (BIL9).
GRANT SELECT, INSERT ON operational.payment_accounts TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, status, processor_account_id, charges_enabled, is_default, activated_at, closed_at, updated_at)
  ON operational.payment_accounts TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.payment_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.payment_accounts
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- The processor's account id is set once (BIL10): pointing a payment account
-- at a different processor account would send its patients' money elsewhere.
CREATE FUNCTION operational.keep_processor_account() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.processor_account_id IS NOT NULL AND NEW.processor_account_id IS DISTINCT FROM OLD.processor_account_id THEN
    RAISE EXCEPTION 'a payment account keeps its processor account' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
CREATE TRIGGER payment_accounts_keep_processor_account BEFORE UPDATE ON operational.payment_accounts
  FOR EACH ROW EXECUTE FUNCTION operational.keep_processor_account();
--> statement-breakpoint
REVOKE ALL ON FUNCTION operational.keep_processor_account() FROM PUBLIC;
