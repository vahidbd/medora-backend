CREATE TABLE "operational"."macros" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_by_user_id" uuid NOT NULL,
	"updated_by_user_id" uuid NOT NULL,
	"approved_by_user_id" uuid,
	"approved_at" timestamp with time zone,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "macros_status_check" CHECK ("operational"."macros"."status" in ('draft', 'approved')),
	CONSTRAINT "macros_approved_check" CHECK (("operational"."macros"."status" = 'approved') = ("operational"."macros"."approved_by_user_id" is not null and "operational"."macros"."approved_at" is not null))
);
--> statement-breakpoint
CREATE UNIQUE INDEX "macros_tenant_name_key" ON "operational"."macros" USING btree ("tenant_id",lower("name")) WHERE "operational"."macros"."archived_at" is null;
--> statement-breakpoint
CREATE INDEX "macros_tenant_idx" ON "operational"."macros" USING btree ("tenant_id","status");
--> statement-breakpoint
CREATE INDEX "macros_created_by_idx" ON "operational"."macros" USING btree ("created_by_user_id");
--> statement-breakpoint
CREATE INDEX "macros_updated_by_idx" ON "operational"."macros" USING btree ("updated_by_user_id");
--> statement-breakpoint
CREATE INDEX "macros_approved_by_idx" ON "operational"."macros" USING btree ("approved_by_user_id");
--> statement-breakpoint
ALTER TABLE "operational"."macros" ADD CONSTRAINT "macros_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."macros" ADD CONSTRAINT "macros_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."macros" ADD CONSTRAINT "macros_updated_by_user_id_users_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "operational"."macros" ADD CONSTRAINT "macros_approved_by_user_id_users_id_fk" FOREIGN KEY ("approved_by_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Macros (docs/decisions/support.md SUP10): approved wording for replies, the
-- tenant's alone (ADR 0006). Archived, never deleted, so a reply's macro stays known.
GRANT SELECT, INSERT ON operational.macros TO medora_app;
--> statement-breakpoint
GRANT UPDATE (name, body, status, updated_by_user_id, approved_by_user_id, approved_at, archived_at, updated_at) ON operational.macros TO medora_app;
--> statement-breakpoint
ALTER TABLE operational.macros ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON operational.macros
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
