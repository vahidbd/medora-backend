import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { type Clearance, type ClearanceSource, type PaidOrders, chargingHandlers, renewalsJob, retriesJob, startSubscription } from '../../src/modules/billing/index.js';
import { deliverDueEvents } from '../../src/lib/outbox-delivery.js';
import { FAKE_METHODS } from '../../src/modules/payments/fake-processor.js';
import { savePaymentMethod } from '../../src/modules/payments/index.js';
import { fakeProcessor } from '../../src/modules/payments/processors.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPaymentAccount, tenantWith } from '../support/db.js';
import { recordingLog } from '../support/log.js';

/**
 * Retrying past-due invoices (docs/decisions/billing.md BIL31), against the
 * fake processor. Invoices go past due on 10 March 2027 in Sydney (AEDT,
 * UTC+11), so retries fall at 10:00 on 11, 13, 15 and 17 March. Patients are
 * made-up ids.
 */
const sydney = (day: number, time = '10:00') => new Date(`2027-03-${String(day).padStart(2, '0')}T${time}:00+11:00`);
let app: App;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(sydney(10, '12:00'));
  app = await testApp();
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await closeDatabase();
  await admin.end();
});

const clinic = await tenantWith('owner', 'finance', 'support');
const [, finance, support] = clinic.members as [(typeof clinic.members)[number], (typeof clinic.members)[number], (typeof clinic.members)[number]];
const account = await createPaymentAccount(clinic.tenantId);
const stripe = fakeProcessor('stripe');
const inClinic = <T>(work: Parameters<typeof withTenant<T>>[1]) =>
  withTenant({ tenantId: clinic.tenantId, actor: { type: 'person', userId: finance.id }, requestId: 'test' } satisfies TenantContext, work);
const get = async (url: string) => (await app.inject({ method: 'GET', url: `/v1${url}`, headers: headers(await signIn(support.email), clinic.tenantId) })).json();

let priceId: string;
beforeAll(async () => {
  const as = headers(await signIn(finance.email), clinic.tenantId);
  const fees = [{ feeKind: 'program', amountCents: 11000 }];
  const draft = await app.inject({
    method: 'POST',
    url: '/v1/prices',
    headers: as,
    payload: { programId: randomUUID(), name: 'Monthly', billingModel: 'pharmacy_billed', interval: { unit: 'month', count: 1 }, paymentAccountId: account, fees },
  });
  priceId = (await app.inject({ method: 'POST', url: `/v1/prices/${draft.json().priceId}/publish`, headers: as, payload: { gstTreatmentsConfirmed: true } })).json().priceId;
});

/** A card of the kind the fake answers by its id's start (FAKE_METHODS), unique to one patient. */
const card = (kind: string = 'pm_fake_ok') => `${kind}_${randomUUID()}`;
const saveCard = (patientId: string, processorMethodId: string) =>
  inClinic((tx) =>
    savePaymentMethod(tx, { patientId, paymentAccountId: account, processorCustomerId: 'cus_fake', processorMethodId, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, consentedAt: new Date() }),
  );

/** Consults and orders, faked: every period is cleared unless a test says otherwise, and every order takes its payment. */
const clearances = new Map<string, Clearance>();
const source: ClearanceSource = {
  clearanceForPeriod: async (_tx, r) => clearances.get(r.subscriptionId) ?? { status: 'cleared', orderId: null, medicineProductId: null, partnerPharmacyId: null },
};
const orders: PaidOrders = { markOrderPaid: async () => 'paid' };
const deps = { clearances: source, orders };
const log = recordingLog();
/** One pass of the outbox, with everything waiting made due first, as if its backoff had passed. */
const deliver = async () => {
  await admin.query('update platform.outbox set next_attempt_at = now() where delivered_at is null and failed_at is null');
  return deliverDueEvents(chargingHandlers(deps), log, { perTenant: 1000 });
};
/** The retries job at a moment, and anything it set off. */
const retryAt = async (at: Date) => {
  vi.setSystemTime(at);
  await retriesJob(deps)
    .run({ name: 'billing-retries', log })
    .catch(() => undefined);
  await deliver();
};

/** A patient with the given card, or none, whose first period invoice was issued and tried on 10 March. */
async function pastDue(method: string | null) {
  vi.setSystemTime(sydney(10, '12:00'));
  const started = await inClinic((tx) => startSubscription(tx, { patientId: randomUUID(), priceId, timeZone: 'Australia/Sydney' }));
  if (method) await saveCard(started.patientId, method);
  await renewalsJob(source)
    .run({ name: 'billing-renewals', log })
    .catch(() => undefined);
  await deliver();
  return { ...started, method };
}

const invoiceOf = async (subscriptionId: string) => (await get(`/invoices?subscriptionId=${subscriptionId}`)).invoices[0];
const subscription = (id: string) => get(`/subscriptions/${id}`);
const attempts = async (subscriptionId: string) => (await invoiceOf(subscriptionId)).payments.map((p: { retry: number | null; status: string }) => [p.retry, p.status]);
/** What the invoice told messaging, in order. */
const told = (invoiceId: string) =>
  admin
    .query(`select type, payload from platform.outbox where record_id = $1 and type in ('invoice.past_due', 'invoice.retried', 'invoice.paid', 'invoice.voided') order by id`, [invoiceId])
    .then((r) => r.rows.map((row) => ({ type: row.type, ...row.payload })));

