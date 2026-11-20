import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { startSubscription } from '../../src/modules/billing/index.js';
import { dayOfMonth, nextStart } from '../../src/modules/billing/periods.js';
import { beginPeriod } from '../../src/modules/billing/subscriptions.service.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPaymentAccount, tenantWith } from '../support/db.js';

/**
 * Subscriptions (docs/decisions/billing.md BIL18 to BIL22). Today is fixed at
 * 10 March 2027 in Sydney. Patients and programs are made-up ids until those
 * tables merge; checkout and invoices call the service directly.
 */
let app: App;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2027-03-10T01:00:00Z'));
  app = await testApp();
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await closeDatabase();
  await admin.end();
});

const TODAY = '2027-03-10';
const clinic = await tenantWith('owner', 'finance', 'support', 'clinician');
const [, finance, support, clinician] = clinic.members as [(typeof clinic.members)[number], (typeof clinic.members)[number], (typeof clinic.members)[number], (typeof clinic.members)[number]];
const account = await createPaymentAccount(clinic.tenantId);
const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });
const inClinic = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant(as(clinic.tenantId, finance.id), work);

type Who = { email: string; tenantId: string };
async function call(method: 'GET' | 'POST', url: string, body?: object, who: Who = { email: support.email, tenantId: clinic.tenantId }) {
  const response = await app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(who.email), who.tenantId), ...(body ? { payload: body } : {}) });
  return { status: response.statusCode, body: response.json() };
}

async function livePrice(options: { paymentAccountId?: string | null; programId?: string; tenant?: Who } = {}): Promise<{ priceId: string; programId: string }> {
  const who = options.tenant ?? { email: finance.email, tenantId: clinic.tenantId };
  const draft = await call(
    'POST',
    '/prices',
    {
      programId: options.programId ?? randomUUID(),
      name: 'Monthly',
      billingModel: 'pharmacy_billed',
      interval: { unit: 'month', count: 1 },
      paymentAccountId: options.paymentAccountId === undefined ? account : options.paymentAccountId,
      fees: [{ feeKind: 'program', amountCents: 11000 }],
    },
    who,
  );
  return (await call('POST', `/prices/${draft.body.priceId}/publish`, { gstTreatmentsConfirmed: true }, who)).body;
}

const start = (priceId: string, patientId: string = randomUUID(), timeZone = 'Australia/Sydney') => inClinic((tx) => startSubscription(tx, { patientId, priceId, timeZone }));

/** A monthly period starting on `startsOn`, as its paid invoice names it. */
const monthFrom = (startsOn: string) => ({ startsOn, endsOn: nextStart(startsOn, { unit: 'month', count: 1 }, dayOfMonth(startsOn)) });

/** A monthly subscription whose first period was paid for from `startsOn`. */
async function running(startsOn: string) {
  const price = await livePrice();
  const started = await start(price.priceId);
  return inClinic((tx) => beginPeriod(tx, started.subscriptionId, monthFrom(startsOn)));
}

const trail = (recordId: string) =>
  Promise.all([
    admin.query(`select action from platform.audit_log where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.action)),
    admin.query(`select type from platform.outbox where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.type)),
  ]);

const code = (promise: Promise<unknown>) => promise.then(() => 'no error', (error: { code?: string }) => error.code);

describe('starting (BIL18, BIL19)', () => {
  it('waits as pending on the price version, its payment account and the time zone, one live subscription per program', async () => {
    const price = await livePrice();
    const patientId = randomUUID();
    const started = await start(price.priceId, patientId, 'Australia/Perth');
    expect(started).toMatchObject({
      patientId,
      programId: price.programId,
      priceId: price.priceId,
      paymentAccountId: account,
      timeZone: 'Australia/Perth',
      status: 'pending',
      currentPeriod: null,
      nextPeriodStartsOn: null,
      cancelsAtPeriodEnd: false,
    });
    expect(await code(start(price.priceId, patientId))).toBe('already_subscribed');
    expect(await trail(started.subscriptionId)).toEqual([['subscription.started'], ['subscription.started']]);
  });

  it("charges through the tenant's default payment account when the price names none, and refuses without an active one", async () => {
    const other = await tenantWith('finance');
    const them = { email: other.members[0]!.email, tenantId: other.tenantId };
    const price = await livePrice({ paymentAccountId: null, tenant: them });
    const startThere = () => withTenant(as(other.tenantId, other.members[0]!.id), (tx) => startSubscription(tx, { patientId: randomUUID(), priceId: price.priceId, timeZone: 'Australia/Sydney' }));
    expect(await code(startThere())).toBe('no_payment_account');
    const fallback = await createPaymentAccount(other.tenantId);
    await admin.query(`update operational.payment_accounts set is_default = true where id = $1`, [fallback]);
    expect((await startThere()).paymentAccountId).toBe(fallback);
  });

  it('refuses a price not offered to new patients, and a time zone nobody has', async () => {
    const draft = await call('POST', '/prices', { programId: randomUUID(), name: 'Draft', billingModel: 'pharmacy_billed', interval: { unit: 'month', count: 1 }, fees: [{ feeKind: 'program', amountCents: 100 }] }, { email: finance.email, tenantId: clinic.tenantId });
    expect(await code(start(draft.body.priceId))).toBe('price_not_live');
    expect(await code(start((await livePrice()).priceId, randomUUID(), 'Mars/Olympus'))).toBe('invalid_time_zone');
  });

  it('starts the first period on the day it is released, and keeps a month-end anchor', async () => {
    const price = await livePrice();
    const started = await start(price.priceId);
    const active = await inClinic((tx) => beginPeriod(tx, started.subscriptionId, monthFrom('2027-01-31')));
    expect(active).toMatchObject({ status: 'active', currentPeriod: { startsOn: '2027-01-31', endsOn: '2027-02-28' }, nextPeriodStartsOn: '2027-02-28' });
    expect(await code(inClinic((tx) => beginPeriod(tx, started.subscriptionId, monthFrom('2027-02-01'))))).toBe('period_not_due');
    // Overdue, so skipping moves it along the anchor: the 31st, or the month's last day.
    expect((await call('POST', `/subscriptions/${active.subscriptionId}/skip`)).body.nextPeriodStartsOn).toBe('2027-03-31');
  });
});

