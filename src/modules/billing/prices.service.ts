import { asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { paymentAccounts, priceFees, prices } from '../../db/schema/index.js';
import type { BillingModel, FeeKind, GstTreatment, IntervalUnit, PriceStatus } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BadRequestError, BusinessRuleError, NotFoundError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';
import { gstIncluded } from '../../lib/money.js';

/**
 * Prices (docs/decisions/billing.md BIL13 to BIL17). Drafts are edited
 * freely; publishing makes a price live and, for a revision, retires the
 * price it replaces in the same transaction. A live price never changes.
 */

export interface FeeInput {
  feeKind: FeeKind;
  productId?: string | undefined;
  amountCents: number;
  pharmacyShareCents?: number | undefined;
  gstTreatment?: GstTreatment | undefined;
}

export interface PriceDetails {
  name: string;
  billingModel: BillingModel;
  interval: { unit: IntervalUnit; count: number };
  paymentAccountId?: string | null | undefined;
  fees: FeeInput[];
}

export interface Fee {
  feeId: string;
  feeKind: FeeKind;
  productId: string | null;
  amountCents: number;
  pharmacyShareCents: number | null;
  gstTreatment: GstTreatment;
  gstCents: number;
}

export interface Price {
  priceId: string;
  programId: string;
  name: string;
  billingModel: BillingModel;
  interval: { unit: IntervalUnit; count: number };
  paymentAccountId: string | null;
  status: PriceStatus;
  version: number;
  replacesPriceId: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  fees: Fee[];
}

const TABLE = 'operational.prices';
const FEE_ORDER: Record<FeeKind, number> = { consult: 0, program: 1, medicine: 2, shipping: 3 };

type PriceRow = typeof prices.$inferSelect;
type FeeRow = typeof priceFees.$inferSelect;

function view(row: PriceRow, fees: FeeRow[]): Price {
  return {
    priceId: row.id,
    programId: row.programId,
    name: row.name,
    billingModel: row.billingModel as BillingModel,
    interval: { unit: row.intervalUnit as IntervalUnit, count: row.intervalCount },
    paymentAccountId: row.paymentAccountId,
    status: row.status as PriceStatus,
    version: row.version,
    replacesPriceId: row.replacesPriceId,
    publishedAt: row.publishedAt?.toISOString() ?? null,
    retiredAt: row.retiredAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    fees: fees
      .filter((fee) => fee.priceId === row.id)
      .sort((a, b) => FEE_ORDER[a.feeKind as FeeKind] - FEE_ORDER[b.feeKind as FeeKind] || a.amountCents - b.amountCents)
      .map((fee) => ({
        feeId: fee.id,
        feeKind: fee.feeKind as FeeKind,
        productId: fee.productId,
        amountCents: fee.amountCents,
        pharmacyShareCents: fee.pharmacyShareCents,
        gstTreatment: fee.gstTreatment as GstTreatment,
        gstCents: fee.gstTreatment === 'taxable' ? gstIncluded(fee.amountCents) : 0,
      })),
  };
}

async function record(tx: TenantTx, action: 'created' | 'updated' | 'published' | 'retired', id: string, details: Record<string, string | number | null>) {
  await audit(tx, { action: `price.${action}`, zone: 'operational', recordTable: TABLE, recordId: id, details });
  // A draft is seen by nobody outside the staff editing it, so editing one emits nothing.
  if (action !== 'updated') await emitEvent(tx, { type: `price.${action}`, recordTable: TABLE, recordId: id, payload: details });
}

export async function listPrices(tx: TenantTx, filter: { programId?: string | undefined } = {}): Promise<Price[]> {
  const rows = await tx.db
    .select()
    .from(prices)
    .where(filter.programId ? eq(prices.programId, filter.programId) : undefined)
    .orderBy(asc(prices.programId), asc(prices.name), desc(prices.version));
  const fees = rows.length ? await tx.db.select().from(priceFees).where(inArray(priceFees.priceId, rows.map((row) => row.id))) : [];
  return rows.map((row) => view(row, fees));
}

export async function getPrice(tx: TenantTx, id: string): Promise<Price> {
  const [row] = await tx.db.select().from(prices).where(eq(prices.id, id));
  if (!row) throw new NotFoundError('Price');
  return view(row, await tx.db.select().from(priceFees).where(eq(priceFees.priceId, id)));
}

async function lockPrice(tx: TenantTx, id: string): Promise<PriceRow> {
  const [row] = await tx.db.select().from(prices).where(eq(prices.id, id)).for('update');
  if (!row) throw new NotFoundError('Price');
  return row;
}

/**
 * GST treatment when staff don't choose one (BIL16): consults and medicine
 * GST-free, program fees taxable, shipping following the medicine it carries.
 * Staff confirm every treatment when they publish.
 */
export function defaultGstTreatment(feeKind: FeeKind, fees: readonly FeeInput[]): GstTreatment {
  if (feeKind === 'program') return 'taxable';
  if (feeKind === 'shipping') return fees.some((fee) => fee.feeKind === 'medicine') ? 'gst_free' : 'taxable';
  return 'gst_free';
}

function checkFees(details: PriceDetails): void {
  const seen = new Set<string>();
  for (const fee of details.fees) {
    if (fee.feeKind === 'medicine' && details.billingModel !== 'bundled') {
      throw new BadRequestError('Only a bundled price charges for medicine; the pharmacy bills it otherwise', 'medicine_fee_not_bundled');
    }
    const key = fee.feeKind === 'medicine' ? `medicine:${fee.productId}` : fee.feeKind;
    if (seen.has(key)) throw new BadRequestError('Each fee kind appears once, and each medicine once', 'duplicate_fee');
    seen.add(key);
  }
}

async function checkPaymentAccount(tx: TenantTx, paymentAccountId: string | null | undefined): Promise<void> {
  if (!paymentAccountId) return;
  const [account] = await tx.db.select({ status: paymentAccounts.status }).from(paymentAccounts).where(eq(paymentAccounts.id, paymentAccountId));
  if (!account) throw new NotFoundError('Payment account');
  if (account.status === 'closed') throw new BusinessRuleError('That payment account is closed to new subscriptions', 'payment_account_closed');
}

async function writeFees(tx: TenantTx, row: Pick<PriceRow, 'id' | 'billingModel'>, fees: readonly FeeInput[]): Promise<void> {
  if (fees.length === 0) return;
  await tx.db.insert(priceFees).values(
    fees.map((fee) => ({
      tenantId: tx.context.tenantId,
      priceId: row.id,
      billingModel: row.billingModel,
      feeKind: fee.feeKind,
      productId: fee.feeKind === 'medicine' ? (fee.productId ?? null) : null,
      amountCents: fee.amountCents,
      pharmacyShareCents: fee.feeKind === 'medicine' ? (fee.pharmacyShareCents ?? null) : null,
      gstTreatment: fee.gstTreatment ?? defaultGstTreatment(fee.feeKind, fees),
    })),
  );
}

export async function createPrice(tx: TenantTx, input: PriceDetails & { programId: string }): Promise<Price> {
  checkFees(input);
  await checkPaymentAccount(tx, input.paymentAccountId);
  const [row] = await tx.db
    .insert(prices)
    .values({
      tenantId: tx.context.tenantId,
      programId: input.programId,
      name: input.name,
      billingModel: input.billingModel,
      intervalUnit: input.interval.unit,
      intervalCount: input.interval.count,
      paymentAccountId: input.paymentAccountId ?? null,
    })
    .returning();
  await writeFees(tx, row!, input.fees);
  await record(tx, 'created', row!.id, { programId: input.programId, version: 1, replacesPriceId: null });
  return getPrice(tx, row!.id);
}

/** Replace a draft's details and all its fees. */
export async function updateDraftPrice(tx: TenantTx, id: string, input: PriceDetails): Promise<Price> {
  const row = await lockPrice(tx, id);
  if (row.status !== 'draft') throw new BusinessRuleError('A published price never changes. Revise it to make a new version', 'price_not_draft');
  checkFees(input);
  await checkPaymentAccount(tx, input.paymentAccountId);
  await tx.db.delete(priceFees).where(eq(priceFees.priceId, id));
  await tx.db
    .update(prices)
    .set({
      name: input.name,
      billingModel: input.billingModel,
      intervalUnit: input.interval.unit,
      intervalCount: input.interval.count,
      paymentAccountId: input.paymentAccountId ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(prices.id, id));
  await writeFees(tx, { id, billingModel: input.billingModel }, input.fees);
  await record(tx, 'updated', id, { version: row.version });
  return getPrice(tx, id);
}

/**
 * Make a draft live (BIL14, BIL16). It needs a fee charged every period, a
 * medicine fee when bundled, and staff confirming the GST treatments. A
 * revision retires the price it replaces in the same transaction.
 */
export async function publishPrice(tx: TenantTx, id: string): Promise<Price> {
  const row = await lockPrice(tx, id);
  if (row.status !== 'draft') throw new BusinessRuleError('This price is already published', 'price_not_draft');
  const replaced = row.replacesPriceId ? await lockPrice(tx, row.replacesPriceId) : null;
  const fees = await tx.db.select().from(priceFees).where(eq(priceFees.priceId, id));
  if (!fees.some((fee) => fee.feeKind !== 'consult')) {
    throw new BusinessRuleError('A price needs a fee charged every billing period: program, medicine or shipping', 'price_has_no_period_fee');
  }
  if (row.billingModel === 'bundled' && !fees.some((fee) => fee.feeKind === 'medicine')) {
    throw new BusinessRuleError('A bundled price needs a medicine fee for each medicine it covers', 'bundled_price_without_medicine');
  }
  await checkPaymentAccount(tx, row.paymentAccountId);
  await tx.db.update(prices).set({ status: 'live', publishedAt: sql`now()`, updatedAt: sql`now()` }).where(eq(prices.id, id));
  await record(tx, 'published', id, { programId: row.programId, version: row.version, replacesPriceId: row.replacesPriceId });
  if (replaced?.status === 'live') await retire(tx, replaced);
  return getPrice(tx, id);
}

async function retire(tx: TenantTx, row: PriceRow): Promise<void> {
  await tx.db.update(prices).set({ status: 'retired', retiredAt: sql`now()`, updatedAt: sql`now()` }).where(eq(prices.id, row.id));
  await record(tx, 'retired', row.id, { programId: row.programId, version: row.version });
}

/** Stop offering a live price to new patients. Its subscriptions keep it (BIL15). */
export async function retirePrice(tx: TenantTx, id: string): Promise<Price> {
  const row = await lockPrice(tx, id);
  if (row.status !== 'live') throw new BusinessRuleError('Only a live price can be retired', 'price_not_live');
  await retire(tx, row);
  return getPrice(tx, id);
}

/** A draft copy of a live price, one version on, that replaces it when published. */
export async function revisePrice(tx: TenantTx, id: string): Promise<Price> {
  const row = await lockPrice(tx, id);
  if (row.status !== 'live') throw new BusinessRuleError('Only a live price can be revised', 'price_not_live');
  const [existing] = await tx.db.select({ id: prices.id }).from(prices).where(eq(prices.replacesPriceId, id));
  if (existing) throw new BusinessRuleError('This price already has a revision. Edit that draft instead', 'price_already_revised');
  const [copy] = await tx.db
    .insert(prices)
    .values({
      tenantId: tx.context.tenantId,
      programId: row.programId,
      name: row.name,
      billingModel: row.billingModel,
      intervalUnit: row.intervalUnit,
      intervalCount: row.intervalCount,
      paymentAccountId: row.paymentAccountId,
      version: row.version + 1,
      replacesPriceId: id,
    })
    .returning();
  const fees = await tx.db.select().from(priceFees).where(eq(priceFees.priceId, id));
  await writeFees(
    tx,
    copy!,
    fees.map((fee) => ({
      feeKind: fee.feeKind as FeeKind,
      productId: fee.productId ?? undefined,
      amountCents: fee.amountCents,
      pharmacyShareCents: fee.pharmacyShareCents ?? undefined,
      gstTreatment: fee.gstTreatment as GstTreatment,
    })),
  );
  await record(tx, 'created', copy!.id, { programId: row.programId, version: copy!.version, replacesPriceId: id });
  return getPrice(tx, copy!.id);
}
