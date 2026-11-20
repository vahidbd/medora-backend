import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPaymentAccount, tenantWith } from '../support/db.js';

/** Prices (docs/decisions/billing.md BIL13 to BIL17). Programs and products are made-up ids until those tables merge. */
let app: App;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const clinic = await tenantWith('owner', 'finance', 'support');
const finance = clinic.members[1]!;
const support = clinic.members[2]!;

async function call(method: 'GET' | 'POST' | 'PUT', url: string, body?: object, who: { email: string; tenantId: string } = { email: finance.email, tenantId: clinic.tenantId }) {
  const response = await app.inject({ method, url: `/v1${url}`, headers: headers(await signIn(who.email), who.tenantId), ...(body ? { payload: body } : {}) });
  return { status: response.statusCode, body: response.json() };
}

const medicine = (amountCents = 22000, pharmacyShareCents = 12000) => ({ feeKind: 'medicine', productId: randomUUID(), amountCents, pharmacyShareCents });
const bundled = (fees: object[] = [{ feeKind: 'consult', amountCents: 4900 }, { feeKind: 'program', amountCents: 11000 }, medicine(), { feeKind: 'shipping', amountCents: 1000 }]) => ({
  programId: randomUUID(),
  name: 'Monthly',
  billingModel: 'bundled',
  interval: { unit: 'month', count: 1 },
  fees,
});
const confirm = { gstTreatmentsConfirmed: true };

async function livePrice(body = bundled()) {
  const created = await call('POST', '/prices', body);
  return (await call('POST', `/prices/${created.body.priceId}/publish`, confirm)).body;
}

const trail = (recordId: string) =>
  Promise.all([
    admin.query(`select action from platform.audit_log where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.action)),
    admin.query(`select type from platform.outbox where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.type)),
  ]);

describe('drafts', () => {
  it('adds a draft with GST treatments defaulted per fee kind, and works out the GST in each', async () => {
    const { status, body } = await call('POST', '/prices', bundled());
    expect(status).toBe(201);
    expect(body).toMatchObject({ status: 'draft', version: 1, replacesPriceId: null, publishedAt: null, interval: { unit: 'month', count: 1 } });
    expect(body.fees.map((f: { feeKind: string; gstTreatment: string; gstCents: number }) => [f.feeKind, f.gstTreatment, f.gstCents])).toEqual([
      ['consult', 'gst_free', 0],
      ['program', 'taxable', 1000],
      ['medicine', 'gst_free', 0],
      ['shipping', 'gst_free', 0],
    ]);
    expect(await trail(body.priceId)).toEqual([['price.created'], ['price.created']]);
  });

  it('charges GST on shipping when no medicine travels with it, and keeps a treatment staff chose', async () => {
    const { body } = await call('POST', '/prices', {
      ...bundled([{ feeKind: 'program', amountCents: 5500, gstTreatment: 'gst_free' }, { feeKind: 'shipping', amountCents: 1100 }]),
      billingModel: 'pharmacy_billed',
    });
    expect(body.fees.map((f: { gstTreatment: string; gstCents: number }) => [f.gstTreatment, f.gstCents])).toEqual([
      ['gst_free', 0],
      ['taxable', 100],
    ]);
  });

  it('refuses medicine on a pharmacy-billed price, a fee kind twice, a share above the fee and an interval too long', async () => {
    const refused = [
      await call('POST', '/prices', { ...bundled(), billingModel: 'pharmacy_billed' }),
      await call('POST', '/prices', bundled([{ feeKind: 'program', amountCents: 100 }, { feeKind: 'program', amountCents: 200 }])),
      await call('POST', '/prices', bundled([medicine(100, 200)])),
      await call('POST', '/prices', { ...bundled(), interval: { unit: 'month', count: 13 } }),
      await call('POST', '/prices', bundled([{ feeKind: 'program', amountCents: 100, productId: randomUUID() }])),
    ];
    expect(refused.map((r) => [r.status, r.body.error.code])).toEqual([
      [400, 'medicine_fee_not_bundled'],
      [400, 'duplicate_fee'],
      [400, 'bad_request'],
      [400, 'bad_request'],
      [400, 'bad_request'],
    ]);
    expect((await call('POST', '/prices', { ...bundled(), interval: { unit: 'week', count: 52 } })).status).toBe(201);
  });

  it('replaces a draft and all its fees, audited without an event', async () => {
    const created = await call('POST', '/prices', bundled());
    const { status, body } = await call('PUT', `/prices/${created.body.priceId}`, {
      name: 'Every 4 weeks',
      billingModel: 'pharmacy_billed',
      interval: { unit: 'week', count: 4 },
      fees: [{ feeKind: 'program', amountCents: 9900 }],
    });
    expect(status).toBe(200);
    expect(body).toMatchObject({ name: 'Every 4 weeks', billingModel: 'pharmacy_billed', interval: { unit: 'week', count: 4 } });
    expect(body.fees).toHaveLength(1);
    expect(await trail(body.priceId)).toEqual([['price.created', 'price.updated'], ['price.created']]);
  });
});

