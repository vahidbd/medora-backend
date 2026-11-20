import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { addDays, instantAt, localDate } from '../../src/lib/time.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { bookConsult, completeConsult, createPrescriber, giveHours } from '../support/consults.js';
import { admin, createBrand, createPlatformStaff, tenantWith } from '../support/db.js';

/** A patient's own consults (docs/decisions/consults.md CNS21 to CNS23), on a made-up program and made-up people. */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const definition = {
  steps: [{ key: 'about', title: 'About you', questions: [{ key: 'expecting', label: 'Are you expecting?', kind: 'yes_no' }] }],
  rules: [{ key: 'expecting_stop', outcome: 'hard_stop', when: { answer: 'expecting', is: 'equals', value: true }, prescriberLabel: 'Expecting', patientMessage: 'Please see your GP.' }],
};

const SYDNEY = 'Australia/Sydney';
const tomorrowAt = (hhmm: string) => instantAt(addDays(localDate(new Date(), SYDNEY), 1), hhmm, SYDNEY)!.toISOString();
const QUARTER = 15 * 60_000;

const staff = async (method: 'GET' | 'POST' | 'PATCH', url: string, email: string, tenantId: string, payload?: object) =>
  app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

/** A tenant taking new patients through one live program, and a prescriber working all day under a name. */
async function clinic() {
  const { tenantId, members } = await tenantWith('medical_director', 'support', 'owner');
  const [director, desk, owner] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
  const { brandId } = await createBrand(tenantId, { status: 'live', host: `${randomUUID().slice(0, 8)}.example.test`, verifiedBy: (await createPlatformStaff()).id });
  const documents = [];
  for (const kind of ['privacy', 'telehealth_terms']) documents.push((await staff('POST', '/consent-documents', owner.email, tenantId, { kind, title: `${kind} notice`, body: 'Made-up text.' })).json());
  const protocol = (await staff('POST', '/protocols', director.email, tenantId, { name: 'Made-up care', condition: 'Made-up condition', definition })).json();
  await staff('POST', `/protocols/${protocol.protocolId}/sign-off`, director.email, tenantId, { version: 1, registration: 'MED0001234567', attest: true });
  const program = (await staff('POST', '/programs', director.email, tenantId, { brandId, protocolId: protocol.protocolId, name: 'Made-up program' })).json();
  await staff('PATCH', `/programs/${program.programId}`, director.email, tenantId, { status: 'live' });
  const doctor = await createPrescriber(tenantId);
  await giveHours(tenantId, doctor.clinicianId, { startsAt: '00:00', endsAt: '24:00' });
  await admin.query("update platform.users set display_name = 'Dr Alex Sample' where id = $1", [doctor.userId]);
  return { tenantId, brandId, director, desk, doctor, programId: program.programId as string, documents: documents as { documentId: string }[] };
}
type Clinic = Awaited<ReturnType<typeof clinic>>;

/** A signed-up patient who has agreed to the terms, and a way to call as them. */
async function patient(c: Clinic) {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const as = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: object) =>
    app.inject({ method, url: `/v1${url}`, headers: headers(token, c.tenantId), ...(payload ? { payload } : {}) });
  const account = await as('POST', '/patient/account', { brandId: c.brandId, givenName: 'Sam', familyName: 'Sample', dateOfBirth: '1990-05-01', sex: 'not_stated' });
  for (const document of c.documents) await as('POST', '/patient/consents', { documentId: document.documentId });
  return { as, patientId: account.json().patientId as string };
}

async function answerIntake(c: Clinic, p: Awaited<ReturnType<typeof patient>>, expecting: boolean) {
  const { intakeId } = (await p.as('POST', '/patient/intakes', { programId: c.programId })).json();
  const answered = await p.as('PUT', `/patient/intakes/${intakeId}/steps/about`, { answers: { expecting } });
  if (!expecting) await p.as('POST', `/patient/intakes/${intakeId}/submit`);
  return answered;
}

const first = (c: Clinic, startsAt: string) => ({ purpose: 'initial', mode: 'video', startsAt, programId: c.programId });

