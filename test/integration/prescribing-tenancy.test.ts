import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { type TenantContext, withTenant } from '../../src/db/tenant.js';
import { admin, tenantWith } from '../support/db.js';

/** Prescribing's tables keep each tenant's rows to itself (ADR 0006). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const as = (tenantId: string, userId: string): TenantContext => ({ tenantId, actor: { type: 'person', userId }, requestId: 'test' });

describe("prescribing's tables", async () => {
  const a = await tenantWith('clinician');
  const b = await tenantWith('clinician');
  const personA = a.members[0]!;
  const personB = b.members[0]!;
  const patientId = randomUUID();
  const consultId = randomUUID();

  await admin.query('insert into clinical.parchment_patients (tenant_id, patient_id, parchment_patient_id) values ($1, $2, $3)', [b.tenantId, patientId, `pat_${randomUUID()}`]);
  await admin.query('insert into operational.parchment_prescribers (tenant_id, user_id, parchment_user_id) values ($1, $2, $3)', [b.tenantId, personB.id, `usr_${randomUUID()}`]);
  await admin.query(
    'insert into clinical.prescribing_sessions (tenant_id, patient_id, prescriber_user_id, parchment_user_id, consult_id) values ($1, $2, $3, $4, $5)',
    [b.tenantId, patientId, personB.id, 'usr_b', consultId],
  );

  const tables = ['clinical.parchment_patients', 'operational.parchment_prescribers', 'clinical.prescribing_sessions'];

  it.each(tables)("%s: another tenant can't read its rows", async (table) => {
    const seen = await withTenant(as(a.tenantId, personA.id), (tx) => tx.db.execute(sql`select tenant_id from ${sql.raw(table)}`));
    expect(seen.rows).toEqual([]);
  });

  it("another tenant can't change a patient link", async () => {
    const changed = await withTenant(as(a.tenantId, personA.id), (tx) => tx.db.execute(sql`update clinical.parchment_patients set synced_at = now()`));
    expect(changed.rowCount).toBe(0);
  });

  it.each(tables)("%s: nobody deletes from it, not even its own tenant", async (table) => {
    await expect(withTenant(as(b.tenantId, personB.id), (tx) => tx.db.execute(sql`delete from ${sql.raw(table)}`))).rejects.toThrow();
  });

  it("never changes a prescribing session, or which patient a link is for", async () => {
    await expect(withTenant(as(b.tenantId, personB.id), (tx) => tx.db.execute(sql`update clinical.prescribing_sessions set consult_id = gen_random_uuid()`))).rejects.toThrow();
    await expect(withTenant(as(b.tenantId, personB.id), (tx) => tx.db.execute(sql`update clinical.parchment_patients set patient_id = gen_random_uuid()`))).rejects.toThrow();
  });

  it("can't write a row into another tenant", async () => {
    await expect(
      withTenant(as(a.tenantId, personA.id), (tx) =>
        tx.db.execute(sql`insert into clinical.parchment_patients (tenant_id, patient_id, parchment_patient_id) values (${b.tenantId}, ${randomUUID()}, 'pat_forged')`),
      ),
    ).rejects.toThrow();
  });
});
