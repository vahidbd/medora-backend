import pino from 'pino';
import { env } from './config/env.js';
import { checkDatabaseRole, closeDatabase } from './db/health.js';
import { flushErrorTracking, reportError, startErrorTracking } from './lib/error-tracking.js';
import { assertJobsValid, runDueJobs } from './lib/jobs.js';
import { expireHeldLeases } from './lib/leases.js';
import { outboxDeliveryJob } from './lib/outbox-delivery.js';
import { REDACT_PATHS } from './lib/redact.js';
import { eventHandlers, moduleJobs } from './modules/workers.js';

/**
 * The worker service (ADR 0029): scheduled jobs and outbox delivery, apart
 * from the API so heavy or slow work never competes with requests. Every few
 * seconds it runs whichever jobs are due; leases keep each job to one run at a
 * time across every copy of the worker (docs/decisions/jobs.md).
 */
const TICK_MS = 1_000;

startErrorTracking({ dsn: env.SENTRY_DSN, environment: env.MEDORA_ENV, release: env.RELEASE_SHA, service: 'worker' });

const log = pino({ level: env.LOG_LEVEL, redact: { paths: REDACT_PATHS, censor: '[redacted]' } });
const jobs = [outboxDeliveryJob(eventHandlers), ...moduleJobs];

let stopping = false;
let current: Promise<unknown> = Promise.resolve();

try {
  assertJobsValid(jobs);
  // Refuse to run on a role row-level security doesn't bind (ADR 0025).
  await checkDatabaseRole();
} catch (error) {
  log.fatal({ error: error instanceof Error ? error.message : 'unknown' }, 'worker failed to start');
  reportError(error, { tags: { phase: 'start' } });
  await flushErrorTracking();
  process.exit(1);
}

log.info({ jobs: jobs.map((job) => job.name), release: env.RELEASE_SHA ?? 'development' }, 'worker started');

async function tick(): Promise<void> {
  if (stopping) return;
  current = runDueJobs(jobs, log).catch((error: unknown) => {
    reportError(error, { tags: { phase: 'tick' } });
  });
  await current;
  if (!stopping) setTimeout(() => void tick(), TICK_MS);
}

void tick();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    stopping = true;
    log.info({ signal }, 'worker shutting down');
    // Give running jobs a few seconds, then hand their leases on at once.
    const deadline = new Promise((resolve) => setTimeout(resolve, 8_000).unref());
    await Promise.race([current, deadline]);
    await expireHeldLeases().catch(() => 0);
    await closeDatabase();
    await flushErrorTracking();
    process.exit(0);
  });
}
