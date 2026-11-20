import { createHash } from 'node:crypto';
import type { AgentKind } from '../../db/schema/values.js';
import { AGENT_FORBIDDEN_PERMISSIONS, type Permission } from '../../lib/permissions.js';
import type { AgentToolRoute, JsonSchema } from '../../plugins/agent-tools.js';
import { AGENT_DEFINITIONS, SHARED_RULES } from './definitions.js';
import { PRICES } from './runtime/cost.js';
import { HAND_OFF_TOOL } from './runtime/hand-off.js';
import { SAFETY_SCREEN_FINGERPRINT } from './runtime/safety-screen.js';

/**
 * What each tool may do without a person (ADR 0012, docs/decisions/agents.md
 * AGT7, AGT9). Every tool a route names has a line here, and every tool an
 * agent lists does too. A tool whose module hasn't landed yet names the
 * thread that owns it; the agent simply doesn't have it until the route exists.
 */
export interface ToolPolicy {
  /** The most a tenant may raise it to. Reads always run; a change runs only on an approved card unless raised to auto. */
  ceiling: 'auto' | 'approve';
  /** Reads or changes one patient's record: only in a signed-in patient conversation, pinned to that patient (AGT9). */
  patientRecord: boolean;
  /** Input fields the runtime fills from the conversation; the model never sees or sets them. */
  pins: Readonly<Record<string, 'patientId' | 'subjectId'>>;
  /** A change that may be auto only up to a tenant limit: the input field with its amount in cents, and the setting that caps it. Over the cap it goes on a card (AGT7). */
  autoLimit?: { field: string; setting: AutoLimitSetting };
  /** The feature thread whose route this will be, while it doesn't exist. */
  waitingOn?: string;
}

export type AutoLimitSetting = 'refundCapCents';

const line = (waitingOn: string, extra: Partial<ToolPolicy> = {}): ToolPolicy => ({ ceiling: 'approve', patientRecord: false, pins: {}, waitingOn, ...extra });
const patient = { patientRecord: true, pins: { patientId: 'patientId' } } as const;

export const TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = {
  search_help_centre: line('support and CRM'),
  get_order_status: line('Parchment prescribing and orders', patient),
  get_next_consult: line('EMR and consults', patient),
  /**
   * Every refund goes on a card at launch (AGT7). If Vahid allows refunds
   * within the tenant's refund cap to run without a person, the ceiling
   * becomes 'auto' and the cap already applies.
   */
  request_refund: line('billing', { ...patient, autoLimit: { field: 'amountCents', setting: 'refundCapCents' } }),
  get_intake_progress: line('intake and protocol engine', patient),
  list_consult_times: line('EMR and consults'),
  /** The patient's own consult, first (intake) or review (care coordinator), may be raised to auto (AGT7). */
  book_consult: line('EMR and consults', { ...patient, ceiling: 'auto' }),
  /** Always on a card, and no agent has them at launch (AGT7). */
  reschedule_consult: line('EMR and consults', patient),
  cancel_consult: line('EMR and consults', patient),
  get_care_plan: line('EMR and consults', patient),
  /** An approved template, to the conversation's patient (AGT7). */
  send_template_message: line('support and CRM', { ...patient, ceiling: 'auto' }),
  get_intake_answers: line('intake and protocol engine', { pins: { intakeId: 'subjectId' } }),
  get_protocol_checklist: line('intake and protocol engine', { pins: { intakeId: 'subjectId' } }),
  save_intake_summary: line('intake and protocol engine', { pins: { intakeId: 'subjectId' } }),
};

