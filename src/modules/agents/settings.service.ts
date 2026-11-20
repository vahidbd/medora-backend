import { and, eq } from 'drizzle-orm';
import { env } from '../../config/env.js';
import { agentSettings, agentTenantSettings, tenants } from '../../db/schema/index.js';
import { AGENT_KINDS, type AgentChannel, type AgentKind } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError, ForbiddenError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import type { AgentToolRoute } from '../../plugins/agent-tools.js';
import { AGENT_DEFINITIONS } from './definitions.js';
import { evalStatus, type EvalStatus } from './evals.js';
import { TOOL_POLICY, agentVersion, canBeAuto } from './policy.js';
import { monthSpendCents, runsToday } from './usage.js';

/**
 * Agent settings and the kill switches (docs/decisions/agents.md AGT5 to AGT7).
 * An agent runs only when its own setting is on, its tenant hasn't paused all
 * agents, and the platform switch is on. A settings row is made the first
 * time someone changes an agent, so an agent nobody touched is off.
 */
type Catalogue = ReadonlyMap<string, AgentToolRoute>;

export type SettingsRow = typeof agentSettings.$inferSelect;

export const DEFAULT_SETTINGS = {
  enabled: false,
  displayName: null,
  autoTools: [] as string[],
  monthlySpendCapCents: 15_000,
  dailyReplyCap: 1_000,
  refundCapCents: 0,
};

/** Why an agent is off, most specific last: the platform, then the tenant, then the agent itself. */
export type OffReason = 'platform_off' | 'tenant_paused' | 'agent_off';

export interface Switches {
  settings: SettingsRow | null;
  paused: boolean;
  platformOn: boolean;
}

export function platformOn(): boolean {
  return env.AGENTS_ENABLED === 'true';
}

export function offReason(switches: Switches): OffReason | null {
  if (!switches.platformOn) return 'platform_off';
  if (switches.paused) return 'tenant_paused';
  if (!switches.settings?.enabled) return 'agent_off';
  return null;
}

export async function readSwitches(tx: TenantTx, agent: AgentKind): Promise<Switches> {
  const [settings] = await tx.db.select().from(agentSettings).where(and(eq(agentSettings.tenantId, tx.context.tenantId), eq(agentSettings.agent, agent)));
  const [tenant] = await tx.db.select({ paused: agentTenantSettings.paused }).from(agentTenantSettings).where(eq(agentTenantSettings.tenantId, tx.context.tenantId));
  return { settings: settings ?? null, paused: tenant?.paused ?? false, platformOn: platformOn() };
}

export async function tenantTimeZone(tx: TenantTx): Promise<string> {
  const [row] = await tx.db.select({ timeZone: tenants.timeZone }).from(tenants).where(eq(tenants.id, tx.context.tenantId));
  return row?.timeZone ?? 'Australia/Sydney';
}

export interface AgentSummary {
  agent: AgentKind;
  name: string;
  defaultName: string;
  enabled: boolean;
  off: OffReason | null;
  version: string;
  evals: EvalStatus;
  channels: AgentChannel[];
  tools: { name: string; changesData: boolean; ceiling: 'auto' | 'approve'; auto: boolean; available: boolean; waitingOn: string | null }[];
  autoTools: string[];
  monthlySpendCapCents: number;
  dailyReplyCap: number;
  refundCapCents: number;
  usage: { monthSpendCents: number; runsToday: number };
  updatedAt: string | null;
}

function summarise(agent: AgentKind, switches: Switches, catalogue: Catalogue, usage: AgentSummary['usage']): AgentSummary {
  const definition = AGENT_DEFINITIONS[agent];
  const settings = switches.settings ?? DEFAULT_SETTINGS;
  const version = agentVersion(agent, catalogue);
  return {
    agent,
    name: settings.displayName ?? definition.defaultName,
    defaultName: definition.defaultName,
    enabled: settings.enabled,
    off: offReason(switches),
    version,
    evals: evalStatus(agent, version),
    channels: [...definition.channels],
    tools: definition.tools.map((name) => {
      const route = catalogue.get(name);
      const policy = TOOL_POLICY[name]!;
      return {
        name,
        changesData: route?.changesData ?? false,
        ceiling: policy.ceiling,
        auto: settings.autoTools.includes(name),
        available: Boolean(route),
        waitingOn: route ? null : (policy.waitingOn ?? null),
      };
    }),
    autoTools: [...settings.autoTools],
    monthlySpendCapCents: settings.monthlySpendCapCents,
    dailyReplyCap: settings.dailyReplyCap,
    refundCapCents: settings.refundCapCents,
    usage,
    updatedAt: switches.settings?.updatedAt.toISOString() ?? null,
  };
}

export async function describeAgent(tx: TenantTx, agent: AgentKind, catalogue: Catalogue): Promise<AgentSummary> {
  const timeZone = await tenantTimeZone(tx);
  const usage = { monthSpendCents: await monthSpendCents(tx, agent, timeZone), runsToday: await runsToday(tx, agent, timeZone) };
  return summarise(agent, await readSwitches(tx, agent), catalogue, usage);
}