describe('the retry schedule (BIL31)', () => {
  it('tries again at 10:00 on days 1, 3, 5 and 7, once each, and a soft decline that clears is paid', async () => {
    const { subscriptionId, method } = await pastDue(card(FAKE_METHODS.declined));
    expect(await invoiceOf(subscriptionId)).toMatchObject({ status: 'past_due', pastDueOn: '2027-03-10', retryDueOn: '2027-03-11' });

    await retryAt(sydney(11, '09:59'));
    expect(await attempts(subscriptionId)).toEqual([[null, 'failed']]);
    await retryAt(sydney(11));
    await retryAt(sydney(11, '16:00'));
    expect(await attempts(subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'failed'],
    ]);
    expect(await invoiceOf(subscriptionId)).toMatchObject({ status: 'past_due', retryDueOn: '2027-03-13' });

    stripe.setOutcome(method!, 'charged');
    await retryAt(sydney(13));
    const invoice = await invoiceOf(subscriptionId);
    expect(invoice).toMatchObject({ status: 'paid', pastDueOn: '2027-03-10', retryDueOn: null });
    expect(await attempts(subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'failed'],
      [2, 'succeeded'],
    ]);
    expect(await subscription(subscriptionId)).toMatchObject({ status: 'active', currentPeriod: { startsOn: '2027-03-10', endsOn: '2027-04-10' } });
    expect(await told(invoice.invoiceId)).toEqual([
      { type: 'invoice.past_due', patientId: invoice.patientId, subscriptionId, number: invoice.number, reason: 'payment_failed', retryDueOn: '2027-03-11' },
      { type: 'invoice.retried', patientId: invoice.patientId, subscriptionId, number: invoice.number, retry: 1, outcome: 'payment_failed', retryDueOn: '2027-03-13' },
      { type: 'invoice.paid', patientId: invoice.patientId, subscriptionId, number: invoice.number },
    ]);
  });

  it('never tries twice in a row when the job runs late, and ends the subscription when the last retry fails', async () => {
    const { subscriptionId, patientId } = await pastDue(card(FAKE_METHODS.declined));
    await retryAt(sydney(14));
    await retryAt(sydney(14, '10:15'));
    expect(await attempts(subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'failed'],
    ]);
    expect((await invoiceOf(subscriptionId)).retryDueOn).toBe('2027-03-15');

    await retryAt(sydney(15));
    await retryAt(sydney(17));
    const invoice = await invoiceOf(subscriptionId);
    expect(await attempts(subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'failed'],
      [3, 'failed'],
      [4, 'failed'],
    ]);
    expect(invoice).toMatchObject({ status: 'void', retryDueOn: null, pastDueOn: '2027-03-10' });
    expect(await subscription(subscriptionId)).toMatchObject({ status: 'cancelled', cancelReason: 'payment_failed', endedOn: '2027-03-17' });
    expect((await told(invoice.invoiceId)).slice(-2)).toEqual([
      expect.objectContaining({ type: 'invoice.retried', retry: 4, outcome: 'payment_failed', retryDueOn: null }),
      expect.objectContaining({ type: 'invoice.voided', reason: 'payment_failed' }),
    ]);
    const balance = await admin.query(`select balance_cents::int as cents from operational.ledger_accounts where kind = 'patient_receivable' and patient_id = $1`, [patientId]);
    expect(balance.rows[0].cents).toBe(0);
  });
});

describe('hard declines and new cards (BIL31)', () => {
  it('never tries a hard-declined card again until it is saved again, and tries a saved card at once', async () => {
    const { subscriptionId, patientId, method } = await pastDue(card(FAKE_METHODS.lost));
    const invoice = await invoiceOf(subscriptionId);
    expect(invoice.payments).toEqual([expect.objectContaining({ status: 'failed', failureCode: 'lost_card' })]);
    const declined = await admin.query('select declined_at from operational.payment_methods where processor_method_id = $1', [method]);
    expect(declined.rows[0].declined_at).not.toBeNull();

    await retryAt(sydney(11));
    expect(await attempts(subscriptionId)).toEqual([[null, 'failed']]);
    expect((await told(invoice.invoiceId)).map((e) => [e.type, e.reason ?? e.outcome])).toEqual([
      ['invoice.past_due', 'card_declined'],
      ['invoice.retried', 'no_payment_method'],
    ]);

    stripe.setOutcome(method!, 'charged');
    vi.setSystemTime(sydney(12));
    await saveCard(patientId, method!);
    await deliver();
    expect(await invoiceOf(subscriptionId)).toMatchObject({ status: 'paid', retryDueOn: null });
    expect(await attempts(subscriptionId)).toEqual([
      [null, 'failed'],
      [null, 'succeeded'],
    ]);
  });

  it("keeps the schedule when a new card's charge fails, and tries nothing without a card", async () => {
    const { subscriptionId, patientId } = await pastDue(null);
    const invoice = await invoiceOf(subscriptionId);
    expect(invoice).toMatchObject({ status: 'past_due', payments: [], retryDueOn: '2027-03-11' });
    await retryAt(sydney(11));
    expect(await invoiceOf(subscriptionId)).toMatchObject({ payments: [], retryDueOn: '2027-03-13' });

    vi.setSystemTime(sydney(12));
    await saveCard(patientId, card(FAKE_METHODS.declined));
    await deliver();
    expect(await invoiceOf(subscriptionId)).toMatchObject({ status: 'past_due', retryDueOn: '2027-03-13' });
    expect(await attempts(subscriptionId)).toEqual([[null, 'failed']]);
    expect((await told(invoice.invoiceId)).at(-1)).toMatchObject({ type: 'invoice.retried', retry: null, outcome: 'payment_failed', retryDueOn: '2027-03-13' });
  });
});

