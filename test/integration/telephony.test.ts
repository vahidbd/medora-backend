import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { fakeTelephony, sendSms } from '../../src/modules/telephony/index.js';
import { testApp } from '../support/app.js';
import { admin, createTenant } from '../support/db.js';
import { postTwilioWebhook } from '../support/twilio.js';

/** Twilio's webhooks land in the inbox; SMS goes through the one client (docs/decisions/telephony.md). */
let app: App;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const inbound = () => ({ MessageSid: `SM${randomUUID().replace(/-/g, '')}`, From: '+61400000001', To: '+61400000002', Body: 'Made-up text' });

async function stored(tenantId: string) {
  const { rows } = await admin.query('select provider, provider_event_id, kind, body from platform.webhook_inbox where tenant_id = $1 order by id', [tenantId]);
  return rows;
}

describe("Twilio's webhooks", async () => {
  const tenantId = await createTenant();

  it('stores a signed inbound SMS once, however often Twilio sends it', async () => {
    const fields = inbound();
    const path = `/v1/webhooks/twilio/${tenantId}/sms-inbound`;
    const first = await postTwilioWebhook(app, path, fields);
    const again = await postTwilioWebhook(app, path, fields);
    expect(first.statusCode).toBe(200);
    expect(first.headers['content-type']).toContain('text/xml');
    expect(first.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response/>');
    expect(again.statusCode).toBe(200);
    const rows = (await stored(tenantId)).filter((r) => r.provider_event_id === fields.MessageSid);
    expect(rows).toEqual([{ provider: 'twilio', provider_event_id: fields.MessageSid, kind: 'sms.inbound', body: fields }]);
  });

  it('stores each delivery status as its own delivery', async () => {
    const sid = `SM${randomUUID().replace(/-/g, '')}`;
    const path = `/v1/webhooks/twilio/${tenantId}/sms-status`;
    await postTwilioWebhook(app, path, { MessageSid: sid, MessageStatus: 'sent' });
    await postTwilioWebhook(app, path, { MessageSid: sid, MessageStatus: 'delivered' });
    const ids = (await stored(tenantId)).map((r) => r.provider_event_id).filter((id: string) => id.startsWith(sid));
    expect(ids).toEqual([`${sid}:sent`, `${sid}:delivered`]);
  });

  it('refuses a wrong signature, and a tenant that does not exist, with the same answer', async () => {
    const forged = await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-inbound`, inbound(), { signature: 'bm90IGEgc2lnbmF0dXJl' });
    const nobody = await postTwilioWebhook(app, `/v1/webhooks/twilio/${randomUUID()}/sms-inbound`, inbound());
    expect(forged.statusCode).toBe(403);
    expect(nobody.statusCode).toBe(403);
    expect(nobody.json()).toEqual(forged.json());
  });

  it('refuses a delivery with no id to store it under', async () => {
    const reply = await postTwilioWebhook(app, `/v1/webhooks/twilio/${tenantId}/sms-inbound`, { Body: 'no sid' });
    expect(reply.statusCode).toBe(403);
  });
});

describe('sendSms', () => {
  it('sends through the client with the status callback for the tenant', async () => {
    fakeTelephony.reset();
    const tenantId = randomUUID();
    const { providerMessageId } = await sendSms({ tenantId, to: '+61400000003', from: '+61400000004', body: 'Made-up reminder' });
    expect(fakeTelephony.sent).toEqual([
      {
        tenantId,
        to: '+61400000003',
        from: '+61400000004',
        body: 'Made-up reminder',
        providerMessageId,
        statusCallbackUrl: `https://api.medora.test/v1/webhooks/twilio/${tenantId}/sms-status`,
      },
    ]);
  });

  it('refuses a number that is not in international form', async () => {
    await expect(sendSms({ tenantId: randomUUID(), to: '0400000003', from: '+61400000004', body: 'x' })).rejects.toThrow('international form');
  });
});
