import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { chargeInvoice } from '../../src/modules/billing/charges.js';
import { type Clearance, type ClearanceSource, type PaidOrders, chargingHandlers, renewalsJob, startSubscription } from '../../src/modules/billing/index.js';
import { deliverDueEvents } from '../../src/lib/outbox-delivery.js';
import { FAKE_METHODS } from '../../src/modules/payments/fake-processor.js';
import { savePaymentMethod } from '../../src/modules/payments/index.js';
import { fakeProcessor } from '../../src/modules/payments/processors.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPaymentAccount, tenantWith } from '../support/db.js';
import { recordingLog } from '../support/log.js';

/**
 * Charging period invoices to saved cards (docs/decisions/billing.md BIL28
 * to BIL30), against the fake processor. Today is 10 March 2027, 12:00 in
 * Sydney. Patients, orders and pharmacies are made-up ids.
 */
const NOW = new Date('2027-03-10T01:00:00Z');
let app: App;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
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

async function call(method: 'GET' | 'POST', url: string, body?: object) {
  const response = await app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(support.email), clinic.tenantId), ...(body ? { payload: body } : {}) });
  return { status: response.statusCode, body: response.json() };
}

const productA = randomUUID();
const program = { feeKind: 'program', amountCents: 11000 };
const bundled = [program, { feeKind: 'medicine', productId: productA, amountCents: 22000, pharmacyShareCents: 12000 }];
async function livePrice(fees: object[] = [program], billingModel = 'pharmacy_billed'): Promise<string> {
  const draft = await app.inject({
    method: 'POST',
    url: '/v1/prices',
    headers: headers(await signIn(finance.email), clinic.tenantId),
    payload: { programId: randomUUID(), name: 'Monthly', billingModel, interval: { unit: 'month', count: 1 }, paymentAccountId: account, fees },
  });
  const live = await app.inject({ method: 'POST', url: `/v1/prices/${draft.json().priceId}/publish`, headers: headers(await signIn(finance.email), clinic.tenantId), payload: { gstTreatmentsConfirmed: true } });
  return live.json().priceId;
}

const saveCard = (patientId: string, processorMethodId = `pm_fake_${randomUUID()}`) =>
  inClinic((tx) =>
    savePaymentMethod(tx, { patientId, paymentAccountId: account, processorCustomerId: 'cus_fake', processorMethodId, brand: 'visa', last4: '4242', expMonth: 12, expYear: 2030, consentedAt: new Date() }),
  );

/** A card of the kind the fake answers by its id's start (FAKE_METHODS), unique to one patient. */
const card = (kind: string = 'pm_fake_ok') => `${kind}_${randomUUID()}`;

/** A pending subscription whose patient has the given card, or none. */
async function subscribe(method: string | null = card(), fees?: object[], billingModel?: string) {
  const priceId = await livePrice(fees, billingModel);
  const started = await inClinic((tx) => startSubscription(tx, { patientId: randomUUID(), priceId, timeZone: 'Australia/Sydney' }));
  if (method) await saveCard(started.patientId, method);
  return started;
}

/** Consults and orders, faked: a period is cleared once a test says so, and orders answers as told. */
const clearances = new Map<string, Clearance>();
const ordersAnswer = new Map<string, 'paid' | 'refused'>();
const orders: PaidOrders = { markOrderPaid: async (_tx, { orderId }) => ordersAnswer.get(orderId) ?? 'paid' };
const log = recordingLog();
const source: ClearanceSource = { clearanceForPeriod: async (_tx, r) => clearances.get(r.subscriptionId) ?? { status: 'held', reason: 'other' } };
const deps = { clearances: source, orders };
const release = (subscriptionId: string, clearance: Clearance = { status: 'cleared', orderId: null, medicineProductId: null, partnerPharmacyId: null }) => {
  clearances.set(subscriptionId, clearance);
  return renewalsJob(source).run({ name: 'billing-renewals', log }).catch(() => undefined);
};
/** One pass of the outbox, with everything waiting made due first, as if its backoff had passed. */
const deliver = async () => {
  await admin.query('update platform.outbox set next_attempt_at = now() where delivered_at is null and failed_at is null');
  return deliverDueEvents(chargingHandlers(deps), log, { perTenant: 1000 });
};

