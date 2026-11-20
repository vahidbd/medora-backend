/**
 * Allowed values, in one place (ADR 0028). The database holds the same lists
 * as CHECK constraints, built from these constants, and
 * test/integration/schema-rules.test.ts fails when the two differ. Adding a
 * value means changing the constant and adding a migration.
 */

/**
 * The starting roles every tenant has (docs/decisions/foundation.md FND3,
 * docs/decisions/admin.md ADM1 and ADM2). Their permissions are in
 * src/lib/permissions.ts and tenants can't edit them.
 */
export const ROLES = [
  'owner',
  'admin',
  'medical_director',
  'prescriber',
  'clinician',
  'support',
  'finance',
  'operations',
  'marketing',
  'compliance',
] as const;
export type Role = (typeof ROLES)[number];

/** What `platform.memberships.role` may hold: a starting role, or `custom` with `custom_role_id` set (ADM1). */
export const MEMBERSHIP_ROLES = [...ROLES, 'custom'] as const;
export type MembershipRole = (typeof MEMBERSHIP_ROLES)[number];

/** `invited` until the person's first sign-in after the invitation (ADM5). */
export const MEMBERSHIP_STATUSES = ['active', 'suspended', 'invited'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

/** Who did something: a person, one of Medora's AI agents, or the system itself (ADR 0008). */
export const ACTOR_TYPES = ['person', 'agent', 'system'] as const;
export type ActorType = (typeof ACTOR_TYPES)[number];

/** The data zones (ADR 0007). */
export const DATA_ZONES = ['clinical', 'operational', 'marketing', 'platform'] as const;
export type DataZone = (typeof DATA_ZONES)[number];

/** Medora's own AI agents (ADR 0012, docs/decisions/agents.md AGT1). Each is switched on per tenant. */
export const AGENT_KINDS = ['intake', 'support', 'care_coordinator', 'clinical_copilot'] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

/** Where an agent conversation happens. */
export const AGENT_CHANNELS = ['chat', 'email', 'sms', 'voice', 'job'] as const;
export type AgentChannel = (typeof AGENT_CHANNELS)[number];

export const AGENT_CONVERSATION_STATUSES = ['open', 'handed_off', 'closed'] as const;
export type AgentConversationStatus = (typeof AGENT_CONVERSATION_STATUSES)[number];

/** Who wrote a transcript line: the patient or a staff member, the agent, a tool's result, or a fixed notice from the runtime. */
export const AGENT_MESSAGE_ROLES = ['patient', 'staff', 'agent', 'tool', 'notice'] as const;
export type AgentMessageRole = (typeof AGENT_MESSAGE_ROLES)[number];

/** What started a run. */
export const AGENT_RUN_TRIGGERS = ['message', 'staff', 'event', 'schedule', 'call'] as const;
export type AgentRunTrigger = (typeof AGENT_RUN_TRIGGERS)[number];

export const AGENT_RUN_STATUSES = ['queued', 'running', 'completed', 'handed_off', 'stopped', 'failed'] as const;
export type AgentRunStatus = (typeof AGENT_RUN_STATUSES)[number];

/** An approval card: waiting; approved and about to run; then carried out, failed, rejected or expired. */
export const AGENT_PROPOSAL_STATUSES = ['pending', 'approved', 'rejected', 'executed', 'failed', 'expired'] as const;
export type AgentProposalStatus = (typeof AGENT_PROPOSAL_STATUSES)[number];

/** Every CHECK constraint built from a constant above, for the schema-rules test. */
export const CHECKED_VALUES = [
  { table: 'platform.memberships', column: 'role', values: MEMBERSHIP_ROLES },
  { table: 'platform.memberships', column: 'status', values: MEMBERSHIP_STATUSES },
  { table: 'platform.audit_log', column: 'actor_type', values: ACTOR_TYPES },
  { table: 'platform.audit_log', column: 'zone', values: DATA_ZONES },
  { table: 'platform.agent_settings', column: 'agent', values: AGENT_KINDS },
  { table: 'platform.agent_runs', column: 'agent', values: AGENT_KINDS },
  { table: 'platform.agent_runs', column: 'trigger', values: AGENT_RUN_TRIGGERS },
  { table: 'platform.agent_runs', column: 'status', values: AGENT_RUN_STATUSES },
  { table: 'clinical.agent_conversations', column: 'agent', values: AGENT_KINDS },
  { table: 'clinical.agent_conversations', column: 'channel', values: AGENT_CHANNELS },
  { table: 'clinical.agent_conversations', column: 'status', values: AGENT_CONVERSATION_STATUSES },
  { table: 'clinical.agent_messages', column: 'role', values: AGENT_MESSAGE_ROLES },
  { table: 'clinical.agent_proposals', column: 'status', values: AGENT_PROPOSAL_STATUSES },
] as const;
