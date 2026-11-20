import { and, count, eq, sql } from 'drizzle-orm';
import { invoices, payments } from '../../db/schema/index.js';
import type { BillingModel, Processor } from '../../db/schema/values.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import type { DeliveredEvent, EventHandler } from '../../lib/outbox-delivery.js';
import { postEntry } from '../ledger/index.js';
import { type ChargeResult, ProcessorRefusedError, chargeableMethod, declinePaymentMethod, paymentProcessor } from '../payments/index.js';
import { type InvoiceRow, type Unpaid, lockInvoice, markInvoicePaid, markInvoicePastDue, markInvoiceRetried, startRetry, voidInvoice } from './invoices.service.js';
import type { ClearanceSource } from './renewals.js';
import { type SubscriptionRow, beginPeriod, cancelSubscription, holdRenewal, lockSubscription, releaseDay, today } from './subscriptions.service.js';

/**
 * Charging a period invoice to the patient's saved card (docs/decisions/
 * billing.md BIL28 to BIL31). The attempt is written before the processor is
 * called and settled after, each in its own transaction, so a redelivered
 * event asks again with the same idempotency key instead of charging twice.
 * Every charge asks first whether the period is still cleared. A paid invoice
 * starts its period; a payment that lands on an invoice that can't stand is
 * refunded in full; an invoice still unpaid after its last retry is voided
 * and its subscription ends.
 */

/** Orders' answer when billing has taken the money for an order (BIL30). Orders provides the real one. */
export interface PaidOrders {
  /** In billing's transaction. `refused` when the order can no longer take it, such as a script that isn't current: an answer, never a throw. */
  markOrderPaid(tx: TenantTx, input: { orderId: string; invoiceId: string }): Promise<'paid' | 'refused'>;
}

/** Until orders is wired in, no order takes a payment, so nothing is dispensed unpaid. Nothing clears an order yet either. */
export const noOrdersYet: PaidOrders = { markOrderPaid: async () => 'refused' };

/** Who a charge asks first and tells after: consults and orders (BIL24, BIL30). */
export interface ChargeDeps {
  clearances: ClearanceSource;
  orders: PaidOrders;
}

/**
 * Why a charge is made (BIL28, BIL31): the first try once an invoice is
 * issued, a scheduled retry of a past-due one, or a past-due one tried at
 * once on the card the patient has just saved.
 */
export type ChargeReason = 'issued' | 'retry' | 'new_card';

/** The processor hasn't decided; the outbox or the retries job asks again later with the same payment. */
export class PaymentPendingError extends Error {
  override name = 'PaymentPendingError';
}

/** A charge whose reply was lost longer ago than the processor keeps its key: asking again could charge twice (BIL31). */
export class PaymentUnknownError extends Error {
  override name = 'PaymentUnknownError';
  constructor() {
    super("A charge's reply was lost too long ago to ask again safely; check it at the processor");
  }
}

interface Attempt {
  paymentId: string;
  invoiceId: string;
  amountCents: number;
  processor: Processor;
  processorAccountId: string;
  processorCustomerId: string;
  processorMethodId: string;
  processorPaymentId: string | null;
  /** How long ago the attempt was written, by the database's clock. */
  ageHours: number;
}

type PaymentRow = typeof payments.$inferSelect;
const TABLE = 'operational.payments';
type Action = 'succeeded' | 'failed' | 'refund_started' | 'refunded';

/** Ids and amounts only (ADR 0008); the processor's failure code stays on the payment. */
async function record(tx: TenantTx, action: Action, payment: PaymentRow, invoice: InvoiceRow): Promise<void> {
  const facts = { patientId: invoice.patientId, subscriptionId: invoice.subscriptionId, invoiceId: invoice.id, attempt: payment.attempt, amountCents: payment.amountCents };
  await audit(tx, { action: `payment.${action}`, zone: 'operational', recordTable: TABLE, recordId: payment.id, details: facts });
  await emitEvent(tx, { type: `payment.${action}`, recordTable: TABLE, recordId: payment.id, payload: facts });
}

/** The payment's subscription, invoice and payment, locked in that order, the same order a void takes (BIL29). */
async function lockPayment(tx: TenantTx, paymentId: string): Promise<{ payment: PaymentRow; invoice: InvoiceRow; subscription: SubscriptionRow }> {
  const [owner] = await tx.db
    .select({ subscriptionId: invoices.subscriptionId, invoiceId: invoices.id })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(eq(payments.id, paymentId));
  if (!owner) throw new Error('No such payment');
  const { row: subscription } = await lockSubscription(tx, owner.subscriptionId);
  const invoice = await lockInvoice(tx, owner.invoiceId);
  const [payment] = await tx.db.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  return { payment: payment!, invoice, subscription };
}

