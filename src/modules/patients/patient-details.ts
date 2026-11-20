import { localDate } from '../../lib/time.js';

/**
 * Checks on what a patient types about themselves (docs/decisions/patients.md
 * IDN5 and IDN8). Pure functions: no database, no clock except the one passed in.
 */

/** v1 treats adults only (IDN-03). */
export const MINIMUM_AGE = 18;

/** A real calendar date in YYYY-MM-DD, or null. */
export function parseCalendarDate(value: string): { year: number; month: number; day: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** Whole years between a date of birth and a calendar date (both YYYY-MM-DD). A 29 February birthday turns over on 1 March. */
export function ageOn(dateOfBirth: string, today: string): number | null {
  const born = parseCalendarDate(dateOfBirth);
  const now = parseCalendarDate(today);
  if (!born || !now) return null;
  let age = now.year - born.year;
  if (now.month < born.month || (now.month === born.month && now.day < born.day)) age -= 1;
  return age;
}

export type DateOfBirthProblem = 'not_a_date' | 'in_the_future' | 'too_long_ago' | 'under_age';

/**
 * Why a date of birth can't be accepted, or null when it can. "Today" is the
 * tenant's calendar date (ADR 0017): the patient's own zone isn't known yet
 * when they create their account.
 */
export function dateOfBirthProblem(dateOfBirth: string, now: Date, timeZone: string): DateOfBirthProblem | null {
  const born = parseCalendarDate(dateOfBirth);
  if (!born) return 'not_a_date';
  const today = localDate(now, timeZone);
  if (dateOfBirth > today) return 'in_the_future';
  const age = ageOn(dateOfBirth, today) ?? 0;
  if (age > 120) return 'too_long_ago';
  if (age < MINIMUM_AGE) return 'under_age';
  return null;
}

export const DATE_OF_BIRTH_MESSAGES: Record<DateOfBirthProblem, string> = {
  not_a_date: 'Enter your date of birth as a real date',
  in_the_future: "Your date of birth can't be in the future",
  too_long_ago: 'Check the year of your date of birth',
  under_age: 'This service is for adults 18 and over',
};

/** An Australian mobile number as E.164 (+614XXXXXXXX), or null when it isn't one. Spaces, dashes and brackets are ignored. */
export function normaliseMobile(value: string): string | null {
  const digits = value.replace(/[\s\-()]/g, '');
  if (/^04\d{8}$/.test(digits)) return `+61${digits.slice(1)}`;
  if (/^\+614\d{8}$/.test(digits)) return digits;
  if (/^614\d{8}$/.test(digits)) return `+${digits}`;
  return null;
}

export function normaliseEmail(value: string): string | null {
  const email = value.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

/**
 * A Medicare card number: 10 digits, the first 2 to 6, the ninth a check
 * digit (weights 1, 3, 7, 9, 1, 3, 7, 9 on the first eight, sum modulo 10),
 * the tenth the card's issue number.
 */
export function isMedicareNumber(value: string): boolean {
  if (!/^[2-6]\d{9}$/.test(value)) return false;
  const weights = [1, 3, 7, 9, 1, 3, 7, 9];
  const sum = weights.reduce((total, weight, i) => total + weight * Number(value[i]), 0);
  return sum % 10 === Number(value[8]);
}

/** Medicare card valid-to as YYYY-MM. */
export function isValidTo(value: string): boolean {
  const match = /^(\d{4})-(\d{2})$/.exec(value);
  return Boolean(match) && Number(match![2]) >= 1 && Number(match![2]) <= 12;
}
