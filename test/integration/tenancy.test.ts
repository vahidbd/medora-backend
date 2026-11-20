import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { db } from '../../src/db/client.js';
import { closeDatabase } from '../../src/db/health.js';
import { memberships, outbox, tenants } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { audit } from '../../src/lib/audit.js';
import { emitEvent } from '../../src/lib/events.js';
import { admin, tenantWith } from '../support/db.js';

/** A tenant never reads, changes or deletes another tenant's rows (ADR 0006). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });

describe('tenant isolation', async () => {
  const a = await tenantWith('owner', 'clinician');
  const b = await tenantWith('owner');
  const ownerA = a.members[0]!;
  const ownerB = b.members[0]!;

  it("sees only its own tenant, memberships, audit entries and events", async () => {
    await withTenant(as(b.tenantId, ownerB.id), async (tx) => {
      await audit(tx, { action: 'test.written', zone: 'platform', recordTable: 'platform.tenants', recordId: b.tenantId });
      await emitEvent(tx, { type: 'test.written', recordTable: 'platform.tenants', recordId: b.tenantId });
    });
    const seen = await withTenant(as(a.tenantId, ownerA.id), async (tx) => ({
      tenants: await tx.db.select({ id: tenants.id }).from(tenants),
      memberships: await tx.db.select({ tenantId: memberships.tenantId }).from(memberships),
      audit: await tx.db.execute<{ tenant_id: string }>(sql`select tenant_id from platform.audit_log`),
      outbox: await tx.db.select({ tenantId: outbox.tenantId }).from(outbox),
    }));
    expect(seen.tenants).toEqual([{ id: a.tenantId }]);
    expect(seen.memberships.map((m) => m.tenantId)).toEqual([a.tenantId, a.tenantId]);
    expect(seen.audit.rows.every((row) => row.tenant_id === a.tenantId)).toBe(true);
    expect(seen.outbox.every((row) => row.tenantId === a.tenantId)).toBe(true);
  });

  it("can't change or delete another tenant's rows", async () => {
    const changed = await withTenant(as(a.tenantId, ownerA.id), (tx) =>
      tx.db.execute(sql`update platform.memberships set role = 'support' where id = ${ownerB.membershipId}`),
    );
    expect(changed.rowCount).toBe(0);
    const { rows } = await admin.query('select role from platform.memberships where id = $1', [ownerB.membershipId]);
    expect(rows[0].role).toBe('owner');
  });

  it("can't write a row into another tenant", async () => {
    await expect(
      withTenant(as(a.tenantId, ownerA.id), (tx) => emitEvent({ ...tx, context: { ...tx.context, tenantId: b.tenantId } }, { type: 'test.written', recordTable: 'platform.tenants', recordId: 'x' })),
    ).rejects.toThrow();
  });

  it('sees nothing without a tenant', async () => {
    const result = await db.transaction(async (tx) => ({
      tenants: await tx.select().from(tenants),
      memberships: await tx.select().from(memberships),
      outbox: await tx.select().from(outbox),
    }));
    expect(result).toEqual({ tenants: [], memberships: [], outbox: [] });
  });
});
