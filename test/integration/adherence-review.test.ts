import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { resolveAdherenceFlag } from '../../src/modules/adherence/review.service.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/**
 * The care team's adherence flags: the list, one flag, resolving and
 * reopening (docs/decisions/adherence.md ADH7 to ADH10). Made-up people and
 * made-up words only.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const call = async (method: 'GET' | 'POST', url: string, email: string, tenantId: string, payload?: object) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

async function patientWith(tenantId: string, givenName: string, severities: ('severe' | 'moderate' | 'mild')[]) {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const as = headers(token, tenantId);
  const created = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: as, payload: { givenName, familyName: 'Example', dateOfBirth: '1985-07-01', sex: 'not_stated' } });
  expect(created.statusCode).toBe(201);
  const sideEffectIds: string[] = [];
  for (const severity of severities) {
    const reply = await app.inject({ method: 'POST', url: '/v1/patient/side-effects', headers: as, payload: { severity, description: `Made-up ${severity} words` } });
    sideEffectIds.push(reply.json().sideEffectId);
  }
  return { patientId: created.json().patientId as string, sideEffectIds };
}

describe('the list and one adherence flag (ADH9, ADH10)', async () => {
  const { tenantId, members } = await tenantWith('clinician', 'support', 'owner');
  const [clinician, support, owner] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];
  const sam = await patientWith(tenantId, 'Sam', ['moderate']);
  const alex = await patientWith(tenantId, 'Alex', ['severe', 'mild']);

  it('lists open flags urgent first, with the patient’s name and never their words', async () => {
    const reply = await call('GET', '/v1/adherence/flags', clinician.email, tenantId);
    expect(reply.statusCode).toBe(200);
    const listed = reply.json().adherenceFlags;
    expect(listed.map((flag: { patientName: string; urgency: string }) => [flag.patientName, flag.urgency])).toEqual([
      ['Alex Example', 'urgent'],
      ['Sam Example', 'soon'],
    ]);
    expect(JSON.stringify(listed)).not.toContain('Made-up');
    const audited = await admin.query("select details from platform.audit_log where action = 'adherence_flag.listed' and tenant_id = $1", [tenantId]);
    expect(audited.rows).toEqual([{ details: { status: 'open', count: 2 } }]);
  });

  it('shows the patient’s words behind a flag only in an audited read of the report', async () => {
    const [flag] = (await call('GET', '/v1/adherence/flags', clinician.email, tenantId)).json().adherenceFlags;
    const report = await call('GET', `/v1/side-effects/${flag.sideEffectId}`, clinician.email, tenantId);
    expect(report.json()).toMatchObject({ patientId: alex.patientId, severity: 'severe', description: 'Made-up severe words', reportedBy: 'patient' });
    const audited = await admin.query("select details from platform.audit_log where action = 'side_effect.read' and record_id = $1", [flag.sideEffectId]);
    expect(audited.rows).toEqual([{ details: { patientId: alex.patientId } }]);
  });

  it('is for a clinical role: support is refused, and the owner needs break-glass (ADR 0036)', async () => {
    expect((await call('GET', '/v1/adherence/flags', support.email, tenantId)).statusCode).toBe(403);
    expect((await call('GET', `/v1/side-effects/${sam.sideEffectIds[0]}`, support.email, tenantId)).statusCode).toBe(403);
    expect((await call('GET', '/v1/adherence/flags', owner.email, tenantId)).json().error.code).toBe('break_glass_required');
  });
});

describe('resolving and reopening (ADH7)', async () => {
  const { tenantId, members } = await tenantWith('clinician');
  const clinician = members[0]!;
  const sam = await patientWith(tenantId, 'Sam', ['severe']);
  const [open] = (await call('GET', '/v1/adherence/flags', clinician.email, tenantId)).json().adherenceFlags;

  it('resolves with an outcome and a note, keeping the note out of the audit entry and the event', async () => {
    const reply = await call('POST', `/v1/adherence/flags/${open.adherenceFlagId}/resolve`, clinician.email, tenantId, { outcome: 'contacted_patient', note: 'Made-up note' });
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ status: 'resolved', resolution: { outcome: 'contacted_patient', note: 'Made-up note', resolvedBy: { userId: clinician.id } } });
    const audited = await admin.query("select details from platform.audit_log where action = 'adherence_flag.resolved' and record_id = $1", [open.adherenceFlagId]);
    expect(audited.rows).toEqual([{ details: { patientId: sam.patientId, kind: 'side_effect_reported', outcome: 'contacted_patient', withNote: true } }]);
    const event = await admin.query("select payload from platform.outbox where type = 'adherence_flag.resolved' and record_id = $1", [open.adherenceFlagId]);
    expect(JSON.stringify(event.rows)).not.toContain('Made-up');
    const listed = (await call('GET', '/v1/adherence/flags?status=resolved', clinician.email, tenantId)).json().adherenceFlags;
    expect(listed).toMatchObject([{ adherenceFlagId: open.adherenceFlagId, resolution: { outcome: 'contacted_patient' } }]);
    expect(listed[0].resolution.note).toBeUndefined();
  });

  it('refuses to resolve it again', async () => {
    const again = await call('POST', `/v1/adherence/flags/${open.adherenceFlagId}/resolve`, clinician.email, tenantId, { outcome: 'no_action_needed' });
    expect(again.statusCode).toBe(409);
    expect(again.json().error.code).toBe('already_resolved');
  });

  it('reopens as a new open flag for the same report, showing the earlier resolution, once', async () => {
    const reopened = await call('POST', `/v1/adherence/flags/${open.adherenceFlagId}/reopen`, clinician.email, tenantId);
    expect(reopened.statusCode).toBe(201);
    expect(reopened.json()).toMatchObject({
      status: 'open',
      urgency: 'urgent',
      sideEffectId: sam.sideEffectIds[0],
      reopenedFromId: open.adherenceFlagId,
      resolution: null,
      reopenedFrom: { outcome: 'contacted_patient', note: 'Made-up note' },
    });
    const twice = await call('POST', `/v1/adherence/flags/${open.adherenceFlagId}/reopen`, clinician.email, tenantId);
    expect(twice.json().error.code).toBe('already_reopened');
    const notResolved = await call('POST', `/v1/adherence/flags/${reopened.json().adherenceFlagId}/reopen`, clinician.email, tenantId);
    expect(notResolved.json().error.code).toBe('not_resolved');
    const { rows } = await admin.query('select status, outcome from clinical.adherence_flags where id = $1', [open.adherenceFlagId]);
    expect(rows).toEqual([{ status: 'resolved', outcome: 'contacted_patient' }]);
  });

  it('refuses an agent, whatever its role (ADH8)', async () => {
    const [next] = (await call('GET', '/v1/adherence/flags', clinician.email, tenantId)).json().adherenceFlags;
    const refused = await withTenant({ tenantId, actor: { type: 'agent', agentId: randomUUID() }, requestId: 'test' }, (tx) =>
      resolveAdherenceFlag(tx, next.adherenceFlagId, { outcome: 'no_action_needed' }),
    ).catch((error: unknown) => error);
    expect(refused).toMatchObject({ statusCode: 403 });
  });

  it("can't reach another tenant's flag", async () => {
    const other = await tenantWith('clinician');
    const [next] = (await call('GET', '/v1/adherence/flags', clinician.email, tenantId)).json().adherenceFlags;
    const reply = await call('POST', `/v1/adherence/flags/${next.adherenceFlagId}/resolve`, other.members[0]!.email, other.tenantId, { outcome: 'no_action_needed' });
    expect(reply.statusCode).toBe(404);
  });
});
