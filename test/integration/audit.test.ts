import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { audit } from '../../src/lib/audit.js';
import { admin, tenantWith } from '../support/db.js';

/** Audit entries commit with the change, and can never be changed (ADR 0008). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

describe('the audit log', async () => {
  const { tenantId, members } = await tenantWith('owner');
  const context = { tenantId, actor: { type: 'person' as const, userId: members[0]!.id }, requestId: 'audit-test' };
  const entry = { action: 'test.audited', zone: 'platform', recordTable: 'platform.tenants', recordId: tenantId } as const;

  it('writes the entry with the work', async () => {
    await withTenant(context, (tx) => audit(tx, entry));
    const { rows } = await admin.query('select actor_type, actor_id, request_id from platform.audit_log where tenant_id = $1 and action = $2', [tenantId, entry.action]);
    expect(rows).toEqual([{ actor_type: 'person', actor_id: members[0]!.id, request_id: 'audit-test' }]);
  });

  it('loses the entry when the work rolls back', async () => {
    await expect(
      withTenant(context, async (tx) => {
        await audit(tx, { ...entry, action: 'test.rolled_back' });
        throw new Error('the work failed');
      }),
    ).rejects.toThrow('the work failed');
    const { rowCount } = await admin.query('select 1 from platform.audit_log where tenant_id = $1 and action = $2', [tenantId, 'test.rolled_back']);
    expect(rowCount).toBe(0);
  });

  it('refuses UPDATE, DELETE and TRUNCATE even for the superuser', async () => {
    await expect(admin.query("update platform.audit_log set action = 'test.edited' where tenant_id = $1", [tenantId])).rejects.toThrow(/append-only/);
    await expect(admin.query('delete from platform.audit_log where tenant_id = $1', [tenantId])).rejects.toThrow(/append-only/);
    await expect(admin.query('truncate platform.audit_log cascade')).rejects.toThrow(/append-only/);
  });
});
