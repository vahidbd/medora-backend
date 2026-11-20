import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { brandDomains } from '../../src/db/schema/index.js';
import { type TenantContext, withPerson, withTenant } from '../../src/db/tenant.js';
import { assertAcceptingPatients } from '../../src/modules/brands/index.js';
import { invitations } from '../../src/modules/staff/index.js';
import { headers, signIn, testApp } from '../support/app.js';
import { addMember, admin, createBrand, createPlatformStaff, createTenant, createUser, makeAbn, tenantWith } from '../support/db.js';

/** A tenant's set-up: settings, companies, brands, domains, platform staff and the onboarding checklist (docs/decisions/admin.md ADM14 to ADM20). */
const app = await testApp();
const sent: string[] = [];
const send = vi.spyOn(invitations, 'send').mockImplementation(async (email) => {
  sent.push(email);
  return 'sent';
});
afterEach(() => {
  sent.length = 0;
});
afterAll(async () => {
  send.mockRestore();
  await app.close();
  await closeDatabase();
  await admin.end();
});

type Method = 'GET' | 'POST' | 'PATCH' | 'DELETE';
const call = async (method: Method, url: string, email: string, tenantId?: string, payload?: object) =>
  app.inject({ method, url, headers: headers(await signIn(email), tenantId), ...(payload ? { payload } : {}) });

const host = () => `app-${randomUUID().slice(0, 8)}.example.test`;
/** Drizzle wraps the database's refusal; its own words are on the cause. */
const refusedWith = (pattern: RegExp) => ({ cause: { message: expect.stringMatching(pattern) } });
const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });

describe('tenant settings (ADM20)', () => {
  it('lets an owner rename the tenant and change its time zone, and anyone in it read them', async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    const [owner, support] = members;
    const changed = await call('PATCH', '/v1/tenant', owner!.email, tenantId, { name: 'Renamed clinic', timeZone: 'Australia/Perth' });
    expect(changed.json()).toEqual({ tenantId, name: 'Renamed clinic', timeZone: 'Australia/Perth' });
    expect((await call('GET', '/v1/tenant', support!.email, tenantId)).json().timeZone).toBe('Australia/Perth');
    expect((await call('PATCH', '/v1/tenant', support!.email, tenantId, { name: 'Mine now' })).statusCode).toBe(403);
    expect((await call('PATCH', '/v1/tenant', owner!.email, tenantId, { timeZone: 'Europe/London' })).statusCode).toBe(400);
  });
});

describe('companies (ADM19)', () => {
  it('saves an ABN as typed, without spaces, and refuses a wrong checksum or a second company with it', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = members[0]!.email;
    const abn = makeAbn();
    const spaced = `${abn.slice(0, 2)} ${abn.slice(2, 5)} ${abn.slice(5, 8)} ${abn.slice(8)}`;
    const created = await call('POST', '/v1/companies', email, tenantId, { legalName: 'Harbour Care Pty Ltd', abn: spaced, state: 'NSW' });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ abn, state: 'NSW', tradingName: null, brandCount: 0 });

    const wrong = `${abn.slice(0, 10)}${(Number(abn[10]) + 1) % 10}`;
    const refused = await call('POST', '/v1/companies', email, tenantId, { legalName: 'Typo Pty Ltd', abn: wrong, state: 'VIC' });
    expect(refused.json().error.code).toBe('abn_invalid');
    const twice = await call('POST', '/v1/companies', email, tenantId, { legalName: 'Again Pty Ltd', abn, state: 'VIC' });
    expect(twice.json().error.code).toBe('abn_taken');
  });

  it('is refused by the database with a wrong checksum, whoever writes it', async () => {
    const tenantId = await createTenant();
    await expect(
      admin.query(`insert into platform.companies (tenant_id, legal_name, abn, state) values ($1, 'X', '12345678901', 'NSW')`, [tenantId]),
    ).rejects.toThrow(/companies_abn_check/);
  });

  it("keeps a company's ABN once a brand of it is live, and deletes only a company with no brands", async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = members[0]!.email;
    const { companyId } = await createBrand(tenantId, { status: 'live' });
    const changed = await call('PATCH', `/v1/companies/${companyId}`, email, tenantId, { abn: makeAbn() });
    expect(changed.json().error.code).toBe('abn_fixed');
    expect((await call('PATCH', `/v1/companies/${companyId}`, email, tenantId, { tradingName: 'Harbour' })).json().tradingName).toBe('Harbour');
    expect((await call('DELETE', `/v1/companies/${companyId}`, email, tenantId)).json().error.code).toBe('company_has_brands');
  });
});

