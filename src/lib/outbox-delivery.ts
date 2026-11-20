import { and, asc, eq, inArray, isNull, lte, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { outbox, outboxDeliveries } from '../db/schema/index.js';
import { type TenantContext, withTenant } from '../db/tenant.js';
import type { Job, JobLogger } from './jobs.js';
import { safeErrorMessage } from './redact.js';

/**
 * Delivering the outbox (ADRs 0016 and 0029, docs/decisions/jobs.md). Events
 * are read after the change that wrote them committed, handed to every
 * handler that subscribes to their type, and marked delivered once each
 * handler has succeeded. A handler that already succeeded for an event is
 * never run for it again (JOB3); a failure is tried again later with backoff,
 * and an event whose attempts run out is marked failed and reported.
 */

export interface DeliveredEvent {
  id: number;
  tenantId: string;
  type: string;
  recordTable: string;
  recordId: string;
  payload: Record<string, unknown>;
  requestId: string | null;
  createdAt: Date;
}

export interface EventHandler {
  /** Unique, kebab-case; deliveries are recorded per handler. Renaming one delivers its events again. */
  name: string;
  eventTypes: readonly string[];
  /**
   * Runs outside any transaction: open withTenant for database work. At least
   * once per event, so it must be safe to run twice; use the event id as the
   * idempotency key for outside calls (ADR 0029).
   */
  handle(event: DeliveredEvent): Promise<void>;
}

export interface DeliveryOptions {
  /** Tenants served per pass, oldest due first (JOB4). */
  tenants?: number;
  /** Events per tenant per pass, so one tenant's spike can't hold up the others. */
  perTenant?: number;
  /** Attempts before an event is marked failed (JOB2). */
  maxAttempts?: number;
}

export interface DeliveryResult {
  delivered: number;
  retrying: number;
  failed: number;
}

/** Seconds before the next try after `attempts` failures: 30s doubling, at most an hour (JOB2). */
export function retryDelaySeconds(attempts: number): number {
  return Math.min(30 * 2 ** Math.max(attempts - 1, 0), 3600);
}

/** The error's name and code, never its message: a message can carry personal details. */
function errorLabel(error: unknown): string {
  if (!(error instanceof Error)) return 'Error';
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' ? `${error.name}:${code}`.slice(0, 120) : error.name.slice(0, 120);
}

export function assertHandlersValid(handlers: readonly EventHandler[]): void {
  const seen = new Set<string>();
  for (const handler of handlers) {
    if (!/^[a-z][a-z0-9]*(-[a-z0-9]+)*$/.test(handler.name)) throw new Error(`Event handler name ${handler.name} must be kebab-case`);
    if (seen.has(handler.name)) throw new Error(`Two event handlers are named ${handler.name}`);
    if (handler.eventTypes.length === 0) throw new Error(`Event handler ${handler.name} subscribes to nothing`);
    seen.add(handler.name);
  }
}

const system = (tenantId: string): TenantContext => ({ tenantId, actor: { type: 'system' }, requestId: 'job:outbox-delivery' });

/** One pass over the events that are due now. */
export async function deliverDueEvents(handlers: readonly EventHandler[], log: JobLogger, options: DeliveryOptions = {}): Promise<DeliveryResult> {
  const { tenants = 50, perTenant = 100, maxAttempts = 12 } = options;
  const result: DeliveryResult = { delivered: 0, retrying: 0, failed: 0 };
  const due = await db.execute<{ tenant_id: string }>(sql`select tenant_id from platform.tenants_with_due_events(${tenants})`);
  for (const { tenant_id: tenantId } of due.rows) {
    const events = await withTenant(system(tenantId), async (tx) => {
      const rows = await tx.db
        .select()
        .from(outbox)
        .where(and(isNull(outbox.deliveredAt), isNull(outbox.failedAt), lte(outbox.nextAttemptAt, sql`now()`)))
        .orderBy(asc(outbox.id))
        .limit(perTenant);
      const done = rows.length
        ? await tx.db
            .select({ eventId: outboxDeliveries.eventId, handler: outboxDeliveries.handler })
            .from(outboxDeliveries)
            .where(inArray(outboxDeliveries.eventId, rows.map((row) => row.id)))
        : [];
      return rows.map((row) => ({ row, done: new Set(done.filter((d) => d.eventId === row.id).map((d) => d.handler)) }));
    });
    for (const { row, done } of events) {
      const event: DeliveredEvent = {
        id: row.id,
        tenantId: row.tenantId,
        type: row.type,
        recordTable: row.recordTable,
        recordId: row.recordId,
        payload: row.payload as Record<string, unknown>,
        requestId: row.requestId,
        createdAt: row.createdAt,
      };
      const pending = handlers.filter((handler) => handler.eventTypes.includes(event.type) && !done.has(handler.name));
      let lastError: unknown = null;
      for (const handler of pending) {
        try {
          await handler.handle(event);
          await withTenant(system(tenantId), (tx) =>
            tx.db.insert(outboxDeliveries).values({ tenantId, eventId: event.id, handler: handler.name }).onConflictDoNothing(),
          );
        } catch (error) {
          lastError = error;
          log.warn({ eventId: event.id, type: event.type, handler: handler.name, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'event handler failed');
        }
      }
      const outcome = await withTenant(system(tenantId), async (tx) => {
        if (lastError === null) {
          await tx.db.update(outbox).set({ deliveredAt: sql`now()` }).where(eq(outbox.id, event.id));
          return 'delivered' as const;
        }
        const attempts = row.attempts + 1;
        const failed = attempts >= maxAttempts;
        await tx.db
          .update(outbox)
          .set({
            attempts,
            lastError: errorLabel(lastError),
            ...(failed ? { failedAt: sql`now()` } : { nextAttemptAt: sql`now() + make_interval(secs => ${retryDelaySeconds(attempts)})` }),
          })
          .where(eq(outbox.id, event.id));
        return failed ? ('failed' as const) : ('retrying' as const);
      });
      if (outcome === 'failed') log.error({ eventId: event.id, type: event.type, tenantId, attempts: maxAttempts }, 'event delivery gave up');
      result[outcome] += 1;
    }
  }
  return result;
}

/** The job the worker runs to deliver the outbox. Every few seconds, so events go out moments after commit. */
export function outboxDeliveryJob(handlers: readonly EventHandler[], options: DeliveryOptions = {}): Job {
  assertHandlersValid(handlers);
  return {
    name: 'outbox-delivery',
    everySeconds: 2,
    run: async ({ log }) => {
      await deliverDueEvents(handlers, log, options);
    },
  };
}