describe('booking for themselves (CNS21)', async () => {
  const c = await clinic();

  it('books a first consult only once the program’s intake is sent, with a clinician assigned', async () => {
    const p = await patient(c);
    const times = (await p.as('GET', `/patient/consults/slots?purpose=initial&from=${tomorrowAt('10:00')}&to=${tomorrowAt('11:00')}`)).json();
    expect(times.slots[0].startsAt).toBe(tomorrowAt('10:00'));
    expect((await p.as('POST', '/patient/consults', { ...first(c, tomorrowAt('10:00')), programId: undefined })).json().error.code).toBe('program_needed');
    expect((await p.as('POST', '/patient/consults', first(c, tomorrowAt('10:00')))).json().error.code).toBe('intake_needed');
    await answerIntake(c, p, false);
    const booked = await p.as('POST', '/patient/consults', first(c, tomorrowAt('10:00')));
    expect(booked.statusCode).toBe(201);
    expect(booked.json()).toEqual({
      consultId: expect.any(String),
      status: 'scheduled',
      mode: 'video',
      purpose: 'initial',
      startsAt: tomorrowAt('10:00'),
      endsAt: new Date(new Date(tomorrowAt('10:00')).getTime() + QUARTER).toISOString(),
      clinicianName: 'Dr Alex Sample',
      canChange: true,
      canJoin: false,
    });
    const audit = await admin.query("select action from platform.audit_log where tenant_id = $1 and action in ('intake.outcome_read', 'consult.booked') order by id", [c.tenantId]);
    expect(audit.rows.map((r) => r.action).slice(-2)).toEqual(['intake.outcome_read', 'consult.booked']);
    expect((await p.as('POST', '/patient/consults', first(c, tomorrowAt('11:00')))).json().error.code).toBe('already_booked');
  });

  it('refuses a first consult once a later intake was stopped, and while the program is paused', async () => {
    const p = await patient(c);
    await answerIntake(c, p, false);
    await answerIntake(c, p, true);
    expect((await p.as('POST', '/patient/consults', first(c, tomorrowAt('12:00')))).json().error.code).toBe('intake_ineligible');
    const director = c.director.email;
    await staff('PATCH', `/programs/${c.programId}`, director, c.tenantId, { status: 'paused' });
    const other = await patient(c);
    await answerIntake(c, other, false);
    expect((await other.as('POST', '/patient/consults', first(c, tomorrowAt('12:00')))).json().error.code).toBe('program_not_accepting');
    await staff('PATCH', `/programs/${c.programId}`, director, c.tenantId, { status: 'live' });
  });

  it('books a review only after a first consult or review the patient has had, and never a follow-up', async () => {
    const p = await patient(c);
    const review = { purpose: 'review', mode: 'video', startsAt: tomorrowAt('13:00') };
    expect((await p.as('POST', '/patient/consults', review)).json().error.code).toBe('no_earlier_consult');
    const followUp = await bookConsult(c.tenantId, { patientId: p.patientId, clinicianUserId: c.doctor.userId, purpose: 'follow_up' });
    await completeConsult(followUp);
    expect((await p.as('POST', '/patient/consults', review)).json().error.code).toBe('no_earlier_consult');
    const earlier = await bookConsult(c.tenantId, { patientId: p.patientId, clinicianUserId: c.doctor.userId });
    await completeConsult(earlier);
    expect((await p.as('POST', '/patient/consults', review)).statusCode).toBe(201);
    expect((await p.as('POST', '/patient/consults', { ...review, purpose: 'follow_up' })).statusCode).toBe(400);
  });
});

describe('seeing and changing their consults (CNS22, CNS23)', async () => {
  const c = await clinic();

  it('lists only their own, what’s coming first, and lets them move or cancel up to two hours ahead', async () => {
    const p = await patient(c);
    const someoneElse = await patient(c);
    const past = await bookConsult(c.tenantId, { patientId: p.patientId, clinicianUserId: c.doctor.userId });
    await completeConsult(past);
    const theirs = await bookConsult(c.tenantId, { patientId: someoneElse.patientId, clinicianUserId: c.doctor.userId, startsAt: new Date(tomorrowAt('16:00')) });
    const soon = new Date(Math.ceil((Date.now() + 60 * 60_000) / QUARTER) * QUARTER).toISOString();
    const { consultId: near } = (await staff('POST', '/consults', c.desk.email, c.tenantId, { patientId: p.patientId, clinicianUserId: c.doctor.userId, mode: 'video', purpose: 'review', startsAt: soon })).json();

    const listed = (await p.as('GET', '/patient/consults')).json().consults;
    expect(listed.map((x: { consultId: string; status: string; canChange: boolean }) => [x.consultId, x.status, x.canChange])).toEqual([
      [near, 'scheduled', false],
      [past, 'completed', false],
    ]);
    expect((await p.as('POST', `/patient/consults/${near}/cancel`)).json().error.code).toBe('too_late_to_change');
    expect((await p.as('POST', `/patient/consults/${theirs}/cancel`)).statusCode).toBe(404);
    expect((await p.as('POST', `/patient/consults/${theirs}/reschedule`, { startsAt: tomorrowAt('17:00') })).statusCode).toBe(404);

    await staff('POST', `/consults/${near}/cancel`, c.desk.email, c.tenantId, { reason: 'other' });
    const { consultId } = (await p.as('POST', '/patient/consults', { purpose: 'review', mode: 'video', startsAt: tomorrowAt('09:00') })).json();
    const moved = await p.as('POST', `/patient/consults/${consultId}/reschedule`, { startsAt: tomorrowAt('09:30') });
    expect(moved.statusCode).toBe(201);
    expect(moved.json()).toMatchObject({ startsAt: tomorrowAt('09:30'), status: 'scheduled', canChange: true });
    const cancelled = await p.as('POST', `/patient/consults/${moved.json().consultId}/cancel`);
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', canChange: false });
    const reason = await admin.query('select cancellation_reason from clinical.consults where id = $1', [moved.json().consultId]);
    expect(reason.rows[0].cancellation_reason).toBe('patient_request');
  });

  it('keeps staff tokens off the patient routes and patient tokens off the staff ones', async () => {
    const p = await patient(c);
    expect((await staff('GET', '/patient/consults', c.desk.email, c.tenantId)).statusCode).toBe(401);
    expect((await p.as('GET', `/consults/slots?purpose=initial`)).statusCode).toBe(401);
  });
});
