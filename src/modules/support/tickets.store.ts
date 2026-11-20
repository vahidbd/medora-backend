import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { ticketFlags, tickets } from '../../db/schema/index.js';
import type { Channel, TicketFlag, TicketPriority, TicketQueue, TicketStatus, TicketTopic } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { firstResponseDue } from './sla.js';

/**
 * Rows of operational.tickets and ticket_flags, and the writes every path
 * shares. The only writer of both tables (ADR 0027).
 */

export type TicketRow = typeof tickets.$inferSelect;
export const RECORD = 'operational.tickets' as const;

export async function loadTicket(tx: TenantTx, ticketId: string, options: { lock?: boolean } = {}): Promise<TicketRow> {
  const query = tx.db
    .select()
    .from(tickets)
    .where(and(eq(tickets.tenantId, tx.context.tenantId), eq(tickets.id, ticketId)));
  const [row] = options.lock ? await query.for('update') : await query;
  if (!row) throw new NotFoundError('Ticket');
  return row;
}

/** Open (not cleared) flags per ticket. */
export async function openFlags(tx: TenantTx, ticketIds: string[]): Promise<Map<string, TicketFlag[]>> {
  const out = new Map<string, TicketFlag[]>(ticketIds.map((id) => [id, []]));
  if (ticketIds.length === 0) return out;
  const rows = await tx.db
    .select({ ticketId: ticketFlags.ticketId, flag: ticketFlags.flag })
    .from(ticketFlags)
    .where(and(eq(ticketFlags.tenantId, tx.context.tenantId), inArray(ticketFlags.ticketId, ticketIds), isNull(ticketFlags.clearedAt)))
    .orderBy(ticketFlags.createdAt);
  for (const row of rows) out.get(row.ticketId)?.push(row.flag as TicketFlag);
  return out;
}

export interface NewTicket {
  channel: Channel;
  topic?: TicketTopic;
  brandId: string | null;
  patientId: string | null;
  queue: TicketQueue;
  priority: TicketPriority;
  patientVisible?: boolean;
  verifiedInApp?: boolean;
}

export async function insertTicket(tx: TenantTx, input: NewTicket): Promise<TicketRow> {
  const now = new Date();
  const [row] = await tx.db
    .insert(tickets)
    .values({
      tenantId: tx.context.tenantId,
      brandId: input.brandId,
      patientId: input.patientId,
      channel: input.channel,
      topic: input.topic ?? 'other',
      queue: input.queue,
      priority: input.priority,
      patientVisible: input.patientVisible ?? false,
      ...(input.verifiedInApp ? { patientVerifiedAt: now, patientVerifiedMethod: 'patient_app' } : {}),
      firstResponseDueAt: firstResponseDue(now, input.queue, input.priority),
      lastMessageAt: now,
    })
    .returning();
  if (!row) throw new Error('ticket insert returned nothing');
  const facts = {
    channel: row.channel,
    queue: row.queue,
    priority: row.priority,
    topic: row.topic,
  };
  await audit(tx, {
    action: 'ticket.created',
    zone: 'operational',
    recordTable: RECORD,
    recordId: row.id,
    details: facts,
  });
  await emitEvent(tx, {
    type: 'ticket.created',
    recordTable: RECORD,
    recordId: row.id,
    payload: { ...facts, brandId: row.brandId, patientId: row.patientId },
  });
  return row;
}

/**
 * Set flags that aren't already open on the ticket. Returns the ones that
 * were new. Each writes an audit entry and a ticket.flagged event with the
 * flag's name only (never the words that raised it).
 */
export async function addFlags(tx: TenantTx, ticket: TicketRow, flags: readonly TicketFlag[], by: 'actor' | 'triage' = 'actor'): Promise<TicketFlag[]> {
  if (flags.length === 0) return [];
  const { actor, tenantId } = tx.context;
  // Triage's word lists are the system's, whoever's message they ran on.
  const setByType = by === 'triage' ? 'system' : actor.type;
  const setById = by === 'triage' ? null : actor.type === 'person' ? actor.userId : actor.type === 'agent' ? actor.agentId : null;
  const added = await tx.db
    .insert(ticketFlags)
    .values(
      flags.map((flag) => ({
        tenantId,
        ticketId: ticket.id,
        flag,
        setByType,
        setById,
      })),
    )
    .onConflictDoNothing()
    .returning({ flag: ticketFlags.flag });
  for (const { flag } of added) {
    await audit(tx, {
      action: 'ticket.flagged',
      zone: 'operational',
      recordTable: RECORD,
      recordId: ticket.id,
      details: { flag, by: setByType },
    });
    await emitEvent(tx, {
      type: 'ticket.flagged',
      recordTable: RECORD,
      recordId: ticket.id,
      payload: { flag, queue: ticket.queue, patientId: ticket.patientId },
    });
  }
  return added.map((row) => row.flag as TicketFlag);
}

export interface TicketChange {
  status?: TicketStatus;
  queue?: TicketQueue;
  priority?: TicketPriority;
  assigneeMembershipId?: string | null;
}

/**
 * Change a ticket's status, queue, priority or assignee, with an audit entry
 * and an event for each field that changed. While nobody has replied, a new
 * queue or priority moves the first-response due time (SUP5).
 */
