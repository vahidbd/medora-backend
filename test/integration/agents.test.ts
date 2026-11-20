import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { env } from '../../src/config/env.js';
import { closeDatabase } from '../../src/db/health.js';
import { mintAgentCredential } from '../../src/lib/agent-credential.js';
import { TENANT_HEADER } from '../../src/plugins/auth.js';
import { agentTestApp, agentsOn, passEvals } from '../support/agents.js';
import { headers, signIn } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** Agent settings, the kill switches and who may change them (docs/decisions/agents.md AGT4 to AGT7). */
let app: App;
beforeAll(async () => {
  app = await agentTestApp();
  agentsOn();
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const call = async (method: 'GET' | 'PATCH' | 'POST', url: string, email: string, tenantId: string, payload?: object) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

describe('agent settings', () => {
  it('starts every agent off, and shows why', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const reply = await call('GET', '/v1/agents', members[0]!.email, tenantId);
    expect(reply.statusCode).toBe(200);
    const body = reply.json();
    expect(body.agents.map((a: { agent: string }) => a.agent)).toEqual(['intake', 'support', 'care_coordinator', 'clinical_copilot']);
    expect(body.agents.every((a: { enabled: boolean; off: string }) => !a.enabled && a.off === 'agent_off')).toBe(true);
    const intake = body.agents[0];
    expect(intake.tools.find((t: { name: string }) => t.name === 'book_consult')).toMatchObject({ available: true, ceiling: 'auto', auto: false });
    expect(intake.tools.find((t: { name: string }) => t.name === 'get_intake_progress')).toMatchObject({ available: false, waitingOn: 'intake and protocol engine' });
  });

  it("won't switch on an agent whose version has no passing eval, then will once it has one", async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!.email;
    const refused = await call('PATCH', '/v1/agents/support', owner, tenantId, { enabled: true });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('eval_required');

    passEvals(app, 'support');
    const on = await call('PATCH', '/v1/agents/support', owner, tenantId, { enabled: true, displayName: 'Sam' });
    expect(on.statusCode).toBe(200);
    expect(on.json()).toMatchObject({ enabled: true, off: null, name: 'Sam', evals: 'passed' });
    const { rows } = await admin.query("select actor_type, details from platform.audit_log where tenant_id = $1 and action = 'agent_settings.changed'", [tenantId]);
    expect(rows).toHaveLength(1);
    expect(rows[0].details).toMatchObject({ agent: 'support', enabled: true });
    const events = await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'agent_settings.changed'", [tenantId]);
    expect(events.rows).toHaveLength(1);
  });

  it('raises a tool to auto only within its ceiling (AGT7)', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!.email;
    const ok = await call('PATCH', '/v1/agents/intake', owner, tenantId, { autoTools: ['book_consult'] });
    expect(ok.json().autoTools).toEqual(['book_consult']);
    const reads = await call('PATCH', '/v1/agents/support', owner, tenantId, { autoTools: ['get_next_consult'] });
    expect(reads.json().error.code).toBe('tool_ceiling');
    const otherAgents = await call('PATCH', '/v1/agents/support', owner, tenantId, { autoTools: ['book_consult'] });
    expect(otherAgents.json().error.code).toBe('tool_ceiling');
  });

  it('refuses caps above the platform maxima', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const reply = await call('PATCH', '/v1/agents/support', members[0]!.email, tenantId, { monthlySpendCapCents: 500_001 });
    expect(reply.statusCode).toBe(400);
  });

  it('pauses and resumes every agent, keeping each one\'s setting (AGT5)', async () => {
    passEvals(app, 'support');
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!.email;
    await call('PATCH', '/v1/agents/support', owner, tenantId, { enabled: true });
    expect((await call('POST', '/v1/agents/pause', owner, tenantId)).json()).toEqual({ paused: true });
    const paused = (await call('GET', '/v1/agents', owner, tenantId)).json();
    expect(paused.paused).toBe(true);
    expect(paused.agents[1]).toMatchObject({ enabled: true, off: 'tenant_paused' });
    expect((await call('POST', '/v1/agents/resume', owner, tenantId)).json()).toEqual({ paused: false });
    expect((await call('GET', '/v1/agents', owner, tenantId)).json().agents[1]).toMatchObject({ enabled: true, off: null });
    const { rows } = await admin.query("select details from platform.audit_log where tenant_id = $1 and action = 'agent_tenant_settings.changed' order by at", [tenantId]);
    expect(rows.map((r) => r.details.paused)).toEqual([true, false]);
  });

  it('is off everywhere while the platform switch is off', async () => {
    const { tenantId, members } = await tenantWith('owner');
    env.AGENTS_ENABLED = 'false';
    try {
      const reply = await call('GET', '/v1/agents', members[0]!.email, tenantId);
      expect(reply.json()).toMatchObject({ platformOn: false });
      expect(reply.json().agents.every((a: { off: string }) => a.off === 'platform_off')).toBe(true);
    } finally {
      env.AGENTS_ENABLED = 'true';
    }
  });
});

