import { and, desc, eq, gt, inArray, isNull, lte, or } from 'drizzle-orm';
import { agentProposals } from '../../db/schema/index.js';
import type { AgentKind, AgentProposalStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { Permission } from '../../lib/permissions.js';
import type { AgentToolRoute } from '../../plugins/agent-tools.js';
import { agentRolePermissions } from './policy.js';
import { offReason, readSwitches } from './settings.service.js';
import { appendMessage, findConversation, textContent } from './transcript.js';

/**
 * Approval cards (docs/decisions/agents.md AGT12). An agent's change waits
 * here until someone who could make it themselves approves or rejects it.
 * What runs is exactly what the card shows, with the person's edits, once,
 * under an idempotency key. A card lasts seven days.
 */
export const PROPOSAL_DAYS = 7;
export const DECISION_REASONS = ['not_needed', 'wrong_details', 'unsafe', 'patient_declined', 'duplicate', 'edited', 'other'] as const;
export type DecisionReason = (typeof DECISION_REASONS)[number];

type Row = typeof agentProposals.$inferSelect;

export interface Proposal {
  proposalId: string;
  agent: AgentKind;
  tool: string;
  permission: string;
  input: unknown;
  finalInput: unknown;
  rationale: string | null;
  status: AgentProposalStatus;
  conversationId: string;
  runId: string;
  createdAt: string;
  expiresAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  resultStatus: number | null;
  executedAt: string | null;
}

function toProposal(row: Row, now = new Date()): Proposal {
  const status = row.status === 'pending' && row.expiresAt <= now ? 'expired' : (row.status as AgentProposalStatus);
  return {
    proposalId: row.id,
    agent: row.agent as AgentKind,
    tool: row.tool,
    permission: row.permission,
    input: row.input,
    finalInput: row.finalInput,
    rationale: row.rationale,
    status,
    conversationId: row.conversationId,
    runId: row.runId,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    decidedBy: row.decidedBy,
    decidedAt: row.decidedAt?.toISOString() ?? null,
    decisionReason: row.decisionReason,
    resultStatus: row.resultStatus,
    executedAt: row.executedAt?.toISOString() ?? null,
  };
}

const record = (id: string) => ({ recordTable: 'clinical.agent_proposals', recordId: id }) as const;

export interface NewProposal {
  agent: AgentKind;
  agentId: string;
  runId: string;
  conversationId: string;
  tool: AgentToolRoute;
  input: Record<string, unknown>;
  rationale: string | null;
  idempotencyKey: string;
}

export async function createProposal(tx: TenantTx, proposal: NewProposal): Promise<string> {
  const expiresAt = new Date(Date.now() + PROPOSAL_DAYS * 24 * 60 * 60 * 1000);
  const [row] = await tx.db
    .insert(agentProposals)
    .values({
      tenantId: tx.context.tenantId,
      agent: proposal.agent,
      agentId: proposal.agentId,
      runId: proposal.runId,
      conversationId: proposal.conversationId,
      tool: proposal.tool.name,
      permission: proposal.tool.permission,
      input: proposal.input,
      rationale: proposal.rationale,
      idempotencyKey: proposal.idempotencyKey,
      expiresAt,
    })
    .onConflictDoNothing()
    .returning({ id: agentProposals.id });
  const id =
    row?.id ??
    (await tx.db.select({ id: agentProposals.id }).from(agentProposals).where(and(eq(agentProposals.tenantId, tx.context.tenantId), eq(agentProposals.idempotencyKey, proposal.idempotencyKey))))[0]!.id;
  if (row) {
    const facts = { agent: proposal.agent, tool: proposal.tool.name, permission: proposal.tool.permission };
    await audit(tx, { action: 'agent_proposal.created', zone: 'clinical', ...record(id), details: facts });
    await emitEvent(tx, { type: 'agent_proposal.created', ...record(id), payload: facts });
  }
  return id;
}

/** Cards the viewer could approve, newest first, each read audited (AGT4). */
export async function listProposals(tx: TenantTx, viewer: ReadonlySet<Permission>, filter: 'pending' | 'decided'): Promise<Proposal[]> {
  const permissions = [...viewer];
  if (permissions.length === 0) return [];
  const now = new Date();
  const state =
    filter === 'pending'
      ? and(eq(agentProposals.status, 'pending'), gt(agentProposals.expiresAt, now))
      : or(inArray(agentProposals.status, ['approved', 'rejected', 'executed', 'failed', 'expired']), and(eq(agentProposals.status, 'pending'), lte(agentProposals.expiresAt, now)));
  const rows = await tx.db
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.tenantId, tx.context.tenantId), inArray(agentProposals.permission, permissions), state))
    .orderBy(desc(agentProposals.createdAt))
    .limit(100);
  for (const row of rows) await audit(tx, { action: 'agent_proposal.read', zone: 'clinical', ...record(row.id) });
  return rows.map((row) => toProposal(row, now));
}

