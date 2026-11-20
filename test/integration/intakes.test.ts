import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { intakes } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { intakeSummaryFor, settleIntakes } from '../../src/modules/intake/index.js';
import { headers, patientSignIn, signIn, testApp } from '../support/app.js';
import { admin, createBrand, createPlatformStaff, tenantWith } from '../support/db.js';

/**
 * Intakes (PRD INT-02, INT-03, INT-05; docs/decisions/intake.md INT5 to
 * INT15), on a made-up condition (ADR 0023) and made-up people.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const definition = {
  steps: [
    { key: 'body', title: 'About you', questions: [{ key: 'height', label: 'Height', kind: 'number', unit: 'cm', min: 100, max: 250 }, { key: 'mass', label: 'Mass', kind: 'number', unit: 'kg', min: 30, max: 300 }] },
    {
      key: 'status',
      title: 'Your situation',
      questions: [
        { key: 'expecting', label: 'Are you expecting?', kind: 'yes_no' },
        { key: 'conditions', label: 'Any of these?', kind: 'multi_choice', required: false, options: [{ value: 'alpha', label: 'Alpha' }, { value: 'beta', label: 'Beta' }] },
      ],
    },
    { key: 'extra', title: 'Only for some', showIf: { derived: 'index', is: 'at_least', value: 30 }, questions: [{ key: 'tried', label: 'Tried before?', kind: 'single_choice', options: [{ value: 'never', label: 'Never' }, { value: 'once', label: 'Once' }] }] },
    { key: 'more', title: 'Anything else', questions: [{ key: 'notes', label: 'Anything else?', kind: 'text', required: false }] },
  ],
  derived: [{ key: 'index', label: 'Index', decimals: 1, formula: { op: 'divide', of: [{ op: 'multiply', of: [{ answer: 'mass' }, 10000] }, { op: 'multiply', of: [{ answer: 'height' }, { answer: 'height' }] }] } }],
  rules: [
    { key: 'expecting_stop', outcome: 'hard_stop', when: { answer: 'expecting', is: 'equals', value: true }, prescriberLabel: 'Expecting', patientMessage: 'This isn’t right for you now.', urgentHelp: true },
    { key: 'low_index', outcome: 'hard_stop', when: { all: [{ derived: 'index', is: 'less_than', value: 20 }, { not: { answer: 'conditions', is: 'includes', value: 'alpha' } }] }, prescriberLabel: 'Low index', patientMessage: 'This needs a higher index.' },
    { key: 'beta_flag', outcome: 'red_flag', when: { answer: 'conditions', is: 'includes', value: 'beta' }, prescriberLabel: 'Has beta' },
    { key: 'tried_flag', outcome: 'red_flag', when: { answer: 'tried', is: 'equals', value: 'once' }, prescriberLabel: 'Tried once before' },
  ],
};

type Reply = Awaited<ReturnType<App['inject']>>;
const staffCall = async (method: 'GET' | 'POST' | 'PATCH', url: string, email: string, tenantId: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

/** A tenant that takes new patients: a live brand on a verified domain, a medical director, a prescriber, published terms, and one live program. */
async function clinic() {
  const { tenantId, members } = await tenantWith('medical_director', 'prescriber', 'support', 'owner');
  const [director, prescriber, support, owner] = members as [(typeof members)[0], (typeof members)[0], (typeof members)[0], (typeof members)[0]];
  const { brandId } = await createBrand(tenantId, { status: 'live', host: `${randomUUID().slice(0, 8)}.example.test`, verifiedBy: (await createPlatformStaff()).id });
  const publish = async (kind: string) => (await staffCall('POST', '/v1/consent-documents', owner.email, tenantId, { kind, title: `${kind} notice`, body: 'Made-up text.' })).json();
  const privacy = await publish('privacy');
  const terms = await publish('telehealth_terms');
  const protocol = (await staffCall('POST', '/v1/protocols', director.email, tenantId, { name: 'Made-up care', condition: 'Made-up condition', definition })).json();
  await staffCall('POST', `/v1/protocols/${protocol.protocolId}/sign-off`, director.email, tenantId, { version: 1, registration: 'MED0001234567', attest: true });
  const program = (await staffCall('POST', '/v1/programs', director.email, tenantId, { brandId, protocolId: protocol.protocolId, name: 'Made-up program', measurements: ['weight'] })).json();
  await staffCall('PATCH', `/v1/programs/${program.programId}`, director.email, tenantId, { status: 'live' });
  return { tenantId, brandId, director, prescriber, support, owner, privacy, terms, protocolId: protocol.protocolId as string, programId: program.programId as string };
}
type Clinic = Awaited<ReturnType<typeof clinic>>;

