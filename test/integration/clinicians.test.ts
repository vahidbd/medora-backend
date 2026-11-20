import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { clinicianStanding } from '../../src/modules/clinicians/index.js';
import { headers, signIn, testApp } from '../support/app.js';
import { addMember, admin, createUser, tenantWith } from '../support/db.js';

/** Clinicians, their credentials and hours (docs/decisions/workforce.md). Made-up people only. */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE';
async function call(email: string, tenantId: string, method: Method, url: string, payload?: object) {
  return app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });
}

const registration = { kind: 'registration', registeringBody: 'ahpra', reference: 'MED0000000001', registrationStatus: 'practising', expiresOn: '2099-09-30' };
const indemnity = { kind: 'indemnity', insurer: 'Example Mutual', coversTelehealthNewPatients: true, expiresOn: '2099-06-30' };

/** A tenant with an owner, a doctor (made a clinician by the owner) and a support person. */
async function clinic() {
  const { tenantId, members } = await tenantWith('owner', 'clinician', 'support');
  const [owner, doctor, support] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
  const created = await call(owner.email, tenantId, 'POST', '/clinicians', {
    membershipId: doctor.membershipId,
    profession: 'medical_practitioner',
    timeZone: 'Australia/Perth',
  });
  expect(created.statusCode).toBe(201);
  return { tenantId, owner, doctor, support, clinicianId: created.json().clinicianId as string };
}

async function credentialed() {
  const setup = await clinic();
  const { tenantId, owner, doctor, clinicianId } = setup;
  for (const body of [registration, indemnity]) {
    const added = await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, body);
    expect(added.statusCode).toBe(201);
  }
  const listed = await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`);
  for (const credential of listed.json().credentials) {
    const verified = await call(owner.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials/${credential.credentialId}/verify`);
    expect(verified.statusCode).toBe(200);
  }
  return setup;
}

