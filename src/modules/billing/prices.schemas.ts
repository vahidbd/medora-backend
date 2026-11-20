import { z } from 'zod';
import { BILLING_MODELS, FEE_KINDS, GST_TREATMENTS, INTERVAL_UNITS, PRICE_STATUSES } from '../../db/schema/values.js';

/** Whole cents, GST-inclusive, up to $100,000. */
const cents = z.number().int().min(1).max(10_000_000);

const fee = z
  .object({
    feeKind: z.enum(FEE_KINDS),
    /** Medicine fees only: the catalogue product. */
    productId: z.uuid().optional(),
    amountCents: cents,
    /** Medicine fees only: the partner pharmacy's part of the amount. */
    pharmacyShareCents: z.number().int().min(0).optional(),
    /** Left out: the default for the fee kind (BIL16). */
    gstTreatment: z.enum(GST_TREATMENTS).optional(),
  })
  .refine((f) => (f.feeKind === 'medicine') === (f.productId !== undefined), 'A medicine fee names its product, and only a medicine fee does')
  .refine((f) => (f.feeKind === 'medicine') === (f.pharmacyShareCents !== undefined), "A medicine fee says the pharmacy's share, and only a medicine fee does")
  .refine((f) => f.pharmacyShareCents === undefined || f.pharmacyShareCents <= f.amountCents, "The pharmacy's share can't be more than the fee");

const interval = z
  .object({ unit: z.enum(INTERVAL_UNITS), count: z.number().int().min(1) })
  .refine((i) => i.count <= (i.unit === 'week' ? 52 : 12), 'Every 1 to 52 weeks, or every 1 to 12 months');

export const priceDetails = z.object({
  name: z.string().trim().min(1).max(80),
  billingModel: z.enum(BILLING_MODELS),
  interval,
  paymentAccountId: z.uuid().nullable().optional(),
  fees: z.array(fee).max(50),
});

export const createPriceBody = priceDetails.extend({ programId: z.uuid() });

/** Publishing says the tenant has checked every fee's GST treatment (BIL16). */
export const publishPriceBody = z.object({ gstTreatmentsConfirmed: z.literal(true) });

export const priceParams = z.object({ priceId: z.uuid() });
export const pricesQuery = z.object({ programId: z.uuid().optional() });

export const price = z.object({
  priceId: z.uuid(),
  programId: z.uuid(),
  name: z.string(),
  billingModel: z.enum(BILLING_MODELS),
  interval: z.object({ unit: z.enum(INTERVAL_UNITS), count: z.number().int() }),
  paymentAccountId: z.uuid().nullable(),
  status: z.enum(PRICE_STATUSES),
  version: z.number().int(),
  replacesPriceId: z.uuid().nullable(),
  publishedAt: z.iso.datetime().nullable(),
  retiredAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
  fees: z.array(
    z.object({
      feeId: z.uuid(),
      feeKind: z.enum(FEE_KINDS),
      productId: z.uuid().nullable(),
      amountCents: z.number().int(),
      pharmacyShareCents: z.number().int().nullable(),
      gstTreatment: z.enum(GST_TREATMENTS),
      /** The GST inside the amount: one eleventh when taxable (BIL7). */
      gstCents: z.number().int(),
    }),
  ),
});

export const pricesReply = z.object({ prices: z.array(price) });