const anon = (tenantId: string, token?: string) => ({ 'x-medora-tenant': tenantId, ...(token ? { 'x-medora-intake-token': token } : {}) });

async function begin(c: Clinic, dateOfBirth = '1990-05-01') {
  const reply = await app.inject({ method: 'POST', url: '/v1/public/intakes', headers: anon(c.tenantId), payload: { programId: c.programId, privacyDocumentId: c.privacy.documentId, adult: true, dateOfBirth } });
  expect(reply.statusCode).toBe(201);
  expect(reply.headers['cache-control']).toBe('no-store');
  return { resumeToken: String(reply.headers['x-medora-intake-token']), intake: reply.json() as { intakeId: string; status: string; currentStep: string | null } };
}

const step = (c: Clinic, intakeId: string, token: string, key: string, answers: Record<string, unknown>): Promise<Reply> =>
  app.inject({ method: 'PUT', url: `/v1/public/intakes/${intakeId}/steps/${key}`, headers: anon(c.tenantId, token), payload: { answers } });

async function signUp(c: Clinic) {
  const subject = `user_${randomUUID()}`;
  const token = await patientSignIn(subject, { email: `${subject}@example.test` });
  const reply = await app.inject({ method: 'POST', url: '/v1/patient/account', headers: headers(token, c.tenantId), payload: { brandId: c.brandId, givenName: 'Sam', familyName: 'Sample', dateOfBirth: '1990-05-01', sex: 'not_stated' } });
  expect(reply.statusCode).toBe(201);
  return { token, patientId: reply.json().patientId as string };
}
const asPatient = (c: Clinic, token: string, method: 'GET' | 'POST' | 'PUT', url: string, payload?: Record<string, unknown>) =>
  app.inject({ method, url, headers: headers(token, c.tenantId), ...(payload ? { payload } : {}) });

/** A patient who has agreed to the privacy notice and the telehealth terms. */
async function agreed(c: Clinic) {
  const patient = await signUp(c);
  for (const document of [c.privacy, c.terms]) await asPatient(c, patient.token, 'POST', '/v1/patient/consents', { documentId: document.documentId });
  return patient;
}