describe('publishing, revising and retiring', () => {
  it('publishes only with the GST treatments confirmed, a fee every period, and medicine when bundled', async () => {
    const consultOnly = await call('POST', '/prices', { ...bundled([{ feeKind: 'consult', amountCents: 4900 }]), billingModel: 'pharmacy_billed' });
    const noMedicine = await call('POST', '/prices', bundled([{ feeKind: 'program', amountCents: 11000 }]));
    expect((await call('POST', `/prices/${noMedicine.body.priceId}/publish`, {})).status).toBe(400);
    expect((await call('POST', `/prices/${consultOnly.body.priceId}/publish`, confirm)).body.error.code).toBe('price_has_no_period_fee');
    expect((await call('POST', `/prices/${noMedicine.body.priceId}/publish`, confirm)).body.error.code).toBe('bundled_price_without_medicine');

    const live = await livePrice();
    expect(live).toMatchObject({ status: 'live' });
    expect(live.publishedAt).not.toBeNull();
    expect(await trail(live.priceId)).toEqual([
      ['price.created', 'price.published'],
      ['price.created', 'price.published'],
    ]);
    expect((await call('PUT', `/prices/${live.priceId}`, { ...bundled(), programId: undefined })).body.error.code).toBe('price_not_draft');
  });

  it('revises a live price into one draft, and publishing it retires the version it replaces', async () => {
    const v1 = await livePrice();
    const v2 = await call('POST', `/prices/${v1.priceId}/revisions`);
    expect(v2.status).toBe(201);
    expect(v2.body).toMatchObject({ status: 'draft', version: 2, replacesPriceId: v1.priceId, programId: v1.programId });
    expect(v2.body.fees.map((f: { feeKind: string; amountCents: number }) => [f.feeKind, f.amountCents])).toEqual(
      v1.fees.map((f: { feeKind: string; amountCents: number }) => [f.feeKind, f.amountCents]),
    );
    expect((await call('POST', `/prices/${v1.priceId}/revisions`)).body.error.code).toBe('price_already_revised');

    const published = await call('POST', `/prices/${v2.body.priceId}/publish`, confirm);
    expect(published.body).toMatchObject({ status: 'live', version: 2 });
    expect((await call('GET', `/prices/${v1.priceId}`)).body).toMatchObject({ status: 'retired' });
    expect((await trail(v1.priceId))[1]).toEqual(['price.created', 'price.published', 'price.retired']);
    const listed = await call('GET', `/prices?programId=${v1.programId}`);
    expect(listed.body.prices.map((p: { version: number; status: string }) => [p.version, p.status])).toEqual([
      [2, 'live'],
      [1, 'retired'],
    ]);
  });

  it('retires a live price once, and never revises a retired one', async () => {
    const live = await livePrice();
    expect((await call('POST', `/prices/${live.priceId}/retire`)).body).toMatchObject({ status: 'retired' });
    expect((await call('POST', `/prices/${live.priceId}/retire`)).body.error.code).toBe('price_not_live');
    expect((await call('POST', `/prices/${live.priceId}/revisions`)).body.error.code).toBe('price_not_live');
  });

  it('sends charges to a payment account that is open, and only one of this tenant', async () => {
    const open = await createPaymentAccount(clinic.tenantId);
    const closed = await createPaymentAccount(clinic.tenantId);
    await admin.query(`update operational.payment_accounts set status = 'closed', closed_at = now() where id = $1`, [closed]);
    const other = await tenantWith('owner');
    const elsewhere = await createPaymentAccount(other.tenantId);
    expect((await call('POST', '/prices', { ...bundled(), paymentAccountId: open })).body.paymentAccountId).toBe(open);
    expect((await call('POST', '/prices', { ...bundled(), paymentAccountId: closed })).body.error.code).toBe('payment_account_closed');
    expect((await call('POST', '/prices', { ...bundled(), paymentAccountId: elsewhere })).status).toBe(404);
  });
});

