CREATE TABLE "clinical"."ticket_comments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_user_id" uuid NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "ticket_comments_ticket_idx" ON "clinical"."ticket_comments" USING btree ("tenant_id","ticket_id","created_at");
--> statement-breakpoint
CREATE INDEX "ticket_comments_author_idx" ON "clinical"."ticket_comments" USING btree ("author_user_id");
--> statement-breakpoint
ALTER TABLE "clinical"."ticket_comments" ADD CONSTRAINT "ticket_comments_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clinical"."ticket_comments" ADD CONSTRAINT "ticket_comments_author_user_id_users_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "clinical"."ticket_comments" ADD CONSTRAINT "ticket_comments_ticket_fk" FOREIGN KEY ("tenant_id","ticket_id") REFERENCES "operational"."tickets"("tenant_id","id") ON DELETE no action ON UPDATE no action;
--> statement-breakpoint
-- Staff comments on a ticket (docs/decisions/support.md SUP13): clinical zone,
-- like every free text on a ticket, and the tenant's alone (ADR 0006).
-- A comment is a record: written once, never changed or removed (ADR 0028).
GRANT SELECT, INSERT ON clinical.ticket_comments TO medora_app;
--> statement-breakpoint
ALTER TABLE clinical.ticket_comments ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON clinical.ticket_comments
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint
CREATE TRIGGER ticket_comments_keep BEFORE UPDATE OR DELETE ON clinical.ticket_comments
  FOR EACH ROW EXECUTE FUNCTION platform.refuse_change();
--> statement-breakpoint
CREATE TRIGGER ticket_comments_no_truncate BEFORE TRUNCATE ON clinical.ticket_comments
  FOR EACH STATEMENT EXECUTE FUNCTION platform.refuse_change();