describe('starting before an account (INT5)', async () => {
  const c = await clinic();

  it('shows the program and the current privacy notice, and refuses an older one', async () => {
    const screen = await app.inject({ method: 'GET', url: `/v1/public/programs/${c.programId}/intake-start`, headers: anon(c.tenantId) });
    expect(screen.json()).toMatchObject({ programName: 'Made-up program', privacyNotice: { documentId: c.privacy.documentId, version: 1 } });
    const stale = await app.inject({ method: 'POST', url: '/v1/public/intakes', headers: anon(c.tenantId), payload: { programId: c.programId, privacyDocumentId: randomUUID(), adult: true, dateOfBirth: '1990-05-01' } });
    expect(stale.json().error.code).toBe('not_current_version');
    const notAdult = await app.inject({ method: 'POST', url: '/v1/public/intakes', headers: anon(c.tenantId), payload: { programId: c.programId, privacyDocumentId: c.privacy.documentId, adult: false, dateOfBirth: '1990-05-01' } });
    expect(notAdult.statusCode).toBe(400);
  });

  it('ends at once for someone under 18, keeping no date of birth', async () => {
    const { intake } = await begin(c, '2015-01-01');
    expect(intake).toMatchObject({ status: 'ended', endedReason: 'under_age', currentStep: null });
    const { rows } = await admin.query('select date_of_birth, answers from clinical.intakes where id = $1', [intake.intakeId]);
    expect(rows).toEqual([{ date_of_birth: null, answers: null }]);
    const events = await admin.query('select type, payload from platform.outbox where record_id = $1 order by created_at, type', [intake.intakeId]);
    expect(events.rows).toEqual([
      { type: 'intake.ended', payload: { programId: c.programId, status: 'ended', reason: 'under_age' } },
      { type: 'intake.started', payload: { programId: c.programId } },
    ]);
  });

  it('keeps only a hash of the resume token, and a wrong token finds nothing', async () => {
    const { resumeToken, intake } = await begin(c);
    expect(intake).toMatchObject({ status: 'in_progress', currentStep: 'body' });
    const { rows } = await admin.query('select resume_token_hash from clinical.intakes where id = $1', [intake.intakeId]);
    expect(rows[0].resume_token_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(rows[0].resume_token_hash).not.toContain(resumeToken);
    expect((await app.inject({ method: 'GET', url: `/v1/public/intakes/${intake.intakeId}`, headers: anon(c.tenantId, `x${resumeToken}`) })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: `/v1/public/intakes/${intake.intakeId}`, headers: anon(c.tenantId, resumeToken) })).json().intakeId).toBe(intake.intakeId);
  });

  it('is closed while the program or its brand is not taking new patients', async () => {
    await staffCall('PATCH', `/v1/programs/${c.programId}`, c.director.email, c.tenantId, { status: 'paused' });
    const paused = await app.inject({ method: 'POST', url: '/v1/public/intakes', headers: anon(c.tenantId), payload: { programId: c.programId, privacyDocumentId: c.privacy.documentId, adult: true, dateOfBirth: '1990-05-01' } });
    expect(paused.json().error.code).toBe('program_unavailable');
    await staffCall('PATCH', `/v1/programs/${c.programId}`, c.director.email, c.tenantId, { status: 'live' });
    await admin.query("update platform.brands set status = 'paused' where id = $1", [c.brandId]);
    const brand = await app.inject({ method: 'GET', url: `/v1/public/programs/${c.programId}/intake-start`, headers: anon(c.tenantId) });
    expect(brand.json().error.code).toBe('brand_not_accepting');
    await admin.query("update platform.brands set status = 'live' where id = $1", [c.brandId]);
  });
});

