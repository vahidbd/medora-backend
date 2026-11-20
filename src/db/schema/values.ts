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

/** The documents a patient's identity can be checked against (IDN-02, docs/decisions/patients.md IDN16). */
export const IDENTITY_DOCUMENTS = ['driver_licence', 'passport', 'medicare_card'] as const;
export type IdentityDocument = (typeof IDENTITY_DOCUMENTS)[number];

/** How an identity check was done: online against the document, or by staff who sighted it (IDN17). */
export const IDENTITY_METHODS = ['document', 'manual'] as const;
export type IdentityMethod = (typeof IDENTITY_METHODS)[number];

/** `unavailable` is the gateway failing to answer; it doesn't count as a failed attempt. */
export const IDENTITY_OUTCOMES = ['verified', 'not_matched', 'unavailable'] as const;
export type IdentityOutcome = (typeof IDENTITY_OUTCOMES)[number];

/** An IHI's number status and record status, as the HI Service returns them (IDN19). */
export const IHI_STATUSES = ['active', 'deceased', 'retired', 'expired', 'resolved'] as const;
export type IhiStatus = (typeof IHI_STATUSES)[number];
export const IHI_RECORD_STATUSES = ['verified', 'unverified', 'provisional'] as const;
export type IhiRecordStatus = (typeof IHI_RECORD_STATUSES)[number];

/**
 * A protocol version's life (docs/decisions/intake.md INT3, INT4): a draft
 * is edited; a medical director's sign-off makes it live; going live retires
 * the one before; withdrawing takes a live version off for safety.
 */
export const PROTOCOL_VERSION_STATUSES = ['draft', 'live', 'retired', 'withdrawn'] as const;
export type ProtocolVersionStatus = (typeof PROTOCOL_VERSION_STATUSES)[number];

export const PROGRAM_STATUSES = ['draft', 'live', 'paused', 'retired'] as const;
export type ProgramStatus = (typeof PROGRAM_STATUSES)[number];

/**
 * What a measurement measures, each in one fixed unit (docs/decisions/tracking.md
 * TRK1); a program names the kinds its patients record. Blood pressure is two
 * readings taken together.
 */
export const MEASUREMENT_KINDS = ['weight', 'waist', 'height', 'blood_pressure_systolic', 'blood_pressure_diastolic', 'heart_rate'] as const;
export type MeasurementKind = (typeof MEASUREMENT_KINDS)[number];

/** Where an intake stands (INT5 to INT8). */
export const INTAKE_STATUSES = ['in_progress', 'completed', 'ineligible', 'ended'] as const;
export type IntakeStatus = (typeof INTAKE_STATUSES)[number];

/** Why an intake ended without a protocol's hard stop. */
export const INTAKE_END_REASONS = ['under_age', 'version_withdrawn', 'expired', 'unclaimed'] as const;
export type IntakeEndReason = (typeof INTAKE_END_REASONS)[number];

/** Australian states and territories: where a company is registered, and a patient's address. */
export const AU_STATES = ['NSW', 'VIC', 'QLD', 'WA', 'SA', 'TAS', 'ACT', 'NT'] as const;
export type AuState = (typeof AU_STATES)[number];

/** A brand's state: `draft` until it goes live; `paused` stops new sign-ups only (docs/decisions/admin.md ADM16). */
export const BRAND_STATUSES = ['draft', 'live', 'paused'] as const;
export type BrandStatus = (typeof BRAND_STATUSES)[number];

/** The time zones a tenant can work in (ADR 0017): Australia's, by their IANA names. */
export const TIME_ZONES = [
  'Australia/Sydney',
  'Australia/Melbourne',
  'Australia/Brisbane',
  'Australia/Adelaide',
  'Australia/Darwin',
  'Australia/Perth',
  'Australia/Hobart',
  'Australia/Lord_Howe',
  'Australia/Eucla',
  'Australia/Broken_Hill',
  'Indian/Christmas',
  'Indian/Cocos',
  'Antarctica/Macquarie',
] as const;
export type TimeZone = (typeof TIME_ZONES)[number];

/** What a product is (docs/decisions/catalogue.md CAT1). */
export const PRODUCT_KINDS = ['medicine', 'device', 'service'] as const;
export type ProductKind = (typeof PRODUCT_KINDS)[number];

/** The Poisons Standard schedules a medicine Medora sells can carry; null means unscheduled (CAT1). */
export const SCHEDULES = ['S2', 'S3', 'S4', 'S8'] as const;
export type Schedule = (typeof SCHEDULES)[number];

/** How a product is kept: it decides how the pharmacy ships it. */
export const STORAGE = ['room', 'refrigerated'] as const;
export type Storage = (typeof STORAGE)[number];

/** A product is archived when the tenant stops selling it, never deleted (CAT1). */
export const PRODUCT_STATUSES = ['active', 'archived'] as const;
export type ProductStatus = (typeof PRODUCT_STATUSES)[number];

