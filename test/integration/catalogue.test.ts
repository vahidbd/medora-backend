import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withPerson, withTenant } from '../../src/db/tenant.js';
import { assertProductSuppliable, getOrderableProduct } from '../../src/modules/catalogue/index.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createPlatformStaff, createUser, tenantWith } from '../support/db.js';

/**
 * The catalogue and blocked items (docs/decisions/catalogue.md CAT1 to
 * CAT5). Block rules are shared by every tenant and by every test running
 * at once, so each test blocks a made-up ARTG number of its own, and only
 * one test touches schedule rules, on a schedule nobody else uses (S3).
 */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = async (method: Method, url: string, email: string, tenantId?: string, payload?: object) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });
/** An ARTG number no other test uses, so a rule on it touches only this test's products. */
const artg = () => String(10_000_000 + Math.floor(Math.random() * 89_999_999)).slice(0, 8);
const medicine = (over: object = {}) => ({ name: 'Made-up tablets 10 mg', kind: 'medicine', schedule: 'S4', artgNumber: artg(), priceCents: 4500, gstFree: true, ...over });

describe('products (CAT1)', () => {
  it('saves a medicine with its ARTG number as digits, and refuses one that says neither ARTG nor compounded', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = members[0]!.email;
    const created = await call('POST', '/v1/products', email, tenantId, medicine({ artgNumber: 'ARTG 123 456', form: 'Tablet', packSize: '30' }));
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ artgNumber: '123456', compounded: false, status: 'active', storage: 'room', blocked: null });

    const vague = await call('POST', '/v1/products', email, tenantId, medicine({ artgNumber: null }));
    expect(vague.json().error.code).toBe('medicine_identity_required');
    const compounded = await call('POST', '/v1/products', email, tenantId, medicine({ artgNumber: null, compounded: true, storage: 'refrigerated' }));
    expect(compounded.statusCode).toBe(201);
    const device = await call('POST', '/v1/products', email, tenantId, { name: 'Made-up scale', kind: 'device', schedule: 'S2', priceCents: 9900, gstFree: false });
    expect(device.json().error.code).toBe('not_a_medicine');
    const changed = await call('PATCH', `/v1/products/${created.json().productId}`, email, tenantId, { artgNumber: null });
    expect(changed.json().error.code).toBe('medicine_identity_required');
  });

  it('is refused by the database when a medicine says neither, whoever writes it', async () => {
    const { tenantId } = await tenantWith('owner');
    await expect(
      admin.query(`insert into operational.products (tenant_id, name, kind, price_cents, gst_free) values ($1, 'X', 'medicine', 100, true)`, [tenantId]),
    ).rejects.toThrow(/products_identity_check/);
  });

  it('records a price change from and to, and lets every role read but only owner, admin and operations change', async () => {
    const { tenantId, members } = await tenantWith('owner', 'operations', 'clinician', 'admin');
    const [, operations, clinician, adminMember] = members;
    const created = (await call('POST', '/v1/products', operations!.email, tenantId, medicine())).json();
    const repriced = await call('PATCH', `/v1/products/${created.productId}`, adminMember!.email, tenantId, { priceCents: 5200 });
    expect(repriced.json().priceCents).toBe(5200);
    const { rows } = await admin.query(
      `select details from platform.audit_log where tenant_id = $1 and action = 'product.changed' and record_id = $2`,
      [tenantId, created.productId],
    );
    expect(rows[0].details).toMatchObject({ changed: 'priceCents', priceBefore: 4500, priceAfter: 5200 });

    expect((await call('GET', '/v1/products', clinician!.email, tenantId)).json().products).toHaveLength(1);
    expect((await call('PATCH', `/v1/products/${created.productId}`, clinician!.email, tenantId, { priceCents: 1 })).statusCode).toBe(403);
    expect((await call('POST', '/v1/products', clinician!.email, tenantId, medicine())).statusCode).toBe(403);
  });

  it('archives a product, which then refuses to be supplied, and brings it back', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const created = (await call('POST', '/v1/products', owner.email, tenantId, medicine())).json();
    expect((await call('POST', `/v1/products/${created.productId}/status`, owner.email, tenantId, { status: 'archived' })).json().status).toBe('archived');
    await expect(withTenant(as(tenantId, owner.id), (tx) => assertProductSuppliable(tx, created.productId))).rejects.toMatchObject({
      code: 'product_archived',
    });
    expect((await call('POST', `/v1/products/${created.productId}/status`, owner.email, tenantId, { status: 'active' })).json().status).toBe('active');
    await expect(withTenant(as(tenantId, owner.id), (tx) => assertProductSuppliable(tx, created.productId))).resolves.toMatchObject({
      productId: created.productId,
    });
  });

  it("keeps each tenant's products to itself", async () => {
    const first = await tenantWith('owner');
    const second = await tenantWith('owner');
    const created = (await call('POST', '/v1/products', first.members[0]!.email, first.tenantId, medicine())).json();
    const other = second.members[0]!;
    expect((await call('GET', `/v1/products/${created.productId}`, other.email, second.tenantId)).statusCode).toBe(404);
    expect((await call('PATCH', `/v1/products/${created.productId}`, other.email, second.tenantId, { priceCents: 1 })).statusCode).toBe(404);
    expect((await call('POST', `/v1/products/${created.productId}/block`, other.email, second.tenantId, { reason: 'Not mine' })).statusCode).toBe(404);
    await expect(withTenant(as(second.tenantId, other.id), (tx) => getOrderableProduct(tx, created.productId))).rejects.toMatchObject({ statusCode: 404 });
    const seen = await withTenant(as(second.tenantId, other.id), (tx) =>
      tx.db.execute(sql`select count(*)::int as n from operational.products where id = ${created.productId}`),
    );
    expect(seen.rows[0]).toEqual({ n: 0 });
  });
});

