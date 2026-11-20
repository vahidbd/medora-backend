import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { patients } from './clinical-patients.js';
import { memberships, tenants } from './platform.js';
import { CANCELLATION_REASONS, CONSULT_MODES, CONSULT_PURPOSES, CONSULT_STATUSES, EVIDENCE_EVENTS, EVIDENCE_PARTIES } from './values.js';
import { webhookInbox } from './webhooks.js';
import { clinical } from './zones.js';

/**
 * Consults: real-time phone or video appointments between a patient and a
 * clinician (docs/decisions/consults.md). The status is a convenience the
 * consult gate never trusts (CNS3). The migration adds what Drizzle can't
 * say: no two consults that aren't cancelled may overlap for one clinician or
 * one patient (CNS12).
 */
export const consults = clinical.table(
  'consults',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    patientId: uuid('patient_id').notNull(),
    /** The clinician the consult is with: a member of the same tenant. */
    clinicianUserId: uuid('clinician_user_id').notNull(),
    mode: text('mode').notNull(),
    purpose: text('purpose').notNull(),
    /** The booked slot (CNS12). */
    scheduledStart: timestamp('scheduled_start', { withTimezone: true }).notNull(),
    scheduledEnd: timestamp('scheduled_end', { withTimezone: true }).notNull(),
    status: text('status').notNull().default('scheduled'),
    cancellationReason: text('cancellation_reason'),
    /** The consult this one replaced, when it was moved (CNS15). */
    rescheduledFrom: uuid('rescheduled_from'),
    /** The first moment the patient and clinician were connected together, from the evidence. */
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    unique('consults_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'consults_patient_fk' }),
    foreignKey({ columns: [table.tenantId, table.clinicianUserId], foreignColumns: [memberships.tenantId, memberships.userId], name: 'consults_clinician_fk' }),
    index('consults_patient_idx').on(table.tenantId, table.patientId, table.clinicianUserId),
    index('consults_clinician_idx').on(table.tenantId, table.clinicianUserId, table.scheduledStart),
    foreignKey({ columns: [table.tenantId, table.rescheduledFrom], foreignColumns: [table.tenantId, table.id], name: 'consults_rescheduled_from_fk' }),
    uniqueIndex('consults_rescheduled_from_key').on(table.tenantId, table.rescheduledFrom),
    index('consults_schedule_idx').on(table.tenantId, table.scheduledStart),
    check('consults_mode_check', oneOf(table.mode, CONSULT_MODES)),
    check('consults_purpose_check', oneOf(table.purpose, CONSULT_PURPOSES)),
    check('consults_status_check', oneOf(table.status, CONSULT_STATUSES)),
    check('consults_cancellation_reason_check', oneOf(table.cancellationReason, CANCELLATION_REASONS)),
    check('consults_cancelled_check', sql`(${table.status} = 'cancelled') = (${table.cancellationReason} is not null)`),
    check('consults_slot_check', sql`${table.scheduledEnd} > ${table.scheduledStart}`),
    check('consults_started_check', sql`${table.status} not in ('in_progress', 'completed') or ${table.startedAt} is not null`),
    check('consults_ended_check', sql`(${table.status} = 'completed') = (${table.endedAt} is not null)`),
    check('consults_times_check', sql`${table.endedAt} is null or ${table.endedAt} >= ${table.startedAt}`),
  ],
);

/**
 * Consult evidence: when the patient and the consult's clinician connected
 * and disconnected, at the provider's time (CNS2). Each row points at the
 * verified webhook delivery it came from, so evidence exists only where a
 * provider said so. Rows are never changed or removed (the migration's
 * trigger refuses it from any role).
 */
export const consultEvidence = clinical.table(
  'consult_evidence',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    consultId: uuid('consult_id').notNull(),
    party: text('party').notNull(),
    /** The clinician who connected; null on the patient's rows. */
    clinicianUserId: uuid('clinician_user_id'),
    event: text('event').notNull(),
    /** Phone or video: time together counts within one channel (CNS4). */
    channel: text('channel').notNull(),
    /** The provider's time for the event. Only this counts (CNS5). */
    at: timestamp('at', { withTimezone: true }).notNull(),
    deliveryId: bigint('delivery_id', { mode: 'number' }).notNull(),
    recordedAt: timestamp('recorded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    foreignKey({ columns: [table.tenantId, table.consultId], foreignColumns: [consults.tenantId, consults.id], name: 'consult_evidence_consult_fk' }),
    foreignKey({ columns: [table.tenantId, table.deliveryId], foreignColumns: [webhookInbox.tenantId, webhookInbox.id], name: 'consult_evidence_delivery_fk' }),
    foreignKey({ columns: [table.tenantId, table.clinicianUserId], foreignColumns: [memberships.tenantId, memberships.userId], name: 'consult_evidence_clinician_fk' }),
    index('consult_evidence_consult_idx').on(table.tenantId, table.consultId, table.at),
    uniqueIndex('consult_evidence_delivery_key').on(table.tenantId, table.deliveryId, table.party),
    index('consult_evidence_clinician_idx').on(table.tenantId, table.clinicianUserId),
    check('consult_evidence_party_check', oneOf(table.party, EVIDENCE_PARTIES)),
    check('consult_evidence_event_check', oneOf(table.event, EVIDENCE_EVENTS)),
    check('consult_evidence_channel_check', oneOf(table.channel, CONSULT_MODES)),
    check('consult_evidence_clinician_check', sql`(${table.party} = 'clinician') = (${table.clinicianUserId} is not null)`),
  ],
);
