import { sql } from 'drizzle-orm';
import { bigint, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { ACTOR_TYPES, DATA_ZONES, MEMBERSHIP_STATUSES, ROLES } from './values.js';
import { platform } from './zones.js';

/**
 * The platform zone: tenants, the people who sign in, their memberships, the
 * audit log, the event outbox and rate-limit counters. Row-level security,
 * grants and the audit log's trigger are in the SQL migrations.
 */

/** A business that runs its care on Medora. Its row is visible only inside its own tenant context. */
export const tenants = platform.table('tenants', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  /** IANA zone for staff-facing dates (ADR 0017). */
  timeZone: text('time_zone').notNull().default('Australia/Sydney'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

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
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('users_email_key').on(sql`lower(${table.email})`),
    check('users_email_lower', sql`${table.email} = lower(${table.email})`),
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
    role: text('role').notNull(),
    status: text('status').notNull().default('active'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('memberships_tenant_user_key').on(table.tenantId, table.userId),
    index('memberships_user_idx').on(table.userId),
    check('memberships_role_check', oneOf(table.role, ROLES)),
    check('memberships_status_check', oneOf(table.status, MEMBERSHIP_STATUSES)),
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