describe('pausing and skipping (BIL20)', () => {
  it('pauses until a date from the period end to three months after it, and resumes at the period end', async () => {
    const subscription = await running('2027-03-01');
    const pause = (resumesOn: string) => call('POST', `/subscriptions/${subscription.subscriptionId}/pause`, { resumesOn });
    expect((await pause('2027-03-31')).body.error.code).toBe('resume_date_out_of_range');
    expect((await pause('2027-07-02')).body.error.code).toBe('resume_date_out_of_range');
    expect((await pause('2027-07-01')).body).toMatchObject({ status: 'paused', nextPeriodStartsOn: '2027-07-01' });
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/skip`)).body.error.code).toBe('subscription_paused');
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/resume`)).body).toMatchObject({ status: 'active', nextPeriodStartsOn: '2027-04-01' });
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/resume`)).body.error.code).toBe('subscription_not_paused');
    expect(await trail(subscription.subscriptionId)).toEqual([
      ['subscription.started', 'subscription.activated', 'subscription.paused', 'subscription.resumed'],
      ['subscription.started', 'subscription.activated', 'subscription.paused', 'subscription.resumed'],
    ]);
  });

  it('pauses only into the future, and a resume after the period ended is due at once', async () => {
    const subscription = await running('2027-02-01');
    const pause = (resumesOn: string) => call('POST', `/subscriptions/${subscription.subscriptionId}/pause`, { resumesOn });
    expect((await pause(TODAY)).body.error.code).toBe('resume_date_out_of_range');
    expect((await pause('2027-03-11')).body.status).toBe('paused');
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/resume`)).body.nextPeriodStartsOn).toBe('2027-03-01');
  });

  it('skips one interval at a time, with pauses and skips together putting it off three months at most', async () => {
    const subscription = await running('2027-03-01');
    const skip = () => call('POST', `/subscriptions/${subscription.subscriptionId}/skip`);
    expect((await skip()).body.nextPeriodStartsOn).toBe('2027-05-01');
    expect((await skip()).body.nextPeriodStartsOn).toBe('2027-06-01');
    expect((await skip()).body.nextPeriodStartsOn).toBe('2027-07-01');
    expect((await skip()).body.error.code).toBe('deferral_limit');
  });

  it('does nothing to a subscription that has not started or has ended', async () => {
    const pending = await start((await livePrice()).priceId);
    expect((await call('POST', `/subscriptions/${pending.subscriptionId}/skip`)).body.error.code).toBe('subscription_not_running');
    expect((await call('POST', `/subscriptions/${pending.subscriptionId}/pause`, { resumesOn: '2027-04-01' })).body.error.code).toBe('subscription_not_running');
  });
});

