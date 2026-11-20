import type { Job } from '../lib/jobs.js';
import type { EventHandler } from '../lib/outbox-delivery.js';
import { chargingHandlers, noOrdersYet, nothingClearsYet, renewalsJob } from './billing/index.js';
import { ledgerBalanceCheck } from './ledger/index.js';

/**
 * Every module's scheduled jobs and outbox handlers, run by the worker
 * service (src/worker.ts, docs/decisions/jobs.md). A module exports its own
 * from its index.ts and adds them here.
 */
/** Renewals release nothing until consults and orders provide the clearance (BIL24). */
export const moduleJobs: readonly Job[] = [ledgerBalanceCheck, renewalsJob(nothingClearsYet)];

/** Period invoices are charged once issued; until orders answers, no order takes a payment (BIL30). */
export const eventHandlers: readonly EventHandler[] = [...chargingHandlers(noOrdersYet)];
