import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { type Received, agentsLoop, handBack, openConversation, readReply, receiveMessage, startJob } from '../../src/modules/agents/index.js';
import { type ScriptStep, scripted, scriptedClient } from '../../src/modules/agents/model/scripted.js';
import { agentTestApp, agentsOn, passEvals, toolCalls } from '../support/agents.js';
import { headers, signIn } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** Runs end to end: queue, claim, model, tools, cards, limits, the safety screen (docs/decisions/agents.md AGT6 to AGT12). */
let app: App;
beforeAll(async () => {
  app = await agentTestApp();
  agentsOn();
  passEvals(app, 'intake', 'support', 'care_coordinator', 'clinical_copilot');
});
afterEach(async () => {
  // Files in a worker share a database: leave no run for the next test to claim.
  await admin.query("update platform.agent_runs set status = 'stopped', end_reason = 'test_cleanup', ended_at = now() where status = 'queued'");
  toolCalls.length = 0;
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const silentLog = { error: () => undefined, warn: () => undefined };
const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });
const later = '2026-12-01T09:00:00+11:00';

async function runAll(steps: ScriptStep[]) {
  const model = scriptedClient(steps);
  const loop = agentsLoop({ app, model, log: silentLog });
  await loop.tick();
  await loop.drain();
  return model;
}

async function setUp(agent: 'intake' | 'support', settings: object = {}) {
  const { tenantId, members } = await tenantWith('owner', 'clinician', 'finance');
  const owner = members[0]!;
  const token = await signIn(owner.email);
  const enabled = await app.inject({ method: 'PATCH', url: `/v1/agents/${agent}`, headers: headers(token, tenantId), payload: { enabled: true, ...settings } });
  expect(enabled.statusCode).toBe(200);
  const patientId = crypto.randomUUID();
  const opened = await withTenant(system(tenantId), (tx) => openConversation(tx, { agent, channel: 'chat', patientId, verified: true }));
  if (!('conversationId' in opened)) throw new Error('the agent should be on');
  const send = (text: string): Promise<Received> =>
    withTenant(system(tenantId), (tx) => receiveMessage(tx, { conversationId: opened.conversationId, text, from: 'patient' }));
  return { tenantId, members, owner, token, patientId, conversationId: opened.conversationId, send };
}

const runOf = async (runId: string) => (await admin.query('select * from platform.agent_runs where id = $1', [runId])).rows[0];
const conversationOf = async (id: string) => (await admin.query('select status, handoff_reason from clinical.agent_conversations where id = $1', [id])).rows[0];

