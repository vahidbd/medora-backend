import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { closeDatabase } from '../../src/db/health.js';
import { withTenant } from '../../src/db/tenant.js';
import { emitEvent } from '../../src/lib/events.js';
import { deliverDueEvents, retryDelaySeconds, type DeliveredEvent, type EventHandler } from '../../src/lib/outbox-delivery.js';
import { admin, createTenant } from '../support/db.js';
import { recordingLog } from '../support/log.js';

/** Events reach every handler once, after commit, with retries (ADRs 0016 and 0029, docs/decisions/jobs.md). */
afterAll(async () => {
  await closeDatabase();
  await admin.end();
});

const ALL = { tenants: 10_000 };

async function emit(tenantId: string, type: `${string}.${string}`): Promise<number> {
  await withTenant({ tenantId, actor: { type: 'system' }, requestId: 'test' }, (tx) =>
    emitEvent(tx, { type, recordTable: 'platform.tenants', recordId: tenantId, payload: { n: 1 } }),
  );
  const { rows } = await admin.query('select id from platform.outbox where tenant_id = $1 and type = $2 order by id desc limit 1', [tenantId, type]);
  return Number(rows[0].id);
}

const eventRow = async (id: number) =>
  (await admin.query('select delivered_at, failed_at, attempts, last_error, next_attempt_at > now() as later from platform.outbox where id = $1', [id])).rows[0];

/** Pretend the retry delay has passed. */
const makeDue = (id: number) => admin.query('update platform.outbox set next_attempt_at = now() where id = $1', [id]);

function recorder(name: string, type: string, fail = () => false): EventHandler & { seen: DeliveredEvent[] } {
  const seen: DeliveredEvent[] = [];
  return {
    name,
    eventTypes: [type],
    seen,
    handle: async (event) => {
      seen.push(event);
      if (fail()) throw Object.assign(new Error('the patient jane@example.test could not be reached'), { code: 'unreachable' });
    },
  };
}

describe('outbox delivery', () => {
  it('hands an event to each subscribed handler once, in its tenant, then marks it delivered', async () => {
    const tenantId = await createTenant();
    const type = `test.${randomUUID().slice(0, 8)}` as const;
    const a = recorder('handler-a', type);
    const b = recorder('handler-b', type);
    const id = await emit(tenantId, type);
    await deliverDueEvents([a, b], recordingLog(), ALL);
    await deliverDueEvents([a, b], recordingLog(), ALL);
    expect(a.seen.map((e) => e.id)).toEqual([id]);
    expect(b.seen.map((e) => e.id)).toEqual([id]);
    expect(a.seen[0]).toMatchObject({ tenantId, type, payload: { n: 1 } });
    expect((await eventRow(id)).delivered_at).not.toBeNull();
  });

  it('marks an event no handler wants as delivered', async () => {
    const tenantId = await createTenant();
    const id = await emit(tenantId, `test.unwanted${randomUUID().slice(0, 6)}`);
    await deliverDueEvents([], recordingLog(), ALL);
    expect((await eventRow(id)).delivered_at).not.toBeNull();
  });

  it('retries only the handler that failed, later, and never stores the error message', async () => {
    const tenantId = await createTenant();
    const type = `test.${randomUUID().slice(0, 8)}` as const;
    let failing = true;
    const ok = recorder('handler-ok', type);
    const flaky = recorder('handler-flaky', type, () => failing);
    const id = await emit(tenantId, type);

    await deliverDueEvents([ok, flaky], recordingLog(), ALL);
    const afterFailure = await eventRow(id);
    expect(afterFailure).toMatchObject({ delivered_at: null, attempts: 1, last_error: 'Error:unreachable', later: true });

    await deliverDueEvents([ok, flaky], recordingLog(), ALL);
    expect(flaky.seen).toHaveLength(1);

    failing = false;
    await makeDue(id);
    await deliverDueEvents([ok, flaky], recordingLog(), ALL);
    expect(ok.seen).toHaveLength(1);
    expect(flaky.seen).toHaveLength(2);
    expect((await eventRow(id)).delivered_at).not.toBeNull();
  });

  it('gives up after the last attempt and reports it', async () => {
    const tenantId = await createTenant();
    const type = `test.${randomUUID().slice(0, 8)}` as const;
    const broken = recorder('handler-broken', type, () => true);
    const id = await emit(tenantId, type);
    const log = recordingLog();
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await deliverDueEvents([broken], log, { ...ALL, maxAttempts: 3 });
      await makeDue(id);
    }
    expect((await eventRow(id)).failed_at).not.toBeNull();
    await deliverDueEvents([broken], log, { ...ALL, maxAttempts: 3 });
    expect(broken.seen).toHaveLength(3);
    expect(log.lines.some((line) => line.level === 'error' && line.message === 'event delivery gave up')).toBe(true);
  });

  it("serves a tenant's backlog a batch at a time, so other tenants aren't held up", async () => {
    const busy = await createTenant();
    const quiet = await createTenant();
    const type = `test.${randomUUID().slice(0, 8)}` as const;
    for (let i = 0; i < 5; i += 1) await emit(busy, type);
    await emit(quiet, type);
    const handler = recorder('handler-batch', type);
    await deliverDueEvents([handler], recordingLog(), { ...ALL, perTenant: 2 });
    const perTenant = (tenantId: string) => handler.seen.filter((e) => e.tenantId === tenantId).length;
    expect(perTenant(busy)).toBe(2);
    expect(perTenant(quiet)).toBe(1);
  });

  it('backs off by doubling, up to an hour', () => {
    expect([1, 2, 3, 20].map(retryDelaySeconds)).toEqual([30, 60, 120, 3600]);
  });
});
