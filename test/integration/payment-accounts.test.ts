import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { fakeProcessor } from '../../src/modules/payments/processors.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** Payment accounts (ADR 0037, docs/decisions/billing.md BIL8 to BIL12), against the fake processor. */
let app: App;
beforeAll(async () => {
  app = await testApp();
});
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const stripe = fakeProcessor('stripe');
const clinic = await tenantWith('owner', 'finance', 'support');
const [, finance, support] = clinic.members as [(typeof clinic.members)[number], (typeof clinic.members)[number], (typeof clinic.members)[number]];

async function call(method: 'GET' | 'POST' | 'PATCH', url: string, options: { email?: string; tenantId?: string; body?: object } = {}) {
  const response = await app.inject({
    method,
    url: `/v1${url}`,
    headers: headers(await signIn(options.email ?? finance.email), options.tenantId ?? clinic.tenantId),
    ...(options.body ? { payload: options.body } : {}),
  });
  return { status: response.statusCode, body: response.json() };
}

const add = (name = 'Main card account', tenantId = clinic.tenantId, email = finance.email) =>
  call('POST', '/payment-accounts', { tenantId, email, body: { processor: 'stripe', companyId: randomUUID(), name } });

/** Added, onboarded on the processor's pages and refreshed: active. */
async function activeAccount(tenantId = clinic.tenantId, email = finance.email): Promise<{ paymentAccountId: string; isDefault: boolean }> {
  const created = await add('Card account', tenantId, email);
  await call('POST', `/payment-accounts/${created.body.paymentAccountId}/onboarding-link`, { tenantId, email });
  return (await call('POST', `/payment-accounts/${created.body.paymentAccountId}/refresh`, { tenantId, email })).body;
}

const actions = (recordId: string) =>
  admin.query(`select action from platform.audit_log where record_id = $1 order by id`, [recordId]).then((r) => r.rows.map((row) => row.action));
const events = (recordId: string) =>
  admin.query(`select type, payload from platform.outbox where record_id = $1 order by id`, [recordId]).then((r) => r.rows);

describe('connecting a Stripe account', () => {
  it('opens the Stripe account once however often staff ask, and is active and the default after onboarding', async () => {
    const tenant = await tenantWith('finance');
    const email = tenant.members[0]!.email;
    const created = await add('Main card account', tenant.tenantId, email);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ processor: 'stripe', status: 'setting_up', processorAccountId: null, chargesEnabled: false, isDefault: false });
    const id = created.body.paymentAccountId;

    const opened = stripe.accountsOpened;
    const first = await call('POST', `/payment-accounts/${id}/onboarding-link`, { tenantId: tenant.tenantId, email });
    const second = await call('POST', `/payment-accounts/${id}/onboarding-link`, { tenantId: tenant.tenantId, email });
    expect(first.status).toBe(200);
    expect(first.body.url).toBe(`http://localhost:3000/settings/payment-accounts/${id}?onboarding=returned`);
    expect(second.status).toBe(200);
    expect(stripe.accountsOpened).toBe(opened + 1);

    const refreshed = await call('POST', `/payment-accounts/${id}/refresh`, { tenantId: tenant.tenantId, email });
    expect(refreshed.body).toMatchObject({ status: 'active', chargesEnabled: true, isDefault: true, processorAccountId: expect.stringMatching(/^acct_fake/) });
    expect(refreshed.body.activatedAt).not.toBeNull();

    expect(await actions(id)).toEqual([
      'payment_account.created',
      'payment_account.onboarding_started',
      'payment_account.connected',
      'payment_account.onboarding_started',
      'payment_account.processor_state_changed',
      'payment_account.activated',
      'payment_account.made_default',
    ]);
    expect(await events(id)).toEqual([
      { type: 'payment_account.created', payload: { processor: 'stripe' } },
      { type: 'payment_account.connected', payload: { processor: 'stripe' } },
      { type: 'payment_account.processor_state_changed', payload: { chargesEnabled: true } },
      { type: 'payment_account.activated', payload: {} },
      { type: 'payment_account.made_default', payload: { previousPaymentAccountId: null } },
    ]);
  });

  it('stays setting up until the processor says it can take payments, and a refresh before then changes nothing', async () => {
    const created = await add();
    const id = created.body.paymentAccountId;
    expect((await call('POST', `/payment-accounts/${id}/refresh`)).body).toMatchObject({ status: 'setting_up', processorAccountId: null });
    await call('POST', `/payment-accounts/${id}/onboarding-link`);
    const { body } = await call('GET', '/payment-accounts');
    const connected = body.paymentAccounts.find((a: { paymentAccountId: string }) => a.paymentAccountId === id);
    stripe.setChargesEnabled(connected.processorAccountId, false);
    expect((await call('POST', `/payment-accounts/${id}/refresh`)).body).toMatchObject({ status: 'setting_up', chargesEnabled: false });
  });

  it('keeps an active account active when the processor stops its payments, and records that it did', async () => {
    const account = await activeAccount();
    const { body } = await call('GET', '/payment-accounts');
    const { processorAccountId } = body.paymentAccounts.find((a: { paymentAccountId: string }) => a.paymentAccountId === account.paymentAccountId);
    stripe.setChargesEnabled(processorAccountId, false);
    const refreshed = await call('POST', `/payment-accounts/${account.paymentAccountId}/refresh`);
    expect(refreshed.body).toMatchObject({ status: 'active', chargesEnabled: false });
    expect((await events(account.paymentAccountId)).at(-1)).toEqual({ type: 'payment_account.processor_state_changed', payload: { chargesEnabled: false } });
  });
});

