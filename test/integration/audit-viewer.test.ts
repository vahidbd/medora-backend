import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { audit, type AuditEntry } from '../../src/lib/audit.js';
import { AUDIT_EXPORT_LIMIT } from '../../src/modules/audit/audit.routes.js';
import { headers, signIn, testApp } from '../support/app.js';
import { admin, tenantWith } from '../support/db.js';

/** Reading and exporting the tenant's audit log (docs/decisions/admin.md ADM25, ADM26). */
const app = await testApp();
afterAll(async () => {
  await app.close();
  await closeDatabase();
  await admin.end();
});

const get = async (email: string, tenantId: string, query = '') =>
  app.inject({ method: 'GET', url: `/v1/audit${query}`, headers: headers(await signIn(email), tenantId) });
const exportLog = async (email: string, tenantId: string, payload: object = {}) =>
  app.inject({ method: 'POST', url: '/v1/audit/exports', headers: headers(await signIn(email), tenantId), payload });

const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'audit-viewer' });
const write = (context: TenantContext, entry: Partial<AuditEntry> & Pick<AuditEntry, 'action'>) =>
  withTenant(context, (tx) => audit(tx, { zone: 'platform', recordTable: 'platform.tenants', recordId: context.tenantId, ...entry }));

describe('the audit log viewer (ADM25)', () => {
  it("shows the tenant's own entries newest first, with who did it, and filters and pages them", async () => {
    const { tenantId, members } = await tenantWith('owner', 'compliance');
    const [owner, compliance] = members;
    await write(as(tenantId, owner!.id), { action: 'brand.created', recordTable: 'platform.brands', recordId: 'brand-1' });
    await write(as(tenantId, owner!.id), { action: 'brand.changed', recordTable: 'platform.brands', recordId: 'brand-1', details: { changed: 'name' } });
    await write(as(tenantId, compliance!.id), { action: 'product.created', zone: 'operational', recordTable: 'operational.products', recordId: 'product-1' });
    // Another tenant's entry with the same action never shows.
    const other = await tenantWith('owner');
    await write(as(other.tenantId, other.members[0]!.id), { action: 'brand.created', recordTable: 'platform.brands', recordId: 'brand-2' });

    const all = await get(compliance!.email, tenantId);
    expect(all.statusCode).toBe(200);
    const actions = all.json().entries.map((entry: { action: string }) => entry.action);
    expect(actions.slice(0, 3)).toEqual(['product.created', 'brand.changed', 'brand.created']);
    expect(all.json().entries.every((entry: { recordId: string }) => entry.recordId !== 'brand-2')).toBe(true);
    expect(all.json().entries[1]).toMatchObject({ actorType: 'person', actorId: owner!.id, actorName: expect.any(String), details: { changed: 'name' } });

    const brands = (await get(compliance!.email, tenantId, '?action=brand.')).json().entries;
    expect(brands.map((entry: { action: string }) => entry.action)).toEqual(['brand.changed', 'brand.created']);
    const byPerson = (await get(compliance!.email, tenantId, `?actorId=${compliance!.id}`)).json().entries;
    expect(byPerson.map((entry: { action: string }) => entry.action)).toEqual(['product.created']);
    const operational = (await get(compliance!.email, tenantId, '?zone=operational&recordId=product-1')).json().entries;
    expect(operational).toHaveLength(1);
    const later = (await get(compliance!.email, tenantId, `?from=${encodeURIComponent(new Date(Date.now() + 60_000).toISOString())}`)).json().entries;
    expect(later).toEqual([]);
    // An action filter is a prefix, never a pattern.
    expect((await get(compliance!.email, tenantId, '?action=brand%25')).json().entries).toEqual([]);

    const first = (await get(compliance!.email, tenantId, '?action=brand.&limit=1')).json();
    expect(first.entries.map((entry: { action: string }) => entry.action)).toEqual(['brand.changed']);
    const second = (await get(compliance!.email, tenantId, `?action=brand.&limit=1&before=${first.nextBefore}`)).json();
    expect(second.entries.map((entry: { action: string }) => entry.action)).toEqual(['brand.created']);
    expect(second.nextBefore).toBeNull();
  });

  it('is refused to a role without audit:read', async () => {
    const { tenantId, members } = await tenantWith('owner', 'clinician', 'medical_director');
    const [, clinician, director] = members;
    expect((await get(clinician!.email, tenantId)).statusCode).toBe(403);
    expect((await exportLog(clinician!.email, tenantId)).statusCode).toBe(403);
    expect((await get(director!.email, tenantId)).statusCode).toBe(200);
  });

  it('refuses a filter it does not know', async () => {
    const { tenantId, members } = await tenantWith('owner');
    expect((await get(members[0]!.email, tenantId, '?tenantId=someone-else')).statusCode).toBe(400);
  });
});

describe('exporting the audit log (ADM26)', () => {
  it('returns what the filter matches and records the export, with its filter and count', async () => {
    const { tenantId, members } = await tenantWith('owner', 'admin');
    const [owner, adminMember] = members;
    await write(as(tenantId, owner!.id), { action: 'staff.invited', recordTable: 'platform.invitations', recordId: 'invite-1' });
    await write(as(tenantId, owner!.id), { action: 'staff.invited', recordTable: 'platform.invitations', recordId: 'invite-2' });

    const taken = await exportLog(adminMember!.email, tenantId, { action: 'staff.' });
    expect(taken.statusCode).toBe(200);
    expect(taken.json()).toMatchObject({ truncated: false });
    expect(taken.json().entries).toHaveLength(2);

    const { rows } = await admin.query(`select actor_id, details from platform.audit_log where tenant_id = $1 and action = 'audit.exported'`, [tenantId]);
    expect(rows).toEqual([{ actor_id: adminMember!.id, details: expect.objectContaining({ count: 2, truncated: false, action: 'staff.' }) }]);
    // The export shows in the log it was taken from.
    expect((await get(owner!.email, tenantId, '?action=audit.')).json().entries).toHaveLength(1);
  });

  it(`allows ${AUDIT_EXPORT_LIMIT.max} exports an hour for each person`, async () => {
    const { tenantId, members } = await tenantWith('owner', 'compliance');
    const [owner, compliance] = members;
    for (let i = 0; i < AUDIT_EXPORT_LIMIT.max; i += 1) {
      expect((await exportLog(compliance!.email, tenantId)).statusCode).toBe(200);
    }
    const refused = await exportLog(compliance!.email, tenantId);
    expect(refused.statusCode).toBe(429);
    expect(Number(refused.headers['retry-after'])).toBeGreaterThan(0);
    // Someone else in the tenant still can.
    expect((await exportLog(owner!.email, tenantId)).statusCode).toBe(200);
  });
});