const invoicesOf = async (subscriptionId: string) => (await call('GET', `/invoices?subscriptionId=${subscriptionId}`)).body.invoices;
const subscription = async (id: string) => (await call('GET', `/subscriptions/${id}`)).body;
const events = (recordId: string) => admin.query('select type from platform.outbox where record_id = $1 order by id', [recordId]).then((r) => r.rows.map((row) => row.type));
/** The ledger entries an invoice and its payment made, by kind. */
const entries = (invoiceId: string, paymentId: string) =>
  admin
    .query(`select kind from operational.ledger_entries where idempotency_key like any($1) order by kind`, [[`invoice:${invoiceId}:%`, `payment:${paymentId}:%`]])
    .then((r) => r.rows.map((row) => row.kind));
/** What the fake processor was asked to charge for a subscription's newest invoice. */
const chargeFor = async (subscriptionId: string) => {
  const [invoice] = await invoicesOf(subscriptionId);
  return stripe.charges.find((charge) => charge.paymentId === invoice.payments.at(-1).paymentId)!;
};
const receivable = (patientId: string) =>
  admin.query(`select balance_cents::int as cents from operational.ledger_accounts where kind = 'patient_receivable' and patient_id = $1`, [patientId]).then((r) => r.rows[0]?.cents);

describe('charging a period invoice (BIL28, BIL29)', () => {
  it('charges the default card once issued, posts the payment, and only then starts the period', async () => {
    const started = await subscribe();
    await release(started.subscriptionId);
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'pending', currentPeriod: null, renewalHeld: null });
    const before = stripe.charges.length;
    await deliver();
    const [invoice] = await invoicesOf(started.subscriptionId);
    expect(invoice).toMatchObject({ status: 'paid', paidAt: expect.any(String), payments: [{ attempt: 1, status: 'succeeded', amountCents: 11000, card: { brand: 'visa', last4: '4242' }, failureCode: null }] });
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'active', currentPeriod: { startsOn: '2027-03-10', endsOn: '2027-04-10' } });
    expect(await entries(invoice.invoiceId, invoice.payments[0].paymentId)).toEqual(['invoice_issued', 'payment_received']);
    expect(await receivable(started.patientId)).toBe(0);
    expect(stripe.charges.slice(before)).toEqual([
      expect.objectContaining({ processorAccountId: expect.stringMatching(/^acct_fake/), amountCents: 11000, tenantId: clinic.tenantId, invoiceId: invoice.invoiceId, paymentId: invoice.payments[0].paymentId }),
    ]);
    expect(await events(invoice.invoiceId)).toEqual(['invoice.issued', 'invoice.paid']);
    expect(await events(started.subscriptionId)).toContain('subscription.activated');

    await chargeInvoice({ tenantId: clinic.tenantId, actor: { type: 'system' }, requestId: 'test' }, invoice.invoiceId, 'issued', deps);
    expect(stripe.charges.length).toBe(before + 1);
  });

  it('asks again with the same key when a reply is lost, and keeps asking while the processor decides', async () => {
    const lost = await subscribe();
    await release(lost.subscriptionId);
    stripe.loseNextReply();
    expect((await deliver()).retrying).toBeGreaterThan(0);
    expect((await invoicesOf(lost.subscriptionId))[0]).toMatchObject({ status: 'open', payments: [{ status: 'pending' }] });
    const before = stripe.charges.length;
    await deliver();
    expect((await invoicesOf(lost.subscriptionId))[0]).toMatchObject({ status: 'paid', payments: [{ attempt: 1, status: 'succeeded' }] });
    expect(stripe.charges.length).toBe(before);

    const slow = await subscribe(card(FAKE_METHODS.pending));
    await release(slow.subscriptionId);
    await deliver();
    expect((await invoicesOf(slow.subscriptionId))[0]).toMatchObject({ status: 'open', payments: [{ status: 'pending' }] });
    stripe.settle((await chargeFor(slow.subscriptionId)).result.processorPaymentId!, 'succeeded');
    await deliver();
    expect((await invoicesOf(slow.subscriptionId))[0]).toMatchObject({ status: 'paid', payments: [{ status: 'succeeded' }] });
    expect((await subscription(slow.subscriptionId)).status).toBe('active');
  });

  it('makes the invoice past due on a decline, a card that needs the patient, or no card, and issues nothing more', async () => {
    const declined = await subscribe(card(FAKE_METHODS.declined));
    const needsPatient = await subscribe(card(FAKE_METHODS.needsAuthentication));
    const noCard = await subscribe(null);
    for (const s of [declined, needsPatient, noCard]) await release(s.subscriptionId);
    await deliver();
    expect((await invoicesOf(declined.subscriptionId))[0]).toMatchObject({ status: 'past_due', payments: [{ status: 'failed', failureCode: 'insufficient_funds' }] });
    expect((await invoicesOf(needsPatient.subscriptionId))[0]).toMatchObject({ status: 'past_due', payments: [{ status: 'failed', failureCode: 'authentication_required' }] });
    const [unpaid] = await invoicesOf(noCard.subscriptionId);
    expect(unpaid).toMatchObject({ status: 'past_due', payments: [] });
    expect(await events(unpaid.invoiceId)).toEqual(['invoice.issued', 'invoice.past_due']);
    expect(await subscription(noCard.subscriptionId)).toMatchObject({ status: 'pending', currentPeriod: null });
    await release(noCard.subscriptionId);
    expect(await invoicesOf(noCard.subscriptionId)).toHaveLength(1);
  });
});

