import { and, desc, eq } from 'drizzle-orm';
import { tickets } from '../../db/schema/index.js';
import type { TicketTopic } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { latestMessages, messagesOfTickets, type MessageRow } from '../messaging/index.js';
import { receiveMessage } from './inbound.service.js';
import { loadTicket, RECORD, type TicketRow } from './tickets.store.js';

/**
 * The patient app's Messages (APP-04, docs/decisions/support.md SUP13): the
 * one message store, seen from the patient's side. A patient sees only the
 * tickets they opened in the app, their own messages and the replies, never
 * a comment, a flag, a queue or who on the staff wrote.
 */

export type PatientTopic = Exclude<TicketTopic, 'other'>;

function patientStatus(ticket: TicketRow): 'open' | 'answered' | 'closed' {
  if (ticket.status === 'solved') return 'closed';
  return ticket.status === 'waiting' ? 'answered' : 'open';
}

function messageForPatient(message: MessageRow) {
  return {
    messageId: message.id,
    from: message.direction === 'inbound' ? ('you' as const) : message.automated ? ('automatic' as const) : ('team' as const),
    body: message.body,
    createdAt: message.createdAt.toISOString(),
  };
}

async function ownTicket(tx: TenantTx, patientId: string, ticketId: string): Promise<TicketRow> {
  const ticket = await loadTicket(tx, ticketId).catch(() => null);
  // Someone else's ticket, or one staff opened, is "not found" to the patient: it doesn't exist for them.
  if (!ticket || ticket.patientId !== patientId || !ticket.patientVisible) throw new NotFoundError('Ticket');
  return ticket;
}

export async function listPatientTickets(tx: TenantTx, patientId: string) {
  const rows = await tx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.tenantId, tx.context.tenantId), eq(tickets.patientId, patientId), eq(tickets.patientVisible, true)))
    .orderBy(desc(tickets.lastMessageAt))
    .limit(100);
  const latest = await latestMessages(
    tx,
    rows.map((row) => row.id),
  );
  const items = [];
  for (const row of rows) {
    const newest = latest.get(row.id);
    const last = newest?.status === 'logged' ? undefined : newest;
    if (last)
      await audit(tx, {
        action: 'ticket.previewed',
        zone: 'clinical',
        recordTable: RECORD,
        recordId: row.id,
        details: { messageId: last.id },
      });
    items.push({
      ticketId: row.id,
      topic: row.topic as PatientTopic,
      status: patientStatus(row),
      lastMessageAt: row.lastMessageAt.toISOString(),
      lastMessage: last ? messageForPatient(last) : null,
    });
  }
  return { tickets: items };
}

export async function getPatientTicket(tx: TenantTx, patientId: string, ticketId: string) {
  const ticket = await ownTicket(tx, patientId, ticketId);
  // A call staff logged is their write-up, not something the patient sent or was sent.
  const messages = (await messagesOfTickets(tx, [ticket.id])).filter((message) => message.status !== 'logged');
  await audit(tx, {
    action: 'ticket.viewed',
    zone: 'clinical',
    recordTable: RECORD,
    recordId: ticket.id,
    details: { messages: messages.length },
  });
  return {
    ticketId: ticket.id,
    topic: ticket.topic as PatientTopic,
    status: patientStatus(ticket),
    createdAt: ticket.createdAt.toISOString(),
    messages: messages.map(messageForPatient),
  };
}

/** A patient opens a ticket in the app. Care-team ones go to the clinical queue (SUP13). */
export async function openPatientTicket(
  tx: TenantTx,
  patientId: string,
  input: {
    topic: PatientTopic;
    subject?: string | null | undefined;
    body: string;
  },
) {
  const received = await receiveMessage(tx, {
    channel: 'chat',
    from: null,
    to: null,
    subject: input.subject ?? null,
    body: input.body,
    brandId: null,
    patient: { patientId, topic: input.topic },
  });
  return getPatientTicket(tx, patientId, received.ticket.id);
}

export async function postPatientMessage(tx: TenantTx, patientId: string, ticketId: string, body: string) {
  await ownTicket(tx, patientId, ticketId);
  await receiveMessage(tx, {
    channel: 'chat',
    from: null,
    to: null,
    body,
    brandId: null,
    patient: { patientId, ticketId },
  });
  return getPatientTicket(tx, patientId, ticketId);
}
