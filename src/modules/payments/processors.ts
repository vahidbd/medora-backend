import { env, isDeployed } from '../../config/env.js';
import type { Processor } from '../../db/schema/values.js';
import { FakeProcessor } from './fake-processor.js';
import { type PaymentProcessor, ProcessorNotConfiguredError } from './processor.js';
import { stripeProcessor } from './stripe.js';

/**
 * Which adapter serves a processor (ADR 0160). With a key, the real one.
 * Without, the fake stands in outside a deployed service, and a deployed
 * service refuses rather than pretend (production can't start without a
 * Stripe key: src/config/env.ts). Tests never have a key (test/setup-env.ts).
 */
const fakes = new Map<Processor, FakeProcessor>();
let stripe: PaymentProcessor | null = null;

export function fakeProcessor(processor: Processor): FakeProcessor {
  let fake = fakes.get(processor);
  if (!fake) {
    fake = new FakeProcessor(processor);
    fakes.set(processor, fake);
  }
  return fake;
}

export function paymentProcessor(processor: Processor): PaymentProcessor {
  if (processor === 'stripe' && env.STRIPE_SECRET_KEY) {
    stripe ??= stripeProcessor({ secretKey: env.STRIPE_SECRET_KEY });
    return stripe;
  }
  if (isDeployed) throw new ProcessorNotConfiguredError(processor);
  return fakeProcessor(processor);
}
