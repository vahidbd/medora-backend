import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { addDays, instantAt, localDate } from '../../src/lib/time.js';
import { headers, signIn, testApp } from '../support/app.js';
import { bookConsult, completeConsult, createPatient, createPrescriber, giveCareConsents, giveHours } from '../support/consults.js';
import { addMember, admin, createTenant, createUser } from '../support/db.js';

/** Times without a clinician named, and who takes them (docs/decisions/consults.md CNS18 to CNS20). Made-up people only. */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

async function call(email: string, tenantId: string, method: 'GET' | 'POST', url: string, payload?: object) {
  return app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });
}

const SYDNEY = 'Australia/Sydney';
/** A time on tomorrow's Sydney calendar, so every clinician below shares the day. */
const tomorrowAt = (hhmm: string) => instantAt(addDays(localDate(new Date(), SYDNEY), 1), hhmm, SYDNEY)!;
const QUARTER = 15 * 60_000;

async function clinic() {
  const tenantId = await createTenant();
  const desk = await createUser();
  await addMember(tenantId, desk.id, 'support');
  const doctors = [];
  for (let i = 0; i < 2; i++) {
    const doctor = await createPrescriber(tenantId);
    await giveHours(tenantId, doctor.clinicianId, { startsAt: '00:00', endsAt: '24:00' });
    doctors.push(doctor);
  }
  // Booking breaks ties in this order (CNS19).
  doctors.sort((a, b) => (a.userId < b.userId ? -1 : 1));
  const patient = async () => {
    const id = await createPatient(tenantId);
    await giveCareConsents(tenantId, id);
    return id;
  };
  return { tenantId, desk, first: doctors[0]!, second: doctors[1]!, patient };
}

const unnamed = (patientId: string, startsAt: Date, extra: object = {}) => ({ patientId, mode: 'video', purpose: 'initial', startsAt: startsAt.toISOString(), ...extra });

describe('times without a clinician (CNS18)', () => {
  it('offers every eligible clinician’s free slots together, in the tenant’s zone, and only prescribers for a first consult', async () => {
    const tenantId = await createTenant();
    const desk = await createUser();
    await addMember(tenantId, desk.id, 'support');
    const morning = await createPrescriber(tenantId);
    await giveHours(tenantId, morning.clinicianId, { startsAt: '09:00', endsAt: '10:00', slotMinutes: 30 });
    const evening = await createPrescriber(tenantId, { timeZone: 'Australia/Perth' });
    await giveHours(tenantId, evening.clinicianId, { startsAt: '16:00', endsAt: '17:00', slotMinutes: 30 });
    const nurse = await createPrescriber(tenantId, { profession: 'registered_nurse' });
    await giveHours(tenantId, nurse.clinicianId, { startsAt: '12:00', endsAt: '12:30', slotMinutes: 30 });
    const from = tomorrowAt('00:00').toISOString();
    const to = new Date(tomorrowAt('00:00').getTime() + 86_400_000).toISOString();
    const local = (iso: string) => new Intl.DateTimeFormat('en-AU', { timeZone: SYDNEY, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));

    const initial = (await call(desk.email, tenantId, 'GET', `/consults/slots?purpose=initial&from=${from}&to=${to}`)).json();
    expect(initial.timeZone).toBe(SYDNEY);
    // Perth's 16:00 is Sydney's 18:00 or 19:00, depending on daylight saving.
    const perth = (hhmm: string) => local(instantAt(addDays(localDate(new Date(), SYDNEY), 1), hhmm, 'Australia/Perth')!.toISOString());
    expect(initial.slots.map((s: { startsAt: string }) => local(s.startsAt))).toEqual(['09:00', '09:30', perth('16:00'), perth('16:30')]);
    const followUp = (await call(desk.email, tenantId, 'GET', `/consults/slots?purpose=follow_up&from=${from}&to=${to}`)).json();
    expect(followUp.slots.map((s: { startsAt: string }) => local(s.startsAt))).toContain('12:00');

    expect((await call(desk.email, tenantId, 'GET', `/consults/slots?from=${from}`)).json().error.code).toBe('clinician_or_purpose');
  });

  it('drops a time once every clinician is taken then', async () => {
    const { tenantId, desk, first, second, patient } = await clinic();
    const at = tomorrowAt('10:00');
    const range = `from=${at.toISOString()}&to=${new Date(at.getTime() + QUARTER).toISOString()}`;
    const starts = async () => (await call(desk.email, tenantId, 'GET', `/consults/slots?purpose=initial&${range}`)).json().slots.map((s: { startsAt: string }) => s.startsAt);
    await bookConsult(tenantId, { patientId: await patient(), clinicianUserId: first.userId, startsAt: at });
    expect(await starts()).toContain(at.toISOString());
    await bookConsult(tenantId, { patientId: await patient(), clinicianUserId: second.userId, startsAt: at });
    expect(await starts()).not.toContain(at.toISOString());
  });
});

