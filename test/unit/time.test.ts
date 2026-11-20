import { describe, expect, it } from 'vitest';
import { isTimeZone, localDate } from '../../src/lib/time.js';

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