describe('every retry asks first (ADR 0009, BIL31)', () => {
  it('voids and holds when the period is no longer cleared, and ends the subscription when the clinician declines', async () => {
    const held = await pastDue(card(FAKE_METHODS.declined));
    const declined = await pastDue(card(FAKE_METHODS.declined));
    clearances.set(held.subscriptionId, { status: 'held', reason: 'no_current_script' });
    clearances.set(declined.subscriptionId, { status: 'declined' });
    await retryAt(sydney(11));

    const voided = await invoiceOf(held.subscriptionId);
    expect(voided).toMatchObject({ status: 'void', payments: [{ retry: null }] });
    expect((await told(voided.invoiceId)).at(-1)).toMatchObject({ type: 'invoice.voided', reason: 'not_cleared' });
    expect(await subscription(held.subscriptionId)).toMatchObject({ status: 'pending', renewalHeld: { reason: 'no_current_script' } });
    expect(await subscription(declined.subscriptionId)).toMatchObject({ status: 'cancelled', cancelReason: 'clinician_declined' });
    expect((await invoiceOf(declined.subscriptionId)).status).toBe('void');
  });

  it('asks a retry still in flight again, and stops asking with its key once the processor may have forgotten it', async () => {
    const slow = await pastDue(card(FAKE_METHODS.declined));
    stripe.setOutcome(slow.method!, 'pending');
    await retryAt(sydney(11));
    expect(await attempts(slow.subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'pending'],
    ]);
    const retried = (await invoiceOf(slow.subscriptionId)).payments[1].paymentId;
    stripe.settle(stripe.charges.find((charge) => charge.paymentId === retried)!.result.processorPaymentId!, 'succeeded');
    await retryAt(sydney(11, '10:15'));
    expect(await invoiceOf(slow.subscriptionId)).toMatchObject({ status: 'paid', retryDueOn: null });

    const lost = await pastDue(card(FAKE_METHODS.declined));
    stripe.setOutcome(lost.method!, 'charged');
    stripe.loseNextReply();
    await retryAt(sydney(11));
    const [, inFlight] = (await invoiceOf(lost.subscriptionId)).payments;
    expect(inFlight).toMatchObject({ retry: 1, status: 'pending' });
    await admin.query(`update operational.payments set created_at = created_at - interval '25 hours' where id = $1`, [inFlight.paymentId]);
    const made = () => stripe.charges.filter((charge) => charge.paymentId === inFlight.paymentId).length;
    expect(made()).toBe(1);
    await retryAt(sydney(13));
    expect(made()).toBe(1);
    expect(await attempts(lost.subscriptionId)).toEqual([
      [null, 'failed'],
      [1, 'pending'],
    ]);
    expect(log.lines).toContainEqual(
      expect.objectContaining({ level: 'error', message: 'retry failed', details: expect.objectContaining({ error: expect.stringContaining('too long ago') }) }),
    );
  });
});

describe('the database keeps the rules (ADR 0028)', () => {
  it('keeps the retry day to past-due invoices and the retry number to four', async () => {
    const { subscriptionId } = await pastDue(card(FAKE_METHODS.declined));
    const { invoiceId, payments } = await invoiceOf(subscriptionId);
    const asApi = (statement: ReturnType<typeof sql>) => withTenant({ tenantId: clinic.tenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) => tx.db.execute(statement));
    for (const change of [sql`past_due_on = null`, sql`retry_due_on = '2027-03-10'`, sql`status = 'open'`]) {
      await expect(asApi(sql`update operational.invoices set ${change} where id = ${invoiceId}`)).rejects.toMatchObject({
        cause: expect.objectContaining({ constraint: 'invoices_retry_check' }),
      });
    }
    await expect(admin.query(`update operational.payments set retry = 5 where id = $1`, [payments[0].paymentId])).rejects.toThrow(/payments_shape_check/);
    await expect(asApi(sql`update operational.payments set retry = 1 where id = ${payments[0].paymentId}`)).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });
});
