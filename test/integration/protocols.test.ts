import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { programs, protocols, protocolVersions } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createBrand, tenantWith } from '../support/db.js';

/**
 * Protocols, sign-off and programs (PRD INT-01 to INT-04,
 * docs/decisions/intake.md INT3, INT4, INT9 to INT11). The flows run on a
 * made-up condition (ADR 0023); one test copies the platform's template.
 */
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
const REGISTRATION = 'MED0001234567';

async function call(method: 'GET' | 'POST' | 'PUT' | 'PATCH', url: string, email: string, tenantId: string, payload?: Record<string, unknown>) {
  return app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });
}

async function newProtocol(email: string, tenantId: string, name = `Made-up care ${randomUUID().slice(0, 6)}`) {
  const reply = await call('POST', '/v1/protocols', email, tenantId, { name, condition: 'Made-up condition', definition });
  expect(reply.statusCode).toBe(201);
  return reply.json() as { protocolId: string; name: string };
}

const signOff = (email: string, tenantId: string, protocolId: string, version: number, registration = REGISTRATION) =>
  call('POST', `/v1/protocols/${protocolId}/sign-off`, email, tenantId, { version, registration, attest: true });

describe('starting a protocol (INT3, INT10)', async () => {
  const { tenantId, members } = await tenantWith('medical_director', 'clinician', 'support');
  const [director, clinician, support] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];

  it('copies a platform template as version 1, a draft, and audits both', async () => {
    const templates = await call('GET', '/v1/protocol-templates', director.email, tenantId);
    expect(templates.json().templates.map((t: { key: string }) => t.key)).toContain('weight-management');
    const reply = await call('POST', '/v1/protocols', director.email, tenantId, { name: 'Our weight care', templateKey: 'weight-management' });
    expect(reply.statusCode).toBe(201);
    const created = reply.json();
    expect(created).toMatchObject({ condition: 'Weight management', template: { key: 'weight-management', version: 1 }, liveVersion: null, draftVersion: 1, versions: [{ version: 1, status: 'draft', signedOffAt: null }] });
    const audit = await admin.query('select action from platform.audit_log where tenant_id = $1 and actor_id = $2 order by at, action', [tenantId, director.id]);
    expect(audit.rows.map((row) => row.action)).toEqual(['protocol.created', 'protocol_version.drafted']);
  });

  it('answers each problem in a definition with its path, and refuses a second protocol of the same name', async () => {
    const broken = { ...definition, rules: [{ ...definition.rules[0], patientMessage: undefined }] };
    const reply = await call('POST', '/v1/protocols', director.email, tenantId, { name: 'Broken', condition: 'Made-up condition', definition: broken });
    expect(reply.statusCode).toBe(400);
    expect(reply.json().error).toMatchObject({ code: 'protocol_problems', details: { problems: [{ message: 'A hard stop needs a message for the patient' }] } });
    const first = await newProtocol(director.email, tenantId, 'Same name');
    expect(first.name).toBe('Same name');
    const again = await call('POST', '/v1/protocols', director.email, tenantId, { name: 'same NAME', condition: 'Made-up condition', definition });
    expect(again.json().error.code).toBe('name_taken');
  });

  it('lets a clinician read protocols but not write them, and keeps support out', async () => {
    expect((await call('GET', '/v1/protocols', clinician.email, tenantId)).statusCode).toBe(200);
    expect((await call('POST', '/v1/protocols', clinician.email, tenantId, { name: 'Nope', condition: 'Made-up condition', definition })).statusCode).toBe(403);
    expect((await call('GET', '/v1/protocols', support.email, tenantId)).statusCode).toBe(403);
  });
});

