import { randomUUID } from 'node:crypto';
import type { App } from '../../src/app.js';
import { connectPrescribing, fakeParchment, type PrescribingPatient, type QualifyingConsult } from '../../src/modules/prescribing/index.js';
import { headers, signIn } from './app.js';

/**
 * Stand-ins for the patients, consults and credentials modules, and for
 * Parchment's side of prescribing. Made-up people only.
 */
export const world = {
  patients: new Map<string, PrescribingPatient>(),
  consults: [] as { patientId: string; clinicianUserId: string; consult: QualifyingConsult }[],
  /** People whose registration or indemnity has lapsed. */
  notInGoodStanding: new Set<string>(),
};

export function connectStandIns(): void {
  connectPrescribing({
    getPatientForPrescribing: async (_tx, patientId) => world.patients.get(patientId) ?? null,
    findQualifyingConsult: async (_tx, query) => {
      const at = query.at ?? new Date();
      const found = world.consults.find((c) => c.patientId === query.patientId && c.clinicianUserId === query.clinicianUserId && c.consult.qualifiedAt <= at);
      return found?.consult ?? null;
    },
    clinicianStanding: async (_tx, userId) =>
      world.notInGoodStanding.has(userId) ? { mayPrescribe: false, reasons: ['registration_lapsed'] } : { mayPrescribe: true, reasons: [] },
  });
}

/** A made-up patient with everything Parchment needs. */
export function madeUpPatient(changes: Partial<PrescribingPatient> = {}): PrescribingPatient {
  const patient: PrescribingPatient = {
    patientId: randomUUID(),
    givenName: 'Alex',
    familyName: 'Sample',
    dateOfBirth: '1990-01-01',
    sex: 'not_stated',
    email: `${randomUUID()}@example.test`,
    mobile: '0400000000',
    address: { line1: '1 Test Street', line2: null, suburb: 'Sampleton', state: 'NSW', postcode: '2000' },
    medicare: null,
    ...changes,
  };
  world.patients.set(patient.patientId, patient);
  return patient;
}

/** A phone consult between the clinician and the patient that qualified an hour before `at`. */
export function consultBetween(patientId: string, clinicianUserId: string, at = new Date()): QualifyingConsult {
  const qualifiedAt = new Date(at.getTime() - 60 * 60 * 1000);
  const consult = { consultId: randomUUID(), mode: 'phone' as const, startedAt: qualifiedAt, endedAt: null, qualifiedAt };
  world.consults.push({ patientId, clinicianUserId, consult });
  return consult;
}

/** A prescriber with a Parchment account under the same email. */
export function parchmentAccountFor(email: string): string {
  const parchmentUserId = `usr_${randomUUID().slice(0, 8)}`;
  fakeParchment.users.push({ parchmentUserId, email: email.toLowerCase() });
  return parchmentUserId;
}

/** Opens Parchment for a patient as a staff member. */
export async function openParchment(app: App, tenantId: string, email: string, patientId: string) {
  return app.inject({ method: 'POST', url: '/v1/prescribing-sessions', headers: headers(await signIn(email), tenantId), payload: { patientId } });
}
