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

/** Who did something: a person, one of Medora's AI agents, or the system itself (ADR 0008). */
export const ACTOR_TYPES = ['person', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The data zones (ADR 0007). */
export const DATA_ZONES = ['clinical', 'operational', 'marketing', 'platform'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/** Australian states and territories, for where a company is registered. */
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

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: MEMBERSHIP_ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.tenants', column: 'time_zone', values: TIME_ZONES },
  { table: 'platform.companies', column: 'state', values: AU_STATES },
  { table: 'platform.brands', column: 'status', values: BRAND_STATUSES },
] as const;
