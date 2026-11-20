import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { fakeParchment } from '../../src/modules/prescribing/index.js';
import { testApp } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';
import { connectStandIns, consultBetween, madeUpPatient, openParchment, parchmentAccountFor, world } from '../support/prescribing.js';

/** Opening Parchment for a patient: the consult gate (ADR 0009, docs/decisions/prescribing.md RX1, RX2, RX3). */
connectStandIns();
let app: App;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

async function sessionsOf(patientId: string) {
  const { rows } = await admin.query('select prescriber_user_id, parchment_user_id, consult_id from clinical.prescribing_sessions where patient_id = $1', [patientId]);
  return rows;
}

async function auditActions(tenantId: string) {
  const { rows } = await admin.query('select action, details from platform.audit_log where tenant_id = $1 order by id', [tenantId]);
  return rows as { action: string; details: Record<string, unknown> }[];
}

describe('opening Parchment', async () => {
  const { tenantId, members } = await tenantWith('clinician', 'support', 'clinician');
  const prescriber = members[0]!;
  const support = members[1]!;
  const lapsed = members[2]!;
  const parchmentUserId = parchmentAccountFor(prescriber.email);
  parchmentAccountFor(lapsed.email);
  world.notInGoodStanding.add(lapsed.id);

  it('refuses without a phone or video consult with the patient, and sends Parchment nothing', async () => {
    const patient = madeUpPatient();
    const calls = fakeParchment.calls.length;
    const reply = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('consult_required');
    expect(fakeParchment.calls.length).toBe(calls);
    expect(await sessionsOf(patient.patientId)).toEqual([]);
  });

  it('refuses a prescriber whose registration or indemnity has lapsed', async () => {
    const patient = madeUpPatient();
    consultBetween(patient.patientId, lapsed.id);
    const reply = await openParchment(app, tenantId, lapsed.email, patient.patientId);
    expect(reply.statusCode).toBe(403);
    expect(reply.json().error).toMatchObject({ code: 'not_a_prescriber', details: { reasons: ['registration_lapsed'] } });
  });

  it("refuses a role that doesn't prescribe", async () => {
    const patient = madeUpPatient();
    consultBetween(patient.patientId, support.id);
    const reply = await openParchment(app, tenantId, support.email, patient.patientId);
    expect(reply.statusCode).toBe(403);
  });

  it('sends the patient to Parchment, links the prescriber, and records the prescribing session', async () => {
    const patient = madeUpPatient({ medicare: { number: '0000 00000 0', irn: '1', validTo: null } });
    const consult = consultBetween(patient.patientId, prescriber.id);
    const reply = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(reply.statusCode).toBe(201);
    const parchmentPatientId = fakeParchment.parchmentIdOf(patient.patientId)!;
    expect(reply.json()).toEqual({
      sessionId: expect.any(String),
      consultId: consult.consultId,
      parchmentUrl: `https://parchment.invalid/dashboard/patients/${parchmentPatientId}`,
    });
    expect(fakeParchment.patients.get(parchmentPatientId)).toMatchObject({ partnerPatientId: patient.patientId, familyName: 'Sample', medicare: { number: '0000000000' } });
    expect(await sessionsOf(patient.patientId)).toEqual([{ prescriber_user_id: prescriber.id, parchment_user_id: parchmentUserId, consult_id: consult.consultId }]);
    const actions = (await auditActions(tenantId)).map((entry) => entry.action);
    expect(actions).toEqual(expect.arrayContaining(['parchment_prescriber.linked', 'parchment_patient.sent', 'prescribing_session.opened']));
    const { rows } = await admin.query("select payload from platform.outbox where type = 'prescribing_session.opened' and record_id = $1", [reply.json().sessionId]);
    expect(rows[0].payload).toEqual({ patientId: patient.patientId, consultId: consult.consultId });
  });

  it("updates the same Parchment patient on the next open, and doesn't look the prescriber up again", async () => {
    const patient = madeUpPatient();
    consultBetween(patient.patientId, prescriber.id);
    await openParchment(app, tenantId, prescriber.email, patient.patientId);
    const before = fakeParchment.calls.length;
    world.patients.set(patient.patientId, { ...patient, mobile: '0411111111' });
    const reply = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(reply.statusCode).toBe(201);
    expect(fakeParchment.calls.slice(before)).toEqual(['updatePatient']);
    expect(fakeParchment.patients.get(fakeParchment.parchmentIdOf(patient.patientId)!)?.mobile).toBe('0411111111');
    const { rows } = await admin.query('select count(*)::int as links from clinical.parchment_patients where patient_id = $1', [patient.patientId]);
    expect(rows[0].links).toBe(1);
    expect(await sessionsOf(patient.patientId)).toHaveLength(2);
  });

  it("names what the patient's record is missing before anything is sent", async () => {
    const patient = madeUpPatient({ mobile: null, address: null });
    consultBetween(patient.patientId, prescriber.id);
    const reply = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error).toMatchObject({ code: 'patient_details_missing', message: "Add the patient's an Australian mobile number, home address before opening Parchment" });
  });

  it("fails closed when Parchment doesn't answer, and says which details Parchment refused", async () => {
    const patient = madeUpPatient();
    consultBetween(patient.patientId, prescriber.id);
    fakeParchment.failNext(503);
    const down = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(down.statusCode).toBe(502);
    expect(down.json().error.code).toBe('parchment_unavailable');
    fakeParchment.failNext(400, ['australian_street_address.postcode']);
    const refused = await openParchment(app, tenantId, prescriber.email, patient.patientId);
    expect(refused.json().error).toMatchObject({ code: 'parchment_refused_patient', message: "Parchment didn't accept the patient's home address. Check the record and try again." });
    expect(await sessionsOf(patient.patientId)).toEqual([]);
  });

  it('asks for a Parchment account when none has the prescriber’s email', async () => {
    const { tenantId: other, members: [stranger] } = await tenantWith('clinician');
    const patient = madeUpPatient();
    consultBetween(patient.patientId, stranger!.id);
    const reply = await openParchment(app, other, stranger!.email, patient.patientId);
    expect(reply.statusCode).toBe(409);
    expect(reply.json().error.code).toBe('parchment_account_missing');
  });

  it('keeps patient details out of the audit trail and events', async () => {
    const text = JSON.stringify(await auditActions(tenantId));
    const { rows } = await admin.query('select payload from platform.outbox where tenant_id = $1', [tenantId]);
    for (const leak of ['Sample', 'Alex', '0400000000', '1990-01-01']) {
      expect(text).not.toContain(leak);
      expect(JSON.stringify(rows)).not.toContain(leak);
    }
  });
});