describe('clinicians and their standing', () => {
  it("starts a new clinician unable to consult, and says why", async () => {
    const { tenantId, owner, clinicianId } = await clinic();
    const reply = await call(owner.email, tenantId, 'GET', `/clinicians/${clinicianId}`);
    expect(reply.json()).toMatchObject({
      profession: 'medical_practitioner',
      timeZone: 'Australia/Perth',
      standing: { mayConsult: false, mayPrescribe: false, reasons: ['registration_missing', 'indemnity_missing'] },
      credentials: [],
    });
  });

  it('lets a doctor consult and prescribe once someone else checks their credentials, with audit entries and events', async () => {
    const { tenantId, doctor, clinicianId } = await credentialed();
    const reply = await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`);
    expect(reply.json().standing).toEqual({ mayConsult: true, mayPrescribe: true, reasons: [], warnings: [] });
    expect(reply.json().credentials.every((c: { counts: boolean }) => c.counts)).toBe(true);
    const standing = await withTenant({ tenantId, actor: { type: 'system' }, requestId: null }, (tx) => clinicianStanding(tx, doctor.id));
    expect(standing.mayPrescribe).toBe(true);
    const audit = await admin.query("select action from platform.audit_log where tenant_id = $1 and action like 'credential.%' order by id", [tenantId]);
    expect(audit.rows.map((r) => r.action)).toEqual(['credential.added', 'credential.added', 'credential.verified', 'credential.verified']);
    const events = await admin.query("select count(*)::int as n from platform.outbox where tenant_id = $1 and type = 'credential.verified'", [tenantId]);
    expect(events.rows[0].n).toBe(2);
  });

  it("never lets anyone check their own credential, even an owner (WRK4)", async () => {
    const { tenantId, doctor, clinicianId } = await clinic();
    await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, registration);
    const [credential] = (await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json().credentials;
    const byDoctor = await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials/${credential.credentialId}/verify`);
    expect(byDoctor.statusCode).toBe(403);

    const solo = await tenantWith('owner');
    const owner = solo.members[0]!;
    const own = await call(owner.email, solo.tenantId, 'POST', '/clinicians', { membershipId: owner.membershipId, profession: 'medical_practitioner', timeZone: 'Australia/Sydney' });
    const ownId = own.json().clinicianId;
    await call(owner.email, solo.tenantId, 'POST', `/clinicians/${ownId}/credentials`, registration);
    const [mine] = (await call(owner.email, solo.tenantId, 'GET', `/clinicians/${ownId}`)).json().credentials;
    const byOwner = await call(owner.email, solo.tenantId, 'POST', `/clinicians/${ownId}/credentials/${mine.credentialId}/verify`);
    expect(byOwner.json().error.code).toBe('own_record');
  });

  it('shows support the standing but not the registration details (WRK4)', async () => {
    const { tenantId, support, clinicianId } = await credentialed();
    const list = await call(support.email, tenantId, 'GET', '/clinicians');
    expect(list.json().clinicians).toHaveLength(1);
    expect(list.json().clinicians[0].standing.mayConsult).toBe(true);
    const detail = await call(support.email, tenantId, 'GET', `/clinicians/${clinicianId}`);
    expect(detail.json().credentials).toBeNull();
    const add = await call(support.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, registration);
    expect(add.statusCode).toBe(403);
  });

  it('keeps the checked registration counting until its renewal is checked, then withdraws the old one as replaced (WRK2)', async () => {
    const { tenantId, owner, doctor, clinicianId } = await credentialed();
    const renewal = { ...registration, expiresOn: '2100-09-30' };
    await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, renewal);
    const waiting = (await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json();
    expect(waiting.standing.mayPrescribe).toBe(true);
    const newest = waiting.credentials.find((c: { kind: string; verifiedAt: string | null }) => c.kind === 'registration' && !c.verifiedAt);
    await call(owner.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials/${newest.credentialId}/verify`);
    const after = (await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json();
    const registrations = after.credentials.filter((c: { kind: string }) => c.kind === 'registration');
    expect(registrations.map((c: { expiresOn: string; withdrawalReason: string | null; counts: boolean }) => [c.expiresOn, c.withdrawalReason, c.counts])).toEqual([
      ['2100-09-30', null, true],
      ['2099-09-30', 'replaced', false],
    ]);
  });

  it('lets a clinician withdraw an unchecked credential, but only a manager a checked one', async () => {
    const { tenantId, owner, doctor, clinicianId } = await credentialed();
    await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, { ...registration, reference: 'MED0000000002' });
    const credentials = (await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json().credentials;
    const unchecked = credentials.find((c: { verifiedAt: string | null }) => !c.verifiedAt);
    const checked = credentials.find((c: { kind: string; verifiedAt: string | null }) => c.kind === 'indemnity');
    const url = (id: string) => `/clinicians/${clinicianId}/credentials/${id}/withdraw`;
    expect((await call(doctor.email, tenantId, 'POST', url(unchecked.credentialId), { reason: 'entered_in_error' })).statusCode).toBe(200);
    expect((await call(doctor.email, tenantId, 'POST', url(checked.credentialId), { reason: 'no_longer_held' })).json().error.code).toBe('credential_verified');
    const byOwner = await call(owner.email, tenantId, 'POST', url(checked.credentialId), { reason: 'no_longer_held' });
    expect(byOwner.json().standing.reasons).toEqual(['indemnity_missing']);
  });

  it('blocks a registration with conditions until someone else reviews them', async () => {
    const { tenantId, owner, doctor, clinicianId } = await credentialed();
    await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials`, { ...registration, conditions: 'Must practise under supervision' });
    const added = (await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json();
    const withConditions = added.credentials.find((c: { conditions: string | null }) => c.conditions);
    const verified = await call(owner.email, tenantId, 'POST', `/clinicians/${clinicianId}/credentials/${withConditions.credentialId}/verify`);
    expect(verified.json().standing.reasons).toEqual(['registration_conditions_unreviewed']);
    const url = `/clinicians/${clinicianId}/credentials/${withConditions.credentialId}/review-conditions`;
    expect((await call(doctor.email, tenantId, 'POST', url)).statusCode).toBe(403);
    expect((await call(owner.email, tenantId, 'POST', url)).json().standing.mayConsult).toBe(true);
  });

  it("refuses a credential that doesn't fit the profession (WRK1)", async () => {
    const { tenantId, doctor, clinicianId } = await clinic();
    const url = `/clinicians/${clinicianId}/credentials`;
    expect((await call(doctor.email, tenantId, 'POST', url, { ...registration, registeringBody: 'dietitians_australia' })).json().error.code).toBe(
      'wrong_registering_body',
    );
    expect((await call(doctor.email, tenantId, 'POST', url, { kind: 'endorsement', endorsement: 'nurse_practitioner' })).json().error.code).toBe(
      'endorsement_not_for_profession',
    );
  });

  it('suspends a clinician at once and lets someone else lift it (WRK3)', async () => {
    const { tenantId, owner, doctor, clinicianId } = await credentialed();
    const suspended = await call(owner.email, tenantId, 'POST', `/clinicians/${clinicianId}/suspend`, { reason: 'registration_concern' });
    expect(suspended.json()).toMatchObject({ suspension: { reason: 'registration_concern' }, standing: { mayConsult: false, reasons: ['suspended'] } });
    expect((await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/resume`)).statusCode).toBe(403);
    const resumed = await call(owner.email, tenantId, 'POST', `/clinicians/${clinicianId}/resume`);
    expect(resumed.json()).toMatchObject({ suspension: null, standing: { mayConsult: true } });
  });

  it("refuses making a staff member a clinician twice, or one whose access is paused", async () => {
    const { tenantId, owner, doctor, support } = await clinic();
    const again = await call(owner.email, tenantId, 'POST', '/clinicians', { membershipId: doctor.membershipId, profession: 'registered_nurse', timeZone: 'Australia/Sydney' });
    expect(again.json().error.code).toBe('already_a_clinician');
    await admin.query("update platform.memberships set status = 'suspended' where id = $1", [support.membershipId]);
    const paused = await call(owner.email, tenantId, 'POST', '/clinicians', { membershipId: support.membershipId, profession: 'registered_nurse', timeZone: 'Australia/Sydney' });
    expect(paused.json().error.code).toBe('membership_inactive');
  });
});

describe('working hours and time off (WRK6, WRK7)', () => {
  it('replaces the week as a whole, and refuses overlapping blocks', async () => {
    const { tenantId, doctor, clinicianId } = await clinic();
    const url = `/clinicians/${clinicianId}/hours`;
    const week = { hours: [{ weekday: 1, startsAt: '09:00', endsAt: '12:00' }, { weekday: 1, startsAt: '13:00', endsAt: '17:00', slotMinutes: 20 }] };
    const set = await call(doctor.email, tenantId, 'PUT', url, week);
    expect(set.json().hours).toEqual([
      { weekday: 1, startsAt: '09:00', endsAt: '12:00', slotMinutes: 15 },
      { weekday: 1, startsAt: '13:00', endsAt: '17:00', slotMinutes: 20 },
    ]);
    const overlap = await call(doctor.email, tenantId, 'PUT', url, { hours: [{ weekday: 2, startsAt: '09:00', endsAt: '12:00' }, { weekday: 2, startsAt: '11:00', endsAt: '13:00' }] });
    expect(overlap.json().error.code).toBe('hours_overlap');
    expect((await call(doctor.email, tenantId, 'PUT', url, { hours: [] })).json().hours).toEqual([]);
  });

  it("doesn't let one clinician change another's hours", async () => {
    const { tenantId, owner, clinicianId } = await clinic();
    const nurse = await createUser();
    const membershipId = await addMember(tenantId, nurse.id, 'clinician');
    await call(owner.email, tenantId, 'POST', '/clinicians', { membershipId, profession: 'registered_nurse', timeZone: 'Australia/Sydney' });
    const reply = await call(nurse.email, tenantId, 'PUT', `/clinicians/${clinicianId}/hours`, { hours: [] });
    expect(reply.statusCode).toBe(403);
  });

  it('adds time off and takes it away again', async () => {
    const { tenantId, doctor, clinicianId } = await clinic();
    const added = await call(doctor.email, tenantId, 'POST', `/clinicians/${clinicianId}/time-off`, {
      startsAt: '2099-01-05T00:00:00+08:00',
      endsAt: '2099-01-10T00:00:00+08:00',
      reason: 'leave',
    });
    expect(added.statusCode).toBe(201);
    const { timeOffId } = added.json();
    expect((await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json().timeOff).toHaveLength(1);
    expect((await call(doctor.email, tenantId, 'DELETE', `/clinicians/${clinicianId}/time-off/${timeOffId}`)).json()).toEqual({ removed: true });
    expect((await call(doctor.email, tenantId, 'GET', `/clinicians/${clinicianId}`)).json().timeOff).toEqual([]);
  });
});

describe('tenant isolation of the workforce tables (ADR 0006)', () => {
  it("can't read, change or delete another tenant's clinicians, credentials, hours or time off", async () => {
    const a = await credentialed();
    await call(a.doctor.email, a.tenantId, 'PUT', `/clinicians/${a.clinicianId}/hours`, { hours: [{ weekday: 3, startsAt: '09:00', endsAt: '10:00' }] });
    await call(a.doctor.email, a.tenantId, 'POST', `/clinicians/${a.clinicianId}/time-off`, { startsAt: '2099-02-01T00:00:00Z', endsAt: '2099-02-02T00:00:00Z', reason: 'training' });
    const b = await tenantWith('owner');
    const owner = b.members[0]!;
    expect((await call(owner.email, b.tenantId, 'GET', `/clinicians/${a.clinicianId}`)).statusCode).toBe(404);
    const seen = await withTenant({ tenantId: b.tenantId, actor: { type: 'person', userId: owner.id }, requestId: 'test' }, async (tx) => {
      const counts = [];
      for (const table of ['clinicians', 'clinician_credentials', 'clinician_hours', 'clinician_time_off']) {
        const read = await tx.db.execute(sql.raw(`select 1 from operational.${table}`));
        counts.push(read.rows.length);
      }
      const changed = await tx.db.execute(sql`update operational.clinicians set time_zone = 'UTC' where id = ${a.clinicianId}`);
      const deleted = await tx.db.execute(sql`delete from operational.clinician_hours where clinician_id = ${a.clinicianId}`);
      return { counts, changed: changed.rowCount, deleted: deleted.rowCount };
    });
    expect(seen).toEqual({ counts: [0, 0, 0, 0], changed: 0, deleted: 0 });
  });
});
