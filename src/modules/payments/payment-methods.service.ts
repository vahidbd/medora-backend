import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import { paymentAccounts, paymentMethods } from '../../db/schema/index.js';
import type { Processor } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';
import { audit } from '../../lib/audit.js';
import { BusinessRuleError } from '../../lib/errors.js';
import { emitEvent } from '../../lib/events.js';

/**
 * Patients' saved cards (docs/decisions/billing.md BIL28). The processor
 * holds the card; a payment method is its tokens on the tenant's account and
 * what a patient needs to recognise it. The newest card saved at a payment
 * account is the one period invoices are charged to, unless the processor
 * has hard-declined it (BIL31).
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
 * the default, and usable again after a hard decline (BIL31).
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
    .onConflictDoUpdate({
      target: [paymentMethods.tenantId, paymentMethods.paymentAccountId, paymentMethods.processorMethodId],
      set: { isDefault: true, declinedAt: null },
      setWhere: eq(paymentMethods.patientId, input.patientId),
    })
    .returning({ id: paymentMethods.id });
  // The processor's card is someone else's here: never hand it to another patient.
  if (!saved) throw new BusinessRuleError('That card is saved for another patient', 'payment_method_taken');
  const facts = { patientId: input.patientId, paymentAccountId: input.paymentAccountId };
  await audit(tx, { action: 'payment_method.saved', zone: 'operational', recordTable: TABLE, recordId: saved.id, details: facts });
  await emitEvent(tx, { type: 'payment_method.saved', recordTable: TABLE, recordId: saved.id, payload: facts });
  return { paymentMethodId: saved.id };
}

/**
 * A card with what its processor needs: the patient's default at a payment
 * account, unless it was hard-declined, or a given one (a payment keeps the
 * card it was tried on). Null when there is none.
 */
export async function chargeableMethod(
  tx: TenantTx,
  which: { patientId: string; paymentAccountId: string } | { paymentMethodId: string },
): Promise<ChargeableMethod | null> {
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
    .where(
      'paymentMethodId' in which
        ? eq(paymentMethods.id, which.paymentMethodId)
        : and(
            eq(paymentMethods.patientId, which.patientId),
            eq(paymentMethods.paymentAccountId, which.paymentAccountId),
            sql`${paymentMethods.isDefault}`,
            isNull(paymentMethods.declinedAt),
          ),
    );
  if (!found?.processorAccountId) return null;
  return { ...found, processor: found.processor as Processor, processorAccountId: found.processorAccountId };
}

/**
 * The processor hard-declined the card (BIL31): it is never charged without
 * the patient again until they save it again.
 */
export async function declinePaymentMethod(tx: TenantTx, paymentMethodId: string): Promise<void> {
  const [declined] = await tx.db
    .update(paymentMethods)
    .set({ declinedAt: sql`now()` })
    .where(and(eq(paymentMethods.id, paymentMethodId), isNull(paymentMethods.declinedAt)))
    .returning({ patientId: paymentMethods.patientId, paymentAccountId: paymentMethods.paymentAccountId });
  if (!declined) return;
  await audit(tx, { action: 'payment_method.declined', zone: 'operational', recordTable: TABLE, recordId: paymentMethodId, details: declined });
  await emitEvent(tx, { type: 'payment_method.declined', recordTable: TABLE, recordId: paymentMethodId, payload: declined });
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
