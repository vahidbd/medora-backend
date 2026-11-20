import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { markNoShow } from '../../src/modules/consults/booking.service.js';
import { headers, signIn, testApp } from '../support/app.js';
import { bookConsult, brandOf, createPatient, createPrescriber, giveCareConsents, giveHours, playVideo } from '../support/consults.js';
import { addMember, admin, createTenant, createUser } from '../support/db.js';

/** Booking consults (docs/decisions/consults.md CNS11 to CNS16). Made-up people only. */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

type Method = 'GET' | 'POST';
async function call(email: string, tenantId: string, method: Method, url: string, payload?: object) {
  return app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });
}

const QUARTER = 15 * 60_000;
/** The first quarter hour at least `minutes` from now. Sydney's offset is whole hours, so it is a slot boundary there too. */
const slotIn = (minutes: number) => new Date(Math.ceil((Date.now() + minutes * 60_000) / QUARTER) * QUARTER);

async function clinic() {
  const tenantId = await createTenant();
  const doctor = await createPrescriber(tenantId);
  await giveHours(tenantId, doctor.clinicianId, { startsAt: '00:00', endsAt: '24:00' });
  const desk = await createUser();
  await addMember(tenantId, desk.id, 'support');
  const patientId = await createPatient(tenantId, { mobile: '+61400000001' });
  await giveCareConsents(tenantId, patientId);
  return { tenantId, doctor, desk, patientId };
}

const booking = (patientId: string, clinicianUserId: string, startsAt: Date, extra: object = {}) => ({
  patientId,
  brandId: brandOf(patientId),
  clinicianUserId,
  mode: 'video',
  purpose: 'initial',
  startsAt: startsAt.toISOString(),
  ...extra,
});

describe('offering slots (CNS12)', () => {
  it('cuts slots from the hours in the clinician’s zone, leaving out time off, booked slots and the next 15 minutes', async () => {
    const tenantId = await createTenant();
    const doctor = await createPrescriber(tenantId, { timeZone: 'Australia/Perth' });
    await giveHours(tenantId, doctor.clinicianId, { startsAt: '09:00', endsAt: '11:00', slotMinutes: 30 });
    const from = new Date(Date.now() + 86_400_000);
    const reply = await call(doctor.email, tenantId, 'GET', `/consults/slots?clinicianUserId=${doctor.userId}&from=${from.toISOString()}`);
    expect(reply.statusCode).toBe(200);
    const { timeZone, slots } = reply.json() as { timeZone: string; slots: { startsAt: string; endsAt: string }[] };
    expect(timeZone).toBe('Australia/Perth');
    expect(slots.length).toBeGreaterThanOrEqual(24);
    const local = (iso: string) => new Intl.DateTimeFormat('en-AU', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(new Date(iso));
    expect(new Set(slots.map((s) => local(s.startsAt)))).toEqual(new Set(['09:00', '09:30', '10:00', '10:30']));

    const [first, second] = slots as [(typeof slots)[0], (typeof slots)[0]];
    const patientId = await createPatient(tenantId);
    await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId, startsAt: new Date(first.startsAt), minutes: 30 });
    await admin.query(
      `insert into operational.clinician_time_off (tenant_id, clinician_id, starts_at, ends_at, reason, created_by) values ($1, $2, $3, $4, 'leave', $5)`,
      [tenantId, doctor.clinicianId, second.startsAt, second.endsAt, doctor.userId],
    );
    const after = (await call(doctor.email, tenantId, 'GET', `/consults/slots?clinicianUserId=${doctor.userId}&from=${from.toISOString()}`)).json();
    expect(after.slots.map((s: { startsAt: string }) => s.startsAt)).not.toContain(first.startsAt);
    expect(after.slots.map((s: { startsAt: string }) => s.startsAt)).not.toContain(second.startsAt);
  });
});

