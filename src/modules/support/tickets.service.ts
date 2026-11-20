import { and, desc, eq, inArray, lt, sql, type SQL } from 'drizzle-orm';
import { memberships, ticketComments, tickets } from '../../db/schema/index.js';
import type {
  ActorType,
  Channel,
  MessageDirection,
  MessageStatus,
  TicketFlag,
  TicketPriority,
  TicketQueue,
  TicketStatus,
  TicketTopic,
  VerificationMethod,
} from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError } from '../../lib/errors.js';
import { latestMessages, messagesOfTickets, type MessageRow } from '../messaging/index.js';
import { findPatientContact, findPatients } from '../patients/index.js';
import { assertCanReadText, canReadText, replyRefusal, type Viewer } from './access.js';
import { changeTicket, loadTicket, openFlags, RECORD, type TicketChange, type TicketRow } from './tickets.store.js';

/**
 * The inbox (docs/decisions/support.md): the ticket list, one ticket, and
 * changes to its status, queue, priority and assignee. The API hides what a
 * viewer may not read (SUP2): a clinical-queue ticket shows that it exists,
 * never its text, without support:clinical.
 */

export interface TicketListQuery {
  queue?: TicketQueue | undefined;
  status?: TicketStatus | 'active' | undefined;
  /** 'me' (the viewer's membership), 'unassigned', or a membership id. */
  assignee?: string | undefined;
  brandId?: string | undefined;
  patientId?: string | undefined;
  /** Tickets whose last message is before this instant: the next page. */
  before?: string | undefined;
  limit: number;
}

const SNIPPET_LENGTH = 160;

function snippetOf(body: string): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > SNIPPET_LENGTH ? `${flat.slice(0, SNIPPET_LENGTH - 1)}…` : flat;
}

function isOverdue(ticket: TicketRow, now: Date): boolean {
  return ticket.firstRespondedAt === null && ticket.status !== 'solved' && ticket.firstResponseDueAt.getTime() < now.getTime();
}

function summaryOf(ticket: TicketRow, flags: TicketFlag[], textShown: boolean, now: Date) {
  return {
    ticketId: ticket.id,
    brandId: ticket.brandId,
    channel: ticket.channel as Channel,
    topic: ticket.topic as TicketTopic,
    status: ticket.status as TicketStatus,
    queue: ticket.queue as TicketQueue,
    priority: ticket.priority as TicketPriority,
    assigneeMembershipId: ticket.assigneeMembershipId,
    flags,
    firstResponseDueAt: ticket.firstResponseDueAt.toISOString(),
    firstRespondedAt: ticket.firstRespondedAt?.toISOString() ?? null,
    overdue: isOverdue(ticket, now),
    lastMessageAt: ticket.lastMessageAt.toISOString(),
    createdAt: ticket.createdAt.toISOString(),
    textHidden: !textShown,
  };
}

function previewOf(message: MessageRow | undefined) {
  if (!message) return null;
  return {
    direction: message.direction as MessageDirection,
    channel: message.channel as Channel,
    subject: message.subject,
    snippet: snippetOf(message.body),
    automated: message.automated,
    at: message.createdAt.toISOString(),
  };
}

/** Names only for a viewer who may read patients (SUP8): support:read opens a ticket's text, not the record. */
async function patientNames(tx: TenantTx, viewer: Viewer, rows: TicketRow[]) {
  if (!viewer.permissions.has('patients:read')) return new Map<string, string>();
  const ids = rows.map((row) => row.patientId).filter((id): id is string => id !== null);
  const found = await findPatients(tx, ids);
  return new Map([...found].map(([id, summary]) => [id, summary.displayName]));
}

function patientOf(ticket: TicketRow, names: Map<string, string>) {
  if (!ticket.patientId) return null;
  return {
    patientId: ticket.patientId,
    displayName: names.get(ticket.patientId) ?? null,
    verified: ticket.patientVerifiedAt !== null,
  };
}

