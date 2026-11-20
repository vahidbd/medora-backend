import { and, desc, eq, lt } from 'drizzle-orm';
import { agentRuns } from '../../db/schema/index.js';
import type { AgentKind, AgentRunStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { findConversation, readTranscript } from './transcript.js';

/**
 * What agents did (docs/decisions/agents.md AGT3, AGT4): run metadata for
 * anyone with agents:read, and the model-side transcript, audited, for
 * agents:transcripts.
 */
export async function listRuns(tx: TenantTx, filter: { agent?: AgentKind | undefined; status?: AgentRunStatus | undefined; before?: string | undefined; limit: number }) {
  const rows = await tx.db
    .select()
    .from(agentRuns)
    .where(
      and(
        eq(agentRuns.tenantId, tx.context.tenantId),
        filter.agent ? eq(agentRuns.agent, filter.agent) : undefined,
        filter.status ? eq(agentRuns.status, filter.status) : undefined,
        filter.before ? lt(agentRuns.queuedAt, new Date(filter.before)) : undefined,
      ),
    )
    .orderBy(desc(agentRuns.queuedAt))
    .limit(filter.limit);
  return rows.map((row) => ({
    runId: row.id,
    agent: row.agent as AgentKind,
    conversationId: row.conversationId,
    trigger: row.trigger as 'message',
    status: row.status as AgentRunStatus,
    endReason: row.endReason,
    agentVersion: row.agentVersion,
    model: row.model,
    steps: row.steps,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costCents: row.costCents,
    queuedAt: row.queuedAt.toISOString(),
    startedAt: row.startedAt?.toISOString() ?? null,
    endedAt: row.endedAt?.toISOString() ?? null,
  }));
}

type Block = { type: 'text'; text: string } | { type: 'tool_use'; id: string; name: string; input: unknown } | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean };

/** Stored blocks as a person reads them: text, tool calls and their results. The model's thinking is left out. */
function readable(content: unknown[]): Block[] {
  return content.flatMap((raw): Block[] => {
    const block = raw as Record<string, unknown>;
    if (block['type'] === 'text') return [{ type: 'text', text: String(block['text'] ?? '') }];
    if (block['type'] === 'tool_use') return [{ type: 'tool_use', id: String(block['id']), name: String(block['name']), input: block['input'] ?? {} }];
    if (block['type'] === 'tool_result') {
      const body = block['content'];
      return [{ type: 'tool_result', toolUseId: String(block['tool_use_id']), content: typeof body === 'string' ? body : JSON.stringify(body ?? ''), isError: block['is_error'] === true }];
    }
    return [];
  });
}

export async function readConversation(tx: TenantTx, conversationId: string) {
  const conversation = await findConversation(tx, conversationId);
  const messages = await readTranscript(tx, conversationId, 'view');
  return {
    conversationId: conversation.id,
    agent: conversation.agent as AgentKind,
    channel: conversation.channel as 'chat',
    patientId: conversation.patientId,
    verified: conversation.verified,
    status: conversation.status as 'open',
    handoffReason: conversation.handoffReason,
    createdAt: conversation.createdAt.toISOString(),
    messages: messages.map((message) => ({
      id: message.id,
      role: message.role,
      untrusted: message.untrusted,
      runId: message.runId,
      createdAt: message.createdAt.toISOString(),
      blocks: readable(message.content),
    })),
  };
}
