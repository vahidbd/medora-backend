import { sql } from 'drizzle-orm';
import { check, foreignKey, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { tenants, users } from './platform.js';
import { CONSENT_CHANNELS, CONSENT_DECISIONS, CONSENT_KINDS } from './values.js';
import { clinical } from './zones.js';

/**
 * Consents (IDN-05, docs/decisions/patients.md IDN12 to IDN14). A tenant
 * publishes the text of each kind of consent as numbered versions; a patient's
 * decisions are rows against one exact version. Both tables are insert-only:
 * a new version or a withdrawal is a new row, never an edit (the trigger is
 * in the migration).
 */
export const consentDocuments = clinical.table(
  'consent_documents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    kind: text('kind').notNull(),
    version: integer('version').notNull(),
    title: text('title').notNull(),
    /** Plain text with paragraphs separated by blank lines; never drawn as HTML (ADR 0030). */
    body: text('body').notNull(),
    publishedBy: uuid('published_by').references(() => users.id),
    publishedAt: timestamp('published_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('consent_documents_tenant_id_key').on(table.tenantId, table.id),
    /** Lets a decision's kind be checked against its document's. */
    unique('consent_documents_kind_key').on(table.tenantId, table.id, table.kind),
    uniqueIndex('consent_documents_version_key').on(table.tenantId, table.kind, table.version),
    index('consent_documents_published_by_idx').on(table.publishedBy),
    check('consent_documents_kind_check', oneOf(table.kind, CONSENT_KINDS)),
    check('consent_documents_version_check', sql`${table.version} > 0`),
    check('consent_documents_text_check', sql`length(trim(${table.title})) > 0 and length(trim(${table.body})) > 0`),
  ],
);

export const patientConsents = clinical.table(
  'patient_consents',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    documentId: uuid('document_id').notNull(),
    /** Copied from the document (the foreign key checks it), so "the latest decision per kind" needs no join. */
    kind: text('kind').notNull(),
    decision: text('decision').notNull(),
    channel: text('channel').notNull(),
    /** The staff member who recorded it for the patient (phone, in person, a withdrawal); null when the patient did it. */
    recordedBy: uuid('recorded_by').references(() => users.id),
    /** Why, for a decision staff recorded. */
    reason: text('reason'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'patient_consents_patient_fk' }),
    foreignKey({
      columns: [table.tenantId, table.documentId, table.kind],
      foreignColumns: [consentDocuments.tenantId, consentDocuments.id, consentDocuments.kind],
      name: 'patient_consents_document_fk',
    }),
    index('patient_consents_patient_idx').on(table.tenantId, table.patientId, table.kind, table.at),
    index('patient_consents_document_idx').on(table.tenantId, table.documentId, table.kind),
    index('patient_consents_recorded_by_idx').on(table.recordedBy),
    check('patient_consents_kind_check', oneOf(table.kind, CONSENT_KINDS)),
    check('patient_consents_decision_check', oneOf(table.decision, CONSENT_DECISIONS)),
    check('patient_consents_channel_check', oneOf(table.channel, CONSENT_CHANNELS)),
    check('patient_consents_staff_reason_check', sql`(${table.recordedBy} is null) or (${table.reason} is not null and length(trim(${table.reason})) > 0)`),
  ],
);
