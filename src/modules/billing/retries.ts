import { and, eq, exists, or, sql } from 'drizzle-orm';
import { invoices, payments, subscriptions } from '../../db/schema/index.js';
import { forEachTenant, type Job } from '../../lib/jobs.js';
import { safeErrorMessage } from '../../lib/redact.js';
import { type ChargeDeps, PaymentPendingError, chargeInvoice } from './charges.js';
import { releaseDate } from './renewals.js';

/**
 * Retrying past-due invoices (docs/decisions/billing.md BIL31). Every 15
 * minutes, per tenant: each past-due invoice whose retry day has reached
 * 10:00 the patient's time is tried again, and any charge still in flight is
 * asked about again. The charges happen outside the tenant's transaction, one
 * invoice at a time, so one that fails is logged and the rest carry on (JOB5).
 */
export function retriesJob(deps: ChargeDeps): Job {
  return {
    name: 'billing-retries',
    everySeconds: 15 * 60,
    run: async (context) => {
      const now = new Date();
      const due: { tenantId: string; invoiceId: string }[] = [];
      await forEachTenant(context, async (tx) => {
        const inFlight = tx.db
          .select({ id: payments.id })
          .from(payments)
          .where(and(eq(payments.invoiceId, invoices.id), eq(payments.status, 'pending')));
        const rows = await tx.db
          .select({ id: invoices.id })
          .from(invoices)
          .innerJoin(subscriptions, eq(subscriptions.id, invoices.subscriptionId))
          .where(or(and(eq(invoices.status, 'past_due'), sql`${invoices.retryDueOn} <= ${releaseDate(now)}`), exists(inFlight)))
          .orderBy(invoices.retryDueOn, invoices.id);
        due.push(...rows.map((row) => ({ tenantId: tx.context.tenantId, invoiceId: row.id })));
      });
      let failed = 0;
      for (const { tenantId, invoiceId } of due) {
        try {
          await chargeInvoice({ tenantId, actor: { type: 'system' }, requestId: `job:${context.name}` }, invoiceId, 'retry', deps);
        } catch (error) {
          // Still with the processor: asked again on the next run.
          if (error instanceof PaymentPendingError) continue;
          failed += 1;
          context.log.error({ job: context.name, tenantId, invoiceId, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'retry failed');
        }
      }
      if (failed > 0) throw new Error(`${failed} retries failed`);
    },
  };
}
