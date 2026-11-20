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

/** Who did something: a person, one of Medora's AI agents, or the system itself (ADR 0008). */
export const ACTOR_TYPES = ['person', 'agent', 'system'] as const;
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

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: ROLES },
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
] as const;
