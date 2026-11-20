import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { findQualifyingConsult, listQualifyingConsults, type Participant } from '../../src/modules/consults/index.js';
import { testApp } from '../support/app.js';
import { bookConsult, createPatient, createPrescriber, heldConsult, playVideo, postVideoWebhook, videoAuthorization, videoEvent } from '../support/consults.js';
import { addMember, admin, createTenant, createUser } from '../support/db.js';

/**
 * The consult gate and consult evidence (ADR 0009, docs/decisions/consults.md).
 * Evidence comes only from signed video server callbacks. Made-up people only.
 */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });
const gate = (tenantId: string, input: { patientId: string; clinicianUserId: string; at?: Date }) => withTenant(system(tenantId), (tx) => findQualifyingConsult(tx, input));
const minutesAgo = (minutes: number) => new Date(Math.floor((Date.now() - minutes * 60_000) / 1000) * 1000);

async function clinic() {
  const tenantId = await createTenant();
  const patientId = await createPatient(tenantId);
  const doctor = await createPrescriber(tenantId);
  const patient: Participant = { party: 'patient', patientId };
  const clinician: Participant = { party: 'clinician', userId: doctor.userId };
  return { tenantId, patientId, doctor, patient, clinician };
}

async function lastGateAudit(tenantId: string) {
  const { rows } = await admin.query("select details from platform.audit_log where tenant_id = $1 and action = 'consult.gate_checked' order by id desc limit 1", [tenantId]);
  return rows[0]?.details;
}