/** What a block rule matches on a product (CAT2). Ingredient classes wait for Medora's own ingredient list. */
export const BLOCK_RULE_MATCHES = ['schedule', 'artg_number', 'compounded'] as const;
export type BlockRuleMatch = (typeof BLOCK_RULE_MATCHES)[number];

/** Who wrote a measurement or reported a side effect: the patient, or a staff member for them. */
export const RECORDED_BY_TYPES = ['patient', 'person'] as const;
export type RecordedByType = (typeof RECORDED_BY_TYPES)[number];

export const SIDE_EFFECT_SEVERITIES = ['mild', 'moderate', 'severe'] as const;
export type SideEffectSeverity = (typeof SIDE_EFFECT_SEVERITIES)[number];

/** A check-in's answer to "have you missed any doses since your last check-in?" (TRK5). */
export const MISSED_DOSES = ['none', 'some', 'most'] as const;
export type MissedDoses = (typeof MISSED_DOSES)[number];

/**
 * What a patient did that shows how they are keeping up (docs/decisions/adherence.md
 * ADH1): the adherence activity stream. Only the patient's own actions.
 */
export const ACTIVITY_KINDS = [
  'app_opened',
  'measurement_recorded',
  'side_effect_reported',
  'check_in_submitted',
  'message_sent',
  'order_placed',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

/** What raised an adherence flag (ADH4). A new rule adds its kind here and a migration. */
export const FLAG_KINDS = ['side_effect_reported'] as const;
export type FlagKind = (typeof FLAG_KINDS)[number];

/** How soon the care team should look (ADH5): the one list the clinician task inbox reuses too. */
export const FLAG_URGENCIES = ['urgent', 'soon', 'routine'] as const;
export type FlagUrgency = (typeof FLAG_URGENCIES)[number];

export const FLAG_STATUSES = ['open', 'resolved'] as const;
export type FlagStatus = (typeof FLAG_STATUSES)[number];

/** What the staff member who resolved an adherence flag did about it (ADH7). */
export const FLAG_OUTCOMES = [
  'contacted_patient',
  'booked_review',
  'referred_to_prescriber',
  'no_action_needed',
] as const;
export type FlagOutcome = (typeof FLAG_OUTCOMES)[number];

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: MEMBERSHIP_ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
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
  { table: 'clinical.patients', column: 'ihi_status', values: IHI_STATUSES },
  { table: 'clinical.patients', column: 'ihi_record_status', values: IHI_RECORD_STATUSES },
  { table: 'clinical.identity_checks', column: 'method', values: IDENTITY_METHODS },
  { table: 'clinical.identity_checks', column: 'document_type', values: IDENTITY_DOCUMENTS },
  { table: 'clinical.identity_checks', column: 'outcome', values: IDENTITY_OUTCOMES },
  { table: 'clinical.protocol_versions', column: 'status', values: PROTOCOL_VERSION_STATUSES },
  { table: 'operational.programs', column: 'status', values: PROGRAM_STATUSES },
  { table: 'operational.programs', column: 'measurements', values: MEASUREMENT_KINDS },
  { table: 'clinical.intakes', column: 'status', values: INTAKE_STATUSES },
  { table: 'clinical.intakes', column: 'ended_reason', values: INTAKE_END_REASONS },
  { table: 'platform.tenants', column: 'time_zone', values: TIME_ZONES },
  { table: 'platform.companies', column: 'state', values: AU_STATES },
  { table: 'platform.brands', column: 'status', values: BRAND_STATUSES },
  { table: 'operational.products', column: 'kind', values: PRODUCT_KINDS },
  { table: 'operational.products', column: 'schedule', values: SCHEDULES },
  { table: 'operational.products', column: 'storage', values: STORAGE },
  { table: 'operational.products', column: 'status', values: PRODUCT_STATUSES },
  { table: 'platform.block_rules', column: 'match', values: BLOCK_RULE_MATCHES },
  { table: 'clinical.measurements', column: 'kind', values: MEASUREMENT_KINDS },
  { table: 'clinical.measurements', column: 'recorded_by_type', values: RECORDED_BY_TYPES },
  { table: 'clinical.side_effects', column: 'severity', values: SIDE_EFFECT_SEVERITIES },
  { table: 'clinical.side_effects', column: 'reported_by_type', values: RECORDED_BY_TYPES },
  { table: 'clinical.check_ins', column: 'missed_doses', values: MISSED_DOSES },
  { table: 'clinical.adherence_activity', column: 'kind', values: ACTIVITY_KINDS },
  { table: 'clinical.adherence_flags', column: 'kind', values: FLAG_KINDS },
  { table: 'clinical.adherence_flags', column: 'urgency', values: FLAG_URGENCIES },
  { table: 'clinical.adherence_flags', column: 'status', values: FLAG_STATUSES },
  { table: 'clinical.adherence_flags', column: 'outcome', values: FLAG_OUTCOMES },
] as const;
