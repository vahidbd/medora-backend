import { and, eq } from 'drizzle-orm';
import { agentConversations, agentMessages, agentRuns } from '../../db/schema/index.js';
import type { AgentChannel, AgentKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { AGENT_DEFINITIONS } from './definitions.js';
import { type HandoffReason, URGENT_REASONS } from './runtime/hand-off.js';
import { type KnownValue, maskForModel } from './runtime/masking.js';
import { screenMessage } from './runtime/safety-screen.js';
import { type OffReason, offReason, readSwitches, tenantTimeZone } from './settings.service.js';
import { appendMessage, lockConversation, textContent } from './transcript.js';
import { conversationRunsToday, monthSpendCents, runsToday } from './usage.js';

/**
 * How other modules hand work to an agent (docs/decisions/agents.md AGT8,
 * AGT9, AGT11). The helpdesk and the patient app own what the patient sees;
 * they open a conversation, pass each message in, and deliver what comes
 * back. The safety screen runs here, on every patient message, whether or
 * not the agent is on.
 */

/** Replies a conversation may get from an agent each day (AGT6). */
export const CONVERSATION_DAILY_RUNS = 30;

export interface ConversationStart {
  agent: AgentKind;
  channel: AgentChannel;
  /** The patient it is pinned to (AGT9); null when there is none yet. */
  patientId?: string | null;
  /** The brand the patient came through, for tools that act for a brand (AGT9). */
  brandId?: string | null;
  /** True only for a signed-in patient chat. */
  verified?: boolean;
  subjectTable?: string | null;
  subjectId?: string | null;
  startedBy?: string | null;
}

export type Opened = { conversationId: string } | { off: OffReason };

export async function openConversation(tx: TenantTx, start: ConversationStart): Promise<Opened> {
  const definition = AGENT_DEFINITIONS[start.agent];
  if (!definition.channels.includes(start.channel)) throw new BusinessRuleError(`The ${start.agent} agent doesn't work by ${start.channel}`, 'agent_channel');
  const verified = start.verified ?? false;
  if (verified && (start.channel !== 'chat' || !start.patientId)) throw new BusinessRuleError('Only a signed-in chat with a patient is verified', 'agent_verified');
  const switches = await readSwitches(tx, start.agent);
  const off = offReason(switches);
  if (off || !switches.settings) return { off: off ?? 'agent_off' };

  const [row] = await tx.db
    .insert(agentConversations)
    .values({
      tenantId: tx.context.tenantId,
      agent: start.agent,
      agentId: switches.settings.id,
      channel: start.channel,
      patientId: start.patientId ?? null,
      brandId: start.brandId ?? null,
      verified,
      subjectTable: start.subjectTable ?? null,
      subjectId: start.subjectId ?? null,
      startedBy: start.startedBy ?? null,
    })
    .returning({ id: agentConversations.id });
  const conversationId = row!.id;
  await audit(tx, {
    action: 'agent_conversation.created',
    zone: 'clinical',
    recordTable: 'clinical.agent_conversations',
    recordId: conversationId,
    details: { agent: start.agent, channel: start.channel, verified, patientId: start.patientId ?? null },
  });
  return { conversationId };
}

export type Received =
  /** The agent will answer: the reply comes as an `agent_message.created` event. */
  | { action: 'agent'; runId: string }
  /** The safety screen matched: send these exact words now. A person has the conversation. */
  | { action: 'safety'; reason: HandoffReason; reply: string }
  /** A person has the conversation. */
  | { action: 'person'; reason: HandoffReason | 'closed' };

export interface IncomingMessage {
  conversationId: string;
  text: string;
  from: 'patient' | 'staff';
  /** What the clinic holds for the patient, masked out before the model sees the text (AGT9). */
  known?: readonly KnownValue[];
}

/** Hand a conversation to a person (AGT11): the helpdesk picks it up from the event. */
export async function handOff(tx: TenantTx, conversationId: string, reason: HandoffReason): Promise<void> {
  const conversation = await lockConversation(tx, conversationId);
  if (conversation.status !== 'open') return;
  await tx.db
    .update(agentConversations)
    .set({ status: 'handed_off', handoffReason: reason, updatedAt: new Date() })
    .where(and(eq(agentConversations.tenantId, tx.context.tenantId), eq(agentConversations.id, conversationId)));
  const record = { recordTable: 'clinical.agent_conversations', recordId: conversationId } as const;
  const facts = { agent: conversation.agent, channel: conversation.channel, reason, urgent: URGENT_REASONS.has(reason) };
  await audit(tx, { action: 'agent_conversation.handed_off', zone: 'clinical', ...record, details: facts });
  await emitEvent(tx, { type: 'agent_conversation.handed_off', ...record, payload: { ...facts, patientId: conversation.patientId, subjectTable: conversation.subjectTable, subjectId: conversation.subjectId } });
}

/** A staff member gives the conversation back to the agent (AGT11), the way back out of a handoff. */
export async function handBack(tx: TenantTx, conversationId: string): Promise<void> {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can hand a conversation back', 'person_only');
  const conversation = await lockConversation(tx, conversationId);
  if (conversation.status !== 'handed_off') throw new BusinessRuleError('This conversation is not with a person', 'not_handed_off');
  await tx.db
    .update(agentConversations)
    .set({ status: 'open', handoffReason: null, updatedAt: new Date() })
    .where(and(eq(agentConversations.tenantId, tx.context.tenantId), eq(agentConversations.id, conversationId)));
  const record = { recordTable: 'clinical.agent_conversations', recordId: conversationId } as const;
  await audit(tx, { action: 'agent_conversation.handed_back', zone: 'clinical', ...record, details: { from: conversation.handoffReason } });
  await emitEvent(tx, { type: 'agent_conversation.handed_back', ...record, payload: { agent: conversation.agent } });
}

/**
 * Pass one message to the agent. Patient text is screened first, then
 * masked and stored as untrusted; then the switches and limits decide
 * whether a run is queued or a person takes over.
 */
export async function receiveMessage(tx: TenantTx, message: IncomingMessage): Promise<Received> {
  const conversation = await lockConversation(tx, message.conversationId);
  if (conversation.status !== 'open') return { action: 'person', reason: (conversation.handoffReason as HandoffReason | null) ?? 'closed' };
  const agent = conversation.agent as AgentKind;
  const store = (role: 'patient' | 'staff' | 'notice', text: string) =>
    appendMessage(tx, { conversationId: conversation.id, runId: null, role, content: textContent(text), untrusted: role === 'patient' });

  await store(message.from, message.from === 'patient' ? maskForModel(message.text, message.known) : message.text);
  if (message.from === 'patient') {
    const screened = screenMessage(message.text);
    if (screened) {
      await store('notice', `The safety screen matched (${screened.reason}). The patient was sent the fixed reply and a person has the conversation.`);
      await handOff(tx, conversation.id, screened.reason);
      return { action: 'safety', reason: screened.reason, reply: screened.reply };
    }
  }

  const person = async (reason: HandoffReason): Promise<Received> => {
    await handOff(tx, conversation.id, reason);
    return { action: 'person', reason };
  };
  const switches = await readSwitches(tx, agent);
  if (offReason(switches) || !switches.settings) return person('agent_off');
  const settings = switches.settings;
  const timeZone = await tenantTimeZone(tx);
  if ((await runsToday(tx, agent, timeZone)) >= settings.dailyReplyCap) return person('limit');
  if ((await conversationRunsToday(tx, conversation.id, timeZone)) >= CONVERSATION_DAILY_RUNS) return person('limit');
  if ((await monthSpendCents(tx, agent, timeZone)) >= settings.monthlySpendCapCents) return person('limit');

  const [queued] = await tx.db
    .select({ id: agentRuns.id })
    .from(agentRuns)
    .where(and(eq(agentRuns.tenantId, tx.context.tenantId), eq(agentRuns.conversationId, conversation.id), eq(agentRuns.status, 'queued')));
  if (queued) return { action: 'agent', runId: queued.id };

  const startedBy = message.from === 'staff' && tx.context.actor.type === 'person' ? tx.context.actor.userId : null;
  const [run] = await tx.db
    .insert(agentRuns)
    .values({ tenantId: tx.context.tenantId, agent, agentId: settings.id, conversationId: conversation.id, trigger: message.from === 'patient' ? 'message' : 'staff', startedBy })
    .returning({ id: agentRuns.id });
  return { action: 'agent', runId: run!.id };
}

/** A job for an agent, about one record (AGT13): the copilot preparing an intake, a coordinator's check. */
export async function startJob(
  tx: TenantTx,
  job: { agent: AgentKind; subjectTable: string; subjectId: string; instructions: string; patientId?: string | null },
): Promise<{ conversationId: string; received: Received } | { off: OffReason }> {
  const startedBy = tx.context.actor.type === 'person' ? tx.context.actor.userId : null;
  const opened = await openConversation(tx, { agent: job.agent, channel: 'job', patientId: job.patientId ?? null, subjectTable: job.subjectTable, subjectId: job.subjectId, startedBy });
  if ('off' in opened) return opened;
  return { conversationId: opened.conversationId, received: await receiveMessage(tx, { conversationId: opened.conversationId, text: job.instructions, from: 'staff' }) };
}

/** An agent's reply, for the module that delivers it (AGT11). Audited, like every read of a transcript. */
export async function readReply(tx: TenantTx, messageId: number): Promise<{ conversationId: string; text: string }> {
  const [row] = await tx.db
    .select({ conversationId: agentMessages.conversationId, role: agentMessages.role, content: agentMessages.content })
    .from(agentMessages)
    .where(and(eq(agentMessages.tenantId, tx.context.tenantId), eq(agentMessages.id, messageId)));
  if (!row || row.role !== 'agent') throw new NotFoundError('Agent reply');
  await audit(tx, { action: 'agent_message.read', zone: 'clinical', recordTable: 'clinical.agent_messages', recordId: String(messageId), details: { conversationId: row.conversationId } });
  const text = (row.content as { type: string; text?: string }[])
    .filter((block) => block.type === 'text' && block.text)
    .map((block) => block.text!.trim())
    .join('\n\n');
  return { conversationId: row.conversationId, text };
}