describe('a run', () => {
  it('answers, and the reply reaches the channel through an event', async () => {
    const s = await setUp('support');
    const received = await s.send('When is my next consult?');
    expect(received.action).toBe('agent');
    const model = await runAll([scripted.tool('get_next_consult', {}), scripted.text('Your next consult is on 1 December at 9 am.')]);

    const run = await runOf((received as { runId: string }).runId);
    expect(run).toMatchObject({ status: 'completed', end_reason: 'replied', steps: 2 });
    expect(run.cost_cents).toBeGreaterThan(0);
    // The read ran pinned to the conversation's patient, whatever the model sent (AGT9).
    expect(toolCalls).toEqual([{ tool: 'get_next_consult', input: { patientId: s.patientId }, idempotencyKey: undefined }]);
    expect(JSON.stringify(model.requests[1]!.messages)).toContain(s.patientId);

    const event = (await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'agent_message.created'", [s.tenantId])).rows[0];
    // Ids only: the channel's module reads the text through readReply (AGT16).
    expect(Object.keys(event.payload).sort()).toEqual(['agent', 'channel', 'conversationId', 'messageId', 'subjectId', 'subjectTable']);
    const reply = await withTenant(system(s.tenantId), (tx) => readReply(tx, event.payload.messageId));
    expect(reply.text).toBe('Your next consult is on 1 December at 9 am.');
  });

  it('puts a change on an approval card by default, and the card runs once when approved (AGT12)', async () => {
    const s = await setUp('intake');
    await s.send('Please book me in for 1 December at 9');
    await runAll([scripted.tool('book_consult', { startsAt: later }), scripted.text('A person will confirm your booking.')]);
    expect(toolCalls).toEqual([]);

    const [, clinician, finance] = s.members;
    // The card's route needs agents:read: the clinician can't approve it, so doesn't see it (AGT4).
    const unseen = await app.inject({ method: 'GET', url: '/v1/agent-proposals', headers: headers(await signIn(clinician!.email), s.tenantId) });
    expect(unseen.json().proposals).toEqual([]);
    const financeToken = await signIn(finance!.email);
    const inbox = await app.inject({ method: 'GET', url: '/v1/agent-proposals', headers: headers(financeToken, s.tenantId) });
    const [card] = inbox.json().proposals;
    expect(card).toMatchObject({ tool: 'book_consult', status: 'pending', input: { startsAt: later } });

    const approve = () => app.inject({ method: 'POST', url: `/v1/agent-proposals/${card.proposalId}/approve`, headers: headers(financeToken, s.tenantId), payload: {} });
    const [first, second] = await Promise.all([approve(), approve()]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([200, 409]);
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0]).toMatchObject({ input: { patientId: s.patientId, startsAt: later }, idempotencyKey: expect.stringContaining(card.runId) });
    const done = [first, second].find((r) => r.statusCode === 200)!.json();
    expect(done).toMatchObject({ status: 'executed', resultStatus: 201, decidedBy: finance!.id });

    // The route's own audit entry names the agent, the run and the approver (AGT2).
    const { rows } = await admin.query("select actor_type, details from platform.audit_log where tenant_id = $1 and action = 'test.booked'", [s.tenantId]);
    expect(rows).toEqual([{ actor_type: 'agent', details: expect.objectContaining({ agentRunId: card.runId, approvedBy: finance!.id }) }]);
  });

  it('runs a change without a card once the tenant raised it to auto', async () => {
    const s = await setUp('intake', { autoTools: ['book_consult'] });
    await s.send('Book me for 1 December at 9 please');
    await runAll([scripted.tool('book_consult', { startsAt: later }), scripted.text('Booked.')]);
    expect(toolCalls).toHaveLength(1);
    const { rows } = await admin.query('select count(*)::int as n from clinical.agent_proposals where tenant_id = $1', [s.tenantId]);
    expect(rows[0].n).toBe(0);
  });

  it('puts every refund on a card, whatever the refund cap (AGT7)', async () => {
    const s = await setUp('support', { refundCapCents: 5000 });
    const raise = await app.inject({ method: 'PATCH', url: '/v1/agents/support', headers: headers(s.token, s.tenantId), payload: { autoTools: ['request_refund'] } });
    expect(raise.statusCode).toBe(409);
    expect(raise.json().error.code).toBe('tool_ceiling');

    await s.send("I'd like a refund for my last order");
    await runAll([scripted.tool('request_refund', { orderId: 'order-1', amountCents: 4000 }), scripted.text('A person will confirm your refund.')]);
    expect(toolCalls).toEqual([]);
    const { rows } = await admin.query('select tool, input from clinical.agent_proposals where tenant_id = $1', [s.tenantId]);
    expect(rows).toEqual([{ tool: 'request_refund', input: { orderId: 'order-1', amountCents: 4000 } }]);
  });

  it('rejects a card with a reason, and expires one after seven days', async () => {
    const s = await setUp('intake');
    await s.send('Book me in');
    await runAll([scripted.tool('book_consult', { startsAt: later }), scripted.text('Sent.')]);
    await s.send('And another one');
    await runAll([scripted.tool('book_consult', { startsAt: '2026-12-02T09:00:00+11:00' }), scripted.text('Sent.')]);
    const ownerHeaders = headers(s.token, s.tenantId);
    const owner = headers(await signIn(s.owner.email), s.tenantId);
    const cards = (await app.inject({ method: 'GET', url: '/v1/agent-proposals', headers: ownerHeaders })).json().proposals;
    expect(cards).toHaveLength(2);

    const rejected = await app.inject({ method: 'POST', url: `/v1/agent-proposals/${cards[0].proposalId}/reject`, headers: owner, payload: { reason: 'not_needed' } });
    expect(rejected.json()).toMatchObject({ status: 'rejected', decisionReason: 'not_needed' });

    await admin.query("update clinical.agent_proposals set expires_at = now() - interval '1 minute' where id = $1", [cards[1].proposalId]);
    const late = await app.inject({ method: 'POST', url: `/v1/agent-proposals/${cards[1].proposalId}/approve`, headers: owner, payload: {} });
    expect(late.json().error.code).toBe('proposal_expired');
    expect((await admin.query('select status from clinical.agent_proposals where id = $1', [cards[1].proposalId])).rows[0].status).toBe('expired');
    expect(toolCalls).toEqual([]);
  });

  it("can be rejected but not approved while the agent is off (AGT5)", async () => {
    const s = await setUp('intake');
    await s.send('Book me in');
    await runAll([scripted.tool('book_consult', { startsAt: later }), scripted.text('Sent.')]);
    const owner = headers(s.token, s.tenantId);
    const [card] = (await app.inject({ method: 'GET', url: '/v1/agent-proposals', headers: owner })).json().proposals;
    await app.inject({ method: 'POST', url: '/v1/agents/pause', headers: owner });
    const approve = await app.inject({ method: 'POST', url: `/v1/agent-proposals/${card.proposalId}/approve`, headers: owner, payload: {} });
    expect(approve.json().error.code).toBe('proposal_agent_off');
    const reject = await app.inject({ method: 'POST', url: `/v1/agent-proposals/${card.proposalId}/reject`, headers: owner, payload: { reason: 'unsafe' } });
    expect(reject.statusCode).toBe(200);
    expect(toolCalls).toEqual([]);
  });

  it('hands the conversation to a person when the agent is switched off before its run', async () => {
    const s = await setUp('support');
    const received = await s.send('Hello');
    await app.inject({ method: 'PATCH', url: '/v1/agents/support', headers: headers(s.token, s.tenantId), payload: { enabled: false } });
    await runAll([]);
    expect(await runOf((received as { runId: string }).runId)).toMatchObject({ status: 'stopped', end_reason: 'agent_off' });
    expect(await conversationOf(s.conversationId)).toEqual({ status: 'handed_off', handoff_reason: 'agent_off' });
  });

  it('hands off on a refusal and when the model asks, and stays out until handed back (AGT11)', async () => {
    const s = await setUp('support');
    await s.send('Something odd');
    await runAll([scripted.refusal()]);
    expect(await conversationOf(s.conversationId)).toEqual({ status: 'handed_off', handoff_reason: 'refusal' });
    expect(await s.send('Hello?')).toEqual({ action: 'person', reason: 'refusal' });

    await withTenant({ tenantId: s.tenantId, actor: { type: 'person', userId: s.owner.id }, requestId: 'test' }, (tx) => handBack(tx, s.conversationId));
    expect((await s.send('I have a rash since starting the tablets')).action).toBe('agent');
    await runAll([scripted.tool('hand_off', { reason: 'adverse_event', note: 'Reports a rash' })]);
    expect(await conversationOf(s.conversationId)).toEqual({ status: 'handed_off', handoff_reason: 'adverse_event' });
    const event = (await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'agent_conversation.handed_off' order by id desc limit 1", [s.tenantId])).rows[0];
    expect(event.payload).toMatchObject({ reason: 'adverse_event', urgent: true });
  });
});

describe('the safety screen (AGT11)', () => {
  it('answers with fixed words before any model, and hands off urgently', async () => {
    const s = await setUp('support');
    const received = await s.send('I want to end my life');
    expect(received).toMatchObject({ action: 'safety', reason: 'self_harm' });
    expect((received as { reply: string }).reply).toContain('13 11 14');
    const model = await runAll([]);
    expect(model.requests).toEqual([]);
    expect(await conversationOf(s.conversationId)).toEqual({ status: 'handed_off', handoff_reason: 'self_harm' });
  });

  it('screens a message even while the agent is off', async () => {
    const s = await setUp('support');
    await app.inject({ method: 'POST', url: '/v1/agents/pause', headers: headers(s.token, s.tenantId) });
    expect(await s.send('I have chest pain')).toMatchObject({ action: 'safety', reason: 'emergency' });
  });
});

describe('limits (AGT6)', () => {
  it('hands off once the monthly cap is spent, and tells the owner at 100%', async () => {
    const s = await setUp('support', { monthlySpendCapCents: 1 });
    await s.send('Hi');
    await runAll([scripted.text('Hello.')]);
    expect(await s.send('Hi again')).toEqual({ action: 'person', reason: 'limit' });
    const { rows } = await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'agent_spend.threshold_reached'", [s.tenantId]);
    expect(rows.map((r) => r.payload.percent)).toEqual([80, 100]);
  });

  it('hands off once the daily reply cap is reached', async () => {
    const s = await setUp('support', { dailyReplyCap: 1 });
    await s.send('Hi');
    await runAll([scripted.text('Hello.')]);
    expect(await s.send('Hi again')).toEqual({ action: 'person', reason: 'limit' });
  });
});

describe('the claim (AGT8)', () => {
  it('fails a run whose worker died and hands its conversation to a person', async () => {
    const s = await setUp('support');
    const received = await s.send('Hello');
    const runId = (received as { runId: string }).runId;
    await admin.query("update platform.agent_runs set status = 'running', started_at = now(), lease_expires_at = now() - interval '1 second' where id = $1", [runId]);
    await runAll([]);
    expect(await runOf(runId)).toMatchObject({ status: 'failed', end_reason: 'worker_died' });
    expect(await conversationOf(s.conversationId)).toEqual({ status: 'handed_off', handoff_reason: 'error' });
  });
});

describe('jobs and narrowing (AGT2, AGT13)', () => {
  it('narrows a job to the staff member who started it', async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician');
    const [owner, clinician] = members;
    await app.inject({ method: 'PATCH', url: '/v1/agents/care_coordinator', headers: headers(await signIn(owner!.email), tenantId), payload: { enabled: true } });
    const asClinician: TenantContext = { tenantId, actor: { type: 'person', userId: clinician!.id }, requestId: 'test' };
    const job = await withTenant(asClinician, (tx) =>
      startJob(tx, { agent: 'care_coordinator', subjectTable: 'clinical.care_plans', subjectId: crypto.randomUUID(), patientId: crypto.randomUUID(), instructions: 'Check whether a review is due' }),
    );
    expect('conversationId' in job).toBe(true);
    // The care coordinator's tools here don't include the stand-in routes, so it can only reply.
    await runAll([scripted.text('No review is due.')]);
    const { rows } = await admin.query('select status, started_by from platform.agent_runs where tenant_id = $1', [tenantId]);
    expect(rows).toEqual([{ status: 'completed', started_by: clinician!.id }]);
  });
});

