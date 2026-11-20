import { sql } from 'drizzle-orm';
import { bigint, boolean, check, foreignKey, index, integer, jsonb, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { ACTOR_TYPES, DATA_ZONES, MEMBERSHIP_ROLES, MEMBERSHIP_STATUSES, ROLES, TIME_ZONES } from './values.js';
import { platform } from './zones.js';

/**
 * The platform zone: tenants, the people who sign in, their memberships, the
 * audit log, the event outbox and rate-limit counters. Row-level security,
 * grants and the audit log's trigger are in the SQL migrations.
 */

/** A business that runs its care on Medora. Its row is visible only inside its own tenant context. */
export const tenants = platform.table(
  'tenants',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    /** IANA zone for staff-facing dates (ADR 0017). */
    timeZone: text('time_zone').notNull().default('Australia/Sydney'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check('tenants_time_zone_check', oneOf(table.timeZone, TIME_ZONES)),
    check('tenants_name_check', sql`length(btrim(${table.name})) between 1 and 120`),
  ],
);

/**
 * A person who can sign in. Held once across tenants; their memberships say
 * where they work. `clerk_user_id` is set the first time they sign in with
 * the verified email they were invited with (FND2).
 */
export const users = platform.table(
  'users',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    clerkUserId: text('clerk_user_id').unique(),
    email: text('email').notNull(),
    /** How screens name the person. Set when they are first invited; never written to audit details (ADM5). */
    displayName: text('display_name'),
    /**
     * Medora's own team (docs/decisions/admin.md ADM15): may create tenants
     * and verify brand domains, and sees no tenant's data without a
     * membership. Set only by a reviewed migration or an operator as the
     * owner role; medora_app can't write it.
     */
    platformStaff: boolean('platform_staff').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
    check('users_email_lower', sql`${table.email} = lower(${table.email})`),
  ],
);

/**
 * A role a tenant made by copying a starting role and editing it (ADM1).
 * Starting roles are not rows: their permissions live in code.
 */
export const roles = platform.table(
  'roles',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    description: text('description').notNull().default(''),
    /** Permission keys from src/lib/permissions.ts. A snapshot: it never gains new keys on its own. */
    permissions: text('permissions').array().notNull().default(sql`'{}'::text[]`),
    /** The starting role it was copied from, which also decides whether it is clinical (ADM3). */
    basedOn: text('based_on').notNull(),
    clinical: boolean('clinical').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('roles_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('roles_tenant_name_key').on(table.tenantId, sql`lower(${table.name})`),
    check('roles_based_on_check', oneOf(table.basedOn, ROLES)),
    check('roles_name_check', sql`length(btrim(${table.name})) between 1 and 60`),
  ],
);

