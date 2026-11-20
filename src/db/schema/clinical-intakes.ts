import { sql } from 'drizzle-orm';
import { check, date, foreignKey, index, integer, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { consentDocuments } from './clinical-consents.js';
import { patients } from './clinical-patients.js';
import { protocolVersions } from './clinical-protocols.js';
import { programs } from './operational-programs.js';
import { tenants } from './platform.js';
import { INTAKE_END_REASONS, INTAKE_STATUSES } from './values.js';
import { clinical } from './zones.js';

/**
 * Intakes (PRD INT-02, INT-03, INT-05; docs/decisions/intake.md INT5 to
 * INT8). A person answers one program's questions on the protocol version
 * that was live when they started. It can start before an account, held by
 * a resume token (only its hash is stored), and becomes the patient's when
 * they claim it. Answers are sealed (ADR 0010).
 */
export const intakes = clinical.table(
  'intakes',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    programId: uuid('program_id').notNull(),
    protocolVersionId: uuid('protocol_version_id').notNull(),
    /** Null until claimed (INT6). */
    patientId: uuid('patient_id'),
    /** SHA-256 of the resume token, while unclaimed. */
    resumeTokenHash: text('resume_token_hash'),
    status: text('status').notNull().default('in_progress'),
    endedReason: text('ended_reason'),
    /** The protocol rule that stopped it (clinical; events never carry it). */
    stoppedRule: text('stopped_rule'),
    /** The red-flag rules that matched when it was submitted. */
    redFlags: text('red_flags').array().notNull().default(sql`'{}'::text[]`),
    dateOfBirth: date('date_of_birth', { mode: 'string' }),
    /** The privacy consent given on the first screen: the exact version and when (IDN12). */
    privacyDocumentId: uuid('privacy_document_id').notNull(),
    privacyAgreedAt: timestamp('privacy_agreed_at', { withTimezone: true }).notNull(),
    /** The answers so far, sealed as one JSON object keyed by question. */
    answers: text('answers'),
    /** How many of the protocol's steps, in order, are behind the person. */
    stepsDone: integer('steps_done').notNull().default(0),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }).notNull().defaultNow(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** When an unclaimed intake's answers and date of birth were removed (INT7). */
    clearedAt: timestamp('cleared_at', { withTimezone: true }),
  },
  (table) => [
    unique('intakes_tenant_id_key').on(table.tenantId, table.id),
    foreignKey({ columns: [table.tenantId, table.programId], foreignColumns: [programs.tenantId, programs.id], name: 'intakes_program_fk' }),
    foreignKey({ columns: [table.tenantId, table.protocolVersionId], foreignColumns: [protocolVersions.tenantId, protocolVersions.id], name: 'intakes_protocol_version_fk' }),
    foreignKey({ columns: [table.tenantId, table.patientId], foreignColumns: [patients.tenantId, patients.id], name: 'intakes_patient_fk' }),
    foreignKey({ columns: [table.tenantId, table.privacyDocumentId], foreignColumns: [consentDocuments.tenantId, consentDocuments.id], name: 'intakes_privacy_document_fk' }),
    uniqueIndex('intakes_resume_token_key').on(table.resumeTokenHash),
    index('intakes_patient_idx').on(table.tenantId, table.patientId, table.submittedAt),
    index('intakes_program_idx').on(table.tenantId, table.programId),
    index('intakes_protocol_version_idx').on(table.tenantId, table.protocolVersionId),
    index('intakes_privacy_document_idx').on(table.tenantId, table.privacyDocumentId),
    index('intakes_activity_idx').on(table.status, table.lastActiveAt),
    check('intakes_status_check', oneOf(table.status, INTAKE_STATUSES)),
    check('intakes_ended_reason_check', oneOf(table.endedReason, INTAKE_END_REASONS)),
    check('intakes_ended_check', sql`(${table.status} = 'ended') = (${table.endedReason} is not null)`),
    check('intakes_ineligible_check', sql`(${table.status} = 'ineligible') = (${table.stoppedRule} is not null)`),
    check('intakes_submitted_check', sql`(${table.status} = 'completed') = (${table.submittedAt} is not null)`),
    check('intakes_holder_check', sql`${table.patientId} is not null or ${table.resumeTokenHash} is not null or ${table.clearedAt} is not null`),
    check('intakes_steps_check', sql`${table.stepsDone} >= 0`),
  ],
);
