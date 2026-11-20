import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { invoiceLines, invoiceNumbers, invoices, paymentAccounts, payments, priceFees } from '../../db/schema/index.js';
import type { FeeKind, GstTreatment, InvoiceKind, InvoiceStatus, PaymentStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { gstIncluded, sumCents } from '../../lib/money.js';
import { type LineInput, entryIdForKey, postEntry, reverseEntry } from '../ledger/index.js';
import { methodLabels } from '../payments/index.js';
import { addDays } from './periods.js';

/**
 * Issuing invoices (docs/decisions/billing.md BIL23 to BIL27). An invoice is
 * written once, when it is issued: its number, its lines copied from the
 * price's fees, and its ledger entry, all in the caller's transaction. Then
 * only its status moves, as payments and voids decide (BIL28, BIL29).
 */

export interface InvoiceLine {
  feeKind: FeeKind;
  productId: string | null;
  amountCents: number;
  pharmacyShareCents: number | null;
  gstTreatment: GstTreatment;
  gstCents: number;
}

/** One attempt to take the invoice's total (BIL28). The failure code is the processor's, for staff. */
export interface InvoicePayment {
  paymentId: string;
  attempt: number;
  /** Which scheduled retry it was (BIL31); null for the first try and a new card's. */
  retry: number | null;
  status: PaymentStatus;
  amountCents: number;
  card: { brand: string; last4: string } | null;
  failureCode: string | null;
  createdAt: string;
  settledAt: string | null;
  refundedAt: string | null;
}

export interface Invoice {
  invoiceId: string;
  number: string;
  kind: InvoiceKind;
  patientId: string;
  subscriptionId: string;
  priceId: string;
  paymentAccountId: string;
  companyId: string;
  period: { startsOn: string; endsOn: string } | null;
  orderId: string | null;
  status: InvoiceStatus;
  totalCents: number;
  gstCents: number;
  issuedAt: string;
  paidAt: string | null;
  voidedAt: string | null;
  /** The patient's date it went past due, and of its next retry (BIL31). */
  pastDueOn: string | null;
  retryDueOn: string | null;
  lines: InvoiceLine[];
  payments: InvoicePayment[];
}

const TABLE = 'operational.invoices';
const FEE_ORDER: Record<FeeKind, number> = { consult: 0, program: 1, medicine: 2, shipping: 3 };
type FeeRow = typeof priceFees.$inferSelect;
type Row = typeof invoices.$inferSelect;
type LineRow = typeof invoiceLines.$inferSelect;
type PaymentRow = typeof payments.$inferSelect;

export async function feesOf(tx: TenantTx, priceId: string): Promise<FeeRow[]> {
  return tx.db.select().from(priceFees).where(eq(priceFees.priceId, priceId));
}

function view(row: Row, lines: LineRow[], attempts: PaymentRow[], cards: Map<string, { brand: string; last4: string }>): Invoice {
  return {
    invoiceId: row.id,
    number: row.number,
    kind: row.kind as InvoiceKind,
    patientId: row.patientId,
    subscriptionId: row.subscriptionId,
    priceId: row.priceId,
    paymentAccountId: row.paymentAccountId,
    companyId: row.companyId,
    period: row.periodStartsOn && row.periodEndsOn ? { startsOn: row.periodStartsOn, endsOn: row.periodEndsOn } : null,
    orderId: row.orderId,
    status: row.status as InvoiceStatus,
    totalCents: row.totalCents,
    gstCents: row.gstCents,
    issuedAt: row.issuedAt.toISOString(),
    paidAt: row.paidAt?.toISOString() ?? null,
    voidedAt: row.voidedAt?.toISOString() ?? null,
    pastDueOn: row.pastDueOn,
    retryDueOn: row.retryDueOn,
    lines: lines
      .map((line) => ({
        feeKind: line.feeKind as FeeKind,
        productId: line.productId,
        amountCents: line.amountCents,
        pharmacyShareCents: line.pharmacyShareCents,
        gstTreatment: line.gstTreatment as GstTreatment,
        gstCents: line.gstCents,
      }))
      .sort((a, b) => FEE_ORDER[a.feeKind] - FEE_ORDER[b.feeKind]),
    payments: attempts
      .sort((a, b) => a.attempt - b.attempt)
      .map((payment) => ({
        paymentId: payment.id,
        attempt: payment.attempt,
        retry: payment.retry,
        status: payment.status as PaymentStatus,
        amountCents: payment.amountCents,
        card: cards.get(payment.paymentMethodId) ?? null,
        failureCode: payment.failureCode,
        createdAt: payment.createdAt.toISOString(),
        settledAt: payment.settledAt?.toISOString() ?? null,
        refundedAt: payment.refundedAt?.toISOString() ?? null,
      })),
  };
}

async function views(tx: TenantTx, rows: Row[]): Promise<Invoice[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((row) => row.id);
  const lines = await tx.db.select().from(invoiceLines).where(inArray(invoiceLines.invoiceId, ids)).orderBy(asc(invoiceLines.id));
  const attempts = await tx.db.select().from(payments).where(inArray(payments.invoiceId, ids));
  const cards = await methodLabels(tx, [...new Set(attempts.map((payment) => payment.paymentMethodId))]);
  return rows.map((row) =>
    view(
      row,
      lines.filter((line) => line.invoiceId === row.id),
      attempts.filter((payment) => payment.invoiceId === row.id),
      cards,
    ),
  );
}

export async function listInvoices(tx: TenantTx, filter: { patientId?: string | undefined; subscriptionId?: string | undefined }): Promise<Invoice[]> {
  const rows = await tx.db
    .select()
    .from(invoices)
    .where(and(filter.patientId ? eq(invoices.patientId, filter.patientId) : undefined, filter.subscriptionId ? eq(invoices.subscriptionId, filter.subscriptionId) : undefined))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number))
    .limit(200);
  return views(tx, rows);
}

