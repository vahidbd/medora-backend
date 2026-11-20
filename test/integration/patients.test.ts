import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { patientContacts, patients } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { findPatients, findPatientsByContact, getPatientForPrescribing } from '../../src/modules/patients/index.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { admin, createTenant, tenantWith } from '../support/db.js';

/**
 * Patients and patient sign-in (ADR 0035, docs/decisions/patients.md).
 * Made-up people only.
 */
// Built before the describe blocks run, because they create made-up patients while collecting.
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const adult = { givenName: 'Alex', familyName: 'Example', dateOfBirth: '1990-04-12', sex: 'not_stated' } as const;

async function signUp(tenantId: string, subject = `user_${randomUUID()}`, email = `${subject}@example.test`) {
  const token = await patientSignIn(subject, { email });
  const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: adult });
  return { token, subject, reply, patientId: reply.json().patientId as string };
}

describe('patient sign-in is its own door (ADR 0035)', async () => {
  const tenantId = await createTenant();

  it('refuses a patient token on staff routes, and a staff token on patient routes', async () => {
    const patientToken = await patientSignIn('user_door', { email: 'door@example.test' });
    expect((await app.inject({ method: 'GET', url: '/v1/me', headers: headers(patientToken) })).statusCode).toBe(401);
    const staffToken = await signIn('staff-door@example.test');
    expect((await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(staffToken, tenantId) })).statusCode).toBe(401);
  });

  it('needs a tenant that exists', async () => {
    const token = await patientSignIn('user_nowhere');
    expect((await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(token) })).json().error.code).toBe('tenant_required');
    expect((await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(token, randomUUID()) })).json().error.code).toBe('tenant_unavailable');
  });

  it('asks for an account before anything else', async () => {
    const token = await patientSignIn('user_new');
    const reply = await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(token, tenantId) });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('no_patient_record');
  });
});

describe('creating an account (IDN-01, IDN-03, IDN-07)', async () => {
  const tenantId = await createTenant();

  it('refuses anyone under 18, and dates that are not real', async () => {
    const token = await patientSignIn('user_young');
    const young = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, dateOfBirth: '2015-01-01' } });
    expect(young.statusCode).toBe(400);
    expect(young.json().error.code).toBe('under_age');
    const unreal = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, dateOfBirth: '1990-02-31' } });
    expect(unreal.json().error.code).toBe('date_of_birth');
    expect((await admin.query('select 1 from clinical.patients where clerk_user_id = $1', ['user_young'])).rowCount).toBe(0);
  });

  it('creates the record with the verified email, audits it as the patient and confirms this session', async () => {
    const { reply, patientId, token } = await signUp(tenantId, 'user_alex', 'alex@example.test');
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({ displayName: 'Alex Example', email: 'alex@example.test', identityStatus: 'unverified', consentsNeeded: ['privacy', 'telehealth_terms'], programs: [] });
    const audit = await admin.query("select actor_type, actor_id, zone from platform.audit_log where action = 'patient.created' and record_id = $1", [patientId]);
    expect(audit.rows).toEqual([{ actor_type: 'patient', actor_id: patientId, zone: 'clinical' }]);
    const events = await admin.query("select payload from platform.outbox where type = 'patient.created' and record_id = $1", [patientId]);
    expect(events.rows).toEqual([{ payload: {} }]);
    const contact = await admin.query('select verified_at from clinical.patient_contacts where patient_id = $1 and kind = $2', [patientId, 'email']);
    expect(contact.rows[0].verified_at).not.toBeNull();
    expect((await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(token, tenantId) })).statusCode).toBe(200);
  });

  it('refuses a second account for the same sign-in', async () => {
    const { token } = await signUp(tenantId, 'user_twice');
    const again = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: adult });
    expect(again.json().error.code).toBe('already_registered');
  });

  it('needs an email or a mobile', async () => {
    const token = await patientSignIn('user_unreachable');
    const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: adult });
    expect(reply.json().error.code).toBe('contact_needed');
  });

  it('gives the same sign-in a separate record in another tenant (IDN1)', async () => {
    const other = await createTenant();
    const first = await signUp(tenantId, 'user_two_clinics');
    const second = await signUp(other, 'user_two_clinics');
    expect(second.reply.statusCode).toBe(201);
    expect(second.patientId).not.toBe(first.patientId);
  });
});

