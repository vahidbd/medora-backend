import { z } from 'zod';
import { FEE_KINDS, GST_TREATMENTS, INVOICE_KINDS, INVOICE_STATUSES, PAYMENT_STATUSES } from '../../db/schema/values.js';

export const invoiceParams = z.object({ invoiceId: z.uuid() });
export const invoicesQuery = z.object({ patientId: z.uuid().optional(), subscriptionId: z.uuid().optional() });

export const invoice = z.object({
  invoiceId: z.uuid(),
  /** `<prefix>-<number>`, gapless per issuing company. */
  number: z.string(),
  kind: z.enum(INVOICE_KINDS),
  patientId: z.uuid(),
  subscriptionId: z.uuid(),
  priceId: z.uuid(),
  paymentAccountId: z.uuid(),
  companyId: z.uuid(),
  /** The billing period it charges for; null for the consult at checkout. */
  period: z.object({ startsOn: z.iso.date(), endsOn: z.iso.date() }).nullable(),
  /** The order that cleared a period with medicine. */
  orderId: z.uuid().nullable(),
  status: z.enum(INVOICE_STATUSES),
  totalCents: z.number().int(),
  gstCents: z.number().int(),
  issuedAt: z.iso.datetime(),
  paidAt: z.iso.datetime().nullable(),
  /** A void invoice keeps its number; nothing is owed on it. */
  voidedAt: z.iso.datetime().nullable(),
  lines: z.array(
    z.object({
      feeKind: z.enum(FEE_KINDS),
      productId: z.uuid().nullable(),
      amountCents: z.number().int(),
      pharmacyShareCents: z.number().int().nullable(),
      gstTreatment: z.enum(GST_TREATMENTS),
      gstCents: z.number().int(),
    }),
  ),
  /** Every attempt to take the total from a saved card, oldest first. */
  payments: z.array(
    z.object({
      paymentId: z.uuid(),
      attempt: z.number().int(),
      status: z.enum(PAYMENT_STATUSES),
      amountCents: z.number().int(),
      card: z.object({ brand: z.string(), last4: z.string() }).nullable(),
      /** The processor's reason for a failure, for staff; not wording for the patient. */
      failureCode: z.string().nullable(),
      createdAt: z.iso.datetime(),
      settledAt: z.iso.datetime().nullable(),
      refundedAt: z.iso.datetime().nullable(),
    }),
  ),
});

export const invoicesReply = z.object({ invoices: z.array(invoice) });