describe('who may do what with agents (AGT4)', () => {
  it('lets finance read and only the owner change', async () => {
    const { tenantId, members } = await tenantWith('owner', 'finance', 'support', 'admin');
    const [, finance, support, tenantAdmin] = members;
    expect((await call('GET', '/v1/agents', finance!.email, tenantId)).statusCode).toBe(200);
    expect((await call('GET', '/v1/agent-runs', tenantAdmin!.email, tenantId)).statusCode).toBe(200);
    expect((await call('GET', '/v1/agents', support!.email, tenantId)).statusCode).toBe(403);
    expect((await call('PATCH', '/v1/agents/support', finance!.email, tenantId, { dailyReplyCap: 5 })).statusCode).toBe(403);
    expect((await call('POST', '/v1/agents/pause', tenantAdmin!.email, tenantId)).statusCode).toBe(403);
  });
});

describe('the agent credential (AGT2)', () => {
  const credential = (tenantId: string, permissions: string[]) =>
    mintAgentCredential({ tenantId, agentId: crypto.randomUUID(), agent: 'support', runId: crypto.randomUUID(), permissions: permissions as never, approvedBy: null });

  it('calls a route that needs a permission it holds, in its own tenant only', async () => {
    const { tenantId } = await tenantWith('owner');
    const other = await tenantWith('owner');
    const token = await credential(tenantId, ['agents:read']);
    const patientId = crypto.randomUUID();
    const ok = await app.inject({ method: 'GET', url: `/v1/test/patients/${patientId}/next-consult`, headers: { authorization: `Agent ${token}`, [TENANT_HEADER]: tenantId } });
    expect(ok.statusCode).toBe(200);
    const elsewhere = await app.inject({ method: 'GET', url: `/v1/test/patients/${patientId}/next-consult`, headers: { authorization: `Agent ${token}`, [TENANT_HEADER]: other.tenantId } });
    expect(elsewhere.statusCode).toBe(403);
  });

  it("can't call a route its credential doesn't name, a person's route, or one no agent may use", async () => {
    const { tenantId } = await tenantWith('owner');
    const reading = await credential(tenantId, ['agents:read']);
    const auth = (token: string) => ({ authorization: `Agent ${token}`, [TENANT_HEADER]: tenantId });
    expect((await app.inject({ method: 'POST', url: '/v1/agents/pause', headers: auth(reading) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: auth(reading) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/agent-proposals', headers: auth(reading) })).statusCode).toBe(403);
    const managing = await credential(tenantId, ['staff:manage']);
    expect((await app.inject({ method: 'GET', url: '/v1/staff', headers: auth(managing) })).statusCode).toBe(403);
    expect((await app.inject({ method: 'GET', url: '/v1/agents', headers: { authorization: 'Agent not-a-credential', [TENANT_HEADER]: tenantId } })).statusCode).toBe(401);
  });
});