async function lockProposal(tx: TenantTx, proposalId: string, viewer: ReadonlySet<Permission>): Promise<Row> {
  const [row] = await tx.db
    .select()
    .from(agentProposals)
    .where(and(eq(agentProposals.tenantId, tx.context.tenantId), eq(agentProposals.id, proposalId)))
    .for('update');
  // A card the viewer couldn't approve doesn't exist for them.
  if (!row || !viewer.has(row.permission as Permission)) throw new NotFoundError('Approval card');
  return row;
}

export async function getProposal(tx: TenantTx, proposalId: string, viewer: ReadonlySet<Permission>): Promise<Proposal> {
  const row = await lockProposal(tx, proposalId, viewer);
  await audit(tx, { action: 'agent_proposal.read', zone: 'clinical', ...record(row.id) });
  return toProposal(row);
}

export type Approval =
  | { kind: 'run'; proposal: Proposal; agentId: string; tool: AgentToolRoute; input: Record<string, unknown>; pinned: { patientId: string | null; subjectId: string | null }; idempotencyKey: string }
  | { kind: 'refused'; proposal: Proposal; code: 'expired' | 'agent_off' | 'tool_changed' | 'already_decided' };

/**
 * Approve a card (AGT12): checked again now, not when it was made. The
 * agent must be on, the tool's route must still exist with the same
 * permission, and the card must be pending and in date. Only one approval
 * ever moves it on, so it runs once.
 */
export async function approveProposal(
  tx: TenantTx,
  proposalId: string,
  viewer: { userId: string; permissions: ReadonlySet<Permission> },
  edit: { finalInput?: Record<string, unknown> | undefined; reason?: DecisionReason | undefined },
  catalogue: ReadonlyMap<string, AgentToolRoute>,
): Promise<Approval> {
  const row = await lockProposal(tx, proposalId, viewer.permissions);
  const now = new Date();
  if (row.status !== 'pending') return { kind: 'refused', proposal: toProposal(row, now), code: 'already_decided' };
  const decide = async (status: AgentProposalStatus, extra: Partial<Row> = {}) => {
    const [updated] = await tx.db
      .update(agentProposals)
      .set({ status, decidedBy: status === 'expired' ? null : viewer.userId, decidedAt: status === 'expired' ? null : now, ...extra })
      .where(and(eq(agentProposals.tenantId, tx.context.tenantId), eq(agentProposals.id, row.id), eq(agentProposals.status, 'pending')))
      .returning();
    await audit(tx, { action: `agent_proposal.${status}`, zone: 'clinical', ...record(row.id), details: { tool: row.tool, edited: extra.finalInput !== undefined && extra.finalInput !== null } });
    await emitEvent(tx, { type: `agent_proposal.${status}`, ...record(row.id), payload: { agent: row.agent, tool: row.tool } });
    return toProposal(updated!, now);
  };
  if (row.expiresAt <= now) return { kind: 'refused', proposal: await decide('expired'), code: 'expired' };

  const agent = row.agent as AgentKind;
  if (offReason(await readSwitches(tx, agent))) return { kind: 'refused', proposal: toProposal(row, now), code: 'agent_off' };
  const tool = catalogue.get(row.tool);
  if (!tool || tool.permission !== row.permission || !agentRolePermissions(agent, catalogue).has(tool.permission)) {
    return { kind: 'refused', proposal: await decide('failed'), code: 'tool_changed' };
  }

  const finalInput = edit.finalInput ?? null;
  const proposal = await decide('approved', { finalInput, decisionReason: finalInput ? (edit.reason ?? 'edited') : (edit.reason ?? null) });
  const conversation = await findConversation(tx, row.conversationId);
  return {
    kind: 'run',
    proposal,
    agentId: row.agentId,
    tool,
    input: finalInput ?? (row.input as Record<string, unknown>),
    pinned: { patientId: conversation.patientId, subjectId: conversation.subjectId },
    idempotencyKey: row.idempotencyKey,
  };
}

