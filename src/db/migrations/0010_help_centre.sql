CREATE TABLE "operational"."help_centre_article_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"article_id" uuid NOT NULL,
	"title" text NOT NULL,
	"summary" text NOT NULL,
	"body" text NOT NULL,
	"written_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"checked_with" text,
	"confirmation" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_centre_article_versions_article_id_key" UNIQUE("tenant_id","article_id","id"),
	CONSTRAINT "help_centre_article_versions_approved_check" CHECK (("operational"."help_centre_article_versions"."approved_at" is null) = ("operational"."help_centre_article_versions"."approved_by_user_id" is null) and ("operational"."help_centre_article_versions"."approved_at" is null) = ("operational"."help_centre_article_versions"."checked_with" is null) and ("operational"."help_centre_article_versions"."approved_at" is null) = ("operational"."help_centre_article_versions"."confirmation" is null))
);
--> statement-breakpoint
CREATE TABLE "operational"."help_centre_articles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"section_id" uuid NOT NULL,
	"slug" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"live_version_id" uuid,
	"published_at" timestamp with time zone,
	"created_by_user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_centre_articles_tenant_id_key" UNIQUE("tenant_id","id"),
	CONSTRAINT "help_centre_articles_slug_check" CHECK ("operational"."help_centre_articles"."slug" ~ '^[a-z0-9]+(-[a-z0-9]+)*$' and length("operational"."help_centre_articles"."slug") <= 80),
	CONSTRAINT "help_centre_articles_published_check" CHECK ("operational"."help_centre_articles"."published_at" is null or "operational"."help_centre_articles"."live_version_id" is not null)
);
--> statement-breakpoint
CREATE TABLE "operational"."help_centre_sections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"brand_id" uuid NOT NULL,
	"name" text NOT NULL,
	"position" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "help_centre_sections_brand_id_key" UNIQUE("tenant_id","brand_id","id")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "help_centre_article_versions_one_draft_key" ON "operational"."help_centre_article_versions" USING btree ("article_id") WHERE "operational"."help_centre_article_versions"."approved_at" is null;
--> statement-breakpoint
CREATE INDEX "help_centre_article_versions_search_idx" ON "operational"."help_centre_article_versions" USING gin (to_tsvector('english', "title" || ' ' || "summary" || ' ' || "body")) WHERE "operational"."help_centre_article_versions"."approved_at" is not null;
--> statement-breakpoint
CREATE INDEX "help_centre_article_versions_written_by_idx" ON "operational"."help_centre_article_versions" USING btree ("written_by_user_id");
--> statement-breakpoint
CREATE INDEX "help_centre_article_versions_approved_by_idx" ON "operational"."help_centre_article_versions" USING btree ("approved_by_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "help_centre_articles_slug_key" ON "operational"."help_centre_articles" USING btree ("tenant_id","brand_id","slug");
--> statement-breakpoint
CREATE INDEX "help_centre_articles_section_idx" ON "operational"."help_centre_articles" USING btree ("tenant_id","brand_id","section_id");
--> statement-breakpoint
CREATE INDEX "help_centre_articles_live_version_idx" ON "operational"."help_centre_articles" USING btree ("tenant_id","id","live_version_id");
--> statement-breakpoint
CREATE INDEX "help_centre_articles_created_by_idx" ON "operational"."help_centre_articles" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE UNIQUE INDEX "help_centre_sections_name_key" ON "operational"."help_centre_sections" USING btree ("tenant_id","brand_id",lower("name"));
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_article_versions" ADD CONSTRAINT "help_centre_article_versions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_article_versions" ADD CONSTRAINT "help_centre_article_versions_written_by_user_id_users_id_fk" FOREIGN KEY ("written_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_article_versions" ADD CONSTRAINT "help_centre_article_versions_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_article_versions" ADD CONSTRAINT "help_centre_article_versions_article_fk" FOREIGN KEY ("tenant_id","article_id") REFERENCES "operational"."help_centre_articles"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_articles" ADD CONSTRAINT "help_centre_articles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_articles" ADD CONSTRAINT "help_centre_articles_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_articles" ADD CONSTRAINT "help_centre_articles_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_articles" ADD CONSTRAINT "help_centre_articles_section_fk" FOREIGN KEY ("tenant_id","brand_id","section_id") REFERENCES "operational"."help_centre_sections"("tenant_id","brand_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_articles" ADD CONSTRAINT "help_centre_articles_live_version_fk" FOREIGN KEY ("tenant_id","id","live_version_id") REFERENCES "operational"."help_centre_article_versions"("tenant_id","article_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_sections" ADD CONSTRAINT "help_centre_sections_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."help_centre_sections" ADD CONSTRAINT "help_centre_sections_brand_fk" FOREIGN KEY ("tenant_id","brand_id") REFERENCES "platform"."brands"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- The help centre (docs/decisions/support.md SUP14 to SUP19): each brand's
-- public service articles, the tenant's alone (ADR 0006).
GRANT SELECT, INSERT, DELETE ON operational.help_centre_sections TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, position, updated_at) ON operational.help_centre_sections TO medora_app;
--> statement-breakpoint
-- An article is removed only while it has never been published (SUP15).
GRANT SELECT, INSERT, DELETE ON operational.help_centre_articles TO medora_app;
--> statement-breakpoint
GRANT UPDATE (section_id, slug, position, live_version_id, published_at, updated_at) ON operational.help_centre_articles TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON operational.help_centre_article_versions TO medora_app;
--> statement-breakpoint
GRANT UPDATE (title, summary, body, written_by_user_id, approved_by_user_id, approved_at, checked_with, confirmation, updated_at)
  ON operational.help_centre_article_versions TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.help_centre_sections ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.help_centre_sections
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.help_centre_articles ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.help_centre_articles
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
ALTER TABLE operational.help_centre_article_versions ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.help_centre_article_versions
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
-- Approved wording is the archive of what was public (SUP15): never changed or
-- removed. A draft can be rewritten, approved once, or discarded.
CREATE FUNCTION operational.keep_approved_article_versions() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    RAISE EXCEPTION 'help centre wording is never truncated' USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF OLD.approved_at IS NOT NULL THEN
    RAISE EXCEPTION 'approved help centre wording is never changed or removed: % refused', TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operational.keep_approved_article_versions() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER help_centre_article_versions_keep BEFORE UPDATE OR DELETE ON operational.help_centre_article_versions
  FOR EACH ROW EXECUTE FUNCTION operational.keep_approved_article_versions();
--> statement-breakpoint
CREATE TRIGGER help_centre_article_versions_no_truncate BEFORE TRUNCATE ON operational.help_centre_article_versions
  FOR EACH STATEMENT EXECUTE FUNCTION operational.keep_approved_article_versions();
--> statement-breakpoint
-- Only approved wording goes live (SUP15), whatever code sets the live version.
CREATE FUNCTION operational.live_version_is_approved() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.live_version_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM operational.help_centre_article_versions v
     WHERE v.tenant_id = NEW.tenant_id AND v.id = NEW.live_version_id AND v.approved_at IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'a help centre article goes live only with approved wording'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION operational.live_version_is_approved() FROM PUBLIC;
--> statement-breakpoint
CREATE TRIGGER help_centre_articles_live_approved BEFORE INSERT OR UPDATE OF live_version_id ON operational.help_centre_articles
  FOR EACH ROW EXECUTE FUNCTION operational.live_version_is_approved();
