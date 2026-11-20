import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { fakeEmail, queueMessage } from '../../src/modules/messaging/index.js';
import { logCall, markOverdue, receiveMessage, replyToTicket, type InboundMessage } from '../../src/modules/support/index.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { admin, createBrand, tenantWith } from '../support/db.js';
import { postTwilioWebhook } from '../support/twilio.js';

/**
 * The helpdesk (PRD section 13, docs/decisions/support.md). Made-up people,
 * addresses and messages only.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});
beforeEach(() => fakeEmail.reset());

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });

async function setUp() {
  const { tenantId, members } = await tenantWith('owner', 'support', 'clinician', 'admin');
  const [owner, support, clinician] = members;
  const { brandId } = await createBrand(tenantId, { status: 'live' });
  await admin.query(
    `insert into operational.senders (tenant_id, brand_id, channel, purpose, address, updated_by_user_id)
     values ($1, $2, 'email', 'service', 'care@kestrel.example', $3), ($1, $2, 'sms', 'service', '+61400000100', $3)`,
    [tenantId, brandId, owner!.id],
  );
  const as = async (member: { email: string }) => headers(await signIn(member.email), tenantId);
  return { tenantId, brandId, owner: owner!, support: support!, clinician: clinician!, as };
}

async function createPatient(tenantId: string, contact: { email?: string; mobile?: string }, givenName = 'Alex'): Promise<string> {
  const { rows } = await admin.query<{ id: string }>(
    `insert into clinical.patients (tenant_id, given_name, family_name, date_of_birth, sex) values ($1, $2, 'Example', '1990-04-12', 'not_stated') returning id`,
    [tenantId, givenName],
  );
  const patientId = rows[0]!.id;
  if (contact.email)
    await admin.query(`insert into clinical.patient_contacts (tenant_id, patient_id, kind, value) values ($1, $2, 'email', $3)`, [tenantId, patientId, contact.email]);
  if (contact.mobile)
    await admin.query(`insert into clinical.patient_contacts (tenant_id, patient_id, kind, value) values ($1, $2, 'mobile', $3)`, [tenantId, patientId, contact.mobile]);
  return patientId;
}

function email(brandId: string, from: string, body: string, extra: Partial<InboundMessage> = {}): InboundMessage {
  return { channel: 'email', from, to: 'care@kestrel.example', subject: 'Question', body, brandId, providerMessageId: `<${randomUUID()}@mail.example>`, ...extra };
}

const receive = (tenantId: string, input: InboundMessage) => withTenant(system(tenantId), (tx) => receiveMessage(tx, input));

describe('a message comes in (SUP3, SUP8)', async () => {
  const t = await setUp();

  it('opens a ticket in the support queue and links the one patient with that address', async () => {
    const patientId = await createPatient(t.tenantId, { email: 'alex.one@example.test' });
    const { ticket, newTicket } = await receive(t.tenantId, email(t.brandId, 'Alex.One@example.test', 'Where is my order?'));
    expect(newTicket).toBe(true);
    expect(ticket).toMatchObject({ queue: 'support', priority: 'normal', patientId, patientVerifiedAt: null, brandId: t.brandId });
    const events = await admin.query("select payload from platform.outbox where type = 'ticket.message_received' and record_id = $1", [ticket.id]);
    expect(Object.keys(events.rows[0].payload).sort()).toEqual(['channel', 'flags', 'messageId', 'newTicket', 'patientId', 'priority', 'queue']);
  });

  it('links nobody when two patients share the address', async () => {
    await createPatient(t.tenantId, { email: 'shared@example.test' }, 'Sam');
    await createPatient(t.tenantId, { email: 'shared@example.test' }, 'Jo');
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'shared@example.test', 'Hello'));
    expect(ticket.patientId).toBeNull();
  });

  it('threads a reply to our email onto its ticket, by the message it answers', async () => {
    const first = await receive(t.tenantId, email(t.brandId, 'thread@example.test', 'Can I change my address?'));
    const { message } = await withTenant(system(t.tenantId), (tx) =>
      queueMessage(tx, {
        channel: 'email',
        kind: 'support',
        from: 'care@kestrel.example',
        to: 'thread@example.test',
        subject: 'Re: Question',
        body: 'Yes, tell us the new one.',
        ticketId: first.ticket.id,
      }),
    );
    const next = await receive(t.tenantId, email(t.brandId, 'thread@example.test', 'It is 1 Example St', { answers: [message.id] }));
    expect(next).toMatchObject({ newTicket: false, ticket: { id: first.ticket.id } });
  });

  it('threads an SMS from the same number onto its open ticket, from the Twilio inbox', async () => {
    const from = '+61400000201';
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${t.tenantId}/sms-inbound`, {
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
      From: from,
      To: '+61400000100',
      Body: 'Hi, is my order coming?',
    });
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${t.tenantId}/sms-inbound`, {
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
      From: from,
      To: '+61400000100',
      Body: 'Thanks',
    });
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${t.tenantId}/sms-inbound`, {
      MessageSid: `SM${randomUUID().replace(/-/g, '')}`,
      From: from,
      To: '+61400000100',
      Body: 'STOP',
    });
    const { rows } = await admin.query('select distinct ticket_id, brand_id from clinical.messages where tenant_id = $1 and from_address = $2', [t.tenantId, from]);
    expect(rows).toEqual([{ ticket_id: expect.any(String), brand_id: t.brandId }]);
    const count = await admin.query('select count(*)::int as n from clinical.messages where ticket_id = $1', [rows[0].ticket_id]);
    expect(count.rows[0].n).toBe(2);
  });
});

describe('an emergency (SUP3, SUP4)', async () => {
  const t = await setUp();

  it('goes to the clinical queue as urgent, with the safety reply sent once an hour at most', async () => {
    const message = email(t.brandId, 'help@example.test', 'I am thinking about suicide');
    const first = await receive(t.tenantId, message);
    expect(first.ticket).toMatchObject({ queue: 'clinical', priority: 'urgent' });
    await receive(t.tenantId, { ...message, answers: [first.message.id], providerMessageId: `<${randomUUID()}@mail.example>`, body: 'still here, I want to die' });
    const safety = await admin.query("select to_address, automated, status from clinical.messages where ticket_id = $1 and template_key = 'support.safety_reply'", [
      first.ticket.id,
    ]);
    expect(safety.rows).toEqual([{ to_address: 'help@example.test', automated: true, status: 'queued' }]);
    const flags = await admin.query('select flag, set_by_type from operational.ticket_flags where ticket_id = $1', [first.ticket.id]);
    expect(flags.rows).toEqual([{ flag: 'self_harm', set_by_type: 'system' }]);
  });

  it('never lowers a ticket already in the clinical queue', async () => {
    const urgent = await receive(t.tenantId, email(t.brandId, 'raise@example.test', 'chest pain'));
    const calm = await receive(t.tenantId, email(t.brandId, 'raise@example.test', 'thanks, all fine now', { answers: [urgent.message.id] }));
    expect(calm.ticket).toMatchObject({ queue: 'clinical', priority: 'urgent' });
  });
});

describe('what each role sees (SUP2, SUP11)', async () => {
  const t = await setUp();
  const patientId = await createPatient(t.tenantId, { email: 'seen@example.test' });
  const clinical = await receive(t.tenantId, email(t.brandId, 'seen@example.test', 'I have a rash since my injection'));
  const plain = await receive(t.tenantId, email(t.brandId, 'other@example.test', 'Can I update my card?'));

  it('shows support that a clinical ticket exists, never its text', async () => {
    const list = await app.inject({ method: 'GET', url: '/v1/tickets?status=active', headers: await t.as(t.support) });
    const rows = list.json().tickets as { ticketId: string; preview: unknown; textHidden: boolean }[];
    expect(rows.find((row) => row.ticketId === clinical.ticket.id)).toMatchObject({ preview: null, textHidden: true });
    expect(rows.find((row) => row.ticketId === plain.ticket.id)).toMatchObject({ preview: { snippet: 'Can I update my card?' }, textHidden: false });
    const detail = await app.inject({ method: 'GET', url: `/v1/tickets/${clinical.ticket.id}`, headers: await t.as(t.support) });
    expect(detail.json()).toMatchObject({ messages: null, comments: null, reply: { allowed: false, refusal: 'This ticket is in the clinical queue' } });
  });

  it('shows the clinical team the text, and audits the read as clinical', async () => {
    const detail = await app.inject({ method: 'GET', url: `/v1/tickets/${clinical.ticket.id}`, headers: await t.as(t.clinician) });
    expect(detail.json().messages[0].body).toBe('I have a rash since my injection');
    const audit = await admin.query("select zone, details from platform.audit_log where action = 'ticket.viewed' and record_id = $1 and actor_id = $2", [
      clinical.ticket.id,
      t.clinician.id,
    ]);
    expect(audit.rows).toEqual([{ zone: 'clinical', details: { messages: 1, comments: 0 } }]);
  });

  it('shows the owner the support queue but not the clinical text without break-glass', async () => {
    const detail = await app.inject({ method: 'GET', url: `/v1/tickets/${clinical.ticket.id}`, headers: await t.as(t.owner) });
    expect(detail.json().messages).toBeNull();
  });

  it('shows only the name and date of birth until identity is confirmed, then the contact details', async () => {
    const before = await app.inject({ method: 'GET', url: `/v1/tickets/${clinical.ticket.id}`, headers: await t.as(t.clinician) });
    expect(before.json().patientPanel).toEqual({ patientId, displayName: 'Alex Example', dateOfBirth: '1990-04-12', email: null, mobile: null });
    const verified = await app.inject({ method: 'POST', url: `/v1/tickets/${clinical.ticket.id}/verify`, headers: await t.as(t.clinician), payload: { method: 'date_of_birth' } });
    expect(verified.json().patientPanel.email).toBe('seen@example.test');
    expect(verified.json().verification).toMatchObject({ method: 'date_of_birth', byUserId: t.clinician.id });
  });
});

describe('replying and moving tickets (SUP2, SUP5, SUP8)', async () => {
  const t = await setUp();

  it('replies to the address the person wrote from, counts the first response and waits for them', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'reply@example.test', 'Do you ship to Hobart?', { subject: 'Shipping' }));
    const reply = await app.inject({ method: 'POST', url: `/v1/tickets/${ticket.id}/replies`, headers: await t.as(t.support), payload: { body: 'Yes, we do.' } });
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ status: 'waiting', firstRespondedAt: expect.any(String) });
    const sent = await admin.query("select to_address, from_address, subject, status from clinical.messages where ticket_id = $1 and direction = 'outbound'", [ticket.id]);
    expect(sent.rows).toEqual([{ to_address: 'reply@example.test', from_address: 'care@kestrel.example', subject: 'Re: Shipping', status: 'queued' }]);
  });

  it('lets support send a ticket to the clinical queue, and only the clinical team send it back', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'move@example.test', 'A question about my plan'));
    const toClinical = await app.inject({ method: 'PATCH', url: `/v1/tickets/${ticket.id}`, headers: await t.as(t.support), payload: { queue: 'clinical' } });
    expect(toClinical.json()).toMatchObject({ queue: 'clinical', textHidden: true });
    const back = await app.inject({ method: 'PATCH', url: `/v1/tickets/${ticket.id}`, headers: await t.as(t.support), payload: { queue: 'support' } });
    expect(back.statusCode).toBe(403);
    const byClinician = await app.inject({ method: 'PATCH', url: `/v1/tickets/${ticket.id}`, headers: await t.as(t.clinician), payload: { queue: 'support' } });
    expect(byClinician.json()).toMatchObject({ queue: 'support' });
    const audit = await admin.query("select details from platform.audit_log where action = 'ticket.queue_changed' and record_id = $1 order by at", [ticket.id]);
    expect(audit.rows.map((row) => row.details)).toEqual([
      { from: 'support', to: 'clinical' },
      { from: 'clinical', to: 'support' },
    ]);
  });

  it('refuses an agent a reply in the clinical queue, in the service, not only on screen (SUP12)', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'agent@example.test', 'my injection site is swollen'));
    const agent = { actor: { type: 'agent' as const, agentId: 'support-agent' }, permissions: new Set(['support:read', 'support:reply'] as const), membershipId: null };
    await expect(withTenant({ tenantId: t.tenantId, actor: agent.actor, requestId: 'test' }, (tx) => replyToTicket(tx, agent, ticket.id, { body: 'Hello' }))).rejects.toMatchObject(
      { code: 'reply_refused' },
    );
  });
});

describe('flags (SUP6)', async () => {
  const t = await setUp();

  it('lets a person dismiss a possible complaint, and keeps clinical flags for the clinical team', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'unhappy@example.test', 'I want to make a complaint'));
    const dismissed = await app.inject({ method: 'DELETE', url: `/v1/tickets/${ticket.id}/flags/possible_complaint`, headers: await t.as(t.support) });
    expect(dismissed.json().flags).toEqual([]);
    const audit = await admin.query("select details from platform.audit_log where action = 'ticket.flag_cleared' and record_id = $1", [ticket.id]);
    expect(audit.rowCount).toBe(1);
    const flagged = await app.inject({ method: 'POST', url: `/v1/tickets/${ticket.id}/flags`, headers: await t.as(t.support), payload: { flag: 'possible_adverse_event' } });
    expect(flagged.json().flags).toEqual(['possible_adverse_event']);
    const bySupport = await app.inject({ method: 'DELETE', url: `/v1/tickets/${ticket.id}/flags/possible_adverse_event`, headers: await t.as(t.support) });
    expect(bySupport.statusCode).toBe(403);
    const byClinician = await app.inject({ method: 'DELETE', url: `/v1/tickets/${ticket.id}/flags/possible_adverse_event`, headers: await t.as(t.clinician) });
    expect(byClinician.json().flags).toEqual([]);
  });

  it('never lets a flag lower a ticket, and refuses one triage alone sets', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'ae@example.test', 'Can I change my delivery day?'));
    const raised = await app.inject({ method: 'POST', url: `/v1/tickets/${ticket.id}/flags`, headers: await t.as(t.support), payload: { flag: 'emergency' } });
    expect(raised.json().flags).toEqual(['emergency']);
    const row = await admin.query('select queue, priority from operational.tickets where id = $1', [ticket.id]);
    expect(row.rows[0]).toEqual({ queue: 'clinical', priority: 'urgent' });
    const clinicalOnly = await app.inject({ method: 'POST', url: `/v1/tickets/${ticket.id}/flags`, headers: await t.as(t.clinician), payload: { flag: 'clinical' } });
    expect(clinicalOnly.statusCode).toBe(400);
  });
});

describe('macros (SUP10)', async () => {
  const t = await setUp();

  it('can be used only once approved, and go back to draft when the wording changes', async () => {
    const adminUser = (
      await admin.query("select u.email from platform.memberships m join platform.users u on u.id = m.user_id where m.tenant_id = $1 and m.role = 'admin'", [t.tenantId])
    ).rows[0];
    const manage = await t.as(adminUser);
    const created = await app.inject({ method: 'POST', url: '/v1/macros', headers: manage, payload: { name: 'Shipping times', body: 'Orders arrive in 2 to 5 business days.' } });
    const macroId = created.json().macroId as string;
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'macro@example.test', 'When will it arrive?'));
    const early = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticket.id}/replies`,
      headers: await t.as(t.support),
      payload: { body: 'Orders arrive in 2 to 5 business days.', macroId },
    });
    expect(early.json().error.code).toBe('macro_not_approved');
    expect((await app.inject({ method: 'GET', url: '/v1/macros', headers: await t.as(t.support) })).json().macros).toEqual([]);
    await app.inject({ method: 'POST', url: `/v1/macros/${macroId}/approve`, headers: manage });
    expect((await app.inject({ method: 'GET', url: '/v1/macros', headers: await t.as(t.support) })).json().macros).toHaveLength(1);
    const edited = await app.inject({ method: 'PATCH', url: `/v1/macros/${macroId}`, headers: manage, payload: { body: 'Orders arrive in 3 to 5 business days.' } });
    expect(edited.json().status).toBe('draft');
    expect((await app.inject({ method: 'POST', url: '/v1/macros', headers: await t.as(t.support), payload: { name: 'Mine', body: 'x' } })).statusCode).toBe(403);
  });
});

describe('the first-response clock (SUP5)', async () => {
  const t = await setUp();

  it('writes ticket.overdue once, with ids only', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'late@example.test', 'Hello?'));
    await admin.query("update operational.tickets set first_response_due_at = now() - interval '1 minute' where id = $1", [ticket.id]);
    await withTenant(system(t.tenantId), markOverdue);
    await withTenant(system(t.tenantId), markOverdue);
    const events = await admin.query("select payload from platform.outbox where type = 'ticket.overdue' and record_id = $1", [ticket.id]);
    expect(events.rows).toHaveLength(1);
    expect(Object.keys(events.rows[0].payload).sort()).toEqual(['dueAt', 'patientId', 'priority', 'queue']);
  });
});

describe("the patient app's Messages (SUP13)", async () => {
  const t = await setUp();

  async function patient() {
    const subject = `user_${randomUUID()}`;
    const token = await patientSignIn(subject, { email: `${subject}@example.test` });
    const account = await app.inject({
      method: 'POST',
      url: '/v1/patient/account',
      headers: headers(token, t.tenantId),
      payload: { givenName: 'Sam', familyName: 'Sample', dateOfBirth: '1988-09-30', sex: 'not_stated' },
    });
    expect(account.statusCode).toBe(201);
    return headers(token, t.tenantId);
  }

  it('keeps a care-team ticket in the clinical queue, shows the patient only their side, and hides it from everyone else', async () => {
    const mine = await patient();
    const opened = await app.inject({ method: 'POST', url: '/v1/patient/tickets', headers: mine, payload: { topic: 'care_team', body: 'Is it fine to take this with food?' } });
    expect(opened.statusCode).toBe(201);
    const { ticketId } = opened.json();
    const row = await admin.query('select queue, patient_verified_method from operational.tickets where id = $1', [ticketId]);
    expect(row.rows[0]).toEqual({ queue: 'clinical', patient_verified_method: 'patient_app' });
    await app.inject({ method: 'POST', url: `/v1/tickets/${ticketId}/comments`, headers: await t.as(t.clinician), payload: { body: 'Staff only' } });
    await app.inject({ method: 'POST', url: `/v1/tickets/${ticketId}/replies`, headers: await t.as(t.clinician), payload: { body: 'Yes, with food is fine.' } });
    const seen = await app.inject({ method: 'GET', url: `/v1/patient/tickets/${ticketId}`, headers: mine });
    expect(seen.json()).toMatchObject({ topic: 'care_team', status: 'answered' });
    expect(seen.json().messages.map((message: { from: string; body: string }) => [message.from, message.body])).toEqual([
      ['you', 'Is it fine to take this with food?'],
      ['team', 'Yes, with food is fine.'],
    ]);
    const moved = await app.inject({ method: 'PATCH', url: `/v1/tickets/${ticketId}`, headers: await t.as(t.clinician), payload: { queue: 'support' } });
    expect(moved.json().error.code).toBe('care_team_stays_clinical');
    const someoneElse = await patient();
    expect((await app.inject({ method: 'GET', url: `/v1/patient/tickets/${ticketId}`, headers: someoneElse })).statusCode).toBe(404);
    expect((await app.inject({ method: 'POST', url: `/v1/patient/tickets/${ticketId}/messages`, headers: someoneElse, payload: { body: 'Hi' } })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/patient/tickets', headers: someoneElse })).json().tickets).toEqual([]);
  });
});

describe('logging a call (SUP7)', async () => {
  const t = await setUp();

  it('triages a written-up call like any message, and refuses an agent', async () => {
    const { ticket } = await receive(t.tenantId, email(t.brandId, 'caller@example.test', 'Please call me about my order'));
    const logged = await app.inject({
      method: 'POST',
      url: `/v1/tickets/${ticket.id}/calls`,
      headers: await t.as(t.support),
      payload: { direction: 'inbound', summary: 'Said they collapsed this morning, now feeling better' },
    });
    expect(logged.statusCode).toBe(201);
    const row = await admin.query('select queue, priority from operational.tickets where id = $1', [ticket.id]);
    expect(row.rows[0]).toEqual({ queue: 'clinical', priority: 'urgent' });
    const agent = { actor: { type: 'agent' as const, agentId: 'support-agent' }, permissions: new Set(['support:read', 'support:reply'] as const), membershipId: null };
    await expect(
      withTenant({ tenantId: t.tenantId, actor: agent.actor, requestId: 'test' }, (tx) => logCall(tx, agent, ticket.id, { direction: 'outbound', summary: 'x' })),
    ).rejects.toMatchObject({ code: 'person_only' });
  });
});

describe('tenancy of tickets (ADR 0006)', async () => {
  const a = await setUp();
  const b = await setUp();

  it("never shows another tenant's ticket, or lets one be changed", async () => {
    const { ticket } = await receive(b.tenantId, email(b.brandId, 'b@example.test', 'Hello'));
    const reply = await app.inject({ method: 'GET', url: `/v1/tickets/${ticket.id}`, headers: await a.as(a.clinician) });
    expect(reply.statusCode).toBe(404);
    const changed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`update operational.tickets set status = 'solved', solved_at = now() where id = '${ticket.id}'`));
    expect(changed.rowCount).toBe(0);
  });

  it("never shows, changes or deletes another tenant's tickets, flags, comments, macros or sender addresses", async () => {
    const { ticket } = await receive(b.tenantId, email(b.brandId, 'b2@example.test', 'I want to make a complaint'));
    await app.inject({ method: 'POST', url: `/v1/tickets/${ticket.id}/comments`, headers: await b.as(b.support), payload: { body: 'Called back, no answer' } });
    await admin.query(
      `insert into operational.macros (tenant_id, name, body, status, created_by_user_id, updated_by_user_id) values ($1, 'Hours', 'We answer within a day.', 'draft', $2, $2)`,
      [b.tenantId, b.owner.id],
    );
    for (const table of ['operational.tickets', 'operational.ticket_flags', 'clinical.ticket_comments', 'operational.macros', 'operational.senders']) {
      const owned = await admin.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [b.tenantId]);
      expect(owned.rows[0].n, table).toBeGreaterThan(0);
      const seen = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`select 1 from ${table} where tenant_id = '${b.tenantId}'`));
      expect(seen.rows, table).toEqual([]);
      const column = table === 'operational.ticket_flags' ? 'cleared_at = now()' : table === 'clinical.ticket_comments' ? 'body = body' : 'updated_at = now()';
      const changed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`update ${table} set ${column} where tenant_id = '${b.tenantId}'`)).catch(() => ({ rowCount: 0 }));
      expect(changed.rowCount, table).toBe(0);
      const removed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`delete from ${table} where tenant_id = '${b.tenantId}'`)).catch(() => ({ rowCount: 0 }));
      expect(removed.rowCount, table).toBe(0);
    }
  });
});