describe('the consult gate (CNS1 to CNS6)', () => {
  it('lets a script follow a video consult of at least 60 seconds together, and audits the check', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    const from = minutesAgo(30);
    const consultId = await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, from, seconds: 60 });
    const found = await gate(tenantId, { patientId, clinicianUserId: doctor.userId });
    expect(found).toEqual({
      consultId,
      mode: 'video',
      startedAt: from,
      endedAt: new Date(from.getTime() + 60_000),
      qualifiedAt: new Date(from.getTime() + 60_000),
      usableUntil: new Date(from.getTime() + 60_000 + 24 * 3_600_000),
    });
    expect(await lastGateAudit(tenantId)).toEqual({ clinicianUserId: doctor.userId, found: true, consultId, reason: null });
    const consult = await admin.query('select status, started_at, ended_at from clinical.consults where id = $1', [consultId]);
    expect(consult.rows[0]).toEqual({ status: 'completed', started_at: from, ended_at: new Date(from.getTime() + 60_000) });
    const events = await admin.query('select type, payload from platform.outbox where tenant_id = $1 order by id', [tenantId]);
    expect(events.rows.map((r) => r.type)).toEqual(['consult.started', 'consult.completed']);
    expect(events.rows[0].payload).toMatchObject({ patientId, consultId });
  });

  it('refuses 59 seconds, and says why only in the audit entry', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, seconds: 59 });
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId })).toBeNull();
    expect(await lastGateAudit(tenantId)).toMatchObject({ found: false, reason: 'too_short' });
  });

  it('adds the time from a dropped call and its reconnection', async () => {
    const { tenantId, patientId, doctor, patient, clinician } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    const t = minutesAgo(20).getTime();
    const at = (seconds: number) => new Date(t + seconds * 1000);
    await playVideo(app, tenantId, consultId, [
      { kind: 'participant_joined', who: patient, at: at(0) },
      { kind: 'participant_joined', who: clinician, at: at(0) },
      { kind: 'participant_connection_aborted', who: patient, at: at(30) },
      { kind: 'participant_joined', who: patient, at: at(100) },
      { kind: 'participant_left', who: clinician, at: at(130) },
    ]);
    expect((await gate(tenantId, { patientId, clinicianUserId: doctor.userId }))?.qualifiedAt).toEqual(at(130));
  });

  it('counts nothing until someone leaves or the room closes: a lost disconnect never qualifies (CNS4)', async () => {
    const { tenantId, patientId, doctor, patient, clinician } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    await playVideo(app, tenantId, consultId, [
      { kind: 'participant_joined', who: patient, at: minutesAgo(60) },
      { kind: 'participant_joined', who: clinician, at: minutesAgo(60) },
    ]);
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId })).toBeNull();
    const consult = await admin.query('select status from clinical.consults where id = $1', [consultId]);
    expect(consult.rows[0].status).toBe('in_progress');
  });

  it('is usable until exactly 24 hours after they were last together', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    const from = minutesAgo(10);
    await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, from, seconds: 120 });
    const end = from.getTime() + 120_000 + 24 * 3_600_000;
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId, at: new Date(end) })).not.toBeNull();
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId, at: new Date(end + 1) })).toBeNull();
    expect(await lastGateAudit(tenantId)).toMatchObject({ found: false, reason: 'no_consult' });
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId, at: new Date(from.getTime() + 60_000) })).toBeNull();
  });

  it('never qualifies a cancelled or no-show consult, whatever the evidence says', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    const consultId = await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId });
    for (const status of ['cancelled', 'no_show']) {
      await admin.query('update clinical.consults set status = $2, ended_at = null where id = $1', [consultId, status]);
      expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId })).toBeNull();
    }
  });

  it('belongs to that patient and that clinician: a second clinician in the room proves nothing', async () => {
    const { tenantId, patientId, doctor, patient } = await clinic();
    const other = await createPrescriber(tenantId);
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    const visitor: Participant = { party: 'clinician', userId: other.userId };
    await playVideo(app, tenantId, consultId, [
      { kind: 'participant_joined', who: patient, at: minutesAgo(20) },
      { kind: 'participant_joined', who: visitor, at: minutesAgo(20) },
      { kind: 'participant_left', who: visitor, at: minutesAgo(10) },
      { kind: 'room_finished', at: minutesAgo(10) },
    ]);
    expect(await gate(tenantId, { patientId, clinicianUserId: other.userId })).toBeNull();
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId })).toBeNull();
    const rows = await admin.query('select party from clinical.consult_evidence where consult_id = $1 order by id', [consultId]);
    expect(rows.rows.map((r) => r.party)).toEqual(['patient', 'patient', 'clinician']);

    await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId });
    const somebodyElse = await createPatient(tenantId);
    expect(await gate(tenantId, { patientId: somebodyElse, clinicianUserId: doctor.userId })).toBeNull();
  });

  it('needs the clinician to be a prescriber in good standing when the script is written', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId });
    const director = await createUser();
    await admin.query("update operational.clinicians set suspended_at = now(), suspension_reason = 'registration_concern', suspended_by = $2 where id = $1", [doctor.clinicianId, director.id]);
    expect(await gate(tenantId, { patientId, clinicianUserId: doctor.userId })).toBeNull();
    expect(await lastGateAudit(tenantId)).toMatchObject({ found: false, reason: 'not_a_prescriber' });
  });

  it('lists every qualifying consult for a reviewer, newest first, whatever the window', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    const old = await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, from: minutesAgo(3 * 24 * 60) });
    const recent = await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, from: minutesAgo(30) });
    await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId, seconds: 20 });
    const listed = await withTenant(system(tenantId), (tx) => listQualifyingConsults(tx, { patientId }));
    expect(listed.map((c) => c.consultId)).toEqual([recent, old]);
  });
});

