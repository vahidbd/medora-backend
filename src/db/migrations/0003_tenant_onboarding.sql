-- Tenant onboarding (docs/decisions/admin.md ADM14 to ADM20): companies,
-- brands and their domains, tenant settings, platform staff.

-- An Australian Business Number: eleven digits whose weighted sum, after
-- taking one from the first digit, divides by 89 (the ATO's checksum).
CREATE FUNCTION platform.abn_valid(p_abn text) RETURNS boolean
  LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT CASE WHEN p_abn ~ '^[0-9]{11}$' THEN
    (SELECT sum((substr(p_abn, i, 1)::int - CASE WHEN i = 1 THEN 1 ELSE 0 END) * (ARRAY[10, 1, 3, 5, 7, 9, 11, 13, 15, 17, 19])[i])
       FROM generate_series(1, 11) AS i) % 89 = 0
  ELSE false END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.abn_valid(text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.abn_valid(text) TO medora_app;
--> statement-breakpoint
CREATE TABLE "platform"."brand_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"host" text NOT NULL,
	"verified_at" timestamp with time zone,
	"verified_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brand_domains_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "brand_domains_host_key" UNIQUE("host"),
	CONSTRAINT "brand_domains_host_check" CHECK ("platform"."brand_domains"."host" ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$' and length("platform"."brand_domains"."host") <= 253),
	CONSTRAINT "brand_domains_verified_check" CHECK (("platform"."brand_domains"."verified_at" is null) = ("platform"."brand_domains"."verified_by" is null))
);
--> statement-breakpoint
CREATE TABLE "platform"."brands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"support_email" text,
	"support_phone" text,
	"primary_colour" text,
	"logo_url" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "brands_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "brands_slug_key" UNIQUE("slug"),
	CONSTRAINT "brands_status_check" CHECK ("platform"."brands"."status" in ('draft', 'live', 'paused')),
	CONSTRAINT "brands_slug_check" CHECK ("platform"."brands"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("platform"."brands"."slug") between 2 and 40),
	CONSTRAINT "brands_name_check" CHECK (length(btrim("platform"."brands"."name")) between 1 and 80),
	CONSTRAINT "brands_colour_check" CHECK ("platform"."brands"."primary_colour" ~ '^#[0-9a-f]{6}$'),
	CONSTRAINT "brands_logo_check" CHECK ("platform"."brands"."logo_url" ~ '^https://'),
	CONSTRAINT "brands_live_check" CHECK ("platform"."brands"."status" = 'draft' or "platform"."brands"."support_email" is not null)
);
--> statement-breakpoint
CREATE TABLE "platform"."companies" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"legal_name" text NOT NULL,
	"trading_name" text,
	"abn" text NOT NULL,
	"state" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "companies_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "companies_tenant_abn_key" UNIQUE("tenant_id","abn"),
	CONSTRAINT "companies_abn_check" CHECK (platform.abn_valid("platform"."companies"."abn")),
	CONSTRAINT "companies_state_check" CHECK ("platform"."companies"."state" in ('NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT')),
	CONSTRAINT "companies_legal_name_check" CHECK (length(btrim("platform"."companies"."legal_name")) between 1 and 200)
);
--> statement-breakpoint
ALTER TABLE "platform"."users" ADD COLUMN "platform_staff" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."brand_domains" ADD CONSTRAINT "brand_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."brand_domains" ADD CONSTRAINT "brand_domains_verified_by_users_id_fk" FOREIGN KEY ("verified_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."brand_domains" ADD CONSTRAINT "brand_domains_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."brands" ADD CONSTRAINT "brands_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."brands" ADD CONSTRAINT "brands_company_fk" FOREIGN KEY ("tenant_id","company_id") REFERENCES "platform"."companies"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."companies" ADD CONSTRAINT "companies_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "brand_domains_brand_idx" ON "platform"."brand_domains" USING btree ("tenant_id","brand_id");--> statement-breakpoint
CREATE INDEX "brand_domains_verified_by_idx" ON "platform"."brand_domains" USING btree ("verified_by");--> statement-breakpoint
CREATE UNIQUE INDEX "brands_tenant_name_key" ON "platform"."brands" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "brands_company_idx" ON "platform"."brands" USING btree ("tenant_id","company_id");--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD CONSTRAINT "tenants_time_zone_check" CHECK ("platform"."tenants"."time_zone" in ('Australia/Sydney', 'Australia/Melbourne', 'Australia/Brisbane', 'Australia/Adelaide', 'Australia/Darwin', 'Australia/Perth', 'Australia/Hobart', 'Australia/Lord_Howe', 'Australia/Eucla', 'Australia/Broken_Hill', 'Indian/Christmas', 'Indian/Cocos', 'Antarctica/Macquarie'));--> statement-breakpoint
ALTER TABLE "platform"."tenants" ADD CONSTRAINT "tenants_name_check" CHECK (length(btrim("platform"."tenants"."name")) between 1 and 120);
--> statement-breakpoint

