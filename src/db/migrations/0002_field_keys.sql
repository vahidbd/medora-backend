CREATE TABLE "platform"."tenant_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"wrapped_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_keys_provider_check" CHECK ("platform"."tenant_keys"."provider" in ('local'))
);
--> statement-breakpoint
ALTER TABLE "platform"."tenant_keys" ADD CONSTRAINT "tenant_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_keys_tenant_key" ON "platform"."tenant_keys" USING btree ("tenant_id");--> statement-breakpoint

-- Field encryption keys (ADR 0010, docs/decisions/field-encryption.md).
-- The API reads its tenant's key and adds one on first use; nobody changes or
-- removes a key, because values sealed with it would become unreadable.
GRANT SELECT, INSERT ON platform.tenant_keys TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.tenant_keys ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.tenant_keys
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE FUNCTION platform.refuse_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION '%.% rows are never changed or removed: % refused', TG_TABLE_SCHEMA, TG_TABLE_NAME, TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.refuse_change() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER tenant_keys_keep BEFORE UPDATE OR DELETE ON platform.tenant_keys
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER tenant_keys_no_truncate BEFORE TRUNCATE ON platform.tenant_keys
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
