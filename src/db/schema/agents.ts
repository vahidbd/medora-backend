import { sql } from 'drizzle-orm';
import { boolean, check, index, integer, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { oneOf } from './checks.js';
import { tenants } from './platform.js';
import { AGENT_KINDS, AGENT_RUN_STATUSES, AGENT_RUN_TRIGGERS } from './values.js';
import { platform } from './zones.js';

/**
 * The agents' platform-zone tables: settings and run metadata, never free
 * text (docs/decisions/agents.md AGT3). Transcripts and approval cards are in
 * clinical-agents.ts. Policies and grants are in the SQL migration.
 */

/** Platform maxima a tenant setting can never pass (AGT6). The database checks them too. */
export const AGENT_LIMIT_MAXIMA = {
  monthlySpendCapCents: 500_000,
  dailyReplyCap: 10_000,
  refundCapCents: 50_000,
} as const;

/** One agent in one tenant. Its id is the agent's id in the audit log (AGT1). */
export const agentSettings = platform.table(
  'agent_settings',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agent: text('agent').notNull(),
    enabled: boolean('enabled').notNull().default(false),
    /** What patients hear and read; null uses the agent's default name. */
    displayName: text('display_name'),
    /** Tools the tenant raised from Approve to Auto, each within its ceiling (AGT7). */
    autoTools: text('auto_tools').array().notNull().default(sql`'{}'::text[]`),
    monthlySpendCapCents: integer('monthly_spend_cap_cents').notNull().default(15_000),
    dailyReplyCap: integer('daily_reply_cap').notNull().default(1_000),
    refundCapCents: integer('refund_cap_cents').notNull().default(0),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: uuid('updated_by'),
  },
  (table) => [
    uniqueIndex('agent_settings_tenant_agent_key').on(table.tenantId, table.agent),
    check('agent_settings_agent_check', oneOf(table.agent, AGENT_KINDS)),
    check('agent_settings_spend_cap_check', sql`${table.monthlySpendCapCents} between 0 and 500000`),
    check('agent_settings_reply_cap_check', sql`${table.dailyReplyCap} between 0 and 10000`),
    check('agent_settings_refund_cap_check', sql`${table.refundCapCents} between 0 and 50000`),
    check('agent_settings_display_name_check', sql`${table.displayName} is null or length(${table.displayName}) between 1 and 40`),
  ],
);

/** The tenant-wide switch (AGT5): one flag, so resuming restores each agent's own setting. */
export const agentTenantSettings = platform.table('agent_tenant_settings', {
  tenantId: uuid('tenant_id')
    .primaryKey()
    .references(() => tenants.id),
  paused: boolean('paused').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  updatedBy: uuid('updated_by'),
});

/**
 * One run of an agent: queued, claimed by the worker, then ended (AGT8).
 * Ids, codes and numbers only. Cost is integer AUD cents, rounded up per run.
 */
export const agentRuns = platform.table(
  'agent_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id),
    agent: text('agent').notNull(),
    /** The agent's settings row: the actor id its audit entries carry. */
    agentId: uuid('agent_id')
      .notNull()
      .references(() => agentSettings.id),
    conversationId: uuid('conversation_id').notNull(),
    trigger: text('trigger').notNull(),
    status: text('status').notNull().default('queued'),
    /** The staff member who started it, if one did. */
    startedBy: uuid('started_by'),
    /** The agent's version hash when it ran (AGT10). */
    agentVersion: text('agent_version'),
    /** The model asked for, and the one that answered. */
    model: text('model'),
    modelVersion: text('model_version'),
    steps: integer('steps').notNull().default(0),
    inputTokens: integer('input_tokens').notNull().default(0),
    outputTokens: integer('output_tokens').notNull().default(0),
    cacheReadTokens: integer('cache_read_tokens').notNull().default(0),
    cacheWriteTokens: integer('cache_write_tokens').notNull().default(0),
    costCents: integer('cost_cents').notNull().default(0),
    /** Why it ended, as a code: a handoff reason, a limit, or an error kind. */
    endReason: text('end_reason'),
    queuedAt: timestamp('queued_at', { withTimezone: true }).notNull().defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true }),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  },
  (table) => [
    index('agent_runs_tenant_agent_queued_idx').on(table.tenantId, table.agent, table.queuedAt),
    index('agent_runs_status_queued_idx').on(table.status, table.queuedAt),
    index('agent_runs_conversation_idx').on(table.conversationId),
    index('agent_runs_agent_id_idx').on(table.agentId),
    // One run at a time per conversation (AGT8): a second claim for the same conversation fails here.
    uniqueIndex('agent_runs_one_running_key').on(table.conversationId).where(sql`${table.status} = 'running'`),
    check('agent_runs_agent_check', oneOf(table.agent, AGENT_KINDS)),
    check('agent_runs_trigger_check', oneOf(table.trigger, AGENT_RUN_TRIGGERS)),
    check('agent_runs_status_check', oneOf(table.status, AGENT_RUN_STATUSES)),
    check('agent_runs_counts_check', sql`least(${table.steps}, ${table.inputTokens}, ${table.outputTokens}, ${table.cacheReadTokens}, ${table.cacheWriteTokens}, ${table.costCents}) >= 0`),
    check('agent_runs_end_reason_check', sql`${table.endReason} is null or ${table.endReason} ~ '^[a-z_]{1,40}$'`),
  ],
);
