import { z } from 'zod';
import { type ChargeResult, type PaymentProcessor, ProcessorRefusedError, ProcessorUnavailableError, type RefundResult } from './processor.js';

/**
 * The Stripe adapter (ADRs 0019 and 0160): Stripe Connect with Standard
 * accounts. Each tenant's account is its own; Medora's key opens and reads
 * them, and charges and refunds are made on the tenant's account (direct
 * charges). Plain HTTPS to Stripe's API, pinned to one API version so
 * a change on Stripe's side can't change what Medora reads.
 */
export const STRIPE_API_VERSION = '2025-03-31.basil';

const TIMEOUT_MS = 20_000;

export interface StripeOptions {
  secretKey: string;
  apiBase?: string;
  fetch?: typeof fetch;
}

const account = z.object({ id: z.string().startsWith('acct_'), charges_enabled: z.boolean() });
const accountLink = z.object({ url: z.url().startsWith('https://'), expires_at: z.number().int() });
const failure = z.object({ error: z.object({ type: z.string(), code: z.string().optional() }) });
const paymentIntent = z.object({
  id: z.string().startsWith('pi_'),
  status: z.string(),
  last_payment_error: z.object({ code: z.string().optional(), decline_code: z.string().optional() }).nullish(),
});
const refund = z.object({ id: z.string().startsWith('re_'), status: z.string() });
/** A declined card comes back as a 402 carrying the payment intent it made. */
const cardError = z.object({
  error: z.object({
    type: z.literal('card_error'),
    code: z.string().optional(),
    decline_code: z.string().optional(),
    payment_intent: z.object({ id: z.string().startsWith('pi_') }).optional(),
  }),
});

/** A payment intent's status, in Medora's words. */
function chargeStatus(status: string): ChargeResult['status'] {
  if (status === 'succeeded') return 'succeeded';
  if (status === 'processing') return 'pending';
  if (status === 'requires_action' || status === 'requires_confirmation') return 'requires_action';
  return 'failed';
}

/**
 * Stripe's decline codes that no retry changes: the card is gone, closed or
 * refused for good, so the patient needs to pay another way (BIL31).
 * Everything else, such as insufficient funds, may pass on a later day.
 */
const HARD_DECLINES = new Set([
  'card_not_supported',
  'currency_not_supported',
  'do_not_honor_permanently',
  'do_not_try_again',
  'expired_card',
  'fraudulent',
  'incorrect_number',
  'invalid_account',
  'invalid_number',
  'lost_card',
  'merchant_blacklist',
  'new_account_information_available',
  'not_permitted',
  'pickup_card',
  'restricted_card',
  'revocation_of_all_authorizations',
  'revocation_of_authorization',
  'security_violation',
  'service_not_allowed',
  'stolen_card',
  'stop_payment_order',
  'transaction_not_allowed',
]);

/** A charge's outcome; one that needs the patient to authenticate counts as a hard decline, since they aren't there to do it. */
function result(status: ChargeResult['status'], processorPaymentId: string | null, failureCode: string | null): ChargeResult {
  const hardDecline = status === 'requires_action' || (status === 'failed' && failureCode !== null && HARD_DECLINES.has(failureCode));
  return { status, processorPaymentId, failureCode, hardDecline };
}

/** A payment intent as Medora reads it: a failed one keeps the card's reason. */
const intentResult = paymentIntent.transform((intent): ChargeResult => {
  const status = chargeStatus(intent.status);
  const reason = intent.last_payment_error;
  const failureCode = status === 'failed' || status === 'requires_action' ? (reason?.decline_code ?? reason?.code ?? intent.status) : null;
  return result(status, intent.id, failureCode);
});

type Form = Record<string, string>;