export async function getInvoice(tx: TenantTx, id: string): Promise<Invoice> {
  const [row] = await tx.db.select().from(invoices).where(eq(invoices.id, id));
  if (!row) throw new NotFoundError('Invoice');
  return (await views(tx, [row]))[0]!;
}

/**
 * The company's next number, taken under its row's lock in the issuing
 * transaction: a rolled-back invoice gives its number back (BIL25).
 */
async function nextNumber(tx: TenantTx, companyId: string): Promise<string> {
  const [taken] = await tx.db
    .insert(invoiceNumbers)
    .values({ tenantId: tx.context.tenantId, companyId, lastNumber: 1 })
    .onConflictDoUpdate({ target: [invoiceNumbers.tenantId, invoiceNumbers.companyId], set: { lastNumber: sql`${invoiceNumbers.lastNumber} + 1` } })
    .returning({ prefix: invoiceNumbers.prefix, lastNumber: invoiceNumbers.lastNumber });
  return `${taken!.prefix}-${String(taken!.lastNumber).padStart(6, '0')}`;
}

/**
 * What the invoice moves in the ledger (BIL3, BIL7): the patient owes the
 * total; each fee's revenue, the GST in it and, for medicine, the pharmacy's
 * share are credited.
 */
function postingLines(patientId: string, partnerPharmacyId: string | null, lines: readonly InvoiceLine[]): LineInput[] {
  const posting: LineInput[] = [{ account: { kind: 'patient_receivable', patientId }, amountCents: sumCents(lines.map((line) => line.amountCents)) }];
  for (const line of lines) {
    const share = line.pharmacyShareCents ?? 0;
    const revenue = line.amountCents - line.gstCents - share;
    if (revenue !== 0) posting.push({ account: { kind: `revenue_${line.feeKind}` }, amountCents: -revenue, feeKind: line.feeKind });
    if (share > 0) posting.push({ account: { kind: 'pharmacy_payable', partnerPharmacyId: partnerPharmacyId! }, amountCents: -share, feeKind: line.feeKind });
  }
  const gst = sumCents(lines.map((line) => line.gstCents));
  if (gst > 0) posting.push({ account: { kind: 'gst_collected' }, amountCents: -gst });
  return posting;
}