/** After the route ran: what happened, on the card and in the conversation, so the agent knows next time. */
export async function recordOutcome(tx: TenantTx, proposalId: string, outcome: { status: number } | { refused: string }): Promise<Proposal> {
  const ok = 'status' in outcome && outcome.status >= 200 && outcome.status < 300;
  const resultStatus = 'status' in outcome ? outcome.status : null;
  const [row] = await tx.db
    .update(agentProposals)
    .set({ status: ok ? 'executed' : 'failed', resultStatus, executedAt: new Date() })
    .where(and(eq(agentProposals.tenantId, tx.context.tenantId), eq(agentProposals.id, proposalId), eq(agentProposals.status, 'approved'), isNull(agentProposals.executedAt)))
    .returning();
  if (!row) throw new NotFoundError('Approval card');
  const facts = { tool: row.tool, resultStatus };
  await audit(tx, { action: ok ? 'agent_proposal.executed' : 'agent_proposal.failed', zone: 'clinical', ...record(row.id), details: facts });
  await emitEvent(tx, { type: ok ? 'agent_proposal.executed' : 'agent_proposal.failed', ...record(row.id), payload: { agent: row.agent, ...facts } });
  const what = ok ? `was approved and done` : `was approved but did not go through (${'refused' in outcome ? outcome.refused : `status ${resultStatus}`})`;
  await appendMessage(tx, { conversationId: row.conversationId, runId: null, role: 'notice', content: textContent(`Your request to use ${row.tool} ${what}.`) });
  return toProposal(row);
}

export async function rejectProposal(tx: TenantTx, proposalId: string, viewer: { userId: string; permissions: ReadonlySet<Permission> }, reason: DecisionReason): Promise<Proposal> {
  const row = await lockProposal(tx, proposalId, viewer.permissions);
  if (row.status !== 'pending') throw new BusinessRuleError('This card has already been decided', 'already_decided');
  const now = new Date();
  const [updated] = await tx.db
    .update(agentProposals)
    .set({ status: 'rejected', decidedBy: viewer.userId, decidedAt: now, decisionReason: reason })
    .where(and(eq(agentProposals.tenantId, tx.context.tenantId), eq(agentProposals.id, row.id)))
    .returning();
  await audit(tx, { action: 'agent_proposal.rejected', zone: 'clinical', ...record(row.id), details: { tool: row.tool, reason } });
  await emitEvent(tx, { type: 'agent_proposal.rejected', ...record(row.id), payload: { agent: row.agent, tool: row.tool, reason } });
  await appendMessage(tx, { conversationId: row.conversationId, runId: null, role: 'notice', content: textContent(`Your request to use ${row.tool} was turned down by a person (${reason}).`) });
  return toProposal(updated!, now);
}
