/**
 * Keeping personal and health details out of logs and error reports
 * (ADR 0026). Two layers: the logger drops known personal fields by key,
 * and free text is masked for email addresses and long runs of digits
 * (phone numbers, Medicare and card numbers).
 */

/** Keys the logger replaces with "[redacted]" wherever they appear, one or two levels down. */
const PERSONAL_KEYS = [
  'authorization',
  'cookie',
  'email',
  'phone',
  'mobile',
  'name',
  'firstName',
  'lastName',
  'fullName',
  'dateOfBirth',
  'address',
  'medicareNumber',
  'ihi',
  'answers',
  'notes',
  'note',
  'body',
  'token',
  'password',
  'secret',
];

export const REDACT_PATHS: string[] = PERSONAL_KEYS.flatMap((key) => [key, `*.${key}`, `*.*.${key}`]).concat([
  'req.headers.authorization',
  'req.headers.cookie',
]);

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
/** Digits, possibly spaced, not part of an id (a UUID's segments are joined by hyphens and letters). */
const LONG_NUMBER = /(?<![\w-])\d[\d ]{6,}\d(?![\w-])/g;

/** Free text with email addresses and runs of eight or more digits masked. */
export function maskText(text: string): string {
  return text.replace(EMAIL, '[email]').replace(LONG_NUMBER, (run) => (run.replace(/\D/g, '').length >= 8 ? '[number]' : run));
}

/**
 * An error's message as it may be logged: a failed query keeps its SQL but
 * loses its parameters (they are the values written or searched for), and
 * the rest is masked.
 */
export function safeErrorMessage(error: Error): string {
  const withoutParams = error.message.replace(/\nparams:[\s\S]*$/, '\nparams: [left out]');
  return maskText(withoutParams);
}
