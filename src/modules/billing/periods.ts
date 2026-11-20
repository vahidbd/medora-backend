import type { IntervalUnit } from '../../db/schema/values.js';

/**
 * Billing period dates (docs/decisions/billing.md BIL15, BIL20). Plain
 * calendar dates (YYYY-MM-DD) in the subscription's time zone, so no clock
 * or daylight saving can move them; "today" comes from localDate (ADR 0017).
 */

export interface Interval {
  unit: IntervalUnit;
  count: number;
}

/** How far after the current period's end the next one may start, across pauses and skips together (BIL20). */
export const MAX_DEFERRAL_MONTHS = 3;

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function parts(date: string): [number, number, number] {
  const match = DATE.exec(date);
  if (!match) throw new Error(`Not a calendar date: ${date}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function format(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function addDays(date: string, days: number): string {
  const [year, month, day] = parts(date);
  // Calendar arithmetic only: the UTC fields of this Date are the calendar date itself, not an instant anyone sees.
  const moved = new Date(Date.UTC(year, month - 1, day + days));
  return format(moved.getUTCFullYear(), moved.getUTCMonth() + 1, moved.getUTCDate());
}

/** Months later, on the anchor day or the month's last day when it is shorter (31 Jan, 28 Feb, 31 Mar). */
export function addMonths(date: string, months: number, anchorDay: number): string {
  const [year, month] = parts(date);
  const index = year * 12 + (month - 1) + months;
  const targetYear = Math.floor(index / 12);
  const targetMonth = (index % 12) + 1;
  const day = Math.min(anchorDay, daysInMonth(targetYear, targetMonth));
  return format(targetYear, targetMonth, day);
}

/** The start of the period after one starting on `date`. */
export function nextStart(date: string, interval: Interval, anchorDay: number): string {
  return interval.unit === 'week' ? addDays(date, 7 * interval.count) : addMonths(date, interval.count, anchorDay);
}

/** The latest the next period may start after a current period ending on `endsOn`. */
export function latestDeferredStart(endsOn: string): string {
  const [, , day] = parts(endsOn);
  return addMonths(endsOn, MAX_DEFERRAL_MONTHS, day);
}

export function dayOfMonth(date: string): number {
  return parts(date)[2];
}
