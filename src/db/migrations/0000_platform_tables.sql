CREATE SCHEMA "clinical";
--> statement-breakpoint
CREATE SCHEMA "marketing";
--> statement-breakpoint
CREATE SCHEMA "operational";
--> statement-breakpoint
CREATE SCHEMA "platform";
--> statement-breakpoint
CREATE TABLE "platform"."audit_log" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform"."audit_log_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"zone" text NOT NULL,
	"record_table" text NOT NULL,
	"record_id" text NOT NULL,
	"request_id" text,
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	CONSTRAINT "audit_log_actor_type_check" CHECK ("platform"."audit_log"."actor_type" in ('person', 'agent', 'system')),
	CONSTRAINT "audit_log_zone_check" CHECK ("platform"."audit_log"."zone" in ('clinical', 'operational', 'marketing', 'platform')),
	CONSTRAINT "audit_log_actor_check" CHECK (("platform"."audit_log"."actor_type" = 'system') = ("platform"."audit_log"."actor_id" is null))
);
--> statement-breakpoint
CREATE TABLE "platform"."memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "memberships_role_check" CHECK ("platform"."memberships"."role" in ('owner', 'clinician', 'support', 'finance')),
	CONSTRAINT "memberships_status_check" CHECK ("platform"."memberships"."status" in ('active', 'suspended'))
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform"."outbox_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"type" text NOT NULL,
	"record_table" text NOT NULL,
	"record_id" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"request_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"delivered_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."rate_limit_counters" (
	"key" text PRIMARY KEY NOT NULL,
	"window_started_at" timestamp with time zone NOT NULL,
	"count" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"time_zone" text DEFAULT 'Australia/Sydney' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "platform"."users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_user_id" text,
	"email" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_clerk_user_id_unique" UNIQUE("clerk_user_id"),
	CONSTRAINT "users_email_lower" CHECK ("platform"."users"."email" = lower("platform"."users"."email"))
);
--> statement-breakpoint
ALTER TABLE "platform"."audit_log" ADD CONSTRAINT "audit_log_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."memberships" ADD CONSTRAINT "memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "platform"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."outbox" ADD CONSTRAINT "outbox_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_log_tenant_at_idx" ON "platform"."audit_log" USING btree ("tenant_id","at");--> statement-breakpoint
CREATE INDEX "audit_log_record_idx" ON "platform"."audit_log" USING btree ("record_table","record_id");--> statement-breakpoint
CREATE UNIQUE INDEX "memberships_tenant_user_key" ON "platform"."memberships" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE INDEX "memberships_user_idx" ON "platform"."memberships" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "outbox_tenant_idx" ON "platform"."outbox" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_key" ON "platform"."users" USING btree (lower("email"));