describe('brands (ADM16, ADM17)', () => {
  it('starts a brand as a draft, and refuses a slug used anywhere on Medora and an unreadable colour', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = members[0]!.email;
    const company = (await call('POST', '/v1/companies', email, tenantId, { legalName: 'Coastal Pty Ltd', abn: makeAbn(), state: 'QLD' })).json();
    const slug = `coastal-${randomUUID().slice(0, 6)}`;
    const brand = await call('POST', '/v1/brands', email, tenantId, { companyId: company.companyId, name: 'Coastal', slug, primaryColour: '#1F6FEB' });
    expect(brand.statusCode).toBe(201);
    expect(brand.json()).toMatchObject({ status: 'draft', slug, primaryColour: '#1f6feb', domains: [] });

    const other = await tenantWith('owner');
    const otherCompany = await createBrand(other.tenantId);
    const taken = await call('POST', '/v1/brands', other.members[0]!.email, other.tenantId, { companyId: otherCompany.companyId, name: 'Copy', slug });
    expect(taken.json().error.code).toBe('slug_taken');
    // Mid grey: neither white nor near-black text reaches 4.5:1 on it.
    const grey = await call('PATCH', `/v1/brands/${brand.json().brandId}`, email, tenantId, { primaryColour: '#777777' });
    expect(grey.json().error.code).toBe('colour_unreadable');
  });

  it('goes live only with a support email and a verified domain, pauses, and resumes', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const email = members[0]!.email;
    const staff = await createPlatformStaff();
    const { brandId } = await createBrand(tenantId);
    await call('PATCH', `/v1/brands/${brandId}`, email, tenantId, { supportEmail: null });
    const live = (body = { status: 'live' }) => call('POST', `/v1/brands/${brandId}/status`, email, tenantId, body);

    expect((await live()).json().error.code).toBe('support_email_required');
    await call('PATCH', `/v1/brands/${brandId}`, email, tenantId, { supportEmail: 'help@example.test' });
    expect((await live()).json().error.code).toBe('domain_unverified');

    const added = await call('POST', `/v1/brands/${brandId}/domains`, email, tenantId, { host: `https://${host().toUpperCase()}/start` });
    const domain = added.json().domains[0];
    expect(domain.host).toMatch(/^app-[0-9a-f]{8}\.example\.test$/);
    expect(domain.verifiedAt).toBeNull();
    expect((await call('POST', `/v1/platform/domains/${domain.domainId}/verify`, staff.email)).json().host).toBe(domain.host);

    expect((await live()).json().status).toBe('live');
    expect((await call('PATCH', `/v1/brands/${brandId}`, email, tenantId, { supportEmail: null })).json().error.code).toBe('support_email_required');
    expect((await call('DELETE', `/v1/brands/${brandId}/domains/${domain.domainId}`, email, tenantId)).json().error.code).toBe('last_verified_domain');
    expect((await live({ status: 'paused' })).json().status).toBe('paused');
    expect((await live()).json().status).toBe('live');

    const { rows } = await admin.query(`select action, details from platform.audit_log where record_id = $1 order by id`, [brandId]);
    expect(rows.filter((row) => row.action === 'brand.status_changed').map((row) => row.details)).toEqual([
      { from: 'draft', to: 'live' },
      { from: 'live', to: 'paused' },
      { from: 'paused', to: 'live' },
    ]);
  });

  it("refuses a domain another brand has, and a live brand's change of company", async () => {
    const a = await tenantWith('owner');
    const b = await tenantWith('owner');
    const staff = await createPlatformStaff();
    const taken = await createBrand(a.tenantId, { status: 'live', host: host(), verifiedBy: staff.id });
    const mine = await createBrand(b.tenantId);
    const clash = await call('POST', `/v1/brands/${mine.brandId}/domains`, b.members[0]!.email, b.tenantId, { host: taken.host });
    expect(clash.json().error.code).toBe('host_taken');
    const other = await call('POST', '/v1/companies', a.members[0]!.email, a.tenantId, { legalName: 'Second Pty Ltd', abn: makeAbn(), state: 'SA' });
    const moved = await call('PATCH', `/v1/brands/${taken.brandId}`, a.members[0]!.email, a.tenantId, { companyId: other.json().companyId });
    expect(moved.json().error.code).toBe('company_fixed');
  });

  it("lets support read brands but not change them", async () => {
    const { tenantId, members } = await tenantWith('owner', 'support');
    const { brandId } = await createBrand(tenantId);
    expect((await call('GET', '/v1/brands', members[1]!.email, tenantId)).json().brands).toHaveLength(1);
    expect((await call('PATCH', `/v1/brands/${brandId}`, members[1]!.email, tenantId, { name: 'Mine' })).statusCode).toBe(403);
  });

  it("won't let the API add a verified domain or verify one itself", async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const { brandId, domainId } = await createBrand(tenantId, { host: host() });
    await expect(
      withTenant(as(tenantId, owner.id), (tx) =>
        tx.db.insert(brandDomains).values({ tenantId, brandId, host: host(), verifiedAt: new Date(), verifiedBy: owner.id }),
      ),
    ).rejects.toMatchObject(refusedWith(/row-level security/));
    await expect(
      withTenant(as(tenantId, owner.id), (tx) => tx.db.execute(sql`update platform.brand_domains set verified_at = now() where id = ${domainId}`)),
    ).rejects.toMatchObject(refusedWith(/permission denied/));
  });
});