const issuedKey = (invoiceId: string) => `invoice:${invoiceId}:issued`;

export interface InvoiceDraft {
  kind: InvoiceKind;
  subscription: { id: string; patientId: string; priceId: string; paymentAccountId: string };
  fees: readonly FeeRow[];
  period?: { startsOn: string; endsOn: string };
  /** The order that cleared a period with medicine (BIL24). */
  order?: { orderId: string; partnerPharmacyId: string };
}

/** Number, lines and ledger entry for an invoice, in one go (BIL23). */
export async function issueInvoice(tx: TenantTx, draft: InvoiceDraft): Promise<Invoice> {
  const { subscription } = draft;
  const [account] = await tx.db.select({ companyId: paymentAccounts.companyId }).from(paymentAccounts).where(eq(paymentAccounts.id, subscription.paymentAccountId));
  if (!account) throw new NotFoundError('Payment account');
  const lines: InvoiceLine[] = draft.fees.map((fee) => ({
    feeKind: fee.feeKind as FeeKind,
    productId: fee.productId,
    amountCents: fee.amountCents,
    pharmacyShareCents: fee.pharmacyShareCents,
    gstTreatment: fee.gstTreatment as GstTreatment,
    gstCents: fee.gstTreatment === 'taxable' ? gstIncluded(fee.amountCents) : 0,
  }));
  const [row] = await tx.db
    .insert(invoices)
    .values({
      tenantId: tx.context.tenantId,
      companyId: account.companyId,
      number: await nextNumber(tx, account.companyId),
      patientId: subscription.patientId,
      subscriptionId: subscription.id,
      priceId: subscription.priceId,
      paymentAccountId: subscription.paymentAccountId,
      kind: draft.kind,
      periodStartsOn: draft.period?.startsOn ?? null,
      periodEndsOn: draft.period?.endsOn ?? null,
      orderId: draft.order?.orderId ?? null,
      partnerPharmacyId: draft.order?.partnerPharmacyId ?? null,
      totalCents: sumCents(lines.map((line) => line.amountCents)),
      gstCents: sumCents(lines.map((line) => line.gstCents)),
    })
    .returning();
  const invoice = row!;
  await tx.db.insert(invoiceLines).values(
    lines.map((line) => ({ tenantId: tx.context.tenantId, invoiceId: invoice.id, orderId: line.feeKind === 'medicine' ? invoice.orderId : null, ...line })),
  );
  await postEntry(tx, { kind: 'invoice_issued', idempotencyKey: issuedKey(invoice.id), lines: postingLines(invoice.patientId, invoice.partnerPharmacyId, lines) });
  const facts = { patientId: invoice.patientId, subscriptionId: invoice.subscriptionId, kind: invoice.kind, number: invoice.number, totalCents: invoice.totalCents };
  await audit(tx, { action: 'invoice.issued', zone: 'operational', recordTable: TABLE, recordId: invoice.id, details: facts });
  await emitEvent(tx, { type: 'invoice.issued', recordTable: TABLE, recordId: invoice.id, payload: facts });
  return getInvoice(tx, invoice.id);
}

export type InvoiceRow = Row;

/** The invoice, locked. Callers that also change its subscription lock the subscription first. */
export async function lockInvoice(tx: TenantTx, id: string): Promise<Row> {
  const [row] = await tx.db.select().from(invoices).where(eq(invoices.id, id)).for('update');
  if (!row) throw new NotFoundError('Invoice');
  return row;
}

/** The subscription's period invoice that hasn't been paid or voided, if any: there is one at most (BIL29). */
export async function unpaidPeriodInvoice(tx: TenantTx, subscriptionId: string): Promise<Row | null> {
  const [row] = await tx.db
    .select()
    .from(invoices)
    .where(and(eq(invoices.subscriptionId, subscriptionId), eq(invoices.kind, 'period'), inArray(invoices.status, ['open', 'past_due'])))
    .for('update');
  return row ?? null;
}

type Settled = 'paid' | 'past_due' | 'retried' | 'voided';

