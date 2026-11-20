import { randomBytes } from 'node:crypto';
import type { Processor } from '../../db/schema/values.js';
import { type PaymentProcessor, type ProcessorAccountState, ProcessorRefusedError } from './processor.js';

/**
 * A processor that never leaves the process, for development and tests
 * (ADR 0160): no key, no network, no money. A deployed service never uses
 * it (src/modules/payments/processors.ts).
 *
 * Onboarding is instant: making a link finishes it, and the link goes
 * straight back to the console. Tests change what the processor says with
 * `setChargesEnabled`.
 */
export class FakeProcessor implements PaymentProcessor {
  readonly processor: Processor;
  /** How many accounts were really opened, so tests can see a retry didn't open a second. */
  accountsOpened = 0;
  private readonly accounts = new Map<string, ProcessorAccountState>();
  private readonly byKey = new Map<string, string>();

  constructor(processor: Processor) {
    this.processor = processor;
  }

  async getAccount(processorAccountId: string): Promise<ProcessorAccountState> {
    return { ...this.account(processorAccountId) };
  }

  readonly hostedOnboarding = {
    createAccount: async (_input: { tenantId: string; paymentAccountId: string }, idempotencyKey: string) => {
      const known = this.byKey.get(idempotencyKey);
      if (known) return { processorAccountId: known };
      const processorAccountId = `acct_fake${randomBytes(8).toString('hex')}`;
      this.accounts.set(processorAccountId, { chargesEnabled: false });
      this.byKey.set(idempotencyKey, processorAccountId);
      this.accountsOpened += 1;
      return { processorAccountId };
    },

    onboardingLink: async (input: { processorAccountId: string; returnUrl: string; refreshUrl: string }, _idempotencyKey: string) => {
      this.account(input.processorAccountId).chargesEnabled = true;
      return { url: input.returnUrl, expiresAt: new Date(Date.now() + 5 * 60_000) };
    },
  };

  setChargesEnabled(processorAccountId: string, chargesEnabled: boolean): void {
    this.account(processorAccountId).chargesEnabled = chargesEnabled;
  }

  private account(processorAccountId: string): ProcessorAccountState {
    const found = this.accounts.get(processorAccountId);
    if (!found) throw new ProcessorRefusedError(this.processor, 'resource_missing');
    return found;
  }
}