describe('answering, and the rules (INT2, INT12)', async () => {
  const c = await clinic();

  it('takes the steps in order, checks each answer, and sends back to an earlier step', async () => {
    const { resumeToken, intake } = await begin(c);
    expect((await step(c, intake.intakeId, resumeToken, 'status', { expecting: false })).json().error.code).toBe('step_not_reached');
    const wrong = await step(c, intake.intakeId, resumeToken, 'body', { height: 170, mass: 20 });
    expect(wrong.json().error).toMatchObject({ code: 'answer_problems', details: { problems: [{ key: 'mass' }] } });
    expect((await step(c, intake.intakeId, resumeToken, 'body', { height: 170, mass: 95 })).json()).toMatchObject({ currentStep: 'status' });
    const shown = await step(c, intake.intakeId, resumeToken, 'status', { expecting: false, conditions: ['beta'] });
    expect(shown.json()).toMatchObject({ currentStep: 'extra', steps: [{ key: 'body', done: true }, { key: 'status', done: true }, { key: 'extra', done: false }, { key: 'more' }] });
    await step(c, intake.intakeId, resumeToken, 'extra', { tried: 'once' });
    // Back to the first step: a smaller mass hides "extra" and drops its answer.
    const back = await step(c, intake.intakeId, resumeToken, 'body', { height: 170, mass: 70 });
    expect(back.json()).toMatchObject({ currentStep: 'more', answers: { height: 170, mass: 70, expecting: false, conditions: ['beta'] } });
    expect(back.json().answers.tried).toBeUndefined();
    const { rows } = await admin.query('select answers from clinical.intakes where id = $1', [intake.intakeId]);
    expect(rows[0].answers).not.toContain('beta');
  });

  it('fires a hard stop only once its questions are behind the person, with the urgent-help message', async () => {
    const low = await begin(c);
    expect((await step(c, low.intake.intakeId, low.resumeToken, 'body', { height: 190, mass: 60 })).json().status).toBe('in_progress');
    const stopped = await step(c, low.intake.intakeId, low.resumeToken, 'status', { expecting: false, conditions: [] });
    expect(stopped.json()).toMatchObject({ status: 'ineligible', stop: { message: 'This needs a higher index.', urgentHelp: false }, currentStep: null });

    const expecting = await begin(c);
    await step(c, expecting.intake.intakeId, expecting.resumeToken, 'body', { height: 170, mass: 70 });
    const reply = await step(c, expecting.intake.intakeId, expecting.resumeToken, 'status', { expecting: true });
    expect(reply.json().stop).toEqual({ message: 'This isn’t right for you now.', urgentHelp: true });
    expect((await step(c, expecting.intake.intakeId, expecting.resumeToken, 'status', { expecting: false })).json().error.code).toBe('intake_closed');
    const events = await admin.query("select payload from platform.outbox where type = 'intake.ended' and record_id = $1", [expecting.intake.intakeId]);
    expect(events.rows).toEqual([{ payload: { programId: c.programId, status: 'ineligible' } }]);
    const audit = await admin.query("select details from platform.audit_log where action = 'intake.ineligible' and record_id = $1", [expecting.intake.intakeId]);
    expect(audit.rows).toEqual([{ details: {} }]);
  });
});

