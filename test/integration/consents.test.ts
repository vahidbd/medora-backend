import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { consentDocuments, patientConsents } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { assertConsents } from '../../src/modules/patients/index.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { acceptingBrand, admin, createTenant, tenantWith } from '../support/db.js';

/** Consents (IDN-05, docs/decisions/patients.md IDN12 to IDN14). Made-up people and text only. */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const adult = { givenName: 'Sam', familyName: 'Sample', dateOfBirth: '1988-09-30', sex: 'not_stated' } as const;

async function signUp(tenantId: string) {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, brandId: await acceptingBrand(tenantId) } });
  return { token, patientId: reply.json().patientId as string, me: reply.json() };
}

async function publish(token: string, tenantId: string, kind: string, title = `${kind} terms`) {
  const reply = await app.inject({ method: 'POST', url: '/v1/consent-documents', headers: headers(token, tenantId), payload: { kind, title, body: 'Made-up text.\n\nSecond paragraph.' } });
  expect(reply.statusCode).toBe(201);
  return reply.json() as { documentId: string; version: number };
}

const give = (token: string, tenantId: string, documentId: string) =>
  app.inject({ method: 'POST', url: '/v1/patient/consents', headers: headers(token, tenantId), payload: { documentId } });

const stateOf = (reply: { json(): { consents: { kind: string; needed: boolean; decision: string | null; decidedVersion: number | null }[] } }, kind: string) =>
  reply.json().consents.find((state) => state.kind === kind);

describe('publishing consent documents (IDN14)', async () => {
  const { tenantId, members } = await tenantWith('owner', 'support');
  const [owner, support] = members;
  const ownerToken = await signIn(owner!.email);

  it('numbers each kind’s versions, and audits and announces each one', async () => {
    const first = await publish(ownerToken, tenantId, 'privacy');
    const second = await publish(ownerToken, tenantId, 'privacy', 'Privacy, revised');
    const terms = await publish(ownerToken, tenantId, 'telehealth_terms');
    expect([first.version, second.version, terms.version]).toEqual([1, 2, 1]);
    const audit = await admin.query("select actor_type, details from platform.audit_log where action = 'consent_document.published' and record_id = $1", [second.documentId]);
    expect(audit.rows).toEqual([{ actor_type: 'person', details: { kind: 'privacy', version: 2 } }]);
    const events = await admin.query("select payload from platform.outbox where type = 'consent_document.published' and record_id = $1", [second.documentId]);
    expect(events.rows).toEqual([{ payload: { kind: 'privacy', version: 2 } }]);
    const list = await app.inject({ method: 'GET', url: '/v1/consent-documents', headers: headers(ownerToken, tenantId) });
    expect(list.json().documents.filter((d: { kind: string }) => d.kind === 'privacy').map((d: { version: number }) => d.version)).toEqual([2, 1]);
  });

  it('refuses a role without consents:manage', async () => {
    const reply = await app.inject({
      method: 'POST',
      url: '/v1/consent-documents',
      headers: headers(await signIn(support!.email), tenantId),
      payload: { kind: 'privacy', title: 'Not allowed', body: 'Made-up text.' },
    });
    expect(reply.statusCode).toBe(403);
  });

  it('never changes or removes published text, whoever asks', async () => {
    await expect(admin.query("update clinical.consent_documents set body = 'Changed' where tenant_id = $1", [tenantId])).rejects.toThrow(/never changed or removed/);
    await expect(admin.query('delete from clinical.consent_documents where tenant_id = $1', [tenantId])).rejects.toThrow(/never changed or removed/);
  });
});

describe('a patient agreeing (IDN12, IDN13)', async () => {
  const { tenantId, members } = await tenantWith('owner');
  const ownerToken = await signIn(members[0]!.email);
  const privacy = await publish(ownerToken, tenantId, 'privacy');
  const terms = await publish(ownerToken, tenantId, 'telehealth_terms');
  const patient = await signUp(tenantId);

  it('lists what care still needs on the patient’s own record', () => {
    expect(patient.me.consentsNeeded).toEqual(['privacy', 'telehealth_terms']);
  });

  it('records agreement to the current version, once', async () => {
    const reply = await give(patient.token, tenantId, privacy.documentId);
    expect(reply.statusCode).toBe(200);
    expect(stateOf(reply, 'privacy')).toMatchObject({ needed: false, decision: 'given', decidedVersion: 1 });
    await give(patient.token, tenantId, privacy.documentId);
    const rows = await admin.query('select decision, channel, recorded_by from clinical.patient_consents where patient_id = $1', [patient.patientId]);
    expect(rows.rows).toEqual([{ decision: 'given', channel: 'web', recorded_by: null }]);
    const audit = await admin.query("select actor_type, actor_id from platform.audit_log where action = 'consent.given' and details->>'patientId' = $1", [patient.patientId]);
    expect(audit.rows).toEqual([{ actor_type: 'patient', actor_id: patient.patientId }]);
  });

  it('asks again when a new version is published, and refuses the old one', async () => {
    const revised = await publish(ownerToken, tenantId, 'privacy', 'Privacy, revised');
    const me = await app.inject({ method: 'GET', url: '/v1/patient/me', headers: headers(patient.token, tenantId) });
    expect(me.json().consentsNeeded).toEqual(['privacy', 'telehealth_terms']);
    const stale = await give(patient.token, tenantId, privacy.documentId);
    expect(stale.statusCode).toBe(409);
    expect(stale.json().error.code).toBe('not_current_version');
    expect(stateOf(await give(patient.token, tenantId, revised.documentId), 'privacy')).toMatchObject({ needed: false, decidedVersion: 2 });
  });

  it('lets other modules refuse until care has what it needs', async () => {
    const context: TenantContext = { tenantId, actor: { type: 'patient', patientId: patient.patientId }, requestId: 'test' };
    const refused = await withTenant(context, (tx) => assertConsents(tx, patient.patientId, 'care')).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 409, code: 'consent_needed', details: { kinds: ['telehealth_terms'] } });
    await give(patient.token, tenantId, terms.documentId);
    await expect(withTenant(context, (tx) => assertConsents(tx, patient.patientId, 'care'))).resolves.toBeUndefined();
    await expect(withTenant(context, (tx) => assertConsents(tx, patient.patientId, 'order'))).rejects.toMatchObject({ details: { kinds: ['pharmacy_sharing'] } });
  });

  it('keeps a kind needed while the tenant has published no text for it', async () => {
    const consents = await app.inject({ method: 'GET', url: '/v1/patient/consents', headers: headers(patient.token, tenantId) });
    expect(stateOf(consents, 'pharmacy_sharing')).toMatchObject({ needed: true, decision: null });
    expect(consents.json().consents.find((state: { kind: string }) => state.kind === 'pharmacy_sharing').document).toBeNull();
  });
});

