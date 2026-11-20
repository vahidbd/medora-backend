import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { App } from '../../src/app.js';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { approveDraft } from '../../src/modules/help-centre/articles.service.js';
import { HELP_CENTRE_LIMIT } from '../../src/modules/help-centre/public.routes.js';
import { SERVICE_ONLY_CONFIRMATION } from '../../src/modules/help-centre/rules.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, createBrand, tenantWith } from '../support/db.js';

/**
 * Each brand's help centre (PRD SUP-04, SUP-06, docs/decisions/support.md
 * SUP14 to SUP19). Made-up brands and wording only.
 */
const app: App = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });
const newHost = () => `help-${randomUUID().slice(0, 8)}.example.test`;

async function setUp(status: 'live' | 'paused' = 'live') {
  const { tenantId, members } = await tenantWith('owner', 'admin', 'support');
  const [owner, manager, support] = members;
  const brand = await createBrand(tenantId, { status, host: newHost(), verifiedBy: owner!.id });
  const as = async (member: { email: string }) => headers(await signIn(member.email), tenantId);
  const mine = await as(manager!);
  const section = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: mine, payload: { brandId: brand.brandId, name: 'Orders and delivery' } });
  return { tenantId, brand, host: brand.host!, manager: manager!, support: support!, mine, as, sectionId: section.json().sectionId as string };
}

type Setup = Awaited<ReturnType<typeof setUp>>;

async function write(t: Setup, slug: string, body = 'Orders leave within two business days. Track delivery from your account.') {
  const reply = await app.inject({
    method: 'POST',
    url: '/v1/help-centre/articles',
    headers: t.mine,
    payload: { brandId: t.brand.brandId, sectionId: t.sectionId, slug, title: 'How delivery works', summary: 'When your order leaves and arrives', body },
  });
  expect(reply.statusCode).toBe(201);
  return reply.json().articleId as string;
}

