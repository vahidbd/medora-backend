import { z } from 'zod';
import { PAYMENT_ACCOUNT_STATUSES, PROCESSORS } from '../../db/schema/values.js';

export const paymentAccount = z.object({
  paymentAccountId: z.uuid(),
  processor: z.enum(PROCESSORS),
  companyId: z.uuid(),
  name: z.string(),
  status: z.enum(PAYMENT_ACCOUNT_STATUSES),
  /** The processor's id for the account, for support. Not a secret. */
  processorAccountId: z.string().nullable(),
  chargesEnabled: z.boolean(),
  isDefault: z.boolean(),
  activatedAt: z.iso.datetime().nullable(),
  closedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(),
});

const name = z.string().trim().min(1).max(80);

export const paymentAccountsReply = z.object({ paymentAccounts: z.array(paymentAccount) });
export const paymentAccountParams = z.object({ paymentAccountId: z.uuid() });

/** eWAY joins with its keys in the next part (ADR 0160). */
export const createPaymentAccountBody = z.object({
  processor: z.literal('stripe'),
  companyId: z.uuid(),
  name,
});

export const changePaymentAccountBody = z
  .object({
    name: name.optional(),
    /** true closes it to new subscriptions (its subscriptions carry on); false reopens it. */
    closed: z.boolean().optional(),
    /** Choose another payment account as the default to change it; there is no "not the default". */
    isDefault: z.literal(true).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, 'Send at least one change')
  .refine((body) => !(body.closed === true && body.isDefault), "A closed payment account can't be the default");

export const onboardingLinkReply = z.object({
  /** The processor's page. Open it straight away: it works once and expires within minutes. */
  url: z.url(),
  expiresAt: z.iso.datetime(),
});
