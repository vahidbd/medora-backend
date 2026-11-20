import { and, count, desc, eq, gte, lt, ne } from 'drizzle-orm';
import { consults } from '../../db/schema/index.js';
import type { ConsultPurpose } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { addDays, instantAt, localDate } from '../../lib/time.js';
import { clinicianCalendar, listClinicians } from '../clinicians/index.js';
import { busyFor, offeredSlots, overlapsAny, slotStartingAt } from './calendar.service.js';
import type { Span } from './slots.js';

/**
 * Times offered without naming a clinician, and who takes a consult booked
 * that way (docs/decisions/consults.md CNS18, CNS19). The clinician is chosen
 * when the consult is booked, never shown first, so the times a patient sees
 * are every eligible clinician's together.
 */

export const needsPrescriber = (purpose: ConsultPurpose) => purpose === 'initial' || purpose === 'review';

/** Clinicians who may take a consult of this purpose now (CNS13), in a fixed order. */
async function eligibleClinicians(tx: TenantTx, purpose: ConsultPurpose, now: Date): Promise<string[]> {
  return (await listClinicians(tx, now))
    .filter((c) => c.standing.mayConsult && (!needsPrescriber(purpose) || c.standing.mayPrescribe))
    .map((c) => c.userId)
    .sort();
}

/** CNS18: every eligible clinician's free slots together. Where two start at once, the shorter is shown. */
export async function pooledSlots(tx: TenantTx, purpose: ConsultPurpose, now: Date, range: { from: Date; to: Date }): Promise<Span[]> {
  const byStart = new Map<number, Span>();
  for (const userId of await eligibleClinicians(tx, purpose, now)) {
    const calendar = await clinicianCalendar(tx, userId, now);
    if (!calendar) continue;
    for (const slot of await offeredSlots(tx, calendar, userId, now, range)) {
      const known = byStart.get(slot.startsAt.getTime());
      if (!known || slot.endsAt < known.endsAt) byStart.set(slot.startsAt.getTime(), slot);
    }
  }
  return [...byStart.values()].sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

/** The clinician of the patient's latest completed consult, for continuity. */
async function lastClinicianOf(tx: TenantTx, patientId: string): Promise<string | null> {
  const [row] = await tx.db
    .select({ clinicianUserId: consults.clinicianUserId })
    .from(consults)
    .where(and(eq(consults.tenantId, tx.context.tenantId), eq(consults.patientId, patientId), eq(consults.status, 'completed')))
    .orderBy(desc(consults.scheduledStart))
    .limit(1);
  return row?.clinicianUserId ?? null;
}

/** How many consults hold time on the clinician's own calendar day of `at` (ADR 0017). */
async function consultsOnDay(tx: TenantTx, clinicianUserId: string, timeZone: string, at: Date): Promise<number> {
  const date = localDate(at, timeZone);
  const startsAt = instantAt(date, '00:00', timeZone) ?? new Date(at.getTime() - 12 * 3_600_000);
  const endsAt = instantAt(addDays(date, 1), '00:00', timeZone) ?? new Date(at.getTime() + 12 * 3_600_000);
  const [row] = await tx.db
    .select({ n: count() })
    .from(consults)
    .where(
      and(
        eq(consults.tenantId, tx.context.tenantId),
        eq(consults.clinicianUserId, clinicianUserId),
        ne(consults.status, 'cancelled'),
        gte(consults.scheduledStart, startsAt),
        lt(consults.scheduledStart, endsAt),
      ),
    );
  return row?.n ?? 0;
}

/**
 * CNS19: who takes a consult booked for a time without a clinician named.
 * Among the eligible clinicians with that slot free: the one asked for, then
 * the patient's last clinician, then whoever has the fewest consults that
 * day, ties by a fixed order. Booking re-checks the slot with the clinician
 * locked, so a race still ends in `slot_taken`.
 */
export async function assignClinician(
  tx: TenantTx,
  input: { patientId: string; purpose: ConsultPurpose; startsAt: Date; prefer?: string | null },
  now: Date,
): Promise<string> {
  const free: { userId: string; timeZone: string }[] = [];
  for (const userId of await eligibleClinicians(tx, input.purpose, now)) {
    const calendar = await clinicianCalendar(tx, userId, now);
    const slot = calendar && slotStartingAt(calendar, input.startsAt);
    if (!calendar || !slot || overlapsAny(slot, calendar.timeOff)) continue;
    if ((await busyFor(tx, { clinicianUserId: userId }, slot)).length > 0) continue;
    free.push({ userId, timeZone: calendar.timeZone });
  }
  if (free.length === 0) throw new BusinessRuleError('That time is no longer available', 'slot_taken');
  for (const choice of [input.prefer, await lastClinicianOf(tx, input.patientId)]) {
    if (choice && free.some((c) => c.userId === choice)) return choice;
  }
  let chosen = free[0]!;
  let fewest = await consultsOnDay(tx, chosen.userId, chosen.timeZone, input.startsAt);
  for (const candidate of free.slice(1)) {
    const n = await consultsOnDay(tx, candidate.userId, candidate.timeZone, input.startsAt);
    if (n < fewest) [chosen, fewest] = [candidate, n];
  }
  return chosen.userId;
}
