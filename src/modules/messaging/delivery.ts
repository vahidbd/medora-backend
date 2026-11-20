import { and, eq, lt, sql } from 'drizzle-orm';
import { messages } from '../../db/schema/index.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { AppError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { forEachTenant, type Job } from '../../lib/jobs.js';
import type { DeliveredEvent, EventHandler } from '../../lib/outbox-delivery.js';
import { onWebhook, type WebhookDelivery } from '../../lib/webhooks.js';
import { sendSms } from '../telephony/index.js';
import { emailSender } from './email.js';
import type { MessageRow } from './messages.service.js';

/**
 * Delivery (docs/decisions/messaging.md CRM2). A queued message is sent
 * after the change that queued it committed, at most once: the handler first
 * claims the row (queued to sending) in its own transaction, then calls the
 * provider, then records what happened. A handler that runs again finds the
 * row already claimed and does nothing, so a retry never sends twice; a row
 * left in sending (the process died mid-call) is marked failed with
 * `unconfirmed` by the sweep, so a person can check and resend.
 */

const RECORD = 'clinical.messages' as const;
const system = (tenantId: string, requestId: string): TenantContext => ({
  tenantId,
  actor: { type: 'system' },
  requestId,
});

/** Our Message-ID for an email, so a reply's In-Reply-To finds its message (and its ticket). */
export function emailMessageId(message: Pick<MessageRow, 'id' | 'fromAddress'>): string {
  const domain = (message.fromAddress ?? '').split('@')[1] || 'medora.invalid';
  return `<${message.id}@${domain}>`;
}

async function claim(tx: TenantTx, messageId: string): Promise<MessageRow | null> {
  const [row] = await tx.db
    .update(messages)
    .set({ status: 'sending', sendingAt: sql`now()` })
    .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.id, messageId), eq(messages.status, 'queued')))
    .returning();
  return row ?? null;
}

async function previousMessageHeader(tx: TenantTx, message: MessageRow): Promise<string | null> {
  if (!message.ticketId) return null;
  const [previous] = await tx.db
    .select({
      id: messages.id,
      fromAddress: messages.fromAddress,
      direction: messages.direction,
      providerMessageId: messages.providerMessageId,
    })
    .from(messages)
    .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.ticketId, message.ticketId), eq(messages.channel, 'email'), lt(messages.createdAt, message.createdAt)))
    .orderBy(sql`${messages.createdAt} desc`)
    .limit(1);
  if (!previous) return null;
  // Theirs is the provider's Message-ID as it arrived; ours is the one we set.
  return previous.direction === 'inbound' ? previous.providerMessageId : emailMessageId(previous);
}

async function send(message: MessageRow, replyTo: string | null): Promise<string> {
  if (message.channel === 'sms') {
    const { providerMessageId } = await sendSms({
      tenantId: message.tenantId,
      to: message.toAddress ?? '',
      from: message.fromAddress ?? '',
      body: message.body,
    });
    return providerMessageId;
  }
  const headers: Record<string, string> = {
    'Message-ID': emailMessageId(message),
  };
  if (replyTo) {
    headers['In-Reply-To'] = replyTo;
    headers['References'] = replyTo;
  }
  if (message.automated) headers['Auto-Submitted'] = 'auto-replied';
  const { providerMessageId } = await emailSender().send({
    tenantId: message.tenantId,
    from: message.fromAddress ?? '',
    to: message.toAddress ?? '',
    subject: message.subject ?? '',
    text: message.body,
    headers,
  });
  return providerMessageId;
}

function failureCodeOf(error: unknown): string {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[a-z0-9_.:-]{1,60}$/i.test(code) ? code : 'provider_error';
}

export async function deliverMessage(event: Pick<DeliveredEvent, 'tenantId' | 'recordId' | 'id'>): Promise<'sent' | 'failed' | 'skipped'> {
  const requestId = `event:${event.id}`;
  const claimed = await withTenant(system(event.tenantId, requestId), async (tx) => {
    const message = await claim(tx, event.recordId);
    return message
      ? {
          message,
          replyTo: message.channel === 'email' ? await previousMessageHeader(tx, message) : null,
        }
      : null;
  });
  if (!claimed) return 'skipped';
  const { message } = claimed;
  let providerMessageId: string | null = null;
  let failureCode: string | null = null;
  try {
    providerMessageId = await send(message, claimed.replyTo);
  } catch (error) {
    failureCode = failureCodeOf(error);
  }
  await withTenant(system(event.tenantId, requestId), async (tx) => {
    const facts = { channel: message.channel, ticketId: message.ticketId };
    if (providerMessageId) {
      await tx.db
        .update(messages)
        .set({ status: 'sent', sentAt: sql`now()`, providerMessageId })
        .where(and(eq(messages.id, message.id), eq(messages.status, 'sending')));
      await audit(tx, {
        action: 'message.sent',
        zone: 'clinical',
        recordTable: RECORD,
        recordId: message.id,
        details: facts,
      });
    } else {
      await tx.db
        .update(messages)
        .set({ status: 'failed', failedAt: sql`now()`, failureCode })
        .where(and(eq(messages.id, message.id), eq(messages.status, 'sending')));
      await audit(tx, {
        action: 'message.failed',
        zone: 'clinical',
        recordTable: RECORD,
        recordId: message.id,
        details: { ...facts, failureCode },
      });
      await emitEvent(tx, {
        type: 'message.failed',
        recordTable: RECORD,
        recordId: message.id,
        payload: { ...facts, failureCode, patientId: message.patientId },
      });
    }
  });
  return providerMessageId ? 'sent' : 'failed';
}