describe('staff recording a decision for a patient (IDN13)', async () => {
  const { tenantId, members } = await tenantWith('owner', 'support', 'clinician');
  const [owner, support, clinician] = members;
  const document = await publish(await signIn(owner!.email), tenantId, 'identity_check');
  const patient = await signUp(tenantId);
  const supportToken = await signIn(support!.email);
  const record = (token: string, payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/v1/patients/${patient.patientId}/consents`, headers: headers(token, tenantId), payload });

  it('refuses a withdrawal when nothing was given', async () => {
    const reply = await record(supportToken, { documentId: document.documentId, decision: 'withdrawn', channel: 'phone', reason: 'Patient asked on a call' });
    expect(reply.json().error.code).toBe('nothing_to_withdraw');
  });

  it('records a phone agreement and a withdrawal, each with who and why', async () => {
    const given = await record(supportToken, { documentId: document.documentId, decision: 'given', channel: 'phone', reason: 'Read aloud on a call' });
    expect(stateOf(given, 'identity_check')).toMatchObject({ needed: false, decision: 'given' });
    const withdrawn = await record(supportToken, { documentId: document.documentId, decision: 'withdrawn', channel: 'phone', reason: 'Patient asked on a call' });
    expect(stateOf(withdrawn, 'identity_check')).toMatchObject({ needed: true, decision: 'withdrawn' });
    const rows = await admin.query('select decision, channel, recorded_by, reason from clinical.patient_consents where patient_id = $1 order by at, id', [patient.patientId]);
    expect(rows.rows).toEqual([
      { decision: 'given', channel: 'phone', recorded_by: support!.id, reason: 'Read aloud on a call' },
      { decision: 'withdrawn', channel: 'phone', recorded_by: support!.id, reason: 'Patient asked on a call' },
    ]);
  });

  it('needs a reason, and patients:manage', async () => {
    expect((await record(supportToken, { documentId: document.documentId, decision: 'given', channel: 'phone' })).statusCode).toBe(400);
    const clinicianToken = await signIn(clinician!.email);
    expect((await record(clinicianToken, { documentId: document.documentId, decision: 'given', channel: 'phone', reason: 'x' })).statusCode).toBe(403);
    const seen = await app.inject({ method: 'GET', url: `/v1/patients/${patient.patientId}/consents`, headers: headers(clinicianToken, tenantId) });
    expect(seen.statusCode).toBe(200);
  });

  it('never edits or removes a decision', async () => {
    await expect(admin.query("update clinical.patient_consents set decision = 'given' where patient_id = $1", [patient.patientId])).rejects.toThrow(/never changed or removed/);
    await expect(admin.query('delete from clinical.patient_consents where patient_id = $1', [patient.patientId])).rejects.toThrow(/never changed or removed/);
  });
});

describe('consents are isolated by tenant (ADR 0006)', async () => {
  const a = await tenantWith('owner');
  const b = await createTenant();
  const document = await publish(await signIn(a.members[0]!.email), a.tenantId, 'privacy');
  const inA = await signUp(a.tenantId);
  const inB = await signUp(b);
  await give(inA.token, a.tenantId, document.documentId);
  const asB: TenantContext = { tenantId: b, actor: { type: 'system' }, requestId: 'test' };

  it("can't read another tenant's documents or decisions", async () => {
    const seen = await withTenant(asB, async (tx) => ({
      documents: await tx.db.select({ id: consentDocuments.id }).from(consentDocuments),
      consents: await tx.db.select({ id: patientConsents.id }).from(patientConsents),
    }));
    expect(seen).toEqual({ documents: [], consents: [] });
    expect((await give(inB.token, b, document.documentId)).statusCode).toBe(404);
  });

  it("can't point a decision at another tenant's document, or at a document of another kind", async () => {
    await expect(
      withTenant(asB, (tx) => tx.db.insert(patientConsents).values({ tenantId: b, patientId: inB.patientId, documentId: document.documentId, kind: 'privacy', decision: 'given', channel: 'web' })),
    ).rejects.toThrow();
    const asA: TenantContext = { ...asB, tenantId: a.tenantId };
    await expect(
      withTenant(asA, (tx) => tx.db.insert(patientConsents).values({ tenantId: a.tenantId, patientId: inA.patientId, documentId: document.documentId, kind: 'pharmacy_sharing', decision: 'given', channel: 'web' })),
    ).rejects.toThrow();
  });

  it("can't change or delete another tenant's rows either", async () => {
    const changed = await withTenant(asB, (tx) => tx.db.execute(sql`delete from clinical.consent_documents where id = ${document.documentId}`)).catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(Error);
  });
});