/** Whether the invoice is due this kind of charge now. A retry is due from 10:00 on its day, the patient's time (BIL31). */
function isDue(invoice: InvoiceRow, reason: ChargeReason, subscription: SubscriptionRow): boolean {
  if (reason === 'issued') return invoice.status === 'open';
  if (invoice.status !== 'past_due') return false;
  return reason === 'new_card' || (invoice.retryDueOn !== null && invoice.retryDueOn <= releaseDay(subscription));
}

/**
 * Whether a period invoice may still be charged (ADR 0009, BIL31): its
 * subscription hasn't paused or ended, and the period is still cleared, for
 * the invoice's own order. Otherwise it gives way: held, it is voided and the
 * renewal waits to be cleared again; declined, the subscription ends.
 */
async function stillCleared(tx: TenantTx, subscription: SubscriptionRow, billingModel: BillingModel, invoice: InvoiceRow, clearances: ClearanceSource): Promise<boolean> {
  if (subscription.status !== 'pending' && subscription.status !== 'active') return false;
  const clearance = await clearances.clearanceForPeriod(tx, {
    patientId: subscription.patientId,
    programId: subscription.programId,
    subscriptionId: subscription.id,
    billingModel,
    periodStartsOn: invoice.periodStartsOn!,
    first: subscription.status === 'pending',
  });
  if (clearance.status === 'declined') {
    await cancelSubscription(tx, subscription.id, { when: 'now', reason: 'clinician_declined' });
    return false;
  }
  if (clearance.status === 'cleared' && clearance.orderId === invoice.orderId) return true;
  await voidInvoice(tx, invoice, 'not_cleared');
  if (clearance.status === 'held') await holdRenewal(tx, subscription.id, clearance.reason);
  return false;
}

/**
 * A charge didn't take the money, or there was no card to try (BIL31). The
 * first makes the invoice past due; a later one is reported, and the last
 * scheduled retry failing voids the invoice and ends the subscription now.
 */
async function unpaid(tx: TenantTx, subscription: SubscriptionRow, invoice: InvoiceRow, retry: number | null, reason: Unpaid): Promise<void> {
  if (invoice.status === 'open') return markInvoicePastDue(tx, invoice, reason, today(subscription));
  if (invoice.status !== 'past_due') return;
  await markInvoiceRetried(tx, invoice, { retry, unpaid: reason, retryDueOn: invoice.retryDueOn });
  if (retry === null || invoice.retryDueOn !== null) return;
  await voidInvoice(tx, invoice, 'payment_failed');
  await cancelSubscription(tx, subscription.id, { when: 'now', reason: 'payment_failed' });
}

async function attemptOn(tx: TenantTx, payment: PaymentRow, ageHours: number): Promise<Attempt> {
  const method = await chargeableMethod(tx, { paymentMethodId: payment.paymentMethodId });
  if (!method) throw new Error("A payment's card has no processor account");
  const { id: paymentId, invoiceId, amountCents, processorPaymentId } = payment;
  return { ...method, paymentId, invoiceId, amountCents, processorPaymentId, ageHours };
}

/**
 * The attempt to make, before the processor is asked: the one already in
 * flight (never two at once), or a new one on the patient's default card when
 * the invoice is due this charge and still cleared. With no card that can be
 * charged, nothing is asked and the invoice stays unpaid (BIL28, BIL31).
 */
async function startAttempt(tx: TenantTx, invoiceId: string, reason: ChargeReason, clearances: ClearanceSource): Promise<Attempt | null> {
  const [found] = await tx.db.select({ subscriptionId: invoices.subscriptionId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!found) return null;
  const { row: subscription, billingModel } = await lockSubscription(tx, found.subscriptionId);
  const invoice = await lockInvoice(tx, invoiceId);
  const [inFlight] = await tx.db
    .select({ payment: payments, ageHours: sql<number>`extract(epoch from now() - ${payments.createdAt}) / 3600`.mapWith(Number) })
    .from(payments)
    .where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'pending')));
  if (inFlight) return attemptOn(tx, inFlight.payment, inFlight.ageHours);
  if (invoice.kind !== 'period' || !isDue(invoice, reason, subscription)) return null;
  if (!(await stillCleared(tx, subscription, billingModel, invoice, clearances))) return null;
  const retry = reason === 'retry' ? await startRetry(tx, invoice, today(subscription)) : null;
  const method = await chargeableMethod(tx, { patientId: invoice.patientId, paymentAccountId: invoice.paymentAccountId });
  if (!method) {
    if (reason !== 'new_card') await unpaid(tx, subscription, { ...invoice, retryDueOn: retry ? retry.retryDueOn : invoice.retryDueOn }, retry?.retry ?? null, 'no_payment_method');
    return null;
  }
  const [tried] = await tx.db.select({ n: count() }).from(payments).where(eq(payments.invoiceId, invoiceId));
  const [payment] = await tx.db
    .insert(payments)
    .values({
      tenantId: tx.context.tenantId,
      invoiceId,
      paymentAccountId: invoice.paymentAccountId,
      paymentMethodId: method.paymentMethodId,
      attempt: tried!.n + 1,
      retry: retry?.retry ?? null,
      amountCents: invoice.totalCents,
    })
    .returning();
  return attemptOn(tx, payment!, 0);
}

