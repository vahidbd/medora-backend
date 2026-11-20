import type { PrescribingPatient } from '../ports.js';
import type { ParchmentPatientDetails } from './types.js';

/**
 * A patient's record as Parchment takes it (RX2): identity and contact only,
 * never intake answers or notes. Returns the details, or the plain-word
 * names of what's missing so the prescriber can fix the record first.
 */
const SEX: Record<PrescribingPatient['sex'], ParchmentPatientDetails['sex']> = { female: 'F', male: 'M', intersex: 'I', not_stated: 'N' };

/** Australian mobile as ten digits starting with 0, or null when it isn't one. */
export function australianMobile(value: string): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('61') && digits.length === 11) digits = `0${digits.slice(2)}`;
  return /^04\d{8}$/.test(digits) ? digits : null;
}

/** "3/12A Smith Street" → number "3/12A", name "Smith Street". Parchment needs a number, so a line without one uses "-". */
export function streetParts(line: string): { streetNumber: string; streetName: string } {
  const match = line.trim().match(/^(\d+[a-z]?(?:\s*\/\s*\d+[a-z]?)?)\s+(.+)$/i);
  return match ? { streetNumber: match[1]!.replace(/\s+/g, ''), streetName: match[2]! } : { streetNumber: '-', streetName: line.trim() };
}

function withSecondLine(parts: { streetNumber: string; streetName: string }, line2: string | null) {
  return line2?.trim() ? { ...parts, streetName: `${parts.streetName}, ${line2.trim()}` } : parts;
}

export function toParchmentPatient(patient: PrescribingPatient): { details: ParchmentPatientDetails } | { missing: string[] } {
  const missing: string[] = [];
  if (!patient.givenName.trim()) missing.push('given name');
  if (!patient.familyName.trim()) missing.push('family name');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(patient.dateOfBirth)) missing.push('date of birth');
  const mobile = patient.mobile ? australianMobile(patient.mobile) : null;
  if (!mobile) missing.push('an Australian mobile number');
  if (!patient.address) missing.push('home address');
  if (missing.length > 0 || !patient.address) return { missing };
  return {
    details: {
      partnerPatientId: patient.patientId,
      givenName: patient.givenName.trim(),
      familyName: patient.familyName.trim(),
      dateOfBirth: patient.dateOfBirth,
      sex: SEX[patient.sex],
      email: patient.email.toLowerCase(),
      mobile,
      address: {
        ...withSecondLine(streetParts(patient.address.line1), patient.address.line2),
        suburb: patient.address.suburb,
        state: patient.address.state,
        postcode: patient.address.postcode,
      },
      medicare: patient.medicare ? { number: patient.medicare.number.replace(/\s/g, ''), irn: patient.medicare.irn, validTo: patient.medicare.validTo } : null,
    },
  };
}
