import { sql } from 'drizzle-orm';
import { check, foreignKey, index, text, timestamp, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { users } from './platform.js';
import { IDENTITY_DOCUMENTS, IDENTITY_METHODS, IDENTITY_OUTCOMES } from './values.js';
import { clinical } from './zones.js';

/**
 * Every identity check of a patient (IDN-02, docs/decisions/patients.md IDN16
 * and IDN17): an online check against one document, or staff sighting one.
 * Insert-only (the trigger is in the migration). No document number is kept:
 * the gateway's reference is enough to find the check again.
 */
export const identityChecks = clinical.table(
  'identity_checks',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    method: text('method').notNull(),
    documentType: text('document_type').notNull(),
    outcome: text('outcome').notNull(),
    /** The gateway's own id for an online check. */
    providerReference: text('provider_reference'),
    /** The staff member who sighted the document, for a manual check. */
    checkedBy: uuid('checked_by').references(() => users.id),
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'identity_checks_patient_fk' }),
    index('identity_checks_patient_idx').on(table.tenantId, table.patientId, table.at),
    index('identity_checks_checked_by_idx').on(table.checkedBy),
    check('identity_checks_method_check', oneOf(table.method, IDENTITY_METHODS)),
    check('identity_checks_document_type_check', oneOf(table.documentType, IDENTITY_DOCUMENTS)),
    check('identity_checks_outcome_check', oneOf(table.outcome, IDENTITY_OUTCOMES)),
    check(
      'identity_checks_manual_check',
      sql`(${table.method} = 'document' and ${table.checkedBy} is null) or (${table.method} = 'manual' and ${table.checkedBy} is not null and ${table.outcome} = 'verified' and length(trim(coalesce(${table.reason}, ''))) > 0)`,
    ),
  ],
);