describe('the default, closing and reopening', () => {
  it('moves the default, refuses to close the default, and reopens an account to where it was', async () => {
    const tenant = await tenantWith('finance');
    const email = tenant.members[0]!.email;
    const opts = { tenantId: tenant.tenantId, email };
    const first = await activeAccount(tenant.tenantId, email);
    const second = await activeAccount(tenant.tenantId, email);
    expect([first.isDefault, second.isDefault]).toEqual([true, false]);

    expect((await call('PATCH', `/payment-accounts/${second.paymentAccountId}`, { ...opts, body: { isDefault: true } })).body.isDefault).toBe(true);
    expect((await events(second.paymentAccountId)).at(-1)).toEqual({ type: 'payment_account.made_default', payload: { previousPaymentAccountId: first.paymentAccountId } });

    const refused = await call('PATCH', `/payment-accounts/${second.paymentAccountId}`, { ...opts, body: { closed: true } });
    expect(refused).toMatchObject({ status: 409, body: { error: { code: 'default_payment_account' } } });

    const closed = await call('PATCH', `/payment-accounts/${first.paymentAccountId}`, { ...opts, body: { closed: true, name: 'Old card account' } });
    expect(closed.body).toMatchObject({ status: 'closed', name: 'Old card account', isDefault: false });
    expect(closed.body.closedAt).not.toBeNull();
    expect((await call('PATCH', `/payment-accounts/${first.paymentAccountId}`, { ...opts, body: { isDefault: true } })).body.error.code).toBe('payment_account_not_active');
    expect((await call('POST', `/payment-accounts/${first.paymentAccountId}/onboarding-link`, opts)).body.error.code).toBe('payment_account_closed');
    expect((await call('PATCH', `/payment-accounts/${first.paymentAccountId}`, { ...opts, body: { closed: true, isDefault: true } })).status).toBe(400);

    const reopened = await call('PATCH', `/payment-accounts/${first.paymentAccountId}`, { ...opts, body: { closed: false } });
    expect(reopened.body).toMatchObject({ status: 'active', closedAt: null, isDefault: false });
    expect(await actions(first.paymentAccountId)).toEqual(expect.arrayContaining(['payment_account.renamed', 'payment_account.closed', 'payment_account.reopened']));

    const neverSetUp = await add('Spare', tenant.tenantId, email);
    await call('PATCH', `/payment-accounts/${neverSetUp.body.paymentAccountId}`, { ...opts, body: { closed: true } });
    expect((await call('PATCH', `/payment-accounts/${neverSetUp.body.paymentAccountId}`, { ...opts, body: { closed: false } })).body.status).toBe('setting_up');
  });

  it('leaves exactly one default when two staff choose different ones at the same moment', async () => {
    const tenant = await tenantWith('finance', 'finance');
    const [a, b] = tenant.members as [(typeof tenant.members)[number], (typeof tenant.members)[number]];
    await activeAccount(tenant.tenantId, a.email);
    const others = [await activeAccount(tenant.tenantId, a.email), await activeAccount(tenant.tenantId, a.email)];
    const results = await Promise.all(
      others.map((account, i) =>
        call('PATCH', `/payment-accounts/${account.paymentAccountId}`, { tenantId: tenant.tenantId, email: [a, b][i]!.email, body: { isDefault: true } }),
      ),
    );
    expect(results.map((r) => r.status)).toEqual([200, 200]);
    const { rows } = await admin.query(`select count(*)::int as defaults from operational.payment_accounts where tenant_id = $1 and is_default`, [tenant.tenantId]);
    expect(rows[0].defaults).toBe(1);
  });
});