describe('consult evidence (CNS2, CNS5, CNS7)', () => {
  it('stores a duplicate callback once, and works from provider times when callbacks arrive out of order', async () => {
    const { tenantId, patientId, doctor, patient, clinician } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    const from = minutesAgo(15);
    const to = new Date(from.getTime() + 90_000);
    const steps = [
      { kind: 'participant_left', who: patient, at: to, id: 'EV_left' },
      { kind: 'participant_left', who: patient, at: to, id: 'EV_left' },
      { kind: 'participant_joined', who: clinician, at: from },
      { kind: 'participant_joined', who: patient, at: from },
    ] as const;
    await playVideo(app, tenantId, consultId, [...steps]);
    const rows = await admin.query('select count(*)::int as n from clinical.consult_evidence where consult_id = $1', [consultId]);
    expect(rows.rows[0].n).toBe(3);
    expect((await gate(tenantId, { patientId, clinicianUserId: doctor.userId }))?.qualifiedAt).toEqual(to);
  });

  it('refuses a callback without the video server’s signature, and stores nothing', async () => {
    const { tenantId, patientId, doctor, patient } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    const event = videoEvent(tenantId, consultId, { kind: 'participant_joined', who: patient, at: minutesAgo(1) });
    const forged = await postVideoWebhook(app, event, { authorization: await videoAuthorization(JSON.stringify(event), 'not-the-secret-not-the-secret-xx') });
    const tampered = await postVideoWebhook(app, event, { body: JSON.stringify({ ...event, createdAt: '1' }) });
    const unsigned = await postVideoWebhook(app, event, { authorization: '' });
    expect([forged.statusCode, tampered.statusCode, unsigned.statusCode]).toEqual([403, 403, 403]);
    const stored = await admin.query('select count(*)::int as n from platform.webhook_inbox where tenant_id = $1', [tenantId]);
    expect(stored.rows[0].n).toBe(0);
  });

  it('answers and drops callbacks that can’t be evidence: other rooms, other events, unknown tenants', async () => {
    const { tenantId, patientId, doctor, patient } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    const joined = videoEvent(tenantId, consultId, { kind: 'participant_joined', who: patient, at: minutesAgo(1) }) as Record<string, unknown>;
    const replies = [
      await postVideoWebhook(app, { ...joined, room: { name: 'lobby' } }),
      await postVideoWebhook(app, { ...joined, event: 'track_published' }),
      await postVideoWebhook(app, videoEvent('00000000-0000-4000-8000-000000000000', consultId, { kind: 'participant_joined', who: patient, at: minutesAgo(1) })),
    ];
    expect(replies.map((r) => [r.statusCode, r.json().stored])).toEqual([
      [200, false],
      [200, false],
      [200, false],
    ]);
  });

  it('makes no evidence from a provider time ahead of when the callback arrived', async () => {
    const { tenantId, patientId, doctor, patient } = await clinic();
    const consultId = await bookConsult(tenantId, { patientId, clinicianUserId: doctor.userId });
    await playVideo(app, tenantId, consultId, [{ kind: 'participant_joined', who: patient, at: new Date(Date.now() + 5 * 60_000) }]);
    const rows = await admin.query('select count(*)::int as n from clinical.consult_evidence where consult_id = $1', [consultId]);
    expect(rows.rows[0].n).toBe(0);
  });

  it('never changes or removes evidence, or the delivery behind it, whoever asks', async () => {
    const { tenantId, patientId, doctor } = await clinic();
    const consultId = await heldConsult(app, tenantId, { patientId, clinicianUserId: doctor.userId });
    await expect(withTenant(system(tenantId), (tx) => tx.db.execute(sql`update clinical.consult_evidence set at = now() where consult_id = ${consultId}`))).rejects.toThrow();
    await expect(withTenant(system(tenantId), (tx) => tx.db.execute(sql`delete from clinical.consult_evidence where consult_id = ${consultId}`))).rejects.toThrow();
    await expect(admin.query('update clinical.consult_evidence set at = now() where consult_id = $1', [consultId])).rejects.toThrow(/never changed/);
    await expect(admin.query('delete from clinical.consult_evidence where consult_id = $1', [consultId])).rejects.toThrow(/never changed/);
    await expect(admin.query('delete from platform.webhook_inbox where tenant_id = $1', [tenantId])).rejects.toThrow(/foreign key/);
  });

  it("can't read, change or delete another tenant's consults or evidence", async () => {
    const a = await clinic();
    const consultId = await heldConsult(app, a.tenantId, { patientId: a.patientId, clinicianUserId: a.doctor.userId });
    const b = await createTenant();
    const seen = await withTenant(system(b), async (tx) => ({
      consults: (await tx.db.execute(sql`select id from clinical.consults`)).rows,
      evidence: (await tx.db.execute(sql`select id from clinical.consult_evidence`)).rows,
      changed: (await tx.db.execute(sql`update clinical.consults set status = 'cancelled', ended_at = null where id = ${consultId}`)).rowCount,
    }));
    expect(seen).toEqual({ consults: [], evidence: [], changed: 0 });
    await expect(withTenant(system(b), (tx) => tx.db.execute(sql`delete from clinical.consults where id = ${consultId}`))).rejects.toThrow();
    expect(await gate(b, { patientId: a.patientId, clinicianUserId: a.doctor.userId })).toBeNull();
  });

  it("can't book a consult with someone outside the tenant", async () => {
    const { tenantId, patientId } = await clinic();
    const stranger = await createUser();
    await addMember(await createTenant(), stranger.id, 'prescriber');
    await expect(bookConsult(tenantId, { patientId, clinicianUserId: stranger.id })).rejects.toThrow(/foreign key/);
  });
});
