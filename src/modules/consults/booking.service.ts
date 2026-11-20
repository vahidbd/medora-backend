import { and, eq } from 'drizzle-orm';
import { consultEvidence, consults } from '../../db/schema/index.js';
import type { CancellationReason, ConsultMode, ConsultPurpose } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { postgresError } from '../../lib/database-errors.js';
import { AppError, BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { clinicianCalendar, clinicianStanding } from '../clinicians/index.js';
import { ageOn, assertConsents, findPatient, findPatientContact, MINIMUM_AGE } from '../patients/index.js';
import { BOOKING_HORIZON_DAYS, BOOKING_NOTICE_MINUTES, bookingWindow, busyFor, overlapsAny, slotStartingAt, tenantToday } from './calendar.service.js';
import { assignClinician, needsPrescriber } from './assignment.service.js';
import type { BookConsult, RescheduleConsult } from './consults.schemas.js';

/**
 * Booking, moving and cancelling consults, and no-shows (docs/decisions/
 * consults.md CNS11 to CNS16). Each action is one transaction with its audit
 * entry and one event; the database's overlap constraints have the last word.
 */

const RECORD = 'clinical.consults' as const;
type Consult = typeof consults.$inferSelect;

function facts(consult: Consult) {
  return {
    patientId: consult.patientId,
    consultId: consult.id,
    clinicianUserId: consult.clinicianUserId,
    mode: consult.mode,
    purpose: consult.purpose,
    startsAt: consult.scheduledStart.toISOString(),
    endsAt: consult.scheduledEnd.toISOString(),
  };
}

/** CNS13: whether the patient can be booked, checked inside the booking transaction. */
async function assertPatientBookable(tx: TenantTx, input: { patientId: string; mode: ConsultMode }, now: Date) {
  const patient = await findPatient(tx, input.patientId);
  if (!patient) throw new NotFoundError('Patient');
  const age = ageOn(patient.dateOfBirth, await tenantToday(tx, now));
  if (age === null || age < MINIMUM_AGE) throw new BusinessRuleError(`Consults are for patients ${MINIMUM_AGE} and over`, 'patient_under_age');
  await assertConsents(tx, input.patientId, 'care');
  if (input.mode === 'phone' && !(await findPatientContact(tx, input.patientId))?.mobile) {
    throw new BusinessRuleError('A phone consult needs a mobile number on the patient’s record', 'no_mobile');
  }
}

/** CNS13: whether the clinician can take this consult now. */
async function assertClinicianBookable(tx: TenantTx, input: { clinicianUserId: string; purpose: ConsultPurpose }, now: Date) {
  const standing = await clinicianStanding(tx, input.clinicianUserId, now);
  if (!standing.mayConsult) throw new AppError(409, 'clinician_not_in_standing', "This clinician can't be booked right now", { reasons: standing.reasons });
  if (needsPrescriber(input.purpose) && !standing.mayPrescribe) {
    throw new BusinessRuleError('Initial and review consults need a prescriber', 'needs_prescriber');
  }
}

function assertInWindow(startsAt: Date, now: Date): void {
  const window = bookingWindow(now);
  if (startsAt < window.earliest || startsAt > window.latest) {
    throw new BusinessRuleError(`Consults are booked from ${BOOKING_NOTICE_MINUTES} minutes to ${BOOKING_HORIZON_DAYS} days ahead`, 'outside_booking_window');
  }
}

/**
 * Patient checks, then the clinician: the one named, or one assigned (CNS19,
 * preferring `prefer`), then their checks. Returns who takes the consult.
 */
async function bookableClinician(
  tx: TenantTx,
  input: { patientId: string; clinicianUserId?: string | undefined; mode: ConsultMode; purpose: ConsultPurpose; startsAt: Date; prefer?: string },
  now: Date,
): Promise<string> {
  assertInWindow(input.startsAt, now);
  await assertPatientBookable(tx, input, now);
  const clinicianUserId = input.clinicianUserId ?? (await assignClinician(tx, { ...input, prefer: input.prefer ?? null }, now));
  await assertClinicianBookable(tx, { clinicianUserId, purpose: input.purpose }, now);
  return clinicianUserId;
}

/** CNS12: the time must be a slot Medora offers, re-checked here with the clinician locked. Each refusal names its rule. */
async function assertOffered(tx: TenantTx, input: { patientId: string; clinicianUserId: string; startsAt: Date }, now: Date): Promise<{ endsAt: Date }> {
  const calendar = await clinicianCalendar(tx, input.clinicianUserId, now, { lock: true });
  if (!calendar) throw new NotFoundError('Clinician');
  const slot = slotStartingAt(calendar, input.startsAt);
  if (!slot) throw new BusinessRuleError('That time isn’t a slot in the clinician’s hours', 'not_a_slot');
  if (overlapsAny(slot, calendar.timeOff)) throw new BusinessRuleError('The clinician is away then', 'clinician_away');
  if ((await busyFor(tx, { clinicianUserId: input.clinicianUserId }, slot)).length > 0) {
    throw new BusinessRuleError('That slot is already booked', 'slot_taken');
  }
  if ((await busyFor(tx, { patientId: input.patientId }, slot)).length > 0) {
    throw new BusinessRuleError('The patient already has a consult at that time', 'patient_busy');
  }
  return { endsAt: slot.endsAt };
}

async function insertConsult(tx: TenantTx, values: typeof consults.$inferInsert): Promise<Consult> {
  try {
    const [row] = await tx.db.insert(consults).values(values).returning();
    return row!;
  } catch (error) {
    const pg = postgresError(error);
    // The overlap constraints have the last word when two bookings race (CNS12).
    if (pg?.code === '23P01' && pg.constraint === 'consults_patient_overlap') throw new BusinessRuleError('The patient already has a consult at that time', 'patient_busy');
    if (pg?.code === '23P01') throw new BusinessRuleError('That slot is already booked', 'slot_taken');
    throw error;
  }
}

/** CNS12, CNS13; without a clinician named, one is assigned (CNS19). */
export async function bookConsult(tx: TenantTx, input: BookConsult, now = new Date()): Promise<Consult> {
  const startsAt = new Date(input.startsAt);
  const clinicianUserId = await bookableClinician(tx, { ...input, startsAt }, now);
  const { endsAt } = await assertOffered(tx, { patientId: input.patientId, clinicianUserId, startsAt }, now);
  const consult = await insertConsult(tx, {
    tenantId: tx.context.tenantId,
    patientId: input.patientId,
    clinicianUserId,
    mode: input.mode,
    purpose: input.purpose,
    scheduledStart: startsAt,
    scheduledEnd: endsAt,
  });
  await audit(tx, { action: 'consult.booked', zone: 'clinical', recordTable: RECORD, recordId: consult.id, details: facts(consult) });
  await emitEvent(tx, { type: 'consult.booked', recordTable: RECORD, recordId: consult.id, payload: facts(consult) });
  return consult;
}

/** The consult, held until the transaction ends. Naming a patient makes another patient's consult not found (CNS20). */
export async function lockedConsult(tx: TenantTx, consultId: string, patientId?: string): Promise<Consult> {
  const [row] = await tx.db
    .select()
    .from(consults)
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consultId)))
    .for('update');
  if (!row || (patientId !== undefined && row.patientId !== patientId)) throw new NotFoundError('Consult');
  return row;
}