describe('a payment that cannot stand is refunded (BIL30)', () => {
  it('refunds in full when orders refuses, voids the invoice, holds the renewal, and lets the period be issued again', async () => {
    const started = await subscribe(undefined, bundled, 'bundled');
    const order = { orderId: randomUUID(), medicineProductId: productA, partnerPharmacyId: randomUUID() };
    ordersAnswer.set(order.orderId, 'refused');
    await release(started.subscriptionId, { status: 'cleared', ...order });
    await deliver();
    await deliver();
    const [invoice] = await invoicesOf(started.subscriptionId);
    expect(invoice).toMatchObject({ status: 'void', voidedAt: expect.any(String), payments: [{ status: 'refunded', refundedAt: expect.any(String) }] });
    expect(await entries(invoice.invoiceId, invoice.payments[0].paymentId)).toEqual(['invoice_issued', 'payment_received', 'refund_paid', 'reversal']);
    expect(await receivable(started.patientId)).toBe(0);
    expect(stripe.refundsMade.at(-1)).toMatchObject({ amountCents: 33000 });
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'pending', renewalHeld: { reason: 'no_current_script' } });
    expect(await events(invoice.invoiceId)).toContain('invoice.voided');

    const next = { ...order, orderId: randomUUID() };
    await release(started.subscriptionId, { status: 'cleared', ...next });
    await deliver();
    const reissued = await invoicesOf(started.subscriptionId);
    expect(reissued.map((i: { status: string; period: object }) => [i.status, i.period])).toEqual([
      ['paid', { startsOn: '2027-03-10', endsOn: '2027-04-10' }],
      ['void', { startsOn: '2027-03-10', endsOn: '2027-04-10' }],
    ]);
  });

  it('voids an unpaid invoice when the patient cancels, pauses or skips, and refunds a charge that lands after', async () => {
    const cancelling = await subscribe(card(FAKE_METHODS.declined));
    await release(cancelling.subscriptionId);
    await deliver();
    await call('POST', `/subscriptions/${cancelling.subscriptionId}/cancel`, { when: 'period_end', reason: 'patient_request' });
    expect((await invoicesOf(cancelling.subscriptionId))[0].status).toBe('void');
    expect(await receivable(cancelling.patientId)).toBe(0);

    const pausing = await subscribe();
    const skipping = await subscribe();
    for (const s of [pausing, skipping]) await release(s.subscriptionId);
    await deliver();
    for (const s of [pausing, skipping]) await saveCard(s.patientId, card(FAKE_METHODS.declined));
    vi.setSystemTime(new Date('2027-04-10T01:00:00Z'));
    for (const s of [pausing, skipping]) await release(s.subscriptionId);
    await deliver();
    expect((await call('POST', `/subscriptions/${pausing.subscriptionId}/pause`, { resumesOn: '2027-05-01' })).body).toMatchObject({ status: 'paused', nextPeriodStartsOn: '2027-05-01' });
    expect((await call('POST', `/subscriptions/${skipping.subscriptionId}/skip`)).body).toMatchObject({ nextPeriodStartsOn: '2027-05-10' });
    for (const s of [pausing, skipping]) expect((await invoicesOf(s.subscriptionId)).map((i: { status: string }) => i.status)).toEqual(['void', 'paid']);

    vi.setSystemTime(NOW);
    const inFlight = await subscribe(card(FAKE_METHODS.pending));
    await release(inFlight.subscriptionId);
    await deliver();
    await call('POST', `/subscriptions/${inFlight.subscriptionId}/cancel`, { when: 'now', reason: 'patient_request' });
    stripe.settle((await chargeFor(inFlight.subscriptionId)).result.processorPaymentId!, 'succeeded');
    await deliver();
    await deliver();
    expect((await invoicesOf(inFlight.subscriptionId))[0]).toMatchObject({ status: 'void', payments: [{ status: 'refunded' }] });
    expect(await subscription(inFlight.subscriptionId)).toMatchObject({ status: 'cancelled', currentPeriod: null });
    expect(await receivable(inFlight.patientId)).toBe(0);
  });
});