describe('claiming, submitting and the prescriber’s summary (INT6, INT15)', async () => {
  const c = await clinic();
  const earlier = await begin(c);
  await step(c, earlier.intake.intakeId, earlier.resumeToken, 'body', { height: 170, mass: 70 });
  await step(c, earlier.intake.intakeId, earlier.resumeToken, 'status', { expecting: true });
  const later = await begin(c);
  for (const [key, answers] of [
    ['body', { height: 170, mass: 95 }],
    ['status', { expecting: false, conditions: ['beta'] }],
    ['extra', { tried: 'once' }],
    ['more', { notes: 'Made-up note' }],
  ] as const) {
    await step(c, later.intake.intakeId, later.resumeToken, key, answers);
  }
  const patient = await signUp(c);

  it('makes every intake from the browser the patient’s, records the privacy consent as given then, and retires the tokens', async () => {
    const before = await app.inject({ method: 'GET', url: `/v1/public/intakes/${later.intake.intakeId}`, headers: anon(c.tenantId, later.resumeToken) });
    expect(before.json().readyToSubmit).toBe(true);
    const claim = await asPatient(c, patient.token, 'POST', '/v1/patient/intakes/claim', { tokens: [earlier.resumeToken, later.resumeToken] });
    expect(claim.json().claimed.sort()).toEqual([earlier.intake.intakeId, later.intake.intakeId].sort());
    const consent = await admin.query(
      "select c.decision, c.at in (select privacy_agreed_at from clinical.intakes where patient_id = $1) as at_the_intake from clinical.patient_consents c where c.patient_id = $1 and c.kind = 'privacy'",
      [patient.patientId],
    );
    expect(consent.rows).toEqual([{ decision: 'given', at_the_intake: true }]);
    expect((await app.inject({ method: 'GET', url: `/v1/public/intakes/${later.intake.intakeId}`, headers: anon(c.tenantId, later.resumeToken) })).statusCode).toBe(404);
    const mine = await asPatient(c, patient.token, 'GET', '/v1/patient/intakes');
    expect(mine.json().intakes.map((i: { status: string }) => i.status).sort()).toEqual(['in_progress', 'ineligible']);
  });

  it('is submitted by the patient once the terms are agreed, with its red flags', async () => {
    expect((await asPatient(c, patient.token, 'POST', `/v1/patient/intakes/${later.intake.intakeId}/submit`)).json().error.code).toBe('consent_needed');
    await asPatient(c, patient.token, 'POST', '/v1/patient/consents', { documentId: c.terms.documentId });
    const sent = await asPatient(c, patient.token, 'POST', `/v1/patient/intakes/${later.intake.intakeId}/submit`);
    expect(sent.json()).toMatchObject({ status: 'completed', readyToSubmit: false });
    const { rows } = await admin.query('select red_flags from clinical.intakes where id = $1', [later.intake.intakeId]);
    expect(rows[0].red_flags.sort()).toEqual(['beta_flag', 'tried_flag']);
    const events = await admin.query("select payload from platform.outbox where type = 'intake.completed' and record_id = $1", [later.intake.intakeId]);
    expect(events.rows).toEqual([{ payload: { programId: c.programId, patientId: patient.patientId } }]);
    const me = await asPatient(c, patient.token, 'GET', '/v1/patient/me');
    expect(me.json().programs).toEqual([{ programId: c.programId, name: 'Made-up program', measurements: ['weight'], checkInEveryDays: null }]);
  });

  it('gives the prescriber the answers in order, the red flags, the derived numbers and the earlier hard stop', async () => {
    const reply = await staffCall('GET', `/v1/intakes/${later.intake.intakeId}`, c.prescriber.email, c.tenantId);
    expect(reply.json()).toMatchObject({
      protocolName: 'Made-up care',
      protocolVersion: 1,
      outcome: 'red_flags',
      stale: false,
      dateOfBirthDiffers: false,
      redFlags: [{ rule: 'beta_flag', message: 'Has beta' }, { rule: 'tried_flag', message: 'Tried once before' }],
      derived: [{ key: 'index', label: 'Index', value: 32.9, unit: null }],
      earlierIneligible: [{ intakeId: earlier.intake.intakeId, rule: 'Expecting' }],
    });
    expect(reply.json().items).toEqual([
      { questionKey: 'height', question: 'Height', answer: '170 cm', redFlag: false },
      { questionKey: 'mass', question: 'Mass', answer: '95 kg', redFlag: false },
      { questionKey: 'expecting', question: 'Are you expecting?', answer: 'No', redFlag: false },
      { questionKey: 'conditions', question: 'Any of these?', answer: 'Beta', redFlag: true },
      { questionKey: 'tried', question: 'Tried before?', answer: 'Once', redFlag: true },
      { questionKey: 'notes', question: 'Anything else?', answer: 'Made-up note', redFlag: false },
    ]);
    const audit = await admin.query("select actor_id from platform.audit_log where action = 'intake.summary_read' and record_id = $1", [later.intake.intakeId]);
    expect(audit.rows).toEqual([{ actor_id: c.prescriber.id }]);
    const context: TenantContext = { tenantId: c.tenantId, actor: { type: 'person', userId: c.prescriber.id }, requestId: 'test' };
    expect((await withTenant(context, (tx) => intakeSummaryFor(tx, patient.patientId)))?.intakeId).toBe(later.intake.intakeId);
  });

  it('shows support where intakes stand but never the answers, and asks the owner for break-glass', async () => {
    const list = await staffCall('GET', `/v1/patients/${patient.patientId}/intakes`, c.support.email, c.tenantId);
    expect(list.json().intakes.map((i: { status: string }) => i.status).sort()).toEqual(['completed', 'ineligible']);
    expect(JSON.stringify(list.json())).not.toContain('Beta');
    expect((await staffCall('GET', `/v1/intakes/${later.intake.intakeId}`, c.support.email, c.tenantId)).statusCode).toBe(403);
    expect((await staffCall('GET', `/v1/intakes/${later.intake.intakeId}`, c.owner.email, c.tenantId)).json().error.code).toBe('break_glass_required');
  });

  it('lets a signed-in patient start again, picking up the one in progress', async () => {
    const first = await asPatient(c, patient.token, 'POST', '/v1/patient/intakes', { programId: c.programId });
    const again = await asPatient(c, patient.token, 'POST', '/v1/patient/intakes', { programId: c.programId });
    expect(first.json()).toMatchObject({ status: 'in_progress', currentStep: 'body' });
    expect(again.json().intakeId).toBe(first.json().intakeId);
  });
});

