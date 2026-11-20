import { sql } from 'drizzle-orm';
import { boolean, check, date, index, smallint, text, time, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { memberships, tenants, users } from './platform.js';
import {
  CREDENTIAL_KINDS,
  CREDENTIAL_WITHDRAWAL_REASONS,
  ENDORSEMENTS,
  PROFESSIONS,
  REGISTERING_BODIES,
  REGISTRATION_STATUSES,
  REGISTRATION_TYPES,
  SUSPENSION_REASONS,
  TIME_OFF_REASONS,
} from './values.js';
import { operational } from './zones.js';

/**
 * The workforce, in the operational zone (ADR 0007): who sees patients, the
 * credentials that let them, and when they work (docs/decisions/workforce.md).
 * A clinician's standing is worked out from these rows when it is checked.
 */

/** A staff member who sees patients: one per membership, with the profession that sets their scope. */
export const clinicians = operational.table(
  'clinicians',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    membershipId: uuid('membership_id')
      .notNull()
      .references(() => memberships.id),
    profession: text('profession').notNull(),
    /** Their working hours are in this zone (WRK6). */
    timeZone: text('time_zone').notNull(),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    suspensionReason: text('suspension_reason'),
    suspendedBy: uuid('suspended_by').references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('clinicians_membership_key').on(table.membershipId),
    index('clinicians_tenant_idx').on(table.tenantId),
    index('clinicians_suspended_by_idx').on(table.suspendedBy),
    check('clinicians_profession_check', oneOf(table.profession, PROFESSIONS)),
    check('clinicians_suspension_reason_check', oneOf(table.suspensionReason, SUSPENSION_REASONS)),
    check(
      'clinicians_suspension_check',
      sql`(${table.suspendedAt} is null) = (${table.suspensionReason} is null) and (${table.suspendedAt} is null) = (${table.suspendedBy} is null)`,
    ),
  ],
);

/**
 * A registration, an endorsement or an indemnity policy. Never deleted or
 * rewritten: a renewal is a new row and the old one is withdrawn (WRK2).
 * Verification and the review of a registration's conditions are recorded
 * by someone other than the clinician (WRK4).
 */