describe('the database keeps the rules (ADR 0028, ADR 0006)', () => {
  it('holds a payment to its invoice total and card account, takes the money once, and keeps other tenants out', async () => {
    const started = await subscribe();
    await release(started.subscriptionId);
    await deliver();
    const [invoice] = await invoicesOf(started.subscriptionId);
    const { paymentId } = invoice.payments[0];
    const another = (amountCents: string, status: string, failureCode: string | null) =>
      admin.query(
        `insert into operational.payments (tenant_id, invoice_id, payment_account_id, payment_method_id, attempt, amount_cents, status, processor_payment_id, failure_code, settled_at)
         select tenant_id, invoice_id, payment_account_id, payment_method_id, attempt + 1, ${amountCents}, $2, 'pi_another', $3, now() from operational.payments where id = $1`,
        [paymentId, status, failureCode],
      );
    await expect(another('amount_cents - 1', 'failed', 'card_declined')).rejects.toThrow(/payments_invoice_fk/);
    await expect(another('amount_cents', 'succeeded', null)).rejects.toThrow(/payments_taken_key/);

    const asApi = <T>(tenantId: string, work: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId, actor: { type: 'system' }, requestId: 'test' }, work);
    for (const statement of [
      sql`update operational.payments set amount_cents = 1 where id = ${paymentId}`,
      sql`delete from operational.payments where id = ${paymentId}`,
      sql`delete from operational.payment_methods where patient_id = ${started.patientId}`,
      sql`update operational.payment_methods set last4 = '0000' where patient_id = ${started.patientId}`,
    ]) {
      await expect(asApi(clinic.tenantId, (tx) => tx.db.execute(statement))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    }
    const other = await tenantWith('owner');
    const seen = await asApi(other.tenantId, async (tx) => ({
      payments: (await tx.db.execute(sql`select id from operational.payments where id = ${paymentId}`)).rows,
      methods: (await tx.db.execute(sql`select id from operational.payment_methods where patient_id = ${started.patientId}`)).rows,
      changed: (await tx.db.execute(sql`update operational.payment_methods set is_default = false where patient_id = ${started.patientId}`)).rowCount,
    }));
    expect(seen).toEqual({ payments: [], methods: [], changed: 0 });
  });
});