-- Row-level security and grants (ADR 0006). Tenants set their own name and
-- time zone (ADM20); a brand's slug never changes once made (ADM16).
ALTER TABLE platform.companies ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.companies
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform.companies TO medora_app;
--> statement-breakpoint
GRANT UPDATE (legal_name, trading_name, abn, state, updated_at) ON platform.companies TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.brands ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.brands
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.brands TO medora_app;
--> statement-breakpoint
GRANT UPDATE (company_id, name, status, support_email, support_phone, primary_colour, logo_url, updated_at) ON platform.brands TO medora_app;
--> statement-breakpoint

-- A tenant adds and removes its brands' hosts, but only platform staff mark
-- one verified, through platform.verify_domain below (ADM15). The API can't
-- insert a verified row or change one.
ALTER TABLE platform.brand_domains ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.brand_domains
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE POLICY added_unverified ON platform.brand_domains AS RESTRICTIVE FOR INSERT
  WITH CHECK (verified_at IS NULL AND verified_by IS NULL);
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform.brand_domains TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, time_zone) ON platform.tenants TO medora_app;
--> statement-breakpoint

-- Platform staff (ADM15): Medora's own people, marked on their account by a
-- reviewed migration or an operator. They create tenants and verify hosts
-- through the functions below, and see only tenant names, brands and hosts:
-- never a tenant's staff, patients or settings, unless a tenant invites them.
-- Each function checks the flag itself, so the API's check is not the only one.

-- A new tenant and its first owner's invitation (ADM14). The owner accepts
-- like any invited person; platform staff get no membership.
CREATE FUNCTION platform.create_tenant(p_name text, p_time_zone text, p_owner_email text, p_owner_name text, p_request_id text)
  RETURNS TABLE (new_tenant_id uuid, owner_membership_id uuid, owner_user_id uuid)
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  actor uuid := medora.current_user_id();
  tenant uuid;
  owner uuid;
  invited uuid;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM platform.users WHERE id = actor AND platform_staff) THEN
    RAISE EXCEPTION 'create_tenant needs platform staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_owner_email), '') = '' THEN
    RAISE EXCEPTION 'create_tenant needs the owner''s email' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO platform.tenants (name, time_zone) VALUES (btrim(p_name), p_time_zone) RETURNING id INTO tenant;
  INSERT INTO platform.users (email, display_name)
  VALUES (lower(btrim(p_owner_email)), nullif(btrim(p_owner_name), ''))
  ON CONFLICT ((lower(email))) DO NOTHING
  RETURNING id INTO owner;
  IF owner IS NULL THEN
    SELECT id INTO owner FROM platform.users WHERE email = lower(btrim(p_owner_email));
  END IF;
  INSERT INTO platform.memberships (tenant_id, user_id, role, status, invited_at, invited_by)
  VALUES (tenant, owner, 'owner', 'invited', now(), actor)
  RETURNING id INTO invited;
  INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id, details)
  VALUES (tenant, 'person', actor, 'tenant.created', 'platform', 'platform.tenants', tenant::text, p_request_id,
          jsonb_build_object('timeZone', p_time_zone)),
         (tenant, 'person', actor, 'membership.invited', 'platform', 'platform.memberships', invited::text, p_request_id,
          jsonb_build_object('role', 'owner', 'customRoleId', NULL, 'renewed', false));
  INSERT INTO platform.outbox (tenant_id, type, record_table, record_id, payload, request_id)
  VALUES (tenant, 'tenant.created', 'platform.tenants', tenant::text, jsonb_build_object('timeZone', p_time_zone), p_request_id),
         (tenant, 'membership.invited', 'platform.memberships', invited::text,
          jsonb_build_object('role', 'owner', 'customRoleId', NULL, 'renewed', false, 'userId', owner), p_request_id);
  RETURN QUERY SELECT tenant, invited, owner;
END
$$;
--> statement-breakpoint

-- The first owner's invitation again, when it failed to send or ran out
-- before anyone accepted (ADM14): restarts its 14 days. Answers the owner's
-- email, or nothing when the tenant has no unaccepted owner invitation.
CREATE FUNCTION platform.renew_owner_invitation(p_tenant_id uuid, p_request_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  actor uuid := medora.current_user_id();
  renewed record;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM platform.users WHERE id = actor AND platform_staff) THEN
    RAISE EXCEPTION 'renew_owner_invitation needs platform staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF EXISTS (SELECT 1 FROM platform.memberships WHERE tenant_id = p_tenant_id AND role = 'owner' AND status = 'active') THEN
    RETURN NULL;
  END IF;
  UPDATE platform.memberships m SET invited_at = now(), invited_by = actor, updated_at = now()
    FROM platform.users u
   WHERE m.id = (SELECT id FROM platform.memberships
                  WHERE tenant_id = p_tenant_id AND role = 'owner' AND status = 'invited'
                  ORDER BY created_at, id LIMIT 1)
     AND u.id = m.user_id
   RETURNING m.id, m.user_id, u.email INTO renewed;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id)
  VALUES (p_tenant_id, 'person', actor, 'membership.invitation_resent', 'platform', 'platform.memberships', renewed.id::text, p_request_id);
  INSERT INTO platform.outbox (tenant_id, type, record_table, record_id, payload, request_id)
  VALUES (p_tenant_id, 'membership.invitation_resent', 'platform.memberships', renewed.id::text,
          jsonb_build_object('userId', renewed.user_id), p_request_id);
  RETURN renewed.email;
