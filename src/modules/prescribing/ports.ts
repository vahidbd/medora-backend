import type { TenantTx } from '../../db/tenant.js';
import { AppError } from '../../lib/errors.js';

/**
 * What prescribing needs from other modules, in their own shapes, so their
 * front doors plug straight in (src/modules/index.ts) once they land
 * (ADR 0027). Until then every call fails closed: no patient, no consult and
 * no standing means nobody opens Parchment.
 */

/** From the patients module: what Parchment needs. It decrypts, and audits the read itself. */
export interface PrescribingPatient {
  patientId: string;
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  sex: 'female' | 'male' | 'intersex' | 'not_stated';
  email: string;
  mobile: string | null;
  address: { line1: string; line2: string | null; suburb: string; state: 'ACT' | 'NSW' | 'NT' | 'QLD' | 'SA' | 'TAS' | 'VIC' | 'WA'; postcode: string } | null;
  medicare: { number: string; irn: string | null; validTo: string | null } | null;
}

/** From the consults module (ADR 0009): a consult that lets this prescriber write for this patient. */
export interface QualifyingConsult {
  consultId: string;
  mode: 'video' | 'phone';
  startedAt: Date;
  endedAt: Date | null;
  qualifiedAt: Date;
}

export interface PrescribingDependencies {
  getPatientForPrescribing(tx: TenantTx, patientId: string): Promise<PrescribingPatient | null>;
  findQualifyingConsult(tx: TenantTx, query: { patientId: string; clinicianUserId: string; at?: Date }): Promise<QualifyingConsult | null>;
  clinicianStanding(tx: TenantTx, userId: string, at?: Date): Promise<{ mayPrescribe: boolean; reasons: string[] }>;
}

const notConnected = (): never => {
  throw new AppError(503, 'prescribing_not_connected', "Prescribing can't reach patient records and consults yet");
};

const failClosed: PrescribingDependencies = {
  getPatientForPrescribing: notConnected,
  findQualifyingConsult: notConnected,
  clinicianStanding: notConnected,
};

let connected: PrescribingDependencies = failClosed;

/** Called once at start-up by src/modules/index.ts, and by tests with fakes. */
export function connectPrescribing(dependencies: PrescribingDependencies): void {
  connected = dependencies;
}

export function prescribingDependencies(): PrescribingDependencies {
  return connected;
}
