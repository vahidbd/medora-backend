import { describe, expect, it } from 'vitest';
import { addDays, instantAt, isTimeZone, localDate, weekdayOf } from '../../src/lib/time.js';

describe("today depends on whose clock (ADR 0017)", () => {
  // 20 Nov 2026, 14:30 UTC: already the 21st in Sydney, still the 20th in Perth.
  const instant = new Date(Date.UTC(2026, 10, 20, 14, 30));

  it('gives the calendar date in the named zone', () => {
    expect(localDate(instant, 'Australia/Sydney')).toBe('2026-11-21');
    expect(localDate(instant, 'Australia/Perth')).toBe('2026-11-20');
  });

  it('knows a time zone name from a typo', () => {
    expect(isTimeZone('Australia/Hobart')).toBe(true);
    expect(isTimeZone('Australia/Hobarth')).toBe(false);
  });
});

describe('wall-clock times in a zone (ADR 0017)', () => {
  it('finds the instant a local time happens, in summer and winter', () => {
    expect(instantAt('2026-11-20', '09:00', 'Australia/Sydney')).toEqual(new Date('2026-11-19T22:00:00Z'));
    expect(instantAt('2026-06-20', '09:00', 'Australia/Sydney')).toEqual(new Date('2026-06-19T23:00:00Z'));
    expect(instantAt('2026-11-20', '09:00', 'Australia/Perth')).toEqual(new Date('2026-11-20T01:00:00Z'));
  });

  it('has no instant for a time daylight saving skips, and takes the first of a time it repeats', () => {
    // Sydney: clocks go from 02:00 to 03:00 on 4 Oct 2026, and from 03:00 back to 02:00 on 5 Apr 2026.
    expect(instantAt('2026-10-04', '02:30', 'Australia/Sydney')).toBeNull();
    expect(instantAt('2026-04-05', '02:30', 'Australia/Sydney')).toEqual(new Date('2026-04-04T15:30:00Z'));
  });

  it('counts weekdays from Monday and steps over month ends', () => {
    expect(weekdayOf('2026-11-23')).toBe(1);
    expect(weekdayOf('2026-11-22')).toBe(7);
    expect(addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
  });
});
