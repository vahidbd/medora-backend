import { and, asc, eq, gt } from 'drizzle-orm';
import { clinicianHours, clinicianTimeOff } from '../../db/schema/index.js';
import type { TimeOffReason } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { HoursBlock, TimeOffReply } from './clinicians.schemas.js';
import { type Acting, assertSelfOrManager, clinicianById, clinicianByUserId } from './clinicians.store.js';

/** Working hours and time off (docs/decisions/workforce.md WRK6, WRK7). Booking cuts slots from these. */

const record = (clinicianId: string) => ({ recordTable: 'operational.clinicians', recordId: clinicianId }) as const;
const hhmm = (value: string) => value.slice(0, 5);

export async function hoursOf(tx: TenantTx, clinicianId: string): Promise<HoursBlock[]> {
  const rows = await tx.db
    .select()
    .from(clinicianHours)
    .where(and(eq(clinicianHours.tenantId, tx.context.tenantId), eq(clinicianHours.clinicianId, clinicianId)))
    .orderBy(asc(clinicianHours.weekday), asc(clinicianHours.startsAt));
  return rows.map((row) => ({ weekday: row.weekday, startsAt: hhmm(row.startsAt), endsAt: hhmm(row.endsAt), slotMinutes: row.slotMinutes }));
}

function assertNoOverlap(blocks: HoursBlock[]): void {
  const sorted = [...blocks].sort((a, b) => a.weekday - b.weekday || a.startsAt.localeCompare(b.startsAt));
  for (let i = 1; i < sorted.length; i += 1) {
    const [before, block] = [sorted[i - 1]!, sorted[i]!];
    if (before.weekday === block.weekday && block.startsAt < before.endsAt) {
      throw new BadRequestError('Two blocks of hours overlap on the same day', 'hours_overlap');
    }
  }
}

/** WRK6: the week is replaced as a whole, with the clinician locked, so two editors can't interleave. */
export async function replaceHours(tx: TenantTx, clinicianId: string, blocks: HoursBlock[], acting: Acting): Promise<HoursBlock[]> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertSelfOrManager(acting, clinician);
  assertNoOverlap(blocks);
  const tenantId = tx.context.tenantId;
  await tx.db.delete(clinicianHours).where(and(eq(clinicianHours.tenantId, tenantId), eq(clinicianHours.clinicianId, clinicianId)));
  if (blocks.length > 0) {
    await tx.db.insert(clinicianHours).values(blocks.map((block) => ({ tenantId, clinicianId, ...block })));
  }
  const facts = { blocks: blocks.length };
  await audit(tx, { action: 'clinician.hours_changed', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'clinician.hours_changed', ...record(clinicianId), payload: facts });
  return hoursOf(tx, clinicianId);
}

const timeOffReply = (row: typeof clinicianTimeOff.$inferSelect): TimeOffReply => ({
  timeOffId: row.id,
  startsAt: row.startsAt.toISOString(),
  endsAt: row.endsAt.toISOString(),
  reason: row.reason as TimeOffReason,
});

export async function upcomingTimeOff(tx: TenantTx, clinicianId: string, now: Date): Promise<TimeOffReply[]> {
  const rows = await tx.db
    .select()
    .from(clinicianTimeOff)
    .where(and(eq(clinicianTimeOff.tenantId, tx.context.tenantId), eq(clinicianTimeOff.clinicianId, clinicianId), gt(clinicianTimeOff.endsAt, now)))
    .orderBy(asc(clinicianTimeOff.startsAt));
  return rows.map(timeOffReply);
}

export async function addTimeOff(
  tx: TenantTx,
  clinicianId: string,
  input: { startsAt: string; endsAt: string; reason: TimeOffReason },
  acting: Acting,
): Promise<TimeOffReply> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertSelfOrManager(acting, clinician);
  const [row] = await tx.db
    .insert(clinicianTimeOff)
    .values({ tenantId: tx.context.tenantId, clinicianId, startsAt: new Date(input.startsAt), endsAt: new Date(input.endsAt), reason: input.reason, createdBy: acting.userId })
    .returning();
  if (!row) throw new Error('The time off was not saved');
  const facts = { timeOffId: row.id, reason: input.reason };
  await audit(tx, { action: 'clinician.time_off_added', zone: 'operational', ...record(clinicianId), details: facts });
  await emitEvent(tx, { type: 'clinician.time_off_added', ...record(clinicianId), payload: { ...facts, startsAt: input.startsAt, endsAt: input.endsAt } });
  return timeOffReply(row);
}

export async function removeTimeOff(tx: TenantTx, clinicianId: string, timeOffId: string, acting: Acting): Promise<void> {
  const clinician = await clinicianById(tx, clinicianId, { lock: true });
  assertSelfOrManager(acting, clinician);
  const removed = await tx.db
    .delete(clinicianTimeOff)
    .where(and(eq(clinicianTimeOff.tenantId, tx.context.tenantId), eq(clinicianTimeOff.clinicianId, clinicianId), eq(clinicianTimeOff.id, timeOffId)))
    .returning({ id: clinicianTimeOff.id });
  if (removed.length === 0) throw new NotFoundError('Time off');
  await audit(tx, { action: 'clinician.time_off_removed', zone: 'operational', ...record(clinicianId), details: { timeOffId } });
  await emitEvent(tx, { type: 'clinician.time_off_removed', ...record(clinicianId), payload: { timeOffId } });
}

export interface ClinicianCalendar {
  clinicianId: string;
  timeZone: string;
  hours: HoursBlock[];
  /** Time off that hasn't ended by `now`. */
  timeOff: { startsAt: Date; endsAt: Date }[];
}

/**
 * What booking needs to cut a person's slots (docs/decisions/consults.md
 * CNS12): their zone, weekly hours and time off. Null if they aren't a
 * clinician here. `lock` holds the clinician row, so two bookings for one
 * clinician queue behind each other.
 */
export async function clinicianCalendar(tx: TenantTx, userId: string, now: Date, options: { lock?: boolean } = {}): Promise<ClinicianCalendar | null> {
  const row = await clinicianByUserId(tx, userId);
  if (!row) return null;
  if (options.lock) await clinicianById(tx, row.clinicianId, { lock: true });
  const timeOff = await upcomingTimeOff(tx, row.clinicianId, now);
  return {
    clinicianId: row.clinicianId,
    timeZone: row.timeZone,
    hours: await hoursOf(tx, row.clinicianId),
    timeOff: timeOff.map((span) => ({ startsAt: new Date(span.startsAt), endsAt: new Date(span.endsAt) })),
  };
}