/** CNS14: a consult with any evidence may back a script, so its booking can't be undone, whatever its status says. */
async function assertNoEvidence(tx: TenantTx, consult: Consult): Promise<void> {
  const [found] = await tx.db
    .select({ id: consultEvidence.id })
    .from(consultEvidence)
    .where(and(eq(consultEvidence.tenantId, tx.context.tenantId), eq(consultEvidence.consultId, consult.id)))
    .limit(1);
  if (found) throw new BusinessRuleError('This consult has already started', 'consult_has_evidence');
}

async function scheduledWithoutEvidence(tx: TenantTx, consultId: string, patientId?: string): Promise<Consult> {
  const consult = await lockedConsult(tx, consultId, patientId);
  if (consult.status !== 'scheduled') throw new BusinessRuleError('Only a scheduled consult can be changed', 'consult_not_scheduled');
  await assertNoEvidence(tx, consult);
  return consult;
}

async function setCancelled(tx: TenantTx, consult: Consult, reason: CancellationReason): Promise<void> {
  await tx.db
    .update(consults)
    .set({ status: 'cancelled', cancellationReason: reason, updatedAt: new Date() })
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consult.id)));
}

/** CNS14: cancelled is final; the way back is booking again. */
export async function cancelConsult(
  tx: TenantTx,
  consultId: string,
  reason: Exclude<CancellationReason, 'rescheduled'>,
  options: { patientId?: string | undefined; check?: (consult: Consult) => void } = {},
): Promise<Consult> {
  const consult = await scheduledWithoutEvidence(tx, consultId, options.patientId);
  options.check?.(consult);
  await setCancelled(tx, consult, reason);
  await audit(tx, { action: 'consult.cancelled', zone: 'clinical', recordTable: RECORD, recordId: consult.id, details: { reason } });
  await emitEvent(tx, { type: 'consult.cancelled', recordTable: RECORD, recordId: consult.id, payload: { ...facts(consult), reason } });
  return lockedConsult(tx, consultId);
}

