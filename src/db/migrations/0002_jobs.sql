CREATE TABLE "platform"."job_leases" (
	"name" text PRIMARY KEY NOT NULL,
	"holder" text,
	"expires_at" timestamp with time zone,
	"last_started_at" timestamp with time zone,
	"last_finished_at" timestamp with time zone,
	"last_outcome" text,
	CONSTRAINT "job_leases_last_outcome_check" CHECK ("platform"."job_leases"."last_outcome" is null or "platform"."job_leases"."last_outcome" in ('succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "platform"."outbox_deliveries" (
	"id" bigint PRIMARY KEY GENERATED ALWAYS AS IDENTITY (sequence name "platform"."outbox_deliveries_id_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1),
	"tenant_id" uuid NOT NULL,
	"event_id" bigint NOT NULL,
	"handler" text NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "platform"."outbox" ADD COLUMN "next_attempt_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "platform"."outbox" ADD COLUMN "failed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "platform"."outbox" ADD COLUMN "last_error" text;--> statement-breakpoint
ALTER TABLE "platform"."outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "platform"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "platform"."outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_event_id_outbox_id_fk" FOREIGN KEY ("event_id") REFERENCES "platform"."outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "outbox_deliveries_event_handler_key" ON "platform"."outbox_deliveries" USING btree ("event_id","handler");--> statement-breakpoint
CREATE INDEX "outbox_deliveries_tenant_idx" ON "platform"."outbox_deliveries" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "outbox_due_idx" ON "platform"."outbox" USING btree ("next_attempt_at") WHERE "platform"."outbox"."delivered_at" is null and "platform"."outbox"."failed_at" is null;--> statement-breakpoint

-- The worker (ADR 0029, docs/decisions/jobs.md). It connects as medora_api,
-- like the API, so row-level security binds it the same way.

-- Job leases hold job names and process ids only, no tenant data.
GRANT SELECT, INSERT, UPDATE ON platform.job_leases TO medora_app;
--> statement-breakpoint

-- Delivery marks an event delivered, or schedules its next try.
GRANT UPDATE (delivered_at, attempts, next_attempt_at, failed_at, last_error) ON platform.outbox TO medora_app;
--> statement-breakpoint
GRANT SELECT, INSERT ON platform.outbox_deliveries TO medora_app;
--> statement-breakpoint
ALTER TABLE platform.outbox_deliveries ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_isolation ON platform.outbox_deliveries
  USING (tenant_id = medora.current_tenant())
  WITH CHECK (tenant_id = medora.current_tenant());
--> statement-breakpoint

-- Which tenants have events due now, oldest first (JOB4). Ids only: the
-- worker then reads each tenant's events inside that tenant (ADR 0006).
CREATE FUNCTION platform.tenants_with_due_events(p_limit integer)
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
  SELECT o.tenant_id
    FROM platform.outbox o
   WHERE o.delivered_at IS NULL AND o.failed_at IS NULL AND o.next_attempt_at <= now()
   GROUP BY o.tenant_id
   ORDER BY min(o.next_attempt_at), o.tenant_id
   LIMIT greatest(p_limit, 0)
$$;
--> statement-breakpoint
-- Every tenant's id, for a job that works one tenant at a time (JOB5).
CREATE FUNCTION platform.tenant_ids()
  RETURNS TABLE (tenant_id uuid)
  LANGUAGE sql STABLE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$ SELECT t.id FROM platform.tenants t ORDER BY t.id $$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION platform.tenants_with_due_events(integer), platform.tenant_ids() FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION platform.tenants_with_due_events(integer), platform.tenant_ids() TO medora_app;
