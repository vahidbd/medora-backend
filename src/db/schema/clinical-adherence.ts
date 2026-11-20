import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { sideEffects } from './clinical-tracking.js';
import { users } from './platform.js';
import { ACTIVITY_KINDS, FLAG_KINDS, FLAG_OUTCOMES, FLAG_STATUSES, FLAG_URGENCIES } from './values.js';
import { clinical } from './zones.js';

/**
 * Adherence (PRD 12, docs/decisions/adherence.md): what the patient did, and
 * the flags the care team looks at. Clinical zone (ADR 0007): that someone is
 * a brand's patient, and how they keep up, is health information. Each row is
 * one tenant's, for one of its patients, through `(tenant_id, patient_id)`.
 */

/** The activity stream (ADH1): the patient's own actions, never changed or removed (ADR 0028). */
export const adherenceActivity = clinical.table(
  'adherence_activity',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull().defaultNow(),
    /** The patient's calendar day an app_opened falls on (ADH2): there is one a day at most. Null for every other kind. */
    openedOn: date('opened_on', { mode: 'string' }),
    /** The record the action wrote (a measurement, a side effect, a check-in), when there is one. */
    sourceTable: text('source_table'),
    sourceId: uuid('source_id'),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'adherence_activity_patient_fk' }),
    index('adherence_activity_patient_idx').on(table.tenantId, table.patientId, table.occurredAt),
    uniqueIndex('adherence_activity_opened_on_key').on(table.tenantId, table.patientId, table.openedOn).where(sql`${table.kind} = 'app_opened'`),
    check('adherence_activity_kind_check', oneOf(table.kind, ACTIVITY_KINDS)),
    check('adherence_activity_opened_on_check', sql`(${table.kind} = 'app_opened') = (${table.openedOn} is not null)`),
    check('adherence_activity_source_check', sql`(${table.sourceTable} is null) = (${table.sourceId} is null)`),
  ],
);

/**
 * Adherence flags (ADH3 to ADH8): a risk a rule raised, open until a staff
 * member resolves it with an outcome. Only an open flag changes, once, to
 * resolved; a resolved flag and its resolution are never changed, and a
 * mistaken resolution is undone by reopening, which raises a new flag linked
 * to it (ADH7). The trigger in the migration holds this for every role.
 */
export const adherenceFlags = clinical.table(
  'adherence_flags',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id').notNull(),
    patientId: uuid('patient_id').notNull(),
    kind: text('kind').notNull(),
    urgency: text('urgency').notNull(),
    /** The side effect report that raised it, for `side_effect_reported`. Each new kind adds its own source column. */
    sideEffectId: uuid('side_effect_id'),
    /** The resolved flag this one reopens. */
    reopenedFromId: uuid('reopened_from_id'),
    raisedAt: timestamp('raised_at', { withTimezone: true }).notNull().defaultNow(),
    status: text('status').notNull().default('open'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: uuid('resolved_by').references(() => users.id),
    outcome: text('outcome'),
    /** The resolver's note. Clinical text: never in a log, event or audit detail. */
    note: text('note'),
  },
  (table) => [
    unique('adherence_flags_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'adherence_flags_patient_fk' }),
    foreignKey({ columns: [table.tenantId, table.sideEffectId], foreignColumns: [sideEffects.tenantId, sideEffects.id], name: 'adherence_flags_side_effect_fk' }),
    foreignKey({ columns: [table.tenantId, table.reopenedFromId], foreignColumns: [table.tenantId, table.id], name: 'adherence_flags_reopened_from_fk' }),
    // One flag per report, however often it is raised; reopenings are the only others (ADH4, ADH7).
    uniqueIndex('adherence_flags_side_effect_key').on(table.tenantId, table.sideEffectId).where(sql`${table.reopenedFromId} is null`),
    // A resolved flag is reopened once at most: after that, its reopening is the one to resolve or reopen.
    uniqueIndex('adherence_flags_reopened_from_key').on(table.tenantId, table.reopenedFromId),
    index('adherence_flags_side_effect_idx').on(table.tenantId, table.sideEffectId),
    index('adherence_flags_status_idx').on(table.tenantId, table.status, table.raisedAt),
    index('adherence_flags_patient_idx').on(table.tenantId, table.patientId, table.status),
    index('adherence_flags_resolved_by_idx').on(table.resolvedBy),
    check('adherence_flags_kind_check', oneOf(table.kind, FLAG_KINDS)),
    check('adherence_flags_urgency_check', oneOf(table.urgency, FLAG_URGENCIES)),
    check('adherence_flags_status_check', oneOf(table.status, FLAG_STATUSES)),
    check('adherence_flags_outcome_check', oneOf(table.outcome, FLAG_OUTCOMES)),
    check('adherence_flags_source_check', sql`(${table.kind} = 'side_effect_reported') = (${table.sideEffectId} is not null)`),
    check(
      'adherence_flags_resolution_check',
      sql`(${table.status} = 'resolved') = (${table.resolvedAt} is not null) and (${table.resolvedAt} is null) = (${table.resolvedBy} is null) and (${table.resolvedAt} is null) = (${table.outcome} is null) and (${table.status} = 'resolved' or ${table.note} is null)`,
    ),
    check('adherence_flags_note_check', sql`${table.note} is null or length(trim(${table.note})) between 1 and 1000`),
  ],
);
