import { describe, expect, it } from 'vitest';
import { addDays, addMonths, latestDeferredStart, nextStart } from '../../src/modules/billing/periods.js';

/** Billing period dates (docs/decisions/billing.md BIL15, BIL20). */
describe('billing period dates', () => {
  it('keeps a monthly anchor day, landing on the last day of shorter months', () => {
    const starts = ['2027-01-31'];
    for (let i = 0; i < 4; i += 1) starts.push(nextStart(starts.at(-1)!, { unit: 'month', count: 1 }, 31));
    expect(starts).toEqual(['2027-01-31', '2027-02-28', '2027-03-31', '2027-04-30', '2027-05-31']);
  });

  it('knows leap years, and crosses the year', () => {
    expect(addMonths('2028-01-29', 1, 29)).toBe('2028-02-29');
    expect(addMonths('2027-11-15', 3, 15)).toBe('2028-02-15');
    expect(nextStart('2027-12-31', { unit: 'month', count: 12 }, 31)).toBe('2028-12-31');
  });

  it('counts weeks as days, whatever daylight saving does', () => {
    expect(nextStart('2027-03-29', { unit: 'week', count: 4 }, 29)).toBe('2027-04-26');
    expect(addDays('2027-10-01', 7)).toBe('2027-10-08');
    expect(addDays('2027-12-30', 3)).toBe('2028-01-02');
  });

  it('lets the next period start at most three months after the current one ends', () => {
    expect(latestDeferredStart('2027-11-30')).toBe('2028-02-29');
    expect(latestDeferredStart('2027-05-15')).toBe('2027-08-15');
  });

  it('refuses something that is not a calendar date', () => {
    expect(() => addDays('15/05/2027', 1)).toThrow('Not a calendar date');
  });
});
