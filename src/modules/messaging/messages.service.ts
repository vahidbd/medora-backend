import { and, eq, sql } from 'drizzle-orm';
import { messages } from '../../db/schema/index.js';
import type { Channel, MessageDirection, MessageKind, MessageStatus, SenderChannel } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { emailIsOn } from './email.js';

/**
 * The one way a message is written (ADR 0027, docs/decisions/messaging.md
 * CRM1). Outbound email and SMS are queued here and sent after commit by the
 * delivery handler (CRM2); inbound messages, chat lines and logged calls are
 * recorded as they are. Text is never edited afterwards (CRM4, ADR 0028).
 */

export type MessageRow = typeof messages.$inferSelect;

const RECORD = 'clinical.messages' as const;

function authorOf(tx: TenantTx): {
  authorType: 'person' | 'agent' | 'system';
  authorId: string | null;
} {
  const { actor } = tx.context;
  if (actor.type === 'person') return { authorType: 'person', authorId: actor.userId };
  if (actor.type === 'agent') return { authorType: 'agent', authorId: actor.agentId };
  return { authorType: 'system', authorId: null };
}

export interface QueueInput {
  channel: SenderChannel;
  kind: MessageKind;
  from: string;
  to: string;
  subject?: string | null;
  body: string;
  ticketId?: string | null;
  patientId?: string | null;
  brandId?: string | null;
  templateKey?: string | null;
  automated?: boolean;
  /** "Send this once": a second call with the same key returns the first message (ADR 0029). */
  idempotencyKey?: string | null;
}

/** Queue an email or SMS. It goes out after this transaction commits (CRM2). */
export async function queueMessage(tx: TenantTx, input: QueueInput): Promise<{ message: MessageRow; created: boolean }> {
  if (input.channel === 'email' && !emailIsOn()) throw new BusinessRuleError("Email isn't set up for this service yet", 'email_off');
  if (input.channel === 'email' && !input.subject) throw new BusinessRuleError('An email needs a subject', 'subject_required');
  if (input.idempotencyKey) {
    const [existing] = await tx.db
      .select()
      .from(messages)
      .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.idempotencyKey, input.idempotencyKey)));
    if (existing) return { message: existing, created: false };
  }
  const [message] = await tx.db
    .insert(messages)
    .values({
      tenantId: tx.context.tenantId,
      ticketId: input.ticketId ?? null,
      patientId: input.patientId ?? null,
      brandId: input.brandId ?? null,
      direction: 'outbound',
      channel: input.channel,
      kind: input.kind,
      status: 'queued',
      fromAddress: input.from,
      toAddress: input.to,
      subject: input.channel === 'email' ? (input.subject ?? null) : null,
      body: input.body,
      templateKey: input.templateKey ?? null,
      automated: input.automated ?? false,
      ...authorOf(tx),
      idempotencyKey: input.idempotencyKey ?? null,
    })
    .returning();
  if (!message) throw new Error('message insert returned nothing');
  const facts = {
    channel: input.channel,
    kind: input.kind,
    ticketId: input.ticketId ?? null,
    automated: message.automated,
  };
  await audit(tx, {
    action: 'message.queued',
    zone: 'clinical',
    recordTable: RECORD,
    recordId: message.id,
    details: facts,
  });
  await emitEvent(tx, {
    type: 'message.queued',
    recordTable: RECORD,
    recordId: message.id,
    payload: { ...facts, patientId: message.patientId },
  });
  return { message, created: true };
}

export interface RecordInput {
  direction: MessageDirection;
  channel: Channel;
  kind: MessageKind;
  status: Extract<MessageStatus, 'received' | 'logged' | 'sent'>;
  from?: string | null;
  to?: string | null;
  subject?: string | null;
  body: string;
  ticketId?: string | null;
  patientId?: string | null;
  brandId?: string | null;
  templateKey?: string | null;
  automated?: boolean;
  attachmentCount?: number;
  providerMessageId?: string | null;
}

/**
 * Record a message that needs no sending: one that came in, a chat line the
 * patient app shows, or a call a person wrote up.
 */
export async function recordMessage(tx: TenantTx, input: RecordInput): Promise<MessageRow> {
  const [message] = await tx.db
    .insert(messages)
    .values({
      tenantId: tx.context.tenantId,
      ticketId: input.ticketId ?? null,
      patientId: input.patientId ?? null,
      brandId: input.brandId ?? null,
      direction: input.direction,
      channel: input.channel,
      kind: input.kind,
      status: input.status,
      fromAddress: input.from ?? null,
      toAddress: input.to ?? null,
      subject: input.subject ?? null,
      body: input.body,
      templateKey: input.templateKey ?? null,
      automated: input.automated ?? false,
      ...authorOf(tx),
      attachmentCount: input.attachmentCount ?? 0,
      providerMessageId: input.providerMessageId ?? null,
      sentAt: input.status === 'sent' ? sql`now()` : null,
    })
    .returning();
  if (!message) throw new Error('message insert returned nothing');
  const action = input.direction === 'inbound' ? 'message.received' : 'message.recorded';
  await audit(tx, {
    action,
    zone: 'clinical',
    recordTable: RECORD,
    recordId: message.id,
    details: {
      channel: input.channel,
      ticketId: input.ticketId ?? null,
      attachments: message.attachmentCount,
    },
  });
  return message;
}

export async function findMessage(tx: TenantTx, messageId: string): Promise<MessageRow | null> {
  const [row] = await tx.db
    .select()
    .from(messages)
    .where(and(eq(messages.tenantId, tx.context.tenantId), eq(messages.id, messageId)));
  return row ?? null;
}

/** Automated messages on a ticket with one template since a moment, e.g. the safety reply in the last hour (SUP4). */
export async function countTemplateSince(tx: TenantTx, ticketId: string, templateKey: string, since: Date): Promise<number> {
  const [row] = await tx.db
    .select({ n: sql<number>`count(*)::int` })
    .from(messages)
    .where(
      and(eq(messages.tenantId, tx.context.tenantId), eq(messages.ticketId, ticketId), eq(messages.templateKey, templateKey), sql`${messages.createdAt} >= ${since.toISOString()}`),
    );
  return row?.n ?? 0;
}