describe('cancelling and reinstating (BIL21)', () => {
  it('ends at the period end with its reason kept, and can be reinstated until then', async () => {
    const subscription = await running('2027-03-01');
    const cancel = () => call('POST', `/subscriptions/${subscription.subscriptionId}/cancel`, { when: 'period_end', reason: 'patient_request' });
    expect((await cancel()).body).toMatchObject({ status: 'active', cancelsAtPeriodEnd: true, cancelReason: 'patient_request', endedOn: null });
    expect((await cancel()).body.cancelsAtPeriodEnd).toBe(true);
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/reinstate`)).body).toMatchObject({ status: 'active', cancelsAtPeriodEnd: false, cancelReason: null });
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/reinstate`)).body.error.code).toBe('nothing_to_reinstate');
    const [actions] = await trail(subscription.subscriptionId);
    expect(actions).toEqual(['subscription.started', 'subscription.activated', 'subscription.cancellation_scheduled', 'subscription.reinstated']);
  });

  it('ends today when asked, after which nothing changes it and the program is free again', async () => {
    const subscription = await running('2027-03-01');
    const ended = await call('POST', `/subscriptions/${subscription.subscriptionId}/cancel`, { when: 'now', reason: 'staff_decision' });
    expect(ended.body).toMatchObject({ status: 'cancelled', endedOn: TODAY, cancelReason: 'staff_decision', cancelsAtPeriodEnd: false });
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/cancel`, { when: 'now', reason: 'other' })).body.error.code).toBe('subscription_ended');
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/reinstate`)).body.error.code).toBe('nothing_to_reinstate');
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/resume`)).body.error.code).toBe('subscription_not_paused');
    expect((await start(subscription.priceId, subscription.patientId)).status).toBe('pending');
  });

  it('ends now with no paid days left: still pending, or its period already over', async () => {
    const pending = await start((await livePrice()).priceId);
    const overdue = await running('2027-02-01');
    for (const { subscriptionId } of [pending, overdue]) {
      const { body } = await call('POST', `/subscriptions/${subscriptionId}/cancel`, { when: 'period_end', reason: 'patient_request' });
      expect(body).toMatchObject({ status: 'cancelled', endedOn: TODAY, cancelsAtPeriodEnd: false });
    }
  });

  it('leaves a clinician declining to the consult, not to staff', async () => {
    const subscription = await running('2027-03-01');
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/cancel`, { when: 'now', reason: 'clinician_declined' })).status).toBe(400);
  });
});

describe('who may, and tenancy (BIL22, ADR 0006)', () => {
  it('lets support, finance and the owner see and change subscriptions, and not clinicians', async () => {
    const subscription = await running('2027-03-01');
    const by = (email: string) => ({ email, tenantId: clinic.tenantId });
    expect((await call('GET', `/subscriptions?patientId=${subscription.patientId}`)).body.subscriptions).toEqual([subscription]);
    expect((await call('GET', `/subscriptions/${subscription.subscriptionId}`, undefined, by(finance.email))).body).toEqual(subscription);
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/skip`, undefined, by(clinic.members[0]!.email))).status).toBe(200);
    expect((await call('GET', '/subscriptions', undefined, by(clinician.email))).status).toBe(403);
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/skip`, undefined, by(clinician.email))).status).toBe(403);
  });

  it("never shows or changes another tenant's subscriptions", async () => {
    const subscription = await running('2027-03-01');
    const other = await tenantWith('support');
    const them = { email: other.members[0]!.email, tenantId: other.tenantId };
    expect((await call('GET', '/subscriptions', undefined, them)).body.subscriptions).toEqual([]);
    expect((await call('GET', `/subscriptions/${subscription.subscriptionId}`, undefined, them)).status).toBe(404);
    expect((await call('POST', `/subscriptions/${subscription.subscriptionId}/cancel`, { when: 'now', reason: 'other' }, them)).status).toBe(404);
    expect((await call('GET', `/subscriptions/${subscription.subscriptionId}`)).body.status).toBe('active');
  });
});

describe('the database keeps the rules (ADR 0028)', () => {
  const asApi = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId: clinic.tenantId, actor: { type: 'system' }, requestId: 'test' }, work);
  const insert = (values: { priceId: string; programId: string; patientId: string }) =>
    admin.query(
      `insert into operational.subscriptions (tenant_id, patient_id, program_id, price_id, payment_account_id, time_zone) values ($1, $2, $3, $4, $5, 'Australia/Sydney')`,
      [clinic.tenantId, values.patientId, values.programId, values.priceId, account],
    );

  it("keeps one live subscription per program, on the price's own program", async () => {
    const price = await livePrice();
    const patientId = randomUUID();
    await insert({ ...price, patientId });
    await expect(insert({ ...price, patientId })).rejects.toThrow(/subscriptions_live_key/);
    await expect(insert({ ...price, programId: randomUUID(), patientId: randomUUID() })).rejects.toThrow(/subscriptions_price_fk/);
  });

  it('refuses dates that break the lifecycle, and never deletes a subscription', async () => {
    const subscription = await running('2027-03-01');
    const change = (set: ReturnType<typeof sql>) =>
      asApi((tx) => tx.db.execute(sql`update operational.subscriptions set ${set} where id = ${subscription.subscriptionId}`));
    const lifecycle = { cause: expect.objectContaining({ constraint: 'subscriptions_lifecycle_check' }) };
    await expect(change(sql`next_period_starts_on = '2027-07-02'`)).rejects.toMatchObject(lifecycle);
    await expect(change(sql`next_period_starts_on = '2027-03-31'`)).rejects.toMatchObject(lifecycle);
    await expect(change(sql`status = 'cancelled'`)).rejects.toMatchObject(lifecycle);
    await expect(change(sql`cancel_reason = 'other'`)).rejects.toMatchObject(lifecycle);
    await expect(asApi((tx) => tx.db.execute(sql`delete from operational.subscriptions where id = ${subscription.subscriptionId}`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }),
    });
  });
});