describe('who takes it (CNS19)', () => {
  it('gives the consult to whoever is free then', async () => {
    const { tenantId, desk, first, second, patient } = await clinic();
    const at = tomorrowAt('11:00');
    await bookConsult(tenantId, { patientId: await patient(), clinicianUserId: first.userId, startsAt: at });
    const reply = await call(desk.email, tenantId, 'POST', '/consults', unnamed(await patient(), at));
    expect(reply.statusCode).toBe(201);
    expect(reply.json().clinicianUserId).toBe(second.userId);
    const none = await call(desk.email, tenantId, 'POST', '/consults', unnamed(await patient(), at));
    expect(none.json().error).toMatchObject({ code: 'slot_taken', message: 'That time is no longer available' });
  });

  it('prefers the patient’s last clinician, then whoever has fewer consults that day, then a fixed order', async () => {
    const { tenantId, desk, first, second, patient } = await clinic();
    const tie = await call(desk.email, tenantId, 'POST', '/consults', unnamed(await patient(), tomorrowAt('08:00')));
    expect(tie.json().clinicianUserId).toBe(first.userId);
    const lighter = await call(desk.email, tenantId, 'POST', '/consults', unnamed(await patient(), tomorrowAt('08:30')));
    expect(lighter.json().clinicianUserId).toBe(second.userId);

    const returning = await patient();
    const seen = await bookConsult(tenantId, { patientId: returning, clinicianUserId: second.userId });
    await completeConsult(seen);
    await bookConsult(tenantId, { patientId: await patient(), clinicianUserId: second.userId, startsAt: tomorrowAt('09:00') });
    const kept = await call(desk.email, tenantId, 'POST', '/consults', unnamed(returning, tomorrowAt('09:30'), { purpose: 'review' }));
    expect(kept.json().clinicianUserId).toBe(second.userId);
  });

  it('keeps a moved consult with its clinician when they are free, and otherwise finds another', async () => {
    const { tenantId, desk, first, second, patient } = await clinic();
    const patientId = await patient();
    const { consultId } = (await call(desk.email, tenantId, 'POST', '/consults', unnamed(patientId, tomorrowAt('13:00'), { clinicianUserId: second.userId }))).json();
    const stayed = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/reschedule`, { startsAt: tomorrowAt('13:30').toISOString() });
    expect(stayed.json().clinicianUserId).toBe(second.userId);
    await bookConsult(tenantId, { patientId: await patient(), clinicianUserId: second.userId, startsAt: tomorrowAt('14:00') });
    const handed = await call(desk.email, tenantId, 'POST', `/consults/${stayed.json().consultId}/reschedule`, { startsAt: tomorrowAt('14:00').toISOString() });
    expect(handed.json().clinicianUserId).toBe(first.userId);
    const event = await admin.query("select payload from platform.outbox where record_id = $1 and type = 'consult.rescheduled'", [handed.json().consultId]);
    expect(event.rows[0].payload).toMatchObject({ clinicianUserId: first.userId, previousClinicianUserId: second.userId });
  });
});

describe('naming the patient on a change (CNS20)', () => {
  it('finds no consult when the named patient isn’t its patient', async () => {
    const { tenantId, desk, first, patient } = await clinic();
    const [patientId, someoneElse] = [await patient(), await patient()];
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: first.userId, startsAt: tomorrowAt('15:00') });
    const wrongCancel = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/cancel`, { reason: 'other', patientId: someoneElse });
    expect(wrongCancel.statusCode).toBe(404);
    const wrongMove = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/reschedule`, { startsAt: tomorrowAt('15:30').toISOString(), patientId: someoneElse });
    expect(wrongMove.statusCode).toBe(404);
    const moved = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/reschedule`, { startsAt: tomorrowAt('15:30').toISOString(), patientId });
    expect(moved.statusCode).toBe(201);
    const cancelled = await call(desk.email, tenantId, 'POST', `/consults/${moved.json().consultId}/cancel`, { reason: 'other', patientId });
    expect(cancelled.json().status).toBe('cancelled');
  });
});
