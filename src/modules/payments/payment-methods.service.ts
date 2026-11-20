import { and, eq, inArray, ne, sql } from 'drizzle-orm';
import { paymentAccounts, paymentMethods } from '../../db/schema/index.js';
import type { Processor } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { emitEvent } from '../../lib/events.js';

/**
 * Patients' saved cards (docs/decisions/billing.md BIL28). The processor
 * holds the card; a payment method is its tokens on the tenant's account and
 * what a patient needs to recognise it. The newest card saved at a payment
 * account is the one period invoices are charged to.
 */

export interface PaymentMethodToSave {
  patientId: string;
  paymentAccountId: string;
  processorCustomerId: string;
  processorMethodId: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  /** When the patient agreed to later charges without them present. A card is never saved without it. */
  consentedAt: Date;
}

/** A card that can be charged, with what its processor needs. */
export interface ChargeableMethod {
  paymentMethodId: string;
  processor: Processor;
  processorAccountId: string;
  processorCustomerId: string;
  processorMethodId: string;
}

const TABLE = 'operational.payment_methods';

/**
 * Save a card the processor has set up for later charges, and make it the
 * patient's default at that payment account. The patient app calls this once
 * the processor confirms the card; saving the same card again only makes it
 * the default.
 */
export async function savePaymentMethod(tx: TenantTx, input: PaymentMethodToSave): Promise<{ paymentMethodId: string }> {
  const owner = and(eq(paymentMethods.patientId, input.patientId), eq(paymentMethods.paymentAccountId, input.paymentAccountId));
  await tx.db
    .update(paymentMethods)
    .set({ isDefault: false })
    .where(and(owner, eq(paymentMethods.isDefault, true), ne(paymentMethods.processorMethodId, input.processorMethodId)));
  const [saved] = await tx.db
    .insert(paymentMethods)
    .values({ tenantId: tx.context.tenantId, ...input, isDefault: true })
    .onConflictDoUpdate({ target: [paymentMethods.tenantId, paymentMethods.paymentAccountId, paymentMethods.processorMethodId], set: { isDefault: true } })
    .returning({ id: paymentMethods.id });
  const facts = { patientId: input.patientId, paymentAccountId: input.paymentAccountId };
  await audit(tx, { action: 'payment_method.saved', zone: 'operational', recordTable: TABLE, recordId: saved!.id, details: facts });
  await emitEvent(tx, { type: 'payment_method.saved', recordTable: TABLE, recordId: saved!.id, payload: facts });
  return { paymentMethodId: saved!.id };
}

/** The patient's default card at a payment account, or null when they have none there. */
export async function chargeableMethod(tx: TenantTx, owner: { patientId: string; paymentAccountId: string }): Promise<ChargeableMethod | null> {
  const [found] = await tx.db
    .select({
      paymentMethodId: paymentMethods.id,
      processor: paymentAccounts.processor,
      processorAccountId: paymentAccounts.processorAccountId,
      processorCustomerId: paymentMethods.processorCustomerId,
      processorMethodId: paymentMethods.processorMethodId,
    })
    .from(paymentMethods)
    .innerJoin(paymentAccounts, eq(paymentAccounts.id, paymentMethods.paymentAccountId))
    .where(and(eq(paymentMethods.patientId, owner.patientId), eq(paymentMethods.paymentAccountId, owner.paymentAccountId), sql`${paymentMethods.isDefault}`));
  if (!found?.processorAccountId) return null;
  return { ...found, processor: found.processor as Processor, processorAccountId: found.processorAccountId };
}

/** How a card is shown on an invoice or receipt. */
export async function methodLabels(tx: TenantTx, ids: readonly string[]): Promise<Map<string, { brand: string; last4: string }>> {
  if (ids.length === 0) return new Map();
  const rows = await tx.db
    .select({ id: paymentMethods.id, brand: paymentMethods.brand, last4: paymentMethods.last4 })
    .from(paymentMethods)
    .where(inArray(paymentMethods.id, [...ids]));
  return new Map(rows.map((row) => [row.id, { brand: row.brand, last4: row.last4 }]));
}
