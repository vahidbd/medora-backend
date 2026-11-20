import { and, eq, sql } from 'drizzle-orm';
import { prices, subscriptions } from '../../db/schema/index.js';
import type { BillingModel, HeldReason } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { forEachTenant, type Job } from '../../lib/jobs.js';
import { safeErrorMessage } from '../../lib/redact.js';
import { feesOf, issueInvoice, unpaidPeriodInvoice } from './invoices.service.js';
import { cancelSubscription, clearRenewalHold, endAtPeriodEnd, holdRenewal, lockSubscription, periodStartingOn, today } from './subscriptions.service.js';

/**
 * Releasing billing periods (docs/decisions/billing.md BIL24). A period's
 * invoice is issued only once the period is cleared: the clinician accepted
 * and, when medicine is charged, an order holds a current script that the
 * pharmacist has checked (ADR 0009). Billing asks; consults and orders answer.
 */

export type Clearance =
  | {
      status: 'cleared';
      /** The order behind a period with medicine; null when none is charged (pharmacy-billed). */
      orderId: string | null;
      medicineProductId: string | null;
      partnerPharmacyId: string | null;
    }
  | { status: 'held'; reason: Exclude<HeldReason, 'no_medicine_fee'> }
  /** The clinician declined the patient for the program, or stopped the treatment. */
  | { status: 'declined' };

export interface ClearanceRequest {
  patientId: string;
  programId: string;
  subscriptionId: string;
  billingModel: BillingModel;
  /** The period's first day, in the patient's time zone. */
  periodStartsOn: string;
  /** The first period also needs the clinician's acceptance. */
  first: boolean;
}

/** Who says a period may be charged. Consults and orders provide the real one. */
export interface ClearanceSource {
  clearanceForPeriod(tx: TenantTx, request: ClearanceRequest): Promise<Clearance>;
}

/** Until consults and orders are wired in, nothing is cleared, so nothing is charged by accident. */
export const nothingClearsYet: ClearanceSource = { clearanceForPeriod: async () => ({ status: 'held', reason: 'other' }) };

type Outcome = 'issued' | 'held' | 'ended' | 'not_due' | 'awaiting_payment';

/**
 * Issue a due period's invoice, or record why it waits (BIL24). The period
 * starts once the invoice is paid, and nothing more is issued until then
 * (BIL29). A clinician's decline ends the subscription instead, charging nothing.
 */
export async function releaseDuePeriod(tx: TenantTx, subscriptionId: string, source: ClearanceSource): Promise<Outcome> {
  const { row, interval } = await lockSubscription(tx, subscriptionId);
  const startsOn = today(row);
  const first = row.status === 'pending';
  const due = first || ((row.status === 'active' || row.status === 'paused') && !row.cancelsAtPeriodEnd && row.nextPeriodStartsOn! <= startsOn);
  if (!due) return 'not_due';
  if (await unpaidPeriodInvoice(tx, subscriptionId)) return 'awaiting_payment';
  const [price] = await tx.db.select({ billingModel: prices.billingModel }).from(prices).where(eq(prices.id, row.priceId));
  const billingModel = price!.billingModel as BillingModel;
  const clearance = await source.clearanceForPeriod(tx, { patientId: row.patientId, programId: row.programId, subscriptionId, billingModel, periodStartsOn: startsOn, first });
  if (clearance.status === 'declined') {
    await cancelSubscription(tx, subscriptionId, { when: 'now', reason: 'clinician_declined' });
    return 'ended';
  }
  if (clearance.status === 'held') {
    await holdRenewal(tx, subscriptionId, clearance.reason);
    return 'held';
  }
  const fees = (await feesOf(tx, row.priceId)).filter((fee) => fee.feeKind === 'program' || fee.feeKind === 'shipping');
  let order: { orderId: string; partnerPharmacyId: string } | undefined;
  if (billingModel === 'bundled') {
    const medicine = (await feesOf(tx, row.priceId)).find((fee) => fee.feeKind === 'medicine' && fee.productId === clearance.medicineProductId);
    if (!medicine) {
      await holdRenewal(tx, subscriptionId, 'no_medicine_fee');
      return 'held';
    }
    if (!clearance.orderId || !clearance.partnerPharmacyId) {
      await holdRenewal(tx, subscriptionId, 'no_order');
      return 'held';
    }
    fees.push(medicine);
    order = { orderId: clearance.orderId, partnerPharmacyId: clearance.partnerPharmacyId };
  }
  const { endsOn } = periodStartingOn(row, interval, startsOn);
  await issueInvoice(tx, { kind: 'period', subscription: row, fees, period: { startsOn, endsOn }, ...(order ? { order } : {}) });
  await clearRenewalHold(tx, subscriptionId);
  return 'issued';
}

