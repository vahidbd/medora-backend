import type { TicketQueue } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { findPatient } from '../patients/index.js';
import { assertCanReadText, type Viewer } from './access.js';
import { loadTicket, RECORD, setTicketPatient, type TicketRow } from './tickets.store.js';

/**
 * Who a ticket is from (docs/decisions/support.md SUP8). Matching links a
 * ticket only on an exact address that points at one patient; staff link the
 * rest by hand. Linking is not knowing: a staff member confirms identity on
 * each ticket, and records how, before anything about the patient's care,
 * orders or billing is discussed.
 */

function personOf(viewer: Viewer): string {
  if (viewer.actor.type !== 'person') throw new ForbiddenError('Only a staff member links a patient or confirms identity', 'person_only');
  return viewer.actor.userId;
}

async function lockedReadable(tx: TenantTx, viewer: Viewer, ticketId: string): Promise<TicketRow> {
  const ticket = await loadTicket(tx, ticketId, { lock: true });
  assertCanReadText(viewer, ticket.queue as TicketQueue);
  return ticket;
}

/** Link a ticket to a patient, or to nobody. Any confirmation of identity goes with the old link. */
export async function linkPatient(tx: TenantTx, viewer: Viewer, ticketId: string, patientId: string | null): Promise<TicketRow> {
  personOf(viewer);
  const ticket = await lockedReadable(tx, viewer, ticketId);
  if (ticket.patientVerifiedMethod === 'patient_app') throw new BusinessRuleError('This ticket came from the signed-in patient app, so its patient is fixed', 'patient_fixed');
  if (patientId && !(await findPatient(tx, patientId))) throw new NotFoundError('Patient');
  if (ticket.patientId === patientId) return ticket;
  const row = await setTicketPatient(tx, ticket, { patientId, verified: null });
  const action = patientId ? 'ticket.patient_linked' : 'ticket.patient_unlinked';
  await audit(tx, {
    action,
    zone: 'operational',
    recordTable: RECORD,
    recordId: ticket.id,
    details: { from: ticket.patientId, to: patientId },
  });
  await emitEvent(tx, {
    type: action,
    recordTable: RECORD,
    recordId: ticket.id,
    payload: { from: ticket.patientId, to: patientId },
  });
  return row;
}

/** Confirm who the staff member is talking to, on this ticket, and how (SUP8). */
export async function verifyPatient(tx: TenantTx, viewer: Viewer, ticketId: string, method: 'date_of_birth' | 'call_back'): Promise<TicketRow> {
  const userId = personOf(viewer);
  const ticket = await lockedReadable(tx, viewer, ticketId);
  if (!ticket.patientId) throw new BusinessRuleError('Link the ticket to a patient first', 'no_patient');
  if (ticket.patientVerifiedAt) return ticket;
  const row = await setTicketPatient(tx, ticket, {
    patientId: ticket.patientId,
    verified: { method, userId },
  });
  await audit(tx, {
    action: 'ticket.patient_verified',
    zone: 'operational',
    recordTable: RECORD,
    recordId: ticket.id,
    details: { method },
  });
  await emitEvent(tx, {
    type: 'ticket.patient_verified',
    recordTable: RECORD,
    recordId: ticket.id,
    payload: { method, patientId: ticket.patientId },
  });
  return row;
}
