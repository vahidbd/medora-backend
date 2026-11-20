import { and, desc, eq, gte, ne } from 'drizzle-orm';
import { messages, tickets } from '../../db/schema/index.js';
import type { TicketFlag, TicketTopic } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { countTemplateSince, findMessage, queueMessage, recordMessage, senderAddress, type MessageRow } from '../messaging/index.js';
import { findPatientsByContact } from '../patients/index.js';
import { addFlags, changeTicket, insertTicket, loadTicket, openFlags, RECORD, touchTicket, type TicketRow } from './tickets.store.js';
import { SAFETY_REPLY, SAFETY_REPLY_SUBJECT, triage, type Triage } from './triage.js';

/**
 * A message a person sent in, on any channel (docs/decisions/support.md):
 * find or open its ticket, link the patient when exactly one matches, run
 * triage, and send the safety reply when it is needed. One transaction, so
 * the message, its ticket and its flags commit together.
 */

export interface InboundMessage {
  channel: 'email' | 'sms' | 'chat' | 'voice';
  from: string | null;
  to: string | null;
  subject?: string | null;
  body: string;
  brandId: string | null;
  /** The provider's own id (email Message-ID, Twilio MessageSid). */
  providerMessageId?: string | null;
  /** Message ids of ours this one answers (from an email's In-Reply-To and References). */
  answers?: string[];
  attachmentCount?: number;
  /** The signed-in patient app: the patient is known and verified. */
  patient?: { patientId: string; ticketId?: string; topic?: TicketTopic };
  /** A logged call: written up by a person, not received from a provider. */
  logged?: boolean;
  /** The ticket a staff member logged this call on. */
  ticketId?: string;
}

export interface Received {
  ticket: TicketRow;
  message: MessageRow;
  triage: Triage;
  newTicket: boolean;
}

/** An SMS thread with no message in this long starts a new ticket. */
const SMS_THREAD_DAYS = 14;
export const SAFETY_TEMPLATE = 'support.safety_reply';

async function threadFor(tx: TenantTx, input: InboundMessage): Promise<TicketRow | null> {
  if (input.ticketId) return loadTicket(tx, input.ticketId, { lock: true });
  if (input.patient?.ticketId) {
    const ticket = await loadTicket(tx, input.patient.ticketId, { lock: true });
    if (ticket.patientId !== input.patient.patientId || !ticket.patientVisible) throw new BusinessRuleError('That ticket is not yours', 'not_your_ticket');
    return ticket;
  }
  for (const messageId of input.answers ?? []) {
    const answered = await findMessage(tx, messageId);
    if (answered?.ticketId) return loadTicket(tx, answered.ticketId, { lock: true });
  }
  if (input.channel === 'sms' && input.from) {
    const since = new Date(Date.now() - SMS_THREAD_DAYS * 86_400_000);
    const [recent] = await tx.db
      .select({ id: tickets.id })
      .from(tickets)
      .innerJoin(messages, and(eq(messages.tenantId, tickets.tenantId), eq(messages.ticketId, tickets.id)))
      .where(
        and(
          eq(tickets.tenantId, tx.context.tenantId),
          ne(tickets.status, 'solved'),
          gte(tickets.lastMessageAt, since),
          eq(messages.channel, 'sms'),
          eq(messages.direction, 'inbound'),
          eq(messages.fromAddress, input.from),
        ),
      )
      .orderBy(desc(tickets.lastMessageAt))
      .limit(1);
    if (recent) return loadTicket(tx, recent.id, { lock: true });
  }
  return null;
}

/** Exactly one patient with this address, or nobody (SUP8: never by name, never a guess between two). */
async function matchPatient(tx: TenantTx, input: InboundMessage): Promise<string | null> {
  if (!input.from || (input.channel !== 'email' && input.channel !== 'sms')) return null;
  const ids = await findPatientsByContact(tx, input.channel === 'email' ? { email: input.from } : { mobile: input.from });
  return ids.length === 1 ? (ids[0] ?? null) : null;
}