describe('signing off a version (INT4)', async () => {
  const { tenantId, members } = await tenantWith('medical_director', 'owner', 'prescriber');
  const [director, owner, prescriber] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0]];

  it('needs a medical practitioner’s registration and the current draft, then goes live with the attestation', async () => {
    const { protocolId, name } = await newProtocol(director.email, tenantId);
    expect((await signOff(director.email, tenantId, protocolId, 1, 'NMW0001234567')).json().error.code).toBe('registration_needed');
    expect((await signOff(director.email, tenantId, protocolId, 2)).json().error.code).toBe('not_a_draft');
    const reply = await signOff(director.email, tenantId, protocolId, 1, 'med0001234567');
    expect(reply.statusCode).toBe(200);
    expect(reply.json()).toMatchObject({ version: 1, status: 'live', signedOffBy: director.id, signerRegistration: REGISTRATION });
    expect(reply.json().attestation).toBe(`I have reviewed version 1 of the protocol "${name}" and approve it for use with patients, under Ahpra registration ${REGISTRATION}.`);
    const events = await admin.query("select payload from platform.outbox where type = 'protocol_version.live' and record_id = $1", [reply.json().versionId]);
    expect(events.rows).toEqual([{ payload: { protocolId, version: 1 } }]);
  });

  it('retires the live version when the next one is signed off, and allows one draft at a time', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    await signOff(director.email, tenantId, protocolId, 1);
    const draft = await call('POST', `/v1/protocols/${protocolId}/draft`, director.email, tenantId);
    expect(draft.json()).toMatchObject({ version: 2, status: 'draft', definition: { steps: [{ key: 'about' }] } });
    expect((await call('POST', `/v1/protocols/${protocolId}/draft`, director.email, tenantId)).json().error.code).toBe('draft_exists');
    const edited = await call('PUT', `/v1/protocols/${protocolId}/draft`, director.email, tenantId, {
      definition: { ...definition, steps: [{ ...definition.steps[0], title: 'About you, revised' }] },
    });
    expect(edited.json().definition.steps[0].title).toBe('About you, revised');
    await signOff(director.email, tenantId, protocolId, 2);
    const detail = await call('GET', `/v1/protocols/${protocolId}`, director.email, tenantId);
    expect(detail.json()).toMatchObject({ liveVersion: 2, draftVersion: null, versions: [{ version: 2, status: 'live' }, { version: 1, status: 'retired' }] });
    expect((await call('PUT', `/v1/protocols/${protocolId}/draft`, director.email, tenantId, { definition })).json().error.code).toBe('no_draft');
  });

  it('is for a clinical role: a prescriber can’t, and an owner can only with break-glass open', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    expect((await signOff(prescriber.email, tenantId, protocolId, 1)).statusCode).toBe(403);
    expect((await signOff(owner.email, tenantId, protocolId, 1)).json().error.code).toBe('break_glass_required');
    await admin.query("insert into platform.break_glass (tenant_id, membership_id, user_id, reason, ends_at) values ($1, $2, $3, 'Signing off while the director is away', now() + interval '1 hour')", [
      tenantId,
      owner.membershipId,
      owner.id,
    ]);
    expect((await signOff(owner.email, tenantId, protocolId, 1)).json().status).toBe('live');
  });

  it('never changes a signed-off version, for any role', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    const live = (await signOff(director.email, tenantId, protocolId, 1)).json();
    await expect(admin.query("update clinical.protocol_versions set definition = '{}'::jsonb where id = $1", [live.versionId])).rejects.toThrow(/can't change that way/);
    await expect(admin.query("update clinical.protocol_versions set status = 'draft', signed_off_at = null where id = $1", [live.versionId])).rejects.toThrow(/can't change that way/);
    await expect(admin.query('delete from clinical.protocol_versions where id = $1', [live.versionId])).rejects.toThrow(/never changed or removed/);
  });

  it('withdraws the live version for safety, with a reason, and only once', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    await signOff(director.email, tenantId, protocolId, 1);
    expect((await call('POST', `/v1/protocols/${protocolId}/withdraw`, director.email, tenantId, { reason: ' ' })).statusCode).toBe(400);
    const reply = await call('POST', `/v1/protocols/${protocolId}/withdraw`, director.email, tenantId, { reason: 'A rule needs another look' });
    expect(reply.json()).toMatchObject({ status: 'withdrawn', withdrawnReason: 'A rule needs another look' });
    const events = await admin.query("select payload from platform.outbox where type = 'protocol_version.withdrawn' and record_id = $1", [reply.json().versionId]);
    expect(events.rows).toEqual([{ payload: { protocolId, version: 1 } }]);
    expect((await call('POST', `/v1/protocols/${protocolId}/withdraw`, director.email, tenantId, { reason: 'Again' })).json().error.code).toBe('nothing_live');
    await expect(admin.query("update clinical.protocol_versions set status = 'live' where id = $1", [reply.json().versionId])).rejects.toThrow(/can't change that way/);
  });
});

