import { and, eq, isNull, lt, ne, sql } from 'drizzle-orm';
import { tickets } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import { forEachTenant, type Job } from '../../lib/jobs.js';
import { onWebhook, type WebhookDelivery } from '../../lib/webhooks.js';
import { senderByAddress } from '../messaging/index.js';
import { isStopKeyword, receiveMessage } from './inbound.service.js';
import { RECORD } from './tickets.store.js';

/**
 * What reaches the helpdesk without a person: SMS from Twilio's inbox, and
 * the first-response clock (docs/decisions/support.md SUP5, SUP7).
 */

function text(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * An SMS to one of a tenant's numbers. The brand is the one whose number it
 * was sent to; a STOP opens no ticket (Twilio stops sending to that number
 * itself, and marketing SMS goes from a different number, CRM5).
 */
export async function receiveSms(tx: TenantTx, delivery: WebhookDelivery): Promise<void> {
  const body = (delivery.body ?? {}) as Record<string, unknown>;
  const from = text(body, 'From');
  const to = text(body, 'To');
  const words = text(body, 'Body') ?? '';
  if (!from || isStopKeyword(words)) return;
  const sender = to ? await senderByAddress(tx, 'sms', to) : null;
  await receiveMessage(tx, {
    channel: 'sms',
    from,
    to,
    body: words,
    brandId: sender?.brandId ?? null,
    providerMessageId: delivery.providerEventId,
    attachmentCount: Number.parseInt(text(body, 'NumMedia') ?? '0', 10) || 0,
  });
}

export function registerSupportWebhooks(): void {
  onWebhook('twilio', 'sms.inbound', receiveSms);
}

/** Write ticket.overdue once for each ticket whose first reply is late (SUP5). Ids only. */
export async function markOverdue(tx: TenantTx): Promise<number> {
  const late = await tx.db
    .update(tickets)
    .set({ overdueNotifiedAt: sql`now()` })
    .where(
      and(
        eq(tickets.tenantId, tx.context.tenantId),
        isNull(tickets.firstRespondedAt),
        isNull(tickets.overdueNotifiedAt),
        ne(tickets.status, 'solved'),
        lt(tickets.firstResponseDueAt, sql`now()`),
      ),
    )
    .returning({
      id: tickets.id,
      queue: tickets.queue,
      priority: tickets.priority,
      patientId: tickets.patientId,
      dueAt: tickets.firstResponseDueAt,
    });
  for (const row of late) {
    const facts = {
      queue: row.queue,
      priority: row.priority,
      dueAt: row.dueAt.toISOString(),
    };
    await audit(tx, {
      action: 'ticket.overdue',
      zone: 'operational',
      recordTable: RECORD,
      recordId: row.id,
      details: facts,
    });
    await emitEvent(tx, {
      type: 'ticket.overdue',
      recordTable: RECORD,
      recordId: row.id,
      payload: { ...facts, patientId: row.patientId },
    });
  }
  return late.length;
}

export const overdueJob: Job = {
  name: 'support-overdue',
  everySeconds: 300,
  run: async (context) => {
    await forEachTenant(context, async (tx) => {
      await markOverdue(tx);
    });
  },
};