describe('date of birth on a new sign-in (IDN-07, IDN3)', async () => {
  const tenantId = await createTenant();
  const { patientId } = await signUp(tenantId, 'user_returning');
  const newSession = await patientSignIn('user_returning', { sessionId: 'sess_second_device' });

  it('holds everything until the date of birth is confirmed', async () => {
    const reply = await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(newSession, tenantId) });
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error.code).toBe('date_of_birth_needed');
  });

  it('refuses a wrong date and audits the attempt, then accepts the right one', async () => {
    const wrong = await app.inject({ method: 'POST', url: '/v1/patient/confirm-date-of-birth', headers: headers(newSession, tenantId), payload: { dateOfBirth: '1991-04-12' } });
    expect(wrong.json().error.code).toBe('date_of_birth_mismatch');
    const refused = await admin.query("select 1 from platform.audit_log where action = 'patient.date_of_birth_refused' and record_id = $1", [patientId]);
    expect(refused.rowCount).toBe(1);
    const right = await app.inject({ method: 'POST', url: '/v1/patient/confirm-date-of-birth', headers: headers(newSession, tenantId), payload: { dateOfBirth: adult.dateOfBirth } });
    expect(right.json()).toEqual({ confirmed: true });
    expect((await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(newSession, tenantId) })).statusCode).toBe(200);
  });

  it('stops guessing after five wrong dates', async () => {
    await signUp(tenantId, 'user_guessed');
    const guesser = await patientSignIn('user_guessed', { sessionId: 'sess_guesser' });
    const statuses = [];
    for (let i = 0; i < 6; i += 1) {
      const reply = await app.inject({ method: 'POST', url: '/v1/patient/confirm-date-of-birth', headers: headers(guesser, tenantId), payload: { dateOfBirth: `1980-01-0${i + 1}` } });
      statuses.push(reply.statusCode);
    }
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429]);
  });
});

describe('a patient changing their own details (IDN5 to IDN7)', async () => {
  const tenantId = await createTenant();
  const { token, patientId } = await signUp(tenantId, 'user_details');
  const patch = (payload: object) => app.inject({ method: 'PATCH', url: '/v1/patient/me', headers: headers(token, tenantId), payload });

  it('checks a Medicare number, seals it, and shows it masked', async () => {
    expect((await patch({ medicare: { number: '2123456711', irn: '1', validTo: '2030-01' } })).json().error.code).toBe('medicare');
    const reply = await patch({ medicare: { number: '2123456701', irn: '1', validTo: '2030-01' } });
    expect(reply.json().medicare).toEqual({ masked: '•••• ••670 1', irn: '1', validTo: '2030-01' });
    const stored = await admin.query('select medicare from clinical.patients where id = $1', [patientId]);
    expect(stored.rows[0].medicare).not.toContain('2123456701');
  });

  it('stores the mobile as E.164 and the home address', async () => {
    const reply = await patch({ mobile: '0412 345 678', address: { line1: '1 Example St', suburb: 'Exampleton', state: 'NSW', postcode: '2000' } });
    expect(reply.json()).toMatchObject({ mobile: '+61412345678', address: { line1: '1 Example St', line2: null, state: 'NSW' } });
    const audit = await admin.query("select details from platform.audit_log where action = 'patient.updated' and record_id = $1 order by id desc limit 1", [patientId]);
    expect(audit.rows[0].details).toEqual({ fields: 'mobile,address' });
  });

  it('locks legal details once identity is verified', async () => {
    expect((await patch({ familyName: 'Sample' })).statusCode).toBe(200);
    await admin.query("update clinical.patients set identity_status = 'verified' where id = $1", [patientId]);
    const locked = await patch({ dateOfBirth: '1990-04-13' });
    expect(locked.json().error.code).toBe('identity_locked');
    expect((await patch({ preferredName: 'Lex' })).json().displayName).toBe('Lex Sample');
  });
});

