-- Roles, row-level security, grants, the audit log's guard and the two
-- cross-tenant functions (ADRs 0006, 0007, 0008).

-- Group roles. The API's login, medora_api, is made per environment with its
-- own password and joins medora_app (README, "Setting up a database"). Neither
-- group owns anything, so row-level security always applies to them.
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medora_app') THEN
    CREATE ROLE medora_app NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'medora_marketing') THEN
    CREATE ROLE medora_marketing NOLOGIN NOSUPERUSER NOBYPASSRLS;
  END IF;
END $$;
--> statement-breakpoint

-- Functions are not callable by everyone unless a migration says so.
ALTER DEFAULT PRIVILEGES REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
--> statement-breakpoint

-- The tenant and the person a transaction acts for. withTenant
-- (src/db/tenant.ts) sets both with set_config(..., true), so they end with
-- the transaction. Unset, current_tenant() is null and every policy below
-- matches nothing.
CREATE SCHEMA medora;
--> statement-breakpoint
CREATE FUNCTION medora.current_tenant() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.tenant_id', true), '')::uuid $$;
--> statement-breakpoint
CREATE FUNCTION medora.current_user_id() RETURNS uuid
  LANGUAGE sql STABLE PARALLEL SAFE
  AS $$ SELECT nullif(current_setting('app.user_id', true), '')::uuid $$;
--> statement-breakpoint
REVOKE ALL ON SCHEMA medora, platform, clinical, operational, marketing FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA medora TO medora_app, medora_marketing;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION medora.current_tenant(), medora.current_user_id() TO medora_app, medora_marketing;
--> statement-breakpoint

-- Data zones (ADR 0007): the API uses platform, clinical and operational;
-- marketing jobs use marketing and can't see clinical at all.
GRANT USAGE ON SCHEMA platform, clinical, operational TO medora_app;
--> statement-breakpoint
GRANT USAGE ON SCHEMA marketing TO medora_marketing;
--> statement-breakpoint

-- Grants, table by table: only what the API does today.
GRANT SELECT ON platform.tenants TO medora_app;
--> statement-breakpoint
GRANT SELECT ON platform.users TO medora_app;
--> statement-breakpoint
GRANT SELECT ON platform.memberships TO medora_app;
--> statement-breakpoint
GRANT UPDATE (role, status, updated_at) ON platform.memberships TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.audit_log TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.outbox TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON platform.rate_limit_counters TO medora_app;
--> statement-breakpoint

-- Row-level security (ADR 0006). ENABLE, not FORCE: the owner (migrations and
-- the reviewed functions below) is not subject to it; medora_app always is.
ALTER TABLE platform.tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.tenants
  USING (id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE platform.memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.memberships
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE platform.audit_log ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.audit_log
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE platform.outbox ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.outbox
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
-- A person is visible to themselves, and to the tenant they are a member of.
ALTER TABLE platform.users ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_or_same_tenant ON platform.users FOR SELECT
  USING (
    id = medora.current_user_id()
    OR EXISTS (
      SELECT 1 FROM platform.memberships m
       WHERE m.user_id = users.id AND m.tenant_id = medora.current_tenant()
    )
  );
--> statement-breakpoint

-- The audit log is append-only for every role, the owner included (ADR 0008).
CREATE FUNCTION platform.refuse_audit_change() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  RAISE EXCEPTION 'platform.audit_log is append-only: % refused', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END
$$;
--> statement-breakpoint
CREATE TRIGGER audit_log_append_only BEFORE UPDATE OR DELETE ON platform.audit_log
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_audit_change();
--> statement-breakpoint
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON platform.audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_audit_change();
--> statement-breakpoint

-- Cross-tenant work, kept to two narrow functions (ADR 0006).

-- Who a sign-in is (docs/decisions/foundation.md FND2): the account already
-- linked to this Clerk user, or else the invited account with this verified
-- email, which gets linked now. Null when there is neither. The API passes
-- the email only when Clerk says it is verified.
CREATE FUNCTION platform.claim_user(p_clerk_user_id text, p_email text, p_request_id text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  found uuid;
BEGIN
  SELECT id INTO found FROM platform.users WHERE clerk_user_id = p_clerk_user_id;
  IF found IS NOT NULL OR coalesce(p_email, '') = '' THEN
    RETURN found;
  END IF;
  UPDATE platform.users SET clerk_user_id = p_clerk_user_id
   WHERE email = lower(p_email) AND clerk_user_id IS NULL
   RETURNING id INTO found;
  IF found IS NULL THEN
    -- Another request for the same first sign-in may have linked it a moment ago.
    SELECT id INTO found FROM platform.users WHERE clerk_user_id = p_clerk_user_id;
    RETURN found;
  END IF;
  INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id)
  VALUES (NULL, 'person', found, 'user.sign_in_linked', 'platform', 'platform.users', found::text, p_request_id);
  RETURN found;
END
$$;
--> statement-breakpoint
-- The signed-in person's memberships in every tenant, for "who am I" and for
-- checking the tenant a request names. Reads the person from app.user_id.
CREATE FUNCTION platform.my_memberships()
  RETURNS TABLE (membership_id uuid, tenant_id uuid, tenant_name text, role text, status text)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT m.id, m.tenant_id, t.name, m.role, m.status
    FROM platform.memberships m
    JOIN platform.tenants t ON t.id = m.tenant_id
   WHERE m.user_id = medora.current_user_id()
   ORDER BY t.name, m.tenant_id
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.claim_user(text, text, text), platform.my_memberships(), platform.refuse_audit_change() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.claim_user(text, text, text), platform.my_memberships() TO medora_app;
