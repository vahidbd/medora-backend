import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { tenantKeys } from '../../src/db/schema/index.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { decryptField, encryptField, FieldCryptoError } from '../../src/lib/field-crypto.js';
import { admin, createTenant } from '../support/db.js';

/**
 * Field encryption with each tenant's own key (ADR 0010,
 * docs/decisions/field-encryption.md). Values are made up.
 */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'test' });
const PURPOSE = 'clinical.example.value' as const;

describe('field encryption', async () => {
  const a = await createTenant();
  const b = await createTenant();

  it('opens what it sealed, and the stored text never holds the value', async () => {
    const sealed = await withTenant(system(a), (tx) => encryptField(tx, PURPOSE, 'made-up value 4412'));
    expect(sealed).not.toContain('4412');
    expect(sealed.startsWith('enc1.')).toBe(true);
    expect(await withTenant(system(a), (tx) => decryptField(tx, PURPOSE, sealed))).toBe('made-up value 4412');
  });

  it('seals the same value differently each time', async () => {
    const [first, second] = await withTenant(system(a), async (tx) => [await encryptField(tx, PURPOSE, 'same'), await encryptField(tx, PURPOSE, 'same')]);
    expect(first).not.toBe(second);
  });

  it("won't open another tenant's value", async () => {
    const sealed = await withTenant(system(a), (tx) => encryptField(tx, PURPOSE, 'tenant a only'));
    await expect(withTenant(system(b), (tx) => decryptField(tx, PURPOSE, sealed))).rejects.toThrow(FieldCryptoError);
  });

  it("won't open a value moved to another column", async () => {
    const sealed = await withTenant(system(a), (tx) => encryptField(tx, PURPOSE, 'for one column'));
    await expect(withTenant(system(a), (tx) => decryptField(tx, 'clinical.example.other', sealed))).rejects.toThrow(FieldCryptoError);
  });

  it("won't open a changed value", async () => {
    const sealed = await withTenant(system(a), (tx) => encryptField(tx, PURPOSE, 'untouched'));
    const parts = sealed.split('.');
    const body = Buffer.from(parts[3]!, 'base64url');
    body[0] = body[0]! ^ 1;
    parts[3] = body.toString('base64url');
    await expect(withTenant(system(a), (tx) => decryptField(tx, PURPOSE, parts.join('.')))).rejects.toThrow(FieldCryptoError);
    await expect(withTenant(system(a), (tx) => decryptField(tx, PURPOSE, 'not sealed'))).rejects.toThrow(FieldCryptoError);
  });

  it('makes one key per tenant, even when two first uses race, and audits it', async () => {
    const tenant = await createTenant();
    await Promise.all([1, 2, 3].map((n) => withTenant(system(tenant), (tx) => encryptField(tx, PURPOSE, `value ${n}`))));
    const keys = await admin.query('select id, wrapped_key from platform.tenant_keys where tenant_id = $1', [tenant]);
    expect(keys.rowCount).toBe(1);
    expect(keys.rows[0].wrapped_key.startsWith('local1.')).toBe(true);
    const audits = await admin.query("select count(*)::int as n from platform.audit_log where tenant_id = $1 and action = 'tenant_key.created'", [tenant]);
    expect(audits.rows[0].n).toBe(1);
  });
});

describe('tenant keys are isolated and kept (ADRs 0006, 0010)', async () => {
  const a = await createTenant();
  const b = await createTenant();
  await withTenant(system(a), (tx) => encryptField(tx, PURPOSE, 'x'));
  await withTenant(system(b), (tx) => encryptField(tx, PURPOSE, 'x'));

  it("sees only its own tenant's key", async () => {
    const seen = await withTenant(system(a), (tx) => tx.db.select({ tenantId: tenantKeys.tenantId }).from(tenantKeys));
    expect(seen).toEqual([{ tenantId: a }]);
  });

  it("can't add a key to another tenant", async () => {
    await expect(
      withTenant(system(a), (tx) => tx.db.insert(tenantKeys).values({ tenantId: b, provider: 'local', wrappedKey: 'local1.x.y.z' })),
    ).rejects.toThrow();
  });

  it('lets nobody change or remove a key, the owner included', async () => {
    await expect(withTenant(system(a), (tx) => tx.db.execute(sql`update platform.tenant_keys set wrapped_key = 'x'`))).rejects.toThrow();
    await expect(withTenant(system(a), (tx) => tx.db.execute(sql`delete from platform.tenant_keys`))).rejects.toThrow();
    await expect(admin.query('delete from platform.tenant_keys where tenant_id = $1', [a])).rejects.toThrow(/never changed or removed/);
    await expect(admin.query('truncate platform.tenant_keys')).rejects.toThrow(/never changed or removed/);
  });
});