describe('lapses (INT4, INT7, INT14)', async () => {
  const c = await clinic();
  const context: TenantContext = { tenantId: c.tenantId, actor: { type: 'system' }, requestId: 'test' };

  it('clears an unclaimed intake after 14 quiet days and keeps the row', async () => {
    const { resumeToken, intake } = await begin(c);
    await step(c, intake.intakeId, resumeToken, 'body', { height: 170, mass: 80 });
    await admin.query("update clinical.intakes set last_active_at = now() - interval '15 days' where id = $1", [intake.intakeId]);
    expect((await app.inject({ method: 'GET', url: `/v1/public/intakes/${intake.intakeId}`, headers: anon(c.tenantId, resumeToken) })).statusCode).toBe(404);
    const { rows } = await admin.query('select status, ended_reason, answers, date_of_birth, resume_token_hash, cleared_at is not null as cleared from clinical.intakes where id = $1', [intake.intakeId]);
    expect(rows).toEqual([{ status: 'ended', ended_reason: 'unclaimed', answers: null, date_of_birth: null, resume_token_hash: null, cleared: true }]);
  });

  it('ends a claimed intake idle for 30 days, and in-progress ones on a withdrawn version', async () => {
    const patient = await agreed(c);
    const idle = (await asPatient(c, patient.token, 'POST', '/v1/patient/intakes', { programId: c.programId })).json();
    await admin.query("update clinical.intakes set last_active_at = now() - interval '31 days' where id = $1", [idle.intakeId]);
    expect((await asPatient(c, patient.token, 'GET', `/v1/patient/intakes/${idle.intakeId}`)).json()).toMatchObject({ status: 'ended', endedReason: 'expired' });

    const open = (await asPatient(c, patient.token, 'POST', '/v1/patient/intakes', { programId: c.programId })).json();
    await staffCall('POST', `/v1/protocols/${c.protocolId}/withdraw`, c.director.email, c.tenantId, { reason: 'A rule needs another look' });
    await withTenant(context, (tx) => settleIntakes(tx));
    const { rows } = await admin.query('select status, ended_reason from clinical.intakes where id = $1', [open.intakeId]);
    expect(rows).toEqual([{ status: 'ended', ended_reason: 'version_withdrawn' }]);
    expect((await asPatient(c, patient.token, 'POST', '/v1/patient/intakes', { programId: c.programId })).json().error.code).toBe('program_unavailable');
  });
});

describe('tenancy', async () => {
  const a = await clinic();
  const b = await clinic();
  const { resumeToken, intake } = await begin(a);

  it("can't open another tenant's intake with its token, or see its rows", async () => {
    expect((await app.inject({ method: 'GET', url: `/v1/public/intakes/${intake.intakeId}`, headers: anon(b.tenantId, resumeToken) })).statusCode).toBe(404);
    const asB: TenantContext = { tenantId: b.tenantId, actor: { type: 'system' }, requestId: 'test' };
    const seen = await withTenant(asB, (tx) => tx.db.select({ id: intakes.id }).from(intakes));
    expect(seen.map((row) => row.id)).not.toContain(intake.intakeId);
    const changed = await withTenant(asB, (tx) => tx.db.update(intakes).set({ stepsDone: 9 }).returning({ id: intakes.id }));
    expect(changed.map((row) => row.id)).not.toContain(intake.intakeId);
  });

  it("can't claim another tenant's intake", async () => {
    const patient = await signUp(b);
    expect((await asPatient(b, patient.token, 'POST', '/v1/patient/intakes/claim', { tokens: [resumeToken] })).json()).toEqual({ claimed: [] });
  });
});
