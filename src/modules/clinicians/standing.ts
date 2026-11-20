import type { CredentialKind, Endorsement, Profession, RegistrationStatus } from '../../db/schema/values.js';

/**
 * Whether a clinician may consult and prescribe, worked out from their rows
 * when it is asked, so a lapse takes effect the moment it happens with no
 * job to run (docs/decisions/workforce.md WRK3). Pure: the caller loads the
 * rows and says what "today" is in the tenant's time zone.
 */
export const STANDING_REASONS = [
  'no_clinician_profile',
  'membership_inactive',
  'suspended',
  'registration_missing',
  'registration_unverified',
  'registration_expired',
  'registration_not_practising',
  'registration_conditions_unreviewed',
  'indemnity_missing',
  'indemnity_unverified',
  'indemnity_expired',
  'indemnity_excludes_telehealth',
  'not_a_prescriber',
  'endorsement_missing',
  'endorsement_unverified',
  'endorsement_expired',
] as const;
export type StandingReason = (typeof STANDING_REASONS)[number];

/** Things to act on soon that don't block anyone yet. */
export const STANDING_WARNINGS = ['recheck_due', 'expires_soon'] as const;
export type StandingWarning = (typeof STANDING_WARNINGS)[number];

export interface Standing {
  mayConsult: boolean;
  mayPrescribe: boolean;
  /** Why not, for consulting first, then for prescribing. Empty when both are allowed. */
  reasons: StandingReason[];
  warnings: StandingWarning[];
}

export interface CredentialFacts {
  kind: CredentialKind;
  registrationStatus: RegistrationStatus | null;
  conditions: string | null;
  conditionsReviewedAt: Date | null;
  endorsement: Endorsement | null;
  coversTelehealthNewPatients: boolean | null;
  /** YYYY-MM-DD, or null for an endorsement with no end date. */
  expiresOn: string | null;
  verifiedAt: Date | null;
  withdrawnAt: Date | null;
  createdAt: Date;
}

export interface StandingInput {
  membershipActive: boolean;
  clinician: { profession: Profession; suspendedAt: Date | null } | null;
  credentials: CredentialFacts[];
  /** YYYY-MM-DD in the tenant's time zone. */
  today: string;
  now: Date;
}

/** WRK5: a registration checked against the register more than this long ago is due a re-check. */
export const RECHECK_AFTER_DAYS = 31;
/** WRK5: a credential ending within this many days is flagged. */
export const EXPIRY_WARNING_DAYS = 30;

const PRESCRIBERS: ReadonlySet<Profession> = new Set(['medical_practitioner', 'nurse_practitioner']);
/** Health coaches hold no registration; every other profession does (WRK1). */
const UNREGISTERED: ReadonlySet<Profession> = new Set(['health_coach']);

const DAY_MS = 86_400_000;

function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const shifted = new Date(Date.UTC(y, m - 1, d) + days * DAY_MS);
  return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}-${String(shifted.getUTCDate()).padStart(2, '0')}`;
}

/**
 * The credential that counts for one kind: the newest verified one still
 * held. An unverified renewal doesn't replace a verified credential until
 * someone checks it (WRK2).
 */
function counting(credentials: CredentialFacts[], kind: CredentialKind, endorsement?: Endorsement) {
  const held = credentials.filter((c) => c.kind === kind && c.withdrawnAt === null && (endorsement === undefined || c.endorsement === endorsement));
  const newest = (list: CredentialFacts[]) => [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  return { verified: newest(held.filter((c) => c.verifiedAt !== null)), anyHeld: held.length > 0 };
}

const expired = (credential: CredentialFacts, today: string) => credential.expiresOn !== null && credential.expiresOn < today;

export function standingOf(input: StandingInput): Standing {
  const reasons: StandingReason[] = [];
  const warnings = new Set<StandingWarning>();
  const { clinician, today, now } = input;
  if (!clinician) return { mayConsult: false, mayPrescribe: false, reasons: ['no_clinician_profile'], warnings: [] };
  if (!input.membershipActive) reasons.push('membership_inactive');
  if (clinician.suspendedAt) reasons.push('suspended');

  const soon = addDays(today, EXPIRY_WARNING_DAYS);
  const watchExpiry = (credential: CredentialFacts) => {
    if (credential.expiresOn !== null && credential.expiresOn >= today && credential.expiresOn <= soon) warnings.add('expires_soon');
  };

  if (!UNREGISTERED.has(clinician.profession)) {
    const registration = counting(input.credentials, 'registration');
    const current = registration.verified;
    if (!current) reasons.push(registration.anyHeld ? 'registration_unverified' : 'registration_missing');
    else if (expired(current, today)) reasons.push('registration_expired');
    else {
      if (current.registrationStatus !== 'practising') reasons.push('registration_not_practising');
      if (current.conditions && !current.conditionsReviewedAt) reasons.push('registration_conditions_unreviewed');
      watchExpiry(current);
      if (current.verifiedAt && now.getTime() - current.verifiedAt.getTime() > RECHECK_AFTER_DAYS * DAY_MS) warnings.add('recheck_due');
    }
  }

  const indemnity = counting(input.credentials, 'indemnity');
  if (!indemnity.verified) reasons.push(indemnity.anyHeld ? 'indemnity_unverified' : 'indemnity_missing');
  else if (expired(indemnity.verified, today)) reasons.push('indemnity_expired');
  else {
    if (indemnity.verified.coversTelehealthNewPatients !== true) reasons.push('indemnity_excludes_telehealth');
    watchExpiry(indemnity.verified);
  }

  const mayConsult = reasons.length === 0;
  const prescribing: StandingReason[] = [];
  if (!PRESCRIBERS.has(clinician.profession)) prescribing.push('not_a_prescriber');
  else if (clinician.profession === 'nurse_practitioner') {
    const endorsement = counting(input.credentials, 'endorsement', 'nurse_practitioner');
    if (!endorsement.verified) prescribing.push(endorsement.anyHeld ? 'endorsement_unverified' : 'endorsement_missing');
    else if (expired(endorsement.verified, today)) prescribing.push('endorsement_expired');
    else watchExpiry(endorsement.verified);
  }
  return {
    mayConsult,
    mayPrescribe: mayConsult && prescribing.length === 0,
    reasons: [...reasons, ...prescribing],
    warnings: [...warnings],
  };
}
