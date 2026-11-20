import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import {
  type Clearance,
  type ClearanceRequest,
  type ClearanceSource,
  type PaidOrders,
  chargingHandlers,
  renewalsJob,
  startSubscription,
  upcomingRenewals,
} from '../../src/modules/billing/index.js';
import { savePaymentMethod } from '../../src/modules/payments/index.js';
import { deliverDueEvents } from '../../src/lib/outbox-delivery.js';
import { releaseDuePeriod } from '../../src/modules/billing/renewals.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPaymentAccount, tenantWith } from '../support/db.js';
import { recordingLog } from '../support/log.js';

/**
 * Invoices and renewals (docs/decisions/billing.md BIL23 to BIL27). Today is
 * 10 March 2027, 12:00 in Sydney, unless a test moves the clock. Patients,
 * programs, products, orders and pharmacies are made-up ids until those
 * tables merge; a fake stands in for consults and orders. Every patient has
 * a saved card at the fake processor, so a released period is paid and
 * starts when the outbox is delivered (BIL29).
 */
const NOW = new Date('2027-03-10T01:00:00Z');
let app: App;
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
  app = await testApp();
});
afterEach(() => {
  vi.setSystemTime(NOW);
});
afterAll(async () => {
  vi.useRealTimers();
  await app.close();
  await closeDatabase();
  await admin.end();
});

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

const productA = randomUUID();
const program = { feeKind: 'program', amountCents: 11000 };
const consult = { feeKind: 'consult', amountCents: 4900 };
const bundledFees = [program, { feeKind: 'medicine', productId: productA, amountCents: 22000, pharmacyShareCents: 12000 }, { feeKind: 'shipping', amountCents: 1000 }];

async function livePrice(fees: object[] = [program], options: { billingModel?: string; paymentAccountId?: string } = {}): Promise<{ priceId: string }> {
  const who = { email: finance.email, tenantId: clinic.tenantId };
  const draft = await call(
    'POST',
    '/prices',
    { programId: randomUUID(), name: 'Monthly', billingModel: options.billingModel ?? 'pharmacy_billed', interval: { unit: 'month', count: 1 }, paymentAccountId: options.paymentAccountId ?? account, fees },
    who,
  );
  return (await call('POST', `/prices/${draft.body.priceId}/publish`, { gstTreatmentsConfirmed: true }, who)).body;
}

const start = (price: { priceId: string }) =>
  inClinic(async (tx) => {
    const started = await startSubscription(tx, { patientId: randomUUID(), priceId: price.priceId, timeZone: 'Australia/Sydney' });
    await savePaymentMethod(tx, {
      patientId: started.patientId,
      paymentAccountId: started.paymentAccountId,
      processorCustomerId: 'cus_fake',
      processorMethodId: `pm_fake_${randomUUID()}`,
      brand: 'visa',
      last4: '4242',
      expMonth: 12,
      expYear: 2030,
      consentedAt: new Date(),
    });
    return started;
  });

/** Consults and orders, as far as billing can tell: held until a test says otherwise. */
const answers = new Map<string, Clearance | Error>();
const asked: ClearanceRequest[] = [];
const fake: ClearanceSource = {
  clearanceForPeriod: async (_tx, request) => {
    asked.push(request);
    const answer = answers.get(request.subscriptionId) ?? { status: 'held', reason: 'awaiting_clinician' };
    if (answer instanceof Error) throw answer;
    return answer;
  },
};
const cleared = (order?: { orderId: string; medicineProductId: string; partnerPharmacyId: string }): Clearance => ({
  status: 'cleared',
  orderId: order?.orderId ?? null,
  medicineProductId: order?.medicineProductId ?? null,
  partnerPharmacyId: order?.partnerPharmacyId ?? null,
});
const anOrder = () => ({ orderId: randomUUID(), medicineProductId: productA, partnerPharmacyId: randomUUID() });

const log = recordingLog();
const paid: PaidOrders = { markOrderPaid: async () => 'paid' };
const runRenewals = () => renewalsJob(fake).run({ name: 'billing-renewals', log });
/** Release what is due, then charge it, as the worker would. */
const runQuietly = async () => {
  await runRenewals().catch(() => undefined);
  await deliverDueEvents(chargingHandlers(paid), log, { perTenant: 1000 });
};
const at = (instant: string) => vi.setSystemTime(new Date(instant));

