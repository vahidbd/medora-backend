import type { TicketFlag, TicketQueue } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { BusinessRuleError, ForbiddenError } from '../../lib/errors.js';
import { assertCanReadText, type Viewer } from './access.js';
import { addFlags, changeTicket, clearOpenFlag, loadTicket, openFlags, type TicketRow } from './tickets.store.js';

/**
 * Flags a person or an agent sets, and clearing them (docs/decisions/support.md
 * SUP6). Setting a flag only ever escalates the ticket. Confirming a
 * complaint or an adverse event, and sending it to clinical governance's
 * register, comes with that register.
 */

/** Every flag but `clinical`, which only triage sets. */
export type SettableFlag = Exclude<TicketFlag, 'clinical'>;

/** Flags that send a ticket to the clinical queue when set. */
const CLINICAL_FLAGS: ReadonlySet<TicketFlag> = new Set(['emergency', 'self_harm', 'possible_adverse_event']);
const URGENT_FLAGS: ReadonlySet<TicketFlag> = new Set(['emergency', 'self_harm']);
/** Cleared only by the clinical team. */
const CLINICAL_CLEAR: ReadonlySet<TicketFlag> = new Set(['emergency', 'self_harm', 'clinical', 'possible_adverse_event']);

async function escalate(tx: TenantTx, ticket: TicketRow, flag: TicketFlag): Promise<TicketRow> {
  const toClinical = CLINICAL_FLAGS.has(flag) && ticket.queue === 'support';
  const toUrgent = URGENT_FLAGS.has(flag) && ticket.priority === 'normal';
  if (!toClinical && !toUrgent) return ticket;
  return changeTicket(tx, ticket, {
    ...(toClinical ? { queue: 'clinical' } : {}),
    ...(toUrgent ? { priority: 'urgent' } : {}),
  });
}

/** A person or an agent marks what triage missed (SUP3, SUP12): it escalates, never lowers. */
export async function flagTicket(tx: TenantTx, viewer: Viewer, ticketId: string, flag: SettableFlag): Promise<TicketFlag[]> {
  let ticket = await loadTicket(tx, ticketId, { lock: true });
  assertCanReadText(viewer, ticket.queue as TicketQueue);
  if (viewer.actor.type !== 'person' && viewer.actor.type !== 'agent') throw new ForbiddenError();
  const open = (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
  if (open.includes(flag)) return open;
  ticket = await escalate(tx, ticket, flag);
  await addFlags(tx, ticket, [flag]);
  return (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
}

/** Only a person clears a flag, and only the clinical team a clinical one (SUP6). */
export async function clearFlag(tx: TenantTx, viewer: Viewer, ticketId: string, flag: TicketFlag): Promise<TicketFlag[]> {
  if (viewer.actor.type !== 'person') throw new ForbiddenError('Only a staff member clears a flag', 'person_only');
  const ticket = await loadTicket(tx, ticketId, { lock: true });
  assertCanReadText(viewer, ticket.queue as TicketQueue);
  if (CLINICAL_CLEAR.has(flag) && !viewer.permissions.has('support:clinical')) throw new ForbiddenError('Only the clinical team clears this flag', 'clinical_only');
  const cleared = await clearOpenFlag(tx, ticket, flag, viewer.actor.userId);
  if (!cleared) throw new BusinessRuleError("That flag isn't set on this ticket", 'flag_not_open');
  return (await openFlags(tx, [ticket.id])).get(ticket.id) ?? [];
}
