import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { checkIns, measurements, sideEffects } from '../../src/db/schema/index.js';
import { withTenant } from '../../src/db/tenant.js';
import { headers, patientSignIn, testApp } from '../support/app.js';
import { acceptingBrand, admin, createTenant } from '../support/db.js';

/**
 * Measurements, side effects and check-ins (docs/decisions/tracking.md).
 * Made-up people only; the side effect words are made up too.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const adult = { givenName: 'Sam', familyName: 'Example', dateOfBirth: '1985-07-01', sex: 'not_stated' } as const;

/** A patient with an account, signed in on a session that has confirmed the date of birth. */
async function patientIn(tenantId: string, subject = `user_${randomUUID()}`) {
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, brandId: await acceptingBrand(tenantId) } });
  expect(reply.statusCode).toBe(201);
  const as = headers(token, tenantId);
  return {
    patientId: reply.json().patientId as string,
    get: (url: string) => app.inject({ method: 'GET', url, headers: as }),
    post: (url: string, payload: object) => app.inject({ method: 'POST', url, headers: as, payload }),
  };
}

const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

describe('measurements (TRK1 to TRK3)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);

  it('records readings taken together, and lists them newest first in their units', async () => {
    const first = await sam.post('/v1/patient/measurements', { readings: [{ kind: 'weight', value: 92.4 }], measuredAt: minutesAgo(60 * 24) });
    expect(first.statusCode).toBe(201);
    const second = await sam.post('/v1/patient/measurements', {
      readings: [
        { kind: 'weight', value: 91.8 },
        { kind: 'blood_pressure_systolic', value: 128 },
        { kind: 'blood_pressure_diastolic', value: 82 },
      ],
    });
    expect(second.statusCode).toBe(201);
    const weights = (await sam.get('/v1/patient/measurements?kind=weight')).json().measurements;
    expect(weights.map((m: { value: number; unit: string; recordedBy: string }) => [m.value, m.unit, m.recordedBy])).toEqual([
      [91.8, 'kg', 'patient'],
      [92.4, 'kg', 'patient'],
    ]);
    expect((await sam.get('/v1/patient/measurements')).json().measurements).toHaveLength(4);
  });

  it('audits every write and read against the patient, as the patient', async () => {
    const written = await admin.query(
      "select actor_type, actor_id, details from platform.audit_log where action = 'measurement.recorded' and details->>'patientId' = $1",
      [sam.patientId],
    );
    expect(written.rowCount).toBe(4);
    expect(written.rows.every((row) => row.actor_type === 'patient' && row.actor_id === sam.patientId)).toBe(true);
    const read = await admin.query("select 1 from platform.audit_log where action = 'measurement.read' and record_id = $1", [sam.patientId]);
    expect(read.rowCount).toBeGreaterThan(0);
  });

  it.each([
    ['a reading out of range', { readings: [{ kind: 'weight', value: 920 }] }, 'out_of_range'],
    ['half a blood pressure', { readings: [{ kind: 'blood_pressure_systolic', value: 120 }] }, 'blood_pressure_pair'],
    ['blood pressure the wrong way round', { readings: [{ kind: 'blood_pressure_systolic', value: 70 }, { kind: 'blood_pressure_diastolic', value: 120 }] }, 'blood_pressure_order'],
    ['the same kind twice', { readings: [{ kind: 'waist', value: 100 }, { kind: 'waist', value: 101 }] }, 'duplicate_kind'],
    ['a reading in the future', { readings: [{ kind: 'waist', value: 100 }], measuredAt: minutesAgo(-60) }, 'measured_in_future'],
    ['a reading over 30 days old', { readings: [{ kind: 'waist', value: 100 }], measuredAt: minutesAgo(60 * 24 * 31) }, 'measured_too_long_ago'],
  ])('refuses %s, and writes nothing', async (_name, payload, code) => {
    const before = (await admin.query('select count(*)::int as n from clinical.measurements where patient_id = $1', [sam.patientId])).rows[0].n;
    const reply = await sam.post('/v1/patient/measurements', payload);
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error.code).toBe(code);
    expect((await admin.query('select count(*)::int as n from clinical.measurements where patient_id = $1', [sam.patientId])).rows[0].n).toBe(before);
  });
});

