import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants } from './platform.js';
import { ADDRESS_KINDS, AU_STATES, CONTACT_KINDS, IDENTITY_STATUSES, SEXES } from './values.js';
import { clinical } from './zones.js';

/**
 * Patients: the identity part of the record (docs/decisions/patients.md).
 * One record per person per tenant (IDN1): the tenant is the data controller,
 * so nothing here is shared across tenants. In the clinical zone, because in
 * a health service a patient's identity is health information (ADR 0007).
 * Row-level security, grants and the composite keys' purpose are in the
 * migration. Other modules reference `(tenant_id, id)`, so a row can never
 * point at another tenant's patient.
 */
export const patients = clinical.table(
  'patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    /** The patient sign-in (Clerk, patient instance) this record belongs to (IDN2). */
    clerkUserId: text('clerk_user_id'),
    givenName: text('given_name').notNull(),
    familyName: text('family_name').notNull(),
    /** What they like to be called. Legal names stay as verified (IDN6). */
    preferredName: text('preferred_name'),
    dateOfBirth: date('date_of_birth', { mode: 'string' }).notNull(),
    sex: text('sex').notNull(),
    /** IANA zone for patient-facing dates; null means the tenant's (ADR 0017). */
    timeZone: text('time_zone'),
    identityStatus: text('identity_status').notNull().default('unverified'),
    /** Medicare number, IRN and valid-to, sealed together with field encryption (ADR 0010, IDN5). */
    medicare: text('medicare'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('patients_tenant_id_key').on(table.tenantId, table.id),
    uniqueIndex('patients_tenant_sign_in_key').on(table.tenantId, table.clerkUserId).where(sql`${table.clerkUserId} is not null`),
    index('patients_tenant_family_name_idx').on(table.tenantId, sql`lower(${table.familyName})`),
    check('patients_sex_check', oneOf(table.sex, SEXES)),
    check('patients_identity_status_check', oneOf(table.identityStatus, IDENTITY_STATUSES)),
    check('patients_names_check', sql`length(trim(${table.givenName})) > 0 and length(trim(${table.familyName})) > 0`),
  ],
);

/** An email address or mobile number, one row each (ADR 0028). Stored plain so staff can find a patient by it (ADR 0010). */
export const patientContacts = clinical.table(
  'patient_contacts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    /** Email lowercased; mobile in E.164 (+614...). */
    value: text('value').notNull(),
    /** When the sign-in provider proved the patient controls it; null if only typed in. */
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'patient_contacts_patient_fk' }),
    uniqueIndex('patient_contacts_patient_kind_key').on(table.tenantId, table.patientId, table.kind),
    index('patient_contacts_lookup_idx').on(table.tenantId, table.kind, table.value),
    check('patient_contacts_kind_check', oneOf(table.kind, CONTACT_KINDS)),
    check(
      'patient_contacts_value_check',
      sql`(${table.kind} = 'email' and ${table.value} = lower(${table.value}) and ${table.value} like '%_@_%') or (${table.kind} = 'mobile' and ${table.value} ~ '^\\+614[0-9]{8}$')`,
    ),
  ],
);

/** The patient's home address, which every script carries (IDN7). */
export const patientAddresses = clinical.table(
  'patient_addresses',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull().default('home'),
    line1: text('line1').notNull(),
    line2: text('line2'),
    suburb: text('suburb').notNull(),
    state: text('state').notNull(),
    postcode: text('postcode').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'patient_addresses_patient_fk' }),
    uniqueIndex('patient_addresses_patient_kind_key').on(table.tenantId, table.patientId, table.kind),
    check('patient_addresses_kind_check', oneOf(table.kind, ADDRESS_KINDS)),
    check('patient_addresses_state_check', oneOf(table.state, AU_STATES)),
    check('patient_addresses_postcode_check', sql`${table.postcode} ~ '^[0-9]{4}$'`),
  ],
);

/**
 * Patient sign-in sessions whose date of birth has been confirmed (IDN-07,
 * docs/decisions/patients.md IDN3). A patient route answers 403
 * `date_of_birth_needed` until the session has a row here.
 */
export const patientSignIns = clinical.table(
  'patient_sign_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    /** The sign-in provider's session id (`sid`). */
    sessionId: text('session_id').notNull(),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'patient_sign_ins_patient_fk' }),
    uniqueIndex('patient_sign_ins_session_key').on(table.tenantId, table.sessionId),
    index('patient_sign_ins_patient_idx').on(table.tenantId, table.patientId),
  ],
);
