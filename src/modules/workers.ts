import type { Job } from '../lib/jobs.js';
import type { EventHandler } from '../lib/outbox-delivery.js';
import { type ChargeDeps, chargingHandlers, noOrdersYet, nothingClearsYet, renewalsJob, retriesJob } from './billing/index.js';
import { ledgerBalanceCheck } from './ledger/index.js';

/**
 * Every module's scheduled jobs and outbox handlers, run by the worker
 * service (src/worker.ts, docs/decisions/jobs.md). A module exports its own
 * from its index.ts and adds them here.
 */
/** Until consults and orders provide them, nothing is cleared, so nothing is issued or charged, and no order takes a payment (BIL24, BIL30). */
const billing: ChargeDeps = { clearances: nothingClearsYet, orders: noOrdersYet };

export const moduleJobs: readonly Job[] = [ledgerBalanceCheck, renewalsJob(billing.clearances), retriesJob(billing)];

/** Period invoices are charged once issued, and past-due ones again on a new card (BIL28, BIL31). */
export const eventHandlers: readonly EventHandler[] = [...chargingHandlers(billing)];
