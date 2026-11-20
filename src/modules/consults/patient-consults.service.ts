import { and, asc, desc, eq, inArray, notInArray } from 'drizzle-orm';
import { consults } from '../../db/schema/index.js';
import type { ConsultMode, ConsultPurpose, ConsultStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { assertAcceptingPatients } from '../brands/index.js';
import { clinicianNames } from '../clinicians/index.js';
import { latestIntakeFor } from '../intake/index.js';
import { getProgram } from '../protocols/index.js';
import { bookConsult, cancelConsult, rescheduleConsult } from './booking.service.js';
import type { PatientBookConsult, PatientConsult } from './consults.schemas.js';

/**
 * The patient's own consults (docs/decisions/consults.md CNS21 to CNS23): the
 * same booking rules as staff, plus what a patient may do alone. The patient
 * comes from the sign-in, never from the request.
 */

const RECORD = 'clinical.consults' as const;
/** CNS23: inside this, a change goes through the clinic. */
export const PATIENT_CHANGE_CUTOFF_HOURS = 2;
const PAST_SHOWN = 20;
const UPCOMING: ConsultStatus[] = ['scheduled', 'in_progress'];
/** What a review must follow: a consult with a prescriber, which a first consult's intake gated (CNS21). */
const PRESCRIBER_PURPOSES: ConsultPurpose[] = ['initial', 'review'];
type Consult = typeof consults.$inferSelect;

const changeable = (consult: Consult, now: Date) =>
  consult.status === 'scheduled' && consult.scheduledStart.getTime() - now.getTime() >= PATIENT_CHANGE_CUTOFF_HOURS * 3_600_000;

function assertChangeable(now: Date) {
  return (consult: Consult) => {
    if (consult.status === 'scheduled' && !changeable(consult, now)) {
      throw new BusinessRuleError(`A consult can be changed online up to ${PATIENT_CHANGE_CUTOFF_HOURS} hours before it starts. Please contact the clinic.`, 'too_late_to_change');
    }
  };
}

async function viewsOf(tx: TenantTx, rows: Consult[], now: Date): Promise<PatientConsult[]> {
  const names = await clinicianNames(tx, [...new Set(rows.map((row) => row.clinicianUserId))]);
  return rows.map((row) => ({
    consultId: row.id,
    status: row.status as ConsultStatus,
    mode: row.mode as ConsultMode,
    purpose: row.purpose as ConsultPurpose,
    startsAt: row.scheduledStart.toISOString(),
    endsAt: row.scheduledEnd.toISOString(),
    clinicianName: names.get(row.clinicianUserId) ?? null,
    canChange: changeable(row, now),
    canJoin: false,
  }));
}

/** CNS22: what's coming, soonest first, then the last 20 that have passed, newest first. */
export async function consultsOfPatient(tx: TenantTx, patientId: string, now = new Date()): Promise<PatientConsult[]> {
  const mine = and(eq(consults.tenantId, tx.context.tenantId), eq(consults.patientId, patientId));
  const upcoming = await tx.db
    .select()
    .from(consults)
    .where(and(mine, inArray(consults.status, UPCOMING)))
    .orderBy(asc(consults.scheduledStart));
  const past = await tx.db
    .select()
    .from(consults)
    .where(and(mine, notInArray(consults.status, UPCOMING)))
    .orderBy(desc(consults.scheduledStart))
    .limit(PAST_SHOWN);
  const rows = [...upcoming, ...past];
  await audit(tx, { action: 'consult.schedule_read', zone: 'clinical', recordTable: RECORD, recordId: '*', details: { count: rows.length, patientId } });
  return viewsOf(tx, rows, now);
}

/**
 * CNS21: one upcoming consult at a time; a first consult needs the program to
 * be open and its newest intake sent, not stopped; a review needs an earlier
 * completed first consult or review, never only a follow-up. Then the
 * clinic's own booking rules, with a clinician assigned (CNS19).
 */
export async function bookForPatient(tx: TenantTx, patientId: string, input: PatientBookConsult, now = new Date()): Promise<PatientConsult> {
  const mine = and(eq(consults.tenantId, tx.context.tenantId), eq(consults.patientId, patientId));
  const [booked] = await tx.db
    .select({ id: consults.id })
    .from(consults)
    .where(and(mine, inArray(consults.status, UPCOMING)))
    .limit(1);
  if (booked) throw new BusinessRuleError('You already have a consult booked. Move it or cancel it instead.', 'already_booked');
  if (input.purpose === 'initial') {
    if (!input.programId) throw new BadRequestError('A first consult names its program', 'program_needed');
    const program = await getProgram(tx, input.programId);
    // CNS24: a first consult is booked through the program's own brand.
    if (program.brandId !== input.brandId) throw new NotFoundError('Program');
    if (program.status !== 'live') throw new BusinessRuleError("This program isn't taking new patients right now", 'program_not_accepting');
    await assertAcceptingPatients(tx, program.brandId);
    const intake = await latestIntakeFor(tx, { patientId, programId: program.programId });
    if (!intake) throw new BusinessRuleError('Please finish the questions for this program first', 'intake_needed');
    if (intake.status === 'ineligible') throw new BusinessRuleError('Your answers mean this program isn’t right for you now', 'intake_ineligible');
  } else {
    const [earlier] = await tx.db
      .select({ id: consults.id })
      .from(consults)
      .where(and(mine, eq(consults.status, 'completed'), inArray(consults.purpose, PRESCRIBER_PURPOSES)))
      .limit(1);
    if (!earlier) throw new BusinessRuleError('A review follows a consult you have had', 'no_earlier_consult');
  }
  const consult = await bookConsult(tx, { patientId, brandId: input.brandId, mode: input.mode, purpose: input.purpose, startsAt: input.startsAt }, now);
  return (await viewsOf(tx, [consult], now))[0]!;
}

/** CNS23: the patient's own scheduled consult, up to two hours before it starts. */
export async function cancelForPatient(tx: TenantTx, patientId: string, consultId: string, now = new Date()): Promise<PatientConsult> {
  const consult = await cancelConsult(tx, consultId, 'patient_request', { patientId, check: assertChangeable(now) });
  return (await viewsOf(tx, [consult], now))[0]!;
}

/** CNS23: moved by the same rule as cancelling, to an offered time; the same clinician keeps it if they're free (CNS19). */
export async function rescheduleForPatient(
  tx: TenantTx,
  patientId: string,
  consultId: string,
  input: { startsAt: string; mode?: ConsultMode | undefined },
  now = new Date(),
): Promise<PatientConsult> {
  const consult = await rescheduleConsult(tx, consultId, { ...input, patientId }, now, { check: assertChangeable(now) });
  return (await viewsOf(tx, [consult], now))[0]!;
}