/** Renewals happen at 10:00 in the patient's time zone on the period's first day (BIL24); `now` is the job's clock. */
const releaseDate = (now: Date) => sql`(${now.toISOString()}::timestamptz at time zone ${subscriptions.timeZone} - interval '10 hours')::date`;
const localToday = (now: Date) => sql`(${now.toISOString()}::timestamptz at time zone ${subscriptions.timeZone})::date`;

/**
 * Every 15 minutes, per tenant: end scheduled cancellations whose period is
 * over, then try every due period. Each subscription is its own savepoint, so
 * one that fails is logged and the rest carry on (JOB5).
 */
export function renewalsJob(source: ClearanceSource): Job {
  return {
    name: 'billing-renewals',
    everySeconds: 15 * 60,
    run: async (context) => {
      let failed = 0;
      await forEachTenant(context, async (tx) => {
        const now = new Date();
        const each = async (ids: { id: string }[], work: (inner: TenantTx, id: string) => Promise<unknown>) => {
          for (const { id } of ids) {
            try {
              await tx.db.transaction((db) => work({ db, context: tx.context }, id));
            } catch (error) {
              failed += 1;
              context.log.error({ job: context.name, tenantId: tx.context.tenantId, subscriptionId: id, error: error instanceof Error ? safeErrorMessage(error) : 'unknown' }, 'renewal failed');
            }
          }
        };
        const ending = await tx.db
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(and(eq(subscriptions.cancelsAtPeriodEnd, true), sql`${subscriptions.currentPeriodEndsOn} <= ${localToday(now)}`));
        await each(ending, endAtPeriodEnd);
        const due = await tx.db
          .select({ id: subscriptions.id })
          .from(subscriptions)
          .where(
            sql`${subscriptions.status} = 'pending'
              or (${subscriptions.status} in ('active', 'paused') and not ${subscriptions.cancelsAtPeriodEnd} and ${subscriptions.nextPeriodStartsOn} <= ${releaseDate(now)})`,
          );
        await each(due, (inner, id) => releaseDuePeriod(inner, id, source));
      });
      if (failed > 0) throw new Error(`${failed} renewals failed`);
    },
  };
}

export interface UpcomingRenewal {
  subscriptionId: string;
  patientId: string;
  programId: string;
  priceId: string;
  billingModel: BillingModel;
  periodStartsOn: string;
}

/** Subscriptions that will renew within the window, for orders to place renewal orders ahead (BIL26). */
export async function upcomingRenewals(tx: TenantTx, options: { withinDays: number }): Promise<UpcomingRenewal[]> {
  const now = new Date();
  const rows = await tx.db
    .select({
      subscriptionId: subscriptions.id,
      patientId: subscriptions.patientId,
      programId: subscriptions.programId,
      priceId: subscriptions.priceId,
      billingModel: prices.billingModel,
      periodStartsOn: subscriptions.nextPeriodStartsOn,
    })
    .from(subscriptions)
    .innerJoin(prices, eq(prices.id, subscriptions.priceId))
    .where(
      and(
        eq(subscriptions.status, 'active'),
        eq(subscriptions.cancelsAtPeriodEnd, false),
        sql`${subscriptions.nextPeriodStartsOn} <= ${localToday(now)} + ${options.withinDays}::int`,
      ),
    )
    .orderBy(subscriptions.nextPeriodStartsOn, subscriptions.id);
  return rows.map((row) => ({ ...row, billingModel: row.billingModel as BillingModel, periodStartsOn: row.periodStartsOn! }));
}
