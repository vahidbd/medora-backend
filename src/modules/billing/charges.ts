import { and, count, eq, sql } from 'drizzle-orm';
import { invoices, payments } from '../../db/schema/index.js';
import type { Processor } from '../../db/schema/values.js';
import { type TenantContext, type TenantTx, withTenant } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';
import type { DeliveredEvent, EventHandler } from '../../lib/outbox-delivery.js';
import { postEntry } from '../ledger/index.js';
import { type ChargeResult, ProcessorRefusedError, chargeableMethod, paymentProcessor } from '../payments/index.js';
import { type InvoiceRow, lockInvoice, markInvoicePaid, markInvoicePastDue, voidInvoice } from './invoices.service.js';
import { beginPeriod, holdRenewal, lockSubscription } from './subscriptions.service.js';

/**
 * Charging a period invoice to the patient's saved card (docs/decisions/
 * billing.md BIL28 to BIL30). The attempt is written before the processor is
 * called and settled after, each in its own transaction, so a redelivered
 * event asks again with the same idempotency key instead of charging twice.
 * A paid invoice starts its period; a payment that lands on an invoice that
 * can't stand is refunded in full.
 */

/** Orders' answer when billing has taken the money for an order (BIL30). Orders provides the real one. */
export interface PaidOrders {
  /** In billing's transaction. `refused` when the order can no longer take it, such as a script that isn't current: an answer, never a throw. */
  markOrderPaid(tx: TenantTx, input: { orderId: string; invoiceId: string }): Promise<'paid' | 'refused'>;
}

/** Until orders is wired in, no order takes a payment, so nothing is dispensed unpaid. Nothing clears an order yet either. */
export const noOrdersYet: PaidOrders = { markOrderPaid: async () => 'refused' };

/** The processor hasn't decided; the outbox asks again later with the same payment. */
export class PaymentPendingError extends Error {
  override name = 'PaymentPendingError';
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
async function lockPayment(tx: TenantTx, paymentId: string): Promise<{ payment: PaymentRow; invoice: InvoiceRow }> {
  const [owner] = await tx.db
    .select({ subscriptionId: invoices.subscriptionId, invoiceId: invoices.id })
    .from(payments)
    .innerJoin(invoices, eq(invoices.id, payments.invoiceId))
    .where(eq(payments.id, paymentId));
  if (!owner) throw new Error('No such payment');
  await lockSubscription(tx, owner.subscriptionId);
  const invoice = await lockInvoice(tx, owner.invoiceId);
  const [payment] = await tx.db.select().from(payments).where(eq(payments.id, paymentId)).for('update');
  return { payment: payment!, invoice };
}

/**
 * The attempt to make: one still in flight, or a new one on the patient's
 * default card while the invoice is open. No card makes the invoice past due
 * without asking the processor (BIL28).
 */
async function startAttempt(tx: TenantTx, invoiceId: string): Promise<Attempt | null> {
  const [found] = await tx.db.select({ subscriptionId: invoices.subscriptionId }).from(invoices).where(eq(invoices.id, invoiceId));
  if (!found) return null;
  await lockSubscription(tx, found.subscriptionId);
  const invoice = await lockInvoice(tx, invoiceId);
  let [payment] = await tx.db.select().from(payments).where(and(eq(payments.invoiceId, invoiceId), eq(payments.status, 'pending')));
  if (!payment) {
    if (invoice.status !== 'open') return null;
    const method = await chargeableMethod(tx, { patientId: invoice.patientId, paymentAccountId: invoice.paymentAccountId });
    if (!method) {
      await markInvoicePastDue(tx, invoice, 'no_payment_method');
      return null;
    }
    const [tried] = await tx.db.select({ n: count() }).from(payments).where(eq(payments.invoiceId, invoiceId));
    [payment] = await tx.db
      .insert(payments)
      .values({
        tenantId: tx.context.tenantId,
        invoiceId,
        paymentAccountId: invoice.paymentAccountId,
        paymentMethodId: method.paymentMethodId,
        attempt: tried!.n + 1,
        amountCents: invoice.totalCents,
      })
      .returning();
  }
  const method = await chargeableMethod(tx, { paymentMethodId: payment!.paymentMethodId });
  if (!method) throw new Error("A payment's card has no processor account");
  return { ...method, paymentId: payment!.id, invoiceId, amountCents: payment!.amountCents, processorPaymentId: payment!.processorPaymentId };
}

/** Outside any transaction. A refusal is a failed charge; an unreachable processor is tried again with the same key. */
async function ask(attempt: Attempt, tenantId: string): Promise<ChargeResult> {
  const charges = paymentProcessor(attempt.processor).savedMethodCharges;
  if (!charges) return { status: 'failed', processorPaymentId: null, failureCode: 'saved_cards_not_supported' };
  const { processorAccountId } = attempt;
  if (attempt.processorPaymentId) return charges.checkCharge({ processorAccountId, processorPaymentId: attempt.processorPaymentId });
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
    if (error instanceof ProcessorRefusedError) return { status: 'failed', processorPaymentId: null, failureCode: error.processorCode };
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
 * What the processor said, in one transaction (BIL30). Paid: the order is
 * told and the period starts. A refused order, or an invoice voided while
 * the charge was in flight, keeps the payment and refunds it in full.
 */
async function settle(tx: TenantTx, paymentId: string, result: ChargeResult, orders: PaidOrders): Promise<void> {
  const { payment, invoice } = await lockPayment(tx, paymentId);
  if (payment.status !== 'pending') return;
  if (result.status === 'pending') {
    await tx.db.update(payments).set({ processorPaymentId: result.processorPaymentId }).where(eq(payments.id, paymentId));
    return;
  }
  if (result.status !== 'succeeded') {
    const failureCode = result.failureCode ?? result.status;
    await tx.db.update(payments).set({ status: 'failed', processorPaymentId: result.processorPaymentId, failureCode, settledAt: sql`now()` }).where(eq(payments.id, paymentId));
    await record(tx, 'failed', payment, invoice);
    await markInvoicePastDue(tx, invoice, 'payment_failed');
    return;
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
export async function chargeInvoice(context: TenantContext, invoiceId: string, orders: PaidOrders): Promise<void> {
  const attempt = await withTenant(context, (tx) => startAttempt(tx, invoiceId));
  if (!attempt) return;
  const result = await ask(attempt, context.tenantId);
  await withTenant(context, (tx) => settle(tx, attempt.paymentId, result, orders));
  if (result.status === 'pending') throw new PaymentPendingError();
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

/** A period invoice is charged as soon as it is issued; a refund goes out once started (BIL28, BIL30). */
export function chargingHandlers(orders: PaidOrders): EventHandler[] {
  return [
    {
      name: 'billing-charge-period-invoice',
      eventTypes: ['invoice.issued'],
      handle: async (event) => {
        if (event.payload.kind === 'period') await chargeInvoice(asSystem(event), event.recordId, orders);
      },
    },
    { name: 'billing-refund-payment', eventTypes: ['payment.refund_started'], handle: (event) => refundPayment(asSystem(event), event.recordId) },
  ];
}
