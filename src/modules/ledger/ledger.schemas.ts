import { z } from 'zod';
import { CURRENCIES, FEE_KINDS, LEDGER_ACCOUNT_KINDS, LEDGER_ENTRY_KINDS } from '../../db/schema/values.js';

/** Amounts are whole cents; positive is a debit, negative a credit (docs/decisions/billing.md BIL1). */
const cents = z.number().int();

export const ledgerAccount = z.object({
  accountId: z.uuid(),
  kind: z.enum(LEDGER_ACCOUNT_KINDS),
  currency: z.enum(CURRENCIES),
  patientId: z.uuid().nullable(),
  paymentAccountId: z.uuid().nullable(),
  partnerPharmacyId: z.uuid().nullable(),
  balanceCents: cents,
});
export type LedgerAccount = z.infer<typeof ledgerAccount>;

export const ledgerEntry = z.object({
  entryId: z.uuid(),
  kind: z.enum(LEDGER_ENTRY_KINDS),
  occurredAt: z.iso.datetime(),
  postedAt: z.iso.datetime(),
  reversesEntryId: z.uuid().nullable(),
  lines: z.array(
    z.object({
      accountId: z.uuid(),
      accountKind: z.enum(LEDGER_ACCOUNT_KINDS),
      amountCents: cents,
      feeKind: z.enum(FEE_KINDS).nullable(),
    }),
  ),
});
export type LedgerEntry = z.infer<typeof ledgerEntry>;

export const accountsReply = z.object({ accounts: z.array(ledgerAccount) });
export const accountParams = z.object({ accountId: z.uuid() });
export const entriesQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export const entriesReply = z.object({ entries: z.array(ledgerEntry) });
