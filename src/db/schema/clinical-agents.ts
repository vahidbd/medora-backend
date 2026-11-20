import { sql } from 'drizzle-orm';
import { bigint, boolean, check, index, integer, jsonb, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { agentRuns, agentSettings } from './agents.js';
import { oneOf } from './checks.js';
import { tenants } from './platform.js';
import { AGENT_CHANNELS, AGENT_CONVERSATION_STATUSES, AGENT_KINDS, AGENT_MESSAGE_ROLES, AGENT_PROPOSAL_STATUSES } from './values.js';
import { clinical } from './zones.js';

/**
 * The agents' clinical-zone tables: what went to and came from the model, and
 * approval cards (docs/decisions/agents.md AGT3). Patients' free text can
 * carry health information, so all of it lives here, and every read writes
 * an audit entry.
 */

/** A thread of one agent's work: a patient conversation's model side, or a job a staff member or an event started. */
export const agentConversations = clinical.table(
  'agent_conversations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agent: text('agent').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentSettings.id),
    channel: text('channel').notNull(),
    /** The patient the conversation is pinned to (AGT9). Null for a job about no patient, and before a patient exists. */
    patientId: uuid('patient_id'),
    /** True only for a signed-in patient chat: other channels get no patient-record tools. */
    verified: boolean('verified').notNull().default(false),
    /** The record the work is about, when there is one (`clinical.intakes`, an id). */
    subjectTable: text('subject_table'),
    subjectId: text('subject_id'),
    /** The staff member who started it, for a job a person asked for. */
    startedBy: uuid('started_by'),
    status: text('status').notNull().default('open'),
    /** Why it went to a person, as a code (AGT11). */
    handoffReason: text('handoff_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_conversations_tenant_agent_idx').on(table.tenantId, table.agent, table.createdAt),
    index('agent_conversations_subject_idx').on(table.tenantId, table.subjectTable, table.subjectId),
    index('agent_conversations_agent_id_idx').on(table.agentId),
    check('agent_conversations_agent_check', oneOf(table.agent, AGENT_KINDS)),
    check('agent_conversations_channel_check', oneOf(table.channel, AGENT_CHANNELS)),
    check('agent_conversations_status_check', oneOf(table.status, AGENT_CONVERSATION_STATUSES)),
    check('agent_conversations_handoff_check', sql`(${table.status} = 'handed_off') = (${table.handoffReason} is not null)`),
    check('agent_conversations_verified_check', sql`not ${table.verified} or ${table.patientId} is not null`),
  ],
);

/** One line of a transcript, in the model's own content-block shape so it replays exactly. */
export const agentMessages = clinical.table(
  'agent_messages',
  {
    id: bigint('id', { mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id),
    runId: uuid('run_id').references(() => agentRuns.id),
    role: text('role').notNull(),
    content: jsonb('content').notNull(),
    /** Written by a patient or an outsider: reaches the model marked as data, never instructions (ADR 0012). */
    untrusted: boolean('untrusted').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('agent_messages_conversation_idx').on(table.conversationId, table.id),
    index('agent_messages_tenant_created_idx').on(table.tenantId, table.createdAt),
    index('agent_messages_run_idx').on(table.runId),
    check('agent_messages_role_check', oneOf(table.role, AGENT_MESSAGE_ROLES)),
  ],
);

/**
 * An approval card (AGT12): exactly what will run, the AI's version and the
 * person's final version, and what happened.
 */
export const agentProposals = clinical.table(
  'agent_proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agent: text('agent').notNull(),
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentSettings.id),
    runId: uuid('run_id')
      .notNull()
      .references(() => agentRuns.id),
    conversationId: uuid('conversation_id')
      .notNull()
      .references(() => agentConversations.id),
    tool: text('tool').notNull(),
    /** The permission of the route it calls: who may approve it. */
    permission: text('permission').notNull(),
    /** The tool input as the agent proposed it. */
    input: jsonb('input').notNull(),
    /** The input as approved, when a person edited it. */
    finalInput: jsonb('final_input'),
    /** The agent's one-line reason, shown on the card. Model-written, so clinical zone. */
    rationale: text('rationale'),
    status: text('status').notNull().default('pending'),
    decidedBy: uuid('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    /** A code the person picked when rejecting or editing, for evals (AGT10). */
    decisionReason: text('decision_reason'),
    /** The route's status code once it ran. */
    resultStatus: integer('result_status'),
    idempotencyKey: text('idempotency_key').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    executedAt: timestamp('executed_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('agent_proposals_idempotency_key').on(table.tenantId, table.idempotencyKey),
    index('agent_proposals_tenant_status_idx').on(table.tenantId, table.status, table.createdAt),
    index('agent_proposals_agent_id_idx').on(table.agentId),
    index('agent_proposals_run_idx').on(table.runId),
    index('agent_proposals_conversation_idx').on(table.conversationId),
    check('agent_proposals_agent_check', oneOf(table.agent, AGENT_KINDS)),
    check('agent_proposals_status_check', oneOf(table.status, AGENT_PROPOSAL_STATUSES)),
    check('agent_proposals_decided_check', sql`(${table.status} = 'pending' or ${table.status} = 'expired') = (${table.decidedBy} is null)`),
    check('agent_proposals_reason_check', sql`${table.decisionReason} is null or ${table.decisionReason} ~ '^[a-z_]{1,40}$'`),
  ],
);