describe('side effects (TRK4)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);

  it('keeps the words in the record only: the audit entry and the event carry the severity', async () => {
    const reply = await sam.post('/v1/patient/side-effects', { severity: 'severe', description: 'Made-up words for a test', startedOn: null });
    expect(reply.statusCode).toBe(201);
    const { sideEffectId } = reply.json();
    const event = await admin.query("select payload from platform.outbox where type = 'side_effect.reported' and record_id = $1", [sideEffectId]);
    expect(event.rows).toEqual([{ payload: { patientId: sam.patientId, severity: 'severe' } }]);
    const audited = await admin.query("select details from platform.audit_log where action = 'side_effect.reported' and record_id = $1", [sideEffectId]);
    expect(audited.rows).toEqual([{ details: { patientId: sam.patientId, severity: 'severe' } }]);
    const listed = (await sam.get('/v1/patient/side-effects')).json().sideEffects;
    expect(listed).toMatchObject([{ sideEffectId, severity: 'severe', description: 'Made-up words for a test', reportedBy: 'patient' }]);
  });

  it('refuses a start date in the future, or a date that is not real', async () => {
    for (const startedOn of ['2999-01-01', '2026-02-31']) {
      const reply = await sam.post('/v1/patient/side-effects', { severity: 'mild', description: 'Made-up words', startedOn });
      expect(reply.json().error.code).toBe('started_on');
    }
  });
});

describe('check-ins (TRK5)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);

  it('writes the check-in with its readings and side effect, and lists them together', async () => {
    const reply = await sam.post('/v1/patient/check-ins', {
      missedDoses: 'some',
      feeling: 4,
      readings: [{ kind: 'weight', value: 88.2 }],
      sideEffect: { severity: 'mild', description: 'Made-up words' },
    });
    expect(reply.statusCode).toBe(201);
    const { checkInId } = reply.json();
    const [listed] = (await sam.get('/v1/patient/check-ins')).json().checkIns;
    expect(listed).toMatchObject({ checkInId, missedDoses: 'some', feeling: 4, measurements: [{ kind: 'weight', value: 88.2, checkInId }], sideEffect: { severity: 'mild', checkInId } });
  });

  it('writes nothing when any part is wrong', async () => {
    const before = (await admin.query('select count(*)::int as n from clinical.check_ins where patient_id = $1', [sam.patientId])).rows[0].n;
    const reply = await sam.post('/v1/patient/check-ins', { missedDoses: 'none', feeling: 3, readings: [{ kind: 'weight', value: 2000 }] });
    expect(reply.statusCode).toBe(400);
    expect((await admin.query('select count(*)::int as n from clinical.check_ins where patient_id = $1', [sam.patientId])).rows[0].n).toBe(before);
  });

  it('refuses a feeling outside 1 to 5', async () => {
    expect((await sam.post('/v1/patient/check-ins', { missedDoses: 'none', feeling: 6 })).statusCode).toBe(400);
  });
});

describe('only the patient sees their own', async () => {
  const tenantId = await createTenant();
  const otherTenantId = await createTenant();
  const sam = await patientIn(tenantId, 'user_tracking_owner');
  const alex = await patientIn(tenantId);
  // The same person as Sam, signed in at another tenant: a separate record there (IDN1).
  const samElsewhere = await patientIn(otherTenantId, 'user_tracking_owner');
  await sam.post('/v1/patient/measurements', { readings: [{ kind: 'waist', value: 104 }] });
  await sam.post('/v1/patient/side-effects', { severity: 'moderate', description: 'Made-up words' });
  await sam.post('/v1/patient/check-ins', { missedDoses: 'none', feeling: 5 });

  it("another patient of the same tenant sees none of Sam's", async () => {
    expect((await alex.get('/v1/patient/measurements')).json().measurements).toEqual([]);
    expect((await alex.get('/v1/patient/side-effects')).json().sideEffects).toEqual([]);
    expect((await alex.get('/v1/patient/check-ins')).json().checkIns).toEqual([]);
  });

  it("Sam's record in another tenant shows none of it", async () => {
    expect((await samElsewhere.get('/v1/patient/measurements')).json().measurements).toEqual([]);
    expect((await samElsewhere.get('/v1/patient/check-ins')).json().checkIns).toEqual([]);
  });

  it("another tenant can't read, change or delete the rows (ADR 0006)", async () => {
    const seen = await withTenant({ tenantId: otherTenantId, actor: { type: 'system' }, requestId: 'test' }, async (tx) => ({
      measurements: await tx.db.select().from(measurements),
      sideEffects: await tx.db.select().from(sideEffects),
      checkIns: await tx.db.select().from(checkIns),
    }));
    expect(seen).toEqual({ measurements: [], sideEffects: [], checkIns: [] });
    const changed = await withTenant({ tenantId: otherTenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) =>
      tx.db.update(measurements).set({ value: 1 }).returning(),
    ).catch((error: unknown) => error);
    // The API's role may not change a measurement at all (ADR 0028), let alone another tenant's.
    expect(changed).toBeInstanceOf(Error);
    const { rows } = await admin.query('select value from clinical.measurements where patient_id = $1', [sam.patientId]);
    expect(rows.map((row) => Number(row.value))).toEqual([104]);
  });
});