describe('booking (CNS12, CNS13)', () => {
  it('books a free slot, audits it and announces it, and then refuses the same slot', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const at = slotIn(120);
    const reply = await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, at));
    expect(reply.statusCode).toBe(201);
    expect(reply.json()).toMatchObject({
      patientId,
      patientName: 'Sam Example',
      clinicianUserId: doctor.userId,
      startsAt: at.toISOString(),
      endsAt: new Date(at.getTime() + QUARTER).toISOString(),
      status: 'scheduled',
      purpose: 'initial',
    });
    const events = await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'consult.booked'", [tenantId]);
    expect(events.rows[0].payload).toMatchObject({ consultId: reply.json().consultId, patientId });
    const audit = await admin.query("select count(*)::int as n from platform.audit_log where tenant_id = $1 and action = 'consult.booked'", [tenantId]);
    expect(audit.rows[0].n).toBe(1);

    const other = await createPatient(tenantId);
    await giveCareConsents(tenantId, other);
    const again = await call(desk.email, tenantId, 'POST', '/consults', booking(other, doctor.userId, at));
    expect(again.json().error.code).toBe('slot_taken');
    const second = await createPrescriber(tenantId);
    await giveHours(tenantId, second.clinicianId, { startsAt: '00:00', endsAt: '24:00' });
    const busy = await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, second.userId, at));
    expect(busy.json().error.code).toBe('patient_busy');
  });

  it('lets exactly one of two bookings racing for one slot win, and refuses the other cleanly', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const other = await createPatient(tenantId);
    await giveCareConsents(tenantId, other);
    const at = slotIn(180);
    const replies = await Promise.all([
      call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, at)),
      call(desk.email, tenantId, 'POST', '/consults', booking(other, doctor.userId, at)),
    ]);
    expect(replies.map((r) => r.statusCode).sort()).toEqual([201, 409]);
    expect(replies.find((r) => r.statusCode === 409)!.json().error.code).toBe('slot_taken');
  });

  it('names the rule when a time can’t be booked', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const refusal = async (body: object) => (await call(desk.email, tenantId, 'POST', '/consults', body)).json().error.code;
    expect(await refusal(booking(patientId, doctor.userId, new Date(slotIn(120).getTime() + 7 * 60_000)))).toBe('not_a_slot');
    expect(await refusal(booking(patientId, doctor.userId, slotIn(61 * 24 * 60)))).toBe('outside_booking_window');
    expect(await refusal(booking(patientId, doctor.userId, new Date(Date.now() - QUARTER)))).toBe('outside_booking_window');
    const away = slotIn(240);
    await admin.query(
      `insert into operational.clinician_time_off (tenant_id, clinician_id, starts_at, ends_at, reason, created_by) values ($1, $2, $3, $4, 'leave', $5)`,
      [tenantId, doctor.clinicianId, away, new Date(away.getTime() + 2 * QUARTER), doctor.userId],
    );
    expect(await refusal(booking(patientId, doctor.userId, away))).toBe('clinician_away');
  });

  it('books only clinicians in standing, and initial and review consults only with a prescriber', async () => {
    const { tenantId, desk, patientId } = await clinic();
    const nurse = await createPrescriber(tenantId, { profession: 'registered_nurse' });
    await giveHours(tenantId, nurse.clinicianId, { startsAt: '00:00', endsAt: '24:00' });
    const refused = await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, nurse.userId, slotIn(120)));
    expect(refused.json().error.code).toBe('needs_prescriber');
    const followUp = await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, nurse.userId, slotIn(120), { purpose: 'follow_up' }));
    expect(followUp.statusCode).toBe(201);

    const unchecked = await createUser();
    const membershipId = await addMember(tenantId, unchecked.id, 'prescriber');
    await admin.query(`insert into operational.clinicians (tenant_id, membership_id, profession, time_zone) values ($1, $2, 'medical_practitioner', 'Australia/Sydney')`, [tenantId, membershipId]);
    const lapsed = await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, unchecked.id, slotIn(180)));
    expect(lapsed.json().error).toMatchObject({ code: 'clinician_not_in_standing', details: { reasons: ['registration_missing', 'indemnity_missing'] } });
  });

  it('books only adults who have agreed to the care terms, and a phone consult only with a mobile on file', async () => {
    const { tenantId, doctor, desk } = await clinic();
    const refusal = async (patientId: string, extra: object = {}) =>
      (await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, slotIn(120), extra))).json().error;
    const minor = await createPatient(tenantId, { dateOfBirth: '2015-01-01' });
    await giveCareConsents(tenantId, minor);
    expect((await refusal(minor)).code).toBe('patient_under_age');
    const unsigned = await createPatient(tenantId);
    expect(await refusal(unsigned)).toMatchObject({ code: 'consent_needed', details: { kinds: ['privacy', 'telehealth_terms'] } });
    const noPhone = await createPatient(tenantId);
    await giveCareConsents(tenantId, noPhone);
    expect((await refusal(noPhone, { mode: 'phone' })).code).toBe('no_mobile');
  });

  it('needs consults:book to book and consults:read to see the schedule', async () => {
    const { tenantId, doctor, patientId } = await clinic();
    const finance = await createUser();
    await addMember(tenantId, finance.id, 'finance');
    expect((await call(finance.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, slotIn(120)))).statusCode).toBe(403);
    const now = new Date();
    const range = `from=${now.toISOString()}&to=${new Date(now.getTime() + 7 * 86_400_000).toISOString()}`;
    expect((await call(finance.email, tenantId, 'GET', `/consults?${range}`)).statusCode).toBe(403);
    const seen = await call(doctor.email, tenantId, 'GET', `/consults?${range}&clinicianUserId=${doctor.userId}`);
    expect(seen.statusCode).toBe(200);
    const audit = await admin.query("select count(*)::int as n from platform.audit_log where tenant_id = $1 and action = 'consult.schedule_read'", [tenantId]);
    expect(audit.rows[0].n).toBe(1);
  });
});