const draftOf = async (t: Setup, articleId: string): Promise<string> =>
  (await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${articleId}`, headers: t.mine })).json().draft.versionId;
const approveVersion = (t: Setup, articleId: string, versionId: string) =>
  app.inject({ method: 'POST', url: `/v1/help-centre/articles/${articleId}/draft/approve`, headers: t.mine, payload: { versionId, confirm: SERVICE_ONLY_CONFIRMATION } });
const approve = async (t: Setup, articleId: string) => approveVersion(t, articleId, await draftOf(t, articleId));
const publicPage = (host: string, path = '') => app.inject({ method: 'GET', url: `/v1/public/help-centre/${host}${path}` });

describe('writing and approving (SUP15, SUP16, SUP18)', async () => {
  const t = await setUp();

  it('keeps a draft off the public pages until someone approves it, who may be its writer', async () => {
    const articleId = await write(t, 'how-delivery-works');
    expect((await publicPage(t.host)).json().sections).toEqual([]);
    expect((await publicPage(t.host, '/articles/how-delivery-works')).statusCode).toBe(404);

    const unconfirmed = await app.inject({
      method: 'POST',
      url: `/v1/help-centre/articles/${articleId}/draft/approve`,
      headers: t.mine,
      payload: { versionId: await draftOf(t, articleId) },
    });
    expect(unconfirmed.statusCode).toBe(400);
    const approved = await approve(t, articleId);
    expect(approved.statusCode).toBe(200);
    expect(approved.json()).toMatchObject({
      status: 'published',
      draft: null,
      live: { writtenByUserId: t.manager.id, approvedByUserId: t.manager.id, checkedWith: 'format-1', confirmation: SERVICE_ONLY_CONFIRMATION },
    });

    const page = await publicPage(t.host);
    expect(page.headers['cache-control']).toBe('public, max-age=60');
    expect(page.json().sections).toEqual([
      { name: 'Orders and delivery', articles: [{ slug: 'how-delivery-works', title: 'How delivery works', summary: 'When your order leaves and arrives' }] },
    ]);
    expect((await publicPage(t.host, '/articles/how-delivery-works')).json()).toMatchObject({ section: 'Orders and delivery', body: expect.stringContaining('two business days') });
  });

  it('leaves the live wording up while the next draft waits, and keeps every approved version', async () => {
    const articleId = await write(t, 'returns');
    await approve(t, articleId);
    const draft = await app.inject({
      method: 'PUT',
      url: `/v1/help-centre/articles/${articleId}/draft`,
      headers: t.mine,
      payload: { title: 'Returns', summary: 'Sending something back', body: 'Unopened items come back within 30 days.' },
    });
    expect(draft.json()).toMatchObject({ status: 'published', draft: { title: 'Returns' }, live: { title: 'How delivery works' } });
    expect((await publicPage(t.host, '/articles/returns')).json().title).toBe('How delivery works');

    const second = await approve(t, articleId);
    expect(second.json().history).toHaveLength(2);
    expect((await publicPage(t.host, '/articles/returns')).json().title).toBe('Returns');
  });

  it('never changes or removes approved wording, and puts only approved wording live, whatever code asks', async () => {
    const articleId = await write(t, 'refunds');
    const [live] = (await approve(t, articleId)).json().history;
    await app.inject({
      method: 'PUT',
      url: `/v1/help-centre/articles/${articleId}/draft`,
      headers: t.mine,
      payload: { title: 'Refunds', summary: 'Money back', body: 'New words.' },
    });
    const draftId = (await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${articleId}`, headers: t.mine })).json().draft.versionId;
    const run = (statement: string) => withTenant(system(t.tenantId), (tx) => tx.db.execute(statement));
    await expect(run(`update operational.help_centre_article_versions set body = 'changed' where id = '${live.versionId}'`)).rejects.toThrow();
    await expect(run(`delete from operational.help_centre_article_versions where id = '${live.versionId}'`)).rejects.toThrow();
    await expect(run(`update operational.help_centre_articles set live_version_id = '${draftId}' where id = '${articleId}'`)).rejects.toThrow();
    await expect(run(`update operational.help_centre_articles set slug = 'moved' where id = '${articleId}'`)).rejects.toThrow();
  });

  it('refuses to approve a draft saved since the approver read it', async () => {
    const articleId = await write(t, 'read-first');
    const read = await draftOf(t, articleId);
    await app.inject({
      method: 'PUT',
      url: `/v1/help-centre/articles/${articleId}/draft`,
      headers: t.mine,
      payload: { title: 'Read first', summary: 'Changed', body: 'Newer words.' },
    });
    const stale = await approveVersion(t, articleId, read);
    expect(stale.json().error.code).toBe('draft_changed');
    expect((await approve(t, articleId)).json().live.summary).toBe('Changed');
    const audit = await admin.query("select action from platform.audit_log where record_id = $1 and action like 'help_centre_article.%' order by id", [articleId]);
    expect(audit.rows.map((row) => row.action)).toEqual([
      'help_centre_article.created',
      'help_centre_article.draft_saved',
      'help_centre_article.approved',
      'help_centre_article.published',
    ]);
  });

  it('refuses a non-person approving, and a section name the publish check refuses', async () => {
    const articleId = await write(t, 'people-only');
    const versionId = await draftOf(t, articleId);
    await expect(withTenant(system(t.tenantId), (tx) => approveDraft(tx, articleId, versionId))).rejects.toMatchObject({ code: 'person_only' });
    const section = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: t.mine, payload: { brandId: t.brand.brandId, name: '<b>Orders</b>' } });
    expect(section.json().error.code).toBe('publish_check_failed');
  });

  it("refuses HTML in the wording, and fixes the article's slug once published", async () => {
    const html = await app.inject({
      method: 'POST',
      url: '/v1/help-centre/articles',
      headers: t.mine,
      payload: { brandId: t.brand.brandId, sectionId: t.sectionId, slug: 'html', title: 'Hi', summary: 'Hi', body: 'Hello <script>x</script>' },
    });
    expect(html.statusCode).toBe(400);
    const articleId = await write(t, 'pausing');
    expect((await app.inject({ method: 'PATCH', url: `/v1/help-centre/articles/${articleId}`, headers: t.mine, payload: { slug: 'pause' } })).statusCode).toBe(200);
    await approve(t, articleId);
    const fixed = await app.inject({ method: 'PATCH', url: `/v1/help-centre/articles/${articleId}`, headers: t.mine, payload: { slug: 'pausing-again' } });
    expect(fixed.json().error.code).toBe('slug_fixed');
  });
});