describe('platform staff (ADM14, ADM15)', () => {
  it('creates a tenant whose first owner is invited, sees no tenant data, and is the only one who can', async () => {
    const staff = await createPlatformStaff();
    const ownerEmail = `${randomUUID()}@example.test`;
    const created = await call('POST', '/v1/platform/tenants', staff.email, undefined, {
      name: 'Donz demo',
      timeZone: 'Australia/Melbourne',
      ownerEmail: ownerEmail.toUpperCase(),
      ownerName: 'Pat Example',
    });
    expect(created.statusCode).toBe(201);
    expect(created.json()).toMatchObject({ email: 'sent', tenant: { name: 'Donz demo', ownerJoined: false, brands: 0 } });
    expect(sent).toEqual([ownerEmail]);
    const tenantId = created.json().tenant.tenantId;

    const audit = await admin.query(`select action, actor_id from platform.audit_log where tenant_id = $1 order by id`, [tenantId]);
    expect(audit.rows).toEqual([
      { action: 'tenant.created', actor_id: staff.id },
      { action: 'membership.invited', actor_id: staff.id },
    ]);
    // Platform staff are not members: the tenant's own routes are closed to them.
    expect((await call('GET', '/v1/staff', staff.email, tenantId)).json().error.code).toBe('not_a_member');

    const me = await call('GET', '/v1/me', ownerEmail);
    expect(me.json().memberships).toMatchObject([{ tenantId, role: 'owner', status: 'active' }]);
    expect(me.json().platformStaff).toBe(false);
    const listed = (await call('GET', '/v1/platform/tenants', staff.email)).json().tenants;
    expect(listed.find((t: { tenantId: string }) => t.tenantId === tenantId).ownerJoined).toBe(true);
    // Once an owner has joined there is nothing to send again.
    expect((await call('POST', `/v1/platform/tenants/${tenantId}/owner-invitation`, staff.email)).statusCode).toBe(404);
  });

  it('sends the first owner invitation again while nobody has accepted it', async () => {
    const staff = await createPlatformStaff();
    const ownerEmail = `${randomUUID()}@example.test`;
    const created = await call('POST', '/v1/platform/tenants', staff.email, undefined, { name: 'Resend demo', timeZone: 'Australia/Sydney', ownerEmail });
    const tenantId = created.json().tenant.tenantId;
    await admin.query(`update platform.memberships set invited_at = now() - interval '20 days' where tenant_id = $1`, [tenantId]);
    const again = await call('POST', `/v1/platform/tenants/${tenantId}/owner-invitation`, staff.email);
    expect(again.json()).toEqual({ tenantId, email: 'sent' });
    const { rows } = await admin.query(`select invited_at > now() - interval '1 minute' as fresh from platform.memberships where tenant_id = $1`, [tenantId]);
    expect(rows).toEqual([{ fresh: true }]);
  });

  it('refuses platform routes to anyone else, and to platform staff without a second factor', async () => {
    const { tenantId, members } = await tenantWith('owner');
    expect((await call('GET', '/v1/platform/tenants', members[0]!.email, tenantId)).statusCode).toBe(403);
    const staff = await createPlatformStaff();
    const token = await signIn(staff.email, undefined, { secondFactor: false });
    const refused = await app.inject({ method: 'GET', url: '/v1/platform/domains', headers: headers(token) });
    expect(refused.json().error.code).toBe('two_step_required');
    // The database checks for itself, whatever the API does.
    const someone = await createUser();
    await expect(
      withPerson(someone.id, (tx) => tx.db.execute(sql`select * from platform.create_tenant('Sneaky', 'Australia/Sydney', 'x@example.test', null, 'test')`)),
    ).rejects.toMatchObject(refusedWith(/needs platform staff/));
    const listed = await withPerson(someone.id, (tx) => tx.db.execute(sql`select * from platform.platform_tenants()`));
    expect(listed.rows).toEqual([]);
  });

  it("lists domains waiting for a check, and writes the check into the brand's tenant", async () => {
    const { tenantId } = await tenantWith('owner');
    const staff = await createPlatformStaff();
    const { domainId, brandId } = await createBrand(tenantId, { host: host() });
    const waiting = (await call('GET', '/v1/platform/domains', staff.email)).json().domains;
    expect(waiting.find((d: { domainId: string }) => d.domainId === domainId)).toMatchObject({ tenantId, brandId, verifiedAt: null });
    await call('POST', `/v1/platform/domains/${domainId}/verify`, staff.email);
    const after = (await call('GET', '/v1/platform/domains', staff.email)).json().domains;
    expect(after.some((d: { domainId: string }) => d.domainId === domainId)).toBe(false);
    const { rows } = await admin.query(`select tenant_id, action from platform.audit_log where record_id = $1`, [domainId]);
    expect(rows).toEqual([{ tenant_id: tenantId, action: 'brand_domain.verified' }]);
  });
});

