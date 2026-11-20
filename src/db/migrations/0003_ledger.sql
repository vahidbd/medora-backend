CREATE TABLE "operational"."ledger_accounts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"currency" text DEFAULT 'AUD' NOT NULL,
	"patient_id" uuid,
	"payment_account_id" uuid,
	"partner_pharmacy_id" uuid,
	"balance_cents" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_accounts_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ledger_accounts_owner_key" UNIQUE NULLS NOT DISTINCT("tenant_id","kind","currency","patient_id","payment_account_id","partner_pharmacy_id"),
	CONSTRAINT "ledger_accounts_kind_check" CHECK ("operational"."ledger_accounts"."kind" in ('patient_receivable', 'patient_credit', 'processor_clearing', 'pharmacy_payable', 'revenue_consult', 'revenue_program', 'revenue_medicine', 'revenue_shipping', 'gst_collected')),
	CONSTRAINT "ledger_accounts_currency_check" CHECK ("operational"."ledger_accounts"."currency" in ('AUD')),
	CONSTRAINT "ledger_accounts_owner_check" CHECK (("operational"."ledger_accounts"."kind" in ('patient_receivable', 'patient_credit')) = ("operational"."ledger_accounts"."patient_id" is not null)
        and ("operational"."ledger_accounts"."kind" = 'processor_clearing') = ("operational"."ledger_accounts"."payment_account_id" is not null)
        and ("operational"."ledger_accounts"."kind" = 'pharmacy_payable') = ("operational"."ledger_accounts"."partner_pharmacy_id" is not null))
);
--> statement-breakpoint
CREATE TABLE "operational"."ledger_entries" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"idempotency_key" text NOT NULL,
	"reverses_entry_id" uuid,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"posted_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ledger_entries_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "ledger_entries_idempotency_key" UNIQUE("tenant_id","idempotency_key"),
	CONSTRAINT "ledger_entries_kind_check" CHECK ("operational"."ledger_entries"."kind" in ('invoice_issued', 'payment_received', 'refund_paid', 'credit_granted', 'credit_applied', 'chargeback', 'reversal')),
	CONSTRAINT "ledger_entries_reversal_check" CHECK (("operational"."ledger_entries"."kind" = 'reversal') = ("operational"."ledger_entries"."reverses_entry_id" is not null)),
	CONSTRAINT "ledger_entries_key_check" CHECK (length("operational"."ledger_entries"."idempotency_key") between 1 and 200)
);
--> statement-breakpoint
CREATE TABLE "operational"."ledger_lines" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "operational"."ledger_lines_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"entry_id" uuid NOT NULL,
	"account_id" uuid NOT NULL,
	"amount_cents" bigint NOT NULL,
	"fee_kind" text,
	CONSTRAINT "ledger_lines_amount_check" CHECK ("operational"."ledger_lines"."amount_cents" <> 0),
	CONSTRAINT "ledger_lines_fee_kind_check" CHECK ("operational"."ledger_lines"."fee_kind" is null or "operational"."ledger_lines"."fee_kind" in ('consult', 'program', 'medicine', 'shipping'))
);
--> statement-breakpoint
ALTER TABLE "operational"."ledger_accounts" ADD CONSTRAINT "ledger_accounts_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."ledger_entries" ADD CONSTRAINT "ledger_entries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."ledger_entries" ADD CONSTRAINT "ledger_entries_reverses_fk" FOREIGN KEY ("tenant_id","reverses_entry_id") REFERENCES "operational"."ledger_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."ledger_lines" ADD CONSTRAINT "ledger_lines_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."ledger_lines" ADD CONSTRAINT "ledger_lines_entry_fk" FOREIGN KEY ("tenant_id","entry_id") REFERENCES "operational"."ledger_entries"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."ledger_lines" ADD CONSTRAINT "ledger_lines_account_fk" FOREIGN KEY ("tenant_id","account_id") REFERENCES "operational"."ledger_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "ledger_entries_reverses_key" ON "operational"."ledger_entries" USING btree ("tenant_id","reverses_entry_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_entry_idx" ON "operational"."ledger_lines" USING btree ("tenant_id","entry_id");--> statement-breakpoint
CREATE INDEX "ledger_lines_account_idx" ON "operational"."ledger_lines" USING btree ("tenant_id","account_id","id");--> statement-breakpoint

-- The ledger's rules, in the database (ADRs 0016 and 0028, docs/decisions/billing.md).

-- The API posts and reads; it changes only an account's cached balance.
GRANT SELECT, INSERT ON operational.ledger_accounts TO medora_app;
--> statement-breakpoint
GRANT UPDATE (balance_cents) ON operational.ledger_accounts TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.ledger_entries, operational.ledger_lines TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.ledger_accounts ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.ledger_accounts
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.ledger_entries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.ledger_entries
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.ledger_lines ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.ledger_lines
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- Entries and lines are written once, for every role, the owner included.
CREATE FUNCTION operational.refuse_ledger_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'the ledger is append-only: % on % refused', TG_OP, TG_TABLE_NAME
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER ledger_entries_append_only BEFORE UPDATE OR DELETE ON operational.ledger_entries
  FOR EACH ROW EXECUTE FUNCTION operational.refuse_ledger_change();
--> statement-breakpoint
CREATE TRIGGER ledger_entries_no_truncate BEFORE TRUNCATE ON operational.ledger_entries
  FOR EACH STATEMENT EXECUTE FUNCTION operational.refuse_ledger_change();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_append_only BEFORE UPDATE OR DELETE ON operational.ledger_lines
  FOR EACH ROW EXECUTE FUNCTION operational.refuse_ledger_change();
--> statement-breakpoint
CREATE TRIGGER ledger_lines_no_truncate BEFORE TRUNCATE ON operational.ledger_lines
  FOR EACH STATEMENT EXECUTE FUNCTION operational.refuse_ledger_change();
--> statement-breakpoint

-- Every entry has at least two lines and its lines sum to zero, checked when
-- the transaction commits, so lines can be written one by one (BIL1).
CREATE FUNCTION operational.check_ledger_entry_balanced() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  -- The entry's id is in the column the trigger names: id on entries, entry_id on lines.
  entry uuid := (to_jsonb(NEW) ->> TG_ARGV[0])::uuid;
  total numeric;
  line_count integer;
BEGIN
  SELECT coalesce(sum(amount_cents), 0), count(*) INTO total, line_count
    FROM operational.ledger_lines WHERE tenant_id = NEW.tenant_id AND entry_id = entry;
  IF line_count < 2 OR total <> 0 THEN
    RAISE EXCEPTION 'ledger entry % does not balance', entry USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_entries_balanced AFTER INSERT ON operational.ledger_entries
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operational.check_ledger_entry_balanced('id');
--> statement-breakpoint
CREATE CONSTRAINT TRIGGER ledger_lines_balanced AFTER INSERT ON operational.ledger_lines
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION operational.check_ledger_entry_balanced('entry_id');
--> statement-breakpoint
REVOKE ALL ON FUNCTION operational.refuse_ledger_change(), operational.check_ledger_entry_balanced() FROM PUBLIC;
