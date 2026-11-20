import { sql } from 'drizzle-orm';
import { boolean, check, foreignKey, index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { brands } from './brands.js';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { memberships, tenants, users } from './platform.js';
import { ACTOR_TYPES, CHANNELS, MACRO_STATUSES, TICKET_FLAGS, TICKET_PRIORITIES, TICKET_QUEUES, TICKET_STATUSES, TICKET_TOPICS, VERIFICATION_METHODS } from './values.js';
import { clinical, operational } from './zones.js';

/**
 * The helpdesk (PRD section 13, docs/decisions/support.md). A ticket is
 * metadata only, in the operational zone: no free text, because people
 * write health details into support requests too. Every subject, body and
 * comment lives in the clinical zone (SUP13), in clinical.messages and
 * clinical.ticket_comments, and every read of it writes an audit entry.
 */

/** One request from a person, across every channel they use for it. */
export const tickets = operational.table(
  'tickets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The brand the person wrote to; null when it can't be told. */
    brandId: uuid('brand_id'),
    /** Linked by an exact email or mobile match to exactly one patient, or by staff (SUP8). */
    patientId: uuid('patient_id'),
    /** A staff member checked who they are talking to (SUP8). Until then the panel shows the name only. */
    patientVerifiedAt: timestamp('patient_verified_at', { withTimezone: true }),
    patientVerifiedMethod: text('patient_verified_method'),
    /** Null when the patient app verified them (they were signed in). */
    patientVerifiedByUserId: uuid('patient_verified_by_user_id').references(() => users.id),
    /** The channel the ticket started on. */
    channel: text('channel').notNull(),
    topic: text('topic').notNull().default('other'),
    status: text('status').notNull().default('open'),
    queue: text('queue').notNull().default('support'),
    priority: text('priority').notNull().default('normal'),
    assigneeMembershipId: uuid('assignee_membership_id').references(() => memberships.id),
    /** When someone must first reply by (SUP5); recomputed while nobody has. */
    firstResponseDueAt: timestamp('first_response_due_at', {
      withTimezone: true,
    }).notNull(),
    firstRespondedAt: timestamp('first_responded_at', { withTimezone: true }),
    /** Set once the overdue event is written, so it is written once. */
    overdueNotifiedAt: timestamp('overdue_notified_at', { withTimezone: true }),
    /** The patient app shows this ticket to its patient (a ticket they opened there, or one linked and verified). */
    patientVisible: boolean('patient_visible').notNull().default(false),
    lastMessageAt: timestamp('last_message_at', { withTimezone: true }).notNull().defaultNow(),
    solvedAt: timestamp('solved_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('tickets_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({
      columns: [table.tenantId, table.brandId],
      foreignColumns: [brands.tenantId, brands.id],
      name: 'tickets_brand_fk',
    }),
    foreignKey({
      columns: [table.tenantId, table.patientId],
      foreignColumns: [patients.tenantId, patients.id],
      name: 'tickets_patient_fk',
    }),
    index('tickets_tenant_brand_idx').on(table.tenantId, table.brandId),
    index('tickets_tenant_patient_idx').on(table.tenantId, table.patientId),
    index('tickets_assignee_idx').on(table.assigneeMembershipId),
    index('tickets_verified_by_idx').on(table.patientVerifiedByUserId),
    index('tickets_tenant_queue_status_idx').on(table.tenantId, table.queue, table.status, table.lastMessageAt),
    check('tickets_status_check', oneOf(table.status, TICKET_STATUSES)),
    check('tickets_queue_check', oneOf(table.queue, TICKET_QUEUES)),
    check('tickets_priority_check', oneOf(table.priority, TICKET_PRIORITIES)),
    check('tickets_channel_check', oneOf(table.channel, CHANNELS)),
    check('tickets_topic_check', oneOf(table.topic, TICKET_TOPICS)),
    check('tickets_solved_check', sql`(${table.status} = 'solved') = (${table.solvedAt} is not null)`),
    check('tickets_patient_verified_method_check', oneOf(table.patientVerifiedMethod, VERIFICATION_METHODS)),
    check(
      'tickets_verified_check',
      sql`(${table.patientVerifiedAt} is null) = (${table.patientVerifiedMethod} is null)
        and (${table.patientVerifiedAt} is null or ${table.patientId} is not null)
        and ((${table.patientVerifiedByUserId} is null) = (${table.patientVerifiedMethod} is null or ${table.patientVerifiedMethod} = 'patient_app'))`,
    ),
  ],
);

/**
 * What triage or a person marked on a ticket (SUP3, SUP6). Flags never clear
 * by themselves; a cleared flag stays, with who cleared it.
 */
export const ticketFlags = operational.table(
  'ticket_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    flag: text('flag').notNull(),
    /** system: triage's word lists; person: a staff member; agent: one of Medora's agents. */
    setByType: text('set_by_type').notNull(),
    setById: uuid('set_by_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
    clearedByUserId: uuid('cleared_by_user_id').references(() => users.id),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_flags_ticket_fk',
    }),
    uniqueIndex('ticket_flags_open_key')
      .on(table.tenantId, table.ticketId, table.flag)
      .where(sql`${table.clearedAt} is null`),
    index('ticket_flags_ticket_idx').on(table.tenantId, table.ticketId),
    index('ticket_flags_cleared_by_idx').on(table.clearedByUserId),
    check('ticket_flags_flag_check', oneOf(table.flag, TICKET_FLAGS)),
    check('ticket_flags_set_by_type_check', oneOf(table.setByType, ACTOR_TYPES)),
    check('ticket_flags_set_by_check', sql`(${table.setByType} = 'system') = (${table.setById} is null)`),
    check('ticket_flags_cleared_check', sql`(${table.clearedAt} is null) = (${table.clearedByUserId} is null)`),
  ],
);

/** Staff-only text on a ticket, never sent (glossary: Comment). Clinical zone, like every free text on a ticket. */
export const ticketComments = clinical.table(
  'ticket_comments',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    ticketId: uuid('ticket_id').notNull(),
    authorUserId: uuid('author_user_id')
      .notNull()
      .references(() => users.id),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({
      columns: [table.tenantId, table.ticketId],
      foreignColumns: [tickets.tenantId, tickets.id],
      name: 'ticket_comments_ticket_fk',
    }),
    index('ticket_comments_ticket_idx').on(table.tenantId, table.ticketId, table.createdAt),
    index('ticket_comments_author_idx').on(table.authorUserId),
  ],
);

/** A saved reply with approved wording (SUP-04, SUP10). Only an approved macro can be used in a reply. */
export const macros = operational.table(
  'macros',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    name: text('name').notNull(),
    body: text('body').notNull(),
    status: text('status').notNull().default('draft'),
    createdByUserId: uuid('created_by_user_id')
      .notNull()
      .references(() => users.id),
    updatedByUserId: uuid('updated_by_user_id')
      .notNull()
      .references(() => users.id),
    approvedByUserId: uuid('approved_by_user_id').references(() => users.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('macros_tenant_name_key')
      .on(table.tenantId, sql`lower(${table.name})`)
      .where(sql`${table.archivedAt} is null`),
    index('macros_tenant_idx').on(table.tenantId, table.status),
    index('macros_created_by_idx').on(table.createdByUserId),
    index('macros_updated_by_idx').on(table.updatedByUserId),
    index('macros_approved_by_idx').on(table.approvedByUserId),
    check('macros_status_check', oneOf(table.status, MACRO_STATUSES)),
    check('macros_approved_check', sql`(${table.status} = 'approved') = (${table.approvedByUserId} is not null and ${table.approvedAt} is not null)`),
  ],
);
