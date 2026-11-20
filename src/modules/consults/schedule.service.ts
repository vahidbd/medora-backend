import { and, asc, eq, gte, lt } from 'drizzle-orm';
import { consults } from '../../db/schema/index.js';
import type { CancellationReason, ConsultMode, ConsultPurpose, ConsultStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { clinicianCalendar } from '../clinicians/index.js';
import { findPatients } from '../patients/index.js';
import { offeredSlots } from './calendar.service.js';
import type { ScheduleEntry } from './consults.schemas.js';

/**
 * Reading the schedule (docs/decisions/consults.md CNS11): exactly the
 * schedule's fields, and an audit entry for every read, because the rows are
 * clinical even when the fields aren't.
 */

const RECORD = 'clinical.consults' as const;
const MAX_RANGE_DAYS = 31;
const DAY_MS = 86_400_000;
type Consult = typeof consults.$inferSelect;

async function entriesOf(tx: TenantTx, rows: Consult[]): Promise<ScheduleEntry[]> {
  const patients = await findPatients(
    tx,
    rows.map((row) => row.patientId),
  );
  return rows.map((row) => ({
    consultId: row.id,
    patientId: row.patientId,
    patientName: patients.get(row.patientId)?.displayName ?? '',
    clinicianUserId: row.clinicianUserId,
    startsAt: row.scheduledStart.toISOString(),
    endsAt: row.scheduledEnd.toISOString(),
    mode: row.mode as ConsultMode,
    purpose: row.purpose as ConsultPurpose,
    status: row.status as ConsultStatus,
    cancellationReason: row.cancellationReason as CancellationReason | null,
    rescheduledFrom: row.rescheduledFrom,
  }));
}

export async function scheduleEntry(tx: TenantTx, consult: Consult): Promise<ScheduleEntry> {
  return (await entriesOf(tx, [consult]))[0]!;
}

export async function readConsult(tx: TenantTx, consultId: string): Promise<ScheduleEntry> {
  const [row] = await tx.db
    .select()
    .from(consults)
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.id, consultId)));
  if (!row) throw new NotFoundError('Consult');
  await audit(tx, { action: 'consult.read', zone: 'clinical', recordTable: RECORD, recordId: row.id });
  return scheduleEntry(tx, row);
}

/** Consults starting in a range of at most 31 days, for one clinician or patient if asked, every status. */
export async function readSchedule(
  tx: TenantTx,
  query: { from: string; to: string; clinicianUserId?: string; patientId?: string },
): Promise<ScheduleEntry[]> {
  const [from, to] = [new Date(query.from), new Date(query.to)];
  if (!(to > from) || to.getTime() - from.getTime() > MAX_RANGE_DAYS * DAY_MS) {
    throw new BadRequestError(`Ask for a range of up to ${MAX_RANGE_DAYS} days`, 'bad_range');
  }
  const rows = await tx.db
    .select()
    .from(consults)
    .where(
      and(
        eq(consults.tenantId, tx.context.tenantId),
        gte(consults.scheduledStart, from),
        lt(consults.scheduledStart, to),
        query.clinicianUserId ? eq(consults.clinicianUserId, query.clinicianUserId) : undefined,
        query.patientId ? eq(consults.patientId, query.patientId) : undefined,
      ),
    )
    .orderBy(asc(consults.scheduledStart), asc(consults.id));
  await audit(tx, {
    action: 'consult.schedule_read',
    zone: 'clinical',
    recordTable: RECORD,
    recordId: '*',
    details: { count: rows.length, clinicianUserId: query.clinicianUserId ?? null, patientId: query.patientId ?? null },
  });
  return entriesOf(tx, rows);
}

/** Free slots for one clinician, a range of up to 14 days (a week by default). */
export async function readSlots(tx: TenantTx, query: { clinicianUserId: string; from?: string; to?: string }, now = new Date()) {
  const from = query.from ? new Date(query.from) : now;
  const to = query.to ? new Date(query.to) : new Date(from.getTime() + 7 * DAY_MS);
  if (!(to > from) || to.getTime() - from.getTime() > 14 * DAY_MS) throw new BadRequestError('Ask for a range of up to 14 days', 'bad_range');
  const calendar = await clinicianCalendar(tx, query.clinicianUserId, now);
  if (!calendar) throw new NotFoundError('Clinician');
  const slots = await offeredSlots(tx, calendar, query.clinicianUserId, now, { from, to });
  return { timeZone: calendar.timeZone, slots: slots.map((slot) => ({ startsAt: slot.startsAt.toISOString(), endsAt: slot.endsAt.toISOString() })) };
}
