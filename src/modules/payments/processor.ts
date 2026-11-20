import type { Processor } from '../../db/schema/values.js';
import { AppError } from '../../lib/errors.js';

/**
 * The payments interface (ADR 0019): one adapter per processor, and feature
 * code never calls a processor any other way. Each tenant is paid into its
 * own account at the processor (ADR 0160): connecting those accounts,
 * charging a saved card and refunding a charge; saving cards joins it with
 * the patient's billing page.
 */

/** What the processor says about a tenant's account there. */
export interface ProcessorAccountState {
  /** The processor will take payments into this account. */
  chargesEnabled: boolean;
}

/**
 * Onboarding on the processor's own pages (Stripe Connect). Medora asks the
 * processor to open an account for the tenant, then sends a staff member to
 * the processor's pages to finish it, so bank and identity details never
 * reach Medora.
 */
export interface HostedOnboarding {
  createAccount(input: { tenantId: string; paymentAccountId: string }, idempotencyKey: string): Promise<{ processorAccountId: string }>;
  /** A short-lived, single-use link to the processor's onboarding pages. */
  onboardingLink(
    input: { processorAccountId: string; returnUrl: string; refreshUrl: string },
    idempotencyKey: string,
  ): Promise<{ url: string; expiresAt: Date }>;
}

/**
 * What came of a charge. `pending` means the processor hasn't decided yet
 * and will say later; `requires_action` means the patient must confirm it
 * themselves (3-D Secure), which an off-session charge can't do.
 */
export interface ChargeResult {
  status: 'succeeded' | 'pending' | 'requires_action' | 'failed';
  processorPaymentId: string | null;
  /** The processor's own reason for a failure, kept for support; never shown to the patient as is. */
  failureCode: string | null;
}

export interface SavedMethodCharge {
  /** The tenant's account at the processor: the charge is made on it (ADR 0160). */
  processorAccountId: string;
  processorCustomerId: string;
  processorMethodId: string;
  amountCents: number;
  /** Medora's ids, the only metadata sent. */
  tenantId: string;
  invoiceId: string;
  paymentId: string;
}

export interface ChargeRef {
  processorAccountId: string;
  processorPaymentId: string;
}

/** Charging a saved card or wallet without the patient present (off-session). */
export interface SavedMethodCharges {
  chargeSavedMethod(input: SavedMethodCharge, idempotencyKey: string): Promise<ChargeResult>;
  /** What became of a charge that was still pending. */
  checkCharge(charge: ChargeRef): Promise<ChargeResult>;
}

export interface RefundResult {
  /** `pending` means the processor accepted it and the money is on its way back. */
  status: 'succeeded' | 'pending';
  processorRefundId: string;
}

/** Giving a charge back. A refusal throws ProcessorRefusedError; the caller tries again or tells staff. */
export interface Refunds {
  refundCharge(input: ChargeRef & { amountCents: number; tenantId: string; paymentId: string }, idempotencyKey: string): Promise<RefundResult>;
}

export interface PaymentProcessor {
  readonly processor: Processor;
  getAccount(processorAccountId: string): Promise<ProcessorAccountState>;
  /** Present when tenants connect through the processor's own pages (ADR 0019: a capability, not a branch on the name). */
  readonly hostedOnboarding?: HostedOnboarding;
  readonly savedMethodCharges?: SavedMethodCharges;
  readonly refunds?: Refunds;
}

const NAMES: Record<Processor, string> = { stripe: 'Stripe', eway: 'eWAY' };

/** The processor understood the request and said no. `code` is the processor's own, kept for support. */
export class ProcessorRefusedError extends AppError {
  readonly processorCode: string;

  constructor(processor: Processor, processorCode: string) {
    super(502, 'processor_refused', `${NAMES[processor]} refused the request (${processorCode})`, { processorCode });
    this.processorCode = processorCode;
  }
}

/** The processor didn't answer, or answered that it is having trouble. Safe to try again with the same key. */
export class ProcessorUnavailableError extends AppError {
  constructor(processor: Processor) {
    super(503, 'processor_unavailable', `${NAMES[processor]} isn't answering. Try again in a minute.`);
  }
}

/** This server has no key for the processor, so nothing is sent (ADR 0160). */
export class ProcessorNotConfiguredError extends AppError {
  constructor(processor: Processor) {
    super(503, 'processor_not_configured', `${NAMES[processor]} isn't set up on this server yet`);
  }
}
