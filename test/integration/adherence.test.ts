import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { adherenceActivity, adherenceFlags } from '../../src/db/schema/index.js';
import { withTenant } from '../../src/db/tenant.js';
import { openFlagsOf } from '../../src/modules/adherence/index.js';
import { reportSideEffect } from '../../src/modules/tracking/index.js';
import { headers, patientSignIn, testApp } from '../support/app.js';
import { acceptingBrand, addMember, admin, createTenant, createUser } from '../support/db.js';

/**
 * The adherence activity stream and adherence flags (docs/decisions/adherence.md,
 * ADR 0260). Made-up people only; the side effect words are made up too.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const adult = { givenName: 'Sam', familyName: 'Example', dateOfBirth: '1985-07-01', sex: 'not_stated' } as const;

async function patientIn(tenantId: string, subject = `user_${randomUUID()}`) {
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, tenantId), payload: { ...adult, brandId: await acceptingBrand(tenantId) } });
  expect(reply.statusCode).toBe(201);
  const as = headers(token, tenantId);
  return {
    patientId: reply.json().patientId as string,
    post: (url: string, payload?: object) => app.inject({ method: 'POST', url, headers: as, ...(payload ? { payload } : {}) }),
  };
}

const activityKinds = async (patientId: string) =>
  (await admin.query('select kind, source_table, opened_on from clinical.adherence_activity where patient_id = $1 order by occurred_at, kind', [patientId])).rows;
const flagsOf = async (patientId: string) =>
  (await admin.query('select id, kind, urgency, status, side_effect_id from clinical.adherence_flags where patient_id = $1 order by raised_at', [patientId])).rows;

describe('the activity stream (ADH1, ADH2)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);

  it("records the patient's own readings, side effects and check-ins, each pointing at its record", async () => {
    await sam.post('/v1/patient/measurements', { readings: [{ kind: 'weight', value: 91.2 }, { kind: 'waist', value: 101 }] });
    await sam.post('/v1/patient/side-effects', { severity: 'mild', description: 'Made-up words' });
    await sam.post('/v1/patient/check-ins', { missedDoses: 'none', feeling: 4 });
    expect(await activityKinds(sam.patientId)).toEqual([
      { kind: 'measurement_recorded', source_table: 'clinical.measurements', opened_on: null },
      { kind: 'side_effect_reported', source_table: 'clinical.side_effects', opened_on: null },
      { kind: 'check_in_submitted', source_table: 'clinical.check_ins', opened_on: null },
    ]);
    const audited = await admin.query("select details from platform.audit_log where action = 'adherence_activity.recorded' and details->>'patientId' = $1", [sam.patientId]);
    expect(audited.rows.map((row) => Object.keys(row.details).sort())).toEqual([['kind', 'patientId'], ['kind', 'patientId'], ['kind', 'patientId']]);
  });

  it('counts opening the app once a day, on the patient’s calendar, and answers the same each time', async () => {
    const first = await sam.post('/v1/patient/activity/app-opened');
    const second = await sam.post('/v1/patient/activity/app-opened');
    expect(first.statusCode).toBe(200);
    expect(second.json()).toEqual(first.json());
    const opened = (await activityKinds(sam.patientId)).filter((row) => row.kind === 'app_opened');
    expect(opened).toHaveLength(1);
    expect(first.json().openedOn).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('writes no activity for what a staff member does for the patient', async () => {
    const staff = await createUser();
    await addMember(tenantId, staff.id, 'clinician');
    const before = (await activityKinds(sam.patientId)).length;
    await withTenant({ tenantId, actor: { type: 'person', userId: staff.id }, requestId: 'test' }, (tx) =>
      reportSideEffect(tx, { patientId: sam.patientId, severity: 'mild', description: 'Made-up words' }),
    );
    expect(await activityKinds(sam.patientId)).toHaveLength(before);
  });

  it('refuses to change or remove activity, for every role (ADR 0028)', async () => {
    const changed = await admin.query("update clinical.adherence_activity set kind = 'order_placed' where patient_id = $1", [sam.patientId]).catch((error: unknown) => error);
    expect(changed).toBeInstanceOf(Error);
    const removed = await admin.query('delete from clinical.adherence_activity where patient_id = $1', [sam.patientId]).catch((error: unknown) => error);
    expect(removed).toBeInstanceOf(Error);
  });
});

describe('adherence flags from side effects (ADH4, ADH5)', async () => {
  const tenantId = await createTenant();
  const sam = await patientIn(tenantId);

  it('raises an urgent flag for a severe report, a soon one for moderate, and none for mild', async () => {
    const severe = (await sam.post('/v1/patient/side-effects', { severity: 'severe', description: 'Made-up words' })).json();
    const moderate = (await sam.post('/v1/patient/check-ins', { missedDoses: 'some', feeling: 2, sideEffect: { severity: 'moderate', description: 'Made-up words' } })).json();
    await sam.post('/v1/patient/side-effects', { severity: 'mild', description: 'Made-up words' });
    expect((await flagsOf(sam.patientId)).map(({ kind, urgency, status, side_effect_id }) => ({ kind, urgency, status, side_effect_id }))).toEqual([
      { kind: 'side_effect_reported', urgency: 'urgent', status: 'open', side_effect_id: severe.sideEffectId },
      { kind: 'side_effect_reported', urgency: 'soon', status: 'open', side_effect_id: moderate.sideEffect.sideEffectId },
    ]);
  });

  it('carries ids, the kind and the urgency only in its audit entry and event', async () => {
    const [flag] = await flagsOf(sam.patientId);
    const event = await admin.query("select payload from platform.outbox where type = 'adherence_flag.raised' and record_id = $1", [flag.id]);
    expect(event.rows).toEqual([{ payload: { patientId: sam.patientId, kind: 'side_effect_reported', urgency: 'urgent' } }]);
    const audited = await admin.query("select details from platform.audit_log where action = 'adherence_flag.raised' and record_id = $1", [flag.id]);
    expect(audited.rows).toEqual([{ details: { patientId: sam.patientId, kind: 'side_effect_reported', urgency: 'urgent' } }]);
  });

  it('raises the flag when a staff member records the report for the patient', async () => {
    const staff = await createUser();
    await addMember(tenantId, staff.id, 'clinician');
    const reported = await withTenant({ tenantId, actor: { type: 'person', userId: staff.id }, requestId: 'test' }, (tx) =>
      reportSideEffect(tx, { patientId: sam.patientId, severity: 'severe', description: 'Made-up words' }),
    );
    expect((await flagsOf(sam.patientId)).some((flag) => flag.side_effect_id === reported.sideEffectId && flag.urgency === 'urgent')).toBe(true);
  });

  it('keeps one flag per report: a second for the same report is refused', async () => {
    const [flag] = await flagsOf(sam.patientId);
    const again = await admin
      .query("insert into clinical.adherence_flags (tenant_id, patient_id, kind, urgency, side_effect_id) values ($1, $2, 'side_effect_reported', 'urgent', $3)", [tenantId, sam.patientId, flag.side_effect_id])
      .catch((error: unknown) => error);
    expect(again).toBeInstanceOf(Error);
  });

  it('tells the care coordinator what is open, urgent first, without the words (ADH8)', async () => {
    const open = await withTenant({ tenantId, actor: { type: 'agent', agentId: randomUUID() }, requestId: 'test' }, (tx) => openFlagsOf(tx, sam.patientId));
    expect(open.map((flag) => flag.urgency)).toEqual(['urgent', 'urgent', 'soon']);
    expect(Object.keys(open[0]!).sort()).toEqual(['adherenceFlagId', 'kind', 'raisedAt', 'urgency']);
    const audited = await admin.query("select details from platform.audit_log where action = 'adherence_flag.read' and record_id = $1", [sam.patientId]);
    expect(audited.rows.at(-1)?.details).toEqual({ count: 3 });
  });

  it('refuses a flag that is raised resolved, or a resolution that is undone (ADH7)', async () => {
    const [flag] = await flagsOf(sam.patientId);
    const raisedResolved = await admin
      .query("insert into clinical.adherence_flags (tenant_id, patient_id, kind, urgency, side_effect_id, status) values ($1, $2, 'side_effect_reported', 'urgent', $3, 'resolved')", [tenantId, sam.patientId, flag.side_effect_id])
      .catch((error: unknown) => error);
    expect(raisedResolved).toBeInstanceOf(Error);
    const staff = await createUser();
    await admin.query("update clinical.adherence_flags set status = 'resolved', resolved_at = now(), resolved_by = $2, outcome = 'contacted_patient' where id = $1", [flag.id, staff.id]);
    const undone = await admin
      .query("update clinical.adherence_flags set status = 'open', resolved_at = null, resolved_by = null, outcome = null where id = $1", [flag.id])
      .catch((error: unknown) => error);
    expect(undone).toBeInstanceOf(Error);
    const rewritten = await admin.query("update clinical.adherence_flags set outcome = 'no_action_needed' where id = $1", [flag.id]).catch((error: unknown) => error);
    expect(rewritten).toBeInstanceOf(Error);
  });
});

describe('tenancy (ADR 0006)', async () => {
  const tenantId = await createTenant();
  const otherTenantId = await createTenant();
  const sam = await patientIn(tenantId);
  await sam.post('/v1/patient/side-effects', { severity: 'severe', description: 'Made-up words' });
  await sam.post('/v1/patient/activity/app-opened');

  it("another tenant can't read, change or delete the rows", async () => {
    const other = { tenantId: otherTenantId, actor: { type: 'system' } as const, requestId: 'test' };
    const seen = await withTenant(other, async (tx) => ({ activity: await tx.db.select().from(adherenceActivity), flags: await tx.db.select().from(adherenceFlags) }));
    expect(seen).toEqual({ activity: [], flags: [] });
    const changed = await withTenant(other, (tx) => tx.db.update(adherenceFlags).set({ outcome: 'no_action_needed' }).returning());
    expect(changed).toEqual([]);
    const removed = await withTenant(other, (tx) => tx.db.delete(adherenceFlags).returning()).catch((error: unknown) => error);
    expect(removed).toBeInstanceOf(Error);
    expect((await flagsOf(sam.patientId)).map((flag) => flag.urgency)).toEqual(['urgent']);
  });
});