export async function listTickets(tx: TenantTx, viewer: Viewer, query: TicketListQuery) {
  const { tenantId } = tx.context;
  const where: SQL[] = [eq(tickets.tenantId, tenantId)];
  if (query.queue) where.push(eq(tickets.queue, query.queue));
  if (query.status === 'active') where.push(inArray(tickets.status, ['open', 'waiting']));
  else if (query.status) where.push(eq(tickets.status, query.status));
  if (query.assignee === 'unassigned') where.push(sql`${tickets.assigneeMembershipId} is null`);
  else if (query.assignee === 'me') {
    if (!viewer.membershipId) throw new BusinessRuleError('Only a staff member has tickets of their own', 'no_membership');
    where.push(eq(tickets.assigneeMembershipId, viewer.membershipId));
  } else if (query.assignee) where.push(eq(tickets.assigneeMembershipId, query.assignee));
  if (query.brandId) where.push(eq(tickets.brandId, query.brandId));
  if (query.patientId) where.push(eq(tickets.patientId, query.patientId));
  if (query.before) where.push(lt(tickets.lastMessageAt, new Date(query.before)));
  const rows = await tx.db
    .select()
    .from(tickets)
    .where(and(...where))
    .orderBy(desc(tickets.lastMessageAt), desc(tickets.id))
    .limit(query.limit);
  const readable = rows.filter((row) => canReadText(viewer, row.queue as TicketQueue));
  // One connection per transaction: these run one after another.
  const flags = await openFlags(
    tx,
    rows.map((row) => row.id),
  );
  const latest = await latestMessages(
    tx,
    readable.map((row) => row.id),
  );
  const names = await patientNames(tx, viewer, rows);
  const now = new Date();
  const items = [];
  for (const row of rows) {
    const shown = readable.includes(row);
    const preview = shown ? latest.get(row.id) : undefined;
    // A preview is message text: clinical zone, one audit entry per ticket shown (ADR 0008).
    if (preview)
      await audit(tx, {
        action: 'ticket.previewed',
        zone: 'clinical',
        recordTable: RECORD,
        recordId: row.id,
        details: { messageId: preview.id },
      });
    items.push({
      ...summaryOf(row, flags.get(row.id) ?? [], shown, now),
      patient: patientOf(row, names),
      preview: previewOf(preview),
    });
  }
  const last = rows.at(-1);
  return {
    tickets: items,
    nextBefore: rows.length === query.limit && last ? last.lastMessageAt.toISOString() : null,
  };
}

function messageView(message: MessageRow) {
  return {
    messageId: message.id,
    direction: message.direction as MessageDirection,
    channel: message.channel as Channel,
    status: message.status as MessageStatus,
    from: message.fromAddress,
    to: message.toAddress,
    subject: message.subject,
    body: message.body,
    automated: message.automated,
    authorType: message.authorType as ActorType,
    authorId: message.authorId,
    attachmentCount: message.attachmentCount,
    failureCode: message.failureCode,
    createdAt: message.createdAt.toISOString(),
    sentAt: message.sentAt?.toISOString() ?? null,
  };
}

/** The newest inbound message's channel and address: a reply goes back the way the person wrote (SUP8). */
export function replyRouteOf(messages: readonly MessageRow[]): {
  channel: 'email' | 'sms' | 'chat';
  to: string | null;
  subject: string | null;
} | null {
  for (const message of [...messages].reverse()) {
    if (message.direction !== 'inbound') continue;
    if (message.channel === 'chat') return { channel: 'chat', to: null, subject: null };
    if ((message.channel === 'email' || message.channel === 'sms') && message.fromAddress) {
      return {
        channel: message.channel,
        to: message.fromAddress,
        subject: message.subject,
      };
    }
  }
  return null;
}

/** Until a staff member confirms who they are talking to, the panel shows what they check against, nothing more (SUP8, SUP9). */
async function patientPanel(tx: TenantTx, viewer: Viewer, ticket: TicketRow) {
  if (!ticket.patientId || !viewer.permissions.has('patients:read')) return null;
  const contact = await findPatientContact(tx, ticket.patientId);
  if (!contact) return null;
  const [summary] = (await findPatients(tx, [ticket.patientId])).values();
  const verified = ticket.patientVerifiedAt !== null;
  return {
    patientId: ticket.patientId,
    displayName: summary?.displayName ?? contact.givenName,
    dateOfBirth: contact.dateOfBirth,
    email: verified ? contact.email : null,
    mobile: verified ? contact.mobile : null,
  };
}

