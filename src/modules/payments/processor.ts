import type { Processor } from '../../db/schema/values.js';
import { AppError } from '../../lib/errors.js';

/**
 * The payments interface (ADR 0019): one adapter per processor, and feature
 * code never calls a processor any other way. Each tenant is paid into its
 * own account at the processor (ADR 0037). This part covers connecting those
 * accounts; saving cards, charging and refunding join it as billing grows.
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

export interface PaymentProcessor {
  readonly processor: Processor;
  getAccount(processorAccountId: string): Promise<ProcessorAccountState>;
  /** Present when tenants connect through the processor's own pages (ADR 0019: a capability, not a branch on the name). */
  readonly hostedOnboarding?: HostedOnboarding;
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

/** This server has no key for the processor, so nothing is sent (ADR 0037). */
export class ProcessorNotConfiguredError extends AppError {
  constructor(processor: Processor) {
    super(503, 'processor_not_configured', `${NAMES[processor]} isn't set up on this server yet`);
  }
}