/** Outside any transaction. A refusal is a failed charge; an unreachable processor is tried again with the same key. */
async function ask(attempt: Attempt, tenantId: string): Promise<ChargeResult> {
  const charges = paymentProcessor(attempt.processor).savedMethodCharges;
  if (!charges) return { status: 'failed', processorPaymentId: null, failureCode: 'saved_cards_not_supported', hardDecline: false };
  const { processorAccountId } = attempt;
  if (attempt.processorPaymentId) return charges.checkCharge({ processorAccountId, processorPaymentId: attempt.processorPaymentId });
  if (attempt.ageHours > charges.keyLifetimeHours) throw new PaymentUnknownError();
  try {
    return await charges.chargeSavedMethod(
      {
        processorAccountId,
        processorCustomerId: attempt.processorCustomerId,
        processorMethodId: attempt.processorMethodId,
        amountCents: attempt.amountCents,
        tenantId,
        invoiceId: attempt.invoiceId,
        paymentId: attempt.paymentId,
      },
      `payment:${attempt.paymentId}`,
    );
  } catch (error) {
    if (error instanceof ProcessorRefusedError) return { status: 'failed', processorPaymentId: null, failureCode: error.processorCode, hardDecline: false };
    throw error;
  }
}

/** The patient paid: the processor's clearing account is owed the money the patient's receivable no longer is (BIL3). */
export async function postPaymentReceived(tx: TenantTx, payment: PaymentRow, invoice: InvoiceRow): Promise<void> {
  await postEntry(tx, {
    kind: 'payment_received',
    idempotencyKey: `payment:${payment.id}:received`,
    lines: [
      { account: { kind: 'processor_clearing', paymentAccountId: invoice.paymentAccountId }, amountCents: payment.amountCents },
      { account: { kind: 'patient_receivable', patientId: invoice.patientId }, amountCents: -payment.amountCents },
    ],
  });
}

async function startRefund(tx: TenantTx, payment: PaymentRow, invoice: InvoiceRow): Promise<void> {
  await tx.db.update(payments).set({ status: 'refunding' }).where(eq(payments.id, payment.id));
  await record(tx, 'refund_started', payment, invoice);
}

/**
 * What the processor said, in one transaction (BIL30, BIL31). Paid: the order
 * is told and the period starts. A refused order, or an invoice voided while
 * the charge was in flight, keeps the payment and refunds it in full. A hard
 * decline marks the card, so it isn't tried again without the patient.
 */
async function settle(tx: TenantTx, paymentId: string, result: ChargeResult, orders: PaidOrders): Promise<void> {
  const { payment, invoice, subscription } = await lockPayment(tx, paymentId);
  if (payment.status !== 'pending') return;
  if (result.status === 'pending') {
    await tx.db.update(payments).set({ processorPaymentId: result.processorPaymentId }).where(eq(payments.id, paymentId));
    return;
  }
  if (result.status !== 'succeeded') {
    const failureCode = result.failureCode ?? result.status;
    await tx.db.update(payments).set({ status: 'failed', processorPaymentId: result.processorPaymentId, failureCode, settledAt: sql`now()` }).where(eq(payments.id, paymentId));
    await record(tx, 'failed', payment, invoice);
    if (result.hardDecline) await declinePaymentMethod(tx, payment.paymentMethodId);
    return unpaid(tx, subscription, invoice, payment.retry, result.hardDecline ? 'card_declined' : 'payment_failed');
  }
  await tx.db.update(payments).set({ status: 'succeeded', processorPaymentId: result.processorPaymentId, settledAt: sql`now()` }).where(eq(payments.id, paymentId));
  await postPaymentReceived(tx, payment, invoice);
  await record(tx, 'succeeded', payment, invoice);
  if (invoice.status === 'void') return startRefund(tx, payment, invoice);
  if (invoice.orderId && (await orders.markOrderPaid(tx, { orderId: invoice.orderId, invoiceId: invoice.id })) === 'refused') {
    await voidInvoice(tx, invoice, 'order_refused');
    await holdRenewal(tx, invoice.subscriptionId, 'no_current_script');
    return startRefund(tx, payment, invoice);
  }
  await markInvoicePaid(tx, invoice);
  if (invoice.kind === 'period') await beginPeriod(tx, invoice.subscriptionId, { startsOn: invoice.periodStartsOn!, endsOn: invoice.periodEndsOn! });
}