describe('programs (INT9, INT11)', async () => {
  const { tenantId, members } = await tenantWith('medical_director', 'support');
  const [director, support] = members as [(typeof members)[0], (typeof members)[0]];
  const { brandId } = await createBrand(tenantId);

  const newProgram = async (protocolId: string) => {
    const reply = await call('POST', '/v1/programs', director.email, tenantId, { brandId, protocolId, name: 'Made-up program', measurements: ['weight', 'weight', 'waist'], checkInEveryDays: 28 });
    expect(reply.statusCode).toBe(201);
    return reply.json() as { programId: string };
  };
  const change = (programId: string, body: Record<string, unknown>) => call('PATCH', `/v1/programs/${programId}`, director.email, tenantId, body);

  it('starts as a draft on a protocol and inherits its condition', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    const program = await newProgram(protocolId);
    expect(program).toMatchObject({ brandId, protocolId, condition: 'Made-up condition', status: 'draft', measurements: ['weight', 'waist'], checkInEveryDays: 28 });
    const missing = await call('POST', '/v1/programs', director.email, tenantId, { brandId, protocolId: randomUUID(), name: 'Nowhere' });
    const elsewhere = await createBrand((await tenantWith()).tenantId);
    const theirs = await call('POST', '/v1/programs', director.email, tenantId, { brandId: elsewhere.brandId, protocolId, name: 'Borrowed brand' });
    expect([missing.json().error.message, theirs.json().error.message]).toEqual(['Protocol not found', 'Brand not found']);
  });

  it('goes live only on a live protocol, pauses and resumes, and stays retired', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    const { programId } = await newProgram(protocolId);
    expect((await change(programId, { status: 'paused' })).json().error.code).toBe('program_status');
    expect((await change(programId, { status: 'live' })).json().error.code).toBe('protocol_not_live');
    await signOff(director.email, tenantId, protocolId, 1);
    expect((await change(programId, { status: 'live' })).json().status).toBe('live');
    expect((await change(programId, { status: 'paused', name: 'Renamed' })).json()).toMatchObject({ status: 'paused', name: 'Renamed' });
    expect((await change(programId, { status: 'live' })).json().status).toBe('live');
    expect((await change(programId, { status: 'retired' })).json().status).toBe('retired');
    expect((await change(programId, { name: 'Again' })).json().error.code).toBe('program_retired');
    const events = await admin.query("select payload from platform.outbox where type = 'program.status_changed' and record_id = $1 order by created_at", [programId]);
    expect(events.rows.map((row) => row.payload)).toEqual([
      { from: 'draft', to: 'live' },
      { from: 'live', to: 'paused' },
      { from: 'paused', to: 'live' },
      { from: 'live', to: 'retired' },
    ]);
  });

  it('is read by any member and changed only with programs:manage', async () => {
    const { protocolId } = await newProtocol(director.email, tenantId);
    const { programId } = await newProgram(protocolId);
    expect((await call('GET', `/v1/programs/${programId}`, support.email, tenantId)).json().programId).toBe(programId);
    expect((await call('PATCH', `/v1/programs/${programId}`, support.email, tenantId, { name: 'Nope' })).statusCode).toBe(403);
  });
});

describe('tenancy', async () => {
  const a = await tenantWith('medical_director');
  const b = await tenantWith('medical_director');
  const director = a.members[0]!;
  const { protocolId } = await newProtocol(director.email, a.tenantId);
  const brandA = await createBrand(a.tenantId);
  const brandB = await createBrand(b.tenantId);
  const program = (await call('POST', '/v1/programs', director.email, a.tenantId, { brandId: brandA.brandId, protocolId, name: 'Made-up program' })).json();
  const asB: TenantContext = { tenantId: b.tenantId, actor: { type: 'person', userId: b.members[0]!.id }, requestId: 'test' };

  it("can't read another tenant's protocols, versions or programs, through the API or the database", async () => {
    expect((await call('GET', `/v1/protocols/${protocolId}`, b.members[0]!.email, b.tenantId)).statusCode).toBe(404);
    expect((await call('GET', `/v1/programs/${program.programId}`, b.members[0]!.email, b.tenantId)).statusCode).toBe(404);
    const seen = await withTenant(asB, async (tx) => [
      ...(await tx.db.select({ id: protocols.id }).from(protocols)),
      ...(await tx.db.select({ id: protocolVersions.id }).from(protocolVersions)),
      ...(await tx.db.select({ id: programs.id }).from(programs)),
    ]);
    expect(seen).toEqual([]);
  });

  it("can't change another tenant's rows, or point a program at another tenant's protocol", async () => {
    const changed = await withTenant(asB, async (tx) => [
      ...(await tx.db.update(protocolVersions).set({ editedAt: new Date() }).returning({ id: protocolVersions.id })),
      ...(await tx.db.update(programs).set({ name: 'Taken' }).returning({ id: programs.id })),
    ]);
    expect(changed).toEqual([]);
    await expect(withTenant(asB, (tx) => tx.db.insert(programs).values({ tenantId: b.tenantId, brandId: brandB.brandId, protocolId, name: 'Borrowed' }))).rejects.toThrow();
  });
});
