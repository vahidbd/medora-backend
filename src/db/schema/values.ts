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

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
] as const;
