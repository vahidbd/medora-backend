import { normaliseMobile } from '../patients/index.js';

/**
 * Addresses as Medora stores them: lower-case email and E.164 mobiles, using
 * the patients module's normalisers so a match is exact everywhere.
 */
export { normaliseEmail, normaliseMobile } from '../patients/index.js';

/** An SMS sender: an Australian mobile, or a Twilio number in E.164 (+61 and 9 digits). */
export function normaliseSmsSender(value: string): string | null {
  const digits = value.replace(/[\s()-]/g, '');
  return /^\+61\d{9}$/.test(digits) ? digits : normaliseMobile(value);
}