END
$$;
--> statement-breakpoint

-- Every tenant, by name, with how far it has got: for platform staff only.
CREATE FUNCTION platform.platform_tenants()
  RETURNS TABLE (tenant_id uuid, tenant_name text, time_zone text, created_at timestamptz, owner_joined boolean, brands integer, live_brands integer)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT t.id, t.name, t.time_zone, t.created_at,
         EXISTS (SELECT 1 FROM platform.memberships m WHERE m.tenant_id = t.id AND m.role = 'owner' AND m.status = 'active'),
         (SELECT count(*)::int FROM platform.brands b WHERE b.tenant_id = t.id),
         (SELECT count(*)::int FROM platform.brands b WHERE b.tenant_id = t.id AND b.status = 'live')
    FROM platform.tenants t
   WHERE EXISTS (SELECT 1 FROM platform.users u WHERE u.id = medora.current_user_id() AND u.platform_staff)
   ORDER BY t.name, t.id
$$;
--> statement-breakpoint

-- Brands' hosts across Medora, waiting for a check or all of them: for platform staff only.
CREATE FUNCTION platform.platform_domains(p_waiting boolean)
  RETURNS TABLE (domain_id uuid, tenant_id uuid, tenant_name text, brand_id uuid, brand_name text, host text, created_at timestamptz, verified_at timestamptz)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT d.id, d.tenant_id, t.name, d.brand_id, b.name, d.host, d.created_at, d.verified_at
    FROM platform.brand_domains d
    JOIN platform.brands b ON b.tenant_id = d.tenant_id AND b.id = d.brand_id
    JOIN platform.tenants t ON t.id = d.tenant_id
   WHERE (NOT p_waiting OR d.verified_at IS NULL)
     AND EXISTS (SELECT 1 FROM platform.users u WHERE u.id = medora.current_user_id() AND u.platform_staff)
   ORDER BY d.created_at, d.id
$$;
--> statement-breakpoint

-- Platform staff have checked the host's DNS points at Medora (ADM15). Writes
-- the audit entry and the event in the brand's tenant. Answers the host,
-- or nothing when there is no such host; verifying twice changes nothing.
CREATE FUNCTION platform.verify_domain(p_domain_id uuid, p_request_id text)
  RETURNS text
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  actor uuid := medora.current_user_id();
  target record;
BEGIN
  IF actor IS NULL OR NOT EXISTS (SELECT 1 FROM platform.users WHERE id = actor AND platform_staff) THEN
    RAISE EXCEPTION 'verify_domain needs platform staff' USING ERRCODE = 'insufficient_privilege';
  END IF;
  SELECT id, tenant_id, brand_id, host, verified_at INTO target FROM platform.brand_domains WHERE id = p_domain_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  IF target.verified_at IS NOT NULL THEN
    RETURN target.host;
  END IF;
  UPDATE platform.brand_domains SET verified_at = now(), verified_by = actor WHERE id = p_domain_id;
  INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id, details)
  VALUES (target.tenant_id, 'person', actor, 'brand_domain.verified', 'platform', 'platform.brand_domains', target.id::text, p_request_id,
          jsonb_build_object('brandId', target.brand_id, 'host', target.host));
  INSERT INTO platform.outbox (tenant_id, type, record_table, record_id, payload, request_id)
  VALUES (target.tenant_id, 'brand_domain.verified', 'platform.brand_domains', target.id::text,
          jsonb_build_object('brandId', target.brand_id, 'host', target.host), p_request_id);
  RETURN target.host;
END
$$;
--> statement-breakpoint

-- The brand a public page belongs to, before any tenant is known (ADM16):
-- by a host platform staff have verified, or else by slug. Only a live or
-- paused brand answers; paused ones stop new sign-ups, which the caller
-- checks. The caller then works inside the answered tenant with withTenant.
CREATE FUNCTION platform.resolve_brand(p_host text, p_slug text)
  RETURNS TABLE (tenant_id uuid, brand_id uuid, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT b.tenant_id, b.id, b.status
    FROM platform.brands b
   WHERE b.status IN ('live', 'paused')
     AND CASE
           WHEN p_host IS NOT NULL THEN EXISTS (
             SELECT 1 FROM platform.brand_domains d
              WHERE d.tenant_id = b.tenant_id AND d.brand_id = b.id AND d.host = lower(p_host) AND d.verified_at IS NOT NULL)
           ELSE b.slug = p_slug
         END
   LIMIT 1
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.create_tenant(text, text, text, text, text), platform.renew_owner_invitation(uuid, text),
  platform.platform_tenants(), platform.platform_domains(boolean), platform.verify_domain(uuid, text), platform.resolve_brand(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.create_tenant(text, text, text, text, text), platform.renew_owner_invitation(uuid, text),
  platform.platform_tenants(), platform.platform_domains(boolean), platform.verify_domain(uuid, text), platform.resolve_brand(text, text) TO medora_app;
