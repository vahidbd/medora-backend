import { z } from 'zod';
import { AGENT_CHANNELS, AGENT_CONVERSATION_STATUSES, AGENT_KINDS, AGENT_MESSAGE_ROLES, AGENT_PROPOSAL_STATUSES, AGENT_RUN_STATUSES, AGENT_RUN_TRIGGERS } from '../../db/schema/values.js';
import { AGENT_LIMIT_MAXIMA } from '../../db/schema/agents.js';
import { DECISION_REASONS } from './proposals.service.js';

export const agentParams = z.object({ agent: z.enum(AGENT_KINDS) });

const toolLine = z.object({
  name: z.string(),
  changesData: z.boolean(),
  /** The most a tenant may raise it to. */
  ceiling: z.enum(['auto', 'approve']),
  /** The tenant raised it to auto. */
  auto: z.boolean(),
  /** Its route exists, so the agent has it now. */
  available: z.boolean(),
  /** The feature that will add its route, while it doesn't exist. */
  waitingOn: z.string().nullable(),
});

export const agentSummary = z.object({
  agent: z.enum(AGENT_KINDS),
  name: z.string(),
  defaultName: z.string(),
  enabled: z.boolean(),
  /** Why it isn't running now, if it isn't: the platform, the tenant's pause, or its own setting. */
  off: z.enum(['platform_off', 'tenant_paused', 'agent_off']).nullable(),
  version: z.string(),
  evals: z.enum(['passed', 'failed', 'stale', 'none']),
  channels: z.array(z.enum(AGENT_CHANNELS)),
  tools: z.array(toolLine),
  autoTools: z.array(z.string()),
  monthlySpendCapCents: z.number().int(),
  dailyReplyCap: z.number().int(),
  refundCapCents: z.number().int(),
  usage: z.object({ monthSpendCents: z.number().int(), runsToday: z.number().int() }),
  updatedAt: z.string().nullable(),
});

export const agentsReply = z.object({ paused: z.boolean(), platformOn: z.boolean(), agents: z.array(agentSummary) });

export const agentChangeBody = z
  .object({
    enabled: z.boolean().optional(),
    displayName: z.string().trim().min(1).max(40).nullable().optional(),
    autoTools: z.array(z.string().regex(/^[a-z][a-z0-9_]{2,63}$/)).max(20).optional(),
    monthlySpendCapCents: z.number().int().min(0).max(AGENT_LIMIT_MAXIMA.monthlySpendCapCents).optional(),
    dailyReplyCap: z.number().int().min(0).max(AGENT_LIMIT_MAXIMA.dailyReplyCap).optional(),
    refundCapCents: z.number().int().min(0).max(AGENT_LIMIT_MAXIMA.refundCapCents).optional(),
  })
  .strict()
  .refine((body) => Object.keys(body).length > 0, { message: 'Send at least one setting' });

export const pauseReply = z.object({ paused: z.boolean() });

export const runsQuery = z.object({
  agent: z.enum(AGENT_KINDS).optional(),
  status: z.enum(AGENT_RUN_STATUSES).optional(),
  /** Runs queued before this instant, for the next page. */
  before: z.iso.datetime().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export const runLine = z.object({
  runId: z.uuid(),
  agent: z.enum(AGENT_KINDS),
  conversationId: z.uuid(),
  trigger: z.enum(AGENT_RUN_TRIGGERS),
  status: z.enum(AGENT_RUN_STATUSES),
  endReason: z.string().nullable(),
  agentVersion: z.string().nullable(),
  model: z.string().nullable(),
  steps: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costCents: z.number().int(),
  queuedAt: z.string(),
  startedAt: z.string().nullable(),
  endedAt: z.string().nullable(),
});

export const runsReply = z.object({ runs: z.array(runLine) });

export const conversationParams = z.object({ conversationId: z.uuid() });

/** One content block as stored, without the model's thinking. */
const block = z.union([
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), toolUseId: z.string(), content: z.string(), isError: z.boolean() }),
]);

export const conversationReply = z.object({
  conversationId: z.uuid(),
  agent: z.enum(AGENT_KINDS),
  channel: z.enum(AGENT_CHANNELS),
  patientId: z.uuid().nullable(),
  verified: z.boolean(),
  status: z.enum(AGENT_CONVERSATION_STATUSES),
  handoffReason: z.string().nullable(),
  createdAt: z.string(),
  messages: z.array(
    z.object({
      id: z.number().int(),
      role: z.enum(AGENT_MESSAGE_ROLES),
      untrusted: z.boolean(),
      runId: z.uuid().nullable(),
      createdAt: z.string(),
      blocks: z.array(block),
    }),
  ),
});

export const proposalsQuery = z.object({ state: z.enum(['pending', 'decided']).default('pending') });
export const proposalParams = z.object({ proposalId: z.uuid() });

export const proposal = z.object({
  proposalId: z.uuid(),
  agent: z.enum(AGENT_KINDS),
  tool: z.string(),
  permission: z.string(),
  input: z.unknown(),
  finalInput: z.unknown(),
  rationale: z.string().nullable(),
  status: z.enum(AGENT_PROPOSAL_STATUSES),
  conversationId: z.uuid(),
  runId: z.uuid(),
  createdAt: z.string(),
  expiresAt: z.string(),
  decidedBy: z.uuid().nullable(),
  decidedAt: z.string().nullable(),
  decisionReason: z.string().nullable(),
  resultStatus: z.number().int().nullable(),
  executedAt: z.string().nullable(),
});

export const proposalsReply = z.object({ proposals: z.array(proposal) });

export const approveBody = z
  .object({
    /** The input with the approver's edits; pinned fields are set again from the conversation. */
    finalInput: z.record(z.string(), z.unknown()).optional(),
    reason: z.enum(DECISION_REASONS).optional(),
  })
  .strict();

export const rejectBody = z.object({ reason: z.enum(DECISION_REASONS) }).strict();
