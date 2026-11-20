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

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: MEMBERSHIP_ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.webhook_inbox', column: 'provider', values: WEBHOOK_PROVIDERS },
  { table: 'platform.webhook_inbox', column: 'status', values: WEBHOOK_STATUSES },
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
] as const;