async function sendSafetyReply(tx: TenantTx, ticket: TicketRow, input: InboundMessage): Promise<void> {
  // At most once an hour per ticket, so it can never loop with an auto-responder (SUP4).
  if ((await countTemplateSince(tx, ticket.id, SAFETY_TEMPLATE, new Date(Date.now() - 3_600_000))) > 0) return;
  const common = {
    ticketId: ticket.id,
    patientId: ticket.patientId,
    brandId: ticket.brandId,
    templateKey: SAFETY_TEMPLATE,
    automated: true,
  };
  if (input.channel === 'chat') {
    await recordMessage(tx, {
      ...common,
      direction: 'outbound',
      channel: 'chat',
      kind: 'support',
      status: 'sent',
      body: SAFETY_REPLY,
    });
    return;
  }
  if ((input.channel !== 'email' && input.channel !== 'sms') || !input.from || !ticket.brandId) return;
  const from = await senderAddress(tx, ticket.brandId, input.channel);
  if (!from) return;
  await queueMessage(tx, {
    ...common,
    channel: input.channel,
    kind: 'support',
    from,
    to: input.from,
    subject: input.channel === 'email' ? SAFETY_REPLY_SUBJECT : null,
    body: SAFETY_REPLY,
  });
}

/** Triage only ever raises: it never moves a ticket out of the clinical queue or lowers its priority (SUP3). */
export async function raiseFromTriage(tx: TenantTx, ticket: TicketRow, checked: Triage): Promise<TicketRow> {
  const moveToClinical = checked.clinical && ticket.queue === 'support';
  const raise = checked.urgent && ticket.priority === 'normal';
  if (!moveToClinical && !raise) return ticket;
  return changeTicket(tx, ticket, {
    ...(moveToClinical ? { queue: 'clinical' } : {}),
    ...(raise ? { priority: 'urgent' } : {}),
  });
}

export async function receiveMessage(tx: TenantTx, input: InboundMessage): Promise<Received> {
  const checked = triage(input.subject, input.body);
  let ticket = await threadFor(tx, input);
  const newTicket = ticket === null;
  const careTeam = input.patient?.topic === 'care_team';
  if (!ticket) {
    const patientId = input.patient?.patientId ?? (await matchPatient(tx, input));
    ticket = await insertTicket(tx, {
      channel: input.channel,
      topic: input.patient?.topic ?? 'other',
      brandId: input.brandId,
      patientId,
      queue: checked.clinical || careTeam ? 'clinical' : 'support',
      priority: checked.urgent ? 'urgent' : 'normal',
      patientVisible: input.patient !== undefined,
      verifiedInApp: input.patient !== undefined,
    });
  }
  if (!newTicket) ticket = await raiseFromTriage(tx, ticket, checked);
  const message = await recordMessage(tx, {
    direction: 'inbound',
    channel: input.channel,
    kind: 'support',
    status: input.logged ? 'logged' : 'received',
    from: input.from,
    to: input.to,
    subject: input.subject ?? null,
    body: input.body,
    ticketId: ticket.id,
    patientId: ticket.patientId,
    brandId: ticket.brandId ?? input.brandId,
    attachmentCount: input.attachmentCount ?? 0,
    providerMessageId: input.providerMessageId ?? null,
  });
  await addFlags(tx, ticket, checked.flags, 'triage');
  ticket = await touchTicket(tx, ticket, { reopen: true });
  if (checked.urgent) await sendSafetyReply(tx, ticket, input);
  const flags: TicketFlag[] = (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
  await emitEvent(tx, {
    type: 'ticket.message_received',
    recordTable: RECORD,
    recordId: ticket.id,
    payload: {
      messageId: message.id,
      channel: input.channel,
      queue: ticket.queue,
      priority: ticket.priority,
      flags,
      patientId: ticket.patientId,
      newTicket,
    },
  });
  return { ticket, message, triage: checked, newTicket };
}

/** Whether a message body is an SMS keyword that only opts out (it opens no ticket). */
export function isStopKeyword(body: string): boolean {
  return /^\s*(stop|stopall|unsubscribe|cancel|end|quit)\s*$/i.test(body);
}