describe('staff reading patients (IDN9)', async () => {
  const { tenantId, members } = await tenantWith('support', 'finance');
  const [support, finance] = members;
  const { patientId } = await signUp(tenantId, 'user_listed', 'listed@example.test');

  it('lists and finds patients with patients:read, and audits each one shown', async () => {
    const token = await signIn(support!.email);
    const list = await app.inject({ method: 'GET', url: '/v1/patients?search=exam', headers: headers(token, tenantId) });
    expect(list.json().patients.map((p: { patientId: string }) => p.patientId)).toEqual([patientId]);
    const byEmail = await app.inject({ method: 'GET', url: '/v1/patients?search=Listed@Example.test', headers: headers(token, tenantId) });
    expect(byEmail.json().patients).toHaveLength(1);
    const one = await app.inject({ method: 'GET', url: `/v1/patients/${patientId}`, headers: headers(token, tenantId) });
    expect(one.json()).toMatchObject({ patientId, email: 'listed@example.test' });
    const audit = await admin.query("select action from platform.audit_log where record_id = $1 and actor_type = 'person' order by id", [patientId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['patient.listed', 'patient.listed', 'patient.read']);
  });

  it('refuses a role without patients:read, and another tenant’s patient', async () => {
    const financeToken = await signIn(finance!.email);
    expect((await app.inject({ method: 'GET', url: '/v1/patients', headers: headers(financeToken, tenantId) })).statusCode).toBe(403);
    const elsewhere = await tenantWith('support');
    const otherToken = await signIn(elsewhere.members[0]!.email);
    expect((await app.inject({ method: 'GET', url: `/v1/patients/${patientId}`, headers: headers(otherToken, elsewhere.tenantId) })).statusCode).toBe(404);
  });
});

describe('the front door other modules use', async () => {
  const tenantId = await createTenant();
  const { patientId, token } = await signUp(tenantId, 'user_front_door', 'front@example.test');
  await app.inject({ method: 'PATCH', url: '/v1/patient/me', headers: headers(token, tenantId), payload: { medicare: { number: '2123456701', irn: '2', validTo: null } } });
  const system: TenantContext = { tenantId, actor: { type: 'system' }, requestId: 'test' };

  it('reads summaries, finds by contact, and decrypts for prescribing, auditing each read', async () => {
    const found = await withTenant(system, (tx) => findPatients(tx, [patientId, randomUUID()]));
    expect([...found.keys()]).toEqual([patientId]);
    expect(await withTenant(system, (tx) => findPatientsByContact(tx, { email: 'FRONT@example.test' }))).toEqual([patientId]);
    const prescribing = await withTenant(system, (tx) => getPatientForPrescribing(tx, patientId));
    expect(prescribing?.medicare).toEqual({ number: '2123456701', irn: '2', validTo: null });
    const audit = await admin.query("select action from platform.audit_log where tenant_id = $1 and actor_type = 'system' order by id", [tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['patient.read', 'patient.searched', 'patient.read_for_prescribing']);
  });
});

describe('patients are isolated by tenant (ADR 0006)', async () => {
  const a = await createTenant();
  const b = await createTenant();
  const inB = await signUp(b, 'user_in_b');
  const asA: TenantContext = { tenantId: a, actor: { type: 'system' }, requestId: 'test' };

  it("can't read, change or point at another tenant's patients", async () => {
    const seen = await withTenant(asA, async (tx) => ({
      patients: await tx.db.select({ id: patients.id }).from(patients),
      contacts: await tx.db.select({ id: patientContacts.id }).from(patientContacts),
    }));
    expect(seen).toEqual({ patients: [], contacts: [] });
    const changed = await withTenant(asA, (tx) => tx.db.execute(sql`update clinical.patients set family_name = 'Changed' where id = ${inB.patientId}`));
    expect(changed.rowCount).toBe(0);
    await expect(
      withTenant(asA, (tx) => tx.db.insert(patientContacts).values({ tenantId: a, patientId: inB.patientId, kind: 'email', value: 'x@example.test' })),
    ).rejects.toThrow();
  });

  it('gives the API no way to delete a patient', async () => {
    await expect(withTenant({ ...asA, tenantId: b }, (tx) => tx.db.execute(sql`delete from clinical.patients where id = ${inB.patientId}`))).rejects.toThrow();
  });
});
