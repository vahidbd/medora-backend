/**
 * Allowed values, in one place (ADR 0028). The database holds the same lists
 * as CHECK constraints, built from these constants, and
 * test/integration/schema-rules.test.ts fails when the two differ. Adding a
 * value means changing the constant and adding a migration.
 */

/** A staff member's role in one tenant (docs/decisions/foundation.md FND3). */
export const ROLES = ['owner', 'clinician', 'support', 'finance'] as const;
export type Role = (typeof ROLES)[number];

export const MEMBERSHIP_STATUSES = ['active', 'suspended'] as const;
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

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.tenant_keys', column: 'provider', values: KEY_PROVIDERS },
  { table: 'clinical.patients', column: 'sex', values: SEXES },
  { table: 'clinical.patients', column: 'identity_status', values: IDENTITY_STATUSES },
  { table: 'clinical.patient_contacts', column: 'kind', values: CONTACT_KINDS },
  { table: 'clinical.patient_addresses', column: 'kind', values: ADDRESS_KINDS },
  { table: 'clinical.patient_addresses', column: 'state', values: AU_STATES },
] as const;