/** Tools a route names must have a policy line, and no policy line may claim to wait for a route that exists. */
export function catalogueProblems(catalogue: ReadonlyMap<string, AgentToolRoute>, policy: Readonly<Record<string, ToolPolicy>> = TOOL_POLICY): string[] {
  const problems: string[] = [];
  for (const [name, tool] of catalogue) {
    if (AGENT_FORBIDDEN_PERMISSIONS.has(tool.permission)) problems.push(`agent tool ${name} needs ${tool.permission}, which no agent may hold (ADM-07)`);
    const line = policy[name];
    if (!line) problems.push(`agent tool ${name} has no line in TOOL_POLICY (src/modules/agents/policy.ts)`);
    else if (line.waitingOn) problems.push(`agent tool ${name} has a route now: remove its waitingOn`);
    for (const field of Object.keys(line?.pins ?? {})) {
      if (!(field in tool.inputSchema.properties)) problems.push(`agent tool ${name} pins ${field}, which its route doesn't take, so the pin would be dropped (AGT9)`);
    }
    if (line?.autoLimit && tool.inputSchema.properties[line.autoLimit.field]?.['type'] !== 'integer') {
      problems.push(`agent tool ${name} is capped by ${line.autoLimit.field}, which its input must have as a whole number of cents`);
    }
  }
  for (const definition of Object.values(AGENT_DEFINITIONS)) {
    if (!PRICES[definition.model]) problems.push(`${definition.kind} runs on ${definition.model}, which has no price, so its spend cap couldn't count it (AGT6)`);
    for (const name of definition.tools) if (!policy[name]) problems.push(`${definition.kind} lists tool ${name}, which has no policy line`);
  }
  return problems;
}

/** The tools an agent has today: its listed tools whose routes exist. */
export function toolsOf(agent: AgentKind, catalogue: ReadonlyMap<string, AgentToolRoute>): AgentToolRoute[] {
  return AGENT_DEFINITIONS[agent].tools.flatMap((name) => {
    const tool = catalogue.get(name);
    return tool ? [tool] : [];
  });
}

/**
 * The agent's role (AGT2): the permissions of its tools' routes, worked out
 * from code, never stored and never a membership.
 */
export function agentRolePermissions(agent: AgentKind, catalogue: ReadonlyMap<string, AgentToolRoute>): ReadonlySet<Permission> {
  return new Set(toolsOf(agent, catalogue).map((tool) => tool.permission).filter((permission) => !AGENT_FORBIDDEN_PERMISSIONS.has(permission)));
}

/** Whether a tenant may raise this tool to auto for this agent. */
export function canBeAuto(agent: AgentKind, name: string, catalogue: ReadonlyMap<string, AgentToolRoute>): boolean {
  const tool = catalogue.get(name);
  return Boolean(tool?.changesData && TOOL_POLICY[name]?.ceiling === 'auto' && AGENT_DEFINITIONS[agent].tools.includes(name));
}

/** Whether this call stays inside its tool's tenant limit, if it has one: a whole number of cents, at most the cap. */
export function withinAutoLimit(name: string, input: Record<string, unknown>, settings: Readonly<Record<AutoLimitSetting, number>>): boolean {
  const limit = TOOL_POLICY[name]?.autoLimit;
  if (!limit) return true;
  const amount = input[limit.field];
  return typeof amount === 'number' && Number.isInteger(amount) && amount >= 0 && amount <= settings[limit.setting];
}

/** A tool's input schema as the model sees it: pinned fields left out. */
export function modelInputSchema(tool: AgentToolRoute): JsonSchema {
  const pins = TOOL_POLICY[tool.name]?.pins ?? {};
  const properties = Object.fromEntries(Object.entries(tool.inputSchema.properties).filter(([key]) => !(key in pins)));
  return { ...tool.inputSchema, properties, required: tool.inputSchema.required.filter((key) => !(key in pins)) };
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, stable(v)]));
  }
  return value;
}

/**
 * The agent's version (AGT10): a hash of everything that shapes what it does.
 * Eval results are recorded against it, and a different version can't be
 * switched on or run until its own results pass.
 */
export function agentVersion(agent: AgentKind, catalogue: ReadonlyMap<string, AgentToolRoute>): string {
  const definition = AGENT_DEFINITIONS[agent];
  const tools = toolsOf(agent, catalogue).map((tool) => ({
    name: tool.name,
    description: tool.description,
    input: modelInputSchema(tool),
    changesData: tool.changesData,
    policy: TOOL_POLICY[tool.name],
  }));
  const shape = {
    definition: { ...definition, tools: undefined },
    rules: SHARED_RULES,
    tools,
    handOff: HAND_OFF_TOOL,
    safetyScreen: SAFETY_SCREEN_FINGERPRINT,
  };
  return createHash('sha256').update(JSON.stringify(stable(shape))).digest('hex').slice(0, 16);
}
