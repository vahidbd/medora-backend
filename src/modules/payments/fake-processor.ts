import { randomBytes } from 'node:crypto';
import type { Processor } from '../../db/schema/values.js';
import {
  type ChargeRef,
  type ChargeResult,
  type PaymentProcessor,
  type ProcessorAccountState,
  ProcessorRefusedError,
  ProcessorUnavailableError,
  type RefundResult,
  type SavedMethodCharge,
} from './processor.js';

/** How saved method ids start to make the fake answer a charge a particular way. Any other id is charged. */
export const FAKE_METHODS = {
  /** A soft decline, such as insufficient funds: a later day may pass. */
  declined: 'pm_fake_declined',
  /** A hard decline: the card was reported lost. */
  lost: 'pm_fake_lost',
  needsAuthentication: 'pm_fake_needs_authentication',
  pending: 'pm_fake_pending',
} as const;

/**
 * A processor that never leaves the process, for development and tests
 * (ADR 0160): no key, no network, no money. A deployed service never uses
 * it (src/modules/payments/processors.ts).
 *
 * Onboarding is instant: making a link finishes it, and the link goes
 * straight back to the console. Tests change what the processor says with
 * `setChargesEnabled`, decide a charge by its saved method id (FAKE_METHODS)
 * or `setOutcome`, finish a pending one with `settle`, and lose a reply with
 * `loseNextReply`.
 */
export class FakeProcessor implements PaymentProcessor {
  readonly processor: Processor;
  /** How many accounts were really opened, so tests can see a retry didn't open a second. */
  accountsOpened = 0;
  /** Every charge and refund really made, so tests can see a retry didn't make a second. */
  readonly charges: (SavedMethodCharge & { result: ChargeResult })[] = [];
  readonly refundsMade: (ChargeRef & { amountCents: number; result: RefundResult })[] = [];
  private readonly accounts = new Map<string, ProcessorAccountState>();
  private readonly byKey = new Map<string, string>();
  private readonly chargesByKey = new Map<string, ChargeResult>();
  private readonly refundsByKey = new Map<string, RefundResult>();
  private replyLost = false;
  private readonly outcomes = new Map<string, keyof typeof FAKE_METHODS | 'charged'>();

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

  readonly savedMethodCharges = {
    keyLifetimeHours: 24,

    chargeSavedMethod: async (input: SavedMethodCharge, idempotencyKey: string): Promise<ChargeResult> => {
      let result = this.chargesByKey.get(idempotencyKey);
      if (!result) {
        this.account(input.processorAccountId);
        result = this.decide(input.processorMethodId, `pi_fake${randomBytes(8).toString('hex')}`);
        this.chargesByKey.set(idempotencyKey, result);
        this.charges.push({ ...input, result });
      }
      return this.reply({ ...result });
    },

    checkCharge: async ({ processorPaymentId }: ChargeRef): Promise<ChargeResult> => {
      const found = this.charges.find((charge) => charge.result.processorPaymentId === processorPaymentId);
      if (!found) throw new ProcessorRefusedError(this.processor, 'resource_missing');
      return { ...found.result };
    },
  };

  readonly refunds = {
    refundCharge: async (input: ChargeRef & { amountCents: number }, idempotencyKey: string): Promise<RefundResult> => {
      let result = this.refundsByKey.get(idempotencyKey);
      if (!result) {
        const charge = this.charges.find((made) => made.result.processorPaymentId === input.processorPaymentId);
        if (charge?.result.status !== 'succeeded') throw new ProcessorRefusedError(this.processor, 'charge_not_refundable');
        result = { status: 'succeeded', processorRefundId: `re_fake${randomBytes(8).toString('hex')}` };
        this.refundsByKey.set(idempotencyKey, result);
        this.refundsMade.push({ processorAccountId: input.processorAccountId, processorPaymentId: input.processorPaymentId, amountCents: input.amountCents, result });
      }
      return this.reply({ ...result });
    },
  };

  /** A pending charge's outcome, as the processor would later say. */
  settle(processorPaymentId: string, status: 'succeeded' | 'failed'): void {
    const found = this.charges.find((charge) => charge.result.processorPaymentId === processorPaymentId);
    if (!found) throw new Error('No such fake charge');
    found.result.status = status;
    found.result.failureCode = status === 'failed' ? 'card_declined' : null;
  }

  /** From now on, charges to this saved method are answered as one of FAKE_METHODS would be, or charged. */
  setOutcome(processorMethodId: string, outcome: keyof typeof FAKE_METHODS | 'charged'): void {
    this.outcomes.set(processorMethodId, outcome);
  }

  /** The next charge or refund is made, but its reply never arrives, as on a timeout. */
  loseNextReply(): void {
    this.replyLost = true;
  }

  private reply<T>(result: T): T {
    if (!this.replyLost) return result;
    this.replyLost = false;
    throw new ProcessorUnavailableError(this.processor);
  }

  private decide(methodId: string, processorPaymentId: string): ChargeResult {
    const outcome = this.outcomes.get(methodId) ?? (Object.keys(FAKE_METHODS) as (keyof typeof FAKE_METHODS)[]).find((kind) => methodId.startsWith(FAKE_METHODS[kind]));
    const answer = (status: ChargeResult['status'], failureCode: string | null = null, hardDecline = false) => ({ status, processorPaymentId, failureCode, hardDecline });
    if (outcome === 'declined') return answer('failed', 'insufficient_funds');
    if (outcome === 'lost') return answer('failed', 'lost_card', true);
    if (outcome === 'needsAuthentication') return answer('requires_action', 'authentication_required', true);
    if (outcome === 'pending') return answer('pending');
    return answer('succeeded');
  }

  setChargesEnabled(processorAccountId: string, chargesEnabled: boolean): void {
    this.account(processorAccountId).chargesEnabled = chargesEnabled;
  }

  private account(processorAccountId: string): ProcessorAccountState {
    const found = this.accounts.get(processorAccountId);
    if (!found) throw new ProcessorRefusedError(this.processor, 'resource_missing');
    return found;
  }
}
