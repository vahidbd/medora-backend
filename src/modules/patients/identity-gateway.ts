import { randomUUID } from 'node:crypto';
import { env } from '../../config/env.js';
import type { AuState, IdentityDocument, IdentityOutcome } from '../../db/schema/values.js';

/**
 * Checking a patient's identity document online (IDN-02, docs/decisions/patients.md
 * IDN16). The real gateway (a Document Verification Service broker) is a new
 * provider: it gets its row in docs/providers.md, an ADR and a data
 * processing agreement before it is switched on. Until then development,
 * tests and staging use the fake, and production runs with none (manual
 * checks only).
 */

export type DocumentDetails =
  | { documentType: 'driver_licence'; state: AuState; licenceNumber: string; cardNumber: string }
  | { documentType: 'passport'; passportNumber: string }
  | { documentType: 'medicare_card'; number: string; irn: string; validTo: string };

export interface DocumentCheck {
  /** The legal name and date of birth on the patient record: the document must match these. */
  givenName: string;
  familyName: string;
  dateOfBirth: string;
  document: DocumentDetails;
}

export interface DocumentCheckResult {
  outcome: IdentityOutcome;
  /** The gateway's id for the check; never the document number. */
  reference: string | null;
}

/** A real gateway answers `unavailable` when it can't reach the service, rather than throwing. */
export interface IdentityGateway {
  checkDocument(check: DocumentCheck): Promise<DocumentCheckResult>;
}

export const documentTypeOf = (document: DocumentDetails): IdentityDocument => document.documentType;

const numberOf = (document: DocumentDetails): string =>
  document.documentType === 'driver_licence' ? document.licenceNumber : document.documentType === 'passport' ? document.passportNumber : document.number;

/**
 * The made-up gateway. A document number ending in 0000 doesn't match, one
 * ending in 9999 finds the gateway down, and anything else is verified.
 */
export const fakeIdentityGateway: IdentityGateway = {
  async checkDocument(check) {
    const number = numberOf(check.document);
    if (number.endsWith('9999')) return { outcome: 'unavailable', reference: null };
    return { outcome: number.endsWith('0000') ? 'not_matched' : 'verified', reference: `fake_${randomUUID()}` };
  },
};

/** The configured gateway, or null when online checks are off. */
export function identityGateway(): IdentityGateway | null {
  return env.IDENTITY_GATEWAY === 'fake' ? fakeIdentityGateway : null;
}