describe('who may, and tenancy (ADR 0006)', () => {
  it('lets finance and the owner manage prices, and nobody else', async () => {
    expect((await call('GET', '/prices', undefined, { email: support.email, tenantId: clinic.tenantId })).status).toBe(403);
    expect((await call('POST', '/prices', bundled(), { email: support.email, tenantId: clinic.tenantId })).status).toBe(403);
    expect((await call('GET', '/prices', undefined, { email: clinic.members[0]!.email, tenantId: clinic.tenantId })).status).toBe(200);
  });

  it("never shows or changes another tenant's prices", async () => {
    const live = await livePrice();
    const other = await tenantWith('finance');
    const them = { email: other.members[0]!.email, tenantId: other.tenantId };
    expect((await call('GET', '/prices', undefined, them)).body.prices).toEqual([]);
    expect((await call('GET', `/prices/${live.priceId}`, undefined, them)).status).toBe(404);
    expect((await call('POST', `/prices/${live.priceId}/retire`, undefined, them)).status).toBe(404);
    expect((await call('POST', `/prices/${live.priceId}/revisions`, undefined, them)).status).toBe(404);
    const fees = await withTenant({ tenantId: other.tenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) =>
      tx.db.execute(sql`select id from operational.price_fees where price_id = ${live.priceId}`),
    );
    expect(fees.rows).toEqual([]);
  });
});

describe('the database keeps the rules (ADR 0028)', () => {
  const asApi = <T>(work: Parameters<typeof withTenant<T>>[1]) => withTenant({ tenantId: clinic.tenantId, actor: { type: 'system' }, requestId: 'test' }, work);

  it('never changes a published price or its fees, even outside the service', async () => {
    const live = await livePrice();
    const medicineFee = live.fees.find((f: { feeKind: string }) => f.feeKind === 'medicine');
    await expect(asApi((tx) => tx.db.execute(sql`update operational.prices set name = 'Cheaper' where id = ${live.priceId}`))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'a published price never changes' }),
    });
    await expect(asApi((tx) => tx.db.execute(sql`delete from operational.price_fees where id = ${medicineFee.feeId}`))).rejects.toMatchObject({
      cause: expect.objectContaining({ message: 'a published price never changes' }),
    });
    await expect(
      admin.query(`insert into operational.price_fees (tenant_id, price_id, billing_model, fee_kind, amount_cents, gst_treatment) values ($1, $2, 'bundled', 'program', 1, 'taxable')`, [
        clinic.tenantId,
        live.priceId,
      ]),
    ).rejects.toThrow(/a published price never changes/);
    await expect(asApi((tx) => tx.db.execute(sql`delete from operational.prices where id = ${live.priceId}`))).rejects.toMatchObject({
      cause: expect.objectContaining({ code: '42501' }),
    });
  });

  it('refuses a medicine fee on a pharmacy-billed price, and keeps fees on their price\'s billing model', async () => {
    const draft = await call('POST', '/prices', { ...bundled([{ feeKind: 'program', amountCents: 100 }]), billingModel: 'pharmacy_billed' });
    await expect(
      admin.query(
        `insert into operational.price_fees (tenant_id, price_id, billing_model, fee_kind, product_id, amount_cents, pharmacy_share_cents, gst_treatment) values ($1, $2, 'pharmacy_billed', 'medicine', $3, 100, 50, 'gst_free')`,
        [clinic.tenantId, draft.body.priceId, randomUUID()],
      ),
    ).rejects.toThrow(/price_fees_medicine_check/);
    await expect(
      admin.query(
        `insert into operational.price_fees (tenant_id, price_id, billing_model, fee_kind, product_id, amount_cents, pharmacy_share_cents, gst_treatment) values ($1, $2, 'bundled', 'medicine', $3, 100, 50, 'gst_free')`,
        [clinic.tenantId, draft.body.priceId, randomUUID()],
      ),
    ).rejects.toThrow(/price_fees_price_fk/);
  });
});
