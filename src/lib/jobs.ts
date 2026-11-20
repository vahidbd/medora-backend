import { sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { type TenantTx, withTenant } from '../db/tenant.js';
import { withLease } from './leases.js';
import { safeErrorMessage } from './redact.js';

/**
 * Scheduled jobs (ADR 0029, docs/decisions/jobs.md). The worker service
 * (src/worker.ts) calls runDueJobs on a short tick; each job runs only when
 * it is due and no other process is running it.
 *
 * A module exports its jobs from its index.ts, and src/modules/workers.ts
 * lists them.
 */

/** What a job may log: a pino logger fits. Never log patient details (AGENTS.md). */
export interface JobLogger {
  info(details: object, message?: string): void;
  warn(details: object, message?: string): void;
  error(details: object, message?: string): void;
}

export interface JobContext {
  name: string;
  log: JobLogger;
}

export interface Job {
  /** Unique, kebab-case: the lease's name, e.g. `billing-renewals`. */
  name: string;
  /** How long after the last start the job is due again (JOB1). */
  everySeconds: number;
  run(context: JobContext): Promise<void>;
}

export type JobResult = { name: string; ran: false } | { name: string; ran: true; outcome: 'succeeded' | 'failed' };

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

export function assertJobsValid(jobs: readonly Job[]): void {
  const seen = new Set<string>();
  for (const job of jobs) {
    if (!NAME.test(job.name)) throw new Error(`Job name ${job.name} must be kebab-case`);
    if (seen.has(job.name)) throw new Error(`Two jobs are named ${job.name}`);
    if (!Number.isInteger(job.everySeconds) || job.everySeconds < 1) throw new Error(`Job ${job.name} needs a whole number of seconds`);
    seen.add(job.name);
  }
}

/**
 * Run every job that is due and not running elsewhere, side by side. A job
 * that throws is logged and recorded as failed; the others carry on.
 */
export async function runDueJobs(jobs: readonly Job[], log: JobLogger): Promise<JobResult[]> {
  return Promise.all(
    jobs.map(async (job): Promise<JobResult> => {
      try {
        const result = await withLease(job.name, () => job.run({ name: job.name, log }), { dueAfterSeconds: job.everySeconds });
        if (result.ran && result.tookOverFrom) log.warn({ job: job.name, tookOverFrom: result.tookOverFrom }, 'job lease taken over from a run that stopped');
        return result.ran ? { name: job.name, ran: true, outcome: 'succeeded' } : { name: job.name, ran: false };
      } catch (error) {
        log.error({ job: job.name, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'job failed');
        return { name: job.name, ran: true, outcome: 'failed' };
      }
    }),
  );
}

/** Every tenant's id, through the reviewed function platform.tenant_ids() (ADR 0006, JOB5). */
export async function tenantIds(): Promise<string[]> {
  const result = await db.execute<{ tenant_id: string }>(sql`select tenant_id from platform.tenant_ids()`);
  return result.rows.map((row) => row.tenant_id);
}

/**
 * Do one tenant's share of a job at a time, each in its own transaction as
 * the system actor (JOB5). A tenant whose work throws is logged and the rest
 * carry on, so one tenant's bad row can't stall the others; the job is still
 * recorded as failed at the end.
 */
export async function forEachTenant(
  context: JobContext,
  work: (tx: TenantTx) => Promise<void>,
): Promise<{ tenants: number }> {
  let failed = 0;
  const ids = await tenantIds();
  for (const tenantId of ids) {
    try {
      await withTenant({ tenantId, actor: { type: 'system' }, requestId: `job:${context.name}` }, work);
    } catch (error) {
      failed += 1;
      context.log.error({ job: context.name, tenantId, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'job failed for a tenant');
    }
  }
  if (failed > 0) throw new Error(`${context.name} failed for ${failed} of ${ids.length} tenants`);
  return { tenants: ids.length };
}
