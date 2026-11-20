# Jobs and outbox delivery

Rulings for the worker service: scheduled jobs, their leases and delivering the outbox (ADR 0029 sets the rules; ADR 0016 the outbox). Code: `src/worker.ts`, `src/lib/jobs.ts`, `src/lib/leases.ts`, `src/lib/outbox-delivery.ts`, `src/modules/workers.ts`.

### JOB1. A job is due a fixed time after its last start, and missed runs are never replayed

Decision: a job declares `everySeconds`. It runs when that long has passed since its last start and no other process holds its lease; the check and the lease are taken in one statement on `platform.job_leases`. A worker that was down runs each job once when it comes back, never once per missed slot. A job finds its own due work (renewals due, reminders past their time, quiet hours over), so running late does the right thing and running twice finds nothing new.
Why: ADR 0029 allows catch-up only for jobs safe to run late. Making every job work from what is due, rather than from the clock slot it was meant for, makes every job safe to run late and leaves nothing to list.

### JOB2. A failed event is tried again with doubling backoff, then given up and reported

Decision: after a handler fails, the event is tried again 30 seconds later, doubling each time up to an hour, for 12 attempts in all (about five hours). Then it is marked `failed_at`, logged as an error and never tried again by itself. The outbox stores the failure's error name and code, never its message.
Why: a provider outage of a few hours recovers without anyone acting; a handler that can never succeed stops costing work and shows up in the error log. Error messages can carry personal details (an email address in a provider's reply), so they stay in the masked log only.

### JOB3. Deliveries are recorded per handler

Decision: when a handler succeeds for an event, a row in `platform.outbox_deliveries` says so, and that handler is never given the event again, even when another handler on the same event fails and the event is retried. The event is marked delivered once every subscribed handler has succeeded. An event with no subscribed handler is marked delivered at once.
Why: a failing text message must not make a payment handler run again. Handlers are still written to be safe to run twice (the process can die between a handler finishing and its row being written), using the event id as the idempotency key for outside calls.

### JOB4. Delivery serves tenants oldest-due first, a batch at a time

Decision: each pass takes up to 50 tenants with events due, through the reviewed function `platform.tenants_with_due_events`, oldest due first, and up to 100 events per tenant, each tenant's inside its own `withTenant`. The job runs every 2 seconds.
Why: ADR 0029 wants per-tenant queues where volume differs. One tenant's backlog of thousands waits its turn in batches instead of holding up every other tenant's events.

### JOB5. A job that works per tenant does one tenant at a time, and one tenant's failure doesn't stop the rest

Decision: `forEachTenant(context, work)` lists tenants through the reviewed function `platform.tenant_ids()` and runs `work` inside each tenant's `withTenant` as the system actor, one transaction per tenant. A tenant whose work throws is logged and skipped; the job carries on and is recorded as failed at the end.
Why: ADR 0006 says cross-tenant background work runs one tenant at a time. A bad row in one tenant must not stop another tenant's renewals.

### JOB6. The worker is its own service, on the API's database role

Decision: `src/worker.ts` runs as a separate service (`npm run start:worker`), connects as `medora_api` like the API, checks its role at boot the same way, and never runs migrations (the API's start does). On shutdown it lets running jobs finish for a few seconds, then marks its leases as run out so another copy takes them at once.
Why: ADR 0029 keeps heavy and slow work out of the API. The same role means row-level security binds the worker exactly as it binds the API.
