import { index, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { tenants, users } from './platform.js';
import { clinical, operational } from './zones.js';

/**
 * Prescribing through Parchment (ADR 0013, docs/decisions/prescribing.md).
 * Row-level security and grants are in the migration.
 */

/** A patient's record in the tenant's Parchment organisation. Our patient id is Parchment's partner patient id. */
export const parchmentPatients = clinical.table(
  'parchment_patients',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    patientId: uuid('patient_id').notNull(),
    parchmentPatientId: text('parchment_patient_id').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** When Medora last sent the patient's details to Parchment (RX2). */
    syncedAt: timestamp('synced_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('parchment_patients_patient_key').on(table.patientId),
    uniqueIndex('parchment_patients_parchment_key').on(table.tenantId, table.parchmentPatientId),
  ],
);

/** Which Parchment user a prescriber is, matched by their verified email the first time they open Parchment (RX3). */
export const parchmentPrescribers = operational.table(
  'parchment_prescribers',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.id),
    parchmentUserId: text('parchment_user_id').notNull(),
    linkedAt: timestamp('linked_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('parchment_prescribers_parchment_key').on(table.tenantId, table.parchmentUserId),
    uniqueIndex('parchment_prescribers_user_key').on(table.userId, table.tenantId),
  ],
);

/**
 * One pass of the consult gate: a prescriber opened Parchment for a patient
 * on the strength of a qualifying consult (ADR 0009, RX1). Scripts that come
 * back link to it. Written once, never changed.
 */
export const prescribingSessions = clinical.table(
  'prescribing_sessions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    patientId: uuid('patient_id').notNull(),
    prescriberUserId: uuid('prescriber_user_id')
      .notNull()
      .references(() => users.id),
    /** The prescriber's Parchment user, so a returning script can be checked against it. */
    parchmentUserId: text('parchment_user_id').notNull(),
    consultId: uuid('consult_id').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('prescribing_sessions_tenant_idx').on(table.tenantId),
    index('prescribing_sessions_patient_idx').on(table.patientId, table.openedAt),
    index('prescribing_sessions_prescriber_idx').on(table.prescriberUserId),
    index('prescribing_sessions_consult_idx').on(table.consultId),
  ],
);
