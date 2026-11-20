import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { fakeEmail, queueMessage } from '../../src/modules/messaging/index.js';
import { markOverdue, receiveMessage, type InboundMessage } from '../../src/modules/support/index.js';
import { testApp } from '../support/app.js';
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
  const { tenantId, members } = await tenantWith('owner');
  const owner = members[0]!;
  const { brandId } = await createBrand(tenantId, { status: 'live' });
  await admin.query(
    `insert into operational.senders (tenant_id, brand_id, channel, purpose, address, updated_by_user_id)
     values ($1, $2, 'email', 'service', 'care@kestrel.example', $3), ($1, $2, 'sms', 'service', '+61400000100', $3)`,
    [tenantId, brandId, owner.id],
  );
  return { tenantId, brandId, owner };
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

describe('tenancy of tickets (ADR 0006)', async () => {
  const a = await setUp();
  const b = await setUp();

  it("never shows, changes or deletes another tenant's tickets, flags or sender addresses", async () => {
    await receive(b.tenantId, email(b.brandId, 'b@example.test', 'I want to make a complaint'));
    for (const table of ['operational.tickets', 'operational.ticket_flags', 'operational.senders']) {
      const owned = await admin.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [b.tenantId]);
      expect(owned.rows[0].n, table).toBeGreaterThan(0);
      const seen = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`select 1 from ${table} where tenant_id = '${b.tenantId}'`));
      expect(seen.rows, table).toEqual([]);
      const column = table === 'operational.ticket_flags' ? 'cleared_at = now()' : 'updated_at = now()';
      const changed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`update ${table} set ${column} where tenant_id = '${b.tenantId}'`)).catch(() => ({ rowCount: 0 }));
      expect(changed.rowCount, table).toBe(0);
      const removed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`delete from ${table} where tenant_id = '${b.tenantId}'`)).catch(() => ({ rowCount: 0 }));
      expect(removed.rowCount, table).toBe(0);
    }
  });
});
