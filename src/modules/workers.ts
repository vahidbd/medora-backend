import type { Job } from '../lib/jobs.js';
import type { EventHandler } from '../lib/outbox-delivery.js';
import { ledgerBalanceCheck } from './ledger/index.js';

/**
 * Every module's scheduled jobs and outbox handlers, run by the worker
 * service (src/worker.ts, docs/decisions/jobs.md). A module exports its own
 * from its index.ts and adds them here.
 */
export const moduleJobs: readonly Job[] = [ledgerBalanceCheck];

export const eventHandlers: readonly EventHandler[] = [];
