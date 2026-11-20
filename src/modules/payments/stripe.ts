import { z } from 'zod';
import { type PaymentProcessor, ProcessorRefusedError, ProcessorUnavailableError } from './processor.js';

/**
 * The Stripe adapter (ADRs 0019 and 0037): Stripe Connect with Standard
 * accounts. Each tenant's account is its own; Medora's key opens and reads
 * them, and charges are made on the tenant's account (direct charges) as
 * billing arrives. Plain HTTPS to Stripe's API, pinned to one API version so
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

type Form = Record<string, string>;

export function stripeProcessor({ secretKey, apiBase = 'https://api.stripe.com/v1', fetch: send = fetch }: StripeOptions): PaymentProcessor {
  async function call<T>(schema: z.ZodType<T>, path: string, request: { form?: Form; idempotencyKey?: string } = {}): Promise<T> {
    const headers: Record<string, string> = { authorization: `Bearer ${secretKey}`, 'stripe-version': STRIPE_API_VERSION };
    if (request.form) headers['content-type'] = 'application/x-www-form-urlencoded';
    if (request.idempotencyKey) headers['idempotency-key'] = request.idempotencyKey;
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
  };
}
