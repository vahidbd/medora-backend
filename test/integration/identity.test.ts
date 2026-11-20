import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { identityChecks } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { verifyIdentityManually } from '../../src/modules/patients/identity.service.js';
import { assertIdentityVerified, getPatientForPrescribing } from '../../src/modules/patients/index.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { acceptingBrand, admin, createTenant, tenantWith } from '../support/db.js';

/**
 * Identity checks and the IHI (IDN-02, IDN-04, docs/decisions/patients.md
 * IDN16 to IDN19), against the fake gateway and HI Service. Made-up people
 * and document numbers only: a number ending 0000 doesn't match, 9999 finds
 * the gateway down.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const licence = (number: string) => ({ documentType: 'driver_licence', state: 'NSW', licenceNumber: number, cardNumber: 'P1234567' });

async function clinic() {
  const { tenantId, members } = await tenantWith('owner', 'support', 'medical_director', 'clinician');
  const [owner, support, director, clinician] = members;
  const ownerToken = await signIn(owner!.email);
  const document = await app.inject({
    method: 'POST',
    url: '/v1/consent-documents',
    headers: headers(ownerToken, tenantId),
    payload: { kind: 'identity_check', title: 'Checking your ID', body: 'Made-up text about the check.' },
  });
  return { tenantId, ownerToken, support: support!, director: director!, clinician: clinician!, identityDocumentId: document.json().documentId as string };
}

async function signUp(tenantId: string, givenName = 'Jo') {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const reply = await app.inject({
    method: 'POST',
    url: '/v1/patient/account',
    headers: headers(token, tenantId),
    payload: { brandId: await acceptingBrand(tenantId), givenName, familyName: 'Example', dateOfBirth: '1985-06-15', sex: 'female' },
  });
  return { token, patientId: reply.json().patientId as string };
}

const check = (token: string, tenantId: string, payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/v1/patient/identity-check', headers: headers(token, tenantId), payload });
const agree = (token: string, tenantId: string, documentId: string) => app.inject({ method: 'POST', url: '/v1/patient/consents', headers: headers(token, tenantId), payload: { documentId } });

describe('a patient checking their own identity (IDN16)', async () => {
  const setup = await clinic();
  const { tenantId } = setup;

  it('asks for the identity check consent first', async () => {
    const patient = await signUp(tenantId);
    const reply = await check(patient.token, tenantId, licence('12345678'));
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toMatchObject({ code: 'consent_needed', details: { kinds: ['identity_check'] } });
  });

  it('verifies, keeps no document number, looks up the IHI, and locks the legal details', async () => {
    const patient = await signUp(tenantId);
    await agree(patient.token, tenantId, setup.identityDocumentId);
    const reply = await check(patient.token, tenantId, licence('12345678'));
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ identityStatus: 'verified', verification: { method: 'document', documentType: 'driver_licence' }, ihi: { found: true, status: 'active', recordStatus: 'verified' } });
    const stored = await admin.query('select * from clinical.identity_checks where patient_id = $1', [patient.patientId]);
    expect(JSON.stringify(stored.rows)).not.toContain('12345678');
    const sealed = await admin.query('select ihi from clinical.patients where id = $1', [patient.patientId]);
    expect(sealed.rows[0].ihi.startsWith('enc1.')).toBe(true);
    const events = await admin.query("select payload from platform.outbox where type = 'patient.identity_verified' and record_id = $1", [patient.patientId]);
    expect(events.rows).toEqual([{ payload: { method: 'document', documentType: 'driver_licence' } }]);
    const locked = await app.inject({ method: 'PATCH', url: '/v1/patient/me', headers: headers(patient.token, tenantId), payload: { familyName: 'Changed' } });
    expect(locked.json().error.code).toBe('identity_locked');
    expect((await check(patient.token, tenantId, licence('12345678'))).json().error.code).toBe('already_verified');
  });

  it('locks online checks after three that don’t match, and support reopens them', async () => {
    const patient = await signUp(tenantId);
    await agree(patient.token, tenantId, setup.identityDocumentId);
    expect((await check(patient.token, tenantId, licence('99999999'))).json()).toMatchObject({ identityStatus: 'unverified', attemptsLeft: 3 });
    for (const left of [2, 1]) expect((await check(patient.token, tenantId, licence('10000000'))).json()).toMatchObject({ identityStatus: 'unverified', attemptsLeft: left });
    expect((await check(patient.token, tenantId, licence('10000000'))).json()).toMatchObject({ identityStatus: 'failed', attemptsLeft: 0 });
    expect((await check(patient.token, tenantId, licence('12345678'))).json().error.code).toBe('identity_check_locked');
    const events = await admin.query("select payload from platform.outbox where type = 'patient.identity_failed' and record_id = $1", [patient.patientId]);
    expect(events.rows).toEqual([{ payload: { attempts: 3 } }]);

    const supportToken = await signIn(setup.support.email);
    const reopened = await app.inject({ method: 'POST', url: `/v1/patients/${patient.patientId}/identity/reopen`, headers: headers(supportToken, tenantId), payload: { reason: 'Name on licence has a hyphen' } });
    expect(reopened.json()).toMatchObject({ identityStatus: 'unverified', attemptsLeft: 3 });
    expect(reopened.json().checks.map((row: { outcome: string }) => row.outcome)).toEqual(['not_matched', 'not_matched', 'not_matched', 'unavailable']);
    expect((await check(patient.token, tenantId, licence('12345678'))).json().identityStatus).toBe('verified');
  });

  it('never edits or removes a check', async () => {
    await expect(admin.query("update clinical.identity_checks set outcome = 'verified' where tenant_id = $1", [tenantId])).rejects.toThrow(/never changed or removed/);
    await expect(admin.query('delete from clinical.identity_checks where tenant_id = $1', [tenantId])).rejects.toThrow(/never changed or removed/);
  });
});

describe('staff checking identity (IDN17) and correcting legal details', async () => {
  const setup = await clinic();
  const { tenantId } = setup;
  const directorToken = await signIn(setup.director.email);
  const supportToken = await signIn(setup.support.email);
  const manual = (token: string, patientId: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/v1/patients/${patientId}/identity/manual`, headers: headers(token, tenantId), payload });

  it('lets the medical director mark a patient verified with a reason, never support', async () => {
    const patient = await signUp(tenantId);
    expect((await manual(supportToken, patient.patientId, { documentType: 'passport', reason: 'Sighted on video' })).statusCode).toBe(403);
    expect((await manual(directorToken, patient.patientId, { documentType: 'passport' })).statusCode).toBe(400);
    const reply = await manual(directorToken, patient.patientId, { documentType: 'passport', reason: 'Sighted on a video consult' });
    expect(reply.json()).toMatchObject({ identityStatus: 'verified', verification: { method: 'manual', documentType: 'passport' } });
    expect(reply.json().checks[0].checkedBy).toBe(setup.director.id);
    const context: TenantContext = { tenantId, actor: { type: 'system' }, requestId: 'test' };
    const forPrescribing = await withTenant(context, (tx) => getPatientForPrescribing(tx, patient.patientId));
    expect(forPrescribing).toMatchObject({ identityStatus: 'verified', identityVerification: { method: 'manual', documentType: 'passport' }, ihiStatus: 'active' });
    expect(forPrescribing!.ihi).toMatch(/^800360\d{10}$/);
  });

  it('refuses an agent', async () => {
    const patient = await signUp(tenantId);
    const asAgent: TenantContext = { tenantId, actor: { type: 'agent', agentId: 'support' }, requestId: 'test' };
    await expect(verifyIdentityManually(asAgent, patient.patientId, { documentType: 'passport', reason: 'x' })).rejects.toMatchObject({ code: 'person_only' });
  });

  it('lets support correct a legal detail with a reason, which needs a new check and a new IHI', async () => {
    const patient = await signUp(tenantId);
    await manual(directorToken, patient.patientId, { documentType: 'medicare_card', reason: 'Sighted in person' });
    const corrected = await app.inject({
      method: 'POST',
      url: `/v1/patients/${patient.patientId}/legal-details`,
      headers: headers(supportToken, tenantId),
      payload: { familyName: 'Example-Smith', reason: 'Married name on the licence' },
    });
    expect(corrected.json()).toMatchObject({ identityStatus: 'unverified', verification: null, ihi: null });
    const audit = await admin.query("select details from platform.audit_log where action = 'patient.legal_details_corrected' and record_id = $1", [patient.patientId]);
    expect(audit.rows).toEqual([{ details: { fields: 'familyName,identityStatus', reason: 'Married name on the licence' } }]);
    const tooYoung = await app.inject({ method: 'POST', url: `/v1/patients/${patient.patientId}/legal-details`, headers: headers(supportToken, tenantId), payload: { dateOfBirth: '2020-01-01', reason: 'Typo' } });
    expect(tooYoung.json().error.code).toBe('under_age');
  });

  it('keeps going when no IHI is found, and lets staff look again', async () => {
    const patient = await signUp(tenantId, 'Nobody');
    const reply = await manual(directorToken, patient.patientId, { documentType: 'passport', reason: 'Sighted on video' });
    expect(reply.json()).toMatchObject({ identityStatus: 'verified', ihi: { found: false, status: null } });
    const again = await app.inject({ method: 'POST', url: `/v1/patients/${patient.patientId}/ihi-lookup`, headers: headers(supportToken, tenantId) });
    expect(again.statusCode).toBe(200);
    const unverified = await signUp(tenantId);
    const refused = await app.inject({ method: 'POST', url: `/v1/patients/${unverified.patientId}/ihi-lookup`, headers: headers(supportToken, tenantId) });
    expect(refused.json().error.code).toBe('identity_not_verified');
  });

  it('gives other modules a gate, and lets clinicians see the checks', async () => {
    const patient = await signUp(tenantId);
    const context: TenantContext = { tenantId, actor: { type: 'system' }, requestId: 'test' };
    await expect(withTenant(context, (tx) => assertIdentityVerified(tx, patient.patientId))).rejects.toMatchObject({ statusCode: 409, code: 'identity_not_verified' });
    const seen = await app.inject({ method: 'GET', url: `/v1/patients/${patient.patientId}/identity`, headers: headers(await signIn(setup.clinician.email), tenantId) });
    expect(seen.json()).toMatchObject({ identityStatus: 'unverified', attemptsLeft: 3, checks: [] });
  });
});

describe('identity checks are isolated by tenant (ADR 0006)', async () => {
  const a = await clinic();
  const b = await createTenant();
  const inA = await signUp(a.tenantId);
  await app.inject({ method: 'POST', url: `/v1/patients/${inA.patientId}/identity/manual`, headers: headers(await signIn(a.director.email), a.tenantId), payload: { documentType: 'passport', reason: 'Sighted' } });

  it("can't read or add another tenant's checks", async () => {
    const asB: TenantContext = { tenantId: b, actor: { type: 'system' }, requestId: 'test' };
    expect(await withTenant(asB, (tx) => tx.db.select({ id: identityChecks.id }).from(identityChecks))).toEqual([]);
    await expect(
      withTenant(asB, (tx) => tx.db.insert(identityChecks).values({ tenantId: b, patientId: inA.patientId, method: 'document', documentType: 'passport', outcome: 'verified' })),
    ).rejects.toThrow();
  });
});
