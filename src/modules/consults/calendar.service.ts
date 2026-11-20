import { and, asc, eq, gt, lt, ne } from 'drizzle-orm';
import { consults, tenants } from '../../db/schema/index.js';
import type { TenantTx } from '../../db/tenant.js';
import { addDays, localDate } from '../../lib/time.js';
import type { ClinicianCalendar } from '../clinicians/index.js';
import { freeSlots, type Span, slotsFromHours } from './slots.js';

/**
 * Which slots can be booked (docs/decisions/consults.md CNS12): cut from the
 * clinician's hours in their own zone, outside time off, clear of their other
 * consults, from 15 minutes ahead to 60 days ahead. Platform constants, not
 * tenant settings.
 */
export const BOOKING_NOTICE_MINUTES = 15;
export const BOOKING_HORIZON_DAYS = 60;

export function bookingWindow(now: Date): { earliest: Date; latest: Date } {
  return {
    earliest: new Date(now.getTime() + BOOKING_NOTICE_MINUTES * 60_000),
    latest: new Date(now.getTime() + BOOKING_HORIZON_DAYS * 86_400_000),
  };
}

/** Consults that hold time, for one clinician or one patient: everything but cancelled (a no-show keeps its slot). */
export async function busyFor(tx: TenantTx, who: { clinicianUserId: string } | { patientId: string }, range: Span): Promise<Span[]> {
  const whose = 'clinicianUserId' in who ? eq(consults.clinicianUserId, who.clinicianUserId) : eq(consults.patientId, who.patientId);
  const rows = await tx.db
    .select({ startsAt: consults.scheduledStart, endsAt: consults.scheduledEnd })
    .from(consults)
    .where(
      and(
        eq(consults.tenantId, tx.context.tenantId),
        whose,
        ne(consults.status, 'cancelled'),
        lt(consults.scheduledStart, range.endsAt),
        gt(consults.scheduledEnd, range.startsAt),
      ),
    )
    .orderBy(asc(consults.scheduledStart));
  return rows;
}

/** The clinician's free slots starting between `from` and `to`, inside the booking window. */
export async function offeredSlots(tx: TenantTx, calendar: ClinicianCalendar, clinicianUserId: string, now: Date, range: { from: Date; to: Date }): Promise<Span[]> {
  const window = bookingWindow(now);
  const earliest = range.from > window.earliest ? range.from : window.earliest;
  const latest = range.to < window.latest ? range.to : window.latest;
  if (latest < earliest) return [];
  // A day either side, so a slot near midnight in the clinician's zone is never missed.
  const fromDate = addDays(localDate(earliest, calendar.timeZone), -1);
  const toDate = addDays(localDate(latest, calendar.timeZone), 1);
  const slots = slotsFromHours(calendar.hours, calendar.timeZone, fromDate, toDate);
  const last = slots.at(-1)?.endsAt ?? latest;
  const busy = [...calendar.timeOff, ...(await busyFor(tx, { clinicianUserId }, { startsAt: earliest, endsAt: last }))];
  return freeSlots(slots, busy, { earliest, latest });
}

/** The slot from the clinician's hours that starts exactly then, busy or not. */
export function slotStartingAt(calendar: ClinicianCalendar, startsAt: Date): Span | null {
  const date = localDate(startsAt, calendar.timeZone);
  return slotsFromHours(calendar.hours, calendar.timeZone, date, date).find((slot) => slot.startsAt.getTime() === startsAt.getTime()) ?? null;
}

export const overlapsAny = (span: Span, others: Span[]) => others.some((other) => span.startsAt < other.endsAt && other.startsAt < span.endsAt);

/** The tenant's own zone (ADR 0017). */
export async function tenantTimeZone(tx: TenantTx): Promise<string> {
  const [tenant] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return tenant?.timeZone ?? 'Australia/Sydney';
}

/** "Today" for the tenant: age checks are on its calendar day (ADR 0017). */
export async function tenantToday(tx: TenantTx, now: Date): Promise<string> {
  return localDate(now, await tenantTimeZone(tx));
}