describe('who may', () => {
  it('lets finance and the owner manage payment accounts, and nobody else', async () => {
    expect((await call('GET', '/payment-accounts', { email: support.email })).status).toBe(403);
    expect((await add('Card account', clinic.tenantId, support.email)).status).toBe(403);
    expect((await call('GET', '/payment-accounts', { email: clinic.members[0]!.email })).status).toBe(200);
  });
});

describe('tenancy (ADR 0006)', () => {
  it("never shows or changes another tenant's payment accounts", async () => {
    const account = await activeAccount();
    const other = await tenantWith('finance');
    const opts = { tenantId: other.tenantId, email: other.members[0]!.email };
    expect((await call('GET', '/payment-accounts', opts)).body.paymentAccounts).toEqual([]);
    for (const [method, url] of [
      ['PATCH', `/payment-accounts/${account.paymentAccountId}`],
      ['POST', `/payment-accounts/${account.paymentAccountId}/onboarding-link`],
      ['POST', `/payment-accounts/${account.paymentAccountId}/refresh`],
    ] as const) {
      expect((await call(method, url, { ...opts, ...(method === 'PATCH' ? { body: { name: 'Taken' } } : {}) })).status).toBe(404);
    }
    const seen = await withTenant({ tenantId: other.tenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) =>
      tx.db.execute(sql`update operational.payment_accounts set name = 'Taken' returning id`),
    );
    expect(seen.rows).toEqual([]);
  });
});

describe('the database keeps the rules (ADR 0028)', () => {
  const insert = (tenantId: string, columns: Record<string, unknown>) => {
    const values = { tenant_id: tenantId, processor: 'stripe', company_id: randomUUID(), name: 'Card account', ...columns };
    const names = Object.keys(values);
    return admin.query(`insert into operational.payment_accounts (${names.join(', ')}) values (${names.map((_, i) => `$${i + 1}`).join(', ')}) returning id`, Object.values(values));
  };

  it('keeps a payment account on its processor account once it is set', async () => {
    const { rows } = await insert(clinic.tenantId, { processor_account_id: `acct_${randomUUID().slice(0, 8)}` });
    await expect(admin.query(`update operational.payment_accounts set processor_account_id = 'acct_other' where id = $1`, [rows[0].id])).rejects.toThrow(/keeps its processor account/);
  });

  it('gives one processor account to one payment account in all of Medora', async () => {
    const processorAccountId = `acct_${randomUUID().slice(0, 8)}`;
    await insert(clinic.tenantId, { processor_account_id: processorAccountId });
    const other = await tenantWith('owner');
    await expect(insert(other.tenantId, { processor_account_id: processorAccountId })).rejects.toThrow(/payment_accounts_processor_account_key/);
  });

  it('allows one default per tenant, only an active one, and no deleting', async () => {
    const tenant = await tenantWith('owner');
    await insert(tenant.tenantId, { status: 'active', activated_at: new Date(), is_default: true });
    await expect(insert(tenant.tenantId, { status: 'active', activated_at: new Date(), is_default: true })).rejects.toThrow(/payment_accounts_default_key/);
    await expect(insert(tenant.tenantId, { is_default: true })).rejects.toThrow(/payment_accounts_lifecycle_check/);
    await expect(
      withTenant({ tenantId: tenant.tenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) => tx.db.execute(sql`delete from operational.payment_accounts`)),
    ).rejects.toMatchObject({ cause: expect.objectContaining({ code: '42501' }) });
  });

  it("refuses a ledger account for another tenant's payment account", async () => {
    const { rows } = await insert(clinic.tenantId, {});
    const other = await tenantWith('owner');
    await expect(
      admin.query(`insert into operational.ledger_accounts (tenant_id, kind, payment_account_id) values ($1, 'processor_clearing', $2)`, [other.tenantId, rows[0].id]),
    ).rejects.toThrow(/ledger_accounts_payment_account_fk/);
  });
});
