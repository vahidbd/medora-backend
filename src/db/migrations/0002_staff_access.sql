CREATE TABLE "platform"."break_glass" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"membership_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"reason" text NOT NULL,
	"opened_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ends_at" timestamp with time zone NOT NULL,
	"reviewed_at" timestamp with time zone,
	"reviewed_by" uuid,
	"review_note" text,
	CONSTRAINT "break_glass_reason_check" CHECK (length(btrim("platform"."break_glass"."reason")) between 10 and 500),
	CONSTRAINT "break_glass_ends_check" CHECK ("platform"."break_glass"."ends_at" > "platform"."break_glass"."opened_at"),
	CONSTRAINT "break_glass_review_check" CHECK (("platform"."break_glass"."reviewed_at" is null) = ("platform"."break_glass"."reviewed_by" is null))
);
--> statement-breakpoint
CREATE TABLE "platform"."roles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"permissions" text[] DEFAULT '{}'::text[] NOT NULL,
	"based_on" text NOT NULL,
	"clinical" boolean NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "roles_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "roles_based_on_check" CHECK ("platform"."roles"."based_on" in ('owner', 'admin', 'medical_director', 'prescriber', 'clinician', 'support', 'finance', 'operations', 'marketing', 'compliance')),
	CONSTRAINT "roles_name_check" CHECK (length(btrim("platform"."roles"."name")) between 1 and 60)
);
--> statement-breakpoint
CREATE TABLE "platform"."sign_ins" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform"."sign_ins_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"user_id" uuid NOT NULL,
	"session_hash" text NOT NULL,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"client_ip" text,
	"device" text,
	"second_factor" boolean NOT NULL,
	CONSTRAINT "sign_ins_session_hash_unique" UNIQUE("session_hash")
);
--> statement-breakpoint
ALTER TABLE "platform"."memberships" DROP CONSTRAINT "memberships_role_check";--> statement-breakpoint
ALTER TABLE "platform"."memberships" DROP CONSTRAINT "memberships_status_check";--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD COLUMN "custom_role_id" uuid;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD COLUMN "invited_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD COLUMN "invited_by" uuid;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD COLUMN "expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."users" ADD COLUMN "display_name" text;--> statement-breakpoint
ALTER TABLE "platform"."break_glass" ADD CONSTRAINT "break_glass_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."break_glass" ADD CONSTRAINT "break_glass_membership_id_memberships_id_fk" FOREIGN KEY ("membership_id") REFERENCES "platform"."memberships"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."break_glass" ADD CONSTRAINT "break_glass_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."break_glass" ADD CONSTRAINT "break_glass_reviewed_by_users_id_fk" FOREIGN KEY ("reviewed_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."sign_ins" ADD CONSTRAINT "sign_ins_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "break_glass_tenant_opened_idx" ON "platform"."break_glass" USING btree ("tenant_id","opened_at");--> statement-breakpoint
CREATE INDEX "break_glass_membership_idx" ON "platform"."break_glass" USING btree ("membership_id","ends_at");--> statement-breakpoint
CREATE INDEX "break_glass_user_idx" ON "platform"."break_glass" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "break_glass_reviewed_by_idx" ON "platform"."break_glass" USING btree ("reviewed_by");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_tenant_name_key" ON "platform"."roles" USING btree ("tenant_id",lower("name"));--> statement-breakpoint
CREATE INDEX "sign_ins_user_at_idx" ON "platform"."sign_ins" USING btree ("user_id","at");--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_invited_by_users_id_fk" FOREIGN KEY ("invited_by") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_custom_role_fk" FOREIGN KEY ("tenant_id","custom_role_id") REFERENCES "platform"."roles"("tenant_id","id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "memberships_custom_role_idx" ON "platform"."memberships" USING btree ("tenant_id","custom_role_id");--> statement-breakpoint
CREATE INDEX "memberships_invited_by_idx" ON "platform"."memberships" USING btree ("invited_by");--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_custom_role_check" CHECK (("platform"."memberships"."role" = 'custom') = ("platform"."memberships"."custom_role_id" is not null));--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_invited_check" CHECK ("platform"."memberships"."status" <> 'invited' or "platform"."memberships"."invited_at" is not null);--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_role_check" CHECK ("platform"."memberships"."role" in ('owner', 'admin', 'medical_director', 'prescriber', 'clinician', 'support', 'finance', 'operations', 'marketing', 'compliance', 'custom'));--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_status_check" CHECK ("platform"."memberships"."status" in ('active', 'suspended', 'invited'));--> statement-breakpoint

-- Row-level security and grants for staff access (ADR 0006, docs/decisions/admin.md ADM1 to ADM7).
ALTER TABLE platform.roles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.roles
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON platform.roles TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, description, permissions, updated_at) ON platform.roles TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.break_glass ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.break_glass
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.break_glass TO medora_app;
--> statement-breakpoint
GRANT UPDATE (ends_at, reviewed_at, reviewed_by, review_note) ON platform.break_glass TO medora_app;
--> statement-breakpoint

-- Memberships: invitations are inserted, and withdrawn ones deleted, by the
-- API inside the tenant. Only a row still invited may be deleted (ADM5).
GRANT INSERT ON platform.memberships TO medora_app;
--> statement-breakpoint
GRANT UPDATE (custom_role_id, invited_at, invited_by, expires_at) ON platform.memberships TO medora_app;
--> statement-breakpoint
GRANT DELETE ON platform.memberships TO medora_app;
--> statement-breakpoint
CREATE POLICY only_invitations_deleted ON platform.memberships AS RESTRICTIVE FOR DELETE
  USING (status = 'invited');
--> statement-breakpoint

-- Sign-ins belong to the person (ADM6): written by their own request, read by
-- themselves and by the tenants they are a member of.
ALTER TABLE platform.sign_ins ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY own_or_same_tenant ON platform.sign_ins FOR SELECT
  USING (
    user_id = medora.current_user_id()
    OR EXISTS (
      SELECT 1 FROM platform.memberships m
       WHERE m.user_id = sign_ins.user_id AND m.tenant_id = medora.current_tenant()
    )
  );
--> statement-breakpoint
CREATE POLICY own_insert ON platform.sign_ins FOR INSERT
  WITH CHECK (user_id = medora.current_user_id());
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.sign_ins TO medora_app;
--> statement-breakpoint

-- What the signed-in person may do in each tenant, in one read (ADM1, ADM3,
-- ADM7): the starting role's key or the custom role's own permissions,
-- whether access has run out, and until when break-glass is open. Replaces
-- platform.my_memberships(), which stays until no released code calls it.
CREATE FUNCTION platform.my_access()
  RETURNS TABLE (
    membership_id uuid, tenant_id uuid, tenant_name text, role text, custom_role_id uuid,
    custom_role_name text, custom_permissions text[], custom_clinical boolean,
    status text, expires_at timestamptz, break_glass_until timestamptz
  )
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT m.id, m.tenant_id, t.name, m.role, m.custom_role_id,
         r.name, r.permissions, r.clinical,
         m.status, m.expires_at,
         (SELECT max(b.ends_at) FROM platform.break_glass b
           WHERE b.membership_id = m.id AND b.ends_at > now())
    FROM platform.memberships m
    JOIN platform.tenants t ON t.id = m.tenant_id
    LEFT JOIN platform.roles r ON r.tenant_id = m.tenant_id AND r.id = m.custom_role_id
   WHERE m.user_id = medora.current_user_id()
   ORDER BY t.name, m.tenant_id
$$;
--> statement-breakpoint

-- The signed-in person's open invitations become active memberships (ADM5).
-- An invitation lasts 14 days from when it was last sent; after that only a
-- new invitation from the tenant brings it back. Each one accepted writes an
-- audit entry and an event in that tenant.
CREATE FUNCTION platform.accept_invitations(p_request_id text)
  RETURNS integer
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  accepted record;
  total integer := 0;
BEGIN
  FOR accepted IN
    UPDATE platform.memberships SET status = 'active', updated_at = now()
     WHERE user_id = medora.current_user_id()
       AND status = 'invited'
       AND invited_at > now() - interval '14 days'
       AND (expires_at IS NULL OR expires_at > now())
     RETURNING id, tenant_id, user_id
  LOOP
    INSERT INTO platform.audit_log (tenant_id, actor_type, actor_id, action, zone, record_table, record_id, request_id)
    VALUES (accepted.tenant_id, 'person', accepted.user_id, 'membership.invitation_accepted', 'platform', 'platform.memberships', accepted.id::text, p_request_id);
    INSERT INTO platform.outbox (tenant_id, type, record_table, record_id, payload, request_id)
    VALUES (accepted.tenant_id, 'membership.invitation_accepted', 'platform.memberships', accepted.id::text,
            jsonb_build_object('userId', accepted.user_id), p_request_id);
    total := total + 1;
  END LOOP;
  RETURN total;
END
$$;
--> statement-breakpoint

-- The person an invitation is for (ADM5): the account with this email, made
-- now if there is none. A display name is kept only for a new account, so one
-- tenant can't rename someone another tenant knows. Callable only by an
-- active member of the tenant the transaction acts in; the API checks
-- staff:manage before it calls this.
CREATE FUNCTION platform.invite_person(p_email text, p_display_name text)
  RETURNS uuid
  LANGUAGE plpgsql SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  found uuid;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM platform.memberships
     WHERE tenant_id = medora.current_tenant() AND user_id = medora.current_user_id() AND status = 'active'
  ) THEN
    RAISE EXCEPTION 'invite_person needs an active member of the current tenant' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF coalesce(btrim(p_email), '') = '' THEN
    RAISE EXCEPTION 'invite_person needs an email' USING ERRCODE = 'invalid_parameter_value';
  END IF;
  INSERT INTO platform.users (email, display_name)
  VALUES (lower(btrim(p_email)), nullif(btrim(p_display_name), ''))
  ON CONFLICT ((lower(email))) DO NOTHING
  RETURNING id INTO found;
  IF found IS NULL THEN
    SELECT id INTO found FROM platform.users WHERE email = lower(btrim(p_email));
  END IF;
  RETURN found;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.my_access(), platform.accept_invitations(text), platform.invite_person(text, text) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.my_access(), platform.accept_invitations(text), platform.invite_person(text, text) TO medora_app;
