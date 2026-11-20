import { and, eq } from 'drizzle-orm';
import { messages } from '../../db/schema/index.js';
import type { MessageKind, SenderChannel } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { emailIsOn } from './email.js';

/**
 * The one way an email or SMS is written (ADR 0027, docs/decisions/messaging.md
 * CRM1). It is queued here and sent after commit by the delivery handler
 * (CRM2). Text is never edited afterwards (CRM4, ADR 0028).
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
  /** The helpdesk ticket it belongs to, if any. */
  ticketId?: string | null;
  patientId?: string | null;
  /** The brand it is sent as. */
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
