import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { deliverMessage, fakeEmail, queueMessage, sweepUnconfirmed } from '../../src/modules/messaging/index.js';
import { fakeTelephony } from '../../src/modules/telephony/index.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createBrand, tenantWith } from '../support/db.js';
import { postTwilioWebhook } from '../support/twilio.js';

/**
 * The email and SMS rails (docs/decisions/messaging.md): queued in the
 * change's own transaction, sent after commit at most once, and moved on by
 * the provider's status webhooks. Made-up people and addresses only.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});
beforeEach(() => fakeEmail.reset());

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });

async function queue(tenantId: string, input: Partial<Parameters<typeof queueMessage>[1]> = {}) {
  return withTenant(system(tenantId), (tx) =>
    queueMessage(tx, { channel: 'email', kind: 'transactional', from: 'care@kestrel.example', to: 'alex@example.test', subject: 'Your order', body: 'It has shipped.', ...input }),
  );
}

async function statusOf(messageId: string): Promise<{ status: string; failure_code: string | null; provider_message_id: string | null }> {
  const { rows } = await admin.query('select status, failure_code, provider_message_id from clinical.messages where id = $1', [messageId]);
  return rows[0];
}

const eventOf = (messageId: string) => ({ tenantId: '', recordId: messageId, id: Math.floor(Math.random() * 1e9) });

describe('delivery (CRM2)', async () => {
  const { tenantId } = await tenantWith('owner');

  it('sends a queued email once, with our Message-ID, however often delivery runs', async () => {
    const { message } = await queue(tenantId);
    const event = { ...eventOf(message.id), tenantId };
    expect(await deliverMessage(event)).toBe('sent');
    expect(await deliverMessage(event)).toBe('skipped');
    expect(fakeEmail.sent).toHaveLength(1);
    expect(fakeEmail.sent[0]!.headers['Message-ID']).toBe(`<${message.id}@kestrel.example>`);
    expect((await statusOf(message.id)).status).toBe('sent');
  });

  it('labels an automatic email so an auto-responder does not answer it', async () => {
    const { message } = await queue(tenantId, { automated: true });
    await deliverMessage({ ...eventOf(message.id), tenantId });
    expect(fakeEmail.sent[0]!.headers['Auto-Submitted']).toBe('auto-replied');
  });

  it("records a provider's refusal by its code only, with a message.failed event", async () => {
    fakeEmail.failNext = 'mailbox_full';
    const { message } = await queue(tenantId);
    expect(await deliverMessage({ ...eventOf(message.id), tenantId })).toBe('failed');
    expect(await statusOf(message.id)).toMatchObject({ status: 'failed', failure_code: 'mailbox_full' });
    const events = await admin.query("select payload from platform.outbox where type = 'message.failed' and record_id = $1", [message.id]);
    expect(events.rows[0].payload).toEqual({ channel: 'email', ticketId: null, failureCode: 'mailbox_full', patientId: null });
  });

  it('returns the first message for a repeated idempotency key', async () => {
    const key = `order-shipped-${randomUUID()}`;
    const first = await queue(tenantId, { idempotencyKey: key });
    const second = await queue(tenantId, { idempotencyKey: key });
    expect(second).toMatchObject({ created: false, message: { id: first.message.id } });
  });

  it('marks a send left in sending as unconfirmed, for a person to check', async () => {
    const { message } = await queue(tenantId);
    await admin.query("update clinical.messages set status = 'sending', sending_at = now() - interval '20 minutes' where id = $1", [message.id]);
    expect(await withTenant(system(tenantId), sweepUnconfirmed)).toBeGreaterThanOrEqual(1);
    expect(await statusOf(message.id)).toMatchObject({ status: 'failed', failure_code: 'unconfirmed' });
  });

  it('measures a stuck send from when delivery claimed it, not from when it was queued', async () => {
    const { message } = await queue(tenantId);
    await admin.query("update clinical.messages set status = 'sending', sending_at = now(), created_at = now() - interval '2 hours' where id = $1", [message.id]);
    await withTenant(system(tenantId), sweepUnconfirmed);
    expect((await statusOf(message.id)).status).toBe('sending');
  });
});

describe("Twilio's status webhooks (CRM2, WHK)", async () => {
  const { tenantId } = await tenantWith('owner');

  async function sentSms(): Promise<{ messageId: string; sid: string }> {
    const { message } = await queue(tenantId, { channel: 'sms', from: '+61400000001', to: '+61400000002', subject: null });
    await deliverMessage({ ...eventOf(message.id), tenantId });
    const { provider_message_id } = await statusOf(message.id);
    return { messageId: message.id, sid: provider_message_id! };
  }

  it('moves a message on, and never back when status webhooks arrive out of order', async () => {
    const { messageId, sid } = await sentSms();
    expect(fakeTelephony.sent.some((sms) => sms.body === 'It has shipped.')).toBe(true);
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-status`, { MessageSid: sid, MessageStatus: 'delivered' });
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-status`, { MessageSid: sid, MessageStatus: 'sent' });
    expect((await statusOf(messageId)).status).toBe('delivered');
  });

  it("records an undelivered SMS with Twilio's error code", async () => {
    const { messageId, sid } = await sentSms();
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-status`, { MessageSid: sid, MessageStatus: 'undelivered', ErrorCode: '30005' });
    expect(await statusOf(messageId)).toMatchObject({ status: 'failed', failure_code: 'twilio_30005' });
  });

  it('leaves a status webhook for a send it has no record of yet in the inbox to try again', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '')}`;
    await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-status`, { MessageSid: sid, MessageStatus: 'delivered' });
    const { rows } = await admin.query("select status, last_error from platform.webhook_inbox where tenant_id = $1 and kind = 'sms.status' and body->>'MessageSid' = $2", [
      tenantId,
      sid,
    ]);
    expect(rows).toEqual([{ status: 'failed', last_error: 'unknown_provider_message' }]);
  });
});

describe("a brand's addresses (CRM5)", async () => {
  const { tenantId, members } = await tenantWith('admin', 'support');
  const [adminUser, supportUser] = members;
  const { brandId } = await createBrand(tenantId);

  it('lets setup set a number, normalised, and refuses the support role', async () => {
    const token = await signIn(adminUser!.email);
    const set = await app.inject({
      method: 'PUT',
      url: '/v1/senders',
      headers: headers(token, tenantId),
      payload: { brandId, channel: 'sms', purpose: 'service', address: '0400 000 003' },
    });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ address: '+61400000003', channel: 'sms', purpose: 'service' });
    const refused = await app.inject({ method: 'GET', url: '/v1/senders', headers: headers(await signIn(supportUser!.email), tenantId) });
    expect(refused.statusCode).toBe(403);
  });

  it("can't use a brand from another tenant", async () => {
    const other = await tenantWith('owner');
    const { brandId: otherBrand } = await createBrand(other.tenantId);
    const token = await signIn(adminUser!.email);
    const reply = await app.inject({
      method: 'PUT',
      url: '/v1/senders',
      headers: headers(token, tenantId),
      payload: { brandId: otherBrand, channel: 'email', purpose: 'service', address: 'hello@larkspur.example' },
    });
    expect(reply.statusCode).toBe(404);
  });
});

describe('tenancy of messages (ADR 0006)', async () => {
  const a = await tenantWith('owner');
  const b = await tenantWith('owner');

  it("never shows, changes or deletes another tenant's messages", async () => {
    const { message } = await queue(b.tenantId);
    const seen = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`select id from clinical.messages where id = '${message.id}'`));
    expect(seen.rows).toEqual([]);
    const changed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`update clinical.messages set status = 'failed' where id = '${message.id}'`));
    expect(changed.rowCount).toBe(0);
  });

  it("never shows, changes or deletes another tenant's sender addresses", async () => {
    const { brandId } = await createBrand(b.tenantId);
    await admin.query(
      `insert into operational.senders (tenant_id, brand_id, channel, purpose, address, updated_by_user_id) values ($1, $2, 'email', 'service', 'care@larkspur.example', $3)`,
      [b.tenantId, brandId, b.members[0]!.id],
    );
    const seen = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`select 1 from operational.senders where tenant_id = '${b.tenantId}'`));
    expect(seen.rows).toEqual([]);
    const changed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`update operational.senders set updated_at = now() where tenant_id = '${b.tenantId}'`));
    expect(changed.rowCount).toBe(0);
    const removed = await withTenant(system(a.tenantId), (tx) => tx.db.execute(`delete from operational.senders where tenant_id = '${b.tenantId}'`));
    expect(removed.rowCount).toBe(0);
    const kept = await admin.query('select count(*)::int as n from operational.senders where tenant_id = $1', [b.tenantId]);
    expect(kept.rows[0].n).toBe(1);
  });

  it('refuses to change the text of a message once written (CRM4, ADR 0028)', async () => {
    const { message } = await queue(a.tenantId);
    await expect(withTenant(system(a.tenantId), (tx) => tx.db.execute(`update clinical.messages set body = 'changed' where id = '${message.id}'`))).rejects.toThrow();
    await expect(withTenant(system(a.tenantId), (tx) => tx.db.execute(`delete from clinical.messages where id = '${message.id}'`))).rejects.toThrow();
  });
});