describe('block rules (CAT2, CAT3)', () => {
  it('stops an existing product the moment platform staff add a rule, and no tenant can lift it', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const number = artg();
    const created = (await call('POST', '/v1/products', owner.email, tenantId, medicine({ artgNumber: number }))).json();
    await expect(withTenant(as(tenantId, owner.id), (tx) => assertProductSuppliable(tx, created.productId))).resolves.toBeDefined();

    const staff = await createPlatformStaff();
    const added = await call('POST', '/v1/platform/block-rules', staff.email, undefined, {
      match: 'artg_number',
      value: `ARTG ${number}`,
      reason: 'Made-up recall for this test',
      sourceUrl: 'https://example.test/recall',
    });
    expect(added.statusCode).toBe(201);
    expect(added.json()).toMatchObject({ match: 'artg_number', value: number });

    const now = (await call('GET', `/v1/products/${created.productId}`, owner.email, tenantId)).json();
    expect(now.blocked).toEqual({ code: 'platform_rule', reason: 'Made-up recall for this test', ruleId: added.json().ruleId });
    await expect(withTenant(as(tenantId, owner.id), (tx) => assertProductSuppliable(tx, created.productId))).rejects.toMatchObject({
      statusCode: 409,
      code: 'product_blocked',
    });
    // Lifting the tenant's own block (there is none) leaves Medora's rule in place.
    expect((await call('DELETE', `/v1/products/${created.productId}/block`, owner.email, tenantId)).json().blocked.code).toBe('platform_rule');
    expect((await call('POST', '/v1/platform/block-rules', staff.email, undefined, { match: 'artg_number', value: number, reason: 'Made-up recall again' })).json().error.code).toBe('rule_exists');

    const { rows } = await admin.query(`select tenant_id, actor_id from platform.audit_log where action = 'block_rule.added' and record_id = $1`, [added.json().ruleId]);
    expect(rows).toEqual([{ tenant_id: null, actor_id: staff.id }]);
  });

  it('applies a schedule rule from its effective time only', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const created = (await call('POST', '/v1/products', owner.email, tenantId, medicine({ schedule: 'S3' }))).json();
    const staff = await createPlatformStaff();
    const nextYear = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
    const announced = await call('POST', '/v1/platform/block-rules', staff.email, undefined, {
      match: 'schedule',
      value: 's3',
      reason: 'Made-up schedule rule, announced ahead',
      effectiveFrom: nextYear,
    });
    expect(announced.json().value).toBe('S3');
    expect((await call('GET', `/v1/products/${created.productId}`, owner.email, tenantId)).json().blocked).toBeNull();
    expect((await call('GET', '/v1/block-rules', owner.email)).json().rules.map((r: { ruleId: string }) => r.ruleId)).toContain(announced.json().ruleId);
    // Retire it, as the operator script would, so other tests' S3 products stay clear.
    await admin.query('update platform.block_rules set retired_at = now() where id = $1', [announced.json().ruleId]);
  });

  it('lets only platform staff add a rule, through the route or the function', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const refused = await call('POST', '/v1/platform/block-rules', owner.email, tenantId, { match: 'compounded', reason: 'Owners cannot do this' });
    expect(refused.statusCode).toBe(403);
    const person = await createUser();
    await expect(
      withPerson(person.id, (tx) =>
        tx.db.execute(sql`select platform.add_block_rule('artg_number', ${artg()}, 'Not platform staff here', null, null, 'test')`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/needs platform staff/) } });
    // Nor can the API's role write a rule around the function.
    await expect(
      withPerson(person.id, (tx) =>
        tx.db.execute(sql`insert into platform.block_rules (match, reason, added_by) values ('compounded', 'Straight in, no function', ${person.id})`),
      ),
    ).rejects.toMatchObject({ cause: { message: expect.stringMatching(/permission denied/) } });
  });

  it('refuses a rule value that could match nothing', async () => {
    const staff = await createPlatformStaff();
    const bad = await call('POST', '/v1/platform/block-rules', staff.email, undefined, { match: 'schedule', value: 'S9', reason: 'Not a real schedule here' });
    expect(bad.json().error.code).toBe('rule_value_invalid');
  });
});

describe("a tenant's own block (CAT4)", () => {
  it('blocks with a reason, refuses supply, and lifts', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const created = (await call('POST', '/v1/products', owner.email, tenantId, medicine({ name: `Made-up ${randomUUID().slice(0, 6)}` }))).json();
    const blocked = await call('POST', `/v1/products/${created.productId}/block`, owner.email, tenantId, { reason: 'Supplier recall' });
    expect(blocked.json().blocked).toEqual({ code: 'tenant_block', reason: 'Supplier recall', ruleId: null });
    await expect(withTenant(as(tenantId, owner.id), (tx) => assertProductSuppliable(tx, created.productId))).rejects.toMatchObject({
      code: 'product_blocked',
    });
    expect((await call('DELETE', `/v1/products/${created.productId}/block`, owner.email, tenantId)).json().blocked).toBeNull();
    const { rows } = await admin.query(
      `select action from platform.audit_log where tenant_id = $1 and record_id = $2 order by id`,
      [tenantId, created.productId],
    );
    expect(rows.map((row) => row.action)).toEqual(['product.created', 'product.blocked', 'product.unblocked']);
  });
});
