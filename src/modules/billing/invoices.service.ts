import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { invoiceLines, invoiceNumbers, invoices, paymentAccounts, priceFees } from '../../db/schema/index.js';
import type { FeeKind, GstTreatment, InvoiceKind, InvoiceStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { gstIncluded, sumCents } from '../../lib/money.js';
import { type LineInput, postEntry } from '../ledger/index.js';

/**
 * Issuing invoices (docs/decisions/billing.md BIL23 to BIL27). An invoice is
 * written once, when it is issued: its number, its lines copied from the
 * price's fees, and its ledger entry, all in the caller's transaction.
 */

export interface InvoiceLine {
  feeKind: FeeKind;
  productId: string | null;
  amountCents: number;
  pharmacyShareCents: number | null;
  gstTreatment: GstTreatment;
  gstCents: number;
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
  lines: InvoiceLine[];
}

const TABLE = 'operational.invoices';
const FEE_ORDER: Record<FeeKind, number> = { consult: 0, program: 1, medicine: 2, shipping: 3 };
type FeeRow = typeof priceFees.$inferSelect;
type Row = typeof invoices.$inferSelect;
type LineRow = typeof invoiceLines.$inferSelect;

export async function feesOf(tx: TenantTx, priceId: string): Promise<FeeRow[]> {
  return tx.db.select().from(priceFees).where(eq(priceFees.priceId, priceId));
}

function view(row: Row, lines: LineRow[]): Invoice {
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
  };
}

export async function listInvoices(tx: TenantTx, filter: { patientId?: string | undefined; subscriptionId?: string | undefined }): Promise<Invoice[]> {
  const rows = await tx.db
    .select()
    .from(invoices)
    .where(and(filter.patientId ? eq(invoices.patientId, filter.patientId) : undefined, filter.subscriptionId ? eq(invoices.subscriptionId, filter.subscriptionId) : undefined))
    .orderBy(desc(invoices.issuedAt), desc(invoices.number))
    .limit(200);
  if (rows.length === 0) return [];
  const lines = await tx.db
    .select()
    .from(invoiceLines)
    .where(inArray(invoiceLines.invoiceId, rows.map((row) => row.id)))
    .orderBy(asc(invoiceLines.id));
  return rows.map((row) => view(row, lines.filter((line) => line.invoiceId === row.id)));
}

export async function getInvoice(tx: TenantTx, id: string): Promise<Invoice> {
  const [row] = await tx.db.select().from(invoices).where(eq(invoices.id, id));
  if (!row) throw new NotFoundError('Invoice');
  return view(row, await tx.db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, id)));
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
  await postEntry(tx, { kind: 'invoice_issued', idempotencyKey: `invoice:${invoice.id}:issued`, lines: postingLines(invoice.patientId, invoice.partnerPharmacyId, lines) });
  const facts = { patientId: invoice.patientId, subscriptionId: invoice.subscriptionId, kind: invoice.kind, number: invoice.number, totalCents: invoice.totalCents };
  await audit(tx, { action: 'invoice.issued', zone: 'operational', recordTable: TABLE, recordId: invoice.id, details: facts });
  await emitEvent(tx, { type: 'invoice.issued', recordTable: TABLE, recordId: invoice.id, payload: facts });
  return getInvoice(tx, invoice.id);
}
