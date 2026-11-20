/**
 * Dates as a person sees them (ADR 0017). Instants are stored in UTC; "today"
 * depends on whose clock, so every calendar date is worked out in a named
 * time zone: the patient's for patient-facing work, the tenant's for staff
 * work. Lint refuses `toISOString().slice(0, 10)`, which is UTC's date.
 */

/** The calendar date (YYYY-MM-DD) an instant falls on in an IANA time zone. */
export function localDate(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-AU', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('year')}-${part('month')}-${part('day')}`;
}

export function isTimeZone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-AU', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/** How far a zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-AU', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'));
  return wall - Math.floor(instant / 1000) * 1000;
}

/**
 * The instant a wall-clock time (YYYY-MM-DD and HH:MM) happens in a zone.
 * Null for a time the clocks skip when daylight saving starts; the earlier
 * of the two for a time that happens twice when it ends.
 */
export function instantAt(date: string, time: string, timeZone: string): Date | null {
  const [year, month, day] = date.split('-').map(Number);
  const [hour, minute] = time.split(':').map(Number);
  const wall = Date.UTC(year!, month! - 1, day!, hour!, minute!);
  const day1 = 86_400_000;
  const candidates = [...new Set([offsetAt(wall - day1, timeZone), offsetAt(wall + day1, timeZone)])]
    .map((offset) => wall - offset)
    .filter((instant) => instant + offsetAt(instant, timeZone) === wall)
    .sort((a, b) => a - b);
  return candidates.length > 0 ? new Date(candidates[0]!) : null;
}

/** ISO weekday (1 is Monday, 7 is Sunday) of a calendar date. */
export function weekdayOf(date: string): number {
  const [year, month, day] = date.split('-').map(Number);
  return new Date(Date.UTC(year!, month! - 1, day!)).getUTCDay() || 7;
}

/** The calendar date `days` after another. */
export function addDays(date: string, days: number): string {
  const [year, month, day] = date.split('-').map(Number);
  const next = new Date(Date.UTC(year!, month! - 1, day! + days));
  return `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
}