/**
 * CNS15: a move cancels the consult and books a new one linked to it, by the
 * same rules as any booking, in one transaction. If the new time is refused
 * the old consult stands. One event, so the patient gets one message. With
 * no clinician named, the same clinician keeps it if they are free then,
 * and otherwise it is assigned (CNS19); the reply and the event say who
 * holds it now.
 */
export async function rescheduleConsult(
  tx: TenantTx,
  consultId: string,
  input: RescheduleConsult,
  now = new Date(),
  options: { check?: (consult: Consult) => void } = {},
): Promise<Consult> {
  const old = await scheduledWithoutEvidence(tx, consultId, input.patientId);
  options.check?.(old);
  const startsAt = new Date(input.startsAt);
  const mode = input.mode ?? (old.mode as ConsultMode);
  const purpose = old.purpose as ConsultPurpose;
  await setCancelled(tx, old, 'rescheduled');
  const clinicianUserId = await bookableClinician(
    tx,
    { patientId: old.patientId, clinicianUserId: input.clinicianUserId, mode, purpose, startsAt, prefer: old.clinicianUserId },
    now,
  );
  const next = { patientId: old.patientId, clinicianUserId, mode, purpose };
  const { endsAt } = await assertOffered(tx, { ...next, startsAt }, now);
  const consult = await insertConsult(tx, {
    tenantId: tx.context.tenantId,
    ...next,
    scheduledStart: startsAt,
    scheduledEnd: endsAt,
    rescheduledFrom: old.id,
  });
  await audit(tx, { action: 'consult.rescheduled', zone: 'clinical', recordTable: RECORD, recordId: old.id, details: { to: consult.id } });
  await audit(tx, { action: 'consult.booked', zone: 'clinical', recordTable: RECORD, recordId: consult.id, details: { ...facts(consult), from: old.id } });
  await emitEvent(tx, {
    type: 'consult.rescheduled',
    recordTable: RECORD,
    recordId: consult.id,
    payload: { ...facts(consult), previousConsultId: old.id, previousClinicianUserId: old.clinicianUserId },
  });
  return consult;
}

/** CNS16: whether someone turned up is for a person to say, never an agent. */
function assertPerson(tx: TenantTx): void {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can record whether a patient came', 'people_only');
}

export async function markNoShow(tx: TenantTx, consultId: string, now = new Date()): Promise<Consult> {
  assertPerson(tx);
  const consult = await scheduledWithoutEvidence(tx, consultId);
  if (consult.scheduledStart > now) throw new BusinessRuleError('A consult can be marked a no-show only once it was due', 'consult_not_due');
  await tx.db
    .update(consults)
    .set({ status: 'no_show', updatedAt: new Date() })
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consult.id)));
  await audit(tx, { action: 'consult.marked_no_show', zone: 'clinical', recordTable: RECORD, recordId: consult.id });
  await emitEvent(tx, { type: 'consult.marked_no_show', recordTable: RECORD, recordId: consult.id, payload: facts(consult) });
  return lockedConsult(tx, consultId);
}

/** CNS16: for a mistaken mark. The no-show kept its slot, so nothing can collide. */
export async function reinstateConsult(tx: TenantTx, consultId: string): Promise<Consult> {
  assertPerson(tx);
  const consult = await lockedConsult(tx, consultId);
  if (consult.status !== 'no_show') throw new BusinessRuleError('Only a no-show can be reinstated', 'consult_not_no_show');
  await tx.db
    .update(consults)
    .set({ status: 'scheduled', updatedAt: new Date() })
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consult.id)));
  await audit(tx, { action: 'consult.reinstated', zone: 'clinical', recordTable: RECORD, recordId: consult.id });
  await emitEvent(tx, { type: 'consult.reinstated', recordTable: RECORD, recordId: consult.id, payload: facts(consult) });
  return lockedConsult(tx, consultId);
}