describe('cancelling and moving (CNS14, CNS15)', () => {
  it('cancels for a listed reason, frees the slot, and never takes "rescheduled" from a person', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const at = slotIn(120);
    const { consultId } = (await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, at))).json();
    expect((await call(desk.email, tenantId, 'POST', `/consults/${consultId}/cancel`, { reason: 'rescheduled' })).statusCode).toBe(400);
    const cancelled = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/cancel`, { reason: 'patient_request' });
    expect(cancelled.json()).toMatchObject({ status: 'cancelled', cancellationReason: 'patient_request' });
    const event = await admin.query("select payload from platform.outbox where tenant_id = $1 and type = 'consult.cancelled'", [tenantId]);
    expect(event.rows[0].payload).toMatchObject({ consultId, reason: 'patient_request' });
    expect((await call(desk.email, tenantId, 'POST', `/consults/${consultId}/cancel`, { reason: 'other' })).json().error.code).toBe('consult_not_scheduled');
    expect((await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, at))).statusCode).toBe(201);
  });

  it('never cancels or moves a consult that has evidence, whatever its status says', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const { consultId } = (await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, slotIn(120)))).json();
    await playVideo(app, tenantId, consultId, [{ kind: 'participant_joined', who: { party: 'patient', patientId }, at: new Date(Date.now() - 60_000) }]);
    expect((await call(desk.email, tenantId, 'POST', `/consults/${consultId}/cancel`, { reason: 'other' })).json().error.code).toBe('consult_has_evidence');
    expect((await call(desk.email, tenantId, 'POST', `/consults/${consultId}/reschedule`, { startsAt: slotIn(300).toISOString() })).json().error.code).toBe(
      'consult_has_evidence',
    );
  });

  it('moves a consult in one step with one event, and leaves it alone if the new time is refused', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const at = slotIn(120);
    const { consultId } = (await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, at))).json();
    const later = new Date(at.getTime() + QUARTER);
    const moved = await call(desk.email, tenantId, 'POST', `/consults/${consultId}/reschedule`, { startsAt: later.toISOString() });
    expect(moved.statusCode).toBe(201);
    expect(moved.json()).toMatchObject({ rescheduledFrom: consultId, startsAt: later.toISOString(), status: 'scheduled' });
    const old = (await call(desk.email, tenantId, 'GET', `/consults/${consultId}`)).json();
    expect(old).toMatchObject({ status: 'cancelled', cancellationReason: 'rescheduled' });
    const types = await admin.query("select type from platform.outbox where tenant_id = $1 and type like 'consult.%' order by id", [tenantId]);
    expect(types.rows.map((r) => r.type)).toEqual(['consult.booked', 'consult.rescheduled']);

    const taken = await createPatient(tenantId);
    await giveCareConsents(tenantId, taken);
    const blocker = slotIn(360);
    expect((await call(desk.email, tenantId, 'POST', '/consults', booking(taken, doctor.userId, blocker))).statusCode).toBe(201);
    const refused = await call(desk.email, tenantId, 'POST', `/consults/${moved.json().consultId}/reschedule`, { startsAt: blocker.toISOString() });
    expect(refused.json().error.code).toBe('slot_taken');
    expect((await call(desk.email, tenantId, 'GET', `/consults/${moved.json().consultId}`)).json().status).toBe('scheduled');
  });
});

describe('no-shows (CNS16)', () => {
  it('marks a no-show only once it was due, by a person, and reinstates a mistaken one', async () => {
    const { tenantId, doctor, desk, patientId } = await clinic();
    const due = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId, startsAt: new Date(Date.now() - 2 * QUARTER) });
    const { consultId: future } = (await call(desk.email, tenantId, 'POST', '/consults', booking(patientId, doctor.userId, slotIn(120)))).json();
    expect((await call(desk.email, tenantId, 'POST', `/consults/${future}/no-show`)).json().error.code).toBe('consult_not_due');
    await expect(withTenant({ tenantId, actor: { type: 'agent', agentId: 'booking' }, requestId: 'test' }, (tx) => markNoShow(tx, due))).rejects.toThrow(/person/);
    expect((await call(desk.email, tenantId, 'POST', `/consults/${due}/no-show`)).json().status).toBe('no_show');
    expect((await call(desk.email, tenantId, 'POST', `/consults/${due}/reinstate`)).json().status).toBe('scheduled');
    const audit = await admin.query("select action from platform.audit_log where tenant_id = $1 and action in ('consult.marked_no_show', 'consult.reinstated') order by id", [tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['consult.marked_no_show', 'consult.reinstated']);
  });

  it("can't point a move at another tenant's consult", async () => {
    const a = await clinic();
    const b = await clinic();
    const theirs = await bookConsult(b.tenantId, { patientId: b.patientId, clinicianUserId: b.doctor.userId });
    await expect(
      admin.query(
        `insert into clinical.consults (tenant_id, patient_id, clinician_user_id, brand_id, mode, purpose, scheduled_start, scheduled_end, rescheduled_from)
         values ($1, $2, $3, $4, 'video', 'initial', now() + interval '1 day', now() + interval '1 day 15 minutes', $5)`,
        [a.tenantId, a.patientId, a.doctor.userId, brandOf(a.patientId), theirs],
      ),
    ).rejects.toThrow(/foreign key/);
  });
});