export const messageDelivery: EventHandler = {
  name: 'messaging-delivery',
  eventTypes: ['message.queued'],
  handle: async (event) => {
    await deliverMessage(event);
  },
};

/** Minutes a message may sit in sending, from when delivery claimed it, before the sweep calls it unconfirmed. */
export const SENDING_STUCK_MINUTES = 15;

export async function sweepUnconfirmed(tx: TenantTx): Promise<number> {
  const stuck = await tx.db
    .update(messages)
    .set({ status: 'failed', failedAt: sql`now()`, failureCode: 'unconfirmed' })
    .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.status, 'sending'), sql`${messages.sendingAt} < now() - make_interval(mins => ${SENDING_STUCK_MINUTES})`))
    .returning({
      id: messages.id,
      channel: messages.channel,
      ticketId: messages.ticketId,
      patientId: messages.patientId,
    });
  for (const row of stuck) {
    const facts = {
      channel: row.channel,
      ticketId: row.ticketId,
      failureCode: 'unconfirmed',
    };
    await audit(tx, {
      action: 'message.failed',
      zone: 'clinical',
      recordTable: RECORD,
      recordId: row.id,
      details: facts,
    });
    await emitEvent(tx, {
      type: 'message.failed',
      recordTable: RECORD,
      recordId: row.id,
      payload: { ...facts, patientId: row.patientId },
    });
  }
  return stuck.length;
}

export const unconfirmedSweep: Job = {
  name: 'messaging-unconfirmed-sweep',
  everySeconds: 300,
  run: async (context) => {
    await forEachTenant(context, async (tx) => {
      await sweepUnconfirmed(tx);
    });
  },
};

/** Twilio's delivery statuses, mapped to ours. Anything else (queued, accepted, sending) changes nothing. */
const SMS_STATUS: Record<string, 'sent' | 'delivered' | 'failed'> = {
  sent: 'sent',
  delivered: 'delivered',
  undelivered: 'failed',
  failed: 'failed',
};

/** The statuses each status webhook may move a message on from: they can arrive out of order, and never move one back. */
const MOVES_FROM: Record<'sent' | 'delivered' | 'failed', readonly string[]> = {
  sent: ['sending'],
  delivered: ['sending', 'sent'],
  failed: ['sending', 'sent'],
};

/** Thrown so the webhook inbox records the code and tries the delivery again (WHK). */
export class UnknownProviderMessageError extends AppError {
  constructor() {
    super(409, 'unknown_provider_message', 'No message has that provider id yet');
  }
}

/** Twilio's word on an SMS we sent: sent, delivered, or not. */
export async function smsStatus(tx: TenantTx, delivery: WebhookDelivery): Promise<void> {
  const body = (delivery.body ?? {}) as Record<string, unknown>;
  const sid = typeof body['MessageSid'] === 'string' ? body['MessageSid'] : '';
  const status = SMS_STATUS[typeof body['MessageStatus'] === 'string' ? body['MessageStatus'] : ''];
  if (!sid || !status) return;
  const [row] = await tx.db
    .select({
      id: messages.id,
      status: messages.status,
      ticketId: messages.ticketId,
      patientId: messages.patientId,
    })
    .from(messages)
    .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.channel, 'sms'), eq(messages.providerMessageId, sid)))
    .for('update');
  // The webhook can beat our own record of the send by a moment: fail, and the inbox tries again (WHK).
  if (!row) throw new UnknownProviderMessageError();
  if (!MOVES_FROM[status].includes(row.status)) return;
  const code = typeof body['ErrorCode'] === 'string' && /^\d{1,6}$/.test(body['ErrorCode']) ? `twilio_${body['ErrorCode']}` : 'undelivered';
  const change = status === 'delivered' ? { status, deliveredAt: sql`now()` } : status === 'failed' ? { status, failedAt: sql`now()`, failureCode: code } : { status };
  await tx.db.update(messages).set(change).where(eq(messages.id, row.id));
  await audit(tx, {
    action: `message.${status}`,
    zone: 'clinical',
    recordTable: RECORD,
    recordId: row.id,
    details: { channel: 'sms', ticketId: row.ticketId },
  });
  if (status === 'failed') {
    await emitEvent(tx, {
      type: 'message.failed',
      recordTable: RECORD,
      recordId: row.id,
      payload: {
        channel: 'sms',
        ticketId: row.ticketId,
        failureCode: code,
        patientId: row.patientId,
      },
    });
  }
}

export function registerDeliveryWebhooks(): void {
  onWebhook('twilio', 'sms.status', smsStatus);
}