describe('public pages (ADM16)', () => {
  it('finds a live or paused brand by a verified domain, and nothing else', async () => {
    const { tenantId } = await tenantWith('owner');
    const staff = await createPlatformStaff();
    const live = await createBrand(tenantId, { status: 'live', host: host(), verifiedBy: staff.id });
    const found = await app.inject({ method: 'GET', url: `/v1/public/brands/by-host/${live.host!.toUpperCase()}` });
    expect(found.statusCode).toBe(200);
    expect(found.headers['cache-control']).toBe('public, max-age=60');
    expect(found.json()).toMatchObject({ brandId: live.brandId, tenantId, status: 'live', supportEmail: 'help@example.test', timeZone: 'Australia/Sydney' });

    const paused = await createBrand(tenantId, { status: 'paused', host: host(), verifiedBy: staff.id });
    expect((await app.inject({ method: 'GET', url: `/v1/public/brands/by-host/${paused.host}` })).json().status).toBe('paused');
    const draft = await createBrand(tenantId, { host: host(), verifiedBy: staff.id });
    const unverified = await createBrand(tenantId, { status: 'live', host: host() });
    for (const missing of [draft.host, unverified.host, 'nowhere.example.test', 'not a host']) {
      expect((await app.inject({ method: 'GET', url: `/v1/public/brands/by-host/${encodeURIComponent(missing!)}` })).statusCode).toBe(404);
    }
  });
});

