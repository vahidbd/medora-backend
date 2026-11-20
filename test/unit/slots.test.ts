import { describe, expect, it } from 'vitest';
import { freeSlots, slotsFromHours } from '../../src/modules/consults/slots.js';

/** Slots from weekly hours (docs/decisions/consults.md CNS12, ADR 0017). */
const local = (date: Date, timeZone = 'Australia/Sydney') =>
  new Intl.DateTimeFormat('en-AU', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(date);

describe('slots from weekly hours', () => {
  it('cuts each block on its own grid, on its own weekdays, in the clinician’s zone', () => {
    const slots = slotsFromHours(
      [
        { weekday: 1, startsAt: '09:00', endsAt: '10:00', slotMinutes: 20 },
        { weekday: 3, startsAt: '13:00', endsAt: '13:45', slotMinutes: 30 },
      ],
      'Australia/Perth',
      '2026-11-23',
      '2026-11-29',
    );
    expect(slots.map((s) => local(s.startsAt, 'Australia/Perth'))).toEqual(['Mon 09:00', 'Mon 09:20', 'Mon 09:40', 'Wed 13:00']);
    expect(slots[0]!.startsAt).toEqual(new Date('2026-11-23T01:00:00Z'));
  });

  it('runs to midnight when the hours end at 24:00', () => {
    const slots = slotsFromHours([{ weekday: 1, startsAt: '23:30', endsAt: '24:00', slotMinutes: 15 }], 'Australia/Sydney', '2026-11-23', '2026-11-23');
    expect(slots.map((s) => local(s.startsAt))).toEqual(['Mon 23:30', 'Mon 23:45']);
    expect(slots[1]!.endsAt).toEqual(new Date('2026-11-23T13:00:00Z'));
  });

  it('leaves out the slots daylight saving skips or stretches, rather than guessing', () => {
    // Sydney, Sunday 4 Oct 2026: 02:00 becomes 03:00. Sunday 5 Apr 2026: 03:00 becomes 02:00.
    const hours = [{ weekday: 7, startsAt: '01:00', endsAt: '04:00', slotMinutes: 30 }];
    const spring = slotsFromHours(hours, 'Australia/Sydney', '2026-10-04', '2026-10-04');
    expect(spring.map((s) => local(s.startsAt))).toEqual(['Sun 01:00', 'Sun 03:00', 'Sun 03:30']);
    const autumn = slotsFromHours(hours, 'Australia/Sydney', '2026-04-05', '2026-04-05');
    expect(autumn.every((s) => s.endsAt.getTime() - s.startsAt.getTime() === 30 * 60_000)).toBe(true);
    expect(autumn.length).toBeGreaterThanOrEqual(5);
  });

  it('keeps only slots inside the window that touch nothing busy', () => {
    const slots = slotsFromHours([{ weekday: 1, startsAt: '09:00', endsAt: '10:00', slotMinutes: 15 }], 'Australia/Sydney', '2026-11-23', '2026-11-23');
    const busy = [{ startsAt: slots[1]!.startsAt, endsAt: new Date(slots[1]!.startsAt.getTime() + 60_000) }];
    const free = freeSlots(slots, busy, { earliest: slots[0]!.startsAt, latest: slots[2]!.startsAt });
    expect(free.map((s) => local(s.startsAt))).toEqual(['Mon 09:00', 'Mon 09:30']);
  });
});
