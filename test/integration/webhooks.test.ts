import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { audit } from '../../src/lib/audit.js';
import { BusinessRuleError } from '../../src/lib/errors.js';
import { onWebhook, processPendingWebhooks, receiveWebhook } from '../../src/lib/webhooks.js';
import { admin, createTenant } from '../support/db.js';

/** The webhook inbox (ADR 0029, docs/decisions/webhooks.md). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const kind = () => `test.${randomUUID()}`;
const delivery = (tenantId: string) => ({ tenantId, requestId: 'test' });

async function row(tenantId: string, deliveryId: number) {
  const { rows } = await admin.query('select status, attempts, last_error, processed_at from platform.webhook_inbox where tenant_id = $1 and id = $2', [tenantId, deliveryId]);
  return rows[0];
}

describe('receiveWebhook', async () => {
  const tenantId = await createTenant();

  it('stores a delivery, processes it once, and ignores the provider sending it again', async () => {
    const k = kind();
    const seen: string[] = [];
    onWebhook('email', k, async (tx, incoming) => {
      seen.push(incoming.providerEventId);
      await audit(tx, { action: 'test.processed', zone: 'platform', recordTable: 'platform.webhook_inbox', recordId: String(incoming.deliveryId) });
    });
    const first = await receiveWebhook(delivery(tenantId), { provider: 'email', providerEventId: 'evt-1', kind: k, body: { a: 1 } });
    const again = await receiveWebhook(delivery(tenantId), { provider: 'email', providerEventId: 'evt-1', kind: k, body: { a: 1 } });
    expect(first).toMatchObject({ duplicate: false, outcome: 'processed' });
    expect(again).toEqual({ deliveryId: first.deliveryId, duplicate: true, outcome: 'skipped' });
    expect(seen).toEqual(['evt-1']);
    expect(await row(tenantId, first.deliveryId)).toMatchObject({ status: 'processed', attempts: 1, last_error: null });
  });

  it('rolls a failed handler back, records only its error code, and retries later', async () => {
    const k = kind();
    let fail = true;
    onWebhook('email', k, async (tx, incoming) => {
      await audit(tx, { action: 'test.processed', zone: 'platform', recordTable: 'platform.webhook_inbox', recordId: String(incoming.deliveryId) });
      if (fail) throw new BusinessRuleError('The body said something private', 'not_yet');
    });
    const first = await receiveWebhook(delivery(tenantId), { provider: 'email', providerEventId: `evt-${k}`, kind: k, body: {} });
    expect(first.outcome).toBe('failed');
    expect(await row(tenantId, first.deliveryId)).toMatchObject({ status: 'failed', attempts: 1, last_error: 'not_yet', processed_at: null });
    const written = await admin.query("select 1 from platform.audit_log where action = 'test.processed' and record_id = $1", [String(first.deliveryId)]);
    expect(written.rowCount).toBe(0);

    fail = false;
    expect(await processPendingWebhooks(tenantId)).toMatchObject({ processed: 1 });
    expect(await row(tenantId, first.deliveryId)).toMatchObject({ status: 'processed', attempts: 2, last_error: null });
  });

  it('keeps a delivery whose kind has no handler yet, untouched', async () => {
    const result = await receiveWebhook(delivery(tenantId), { provider: 'email', providerEventId: 'evt-unhandled', kind: kind(), body: {} });
    expect(result.outcome).toBe('skipped');
    expect(await row(tenantId, result.deliveryId)).toMatchObject({ status: 'received', attempts: 0 });
  });

  it('refuses a second handler for the same kind', () => {
    const k = kind();
    onWebhook('email', k, async () => {});
    expect(() => onWebhook('email', k, async () => {})).toThrow('already registered');
  });
});

describe('the inbox is tenant-isolated and append-only for the API', async () => {
  const a = await createTenant();
  const b = await createTenant();
  const stored = await receiveWebhook(delivery(a), { provider: 'email', providerEventId: 'evt-isolated', kind: kind(), body: {} });
  const system = (tenantId: string) => ({ tenantId, actor: { type: 'system' as const }, requestId: 'test' });

  it("doesn't show one tenant's deliveries to another, or let it change them", async () => {
    const seen = await withTenant(system(b), (tx) => tx.db.execute(sql`select id from platform.webhook_inbox where id = ${stored.deliveryId}`));
    expect(seen.rows).toEqual([]);
    const changed = await withTenant(system(b), (tx) =>
      tx.db.execute(sql`update platform.webhook_inbox set status = 'processed', processed_at = now() where id = ${stored.deliveryId}`),
    );
    expect(changed.rowCount).toBe(0);
  });

  it("can't delete a delivery or rewrite its body", async () => {
    await expect(withTenant(system(a), (tx) => tx.db.execute(sql`delete from platform.webhook_inbox where id = ${stored.deliveryId}`))).rejects.toThrow();
    await expect(
      withTenant(system(a), (tx) => tx.db.execute(sql`update platform.webhook_inbox set body = '{}'::jsonb where id = ${stored.deliveryId}`)),
    ).rejects.toThrow();
  });
});
