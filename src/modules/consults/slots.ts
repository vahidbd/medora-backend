import { addDays, instantAt, weekdayOf } from '../../lib/time.js';

/**
 * Slots cut from a clinician's weekly hours (docs/decisions/consults.md
 * CNS12), in the clinician's own time zone (ADR 0017). Pure, so the calendar
 * arithmetic is tested without a database.
 */

export interface WeeklyHours {
  weekday: number;
  startsAt: string;
  endsAt: string;
  slotMinutes: number;
}

export interface Span {
  startsAt: Date;
  endsAt: Date;
}

const minutesOf = (hhmm: string) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));
const hhmmOf = (minutes: number) => `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;

/**
 * Every slot the hours give on each calendar date from `fromDate` to
 * `toDate`, inclusive. A slot that daylight saving skips or stretches is
 * left out rather than guessed at.
 */
export function slotsFromHours(hours: WeeklyHours[], timeZone: string, fromDate: string, toDate: string): Span[] {
  const slots: Span[] = [];
  for (let date = fromDate; date <= toDate; date = addDays(date, 1)) {
    const weekday = weekdayOf(date);
    for (const block of hours.filter((h) => h.weekday === weekday)) {
      const end = minutesOf(block.endsAt);
      for (let minute = minutesOf(block.startsAt); minute + block.slotMinutes <= end; minute += block.slotMinutes) {
        const startsAt = instantAt(date, hhmmOf(minute), timeZone);
        const endsAt = instantAt(date, hhmmOf(minute + block.slotMinutes), timeZone);
        if (!startsAt || !endsAt || endsAt.getTime() - startsAt.getTime() !== block.slotMinutes * 60_000) continue;
        slots.push({ startsAt, endsAt });
      }
    }
  }
  return slots.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
}

const overlaps = (a: Span, b: Span) => a.startsAt < b.endsAt && b.startsAt < a.endsAt;

/** The slots that start inside the booking window and touch nothing busy. */
export function freeSlots(slots: Span[], busy: Span[], window: { earliest: Date; latest: Date }): Span[] {
  return slots.filter((slot) => slot.startsAt >= window.earliest && slot.startsAt <= window.latest && !busy.some((span) => overlaps(slot, span)));
}