export async function changeTicket(tx: TenantTx, ticket: TicketRow, change: TicketChange): Promise<TicketRow> {
  const next = {
    status: change.status ?? (ticket.status as TicketStatus),
    queue: change.queue ?? (ticket.queue as TicketQueue),
    priority: change.priority ?? (ticket.priority as TicketPriority),
    assigneeMembershipId: change.assigneeMembershipId === undefined ? ticket.assigneeMembershipId : change.assigneeMembershipId,
  };
  const changed = (['status', 'queue', 'priority', 'assigneeMembershipId'] as const).filter((key) => next[key] !== ticket[key]);
  if (changed.length === 0) return ticket;
  const due =
    ticket.firstRespondedAt === null && (changed.includes('queue') || changed.includes('priority'))
      ? firstResponseDue(ticket.createdAt, next.queue, next.priority)
      : ticket.firstResponseDueAt;
  const [row] = await tx.db
    .update(tickets)
    .set({
      ...next,
      firstResponseDueAt: due,
      overdueNotifiedAt: due.getTime() === ticket.firstResponseDueAt.getTime() ? ticket.overdueNotifiedAt : null,
      solvedAt: next.status === 'solved' ? (ticket.solvedAt ?? sql`now()`) : null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tickets.tenantId, tx.context.tenantId), eq(tickets.id, ticket.id)))
    .returning();
  if (!row) throw new NotFoundError('Ticket');
  const names = {
    status: 'status_changed',
    queue: 'queue_changed',
    priority: 'priority_changed',
    assigneeMembershipId: 'assigned',
  } as const;
  for (const key of changed) {
    const facts = { from: ticket[key], to: next[key] };
    const action = `ticket.${names[key]}` as const;
    await audit(tx, {
      action,
      zone: 'operational',
      recordTable: RECORD,
      recordId: ticket.id,
      details: facts,
    });
    await emitEvent(tx, {
      type: action,
      recordTable: RECORD,
      recordId: ticket.id,
      payload: { ...facts, patientId: row.patientId },
    });
  }
  return row;
}

/** A message arrived or went out: the ticket's clock, and the first response when it counts (SUP5). */
export async function touchTicket(tx: TenantTx, ticket: TicketRow, options: { firstResponse?: boolean; reopen?: boolean }): Promise<TicketRow> {
  const [row] = await tx.db
    .update(tickets)
    .set({
      lastMessageAt: sql`now()`,
      updatedAt: sql`now()`,
      ...(options.firstResponse && ticket.firstRespondedAt === null ? { firstRespondedAt: sql`now()` } : {}),
      ...(options.reopen && ticket.status !== 'open' ? { status: 'open', solvedAt: null } : {}),
    })
    .where(and(eq(tickets.tenantId, tx.context.tenantId), eq(tickets.id, ticket.id)))
    .returning();
  if (!row) throw new NotFoundError('Ticket');
  if (options.reopen && ticket.status !== 'open') {
    const facts = { from: ticket.status, to: 'open' };
    await audit(tx, {
      action: 'ticket.status_changed',
      zone: 'operational',
      recordTable: RECORD,
      recordId: ticket.id,
      details: facts,
    });
    await emitEvent(tx, {
      type: 'ticket.status_changed',
      recordTable: RECORD,
      recordId: ticket.id,
      payload: { ...facts, patientId: row.patientId },
    });
  }
  return row;
}

/** Clear an open flag, keeping the row with who cleared it. Returns false when it wasn't open. */
export async function clearOpenFlag(tx: TenantTx, ticket: TicketRow, flag: TicketFlag, userId: string): Promise<boolean> {
  const cleared = await tx.db
    .update(ticketFlags)
    .set({ clearedAt: sql`now()`, clearedByUserId: userId })
    .where(and(eq(ticketFlags.tenantId, tx.context.tenantId), eq(ticketFlags.ticketId, ticket.id), eq(ticketFlags.flag, flag), isNull(ticketFlags.clearedAt)))
    .returning({ id: ticketFlags.id });
  if (cleared.length === 0) return false;
  await audit(tx, {
    action: 'ticket.flag_cleared',
    zone: 'operational',
    recordTable: RECORD,
    recordId: ticket.id,
    details: { flag },
  });
  await emitEvent(tx, {
    type: 'ticket.flag_cleared',
    recordTable: RECORD,
    recordId: ticket.id,
    payload: { flag, patientId: ticket.patientId },
  });
  return true;
}

/** Link or unlink a patient, and record who confirmed identity and how (SUP8). */
export async function setTicketPatient(
  tx: TenantTx,
  ticket: TicketRow,
  patient: {
    patientId: string | null;
    verified: { method: 'date_of_birth' | 'call_back'; userId: string } | null;
  },
): Promise<TicketRow> {
  const [row] = await tx.db
    .update(tickets)
    .set({
      patientId: patient.patientId,
      patientVerifiedAt: patient.verified ? sql`now()` : null,
      patientVerifiedMethod: patient.verified?.method ?? null,
      patientVerifiedByUserId: patient.verified?.userId ?? null,
      updatedAt: sql`now()`,
    })
    .where(and(eq(tickets.tenantId, tx.context.tenantId), eq(tickets.id, ticket.id)))
    .returning();
  if (!row) throw new NotFoundError('Ticket');
  return row;
}