const invoicesOf = async (subscriptionId: string) => (await call('GET', `/invoices?subscriptionId=${subscriptionId}`)).body.invoices;
const subscription = async (id: string) => (await call('GET', `/subscriptions/${id}`)).body;
const events = (recordId: string) => admin.query(`select type from platform.outbox where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.type));
const posting = (invoiceId: string) =>
  admin
    .query(
      `select a.kind, l.amount_cents::int as cents from operational.ledger_lines l join operational.ledger_entries e on e.id = l.entry_id
        join operational.ledger_accounts a on a.id = l.account_id where e.idempotency_key = $1 order by l.amount_cents desc, a.kind`,
      [`invoice:${invoiceId}:issued`],
    )
    .then((r) => r.rows.map((row) => [row.kind, row.cents]));
const sequence = (number: string) => Number(number.split('-')[1]);

describe('the consult at checkout (BIL23, BIL25)', () => {
  it('issues the consult invoice at checkout, numbered per company without gaps, and posts it', async () => {
    const price = await livePrice([consult, program]);
    const first = await start(price);
    const [invoice] = await invoicesOf(first.subscriptionId);
    expect(invoice).toMatchObject({ kind: 'consult', period: null, orderId: null, status: 'open', totalCents: 4900, gstCents: 0, lines: [{ feeKind: 'consult', amountCents: 4900, gstTreatment: 'gst_free' }] });
    expect(invoice.number).toMatch(/^INV-\d{6}$/);
    expect(await posting(invoice.invoiceId)).toEqual([
      ['patient_receivable', 4900],
      ['revenue_consult', -4900],
    ]);

    await expect(inClinic(async (tx) => {
      await startSubscription(tx, { patientId: randomUUID(), priceId: price.priceId, timeZone: 'Australia/Sydney' });
      throw new Error('checkout failed after the invoice');
    })).rejects.toThrow('checkout failed');
    const [next] = await invoicesOf((await start(price)).subscriptionId);
    expect(sequence(next.number)).toBe(sequence(invoice.number) + 1);

    const elsewhere = await createPaymentAccount(clinic.tenantId);
    const [own] = await invoicesOf((await start(await livePrice([consult, program], { paymentAccountId: elsewhere }))).subscriptionId);
    expect(own.number).toBe('INV-000001');
    expect(own.companyId).not.toBe(invoice.companyId);
  });
});

describe('releasing a billing period (BIL24)', () => {
  it('holds the first period until it is cleared, telling staff once per reason', async () => {
    const started = await start(await livePrice());
    await runQuietly();
    expect(asked.findLast((r) => r.subscriptionId === started.subscriptionId)).toMatchObject({ first: true, periodStartsOn: '2027-03-10', billingModel: 'pharmacy_billed' });
    expect((await subscription(started.subscriptionId)).renewalHeld).toMatchObject({ reason: 'awaiting_clinician' });
    await runQuietly();
    answers.set(started.subscriptionId, { status: 'held', reason: 'no_current_script' });
    await runQuietly();
    expect((await events(started.subscriptionId)).filter((type: string) => type === 'subscription.renewal_held')).toHaveLength(2);
    expect(await invoicesOf(started.subscriptionId)).toEqual([]);

    answers.set(started.subscriptionId, cleared());
    await runQuietly();
    const [invoice] = await invoicesOf(started.subscriptionId);
    expect(invoice).toMatchObject({ kind: 'period', period: { startsOn: '2027-03-10', endsOn: '2027-04-10' }, orderId: null, totalCents: 11000, gstCents: 1000 });
    expect(await posting(invoice.invoiceId)).toEqual([
      ['patient_receivable', 11000],
      ['gst_collected', -1000],
      ['revenue_program', -10000],
    ]);
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'active', currentPeriod: { startsOn: '2027-03-10', endsOn: '2027-04-10' }, renewalHeld: null });
    const askedBefore = asked.length;
    await runQuietly();
    expect(asked.slice(askedBefore).some((r) => r.subscriptionId === started.subscriptionId)).toBe(false);
  });

  it("charges medicine only for the order that cleared it, and credits the pharmacy its share", async () => {
    const price = await livePrice(bundledFees, { billingModel: 'bundled' });
    const started = await start(price);
    const order = anOrder();
    answers.set(started.subscriptionId, cleared(order));
    const wrongProduct = await start(price);
    answers.set(wrongProduct.subscriptionId, cleared({ ...anOrder(), medicineProductId: randomUUID() }));
    await runQuietly();
    const [invoice] = await invoicesOf(started.subscriptionId);
    expect(invoice).toMatchObject({ orderId: order.orderId, totalCents: 34000, gstCents: 1000 });
    expect(invoice.lines.map((line: { feeKind: string; productId: string | null }) => [line.feeKind, line.productId])).toEqual([
      ['program', null],
      ['medicine', productA],
      ['shipping', null],
    ]);
    expect(await posting(invoice.invoiceId)).toEqual([
      ['patient_receivable', 34000],
      ['gst_collected', -1000],
      ['revenue_shipping', -1000],
      ['revenue_medicine', -10000],
      ['revenue_program', -10000],
      ['pharmacy_payable', -12000],
    ]);
    expect(await invoicesOf(wrongProduct.subscriptionId)).toEqual([]);
    expect((await subscription(wrongProduct.subscriptionId)).renewalHeld.reason).toBe('no_medicine_fee');

    const again = await start(price);
    answers.set(again.subscriptionId, cleared(order));
    await expect(inClinic((tx) => releaseDuePeriod(tx, again.subscriptionId, fake))).rejects.toMatchObject({
      cause: expect.objectContaining({ constraint: 'invoices_one_per_order_key' }),
    });
  });

  it("renews at 10:00 on the period's first day in the patient's time zone, re-anchoring a late one", async () => {
    const onTime = await start(await livePrice());
    const late = await start(await livePrice());
    answers.set(onTime.subscriptionId, cleared());
    answers.set(late.subscriptionId, cleared());
    await runQuietly();
    answers.set(late.subscriptionId, { status: 'held', reason: 'no_order' });
    at('2027-04-09T23:30:00Z'); // 09:30 on 10 April in Sydney
    await runQuietly();
    expect(await invoicesOf(onTime.subscriptionId)).toHaveLength(1);
    at('2027-04-10T00:30:00Z'); // 10:30
    await runQuietly();
    expect((await invoicesOf(onTime.subscriptionId))[0].period).toEqual({ startsOn: '2027-04-10', endsOn: '2027-05-10' });
    expect((await subscription(late.subscriptionId)).renewalHeld.reason).toBe('no_order');
    answers.set(late.subscriptionId, cleared());
    at('2027-04-13T01:00:00Z');
    await runQuietly();
    expect((await invoicesOf(late.subscriptionId))[0].period).toEqual({ startsOn: '2027-04-13', endsOn: '2027-05-13' });
    expect(await events(onTime.subscriptionId)).toContain('subscription.renewed');
  });

  it('ends a scheduled cancellation when its period is over instead of renewing it', async () => {
    const started = await start(await livePrice());
    answers.set(started.subscriptionId, cleared());
    await runQuietly();
    await call('POST', `/subscriptions/${started.subscriptionId}/cancel`, { when: 'period_end', reason: 'patient_request' });
    at('2027-04-10T00:30:00Z');
    await runQuietly();
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'cancelled', endedOn: '2027-04-10', cancelReason: 'patient_request' });
    expect(await invoicesOf(started.subscriptionId)).toHaveLength(1);
  });

  it('ends the subscription when the clinician declines, charging nothing', async () => {
    const started = await start(await livePrice([consult, program]));
    answers.set(started.subscriptionId, { status: 'declined' });
    await runQuietly();
    expect(await subscription(started.subscriptionId)).toMatchObject({ status: 'cancelled', cancelReason: 'clinician_declined', endedOn: '2027-03-10' });
    expect((await invoicesOf(started.subscriptionId)).map((invoice: { kind: string }) => invoice.kind)).toEqual(['consult']);
  });

  it('carries on past a subscription that fails, and reports it', async () => {
    const broken = await start(await livePrice());
    const fine = await start(await livePrice());
    answers.set(broken.subscriptionId, new Error('orders is down'));
    answers.set(fine.subscriptionId, cleared());
    await expect(runRenewals()).rejects.toThrow(/renewals failed/);
    expect(await invoicesOf(fine.subscriptionId)).toHaveLength(1);
    expect(log.lines.some((line) => line.message === 'renewal failed' && (line.details as { subscriptionId?: string }).subscriptionId === broken.subscriptionId)).toBe(true);
  });
});

describe('what orders reads ahead (BIL26)', () => {
  it('lists the subscriptions that will renew within the window, and nothing paused or ending', async () => {
    const renewing = await start(await livePrice());
    const pausing = await start(await livePrice());
    const ending = await start(await livePrice());
    for (const s of [renewing, pausing, ending]) answers.set(s.subscriptionId, cleared());
    await runQuietly();
    await call('POST', `/subscriptions/${pausing.subscriptionId}/pause`, { resumesOn: '2027-05-10' });
    await call('POST', `/subscriptions/${ending.subscriptionId}/cancel`, { when: 'period_end', reason: 'other' });
    const ours = (list: { subscriptionId: string }[]) => list.filter((r) => [renewing, pausing, ending].some((s) => s.subscriptionId === r.subscriptionId));
    expect(ours(await inClinic((tx) => upcomingRenewals(tx, { withinDays: 3 })))).toEqual([]);
    expect(ours(await inClinic((tx) => upcomingRenewals(tx, { withinDays: 31 })))).toEqual([
      { subscriptionId: renewing.subscriptionId, patientId: renewing.patientId, programId: renewing.programId, priceId: renewing.priceId, billingModel: 'pharmacy_billed', periodStartsOn: '2027-04-10' },
    ]);
  });
});

describe('who may, and tenancy (BIL27, ADR 0006)', () => {
  it('lets support, finance and the owner read invoices, not clinicians, and nobody in another tenant', async () => {
    const started = await start(await livePrice([consult, program]));
    const [invoice] = await invoicesOf(started.subscriptionId);
    expect((await call('GET', `/invoices/${invoice.invoiceId}`, undefined, { email: finance.email, tenantId: clinic.tenantId })).body).toEqual(invoice);
    expect((await call('GET', `/invoices?patientId=${started.patientId}`, undefined, { email: clinic.members[0]!.email, tenantId: clinic.tenantId })).body.invoices).toEqual([invoice]);
    expect((await call('GET', '/invoices', undefined, { email: clinician.email, tenantId: clinic.tenantId })).status).toBe(403);
    const other = await tenantWith('support');
    const them = { email: other.members[0]!.email, tenantId: other.tenantId };
    expect((await call('GET', `/invoices?subscriptionId=${started.subscriptionId}`, undefined, them)).body.invoices).toEqual([]);
    expect((await call('GET', `/invoices/${invoice.invoiceId}`, undefined, them)).status).toBe(404);
  });
});

describe('the database keeps the rules (ADR 0028)', () => {
  const asApi = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId: clinic.tenantId, actor: { type: 'system' }, requestId: 'test' }, work);

  it('refuses medicine without its invoice\'s order, a second invoice for a period, and any change or delete', async () => {
    const price = await livePrice(bundledFees, { billingModel: 'bundled' });
    const started = await start(price);
    answers.set(started.subscriptionId, cleared(anOrder()));
    await runQuietly();
    const [invoice] = await invoicesOf(started.subscriptionId);
    const line = (orderId: string | null) =>
      admin.query(
        `insert into operational.invoice_lines (tenant_id, invoice_id, order_id, fee_kind, product_id, amount_cents, pharmacy_share_cents, gst_treatment, gst_cents)
         values ($1, $2, $3, 'medicine', $4, 100, 50, 'gst_free', 0)`,
        [clinic.tenantId, invoice.invoiceId, orderId, productA],
      );
    await expect(line(null)).rejects.toThrow(/invoice_lines_shape_check/);
    await expect(line(randomUUID())).rejects.toThrow(/invoice_lines_order_fk/);
    await expect(
      admin.query(
        `insert into operational.invoices (tenant_id, company_id, number, patient_id, subscription_id, price_id, payment_account_id, kind, period_starts_on, period_ends_on, total_cents, gst_cents)
         select tenant_id, company_id, 'INV-999999', patient_id, subscription_id, price_id, payment_account_id, kind, period_starts_on, period_ends_on, 1, 0 from operational.invoices where id = $1`,
        [invoice.invoiceId],
      ),
    ).rejects.toThrow(/invoices_period_key/);
    for (const statement of [
      sql`update operational.invoices set total_cents = 1 where id = ${invoice.invoiceId}`,
      sql`delete from operational.invoice_lines where invoice_id = ${invoice.invoiceId}`,
      sql`delete from operational.invoices where id = ${invoice.invoiceId}`,
    ]) {
      await expect(asApi((tx) => tx.db.execute(statement))).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
    }
  });
});
