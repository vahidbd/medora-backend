import type { FastifyInstance } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { agentRuns } from '../../../db/schema/index.js';
import type { AgentChannel, AgentKind } from '../../../db/schema/values.js';
import { type TenantContext, type TenantTx, withTenant } from '../../../db/tenant.js';
import { emitEvent } from '../../../lib/events.js';
import { handOff } from '../conversations.service.js';
import { AGENT_DEFINITIONS } from '../definitions.js';
import { evalStatus } from '../evals.js';
import type { ModelClient } from '../model/client.js';
import { TOOL_POLICY, agentVersion, canBeAuto, toolsOf, withinAutoLimit } from '../policy.js';
import { staffPermissions } from '../people.js';
import { createProposal } from '../proposals.service.js';
import { offReason, readSwitches, tenantTimeZone } from '../settings.service.js';
import { appendMessage, findConversation, readTranscript } from '../transcript.js';
import { monthSpendCents } from '../usage.js';
import { costCents, type Usage } from './cost.js';
import { type EngineResult, type ToolOutcome, runEngine } from './engine.js';
import type { HandoffReason } from './hand-off.js';
import { maskToolResult } from './masking.js';
import { ToolRefused, callTool } from './tools.js';

/**
 * One claimed run, with the database (docs/decisions/agents.md AGT8): short
 * transactions before, between and after model calls, never one held
 * across a call. Whatever happens, the run ends with a status and, unless
 * it replied, its conversation goes to a person.
 */
export interface RunnerDeps {
  app: FastifyInstance;
  model: ModelClient;
  /** Time limit for one run (AGT6). */
  runSeconds?: number;
  now?: () => number;
}

export const RUN_SECONDS = 120;

interface Loaded {
  run: typeof agentRuns.$inferSelect;
  agent: AgentKind;
  channel: AgentChannel;
  conversation: Awaited<ReturnType<typeof findConversation>>;
}

const system = (tenantId: string, runId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: `agent-run:${runId}` });

async function finish(tx: TenantTx, runId: string, status: 'completed' | 'handed_off' | 'stopped' | 'failed', endReason: string): Promise<void> {
  await tx.db
    .update(agentRuns)
    .set({ status, endReason, endedAt: new Date(), leaseExpiresAt: null })
    .where(and(eq(agentRuns.tenantId, tx.context.tenantId), eq(agentRuns.id, runId), eq(agentRuns.status, 'running')));
}

/** Tell the tenant's owners when an agent passes 80% and 100% of its monthly cap (AGT6). */
async function spendThresholds(tx: TenantTx, agent: AgentKind, before: number, after: number, cap: number): Promise<void> {
  for (const percent of [80, 100]) {
    const line = (cap * percent) / 100;
    if (cap > 0 && before < line && after >= line) {
      await emitEvent(tx, {
        type: 'agent_spend.threshold_reached',
        recordTable: 'platform.agent_settings',
        recordId: agent,
        payload: { agent, percent, capCents: cap, spentCents: after },
      });
    }
  }
}

