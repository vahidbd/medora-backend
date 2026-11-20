import { and, asc, eq } from 'drizzle-orm';
import { agentConversations, agentMessages } from '../../db/schema/index.js';
import type { AgentMessageRole } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import type { StoredMessage } from './runtime/engine.js';

/**
 * The model side of a conversation (docs/decisions/agents.md AGT3): exactly
 * what went to and came from the model, in the clinical zone. Every write
 * and every read writes an audit entry, with ids only.
 */
export type ConversationRow = typeof agentConversations.$inferSelect;

export async function lockConversation(tx: TenantTx, conversationId: string): Promise<ConversationRow> {
  const [row] = await tx.db
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.tenantId, tx.context.tenantId), eq(agentConversations.id, conversationId)))
    .for('update');
  if (!row) throw new NotFoundError('Conversation');
  return row;
}

export async function findConversation(tx: TenantTx, conversationId: string): Promise<ConversationRow> {
  const [row] = await tx.db
    .select()
    .from(agentConversations)
    .where(and(eq(agentConversations.tenantId, tx.context.tenantId), eq(agentConversations.id, conversationId)));
  if (!row) throw new NotFoundError('Conversation');
  return row;
}

export interface NewMessage {
  conversationId: string;
  runId: string | null;
  role: AgentMessageRole;
  content: unknown[];
  untrusted?: boolean;
}

export async function appendMessage(tx: TenantTx, message: NewMessage): Promise<number> {
  const [row] = await tx.db
    .insert(agentMessages)
    .values({
      tenantId: tx.context.tenantId,
      conversationId: message.conversationId,
      runId: message.runId,
      role: message.role,
      content: message.content,
      untrusted: message.untrusted ?? false,
    })
    .returning({ id: agentMessages.id });
  const id = row!.id;
  await audit(tx, {
    action: 'agent_message.created',
    zone: 'clinical',
    recordTable: 'clinical.agent_messages',
    recordId: String(id),
    details: { conversationId: message.conversationId, role: message.role, runId: message.runId },
  });
  return id;
}

export const textContent = (text: string) => [{ type: 'text', text }];

/** The whole transcript, oldest first, with one audit entry for the read. */
export async function readTranscript(tx: TenantTx, conversationId: string, purpose: 'run' | 'view'): Promise<(StoredMessage & { id: number; createdAt: Date; runId: string | null })[]> {
  const rows = await tx.db
    .select()
    .from(agentMessages)
    .where(and(eq(agentMessages.tenantId, tx.context.tenantId), eq(agentMessages.conversationId, conversationId)))
    .orderBy(asc(agentMessages.id));
  await audit(tx, {
    action: 'agent_conversation.read',
    zone: 'clinical',
    recordTable: 'clinical.agent_conversations',
    recordId: conversationId,
    details: { purpose, messages: rows.length },
  });
  return rows.map((row) => ({
    id: row.id,
    role: row.role as AgentMessageRole,
    content: row.content as unknown[],
    untrusted: row.untrusted,
    createdAt: row.createdAt,
    runId: row.runId,
  }));
}