/**
 * Charge an invoice to the patient's default card, or finish an attempt
 * still in flight. Safe to run again at any point (ADR 0029).
 */
export async function chargeInvoice(context: TenantContext, invoiceId: string, reason: ChargeReason, deps: ChargeDeps): Promise<void> {
  const attempt = await withTenant(context, (tx) => startAttempt(tx, invoiceId, reason, deps.clearances));
  if (!attempt) return;
  const result = await ask(attempt, context.tenantId);
  await withTenant(context, (tx) => settle(tx, attempt.paymentId, result, deps.orders));
  if (result.status === 'pending') throw new PaymentPendingError();
}

/**
 * The patient saved a card, which is now their default and usable (BIL31):
 * each of their past-due period invoices at that payment account is tried on
 * it at once, outside the retry schedule.
 */
async function chargeNewCard(context: TenantContext, saved: { patientId: string; paymentAccountId: string }, deps: ChargeDeps): Promise<void> {
  const due = await withTenant(context, (tx) =>
    tx.db
      .select({ id: invoices.id })
      .from(invoices)
      .where(
        and(
          eq(invoices.patientId, saved.patientId),
          eq(invoices.paymentAccountId, saved.paymentAccountId),
          eq(invoices.kind, 'period'),
          eq(invoices.status, 'past_due'),
        ),
      ),
  );
  for (const { id } of due) await chargeInvoice(context, id, 'new_card', deps);
}

/** Give a payment back in full, once the processor accepts (BIL30). A refusal is tried again, then reported. */
export async function refundPayment(context: TenantContext, paymentId: string): Promise<void> {
  const due = await withTenant(context, async (tx) => {
    const [payment] = await tx.db.select().from(payments).where(eq(payments.id, paymentId));
    if (payment?.status !== 'refunding') return null;
    const method = await chargeableMethod(tx, { paymentMethodId: payment.paymentMethodId });
    return method ? { payment, method } : null;
  });
  if (!due) return;
  const refunds = paymentProcessor(due.method.processor).refunds;
  if (!refunds) throw new Error(`${due.method.processor} can't refund yet`);
  const refund = await refunds.refundCharge(
    {
      processorAccountId: due.method.processorAccountId,
      processorPaymentId: due.payment.processorPaymentId!,
      amountCents: due.payment.amountCents,
      tenantId: context.tenantId,
      paymentId,
    },
    `refund:${paymentId}`,
  );
  await withTenant(context, async (tx) => {
    const { payment, invoice } = await lockPayment(tx, paymentId);
    if (payment.status !== 'refunding') return;
    await tx.db.update(payments).set({ status: 'refunded', processorRefundId: refund.processorRefundId, refundedAt: sql`now()` }).where(eq(payments.id, paymentId));
    await postEntry(tx, {
      kind: 'refund_paid',
      idempotencyKey: `payment:${paymentId}:refunded`,
      lines: [
        { account: { kind: 'patient_receivable', patientId: invoice.patientId }, amountCents: payment.amountCents },
        { account: { kind: 'processor_clearing', paymentAccountId: invoice.paymentAccountId }, amountCents: -payment.amountCents },
      ],
    });
    await record(tx, 'refunded', payment, invoice);
  });
}

const asSystem = (event: DeliveredEvent): TenantContext => ({ tenantId: event.tenantId, actor: { type: 'system' }, requestId: `event:${event.id}` });

/** A period invoice is charged as soon as it is issued, and again on a new card; a refund goes out once started (BIL28, BIL30, BIL31). */
export function chargingHandlers(deps: ChargeDeps): EventHandler[] {
  return [
    {
      name: 'billing-charge-period-invoice',
      eventTypes: ['invoice.issued'],
      handle: async (event) => {
        if (event.payload.kind === 'period') await chargeInvoice(asSystem(event), event.recordId, 'issued', deps);
      },
    },
    {
      name: 'billing-charge-new-card',
      eventTypes: ['payment_method.saved'],
      handle: (event) => chargeNewCard(asSystem(event), { patientId: String(event.payload.patientId), paymentAccountId: String(event.payload.paymentAccountId) }, deps),
    },
    { name: 'billing-refund-payment', eventTypes: ['payment.refund_started'], handle: (event) => refundPayment(asSystem(event), event.recordId) },
  ];
}