describe('transcripts (AGT3, AGT4)', () => {
  it('are read by clinical roles only, and every read is audited', async () => {
    const s = await setUp('support');
    await s.send('My email is someone@example.test');
    await runAll([scripted.text('Thanks.')]);
    const [owner, clinician, finance] = s.members;
    const url = `/v1/agent-conversations/${s.conversationId}`;
    const asClinician = await app.inject({ method: 'GET', url, headers: headers(await signIn(clinician!.email), s.tenantId) });
    expect(asClinician.statusCode).toBe(200);
    const messages = asClinician.json().messages;
    expect(messages[0]).toMatchObject({ role: 'patient', untrusted: true, blocks: [{ type: 'text', text: 'My email is [email]' }] });
    expect((await app.inject({ method: 'GET', url, headers: headers(await signIn(finance!.email), s.tenantId) })).statusCode).toBe(403);
    // The owner holds the permission, but it is clinical: break-glass first (ADM3).
    expect((await app.inject({ method: 'GET', url, headers: headers(await signIn(owner!.email), s.tenantId) })).statusCode).toBe(403);
    const { rows } = await admin.query("select actor_id, details from platform.audit_log where tenant_id = $1 and action = 'agent_conversation.read' and details->>'purpose' = 'view'", [s.tenantId]);
    expect(rows).toEqual([{ actor_id: clinician!.id, details: expect.objectContaining({ messages: 2 }) }]);
  });
});
