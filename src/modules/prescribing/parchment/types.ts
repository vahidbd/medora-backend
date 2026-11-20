/**
 * Parchment as Medora sees it (ADR 0013): the calls prescribing needs,
 * in Medora's words. The live client (client.ts) maps these to Parchment's
 * API; the fake (fake.ts) keeps them in memory for development and tests.
 */

/** What Parchment needs to create or update a patient. Only identity and contact fields (RX2). */
export interface ParchmentPatientDetails {
  /** Our patient id, which Parchment echoes back on every webhook. */
  partnerPatientId: string;
  givenName: string;
  familyName: string;
  /** YYYY-MM-DD. */
  dateOfBirth: string;
  sex: 'M' | 'F' | 'I' | 'N';
  email: string;
  /** Ten digits starting with 0. */
  mobile: string | null;
  address: { streetNumber: string; streetName: string; suburb: string; state: string; postcode: string } | null;
  medicare: { number: string; irn: string | null; validTo: string | null } | null;
}

export interface ParchmentUser {
  parchmentUserId: string;
  email: string | null;
}

export interface ParchmentClient {
  createPatient(details: ParchmentPatientDetails): Promise<{ parchmentPatientId: string }>;
  updatePatient(parchmentPatientId: string, details: ParchmentPatientDetails): Promise<void>;
  /** The organisation's users, to find a prescriber's Parchment account by email (RX3). */
  listUsers(): Promise<ParchmentUser[]>;
}

/** Parchment refused or failed a call. `fields` names the patient fields it refused, never their values. */
export class ParchmentFailure extends Error {
  readonly status: number;
  readonly fields: string[];

  constructor(status: number, fields: string[] = []) {
    super(`Parchment answered ${status}`);
    this.name = 'ParchmentFailure';
    this.status = status;
    this.fields = fields;
  }
}
