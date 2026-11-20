import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { App } from '../../src/app.js';
import { AGENT_KINDS } from '../../src/db/schema/values.js';
import { AGENT_FORBIDDEN_PERMISSIONS } from '../../src/lib/permissions.js';
import { TOOL_POLICY, agentRolePermissions, agentVersion, catalogueProblems, modelInputSchema, withinAutoLimit } from '../../src/modules/agents/policy.js';
import { DEFAULT_SETTINGS } from '../../src/modules/agents/settings.service.js';
import { type AgentToolRoute, requestFor, toolFromRoute } from '../../src/plugins/agent-tools.js';
import { testApp } from '../support/app.js';

/** The tool catalogue and its policy (ADR 0012, docs/decisions/agents.md AGT2, AGT7, AGT9). */
let app: App;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
});

const route = (agentTool: string | { none: string }, extra: Record<string, unknown> = {}) => ({
  method: 'POST' as const,
  url: '/v1/things/:thingId',
  config: { access: { permission: 'agents:read' as const }, agentTool },
  schema: { summary: 'Do a thing', params: z.object({ thingId: z.uuid() }), body: z.object({ note: z.string() }), ...extra },
});

describe('a tool is a route (AGT2)', () => {
  it('takes its description from the summary and its input from the params and body', () => {
    const tool = toolFromRoute(route('do_thing'))!;
    expect(tool).toMatchObject({ name: 'do_thing', description: 'Do a thing', permission: 'agents:read', changesData: true, parts: { thingId: 'path', note: 'body' } });
    expect(tool.inputSchema.required.sort()).toEqual(['note', 'thingId']);
    expect(requestFor(tool, { thingId: 'abc', note: 'hi' })).toEqual({ url: '/v1/things/abc', query: {}, body: { note: 'hi' } });
  });

  it('refuses a tool without a permission, a summary, a good name, or with a field in two places', () => {
    expect(() => toolFromRoute({ ...route('do_thing'), config: { access: 'member', agentTool: 'do_thing' } })).toThrow(/needs a permission/);
    expect(() => toolFromRoute(route('do_thing', { summary: undefined }))).toThrow(/needs a summary/);
    expect(() => toolFromRoute(route('Do-Thing'))).toThrow(/snake_case/);
    expect(() => toolFromRoute(route('do_thing', { body: z.object({ thingId: z.string() }) }))).toThrow(/more than one part/);
    expect(toolFromRoute(route({ none: 'a reason' }))).toBeNull();
  });
});

describe('the policy (AGT7, AGT9)', () => {
  it("has a line for every tool the app's routes name, and none needs a permission no agent may hold", () => {
    expect(catalogueProblems(app.agentTools)).toEqual([]);
  });

  it('lists tools still waiting for their module only while they have no route', () => {
    for (const [name, line] of Object.entries(TOOL_POLICY)) expect(Boolean(line.waitingOn)).toBe(!app.agentTools.has(name));
  });

  it('catches a tool with no policy line, and one that needs a forbidden permission', () => {
    const tool = toolFromRoute({ ...route('rename_staff'), config: { access: { permission: 'staff:manage' }, agentTool: 'rename_staff' } })!;
    expect(catalogueProblems(new Map([[tool.name, tool]]))).toEqual([
      'agent tool rename_staff needs staff:manage, which no agent may hold (ADM-07)',
      'agent tool rename_staff has no line in TOOL_POLICY (src/modules/agents/policy.ts)',
    ]);
  });

  it('never lets a refund run without a person at launch, and has the refund cap ready if that changes', () => {
    expect(TOOL_POLICY['request_refund']!.ceiling).toBe('approve');
    const caps = { refundCapCents: 5000 };
    expect(withinAutoLimit('request_refund', { amountCents: 5000 }, caps)).toBe(true);
    expect(withinAutoLimit('request_refund', { amountCents: 5001 }, caps)).toBe(false);
    for (const amountCents of ['100', 10.5, -1, undefined]) expect(withinAutoLimit('request_refund', { amountCents }, caps)).toBe(false);
    expect(withinAutoLimit('request_refund', { amountCents: 1 }, DEFAULT_SETTINGS)).toBe(false);
    expect(withinAutoLimit('book_consult', {}, caps)).toBe(true);
  });

  it('catches a capped tool whose input has no whole-cents amount', () => {
    const refund = toolFromRoute(route('request_refund'))!;
    expect(catalogueProblems(new Map([[refund.name, refund]]))).toContain('agent tool request_refund is capped by amountCents, which its input must have as a whole number of cents');
  });

  it("catches a pinned field the route doesn't take, which would otherwise leave the tool unpinned", () => {
    const cancel = toolFromRoute(route('cancel_consult'))!;
    expect(catalogueProblems(new Map([[cancel.name, cancel]]))).toContain(
      "agent tool cancel_consult pins patientId, which its route doesn't take, so the pin would be dropped (AGT9)",
    );
    const pinned = toolFromRoute(route('cancel_consult', { body: z.object({ patientId: z.uuid().optional(), reason: z.string() }) }))!;
    expect(catalogueProblems(new Map([[pinned.name, pinned]])).filter((problem) => problem.includes('pins'))).toEqual([]);
  });

  it('keeps pinned fields out of what the model sees', () => {
    const tool: AgentToolRoute = { ...toolFromRoute(route('book_consult'))!, inputSchema: { type: 'object', properties: { patientId: {}, startsAt: {} }, required: ['patientId', 'startsAt'] } };
    expect(modelInputSchema(tool)).toEqual({ type: 'object', properties: { startsAt: {} }, required: ['startsAt'] });
  });

  it('gives no agent a forbidden permission, and versions every agent', () => {
    for (const agent of AGENT_KINDS) {
      for (const permission of agentRolePermissions(agent, app.agentTools)) expect(AGENT_FORBIDDEN_PERMISSIONS.has(permission)).toBe(false);
      expect(agentVersion(agent, app.agentTools)).toMatch(/^[0-9a-f]{16}$/);
    }
    expect(agentVersion('support', app.agentTools)).toBe(agentVersion('support', app.agentTools));
    expect(agentVersion('support', app.agentTools)).not.toBe(agentVersion('intake', app.agentTools));
  });
});
