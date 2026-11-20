import { describe, expect, it } from 'vitest';
import { STRIPE_API_VERSION, stripeProcessor } from '../../src/modules/payments/stripe.js';

/** What the Stripe adapter sends and how it reads Stripe's replies (ADRs 0019, 0160). Made-up ids and keys. */
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

  describe('charging a saved card', () => {
    const charge = {
      processorAccountId: 'acct_123',
      processorCustomerId: 'cus_123',
      processorMethodId: 'pm_123',
      amountCents: 12900,
      tenantId: 't-1',
      invoiceId: 'inv-1',
      paymentId: 'pay-1',
    };

    it('confirms an off-session payment intent on the tenant account, with ids only', async () => {
      const { sent, stripe } = stub(200, { id: 'pi_123', status: 'succeeded' });
      expect(await stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).toEqual({ status: 'succeeded', processorPaymentId: 'pi_123', failureCode: null, hardDecline: false });
      expect(sent[0]).toMatchObject({ url: 'https://api.stripe.com/v1/payment_intents', method: 'POST' });
      expect(sent[0]!.headers).toMatchObject({ 'stripe-account': 'acct_123', 'idempotency-key': 'payment:pay-1' });
      expect(Object.fromEntries(new URLSearchParams(sent[0]!.body!))).toEqual({
        amount: '12900',
        currency: 'aud',
        customer: 'cus_123',
        payment_method: 'pm_123',
        off_session: 'true',
        confirm: 'true',
        'metadata[medora_tenant_id]': 't-1',
        'metadata[medora_invoice_id]': 'inv-1',
        'metadata[medora_payment_id]': 'pay-1',
      });
    });

    it.each([
      ['processing', 'pending'],
      ['requires_action', 'requires_action'],
      ['requires_payment_method', 'failed'],
    ])('reads a %s payment intent as %s', async (stripeStatus, status) => {
      const { stripe } = stub(200, { id: 'pi_123', status: stripeStatus });
      expect(await stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).toMatchObject({ status, processorPaymentId: 'pi_123' });
    });

    it("reads a declined card as failed, keeping the card's reason", async () => {
      const { stripe } = stub(402, { error: { type: 'card_error', code: 'card_declined', decline_code: 'insufficient_funds', payment_intent: { id: 'pi_123' } } });
      expect(await stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).toEqual({
        status: 'failed',
        processorPaymentId: 'pi_123',
        failureCode: 'insufficient_funds',
        hardDecline: false,
      });
    });

    it.each([
      ['card_declined', 'lost_card'],
      ['card_declined', 'stolen_card'],
      ['card_declined', 'do_not_try_again'],
      ['expired_card', undefined],
      ['incorrect_number', undefined],
    ])('reads a %s (%s) decline as hard, so the card is not tried again', async (code, declineCode) => {
      const { stripe } = stub(402, { error: { type: 'card_error', code, ...(declineCode ? { decline_code: declineCode } : {}), payment_intent: { id: 'pi_123' } } });
      expect(await stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).toMatchObject({ status: 'failed', hardDecline: true });
    });

    it('reads a card that wants the patient to authenticate as needing action, and as a hard decline off-session', async () => {
      const { stripe } = stub(402, { error: { type: 'card_error', code: 'authentication_required', payment_intent: { id: 'pi_123' } } });
      expect(await stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).toEqual({
        status: 'requires_action',
        processorPaymentId: 'pi_123',
        failureCode: 'authentication_required',
        hardDecline: true,
      });
    });

    it('treats any other 402 as a refusal', async () => {
      const { stripe } = stub(402, { error: { type: 'invalid_request_error', code: 'amount_too_small' } });
      await expect(stripe.savedMethodCharges!.chargeSavedMethod(charge, 'payment:pay-1')).rejects.toMatchObject({ code: 'processor_refused', processorCode: 'amount_too_small' });
    });

    it("checks a pending charge with a GET on the tenant's account", async () => {
      const { sent, stripe } = stub(200, { id: 'pi_123', status: 'requires_payment_method', last_payment_error: { code: 'card_declined', decline_code: 'do_not_honor' } });
      expect(await stripe.savedMethodCharges!.checkCharge({ processorAccountId: 'acct_123', processorPaymentId: 'pi_123' })).toEqual({
        status: 'failed',
        processorPaymentId: 'pi_123',
        failureCode: 'do_not_honor',
        hardDecline: false,
      });
      expect(sent[0]).toMatchObject({ url: 'https://api.stripe.com/v1/payment_intents/pi_123', method: 'GET', body: null });
      expect(sent[0]!.headers['stripe-account']).toBe('acct_123');
    });
  });

  describe('refunding a charge', () => {
    const input = { processorAccountId: 'acct_123', processorPaymentId: 'pi_123', amountCents: 12900, tenantId: 't-1', paymentId: 'pay-1' };

    it('refunds the amount on the tenant account under the idempotency key', async () => {
      const { sent, stripe } = stub(200, { id: 're_123', status: 'succeeded' });
      expect(await stripe.refunds!.refundCharge(input, 'refund:pay-1')).toEqual({ status: 'succeeded', processorRefundId: 're_123' });
      expect(sent[0]!.headers).toMatchObject({ 'stripe-account': 'acct_123', 'idempotency-key': 'refund:pay-1' });
      expect(Object.fromEntries(new URLSearchParams(sent[0]!.body!))).toEqual({
        payment_intent: 'pi_123',
        amount: '12900',
        'metadata[medora_tenant_id]': 't-1',
        'metadata[medora_payment_id]': 'pay-1',
      });
    });

    it('reads a pending refund as accepted and a failed one as a refusal', async () => {
      expect(await stub(200, { id: 're_123', status: 'pending' }).stripe.refunds!.refundCharge(input, 'refund:pay-1')).toEqual({ status: 'pending', processorRefundId: 're_123' });
      await expect(stub(200, { id: 're_123', status: 'failed' }).stripe.refunds!.refundCharge(input, 'refund:pay-1')).rejects.toMatchObject({
        code: 'processor_refused',
        processorCode: 'refund_failed',
      });
    });
  });
});
