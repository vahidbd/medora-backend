/**
 * Allowed values, in one place (ADR 0028). The database holds the same lists
 * as CHECK constraints, built from these constants, and
 * test/integration/schema-rules.test.ts fails when the two differ. Adding a
 * value means changing the constant and adding a migration.
 */

/**
 * The starting roles every tenant has (docs/decisions/foundation.md FND3,
 * docs/decisions/admin.md ADM1 and ADM2). Their permissions are in
 * src/lib/permissions.ts and tenants can't edit them.
 */
export const ROLES = [
  'owner',
  'admin',
  'medical_director',
  'prescriber',
  'clinician',
  'support',
  'finance',
  'operations',
  'marketing',
  'compliance',
] as const;
export type Role = (typeof ROLES)[number];

/** What `platform.memberships.role` may hold: a starting role, or `custom` with `custom_role_id` set (ADM1). */
export const MEMBERSHIP_ROLES = [...ROLES, 'custom'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** `invited` until the person's first sign-in after the invitation (ADM5). */
export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'invited'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/**
 * Who did something (ADR 0008): a staff member (`person`, a platform user), a
 * patient acting on their own record (docs/decisions/patients.md IDN2), one
 * of Medora's AI agents, or the system itself.
 */
export const ACTOR_TYPES = ['person', 'patient', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The data zones (ADR 0007). */
export const DATA_ZONES = ['clinical', 'operational', 'marketing', 'platform'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/** Outside services that call Medora's webhooks (ADR 0029, docs/decisions/webhooks.md). */
export const WEBHOOK_PROVIDERS = ['twilio', 'video', 'parchment', 'stripe', 'eway', 'email'] as const;
export type WebhookProvider = (typeof WEBHOOK_PROVIDERS)[number];

/** Where a stored webhook is: waiting, done, or failed and waiting for a retry. */
export const WEBHOOK_STATUSES = ['received', 'processed', 'failed'] as const;
export type WebhookStatus = (typeof WEBHOOK_STATUSES)[number];
/**
 * Who seals tenants' data keys (ADR 0010, docs/decisions/field-encryption.md
 * ENC3). `local` uses FIELD_ENCRYPTION_KEY and is refused in production; the
 * KMS provider is added with its own value and migration.
 */
export const KEY_PROVIDERS = ['local'] as const;
export type KeyProvider = (typeof KEY_PROVIDERS)[number];

/** Sex as the HI Service and electronic prescriptions record it (F, M, I, N). */
export const SEXES = ['female', 'male', 'intersex', 'not_stated'] as const;
export type Sex = (typeof SEXES)[number];

/** Whether a patient's identity has been checked against a document (IDN-02). */
export const IDENTITY_STATUSES = ['unverified', 'verified', 'failed'] as const;
export type IdentityStatus = (typeof IDENTITY_STATUSES)[number];

/** Ways to reach a patient, one row each (ADR 0028). */
export const CONTACT_KINDS = ['email', 'mobile'] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export const ADDRESS_KINDS = ['home'] as const;
export type AddressKind = (typeof ADDRESS_KINDS)[number];

export const AU_STATES = ['ACT', 'NSW', 'NT', 'QLD', 'SA', 'TAS', 'VIC', 'WA'] as const;
export type AuState = (typeof AU_STATES)[number];

/**
 * What a patient consents to (IDN-05, docs/decisions/patients.md IDN12).
 * Marketing consent is the messaging module's, in the marketing zone.
 */
export const CONSENT_KINDS = ['privacy', 'telehealth_terms', 'identity_check', 'pharmacy_sharing'] as const;
export type ConsentKind = (typeof CONSENT_KINDS)[number];

export const CONSENT_DECISIONS = ['given', 'withdrawn'] as const;
export type ConsentDecision = (typeof CONSENT_DECISIONS)[number];

/** How a consent decision reached us. */
export const CONSENT_CHANNELS = ['web', 'phone', 'in_person'] as const;
export type ConsentChannel = (typeof CONSENT_CHANNELS)[number];

/** A clinician's profession: what they are registered as, which sets their scope (docs/decisions/workforce.md WRK1). */
export const PROFESSIONS = [
  'medical_practitioner',
  'nurse_practitioner',
  'registered_nurse',
  'pharmacist',
  'dietitian',
  'psychologist',
  'health_coach',
] as const;
export type Profession = (typeof PROFESSIONS)[number];

/** What a credential row records (WRK2). */
export const CREDENTIAL_KINDS = ['registration', 'endorsement', 'indemnity'] as const;
export type CredentialKind = (typeof CREDENTIAL_KINDS)[number];

/** Who a clinician is registered with. Dietitians are credentialed by their professional body, not Ahpra. */
export const REGISTERING_BODIES = ['ahpra', 'dietitians_australia'] as const;
export type RegisteringBody = (typeof REGISTERING_BODIES)[number];

export const REGISTRATION_TYPES = ['general', 'specialist', 'provisional', 'limited'] as const;
export type RegistrationType = (typeof REGISTRATION_TYPES)[number];

/** Only `practising` lets a clinician consult (WRK3). */
export const REGISTRATION_STATUSES = ['practising', 'non_practising', 'suspended', 'cancelled'] as const;
export type RegistrationStatus = (typeof REGISTRATION_STATUSES)[number];

/** Endorsements Medora reads. A nurse practitioner prescribes only with this one. */
export const ENDORSEMENTS = ['nurse_practitioner'] as const;
export type Endorsement = (typeof ENDORSEMENTS)[number];

/** Why a credential stopped counting. Credentials are never deleted (WRK2). */
export const CREDENTIAL_WITHDRAWAL_REASONS = ['entered_in_error', 'replaced', 'no_longer_held'] as const;
export type CredentialWithdrawalReason = (typeof CREDENTIAL_WITHDRAWAL_REASONS)[number];

/** Why a clinician was suspended. A fixed list, so no free text reaches the audit log. */
export const SUSPENSION_REASONS = ['registration_concern', 'indemnity_concern', 'clinical_governance', 'leave', 'other'] as const;
export type SuspensionReason = (typeof SUSPENSION_REASONS)[number];

export const TIME_OFF_REASONS = ['leave', 'sick', 'training', 'other'] as const;
export type TimeOffReason = (typeof TIME_OFF_REASONS)[number];

/** How a consult is held (docs/decisions/consults.md CNS1). Chat, messages and AI voice calls are never consults. */
export const CONSULT_MODES = ['phone', 'video'] as const;
export type ConsultMode = (typeof CONSULT_MODES)[number];

/** Where a consult is (CNS3). Only in progress and completed consults can qualify a script. */
export const CONSULT_STATUSES = ['scheduled', 'in_progress', 'completed', 'cancelled', 'no_show'] as const;
export type ConsultStatus = (typeof CONSULT_STATUSES)[number];

/** Why a consult is booked (CNS11). Initial and review consults need a prescriber. */
export const CONSULT_PURPOSES = ['initial', 'review', 'follow_up'] as const;
export type ConsultPurpose = (typeof CONSULT_PURPOSES)[number];

/** Why a consult was cancelled (CNS14). `rescheduled` is set only by a move. No free text. */
export const CANCELLATION_REASONS = ['patient_request', 'clinician_unavailable', 'rescheduled', 'booked_in_error', 'other'] as const;
export type CancellationReason = (typeof CANCELLATION_REASONS)[number];

/** Who connected, in consult evidence (CNS2). */
export const EVIDENCE_PARTIES = ['patient', 'clinician'] as const;
export type EvidenceParty = (typeof EVIDENCE_PARTIES)[number];

export const EVIDENCE_EVENTS = ['connected', 'disconnected'] as const;
export type EvidenceEvent = (typeof EVIDENCE_EVENTS)[number];

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: MEMBERSHIP_ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.webhook_inbox', column: 'provider', values: WEBHOOK_PROVIDERS },
  { table: 'platform.webhook_inbox', column: 'status', values: WEBHOOK_STATUSES },
  { table: 'operational.clinicians', column: 'profession', values: PROFESSIONS },
  { table: 'operational.clinicians', column: 'suspension_reason', values: SUSPENSION_REASONS },
  { table: 'operational.clinician_credentials', column: 'kind', values: CREDENTIAL_KINDS },
  { table: 'operational.clinician_credentials', column: 'registering_body', values: REGISTERING_BODIES },
  { table: 'operational.clinician_credentials', column: 'registration_type', values: REGISTRATION_TYPES },
  { table: 'operational.clinician_credentials', column: 'registration_status', values: REGISTRATION_STATUSES },
  { table: 'operational.clinician_credentials', column: 'endorsement', values: ENDORSEMENTS },
  { table: 'operational.clinician_credentials', column: 'withdrawal_reason', values: CREDENTIAL_WITHDRAWAL_REASONS },
  { table: 'operational.clinician_time_off', column: 'reason', values: TIME_OFF_REASONS },
  { table: 'platform.tenant_keys', column: 'provider', values: KEY_PROVIDERS },
  { table: 'clinical.patients', column: 'sex', values: SEXES },
  { table: 'clinical.patients', column: 'identity_status', values: IDENTITY_STATUSES },
  { table: 'clinical.patient_contacts', column: 'kind', values: CONTACT_KINDS },
  { table: 'clinical.patient_addresses', column: 'kind', values: ADDRESS_KINDS },
  { table: 'clinical.patient_addresses', column: 'state', values: AU_STATES },
  { table: 'clinical.consent_documents', column: 'kind', values: CONSENT_KINDS },
  { table: 'clinical.patient_consents', column: 'kind', values: CONSENT_KINDS },
  { table: 'clinical.patient_consents', column: 'decision', values: CONSENT_DECISIONS },
  { table: 'clinical.patient_consents', column: 'channel', values: CONSENT_CHANNELS },
  { table: 'clinical.consults', column: 'mode', values: CONSULT_MODES },
  { table: 'clinical.consults', column: 'status', values: CONSULT_STATUSES },
  { table: 'clinical.consults', column: 'purpose', values: CONSULT_PURPOSES },
  { table: 'clinical.consults', column: 'cancellation_reason', values: CANCELLATION_REASONS },
  { table: 'clinical.consult_evidence', column: 'party', values: EVIDENCE_PARTIES },
  { table: 'clinical.consult_evidence', column: 'event', values: EVIDENCE_EVENTS },
  { table: 'clinical.consult_evidence', column: 'channel', values: CONSULT_MODES },
] as const;
