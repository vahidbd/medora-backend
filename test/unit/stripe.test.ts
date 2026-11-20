import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION, stripeProcessor } from '../../src/modules/payments/stripe.js';

/** What the Stripe adapter sends and how it reads Stripe's replies (ADRs 0019, 0037). Made-up ids and keys. */
interface Sent {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string | null;
}

function stub(status: number, reply: unknown) {
  const sent: Sent[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    sent.push({ url, method: init.method ?? 'GET', headers: init.headers as Record<string, string>, body: (init.body as string) ?? null });
    return new Response(JSON.stringify(reply), { status, headers: { 'content-type': 'application/json' } });
  }) as typeof globalThis.fetch;
  return { sent, stripe: stripeProcessor({ secretKey: 'sk_test_made_up', fetch }) };
}

describe('the Stripe adapter', () => {
  it('opens a Standard account in Australia with ids only, under the idempotency key', async () => {
    const { sent, stripe } = stub(200, { id: 'acct_123', charges_enabled: false });
    const opened = await stripe.hostedOnboarding!.createAccount({ tenantId: 't-1', paymentAccountId: 'pa-1' }, 'payment-account-open:pa-1');
    expect(opened).toEqual({ processorAccountId: 'acct_123' });
    expect(sent[0]).toMatchObject({ url: 'https://api.stripe.com/v1/accounts', method: 'POST' });
    expect(sent[0]!.headers).toMatchObject({
      authorization: 'Bearer sk_test_made_up',
      'stripe-version': STRIPE_API_VERSION,
      'idempotency-key': 'payment-account-open:pa-1',
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body!))).toEqual({
      type: 'standard',
      country: 'AU',
      'metadata[medora_tenant_id]': 't-1',
      'metadata[medora_payment_account_id]': 'pa-1',
    });
  });

  it('makes an onboarding link that comes back to the console', async () => {
    const { sent, stripe } = stub(200, { url: 'https://connect.stripe.com/setup/s/abc', expires_at: 1_800_000_000 });
    const link = await stripe.hostedOnboarding!.onboardingLink(
      { processorAccountId: 'acct_123', returnUrl: 'https://console.example.test/back', refreshUrl: 'https://console.example.test/again' },
      'link-key',
    );
    expect(link).toEqual({ url: 'https://connect.stripe.com/setup/s/abc', expiresAt: new Date(1_800_000_000_000) });
    expect(Object.fromEntries(new URLSearchParams(sent[0]!.body!))).toEqual({
      account: 'acct_123',
      type: 'account_onboarding',
      return_url: 'https://console.example.test/back',
      refresh_url: 'https://console.example.test/again',
    });
  });

  it('reads an account with a GET and no idempotency key', async () => {
    const { sent, stripe } = stub(200, { id: 'acct_123', charges_enabled: true, payouts_enabled: true });
    expect(await stripe.getAccount('acct_123')).toEqual({ chargesEnabled: true });
    expect(sent[0]).toMatchObject({ url: 'https://api.stripe.com/v1/accounts/acct_123', method: 'GET', body: null });
    expect(sent[0]!.headers['idempotency-key']).toBeUndefined();
  });

  it("keeps Stripe's code when it refuses, never its message", async () => {
    const { stripe } = stub(400, { error: { type: 'invalid_request_error', code: 'account_invalid', message: 'details we do not pass on' } });
    await expect(stripe.getAccount('acct_123')).rejects.toMatchObject({ statusCode: 502, code: 'processor_refused', processorCode: 'account_invalid' });
    const typeOnly = stub(401, { error: { type: 'authentication_error' } });
    await expect(typeOnly.stripe.getAccount('acct_123')).rejects.toMatchObject({ processorCode: 'authentication_error' });
  });

  it('treats a reply it does not recognise as a refusal', async () => {
    const { stripe } = stub(200, { id: 'cus_123' });
    await expect(stripe.getAccount('acct_123')).rejects.toMatchObject({ code: 'processor_refused', processorCode: 'unexpected_reply' });
  });

  it.each([
    ['Stripe having trouble', 500],
    ['a rate limit', 429],
  ])('says Stripe is unavailable on %s, so the same key can be tried again', async (_name, status) => {
    const { stripe } = stub(status, { error: { type: 'api_error' } });
    await expect(stripe.getAccount('acct_123')).rejects.toMatchObject({ statusCode: 503, code: 'processor_unavailable' });
  });

  it('says Stripe is unavailable when the network fails', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(stripeProcessor({ secretKey: 'sk_test_made_up', fetch }).getAccount('acct_123')).rejects.toMatchObject({ code: 'processor_unavailable' });
  });
});