async function settle(tx: TenantTx, row: Row, action: Settled, details: Record<string, string | number | null>): Promise<void> {
  const facts = { patientId: row.patientId, subscriptionId: row.subscriptionId, number: row.number, ...details };
  await audit(tx, { action: `invoice.${action}`, zone: 'operational', recordTable: TABLE, recordId: row.id, details: facts });
  await emitEvent(tx, { type: `invoice.${action}`, recordTable: TABLE, recordId: row.id, payload: facts });
}

export async function markInvoicePaid(tx: TenantTx, row: Row): Promise<void> {
  await tx.db.update(invoices).set({ status: 'paid', paidAt: sql`now()`, retryDueOn: null }).where(eq(invoices.id, row.id));
  await settle(tx, row, 'paid', {});
}

/** Why a charge didn't take the money: a soft decline, a hard one, or no card that can be charged (BIL28, BIL31). */
export type Unpaid = 'payment_failed' | 'card_declined' | 'no_payment_method';

/** Days after an invoice went past due that it is tried again, each at 10:00 the patient's time (BIL31). */
export const RETRY_DAYS = [1, 3, 5, 7] as const;

/** The first retry day after `today`, or null once the last has come: a job that runs late never tries twice in a row (BIL31). */
export function nextRetryOn(pastDueOn: string, today: string): string | null {
  return RETRY_DAYS.map((day) => addDays(pastDueOn, day)).find((on) => on > today) ?? null;
}

/**
 * The first charge didn't take the money (BIL28): the invoice is past due
 * from the patient's `today`, and the first retry is the next day (BIL31).
 */
export async function markInvoicePastDue(tx: TenantTx, row: Row, reason: Unpaid, today: string): Promise<void> {
  if (row.status !== 'open') return;
  const retryDueOn = nextRetryOn(today, today);
  await tx.db.update(invoices).set({ status: 'past_due', pastDueOn: today, retryDueOn }).where(eq(invoices.id, row.id));
  await settle(tx, row, 'past_due', { reason, retryDueOn });
}

/**
 * A scheduled retry starts (BIL31): the next one is booked before the card is
 * tried, so a retry is never made twice. Says which retry this is, and the
 * next one's date, null when this is the last.
 */
export async function startRetry(tx: TenantTx, row: Row, today: string): Promise<{ retry: number; retryDueOn: string | null }> {
  const retry = RETRY_DAYS.findIndex((day) => addDays(row.pastDueOn!, day) === row.retryDueOn) + 1;
  const retryDueOn = nextRetryOn(row.pastDueOn!, today);
  await tx.db.update(invoices).set({ retryDueOn }).where(eq(invoices.id, row.id));
  return { retry, retryDueOn };
}

/** A retry, or a new card's charge (`retry` null), didn't take the money either: messaging tells the patient (BIL31). */
export async function markInvoiceRetried(tx: TenantTx, row: Row, outcome: { retry: number | null; unpaid: Unpaid; retryDueOn: string | null }): Promise<void> {
  await settle(tx, row, 'retried', { retry: outcome.retry, outcome: outcome.unpaid, retryDueOn: outcome.retryDueOn });
}

export type VoidReason = 'subscription_cancelled' | 'subscription_paused' | 'period_skipped' | 'order_refused' | 'not_cleared' | 'payment_failed';

/**
 * An unpaid invoice that no longer stands (BIL29): it keeps its number, its
 * ledger entry is reversed, and its period and order can be issued again.
 * `invoice.voided` names the order, so orders can release it.
 */
export async function voidInvoice(tx: TenantTx, row: Row, reason: VoidReason): Promise<void> {
  if (row.status === 'void') return;
  if (row.status === 'paid') throw new Error('A paid invoice is refunded, never voided');
  const issued = await entryIdForKey(tx, issuedKey(row.id));
  if (!issued) throw new Error('An issued invoice has no ledger entry');
  await reverseEntry(tx, issued, `invoice:${row.id}:voided`);
  await tx.db.update(invoices).set({ status: 'void', voidedAt: sql`now()`, retryDueOn: null }).where(eq(invoices.id, row.id));
  await settle(tx, row, 'voided', { reason, orderId: row.orderId });
}