export function stripeProcessor({ secretKey, apiBase = 'https://api.stripe.com/v1', fetch: send = fetch }: StripeOptions): PaymentProcessor {
  async function call<T>(
    schema: z.ZodType<T>,
    path: string,
    request: { form?: Form; idempotencyKey?: string; account?: string; onCardError?: (error: z.infer<typeof cardError>) => T } = {},
  ): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}`, 'stripe-version': STRIPE_API_VERSION };
    if (request.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
    // Direct charges: the request acts on the tenant's own Stripe account (ADR 0160).
    if (request.account) headers['stripe-account'] = request.account;
    let response: Response;
    try {
      response = await send(`${apiBase}${path}`, {
        method: request.form ? 'POST' : 'GET',
        headers,
        ...(request.form ? { body: new URLSearchParams(request.form).toString() } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      throw new ProcessorUnavailableError('stripe');
    }
    // Rate limits and Stripe's own trouble are worth another try; anything else is a refusal.
    if (response.status === 429 || response.status >= 500) throw new ProcessorUnavailableError('stripe');
    const body: unknown = await response.json().catch(() => null);
    if (!response.ok) {
      const declined = response.status === 402 && request.onCardError ? cardError.safeParse(body) : null;
      if (declined?.success) return request.onCardError!(declined.data);
      const parsed = failure.safeParse(body);
      throw new ProcessorRefusedError('stripe', parsed.success ? (parsed.data.error.code ?? parsed.data.error.type) : `http_${response.status}`);
    }
    const parsed = schema.safeParse(body);
    if (!parsed.success) throw new ProcessorRefusedError('stripe', 'unexpected_reply');
    return parsed.data;
  }

  return {
    processor: 'stripe',

    async getAccount(processorAccountId) {
      const found = await call(account, `/accounts/${encodeURIComponent(processorAccountId)}`);
      return { chargesEnabled: found.charges_enabled };
    },

    hostedOnboarding: {
      async createAccount({ tenantId, paymentAccountId }, idempotencyKey) {
        // Ids only: the tenant enters its business, bank and identity details on Stripe's pages.
        const created = await call(account, '/accounts', {
          form: {
            type: 'standard',
            country: 'AU',
            'metadata[medora_tenant_id]': tenantId,
            'metadata[medora_payment_account_id]': paymentAccountId,
          },
          idempotencyKey,
        });
        return { processorAccountId: created.id };
      },

      async onboardingLink({ processorAccountId, returnUrl, refreshUrl }, idempotencyKey) {
        const link = await call(accountLink, '/account_links', {
          form: { account: processorAccountId, type: 'account_onboarding', return_url: returnUrl, refresh_url: refreshUrl },
          idempotencyKey,
        });
        return { url: link.url, expiresAt: new Date(link.expires_at * 1000) };
      },
    },

    savedMethodCharges: {
      // Stripe keeps idempotency keys for at least 24 hours.
      keyLifetimeHours: 24,

      async chargeSavedMethod(charge, idempotencyKey) {
        // Ids and the amount only: nothing about the patient or what the charge is for clinically.
        return call(intentResult, '/payment_intents', {
          form: {
            amount: String(charge.amountCents),
            currency: 'aud',
            customer: charge.processorCustomerId,
            payment_method: charge.processorMethodId,
            off_session: 'true',
            confirm: 'true',
            'metadata[medora_tenant_id]': charge.tenantId,
            'metadata[medora_invoice_id]': charge.invoiceId,
            'metadata[medora_payment_id]': charge.paymentId,
          },
          idempotencyKey,
          account: charge.processorAccountId,
          onCardError: ({ error }) =>
            result(error.code === 'authentication_required' ? 'requires_action' : 'failed', error.payment_intent?.id ?? null, error.decline_code ?? error.code ?? 'card_error'),
        });
      },

      async checkCharge({ processorAccountId, processorPaymentId }) {
        return call(intentResult, `/payment_intents/${encodeURIComponent(processorPaymentId)}`, { account: processorAccountId });
      },
    },

    refunds: {
      async refundCharge(input, idempotencyKey): Promise<RefundResult> {
        const made = await call(refund, '/refunds', {
          form: {
            payment_intent: input.processorPaymentId,
            amount: String(input.amountCents),
            'metadata[medora_tenant_id]': input.tenantId,
            'metadata[medora_payment_id]': input.paymentId,
          },
          idempotencyKey,
          account: input.processorAccountId,
        });
        if (made.status === 'succeeded') return { status: 'succeeded', processorRefundId: made.id };
        if (made.status === 'pending' || made.status === 'requires_action') return { status: 'pending', processorRefundId: made.id };
        // Failed or cancelled: the money didn't go back.
        throw new ProcessorRefusedError('stripe', `refund_${made.status}`);
      },
    },
  };
}
