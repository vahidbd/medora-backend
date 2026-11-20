import { and, desc, eq, sql } from 'drizzle-orm';
import { paymentAccounts, prices, subscriptions } from '../../db/schema/index.js';
import type { CancelReason, IntervalUnit, SubscriptionStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { isTimeZone, localDate } from '../../lib/time.js';
import { type Interval, addDays, dayOfMonth, latestDeferredStart, nextStart } from './periods.js';

/**
 * Subscriptions (docs/decisions/billing.md BIL18 to BIL22). Every change
 * locks the subscription first. Dates are calendar dates in the
 * subscription's time zone. Invoices for each billing period, and voiding a
 * held one on pause or cancel, arrive with invoices.
 */

export interface Subscription {
  subscriptionId: string;
  patientId: string;
  programId: string;
  priceId: string;
  paymentAccountId: string;
  timeZone: string;
  status: SubscriptionStatus;
  interval: Interval;
  currentPeriod: { startsOn: string; endsOn: string } | null;
  nextPeriodStartsOn: string | null;
  cancelsAtPeriodEnd: boolean;
  cancelReason: CancelReason | null;
  endedOn: string | null;
  createdAt: string;
}

const TABLE = 'operational.subscriptions';
type Row = typeof subscriptions.$inferSelect;
type Action = 'started' | 'activated' | 'paused' | 'resumed' | 'skipped' | 'cancellation_scheduled' | 'reinstated' | 'cancelled';

const columns = {
  row: subscriptions,
  intervalUnit: prices.intervalUnit,
  intervalCount: prices.intervalCount,
};

function view({ row, intervalUnit, intervalCount }: { row: Row; intervalUnit: string; intervalCount: number }): Subscription {
  return {
    subscriptionId: row.id,
    patientId: row.patientId,
    programId: row.programId,
    priceId: row.priceId,
    paymentAccountId: row.paymentAccountId,
    timeZone: row.timeZone,
    status: row.status as SubscriptionStatus,
    interval: { unit: intervalUnit as IntervalUnit, count: intervalCount },
    currentPeriod: row.currentPeriodStartsOn && row.currentPeriodEndsOn ? { startsOn: row.currentPeriodStartsOn, endsOn: row.currentPeriodEndsOn } : null,
    nextPeriodStartsOn: row.nextPeriodStartsOn,
    cancelsAtPeriodEnd: row.cancelsAtPeriodEnd,
    cancelReason: row.cancelReason as CancelReason | null,
    endedOn: row.endedOn,
    createdAt: row.createdAt.toISOString(),
  };
}

async function record(tx: TenantTx, action: Action, row: Pick<Row, 'id' | 'programId'>, details: Record<string, string | null> = {}) {
  const facts = { programId: row.programId, ...details };
  await audit(tx, { action: `subscription.${action}`, zone: 'operational', recordTable: TABLE, recordId: row.id, details: facts });
  await emitEvent(tx, { type: `subscription.${action}`, recordTable: TABLE, recordId: row.id, payload: facts });
}

const select = (tx: TenantTx) => tx.db.select(columns).from(subscriptions).innerJoin(prices, eq(prices.id, subscriptions.priceId));

export async function listSubscriptions(tx: TenantTx, filter: { patientId?: string | undefined; status?: SubscriptionStatus | undefined }): Promise<Subscription[]> {
  const rows = await select(tx)
    .where(and(filter.patientId ? eq(subscriptions.patientId, filter.patientId) : undefined, filter.status ? eq(subscriptions.status, filter.status) : undefined))
    .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
    .limit(200);
  return rows.map(view);
}

export async function getSubscription(tx: TenantTx, id: string): Promise<Subscription> {
  const [found] = await select(tx).where(eq(subscriptions.id, id));
  if (!found) throw new NotFoundError('Subscription');
  return view(found);
}

async function lock(tx: TenantTx, id: string): Promise<{ row: Row; interval: Interval }> {
  const [row] = await tx.db.select().from(subscriptions).where(eq(subscriptions.id, id)).for('update');
  if (!row) throw new NotFoundError('Subscription');
  const [price] = await tx.db.select({ unit: prices.intervalUnit, count: prices.intervalCount }).from(prices).where(eq(prices.id, row.priceId));
  return { row, interval: { unit: price!.unit as IntervalUnit, count: price!.count } };
}

type Changes = { [K in keyof typeof subscriptions.$inferInsert]?: (typeof subscriptions.$inferInsert)[K] | ReturnType<typeof sql> };

async function update(tx: TenantTx, id: string, values: Changes): Promise<void> {
  await tx.db.update(subscriptions).set({ ...values, updatedAt: sql`now()` }).where(eq(subscriptions.id, id));
}

const today = (row: Pick<Row, 'timeZone'>) => localDate(new Date(), row.timeZone);
/** Calendar dates in YYYY-MM-DD compare as strings. */
const later = (a: string, b: string) => (a > b ? a : b);

/**
 * A patient's subscription to a live price, at checkout (BIL18). It waits as
 * `pending` until its first billing period is released. Its payment account
 * is the price's, or else the tenant's default, and must be active.
 */
export async function startSubscription(tx: TenantTx, input: { patientId: string; priceId: string; timeZone: string }): Promise<Subscription> {
  if (!isTimeZone(input.timeZone)) throw new BadRequestError('Unknown time zone', 'invalid_time_zone');
  const [price] = await tx.db.select().from(prices).where(eq(prices.id, input.priceId));
  if (!price) throw new NotFoundError('Price');
  if (price.status !== 'live') throw new BusinessRuleError('That price is not offered to new patients', 'price_not_live');
  const [account] = await tx.db
    .select({ id: paymentAccounts.id, status: paymentAccounts.status })
    .from(paymentAccounts)
    .where(price.paymentAccountId ? eq(paymentAccounts.id, price.paymentAccountId) : eq(paymentAccounts.isDefault, true));
  if (account?.status !== 'active') throw new BusinessRuleError('There is no active payment account for this price', 'no_payment_account');
  // The database keeps one live subscription per program (subscriptions_live_key), even for two checkouts at once.
  const [row] = await tx.db
    .insert(subscriptions)
    .values({
      tenantId: tx.context.tenantId,
      patientId: input.patientId,
      programId: price.programId,
      priceId: price.id,
      paymentAccountId: account.id,
      timeZone: input.timeZone,
    })
    .onConflictDoNothing({ target: [subscriptions.tenantId, subscriptions.patientId, subscriptions.programId], where: sql`${subscriptions.status} <> 'cancelled'` })
    .returning();
  if (!row) throw new BusinessRuleError('The patient already has a subscription to this program', 'already_subscribed');
  await record(tx, 'started', row, { priceId: price.id });
  return getSubscription(tx, row.id);
}

/**
 * The first billing period starts on the day it is released, not at checkout
 * (BIL19). Called by invoices when the first period's invoice is released.
 */
export async function activateSubscription(tx: TenantTx, id: string, startsOn: string): Promise<Subscription> {
  const { row, interval } = await lock(tx, id);
  if (row.status !== 'pending') throw new BusinessRuleError('This subscription has already started', 'subscription_not_pending');
  const anchorDay = dayOfMonth(startsOn);
  const endsOn = nextStart(startsOn, interval, anchorDay);
  await update(tx, id, {
    status: 'active',
    anchorDay,
    currentPeriodStartsOn: startsOn,
    currentPeriodEndsOn: endsOn,
    nextPeriodStartsOn: endsOn,
    activatedAt: sql`now()`,
  });
  await record(tx, 'activated', row, { startsOn, endsOn });
  return getSubscription(tx, id);
}

function assertBetweenPeriods(row: Row): asserts row is Row & { currentPeriodEndsOn: string; nextPeriodStartsOn: string } {
  if (row.status !== 'active' && row.status !== 'paused') {
    throw new BusinessRuleError('Only a subscription that has started and not ended can do that', 'subscription_not_running');
  }
}

/**
 * No invoice until `resumesOn` (BIL20): after today, no earlier than the
 * current period's end, and at most three months after it.
 */
export async function pauseSubscription(tx: TenantTx, id: string, resumesOn: string): Promise<Subscription> {
  const { row } = await lock(tx, id);
  assertBetweenPeriods(row);
  const earliest = later(row.currentPeriodEndsOn, addDays(today(row), 1));
  const last = latestDeferredStart(row.currentPeriodEndsOn);
  if (resumesOn < earliest || resumesOn > last) {
    throw new BusinessRuleError(`Resume between ${earliest} and ${last}`, 'resume_date_out_of_range');
  }
  await update(tx, id, { status: 'paused', nextPeriodStartsOn: resumesOn });
  await record(tx, 'paused', row, { resumesOn });
  return getSubscription(tx, id);
}

/**
 * Back on (BIL20): the next period starts when the current one ends. If that
 * has passed, it is due now, and starts on the day it is released (BIL19).
 */
export async function resumeSubscription(tx: TenantTx, id: string): Promise<Subscription> {
  const { row } = await lock(tx, id);
  if (row.status !== 'paused') throw new BusinessRuleError('This subscription is not paused', 'subscription_not_paused');
  assertBetweenPeriods(row);
  await update(tx, id, { status: 'active', nextPeriodStartsOn: row.currentPeriodEndsOn });
  await record(tx, 'resumed', row, { nextPeriodStartsOn: row.currentPeriodEndsOn });
  return getSubscription(tx, id);
}

/**
 * The next billing period moves one interval later, on the anchor day, within
 * the three months (BIL20). A paused subscription moves its resume date instead.
 */
export async function skipNextPeriod(tx: TenantTx, id: string): Promise<Subscription> {
  const { row, interval } = await lock(tx, id);
  assertBetweenPeriods(row);
  if (row.status === 'paused') throw new BusinessRuleError('This subscription is paused. Change its resume date instead', 'subscription_paused');
  const startsOn = nextStart(row.nextPeriodStartsOn, interval, row.anchorDay ?? dayOfMonth(row.nextPeriodStartsOn));
  if (startsOn > latestDeferredStart(row.currentPeriodEndsOn)) {
    throw new BusinessRuleError('Pauses and skips can put off the next period by three months at most', 'deferral_limit');
  }
  await update(tx, id, { nextPeriodStartsOn: startsOn });
  await record(tx, 'skipped', row, { nextPeriodStartsOn: startsOn });
  return getSubscription(tx, id);
}

/**
 * Cancel (BIL21). At the period's end: the patient keeps what they paid for
 * and can reinstate until then. Now: it ends today and refunds nothing by
 * itself. With no paid days left (still pending, or the current period has
 * already ended) it ends now either way.
 */
export async function cancelSubscription(tx: TenantTx, id: string, input: { when: 'period_end' | 'now'; reason: CancelReason }): Promise<Subscription> {
  const { row } = await lock(tx, id);
  if (row.status === 'cancelled') throw new BusinessRuleError('This subscription has already ended', 'subscription_ended');
  const endedOn = today(row);
  if (input.when === 'period_end' && row.status !== 'pending') {
    assertBetweenPeriods(row);
    if (row.currentPeriodEndsOn > endedOn) {
      if (row.cancelsAtPeriodEnd) return getSubscription(tx, id);
      await update(tx, id, { cancelsAtPeriodEnd: true, cancelReason: input.reason });
      await record(tx, 'cancellation_scheduled', row, { endsOn: row.currentPeriodEndsOn, reason: input.reason });
      return getSubscription(tx, id);
    }
  }
  await update(tx, id, { status: 'cancelled', cancelReason: input.reason, endedOn, cancelledAt: sql`now()`, cancelsAtPeriodEnd: false });
  await record(tx, 'cancelled', row, { reason: input.reason, endedOn });
  return getSubscription(tx, id);
}

/** Undo a cancellation that hasn't happened yet (BIL21). */
export async function reinstateSubscription(tx: TenantTx, id: string): Promise<Subscription> {
  const { row } = await lock(tx, id);
  if (!row.cancelsAtPeriodEnd || row.status === 'cancelled') {
    throw new BusinessRuleError('Only a subscription due to end at its period end can be reinstated. Start a new one instead', 'nothing_to_reinstate');
  }
  await update(tx, id, { cancelsAtPeriodEnd: false, cancelReason: null });
  await record(tx, 'reinstated', row);
  return getSubscription(tx, id);
}