export const clinicianCredentials = operational.table(
  'clinician_credentials',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    kind: text('kind').notNull(),
    /** Registration number, policy number. */
    reference: text('reference'),
    /** Registration only. */
    registeringBody: text('registering_body'),
    registrationType: text('registration_type'),
    registrationStatus: text('registration_status'),
    /** Conditions, undertakings or notations on a registration, as the register shows them. */
    conditions: text('conditions'),
    /** Endorsement only. */
    endorsement: text('endorsement'),
    /** Indemnity only: the insurer, and whether the policy covers telehealth with new patients. */
    insurer: text('insurer'),
    coversTelehealthNewPatients: boolean('covers_telehealth_new_patients'),
    startsOn: date('starts_on'),
    /** Counts until the end of this day in the tenant's time zone (WRK3). */
    expiresOn: date('expires_on'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    verifiedBy: uuid('verified_by').references(() => users.id),
    conditionsReviewedAt: timestamp('conditions_reviewed_at', { withTimezone: true }),
    conditionsReviewedBy: uuid('conditions_reviewed_by').references(() => users.id),
    withdrawnAt: timestamp('withdrawn_at', { withTimezone: true }),
    withdrawalReason: text('withdrawal_reason'),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clinician_credentials_clinician_idx').on(table.clinicianId, table.kind),
    index('clinician_credentials_tenant_idx').on(table.tenantId),
    index('clinician_credentials_verified_by_idx').on(table.verifiedBy),
    index('clinician_credentials_conditions_reviewed_by_idx').on(table.conditionsReviewedBy),
    index('clinician_credentials_created_by_idx').on(table.createdBy),
    check('clinician_credentials_kind_check', oneOf(table.kind, CREDENTIAL_KINDS)),
    check('clinician_credentials_registering_body_check', oneOf(table.registeringBody, REGISTERING_BODIES)),
    check('clinician_credentials_registration_type_check', oneOf(table.registrationType, REGISTRATION_TYPES)),
    check('clinician_credentials_registration_status_check', oneOf(table.registrationStatus, REGISTRATION_STATUSES)),
    check('clinician_credentials_endorsement_check', oneOf(table.endorsement, ENDORSEMENTS)),
    check('clinician_credentials_withdrawal_reason_check', oneOf(table.withdrawalReason, CREDENTIAL_WITHDRAWAL_REASONS)),
    check(
      'clinician_credentials_shape_check',
      sql`case ${table.kind}
        when 'registration' then ${table.registeringBody} is not null and ${table.registrationStatus} is not null and ${table.reference} is not null
          and ${table.expiresOn} is not null and ${table.endorsement} is null and ${table.insurer} is null and ${table.coversTelehealthNewPatients} is null
        when 'endorsement' then ${table.endorsement} is not null and ${table.registeringBody} is null and ${table.registrationStatus} is null
          and ${table.registrationType} is null and ${table.conditions} is null and ${table.insurer} is null and ${table.coversTelehealthNewPatients} is null
        when 'indemnity' then ${table.insurer} is not null and ${table.coversTelehealthNewPatients} is not null and ${table.expiresOn} is not null
          and ${table.registeringBody} is null and ${table.registrationStatus} is null and ${table.registrationType} is null
          and ${table.conditions} is null and ${table.endorsement} is null
        else false end`,
    ),
    check('clinician_credentials_dates_check', sql`${table.startsOn} is null or ${table.expiresOn} is null or ${table.startsOn} <= ${table.expiresOn}`),
    check('clinician_credentials_verified_check', sql`(${table.verifiedAt} is null) = (${table.verifiedBy} is null)`),
    check('clinician_credentials_reviewed_check', sql`(${table.conditionsReviewedAt} is null) = (${table.conditionsReviewedBy} is null)`),
    check('clinician_credentials_withdrawn_check', sql`(${table.withdrawnAt} is null) = (${table.withdrawalReason} is null)`),
  ],
);

/** A block of weekly working hours, in the clinician's own time zone; slots are cut from it (WRK6). */
export const clinicianHours = operational.table(
  'clinician_hours',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    /** ISO weekday: 1 is Monday, 7 is Sunday. */
    weekday: smallint('weekday').notNull(),
    startsAt: time('starts_at').notNull(),
    endsAt: time('ends_at').notNull(),
    slotMinutes: smallint('slot_minutes').notNull().default(15),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clinician_hours_clinician_idx').on(table.clinicianId, table.weekday),
    index('clinician_hours_tenant_idx').on(table.tenantId),
    check('clinician_hours_weekday_check', sql`${table.weekday} between 1 and 7`),
    check('clinician_hours_order_check', sql`${table.startsAt} < ${table.endsAt}`),
    check('clinician_hours_slot_check', sql`${table.slotMinutes} between 5 and 120`),
  ],
);

/** Time a clinician is away, which no slot may fall in. */
export const clinicianTimeOff = operational.table(
  'clinician_time_off',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    clinicianId: uuid('clinician_id')
      .notNull()
      .references(() => clinicians.id),
    startsAt: timestamp('starts_at', { withTimezone: true }).notNull(),
    endsAt: timestamp('ends_at', { withTimezone: true }).notNull(),
    reason: text('reason').notNull(),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('clinician_time_off_clinician_idx').on(table.clinicianId, table.startsAt),
    index('clinician_time_off_tenant_idx').on(table.tenantId),
    index('clinician_time_off_created_by_idx').on(table.createdBy),
    check('clinician_time_off_reason_check', oneOf(table.reason, TIME_OFF_REASONS)),
    check('clinician_time_off_order_check', sql`${table.startsAt} < ${table.endsAt}`),
  ],
);