describe('the onboarding checklist (ADM18)', () => {
  it('is worked out from the data, and keeps new patients out until it is complete', async () => {
    const { tenantId, members } = await tenantWith('owner');
    const owner = members[0]!;
    const staff = await createPlatformStaff();
    const checklist = async () => (await call('GET', '/v1/tenant/onboarding', owner.email, tenantId)).json();
    expect(await checklist()).toEqual({
      ready: false,
      items: [
        { key: 'company', done: false },
        { key: 'live_brand', done: false },
        { key: 'medical_director', done: false },
        { key: 'prescriber', done: false },
      ],
    });
    const { brandId } = await createBrand(tenantId, { status: 'live', host: host(), verifiedBy: staff.id });
    const director = await createUser();
    await addMember(tenantId, director.id, 'medical_director');
    const accepting = () => withTenant(as(tenantId, owner.id), (tx) => assertAcceptingPatients(tx, brandId));
    await expect(accepting()).rejects.toMatchObject({ code: 'tenant_not_ready' });

    // A prescriber whose access has ended doesn't count.
    const gone = await createUser();
    const goneId = await addMember(tenantId, gone.id, 'prescriber');
    await admin.query(`update platform.memberships set expires_at = now() - interval '1 day' where id = $1`, [goneId]);
    expect((await checklist()).ready).toBe(false);
    const prescriber = await createUser();
    await addMember(tenantId, prescriber.id, 'prescriber');
    expect(await checklist()).toMatchObject({ ready: true });
    await expect(accepting()).resolves.toBeUndefined();

    await admin.query(`update platform.brands set status = 'paused' where id = $1`, [brandId]);
    await expect(accepting()).rejects.toMatchObject({ code: 'brand_not_accepting' });
  });
});

describe('tenant isolation of set-up tables (ADR 0006)', () => {
  it("can't read, change or delete another tenant's companies, brands or domains", async () => {
    const a = await tenantWith('owner');
    const b = await tenantWith('owner');
    const theirs = await createBrand(b.tenantId, { host: host() });
    const result = await withTenant(as(a.tenantId, a.members[0]!.id), async (tx) => ({
      companies: (await tx.db.execute(sql`select id from platform.companies where id = ${theirs.companyId}`)).rows,
      brands: (await tx.db.execute(sql`select id from platform.brands where id = ${theirs.brandId}`)).rows,
      domains: (await tx.db.execute(sql`select id from platform.brand_domains where id = ${theirs.domainId}`)).rows,
      renamed: (await tx.db.execute(sql`update platform.brands set name = 'Taken' where id = ${theirs.brandId}`)).rowCount,
      deleted: (await tx.db.execute(sql`delete from platform.brand_domains where id = ${theirs.domainId}`)).rowCount,
      gone: (await tx.db.execute(sql`delete from platform.companies where id = ${theirs.companyId}`)).rowCount,
    }));
    expect(result).toEqual({ companies: [], brands: [], domains: [], renamed: 0, deleted: 0, gone: 0 });
    // And the API answers as if it isn't there.
    expect((await call('GET', `/v1/brands/${theirs.brandId}`, a.members[0]!.email, a.tenantId)).statusCode).toBe(404);
  });
});
