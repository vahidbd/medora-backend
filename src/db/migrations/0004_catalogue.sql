-- The catalogue and blocked items (docs/decisions/catalogue.md CAT1 to CAT6):
-- tenant products in operational, Medora's block rules in platform.

CREATE TABLE "platform"."block_rules" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"match" text NOT NULL,
	"value" text,
	"reason" text NOT NULL,
	"source_url" text,
	"effective_from" timestamp with time zone DEFAULT now() NOT NULL,
	"added_by" uuid NOT NULL,
	"added_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	CONSTRAINT "block_rules_match_check" CHECK ("platform"."block_rules"."match" in ('schedule', 'artg_number', 'compounded')),
	CONSTRAINT "block_rules_value_check" CHECK (case "platform"."block_rules"."match"
        when 'compounded' then "platform"."block_rules"."value" is null
        when 'schedule' then "platform"."block_rules"."value" ~ '^S[2348]$'
        when 'artg_number' then "platform"."block_rules"."value" ~ '^[0-9]{3,8}$'
        else false end),
	CONSTRAINT "block_rules_reason_check" CHECK (length(btrim("platform"."block_rules"."reason")) between 10 and 500),
	CONSTRAINT "block_rules_source_check" CHECK ("platform"."block_rules"."source_url" ~ '^https://')
);
--> statement-breakpoint
CREATE TABLE "operational"."products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"kind" text NOT NULL,
	"schedule" text,
	"artg_number" text,
	"compounded" boolean DEFAULT false NOT NULL,
	"strength" text,
	"form" text,
	"pack_size" text,
	"storage" text DEFAULT 'room' NOT NULL,
	"price_cents" integer NOT NULL,
	"gst_free" boolean NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"blocked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_kind_check" CHECK ("operational"."products"."kind" in ('medicine', 'device', 'service')),
	CONSTRAINT "products_schedule_check" CHECK ("operational"."products"."schedule" in ('S2', 'S3', 'S4', 'S8')),
	CONSTRAINT "products_storage_check" CHECK ("operational"."products"."storage" in ('room', 'refrigerated')),
	CONSTRAINT "products_status_check" CHECK ("operational"."products"."status" in ('active', 'archived')),
	CONSTRAINT "products_name_check" CHECK (length(btrim("operational"."products"."name")) between 1 and 120),
	CONSTRAINT "products_artg_check" CHECK ("operational"."products"."artg_number" ~ '^[0-9]{3,8}$'),
	CONSTRAINT "products_price_check" CHECK ("operational"."products"."price_cents" between 0 and 10000000),
	CONSTRAINT "products_blocked_reason_check" CHECK (length(btrim("operational"."products"."blocked_reason")) between 3 and 300),
	CONSTRAINT "products_medicine_check" CHECK ("operational"."products"."kind" = 'medicine' or ("operational"."products"."schedule" is null and not "operational"."products"."compounded")),
	CONSTRAINT "products_identity_check" CHECK ("operational"."products"."kind" <> 'medicine' or "operational"."products"."artg_number" is not null or "operational"."products"."compounded")
);
--> statement-breakpoint
ALTER TABLE "platform"."block_rules" ADD CONSTRAINT "block_rules_added_by_users_id_fk" FOREIGN KEY ("added_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "operational"."products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "block_rules_added_by_idx" ON "platform"."block_rules" USING btree ("added_by");--> statement-breakpoint
CREATE UNIQUE INDEX "block_rules_current_key" ON "platform"."block_rules" USING btree ("match",coalesce("value", '')) WHERE "platform"."block_rules"."retired_at" is null;--> statement-breakpoint
CREATE INDEX "products_tenant_name_idx" ON "operational"."products" USING btree ("tenant_id","name");--> statement-breakpoint

-- Row-level security and grants (ADR 0006). A product is archived, never
-- deleted (CAT1), so the API gets no DELETE. Marketing gets nothing here:
-- operational is not its zone (ADR 0007).
ALTER TABLE operational.products ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.products
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON operational.products TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, kind, schedule, artg_number, compounded, strength, form, pack_size, storage, price_cents, gst_free, status, blocked_reason, updated_at)
  ON operational.products TO medora_app;
--> statement-breakpoint

-- Block rules are the same for every tenant, so everyone signed in reads
-- them; nobody writes them except through platform.add_block_rule below.
-- Retiring one (setting retired_at) is a reviewed operator script, never a
-- route (CAT2): tightening is fast and loosening is slow.
ALTER TABLE platform.block_rules ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY everyone_reads ON platform.block_rules FOR SELECT USING (true);
--> statement-breakpoint
GRANT SELECT ON platform.block_rules TO medora_app;
--> statement-breakpoint

-- A new block rule (CAT2), by platform staff only, with its reason. It
-- applies to every tenant's products from its effective time, checked when a
-- product is used (CAT3). The audit entry belongs to no tenant.
CREATE FUNCTION platform.add_block_rule(p_match text, p_value text, p_reason text, p_source_url text, p_effective_from timestamptz, p_request_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  actor uuid := medora.current_user_id();
  rule uuid;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM platform.users WHERE id = actor AND platform_staff) THEN
    RAISE EXCEPTION 'add_block_rule needs platform staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  INSERT INTO platform.block_rules (match, value, reason, source_url, effective_from, added_by)
  VALUES (p_match, p_value, btrim(p_reason), p_source_url, coalesce(p_effective_from, now()), actor)
  RETURNING id INTO rule;
  INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id, details)
  VALUES (NULL, 'person', actor, 'block_rule.added', 'platform', 'platform.block_rules', rule::text, p_request_id,
          jsonb_build_object('match', p_match, 'value', p_value, 'effectiveFrom', coalesce(p_effective_from, now())));
  RETURN rule;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.add_block_rule(text, text, text, text, timestamptz, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.add_block_rule(text, text, text, text, timestamptz, text) TO medora_app;
