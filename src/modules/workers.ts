import type { Job } from '../lib/jobs.js';
import type { EventHandler } from '../lib/outbox-delivery.js';
import { messageDelivery, registerDeliveryWebhooks, unconfirmedSweep } from './messaging/index.js';
import { overdueJob, registerSupportWebhooks } from './support/index.js';

/**
 * Every module's scheduled jobs and outbox handlers, run by the worker
 * service (src/worker.ts, docs/decisions/jobs.md). A module exports its own
 * from its index.ts and adds them here.
 */
// Webhook deliveries the inbox retries are processed in the worker too.
registerDeliveryWebhooks();
registerSupportWebhooks();

export const moduleJobs: readonly Job[] = [unconfirmedSweep, overdueJob];

export const eventHandlers: readonly EventHandler[] = [messageDelivery];
