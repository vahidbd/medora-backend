import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { notificationPreferences } from '../../src/db/schema/index.js';
import { withTenant } from '../../src/db/tenant.js';
import { headers, patientSignIn, testApp } from '../support/app.js';
import { acceptingBrand, admin, createTenant } from '../support/db.js';

/** How a patient wants to hear from their care (docs/decisions/notifications.md). Made-up people only. */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const adult = { givenName: 'Sam', familyName: 'Example', dateOfBirth: '1985-07-01', sex: 'not_stated' } as const;

async function patientIn(tenantId: string) {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const created = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, brandId: await acceptingBrand(tenantId) } });
  expect(created.statusCode).toBe(201);
  const as = headers(token, tenantId);
  return {
    patientId: created.json().patientId as string,
    get: () => app.inject({ method: 'GET', url: '/v1/patient/notification-preferences', headers: as }),
    put: (payload: object) => app.inject({ method: 'PUT', url: '/v1/patient/notification-preferences', headers: as, payload }),
  };
}

describe('notification preferences (NTF1, NTF2)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);
  const alex = await patientIn(tenantId);

  it('starts with texts and reminders on, and keeps what the patient changes', async () => {
    expect((await sam.get()).json()).toEqual({ sms: true, reminders: true });
    const changed = await sam.put({ sms: false, reminders: true });
    expect(changed.statusCode).toBe(200);
    expect(changed.json()).toEqual({ sms: false, reminders: true });
    expect((await sam.put({ sms: false, reminders: false })).json()).toEqual({ sms: false, reminders: false });
    expect((await sam.get()).json()).toEqual({ sms: false, reminders: false });
    // Another patient's are their own.
    expect((await alex.get()).json()).toEqual({ sms: true, reminders: true });
  });

  it('audits each change as the patient, with the choices and nothing else', async () => {
    const { rows } = await admin.query("select actor_type, actor_id, details from platform.audit_log where action = 'notification_preferences.changed' and record_id = $1 order by at", [sam.patientId]);
    expect(rows).toEqual([
      { actor_type: 'patient', actor_id: sam.patientId, details: { patientId: sam.patientId, sms: false, reminders: true } },
      { actor_type: 'patient', actor_id: sam.patientId, details: { patientId: sam.patientId, sms: false, reminders: false } },
    ]);
  });

  it('refuses anything but the two choices, and email can never be turned off', async () => {
    for (const payload of [{ sms: false }, { sms: true, reminders: true, email: false }, { sms: 'no', reminders: true }]) {
      expect((await sam.put(payload)).statusCode).toBe(400);
    }
  });

  it("another tenant can't read, change or delete the rows (ADR 0006)", async () => {
    const otherTenantId = await createTenant();
    const context = { tenantId: otherTenantId, actor: { type: 'system' } as const, requestId: 'test' };
    expect(await withTenant(context, (tx) => tx.db.select().from(notificationPreferences))).toEqual([]);
    expect(await withTenant(context, (tx) => tx.db.update(notificationPreferences).set({ sms: true }).returning())).toEqual([]);
    const deleted = await withTenant(context, (tx) => tx.db.delete(notificationPreferences).returning()).catch((error: unknown) => error);
    // The API's role may not delete a preference at all, let alone another tenant's.
    expect(deleted).toBeInstanceOf(Error);
    const { rows } = await admin.query('select sms, reminders from operational.notification_preferences where patient_id = $1', [sam.patientId]);
    expect(rows).toEqual([{ sms: false, reminders: false }]);
  });
});
