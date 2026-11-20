import { and, eq, isNull } from 'drizzle-orm';
import { macros, ticketComments } from '../../db/schema/index.js';
import type { TicketQueue, TicketPriority, TicketStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { messagesOfTickets, queueMessage, recordMessage, senderAddress, type MessageRow } from '../messaging/index.js';
import { assertCanReadText, assertCanReply, type Viewer } from './access.js';
import { raiseFromTriage, receiveMessage } from './inbound.service.js';
import { countsAsFirstResponse } from './sla.js';
import { replyRouteOf } from './tickets.service.js';
import { addFlags, changeTicket, loadTicket, openFlags, RECORD, touchTicket, type TicketRow } from './tickets.store.js';
import { triage } from './triage.js';

/**
 * Writing on a ticket (docs/decisions/support.md): a reply to the person, a
 * call logged by staff, and a comment only staff see. Text is never edited
 * afterwards; a correction is a new message or comment (ADR 0028).
 */

export interface ReplyInput {
  body: string;
  /** The approved macro the reply started from (SUP10). */
  macroId?: string | undefined;
  /** What the ticket becomes once the reply is sent; waiting by default. */
  status?: Extract<TicketStatus, 'waiting' | 'solved'> | undefined;
}

function authorTypeOf(viewer: Viewer): 'person' | 'agent' | 'system' {
  return viewer.actor.type === 'person' ? 'person' : viewer.actor.type === 'agent' ? 'agent' : 'system';
}

async function assertApprovedMacro(tx: TenantTx, macroId: string): Promise<void> {
  const [row] = await tx.db
    .select({ status: macros.status })
    .from(macros)
    .where(and(eq(macros.tenantId, tx.context.tenantId), eq(macros.id, macroId), isNull(macros.archivedAt)));
  if (!row) throw new NotFoundError('Macro');
  if (row.status !== 'approved') throw new BusinessRuleError('Only an approved macro can be used in a reply', 'macro_not_approved');
}

function replySubject(subject: string | null): string {
  if (!subject) return 'Your message';
  return /^re:/i.test(subject) ? subject : `Re: ${subject}`;
}

/** Send a reply back the way the person last wrote in (SUP8), from the brand's service address. */
async function sendReply(tx: TenantTx, ticket: TicketRow, history: MessageRow[], input: ReplyInput, automated: boolean): Promise<MessageRow> {
  const route = replyRouteOf(history);
  if (!route) throw new BusinessRuleError('Nobody has written in on a channel we can reply on', 'no_reply_channel');
  const templateKey = input.macroId ? `macro:${input.macroId}` : null;
  const common = {
    ticketId: ticket.id,
    patientId: ticket.patientId,
    brandId: ticket.brandId,
    kind: 'support' as const,
    body: input.body,
    templateKey,
    automated,
  };
  if (route.channel === 'chat')
    return recordMessage(tx, {
      ...common,
      direction: 'outbound',
      channel: 'chat',
      status: 'sent',
    });
  if (!ticket.brandId) throw new BusinessRuleError("This ticket has no brand, so there's no address to reply from", 'no_brand');
  const from = await senderAddress(tx, ticket.brandId, route.channel);
  if (!from) throw new BusinessRuleError(`Set the brand's ${route.channel === 'sms' ? 'SMS number' : 'email address'} first`, 'no_sender');
  const { message } = await queueMessage(tx, {
    ...common,
    channel: route.channel,
    from,
    to: route.to ?? '',
    subject: route.channel === 'email' ? replySubject(route.subject) : null,
  });
  return message;
}

export async function replyToTicket(tx: TenantTx, viewer: Viewer, ticketId: string, input: ReplyInput): Promise<{ ticket: TicketRow; message: MessageRow }> {
  let ticket = await loadTicket(tx, ticketId, { lock: true });
  const flags = (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
  assertCanReply(viewer, { queue: ticket.queue as TicketQueue, flags });
  if (input.macroId) await assertApprovedMacro(tx, input.macroId);
  // Every message an agent sends is labelled automated (SUP12).
  const automated = viewer.actor.type === 'agent';
  const history = await messagesOfTickets(tx, [ticket.id]);
  const message = await sendReply(tx, ticket, history, input, automated);
  const firstResponse = countsAsFirstResponse({
    queue: ticket.queue as TicketQueue,
    priority: ticket.priority as TicketPriority,
    authorType: authorTypeOf(viewer),
    automated,
  });
  ticket = await touchTicket(tx, ticket, { firstResponse });
  ticket = await changeTicket(tx, ticket, {
    status: input.status ?? 'waiting',
  });
  await emitEvent(tx, {
    type: 'ticket.replied',
    recordTable: RECORD,
    recordId: ticket.id,
    payload: {
      messageId: message.id,
      channel: message.channel,
      queue: ticket.queue,
      automated,
      patientId: ticket.patientId,
    },
  });
  return { ticket, message };
}

export interface CallInput {
  direction: 'inbound' | 'outbound';
  /** What was said, written up by the person who took the call. No recording, no transcript (SUP7). */
  summary: string;
  /** The number the call came from or went to, when known. */
  phone?: string | null | undefined;
}

/**
 * Log a call on a ticket. An inbound call is a message from the person, so
 * it is triaged like any other; an outbound call is triaged too, since
 * what was said can still be clinical (SUP3).
 */
export async function logCall(tx: TenantTx, viewer: Viewer, ticketId: string, input: CallInput): Promise<{ ticket: TicketRow; message: MessageRow }> {
  if (viewer.actor.type !== 'person') throw new ForbiddenError('Only a staff member logs a call', 'person_only');
  const existing = await loadTicket(tx, ticketId, { lock: true });
  assertCanReadText(viewer, existing.queue as TicketQueue);
  if (input.direction === 'inbound') {
    const received = await receiveMessage(tx, {
      channel: 'voice',
      from: input.phone ?? null,
      to: null,
      body: input.summary,
      brandId: existing.brandId,
      logged: true,
      ticketId,
    });
    return { ticket: received.ticket, message: received.message };
  }
  const checked = triage(input.summary);
  let ticket = await raiseFromTriage(tx, existing, checked);
  const message = await recordMessage(tx, {
    direction: 'outbound',
    channel: 'voice',
    kind: 'support',
    status: 'logged',
    to: input.phone ?? null,
    body: input.summary,
    ticketId: ticket.id,
    patientId: ticket.patientId,
    brandId: ticket.brandId,
  });
  await addFlags(tx, ticket, checked.flags, 'triage');
  ticket = await touchTicket(tx, ticket, {
    firstResponse: countsAsFirstResponse({
      queue: ticket.queue as TicketQueue,
      priority: ticket.priority as TicketPriority,
      authorType: 'person',
      automated: false,
    }),
  });
  await emitEvent(tx, {
    type: 'ticket.call_logged',
    recordTable: RECORD,
    recordId: ticket.id,
    payload: {
      messageId: message.id,
      direction: 'outbound',
      queue: ticket.queue,
      patientId: ticket.patientId,
    },
  });
  return { ticket, message };
}

/** A comment only staff see (glossary: Comment). Never sent, never shown in the patient app. */
export async function addComment(tx: TenantTx, viewer: Viewer, ticketId: string, body: string) {
  if (viewer.actor.type !== 'person') throw new ForbiddenError('Only a staff member writes a comment', 'person_only');
  const ticket = await loadTicket(tx, ticketId);
  assertCanReadText(viewer, ticket.queue as TicketQueue);
  const [row] = await tx.db
    .insert(ticketComments)
    .values({
      tenantId: tx.context.tenantId,
      ticketId: ticket.id,
      authorUserId: viewer.actor.userId,
      body,
    })
    .returning();
  if (!row) throw new Error('comment insert returned nothing');
  await audit(tx, {
    action: 'ticket.commented',
    zone: 'clinical',
    recordTable: 'clinical.ticket_comments',
    recordId: row.id,
    details: { ticketId: ticket.id },
  });
  return {
    commentId: row.id,
    authorUserId: row.authorUserId,
    body: row.body,
    createdAt: row.createdAt.toISOString(),
  };
}