export async function listAgents(tx: TenantTx, catalogue: Catalogue): Promise<{ paused: boolean; platformOn: boolean; agents: AgentSummary[] }> {
  const agents: AgentSummary[] = [];
  for (const agent of AGENT_KINDS) agents.push(await describeAgent(tx, agent, catalogue));
  const [tenant] = await tx.db.select({ paused: agentTenantSettings.paused }).from(agentTenantSettings).where(eq(agentTenantSettings.tenantId, tx.context.tenantId));
  return { paused: tenant?.paused ?? false, platformOn: platformOn(), agents };
}

export interface SettingsChange {
  enabled?: boolean | undefined;
  displayName?: string | null | undefined;
  autoTools?: string[] | undefined;
  monthlySpendCapCents?: number | undefined;
  dailyReplyCap?: number | undefined;
  refundCapCents?: number | undefined;
}

function personOf(tx: TenantTx): string {
  if (tx.context.actor.type !== 'person') throw new ForbiddenError('Only a person can change an agent', 'person_only');
  return tx.context.actor.userId;
}

/**
 * Change one agent's settings (AGT5 to AGT7). Switching it on needs a
 * passing eval for the version that would run and a spending cap above
 * zero; a tool goes to auto only within its ceiling.
 */
export async function updateAgent(tx: TenantTx, agent: AgentKind, change: SettingsChange, catalogue: Catalogue): Promise<AgentSummary> {
  const userId = personOf(tx);
  const current = (await readSwitches(tx, agent)).settings;
  const before = current ?? { ...DEFAULT_SETTINGS };
  const next = {
    enabled: change.enabled ?? before.enabled,
    displayName: change.displayName === undefined ? before.displayName : change.displayName,
    autoTools: change.autoTools ? [...new Set(change.autoTools)].sort() : before.autoTools,
    monthlySpendCapCents: change.monthlySpendCapCents ?? before.monthlySpendCapCents,
    dailyReplyCap: change.dailyReplyCap ?? before.dailyReplyCap,
    refundCapCents: change.refundCapCents ?? before.refundCapCents,
  };

  const notAllowed = next.autoTools.filter((name) => !canBeAuto(agent, name, catalogue));
  if (notAllowed.length > 0) throw new BusinessRuleError(`These tools can't run without approval: ${notAllowed.join(', ')}`, 'tool_ceiling');
  if (next.enabled && !before.enabled) {
    if (evalStatus(agent, agentVersion(agent, catalogue)) !== 'passed') {
      throw new BusinessRuleError("This agent's current version has no passing eval result, so it can't be switched on", 'eval_required');
    }
    if (next.monthlySpendCapCents <= 0) throw new BusinessRuleError('Set a monthly spending cap above zero first', 'spend_cap_required');
  }

  const changed = (Object.keys(next) as (keyof typeof next)[]).filter((key) => JSON.stringify(next[key]) !== JSON.stringify(before[key]));
  if (changed.length === 0 && current) return describeAgent(tx, agent, catalogue);

  const now = new Date();
  let id = current?.id;
  if (current) {
    await tx.db.update(agentSettings).set({ ...next, updatedAt: now, updatedBy: userId }).where(and(eq(agentSettings.tenantId, tx.context.tenantId), eq(agentSettings.id, current.id)));
  } else {
    const [row] = await tx.db
      .insert(agentSettings)
      .values({ tenantId: tx.context.tenantId, agent, ...next, updatedAt: now, updatedBy: userId })
      .returning({ id: agentSettings.id });
    id = row!.id;
  }
  const facts = { agent, changed: changed.join(','), enabled: next.enabled, autoTools: next.autoTools.join(','), monthlySpendCapCents: next.monthlySpendCapCents };
  const record = { recordTable: 'platform.agent_settings', recordId: id! } as const;
  await audit(tx, { action: 'agent_settings.changed', zone: 'platform', ...record, details: facts });
  await emitEvent(tx, { type: 'agent_settings.changed', ...record, payload: facts });
  return describeAgent(tx, agent, catalogue);
}

/** Pause or resume every agent in the tenant at once (AGT5). Each agent's own setting is kept. */
export async function setPaused(tx: TenantTx, paused: boolean): Promise<{ paused: boolean }> {
  const userId = personOf(tx);
  const tenantId = tx.context.tenantId;
  const [current] = await tx.db.select({ paused: agentTenantSettings.paused }).from(agentTenantSettings).where(eq(agentTenantSettings.tenantId, tenantId)).for('update');
  if ((current?.paused ?? false) === paused) return { paused };
  const now = new Date();
  if (current) {
    await tx.db.update(agentTenantSettings).set({ paused, updatedAt: now, updatedBy: userId }).where(eq(agentTenantSettings.tenantId, tenantId));
  } else {
    await tx.db.insert(agentTenantSettings).values({ tenantId, paused, updatedAt: now, updatedBy: userId });
  }
  const record = { recordTable: 'platform.agent_tenant_settings', recordId: tenantId } as const;
  await audit(tx, { action: 'agent_tenant_settings.changed', zone: 'platform', ...record, details: { paused } });
  await emitEvent(tx, { type: 'agent_tenant_settings.changed', ...record, payload: { paused } });
  return { paused };
}