describe('the way back out', async () => {
  const t = await setUp();

  it('takes an article down and puts it back up, for the public and for agents', async () => {
    const articleId = await write(t, 'tracking', 'Track your parcel from the orders page.');
    await approve(t, articleId);
    const search = () => app.inject({ method: 'GET', url: '/v1/help-centre/search?q=parcel', headers: t.mine });
    expect((await search()).json().articles).toHaveLength(1);

    const down = await app.inject({ method: 'POST', url: `/v1/help-centre/articles/${articleId}/unpublish`, headers: t.mine });
    expect(down.json()).toMatchObject({ status: 'unpublished', publishedAt: null });
    expect((await publicPage(t.host, '/articles/tracking')).statusCode).toBe(404);
    expect((await search()).json().articles).toEqual([]);

    const up = await app.inject({ method: 'POST', url: `/v1/help-centre/articles/${articleId}/publish`, headers: t.mine });
    expect(up.json().status).toBe('published');
    expect((await publicPage(t.host, '/articles/tracking')).statusCode).toBe(200);
    const events = await admin.query('select type, payload from platform.outbox where record_id = $1 order by id', [articleId]);
    expect(events.rows.map((row) => row.type)).toEqual(['help_centre_article.published', 'help_centre_article.unpublished', 'help_centre_article.published']);
  });

  it('discards a draft, and an article that was never published goes with it', async () => {
    const articleId = await write(t, 'never-published');
    const discarded = await app.inject({ method: 'DELETE', url: `/v1/help-centre/articles/${articleId}/draft`, headers: t.mine });
    expect(discarded.json()).toEqual({ discarded: true, articleRemoved: true });
    expect((await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${articleId}`, headers: t.mine })).statusCode).toBe(404);
  });

  it('removes only an empty section', async () => {
    const full = await app.inject({ method: 'DELETE', url: `/v1/help-centre/sections/${t.sectionId}`, headers: t.mine });
    expect(full.json().error.code).toBe('section_not_empty');
    const empty = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: t.mine, payload: { brandId: t.brand.brandId, name: 'Billing' } });
    expect((await app.inject({ method: 'DELETE', url: `/v1/help-centre/sections/${empty.json().sectionId}`, headers: t.mine })).statusCode).toBe(200);
  });
});

describe('who does what (SUP16, SUP19)', async () => {
  const t = await setUp();

  it('lets support read and search published articles, never drafts, and not write them', async () => {
    const theirs = await t.as(t.support);
    const live = await write(t, 'support-live');
    await approve(t, live);
    await app.inject({ method: 'PUT', url: `/v1/help-centre/articles/${live}/draft`, headers: t.mine, payload: { title: 'Next', summary: 'Next', body: 'Unapproved words.' } });
    const draftOnly = await write(t, 'support-draft');
    const list = (await app.inject({ method: 'GET', url: '/v1/help-centre/articles', headers: theirs })).json().articles;
    expect(list.map((article: { slug: string }) => article.slug)).toEqual(['support-live']);
    expect(list[0].draft).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${live}`, headers: theirs })).json().draft).toBeNull();
    expect((await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${draftOnly}`, headers: theirs })).statusCode).toBe(404);
    const refused = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: theirs, payload: { brandId: t.brand.brandId, name: 'Account' } });
    expect(refused.statusCode).toBe(403);
  });

  it("gives the agent's search published wording only, with the version and brand to cite", async () => {
    const live = await write(t, 'dispatch', 'We dispatch orders from Sydney every weekday.');
    await approve(t, live);
    await write(t, 'dispatch-draft', 'A draft about dispatch that nobody approved.');
    const reply = await app.inject({ method: 'GET', url: `/v1/help-centre/search?q=dispatch&brandId=${t.brand.brandId}`, headers: t.mine });
    expect(reply.json().articles).toEqual([expect.objectContaining({ articleId: live, slug: 'dispatch', brandName: t.brand.slug, versionId: expect.any(String) })]);
  });

  it("leaves out a brand that isn't public yet", async () => {
    const hidden = await createBrand(t.tenantId, { status: 'draft' });
    const section = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: t.mine, payload: { brandId: hidden.brandId, name: 'Soon' } });
    const created = await app.inject({
      method: 'POST',
      url: '/v1/help-centre/articles',
      headers: t.mine,
      payload: {
        brandId: hidden.brandId,
        sectionId: section.json().sectionId,
        slug: 'coming-soon',
        title: 'Coming soon',
        summary: 'Soon',
        body: 'Our hamper service starts soon.',
      },
    });
    await approve(t, created.json().articleId);
    expect((await app.inject({ method: 'GET', url: '/v1/help-centre/search?q=hamper', headers: t.mine })).json().articles).toEqual([]);
  });
});

describe('the public pages (SUP17)', async () => {
  it('serves a paused brand, shows an empty help centre as empty, and 404s an unknown or unverified host', async () => {
    const paused = await setUp('paused');
    expect((await publicPage(paused.host)).json()).toEqual({ brandName: paused.brand.slug, sections: [] });
    expect((await publicPage(newHost())).statusCode).toBe(404);
    const unverified = await createBrand(paused.tenantId, { status: 'live', host: newHost() });
    expect((await publicPage(unverified.host!)).statusCode).toBe(404);
  });

  it('limits each client address, with a time to try again', async () => {
    const t = await setUp();
    const key = `${HELP_CENTRE_LIMIT.name}:127.0.0.1`;
    await admin.query(
      'insert into platform.rate_limit_counters (key, window_started_at, count) values ($1, now(), $2) on conflict (key) do update set window_started_at = now(), count = $2',
      [key, HELP_CENTRE_LIMIT.max],
    );
    const reply = await publicPage(t.host);
    await admin.query('delete from platform.rate_limit_counters where key = $1', [key]);
    expect(reply.statusCode).toBe(429);
    expect(Number(reply.headers['retry-after'])).toBeGreaterThan(0);
  });

  it('searches one brand only, and never caches a search', async () => {
    const t = await setUp();
    const other = await setUp();
    await approve(t, await write(t, 'parcel-lockers', 'We can deliver to a parcel locker.'));
    await approve(other, await write(other, 'parcel-lockers', 'Another brand also delivers to a parcel locker.'));
    const reply = await publicPage(t.host, '/search?q=locker');
    expect(reply.headers['cache-control']).toBe('no-store');
    expect(reply.json().articles).toEqual([{ slug: 'parcel-lockers', title: 'How delivery works', summary: 'When your order leaves and arrives', section: 'Orders and delivery' }]);
  });
});

describe('tenancy of the help centre (ADR 0006)', async () => {
  const a = await setUp();
  const b = await setUp();
  const articleId = await write(b, 'their-article');

  it("can't use another tenant's brand, or another brand's section", async () => {
    const brand = await app.inject({ method: 'POST', url: '/v1/help-centre/sections', headers: a.mine, payload: { brandId: b.brand.brandId, name: 'Theirs' } });
    expect(brand.statusCode).toBe(404);
    const section = await app.inject({
      method: 'POST',
      url: '/v1/help-centre/articles',
      headers: a.mine,
      payload: { brandId: a.brand.brandId, sectionId: b.sectionId, slug: 'mixed', title: 'Mixed', summary: 'Mixed', body: 'Mixed.' },
    });
    expect(section.json().error.code).toBe('section_not_found');
    expect((await app.inject({ method: 'GET', url: `/v1/help-centre/articles/${articleId}`, headers: a.mine })).statusCode).toBe(404);
  });

  it("never shows, changes or deletes another tenant's sections, articles or versions", async () => {
    const run = (statement: string) => withTenant(system(a.tenantId), (tx) => tx.db.execute(statement));
    for (const table of ['operational.help_centre_sections', 'operational.help_centre_articles', 'operational.help_centre_article_versions']) {
      expect((await run(`select 1 from ${table} where tenant_id = '${b.tenantId}'`)).rows).toEqual([]);
      expect((await run(`update ${table} set updated_at = now() where tenant_id = '${b.tenantId}'`)).rowCount).toBe(0);
      expect((await run(`delete from ${table} where tenant_id = '${b.tenantId}'`)).rowCount).toBe(0);
      const kept = await admin.query(`select count(*)::int as n from ${table} where tenant_id = $1`, [b.tenantId]);
      expect(kept.rows[0].n).toBeGreaterThan(0);
    }
  });
});
