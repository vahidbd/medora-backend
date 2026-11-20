import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { ledgerAccounts } from '../../db/schema/index.js';
import type { Currency } from '../../db/schema/values.js';
import type { TenantTx } from '../../db/tenant.js';

/**
 * Which ledger account a line goes to (docs/decisions/billing.md BIL3). An
 * account is made the first time a posting needs it.
 */
export type AccountRef =
  | { kind: 'patient_receivable' | 'patient_credit'; patientId: string }
  | { kind: 'processor_clearing'; paymentAccountId: string }
  | { kind: 'pharmacy_payable'; partnerPharmacyId: string }
  | { kind: 'revenue_consult' | 'revenue_program' | 'revenue_medicine' | 'revenue_shipping' | 'gst_collected' };

interface Owner {
  patientId: string | null;
  paymentAccountId: string | null;
  partnerPharmacyId: string | null;
}

function ownerOf(ref: AccountRef): Owner {
  return {
    patientId: 'patientId' in ref ? ref.patientId : null,
    paymentAccountId: 'paymentAccountId' in ref ? ref.paymentAccountId : null,
    partnerPharmacyId: 'partnerPharmacyId' in ref ? ref.partnerPharmacyId : null,
  };
}

const matches = (column: AnyPgColumn, value: string | null) => (value === null ? isNull(column) : eq(column, value));

/** The account's id, made if it doesn't exist yet. Safe when two postings make it at once. */
export async function accountId(tx: TenantTx, ref: AccountRef, currency: Currency = 'AUD'): Promise<string> {
  const owner = ownerOf(ref);
  const where = and(
    eq(ledgerAccounts.tenantId, tx.context.tenantId),
    eq(ledgerAccounts.kind, ref.kind),
    eq(ledgerAccounts.currency, currency),
    matches(ledgerAccounts.patientId, owner.patientId),
    matches(ledgerAccounts.paymentAccountId, owner.paymentAccountId),
    matches(ledgerAccounts.partnerPharmacyId, owner.partnerPharmacyId),
  );
  const [found] = await tx.db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  if (found) return found.id;
  await tx.db
    .insert(ledgerAccounts)
    .values({ tenantId: tx.context.tenantId, kind: ref.kind, currency, ...owner })
    .onConflictDoNothing();
  const [made] = await tx.db.select({ id: ledgerAccounts.id }).from(ledgerAccounts).where(where);
  if (!made) throw new Error('Could not find or make a ledger account');
  return made.id;
}

/** Lock accounts before changing their balances, lowest id first, so two postings can't deadlock (ADR 0016). */
export async function lockAccounts(tx: TenantTx, ids: readonly string[]): Promise<void> {
  if (ids.length === 0) return;
  await tx.db
    .select({ id: ledgerAccounts.id })
    .from(ledgerAccounts)
    .where(and(eq(ledgerAccounts.tenantId, tx.context.tenantId), inArray(ledgerAccounts.id, [...ids])))
    .orderBy(ledgerAccounts.id)
    .for('update');
}

export async function addToBalance(tx: TenantTx, id: string, amountCents: number): Promise<void> {
  await tx.db
    .update(ledgerAccounts)
    .set({ balanceCents: sql`${ledgerAccounts.balanceCents} + ${amountCents}` })
    .where(and(eq(ledgerAccounts.tenantId, tx.context.tenantId), eq(ledgerAccounts.id, id)));
}