/** A person's link to one tenant, with a role. */
export const memberships = platform.table(
  'memberships',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** A starting role's key, or `custom` with custom_role_id (ADM1). */
    role: text('role').notNull(),
    customRoleId: uuid('custom_role_id'),
    status: text('status').notNull().default('active'),
    /** When the last invitation went out; it can be accepted for 14 days (ADM5). */
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    invitedBy: uuid('invited_by').references(() => users.id),
    /** Access ends at this instant, if set: time-limited access (ADM7). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_tenant_user_key').on(table.tenantId, table.userId),
    index('memberships_user_idx').on(table.userId),
    index('memberships_custom_role_idx').on(table.tenantId, table.customRoleId),
    index('memberships_invited_by_idx').on(table.invitedBy),
    foreignKey({
      name: 'memberships_custom_role_fk',
      columns: [table.tenantId, table.customRoleId],
      foreignColumns: [roles.tenantId, roles.id],
    }),
    check('memberships_role_check', oneOf(table.role, MEMBERSHIP_ROLES)),
    check('memberships_custom_role_check', sql`(${table.role} = 'custom') = (${table.customRoleId} is not null)`),
    check('memberships_status_check', oneOf(table.status, MEMBERSHIP_STATUSES)),
    check('memberships_invited_check', sql`${table.status} <> 'invited' or ${table.invitedAt} is not null`),
  ],
);

/**
 * One row per new sign-in session (ADM6): when, from where, and whether a
 * second factor was verified. Belongs to the person, not a tenant.
 */
export const signIns = platform.table(
  'sign_ins',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** SHA-256 of the sign-in provider's session id: enough to spot a new session, useless to anyone holding it. */
    sessionHash: text('session_hash').notNull().unique(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    clientIp: text('client_ip'),
    /** A short description of the browser and device, never the raw header. */
    device: text('device'),
    secondFactor: boolean('second_factor').notNull(),
  },
  (table) => [index('sign_ins_user_at_idx').on(table.userId, table.at)],
);

/**
 * Break-glass (ADM3): a non-clinical role that holds clinical permissions
 * (the owner) may use them for 60 minutes after giving a reason. Each one is
 * reviewed by someone holding `break_glass:review`.
 */
export const breakGlass = platform.table(
  'break_glass',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    /** Why, in the person's words. The screen asks them not to name a patient. */
    reason: text('reason').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    reviewedBy: uuid('reviewed_by').references(() => users.id),
    reviewNote: text('review_note'),
  },
  (table) => [
    index('break_glass_tenant_opened_idx').on(table.tenantId, table.openedAt),
    index('break_glass_membership_idx').on(table.membershipId, table.endsAt),
    index('break_glass_user_idx').on(table.userId),
    index('break_glass_reviewed_by_idx').on(table.reviewedBy),
    check('break_glass_reason_check', sql`length(btrim(${table.reason})) between 10 and 500`),
    check('break_glass_ends_check', sql`${table.endsAt} > ${table.openedAt}`),
    check('break_glass_review_check', sql`(${table.reviewedAt} is null) = (${table.reviewedBy} is null)`),
  ],
);

/**
 * Append-only (ADR 0008): no role may update or delete a row, and a trigger
 * refuses UPDATE, DELETE and TRUNCATE for every role, the owner included.
 * Details hold ids and facts only, never names, contact details or clinical text.
 */
export const auditLog = platform.table(
  'audit_log',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    /** Null only for platform-level entries written by reviewed functions, such as linking a sign-in. */
    tenantId: uuid('tenant_id').references(() => tenants.id),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull(),
    /** The person's user id or the agent's id; null for the system. */
    actorId: uuid('actor_id'),
    /** `<record>.<verb>`, e.g. `membership.role_changed`. */
    action: text('action').notNull(),
    zone: text('zone').notNull(),
    recordTable: text('record_table').notNull(),
    recordId: text('record_id').notNull(),
    requestId: text('request_id'),
    details: jsonb('details').notNull().default({}),
  },
  (table) => [
    index('audit_log_tenant_at_idx').on(table.tenantId, table.at),
    index('audit_log_record_idx').on(table.recordTable, table.recordId),
    check('audit_log_actor_type_check', oneOf(table.actorType, ACTOR_TYPES)),
    check('audit_log_zone_check', oneOf(table.zone, DATA_ZONES)),
    check('audit_log_actor_check', sql`(${table.actorType} = 'system') = (${table.actorId} is null)`),
  ],
);

/**
 * Events waiting to be delivered (ADR 0016), written in the same transaction
 * as the change they describe. Delivery comes with the first worker.
 */
export const outbox = platform.table(
  'outbox',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** `<record>.<past-tense verb>`, e.g. `membership.role_changed`. */
    type: text('type').notNull(),
    recordTable: text('record_table').notNull(),
    recordId: text('record_id').notNull(),
    /** Ids and business facts only. */
    payload: jsonb('payload').notNull().default({}),
    requestId: text('request_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    attempts: integer('attempts').notNull().default(0),
  },
  (table) => [index('outbox_tenant_idx').on(table.tenantId, table.id)],
);

/**
 * Fixed-window counters for the one rate limiter (ADR 0030), shared by every
 * copy of the API. `key` is the limit's name and the trusted client address.
 */
export const rateLimitCounters = platform.table('rate_limit_counters', {
  key: text('key').primaryKey(),
  windowStartedAt: timestamp('window_started_at', { withTimezone: true }).notNull(),
  count: integer('count').notNull(),
});
