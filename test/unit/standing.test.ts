import { describe, expect, it } from 'vitest';
import type { Profession } from '../../src/db/schema/values.js';
import { type CredentialFacts, standingOf } from '../../src/modules/clinicians/standing.js';

/** Whether a clinician may consult and prescribe (docs/decisions/workforce.md WRK1 to WRK5). */

const now = new Date('2026-11-20T01:00:00Z');
const today = '2026-11-20';
const checked = new Date('2026-11-10T00:00:00Z');

const registration = (overrides: Partial<CredentialFacts> = {}): CredentialFacts => ({
  kind: 'registration',
  registrationStatus: 'practising',
  conditions: null,
  conditionsReviewedAt: null,
  endorsement: null,
  coversTelehealthNewPatients: null,
  expiresOn: '2027-09-30',
  verifiedAt: checked,
  withdrawnAt: null,
  createdAt: new Date('2026-11-01T00:00:00Z'),
  ...overrides,
});
const indemnity = (overrides: Partial<CredentialFacts> = {}): CredentialFacts => ({
  ...registration(),
  kind: 'indemnity',
  registrationStatus: null,
  coversTelehealthNewPatients: true,
  expiresOn: '2027-06-30',
  ...overrides,
});
const endorsement = (overrides: Partial<CredentialFacts> = {}): CredentialFacts => ({
  ...registration(),
  kind: 'endorsement',
  registrationStatus: null,
  endorsement: 'nurse_practitioner',
  expiresOn: null,
  ...overrides,
});

function standing(profession: Profession, credentials: CredentialFacts[], extra: { suspendedAt?: Date; membershipActive?: boolean } = {}) {
  return standingOf({
    membershipActive: extra.membershipActive ?? true,
    clinician: { profession, suspendedAt: extra.suspendedAt ?? null },
    credentials,
    today,
    now,
  });
}

describe('standing', () => {
  it('lets a doctor with a checked, current registration and indemnity consult and prescribe', () => {
    expect(standing('medical_practitioner', [registration(), indemnity()])).toEqual({ mayConsult: true, mayPrescribe: true, reasons: [], warnings: [] });
  });

  it('lets nobody without a clinician profile do either', () => {
    expect(standingOf({ membershipActive: true, clinician: null, credentials: [], today, now })).toMatchObject({
      mayConsult: false,
      mayPrescribe: false,
      reasons: ['no_clinician_profile'],
    });
  });

  it('stops a suspended clinician, or one whose access is paused, whatever the credentials say (WRK3)', () => {
    expect(standing('medical_practitioner', [registration(), indemnity()], { suspendedAt: now }).reasons).toEqual(['suspended']);
    expect(standing('medical_practitioner', [registration(), indemnity()], { membershipActive: false }).reasons).toEqual(['membership_inactive']);
  });

  it("doesn't count a credential nobody has checked (WRK2)", () => {
    const result = standing('medical_practitioner', [registration({ verifiedAt: null }), indemnity({ verifiedAt: null })]);
    expect(result.mayConsult).toBe(false);
    expect(result.reasons).toEqual(['registration_unverified', 'indemnity_unverified']);
  });

  it('says what is missing when nothing was recorded', () => {
    expect(standing('registered_nurse', []).reasons).toEqual(['registration_missing', 'indemnity_missing', 'not_a_prescriber']);
  });

  it('keeps a checked credential counting while its renewal waits to be checked', () => {
    const renewal = registration({ verifiedAt: null, createdAt: new Date('2026-11-15T00:00:00Z') });
    expect(standing('medical_practitioner', [registration(), renewal, indemnity()]).mayPrescribe).toBe(true);
  });

  it('ignores a withdrawn credential', () => {
    expect(standing('medical_practitioner', [registration({ withdrawnAt: now }), indemnity()]).reasons).toEqual(['registration_missing']);
  });

  it('counts a credential to the end of its expiry day in the tenant zone, then stops (WRK3)', () => {
    expect(standing('medical_practitioner', [registration({ expiresOn: today }), indemnity()]).mayConsult).toBe(true);
    expect(standing('medical_practitioner', [registration({ expiresOn: '2026-11-19' }), indemnity()]).reasons).toEqual(['registration_expired']);
    expect(standing('medical_practitioner', [registration(), indemnity({ expiresOn: '2026-11-19' })]).reasons).toEqual(['indemnity_expired']);
  });

  it('blocks a registration that is not practising, at once (WRK3)', () => {
    for (const status of ['non_practising', 'suspended', 'cancelled'] as const) {
      expect(standing('medical_practitioner', [registration({ registrationStatus: status }), indemnity()]).reasons).toEqual(['registration_not_practising']);
    }
  });

  it('blocks a registration with conditions until someone reviews them (WRK4)', () => {
    const withConditions = registration({ conditions: 'Must not prescribe Schedule 8 medicines' });
    expect(standing('medical_practitioner', [withConditions, indemnity()]).reasons).toEqual(['registration_conditions_unreviewed']);
    expect(standing('medical_practitioner', [{ ...withConditions, conditionsReviewedAt: checked }, indemnity()]).mayConsult).toBe(true);
  });

  it('needs indemnity that covers telehealth with new patients (WRK1)', () => {
    expect(standing('medical_practitioner', [registration(), indemnity({ coversTelehealthNewPatients: false })]).reasons).toEqual([
      'indemnity_excludes_telehealth',
    ]);
  });

  it('lets a nurse practitioner prescribe only with a checked, current endorsement', () => {
    const base = [registration(), indemnity()];
    expect(standing('nurse_practitioner', base)).toMatchObject({ mayConsult: true, mayPrescribe: false, reasons: ['endorsement_missing'] });
    expect(standing('nurse_practitioner', [...base, endorsement({ verifiedAt: null })]).reasons).toEqual(['endorsement_unverified']);
    expect(standing('nurse_practitioner', [...base, endorsement({ expiresOn: '2026-11-01' })]).reasons).toEqual(['endorsement_expired']);
    expect(standing('nurse_practitioner', [...base, endorsement()]).mayPrescribe).toBe(true);
  });

  it('lets other professions consult but never prescribe', () => {
    for (const profession of ['registered_nurse', 'pharmacist', 'dietitian', 'psychologist'] as const) {
      expect(standing(profession, [registration(), indemnity()])).toMatchObject({ mayConsult: true, mayPrescribe: false, reasons: ['not_a_prescriber'] });
    }
  });

  it('needs no registration for a health coach, only indemnity (WRK1)', () => {
    expect(standing('health_coach', [indemnity()])).toMatchObject({ mayConsult: true, mayPrescribe: false, reasons: ['not_a_prescriber'] });
  });

  it('warns when a check is more than 31 days old, or a credential ends within 30 days (WRK5)', () => {
    const old = registration({ verifiedAt: new Date('2026-10-01T00:00:00Z') });
    expect(standing('medical_practitioner', [old, indemnity()])).toMatchObject({ mayConsult: true, warnings: ['recheck_due'] });
    expect(standing('medical_practitioner', [registration(), indemnity({ expiresOn: '2026-12-15' })]).warnings).toEqual(['expires_soon']);
  });
});
