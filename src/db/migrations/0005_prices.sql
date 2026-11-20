CREATE TABLE "operational"."price_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"price_id" uuid NOT NULL,
	"billing_model" text NOT NULL,
	"fee_kind" text NOT NULL,
	"product_id" uuid,
	"amount_cents" bigint NOT NULL,
	"pharmacy_share_cents" bigint,
	"gst_treatment" text NOT NULL,
	CONSTRAINT "price_fees_billing_model_check" CHECK ("operational"."price_fees"."billing_model" in ('bundled', 'pharmacy_billed')),
	CONSTRAINT "price_fees_fee_kind_check" CHECK ("operational"."price_fees"."fee_kind" in ('consult', 'program', 'medicine', 'shipping')),
	CONSTRAINT "price_fees_gst_treatment_check" CHECK ("operational"."price_fees"."gst_treatment" in ('taxable', 'gst_free')),
	CONSTRAINT "price_fees_amount_check" CHECK ("operational"."price_fees"."amount_cents" > 0),
	CONSTRAINT "price_fees_medicine_check" CHECK (("operational"."price_fees"."fee_kind" = 'medicine') = ("operational"."price_fees"."product_id" is not null)
        and ("operational"."price_fees"."fee_kind" = 'medicine') = ("operational"."price_fees"."pharmacy_share_cents" is not null)
        and ("operational"."price_fees"."fee_kind" <> 'medicine' or "operational"."price_fees"."billing_model" = 'bundled')
        and ("operational"."price_fees"."pharmacy_share_cents" is null or "operational"."price_fees"."pharmacy_share_cents" between 0 and "operational"."price_fees"."amount_cents"))
);
--> statement-breakpoint
CREATE TABLE "operational"."prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"program_id" uuid NOT NULL,
	"name" text NOT NULL,
	"billing_model" text NOT NULL,
	"interval_unit" text NOT NULL,
	"interval_count" integer NOT NULL,
	"payment_account_id" uuid,
	"status" text DEFAULT 'draft' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"replaces_price_id" uuid,
	"published_at" timestamp with time zone,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "prices_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "prices_billing_model_key" UNIQUE("tenant_id","id","billing_model"),
	CONSTRAINT "prices_billing_model_check" CHECK ("operational"."prices"."billing_model" in ('bundled', 'pharmacy_billed')),
	CONSTRAINT "prices_status_check" CHECK ("operational"."prices"."status" in ('draft', 'live', 'retired')),
	CONSTRAINT "prices_interval_unit_check" CHECK ("operational"."prices"."interval_unit" in ('week', 'month')),
	CONSTRAINT "prices_interval_check" CHECK ("operational"."prices"."interval_count" between 1 and (case "operational"."prices"."interval_unit" when 'week' then 52 else 12 end)),
	CONSTRAINT "prices_name_check" CHECK (length("operational"."prices"."name") between 1 and 80),
	CONSTRAINT "prices_lifecycle_check" CHECK (("operational"."prices"."status" = 'draft') = ("operational"."prices"."published_at" is null)
        and ("operational"."prices"."status" = 'retired') = ("operational"."prices"."retired_at" is not null)
        and ("operational"."prices"."replaces_price_id" is null) = ("operational"."prices"."version" = 1))
);
--> statement-breakpoint
ALTER TABLE "operational"."price_fees" ADD CONSTRAINT "price_fees_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."price_fees" ADD CONSTRAINT "price_fees_price_fk" FOREIGN KEY ("tenant_id","price_id","billing_model") REFERENCES "operational"."prices"("tenant_id","id","billing_model") ON DELETE no action ON UPDATE cascade;--> statement-breakpoint
ALTER TABLE "operational"."prices" ADD CONSTRAINT "prices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."prices" ADD CONSTRAINT "prices_payment_account_fk" FOREIGN KEY ("tenant_id","payment_account_id") REFERENCES "operational"."payment_accounts"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."prices" ADD CONSTRAINT "prices_replaces_fk" FOREIGN KEY ("tenant_id","replaces_price_id") REFERENCES "operational"."prices"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "price_fees_price_idx" ON "operational"."price_fees" USING btree ("tenant_id","price_id","billing_model");--> statement-breakpoint
CREATE UNIQUE INDEX "price_fees_kind_key" ON "operational"."price_fees" USING btree ("tenant_id","price_id","fee_kind") WHERE "operational"."price_fees"."fee_kind" <> 'medicine';--> statement-breakpoint
CREATE UNIQUE INDEX "price_fees_product_key" ON "operational"."price_fees" USING btree ("tenant_id","price_id","product_id") WHERE "operational"."price_fees"."product_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "prices_replaces_key" ON "operational"."prices" USING btree ("tenant_id","replaces_price_id");--> statement-breakpoint
CREATE INDEX "prices_program_idx" ON "operational"."prices" USING btree ("tenant_id","program_id");--> statement-breakpoint
CREATE INDEX "prices_payment_account_idx" ON "operational"."prices" USING btree ("tenant_id","payment_account_id");
--> statement-breakpoint

-- Hand-written below: grants, row-level security and the database's own rules (ADRs 0006, 0028).
-- Prices are never deleted; a draft's fees are replaced by deleting and inserting them (BIL14).
GRANT SELECT, INSERT ON operational.prices TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, billing_model, interval_unit, interval_count, payment_account_id, status, published_at, retired_at, updated_at)
  ON operational.prices TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON operational.price_fees TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.prices ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.prices
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.price_fees ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.price_fees
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- A published price never changes, apart from being retired (BIL14): a
-- subscription must always be able to say exactly what the patient agreed to.
CREATE FUNCTION operational.keep_published_price() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF OLD.status = 'draft' THEN
    RETURN NEW;
  END IF;
  IF (to_jsonb(NEW) - 'status' - 'retired_at' - 'updated_at') = (to_jsonb(OLD) - 'status' - 'retired_at' - 'updated_at')
     AND (NEW.status = OLD.status OR (OLD.status = 'live' AND NEW.status = 'retired')) THEN
    RETURN NEW;
  END IF;
  RAISE EXCEPTION 'a published price never changes' USING ERRCODE = 'check_violation';
END
$$;
--> statement-breakpoint
CREATE TRIGGER prices_keep_published BEFORE UPDATE ON operational.prices
  FOR EACH ROW EXECUTE FUNCTION operational.keep_published_price();
--> statement-breakpoint

-- Fees change only while their price is a draft. The price row is share-locked,
-- so a fee can't slip in while the price is being published.
CREATE FUNCTION operational.keep_published_price_fees() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  fee operational.price_fees := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  price_status text;
BEGIN
  SELECT status INTO price_status FROM operational.prices
   WHERE tenant_id = fee.tenant_id AND id = fee.price_id
   FOR SHARE;
  IF price_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'a published price never changes' USING ERRCODE = 'check_violation';
  END IF;
  RETURN fee;
END
$$;
--> statement-breakpoint
CREATE TRIGGER price_fees_keep_published BEFORE INSERT OR UPDATE OR DELETE ON operational.price_fees
  FOR EACH ROW EXECUTE FUNCTION operational.keep_published_price_fees();
--> statement-breakpoint
REVOKE ALL ON FUNCTION operational.keep_published_price(), operational.keep_published_price_fees() FROM PUBLIC;