export async function getTicket(tx: TenantTx, viewer: Viewer, ticketId: string) {
  const ticket = await loadTicket(tx, ticketId);
  const flags = (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
  const shown = canReadText(viewer, ticket.queue as TicketQueue);
  const messages = shown ? await messagesOfTickets(tx, [ticket.id]) : [];
  const comments = shown
    ? await tx.db
        .select()
        .from(ticketComments)
        .where(and(eq(ticketComments.tenantId, tx.context.tenantId), eq(ticketComments.ticketId, ticket.id)))
        .orderBy(ticketComments.createdAt)
    : [];
  await audit(tx, {
    action: 'ticket.viewed',
    zone: shown ? 'clinical' : 'operational',
    recordTable: RECORD,
    recordId: ticket.id,
    details: shown ? { messages: messages.length, comments: comments.length } : { textHidden: true },
  });
  const names = await patientNames(tx, viewer, [ticket]);
  const refusal = replyRefusal(viewer, {
    queue: ticket.queue as TicketQueue,
    flags,
  });
  const route = replyRouteOf(messages);
  return {
    ...summaryOf(ticket, flags, shown, new Date()),
    patient: patientOf(ticket, names),
    patientPanel: await patientPanel(tx, viewer, ticket),
    verification: ticket.patientVerifiedAt
      ? {
          method: ticket.patientVerifiedMethod as VerificationMethod | null,
          at: ticket.patientVerifiedAt.toISOString(),
          byUserId: ticket.patientVerifiedByUserId,
        }
      : null,
    messages: shown ? messages.map(messageView) : null,
    comments: shown
      ? comments.map((row) => ({
          commentId: row.id,
          authorUserId: row.authorUserId,
          body: row.body,
          createdAt: row.createdAt.toISOString(),
        }))
      : null,
    reply: {
      allowed: refusal === null && route !== null,
      refusal: refusal ?? (route ? null : 'Nobody has written in on a channel we can reply on'),
      channel: route?.channel ?? null,
    },
  };
}

/** Flags that keep a ticket in the clinical queue until a clinician clears them. */
const HOLDS_CLINICAL: ReadonlySet<TicketFlag> = new Set(['emergency', 'self_harm', 'possible_adverse_event']);

async function assertAssignable(tx: TenantTx, membershipId: string): Promise<void> {
  const [row] = await tx.db
    .select({ status: memberships.status })
    .from(memberships)
    .where(and(eq(memberships.tenantId, tx.context.tenantId), eq(memberships.id, membershipId)));
  if (row?.status !== 'active') throw new BusinessRuleError('Assign the ticket to an active staff member', 'assignee_not_active');
}

/**
 * Change a ticket (SUP2, SUP3, SUP12). Anyone who can read it may send it
 * to the clinical queue or raise it to urgent; only a support:clinical
 * holder may send it back or lower it, and never a care-team ticket or one
 * with an emergency, self-harm or adverse event flag open. Agents only ever
 * escalate.
 */
export async function updateTicket(tx: TenantTx, viewer: Viewer, ticketId: string, change: TicketChange): Promise<TicketRow> {
  const ticket = await loadTicket(tx, ticketId, { lock: true });
  assertCanReadText(viewer, ticket.queue as TicketQueue);
  const flags = (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
  const agent = viewer.actor.type === 'agent';
  const lowers = (change.queue === 'support' && ticket.queue === 'clinical') || (change.priority === 'normal' && ticket.priority === 'urgent');
  if (lowers) {
    if (agent) throw new ForbiddenError('Agents never move a ticket out of the clinical queue or lower its priority', 'agent_escalates_only');
    if (!viewer.permissions.has('support:clinical')) throw new ForbiddenError('Only the clinical team can send a ticket back or lower its priority', 'clinical_only');
  }
  if (change.queue === 'support' && ticket.queue === 'clinical') {
    if (ticket.topic === 'care_team') throw new BusinessRuleError('Care-team messages stay in the clinical queue', 'care_team_stays_clinical');
    const holding = flags.filter((flag) => HOLDS_CLINICAL.has(flag));
    if (holding.length > 0) throw new BusinessRuleError('Clear the clinical flags first', 'clinical_flags_open');
  }
  if (agent && change.assigneeMembershipId !== undefined) throw new ForbiddenError('Agents never assign tickets', 'agent_escalates_only');
  if (change.assigneeMembershipId) await assertAssignable(tx, change.assigneeMembershipId);
  return changeTicket(tx, ticket, change);
}