export async function runAgentRun(deps: RunnerDeps, claimed: { runId: string; tenantId: string }): Promise<void> {
  const { app, model } = deps;
  const now = deps.now ?? Date.now;
  const { runId, tenantId } = claimed;

  const loaded = await withTenant(system(tenantId, runId), async (tx): Promise<Loaded | null> => {
    const [run] = await tx.db.select().from(agentRuns).where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, runId)));
    if (!run || run.status !== 'running') return null;
    const conversation = await findConversation(tx, run.conversationId);
    return { run, agent: run.agent as AgentKind, channel: conversation.channel as AgentChannel, conversation };
  });
  if (!loaded) return;
  const { run, agent, conversation } = loaded;
  const definition = AGENT_DEFINITIONS[agent];
  const actor: TenantContext = { tenantId, actor: { type: 'agent', agentId: run.agentId, runId, approvedBy: null }, requestId: `agent-run:${runId}` };
  const version = agentVersion(agent, app.agentTools);

  const end = (status: 'completed' | 'handed_off' | 'stopped' | 'failed', endReason: string, handoff: HandoffReason | null) =>
    withTenant(actor, async (tx) => {
      if (handoff) await handOff(tx, conversation.id, handoff);
      await finish(tx, runId, status, endReason);
    });

  try {
    const start = await withTenant(actor, async (tx) => {
      const switches = await readSwitches(tx, agent);
      const timeZone = await tenantTimeZone(tx);
      return {
        switches,
        off: offReason(switches),
        timeZone,
        spentBefore: await monthSpendCents(tx, agent, timeZone),
        person: run.startedBy ? await staffPermissions(tx, run.startedBy) : null,
        history: conversation.status === 'open' ? await readTranscript(tx, conversation.id, 'run') : [],
      };
    });
    if (conversation.status !== 'open') return await end('stopped', 'conversation_closed', null);
    if (start.off || !start.switches.settings) return await end('stopped', 'agent_off', 'agent_off');
    if (evalStatus(agent, version) !== 'passed') return await end('stopped', 'not_evaluated', 'agent_off');
    const settings = start.switches.settings;

    await withTenant(actor, (tx) =>
      tx.db.update(agentRuns).set({ agentVersion: version, model: definition.model }).where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, runId))),
    );

    const tools = toolsOf(agent, app.agentTools).filter((tool) => {
      const policy = TOOL_POLICY[tool.name]!;
      if (policy.patientRecord && !(conversation.verified && conversation.patientId)) return false;
      return !(Object.values(policy.pins).includes('subjectId') && !conversation.subjectId);
    });

    const runTool = async (name: string, toolUseId: string, input: Record<string, unknown>): Promise<ToolOutcome> => {
      const tool = app.agentTools.get(name)!;
      const idempotencyKey = `${runId}:${toolUseId}`;
      const auto = settings.autoTools.includes(name) && canBeAuto(agent, name, app.agentTools) && withinAutoLimit(name, input, settings);
      if (tool.changesData && !auto) {
        const proposalId = await withTenant(actor, (tx) =>
          createProposal(tx, { agent, agentId: run.agentId, runId, conversationId: conversation.id, tool, input, rationale: null, idempotencyKey }),
        );
        return { content: `Sent to a person for approval (proposal ${proposalId}). It has not happened yet. Tell the patient a person will confirm it.`, isError: false };
      }
      try {
        const result = await callTool(app, {
          tenantId,
          agentId: run.agentId,
          agent,
          runId,
          tool,
          input,
          pinned: { patientId: conversation.patientId, subjectId: conversation.subjectId },
          person: start.person,
          approvedBy: null,
          idempotencyKey,
        });
        const ok = result.status >= 200 && result.status < 300;
        return { content: maskToolResult({ status: result.status, body: result.body }), isError: !ok };
      } catch (error) {
        if (error instanceof ToolRefused) return { content: error.message, isError: true };
        throw error;
      }
    };

    let spent = start.spentBefore;
    const result: EngineResult = await runEngine(
      {
        definition,
        displayName: settings.displayName ?? definition.defaultName,
        channel: loaded.channel,
        verified: conversation.verified,
        tools,
        history: start.history,
        deadline: now() + (deps.runSeconds ?? RUN_SECONDS) * 1000,
      },
      {
        model,
        now,
        stillOn: () => withTenant(actor, async (tx) => offReason(await readSwitches(tx, agent)) === null),
        withinBudget: async () => spent < settings.monthlySpendCapCents,
        runTool,
        append: (message, cost) =>
          withTenant(actor, async (tx) => {
            const id = await appendMessage(tx, { conversationId: conversation.id, runId, ...message });
            if (cost) await addCost(tx, runId, cost.model, cost.usage).then((cents) => (spent += cents));
            return id;
          }),
      },
    );

    await withTenant(actor, async (tx) => {
      await tx.db.update(agentRuns).set({ modelVersion: result.modelVersion, steps: result.steps }).where(and(eq(agentRuns.tenantId, tenantId), eq(agentRuns.id, runId)));
      await spendThresholds(tx, agent, start.spentBefore, spent, settings.monthlySpendCapCents);
      if (result.outcome.kind === 'replied') {
        const payload = { conversationId: conversation.id, messageId: result.outcome.messageId, agent, channel: loaded.channel, subjectTable: conversation.subjectTable, subjectId: conversation.subjectId };
        await emitEvent(tx, { type: 'agent_message.created', recordTable: 'clinical.agent_messages', recordId: String(result.outcome.messageId), payload });
        await finish(tx, runId, 'completed', 'replied');
      } else {
        await handOff(tx, conversation.id, result.outcome.reason);
        await finish(tx, runId, 'handed_off', result.outcome.endReason);
      }
    });
  } catch (error) {
    await end('failed', 'error', 'error');
    throw error;
  }
}

/** Add one reply's tokens and cost to the run; returns the cents added. */
async function addCost(tx: TenantTx, runId: string, model: string, usage: Usage): Promise<number> {
  const cents = costCents(model, usage);
  await tx.db
    .update(agentRuns)
    .set({
      inputTokens: sql`${agentRuns.inputTokens} + ${usage.inputTokens}`,
      outputTokens: sql`${agentRuns.outputTokens} + ${usage.outputTokens}`,
      cacheReadTokens: sql`${agentRuns.cacheReadTokens} + ${usage.cacheReadTokens}`,
      cacheWriteTokens: sql`${agentRuns.cacheWriteTokens} + ${usage.cacheWriteTokens}`,
      costCents: sql`${agentRuns.costCents} + ${cents}`,
    })
    .where(and(eq(agentRuns.tenantId, tx.context.tenantId), eq(agentRuns.id, runId)));
  return cents;
}

/** A run whose worker died (AGT8): already failed by the claim; its conversation goes to a person. */
export async function handOffAbandoned(claimed: { runId: string; tenantId: string }): Promise<void> {
  await withTenant(system(claimed.tenantId, claimed.runId), async (tx) => {
    const [run] = await tx.db.select({ conversationId: agentRuns.conversationId }).from(agentRuns).where(and(eq(agentRuns.tenantId, claimed.tenantId), eq(agentRuns.id, claimed.runId)));
    if (run) await handOff(tx, run.conversationId, 'error');
  });
}
