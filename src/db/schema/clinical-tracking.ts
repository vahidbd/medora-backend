import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, numeric, smallint, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { MEASUREMENT_KINDS, MISSED_DOSES, RECORDED_BY_TYPES, SIDE_EFFECT_SEVERITIES } from './values.js';
import { clinical } from './zones.js';

/**
 * What a patient tells their care team between consults: measurements,
 * side effects and check-ins (PRD 11 and 12, docs/decisions/tracking.md).
 * Clinical zone (ADR 0007); each row is one tenant's, for one of its
 * patients, through `(tenant_id, patient_id)`. Rows are never changed or
 * deleted (ADR 0028): a wrong reading is followed by a right one.
 */

export const checkIns = clinical.table(
  'check_ins',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    missedDoses: text('missed_doses').notNull(),
    /** How the patient feels overall, 1 (very poorly) to 5 (very well). */
    feeling: smallint('feeling').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('check_ins_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'check_ins_patient_fk' }),
    index('check_ins_patient_idx').on(table.tenantId, table.patientId, table.submittedAt),
    check('check_ins_missed_doses_check', oneOf(table.missedDoses, MISSED_DOSES)),
    check('check_ins_feeling_check', sql`${table.feeling} between 1 and 5`),
  ],
);

export const measurements = clinical.table(
  'measurements',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    /** In the kind's one unit (TRK1), to one decimal place. */
    value: numeric('value', { precision: 6, scale: 1, mode: 'number' }).notNull(),
    /** When the reading was taken, which may be before it was recorded. */
    measuredAt: timestamp('measured_at', { withTimezone: true }).notNull(),
    recordedByType: text('recorded_by_type').notNull(),
    /** The patient's id or the staff member's user id. */
    recordedById: uuid('recorded_by_id').notNull(),
    /** Set when the reading came with a check-in. */
    checkInId: uuid('check_in_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'measurements_patient_fk' }),
    foreignKey({ columns: [table.tenantId, table.checkInId], foreignColumns: [checkIns.tenantId, checkIns.id], name: 'measurements_check_in_fk' }),
    index('measurements_patient_kind_idx').on(table.tenantId, table.patientId, table.kind, table.measuredAt),
    index('measurements_check_in_idx').on(table.tenantId, table.checkInId),
    check('measurements_kind_check', oneOf(table.kind, MEASUREMENT_KINDS)),
    check('measurements_recorded_by_type_check', oneOf(table.recordedByType, RECORDED_BY_TYPES)),
    check('measurements_value_check', sql`${table.value} > 0`),
  ],
);

export const sideEffects = clinical.table(
  'side_effects',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    severity: text('severity').notNull(),
    /** The patient's own words. Clinical text: never in a log, event or audit detail. */
    description: text('description').notNull(),
    /** The day it started, where the patient is, if they said. */
    startedOn: date('started_on', { mode: 'string' }),
    reportedByType: text('reported_by_type').notNull(),
    reportedById: uuid('reported_by_id').notNull(),
    /** Set when it was reported in a check-in. */
    checkInId: uuid('check_in_id'),
    reportedAt: timestamp('reported_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('side_effects_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'side_effects_patient_fk' }),
    foreignKey({ columns: [table.tenantId, table.checkInId], foreignColumns: [checkIns.tenantId, checkIns.id], name: 'side_effects_check_in_fk' }),
    index('side_effects_patient_idx').on(table.tenantId, table.patientId, table.reportedAt),
    index('side_effects_check_in_idx').on(table.tenantId, table.checkInId),
    check('side_effects_severity_check', oneOf(table.severity, SIDE_EFFECT_SEVERITIES)),
    check('side_effects_reported_by_type_check', oneOf(table.reportedByType, RECORDED_BY_TYPES)),
    check('side_effects_description_check', sql`length(trim(${table.description})) between 1 and 2000`),
  ],
);
