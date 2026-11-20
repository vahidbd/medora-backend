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
