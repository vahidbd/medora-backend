import type { FastifyInstance } from 'fastify';
import type { AgentKind } from '../../../db/schema/values.js';
import { mintAgentCredential } from '../../../lib/agent-credential.js';
import type { Permission } from '../../../lib/permissions.js';
import { type AgentToolRoute, requestFor } from '../../../plugins/agent-tools.js';
import { TENANT_HEADER } from '../../../plugins/auth.js';
import { TOOL_POLICY, agentRolePermissions } from '../policy.js';

/**
 * Running a tool: calling its route in-process as the agent (docs/decisions/
 * agents.md AGT2). The credential carries only the one permission the route
 * needs, and only when both the agent's role and the person it works for
 * (or who approved the card) hold it. The route then does everything it
 * does for a person: its permission check, tenancy, gates and audit.
 */
export interface ToolCall {
  tenantId: string;
  agentId: string;
  agent: AgentKind;
  runId: string;
  tool: AgentToolRoute;
  /** As the model or the approver gave it; pinned fields are filled here. */
  input: Record<string, unknown>;
  /** The conversation's patient and subject, for pinned fields (AGT9). */
  pinned: { patientId: string | null; subjectId: string | null };
  /** The usable permissions of the person it works for or who approved it; null when no person is involved. */
  person: ReadonlySet<Permission> | null;
  approvedBy: string | null;
  idempotencyKey: string;
}

export interface ToolCallResult {
  status: number;
  body: unknown;
}

export class ToolRefused extends Error {
  constructor(readonly code: 'not_in_role' | 'person_lacks_permission' | 'pin_missing', message: string) {
    super(message);
    this.name = 'ToolRefused';
  }
}

/** The input with every pinned field set from the conversation, whatever the model sent. */
export function withPins(tool: AgentToolRoute, input: Record<string, unknown>, pinned: ToolCall['pinned']): Record<string, unknown> {
  const pins = TOOL_POLICY[tool.name]?.pins ?? {};
  const result = { ...input };
  for (const [field, from] of Object.entries(pins)) {
    const value = pinned[from];
    if (!value) throw new ToolRefused('pin_missing', `This conversation has no ${from === 'patientId' ? 'patient' : 'record'} for ${tool.name}`);
    result[field] = value;
  }
  return result;
}

export async function callTool(app: FastifyInstance, call: ToolCall): Promise<ToolCallResult> {
  const { tool } = call;
  if (!agentRolePermissions(call.agent, app.agentTools).has(tool.permission)) {
    throw new ToolRefused('not_in_role', `The ${call.agent} agent's role doesn't include ${tool.name}`);
  }
  if (call.person && !call.person.has(tool.permission)) {
    throw new ToolRefused('person_lacks_permission', `The person this agent works for can't use ${tool.name}`);
  }
  const credential = await mintAgentCredential({
    tenantId: call.tenantId,
    agentId: call.agentId,
    agent: call.agent,
    runId: call.runId,
    permissions: [tool.permission],
    approvedBy: call.approvedBy,
  });
  const request = requestFor(tool, withPins(tool, call.input, call.pinned));
  const response = await app.inject({
    method: tool.method as 'GET',
    url: request.url,
    query: request.query,
    ...(request.body ? { payload: request.body } : {}),
    headers: { authorization: `Agent ${credential}`, [TENANT_HEADER]: call.tenantId, 'idempotency-key': call.idempotencyKey },
  });
  let body: unknown = response.body;
  try {
    body = response.json();
  } catch {
    // Not JSON: the text as it came.
  }
  return { status: response.statusCode, body };
}
