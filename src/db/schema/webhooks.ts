import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants } from './platform.js';
import { WEBHOOK_PROVIDERS, WEBHOOK_STATUSES } from './values.js';
import { platform } from './zones.js';

/**
 * Webhooks from outside services, stored before they are processed and
 * processed once per provider event id (ADR 0029, docs/decisions/webhooks.md).
 * Written only by src/lib/webhooks.ts. `last_error` is an error code, never
 * text from the body.
 */
export const webhookInbox = platform.table(
  'webhook_inbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    provider: text('provider').notNull(),
    /** The provider's own id for this delivery, so a retried delivery is stored once. */
    providerEventId: text('provider_event_id').notNull(),
    /** Which handler processes it, e.g. `sms.inbound`. */
    kind: text('kind').notNull(),
    body: jsonb('body').notNull(),
    requestId: text('request_id'),
    status: text('status').notNull().default('received'),
    attempts: integer('attempts').notNull().default(0),
    lastError: text('last_error'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    processedAt: timestamp('processed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('webhook_inbox_delivery_key').on(table.tenantId, table.provider, table.providerEventId),
    // So consult evidence can point at its delivery within its own tenant (docs/decisions/consults.md CNS2).
    unique('webhook_inbox_tenant_id_key').on(table.tenantId, table.id),
    index('webhook_inbox_pending_idx').on(table.tenantId, table.status, table.id),
    check('webhook_inbox_provider_check', oneOf(table.provider, WEBHOOK_PROVIDERS)),
    check('webhook_inbox_status_check', oneOf(table.status, WEBHOOK_STATUSES)),
    check('webhook_inbox_processed_check', sql`(${table.status} = 'processed') = (${table.processedAt} is not null)`),
  ],
);
